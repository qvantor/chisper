//! The chain: the sound of the voices through the slots of the effects in their order, the master gain and the
//! limiter, a block at a time. A slot mixes its effect in (`Law`): the dry signal, late by the latency of the
//! effect, and the wet one, their gains gliding in 10 ms; a slot that is off passes its input and costs nothing
//! once its effect has faded out (it is forgotten then). The effects render from one pair of buffers into another
//! (none works in place), a slot whose effect plays alone only swaps them.
//!
//! It is driven by events with a time (`push`: the params, the mix and the state of a slot, the order, the gains,
//! the mute) taken at the first block at or after it, by the routes, the note and the LFOs of `modulation`, and
//! tells what failed (`take_reports`). A trap inside an effect is not the end of the sound: the chain keeps in
//! memory which stage it is at (`work`) before the call that may trap, `fail` drops that effect (its slot passes
//! its input from then on) and `resume` finishes the block; the limiter that trapped leaves the master silent
//! until it is made again (`retry`).

use alloc::{vec, vec::Vec};
use core::sync::atomic::{compiler_fence, Ordering};

use dsp_core::blocks::{louder, loudest, Smoothed};
use dsp_core::simd::F32x4;
use jsmath::{cos, max, sin, PI};

use crate::delay::Moves;
use crate::modulation::{Bases, Modulation, LINE_FB, LINE_FREQ, LINE_MIX, LINE_PAN, LINE_Q, LINE_TIME};
use crate::units::{law, Law, Unit, DELAY, LIMITER, MAX_METER, MAX_PARAMS, SLOTS};

/// the events: the params of a slot (a: the slot, b: the bits of the keys, the values by key), its mix (a, b),
/// whether it plays (a, b: not 0), the order (a: how many slots, the values: which), the master gain (a), the
/// mute (a: the seconds of the fade), its end, everything forgotten (a preset switch), the gain before the slots
pub const SET_PARAMS: u32 = 0;
pub const SET_MIX: u32 = 1;
pub const SET_ACTIVE: u32 = 2;
pub const SET_ORDER: u32 = 3;
pub const MASTER_GAIN: u32 = 4;
pub const MUTE: u32 = 5;
pub const UNMUTE: u32 = 6;
pub const CLEAR: u32 = 7;
pub const PRE_GAIN: u32 = 8;

/// the stage of the limiter (the slots are theirs by index)
pub const LIMITER_STAGE: u32 = SLOTS as u32;
const NO_WORK: u32 = u32::MAX;
const GLIDE: f64 = 0.01;
const FADED: f64 = 1e-4;

#[derive(Clone, Copy)]
pub struct Event {
    pub at: f64,
    pub kind: u32,
    pub a: f64,
    pub b: f64,
    pub values: [f64; MAX_PARAMS],
}

struct Slot {
    // None: it failed (or its kind has no effect)
    unit: Option<Unit>,
    // its unit renders: the slot plays, or fades out
    live: bool,
    dry: Smoothed,
    wet: Smoothed,
    latency: usize,
    // the last `latency` samples of its input (L, R)
    held: [Vec<f32>; 2],
}

pub struct Chain {
    rate: f64,
    slots: [Slot; SLOTS],
    params: [[f64; MAX_PARAMS]; SLOTS],
    mix: [f64; SLOTS],
    on: [bool; SLOTS],
    order: [usize; SLOTS],
    count: usize,
    // (None: made without one, or it failed)
    limiter: Option<Unit>,
    limited: bool,
    pre: f64,
    gain: f64,
    // the mute: its gain now, what it loses a sample (0: it holds)
    mute: f64,
    fade: f64,
    events: Vec<Event>,
    modulation: Modulation,
    // what the wrapper writes the routes, a note and the LFOs into
    scratch: Vec<f64>,
    // inL, inR, outL, outR, then two pairs of work buffers, `frames` each
    data: Vec<f32>,
    frames: usize,
    // the block in work: its frame, the stage to run next (a place in the order, then the master), the pair the
    // sound is in (0: the input), whether it is all +0
    frame: f64,
    cursor: usize,
    side: usize,
    silent: bool,
    // the stage a call that may trap is in, in memory before it
    work: u32,
    // the stages that failed since the last report (bits)
    reports: u32,
    #[cfg(any(test, feature = "perf"))]
    trap: u32,
    // (the specs of the crate: the slots are never skipped, what the rest is held to)
    #[cfg(test)]
    pub(crate) restless: bool,
}

fn targets(kind: usize, on: bool, mix: f64) -> (f64, f64) {
    if !on {
        return (1.0, 0.0);
    }
    match law(kind as u32) {
        Law::Inside(_) => (0.0, 1.0),
        Law::Linear => (1.0 - mix, mix),
        Law::EqualPower => (cos(mix * PI / 2.0), sin(mix * PI / 2.0)),
    }
}

// out = dry · the input (late by `held`.len(), its samples before the block in `held`) + wet · out; the gains
// from their values at the start of the block to those at its end, a line of each a sample on top
fn mix_in(
    input: &[f32],
    held: &[f32],
    out: &mut [f32],
    dry: (f64, f64),
    wet: (f64, f64),
    lines: (Option<&[f64]>, Option<&[f64]>),
) {
    let frames = out.len();
    let late = held.len().min(frames);
    let steady = dry.0 == dry.1 && wet.0 == wet.1 && lines.0.is_none() && lines.1.is_none();
    if !steady {
        let step = 1.0 / frames as f64;
        for i in 0..frames {
            let share = (i + 1) as f64 * step;
            let d = dry.0 + (dry.1 - dry.0) * share + lines.0.map_or(0.0, |line| line[i]);
            let w = wet.0 + (wet.1 - wet.0) * share + lines.1.map_or(0.0, |line| line[i]);
            let source = if i < held.len() {
                held[i]
            } else {
                input[i - held.len()]
            };
            out[i] = d as f32 * source + w as f32 * out[i];
        }
        return;
    }
    let (d, w) = (dry.1 as f32, wet.1 as f32);
    for i in 0..late {
        out[i] = d * held[i] + w * out[i];
    }
    let (dl, wl) = (F32x4::splat(d), F32x4::splat(w));
    let source = &input[..frames - late];
    let target = &mut out[late..];
    let mut sources = source.chunks_exact(4);
    let mut targets = target.chunks_exact_mut(4);
    for (source, target) in (&mut sources).zip(&mut targets) {
        (dl * F32x4::load(source) + wl * F32x4::load(target)).store(target);
    }
    for (source, target) in sources.remainder().iter().zip(targets.into_remainder()) {
        *target = d * *source + w * *target;
    }
}

// the samples of the input before the next block: the last of `held` and of this one
fn hold(held: &mut [f32], input: &[f32]) {
    let (latency, frames) = (held.len(), input.len());
    if frames >= latency {
        held.copy_from_slice(&input[frames - latency..]);
    } else {
        held.copy_within(frames.., 0);
        held[latency - frames..].copy_from_slice(input);
    }
}

impl Chain {
    /// a chain at a rate: the units of its slots with `params` (by kind, in the order of each), every slot off
    /// and out of the order, the gains 1; `limited`: with the limiter (a render at another rate runs it apart)
    pub fn new(sample_rate: f64, params: &[[f64; MAX_PARAMS]; SLOTS], limited: bool) -> Chain {
        Chain {
            rate: sample_rate,
            slots: core::array::from_fn(|kind| {
                let unit = Unit::new(kind as u32, sample_rate, &params[kind], true);
                let latency = unit.as_ref().map_or(0, |unit| unit.latency());
                Slot {
                    unit,
                    live: false,
                    dry: Smoothed::new(1.0, GLIDE, sample_rate),
                    wet: Smoothed::new(0.0, GLIDE, sample_rate),
                    latency,
                    held: [vec![0.0; latency], vec![0.0; latency]],
                }
            }),
            params: *params,
            mix: core::array::from_fn(|kind| match law(kind as u32) {
                Law::Inside(key) => params[kind][key],
                _ => 1.0,
            }),
            on: [false; SLOTS],
            order: [0; SLOTS],
            count: 0,
            limiter: if limited {
                Unit::new(LIMITER, sample_rate, &[0.0; MAX_PARAMS], true)
            } else {
                None
            },
            limited,
            pre: 1.0,
            gain: 1.0,
            mute: 1.0,
            fade: 0.0,
            events: Vec::with_capacity(64),
            modulation: Modulation::new(sample_rate),
            scratch: Vec::new(),
            data: Vec::new(),
            frames: 0,
            frame: 0.0,
            cursor: 0,
            side: 0,
            silent: false,
            work: NO_WORK,
            reports: 0,
            #[cfg(any(test, feature = "perf"))]
            trap: NO_WORK,
            #[cfg(test)]
            restless: false,
        }
    }

    /// room for `length` values of the wrapper (allocates when it grows)
    pub fn scratch(&mut self, length: usize) -> *mut f64 {
        if self.scratch.len() < length {
            self.scratch = vec![0.0; length];
        }
        self.scratch.as_mut_ptr()
    }

    /// the modulation and the first `length` values of the scratch
    pub fn written(&mut self, length: usize) -> (&mut Modulation, &[f64]) {
        let length = length.min(self.scratch.len());
        (&mut self.modulation, &self.scratch[..length])
    }

    /// room for a block of `frames` (allocates: not while a block renders): the address of inL, inR, outL and
    /// outR one after another
    pub fn reserve(&mut self, frames: usize) -> *mut f32 {
        if self.data.len() < 8 * frames {
            self.data = vec![0.0; 8 * frames];
        }
        if self.frames != frames {
            self.frames = frames;
            for slot in self.slots.iter_mut() {
                if let Some(unit) = &mut slot.unit {
                    unit.grow(frames);
                }
            }
            self.modulation.grow(frames);
        }
        self.data.as_mut_ptr()
    }

    // buffer `index` of the block (0, 1: the input, 2, 3: the output, then the pairs of work)
    //
    // SAFETY of the callers: the buffers of two indexes never overlap, a caller holds each index once
    #[inline(always)]
    unsafe fn buffer<'a>(&mut self, index: usize) -> &'a mut [f32] {
        core::slice::from_raw_parts_mut(self.data.as_mut_ptr().add(index * self.frames), self.frames)
    }

    // the first buffer of the pair of a side: the input, then the pairs of work
    fn pair(side: usize) -> usize {
        if side == 0 {
            0
        } else {
            2 + 2 * side
        }
    }

    /// an event from frame `at` on (allocates when the queue grows: not while a block renders)
    pub fn push(&mut self, event: Event) {
        let at = self
            .events
            .iter()
            .take_while(|other| other.at <= event.at)
            .count();
        self.events.insert(at, event);
    }

    fn aim(&mut self, kind: usize) {
        let (dry, wet) = targets(kind, self.on[kind], self.mix[kind]);
        let slot = &mut self.slots[kind];
        // (a slot that renders nothing is where it goes at once)
        slot.dry.set(dry, !slot.live, None);
        slot.wet.set(wet, !slot.live, None);
    }

    // the unit of a slot that stops rendering: forgotten, its slot a wire
    fn stop(&mut self, kind: usize) {
        let slot = &mut self.slots[kind];
        if let Some(unit) = &mut slot.unit {
            unit.forget();
        }
        slot.live = false;
        slot.dry.set(1.0, true, None);
        slot.wet.set(0.0, true, None);
        slot.held[0].fill(0.0);
        slot.held[1].fill(0.0);
    }

    fn apply(&mut self, event: &Event) {
        let kind = event.a as usize;
        match event.kind {
            SET_PARAMS if kind < SLOTS => {
                let mut direct = 0u32;
                for key in 0..MAX_PARAMS {
                    if event.b as u32 & (1 << key) != 0 {
                        self.params[kind][key] = event.values[key];
                        // (a knob a route moves takes its value from the modulation)
                        if !(self.on[kind] && self.modulation.moves(kind, key)) {
                            direct |= 1 << key;
                        }
                    }
                }
                if let Some(unit) = &mut self.slots[kind].unit {
                    unit.set(direct, &event.values, false);
                }
            }
            SET_MIX if kind < SLOTS => {
                self.mix[kind] = event.b;
                if let Law::Inside(key) = law(kind as u32) {
                    self.params[kind][key] = event.b;
                    if !(self.on[kind] && self.modulation.moves(kind, key)) {
                        let mut values = [0.0; MAX_PARAMS];
                        values[key] = event.b;
                        if let Some(unit) = &mut self.slots[kind].unit {
                            unit.set(1 << key, &values, false);
                        }
                    }
                }
                self.aim(kind);
            }
            SET_ACTIVE if kind < SLOTS => {
                self.on[kind] = event.b != 0.0;
                // (it renders from now on: its gains glide from those of a wire)
                if self.on[kind] && self.slots[kind].unit.is_some() {
                    self.slots[kind].live = true;
                }
                self.aim(kind);
            }
            SET_ORDER => {
                self.count = (event.a as usize).min(SLOTS);
                for place in 0..self.count {
                    self.order[place] = (event.values[place] as usize).min(SLOTS - 1);
                }
                for kind in 0..SLOTS {
                    if !self.order[..self.count].contains(&kind) && self.slots[kind].live {
                        self.stop(kind);
                    }
                }
            }
            MASTER_GAIN => self.gain = event.a,
            PRE_GAIN => self.pre = event.a,
            MUTE => {
                let frames = event.a * self.rate;
                self.mute = if frames >= 1.0 { 1.0 } else { 0.0 };
                self.fade = if frames >= 1.0 { 1.0 / frames } else { 0.0 };
            }
            UNMUTE => {
                self.mute = 1.0;
                self.fade = 0.0;
            }
            CLEAR => {
                for kind in 0..SLOTS {
                    let live = self.on[kind] && self.slots[kind].unit.is_some();
                    self.stop(kind);
                    self.slots[kind].live = live;
                    self.aim(kind);
                    self.slots[kind].dry.snap();
                    self.slots[kind].wet.snap();
                }
                if let Some(limiter) = &mut self.limiter {
                    limiter.forget();
                }
            }
            _ => {}
        }
    }

    /// the block reserved, at `frame`: the events due, then the stages
    pub fn process(&mut self, frame: f64) {
        self.work = NO_WORK;
        compiler_fence(Ordering::SeqCst);
        self.frame = frame;
        self.cursor = 0;
        self.side = 0;
        while self.events.first().is_some_and(|event| event.at <= frame) {
            let event = self.events.remove(0);
            self.apply(&event);
        }

        // the input: a value that is not finite as 0 (it would stay in the state of an effect for good), whether
        // it is all 0
        // SAFETY: the buffers of the input, held once
        let (in_l, in_r) = unsafe { (self.buffer(0), self.buffer(1)) };
        let peak = louder(loudest(in_l), loudest(in_r));
        if !peak.is_finite() {
            for value in in_l.iter_mut().chain(in_r.iter_mut()) {
                if !value.is_finite() {
                    *value = 0.0;
                }
            }
        }
        self.silent = peak == 0.0;
        if self.pre != 1.0 && !self.silent {
            let pre = self.pre as f32;
            for value in in_l.iter_mut().chain(in_r.iter_mut()) {
                *value *= pre;
            }
        }

        // nothing sounds and no slot has anything to play or to glide: the slots are skipped
        let frames = self.frames;
        let resting = self.silent
            && self.order[..self.count].iter().all(|&kind| {
                let slot = &self.slots[kind];
                !slot.live
                    || (slot.unit.as_ref().is_none_or(|unit| unit.idle())
                        && self.on[kind]
                        && slot.dry.from == slot.dry.value
                        && slot.wet.from == slot.wet.value
                        && slot.dry.step_done()
                        && slot.wet.step_done())
            });
        #[cfg(test)]
        let resting = resting && !self.restless;
        if resting {
            for place in 0..self.count {
                let slot = &mut self.slots[self.order[place]];
                if let (true, Some(unit)) = (slot.live, &mut slot.unit) {
                    unit.rest(frames);
                }
            }
            self.cursor = self.count;
        } else if !self.modulation.idle() {
            let Chain {
                modulation,
                slots,
                params,
                mix,
                on,
                ..
            } = self;
            let bases = Bases { params, mix, on };
            modulation.block(frame, frames, &bases, &mut |kind, key, value| {
                let mut values = [0.0; MAX_PARAMS];
                values[key] = value;
                if let Some(unit) = &mut slots[kind].unit {
                    unit.set(1 << key, &values, true);
                }
            });
        }
        self.resume();
    }

    /// the stages of the block from the cursor on (after `fail`: from the stage after the one that trapped)
    pub fn resume(&mut self) {
        while self.cursor < self.count {
            let kind = self.order[self.cursor];
            self.slot(kind);
            self.cursor += 1;
        }
        if self.cursor == self.count {
            self.master();
            self.cursor += 1;
        }
        self.work = NO_WORK;
    }

    // the stage of a slot: its effect from the pair the sound is in into the other one, mixed in there
    fn slot(&mut self, kind: usize) {
        if !self.slots[kind].live {
            return;
        }
        let frames = self.frames as f64;
        let from = Self::pair(self.side);
        let other = if self.side == 1 { 2 } else { 1 };
        let to = Self::pair(other);
        // SAFETY: two pairs that are not the same, each buffer held once
        let (in_l, in_r, out_l, out_r) = unsafe {
            (
                self.buffer(from),
                self.buffer(from + 1),
                self.buffer(to),
                self.buffer(to + 1),
            )
        };
        let playing = self.on[kind];
        let line = |index: usize| {
            if playing {
                self.modulation.line(index, self.frames)
            } else {
                None
            }
        };
        let moves = if kind == DELAY as usize {
            Moves {
                time: line(LINE_TIME),
                fb: line(LINE_FB),
                pan: [line(LINE_PAN), line(LINE_PAN + 1)],
                freq: line(LINE_FREQ).map_or(0.0, |offsets| offsets[0]),
                q: line(LINE_Q).map_or(0.0, |offsets| offsets[0]),
            }
        } else {
            Moves::default()
        };
        let lines = match law(kind as u32) {
            Law::Inside(_) => (None, None),
            _ => (line(LINE_MIX + 2 * kind), line(LINE_MIX + 2 * kind + 1)),
        };
        let slot = &mut self.slots[kind];
        let Some(unit) = &mut slot.unit else {
            return;
        };
        slot.dry.step(frames);
        slot.wet.step(frames);

        self.work = kind as u32;
        compiler_fence(Ordering::SeqCst);
        #[cfg(any(test, feature = "perf"))]
        if self.trap == kind as u32 {
            panic!("a trap of the specs");
        }
        unit.process_moved(in_l, in_r, out_l, out_r, &moves);

        let (dry, wet) = ((slot.dry.from, slot.dry.value), (slot.wet.from, slot.wet.value));
        let alone = dry == (0.0, 0.0) && wet == (1.0, 1.0) && lines.0.is_none() && lines.1.is_none();
        if !alone {
            mix_in(in_l, &slot.held[0], out_l, dry, wet, lines);
            mix_in(in_r, &slot.held[1], out_r, dry, wet, lines);
        }
        if slot.latency > 0 {
            hold(&mut slot.held[0], in_l);
            hold(&mut slot.held[1], in_r);
        }
        self.side = other;
        self.silent = false;
        // off and faded out (80 dB under itself, a tenth of a second): nothing of it sounds any more
        if !playing && wet.1 < FADED {
            self.stop(kind);
        }
    }

    // the mute and the master gain, then the limiter into the output
    fn master(&mut self) {
        let frames = self.frames;
        let from = Self::pair(self.side);
        // SAFETY: the pair the sound is in and the output, each buffer held once
        let (in_l, in_r, out_l, out_r) = unsafe {
            (
                self.buffer(from),
                self.buffer(from + 1),
                self.buffer(2),
                self.buffer(3),
            )
        };
        if self.fade > 0.0 {
            if !self.silent {
                for i in 0..frames {
                    let gain = (self.gain * max(self.mute - self.fade * i as f64, 0.0)) as f32;
                    in_l[i] *= gain;
                    in_r[i] *= gain;
                }
            }
            self.mute -= self.fade * frames as f64;
            if self.mute <= 0.0 {
                self.mute = 0.0;
                self.fade = 0.0;
            }
        } else if !self.silent {
            let gain = (self.gain * self.mute) as f32;
            if gain == 0.0 {
                in_l.fill(0.0);
                in_r.fill(0.0);
                self.silent = true;
            } else if gain != 1.0 {
                let lanes = F32x4::splat(gain);
                for channel in [&mut *in_l, &mut *in_r] {
                    let mut chunks = channel.chunks_exact_mut(4);
                    for chunk in &mut chunks {
                        (F32x4::load(chunk) * lanes).store(chunk);
                    }
                    for value in chunks.into_remainder() {
                        *value *= gain;
                    }
                }
            }
        }
        match &mut self.limiter {
            Some(limiter) => {
                self.work = LIMITER_STAGE;
                compiler_fence(Ordering::SeqCst);
                #[cfg(any(test, feature = "perf"))]
                if self.trap == LIMITER_STAGE {
                    panic!("a trap of the specs");
                }
                limiter.process(in_l, in_r, out_l, out_r);
            }
            // (a limiter that failed: the master is silent until it is made again)
            None if self.limited => {
                out_l.fill(0.0);
                out_r.fill(0.0);
            }
            None => {
                out_l.copy_from_slice(in_l);
                out_r.copy_from_slice(in_r);
            }
        }
    }

    /// after a trap: the stage it was in is dropped (an effect: its slot passes its input; the limiter: silence),
    /// `resume` finishes the block. False: the trap was not in a stage (the block is whatever it is: the caller
    /// plays silence)
    pub fn fail(&mut self) -> bool {
        let stage = self.work;
        self.work = NO_WORK;
        if stage == LIMITER_STAGE {
            // (not dropped: its state is where the trap left it, a free could trap again)
            core::mem::forget(self.limiter.take());
            // SAFETY: the buffers of the output, held once
            let (out_l, out_r) = unsafe { (self.buffer(2), self.buffer(3)) };
            out_l.fill(0.0);
            out_r.fill(0.0);
            self.cursor = self.count + 1;
        } else if (stage as usize) < SLOTS {
            let slot = &mut self.slots[stage as usize];
            core::mem::forget(slot.unit.take());
            slot.live = false;
            self.cursor += 1;
        } else {
            return false;
        }
        self.reports |= 1 << stage;
        true
    }

    /// the stages that failed since the last call (the bit of each)
    pub fn take_reports(&mut self) -> u32 {
        core::mem::take(&mut self.reports)
    }

    /// the unit of a stage made again (allocates: not while a block renders): an effect at its params, off until
    /// its slot plays, or the limiter
    pub fn retry(&mut self, stage: u32) {
        if stage == LIMITER_STAGE {
            if self.limited && self.limiter.is_none() {
                self.limiter = Unit::new(LIMITER, self.rate, &[0.0; MAX_PARAMS], true);
            }
            return;
        }
        let kind = stage as usize;
        if kind >= SLOTS || self.slots[kind].unit.is_some() {
            return;
        }
        let mut unit = Unit::new(stage, self.rate, &self.params[kind], true);
        if let Some(unit) = &mut unit {
            unit.grow(self.frames);
        }
        self.slots[kind].unit = unit;
        self.stop(kind);
        self.slots[kind].live = self.on[kind] && self.slots[kind].unit.is_some();
        self.aim(kind);
    }

    /// what a screen draws of the effect of a slot (`Unit::meter`), how many values
    pub fn meter(&self, kind: usize, values: &mut [f64; MAX_METER]) -> usize {
        match self.slots.get(kind).and_then(|slot| slot.unit.as_ref()) {
            Some(unit) => unit.meter(values),
            None => 0,
        }
    }

    /// the effect of a slot has nothing to play
    pub fn idle(&self, kind: usize) -> bool {
        self.slots
            .get(kind)
            .and_then(|slot| slot.unit.as_ref())
            .is_none_or(|unit| unit.idle())
    }

    /// the samples the limiter delays the sound by (0: none)
    pub fn latency(&self) -> usize {
        self.limiter.as_ref().map_or(0, |limiter| limiter.latency())
    }

    /// the stage `stage` traps from now on (the specs)
    #[cfg(any(test, feature = "perf"))]
    pub fn trap(&mut self, stage: u32) {
        self.trap = stage;
    }
}
