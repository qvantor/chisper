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
use core::cell::Cell;
use dsp_core::biquad::FilterType;
use dsp_core::filter_model::{self, Cell as GridCell, Coefs, LaneCoefs, LaneState, Layout, ModelType};
use dsp_core::simd::{F32x4, U32x4};
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
pub(crate) const SEGMENT: usize = 32;
const SMOOTHING: f64 = 0.0033;
const BLOCK: usize = 128;
/// seconds: the crossfade of a change of type into or out of a model type
pub const FADE: f64 = 0.01;
// the samples of a block (0, 4, 8…) where the saturating sections of a model type work out their steps again (the
// same of every voice: a voice plays the same bits in the lanes of another or alone)
const REFRESH: usize = 4;
// Res (%) from which the resonance of a model type saturates in a pass without Drive and FAT
const RESONANT: f32 = 40.0;

// a model type: its coefficients, the knobs they were worked out with (cutoff, resonance, variation, drive), the
// state of its channels (of each lane of a voice); the cell of its cutoff as it moved last (None: it was still, or
// off the grid), whether it has the designs of that cell (`held`), those designs; `fresh`: reset, its saturating
// sections have no steps yet (its first span gives them those of the small signal: a note that starts between two
// refreshes); `narrow`: the type, knobs and index of a cell it swept that is narrow (Anchors): the cells it sweeps
// within NARROW_CELLS of it take designs; `designed`: the design its coefficients are (None: between the designs of
// a cell)
#[derive(Clone, Copy, Default)]
struct ModelSlot {
    coefs: Coefs,
    last: [f64; 4],
    state: [ModelChannel; 2],
    cell: Option<CellKey>,
    held: bool,
    anchors: Anchors,
    fresh: bool,
    narrow: Option<(ModelType, [f64; 2], u32)>,
    designed: Option<DesignKey>,
}

#[derive(Clone, Copy, Default)]
struct ModelChannel {
    drive: f32,
    svf: [[f32; 2]; 2],
    pole: f32,
    droop: f32,
    sat: [[f32; 3]; 2],
}

impl ModelSlot {
    fn reset(&mut self) {
        self.state = Default::default();
        self.last = [f64::NAN; 4];
        self.cell = None;
        self.held = false;
        self.fresh = true;
        self.narrow = None;
        self.designed = None;
    }
}

// a cell of the grid of the cutoff of a type at a resonance and a variation (those it is designed by: design_knobs)
type CellKey = (ModelType, u32, [f64; 2]);

// The designs of a cell: at its two edges, and whether the design is smooth across it (the coefficients between
// the edges at its middle are those of the design there: Coefs::near). A cutoff in a smooth cell takes the
// coefficients between its edges, in another a design of its own. `narrow`: its resonance is so narrow (NARROW) that
// the cells next to it are not smooth either
#[derive(Clone, Copy, Default)]
struct Anchors {
    edges: [Coefs; 2],
    smooth: bool,
    narrow: bool,
}

// the narrowness (Coefs::narrowness) of a cell from which those next to it are not smooth either (the error of the
// middle of a cell changes by 4 times at most across an octave), the cells on each side taken as narrow without their
// designs (half an octave: the damping of a ladder changes with its cutoff, its cells high up at Res 100 % are smooth)
const NARROW: f64 = 4.0;
const NARROW_CELLS: u32 = 8;

// the designs of a cell: an edge from `kept`, the cell next to it there (by its index), where it is kept, else
// worked out, as the middle is
fn anchors_of(
    ty: ModelType,
    cell: &GridCell,
    [q, v]: [f64; 2],
    sample_rate: f64,
    kept: impl Fn(u32) -> Option<Anchors>,
    designed: impl Fn(),
) -> Anchors {
    let design = |f: f64| {
        designed();
        design_coefs(ty, [f, q, v], sample_rate)
    };
    let below = cell.index.checked_sub(1).and_then(&kept);
    let low = below.map_or_else(|| design(cell.edges[0]), |next| next.edges[1]);
    let high = kept(cell.index + 1).map_or_else(|| design(cell.edges[1]), |next| next.edges[0]);
    let middle = design(0.5 * (cell.edges[0] + cell.edges[1]));
    let between = low.between(&high, 0.5);
    Anchors {
        smooth: between.near(&middle),
        narrow: between.narrowness(&middle) > NARROW,
        edges: [low, high],
    }
}

// the designs a node keeps: the spans of a block of 128 while a knob moves
const DESIGNS: usize = 4;
// a design: its type, its cutoff, resonance and variation (`design_knobs`)
type DesignKey = (ModelType, [f64; 3]);

// the resonance and the variation (%) a type is designed with: 0 for a knob its design doesn't depend on (its FAT
// is set after it: ModelType::fat_of), so its values share designs
fn design_knobs(ty: ModelType, [q, v]: [f64; 2]) -> [f64; 2] {
    let [by_res, by_var] = ty.designed_by();
    [if by_res { q } else { 0.0 }, if by_var { v } else { 0.0 }]
}

// the cells a node keeps, by their index: 8 octaves of the cutoff of one type, resonance and variation
const CELLS: usize = 128;

/// the coefficients of the model types of the last spans of a node, shared by its voices (an LFO, the glide of a
/// knob moves them alike; a voice finishes its block before the next one), and the designs of the cells their
/// cutoffs move in (`Anchors`: the voices of a node sweep the same cells, an LFO comes back to them): a design is
/// a function of its type and knobs, one kept the bits of one worked out again
pub struct Designs {
    keys: [Cell<Option<DesignKey>>; DESIGNS],
    coefs: [Cell<Coefs>; DESIGNS],
    next: Cell<usize>,
    cells: Vec<(Cell<Option<CellKey>>, Cell<Anchors>)>,
    #[cfg(test)]
    worked_out: Cell<usize>,
}

impl Default for Designs {
    fn default() -> Designs {
        Designs {
            keys: Default::default(),
            coefs: Default::default(),
            next: Cell::new(0),
            cells: (0..CELLS).map(|_| Default::default()).collect(),
            #[cfg(test)]
            worked_out: Cell::new(0),
        }
    }
}

impl Designs {
    // into `out`, straight from the one kept (a span of a voice copies its coefficients once)
    fn coefs_into(&self, out: &mut Coefs, ty: ModelType, knobs: [f64; 3], sample_rate: f64) {
        let key = Some((ty, knobs));
        for (kept, coefs) in self.keys.iter().zip(&self.coefs) {
            if kept.get() == key {
                *out = coefs.get();
                return;
            }
        }
        *out = design_coefs(ty, knobs, sample_rate);
        #[cfg(test)]
        self.worked_out.set(self.worked_out.get() + 1);
        let i = self.next.get();
        self.coefs[i].set(*out);
        self.keys[i].set(key);
        self.next.set((i + 1) % DESIGNS);
    }

    // the designs of a cell into `out`: those kept, else worked out (an edge the cell next to it has: taken from
    // it). A cell is kept at its index moved by its type and knobs: voices of other knobs (a velocity on the
    // resonance) sweep the same cells, each mostly its own places
    fn anchors_into(
        &self,
        out: &mut Anchors,
        ty: ModelType,
        cell: &GridCell,
        knobs: [f64; 2],
        sample_rate: f64,
    ) {
        let spread = (knobs[0].to_bits() >> 40) ^ (knobs[1].to_bits() >> 36) ^ ((ty as u64) << 5);
        let place = |index: u32| (index as usize).wrapping_add(spread as usize) % CELLS;
        let kept = |index: u32| {
            let (key, anchors) = &self.cells[place(index)];
            (key.get() == Some((ty, index, knobs))).then(|| anchors.get())
        };
        let (key, slot) = &self.cells[place(cell.index)];
        if key.get() == Some((ty, cell.index, knobs)) {
            *out = slot.get();
            return;
        }
        *out = anchors_of(ty, cell, knobs, sample_rate, kept, || {
            #[cfg(test)]
            self.worked_out.set(self.worked_out.get() + 1);
        });
        slot.set(*out);
        key.set(Some((ty, cell.index, knobs)));
    }
}

// the coefficients of a model type at its cutoff (Hz), resonance and variation (%), Drive 0
fn design_coefs(ty: ModelType, [f, q, v]: [f64; 3], sample_rate: f64) -> Coefs {
    Coefs::of(
        &filter_model::model_design(ty, f, q / 100.0, v / 100.0, sample_rate),
        0.0,
    )
}

// the lanes of two voices (p in 0 and 1, q in 2 and 3) from their channels, and back
fn lanes_of(p: &[ModelChannel; 2], q: &[ModelChannel; 2]) -> LaneState {
    let lanes = |f: fn(&ModelChannel) -> f32| F32x4::new(f(&p[0]), f(&p[1]), f(&q[0]), f(&q[1]));
    LaneState {
        drive: lanes(|c| c.drive),
        svf: [
            [lanes(|c| c.svf[0][0]), lanes(|c| c.svf[0][1])],
            [lanes(|c| c.svf[1][0]), lanes(|c| c.svf[1][1])],
        ],
        pole: lanes(|c| c.pole),
        droop: lanes(|c| c.droop),
        sat: [
            [
                lanes(|c| c.sat[0][0]),
                lanes(|c| c.sat[0][1]),
                lanes(|c| c.sat[0][2]),
            ],
            [
                lanes(|c| c.sat[1][0]),
                lanes(|c| c.sat[1][1]),
                lanes(|c| c.sat[1][2]),
            ],
        ],
    }
}
fn channels_of(state: &LaneState, half: usize) -> [ModelChannel; 2] {
    let [s00, s01, s10, s11] =
        [state.svf[0][0], state.svf[0][1], state.svf[1][0], state.svf[1][1]].map(F32x4::lanes);
    let (pole, droop) = (state.pole.lanes(), state.droop.lanes());
    let drive = state.drive.lanes();
    let sat = state.sat.map(|steps| steps.map(F32x4::lanes));
    core::array::from_fn(|c| {
        let k = 2 * half + c;
        ModelChannel {
            drive: drive[k],
            svf: [[s00[k], s01[k]], [s10[k], s11[k]]],
            pole: pole[k],
            droop: droop[k],
            sat: sat.map(|steps| steps.map(|lane| lane[k])),
        }
    })
}

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

// the sections of a model type with the curve of Drive (Drive over 0), the gain of FAT (over 0, of a type that has
// it: the variation of an EQ type is the gain of its band, the design's FAT a gain of 1) and the saturation of the
// resonance: the resonance saturates under Res 40 %, without Drive and FAT, by under 0.3 dB at the cutoff (a sine at
// full scale): the plain sections there
fn gated(ty: ModelType, drive: bool, fat: bool, resonant: bool) -> Layout {
    let layout = ty.layout();
    let fat = fat && ty.has_fat();
    let resonant = drive || fat || resonant;
    Layout {
        drive,
        fat,
        sat: layout.sat && resonant,
        sat2: layout.sat2 && resonant,
        ..layout
    }
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
        // the coefficients of the span
        current: [f32; 6],
    },
    // (the coefficients of the span: those of its slot, read in place)
    Model {
        ty: ModelType,
        slot: &'a mut ModelSlot,
    },
}

/// the filter of a voice over the samples a..b of a block: its knobs are read at the start of each span (SEGMENT
/// samples from a while one moves, else the whole a..b), its coefficients worked out when they changed
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
}

impl<'a> Pass<'a> {
    // the slot of a model type (a pass with a layout)
    fn model(&self) -> &ModelSlot {
        match &self.engine {
            Engine::Model { slot, .. } => slot,
            Engine::Web { .. } => unreachable!(),
        }
    }

    // the state and the coefficients of the span of a type of a BiquadFilterNode (a pass without a layout)
    fn web(&self) -> ([f32; 4], [f32; 6]) {
        match &self.engine {
            Engine::Web { state, current, .. } => (**state, *current),
            Engine::Model { .. } => unreachable!(),
        }
    }

    // whether the slot of a model type is fresh, its span begun (step: active), it is not afterwards
    fn take_fresh(&mut self) -> bool {
        match &mut self.engine {
            Engine::Model { slot, .. } if self.active => core::mem::take(&mut slot.fresh),
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

    // the span that starts at s (the end of the one before)
    fn step(&mut self, s: usize) {
        if s < self.a || s >= self.b {
            match &mut self.engine {
                Engine::Web { current, .. } => *current = FROZEN,
                Engine::Model { .. } => {}
            }
            self.active = false;
            self.next = if s < self.a { self.a } else { usize::MAX };
            return;
        }
        let at = |values: &[f32]| (if values.len() > 1 { values[s] } else { values[0] }) as f64;
        let (sample_rate, designs, sweeps) = (self.sample_rate, self.designs, self.sweeps);
        match &mut self.engine {
            Engine::Web {
                ty,
                coefficients,
                k,
                power,
                last,
                current,
                ..
            } => {
                let (f, q, g) = (at(self.knobs[0]), at(self.knobs[1]), at(self.knobs[2]));
                if f != last[0] || q != last[1] || g != last[2] {
                    // (a cutoff that moves alone: the power of the span before)
                    if q != last[1] || g != last[2] {
                        **power = power_of(*ty, q, g);
                    }
                    **k = svf_into(coefficients, *ty, f, q, **power, sample_rate);
                    **last = [f, q, g];
                }
                *current = **coefficients;
            }
            Engine::Model { ty, slot } => {
                let (f, q, d, v) = (
                    at(self.knobs[0]),
                    at(self.knobs[1]),
                    at(self.knobs[3]),
                    at(self.knobs[4]),
                );
                let redesign = f != slot.last[0] || q != slot.last[1] || v != slot.last[2];
                if redesign {
                    // (its designs and cells by the knobs it is designed by: one it is not designed by may move)
                    let knobs = design_knobs(*ty, [q, v]);
                    // a cutoff that moves alone in its design, no further than to the cell next to the one of the
                    // span before: between the designs at the edges of its cell where the design is smooth across
                    // it. Faster (a jump, a sweep of over a cell a span) or a first span: a design of its own, as a
                    // still one has (the choice is of the cutoffs of the voice alone: the bits of the voice in any
                    // node)
                    let cell = if sweeps {
                        filter_model::cutoff_cell(f, sample_rate)
                    } else {
                        None
                    };
                    let key = cell.map(|cell| (*ty, cell.index, knobs));
                    let near = matches!(
                        (slot.cell, key),
                        (Some((_, before, was)), Some((_, index, _)))
                            if was == knobs && before.abs_diff(index) <= 1
                    );
                    let narrow = matches!(
                        (slot.narrow, cell),
                        (Some((was, its, index)), Some(cell))
                            if was == *ty && its == knobs && index.abs_diff(cell.index) <= NARROW_CELLS
                    );
                    if let (true, false, Some(cell)) = (near, narrow, cell) {
                        if !slot.held || slot.cell != key {
                            match designs {
                                Some(designs) => {
                                    designs.anchors_into(&mut slot.anchors, *ty, &cell, knobs, sample_rate)
                                }
                                None => {
                                    // (the designs of the cell before: an edge of this one)
                                    let kept = |index: u32| {
                                        let has = slot.held && slot.cell == Some((*ty, index, knobs));
                                        has.then_some(slot.anchors)
                                    };
                                    slot.anchors = anchors_of(*ty, &cell, knobs, sample_rate, kept, || ());
                                }
                            }
                        }
                        slot.held = true;
                        if slot.anchors.narrow {
                            slot.narrow = Some((*ty, knobs, cell.index));
                        }
                    } else {
                        // (next to a narrow cell: a design, the cell's not worked out)
                        slot.held = false;
                    }
                    slot.cell = key;
                    if slot.held && slot.anchors.smooth {
                        let share = cell.map_or(0.0, |cell| cell.share);
                        let [low, high] = &slot.anchors.edges;
                        slot.coefs.set_between(low, high, share);
                        slot.designed = None;
                    } else {
                        let [q, v] = knobs;
                        let design = (*ty, [f, q, v]);
                        // (the design it has: a knob it is not designed by moved)
                        if slot.designed != Some(design) {
                            match designs {
                                Some(designs) => {
                                    designs.coefs_into(&mut slot.coefs, *ty, [f, q, v], sample_rate)
                                }
                                None => slot.coefs = design_coefs(*ty, [f, q, v], sample_rate),
                            }
                            slot.designed = Some(design);
                        }
                    }
                    // (the FAT of a design: that of the edges of a cell, theirs alike)
                    slot.coefs.fat = ty.fat_of(q / 100.0, v / 100.0) as f32;
                    slot.last[..3].copy_from_slice(&[f, q, v]);
                }
                // (a design has no Drive: it is set again after one)
                if redesign || d != slot.last[3] {
                    slot.coefs.drive = filter_model::drive_gain(d / 100.0) as f32;
                    slot.last[3] = d;
                }
            }
        }
        self.active = true;
        self.next = if self.moving {
            self.b.min(s + SEGMENT)
        } else {
            self.b
        };
    }
}

// no filter: the integrators keep their state, nothing comes out (a voice outside its a..b)
const FROZEN: [f32; 6] = [0.0; 6];

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
    let d = 1.0 + g * (g + k);
    *out = [
        2.0 * g * (g + k) / d,
        2.0 * g / d,
        2.0 * g * g / d,
        mix[0],
        mix[1] / 2.0,
        mix[2] / 2.0,
    ]
    .map(|value| value as f32);
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
        // the new filter in, the one before out (a raised cosine)
        for i in a..b {
            if fade.left == 0 {
                break;
            }
            let t = 1.0 - fade.left as f64 / fade.length as f64;
            let share = (0.5 - 0.5 * cos(PI * t)) as f32;
            left[i] = old_l[i] + share * (left[i] - old_l[i]);
            right[i] = old_r[i] + share * (right[i] - old_r[i]);
            fade.left -= 1;
        }
        return;
    }
    run_alone(pass, left, right);
}

// the filter before a change of type over a..b, its knobs as they were
#[inline(never)]
fn run_frozen(fade: &mut Fade, a: usize, b: usize, left: &mut [f32], right: &mut [f32]) {
    match fade.kind {
        Kind::Web(_) => {
            let [l1, r1, l2, r2] = fade.web_state;
            let mut ic1 = F32x4::new(l1, r1, 0.0, 0.0);
            let mut ic2 = F32x4::new(l2, r2, 0.0, 0.0);
            let c = fade.web.map(F32x4::splat);
            for i in a..b {
                let y = tick(&c, &mut ic1, &mut ic2, F32x4::new(left[i], right[i], 0.0, 0.0)).lanes();
                left[i] = y[0];
                right[i] = y[1];
            }
            ic1 = ic1.flush();
            ic2 = ic2.flush();
            let (ic1, ic2) = (ic1.lanes(), ic2.lanes());
            fade.web_state = [ic1[0], ic1[1], ic2[0], ic2[1]];
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

// four rows of four into their columns (and back)
#[inline(always)]
fn transpose([a, b, c, d]: [F32x4; 4]) -> [F32x4; 4] {
    let (ab, ab2) = (a.pick::<0, 4, 1, 5>(b), a.pick::<2, 6, 3, 7>(b));
    let (cd, cd2) = (c.pick::<0, 4, 1, 5>(d), c.pick::<2, 6, 3, 7>(d));
    [
        ab.pick::<0, 1, 4, 5>(cd),
        ab.pick::<2, 3, 6, 7>(cd),
        ab2.pick::<0, 1, 4, 5>(cd2),
        ab2.pick::<2, 3, 6, 7>(cd2),
    ]
}

// A group of REFRESH samples from a refresh on (`rows`: those of each lane) through the sections of a layout: the
// four samples of the lanes turned into the lanes of each sample and back (no sample goes in and out lane by lane),
// the refresh at its first one (no branch a sample); each sample the operations of `tick` alone
#[inline(always)]
fn group(layout: Layout, c: &LaneCoefs, state: &mut LaneState, rows: [F32x4; 4]) -> [F32x4; 4] {
    let x = transpose(rows);
    transpose([
        filter_model::tick(layout, c, state, x[0], true),
        filter_model::tick(layout, c, state, x[1], false),
        filter_model::tick(layout, c, state, x[2], false),
        filter_model::tick(layout, c, state, x[3], false),
    ])
}
const _: () = assert!(REFRESH == 4);

// `group` of two pairs of voices, a sample of one then of the other: the integrators of a pair wait for their own
// state alone, so the two overlap (a sample of both in about the time of a sample of one)
#[inline(always)]
fn groups(
    layout: Layout,
    c: &[LaneCoefs; 2],
    first: &mut LaneState,
    second: &mut LaneState,
    rows: [[F32x4; 4]; 2],
) -> [[F32x4; 4]; 2] {
    let (x, z) = (transpose(rows[0]), transpose(rows[1]));
    let y0 = filter_model::tick(layout, &c[0], first, x[0], true);
    let w0 = filter_model::tick(layout, &c[1], second, z[0], true);
    let y1 = filter_model::tick(layout, &c[0], first, x[1], false);
    let w1 = filter_model::tick(layout, &c[1], second, z[1], false);
    let y2 = filter_model::tick(layout, &c[0], first, x[2], false);
    let w2 = filter_model::tick(layout, &c[1], second, z[2], false);
    let y3 = filter_model::tick(layout, &c[0], first, x[3], false);
    let w3 = filter_model::tick(layout, &c[1], second, z[3], false);
    [transpose([y0, y1, y2, y3]), transpose([w0, w1, w2, w3])]
}
// (the spans of a pass that starts at 0 start at a refresh)
const _: () = assert!(SEGMENT.is_multiple_of(REFRESH));

// the samples a..b of a voice alone (lanes 0 and 1) through the sections of a layout
#[inline(never)]
fn model_span(
    layout: Layout,
    c: &LaneCoefs,
    lanes: &mut LaneState,
    a: usize,
    b: usize,
    left: &mut [f32],
    right: &mut [f32],
) {
    // (without the curve of Drive its state takes the last input of the span)
    let last = (b > a).then(|| F32x4::new(left[b - 1], right[b - 1], left[b - 1], right[b - 1]));
    // (the state of the span in locals: through the reference every sample would load and store it)
    let mut state = *lanes;
    for i in a..b {
        // (lanes 2 and 3 the voice again, as their state and coefficients are: fed zeros they never step, and the
        // curve of Drive would work out the one of a small step at every sample)
        let x = F32x4::new(left[i], right[i], left[i], right[i]);
        let y = filter_model::tick(layout, c, &mut state, x, i % REFRESH == 0).lanes();
        left[i] = y[0];
        right[i] = y[1];
    }
    *lanes = state;
    if let (false, Some(last)) = (layout.drive, last) {
        filter_model::drive_rest(c, lanes, last);
    }
    if !layout.sat {
        filter_model::keep_steps(c, lanes);
    }
}

#[inline(never)]
fn run_alone(pass: &mut Pass, left: &mut [f32], right: &mut [f32]) {
    if let Some(layout) = pass.layout {
        let state = pass.model().state;
        let mut lanes = lanes_of(&state, &state);
        let mut s = pass.a;
        while s < pass.b {
            pass.step(s);
            let fresh = pass.take_fresh();
            let e = pass.next;
            let coefs = &pass.model().coefs;
            let c = LaneCoefs::of(coefs, coefs);
            if fresh {
                filter_model::keep_steps(&c, &mut lanes);
            }
            model_span(layout, &c, &mut lanes, s, e, left, right);
            // (the tail of a filter decays: no denormals in its state)
            lanes.flush();
            s = e;
        }
        if let Engine::Model { slot, .. } = &mut pass.engine {
            slot.state = channels_of(&lanes, 0);
        }
        return;
    }
    let [l1, r1, l2, r2] = pass.web().0;
    let mut ic1 = F32x4::new(l1, r1, 0.0, 0.0);
    let mut ic2 = F32x4::new(l2, r2, 0.0, 0.0);
    let mut s = pass.a;
    while s < pass.b {
        pass.step(s);
        let e = pass.next;
        let c = pass.web().1.map(F32x4::splat);
        let (left, right) = (&mut left[..e], &mut right[..e]);
        for i in s..e {
            let y = tick(&c, &mut ic1, &mut ic2, F32x4::new(left[i], right[i], 0.0, 0.0)).lanes();
            left[i] = y[0];
            right[i] = y[1];
        }
        // (the tail of a filter decays: no denormals in its state)
        ic1 = ic1.flush();
        ic2 = ic2.flush();
        s = e;
    }
    let (ic1, ic2) = (ic1.lanes(), ic2.lanes());
    if let Engine::Web { state, .. } = &mut pass.engine {
        **state = [ic1[0], ic1[1], ic2[0], ic2[1]];
    }
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
/// four of one layout of sections that play their whole block: two pairs of lanes in one loop (`run_model_group`);
/// the others in pairs (`run_pair`), the last of three alone
pub fn run_group(passes: &mut [Pass], outs: &mut [[&mut [f32]; 2]], n: usize) {
    if passes.len() > 2 && n > 0 {
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
// voice the operations of `run_model_pair`: its spans, its state flushed where its own span ends
#[inline(never)]
fn run_model_group(layout: Layout, passes: &mut [Pass], outs: &mut [[&mut [f32]; 2]], n: usize) {
    let count = passes.len();
    // the channels of each voice (the fourth: none of three)
    let (head, tail) = outs.split_at_mut(2);
    let ([[al, ar], [bl, br]], Some(([cl, cr], fourth))) = (head, tail.split_first_mut()) else {
        return;
    };
    let (al, ar, bl, br) = (&mut al[..n], &mut ar[..n], &mut bl[..n], &mut br[..n]);
    let (cl, cr) = (&mut cl[..n], &mut cr[..n]);
    let mut fourth = match fourth {
        [[dl, dr]] => Some((&mut dl[..n], &mut dr[..n])),
        _ => None,
    };
    // the voice of each half of the lanes of a pair
    let voices = |pair: usize| [2 * pair, (2 * pair + 1).min(count - 1)];
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
        let c: [LaneCoefs; 2] = core::array::from_fn(|pair| {
            let [p, q] = voices(pair);
            LaneCoefs::of(&passes[p].model().coefs, &passes[q].model().coefs)
        });
        for (pair, lanes) in lanes.iter_mut().enumerate() {
            fresh_steps(&c[pair], lanes, voices(pair).map(|voice| fresh[voice]));
        }
        let at = e - 1;
        let last = [
            F32x4::new(al[at], ar[at], bl[at], br[at]),
            match &fourth {
                Some((dl, dr)) => F32x4::new(cl[at], cr[at], dl[at], dr[at]),
                None => F32x4::new(cl[at], cr[at], cl[at], cr[at]),
            },
        ];
        // (the state of the span in locals, as `run_model_pair` keeps it)
        let [mut first, mut second] = lanes;
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
            let [y, z] = groups(layout, &c, &mut first, &mut second, rows);
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
        // (the last samples of a block that is not of whole groups)
        while i < e {
            let refresh = i.is_multiple_of(REFRESH);
            let x = F32x4::new(al[i], ar[i], bl[i], br[i]);
            let z = match &fourth {
                Some((dl, dr)) => F32x4::new(cl[i], cr[i], dl[i], dr[i]),
                None => F32x4::new(cl[i], cr[i], cl[i], cr[i]),
            };
            let y = filter_model::tick(layout, &c[0], &mut first, x, refresh).lanes();
            let w = filter_model::tick(layout, &c[1], &mut second, z, refresh).lanes();
            (al[i], ar[i], bl[i], br[i]) = (y[0], y[1], y[2], y[3]);
            (cl[i], cr[i]) = (w[0], w[1]);
            if let Some((dl, dr)) = &mut fourth {
                (dl[i], dr[i]) = (w[2], w[3]);
            }
            i += 1;
        }
        lanes = [first, second];
        for (pair, lanes) in lanes.iter_mut().enumerate() {
            if !layout.drive {
                filter_model::drive_rest(&c[pair], lanes, last[pair]);
            }
            if !layout.sat {
                filter_model::keep_steps(&c[pair], lanes);
            }
            let ends = voices(pair).map(|voice| e == passes[voice].next);
            if ends[0] || ends[1] {
                let mut flushed = *lanes;
                flushed.flush();
                *lanes = flushed.pick(lanes, halves_of(ends));
            }
        }
        s = e;
    }
    for (voice, pass) in passes.iter_mut().enumerate() {
        if let Engine::Model { slot, .. } = &mut pass.engine {
            slot.state = channels_of(&lanes[voice / 2], voice % 2);
        }
    }
}

#[inline(never)]
fn run_model_pair(layout: Layout, passes: [&mut Pass; 2], outs: [[&mut [f32]; 2]; 2], n: usize) {
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
            let c = LaneCoefs::of(&p.model().coefs, &q.model().coefs);
            fresh_steps(&c, &mut lanes, fresh);
            // (a voice outside its span takes no input and keeps its state: its lanes run on zeros, then its
            // state of before; its outputs are left as they are)
            let (on_p, on_q) = (p.active, q.active);
            let kept = (!on_p || !on_q).then_some(lanes);
            let last = F32x4::new(pl[e - 1], pr[e - 1], ql[e - 1], qr[e - 1]);
            // (the state of the span in locals: in `lanes`, whose address the calls around take, every sample
            // would load and store it)
            let mut state = lanes;
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
                    let y = group(layout, &c, &mut state, rows);
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
                let y = filter_model::tick(layout, &c, &mut state, x, i.is_multiple_of(REFRESH)).lanes();
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
            lanes = state;
            if !layout.drive {
                filter_model::drive_rest(&c, &mut lanes, last);
            }
            if !layout.sat {
                filter_model::keep_steps(&c, &mut lanes);
            }
            if let Some(kept) = kept {
                // (the lanes of the voice that played, the others as they were)
                lanes = lanes.pick(&kept, halves_of([on_p, on_q]));
            }
            // (the state of a voice is flushed where its own span ends, as `run` does)
            let ends = [p.active && e == p.next, q.active && e == q.next];
            if ends[0] || ends[1] {
                let mut flushed = lanes;
                flushed.flush();
                lanes = flushed.pick(&lanes, halves_of(ends));
            }
        }
        s = e;
    }
    let halves = [channels_of(&lanes, 0), channels_of(&lanes, 1)];
    for (pass, half) in [p, q].into_iter().zip(halves) {
        if let Engine::Model { slot, .. } = &mut pass.engine {
            slot.state = half;
        }
    }
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

// the mask of the lanes of the halves (0: lanes 0 and 1, 1: 2 and 3) that are set
fn halves_of([p, q]: [bool; 2]) -> U32x4 {
    let all = |on: bool| if on { u32::MAX } else { 0 };
    U32x4::new(all(p), all(p), all(q), all(q))
}

#[inline(never)]
fn run_web_pair(passes: [&mut Pass; 2], outs: [[&mut [f32]; 2]; 2], n: usize) {
    let [p, q] = passes;
    let [[pl, pr], [ql, qr]] = outs;
    let (pl, pr, ql, qr) = (&mut pl[..n], &mut pr[..n], &mut ql[..n], &mut qr[..n]);
    let (ps, qs) = (p.web().0, q.web().0);
    let mut ic1 = F32x4::new(ps[0], ps[1], qs[0], qs[1]);
    let mut ic2 = F32x4::new(ps[2], ps[3], qs[2], qs[3]);
    let mut s = 0;
    while s < n {
        if s == p.next {
            p.step(s);
        }
        if s == q.next {
            q.step(s);
        }
        let e = n.min(p.next).min(q.next);
        if p.active || q.active {
            let (cp, cq) = (p.web().1, q.web().1);
            let c: [F32x4; 6] = core::array::from_fn(|k| F32x4::new(cp[k], cp[k], cq[k], cq[k]));
            match (p.active, q.active) {
                (true, true) => {
                    for i in s..e {
                        let x = F32x4::new(pl[i], pr[i], ql[i], qr[i]);
                        let y = tick(&c, &mut ic1, &mut ic2, x).lanes();
                        pl[i] = y[0];
                        pr[i] = y[1];
                        ql[i] = y[2];
                        qr[i] = y[3];
                    }
                }
                (true, false) => {
                    for i in s..e {
                        let x = F32x4::new(pl[i], pr[i], 0.0, 0.0);
                        let y = tick(&c, &mut ic1, &mut ic2, x).lanes();
                        pl[i] = y[0];
                        pr[i] = y[1];
                    }
                }
                _ => {
                    for i in s..e {
                        let x = F32x4::new(0.0, 0.0, ql[i], qr[i]);
                        let y = tick(&c, &mut ic1, &mut ic2, x).lanes();
                        ql[i] = y[2];
                        qr[i] = y[3];
                    }
                }
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

    // the variation of an EQ type (the gain of its band) and of a one-pole is no FAT: no gain of 1 a sample, two of
    // other variations of one type share the lanes
    #[test]
    fn the_variation_of_an_eq_type_or_a_one_pole_is_no_fat() {
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
        assert_eq!(designs.worked_out.get(), 4 * 4 + 2);
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
        assert_eq!(designs.worked_out.get(), 1 + 3);
        let last = inside[n - SEGMENT] as f64;
        let share = ((last - 1024.0) / 64.0) as f32;
        assert_eq!(coefs_of(&first), design(1024.0).between(&design(1088.0), share));
        assert_ne!(coefs_of(&first), design(last));
        // a second voice in the cell: no design (that of its first span is the last the node kept); alone, with no
        // node: the same bits
        let mut second = model_of(ty, 700.0, 60.0, 0.0, 30.0);
        assert_eq!(play(&mut second, &inside, Some(&designs)), shared);
        assert_eq!(designs.worked_out.get(), 1 + 3);
        let mut alone = model_of(ty, 700.0, 60.0, 0.0, 30.0);
        assert_eq!(play(&mut alone, &inside, None), shared);
        // on to the cell next to it (1088 to 1152 Hz): its far edge and its middle
        let on = sweep(1056.0, 0.2);
        let shared = play(&mut first, &on, Some(&designs));
        assert_eq!(designs.worked_out.get(), 1 + 3 + 2);
        let last = on[n - SEGMENT] as f64;
        let share = ((last - 1088.0) / 64.0) as f32;
        assert_eq!(coefs_of(&first), design(1088.0).between(&design(1152.0), share));
        assert_eq!(play(&mut alone, &on, None), shared);
        // back in the cells the node keeps: no design
        play(&mut second, &on, Some(&designs));
        assert_eq!(designs.worked_out.get(), 1 + 3 + 2);
        // a jump (over a cell a span): a design of its own, the cell after it again between its edges
        let jump: Vec<f32> = (0..n)
            .map(|i| if i < 64 { 1100.0 } else { 3000.0 + i as f32 })
            .collect();
        let before = designs.worked_out.get();
        play(&mut first, &jump, Some(&designs));
        let last = jump[n - SEGMENT] as f64;
        let cell = filter_model::cutoff_cell(last, RATE).unwrap();
        assert_eq!(
            coefs_of(&first),
            design(cell.edges[0]).between(&design(cell.edges[1]), cell.share)
        );
        // (1100 Hz in the cell it has; the jump to 3064 Hz: a design; the cell next to that one: its three; the one
        // after it: two)
        assert_eq!(designs.worked_out.get() - before, 1 + 3 + 2);
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
            assert_eq!(designs.worked_out.get(), n / SEGMENT);
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
        assert_eq!(designs.worked_out.get(), 1);
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
            assert_eq!(designs.worked_out.get(), 1 + 3, "{ty:?} {moved:?}");
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
            assert_eq!(designs.worked_out.get(), designed, "{ty:?} {moved}");
            let mut last = [1030.0, 60.0, 30.0];
            last[if moved == 1 { 1 } else { 2 }] = moving[n - SEGMENT] as f64;
            assert_eq!(coefs_of(&filter), design_coefs(ty, last, RATE), "{ty:?} {moved}");
            assert_eq!(play(ty, moved, None).1, shared, "{ty:?} {moved}");
        }
    }

    // a cell the design is not smooth across (the poles of Peak 24 at Res 0 turn real up there): a cutoff that
    // moves in it takes designs of its own
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
        assert_eq!(designs.worked_out.get(), 1 + 3 + 3);
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
                designs.worked_out.get() <= most,
                "{ty:?}: {} of {most}",
                designs.worked_out.get()
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
                let c = LaneCoefs::of(&p, &q);
                let layout = Layout {
                    drive: drive > 0.0,
                    fat: fat > 0.0,
                    ..ty.layout()
                };
                let (mut grouped, mut one_by_one) = (LaneState::default(), LaneState::default());
                for i in (0..64).step_by(REFRESH) {
                    let at = |k: usize| F32x4::load(&rows[k][i..i + REFRESH]);
                    let out = group(layout, &c, &mut grouped, [at(0), at(1), at(2), at(3)]).map(F32x4::lanes);
                    for j in 0..REFRESH {
                        let x = F32x4::new(rows[0][i + j], rows[1][i + j], rows[2][i + j], rows[3][i + j]);
                        let y = filter_model::tick(layout, &c, &mut one_by_one, x, j == 0).lanes();
                        for lane in 0..4 {
                            assert_eq!(out[lane][j].to_bits(), y[lane].to_bits(), "{ty:?} at {}", i + j);
                        }
                    }
                }
                assert_eq!(bits(&grouped), bits(&one_by_one), "{ty:?}");
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
}
