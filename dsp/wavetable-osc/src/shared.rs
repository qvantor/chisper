//! createVoiceShared of wavetable-osc-dsp.ts: what the voices of a scope share, the buffers of a block (they
//! render one after another), the pool of mix tables, the budget of mix builds per block, the legato phrases and
//! the counters (VoiceStats, the perf build); and the params and outputs of the block the wrapper copies in and out

use crate::glided::glide_length;
use crate::lfo::{frac, Anchor, LfoGlobal, LfoState, KNOBS, LFOS, TABLE};
use crate::macros::{levels_of, Macros, MACROS};
use crate::store::{FRAME_GUARD, MAX_LEVEL_LENGTH};
use crate::sub::SubPhase;
use alloc::{vec, vec::Vec};
use jsmath::{ceil, max};

/// the multiply-adds of mix builds a block may spend: the core builds a mix about twice as fast as the TS core did
/// with its 200000 (the attack of a chord in Node, one shared:
/// 0.105 against 0.215 µs per 1000 multiply-adds at 48 kHz, 0.138 against 0.30 at 96 kHz); the most whose
/// longest block of the attack of a chord of 12 × 2 × u8 is not longer than the one of the TS (0.170 against
/// 0.172 ms; 400000: 0.180), its 192 mixes built from block 26 on instead of 56. Since the mixes are as long as
/// their levels and only the voices in a crossfade build one (the others read their level alone) the 32 of the
/// heavy chord at 48 kHz are built by block 3
pub const MIX_BUDGET_WASM: f64 = 360000.0;
const SEGMENT: f64 = 32.0;
pub const PARAMS: usize = 12;
/// the rows of the io of a voice alone: its params, then the pitch bend of the block (the noise of Pitch Track reads
/// it; the detunes have it already)
pub const IO_ROWS: usize = PARAMS + 1;

pub const VOICES: usize = 0;
pub const UNISON: usize = 1;
pub const MIX_SAMPLES: usize = 2;
pub const DIRECT_SAMPLES: usize = 3;
pub const BUILDS: usize = 4;
pub const BUILD_COST: usize = 5;
pub const REFUSED: usize = 6;
pub const PEAK_COST: usize = 7;
pub const MIXES: usize = 8;
pub const MIX_BYTES: usize = 9;

/// the channels the sources of a voice add into in a block (source.rs), then through the filter and ENV 1 into its
/// outputs: left, right and the middle voices (of an odd unison; a source in the middle) in `center`, added into both
/// sides by the output stage. One for the voices of a scope (they render one after another): no room per voice
#[derive(Default)]
pub struct Bus {
    pub left: Vec<f32>,
    pub right: Vec<f32>,
    pub center: Vec<f32>,
}

impl Bus {
    /// a..b silent before the sources add into it
    pub fn clear(&mut self, a: usize, b: usize) {
        self.left[a..b].fill(0.0);
        self.right[a..b].fill(0.0);
        self.center[a..b].fill(0.0);
    }
}

#[derive(Default)]
pub struct Scratch {
    pub bus: Bus,
    pub a_left: Vec<f32>,
    pub a_right: Vec<f32>,
    pub a_center: Vec<f32>,
    pub b_left: Vec<f32>,
    pub b_right: Vec<f32>,
    pub b_center: Vec<f32>,
    // the centre voices of an even unison (its middle two, left and right) apart from the others, while its blend
    // moves (of the version a crossfade goes to: b_mid_*)
    pub a_mid_left: Vec<f32>,
    pub a_mid_right: Vec<f32>,
    pub b_mid_left: Vec<f32>,
    pub b_mid_right: Vec<f32>,
    pub fading: Vec<f32>,
    // the warped phases of a span of a voice (warp_phases: the block and a group past it), the share of the second
    // level each of its samples reads (local_phases)
    pub phases: Vec<u32>,
    pub shares: Vec<f32>,
    pub points: Vec<i32>,
    pub positions: Vec<f64>,
    // the knob of the warp of an oscillator at each point, the param of its map there, the levels it moves the
    // pitch by (render_osc, render_voices) and of a bend the most levels its slope moves a sample by (warp::local_most:
    // once a point for all its voices)
    pub warp_knobs: Vec<f64>,
    pub warp_params: Vec<f64>,
    pub warp_levels: Vec<f64>,
    pub warp_most: Vec<f64>,
    // the bases of the knobs of the LFOs of a voice per sample (LFOS · KNOBS × the block), while one changes in it
    pub lfo_bases: Vec<f32>,
}

/// what the cycle of a warped mix is of besides the pitch of its voice (voice.rs build_warped_mix): the levels (the
/// serial of their version, Store::serial, and where they are), a of the bend, the length of the mix, its frame on the
/// level lo (its sample 0 in the data and its length) and on hi if it is another
#[derive(Clone, Copy, PartialEq)]
pub struct CycleKey {
    pub serial: u64,
    pub data: usize,
    pub a: u64,
    pub length: usize,
    pub first: (usize, usize),
    pub second: Option<(usize, usize)>,
}

/// the cycle of a warped mix before the pitch of a voice tells the share of each of its samples: `first` its frame
/// on the level lo at the phases of the mix through the bend (sample c at c), `second` the one on hi less it, `ups`
/// the levels of the slope of samples 0..=length / 2 (warp::local_ups). The voices of a unison, and a note struck
/// again, build their mixes of it: no pass of the phases, no read of the levels
#[derive(Default)]
pub struct WarpedCycle {
    pub key: Option<CycleKey>,
    pub first: Vec<f32>,
    pub second: Vec<f32>,
    pub ups: Vec<f32>,
    used: u64,
}

impl WarpedCycle {
    // the room of a cycle of `length` (of the longest level at once: it never grows again); false: no memory for it
    fn room(&mut self, length: usize) -> bool {
        let size = length.max(MAX_LEVEL_LENGTH) + 1;
        let fits = |buffer: &mut Vec<f32>, size: usize| {
            if buffer.len() < size {
                if buffer.try_reserve_exact(size - buffer.len()).is_err() {
                    return false;
                }
                buffer.resize(size, 0.0);
            }
            true
        };
        // (the pass of the ups writes whole groups of 4)
        fits(&mut self.first, size) && fits(&mut self.second, size) && fits(&mut self.ups, size / 2 + 5)
    }
}

/// the cycles kept (two: the two oscillators of a note)
pub const CYCLES: usize = 2;

struct Phrase {
    id: f64,
    frame: f64,
    voices: f64,
}

pub struct Shared {
    size: usize,
    pub scratch: Scratch,
    // the mix tables no voice holds, each as long as the longest level can be (any of them holds any mix)
    pool: Vec<Vec<f32>>,
    // the cycles the warped mixes were last built of
    pub cycles: [WarpedCycle; CYCLES],
    cycle_uses: u64,
    budget_frame: f64,
    spent: f64,
    pub counts: [f64; 10],
    phrases: Vec<Phrase>,
    // the params of the block and its bend (IO_ROWS × frames values, their lengths) and the outputs (left, right)
    pub params: Vec<f32>,
    pub lengths: [f32; IO_ROWS],
    pub output: Vec<f32>,
    frames: usize,
    // the weights of the 6-point Lagrange interpolation per ratio (the upsamplers of the TS, cached per scope; ratio 2
    // only since the mixes are as long as their levels)
    pub upsamplers: Vec<(usize, Vec<f64>)>,
    // the LFOs of the voices (lfo.rs) and the count of their states: a voice that sees another one works its LFOs
    // out again
    pub lfos: [LfoGlobal; LFOS],
    pub lfo_epoch: u32,
    // the macros of the node (the routes read them as sources 8–11), rendered once a block, the levels sent that
    // wait for their frame (the frame, the levels: NaN leaves a macro; the
    // first `waiting` of them, in the order they are due) and the latest frame one came with; a voice that sees
    // another count of the levels taken wakes its routes
    pub macros: Macros,
    macros_glide: f64,
    waiting_macros: [(f64, [f64; MACROS]); WAITING_MACROS],
    waiting: usize,
    macros_stamped: f64,
    pub macro_epoch: u32,
    // the phase of the sub of the note started last (a note of Contiguous starts at it) and the serials of the subs
    pub sub: SubPhase,
    pub sub_serial: u64,
    // (the specs: every build refused, the voices play directly)
    #[cfg(test)]
    pub refuse_builds: bool,
}

impl Default for Shared {
    fn default() -> Self {
        Shared {
            size: 0,
            scratch: Scratch::default(),
            pool: Vec::new(),
            cycles: Default::default(),
            cycle_uses: 0,
            budget_frame: -1.0,
            spent: 0.0,
            counts: [0.0; 10],
            phrases: Vec::new(),
            params: Vec::new(),
            lengths: [1.0; IO_ROWS],
            output: Vec::new(),
            frames: 0,
            upsamplers: Vec::new(),
            lfos: Default::default(),
            lfo_epoch: 0,
            macros: Macros::default(),
            macros_glide: 1.0,
            waiting_macros: [(0.0, [0.0; MACROS]); WAITING_MACROS],
            waiting: 0,
            macros_stamped: 0.0,
            macro_epoch: 0,
            sub: SubPhase::default(),
            sub_serial: 0,
            #[cfg(test)]
            refuse_builds: false,
        }
    }
}

/// the levels of the macros that wait for their frames at most (the automation of a clip sent ahead: a point every
/// few ms at most for TRACK_LEAD); one more and the first is taken at once
const WAITING_MACROS: usize = 64;

/// the values of a state of an LFO in the command buffer: mode, delay, rise, smooth, phase, the anchor (time,
/// phase, period), a new table
pub const LFO_STATE: usize = 9;

impl Shared {
    /// the levels of a new shape of LFO `lfo` (TABLE + 1, within 0..1), until a state takes them
    pub fn lfo_table(&mut self, lfo: usize, values: &[f64]) {
        if let Some(global) = self.lfos.get_mut(lfo) {
            for (level, value) in global.incoming.iter_mut().zip(values.iter().take(TABLE + 1)) {
                *level = if *value > 1.0 {
                    1.0
                } else if *value > 0.0 {
                    *value as f32
                } else {
                    0.0
                };
            }
        }
    }

    /// the LFOs from `at` (seconds) on: LFO_STATE values each; `instantly`: there at once. A value that is not
    /// finite is 0, a period that is not one keeps the clock as it was
    pub fn set_lfos(&mut self, at: f64, instantly: bool, values: &[f64]) {
        let finite = |value: f64| if value.is_finite() { value } else { 0.0 };
        for (lfo, state) in values.chunks_exact(LFO_STATE).take(LFOS).enumerate() {
            let period = state[7];
            let anchor = (period.is_finite() && period > 0.0 && state[5].is_finite() && state[6].is_finite())
                .then_some(Anchor {
                    time: state[5],
                    phase: state[6],
                    period,
                });
            let state = LfoState {
                mode: state[0] as u32,
                delay: max(0.0, finite(state[1])),
                rise: max(0.0, finite(state[2])),
                smooth: max(0.0, finite(state[3])),
                phase: frac(finite(state[4])),
                anchor,
                table: state[8] != 0.0,
            };
            self.lfos[lfo].set(finite(at), &state, instantly);
        }
        self.lfo_epoch = self.lfo_epoch.wrapping_add(1);
    }

    /// the levels of the macros (MACROS values: one that is not a number leaves its macro) from the first block that
    /// starts at frame `at` or after it, in the order sent; 0: now, and now is not before a frame one came with
    /// before it (as the events of the chain: the halves take them in the same blocks). `instantly`: there at once,
    /// no glide, and those that wait are forgotten (a node made again: the levels of now; the shared outlives a node).
    /// WAITING_MACROS wait at most: the first one is taken at once to make room
    pub fn set_macros(&mut self, at: f64, instantly: bool, levels: &[f64]) {
        let levels = levels_of(levels);
        if instantly {
            self.waiting = 0;
            self.macros_stamped = 0.0;
            self.take_macros(&levels, true, 1.0);
            return;
        }
        let due = if at > 0.0 {
            self.macros_stamped = max(self.macros_stamped, at);
            at
        } else {
            self.macros_stamped
        };
        if self.waiting == WAITING_MACROS {
            let (_, first) = self.waiting_macros[0];
            self.take_macros(&first, false, self.macros_glide);
            self.waiting_macros.copy_within(1.., 0);
            self.waiting -= 1;
        }
        // (after those due by then: most often the last place)
        let mut place = self.waiting;
        while place > 0 && self.waiting_macros[place - 1].0 > due {
            place -= 1;
        }
        self.waiting_macros.copy_within(place..self.waiting, place + 1);
        self.waiting_macros[place] = (due, levels);
        self.waiting += 1;
    }

    fn take_macros(&mut self, levels: &[f64; MACROS], instantly: bool, length: f64) {
        if self.macros.set(levels, instantly, length) {
            self.macro_epoch = self.macro_epoch.wrapping_add(1);
        }
    }

    /// the macros of the block of `n` at `frame` (`rate` its sample rate): the levels due glide from it, the levels
    /// of the block once for its voices (the next voice of the same block finds them rendered)
    pub fn render_macros(&mut self, frame: f64, n: usize, rate: f64) {
        if self.macros.rendered(frame) {
            return;
        }
        self.macros_glide = glide_length(rate);
        let mut taken = 0;
        while taken < self.waiting && self.waiting_macros[taken].0 <= frame {
            let (_, levels) = self.waiting_macros[taken];
            self.take_macros(&levels, false, self.macros_glide);
            taken += 1;
        }
        if taken > 0 {
            self.waiting_macros.copy_within(taken..self.waiting, 0);
            self.waiting -= taken;
        }
        self.macros.render(frame, n);
    }

    /// room for one phrase more: a voice joins its phrase without allocating (Voice::attach)
    pub fn reserve_phrase(&mut self) {
        self.phrases.reserve(1);
    }

    pub fn join_phrase(&mut self, id: f64, opens: bool) -> bool {
        match self.phrases.iter_mut().find(|phrase| phrase.id == id) {
            Some(phrase) => phrase.voices += 1.0,
            None => {
                if !opens {
                    return false;
                }
                self.phrases.push(Phrase {
                    id,
                    frame: -1.0,
                    voices: 1.0,
                });
            }
        }
        true
    }

    pub fn leave_phrase(&mut self, id: f64) {
        if let Some(i) = self.phrases.iter().position(|phrase| phrase.id == id) {
            self.phrases[i].voices -= 1.0;
            if self.phrases[i].voices <= 0.0 {
                self.phrases.remove(i);
            }
        }
    }

    pub fn start_phrase(&mut self, id: f64, frame: f64) {
        if let Some(phrase) = self.phrases.iter_mut().find(|phrase| phrase.id == id) {
            if phrase.frame < 0.0 {
                phrase.frame = frame;
            }
        }
    }

    pub fn phrase_frame(&self, id: f64, start: f64, frame: f64) -> f64 {
        match self.phrases.iter().find(|phrase| phrase.id == id) {
            None => start,
            Some(phrase) if phrase.frame >= 0.0 => phrase.frame,
            Some(_) => max(start, frame),
        }
    }

    /// the buffers of a block of `length` (they grow, never shrink) and the room of the kept cycles; the size is set once all of them are allocated:
    /// an allocation that traps leaves the old size, the next block allocates them again
    pub fn grow(&mut self, length: usize) {
        if length > self.size {
            let s = &mut self.scratch;
            for buffer in [
                &mut s.bus.left,
                &mut s.bus.right,
                &mut s.bus.center,
                &mut s.a_left,
                &mut s.a_right,
                &mut s.a_center,
                &mut s.b_left,
                &mut s.b_right,
                &mut s.b_center,
                &mut s.a_mid_left,
                &mut s.a_mid_right,
                &mut s.b_mid_left,
                &mut s.b_mid_right,
                &mut s.fading,
            ] {
                *buffer = vec![0.0; length];
            }
            s.phases = vec![0; length + 4];
            s.shares = vec![0.0; length + 4];
            let points = ceil(length as f64 / SEGMENT) as usize + 2;
            s.points = vec![0; points];
            s.positions = vec![0.0; points];
            s.warp_knobs = vec![0.0; points];
            s.warp_params = vec![0.0; points];
            s.warp_levels = vec![0.0; points];
            s.warp_most = vec![0.0; points];
            s.lfo_bases = vec![0.0; LFOS * KNOBS * length];
            // the room of the cycles of the warped mixes with them: none allocated at the first mix of a note (one
            // without memory for it now asks again there: `cycle`)
            for cycle in &mut self.cycles {
                cycle.room(0);
            }
            self.size = length;
        }
    }

    /// a mix table of `length` (from the pool, or allocated room for the longest level: a mix of any level takes it
    /// later, no size of the pool runs out while another one is kept); None: no memory for it, the voice plays
    /// directly, as when the budget refuses a build (the same sound, more CPU)
    pub fn acquire_mix(&mut self, length: usize) -> Option<Vec<f32>> {
        let size = length.checked_add(FRAME_GUARD)?;
        let mut mix = match self.pool.pop() {
            Some(mix) => mix,
            None => {
                let mut mix = Vec::new();
                mix.try_reserve_exact(length.max(MAX_LEVEL_LENGTH) + FRAME_GUARD)
                    .ok()?;
                if cfg!(feature = "perf") {
                    self.counts[MIXES] += 1.0;
                    self.counts[MIX_BYTES] += 4.0 * mix.capacity() as f64;
                }
                mix
            }
        };
        // (within its room: no allocation)
        mix.clear();
        mix.try_reserve_exact(size).ok()?;
        mix.resize(size, 0.0f32);
        Some(mix)
    }

    /// a mix table back to the pool (freed when the pool has no memory to keep it: the end of a voice never traps)
    pub fn release_mix(&mut self, mix: Vec<f32>) {
        if self.pool.try_reserve(1).is_ok() {
            self.pool.push(mix);
        }
    }

    /// whether the cycle of `key` is kept: a build of it is the shares of a pitch alone (its cost in the budget)
    pub fn keeps(&self, key: &CycleKey) -> bool {
        self.cycles.iter().any(|cycle| cycle.key.as_ref() == Some(key))
    }

    /// the cycle of `key` among those kept (its index, true), or the one used the longest ago with room for it, its
    /// key gone (false: to fill); None: no memory for it
    pub fn cycle(&mut self, key: CycleKey) -> Option<(usize, bool)> {
        self.cycle_uses += 1;
        if let Some(i) = self.cycles.iter().position(|cycle| cycle.key == Some(key)) {
            self.cycles[i].used = self.cycle_uses;
            return Some((i, true));
        }
        let i = (0..CYCLES).min_by_key(|&i| self.cycles[i].used)?;
        let cycle = &mut self.cycles[i];
        cycle.key = None;
        if !cycle.room(key.length) {
            return None;
        }
        cycle.used = self.cycle_uses;
        Some((i, false))
    }

    /// a mix build of `cost` in the block at `frame`, if the budget allows (the first of a block always)
    pub fn take_build(&mut self, frame: f64, cost: f64) -> bool {
        if frame != self.budget_frame {
            self.budget_frame = frame;
            self.spent = 0.0;
        }
        #[cfg(test)]
        if self.refuse_builds {
            return false;
        }
        if self.spent > 0.0 && self.spent + cost > MIX_BUDGET_WASM {
            if cfg!(feature = "perf") {
                self.counts[REFUSED] += 1.0;
            }
            return false;
        }
        self.spent += cost;
        if cfg!(feature = "perf") {
            self.counts[BUILDS] += 1.0;
            self.counts[BUILD_COST] += cost;
            if self.spent > self.counts[PEAK_COST] {
                self.counts[PEAK_COST] = self.spent;
            }
        }
        true
    }

    /// the counters (the peak cost starts again from here)
    pub fn stats(&mut self) -> [f64; 10] {
        let stats = self.counts;
        self.counts[PEAK_COST] = 0.0;
        stats
    }

    /// room for the params and the outputs of a block of `frames`
    pub fn reserve_io(&mut self, frames: usize) {
        // (also after a trap left them out of the shared: osc_voice_process takes them while the voice renders)
        if self.frames < frames || self.params.len() < IO_ROWS * self.frames.max(frames) {
            // (both allocated before the size is set: one that traps leaves the old size, the next block tries again)
            let size = self.frames.max(frames);
            let params = vec![0.0; IO_ROWS * size];
            let output = vec![0.0; 2 * size];
            self.params = params;
            self.output = output;
            self.frames = size;
        }
    }

    pub fn io_frames(&self) -> usize {
        self.frames
    }
}
