//! the voices of one node (the engine node of a context): each with its params as AudioParams would give them
//! (a timeline of the events of the main thread per param, timeline.rs), rendered one after another in the order
//! they were created by the same Voice::process, their outputs summed in f32 in that order. A block also tells the
//! voices that started late (or on time too: `report`) and those that ended. A voice that traps (as it renders or as
//! it finishes its block: those whose filters run in one loop, up to four, all end) is ended by the wrapper (fail), the others
//! render on; the params of a voice may also come as the arrays of a block (direct:
//! the specs), and a tap keeps the output of every voice apart (the specs, the parity of the browsers). The pitch
//! bend is the node's: on top of the detune of every voice, gliding to each new value

use crate::filter::Designs;
use crate::glided::{glide_length, Glided};
use crate::shared::{Shared, PARAMS};
use crate::store::Store;
use crate::timeline::{Kind, Timeline};
use crate::voice::{Params, Voice, VoiceOptions, DETUNES};
use alloc::{vec, vec::Vec};
use core::sync::atomic::{compiler_fence, Ordering};
use dsp_core::filter_model::Layout;
use dsp_core::finite;

/// an automation event: setValueAtTime, setTargetAtTime, exponentialRampToValueAtTime, cancelScheduledValues,
/// linearRampToValueAtTime
pub const SET: u32 = 0;
pub const TARGET: u32 = 1;
pub const RAMP: u32 = 2;
pub const CANCEL: u32 = 3;
pub const LINEAR: u32 = 4;

/// the voices whose filters finish in one loop (filter::run_group): two pairs of lanes
const GROUP: usize = 4;

// what the scope does of a block, for fail(): in memory before each call of a voice that may trap
#[derive(Clone, Copy)]
enum Work {
    Idle,
    // the voice at the cursor renders
    Render,
    // the voices that waited (this many, at the places before the cursor) and the one at the cursor finish together
    // (0: it finishes alone)
    FinishGroup(usize),
    // the voices that waited (this many, before the cursor) finish without the one at the cursor; Some(playing):
    // that one is rendered in the output after theirs, not in the sum yet
    FinishWaiting(usize, Option<bool>),
    // the voices that waited (this many, before the cursor) finish before the one at the cursor, which plays on with
    // its filter still to run: its block in the output after theirs, its span after theirs (it waits next)
    FinishBefore(usize),
}

struct ScopeVoice {
    id: f64,
    voice: Voice,
    timelines: [Timeline; PARAMS],
    // the params of the next block given as they are (lengths, then PARAMS × frames values): not the timelines
    direct: Vec<f32>,
    // it tells its start even on time (a voice of mono, traced), once
    report: bool,
    reported: bool,
}

pub struct Scope {
    rate: f64,
    // the range of each param (its descriptor)
    ranges: [(f32, f32); PARAMS],
    voices: Vec<ScopeVoice>,
    frames: usize,
    // the params of a voice in a block (PARAMS × frames), the outputs of the voices of a group and the sum (left,
    // then right)
    params: Vec<f32>,
    outs: [Vec<f32>; GROUP],
    pub sum: Vec<f32>,
    // where the sum of the block goes (left, then right): `sum`, or the buffers of whoever plays the voices on
    // (process_into: the input of the chain, no copy between them); whether a voice is in the sum of the block (none:
    // it is all 0)
    into: *mut f32,
    pub mixed: bool,
    // the voices rendered up to their filters, in outs[0..waiting] (at the places before the cursor, the a..b of the
    // block of each in `spans`): they wait for the next ones, the filters of up to GROUP run in one loop
    // (Voice::finish_group)
    waiting: usize,
    spans: [(usize, usize); GROUP],
    // the layout of the voices that wait where every one is wide in it (Voice::wide): only then more than a pair
    // wait, all of it
    layout: Option<Layout>,
    // the block: its frame and length, the voice rendering (the next one), what it does of it now
    frame: f64,
    length: usize,
    cursor: usize,
    work: Work,
    // a voice that trapped while it ended (fail): dropped at the next call
    failed: Option<ScopeVoice>,
    // the voices that started (id, frame it started at, frame it was scheduled at) and ended since the last read
    pub started: Vec<[f64; 3]>,
    pub ended: Vec<f64>,
    // the outputs of the voices of the last block apart (ids, then left and right of each): tap() on
    tap: bool,
    pub tapped: Vec<f64>,
    pub taps: Vec<f32>,
    // the pitch bend of every voice (cents), the samples of its glide
    bend: Glided,
    glide: f64,
    // the designs of the filters of the voices, shared
    designs: Designs,
    // the voices of each finish, in turn
    #[cfg(test)]
    pub finished: Vec<usize>,
}

// the detune of a voice in a block (its first `length` values: one, or n) with the pitch bend on top: one value
// while both are (the voice stays on its mix tables), else n; the length of the values
pub fn bend_into(bend: &Glided, values: &mut [f32], length: usize) -> usize {
    if bend.constant && length == 1 {
        values[0] = (values[0] as f64 + bend.value()) as f32;
        return 1;
    }
    let first = values[0];
    for (i, value) in values.iter_mut().enumerate() {
        let detune = if length == 1 { first } else { *value };
        let cents = if bend.constant {
            bend.value()
        } else {
            bend.values[i] as f64
        };
        *value = (detune as f64 + cents) as f32;
    }
    values.len()
}

impl Scope {
    pub fn new(rate: f64, ranges: [(f32, f32); PARAMS]) -> Scope {
        Scope {
            rate,
            ranges,
            voices: Vec::new(),
            frames: 0,
            params: Vec::new(),
            outs: core::array::from_fn(|_| Vec::new()),
            waiting: 0,
            spans: [(0, 0); GROUP],
            layout: None,
            sum: Vec::new(),
            into: core::ptr::null_mut(),
            mixed: false,
            frame: 0.0,
            length: 0,
            cursor: 0,
            work: Work::Idle,
            failed: None,
            started: Vec::new(),
            ended: Vec::new(),
            tap: false,
            tapped: Vec::new(),
            taps: Vec::new(),
            bend: Glided::new(0.0),
            #[cfg(test)]
            finished: Vec::new(),
            designs: Designs::default(),
            glide: glide_length(rate),
        }
    }

    /// the pitch bend of every voice (cents): it glides there from where it is, `instantly` it is there (a node
    /// made again). One that is not finite is the rest (a NaN would stay in the glide for good: every voice silent)
    pub fn set_bend(&mut self, cents: f64, instantly: bool) {
        if instantly {
            self.bend.set(finite(cents));
        } else {
            self.bend.glide(finite(cents), self.glide);
        }
    }

    pub fn voices(&self) -> usize {
        self.voices.len()
    }

    /// the events the timelines of the voices hold
    pub fn events(&self) -> usize {
        self.voices
            .iter()
            .map(|voice| voice.timelines.iter().map(Timeline::len).sum::<usize>())
            .sum()
    }

    fn voice(&mut self, id: f64) -> Option<&mut ScopeVoice> {
        self.voices.iter_mut().find(|voice| voice.id == id)
    }

    /// a voice of a note: its options and the values of its params at the note on; `report`: it tells its start on
    /// time too, `linger`: it lives on after its release (a voice of mono: Voice::linger). Made, with the room of
    /// its place, before it holds its versions and its phrase: a trap of an allocation pins nothing
    #[allow(clippy::too_many_arguments)]
    pub fn on(
        &mut self,
        id: f64,
        options: VoiceOptions,
        values: [f64; PARAMS],
        report: bool,
        linger: bool,
        store: &mut Store,
        shared: &mut Shared,
    ) {
        let (rate, ranges) = (self.rate, self.ranges);
        let mut created = Voice::new(rate, options, shared);
        if linger {
            created.linger();
        }
        let mut voice = ScopeVoice {
            id,
            voice: created,
            timelines: core::array::from_fn(|k| Timeline::new(rate, values[k], ranges[k].0, ranges[k].1)),
            direct: Vec::new(),
            report,
            reported: false,
        };
        self.voices.reserve(1);
        self.started.reserve(self.voices.len() + 1);
        self.ended.reserve(self.voices.len() + 1);
        voice.voice.attach(store, shared);
        self.voices.push(voice);
    }

    /// an automation event of param `param` of voice `id` (none: it has ended, nothing happens). One there is no
    /// memory for ends the voice, told ended: without it the voice would play on wrong (a release lost would hold
    /// its note)
    pub fn event(
        &mut self,
        kind: u32,
        id: f64,
        param: usize,
        value: f64,
        time: f64,
        constant: f64,
        store: &mut Store,
        shared: &mut Shared,
    ) {
        let Some(at) = self.voices.iter().position(|voice| voice.id == id) else {
            return;
        };
        let Some(timeline) = self.voices[at].timelines.get_mut(param) else {
            return;
        };
        let stored = match kind {
            SET => timeline.insert(Kind::Set, time, value, 0.0),
            TARGET => timeline.insert(Kind::Target, time, value, constant),
            RAMP => timeline.insert(Kind::Ramp, time, value, 0.0),
            CANCEL => {
                timeline.cancel(time);
                true
            }
            LINEAR => timeline.insert(Kind::Linear, time, value, 0.0),
            _ => true,
        };
        if !stored {
            self.end_voice(at, store, shared);
        }
    }

    pub fn set_routes(&mut self, id: f64, routes: &[crate::modulation::VoiceRoute]) {
        if let Some(voice) = self.voice(id) {
            voice.voice.set_routes(routes);
        }
    }

    pub fn set_filter(&mut self, id: f64, filter: Option<crate::filter::FilterOptions>) {
        if let Some(voice) = self.voice(id) {
            voice.voice.set_filter(filter);
        }
    }

    /// new knobs of `module` (a `knobs` event) for voice `id`
    pub fn set_knobs(&mut self, id: f64, module: usize, values: &[f64]) {
        if let Some(voice) = self.voice(id) {
            voice.voice.set_knobs(module, values);
        }
    }

    /// voice `id` glides to `velocity` from `time` (seconds of the context; 0: now)
    pub fn set_velocity(&mut self, id: f64, velocity: crate::velocity::VoiceVelocity, time: f64) {
        if let Some(voice) = self.voice(id) {
            voice.voice.set_velocity(velocity, time);
        }
    }

    /// the params of voice `id` for the blocks of `frames` from now on, given directly (lengths, then PARAMS ×
    /// frames values); None: no such voice
    pub fn direct(&mut self, id: f64, frames: usize) -> Option<&mut [f32]> {
        let voice = self.voice(id)?;
        let size = PARAMS + PARAMS * frames;
        if voice.direct.len() != size {
            voice.direct = vec![0.0; size];
        }
        Some(&mut voice.direct)
    }

    /// voice `id` traps as it finishes its blocks from now on (the specs of the perf build)
    #[cfg(feature = "perf")]
    pub fn set_trap(&mut self, id: f64) {
        if let Some(voice) = self.voice(id) {
            voice.voice.set_trap();
        }
    }

    pub fn set_tap(&mut self, on: bool) {
        self.tap = on;
    }

    // the buffers of a block of `n` (they grow, never shrink), the room of the reports and the taps
    fn grow(&mut self, n: usize) {
        if n > self.frames {
            self.params = vec![0.0; PARAMS * n];
            self.outs = core::array::from_fn(|_| vec![0.0; 2 * n]);
            self.sum = vec![0.0; 2 * n];
            self.frames = n;
        }
        let voices = self.voices.len();
        self.started.reserve(voices);
        self.ended.reserve(voices);
        if self.tap {
            self.tapped.clear();
            self.taps.clear();
            self.tapped.reserve(voices);
            self.taps.reserve(2 * n * voices);
        }
    }

    /// a block of `n` frames at `frame`: every voice, the sum at sum[..n] (left) and sum[n..2n] (right)
    pub fn process(&mut self, frame: f64, n: usize, store: &mut Store, shared: &mut Shared) {
        self.grow(n);
        let into = self.sum.as_mut_ptr();
        // SAFETY: the sum has the room of the block and is not moved while it renders
        unsafe { self.process_into(frame, n, into, store, shared) };
    }

    /// the block of `process`, its sum at `into` (left at 0, right at `n`) and not in `sum`: the same values
    ///
    /// # Safety
    /// `into` has room for 2 × `n` values no one else holds, and stays where it is until the block is over (after a
    /// trap: until `fail` and `resume` are)
    pub unsafe fn process_into(
        &mut self,
        frame: f64,
        n: usize,
        into: *mut f32,
        store: &mut Store,
        shared: &mut Shared,
    ) {
        self.failed = None;
        self.work = Work::Idle;
        compiler_fence(Ordering::SeqCst);
        self.grow(n);
        self.frame = frame;
        self.length = n;
        self.cursor = 0;
        self.waiting = 0;
        self.into = into;
        self.mixed = false;
        core::slice::from_raw_parts_mut(into, 2 * n).fill(0.0);
        self.bend.render(0, n);
        self.resume(store, shared);
    }

    /// the voices of the block from the next one on (after a voice trapped and failed)
    pub fn resume(&mut self, store: &mut Store, shared: &mut Shared) {
        let (frame, n) = (self.frame, self.length);
        // (none at rest: the detunes as they are, to the bit)
        let bent = !self.bend.constant || self.bend.value() != 0.0;
        // the bend of the block for the noise of Pitch Track: one value at rest
        let bend_one = [self.bend.value() as f32];
        while self.cursor < self.voices.len() {
            // a trap leaves the memory as it is then (it is not a return): the voice rendering, the sum and the
            // reports of the voices before it are in it before the voice renders, not kept in registers past it
            // (the stores of the work and the cursor would be dead on the path that returns)
            self.at_work(Work::Render);
            // (next to the voices that wait: into the output after theirs)
            let slot = self.waiting;
            let voice = &mut self.voices[self.cursor];
            let (playing, filtered) = {
                let (out_l, out_r) = self.outs[slot][..2 * n].split_at_mut(n);
                let params: Params = if voice.direct.is_empty() {
                    let mut lengths = [1usize; PARAMS];
                    for (k, timeline) in voice.timelines.iter_mut().enumerate() {
                        lengths[k] = timeline.render(frame, &mut self.params[k * n..(k + 1) * n]);
                    }
                    if bent {
                        for k in DETUNES {
                            lengths[k] =
                                bend_into(&self.bend, &mut self.params[k * n..(k + 1) * n], lengths[k]);
                        }
                    }
                    let params = &self.params;
                    core::array::from_fn(|k| &params[k * n..k * n + lengths[k]])
                } else {
                    let (lengths, values) = voice.direct.split_at(PARAMS);
                    let stride = values.len() / PARAMS;
                    let length = |k: usize| if lengths[k] > 1.0 { n } else { 1 };
                    // (the detunes bent in the buffer of the block: the arrays given stay as they are)
                    let mut bent_lengths = [0usize; PARAMS];
                    if bent {
                        for k in DETUNES {
                            let values = &values[k * stride..k * stride + length(k)];
                            let block = &mut self.params[k * n..(k + 1) * n];
                            block[..values.len()].copy_from_slice(values);
                            bent_lengths[k] = bend_into(&self.bend, block, values.len());
                        }
                    }
                    let params = &self.params;
                    core::array::from_fn(|k| {
                        if bent_lengths[k] > 0 {
                            &params[k * n..k * n + bent_lengths[k]]
                        } else {
                            &values[k * stride..k * stride + length(k)]
                        }
                    })
                };
                let bend: &[f32] = if self.bend.constant {
                    &bend_one
                } else {
                    &self.bend.values[..n]
                };
                voice
                    .voice
                    .render(frame, &params, bend, out_l, out_r, store, shared)
            };
            self.work = Work::Idle;
            // a voice with a filter that plays on waits for the next one: a pair, a group of up to GROUP while every
            // one of them is wide in one layout (their filters faster together); the last of a group, the last voice,
            // one that ended: it and those that wait finish together
            let last = self.cursor + 1 == self.voices.len();
            // (asked only where a group may grow: the first one, after wide ones)
            let may = self.waiting == 0 || self.layout.is_some();
            let layout = match filtered {
                Some((a, b)) if may => self.voices[self.cursor].voice.wide(a, b, n),
                _ => None,
            };
            let joins = self.waiting == 0 || (layout.is_some() && layout == self.layout);
            match filtered {
                Some(span) if playing && !last && joins && self.waiting + 1 < GROUP => {
                    self.spans[self.waiting] = span;
                    if self.waiting == 0 {
                        self.layout = layout;
                    }
                    self.waiting += 1;
                    self.cursor += 1;
                    continue;
                }
                // wide ones that wait and one wide in another layout, or a pair or three of them and one that is not
                // wide: they finish, this one waits for the next (next to them it would run alone; one not wide
                // after one wide still pairs with it, their layout may be one)
                Some(span)
                    if playing
                        && !last
                        && !joins
                        && self.layout.is_some()
                        && (self.waiting >= 2 || layout.is_some()) =>
                {
                    self.spans[slot] = span;
                    self.at_work(Work::FinishBefore(slot));
                    self.finish(slot);
                    self.work = Work::Idle;
                    self.settle_waiting();
                    self.wait_alone(slot, layout);
                    continue;
                }
                Some(span) => {
                    self.spans[self.waiting] = span;
                    self.at_work(Work::FinishGroup(self.waiting));
                    self.finish(self.waiting + 1);
                    self.work = Work::Idle;
                    self.settle_waiting();
                }
                None => self.finish_waiting(Some(playing)),
            }
            self.advance(slot, playing);
        }
        // (the voice after them trapped: they finish without it)
        self.finish_waiting(None);
    }

    // the first `members` voices of a group (those that wait, then the one at the cursor), their blocks in
    // outs[0..members]: their filters, their volumes
    fn finish(&mut self, members: usize) {
        #[cfg(test)]
        self.finished.push(members);
        match members {
            2 => self.finish_group::<2>(),
            3 => self.finish_group::<3>(),
            4 => self.finish_group::<4>(),
            _ => {
                let n = self.length;
                let (a, b) = self.spans[0];
                let (out_l, out_r) = self.outs[0][..2 * n].split_at_mut(n);
                self.voices[self.cursor - self.waiting].voice.finish(
                    self.frame,
                    a,
                    b,
                    out_l,
                    out_r,
                    Some(&self.designs),
                );
            }
        }
    }

    fn finish_group<const N: usize>(&mut self) {
        let n = self.length;
        let mut voices = self.voices[self.cursor - self.waiting..].iter_mut();
        let mut outs = self.outs.iter_mut();
        // (N of them there are, by `finish`: a trap otherwise)
        let voices: [&mut Voice; N] = core::array::from_fn(|_| &mut voices.next().unwrap().voice);
        let outs: [[&mut [f32]; 2]; N] = core::array::from_fn(|_| {
            let (left, right) = outs.next().unwrap()[..2 * n].split_at_mut(n);
            [left, right]
        });
        let spans = core::array::from_fn(|k| self.spans[k]);
        Voice::finish_group(voices, self.frame, spans, outs, n, &self.designs);
    }

    // the finished blocks of the voices that waited: into the sum, in their order
    fn settle_waiting(&mut self) {
        for k in 0..self.waiting {
            self.settle(self.cursor - self.waiting + k, k);
        }
        self.waiting = 0;
    }

    // the scope is at `work`: in memory before the call that may trap
    fn at_work(&mut self, work: Work) {
        self.work = work;
        compiler_fence(Ordering::SeqCst);
    }

    // the voices that wait finish without the one at the cursor: their filters, their volumes, then into the sum;
    // `next`: whether the voice at the cursor, rendered next to them, plays on (None: no voice there)
    fn finish_waiting(&mut self, next: Option<bool>) {
        if self.waiting > 0 {
            self.at_work(Work::FinishWaiting(self.waiting, next));
            self.finish(self.waiting);
            self.work = Work::Idle;
            self.settle_waiting();
        }
    }

    // the voice at the cursor, its block in outs[slot] and its span in spans[slot] (its filter to run), waits for the
    // next one alone (`layout`: where it is wide)
    fn wait_alone(&mut self, slot: usize, layout: Option<Layout>) {
        self.outs.swap(0, slot);
        self.spans[0] = self.spans[slot];
        self.layout = layout;
        self.waiting = 1;
        self.cursor += 1;
    }

    // the voice at the cursor has its block in outs[slot]: into the sum, then the next one (it is gone, told
    // ended, once it plays no more)
    fn advance(&mut self, slot: usize, playing: bool) {
        self.settle(self.cursor, slot);
        if playing {
            self.cursor += 1;
        } else {
            self.ended.push(self.voices[self.cursor].id);
            self.voices.remove(self.cursor);
        }
    }

    // the finished block of voice `at` in outs[slot]: into the sum and the taps, its start told
    fn settle(&mut self, at: usize, slot: usize) {
        let n = self.length;
        let voice = &mut self.voices[at];
        {
            let (out_l, out_r) = self.outs[slot][..2 * n].split_at(n);
            // SAFETY: the room of the block (process_into), held here alone
            let (sum_l, sum_r) = unsafe { core::slice::from_raw_parts_mut(self.into, 2 * n) }.split_at_mut(n);
            for i in 0..n {
                sum_l[i] += out_l[i];
                sum_r[i] += out_r[i];
            }
        }
        self.mixed = true;
        if self.tap {
            self.tapped.push(voice.id);
            self.taps.extend_from_slice(&self.outs[slot][..2 * n]);
        }
        let started_at = voice.voice.started_at;
        if !voice.reported && started_at >= 0.0 {
            voice.reported = true;
            let scheduled = voice.voice.start_frame;
            if voice.report || started_at > scheduled {
                self.started.push([voice.id, started_at, scheduled]);
            }
        }
    }

    /// a voice trapped as it rendered or finished its block: it ends (gives its versions and mixes back) and is
    /// told ended, its output is not in the sum; those that finished together (their filters in one loop) all end
    /// (the trap is of any). False when the trap was not in a voice (the block is silence)
    pub fn fail(&mut self, store: &mut Store, shared: &mut Shared) -> bool {
        self.failed = None;
        let work = self.work;
        self.work = Work::Idle;
        if self.cursor >= self.voices.len() && !matches!(work, Work::FinishWaiting(_, None)) {
            return false;
        }
        match work {
            Work::Idle => return false,
            // (one that render() ended already ends once: Voice::end)
            Work::Render => self.end_voice(self.cursor, store, shared),
            Work::FinishGroup(waited) => {
                // (if this end traps too, the others still wait: they finish without it)
                self.end_voice(self.cursor, store, shared);
                self.waiting = 0;
                for _ in 0..waited {
                    self.cursor -= 1;
                    self.end_voice(self.cursor, store, shared);
                }
            }
            Work::FinishWaiting(waited, next) => {
                self.waiting = 0;
                let first = self.cursor - waited;
                // the voice rendered next to them is not rendered again: into the sum as it is (its place is after
                // theirs: they stay where they are)
                if let Some(playing) = next {
                    self.advance(waited, playing);
                }
                for k in (0..waited).rev() {
                    self.end_voice(first + k, store, shared);
                    self.cursor -= 1;
                }
            }
            Work::FinishBefore(waited) => {
                self.waiting = 0;
                let first = self.cursor - waited;
                for k in (0..waited).rev() {
                    self.end_voice(first + k, store, shared);
                    self.cursor -= 1;
                }
                // the voice rendered next to them still has its filter to run: it waits for the next one, as it
                // would have (not rendered again; none groups with it)
                self.wait_alone(waited, None);
            }
        }
        true
    }

    // voice `at` ends now (gives its versions and mixes back) and is told ended
    fn end_voice(&mut self, at: usize, store: &mut Store, shared: &mut Shared) {
        let voice = self.voices.remove(at);
        self.ended.push(voice.id);
        // (kept while it ends: if that traps too, the next call drops it)
        let failed = self.failed.insert(voice);
        compiler_fence(Ordering::SeqCst);
        failed.voice.end(store, shared);
        self.failed = None;
    }

    /// every voice ends (the node is gone): their versions and mixes are given back
    pub fn end(&mut self, store: &mut Store, shared: &mut Shared) {
        self.failed = None;
        while let Some(mut voice) = self.voices.pop() {
            voice.voice.end(store, shared);
        }
    }
}
