//! The chain: the sound of the voices through the slots of the effects in their order, the master gain and the
//! limiter, a block at a time. A slot mixes its effect in (`Law`): the dry signal, late by the latency of the
//! effect, and the wet one, their gains gliding in 10 ms; a slot that is off passes its input and costs nothing
//! once its effect has faded out (it is forgotten then). A slot whose effect is late crosses between its input
//! as it is and the late one as it starts and stops; a slot that sounds and leaves the order fades out where it
//! is first (`pending`). The effects render from one pair of buffers into another
//! (none works in place), a slot whose effect plays alone only swaps them.
//!
//! It is driven by events with a time (`push`: the params, the mix and the state of a slot, the order, the gains,
//! the mute) taken at the first block at or after it (one without a time: at the next block, never before one
//! with a time that came before it), by the routes, the note and the LFOs of `modulation`, and tells what failed
//! (`take_reports`). A trap inside an effect is not the end of the sound: the chain keeps in memory which stage
//! it is at (`work`) before every call of a unit that may trap (its block, a knob, a rest, its sound forgotten),
//! `fail` drops that effect (its slot passes its input from then on) and `resume` finishes the block from the
//! step it was at (`step`: an event that trapped is taken again without the unit); the limiter that trapped
//! leaves the master silent until it is made again (`retry`).

use alloc::{collections::VecDeque, vec, vec::Vec};
use core::sync::atomic::{compiler_fence, Ordering};

use dsp_core::blocks::{louder, loudest, Smoothed};
use dsp_core::simd::F32x4;
use jsmath::{cos, max, sin, PI};

use crate::modulation::{
    Bases, Modulation, LINE_EQ, LINE_FB, LINE_FREQ, LINE_MIX, LINE_PAN, LINE_Q, LINE_TIME,
};
use crate::units::{law, Law, Moves, Unit, DELAY, EQ, LIMITER, MAX_METER, MAX_PARAMS, SLOTS};

/// the events: the params of a slot (a: the slot, b: the bits of the keys, the values by key), its mix (a, b),
/// whether it plays (a, b: not 0), the order (a: how many slots, the values: which), the master gain (a), the
/// mute (a: the seconds of the fade), its end, everything forgotten (a preset switch)
pub const SET_PARAMS: u32 = 0;
pub const SET_MIX: u32 = 1;
pub const SET_ACTIVE: u32 = 2;
pub const SET_ORDER: u32 = 3;
pub const MASTER_GAIN: u32 = 4;
pub const MUTE: u32 = 5;
pub const UNMUTE: u32 = 6;
pub const CLEAR: u32 = 7;

/// the stage of the limiter (the slots are theirs by index)
pub const LIMITER_STAGE: u32 = SLOTS as u32;
const NO_WORK: u32 = u32::MAX;
// the steps of a block, each taken up where a trap left it: the events due, the units that render nothing, the
// knobs the routes move, the stages
const EVENTS: u32 = 0;
const REST: u32 = 1;
const ROUTES: u32 = 2;
const STAGES: u32 = 3;
/// the calls of a unit a trap of the specs is in: its block, a knob, a rest, its sound forgotten; `AFTER`: past
/// its stage, in none; `IN_NEW`: as a retry makes it
pub const IN_PROCESS: u32 = 0;
pub const IN_SET: u32 = 1;
pub const IN_REST: u32 = 2;
pub const IN_FORGET: u32 = 3;
pub const AFTER: u32 = 4;
pub const IN_NEW: u32 = 5;
/// a trap of the specs that is in no stage
#[cfg(any(test, feature = "perf"))]
pub const OUTSIDE: u32 = LIMITER_STAGE + 1;
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
    // (an effect that is late) the gain of its input as it is: 1 while the slot is off, 0 while it plays (the
    // dry signal is the late one then). The slot crosses from one to the other: no jump in time, no hole
    direct: Smoothed,
    latency: usize,
    // the last `latency` samples of its input (L, R)
    held: [Vec<f32>; 2],
    // the samples `held` still lacks after a start: the effect renders, its slot is a wire until it has them
    warm: usize,
    // out of the order to come: it fades out as one that is off, where it is
    gone: bool,
}

pub struct Chain {
    rate: f64,
    slots: [Slot; SLOTS],
    params: [[f64; MAX_PARAMS]; SLOTS],
    mix: [f64; SLOTS],
    on: [bool; SLOTS],
    order: [usize; SLOTS],
    count: usize,
    // the order to come, once the slots that leave it have faded out
    pending: Option<([usize; SLOTS], usize)>,
    // (None: made without one, or it failed)
    limiter: Option<Unit>,
    limited: bool,
    gain: f64,
    // the mute: its gain now, what it loses a sample (0: it holds)
    mute: f64,
    fade: f64,
    // the events to come by the frame each is taken at (its time; of one without a time `stamped`), those of one
    // frame in the order they came
    events: VecDeque<(f64, Event)>,
    // the latest time an event came with
    stamped: f64,
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
    // the step of the block (`EVENTS`…), the kind to rest next, whether the slots are skipped, the knobs the
    // routes move in this block (slot, key, value) and the one to set next
    step: u32,
    // the input of the block is all 0, told by whoever made it (process_fed)
    silent_input: bool,
    rested: usize,
    resting: bool,
    sets: Vec<(usize, usize, f64)>,
    set_at: usize,
    // the stage a call that may trap is in, in memory before it
    work: u32,
    // the stages that failed since the last report (bits)
    reports: u32,
    // the stage and the call (`IN_PROCESS`…) that trap
    #[cfg(any(test, feature = "perf"))]
    trap: (u32, u32),
    // (the specs of the crate: the slots are never skipped, what the rest is held to)
    #[cfg(test)]
    pub(crate) restless: bool,
}

/// the dry and the wet gain of a mix by equal power (all wet: no dry signal at all, cos(π / 2) is 6e-17)
pub fn equal_power(mix: f64) -> (f64, f64) {
    if mix >= 1.0 {
        (0.0, 1.0)
    } else if mix <= 0.0 {
        (1.0, 0.0)
    } else {
        (cos(mix * PI / 2.0), sin(mix * PI / 2.0))
    }
}

// the gains of a slot: the dry one (of the input, late by the latency), the wet one, the direct one (`late`: of
// the input as it is; a slot that is not late is a wire by its dry gain)
fn targets(kind: usize, on: bool, mix: f64, late: bool) -> (f64, f64, f64) {
    if !on {
        return if late { (0.0, 0.0, 1.0) } else { (1.0, 0.0, 0.0) };
    }
    let (dry, wet) = match law(kind as u32) {
        Law::Inside(_) => (0.0, 1.0),
        Law::Linear => (1.0 - mix, mix),
        Law::EqualPower => equal_power(mix),
    };
    (dry, wet, 0.0)
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

// out += direct · the input, the gain from its value at the start of the block to that at its end
fn add_in(input: &[f32], out: &mut [f32], direct: (f64, f64)) {
    let step = 1.0 / out.len() as f64;
    for (i, (source, target)) in input.iter().zip(out.iter_mut()).enumerate() {
        let gain = direct.0 + (direct.1 - direct.0) * ((i + 1) as f64 * step);
        *target += gain as f32 * *source;
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
                let unit = Unit::new(kind as u32, sample_rate, &params[kind]);
                let latency = unit.as_ref().map_or(0, |unit| unit.latency());
                Slot {
                    unit,
                    live: false,
                    dry: Smoothed::new(if latency > 0 { 0.0 } else { 1.0 }, GLIDE, sample_rate),
                    wet: Smoothed::new(0.0, GLIDE, sample_rate),
                    direct: Smoothed::new(if latency > 0 { 1.0 } else { 0.0 }, GLIDE, sample_rate),
                    latency,
                    held: [vec![0.0; latency], vec![0.0; latency]],
                    warm: 0,
                    gone: false,
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
            pending: None,
            limiter: if limited {
                Unit::new(LIMITER, sample_rate, &[0.0; MAX_PARAMS])
            } else {
                None
            },
            limited,
            gain: 1.0,
            mute: 1.0,
            fade: 0.0,
            events: VecDeque::with_capacity(64),
            stamped: 0.0,
            modulation: Modulation::new(sample_rate),
            scratch: Vec::new(),
            data: Vec::new(),
            frames: 0,
            frame: 0.0,
            cursor: 0,
            side: 0,
            silent: false,
            step: EVENTS,
            silent_input: false,
            rested: 0,
            resting: false,
            // (a knob is set back or moved, never both in a block)
            sets: Vec::with_capacity(SLOTS * MAX_PARAMS),
            set_at: 0,
            work: NO_WORK,
            reports: 0,
            #[cfg(any(test, feature = "perf"))]
            trap: (NO_WORK, IN_PROCESS),
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

    /// an event from frame `at` on (allocates when the queue grows: not while a block renders). One without a
    /// time (`at` 0) is of now, and now is not before a time that came before it: an unmute sent after a mute
    /// with a time is taken after it, even when no block was rendered between them
    pub fn push(&mut self, event: Event) {
        let due = if event.at > 0.0 {
            self.stamped = max(self.stamped, event.at);
            event.at
        } else {
            self.stamped
        };
        // (after those due by then: most often the last place)
        let place = self
            .events
            .iter()
            .rposition(|(other, _)| *other <= due)
            .map_or(0, |last| last + 1);
        self.events.insert(place, (due, event));
    }

    // on and in the order to come: its effect sounds
    fn plays(&self, kind: usize) -> bool {
        self.on[kind] && !self.slots[kind].gone
    }

    fn aim(&mut self, kind: usize) {
        let late = self.slots[kind].latency > 0;
        let (dry, wet, direct) = targets(kind, self.plays(kind), self.mix[kind], late);
        let slot = &mut self.slots[kind];
        // (it has no late input yet: a wire until then)
        if slot.warm > 0 {
            return;
        }
        // (a slot that renders nothing is where it goes at once)
        slot.dry.set(dry, !slot.live, None);
        slot.wet.set(wet, !slot.live, None);
        slot.direct.set(direct, !slot.live, None);
    }

    // a call of the unit of `stage` that may trap comes next: the stage in memory before it
    #[inline(always)]
    fn begin(&mut self, stage: u32, _call: u32) {
        self.work = stage;
        compiler_fence(Ordering::SeqCst);
        #[cfg(any(test, feature = "perf"))]
        if self.trap == (stage, _call) {
            panic!("a trap of the specs");
        }
    }

    // the call is over: a trap from now on is in no stage
    #[inline(always)]
    fn end(&mut self) {
        self.work = NO_WORK;
        compiler_fence(Ordering::SeqCst);
    }

    // the params of the unit of a slot (one that failed has none)
    fn set(&mut self, kind: usize, present: u32, values: &[f64; MAX_PARAMS], routed: bool) {
        if self.slots[kind].unit.is_none() {
            return;
        }
        self.begin(kind as u32, IN_SET);
        if let Some(unit) = &mut self.slots[kind].unit {
            unit.set(present, values, routed);
        }
        self.end();
    }

    // the unit of a slot that stops rendering: its slot a wire, then its sound forgotten (the call that may trap
    // last: the slot is a wire whatever comes of it)
    fn stop(&mut self, kind: usize) {
        let slot = &mut self.slots[kind];
        let late = slot.latency > 0;
        slot.live = false;
        slot.gone = false;
        slot.warm = 0;
        slot.dry.set(if late { 0.0 } else { 1.0 }, true, None);
        slot.wet.set(0.0, true, None);
        slot.direct.set(if late { 1.0 } else { 0.0 }, true, None);
        slot.held[0].fill(0.0);
        slot.held[1].fill(0.0);
        if slot.unit.is_none() {
            return;
        }
        self.begin(kind as u32, IN_FORGET);
        if let Some(unit) = &mut self.slots[kind].unit {
            unit.forget();
        }
        self.end();
    }

    // a slot that is on renders from now on: its gains glide from those of a wire (an effect that is late: once
    // the slot has the input it mixes in late)
    fn start(&mut self, kind: usize) {
        let slot = &mut self.slots[kind];
        if self.on[kind] && slot.unit.is_some() && !slot.live {
            slot.live = true;
            slot.warm = slot.latency;
        }
        self.aim(kind);
    }

    // the order of an event: at once, or once the slots that sound and leave it have faded out (they stay where
    // they are until then; a cut would click)
    fn reorder(&mut self, order: [usize; SLOTS], count: usize) {
        let mut waits = false;
        for kind in 0..SLOTS {
            let stays = order[..count].contains(&kind);
            let here = self.order[..self.count].contains(&kind);
            let slot = &mut self.slots[kind];
            let gone = !stays && here && slot.live;
            let changed = slot.gone != gone;
            slot.gone = gone;
            waits = waits || gone;
            if changed {
                self.aim(kind);
            }
        }
        self.pending = Some((order, count));
        if !waits {
            self.settle();
        }
    }

    // the order to come is the order once no slot that leaves it sounds
    fn settle(&mut self) {
        let Some((order, count)) = self.pending else {
            return;
        };
        if self.slots.iter().any(|slot| slot.gone) {
            return;
        }
        // (the order is the new one once every slot is where it goes: after a trap in a stop this is done again)
        for kind in 0..SLOTS {
            let stays = order[..count].contains(&kind);
            if !stays && self.slots[kind].live {
                self.stop(kind);
            } else if stays && !self.order[..self.count].contains(&kind) {
                // (new in the order: it fades in from a wire, whatever it was told while out of it)
                self.stop(kind);
                self.start(kind);
            }
        }
        self.order = order;
        self.count = count;
        self.pending = None;
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
                self.set(kind, direct, &event.values, false);
            }
            SET_MIX if kind < SLOTS => {
                self.mix[kind] = event.b;
                if let Law::Inside(key) = law(kind as u32) {
                    self.params[kind][key] = event.b;
                    if !(self.on[kind] && self.modulation.moves(kind, key)) {
                        let mut values = [0.0; MAX_PARAMS];
                        values[key] = event.b;
                        self.set(kind, 1 << key, &values, false);
                    }
                }
                self.aim(kind);
            }
            SET_ACTIVE if kind < SLOTS => {
                self.on[kind] = event.b != 0.0;
                self.start(kind);
            }
            SET_ORDER => {
                let count = (event.a as usize).min(SLOTS);
                let mut order = [0; SLOTS];
                for place in 0..count {
                    order[place] = (event.values[place] as usize).min(SLOTS - 1);
                }
                self.reorder(order, count);
            }
            MASTER_GAIN => self.gain = event.a,
            MUTE => {
                // (an event with a time: the fade ends `a` seconds after it, however late it is taken)
                let late = if event.at > 0.0 {
                    max(0.0, self.frame - event.at)
                } else {
                    0.0
                };
                let frames = event.a * self.rate - late;
                self.mute = if frames >= 1.0 { 1.0 } else { 0.0 };
                self.fade = if frames >= 1.0 { 1.0 / frames } else { 0.0 };
            }
            UNMUTE => {
                self.mute = 1.0;
                self.fade = 0.0;
            }
            CLEAR => {
                // nothing sounds any more, so the order to come is the order at once; then every slot where its
                // knobs have it (after the order: a slot new in it would fade in from a wire)
                for kind in 0..SLOTS {
                    self.stop(kind);
                }
                self.settle();
                for kind in 0..SLOTS {
                    let slot = &mut self.slots[kind];
                    slot.live = self.on[kind] && slot.unit.is_some();
                    slot.warm = 0;
                    self.aim(kind);
                    self.slots[kind].dry.snap();
                    self.slots[kind].wet.snap();
                    self.slots[kind].direct.snap();
                }
                if self.limiter.is_some() {
                    self.begin(LIMITER_STAGE, IN_FORGET);
                    if let Some(limiter) = &mut self.limiter {
                        limiter.forget();
                    }
                    self.end();
                }
            }
            _ => {}
        }
    }

    /// the input of the block reserved (left, then right): whoever feeds the chain writes it there
    pub fn input(&mut self) -> *mut f32 {
        self.data.as_mut_ptr()
    }

    /// the block of `process`, its input known to be all 0 when `silent` (it is not read to find out: the same
    /// values)
    pub fn process_fed(&mut self, frame: f64, silent: bool) {
        self.silent_input = silent;
        self.block(frame);
    }

    /// the block reserved, at `frame`: the events due, then the stages
    pub fn process(&mut self, frame: f64) {
        self.silent_input = false;
        self.block(frame);
    }

    fn block(&mut self, frame: f64) {
        self.end();
        self.frame = frame;
        self.cursor = 0;
        self.side = 0;
        self.step = EVENTS;
        #[cfg(any(test, feature = "perf"))]
        if self.trap.0 == OUTSIDE {
            panic!("a trap of the specs");
        }
        self.resume();
    }

    // the events due, the input and whether the slots are skipped
    fn take(&mut self) {
        let frame = self.frame;
        // (an event leaves the queue once it is applied: one a unit trapped in is taken again, without the unit)
        while let Some(&(due, event)) = self.events.front() {
            if due > frame {
                break;
            }
            self.apply(&event);
            self.events.pop_front();
        }
        self.settle();

        // the input: a value that is not finite as 0 (it would stay in the state of an effect for good), whether
        // it is all 0
        // SAFETY: the buffers of the input, held once
        let (in_l, in_r) = unsafe { (self.buffer(0), self.buffer(1)) };
        let peak = if self.silent_input {
            0.0
        } else {
            louder(loudest(in_l), loudest(in_r))
        };
        if !peak.is_finite() {
            for value in in_l.iter_mut().chain(in_r.iter_mut()) {
                if !value.is_finite() {
                    *value = 0.0;
                }
            }
        }
        self.silent = peak == 0.0;

        // nothing sounds and no slot has anything to play or to glide: the slots are skipped
        let resting = self.silent
            && self.order[..self.count].iter().all(|&kind| {
                let slot = &self.slots[kind];
                !slot.live
                    || (slot.unit.as_ref().is_none_or(|unit| unit.idle())
                        && self.plays(kind)
                        && slot.warm == 0
                        && slot.dry.from == slot.dry.value
                        && slot.wet.from == slot.wet.value
                        && slot.direct.from == slot.direct.value
                        && slot.dry.step_done()
                        && slot.wet.step_done()
                        && slot.direct.step_done())
            });
        #[cfg(test)]
        let resting = resting && !self.restless;
        self.resting = resting;
    }

    // a unit that renders nothing in this block is left as a block of silence leaves it: the LFO of a chorus goes
    // on in a slot that is off or out of the order too
    fn rest(&mut self) {
        while self.rested < SLOTS {
            let kind = self.rested;
            self.rested += 1;
            let slot = &self.slots[kind];
            let renders = !self.resting && slot.live && self.order[..self.count].contains(&kind);
            if renders || slot.unit.is_none() {
                continue;
            }
            self.begin(kind as u32, IN_REST);
            let frames = self.frames;
            if let Some(unit) = &mut self.slots[kind].unit {
                unit.rest(frames);
            }
            self.end();
        }
    }

    // the knobs the routes move in this block, for `route` to set (the modulation calls no unit: a unit that
    // traps leaves it whole)
    fn modulate(&mut self) {
        self.sets.clear();
        self.set_at = 0;
        if self.resting {
            self.cursor = self.count;
        } else if !self.modulation.idle() {
            // (a slot that fades out, off or out of the order to come, plays no more: its lines go to 0 with it;
            // one that waits for the order to come is not in the chain yet: its lines start as it fades in from a
            // wire; one that is late mixes nothing in until it has its late input)
            let on: [bool; SLOTS] =
                core::array::from_fn(|kind| self.plays(kind) && self.order[..self.count].contains(&kind));
            let mixes: [bool; SLOTS] = core::array::from_fn(|kind| on[kind] && self.slots[kind].warm == 0);
            let Chain {
                modulation,
                sets,
                params,
                mix,
                ..
            } = self;
            let bases = Bases {
                params,
                mix,
                on: &on,
                mixes: &mixes,
            };
            modulation.block(self.frame, self.frames, &bases, &mut |kind, key, value| {
                sets.push((kind, key, value))
            });
        }
    }

    fn route(&mut self) {
        while self.set_at < self.sets.len() {
            let (kind, key, value) = self.sets[self.set_at];
            self.set_at += 1;
            let mut values = [0.0; MAX_PARAMS];
            values[key] = value;
            self.set(kind, 1 << key, &values, true);
        }
    }

    /// the block from the step it is at: all of it, or after `fail` what is left of it (in the stages: from the
    /// one after the stage that trapped)
    pub fn resume(&mut self) {
        if self.step == EVENTS {
            self.take();
            self.rested = 0;
            self.step = REST;
        }
        if self.step == REST {
            self.rest();
            self.modulate();
            self.step = ROUTES;
        }
        if self.step == ROUTES {
            self.route();
            self.step = STAGES;
        }
        while self.cursor < self.count {
            let kind = self.order[self.cursor];
            self.slot(kind);
            // (past its stage: a trap between two stages is of neither)
            self.end();
            #[cfg(any(test, feature = "perf"))]
            if self.trap == (kind as u32, AFTER) {
                panic!("a trap of the specs");
            }
            self.cursor += 1;
        }
        if self.cursor == self.count {
            self.master();
            self.cursor += 1;
        }
        self.end();
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
        let playing = self.plays(kind);
        // (a line is added for as long as there is one: that of a slot that stops glides to 0 as it fades out)
        let line = |index: usize| self.modulation.line(index, self.frames);
        let moves = if kind == DELAY as usize {
            Moves {
                time: line(LINE_TIME),
                fb: line(LINE_FB),
                pan: [line(LINE_PAN), line(LINE_PAN + 1)],
                freq: line(LINE_FREQ).map_or(0.0, |offsets| offsets[0]),
                q: line(LINE_Q).map_or(0.0, |offsets| offsets[0]),
                ..Moves::default()
            }
        } else if kind == EQ as usize {
            Moves {
                eq: core::array::from_fn(|knob| line(LINE_EQ + knob)),
                ..Moves::default()
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
        let warming = slot.warm > 0;
        if !warming {
            slot.dry.step(frames);
            slot.wet.step(frames);
            slot.direct.step(frames);
        }

        self.work = kind as u32;
        compiler_fence(Ordering::SeqCst);
        #[cfg(any(test, feature = "perf"))]
        if self.trap == (kind as u32, IN_PROCESS) {
            panic!("a trap of the specs");
        }
        unit.process_moved(in_l, in_r, out_l, out_r, &moves);

        if warming {
            // (what it rendered is left where it is: the sound stays in the pair it is in)
            hold(&mut slot.held[0], in_l);
            hold(&mut slot.held[1], in_r);
            slot.warm = slot.warm.saturating_sub(self.frames);
            if slot.warm == 0 {
                self.aim(kind);
            }
            return;
        }
        let (dry, wet) = ((slot.dry.from, slot.dry.value), (slot.wet.from, slot.wet.value));
        let direct = (slot.direct.from, slot.direct.value);
        let alone = dry == (0.0, 0.0)
            && wet == (1.0, 1.0)
            && direct == (0.0, 0.0)
            && lines.0.is_none()
            && lines.1.is_none();
        if !alone {
            mix_in(in_l, &slot.held[0], out_l, dry, wet, lines);
            mix_in(in_r, &slot.held[1], out_r, dry, wet, lines);
        }
        if direct != (0.0, 0.0) {
            add_in(in_l, out_l, direct);
            add_in(in_r, out_r, direct);
        }
        let late = slot.latency > 0;
        if late {
            hold(&mut slot.held[0], in_l);
            hold(&mut slot.held[1], in_r);
        }
        self.side = other;
        self.silent = false;
        // off and faded out (80 dB under itself, a tenth of a second): nothing of it sounds any more
        if !playing && wet.1 < FADED && (!late || dry.1 < FADED) {
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
                if self.trap == (LIMITER_STAGE, IN_PROCESS) {
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
    /// `resume` finishes the block (a trap before the stages, in a knob, a rest or a sound forgotten: from the step
    /// it was at). False: the trap was not in a stage (the block is whatever it is: the caller plays silence)
    pub fn fail(&mut self) -> bool {
        let stage = self.work;
        self.work = NO_WORK;
        let staged = self.step == STAGES;
        if stage == LIMITER_STAGE {
            // (not dropped: its state is where the trap left it, a free could trap again)
            core::mem::forget(self.limiter.take());
            if staged {
                // SAFETY: the buffers of the output, held once
                let (out_l, out_r) = unsafe { (self.buffer(2), self.buffer(3)) };
                out_l.fill(0.0);
                out_r.fill(0.0);
                self.cursor = self.count + 1;
            }
        } else if (stage as usize) < SLOTS {
            let slot = &mut self.slots[stage as usize];
            core::mem::forget(slot.unit.take());
            slot.live = false;
            slot.gone = false;
            if staged {
                self.cursor += 1;
            }
        } else {
            return false;
        }
        self.reports |= 1 << stage;
        true
    }

    /// the frames of the block reserved
    pub fn frames(&self) -> usize {
        self.frames
    }

    /// a stage failed since the last `take_reports`
    pub fn reported(&self) -> bool {
        self.reports != 0
    }

    /// the stages that failed since the last call (the bit of each)
    pub fn take_reports(&mut self) -> u32 {
        core::mem::take(&mut self.reports)
    }

    /// the unit of a stage made again (allocates: not while a block renders): an effect at its params, off until
    /// its slot plays, or the limiter. Whether the stage has its unit now
    pub fn retry(&mut self, stage: u32) -> bool {
        if stage == LIMITER_STAGE {
            if self.limited && self.limiter.is_none() {
                self.limiter = Unit::new(LIMITER, self.rate, &[0.0; MAX_PARAMS]);
            }
            return !self.limited || self.limiter.is_some();
        }
        let kind = stage as usize;
        if kind >= SLOTS {
            return false;
        }
        if self.slots[kind].unit.is_some() {
            return true;
        }
        #[cfg(any(test, feature = "perf"))]
        if self.trap == (stage, IN_NEW) {
            panic!("a trap of the specs");
        }
        // (a trap as it is made leaves the slot without a unit: nothing of the retry is done)
        let mut unit = Unit::new(stage, self.rate, &self.params[kind]);
        if let Some(unit) = &mut unit {
            unit.grow(self.frames);
        }
        let gone = self.slots[kind].gone;
        self.stop(kind);
        self.slots[kind].gone = gone;
        self.slots[kind].unit = unit;
        // (a knob a route moves: its value again, the unit is at the one of the knob)
        self.modulation.renew(kind);
        self.start(kind);
        self.slots[kind].unit.is_some()
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

    /// the stage `stage` traps from now on, in its block (the specs)
    #[cfg(any(test, feature = "perf"))]
    pub fn trap(&mut self, stage: u32) {
        self.trap = (stage, IN_PROCESS);
    }

    /// the stage `stage` traps from now on in a call of its unit (`IN_SET`…; the specs)
    #[cfg(any(test, feature = "perf"))]
    pub fn trap_in(&mut self, stage: u32, call: u32) {
        self.trap = (stage, call);
    }
}
