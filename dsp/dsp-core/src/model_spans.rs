//! The spans of the model types of filter_model (the types of the Audio Unit of the renders) over a block: a slot of
//! a filter (its coefficients, the knobs they were worked out with, the cell of its cutoff), the designs a node keeps
//! (`Designs`), the coefficients of the lanes of two filters along their spans (`take_spans`: lines while a knob
//! moves) and the loops of the lanes of one stereo signal through them (`model_span`, `model_line`,
//! `model_line_plain`). The filter of a voice (wavetable-osc filter.rs) and the filter of the chain (chain
//! fxfilter.rs) run on them: the lanes 0 and 1 are the left and the right channel through the coefficients of the
//! first filter, 2 and 3 through those of the second one (the same filter in both halves for a voice alone), the
//! loops take the channels out of the lanes 0 and 1. Of a stereo signal each channel through a filter of its own
//! (`MIXED`: the filter of the chain at a Pan) the coefficients of the first filter are in the lanes 0 and 2, those of
//! the second in 1 and 3 (LaneCoefs::mixed): the left channel through the first one, the right through the second

use crate::filter_model::{self, Cell as GridCell, Coefs, LaneCoefs, LaneState, Layout, ModelType};
use crate::simd::{transpose, F32x4, U32x4};
use alloc::vec::Vec;
use core::cell::Cell;
use jsmath::{cos, PI};

/// the samples of a span while a knob moves
pub const SEGMENT: usize = 32;

// the samples of a block (0, 4, 8…) where the saturating sections of a model type work out their steps again (the
// same of every voice: a voice plays the same bits in the lanes of another or alone)
pub const REFRESH: usize = 4;
// Res (%) from which the resonance of a model type saturates in a pass without Drive and FAT
pub const RESONANT: f32 = 40.0;
// The coefficients of a span whose knobs moved go to those of its knobs as a line from where the span before left
// them, a step every REFRESH samples of a model type, every sample of a type of a BiquadFilterNode (held a span each they were a stair of SEGMENT samples: a noise over the note, more of a
// steeper type; the filter is a span behind its knobs). A cutoff that went further than JUMP times in a span is no
// line (a jump of a knob: the coefficients between two far designs are of no filter), nor is the first span of a note
const JUMP: f64 = 4.0;
pub fn glides(cutoff: f64, before: f64) -> bool {
    cutoff <= before * JUMP && before <= cutoff * JUMP
}
// the refreshes of the saturating sections in the samples s..e
pub fn refreshes(s: usize, e: usize) -> usize {
    e.div_ceil(REFRESH) - s.div_ceil(REFRESH)
}
// The end of a span from s of a pass whose knobs move, of a pass that ends at b: SEGMENT samples on, or b where under
// half a span would be left after it. A short span at the end goes the way of a whole span (from the knobs of the span
// before to its own) in its few steps, under a refresh in none: the block after took it at once, the stair the lines
// take away (a note that starts late in its block, or a voice that sweeps a cutoff of a BiquadFilterNode)
pub fn span_end(s: usize, b: usize) -> usize {
    let e = s + SEGMENT;
    if e + SEGMENT / 2 > b {
        b
    } else {
        e
    }
}

// a model type: its coefficients, the knobs they were worked out with (cutoff, resonance, variation, drive), the
// state of its channels (of each lane of a voice); the cell of its cutoff as it moved last (None: it was still, or
// off the grid), whether it has the designs of that cell (`held`), those designs; `fresh`: reset, its saturating
// sections have no steps yet (its first span gives them those of the small signal: a note that starts between two
// refreshes); `narrow`: the type, knobs and index of a cell it swept that is narrow (Anchors): the cells it sweeps
// within NARROW_CELLS of it take designs; `designed`: the design its coefficients are (None: between the designs of
// a cell)
#[derive(Clone, Copy, Default)]
pub struct ModelSlot {
    pub coefs: Coefs,
    pub last: [f64; 4],
    pub state: [ModelChannel; 2],
    cell: Option<CellKey>,
    held: bool,
    anchors: Anchors,
    fresh: bool,
    pub narrow: Option<(ModelType, [f64; 2], u32)>,
    designed: Option<DesignKey>,
    // its span is a line (`step`), 1 / its refreshes (0: none)
    pub ramps: bool,
    inv: f32,
}

/// the state of a channel of a model type
#[derive(Clone, Copy, Default)]
pub struct ModelChannel {
    pub drive: f32,
    pub svf: [[f32; 2]; 2],
    pub pole: f32,
    pub droop: f32,
    pub sat: [[f32; 3]; 2],
}

impl ModelSlot {
    pub fn reset(&mut self) {
        self.state = Default::default();
        self.last = [f64::NAN; 4];
        self.cell = None;
        self.held = false;
        self.fresh = true;
        self.narrow = None;
        self.designed = None;
    }

    /// whether it is fresh (its first span begun: `step`); it is not afterwards
    pub fn take_fresh(&mut self) -> bool {
        core::mem::take(&mut self.fresh)
    }

    /// The span from s to `next` of a filter of the type `ty` at its knobs there (cutoff in Hz; resonance, Drive and the
    /// variation in %): its coefficients (a design, or between the designs of the cell of its cutoff while it moves
    /// alone in the design: `sweeps`), whether the span is a line to them (`moving`: a knob of the pass moves), its
    /// Drive. `designs`: those of its node (None: its own)
    #[allow(clippy::too_many_arguments)]
    pub fn step(
        &mut self,
        ty: ModelType,
        [f, q, d, v]: [f64; 4],
        s: usize,
        next: usize,
        moving: bool,
        sweeps: bool,
        designs: Option<&Designs>,
        sample_rate: f64,
    ) {
        let redesign = f != self.last[0] || q != self.last[1] || v != self.last[2];
        let line = moving && !self.fresh && (redesign || d != self.last[3]) && glides(f, self.last[0]);
        self.ramps = line;
        if line {
            let count = refreshes(s, next);
            self.inv = if count > 0 { 1.0 / count as f32 } else { 0.0 };
        }
        if redesign {
            // (its designs and cells by the knobs it is designed by: one it is not designed by may move)
            let knobs = design_knobs(ty, [q, v]);
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
            let key = cell.map(|cell| (ty, cell.index, knobs));
            let near = matches!(
                (self.cell, key),
                (Some((_, before, was)), Some((_, index, _)))
                    if was == knobs && before.abs_diff(index) <= 1
            );
            let narrow = matches!(
                (self.narrow, cell),
                (Some((was, its, index)), Some(cell))
                    if was == ty && its == knobs && index.abs_diff(cell.index) <= NARROW_CELLS
            );
            if let (true, false, Some(cell)) = (near, narrow, cell) {
                if !self.held || self.cell != key {
                    match designs {
                        Some(designs) => {
                            designs.anchors_into(&mut self.anchors, ty, &cell, knobs, sample_rate)
                        }
                        None => {
                            // (the designs of the cell before: an edge of this one)
                            let kept = |index: u32| {
                                let has = self.held && self.cell == Some((ty, index, knobs));
                                has.then_some(self.anchors)
                            };
                            self.anchors = anchors_of(ty, &cell, knobs, sample_rate, 0.0, kept, || ());
                        }
                    }
                }
                self.held = true;
                if self.anchors.narrow {
                    self.narrow = Some((ty, knobs, cell.index));
                }
            } else {
                // (next to a narrow cell: a design, the cell's not worked out)
                self.held = false;
            }
            self.cell = key;
            if self.held && self.anchors.smooth {
                let share = cell.map_or(0.0, |cell| cell.share);
                let [low, high] = &self.anchors.edges;
                self.coefs.set_between(low, high, share);
                self.designed = None;
            } else {
                let [q, v] = knobs;
                let design = (ty, [f, q, v]);
                // (the design it has: a knob it is not designed by moved)
                if self.designed != Some(design) {
                    match designs {
                        Some(designs) => designs.coefs_into(&mut self.coefs, ty, [f, q, v], sample_rate),
                        None => self.coefs = design_coefs(ty, [f, q, v], sample_rate),
                    }
                    self.designed = Some(design);
                }
            }
            // (the FAT of a design: that of the edges of a cell, theirs alike)
            self.coefs.fat = ty.fat_of(q / 100.0, v / 100.0) as f32;
            self.last[..3].copy_from_slice(&[f, q, v]);
        }
        // (a design has no Drive: it is set again after one)
        if redesign || d != self.last[3] {
            self.coefs.drive = filter_model::drive_gain(d / 100.0) as f32;
            self.last[3] = d;
        }
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
pub const NARROW_CELLS: u32 = 8;

// the designs of a cell: an edge from `kept`, the cell next to it there (by its index), where it is kept, else
// worked out, as the middle is
#[inline(never)]
#[allow(clippy::too_many_arguments)]
fn anchors_of(
    ty: ModelType,
    cell: &GridCell,
    [q, v]: [f64; 2],
    sample_rate: f64,
    droop: f64,
    kept: impl Fn(u32) -> Option<Anchors>,
    designed: impl Fn(),
) -> Anchors {
    let design = |f: f64| {
        designed();
        drooped_coefs(ty, [f, q, v], sample_rate, droop)
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
pub fn design_knobs(ty: ModelType, [q, v]: [f64; 2]) -> [f64; 2] {
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
    worked_out: Cell<usize>,
    // the droop (dB) of its designs over that of their type, by type (`drooped_coefs`)
    droop: fn(ModelType) -> f64,
}

impl Default for Designs {
    fn default() -> Designs {
        Designs {
            keys: Default::default(),
            coefs: Default::default(),
            next: Cell::new(0),
            cells: (0..CELLS).map(|_| Default::default()).collect(),
            worked_out: Cell::new(0),
            droop: |_| 0.0,
        }
    }
}

impl Designs {
    /// the designs of a filter whose sections droop more than those of its type: `droop` the dB of a type (at
    /// (f/fs)² = 1)
    pub fn drooped(droop: fn(ModelType) -> f64) -> Designs {
        Designs {
            droop,
            ..Designs::default()
        }
    }

    /// the designs it worked out
    pub fn worked_out(&self) -> usize {
        self.worked_out.get()
    }

    // into `out`, straight from the one kept (a span of a voice copies its coefficients once)
    fn coefs_into(&self, out: &mut Coefs, ty: ModelType, knobs: [f64; 3], sample_rate: f64) {
        let key = Some((ty, knobs));
        for (kept, coefs) in self.keys.iter().zip(&self.coefs) {
            if kept.get() == key {
                *out = coefs.get();
                return;
            }
        }
        *out = drooped_coefs(ty, knobs, sample_rate, (self.droop)(ty));
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
        *out = anchors_of(ty, cell, knobs, sample_rate, (self.droop)(ty), kept, || {
            self.worked_out.set(self.worked_out.get() + 1);
        });
        slot.set(*out);
        key.set(Some((ty, cell.index, knobs)));
    }
}

// the coefficients of a model type at its cutoff (Hz), resonance and variation (%), Drive 0
#[inline(never)]
pub fn design_coefs(ty: ModelType, [f, q, v]: [f64; 3], sample_rate: f64) -> Coefs {
    Coefs::of(
        &filter_model::model_design(ty, f, q / 100.0, v / 100.0, sample_rate),
        0.0,
    )
}

// `design_coefs` with `droop` dB more droop (filter_model::more_droop; 0: those of the type)
#[inline(never)]
fn drooped_coefs(ty: ModelType, [f, q, v]: [f64; 3], sample_rate: f64, droop: f64) -> Coefs {
    if droop == 0.0 {
        return design_coefs(ty, [f, q, v], sample_rate);
    }
    let mut design = filter_model::model_design(ty, f, q / 100.0, v / 100.0, sample_rate);
    design.droop = filter_model::more_droop(design.droop, droop);
    Coefs::of(&design, 0.0)
}

// the lanes of two voices (p in 0 and 1, q in 2 and 3) from their channels, and back
pub fn lanes_of(p: &[ModelChannel; 2], q: &[ModelChannel; 2]) -> LaneState {
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
pub fn channels_of(state: &LaneState, half: usize) -> [ModelChannel; 2] {
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

// the sections of a model type with the curve of Drive (Drive over 0), the gain of FAT (over 0, of a type that has
// it: the variation of an EQ type is the gain of its band, the FAT of a one-pole or a notch a gain of 1) and the
// saturation of the resonance: the resonance saturates under Res 40 %, without Drive and FAT, by under 0.3 dB at the
// cutoff (a sine at full scale): the plain sections there
pub fn gated(ty: ModelType, drive: bool, fat: bool, resonant: bool) -> Layout {
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

// A group of REFRESH samples from a refresh on (`rows`: those of each lane) through the sections of a layout: the
// four samples of the lanes turned into the lanes of each sample and back (no sample goes in and out lane by lane),
// the refresh at its first one (no branch a sample); each sample the operations of `tick` alone
#[inline(always)]
pub fn group(
    layout: Layout,
    c: &mut LaneCoefs,
    d: Option<&LaneCoefs>,
    state: &mut LaneState,
    rows: [F32x4; 4],
) -> [F32x4; 4] {
    let x = transpose(rows);
    transpose([
        sample(layout, c, d, state, x[0], true),
        sample(layout, c, d, state, x[1], false),
        sample(layout, c, d, state, x[2], false),
        sample(layout, c, d, state, x[3], false),
    ])
}

// a sample of the lanes through the sections of a layout (filter_model::tick), their coefficients a step on before
// it at a refresh in a span that is a line (`d`: the step a refresh)
#[inline(always)]
pub fn sample(
    layout: Layout,
    c: &mut LaneCoefs,
    d: Option<&LaneCoefs>,
    state: &mut LaneState,
    x: F32x4,
    refresh: bool,
) -> F32x4 {
    if let (Some(d), true) = (d, refresh) {
        c.advance(layout, d);
    }
    filter_model::tick(layout, c, state, x, refresh)
}
const _: () = assert!(REFRESH == 4);

// (the spans of a pass that starts at 0 start at a refresh)
const _: () = assert!(SEGMENT.is_multiple_of(REFRESH));

// The coefficients `c` of the lanes of two voices for the samples from here on, where the span of each one that
// `stepped` starts, and whether a span of theirs is a line. None is: those of their knobs, as they were held before
// the lines. One is: a voice whose span is a line goes on from where its coefficients are (`c`; before the first
// span of a pass those of the block before: `before`), a step `d` a refresh to those of its knobs (LaneCoefs::steer);
// another that stepped has those of its knobs, still; one that did not goes on along its line (one function for a
// voice alone, a pair and the pairs of a group: in each of them it would be a fifth of the core)
#[inline(never)]
pub fn take_spans<const MIXED: bool>(
    layout: Layout,
    c: &mut LaneCoefs,
    d: &mut LaneCoefs,
    slots: [&ModelSlot; 2],
    ramps: [bool; 2],
    stepped: [bool; 2],
) -> bool {
    let to = lanes_of_coefs::<MIXED>(slots);
    let halves_of = |two: [bool; 2]| if MIXED { mixed_of(two) } else { halves_of(two) };
    if !ramps[0] && !ramps[1] {
        // (still: next to lanes that are on a line, a pair of a group, they step by nothing)
        (*c, *d) = (to, LaneCoefs::still());
        return false;
    }
    let jumps = [stepped[0] && !ramps[0], stepped[1] && !ramps[1]];
    if jumps[0] || jumps[1] {
        *c = to.pick(c, halves_of(jumps));
    }
    let ramping = [stepped[0] && ramps[0], stepped[1] && ramps[1]];
    let inv = if MIXED {
        F32x4::new(slots[0].inv, slots[1].inv, slots[0].inv, slots[1].inv)
    } else {
        F32x4::new(slots[0].inv, slots[0].inv, slots[1].inv, slots[1].inv)
    };
    c.steer(d, &to, layout, inv, halves_of(ramping), halves_of(stepped));
    true
}

// `take_spans` where a knob of one of the voices moves; no knob does: no span is a line, their coefficients as they
// were held before the lines (nothing more a block)
#[inline(always)]
pub fn spans<const MIXED: bool>(
    layout: Layout,
    c: &mut LaneCoefs,
    d: &mut LaneCoefs,
    slots: [&ModelSlot; 2],
    ramps: [bool; 2],
    moving: bool,
    stepped: [bool; 2],
) -> bool {
    if moving {
        return take_spans::<MIXED>(layout, c, d, slots, ramps, stepped);
    }
    *c = lanes_of_coefs::<MIXED>(slots);
    false
}

/// the coefficients of two filters in the lanes: by halves, or mixed (LaneCoefs::mixed)
#[inline(always)]
pub fn lanes_of_coefs<const MIXED: bool>([p, q]: [&ModelSlot; 2]) -> LaneCoefs {
    let lanes = LaneCoefs::of(&p.coefs, &q.coefs);
    if MIXED {
        lanes.mixed()
    } else {
        lanes
    }
}

// the mask of the lanes of each of two filters mixed in the lanes (p: 0 and 2, q: 1 and 3) that are set
fn mixed_of([p, q]: [bool; 2]) -> U32x4 {
    let all = |on: bool| if on { u32::MAX } else { 0 };
    U32x4::new(all(p), all(q), all(p), all(q))
}

// the coefficients of the lanes of two voices before the first spans of their passes (`take_spans`): those the block
// before left them at, where a knob of one moves (else no span is a line: nothing reads them)
#[inline(always)]
pub fn before<const MIXED: bool>(slots: [&ModelSlot; 2], moving: bool) -> LaneCoefs {
    if moving {
        lanes_of_coefs::<MIXED>(slots)
    } else {
        LaneCoefs::default()
    }
}

/// the samples a..b of a stereo signal through the sections of a layout (the left channel through the first filter of
/// the lanes, the right one through the second)
#[inline(never)]
pub fn model_span(
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
    end_span(layout, c, lanes, last);
}

/// the same of a span that is a line: its coefficients from `c` on, a step `d` a refresh
#[inline(never)]
#[allow(clippy::too_many_arguments)]
pub fn model_line(
    layout: Layout,
    c: &mut LaneCoefs,
    d: &LaneCoefs,
    lanes: &mut LaneState,
    a: usize,
    b: usize,
    left: &mut [f32],
    right: &mut [f32],
) {
    line_samples(layout, c, d, lanes, a, b, left, right);
}

// whether the sections of a layout are the plain ones: no curve of Drive, no FAT, no saturation (the clip of a
// ladder is of its saturation: none without it)
pub fn plain(layout: Layout) -> bool {
    !(layout.drive || layout.fat || layout.sat || layout.sat2)
}

// `model_line` of plain sections (`plain`: the types of Normal under Res 40 % without Drive and FAT, the EQ types), the
// same operations: a loop without the coefficients and the state of the others (with them a span keeps more than
// the registers hold)
#[inline(never)]
#[allow(clippy::too_many_arguments)]
fn model_line_plain(
    layout: Layout,
    c: &mut LaneCoefs,
    d: &LaneCoefs,
    lanes: &mut LaneState,
    a: usize,
    b: usize,
    left: &mut [f32],
    right: &mut [f32],
) {
    // (what a plain layout has not, written out: its loop is compiled without the rest)
    let layout = Layout {
        drive: false,
        fat: false,
        sat: false,
        sat2: false,
        clip: false,
        ..layout
    };
    line_samples(layout, c, d, lanes, a, b, left, right);
}

#[inline(always)]
#[allow(clippy::too_many_arguments)]
fn line_samples(
    layout: Layout,
    c: &mut LaneCoefs,
    d: &LaneCoefs,
    lanes: &mut LaneState,
    a: usize,
    b: usize,
    left: &mut [f32],
    right: &mut [f32],
) {
    let last = (b > a).then(|| F32x4::new(left[b - 1], right[b - 1], left[b - 1], right[b - 1]));
    let (left, right) = (&mut left[..b], &mut right[..b]);
    // (the state and the coefficients of the span in locals)
    let (mut state, mut now) = (*lanes, *c);
    let mut i = a;
    while i < b {
        // from a refresh on a whole group (`group`: its samples one by one), as two voices in the lanes run; else
        // (the samples up to the first refresh, the last ones) one by one
        if i.is_multiple_of(REFRESH) && i + REFRESH <= b {
            let (l, r) = (
                F32x4::load(&left[i..i + REFRESH]),
                F32x4::load(&right[i..i + REFRESH]),
            );
            let y = group(layout, &mut now, Some(d), &mut state, [l, r, l, r]);
            y[0].store(&mut left[i..i + REFRESH]);
            y[1].store(&mut right[i..i + REFRESH]);
            i += REFRESH;
            continue;
        }
        let x = F32x4::new(left[i], right[i], left[i], right[i]);
        let y = sample(
            layout,
            &mut now,
            Some(d),
            &mut state,
            x,
            i.is_multiple_of(REFRESH),
        )
        .lanes();
        left[i] = y[0];
        right[i] = y[1];
        i += 1;
    }
    (*lanes, *c) = (state, now);
    end_span(layout, c, lanes, last);
}

// the end of a span of the lanes: without the curve of Drive its state takes the last input of the span (`last`: none
// of an empty one), without the saturation the steps of the small signal
#[inline(always)]
pub fn end_span(layout: Layout, c: &LaneCoefs, lanes: &mut LaneState, last: Option<F32x4>) {
    if let (false, Some(last)) = (layout.drive, last) {
        filter_model::drive_rest(c, lanes, last);
    }
    if !layout.sat {
        filter_model::keep_steps(c, lanes);
    }
}

// the mask of the lanes of the halves (0: lanes 0 and 1, 1: 2 and 3) that are set
pub fn halves_of([p, q]: [bool; 2]) -> U32x4 {
    let all = |on: bool| if on { u32::MAX } else { 0 };
    U32x4::new(all(p), all(p), all(q), all(q))
}

/// the samples s..e of a stereo signal through the sections of a layout, the span a line (`line`: from `c` on, a step
/// `d` a refresh) or still
#[inline(always)]
#[allow(clippy::too_many_arguments)]
pub fn run_span(
    layout: Layout,
    line: bool,
    c: &mut LaneCoefs,
    d: &LaneCoefs,
    lanes: &mut LaneState,
    s: usize,
    e: usize,
    left: &mut [f32],
    right: &mut [f32],
) {
    if line && plain(layout) {
        model_line_plain(layout, c, d, lanes, s, e, left, right);
    } else if line {
        model_line(layout, c, d, lanes, s, e, left, right);
    } else {
        model_span(layout, c, lanes, s, e, left, right);
    }
}

/// the new filter (`left`, `right` from a to b) in over the one before (`old`), the one before out: a raised cosine,
/// `rest` the samples left of a fade of `length` (none left: the new one alone)
#[inline(always)]
pub fn crossfade(
    left: &mut [f32],
    right: &mut [f32],
    [old_l, old_r]: [&[f32]; 2],
    a: usize,
    b: usize,
    rest: &mut usize,
    length: usize,
) {
    for i in a..b {
        if *rest == 0 {
            break;
        }
        let t = 1.0 - *rest as f64 / length as f64;
        let share = (0.5 - 0.5 * cos(PI * t)) as f32;
        left[i] = old_l[i] + share * (left[i] - old_l[i]);
        right[i] = old_r[i] + share * (right[i] - old_r[i]);
        *rest -= 1;
    }
}
