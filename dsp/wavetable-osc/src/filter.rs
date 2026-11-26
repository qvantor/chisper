//! The filter of a voice after the oscillators, its knobs glide, the routes move them. The types of a
//! BiquadFilterNode: a state variable filter (trapezoidal integrators) in f32, the response of a BiquadFilterNode:
//! both are the bilinear transform of the same prototype, this one keeps its precision at a low cutoff where a
//! biquad in f32 loses it. The model types (dsp-core filter_model.rs: those of the Audio Unit of the renders): their
//! sections in f32 lanes, Drive and Var. The channels of a voice in two lanes, those of two voices in four (each
//! lane the operations of its channel, in the same order); two voices of different sections each alone. A change of
//! the type on a playing note into or out of a model type crossfades the filter before and the new one (FADE).
//! A model type whose design moves by its cutoff alone takes its coefficients between the designs of the cell of its
//! cutoff (filter_model::cutoff_cell), kept by its node: a sweep costs a design or two a cell, not one a span of each
//! voice.
//! A knob a type is not designed by (FAT, the resonance of a one-pole: ModelType::designed_by) moves no design nor
//! takes its cutoff off its cells: its FAT is set after a design, as Drive is

use alloc::{vec, vec::Vec};
use dsp_core::biquad::FilterType;
use dsp_core::filter_model::{self, LaneCoefs, LaneState, Layout, ModelType};
pub use dsp_core::model_spans::Designs;
pub(crate) use dsp_core::model_spans::SEGMENT;
use dsp_core::model_spans::{
    before, channels_of, crossfade, end_span, fine_sample, gated, glides, group, halves_of, lanes_of,
    model_span, piece_end, piece_knobs, pieces, run_span, sample, span_end, spans, take_spans, Line,
    ModelSlot, REFRESH, RESONANT,
};
use dsp_core::simd::{transpose, F32x4, U32x4};
use jsmath::{cos, exp, log2, max, pow, round, sin, sqrt, PI, SQRT2};

/// the type of the filter: one of a BiquadFilterNode (None: an unknown index, a constant 1) or a model one
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Kind {
    Web(Option<FilterType>),
    Model(ModelType),
}

/// the types of a BiquadFilterNode before the model ones in FILTER_TYPES
const WEB_TYPES: u32 = 8;

impl Kind {
    /// the type of an index of FILTER_TYPES (VoiceFilterOptions)
    pub fn from_index(index: u32) -> Kind {
        if index < WEB_TYPES {
            return Kind::Web(FilterType::from_index(index));
        }
        match ModelType::from_index(index - WEB_TYPES) {
            Some(ty) => Kind::Model(ty),
            None => Kind::Web(None),
        }
    }
}

/// the knobs of the filter (VoiceFilterOptions): the cutoff (Hz); the resonance and the gain of a type of a
/// BiquadFilterNode; the resonance, Drive and the variation (FAT or DB +/-) of a model type, in % (0..100)
#[derive(Clone, Copy, Debug)]
pub struct FilterOptions {
    pub kind: Kind,
    pub cutoff: f64,
    pub resonance: f64,
    pub gain: f64,
    pub drive: f64,
    pub variation: f64,
}

/// the knobs (k of VoiceFilter::base): cutoff, resonance, gain, drive, variation
pub const KNOBS: usize = 5;
const SMOOTHING: f64 = 0.0033;
const BLOCK: usize = 128;
/// seconds: the crossfade of a change of type into or out of a model type
pub const FADE: f64 = 0.01;

// the filter before a change of type while it fades out: its type, its coefficients and state (frozen knobs)
#[derive(Clone, Copy)]
struct Fade {
    kind: Kind,
    web: [f32; 6],
    web_state: [f32; 4],
    model: ModelSlot,
    // samples left of the fade, of its length
    left: usize,
    length: usize,
}

#[cfg_attr(test, derive(Clone))]
pub struct VoiceFilter {
    pub on: bool,
    kind: Kind,
    sample_rate: f64,
    values: [f64; KNOBS],
    targets: [f64; KNOBS],
    still: [[f32; 1]; KNOBS],
    gliding: [Vec<f32>; KNOBS],
    // the knob of each base this block: its still value or its glide
    base_glides: [bool; KNOBS],
    step: f64,
    // of the integrators and of the output (svf_into)
    coefficients: [f32; 6],
    // their damping (svf_into), the power of the resonance and the gain they were worked out with (power_of)
    k: f64,
    power: f64,
    last: [f64; 3],
    // the integrators: the first of the left and of the right, then the second ones
    state: [f32; 4],
    // a model type
    model: ModelSlot,
    fade: Option<Fade>,
    fade_length: usize,
    // a change of type while it fades: it waits for the end of the fade (glide), its knobs with it (they are of its
    // type: a resonance in % of a model type is not one in dB of a type of a BiquadFilterNode)
    pending: Option<FilterOptions>,
    // the channels of the filter before a change while it fades out
    scratch: [Vec<f32>; 2],
    // the layout of its pass over the whole block and whether a knob of it moves, worked out by `wide` for this
    // block, by the knobs they are of (where each is, its length): `pass` takes them for those knobs
    scanned: Option<(KnobKeys, Option<Layout>, bool)>,
}

impl VoiceFilter {
    pub fn new(sample_rate: f64, options: Option<FilterOptions>) -> VoiceFilter {
        let mut filter = VoiceFilter {
            on: false,
            kind: Kind::Web(Some(FilterType::Lowpass)),
            sample_rate,
            values: [0.0; KNOBS],
            targets: [0.0; KNOBS],
            still: [[0.0]; KNOBS],
            gliding: core::array::from_fn(|_| vec![0.0; BLOCK]),
            base_glides: [false; KNOBS],
            step: 1.0 - exp(-1.0 / (SMOOTHING * sample_rate)),
            coefficients: FROZEN,
            k: 0.0,
            power: 0.0,
            last: [f64::NAN; 3],
            state: [0.0; 4],
            model: ModelSlot::default(),
            fade: None,
            fade_length: max(1.0, round(FADE * sample_rate)) as usize,
            pending: None,
            scratch: [vec![0.0; BLOCK], vec![0.0; BLOCK]],
            scanned: None,
        };
        filter.apply(options, false);
        filter
    }

    fn settle(&mut self, k: usize) {
        self.still[k][0] = if k == 0 {
            pow(2.0, self.targets[k])
        } else {
            self.targets[k]
        } as f32;
    }

    fn apply(&mut self, next: Option<FilterOptions>, glide: bool) {
        self.scanned = None;
        let Some(next) = next else {
            self.on = false;
            self.fade = None;
            self.pending = None;
            return;
        };
        let restart = !glide || !self.on;
        // (a fade over the fade would cut the filter that fades out; back to the type it fades into: no change)
        self.pending = (!restart && self.alone() && next.kind != self.kind).then_some(next);
        if self.pending.is_some() {
            return;
        }
        self.targets[0] = log2(max(1e-3, next.cutoff));
        self.targets[1] = next.resonance;
        self.targets[2] = next.gain;
        self.targets[3] = next.drive;
        self.targets[4] = next.variation;
        let changed = next.kind != self.kind;
        // whether the filter that plays has run: one that never did (its note starts later) has no coefficients,
        // nothing to fade out (of a type of a BiquadFilterNode changed in the block: the state it rang with)
        let played = match self.kind {
            Kind::Model(_) => !self.model.last[0].is_nan(),
            Kind::Web(_) => !self.last[0].is_nan() || self.state != [0.0; 4],
        };
        if restart || changed {
            self.values = self.targets;
            for k in 0..KNOBS {
                self.settle(k);
            }
            self.last = [f64::NAN; 3];
        }
        let models = matches!(next.kind, Kind::Model(_)) || matches!(self.kind, Kind::Model(_));
        if restart {
            self.state = [0.0; 4];
            self.model.reset();
            self.fade = None;
        } else if changed && models {
            // into or out of a model type: the filter before fades out (one that played), the new one in from
            // silence
            self.fade = played.then_some(Fade {
                kind: self.kind,
                web: self.coefficients,
                web_state: self.state,
                model: self.model,
                left: self.fade_length,
                length: self.fade_length,
            });
            self.state = [0.0; 4];
            self.model.reset();
        } else if changed {
            let ty = web_type(next.kind);
            // the integrators of a resonance hold its ring (1 / k of the sound): into a type that damps more they
            // come down to the ring of that one, the voice doesn't burst with the ring of the type before
            let power = power_of(ty, next.resonance, next.gain);
            let k = svf_into(
                &mut [0.0; 6],
                ty,
                next.cutoff,
                next.resonance,
                power,
                self.sample_rate,
            );
            if self.k > 0.0 && k > self.k {
                self.state = self.state.map(|x| (x as f64 * (self.k / k)) as f32);
            }
        }
        self.kind = next.kind;
        self.on = true;
    }

    /// the knobs changed on a playing note: they glide (None: off)
    pub fn set(&mut self, next: Option<FilterOptions>) {
        self.apply(next, true);
    }

    /// the base of knob k (0 cutoff, 1 resonance, 2 gain, 3 drive, 4 variation) this block: one value or one per
    /// sample
    pub fn base(&self, k: usize) -> &[f32] {
        if self.base_glides[k] {
            &self.gliding[k]
        } else {
            &self.still[k]
        }
    }

    /// whether it runs alone this block (a fade, or a change of type waiting for its end): not in the lanes of
    /// another voice
    pub fn alone(&self) -> bool {
        self.fade.is_some_and(|fade| fade.left > 0) || self.pending.is_some()
    }

    /// whether a change of type waits for the end of a fade (the routes of its knobs keep the ranges of the type
    /// that plays: Modulation::set_holding)
    pub fn waits(&self) -> bool {
        self.pending.is_some()
    }

    /// a change of type that waited for the end of a fade: now, its knobs from this block on (before `glide`: a
    /// voice takes it before the routes held for it, which may read its cutoff, and asks then whether a route does)
    pub fn switch_type(&mut self) {
        if self.fade.is_some_and(|fade| fade.left == 0) {
            if let Some(next) = self.pending.take() {
                self.fade = None;
                self.apply(Some(next), true);
            }
        }
    }

    /// the layout of its pass over the whole block of n (its knobs, those the routes move replaced) where it runs
    /// faster next to other voices of that layout, two pairs in one loop (run_group); None: not there. What it works
    /// out the pass of this block takes
    pub fn wide<'m>(
        &mut self,
        a: usize,
        b: usize,
        n: usize,
        moved: impl FnOnce() -> [Option<&'m [f32]>; KNOBS],
    ) -> Option<Layout> {
        if !matches!(self.kind, Kind::Model(_)) || !self.on || a != 0 || b != n || self.alone() {
            return None;
        }
        let (keys, layout, moving) = {
            let moved = moved();
            let knobs: [&[f32]; KNOBS] = core::array::from_fn(|i| moved[i].unwrap_or(self.base(i)));
            (
                keys_of(&knobs),
                layout_of(self.kind, &knobs),
                knobs.iter().any(|values| values.len() > 1),
            )
        };
        self.scanned = Some((keys, layout, moving));
        layout.filter(|layout| interleaves(*layout, moving))
    }

    /// the knobs of a block of n samples; `spans` Some(a): the cutoff (in Hz, a power of 2 a sample) is read only at
    /// the starts of the spans of a pass from a (a, a + SEGMENT…: no route reads it), worked out only there
    pub fn glide(&mut self, n: usize, spans: Option<usize>) {
        self.scanned = None;
        for k in 0..KNOBS {
            let mut value = self.values[k];
            let target = self.targets[k];
            self.base_glides[k] = false;
            if value != target {
                if self.gliding[k].len() != n {
                    self.gliding[k] = vec![0.0; n];
                }
                let step = self.step;
                let out = &mut self.gliding[k];
                match (k, spans) {
                    (0, Some(a)) => {
                        for (i, slot) in out.iter_mut().enumerate().take(n) {
                            value += (target - value) * step;
                            if i >= a && (i - a).is_multiple_of(SEGMENT) {
                                *slot = pow(2.0, value) as f32;
                            }
                        }
                    }
                    (0, None) => {
                        for slot in out.iter_mut().take(n) {
                            value += (target - value) * step;
                            *slot = pow(2.0, value) as f32;
                        }
                    }
                    _ => {
                        for slot in out.iter_mut().take(n) {
                            value += (target - value) * step;
                            *slot = value as f32;
                        }
                    }
                }
                self.base_glides[k] = true;
                self.values[k] = if (target - value).abs() <= target.abs() * 1e-6 + 1e-9 {
                    target
                } else {
                    value
                };
                if self.values[k] == target {
                    self.settle(k);
                }
            }
        }
    }

    /// the filter over a..b of a block: its knobs, those the routes move replaced (`moved`)
    pub fn pass<'a>(&'a mut self, a: usize, b: usize, moved: [Option<&'a [f32]>; KNOBS]) -> Pass<'a> {
        let VoiceFilter {
            kind,
            sample_rate,
            still,
            gliding,
            base_glides,
            coefficients,
            k,
            power,
            last,
            state,
            model,
            fade,
            scratch,
            scanned,
            ..
        } = self;
        // (a fade that ended: the new filter alone)
        if fade.is_some_and(|fade| fade.left == 0) {
            *fade = None;
        }
        let knobs: [&'a [f32]; KNOBS] = core::array::from_fn(|i| {
            moved[i].unwrap_or(if base_glides[i] {
                gliding[i].as_slice()
            } else {
                still[i].as_slice()
            })
        });
        let engine = match *kind {
            Kind::Web(ty) => Engine::Web {
                ty,
                coefficients,
                k,
                power,
                last,
                state,
                current: FROZEN,
                step: STILL,
                ramps: false,
            },
            Kind::Model(ty) => Engine::Model { ty, slot: model },
        };
        // (worked out by `wide` for this block of the same knobs: once)
        let (layout, moving) = match scanned.take() {
            Some((keys, layout, moving)) if keys == keys_of(&knobs) => (layout, moving),
            _ => (
                layout_of(*kind, &knobs),
                knobs.iter().any(|values| values.len() > 1),
            ),
        };
        // (the knobs its design depends on besides the cutoff)
        let by = match *kind {
            Kind::Model(ty) => ty.designed_by(),
            Kind::Web(_) => [true, true],
        };
        Pass {
            sample_rate: *sample_rate,
            designs: None,
            moving,
            layout,
            sweeps: knobs[0].len() > 1 && (!by[0] || knobs[1].len() == 1) && (!by[1] || knobs[4].len() == 1),
            knobs,
            a,
            b,
            engine,
            fade: fade.as_mut().map(|fade| (fade, scratch)),
            active: false,
            next: 0,
            pieces: None,
        }
    }
}

// where the values of each knob of a pass are and how many (a scan of them holds for those alone)
type KnobKeys = [(usize, usize); KNOBS];
fn keys_of(knobs: &[&[f32]; KNOBS]) -> KnobKeys {
    knobs.map(|values| (values.as_ptr() as usize, values.len()))
}

// the sections of a model type (None: a type of a BiquadFilterNode), the curve of Drive with them while Drive is
// over 0 anywhere in the pass
fn layout_of(kind: Kind, knobs: &[&[f32]; KNOBS]) -> Option<Layout> {
    let Kind::Model(ty) = kind else {
        return None;
    };
    Some(gated(
        ty,
        knobs[3].iter().any(|drive| *drive > 0.0),
        knobs[4].iter().any(|fat| *fat > 0.0),
        knobs[1].iter().any(|resonance| *resonance >= RESONANT),
    ))
}

fn web_type(kind: Kind) -> Option<FilterType> {
    match kind {
        Kind::Web(ty) => ty,
        Kind::Model(_) => None,
    }
}

// the coefficients and the state of a pass by its type
enum Engine<'a> {
    Web {
        ty: Option<FilterType>,
        coefficients: &'a mut [f32; 6],
        k: &'a mut f64,
        power: &'a mut f64,
        last: &'a mut [f64; 3],
        state: &'a mut [f32; 4],
        // the coefficients the span starts from and their step a sample (`ramps`, a span that is a line: else
        // those of the span, still)
        current: [f32; 6],
        step: [f32; 6],
        ramps: bool,
    },
    // (the coefficients of the span: those of its slot, read in place)
    Model {
        ty: ModelType,
        slot: &'a mut ModelSlot,
    },
}

/// the filter of a voice over the samples a..b of a block: its knobs are read at the start of each span (SEGMENT
/// samples from a while one moves, the last one up to b: `span_end`; else the whole a..b), its coefficients worked
/// out when they changed
pub struct Pass<'a> {
    sample_rate: f64,
    // the designs of the node (None: a voice alone)
    designs: Option<&'a Designs>,
    knobs: [&'a [f32]; KNOBS],
    moving: bool,
    // the sections of a model type over the pass (None: a type of a BiquadFilterNode)
    layout: Option<Layout>,
    // the cutoff moves alone in the design (the knobs it is designed by still: ModelType::designed_by): a model type
    // on the grid of its cutoff
    sweeps: bool,
    a: usize,
    b: usize,
    engine: Engine<'a>,
    // the filter before a change of type while it fades out, its channels
    fade: Option<(&'a mut Fade, &'a mut [Vec<f32>; 2])>,
    // whether the voice plays in the span, where it ends
    active: bool,
    next: usize,
    // the span in pieces it plays (model_spans::pieces)
    pieces: Option<Pieces>,
}

// A span in pieces (model_spans::pieces): the knobs of the span before and its own (a model type: cutoff, resonance,
// Drive, variation; one of a BiquadFilterNode: cutoff, resonance, gain, 0), where it starts and ends, how many pieces,
// the one that plays. A span is read at its start alone (the points of the routes), its pieces on the way
#[derive(Clone, Copy)]
struct Pieces {
    from: [f64; 4],
    to: [f64; 4],
    s: usize,
    e: usize,
    count: usize,
    at: usize,
}

// the next piece of the span in pieces at s, its knobs and its end (None: a span starts at s)
fn next_piece(pieces: &mut Option<Pieces>, s: usize) -> Option<([f64; 4], usize)> {
    match pieces {
        Some(span) if s > span.s && s < span.e => {
            span.at += 1;
            let end = piece_end(span.s, span.e, span.at, span.count);
            Some((piece_knobs(span.from, span.to, span.s, span.e, end), end))
        }
        _ => {
            *pieces = None;
            None
        }
    }
}

// the span s..next of the knobs `read` there: whole (its knobs and next), or in `count` pieces from `before`, the
// knobs of the span before (its first piece; `pieces` keeps the span); whether it is a piece
fn span_of(
    pieces: &mut Option<Pieces>,
    before: [f64; 4],
    read: [f64; 4],
    count: usize,
    s: usize,
    next: usize,
) -> ([f64; 4], usize, bool) {
    if count < 2 {
        return (read, next, false);
    }
    let end = piece_end(s, next, 0, count);
    *pieces = Some(Pieces {
        from: before,
        to: read,
        s,
        e: next,
        count,
        at: 0,
    });
    (piece_knobs(before, read, s, next, end), end, true)
}

impl<'a> Pass<'a> {
    // the slot of a model type (a pass with a layout)
    fn model(&self) -> &ModelSlot {
        match &self.engine {
            Engine::Model { slot, .. } => slot,
            Engine::Web { .. } => unreachable!(),
        }
    }

    // the state of a type of a BiquadFilterNode (a pass without a layout)
    fn web(&self) -> [f32; 4] {
        match &self.engine {
            Engine::Web { state, .. } => **state,
            Engine::Model { .. } => unreachable!(),
        }
    }

    // whether its span is a line of coefficients (`step`)
    fn ramps(&self) -> bool {
        self.active
            && match &self.engine {
                Engine::Web { ramps, .. } => *ramps,
                Engine::Model { slot, .. } => slot.ramps,
            }
    }

    // the coefficients a span of a type of a BiquadFilterNode starts from and their step a sample
    fn web_line(&self) -> ([f32; 6], [f32; 6]) {
        match &self.engine {
            Engine::Web { current, step, .. } => (*current, *step),
            Engine::Model { .. } => unreachable!(),
        }
    }

    // whether the slot of a model type is fresh, its span begun (step: active), it is not afterwards
    fn take_fresh(&mut self) -> bool {
        match &mut self.engine {
            Engine::Model { slot, .. } if self.active => slot.take_fresh(),
            _ => false,
        }
    }

    /// the pass with the designs its node keeps
    pub fn shared(self, designs: &'a Designs) -> Pass<'a> {
        Pass {
            designs: Some(designs),
            ..self
        }
    }

    // the span that starts at s (the end of the one before), or the next piece of a span in pieces
    fn step(&mut self, s: usize) {
        if s < self.a || s >= self.b {
            match &mut self.engine {
                Engine::Web { current, step, .. } => (*current, *step) = (FROZEN, STILL),
                Engine::Model { .. } => {}
            }
            self.active = false;
            self.next = if s < self.a { self.a } else { usize::MAX };
            self.pieces = None;
            return;
        }
        let at = |values: &[f32]| (if values.len() > 1 { values[s] } else { values[0] }) as f64;
        let (sample_rate, designs, sweeps) = (self.sample_rate, self.designs, self.sweeps);
        let (moving, next) = (
            self.moving,
            if self.moving { span_end(s, self.b) } else { self.b },
        );
        let piece = next_piece(&mut self.pieces, s);
        let kept = &mut self.pieces;
        let end = match &mut self.engine {
            Engine::Web {
                ty,
                coefficients,
                k,
                power,
                last,
                current,
                step,
                ramps,
                ..
            } => {
                let ([f, q, g, _], end, piece) = piece.map_or_else(
                    || {
                        let read = [at(self.knobs[0]), at(self.knobs[1]), at(self.knobs[2]), 0.0];
                        let count = if moving {
                            pieces(last[0], read[0], s, next)
                        } else {
                            1
                        };
                        span_of(kept, [last[0], last[1], last[2], 0.0], read, count, s, next)
                    },
                    |(knobs, end)| (knobs, end, true),
                );
                (*ramps, *step) = (false, STILL);
                let before = **coefficients;
                if f != last[0] || q != last[1] || g != last[2] {
                    let line = moving && (piece || glides(f, last[0]));
                    // (a cutoff that moves alone: the power of the span before)
                    if q != last[1] || g != last[2] {
                        **power = power_of(*ty, q, g);
                    }
                    **k = svf_into(coefficients, *ty, f, q, **power, sample_rate);
                    **last = [f, q, g];
                    if line {
                        let count = (end - s) as f32;
                        *step = core::array::from_fn(|k| (coefficients[k] - before[k]) / count);
                        *ramps = true;
                    }
                }
                *current = if *ramps { before } else { **coefficients };
                end
            }
            Engine::Model { ty, slot } => {
                let (knobs, end, piece) = piece.map_or_else(
                    || {
                        let read = [
                            at(self.knobs[0]),
                            at(self.knobs[1]),
                            at(self.knobs[3]),
                            at(self.knobs[4]),
                        ];
                        let count = slot.pieces(read[0], s, next, moving);
                        span_of(kept, slot.knobs(), read, count, s, next)
                    },
                    |(knobs, end)| (knobs, end, true),
                );
                slot.step(*ty, knobs, s, end, moving, sweeps, designs, sample_rate, piece);
                end
            }
        };
        self.active = true;
        self.next = end;
    }
}

// no filter: the integrators keep their state, nothing comes out (a voice outside its a..b)
const FROZEN: [f32; 6] = [0.0; 6];
// the step of coefficients that stay (LaneCoefs::still)
const STILL: [f32; 6] = [-0.0; 6];

fn constant(out: &mut [f32; 6], value: f64) -> f64 {
    *out = [0.0, 0.0, 0.0, value as f32, 0.0, 0.0];
    0.0
}

/// the power the coefficients of a type read: its linear Q (the resonance of a lowpass and a highpass is in dB) or
/// the amplitude A of its gain; the others: none
pub fn power_of(ty: Option<FilterType>, q: f64, gain: f64) -> f64 {
    match ty {
        Some(FilterType::Lowpass | FilterType::Highpass) => pow(10.0, q / 20.0),
        Some(FilterType::Peaking | FilterType::Lowshelf | FilterType::Highshelf) => pow(10.0, gain / 40.0),
        _ => 0.0,
    }
}

/// The coefficients of the state variable filter with the response of a BiquadFilterNode (the Web Audio API spec,
/// Audio EQ Cookbook), `power` the power_of its resonance and gain. With g the prewarped cutoff, k the damping
/// and d = 1 + g (g + k): c = 2 g (g + k) / d, 2 g / d and 2 g² / d of the integrators (tick), then the shares
/// of the input, of the band (halved) and of the low (halved) in the output. Its edge cases at 0 Hz, at nyquist
/// and for Q <= 0 are constants, as those of the biquad; `ty` None: an unknown type (a constant 1). Worked out in
/// doubles, kept in f32; returns k (0 of a constant)
pub fn svf_into(
    out: &mut [f32; 6],
    ty: Option<FilterType>,
    frequency: f64,
    q: f64,
    power: f64,
    sample_rate: f64,
) -> f64 {
    let f = frequency / (sample_rate / 2.0);
    let inside = f > 0.0 && f < 1.0;
    // the prewarped frequency: tan(w0 / 2)
    let tan = || sin(PI * f / 2.0) / cos(PI * f / 2.0);
    let a = power;
    let (g, k, mix): (f64, f64, [f64; 3]) = match ty {
        None => return constant(out, 1.0),
        Some(FilterType::Lowpass) => {
            if f >= 1.0 {
                return constant(out, 1.0);
            }
            if f <= 0.0 {
                return constant(out, 0.0);
            }
            (tan(), 1.0 / power, [0.0, 0.0, 1.0])
        }
        Some(FilterType::Highpass) => {
            if f >= 1.0 {
                return constant(out, 0.0);
            }
            if f <= 0.0 {
                return constant(out, 1.0);
            }
            let k = 1.0 / power;
            (tan(), k, [1.0, -k, -1.0])
        }
        Some(FilterType::Bandpass) => {
            if !inside {
                return constant(out, 0.0);
            }
            if q <= 0.0 {
                return constant(out, 1.0);
            }
            (tan(), 1.0 / q, [0.0, 1.0 / q, 0.0])
        }
        Some(FilterType::Notch) => {
            if !inside {
                return constant(out, 1.0);
            }
            if q <= 0.0 {
                return constant(out, 0.0);
            }
            (tan(), 1.0 / q, [1.0, -1.0 / q, 0.0])
        }
        Some(FilterType::Allpass) => {
            if !inside {
                return constant(out, 1.0);
            }
            if q <= 0.0 {
                return constant(out, -1.0);
            }
            (tan(), 1.0 / q, [1.0, -2.0 / q, 0.0])
        }
        Some(FilterType::Peaking) => {
            if !inside {
                return constant(out, 1.0);
            }
            if q <= 0.0 {
                return constant(out, a * a);
            }
            let k = 1.0 / (q * a);
            (tan(), k, [1.0, k * (a * a - 1.0), 0.0])
        }
        // the shelves: a slope of 1 (k = √2), the cutoff moved by √A
        Some(FilterType::Lowshelf) => {
            if f >= 1.0 {
                return constant(out, a * a);
            }
            if f <= 0.0 {
                return constant(out, 1.0);
            }
            (tan() / sqrt(a), SQRT2, [1.0, SQRT2 * (a - 1.0), a * a - 1.0])
        }
        Some(FilterType::Highshelf) => {
            if f >= 1.0 {
                return constant(out, 1.0);
            }
            if f <= 0.0 {
                return constant(out, a * a);
            }
            (
                tan() * sqrt(a),
                SQRT2,
                [a * a, SQRT2 * (1.0 - a) * a, 1.0 - a * a],
            )
        }
    };
    *out = filter_model::svf_coefs(g, k, mix);
    k
}

// a sample of the lanes through their filters (filter_model::svf_tick), the integrators ic1 (the band) and ic2 (the
// low)
#[inline(always)]
fn tick(c: &[F32x4; 6], ic1: &mut F32x4, ic2: &mut F32x4, x: F32x4) -> F32x4 {
    let mut state = [*ic1, *ic2];
    let y = filter_model::svf_tick(c, &mut state, x);
    [*ic1, *ic2] = state;
    y
}

/// the channels of a voice (silent outside the a..b of its pass) through its filter, in place; while the filter
/// before a change of type fades out, it runs on a copy of them and the two are crossfaded
pub fn run(pass: &mut Pass, left: &mut [f32], right: &mut [f32]) {
    if let Some((fade, scratch)) = pass.fade.take() {
        // (the filter before runs only while it fades out: the fade ends with the pass)
        let (a, b) = (pass.a, pass.b.min(pass.a + fade.left));
        let [old_l, old_r] = scratch;
        if old_l.len() < left.len() {
            old_l.resize(left.len(), 0.0);
            old_r.resize(left.len(), 0.0);
        }
        let (old_l, old_r) = (&mut old_l[..left.len()], &mut old_r[..left.len()]);
        old_l.copy_from_slice(left);
        old_r.copy_from_slice(right);
        run_frozen(fade, a, b, old_l, old_r);
        run_alone(pass, left, right);
        crossfade(left, right, [old_l, old_r], a, b, &mut fade.left, fade.length);
        return;
    }
    run_alone(pass, left, right);
}

// the filter before a change of type over a..b, its knobs as they were
#[inline(never)]
fn run_frozen(fade: &mut Fade, a: usize, b: usize, left: &mut [f32], right: &mut [f32]) {
    match fade.kind {
        Kind::Web(_) => {
            let [mut ic1, mut ic2] = web_lanes(fade.web_state);
            let mut c = fade.web.map(F32x4::splat);
            web_span(&mut c, None, &mut ic1, &mut ic2, a, b, left, right);
            fade.web_state = web_state_of(ic1, ic2);
        }
        Kind::Model(ty) => {
            let c = LaneCoefs::of(&fade.model.coefs, &fade.model.coefs);
            let mut lanes = lanes_of(&fade.model.state, &fade.model.state);
            // (its knobs as they were in its last span: its sections as they ran there, the plain ones of a
            // resonance that didn't saturate)
            let last = fade.model.last;
            let layout = gated(ty, last[3] > 0.0, last[2] > 0.0, last[1] >= RESONANT as f64);
            model_span(layout, &c, &mut lanes, a, b, left, right);
            lanes.flush();
            fade.model.state = channels_of(&lanes, 0);
        }
    }
}

// `group` of two pairs of voices, a sample of one then of the other: the integrators of a pair wait for their own
// state alone, so the two overlap (a sample of both in about the time of a sample of one)
#[inline(always)]
fn groups(
    layout: Layout,
    [c0, c1]: &mut [LaneCoefs; 2],
    d: Option<&[LaneCoefs; 2]>,
    first: &mut LaneState,
    second: &mut LaneState,
    rows: [[F32x4; 4]; 2],
) -> [[F32x4; 4]; 2] {
    let (d0, d1) = (d.map(|d| &d[0]), d.map(|d| &d[1]));
    let (x, z) = (transpose(rows[0]), transpose(rows[1]));
    let y0 = sample(layout, c0, d0, first, x[0], true);
    let w0 = sample(layout, c1, d1, second, z[0], true);
    let y1 = sample(layout, c0, d0, first, x[1], false);
    let w1 = sample(layout, c1, d1, second, z[1], false);
    let y2 = sample(layout, c0, d0, first, x[2], false);
    let w2 = sample(layout, c1, d1, second, z[2], false);
    let y3 = sample(layout, c0, d0, first, x[3], false);
    let w3 = sample(layout, c1, d1, second, z[3], false);
    [transpose([y0, y1, y2, y3]), transpose([w0, w1, w2, w3])]
}

// the slots of the model types of two passes, whether the span of each is a line and whether a knob of either moves
// (the spans of the lanes of their coefficients: model_spans::spans)
#[inline(always)]
fn slots_of<'b>(p: &'b Pass, q: &'b Pass) -> ([&'b ModelSlot; 2], [bool; 2], bool) {
    (
        [p.model(), q.model()],
        [p.ramps(), q.ramps()],
        p.moving || q.moving,
    )
}

// the coefficients of the lanes of two passes before their first spans (model_spans::before)
#[inline(always)]
fn before_of(p: &Pass, q: &Pass) -> LaneCoefs {
    before::<false>([p.model(), q.model()], p.moving || q.moving)
}

// the coefficients of the lanes of two passes from the spans of those that `stepped` on (model_spans::spans)
#[inline(always)]
fn spans_of(
    layout: Layout,
    c: &mut LaneCoefs,
    d: &mut LaneCoefs,
    every: &mut Option<LaneCoefs>,
    p: &Pass,
    q: &Pass,
    stepped: [bool; 2],
) -> Line {
    let (slots, ramps, moving) = slots_of(p, q);
    spans::<false>(layout, c, d, every, slots, ramps, moving, stepped)
}

#[inline(never)]
fn run_alone(pass: &mut Pass, left: &mut [f32], right: &mut [f32]) {
    if let Some(layout) = pass.layout {
        let state = pass.model().state;
        let mut lanes = lanes_of(&state, &state);
        let (mut c, mut d, mut every) = (before_of(pass, pass), LaneCoefs::still(), None);
        let mut s = pass.a;
        while s < pass.b {
            pass.step(s);
            let fresh = pass.take_fresh();
            let e = pass.next;
            let line = spans_of(layout, &mut c, &mut d, &mut every, pass, pass, [true; 2]);
            if fresh {
                filter_model::keep_steps(&c, &mut lanes);
            }
            run_span(layout, line, &mut c, &d, &every, &mut lanes, s, e, left, right);
            // (the tail of a filter decays: no denormals in its state)
            lanes.flush();
            s = e;
        }
        if let Engine::Model { slot, .. } = &mut pass.engine {
            slot.state = channels_of(&lanes, 0);
        }
        return;
    }
    let [mut ic1, mut ic2] = web_lanes(pass.web());
    let mut s = pass.a;
    while s < pass.b {
        pass.step(s);
        let e = pass.next;
        let (from, step) = pass.web_line();
        let mut c = from.map(F32x4::splat);
        if pass.ramps() {
            let d = step.map(F32x4::splat);
            web_span(&mut c, Some(&d), &mut ic1, &mut ic2, s, e, left, right);
        } else {
            web_span(&mut c, None, &mut ic1, &mut ic2, s, e, left, right);
        }
        s = e;
    }
    if let Engine::Web { state, .. } = &mut pass.engine {
        **state = web_state_of(ic1, ic2);
    }
}

// the integrators of a voice alone (lanes 0 and 1) of a filter of a BiquadFilterNode out of its state [ic1 of L and
// R, ic2 of L and R], and back
#[inline(always)]
fn web_lanes([l1, r1, l2, r2]: [f32; 4]) -> [F32x4; 2] {
    [F32x4::new(l1, r1, 0.0, 0.0), F32x4::new(l2, r2, 0.0, 0.0)]
}
#[inline(always)]
fn web_state_of(ic1: F32x4, ic2: F32x4) -> [f32; 4] {
    let (ic1, ic2) = (ic1.lanes(), ic2.lanes());
    [ic1[0], ic1[1], ic2[0], ic2[1]]
}

// the coefficients of a filter of a BiquadFilterNode a step on in a span that is a line (`d`: the step a sample)
#[inline(always)]
fn web_advance(c: &mut [F32x4; 6], d: Option<&[F32x4; 6]>) {
    if let Some(d) = d {
        for k in 0..6 {
            c[k] = c[k] + d[k];
        }
    }
}

// the samples s..e of a voice alone through a filter of a BiquadFilterNode (its coefficients from `c`, in a span that
// is a line a step `d` a sample), its integrators flushed after them (the
// tail of a filter decays: no denormals in its state)
#[inline(always)]
fn web_span(
    c: &mut [F32x4; 6],
    d: Option<&[F32x4; 6]>,
    ic1: &mut F32x4,
    ic2: &mut F32x4,
    s: usize,
    e: usize,
    left: &mut [f32],
    right: &mut [f32],
) {
    let (left, right) = (&mut left[..e], &mut right[..e]);
    // (the integrators in locals, as `model_span` keeps its state)
    let (mut x1, mut x2) = (*ic1, *ic2);
    for i in s..e {
        web_advance(c, d);
        let y = tick(c, &mut x1, &mut x2, F32x4::new(left[i], right[i], 0.0, 0.0)).lanes();
        left[i] = y[0];
        right[i] = y[1];
    }
    *ic1 = x1.flush();
    *ic2 = x2.flush();
}

/// the channels of two voices of `n` samples through their filters, in place: a voice in the lanes 0 and 1, the
/// other in 2 and 3, each sample the operations `run` does (the spans of both: the coefficients of a voice change
/// at its own). Two of a BiquadFilterNode, or of one layout of sections, share the lanes; two others, or a voice
/// that fades from a type to another, each alone
pub fn run_pair(passes: [&mut Pass; 2], outs: [[&mut [f32]; 2]; 2], n: usize) {
    let [p, q] = passes;
    let [[pl, pr], [ql, qr]] = outs;
    let shared = p.fade.is_none() && q.fade.is_none() && p.layout == q.layout;
    if !shared {
        run(p, pl, pr);
        run(q, ql, qr);
        return;
    }
    if let Some(layout) = p.layout {
        return run_model_pair(layout, [p, q], [[pl, pr], [ql, qr]], n);
    }
    run_web_pair([p, q], [[pl, pr], [ql, qr]], n);
}

/// The channels of some voices of `n` samples through their filters, in place, each the bits of `run`. Three or
/// four of one layout of sections that play their whole block (of whole groups of REFRESH): two pairs of lanes in one
/// loop (`run_model_group`); the others in pairs (`run_pair`), the last of three alone
pub fn run_group(passes: &mut [Pass], outs: &mut [[&mut [f32]; 2]], n: usize) {
    // (a block of whole groups of REFRESH, as every block of a node is: every span of the group starts at a refresh,
    // the loop of the group has no sample alone)
    if passes.len() > 2 && n > 0 && n.is_multiple_of(REFRESH) {
        let layout = passes[0].layout;
        let whole = |pass: &Pass| pass.fade.is_none() && pass.a == 0 && pass.b == n && pass.layout == layout;
        if let (Some(layout), true) = (layout, passes.iter().all(whole)) {
            if interleaves(layout, passes.iter().any(|pass| pass.moving)) {
                return run_model_group(layout, passes, outs, n);
            }
        }
    }
    for pair in passes.chunks_mut(2).zip(outs.chunks_mut(2)) {
        match pair {
            ([p, q], [[pl, pr], [ql, qr]]) => run_pair([p, q], [[pl, pr], [ql, qr]], n),
            ([p], [[left, right]]) => run(p, left, right),
            _ => {}
        }
    }
}

// whether two pairs of voices of a layout run faster in one loop (`moving`: a knob of one moves, spans of SEGMENT):
// those whose first section alone saturates, without the curve of Drive (a sample of a pair waits on the steps its
// refresh divides out: the other pair runs meanwhile; Ladder and 12 dB a fifth faster at rest), a ladder (its clip
// waits on the output of both sections) under moving knobs too; the others are as fast in pairs or slower in one
// loop (two saturating sections, the curve of Drive, the plain sections: the work fills the loop, its registers don't
// hold two states; the spans of moving knobs of the others: what the loop saves is less than a span costs it)
pub fn interleaves(layout: Layout, moving: bool) -> bool {
    layout.sat && !layout.sat2 && !layout.drive && (layout.clip || !moving)
}

// Three or four voices of one layout over their whole block: the first two in the lanes of one filter, the others in
// those of a second one (the third of three in both halves of its lanes), a sample of each in turn (`groups`). Each
// voice the operations of `run_model_pair`: its spans, its state flushed where its own span ends; with lines where a
// knob of one moves (`line_group`), else the coefficients of the spans as they are (`still_group`)
#[inline(never)]
fn run_model_group(layout: Layout, passes: &mut [Pass], outs: &mut [[&mut [f32]; 2]], n: usize) {
    if passes.iter().any(|pass| pass.moving) {
        line_group(layout, passes, outs, n);
    } else {
        still_group(layout, passes, outs, n);
    }
}

// the channels of each voice of a group (of the fourth: none of three) over the n samples of a block
type GroupOuts<'a> = (GroupChannels<'a>, Option<(&'a mut [f32], &'a mut [f32])>);
fn group_outs<'a>(outs: &'a mut [[&mut [f32]; 2]], n: usize) -> Option<GroupOuts<'a>> {
    let (head, tail) = outs.split_at_mut(2);
    let ([[al, ar], [bl, br]], Some(([cl, cr], fourth))) = (head, tail.split_first_mut()) else {
        return None;
    };
    let fourth = match fourth {
        [[dl, dr]] => Some((&mut dl[..n], &mut dr[..n])),
        _ => None,
    };
    Some((
        (
            &mut al[..n],
            &mut ar[..n],
            &mut bl[..n],
            &mut br[..n],
            &mut cl[..n],
            &mut cr[..n],
        ),
        fourth,
    ))
}

// the voices of the halves of the lanes of each pair of a group of `count`
fn group_voices(count: usize, pair: usize) -> [usize; 2] {
    [2 * pair, (2 * pair + 1).min(count - 1)]
}

// the last sample of a span s..e of each pair of a group (the input the state of Drive takes after it: `end_span`)
fn group_last(channels: &GroupChannels, fourth: &Option<(&mut [f32], &mut [f32])>, e: usize) -> [F32x4; 2] {
    let (al, ar, bl, br, cl, cr) = channels;
    let at = e - 1;
    [
        F32x4::new(al[at], ar[at], bl[at], br[at]),
        match fourth {
            Some((dl, dr)) => F32x4::new(cl[at], cr[at], dl[at], dr[at]),
            None => F32x4::new(cl[at], cr[at], cl[at], cr[at]),
        },
    ]
}

// the state of the voices of a group back into their slots
fn group_states(passes: &mut [Pass], lanes: &[LaneState; 2]) {
    for (voice, pass) in passes.iter_mut().enumerate() {
        if let Engine::Model { slot, .. } = &mut pass.engine {
            slot.state = channels_of(&lanes[voice / 2], voice % 2);
        }
    }
}

// a group no knob of which moves: the coefficients of each span in locals of the span (`still_pair`)
#[inline(never)]
fn still_group(layout: Layout, passes: &mut [Pass], outs: &mut [[&mut [f32]; 2]], n: usize) {
    let count = passes.len();
    let Some((mut channels, mut fourth)) = group_outs(outs, n) else {
        return;
    };
    let voices = |pair: usize| group_voices(count, pair);
    let mut lanes: [LaneState; 2] = core::array::from_fn(|pair| {
        let [p, q] = voices(pair);
        lanes_of(&passes[p].model().state, &passes[q].model().state)
    });
    let mut s = 0;
    while s < n {
        let mut e = n;
        let mut fresh = [false; 4];
        for (voice, pass) in passes.iter_mut().enumerate() {
            if s == pass.next {
                pass.step(s);
                fresh[voice] = pass.take_fresh();
            }
            e = e.min(pass.next);
        }
        let mut c: [LaneCoefs; 2] = core::array::from_fn(|pair| {
            let [p, q] = voices(pair);
            LaneCoefs::of(&passes[p].model().coefs, &passes[q].model().coefs)
        });
        for (pair, lanes) in lanes.iter_mut().enumerate() {
            fresh_steps(&c[pair], lanes, voices(pair).map(|voice| fresh[voice]));
        }
        let last = group_last(&channels, &fourth, e);
        let rest = fourth.as_mut().map(|(dl, dr)| (&mut **dl, &mut **dr));
        group_samples(layout, &mut c, None, &mut lanes, s, e, &mut channels, rest);
        for (pair, lanes) in lanes.iter_mut().enumerate() {
            end_span(layout, &c[pair], lanes, Some(last[pair]));
            flush_halves(lanes, voices(pair).map(|voice| e == passes[voice].next));
        }
        s = e;
    }
    group_states(passes, &lanes);
}

// a group a knob of which moves: the coefficients of the lanes as a span that is a line left them (a voice goes on
// along its line where the span of another ends) a step `d` on at every refresh (-0 of a span that is no line: the
// bits of no step; a pair no knob of which moves keeps the -0 of `still`, its coefficients those of its spans)
#[inline(never)]
fn line_group(layout: Layout, passes: &mut [Pass], outs: &mut [[&mut [f32]; 2]], n: usize) {
    let count = passes.len();
    let Some((mut channels, mut fourth)) = group_outs(outs, n) else {
        return;
    };
    let voices = |pair: usize| group_voices(count, pair);
    let mut lanes: [LaneState; 2] = core::array::from_fn(|pair| {
        let [p, q] = voices(pair);
        lanes_of(&passes[p].model().state, &passes[q].model().state)
    });
    let mut c: [LaneCoefs; 2] = core::array::from_fn(|pair| {
        let [p, q] = voices(pair);
        before_of(&passes[p], &passes[q])
    });
    let mut d = [LaneCoefs::still(); 2];
    let mut every: [Option<LaneCoefs>; 2] = [None, None];
    let still = LaneCoefs::still();
    let mut s = 0;
    while s < n {
        let mut e = n;
        let mut fresh = [false; 4];
        let mut stepped = [false; 4];
        for (voice, pass) in passes.iter_mut().enumerate() {
            if s == pass.next {
                pass.step(s);
                fresh[voice] = pass.take_fresh();
                stepped[voice] = true;
            }
            e = e.min(pass.next);
        }
        let mut fine = [None; 2];
        for pair in 0..2 {
            let [p, q] = voices(pair);
            let pair_stepped = [stepped[p], stepped[q]];
            let line = spans_of(
                layout,
                &mut c[pair],
                &mut d[pair],
                &mut every[pair],
                &passes[p],
                &passes[q],
                pair_stepped,
            );
            if let Line::Fine(lanes) = line {
                fine[pair] = Some(lanes);
            }
        }
        for (pair, lanes) in lanes.iter_mut().enumerate() {
            fresh_steps(&c[pair], lanes, voices(pair).map(|voice| fresh[voice]));
        }
        let last = group_last(&channels, &fourth, e);
        let rest = fourth.as_mut().map(|(dl, dr)| (&mut **dl, &mut **dr));
        if fine.iter().any(Option::is_some) {
            // (a pair none of whose lanes steps every sample: every step -0 between the refreshes, the bits of its
            // own loop)
            let steps = [0, 1].map(|pair| every[pair].as_ref().unwrap_or(&still));
            let masks = fine.map(|lanes| lanes.unwrap_or(U32x4::splat(0)));
            fine_group_samples(
                layout,
                &mut c,
                &d,
                steps,
                masks,
                &mut lanes,
                s,
                e,
                &mut channels,
                rest,
            );
        } else {
            group_samples(layout, &mut c, Some(&d), &mut lanes, s, e, &mut channels, rest);
        }
        for (pair, lanes) in lanes.iter_mut().enumerate() {
            end_span(layout, &c[pair], lanes, Some(last[pair]));
            flush_halves(lanes, voices(pair).map(|voice| e == passes[voice].next));
        }
        s = e;
    }
    group_states(passes, &lanes);
}

// the channels of three or four voices in a group
type GroupChannels<'a> = (
    &'a mut [f32],
    &'a mut [f32],
    &'a mut [f32],
    &'a mut [f32],
    &'a mut [f32],
    &'a mut [f32],
);

// the samples s..e of a group: the two pairs in turn (`groups`), their coefficients a step `d` on at every refresh
// (None: they stay)
#[inline(always)]
#[allow(clippy::too_many_arguments)]
fn group_samples(
    layout: Layout,
    c: &mut [LaneCoefs; 2],
    d: Option<&[LaneCoefs; 2]>,
    lanes: &mut [LaneState; 2],
    s: usize,
    e: usize,
    (al, ar, bl, br, cl, cr): &mut GroupChannels,
    mut fourth: Option<(&mut [f32], &mut [f32])>,
) {
    // (the state of the span in locals, as `run_model_pair` keeps it)
    let [mut first, mut second] = *lanes;
    let mut i = s;
    while i + REFRESH <= e {
        let to = i + REFRESH;
        let (third_l, third_r) = (F32x4::load(&cl[i..to]), F32x4::load(&cr[i..to]));
        let (fourth_l, fourth_r) = match &fourth {
            Some((dl, dr)) => (F32x4::load(&dl[i..to]), F32x4::load(&dr[i..to])),
            None => (third_l, third_r),
        };
        let rows = [
            [
                F32x4::load(&al[i..to]),
                F32x4::load(&ar[i..to]),
                F32x4::load(&bl[i..to]),
                F32x4::load(&br[i..to]),
            ],
            [third_l, third_r, fourth_l, fourth_r],
        ];
        let [y, z] = groups(layout, c, d, &mut first, &mut second, rows);
        y[0].store(&mut al[i..to]);
        y[1].store(&mut ar[i..to]);
        y[2].store(&mut bl[i..to]);
        y[3].store(&mut br[i..to]);
        z[0].store(&mut cl[i..to]);
        z[1].store(&mut cr[i..to]);
        if let Some((dl, dr)) = &mut fourth {
            z[2].store(&mut dl[i..to]);
            z[3].store(&mut dr[i..to]);
        }
        i = to;
    }
    // (spans of whole groups: `run_group`)
    debug_assert_eq!(i, e);
    *lanes = [first, second];
}

// The samples s..e of a group some lanes of which step every sample (`fine` of each pair; model_spans::fine_sample):
// a sample of each pair in turn, each lane the operations of its own (`group_samples`)
#[inline(never)]
#[allow(clippy::too_many_arguments)]
fn fine_group_samples(
    layout: Layout,
    c: &mut [LaneCoefs; 2],
    d: &[LaneCoefs; 2],
    every: [&LaneCoefs; 2],
    fine: [U32x4; 2],
    lanes: &mut [LaneState; 2],
    s: usize,
    e: usize,
    (al, ar, bl, br, cl, cr): &mut GroupChannels,
    mut fourth: Option<(&mut [f32], &mut [f32])>,
) {
    let [mut first, mut second] = *lanes;
    let [c0, c1] = c;
    for i in s..e {
        let refresh = i.is_multiple_of(REFRESH);
        let x = F32x4::new(al[i], ar[i], bl[i], br[i]);
        let y = fine_sample(layout, c0, &d[0], every[0], fine[0], &mut first, x, refresh).lanes();
        let z = match &fourth {
            Some((dl, dr)) => F32x4::new(cl[i], cr[i], dl[i], dr[i]),
            None => F32x4::new(cl[i], cr[i], cl[i], cr[i]),
        };
        let z = fine_sample(layout, c1, &d[1], every[1], fine[1], &mut second, z, refresh).lanes();
        [al[i], ar[i], bl[i], br[i]] = y;
        cl[i] = z[0];
        cr[i] = z[1];
        if let Some((dl, dr)) = &mut fourth {
            dl[i] = z[2];
            dr[i] = z[3];
        }
    }
    *lanes = [first, second];
}

// two voices of a layout: where a knob of one moves `line_pair`, else `still_pair`
#[inline(never)]
fn run_model_pair(layout: Layout, passes: [&mut Pass; 2], outs: [[&mut [f32]; 2]; 2], n: usize) {
    if passes[0].moving || passes[1].moving {
        line_pair(layout, passes, outs, n);
    } else {
        still_pair(layout, passes, outs, n);
    }
}

// Two voices no knob of which moves: the coefficients of each span in locals of the span. A function of its own, not
// the lines' with no step: there the coefficients live over the block, in memory the calls around take, and the loop
// read them from there (a chord at rest 3 % slower)
#[inline(never)]
fn still_pair(layout: Layout, passes: [&mut Pass; 2], outs: [[&mut [f32]; 2]; 2], n: usize) {
    let [p, q] = passes;
    let [[pl, pr], [ql, qr]] = outs;
    let (pl, pr, ql, qr) = (&mut pl[..n], &mut pr[..n], &mut ql[..n], &mut qr[..n]);
    let mut lanes = lanes_of(&p.model().state, &q.model().state);
    let mut s = 0;
    while s < n {
        let mut fresh = [false; 2];
        if s == p.next {
            p.step(s);
            fresh[0] = p.take_fresh();
        }
        if s == q.next {
            q.step(s);
            fresh[1] = q.take_fresh();
        }
        let e = n.min(p.next).min(q.next);
        if p.active || q.active {
            let mut c = LaneCoefs::of(&p.model().coefs, &q.model().coefs);
            fresh_steps(&c, &mut lanes, fresh);
            // (a voice outside its span takes no input and keeps its state: its lanes run on zeros, then its
            // state of before; its outputs are left as they are)
            let (on_p, on_q) = (p.active, q.active);
            let kept = (!on_p || !on_q).then_some(lanes);
            let last = F32x4::new(pl[e - 1], pr[e - 1], ql[e - 1], qr[e - 1]);
            let mut channels = (&mut *pl, &mut *pr, &mut *ql, &mut *qr);
            pair_samples(
                layout,
                &mut c,
                None,
                &mut lanes,
                s,
                e,
                [on_p, on_q],
                &mut channels,
            );
            end_span(layout, &c, &mut lanes, Some(last));
            if let Some(kept) = kept {
                // (the lanes of the voice that played, the others as they were)
                lanes = lanes.pick(&kept, halves_of([on_p, on_q]));
            }
            // (the state of a voice is flushed where its own span ends, as `run` does)
            flush_halves(&mut lanes, [p.active && e == p.next, q.active && e == q.next]);
        }
        s = e;
    }
    pair_states([p, q], &lanes);
}

// Two voices a knob of one of which moves: the coefficients of the lanes as a span that is a line left them (a voice
// goes on along its line where the span of the other ends) a step `d` on at every refresh, -0 of a span that is no
// line (the bits of no step)
#[inline(never)]
fn line_pair(layout: Layout, passes: [&mut Pass; 2], outs: [[&mut [f32]; 2]; 2], n: usize) {
    let [p, q] = passes;
    let [[pl, pr], [ql, qr]] = outs;
    let (pl, pr, ql, qr) = (&mut pl[..n], &mut pr[..n], &mut ql[..n], &mut qr[..n]);
    let mut lanes = lanes_of(&p.model().state, &q.model().state);
    let (mut c, mut d, mut every) = (before_of(p, q), LaneCoefs::still(), None);
    let mut s = 0;
    while s < n {
        let mut fresh = [false; 2];
        let mut stepped = [false; 2];
        if s == p.next {
            p.step(s);
            fresh[0] = p.take_fresh();
            stepped[0] = true;
        }
        if s == q.next {
            q.step(s);
            fresh[1] = q.take_fresh();
            stepped[1] = true;
        }
        let e = n.min(p.next).min(q.next);
        if p.active || q.active {
            let (slots, ramps, _) = slots_of(p, q);
            let line = take_spans::<false>(layout, &mut c, &mut d, &mut every, slots, ramps, stepped);
            fresh_steps(&c, &mut lanes, fresh);
            let (on_p, on_q) = (p.active, q.active);
            let kept = (!on_p || !on_q).then_some(lanes);
            let last = F32x4::new(pl[e - 1], pr[e - 1], ql[e - 1], qr[e - 1]);
            let mut channels = (&mut *pl, &mut *pr, &mut *ql, &mut *qr);
            match (line, &every) {
                (Line::Fine(fine), Some(every)) => fine_pair_samples(
                    layout,
                    &mut c,
                    &d,
                    every,
                    fine,
                    &mut lanes,
                    s,
                    e,
                    [on_p, on_q],
                    &mut channels,
                ),
                _ => pair_samples(
                    layout,
                    &mut c,
                    Some(&d),
                    &mut lanes,
                    s,
                    e,
                    [on_p, on_q],
                    &mut channels,
                ),
            }
            end_span(layout, &c, &mut lanes, Some(last));
            if let Some(kept) = kept {
                lanes = lanes.pick(&kept, halves_of([on_p, on_q]));
            }
            flush_halves(&mut lanes, [p.active && e == p.next, q.active && e == q.next]);
        }
        s = e;
    }
    pair_states([p, q], &lanes);
}

// the state of the voices of a pair back into their slots
fn pair_states(passes: [&mut Pass; 2], lanes: &LaneState) {
    for (half, pass) in passes.into_iter().enumerate() {
        if let Engine::Model { slot, .. } = &mut pass.engine {
            slot.state = channels_of(lanes, half);
        }
    }
}

// the samples s..e of two voices in the lanes (`on`: whether each plays there), their coefficients a step `d` on at
// every refresh (None: they stay)
#[inline(always)]
#[allow(clippy::too_many_arguments)]
fn pair_samples(
    layout: Layout,
    c: &mut LaneCoefs,
    d: Option<&LaneCoefs>,
    lanes: &mut LaneState,
    s: usize,
    e: usize,
    [on_p, on_q]: [bool; 2],
    (pl, pr, ql, qr): &mut (&mut [f32], &mut [f32], &mut [f32], &mut [f32]),
) {
    // (the state of the span in locals: in `lanes`, whose address the calls around take, every sample
    // would load and store it)
    let mut state = *lanes;
    let mut i = s;
    while i < e {
        // both voices from a refresh on: a whole group; else (the samples up to the first refresh, the last
        // ones, one voice of the two) one by one
        if on_p && on_q && i.is_multiple_of(REFRESH) && i + REFRESH <= e {
            let rows = [
                F32x4::load(&pl[i..i + REFRESH]),
                F32x4::load(&pr[i..i + REFRESH]),
                F32x4::load(&ql[i..i + REFRESH]),
                F32x4::load(&qr[i..i + REFRESH]),
            ];
            let y = group(layout, c, d, &mut state, rows);
            y[0].store(&mut pl[i..i + REFRESH]);
            y[1].store(&mut pr[i..i + REFRESH]);
            y[2].store(&mut ql[i..i + REFRESH]);
            y[3].store(&mut qr[i..i + REFRESH]);
            i += REFRESH;
            continue;
        }
        let x = F32x4::new(
            if on_p { pl[i] } else { 0.0 },
            if on_p { pr[i] } else { 0.0 },
            if on_q { ql[i] } else { 0.0 },
            if on_q { qr[i] } else { 0.0 },
        );
        let y = sample(layout, c, d, &mut state, x, i.is_multiple_of(REFRESH)).lanes();
        if on_p {
            pl[i] = y[0];
            pr[i] = y[1];
        }
        if on_q {
            ql[i] = y[2];
            qr[i] = y[3];
        }
        i += 1;
    }
    *lanes = state;
}

// the samples s..e of two voices in the lanes some of which step every sample (model_spans::fine_sample), a sample
// at a time (`pair_samples`: each lane the operations of its own)
#[inline(never)]
#[allow(clippy::too_many_arguments)]
fn fine_pair_samples(
    layout: Layout,
    c: &mut LaneCoefs,
    d: &LaneCoefs,
    every: &LaneCoefs,
    fine: U32x4,
    lanes: &mut LaneState,
    s: usize,
    e: usize,
    [on_p, on_q]: [bool; 2],
    (pl, pr, ql, qr): &mut (&mut [f32], &mut [f32], &mut [f32], &mut [f32]),
) {
    let mut state = *lanes;
    for i in s..e {
        let x = F32x4::new(
            if on_p { pl[i] } else { 0.0 },
            if on_p { pr[i] } else { 0.0 },
            if on_q { ql[i] } else { 0.0 },
            if on_q { qr[i] } else { 0.0 },
        );
        let refresh = i.is_multiple_of(REFRESH);
        let y = fine_sample(layout, c, d, every, fine, &mut state, x, refresh).lanes();
        if on_p {
            pl[i] = y[0];
            pr[i] = y[1];
        }
        if on_q {
            ql[i] = y[2];
            qr[i] = y[3];
        }
    }
    *lanes = state;
}

// the steps of the small signal in the saturating sections of the voices of the lanes that are fresh (`fresh` of each
// half), the others' as they are
fn fresh_steps(c: &LaneCoefs, lanes: &mut LaneState, fresh: [bool; 2]) {
    if fresh[0] || fresh[1] {
        let mut steps = *lanes;
        filter_model::keep_steps(c, &mut steps);
        *lanes = steps.pick(lanes, halves_of(fresh));
    }
}

// the state of the voices of the halves whose spans end (`ends` of each half) flushed, the others' as it is
#[inline(always)]
fn flush_halves(lanes: &mut LaneState, ends: [bool; 2]) {
    if ends[0] || ends[1] {
        let mut flushed = *lanes;
        flushed.flush();
        *lanes = flushed.pick(lanes, halves_of(ends));
    }
}

// the samples s..e of two voices of a BiquadFilterNode in the lanes (`on`: whether each plays there), their
// coefficients a step `d` on a sample in a span that is a line
#[inline(always)]
#[allow(clippy::too_many_arguments)]
fn web_pair_samples(
    c: &mut [F32x4; 6],
    d: Option<&[F32x4; 6]>,
    ic1: &mut F32x4,
    ic2: &mut F32x4,
    s: usize,
    e: usize,
    on: [bool; 2],
    (pl, pr, ql, qr): &mut (&mut [f32], &mut [f32], &mut [f32], &mut [f32]),
) {
    match on {
        [true, true] => {
            for i in s..e {
                web_advance(c, d);
                let x = F32x4::new(pl[i], pr[i], ql[i], qr[i]);
                let y = tick(c, ic1, ic2, x).lanes();
                pl[i] = y[0];
                pr[i] = y[1];
                ql[i] = y[2];
                qr[i] = y[3];
            }
        }
        [true, false] => {
            for i in s..e {
                web_advance(c, d);
                let x = F32x4::new(pl[i], pr[i], 0.0, 0.0);
                let y = tick(c, ic1, ic2, x).lanes();
                pl[i] = y[0];
                pr[i] = y[1];
            }
        }
        _ => {
            for i in s..e {
                web_advance(c, d);
                let x = F32x4::new(0.0, 0.0, ql[i], qr[i]);
                let y = tick(c, ic1, ic2, x).lanes();
                ql[i] = y[2];
                qr[i] = y[3];
            }
        }
    }
}

#[inline(never)]
fn run_web_pair(passes: [&mut Pass; 2], outs: [[&mut [f32]; 2]; 2], n: usize) {
    let [p, q] = passes;
    let [[pl, pr], [ql, qr]] = outs;
    let (pl, pr, ql, qr) = (&mut pl[..n], &mut pr[..n], &mut ql[..n], &mut qr[..n]);
    let (ps, qs) = (p.web(), q.web());
    let mut ic1 = F32x4::new(ps[0], ps[1], qs[0], qs[1]);
    let mut ic2 = F32x4::new(ps[2], ps[3], qs[2], qs[3]);
    // the coefficients of the lanes as a span that is a line left them (a voice goes on along its line where the
    // span of the other ends)
    let mut c = [F32x4::splat(0.0); 6];
    let mut s = 0;
    while s < n {
        let mut stepped = [false; 2];
        if s == p.next {
            p.step(s);
            stepped[0] = true;
        }
        if s == q.next {
            q.step(s);
            stepped[1] = true;
        }
        let e = n.min(p.next).min(q.next);
        if p.active || q.active {
            let line = p.ramps() || q.ramps();
            let ((cp, dp), (cq, dq)) = (p.web_line(), q.web_line());
            let mask = halves_of(stepped);
            c = core::array::from_fn(|k| {
                let starts = F32x4::new(cp[k], cp[k], cq[k], cq[k]);
                if line {
                    starts.or_else(mask, c[k])
                } else {
                    starts
                }
            });
            let on = [p.active, q.active];
            let mut channels = (&mut *pl, &mut *pr, &mut *ql, &mut *qr);
            if line {
                let d: [F32x4; 6] = core::array::from_fn(|k| F32x4::new(dp[k], dp[k], dq[k], dq[k]));
                web_pair_samples(&mut c, Some(&d), &mut ic1, &mut ic2, s, e, on, &mut channels);
            } else {
                web_pair_samples(&mut c, None, &mut ic1, &mut ic2, s, e, on, &mut channels);
            }
            // (the state of a voice is flushed where its own span ends, as `run` does: at the end of a span of
            // the other it would go to 0 a few samples sooner, other bits)
            let ends = [p.active && e == p.next, q.active && e == q.next];
            let flush = |ic: F32x4| {
                let (kept, flushed) = (ic.lanes(), ic.flush().lanes());
                let lane = |k: usize| if ends[k >> 1] { flushed[k] } else { kept[k] };
                F32x4::new(lane(0), lane(1), lane(2), lane(3))
            };
            ic1 = flush(ic1);
            ic2 = flush(ic2);
        }
        s = e;
    }
    let (ic1, ic2) = (ic1.lanes(), ic2.lanes());
    if let Engine::Web { state, .. } = &mut p.engine {
        **state = [ic1[0], ic1[1], ic2[0], ic2[1]];
    }
    if let Engine::Web { state, .. } = &mut q.engine {
        **state = [ic1[2], ic1[3], ic2[2], ic2[3]];
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dsp_core::biquad::Biquad;
    use dsp_core::filter_model::Coefs;
    use dsp_core::model_spans::{design_coefs, design_knobs, plain, refreshes, NARROW_CELLS};
    use dsp_core::simd::U32x4;
    use jsmath::{log10, min};

    const RATE: f64 = 48000.0;
    const TYPES: [FilterType; 8] = [
        FilterType::Lowpass,
        FilterType::Highpass,
        FilterType::Bandpass,
        FilterType::Lowshelf,
        FilterType::Highshelf,
        FilterType::Peaking,
        FilterType::Notch,
        FilterType::Allpass,
    ];

    fn noise(length: usize, mut seed: u32) -> Vec<f32> {
        (0..length)
            .map(|_| {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                (seed >> 8) as f32 / (1 << 24) as f32 - 0.5
            })
            .collect()
    }

    fn filter_of(ty: FilterType, cutoff: f64, resonance: f64, gain: f64) -> VoiceFilter {
        VoiceFilter::new(
            RATE,
            Some(FilterOptions {
                kind: Kind::Web(Some(ty)),
                cutoff,
                resonance,
                gain,
                drive: 0.0,
                variation: 0.0,
            }),
        )
    }

    #[test]
    fn it_is_the_biquad_of_every_type() {
        // (cutoff, resonance, gain): the edges of the knobs too, the constants at and over the nyquist
        let knobs = [
            (1000.0, 3.0, 6.0),
            (20.0, 0.7, -12.0),
            (20.0, 20.0, 12.0),
            (8000.0, 10.0, -18.0),
            (15000.0, 0.01, 24.0),
            (300.0, -6.0, 0.0),
            (24000.0, 1.0, 6.0),
            (30000.0, 1.0, 6.0),
            (1000.0, 0.0, 6.0),
        ];
        for ty in TYPES {
            for (cutoff, resonance, gain) in knobs {
                let input = noise(4096, 7);
                let mut biquad = Biquad::default();
                biquad.set(ty, cutoff, resonance, gain, RATE);
                let mut filter = filter_of(ty, cutoff, resonance, gain);
                let (mut left, mut right) = (input.clone(), input.clone());
                run(&mut filter.pass(0, 4096, [None; KNOBS]), &mut left, &mut right);
                let mut worst = 0.0f64;
                let mut peak = 1.0f64;
                for (i, &x) in input.iter().enumerate() {
                    let y = biquad.process(x as f64);
                    peak = max(peak, y.abs());
                    worst = max(worst, (left[i] as f64 - y).abs());
                    assert_eq!(left[i].to_bits(), right[i].to_bits());
                }
                assert!(
                    worst < 3e-5 * peak,
                    "{ty:?} at {cutoff} Hz, {resonance}, {gain} dB: {worst} of {peak}"
                );
            }
        }
    }

    #[test]
    fn its_tail_ends_in_zeros() {
        for ty in TYPES {
            let mut filter = filter_of(ty, 20.0, 2.0, 12.0);
            let mut left = noise(128, 3);
            let mut right = left.clone();
            run(&mut filter.pass(0, 128, [None; KNOBS]), &mut left, &mut right);
            // the tail at 20 Hz: silence within 20 s, no denormal on the way
            let mut last = [1.0f32; 2];
            for _ in 0..(20.0 * RATE / 128.0) as usize {
                let (mut left, mut right) = ([0.0f32; 128], [0.0f32; 128]);
                run(&mut filter.pass(0, 128, [None; KNOBS]), &mut left, &mut right);
                assert!(filter.state.iter().all(|x| *x == 0.0 || x.abs() >= 1e-25));
                last = [left[127], right[127]];
            }
            assert_eq!(last, [0.0; 2], "{ty:?}");
            assert_eq!(filter.state, [0.0; 4], "{ty:?}");
        }
    }

    #[test]
    fn two_voices_in_the_lanes_are_each_alone() {
        let n = 200;
        let cutoffs: [Vec<f32>; 2] = [
            (0..n).map(|i| 300.0 + 20.0 * i as f32).collect(),
            (0..n).map(|i| 9000.0 - 30.0 * i as f32).collect(),
        ];
        // (a, b) of each voice: late, stopped, the whole block, nothing
        for ranges in [
            [(0, n), (0, n)],
            [(37, n), (0, 150)],
            [(0, 3), (5, 199)],
            [(60, 60), (10, n)],
        ] {
            for moving in [false, true] {
                let input: [Vec<f32>; 4] = core::array::from_fn(|k| {
                    let (a, b) = ranges[k / 2];
                    let mut channel = noise(n, k as u32 + 1);
                    channel[..a].fill(0.0);
                    channel[b..].fill(0.0);
                    channel
                });
                let filters = || {
                    [
                        filter_of(FilterType::Lowpass, 700.0, 12.0, 0.0),
                        filter_of(FilterType::Peaking, 2000.0, 4.0, 9.0),
                    ]
                };
                let moved = |k: usize| [moving.then_some(cutoffs[k].as_slice()), None, None, None, None];
                let mut alone = input.clone();
                let mut one = filters();
                for (k, filter) in one.iter_mut().enumerate() {
                    let (a, b) = ranges[k];
                    let (left, right) = alone[2 * k..2 * k + 2].split_at_mut(1);
                    run(&mut filter.pass(a, b, moved(k)), &mut left[0], &mut right[0]);
                }
                let mut paired = input.clone();
                let mut two = filters();
                {
                    let [f0, f1] = &mut two;
                    let [l0, r0, l1, r1] = &mut paired;
                    let mut p = f0.pass(ranges[0].0, ranges[0].1, moved(0));
                    let mut q = f1.pass(ranges[1].0, ranges[1].1, moved(1));
                    run_pair([&mut p, &mut q], [[l0, r0], [l1, r1]], n);
                }
                for k in 0..4 {
                    let bits = |channel: &Vec<f32>| channel.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
                    assert_eq!(
                        bits(&alone[k]),
                        bits(&paired[k]),
                        "{ranges:?} {moving} channel {k}"
                    );
                }
                for k in 0..2 {
                    assert_eq!(one[k].state, two[k].state);
                }
            }
        }
    }

    // a still voice whose state rings under TINY next to one whose cutoff moves (its spans end inside the span
    // of the first): the state of the first is flushed at the end of its own span only
    #[test]
    fn a_state_under_tiny_is_flushed_at_the_spans_of_its_own_voice() {
        let n = 200;
        let cutoff: Vec<f32> = (0..n).map(|i| 9000.0 - 30.0 * i as f32).collect();
        for amplitude in [1e-24f32, 1e-23, 1e-22] {
            for still in 0..2 {
                let input: [Vec<f32>; 4] = core::array::from_fn(|k| {
                    if k / 2 == still {
                        let mut channel = vec![0.0; n];
                        channel[0] = amplitude * (1 + k % 2) as f32;
                        channel
                    } else {
                        noise(n, k as u32 + 1)
                    }
                });
                let filters = || {
                    [
                        filter_of(FilterType::Lowpass, 700.0, 12.0, 0.0),
                        filter_of(FilterType::Lowpass, 700.0, 12.0, 0.0),
                    ]
                };
                let moved = |k: usize| [(k != still).then_some(cutoff.as_slice()), None, None, None, None];
                let mut alone = input.clone();
                let mut one = filters();
                for (k, filter) in one.iter_mut().enumerate() {
                    let (left, right) = alone[2 * k..2 * k + 2].split_at_mut(1);
                    run(&mut filter.pass(0, n, moved(k)), &mut left[0], &mut right[0]);
                }
                // (the case is there: the voice alone comes under TINY inside its span and plays on)
                assert!(alone[2 * still][1..]
                    .iter()
                    .any(|x| *x != 0.0 && x.abs() < dsp_core::simd::TINY));
                let mut paired = input.clone();
                let mut two = filters();
                {
                    let [f0, f1] = &mut two;
                    let [l0, r0, l1, r1] = &mut paired;
                    let mut p = f0.pass(0, n, moved(0));
                    let mut q = f1.pass(0, n, moved(1));
                    run_pair([&mut p, &mut q], [[l0, r0], [l1, r1]], n);
                }
                for k in 0..4 {
                    let bits = |channel: &Vec<f32>| channel.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
                    assert_eq!(
                        bits(&alone[k]),
                        bits(&paired[k]),
                        "{amplitude} still {still} channel {k}"
                    );
                }
                for k in 0..2 {
                    assert_eq!(one[k].state, two[k].state);
                }
            }
        }
    }

    fn model_of(ty: ModelType, cutoff: f64, resonance: f64, drive: f64, variation: f64) -> VoiceFilter {
        VoiceFilter::new(
            RATE,
            Some(FilterOptions {
                kind: Kind::Model(ty),
                cutoff,
                resonance,
                gain: 0.0,
                drive,
                variation,
            }),
        )
    }

    // the cutoff of every model type swept from 1 kHz to the top and back, slowly (the coefficients between the
    // designs of its cells) and fast (a design a span): noise in, every sample out finite and bounded, the tail
    // after it too (the one-pole of High 6 turned unstable over 17 kHz: the voice went silent with a click)
    #[test]
    fn every_model_type_sweeps_to_the_top() {
        for rate in [44100.0, 48000.0] {
            let top = 0.46 * rate;
            for ty in filter_model::MODEL_TYPES {
                for resonance in [0.0, 100.0] {
                    for blocks in [160usize, 6] {
                        let mut filter = VoiceFilter::new(
                            rate,
                            Some(FilterOptions {
                                kind: Kind::Model(ty),
                                cutoff: 1000.0,
                                resonance,
                                gain: 0.0,
                                drive: 0.0,
                                variation: 0.0,
                            }),
                        );
                        let n = 2 * blocks * 128;
                        let cutoffs: Vec<f32> = (0..n)
                            .map(|i| {
                                let t = 1.0 - (2.0 * i as f64 / n as f64 - 1.0).abs();
                                (1000.0 * pow(top / 1000.0, t)) as f32
                            })
                            .collect();
                        let mut blocks_of = cutoffs.chunks(128).map(Some).chain([None; 8]).enumerate();
                        for (b, cutoff) in &mut blocks_of {
                            let (mut left, mut right) = match cutoff {
                                Some(_) => (noise(128, b as u32), noise(128, b as u32 + 7919)),
                                None => (vec![0.0; 128], vec![0.0; 128]),
                            };
                            run(
                                &mut filter.pass(0, 128, [cutoff, None, None, None, None]),
                                &mut left,
                                &mut right,
                            );
                            let at = cutoff.map_or(top, |c| c[0] as f64);
                            assert!(
                                left.iter()
                                    .chain(&right)
                                    .all(|y| y.is_finite() && y.abs() < 100.0),
                                "{ty:?} {rate} Res {resonance}, {blocks} blocks: block {b} at {at} Hz"
                            );
                        }
                    }
                }
            }
        }
    }

    // the voice of each filter alone, then the two in the lanes of one: the same bits, the same state
    fn alone_and_paired(make: impl Fn() -> [VoiceFilter; 2], ranges: [(usize, usize); 2], moving: bool) {
        let n = 200;
        let cutoffs: [Vec<f32>; 2] = [
            (0..n).map(|i| 300.0 + 20.0 * i as f32).collect(),
            (0..n).map(|i| 9000.0 - 30.0 * i as f32).collect(),
        ];
        let input: [Vec<f32>; 4] = core::array::from_fn(|k| {
            let (a, b) = ranges[k / 2];
            let mut channel = noise(n, k as u32 + 1);
            channel[..a].fill(0.0);
            channel[b..].fill(0.0);
            channel
        });
        let moved = |k: usize| [moving.then_some(cutoffs[k].as_slice()), None, None, None, None];
        let mut alone = input.clone();
        let mut one = make();
        for (k, filter) in one.iter_mut().enumerate() {
            let (a, b) = ranges[k];
            let (left, right) = alone[2 * k..2 * k + 2].split_at_mut(1);
            run(&mut filter.pass(a, b, moved(k)), &mut left[0], &mut right[0]);
        }
        let mut paired = input.clone();
        let mut two = make();
        {
            let [f0, f1] = &mut two;
            let [l0, r0, l1, r1] = &mut paired;
            let mut p = f0.pass(ranges[0].0, ranges[0].1, moved(0));
            let mut q = f1.pass(ranges[1].0, ranges[1].1, moved(1));
            run_pair([&mut p, &mut q], [[l0, r0], [l1, r1]], n);
        }
        for k in 0..4 {
            let bits = |channel: &Vec<f32>| channel.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
            assert_eq!(
                bits(&alone[k]),
                bits(&paired[k]),
                "{ranges:?} {moving} channel {k}"
            );
        }
    }

    // three or four voices through run_group (two pairs in one loop where they are wide, else in pairs and one
    // alone): the bits and the state of each voice alone. `filters` of the voices, their a..b, whether their cutoffs
    // move (each its own sweep: a block of 200 is not one of whole groups)
    fn grouped_as_alone(filters: &[VoiceFilter], ranges: &[(usize, usize)], moving: bool, n: usize) {
        let count = filters.len();
        let cutoffs: Vec<Vec<f32>> = (0..count)
            .map(|k| {
                (0..n)
                    .map(|i| 300.0 + 40.0 * k as f32 + (12.0 + k as f32) * i as f32)
                    .collect()
            })
            .collect();
        let input: Vec<Vec<f32>> = (0..2 * count)
            .map(|k| {
                let (a, b) = ranges[k / 2];
                let mut channel = noise(n, k as u32 + 11);
                channel[..a].fill(0.0);
                channel[b..].fill(0.0);
                channel
            })
            .collect();
        let moved = |k: usize| [moving.then_some(cutoffs[k].as_slice()), None, None, None, None];
        let designs = Designs::default();
        let mut alone = input.clone();
        let mut one: Vec<VoiceFilter> = filters.to_vec();
        for (k, filter) in one.iter_mut().enumerate() {
            let (a, b) = ranges[k];
            let (left, right) = alone[2 * k..2 * k + 2].split_at_mut(1);
            run(&mut filter.pass(a, b, moved(k)), &mut left[0], &mut right[0]);
        }
        let mut grouped = input.clone();
        let mut all: Vec<VoiceFilter> = filters.to_vec();
        {
            let mut passes: Vec<Pass> = all
                .iter_mut()
                .enumerate()
                .map(|(k, filter)| filter.pass(ranges[k].0, ranges[k].1, moved(k)).shared(&designs))
                .collect();
            let mut outs: Vec<[&mut [f32]; 2]> = grouped
                .chunks_mut(2)
                .map(|channels| {
                    let (left, right) = channels.split_at_mut(1);
                    [left[0].as_mut_slice(), right[0].as_mut_slice()]
                })
                .collect();
            run_group(&mut passes, &mut outs, n);
        }
        let bits = |channel: &Vec<f32>| channel.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
        for k in 0..2 * count {
            assert_eq!(
                bits(&alone[k]),
                bits(&grouped[k]),
                "{ranges:?} {moving} channel {k}"
            );
        }
        for k in 0..count {
            let state = |filter: &VoiceFilter| {
                filter.model.state.map(|c| {
                    let values = [
                        c.svf.as_flattened(),
                        &[c.drive, c.pole, c.droop],
                        c.sat.as_flattened(),
                    ];
                    values.concat().iter().map(|x| x.to_bits()).collect::<Vec<_>>()
                })
            };
            assert_eq!(state(&one[k]), state(&all[k]), "{ranges:?} {moving} voice {k}");
            assert_eq!(one[k].state, all[k].state);
        }
    }

    // the cutoff of a voice over the blocks of a test: a sweep that goes on from block to block
    fn sweep(voice: usize, block: usize, n: usize) -> Vec<f32> {
        (0..n)
            .map(|i| 400.0 + 90.0 * voice as f32 + (3.0 + voice as f32) * (block * n + i) as f32)
            .collect()
    }

    // a fast one over the blocks of a test: plucks again and again, up 6 octaves in 70 samples (over 2 octaves a span
    // at the end: in pieces, a step every sample), then held, then down at once (pieces down)
    fn pluck(voice: usize, block: usize, n: usize) -> Vec<f32> {
        (0..n)
            .map(|i| {
                let at = (block * n + i + 23 * voice) % 150;
                let x = min(at as f64 / 70.0, 1.0);
                (30.0 * pow(2.0, 6.0 * x * x)) as f32
            })
            .collect()
    }

    // A span whose cutoff moved goes to the coefficients of its knobs as a line (a step a refresh, a sample of a
    // type of a BiquadFilterNode) from where the span before left them, over the blocks too; a voice next to it
    // whose knobs are still plays the bits it plays alone, so does each voice on a line, however the spans of the
    // other cut its own (voices that start late, blocks that are not of whole spans), the saturating sections too
    // whose resonance moves with the cutoff (in pairs and in groups). So do voices whose cutoff goes fast (`pluck`:
    // spans in pieces, lines a step every sample) next to slow ones and still ones
    #[test]
    fn the_lines_of_voices_in_the_lanes_are_those_of_each_alone() {
        let ladder = |ty: ModelType, resonance: f64| {
            move |k: usize| model_of(ty, 900.0 + 100.0 * k as f32 as f64, resonance, 0.0, 0.0)
        };
        // (the filters, whose knobs move, whether their resonance moves too)
        let cases: [(Vec<VoiceFilter>, Vec<bool>, bool); 9] = [
            (
                (0..4).map(ladder(ModelType::Ladder12, 30.0)).collect(),
                vec![true, false, true, true],
                false,
            ),
            (
                (0..3).map(ladder(ModelType::Ladder12, 30.0)).collect(),
                vec![false, true, false],
                false,
            ),
            (
                vec![
                    model_of(ModelType::Low12, 700.0, 10.0, 0.0, 0.0),
                    model_of(ModelType::Low12, 2000.0, 60.0, 0.0, 0.0),
                ],
                vec![true, false],
                false,
            ),
            (
                vec![
                    model_of(ModelType::Low24, 700.0, 60.0, 30.0, 40.0),
                    model_of(ModelType::Low24, 2000.0, 20.0, 30.0, 70.0),
                ],
                vec![false, true],
                false,
            ),
            (
                vec![
                    model_of(ModelType::Low18, 700.0, 0.0, 0.0, 0.0),
                    model_of(ModelType::High18, 1500.0, 0.0, 0.0, 0.0),
                ],
                vec![true, true],
                false,
            ),
            (
                vec![
                    filter_of(FilterType::Lowpass, 700.0, 3.0, 0.0),
                    filter_of(FilterType::Highpass, 1500.0, 6.0, 0.0),
                ],
                vec![true, false],
                false,
            ),
            (
                (0..4).map(ladder(ModelType::Ladder24, 60.0)).collect(),
                vec![true, false, true, true],
                true,
            ),
            (
                (0..3).map(ladder(ModelType::Low24, 60.0)).collect(),
                vec![false, true, true],
                true,
            ),
            (
                vec![
                    model_of(ModelType::Low12, 700.0, 60.0, 0.0, 0.0),
                    model_of(ModelType::Low12, 2000.0, 60.0, 0.0, 0.0),
                ],
                vec![true, false],
                true,
            ),
        ];
        // (the voices that pluck: a group of ladders, one of them still, one slow; a pair of a Low 12 with Drive, one
        // with its resonance moving; a pair whose voices both pluck; one of a BiquadFilterNode)
        // (the filters, whose knobs move, whether their resonance moves too, whose cutoff plucks)
        type Case = (Vec<VoiceFilter>, Vec<bool>, bool, Vec<bool>);
        let plucks: [Case; 5] = [
            (
                (0..4).map(ladder(ModelType::Ladder24, 60.0)).collect(),
                vec![true, false, true, true],
                false,
                vec![true, false, false, true],
            ),
            (
                (0..3).map(ladder(ModelType::Ladder12, 30.0)).collect(),
                vec![true, true, false],
                true,
                vec![false, true, false],
            ),
            (
                vec![
                    model_of(ModelType::Low12, 30.0, 20.0, 42.0, 0.0),
                    model_of(ModelType::Low12, 2000.0, 20.0, 42.0, 0.0),
                ],
                vec![true, true],
                false,
                vec![true, false],
            ),
            (
                vec![
                    model_of(ModelType::Low24, 30.0, 60.0, 0.0, 0.0),
                    model_of(ModelType::Low24, 30.0, 45.0, 0.0, 0.0),
                ],
                vec![true, true],
                true,
                vec![true, true],
            ),
            (
                vec![
                    filter_of(FilterType::Lowpass, 30.0, 3.0, 0.0),
                    filter_of(FilterType::Highpass, 1500.0, 6.0, 0.0),
                ],
                vec![true, true],
                false,
                vec![true, false],
            ),
        ];
        let cases = cases
            .into_iter()
            .map(|(filters, moving, resonant)| {
                let still = vec![false; filters.len()];
                (filters, moving, resonant, still)
            })
            .chain(plucks);
        let bits = |channel: &Vec<f32>| channel.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
        for (filters, moving, resonant, fast) in cases {
            let count = filters.len();
            let designs = Designs::default();
            let (mut one, mut all) = (filters.clone(), filters);
            // (the first voice starts late in the first block: its spans are not those of the others)
            for (block, n) in [128, 128, 100, 128].into_iter().enumerate() {
                let start = |k: usize| if block == 0 && k == 0 { 37 } else { 0 };
                let cutoffs: Vec<Vec<f32>> = (0..count)
                    .map(|k| {
                        if fast[k] {
                            pluck(k, block, n)
                        } else {
                            sweep(k, block, n)
                        }
                    })
                    .collect();
                // (from 45 % up: the layout of the voices whose resonance stays)
                let resonances: Vec<Vec<f32>> = (0..count)
                    .map(|k| {
                        (0..n)
                            .map(|i| 45.0 + 4.0 * k as f32 + 0.09 * (block * n + i) as f32)
                            .collect()
                    })
                    .collect();
                let moved = |k: usize| {
                    [
                        moving[k].then_some(cutoffs[k].as_slice()),
                        (moving[k] && resonant).then_some(resonances[k].as_slice()),
                        None,
                        None,
                        None,
                    ]
                };
                let input: Vec<Vec<f32>> = (0..2 * count)
                    .map(|k| {
                        let mut channel = noise(n, (block * 16 + k) as u32 + 5);
                        channel[..start(k / 2)].fill(0.0);
                        channel
                    })
                    .collect();
                let mut alone = input.clone();
                for (k, filter) in one.iter_mut().enumerate() {
                    let (left, right) = alone[2 * k..2 * k + 2].split_at_mut(1);
                    run(
                        &mut filter.pass(start(k), n, moved(k)),
                        &mut left[0],
                        &mut right[0],
                    );
                }
                let mut grouped = input.clone();
                {
                    let mut passes: Vec<Pass> = all
                        .iter_mut()
                        .enumerate()
                        .map(|(k, filter)| filter.pass(start(k), n, moved(k)).shared(&designs))
                        .collect();
                    let mut outs: Vec<[&mut [f32]; 2]> = grouped
                        .chunks_mut(2)
                        .map(|channels| {
                            let (left, right) = channels.split_at_mut(1);
                            [left[0].as_mut_slice(), right[0].as_mut_slice()]
                        })
                        .collect();
                    run_group(&mut passes, &mut outs, n);
                }
                for k in 0..2 * count {
                    assert_eq!(
                        bits(&alone[k]),
                        bits(&grouped[k]),
                        "{moving:?} {resonant} {fast:?} block {block} channel {k}"
                    );
                }
            }
        }
    }

    // The spans of knobs that move are lines: at the end of each the coefficients are those of its knobs (the steps
    // of a span, a refresh each or a sample each of a fast one, add up to them within the rounding of f32), on the way
    // between those of the span before and them by the share of its steps (of a saturating section its g, k0, a, l,
    // the products of its saturation those of them; the steps of its integrators, read at the ends alone, those of its
    // knobs at once). The first span of a note is no line; a cutoff that jumped is a line in pieces. A block starts
    // from the coefficients of its slot (`before`), where the lines of the block before ended: a note that starts late
    // in its block (29: spans from 29, 61, 93) has a last span long enough to get there in its refreshes (`span_end`:
    // none of under half a span)
    #[test]
    fn a_span_of_a_moving_cutoff_is_a_line_to_the_coefficients_of_its_knobs() {
        let n = 128;
        let silence = || (vec![0.0f32; n], vec![0.0f32; n]);
        let near = |a: F32x4, b: F32x4| {
            let (a, b) = (a.lanes(), b.lanes());
            (0..4).all(|k| (a[k] - b[k]).abs() <= 2e-6 * b[k].abs().max(1e-3))
        };
        let toward = |was: F32x4, to: F32x4, share: f32| was + (to - was) * F32x4::splat(share);
        let bits = |sat: &[[F32x4; 8]; 2]| {
            sat.as_flattened()
                .iter()
                .map(|x| x.bits().lanes())
                .collect::<Vec<_>>()
        };
        // (the lines that step every refresh and those that step every sample: FINE)
        let mut kinds = [0; 2];
        // (plain ones, a ladder too, their cutoff alone moving; a saturating one, its resonance with its cutoff)
        for (ty, resonance, resonant) in [
            (ModelType::Low24, 20.0, false),
            (ModelType::Ladder24, 20.0, false),
            (ModelType::Low12, 60.0, true),
        ] {
            let mut filter = model_of(ty, 500.0, resonance, 0.0, 0.0);
            let layout = gated(ty, false, false, resonant);
            assert_eq!(plain(layout), !resonant);
            let mut d = LaneCoefs::still();
            for block in 0..3 {
                let start = if block == 0 { 29 } else { 0 };
                let cutoffs = sweep(0, block, n);
                let resonances: Vec<f32> = (0..n)
                    .map(|i| (resonance + 0.05 * (block * n + i) as f64) as f32)
                    .collect();
                let knobs = [
                    Some(cutoffs.as_slice()),
                    resonant.then_some(resonances.as_slice()),
                    None,
                    None,
                    None,
                ];
                let mut pass = filter.pass(start, n, knobs);
                let (mut left, mut right) = silence();
                let mut lanes = LaneState::default();
                let mut c = before_of(&pass, &pass);
                let mut every = None;
                let mut s = start;
                while s < n {
                    let was = c;
                    pass.step(s);
                    let fresh = pass.take_fresh();
                    let e = pass.next;
                    let line = spans_of(layout, &mut c, &mut d, &mut every, &pass, &pass, [true; 2]);
                    // (the first span of the note alone is no line)
                    assert_eq!(line.moves(), !fresh, "{ty:?} block {block} at {s}");
                    assert!(
                        refreshes(s, e) >= SEGMENT / REFRESH / 2,
                        "{ty:?} block {block}: {s}..{e}"
                    );
                    let to = LaneCoefs::of(&pass.model().coefs, &pass.model().coefs);
                    if line.moves() {
                        // (half its steps: its share of the way; a step a refresh, or a sample of a fast one)
                        let fine = matches!(line, Line::Fine(_));
                        assert_eq!(fine, every.is_some(), "{ty:?} block {block} at {s}");
                        kinds[fine as usize] += 1;
                        let (mid, share) = if fine {
                            let mid = s + (e - s) / 2;
                            (mid, (mid - s) as f32 / (e - s) as f32)
                        } else {
                            let mid = (s.div_ceil(REFRESH) + refreshes(s, e) / 2) * REFRESH;
                            (mid, refreshes(s, mid) as f32 / refreshes(s, e) as f32)
                        };
                        run_span(
                            layout, line, &mut c, &d, &every, &mut lanes, s, mid, &mut left, &mut right,
                        );
                        let half = |was: F32x4, to: F32x4| toward(was, to, share);
                        let at = format!("{ty:?} block {block} at {s}");
                        for i in 0..layout.svfs {
                            let saturates = i == 0 && layout.sat || i == 1 && layout.sat2;
                            for k in 0..6 {
                                let steps = k < 3 && saturates;
                                let there = if steps {
                                    to.svf[i][k]
                                } else {
                                    half(was.svf[i][k], to.svf[i][k])
                                };
                                assert!(near(c.svf[i][k], there), "{at}: {i} {k}");
                            }
                            for k in 0..4 {
                                if saturates {
                                    let there = half(was.saturation[i][k], to.saturation[i][k]);
                                    assert!(near(c.saturation[i][k], there), "{at}: {i} saturation {k}");
                                }
                            }
                        }
                        let products = c
                            .saturation
                            .map(|section| filter_model::sat_products(section, F32x4::splat(1.0)));
                        assert_eq!(bits(&c.sat), bits(&products), "{at}");
                        run_span(
                            layout, line, &mut c, &d, &every, &mut lanes, mid, e, &mut left, &mut right,
                        );
                    }
                    for i in 0..layout.svfs {
                        for k in 0..6 {
                            assert!(
                                near(c.svf[i][k], to.svf[i][k]),
                                "{ty:?} block {block} at {s}: {i} {k}"
                            );
                        }
                        let saturates = i == 0 && layout.sat || i == 1 && layout.sat2;
                        for k in 0..4 {
                            assert!(
                                !saturates || near(c.saturation[i][k], to.saturation[i][k]),
                                "{ty:?} block {block} at {s}: {i} saturation {k}"
                            );
                        }
                    }
                    s = e;
                }
            }
        }
        assert!(kinds[0] > 0 && kinds[1] > 0, "{kinds:?}");
        // A cutoff that jumps (over JUMP times a span: 300 and 3000 Hz in turn, 3.3 octaves) is a line in pieces of an
        // octave at most, 4, each to the design of a cutoff on the way (its share of the octaves by its samples) and
        // over on a refresh, the last at the end of the span with the design of its knobs; so fast a line steps every
        // sample. The first span of the note is no line
        let jumping: Vec<f32> = (0..n)
            .map(|i| {
                if (i / SEGMENT).is_multiple_of(2) {
                    300.0
                } else {
                    3000.0
                }
            })
            .collect();
        for web in [false, true] {
            let mut filter = if web {
                filter_of(FilterType::Lowpass, 500.0, 3.0, 0.0)
            } else {
                model_of(ModelType::Low12, 500.0, 20.0, 0.0, 0.0)
            };
            let mut pass = filter.pass(0, n, [Some(jumping.as_slice()), None, None, None, None]);
            pass.step(0);
            pass.take_fresh();
            assert!(!pass.ramps(), "web {web}");
            assert_eq!(pass.next, SEGMENT);
            let mut ends = vec![];
            let mut s = SEGMENT;
            while s < n {
                pass.step(s);
                pass.take_fresh();
                let e = pass.next;
                assert!(pass.ramps(), "web {web} at {s}");
                // (the span the piece is of: from the knob read at its start before to the one read at its start)
                let span = s / SEGMENT * SEGMENT;
                let (from, to) = (jumping[span - SEGMENT] as f64, jumping[span] as f64);
                let end = span_end(span, n);
                let [cutoff] = piece_knobs([from], [to], span, end, e);
                let at = format!("web {web} at {s}..{e}");
                match &pass.engine {
                    Engine::Web { coefficients, .. } => {
                        let mut design = [0.0; 6];
                        let power = power_of(Some(FilterType::Lowpass), 3.0, 0.0);
                        svf_into(&mut design, Some(FilterType::Lowpass), cutoff, 3.0, power, RATE);
                        assert_eq!(**coefficients, design, "{at}");
                    }
                    Engine::Model { slot, .. } => {
                        assert!(slot.fine(), "{at}");
                        let design = design_coefs(ModelType::Low12, [cutoff, 20.0, 0.0], RATE);
                        assert_eq!(slot.coefs.svf, design.svf, "{at}");
                    }
                }
                ends.push(e);
                s = e;
            }
            assert_eq!(
                ends,
                [40, 48, 56, 64, 72, 80, 88, 96, 104, 112, 120, 128],
                "web {web}"
            );
            // (and one that moves by less: a line, of a type of a BiquadFilterNode too)
            let cutoffs = sweep(1, 0, n);
            let mut pass = filter.pass(0, n, [Some(cutoffs.as_slice()), None, None, None, None]);
            pass.step(0);
            pass.step(SEGMENT);
            assert!(pass.ramps(), "web {web}");
        }
    }

    // A cutoff and a resonance that jump together by under JUMP (a line), a square on both, noise in: the lines of the
    // saturating sections go along their g, k0, a, l, the filter rings as loud as where the knobs are held (a line of
    // the products of the saturation went to a damping under 0 on the way: peaks of 22 and 32 here, under 0.6 held a
    // span each)
    #[test]
    fn a_jump_of_the_cutoff_and_the_resonance_together_is_no_burst() {
        let n = 128;
        // (the type, its cutoff, the octaves and the resonances it jumps between, every so many samples)
        for (ty, cutoff, octaves, low, high, every) in [
            (ModelType::Low12, 5306.0, 1.32, 42.0, 95.9, 2400),
            (ModelType::Band24, 3960.0, 1.807, 40.6, 96.2, 2400),
            (ModelType::Band24, 3960.0, 1.807, 40.6, 96.2, SEGMENT),
            (ModelType::Low24, 3000.0, 1.0, 50.0, 100.0, 2400),
            (ModelType::Ladder24, 3000.0, 1.0, 50.0, 100.0, 3 * SEGMENT),
        ] {
            let mut filter = model_of(ty, cutoff, low, 0.0, 0.0);
            let mut peak = 0.0f32;
            for block in 0..80 {
                let up = |i: usize| ((block * n + i) / every) % 2 == 1;
                let cutoffs: Vec<f32> = (0..n)
                    .map(|i| (cutoff * pow(2.0, if up(i) { octaves } else { 0.0 })) as f32)
                    .collect();
                let resonances: Vec<f32> = (0..n).map(|i| if up(i) { high } else { low } as f32).collect();
                let mut left: Vec<f32> = noise(n, block as u32 + 1).iter().map(|x| 0.5 * x).collect();
                let mut right = left.clone();
                let knobs = [
                    Some(cutoffs.as_slice()),
                    Some(resonances.as_slice()),
                    None,
                    None,
                    None,
                ];
                run(&mut filter.pass(0, n, knobs), &mut left, &mut right);
                peak = left.iter().chain(&right).fold(peak, |most, x| most.max(x.abs()));
            }
            assert!(peak < 1.0, "{ty:?} every {every}: {peak}");
        }
    }

    // the variation of an EQ type (the gain of its band), of a one-pole and of a notch is no FAT: no gain of 1 a
    // sample, two of other variations of one type share the lanes
    #[test]
    fn the_variation_of_an_eq_type_a_one_pole_or_a_notch_is_no_fat() {
        let layout = |ty: ModelType, variation: f64| {
            let mut filter = model_of(ty, 1000.0, 60.0, 0.0, variation);
            filter.pass(0, 128, [None; KNOBS]).layout.expect("a model type")
        };
        assert!(layout(ModelType::Low12, 40.0).fat);
        assert!(layout(ModelType::Ladder24, 40.0).fat);
        for ty in [
            ModelType::LowEq12,
            ModelType::BandEq12,
            ModelType::HighEq6,
            ModelType::Low6,
            ModelType::Notch12,
            ModelType::Notch24,
        ] {
            assert!(!layout(ty, 70.0).fat, "{ty:?}");
            assert!(layout(ty, 70.0) == layout(ty, 0.0), "{ty:?}");
        }
        for moving in [false, true] {
            alone_and_paired(
                || {
                    [
                        model_of(ModelType::LowEq12, 500.0, 60.0, 0.0, 0.0),
                        model_of(ModelType::LowEq12, 900.0, 60.0, 0.0, 70.0),
                    ]
                },
                [(0, 200), (0, 200)],
                moving,
            );
        }
    }

    #[test]
    fn three_or_four_voices_are_each_alone() {
        let n = 200;
        let wide = |ty: ModelType, cutoff: f64| model_of(ty, cutoff, 60.0, 0.0, 40.0);
        // (wide: two pairs in one loop; of three the third in both halves of the second)
        for ty in [
            ModelType::Ladder24,
            ModelType::Low12,
            ModelType::Low18,
            ModelType::Peak12,
        ] {
            let mut filters: Vec<VoiceFilter> = (0..4).map(|k| wide(ty, 500.0 + 900.0 * k as f64)).collect();
            assert!(filters[0].wide(0, n, n, || [None; KNOBS]).is_some(), "{ty:?}");
            for count in [3, 4] {
                for moving in [false, true] {
                    grouped_as_alone(&filters[..count], &vec![(0, n); count], moving, n);
                    grouped_as_alone(&filters[..count], &vec![(0, 128); count], moving, 128);
                }
            }
        }
        // not wide (plain sections, Drive, two saturating sections, a type of a BiquadFilterNode, layouts that differ,
        // a voice that starts late or stops): in pairs, the last of three alone
        let mixed: [Vec<VoiceFilter>; 6] = [
            (0..4)
                .map(|k| model_of(ModelType::Low12, 400.0 + 300.0 * k as f64, 20.0, 0.0, 0.0))
                .collect(),
            (0..4)
                .map(|k| model_of(ModelType::Ladder24, 400.0 + 300.0 * k as f64, 60.0, 30.0, 0.0))
                .collect(),
            (0..4)
                .map(|k| model_of(ModelType::Low24, 400.0 + 300.0 * k as f64, 60.0, 0.0, 0.0))
                .collect(),
            (0..4)
                .map(|k| filter_of(FilterType::Lowpass, 400.0 + 300.0 * k as f64, 8.0, 0.0))
                .collect(),
            vec![
                wide(ModelType::Ladder24, 500.0),
                wide(ModelType::Low12, 900.0),
                wide(ModelType::Ladder24, 1300.0),
            ],
            vec![
                wide(ModelType::Ladder24, 500.0),
                wide(ModelType::Ladder24, 900.0),
                filter_of(FilterType::Peaking, 2000.0, 4.0, 9.0),
                wide(ModelType::Ladder24, 1300.0),
            ],
        ];
        for filters in &mixed {
            for moving in [false, true] {
                grouped_as_alone(filters, &vec![(0, n); filters.len()], moving, n);
            }
        }
        let mut ladders: Vec<VoiceFilter> = (0..4)
            .map(|k| wide(ModelType::Ladder24, 500.0 + 900.0 * k as f64))
            .collect();
        for ranges in [
            [(0, n), (37, n), (0, n), (0, n)],
            [(0, n), (0, n), (0, n), (0, 150)],
            [(0, n), (0, n), (60, 60), (0, n)],
        ] {
            assert!(ladders[1].wide(37, n, n, || [None; KNOBS]).is_none());
            grouped_as_alone(&ladders, &ranges, true, n);
        }
    }

    // a voice whose filter fades from a type to another is not wide (it runs alone)
    #[test]
    fn a_voice_that_fades_is_not_wide() {
        let n = 128;
        let mut filter = model_of(ModelType::Ladder24, 700.0, 60.0, 0.0, 40.0);
        let (mut left, mut right) = (noise(n, 1), noise(n, 2));
        run(&mut filter.pass(0, n, [None; KNOBS]), &mut left, &mut right);
        assert!(filter.wide(0, n, n, || [None; KNOBS]).is_some());
        filter.set(Some(FilterOptions {
            kind: Kind::Model(ModelType::Low12),
            cutoff: 700.0,
            resonance: 60.0,
            gain: 0.0,
            drive: 0.0,
            variation: 40.0,
        }));
        assert!(filter.wide(0, n, n, || [None; KNOBS]).is_none());
        // under Res 40 % without FAT: plain sections, not wide; a route that holds the resonance over it: wide; one
        // that moves it: not wide, but for a ladder
        let mut still = model_of(ModelType::Low12, 700.0, 30.0, 0.0, 0.0);
        assert!(still.wide(0, n, n, || [None; KNOBS]).is_none());
        let held = [45.0f32];
        assert!(still
            .wide(0, n, n, || [None, Some(held.as_slice()), None, None, None])
            .is_some());
        let moves = vec![45.0f32; n];
        assert!(still
            .wide(0, n, n, || [None, Some(moves.as_slice()), None, None, None])
            .is_none());
        let mut ladder = model_of(ModelType::Ladder12, 700.0, 30.0, 0.0, 0.0);
        assert!(ladder
            .wide(0, n, n, || [None, Some(moves.as_slice()), None, None, None])
            .is_some());
    }

    // a cutoff knob turned (it glides) that no route reads: worked out at the starts of the spans of the pass only,
    // the bits of the glide worked out at every sample (a pass from 0 and one that starts late, a model type and one of
    // a BiquadFilterNode, blocks of 128 and of 100)
    #[test]
    fn a_cutoff_glide_no_route_reads_is_worked_out_at_the_spans() {
        let knob = |kind: Kind, cutoff: f64| FilterOptions {
            kind,
            cutoff,
            resonance: 60.0,
            gain: 6.0,
            drive: 0.0,
            variation: 30.0,
        };
        for kind in [
            Kind::Model(ModelType::Ladder24),
            Kind::Model(ModelType::Low12),
            Kind::Web(Some(FilterType::Lowpass)),
        ] {
            for (a, n) in [(0, 128), (37, 128), (0, 100), (99, 100)] {
                let (mut full, mut sparse) = (
                    VoiceFilter::new(RATE, Some(knob(kind, 300.0))),
                    VoiceFilter::new(RATE, Some(knob(kind, 300.0))),
                );
                for block in 0..12 {
                    if block % 4 == 1 {
                        let cutoff = 300.0 * (2 + block) as f64;
                        full.set(Some(knob(kind, cutoff)));
                        sparse.set(Some(knob(kind, cutoff)));
                    }
                    let from = if block == 0 { a } else { 0 };
                    full.glide(n, None);
                    sparse.glide(n, Some(from));
                    assert!(block % 4 != 1 || sparse.base(0).len() == n, "the knob glides");
                    let play = |filter: &mut VoiceFilter| {
                        let (mut left, mut right) = (noise(n, block + 3), noise(n, block + 4));
                        run(&mut filter.pass(from, n, [None; KNOBS]), &mut left, &mut right);
                        left.iter().chain(&right).map(|x| x.to_bits()).collect::<Vec<_>>()
                    };
                    assert_eq!(
                        play(&mut full),
                        play(&mut sparse),
                        "{kind:?} from {a} of {n}, block {block}"
                    );
                }
            }
        }
    }

    // voices of a node with the designs it keeps: the bits of each voice alone (an LFO on the cutoff of all, one
    // of its own on that of another: more designs than kept), each design of the shared cutoff worked out once
    #[test]
    fn the_designs_a_node_keeps_are_those_worked_out_again() {
        let n = 128;
        let lfo: Vec<f32> = (0..n).map(|i| 800.0 + 7.0 * i as f32).collect();
        let own: Vec<f32> = (0..n).map(|i| 5000.0 - 11.0 * i as f32).collect();
        let types = [
            ModelType::Low12,
            ModelType::Low12,
            ModelType::Ladder24,
            ModelType::Low12,
            ModelType::Low12,
        ];
        let cutoffs = [&lfo, &lfo, &lfo, &own, &lfo];
        let make = || types.map(|ty| model_of(ty, 700.0, 30.0, 0.0, 0.0));
        let input: Vec<Vec<f32>> = (0..2 * types.len()).map(|k| noise(n, k as u32 + 1)).collect();
        let moved = |k: usize| [Some(cutoffs[k].as_slice()), None, None, None, None];
        let mut alone = input.clone();
        for (k, filter) in make().iter_mut().enumerate() {
            let (left, right) = alone[2 * k..2 * k + 2].split_at_mut(1);
            run(&mut filter.pass(0, n, moved(k)), &mut left[0], &mut right[0]);
        }
        let designs = Designs::default();
        let mut kept = input.clone();
        let mut filters = make();
        {
            let [f0, f1, f2, f3, f4] = &mut filters;
            let [l0, r0, l1, r1, l2, r2, l3, r3, l4, r4] = kept.as_mut_slice() else {
                unreachable!()
            };
            run_pair(
                [
                    &mut f0.pass(0, n, moved(0)).shared(&designs),
                    &mut f1.pass(0, n, moved(1)).shared(&designs),
                ],
                [[l0, r0], [l1, r1]],
                n,
            );
            run_pair(
                [
                    &mut f2.pass(0, n, moved(2)).shared(&designs),
                    &mut f3.pass(0, n, moved(3)).shared(&designs),
                ],
                [[l2, r2], [l3, r3]],
                n,
            );
            run(&mut f4.pass(0, n, moved(4)).shared(&designs), l4, r4);
        }
        let bits = |channel: &Vec<f32>| channel.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
        for k in 0..alone.len() {
            assert_eq!(bits(&alone[k]), bits(&kept[k]), "channel {k}");
        }
        // (4 spans each, over a cell a span: Low 12 under the LFO, Ladder 24 under it, Low 12 under its own, then
        // Low 12 under the LFO again: the pair before threw its designs out. The cutoff of its own comes to the cell
        // next to its first one: the 3 designs of that cell for the 1 of its span)
        assert_eq!(designs.worked_out(), 4 * 4 + 2);
    }

    // the coefficients a filter ends a pass with (the gain of Drive apart)
    fn coefs_of(filter: &VoiceFilter) -> Coefs {
        Coefs {
            drive: 1.0,
            ..filter.model.coefs
        }
    }

    // a cutoff that moves alone inside the cells of its grid: the coefficients between the designs at the edges of
    // its cell (a first span: its own design), the cells kept by the node for every voice; the voice alone plays
    // the same bits
    #[test]
    fn a_cutoff_that_moves_alone_takes_the_designs_of_its_cells() {
        let n = 256;
        let ty = ModelType::Low12;
        let design = |cutoff: f64| design_coefs(ty, [cutoff, 60.0, 30.0], RATE);
        let sweep = |from: f32, by: f32| -> Vec<f32> { (0..n).map(|i| from + by * i as f32).collect() };
        let designs = Designs::default();
        let play = |filter: &mut VoiceFilter, cutoff: &[f32], designs: Option<&Designs>| {
            let (mut left, mut right) = (noise(n, 5), noise(n, 6));
            let pass = filter.pass(0, n, [Some(cutoff), None, None, None, None]);
            let mut pass = match designs {
                Some(designs) => pass.shared(designs),
                None => pass,
            };
            run(&mut pass, &mut left, &mut right);
            left.iter().map(|x| x.to_bits()).collect::<Vec<_>>()
        };
        // 1030 to 1055 Hz: the cell of 1024 to 1088 Hz. Its first span a design, then the three of the cell
        let inside = sweep(1030.0, 0.1);
        let mut first = model_of(ty, 700.0, 60.0, 0.0, 30.0);
        let shared = play(&mut first, &inside, Some(&designs));
        assert_eq!(designs.worked_out(), 1 + 3);
        let last = inside[n - SEGMENT] as f64;
        let share = ((last - 1024.0) / 64.0) as f32;
        assert_eq!(coefs_of(&first), design(1024.0).between(&design(1088.0), share));
        assert_ne!(coefs_of(&first), design(last));
        // a second voice in the cell: no design (that of its first span is the last the node kept); alone, with no
        // node: the same bits
        let mut second = model_of(ty, 700.0, 60.0, 0.0, 30.0);
        assert_eq!(play(&mut second, &inside, Some(&designs)), shared);
        assert_eq!(designs.worked_out(), 1 + 3);
        let mut alone = model_of(ty, 700.0, 60.0, 0.0, 30.0);
        assert_eq!(play(&mut alone, &inside, None), shared);
        // on to the cell next to it (1088 to 1152 Hz): its far edge and its middle
        let on = sweep(1056.0, 0.2);
        let shared = play(&mut first, &on, Some(&designs));
        assert_eq!(designs.worked_out(), 1 + 3 + 2);
        let last = on[n - SEGMENT] as f64;
        let share = ((last - 1088.0) / 64.0) as f32;
        assert_eq!(coefs_of(&first), design(1088.0).between(&design(1152.0), share));
        assert_eq!(play(&mut alone, &on, None), shared);
        // back in the cells the node keeps: no design
        play(&mut second, &on, Some(&designs));
        assert_eq!(designs.worked_out(), 1 + 3 + 2);
        // a jump (over a cell a span): a design of its own, the cell after it again between its edges
        let jump: Vec<f32> = (0..n)
            .map(|i| if i < 64 { 1100.0 } else { 3000.0 + i as f32 })
            .collect();
        let before = designs.worked_out();
        play(&mut first, &jump, Some(&designs));
        let last = jump[n - SEGMENT] as f64;
        let cell = filter_model::cutoff_cell(last, RATE).unwrap();
        assert_eq!(
            coefs_of(&first),
            design(cell.edges[0]).between(&design(cell.edges[1]), cell.share)
        );
        // (1100 Hz in the cell it has; the jump to 3064 Hz: a design; the cell next to that one: its three; the one
        // after it: two)
        assert_eq!(designs.worked_out() - before, 1 + 3 + 2);
    }

    // a resonance (or a variation) the type is designed by that moves with the cutoff (Band 12, the gain of
    // Band EQ 12), a still cutoff: a design a span, as before
    #[test]
    fn a_resonance_that_moves_takes_a_design_a_span() {
        let n = 128;
        let ty = ModelType::Band12;
        let cutoff: Vec<f32> = (0..n).map(|i| 1030.0 + 0.1 * i as f32).collect();
        let resonance: Vec<f32> = (0..n).map(|i| 40.0 + 0.1 * i as f32).collect();
        for (ty, moved, knob) in [(ty, 1, 1), (ModelType::BandEq12, 4, 2)] {
            let designs = Designs::default();
            let mut filter = model_of(ty, 700.0, 60.0, 0.0, 30.0);
            let (mut left, mut right) = (noise(n, 5), noise(n, 6));
            let mut knobs = [Some(cutoff.as_slice()), None, None, None, None];
            knobs[moved] = Some(resonance.as_slice());
            run(
                &mut filter.pass(0, n, knobs).shared(&designs),
                &mut left,
                &mut right,
            );
            assert_eq!(designs.worked_out(), n / SEGMENT);
            let at = n - SEGMENT;
            let mut last = [cutoff[at] as f64, 60.0, 30.0];
            last[knob] = resonance[at] as f64;
            assert_eq!(coefs_of(&filter), design_coefs(ty, last, RATE));
        }
        // the cutoff still under a route (one value a sample, all the same): its design, once
        let designs = Designs::default();
        let mut filter = model_of(ty, 700.0, 60.0, 0.0, 30.0);
        let (mut left, mut right) = (noise(n, 5), noise(n, 6));
        let still = vec![1030.0f32; n];
        let knobs = [Some(still.as_slice()), None, None, None, None];
        run(
            &mut filter.pass(0, n, knobs).shared(&designs),
            &mut left,
            &mut right,
        );
        assert_eq!(designs.worked_out(), 1);
        assert_eq!(coefs_of(&filter), design_coefs(ty, [1030.0, 60.0, 30.0], RATE));
    }

    // a knob a type is not designed by that moves with the cutoff (the FAT of Band 12, the resonance and the
    // variation of a one-pole, the resonance of an EQ one-pole): the cutoff in the cells of its grid as alone (its
    // first span a design, then the three of its cell), its FAT that of the last span; alone, the same bits
    #[test]
    fn a_knob_a_type_is_not_designed_by_keeps_the_cutoff_in_its_cells() {
        let n = 128;
        let cutoff: Vec<f32> = (0..n).map(|i| 1030.0 + 0.1 * i as f32).collect();
        let moving: Vec<f32> = (0..n).map(|i| 40.0 + 0.1 * i as f32).collect();
        let play = |ty: ModelType, moved: &[usize], designs: Option<&Designs>| {
            let mut filter = model_of(ty, 700.0, 60.0, 0.0, 30.0);
            let (mut left, mut right) = (noise(n, 5), noise(n, 6));
            let mut knobs = [Some(cutoff.as_slice()), None, None, None, None];
            for &k in moved {
                knobs[k] = Some(moving.as_slice());
            }
            let pass = filter.pass(0, n, knobs);
            match designs {
                Some(designs) => run(&mut pass.shared(designs), &mut left, &mut right),
                None => run(&mut { pass }, &mut left, &mut right),
            }
            (filter, left.iter().map(|x| x.to_bits()).collect::<Vec<_>>())
        };
        // (Low 6: its resonance, Drive and variation all moving too)
        for (ty, moved) in [
            (ModelType::Band12, &[4][..]),
            (ModelType::Low6, &[1]),
            (ModelType::Low6, &[4]),
            (ModelType::Low6, &[1, 3, 4]),
            (ModelType::LowEq6, &[1]),
        ] {
            let designs = Designs::default();
            let (filter, shared) = play(ty, moved, Some(&designs));
            assert_eq!(designs.worked_out(), 1 + 3, "{ty:?} {moved:?}");
            let at = n - SEGMENT;
            let mut knobs = [60.0, 30.0];
            for &k in moved.iter().filter(|&&k| k != 3) {
                knobs[if k == 1 { 0 } else { 1 }] = moving[at] as f64;
            }
            let [q, v] = design_knobs(ty, [60.0, 30.0]);
            let design = |cutoff: f64| design_coefs(ty, [cutoff, q, v], RATE);
            let share = ((cutoff[at] as f64 - 1024.0) / 64.0) as f32;
            let mut between = design(1024.0).between(&design(1088.0), share);
            between.fat = ty.fat_of(knobs[0] / 100.0, knobs[1] / 100.0) as f32;
            assert_eq!(coefs_of(&filter), between, "{ty:?} {moved:?}");
            assert_eq!(play(ty, moved, None).1, shared, "{ty:?} {moved:?}");
        }
    }

    // a knob a type is not designed by that moves alone (the FAT of a ladder and of a state variable filter, the
    // resonance and the variation of a one-pole, the resonance of an EQ one-pole): its first span a design, then
    // none; its coefficients are those of the design of the knobs of its last span (FAT with them), the same bits in
    // a node and alone. The resonance of Low 24 (it is designed by it): a design a span
    #[test]
    fn a_knob_a_type_is_not_designed_by_moves_no_design() {
        let n = 128;
        let moving: Vec<f32> = (0..n).map(|i| 20.0 + 0.4 * i as f32).collect();
        let play = |ty: ModelType, moved: usize, designs: Option<&Designs>| {
            let mut filter = model_of(ty, 1030.0, 60.0, 0.0, 30.0);
            let (mut left, mut right) = (noise(n, 5), noise(n, 6));
            let mut knobs = [None, None, None, None, None];
            knobs[moved] = Some(moving.as_slice());
            let pass = filter.pass(0, n, knobs);
            match designs {
                Some(designs) => run(&mut pass.shared(designs), &mut left, &mut right),
                None => run(&mut { pass }, &mut left, &mut right),
            }
            (filter, left.iter().map(|x| x.to_bits()).collect::<Vec<_>>())
        };
        for (ty, moved, designed) in [
            (ModelType::Low24, 4, 1),
            (ModelType::Ladder12, 4, 1),
            (ModelType::Low6, 1, 1),
            (ModelType::High6, 4, 1),
            (ModelType::LowEq6, 1, 1),
            (ModelType::Low24, 1, n / SEGMENT),
        ] {
            let designs = Designs::default();
            let (filter, shared) = play(ty, moved, Some(&designs));
            assert_eq!(designs.worked_out(), designed, "{ty:?} {moved}");
            let mut last = [1030.0, 60.0, 30.0];
            last[if moved == 1 { 1 } else { 2 }] = moving[n - SEGMENT] as f64;
            assert_eq!(coefs_of(&filter), design_coefs(ty, last, RATE), "{ty:?} {moved}");
            assert_eq!(play(ty, moved, None).1, shared, "{ty:?} {moved}");
        }
    }

    // a cell the design is not smooth across (of Peak 24 at Res 0 up there: the second pole of its prototype turns
    // where it meets the root of the delay): a cutoff that moves in it takes designs of its own
    #[test]
    fn a_cell_the_design_is_not_smooth_across_takes_designs() {
        let ty = ModelType::Peak24;
        let design = |cutoff: f64| design_coefs(ty, [cutoff, 0.0, 0.0], RATE);
        let mut f = 4096.0;
        let rough = loop {
            let cell = filter_model::cutoff_cell(f, RATE).expect("a cell that is not smooth");
            let middle = design(0.5 * (cell.edges[0] + cell.edges[1]));
            if !design(cell.edges[0])
                .between(&design(cell.edges[1]), 0.5)
                .near(&middle)
            {
                break cell;
            }
            f = cell.edges[1];
        };
        let n = 128;
        let width = (rough.edges[1] - rough.edges[0]) as f32;
        let cutoff: Vec<f32> = (0..n)
            .map(|i| rough.edges[0] as f32 + width * (0.2 + 0.004 * i as f32))
            .collect();
        let mut filter = model_of(ty, 700.0, 0.0, 0.0, 0.0);
        let (mut left, mut right) = (noise(n, 5), noise(n, 6));
        let designs = Designs::default();
        let knobs = [Some(cutoff.as_slice()), None, None, None, None];
        run(
            &mut filter.pass(0, n, knobs).shared(&designs),
            &mut left,
            &mut right,
        );
        assert_eq!(coefs_of(&filter), design(cutoff[n - SEGMENT] as f64));
        // (the first span, the three of the cell, then one a span)
        assert_eq!(designs.worked_out(), 1 + 3 + 3);
    }

    // Without resonance, a cutoff swept down from the top as ENV 2 of a preset does (16.8 kHz to 8 kHz in 90 ms):
    // the poles of the prototype are real there and move with the cutoff, so the cells are smooth and the sweep
    // takes the designs of its cells: 38 for its 136 spans (a pole that went from one root to another left the cells
    // from 0.22 to 0.31 fs rough: a design a span there, 70 in all, and a click at each)
    #[test]
    fn a_sweep_without_resonance_through_the_top_takes_the_designs_of_its_cells() {
        let (n, blocks) = (128, 34);
        for ty in [
            ModelType::Low12,
            ModelType::Low24,
            ModelType::High18,
            ModelType::Notch12,
        ] {
            let mut filter = model_of(ty, 16800.0, 0.0, 0.0, 0.0);
            let designs = Designs::default();
            for block in 0..blocks {
                let cutoff: Vec<f32> = (0..n)
                    .map(|i| {
                        let t = (block * n + i) as f64 / RATE;
                        (284.0 * jsmath::pow(2.0, 5.886 * (1.0 - t / 0.5))) as f32
                    })
                    .collect();
                let (mut left, mut right) = (noise(n, 5 + block as u32), noise(n, 77 + block as u32));
                let knobs = [Some(cutoff.as_slice()), None, None, None, None];
                run(
                    &mut filter.pass(0, n, knobs).shared(&designs),
                    &mut left,
                    &mut right,
                );
            }
            let spans = blocks * n / SEGMENT;
            assert!(
                designs.worked_out() * 3 < spans,
                "{ty:?}: {}",
                designs.worked_out()
            );
        }
    }

    // Res 100 %: the resonance as narrow as the floor of the damping, no cell is smooth (a ladder's from 40 Hz up to
    // some 150 Hz). A sweep of a cell a span works out a design a span, the designs of a cell every half octave (not
    // those of each cell besides)
    #[test]
    fn a_sweep_next_to_a_narrow_cell_takes_designs_alone() {
        for ty in [ModelType::Low24, ModelType::Ladder24, ModelType::Band12] {
            let (n, blocks) = (128, 8);
            let spans = blocks * n / SEGMENT;
            let mut filter = model_of(ty, 40.0, 100.0, 0.0, 0.0);
            let designs = Designs::default();
            for block in 0..blocks {
                // a 16th of an octave (a cell) every SEGMENT samples
                let cutoff: Vec<f32> = (0..n)
                    .map(|i| {
                        let at = (block * n + i) as f64;
                        (40.0 * pow(2.0, at / (16.0 * SEGMENT as f64))) as f32
                    })
                    .collect();
                let (mut left, mut right) = (noise(n, 5), noise(n, 6));
                let knobs = [Some(cutoff.as_slice()), None, None, None, None];
                run(
                    &mut filter.pass(0, n, knobs).shared(&designs),
                    &mut left,
                    &mut right,
                );
                let design = design_coefs(ty, [cutoff[n - SEGMENT] as f64, 100.0, 0.0], RATE);
                assert_eq!(coefs_of(&filter), design);
            }
            assert!(filter.model.narrow.is_some(), "{ty:?}");
            // (a design a span, the three of a cell every NARROW_CELLS + 1 spans: not three a span)
            let most = spans + 3 * spans.div_ceil(NARROW_CELLS as usize + 1);
            assert!(
                designs.worked_out() <= most,
                "{ty:?}: {} of {most}",
                designs.worked_out()
            );
        }
    }

    // a group of 4 samples (the channels of two voices turned into the lanes of each sample and back, the refresh at
    // the first): the bits of its samples one by one, their state too
    #[test]
    fn a_group_is_its_samples_one_by_one() {
        let bits = |state: &LaneState| -> Vec<u32> {
            let lanes: [&[F32x4]; 5] = [
                &[state.drive],
                &state.svf[0],
                &state.svf[1],
                &state.sat[0],
                &state.sat[1],
            ];
            lanes
                .concat()
                .into_iter()
                .chain([state.pole, state.droop])
                .flat_map(|lane| lane.lanes().map(f32::to_bits))
                .collect()
        };
        let rows: [Vec<f32>; 4] = core::array::from_fn(|k| noise(64, 3 + k as u32));
        for ty in dsp_core::filter_model::MODEL_TYPES {
            for (drive, fat) in [(0.0, 0.0), (0.6, 0.6)] {
                let p = Coefs::of(&filter_model::model_design(ty, 1200.0, 0.85, fat, RATE), drive);
                let q = Coefs::of(&filter_model::model_design(ty, 5000.0, 0.6, fat, RATE), drive);
                let layout = Layout {
                    drive: drive > 0.0,
                    fat: fat > 0.0,
                    ..ty.layout()
                };
                // (still, then along a line: the first voice to the coefficients of the second one)
                let mut step = LaneCoefs::default();
                let all = |on: bool| U32x4::splat(if on { u32::MAX } else { 0 });
                LaneCoefs::of(&p, &q).steer(
                    &mut step,
                    &LaneCoefs::of(&q, &q),
                    layout,
                    F32x4::splat(1.0 / 16.0),
                    halves_of([true, false]),
                    all(true),
                );
                for d in [None, Some(&step)] {
                    let (mut c, mut one) = (LaneCoefs::of(&p, &q), LaneCoefs::of(&p, &q));
                    let (mut grouped, mut one_by_one) = (LaneState::default(), LaneState::default());
                    for i in (0..64).step_by(REFRESH) {
                        let at = |k: usize| F32x4::load(&rows[k][i..i + REFRESH]);
                        let out = group(layout, &mut c, d, &mut grouped, [at(0), at(1), at(2), at(3)]);
                        let out = out.map(F32x4::lanes);
                        for j in 0..REFRESH {
                            let x =
                                F32x4::new(rows[0][i + j], rows[1][i + j], rows[2][i + j], rows[3][i + j]);
                            let y = sample(layout, &mut one, d, &mut one_by_one, x, j == 0).lanes();
                            for lane in 0..4 {
                                assert_eq!(out[lane][j].to_bits(), y[lane].to_bits(), "{ty:?} at {}", i + j);
                            }
                        }
                    }
                    assert_eq!(bits(&grouped), bits(&one_by_one), "{ty:?}");
                }
            }
        }
    }

    #[test]
    fn two_voices_of_model_types_in_the_lanes_are_each_alone() {
        let pairs = [
            (ModelType::Ladder12, ModelType::Ladder24),
            (ModelType::Low12, ModelType::Band12),
            (ModelType::Low18, ModelType::High18),
            (ModelType::Low6, ModelType::HighEq6),
            // (layouts that differ: each alone)
            (ModelType::Low12, ModelType::Low24),
        ];
        for (a, b) in pairs {
            for ranges in [
                [(0, 200), (0, 200)],
                [(37, 200), (0, 150)],
                [(0, 3), (5, 199)],
                [(60, 60), (10, 200)],
            ] {
                for moving in [false, true] {
                    alone_and_paired(
                        || {
                            [
                                model_of(a, 700.0, 60.0, 30.0, 40.0),
                                model_of(b, 2000.0, 20.0, 0.0, 70.0),
                            ]
                        },
                        ranges,
                        moving,
                    );
                }
            }
        }
        // a type of a BiquadFilterNode next to a model one: each alone
        alone_and_paired(
            || {
                [
                    filter_of(FilterType::Lowpass, 700.0, 12.0, 0.0),
                    model_of(ModelType::Low12, 900.0, 50.0, 0.0, 0.0),
                ]
            },
            [(0, 200), (0, 200)],
            true,
        );
    }

    // a resonance at 100 Hz (Res 80 %): silence within 12 s, its state flushed under TINY on the way
    #[test]
    fn the_tail_of_a_model_type_ends_in_zeros() {
        for ty in dsp_core::filter_model::MODEL_TYPES {
            let mut filter = model_of(ty, 100.0, 80.0, 0.0, 50.0);
            let mut left = noise(128, 3);
            let mut right = left.clone();
            run(&mut filter.pass(0, 128, [None; KNOBS]), &mut left, &mut right);
            let mut last = [1.0f32; 2];
            for _ in 0..12 {
                for _ in 0..(RATE / 128.0) as usize {
                    let (mut left, mut right) = ([0.0f32; 128], [0.0f32; 128]);
                    run(&mut filter.pass(0, 128, [None; KNOBS]), &mut left, &mut right);
                    let state = filter.model.state;
                    for channel in state {
                        let values = channel
                            .svf
                            .iter()
                            .flatten()
                            .chain([&channel.pole, &channel.droop]);
                        for x in values {
                            assert!(*x == 0.0 || x.abs() >= dsp_core::simd::TINY, "{ty:?}: under TINY");
                        }
                    }
                    last = [left[127], right[127]];
                }
            }
            assert_eq!(last, [0.0; 2], "{ty:?}");
        }
    }

    #[test]
    fn its_knobs_moving_fast_keep_it_bounded() {
        // a cutoff and a resonance that jump every span, a loud input: the output stays within what the
        // resonance and the drive can make of it
        for ty in dsp_core::filter_model::MODEL_TYPES {
            let n = 4096;
            let mut filter = model_of(ty, 1000.0, 100.0, 100.0, 100.0);
            let cutoff: Vec<f32> = (0..n)
                .map(|i| if (i / 32) % 2 == 0 { 30.0 } else { 18000.0 })
                .collect();
            let resonance: Vec<f32> = (0..n)
                .map(|i| if (i / 64) % 2 == 0 { 0.0 } else { 100.0 })
                .collect();
            let mut left: Vec<f32> = noise(n, 9).iter().map(|x| x * 4.0).collect();
            let mut right = left.clone();
            run(
                &mut filter.pass(0, n, [Some(&cutoff), Some(&resonance), None, None, None]),
                &mut left,
                &mut right,
            );
            let peak = left
                .iter()
                .chain(right.iter())
                .fold(0.0f32, |m, x| m.max(x.abs()));
            assert!(peak.is_finite() && peak < 1e4, "{ty:?}: {peak}");
        }
    }

    #[test]
    fn a_change_of_type_on_a_playing_note_crossfades() {
        let sine = |i: usize| sin(2.0 * PI * 220.0 * i as f64 / RATE) as f32 * 0.5;
        let changes = [
            (
                Kind::Web(Some(FilterType::Lowpass)),
                Kind::Model(ModelType::Ladder24),
            ),
            (Kind::Model(ModelType::Ladder12), Kind::Model(ModelType::High12)),
            (
                Kind::Model(ModelType::Low24),
                Kind::Web(Some(FilterType::Highpass)),
            ),
        ];
        for (from, to) in changes {
            let options = |kind| FilterOptions {
                kind,
                cutoff: 2000.0,
                resonance: if matches!(kind, Kind::Model(_)) { 30.0 } else { 3.0 },
                gain: 0.0,
                drive: 0.0,
                variation: 0.0,
            };
            let mut filter = VoiceFilter::new(RATE, Some(options(from)));
            let mut out = Vec::new();
            for block in 0..20 {
                if block == 8 {
                    filter.set(Some(options(to)));
                    assert!(filter.alone());
                }
                let mut left: Vec<f32> = (0..128).map(|i| sine(block * 128 + i)).collect();
                let mut right = left.clone();
                run(&mut filter.pass(0, 128, [None; KNOBS]), &mut left, &mut right);
                out.extend(left);
            }
            assert!(!filter.alone());
            // no step: a sample at most what a 220 Hz sine of the level moves by, and a bit
            let jump = out.windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0f32, f32::max);
            assert!(jump < 0.05, "{from:?} -> {to:?}: {jump}");
        }
    }

    // a change of type before the filter ran (a note that starts later): nothing fades out, the new type plays from
    // its first sample as on a note of its own
    #[test]
    fn a_change_of_type_before_the_filter_played_does_not_fade() {
        let input = noise(128, 5);
        let options = |kind| FilterOptions {
            kind,
            cutoff: 2000.0,
            resonance: if matches!(kind, Kind::Model(_)) { 60.0 } else { 3.0 },
            gain: 0.0,
            drive: 0.0,
            variation: 0.0,
        };
        let (lowpass, ladder) = (
            Kind::Web(Some(FilterType::Lowpass)),
            Kind::Model(ModelType::Ladder24),
        );
        let play = |filter: &mut VoiceFilter| {
            let (mut left, mut right) = (input.clone(), input.clone());
            filter.glide(128, None);
            run(&mut filter.pass(0, 128, [None; KNOBS]), &mut left, &mut right);
            left
        };
        for (from, to) in [(lowpass, ladder), (ladder, lowpass)] {
            let mut changed = VoiceFilter::new(RATE, Some(options(from)));
            changed.set(Some(options(to)));
            assert!(!changed.alone(), "{from:?} -> {to:?}");
            let mut fresh = VoiceFilter::new(RATE, Some(options(to)));
            assert_eq!(play(&mut changed), play(&mut fresh), "{from:?} -> {to:?}");
        }
    }

    // a change of type within the fade of the change before waits for its end: the filter that fades out is not cut,
    // nor does the one that fades in take the knobs of the next type
    #[test]
    fn a_change_of_type_while_it_fades_waits_for_the_end_of_the_fade() {
        let sine = |i: usize| sin(2.0 * PI * 220.0 * i as f64 / RATE) as f32 * 0.5;
        let options = |kind| FilterOptions {
            kind,
            cutoff: 2000.0,
            resonance: if matches!(kind, Kind::Model(_)) { 90.0 } else { 3.0 },
            gain: 0.0,
            drive: 0.0,
            variation: 0.0,
        };
        let (ladder, lowpass, low18) = (
            Kind::Model(ModelType::Ladder24),
            Kind::Web(Some(FilterType::Lowpass)),
            Kind::Model(ModelType::Low18),
        );
        let play = |changes: &[(usize, Kind)]| {
            let mut filter = VoiceFilter::new(RATE, Some(options(ladder)));
            let mut out = Vec::new();
            for block in 0..24 {
                for &(at, kind) in changes {
                    if at == block {
                        filter.set(Some(options(kind)));
                    }
                }
                if block == 9 {
                    // (the fade of the first change goes on: the second waits)
                    assert!(filter.alone());
                }
                // (as a voice does: the change that waited, then the knobs)
                filter.switch_type();
                filter.glide(128, None);
                let mut left: Vec<f32> = (0..128).map(|i| sine(block * 128 + i)).collect();
                let mut right = left.clone();
                run(&mut filter.pass(0, 128, [None; KNOBS]), &mut left, &mut right);
                out.extend(left);
            }
            (filter, out)
        };
        let (_, once) = play(&[(8, lowpass)]);
        let (twice, out) = play(&[(8, lowpass), (9, low18)]);
        // (the fade of 480 samples from block 8 ends in block 11: the second starts at block 12)
        let end = 12 * 128;
        assert_eq!(out[..end], once[..end]);
        assert_ne!(out[end..], once[end..]);
        assert_eq!(twice.kind, low18);
        assert!(!twice.alone());
        let jump = out.windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0f32, f32::max);
        assert!(jump < 0.05, "{jump}");
        // back to the type it fades into while the next one waits: no change waits any more
        let (back, out) = play(&[(8, lowpass), (9, low18), (10, lowpass)]);
        assert_eq!(out, once);
        assert_eq!(back.kind, lowpass);
    }

    // a note that starts between two refreshes of its saturating sections: their steps from its first sample are those
    // of the small signal (as those of a refresh on a silent filter), not none
    #[test]
    fn a_note_that_starts_within_a_block_has_the_steps_of_its_sections() {
        for ty in [ModelType::Low24, ModelType::Ladder24, ModelType::High12] {
            let input: Vec<f32> = noise(128, 9).iter().map(|x| x * 1e-3).collect();
            let play = |a: usize| {
                let mut filter = model_of(ty, 1000.0, 60.0, 0.0, 0.0);
                let (mut left, mut right) = (input.clone(), input.clone());
                left[..37].fill(0.0);
                right[..37].fill(0.0);
                let mut pass = filter.pass(a, 128, [None; KNOBS]);
                assert!(pass.layout.is_some_and(|layout| layout.sat));
                run(&mut pass, &mut left, &mut right);
                left
            };
            // from 36 (a refresh) with a silent sample first, and from 37
            let (from_refresh, within) = (play(36), play(37));
            let peak = from_refresh.iter().fold(0.0f32, |most, y| most.max(y.abs()));
            for i in 37..128 {
                assert!(
                    (within[i] - from_refresh[i]).abs() <= 1e-4 * peak,
                    "{ty:?} at {i}: {} against {}",
                    within[i],
                    from_refresh[i]
                );
            }
        }
    }

    // the filter before a change of type fades out through its sections as they played: the plain ones of a
    // resonance that didn't saturate (under Res 40 %, no Drive, no FAT), the saturating ones else
    #[test]
    fn a_filter_that_fades_out_runs_its_sections_as_they_played() {
        let saw = |i: usize| ((i as f64 * 110.0 / RATE) % 1.0 * 2.0 - 1.0) as f32;
        let block = |filter: &mut VoiceFilter, from: usize| {
            let mut left: Vec<f32> = (0..128).map(|i| saw(from + i)).collect();
            let mut right = left.clone();
            run(&mut filter.pass(0, 128, [None; KNOBS]), &mut left, &mut right);
            left
        };
        for (ty, resonance, drive, variation) in [
            (ModelType::Low24, 35.0, 0.0, 0.0),
            (ModelType::Ladder24, 35.0, 0.0, 0.0),
            (ModelType::Low24, 70.0, 0.0, 0.0),
            (ModelType::Ladder12, 20.0, 30.0, 0.0),
            (ModelType::Low12, 20.0, 0.0, 60.0),
        ] {
            let mut filter = model_of(ty, 400.0, resonance, drive, variation);
            for b in 0..8 {
                block(&mut filter, b * 128);
            }
            let mut still = filter.clone();
            filter.set(Some(FilterOptions {
                kind: Kind::Web(Some(FilterType::Lowpass)),
                cutoff: 400.0,
                resonance: 3.0,
                gain: 0.0,
                drive: 0.0,
                variation: 0.0,
            }));
            let mut fade = filter.fade.expect("a fade");
            let mut left: Vec<f32> = (0..128).map(|i| saw(1024 + i)).collect();
            let mut right = left.clone();
            run_frozen(&mut fade, 0, 128, &mut left, &mut right);
            let played = block(&mut still, 1024);
            let peak = played.iter().fold(0.0f32, |most, y| most.max(y.abs()));
            for i in 0..128 {
                assert!(
                    (left[i] - played[i]).abs() <= 1e-5 * peak,
                    "{ty:?} Res {resonance} at {i}: {} against {}",
                    left[i],
                    played[i]
                );
            }
        }
    }

    #[test]
    fn a_change_of_type_before_a_model_type_played_fades_out_nothing() {
        // (the type before has no coefficients yet: its saturating section would divide 0 by 0)
        let saw = |i: usize| ((i as f64 * 220.0 / RATE) % 1.0 * 2.0 - 1.0) as f32;
        for from in [ModelType::Notch24, ModelType::Low12, ModelType::Ladder24] {
            let options = |kind| FilterOptions {
                kind,
                cutoff: 1259.0,
                resonance: 83.0,
                gain: 0.0,
                drive: 56.0,
                variation: 50.0,
            };
            let mut filter = VoiceFilter::new(RATE, Some(options(Kind::Model(from))));
            filter.set(Some(options(Kind::Web(Some(FilterType::Allpass)))));
            assert!(!filter.alone());
            for block in 0..8 {
                let mut left: Vec<f32> = (0..128).map(|i| saw(block * 128 + i)).collect();
                let mut right = left.clone();
                run(&mut filter.pass(0, 128, [None; KNOBS]), &mut left, &mut right);
                assert!(left.iter().all(|v| v.is_finite()), "{from:?}");
            }
        }
    }

    #[test]
    fn the_saturation_runs_from_res_40_and_comes_in_with_no_step() {
        // Low 12 at its cutoff, Res from 30 % to 60 % and back: the saturation runs from 40 %, a pass of it starts
        // from the steps of the plain one before (no sample without them)
        let sine = |i: usize| sin(2.0 * PI * 1000.0 * i as f64 / RATE) as f32 * 0.5;
        let options = |resonance| FilterOptions {
            kind: Kind::Model(ModelType::Low12),
            cutoff: 1000.0,
            resonance,
            gain: 0.0,
            drive: 0.0,
            variation: 0.0,
        };
        let mut filter = VoiceFilter::new(RATE, Some(options(30.0)));
        let (mut out, mut runs) = (Vec::new(), Vec::new());
        for block in 0..90 {
            if block == 30 {
                filter.set(Some(options(60.0)));
            }
            if block == 60 {
                filter.set(Some(options(30.0)));
            }
            // (a block not of 4: a pass that starts between the samples the steps are worked out at)
            let n = if block == 29 || block == 59 { 126 } else { 128 };
            let mut left: Vec<f32> = (0..n).map(|i| sine(block * 128 + i)).collect();
            let mut right = left.clone();
            filter.glide(n, None);
            let mut pass = filter.pass(0, n, [None; KNOBS]);
            runs.push(pass.layout.unwrap().sat);
            run(&mut pass, &mut left, &mut right);
            out.extend(left);
        }
        assert!(!runs[10] && runs[45] && !runs[85], "{runs:?}");
        // the glide of Res moves the level smoothly: no step past what a 1 kHz sine moves by in a sample
        let jump = out.windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0f32, f32::max);
        let peak = out.iter().fold(0.0f32, |m, v| m.max(v.abs()));
        assert!(jump < peak * 0.2, "{jump} of {peak}");
    }

    #[test]
    fn drive_on_and_off_on_a_playing_note_makes_no_step() {
        let sine = |i: usize| sin(2.0 * PI * 330.0 * i as f64 / RATE) as f32 * 0.6;
        let options = |drive| FilterOptions {
            kind: Kind::Model(ModelType::Low12),
            cutoff: 3000.0,
            resonance: 20.0,
            gain: 0.0,
            drive,
            variation: 0.0,
        };
        let mut filter = VoiceFilter::new(RATE, Some(options(0.0)));
        let mut out = Vec::new();
        for block in 0..60 {
            if block == 10 {
                filter.set(Some(options(30.0)));
            }
            if block == 30 {
                filter.set(Some(options(0.0)));
            }
            filter.glide(128, None);
            let mut left: Vec<f32> = (0..128).map(|i| sine(block * 128 + i)).collect();
            let mut right = left.clone();
            let moved: [Option<&[f32]>; KNOBS] = [None; KNOBS];
            run(&mut filter.pass(0, 128, moved), &mut left, &mut right);
            out.extend(left);
        }
        // the steps of a sine of 330 Hz at the levels Drive gives it, no more
        let jump = out.windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0f32, f32::max);
        let peak = out.iter().fold(0.0f32, |m, x| m.max(x.abs()));
        assert!(jump < peak * 0.06, "{jump} of {peak}");
    }

    // the energy of a signal in a band of frequencies (shares of the sample rate), under a Hann window
    fn band_energy(data: &[f64], lo: f64, hi: f64) -> f64 {
        let n = data.len();
        let window = |i: usize| 0.5 - 0.5 * cos(2.0 * PI * i as f64 / n as f64);
        (0..=n / 2)
            .filter(|&k| (lo..hi).contains(&(k as f64 / n as f64)))
            .map(|k| {
                let (mut re, mut im) = (0.0, 0.0);
                for (i, x) in data.iter().enumerate() {
                    let phase = 2.0 * PI * (k * i) as f64 / n as f64;
                    re += x * window(i) * cos(phase);
                    im -= x * window(i) * sin(phase);
                }
                re * re + im * im
            })
            .sum()
    }

    // A pluck: an envelope with its attack curved (its steep end 2.3 times its mean slope) moves the cutoff up 6.15
    // octaves from 17.7 Hz in 77 samples, read at the points (over 2 octaves in the spans of its end), a Low 12 with
    // Drive (its section saturates), a Low 24 and a ladder with Drive and FAT, noise in. Its spans in pieces, stepping
    // every sample, are near what a design at every sample renders along the same way (each span from the knobs of the
    // one before to its own: the filter a span behind its knobs), around fs/4 and fs/2 as quiet; the coefficients of a
    // span at once (a stair of its spans: the crackle at the top of the sweep) and lines a step a refresh (a stair of 4
    // samples: images around fs/4 and fs/2) are far from it
    #[test]
    fn a_fast_sweep_goes_as_designs_at_every_sample() {
        let n = 128;
        let blocks = 2;
        let cutoff = |i: usize| {
            let x = min(i as f64 / 77.0, 1.0);
            (17.7 * pow(2.0, 6.15 * (exp(2.0 * x) - 1.0) / (exp(2.0) - 1.0))) as f32
        };
        let cutoffs: Vec<f32> = (0..blocks * n).map(cutoff).collect();
        let input: Vec<f32> = noise(blocks * n, 3).iter().map(|x| 2.0 * x).collect();
        for (ty, resonance, drive, variation) in [
            (ModelType::Low12, 20.0, 42.0, 0.0),
            (ModelType::Low24, 30.0, 0.0, 0.0),
            (ModelType::Ladder24, 60.0, 40.0, 50.0),
        ] {
            let layout = gated(ty, drive > 0.0, variation > 0.0, resonance >= RESONANT as f64);
            let coefs_of = |f: f64| {
                let mut coefs = design_coefs(ty, [f, resonance, variation], RATE);
                coefs.fat = ty.fat_of(resonance / 100.0, variation / 100.0) as f32;
                coefs.drive = filter_model::drive_gain(drive / 100.0) as f32;
                coefs
            };
            // (the knobs of the span of a sample: those read at the start of the span before and of its own)
            let span = |i: usize| {
                let s = i / SEGMENT * SEGMENT;
                let to = cutoffs[s] as f64;
                (s, if s == 0 { to } else { cutoffs[s - SEGMENT] as f64 }, to)
            };
            let render = |coefs: &dyn Fn(usize) -> Coefs, refresh: &dyn Fn(usize) -> bool| {
                let mut state = LaneState::default();
                let mut c = LaneCoefs::of(&coefs(0), &coefs(0));
                filter_model::keep_steps(&c, &mut state);
                (0..blocks * n)
                    .map(|i| {
                        if refresh(i) {
                            let at = coefs(i);
                            c = LaneCoefs::of(&at, &at);
                        }
                        let x = F32x4::splat(input[i]);
                        filter_model::tick(layout, &c, &mut state, x, refresh(i)).lanes()[0] as f64
                    })
                    .collect::<Vec<f64>>()
            };
            let every = |_: usize| true;
            let refreshes = |i: usize| i.is_multiple_of(REFRESH);
            let ideal = render(
                &|i| {
                    let (s, from, to) = span(i);
                    coefs_of(from * pow(to / from, (i - s + 1) as f64 / SEGMENT as f64))
                },
                &every,
            );
            let stairs = render(&|i| coefs_of(span(i).2), &refreshes);
            let lines = render(
                &|i| {
                    let (s, from, to) = span(i);
                    let steps = (i - s) / REFRESH + 1;
                    coefs_of(from).between(&coefs_of(to), (steps * REFRESH) as f32 / SEGMENT as f32)
                },
                &refreshes,
            );
            let mut filter = model_of(ty, cutoff(0) as f64, resonance, drive, variation);
            let mut ours = Vec::new();
            for block in 0..blocks {
                let mut left = input[block * n..(block + 1) * n].to_vec();
                let mut right = left.clone();
                let knobs = &cutoffs[block * n..(block + 1) * n];
                run(
                    &mut filter.pass(0, n, [Some(knobs), None, None, None, None]),
                    &mut left,
                    &mut right,
                );
                assert_eq!(left, right);
                ours.extend(left.iter().map(|x| *x as f64));
            }
            // (the sweep and the top: from the first line on)
            let window = SEGMENT..SEGMENT + 128;
            let apart = |x: &[f64]| -> Vec<f64> { window.clone().map(|i| x[i] - ideal[i]).collect() };
            let level = |x: &[f64]| x.iter().map(|x| x * x).sum::<f64>();
            let of_ideal = level(&ideal[window.clone()]);
            let db = |x: f64| 10.0 * log10(x);
            let off = |x: &[f64]| db(level(&apart(x)) / of_ideal);
            let around = |x: &[f64], lo: f64, hi: f64| db(band_energy(&apart(x), lo, hi) / of_ideal);
            let quarter = |x: &[f64]| around(x, 0.2, 0.3);
            let half = |x: &[f64]| around(x, 0.42, 0.5);
            // (dB under the sweep: ours -33 to -35, the stairs of the spans 5 over to 1 under, the lines of the
            // refreshes -9 to -14; around fs/4 and fs/2 the lines 20 to 31 dB over ours)
            let at = format!("{ty:?}");
            assert!(off(&ours) < -30.0, "{at}: {}", off(&ours));
            assert!(off(&stairs) > off(&ours) + 25.0, "{at}: {}", off(&stairs));
            assert!(off(&lines) > off(&ours) + 18.0, "{at}: {}", off(&lines));
            for (band, of) in [("fs/4", &quarter as &dyn Fn(&[f64]) -> f64), ("fs/2", &half)] {
                let (ours, lines) = (of(&ours), of(&lines));
                assert!(ours < lines - 15.0, "{at} {band}: {ours} {lines}");
            }
        }
    }
}
