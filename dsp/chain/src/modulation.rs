//! The modulation of the knobs of the effects: there is one chain for the whole synth, so its knobs follow the
//! envelopes and the LFOs of the last note pressed (fx-modulation.ts of the app has the same sums for the marks
//! of the knobs; the LFOs run without a note too, on their clocks) and the macros (their levels the node's, as
//! the voices have them: with a note or without one). Worked out once for the chain, only while a route moves a
//! knob of an effect that plays.
//!
//! A knob of a unit takes one value a block (`set`: the unit glides to it). The knobs of the delay, the bands of
//! the EQ and the mix of a slot are lines: the offset the routes move the knob by, a value a sample (worked out
//! at points every 32 samples of a block and its last sample, linear between them; of the frequency of a band of
//! the EQ in octaves), added to the knob as it glides. A change of a line (a route, a knob, a new note) glides
//! from where the line was in GLIDE: no step; a line gone (its routes, or its slot stops playing) goes to 0 so,
//! and the chain adds a line for as long as there is one: a slot that fades out takes its offset down with it.
//! The time of the delay and the offsets of its channels (`SMOOTHED`) are lines through a one-pole instead (of
//! delay::TIME_SMOOTHING, as the Audio Unit follows the LFOs on its time): worked out at the points, exact over the
//! line of the target between two (`smooth`), linear between them, no glide (the pole makes none); one gone goes
//! to 0 through it, no more once within delay::NEAR_SAMPLES of a sample of it.

use alloc::{vec, vec::Vec};

use dsp_core::blocks::smooth;
use dsp_core::envelope::{envelope_value, EnvelopeParams};
use dsp_core::finite;
use dsp_core::glided::glide_length;
use dsp_core::lfo::{frac, Anchor, LfoBlock, LfoGlobal, LfoState, KNOBS, LFOS, PHASE, RATE, TABLE};
use dsp_core::macros::{levels_of, Macros};
// the sources: ENV 1–3, VELO, LFO 1–4, MACRO 1–4 (those of the voices: MOD_SOURCES of the app)
use dsp_core::sources::{is_lfo, is_macro, SOURCES};
pub use dsp_core::sources::{ENVELOPES, LFO_SOURCE, MACRO_SOURCE};
use jsmath::{exp, log2, max, min, pow, sqrt};

use crate::chain::gains;
use crate::delay;
use crate::eq;
use crate::units::{law, Law, DELAY as DELAY_SLOT, EQ as EQ_SLOT, MAX_PARAMS, SLOTS};

/// a target: slot · 32 + the key of a param of its unit, MIX_KEY its mix; from LFO_TARGET on lfo · LFO_KEYS + a knob of
/// an LFO (the routes of the note to its LFOs)
pub const KEYS: usize = 32;
pub const MIX_KEY: usize = 31;
pub const LFO_TARGET: usize = SLOTS * KEYS;
pub const LFO_KEYS: usize = 8;
/// the values of a route: target, source, amount, min, max, scale (0 linear, 1 log, 2 pow), bipolar
pub const ROUTE: usize = 7;
/// the values of a note: start, release (seconds of the context; NaN: held), velo, whether it starts its
/// envelopes from levels, those levels, then attack, hold, decay, sustain, release and three curves of each
pub const NOTE: usize = 7 + ENVELOPES * 8;
/// the values of a state of an LFO: mode, delay, rise, smooth, phase, the anchor (time, phase, period), a new table
pub const LFO_STATE: usize = 9;

/// the lines: the knobs of the units that are lines (`KNOB_LINES`: of the delay, the frequency, the resonance and
/// the gain of each band of the EQ), then the dry and the wet gain of each slot
pub const LINE_TIME: usize = 0;
pub const LINE_FB: usize = 1;
pub const LINE_PAN: usize = 2;
pub const LINE_FREQ: usize = 4;
pub const LINE_Q: usize = 5;
pub const LINE_EQ: usize = 6;
pub const LINE_MIX: usize = KNOB_LINES.len();
pub const LINES: usize = LINE_MIX + 2 * SLOTS;
// (`LINE_EQ` is the row of the frequency of band 1: a line added before the rows of the EQ would shift them)
const _: () = assert!(KNOB_LINES[LINE_EQ].0 == EQ_SLOT && KNOB_LINES[LINE_EQ].1 == eq::F1);

/// the knobs of the units that are lines, a line each in this order (the pan of the delay two: the offset of each
/// channel): the slot, the key, how a knob maps to its line. The lines of a slot are its `Moves` (those of the EQ
/// by band: the frequency in octaves, the resonance, the gain)
const KNOB_LINES: [(u32, usize, Map); 12] = [
    (DELAY_SLOT, delay::TIME, Map::Linear),
    (DELAY_SLOT, delay::FB, Map::Linear),
    (DELAY_SLOT, delay::PAN, Map::PanLeft),
    (DELAY_SLOT, delay::PAN, Map::PanRight),
    (DELAY_SLOT, delay::FREQ, Map::Linear),
    (DELAY_SLOT, delay::Q, Map::Linear),
    (EQ_SLOT, eq::F1, Map::Octaves),
    (EQ_SLOT, eq::Q1, Map::Linear),
    (EQ_SLOT, eq::G1, Map::Linear),
    (EQ_SLOT, eq::F2, Map::Octaves),
    (EQ_SLOT, eq::Q2, Map::Linear),
    (EQ_SLOT, eq::G2, Map::Linear),
];

/// the lines through the one-pole of the time of the delay: its time, the offsets of its channels
const SMOOTHED: [usize; 3] = [LINE_TIME, LINE_PAN, LINE_PAN + 1];

/// the switches of the units with lines, no knob a route moves (the app routes no switch): set at every block, the
/// mode of the delay would change and a type of the EQ start its fade again and again
const SWITCHES: [(u32, usize); 3] = [(DELAY_SLOT, delay::MODE), (EQ_SLOT, eq::T1), (EQ_SLOT, eq::T2)];

const SEGMENT: usize = 32;
const LOG: u32 = 1;
const POW: u32 = 2;
// the points an LFO steps through to a later frame at most: after a rest of the chain it goes on from there
const CATCH_UP: f64 = 4.0;

#[derive(Clone, Copy)]
struct Route {
    target: usize,
    source: usize,
    amount: f64,
    min: f64,
    max: f64,
    scale: u32,
    bipolar: bool,
}

#[derive(Clone, Copy)]
struct Note {
    envelopes: [EnvelopeParams; ENVELOPES],
    start: f64,
    // seconds after the start (Infinity: held)
    released: f64,
    restarted: bool,
    from: [f64; ENVELOPES],
    velo: f64,
}

// the routes of one knob: `count` of them from `start` on
#[derive(Clone, Copy, Default)]
struct Group {
    start: usize,
    count: usize,
}

// how a knob maps to what its line is added to: as it is, the octaves of a frequency of the EQ (its knob glides in
// octaves: an offset in Hz of the new knob over the knob on its way there went under 0 Hz), the offset of a channel
// of a pan, the dry or the wet gain of a mix by its law
#[derive(Clone, Copy, PartialEq)]
enum Map {
    Linear,
    Octaves,
    PanLeft,
    PanRight,
    Dry(Law),
    Wet(Law),
}

fn mapped(map: Map, value: f64) -> f64 {
    match map {
        Map::Linear => value,
        // (within the knob, as the band takes it)
        Map::Octaves => log2(min(max(value, eq::MIN_FREQ), eq::MAX_FREQ)),
        Map::PanLeft => max(0.0, value),
        Map::PanRight => max(0.0, -value),
        Map::Dry(law) => gains(law, value).0,
        Map::Wet(law) => gains(law, value).1,
    }
}

struct Line {
    group: Option<Group>,
    slot: usize,
    map: Map,
    // what it was worked out of in the last block: a change starts a glide
    played: (bool, f64, u32),
    last: f64,
    from: f64,
    done: f64,
    idle: bool,
    values: Vec<f64>,
}

// a line through a one-pole of `tau` samples (`pole`: exp(-SEGMENT / tau); `step`: of a sample, from the last
// point of a block to the first of the next), at 0 within `near`: the target and the value at its last point, the
// frame of it, the pole of the last other length (the short last segment of a block: the same every block)
#[derive(Clone, Copy)]
struct Smoothing {
    tau: f64,
    pole: f64,
    step: f64,
    near: f64,
    input: f64,
    value: f64,
    at: f64,
    other: (f64, f64),
}

impl Smoothing {
    // the value at a point (the frame `at`, after the last one) of the target `x` there, its input a line from the
    // last point
    fn next(&mut self, x: f64, at: f64) -> f64 {
        let length = at - self.at;
        if length > 0.0 {
            let pole = if length == SEGMENT as f64 {
                self.pole
            } else if length == 1.0 {
                self.step
            } else {
                if self.other.0 != length {
                    self.other = (length, exp(-length / self.tau));
                }
                self.other.1
            };
            self.value = smooth(self.value, self.input, x, length, self.tau, Some(pole));
        }
        self.input = x;
        self.at = at;
        self.value
    }
}

// a knob of a unit a route moves: its value of the last block (NaN: none set)
struct Moved {
    slot: usize,
    key: usize,
    group: Group,
    last: f64,
}

/// the knobs as the main thread has them: the params of each unit, the mix of each slot, whether it plays (on
/// and in the order to come) and whether it mixes its effect in (it plays and has its late input: the lines of
/// its mix start then)
pub struct Bases<'a> {
    pub params: &'a [[f64; MAX_PARAMS]; SLOTS],
    pub mix: &'a [f64; SLOTS],
    pub on: &'a [bool; SLOTS],
    pub mixes: &'a [bool; SLOTS],
}

pub struct Modulation {
    rate: f64,
    glide: f64,
    routes: Vec<Route>,
    moved: Vec<Moved>,
    // knobs that lost their routes, or whose slot stopped: back at their base in the next block
    back: Vec<(usize, usize)>,
    lines: [Line; LINES],
    smoothings: [Smoothing; SMOOTHED.len()],
    knobs: [[Group; KNOBS]; LFOS],
    // the knobs of each LFO its routes move (a bit a knob) and those of them a macro moves (without a note too)
    lfo_knobs: [u8; LFOS],
    macro_knobs: [u8; LFOS],
    // the routes as of set_routes: a line that reads them anew glides
    epoch: u32,
    note: Option<Note>,
    next: Option<Option<Note>>,
    globals: [LfoGlobal; LFOS],
    runners: [LfoBlock; LFOS],
    points: Vec<usize>,
    levels: [Vec<f64>; LFOS],
    // the levels of the macros, rendered for the block
    macros: Macros,
}

fn term(route: &Route, level: f64) -> f64 {
    route.amount * if route.bipolar { level - 0.5 } else { level }
}

// a knob moved from `base` by the sum of its routes, in the scale of the knob (of its first route), not clamped
fn moved_by(base: f64, sum: f64, route: &Route) -> f64 {
    match route.scale {
        LOG => base * pow(2.0, sum),
        POW => {
            let share = min(1.0, max(0.0, sqrt(sqrt(base / route.max)) + sum));
            route.max * share * share * share * share
        }
        _ => base + sum,
    }
}

fn clamp_to(value: f64, route: &Route) -> f64 {
    min(route.max, max(route.min, value))
}

fn level_of(note: &Note, source: usize, t: f64) -> f64 {
    if source < ENVELOPES {
        envelope_value(&note.envelopes[source], t, note.released, note.from[source])
    } else if source < LFO_SOURCE {
        note.velo
    } else {
        0.0
    }
}

impl Modulation {
    pub fn new(sample_rate: f64) -> Modulation {
        let mut runners: [LfoBlock; LFOS] = core::array::from_fn(|_| LfoBlock::new(sample_rate, 0.0));
        for runner in runners.iter_mut() {
            runner.free();
        }
        Modulation {
            rate: sample_rate,
            glide: glide_length(sample_rate),
            routes: Vec::new(),
            moved: Vec::new(),
            back: Vec::new(),
            lines: core::array::from_fn(|index| Line {
                group: None,
                slot: if index < LINE_MIX {
                    KNOB_LINES[index].0 as usize
                } else {
                    (index - LINE_MIX) / 2
                },
                map: Map::Linear,
                played: (false, 0.0, 0),
                last: 0.0,
                from: 0.0,
                done: f64::INFINITY,
                idle: true,
                values: Vec::new(),
            }),
            smoothings: {
                let tau = delay::TIME_SMOOTHING * sample_rate;
                [Smoothing {
                    tau,
                    pole: exp(-(SEGMENT as f64) / tau),
                    step: exp(-1.0 / tau),
                    // (the lines of the delay in seconds)
                    near: delay::NEAR_SAMPLES / sample_rate,
                    input: 0.0,
                    value: 0.0,
                    at: 0.0,
                    other: (f64::NAN, 0.0),
                }; SMOOTHED.len()]
            },
            knobs: [[Group::default(); KNOBS]; LFOS],
            lfo_knobs: [0; LFOS],
            macro_knobs: [0; LFOS],
            epoch: 0,
            note: None,
            next: None,
            globals: core::array::from_fn(|_| LfoGlobal::default()),
            runners,
            points: Vec::new(),
            levels: core::array::from_fn(|_| Vec::new()),
            macros: Macros::default(),
        }
    }

    /// room for blocks of `frames` (allocates: not while a block renders)
    pub fn grow(&mut self, frames: usize) {
        for line in self.lines.iter_mut() {
            if line.values.len() < frames {
                line.values = vec![0.0; frames];
            }
        }
        let points = frames / SEGMENT + 2;
        if self.points.capacity() < points {
            self.points = Vec::with_capacity(points);
        }
        for levels in self.levels.iter_mut() {
            if levels.len() < points {
                *levels = vec![0.0; points];
            }
        }
    }

    /// the routes, ROUTE values each (at once: the note comes at its time). A target no one has is left out
    pub fn set_routes(&mut self, values: &[f64]) {
        for knob in self.moved.iter() {
            self.back.push((knob.slot, knob.key));
        }
        self.moved.clear();
        self.routes.clear();
        for route in values.chunks_exact(ROUTE) {
            let target = finite(route[0]) as usize;
            let source = finite(route[1]) as usize;
            if target >= LFO_TARGET + LFOS * LFO_KEYS || source >= SOURCES {
                continue;
            }
            self.routes.push(Route {
                target,
                source,
                amount: finite(route[2]),
                min: finite(route[3]),
                max: finite(route[4]),
                scale: finite(route[5]) as u32,
                bipolar: route[6] != 0.0,
            });
        }
        // (the routes of a knob one after another, in the order they came)
        self.routes.sort_by_key(|route| route.target);
        self.knobs = [[Group::default(); KNOBS]; LFOS];
        self.lfo_knobs = [0; LFOS];
        self.macro_knobs = [0; LFOS];
        for line in self.lines.iter_mut() {
            line.group = None;
        }
        self.epoch = self.epoch.wrapping_add(1);
        let mut start = 0;
        while start < self.routes.len() {
            let target = self.routes[start].target;
            let count = self.routes[start..]
                .iter()
                .take_while(|route| route.target == target)
                .count();
            self.place(target, Group { start, count });
            start += count;
        }
        let moved = &self.moved;
        self.back
            .retain(|&(slot, key)| !moved.iter().any(|knob| knob.slot == slot && knob.key == key));
    }

    // the routes of a target: a knob of an LFO, a line, a knob of a unit
    fn place(&mut self, target: usize, group: Group) {
        if target >= LFO_TARGET {
            let (lfo, knob) = ((target - LFO_TARGET) / LFO_KEYS, (target - LFO_TARGET) % LFO_KEYS);
            // (an LFO moves no knob of an LFO: the routes of the note, its envelopes and VELO, and the macros)
            let reads_lfo = self.routes_of(group).iter().any(|route| is_lfo(route.source));
            if knob < KNOBS && !reads_lfo {
                self.knobs[lfo][knob] = group;
                self.lfo_knobs[lfo] |= 1 << knob;
                if self.routes_of(group).iter().any(|route| is_macro(route.source)) {
                    self.macro_knobs[lfo] |= 1 << knob;
                }
            }
            return;
        }
        let (slot, key) = (target / KEYS, target % KEYS);
        let mut line = |index: usize, map: Map| {
            self.lines[index].group = Some(group);
            self.lines[index].map = map;
        };
        if key == MIX_KEY {
            match law(slot as u32) {
                Law::Inside(mix) => self.moved.push(Moved {
                    slot,
                    key: mix,
                    group,
                    last: f64::NAN,
                }),
                mixed => {
                    line(LINE_MIX + 2 * slot, Map::Dry(mixed));
                    line(LINE_MIX + 2 * slot + 1, Map::Wet(mixed));
                }
            }
        } else {
            // a knob that is a line, or a knob the unit takes once a block (no switch)
            let mut lined = false;
            for (index, &(of, knob, map)) in KNOB_LINES.iter().enumerate() {
                if (of as usize, knob) == (slot, key) {
                    line(index, map);
                    lined = true;
                }
            }
            if !lined && key < MAX_PARAMS && !SWITCHES.contains(&(slot as u32, key)) {
                self.moved.push(Moved {
                    slot,
                    key,
                    group,
                    last: f64::NAN,
                });
            }
        }
    }

    /// the last note (NOTE values; `present` false: none, only the LFOs move, on their clocks): taken at the
    /// first block at or after its start, the note before goes on until then
    pub fn set_note(&mut self, present: bool, values: &[f64]) {
        if !present || values.len() < NOTE {
            self.next = Some(None);
            return;
        }
        let start = finite(values[0]);
        let restarted = values[3] != 0.0;
        self.next = Some(Some(Note {
            envelopes: core::array::from_fn(|envelope| {
                let at = 7 + envelope * 8;
                EnvelopeParams {
                    attack: finite(values[at]),
                    hold: finite(values[at + 1]),
                    decay: finite(values[at + 2]),
                    sustain: finite(values[at + 3]),
                    release: finite(values[at + 4]),
                    curves: [
                        finite(values[at + 5]),
                        finite(values[at + 6]),
                        finite(values[at + 7]),
                    ],
                }
            }),
            start,
            released: if values[1].is_nan() {
                f64::INFINITY
            } else {
                values[1] - start
            },
            restarted,
            from: core::array::from_fn(|envelope| {
                if restarted {
                    finite(values[4 + envelope])
                } else {
                    0.0
                }
            }),
            velo: finite(values[2]),
        }));
    }

    /// the levels of a new shape of LFO `lfo` (TABLE + 1, within 0..1), until a state takes them
    pub fn lfo_table(&mut self, lfo: usize, values: &[f64]) {
        if let Some(global) = self.globals.get_mut(lfo) {
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

    /// the LFOs from `at` (seconds) on: LFO_STATE values each; `instantly`: there at once
    pub fn set_lfos(&mut self, at: f64, instantly: bool, values: &[f64]) {
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
            self.globals[lfo].set(finite(at), &state, instantly);
        }
    }

    /// the levels of the macros (MACROS values: one that is not a number leaves its macro) from the next block,
    /// gliding there; `instantly`: there at once (a node made again)
    pub fn set_macros(&mut self, values: &[f64], instantly: bool) {
        self.macros.set(&levels_of(values), instantly, self.glide);
    }

    /// the levels of the macros in the block of `frames` at `frame`: at every block, whether the routes are worked
    /// out or not (a glide takes its time)
    pub fn render_macros(&mut self, frame: f64, frames: usize) {
        self.macros.render(frame, frames);
    }

    // the level of `source` at `t` (seconds): an envelope or VELO of the note (none: 0), a macro; not an LFO
    fn level_at(&self, source: usize, t: f64) -> f64 {
        if is_macro(source) {
            return self.macros.level_at(source - MACRO_SOURCE, t * self.rate);
        }
        match &self.note {
            Some(note) => level_of(note, source, t - note.start),
            None => 0.0,
        }
    }

    /// a route moves this knob of a unit that plays: its value comes from `block`, not from its knob
    pub fn moves(&self, slot: usize, key: usize) -> bool {
        self.moved.iter().any(|knob| knob.slot == slot && knob.key == key)
    }

    /// the unit of a slot was made again: the knobs of it the routes move are set anew in the next block
    pub fn renew(&mut self, slot: usize) {
        for knob in self.moved.iter_mut().filter(|knob| knob.slot == slot) {
            knob.last = f64::NAN;
        }
    }

    /// nothing to work out: no route, no knob to put back, no line that still glides
    pub fn idle(&self) -> bool {
        self.routes.is_empty() && self.back.is_empty() && self.lines.iter().all(|line| line.idle)
    }

    /// the offsets of a line in the block worked out last (None: it adds nothing)
    pub fn line(&self, index: usize, frames: usize) -> Option<&[f64]> {
        let line = &self.lines[index];
        if line.idle {
            None
        } else {
            Some(&line.values[..frames])
        }
    }

    // the note the LFOs run from: a new start starts them (again on a voice that sounds: from where they are)
    fn follow(&mut self, next: Option<Note>) {
        let same = match (&next, &self.note) {
            (Some(next), Some(note)) => next.start == note.start,
            (None, None) => true,
            _ => false,
        };
        if !same {
            for runner in self.runners.iter_mut() {
                match &next {
                    None => runner.free(),
                    Some(next) if self.note.is_some() && next.restarted => {
                        runner.retrigger(next.start * self.rate)
                    }
                    Some(next) => runner.start_at(next.start * self.rate),
                }
            }
        }
        self.note = next;
    }

    // the knobs of LFO `lfo` its routes move now (a bit a knob): without a note those a macro moves
    fn moved_knobs(&self, lfo: usize) -> u8 {
        if self.note.is_some() {
            self.lfo_knobs[lfo]
        } else {
            self.macro_knobs[lfo]
        }
    }

    // the knobs of an LFO the routes of the note and the macros move at t (those of `mask`, moved_knobs: without a
    // note only the macros move them; a knob not in it is its own, None)
    fn mods(&self, lfo: usize, mask: u8, t: f64) -> [Option<f64>; KNOBS] {
        let mut mods = [None; KNOBS];
        let noted = self.note.is_some();
        let moves = |route: &Route| noted || is_macro(route.source);
        let global = &self.globals[lfo];
        for knob in (0..KNOBS).filter(|knob| mask & (1 << knob) != 0) {
            let routes = self.routes_of(self.knobs[lfo][knob]);
            let knobs = global.knobs(t);
            let base = match knob {
                RATE => 1.0 / global.period(t),
                PHASE => knobs.phase(t),
                dsp_core::lfo::DELAY => knobs.delay,
                dsp_core::lfo::RISE => knobs.rise,
                _ => knobs.smooth,
            };
            let mut sum = 0.0;
            for route in routes.iter().filter(|route| moves(route)) {
                sum += term(route, self.level_at(route.source, t));
            }
            let value = moved_by(base, sum, &routes[0]);
            mods[knob] = Some(if knob == PHASE {
                frac(value)
            } else {
                clamp_to(value, &routes[0])
            });
        }
        mods
    }

    // the level of an LFO at a frame, stepped from its last point in points of 32 samples
    fn lfo_at(&mut self, lfo: usize, frame: f64) -> f64 {
        let (last, level) = self.runners[lfo].last();
        // (the knobs moved: the same at every step, the note is that of the block; none moved, none worked out)
        let mask = self.moved_knobs(lfo);
        let mods_at = |modulation: &Modulation, f: f64| {
            if mask == 0 {
                [None; KNOBS]
            } else {
                modulation.mods(lfo, mask, f / modulation.rate)
            }
        };
        if !last.is_nan() {
            if frame <= last {
                return level;
            }
            let mut f = max(last + SEGMENT as f64, frame - CATCH_UP * SEGMENT as f64);
            while f < frame {
                let mods = mods_at(self, f);
                self.runners[lfo].point(f, &self.globals[lfo], &mods);
                f += SEGMENT as f64;
            }
        }
        let mods = mods_at(self, frame);
        self.runners[lfo].point(frame, &self.globals[lfo], &mods)
    }

    fn routes_of(&self, group: Group) -> &[Route] {
        &self.routes[group.start..group.start + group.count]
    }

    // the sum of the routes of a knob at point `j` of the block at `frame`
    fn sum(&self, group: Group, frame: f64, j: usize) -> f64 {
        let t = (frame + self.points[j] as f64) / self.rate;
        let mut sum = 0.0;
        for route in self.routes_of(group) {
            let level = if is_lfo(route.source) {
                self.levels[route.source - LFO_SOURCE][j]
            } else {
                self.level_at(route.source, t)
            };
            sum += term(route, level);
        }
        sum
    }

    // the slot of a line sounds with it: a line of a mix once the slot mixes its effect in
    fn plays(index: usize, slot: usize, bases: &Bases) -> bool {
        if index >= LINE_MIX {
            bases.mixes[slot]
        } else {
            bases.on[slot]
        }
    }

    // the knob a line follows
    fn base_of(index: usize, bases: &Bases) -> f64 {
        match KNOB_LINES.get(index) {
            Some(&(slot, key, _)) => bases.params[slot as usize][key],
            None => bases.mix[(index - LINE_MIX) / 2],
        }
    }

    /// the block of `frames` at `frame`: the note due is taken, `set` gets the knobs of the units whose value
    /// changed (slot, key, value), the lines are worked out
    pub fn block(
        &mut self,
        frame: f64,
        frames: usize,
        bases: &Bases,
        set: &mut dyn FnMut(usize, usize, f64),
    ) {
        if let Some(next) = self.next {
            let due = match &next {
                None => true,
                Some(note) => note.start * self.rate <= frame,
            };
            if due {
                self.next = None;
                self.follow(next);
                for line in self.lines.iter_mut() {
                    if !line.idle {
                        line.from = f64::NAN;
                        line.done = 0.0;
                    }
                }
            }
        }
        for (slot, key) in self.back.drain(..) {
            set(slot, key, bases.params[slot][key]);
        }
        if frames == 0 || (self.routes.is_empty() && self.lines.iter().all(|line| line.idle)) {
            return;
        }

        // the points of the block, the LFOs at them: all of them for a line, the first one for a knob of a unit
        self.points.clear();
        let mut point = 0;
        loop {
            self.points.push(point);
            if point == frames - 1 {
                break;
            }
            point = (point + SEGMENT).min(frames - 1);
        }
        let mut reads = [0usize; LFOS];
        for knob in self.moved.iter().filter(|knob| bases.on[knob.slot]) {
            for route in self.routes_of(knob.group) {
                if is_lfo(route.source) {
                    reads[route.source - LFO_SOURCE] = reads[route.source - LFO_SOURCE].max(1);
                }
            }
        }
        for (index, line) in self.lines.iter().enumerate() {
            if !Self::plays(index, line.slot, bases) {
                continue;
            }
            let Some(group) = line.group else { continue };
            for route in self.routes_of(group) {
                if is_lfo(route.source) {
                    reads[route.source - LFO_SOURCE] = self.points.len();
                }
            }
        }
        for lfo in 0..LFOS {
            for j in 0..reads[lfo] {
                self.levels[lfo][j] = self.lfo_at(lfo, frame + self.points[j] as f64);
            }
        }

        // the knobs of the units: one value a block
        for index in 0..self.moved.len() {
            let Moved {
                slot,
                key,
                group,
                last,
            } = self.moved[index];
            if !bases.on[slot] {
                // (its slot stopped: the knob as it is, moved again once it plays)
                if !last.is_nan() {
                    self.moved[index].last = f64::NAN;
                    set(slot, key, bases.params[slot][key]);
                }
                continue;
            }
            let first = &self.routes[group.start];
            let value = clamp_to(
                moved_by(bases.params[slot][key], self.sum(group, frame, 0), first),
                first,
            );
            if value != last {
                self.moved[index].last = value;
                set(slot, key, value);
            }
        }

        // the lines
        let glide = self.glide;
        for index in 0..LINES {
            let group = self.lines[index]
                .group
                .filter(|_| Self::plays(index, self.lines[index].slot, bases));
            if group.is_none() && self.lines[index].idle {
                continue;
            }
            let base = Self::base_of(index, bases);
            let played = (group.is_some(), base, self.epoch);
            let map = self.lines[index].map;
            let smoothed = SMOOTHED.iter().position(|&line| line == index);
            if played != self.lines[index].played {
                if let (Some(k), true) = (smoothed, self.lines[index].idle) {
                    // (from 0, a sample before the block)
                    let start = &mut self.smoothings[k];
                    (start.input, start.value, start.at) = (0.0, 0.0, frame - 1.0);
                }
                self.lines[index].played = played;
                self.lines[index].idle = false;
                self.lines[index].from = f64::NAN;
                self.lines[index].done = 0.0;
            }
            // the target at the points, linear between them
            let rest = if group.is_some() { mapped(map, base) } else { 0.0 };
            let offset = |modulation: &Modulation, j: usize| match group {
                Some(group) => {
                    let first = &modulation.routes[group.start];
                    let moved = clamp_to(moved_by(base, modulation.sum(group, frame, j), first), first);
                    mapped(map, moved) - rest
                }
                None => 0.0,
            };
            let mut values = core::mem::take(&mut self.lines[index].values);
            // (a line of the time: each point through its pole, in a loop of its own; the others as they were)
            let smoothing = match smoothed {
                Some(k) => {
                    let mut smoothing = self.smoothings[k];
                    let mut previous = smoothing.next(offset(self, 0), frame + self.points[0] as f64);
                    values[0] = previous;
                    for j in 1..self.points.len() {
                        let (a, b) = (self.points[j - 1], self.points[j]);
                        let value = smoothing.next(offset(self, j), frame + b as f64);
                        let step = (value - previous) / (b - a) as f64;
                        for i in a + 1..=b {
                            values[i] = previous + step * (i - a) as f64;
                        }
                        previous = value;
                    }
                    self.smoothings[k] = smoothing;
                    Some(smoothing)
                }
                None => {
                    let mut previous = offset(self, 0);
                    values[0] = previous;
                    for j in 1..self.points.len() {
                        let value = offset(self, j);
                        let (a, b) = (self.points[j - 1], self.points[j]);
                        let step = (value - previous) / (b - a) as f64;
                        for i in a + 1..=b {
                            values[i] = previous + step * (i - a) as f64;
                        }
                        previous = value;
                    }
                    None
                }
            };
            let line = &mut self.lines[index];
            // (a line gone is no more once a block of it was all 0: the block its glide ends in still has it; one
            // through its pole once within `near` of 0)
            let over = group.is_none()
                && match smoothing {
                    Some(smoothing) => smoothing.value.abs() < smoothing.near,
                    None => line.done >= glide,
                };
            if smoothing.is_none() && line.done < glide {
                if line.from.is_nan() {
                    line.from = line.last - values[0];
                }
                for (i, value) in values[..frames].iter_mut().enumerate() {
                    *value += line.from * max(0.0, 1.0 - (line.done + i as f64) / glide);
                }
                line.done += frames as f64;
            }
            line.last = values[frames - 1];
            if over {
                line.idle = true;
                line.last = 0.0;
            }
            line.values = values;
        }
    }
}
