//! The FX Filter, as the one of the effect rack of the reference (dsp/measurements/fxfilter.json; by its manual it
//! "operates identically to the per-voice synth filter … as a master effect", and its responses are those of the
//! filter of a voice, filter-types.json, but for more droop of the highs: fx_droop): the types of Normal of filter_model (MG
//! Low, Low, High 6..24, Band, Peak, Notch 12, 24), their resonance, Drive and FAT, in the sections and the lanes of
//! the filter of a voice (dsp_core model_spans: a block in spans of SEGMENT samples while a knob moves, the
//! coefficients of a span a line to those of its knobs, between the designs of the cells of a cutoff that moves
//! alone). Its laws, measured: the cutoff a frequency (the knob of the reference the note 136.8 v: 8.18 Hz..22.05
//! kHz); Pan (50: none) the cutoff of the left channel up and of the right one down by 32 x³ semitones, x = (50 -
//! Pan) / 50 (the other way past 50); the droop of fx_droop over that of the type; the level a gain of 4 v² (0 dB at
//! a half); the mix inside, as that of the chorus: wet sin²(π mix / 2), dry 1 - wet², no latency. The defaults of a
//! fresh one: MG Low 6 at 425 Hz (the knob at a half), Res, Drive and Var 0, Pan 50, all wet.
//!
//! At Pan 50 both channels go through the filter of the knobs in the lanes 0 and 1 (2 and 3 the same again, as a
//! voice alone has them): the operations of a voice alone. Past it the lanes are mixed (model_spans: the coefficients
//! of the left channel's filter in the lanes 0 and 2, of the right one's in 1 and 3): each channel the bits of a filter
//! of its cutoff.
//! The knobs glide as those of a voice (SMOOTHING; the cutoff in octaves); the routes move the cutoff (in octaves),
//! the resonance, Drive, Var and Pan as lines (`Moves::filter`), read at the end of each span (the points of the
//! lines), the level and the mix once a block. A change of type crossfades the filter before (its knobs frozen) and
//! the new one in FADE; one during a fade waits for its end. Silent in and out it forgets its state (idle): the tail
//! of a resonance rings on until it is silent.
//!
//! What it costs: still knobs no design (one span a block); a cutoff under an LFO the designs of its cells (kept
//! across blocks); the plain sections under Res 40 % without Drive and FAT; no curve without Drive; Pan at 50 one
//! filter's spans; the level and the mix nothing at 0 dB and all wet

use alloc::{vec, vec::Vec};

use dsp_core::blocks::{louder, loudest, Smoothed};
use dsp_core::filter_model::{self, LaneCoefs, LaneState, Layout, ModelType};
use dsp_core::finite;
use dsp_core::model_spans::{
    before, crossfade, gated, lanes_of_coefs, model_span, piece_end, run_span, span_end, spans, Designs,
    ModelSlot, RESONANT,
};
use jsmath::{log2, max, min, pow, round, sin, PI};

use crate::eq::level_gain;
use crate::units::Moves;

/// the params: the type (an index of TYPES), the cutoff (Hz), the resonance, Drive and Var (%), Pan (%: 50 none), the
/// level (a knob), the mix (0..1)
pub const TYPE: usize = 0;
pub const CUTOFF: usize = 1;
pub const RES: usize = 2;
pub const DRIVE: usize = 3;
pub const VAR: usize = 4;
pub const PAN: usize = 5;
pub const LEVEL: usize = 6;
pub const MIX: usize = 7;
pub const PARAMS: usize = 8;

// the knobs that are lines of the routes (`Moves::filter`), in this order
const LINED: [usize; 5] = [CUTOFF, RES, DRIVE, VAR, PAN];

/// the types by their index (FX_FILTER_TYPES of the app: append-only), the types of Normal of filter_model
pub const TYPES: [ModelType; 18] = [
    ModelType::Ladder6,
    ModelType::Ladder12,
    ModelType::Ladder18,
    ModelType::Ladder24,
    ModelType::Low6,
    ModelType::Low12,
    ModelType::Low18,
    ModelType::Low24,
    ModelType::High6,
    ModelType::High12,
    ModelType::High18,
    ModelType::High24,
    ModelType::Band12,
    ModelType::Band24,
    ModelType::Peak12,
    ModelType::Peak24,
    ModelType::Notch12,
    ModelType::Notch24,
];

/// the cutoff of the knob of the reference: notes 0..136.8 (Hz)
pub const MIN_FREQ: f64 = 8.175798915643707;
pub const MAX_FREQ: f64 = 22050.0;
/// the droop of the highs (dB at (f/fs)² = 1) over that of the type, of a section (of a state variable filter or a
/// one-pole: a 24 dB type has two) and of a ladder, fitted on the rows of fxfilter.json (cutoffs up to 3 kHz, Res up to
/// a half, to 12 kHz: -2.2 dB more at 14.4 kHz of 48 kHz of a high pass of 6 dB, about twice of one of 24 dB)
const SECTION_DROOP: f64 = 18.0;
const LADDER_DROOP: f64 = 32.0;

/// the droop of a type over its own (dB at (f/fs)² = 1): `SECTION_DROOP` a section, `LADDER_DROOP` a ladder
pub fn fx_droop(ty: ModelType) -> f64 {
    use ModelType::*;
    match ty {
        Ladder6 | Ladder12 | Ladder18 | Ladder24 => LADDER_DROOP,
        Low18 | Low24 | High18 | High24 | Band24 | Peak24 | Notch24 => 2.0 * SECTION_DROOP,
        _ => SECTION_DROOP,
    }
}
// the semitones of the cutoff of a channel by Pan at its ends (x³ of its share of the way there)
const PAN_SEMITONES: f64 = 32.0;
// seconds: the knobs glide as those of the filter of a voice; the level and the mix as those of the other effects
const SMOOTHING: f64 = 0.0033;
const GLIDE: f64 = 0.01;
// seconds: the crossfade of a change of type
const FADE: f64 = 0.01;
const SILENCE: f64 = 1e-10;

/// the type of a value of its param: an index of TYPES, MG Low 6 of one no type has
pub fn type_of(value: f64) -> ModelType {
    let index = round(finite(value));
    if (0.0..TYPES.len() as f64).contains(&index) {
        TYPES[index as usize]
    } else {
        TYPES[0]
    }
}

/// the octaves of the cutoff of the left channel over the knob by Pan (the right one's under it)
pub fn pan_octaves(pan: f64) -> f64 {
    let x = min(1.0, max(-1.0, (50.0 - pan) / 50.0));
    PAN_SEMITONES / 12.0 * (x * x * x)
}

fn octaves(hz: f64) -> f64 {
    log2(min(max(hz, MIN_FREQ), MAX_FREQ))
}

// the dry and the wet gain of a mix (wet sin²(π mix / 2), dry 1 - wet²)
fn mix_gains(mix: f64) -> (f64, f64) {
    let share = sin(0.5 * PI * min(1.0, max(0.0, mix)));
    let wet = share * share;
    (1.0 - wet * wet, wet)
}

// the filter before a change of type while it fades out: its sections, its coefficients and lanes (its knobs
// frozen), the samples left of the fade
struct Fade {
    layout: Layout,
    coefs: LaneCoefs,
    lanes: LaneState,
    left: usize,
}

pub struct FxFilter {
    sample_rate: f64,
    ty: ModelType,
    // the octaves of the cutoff, the resonance, Drive, Var and Pan
    knobs: [Smoothed; 5],
    // the gain of the level (4 v²), the mix
    level: Smoothed,
    mix: Smoothed,
    // the filter of the left channel (of both at Pan 50) and of the right one (`split`: Pan moved it)
    left: ModelSlot,
    right: ModelSlot,
    split: bool,
    lanes: LaneState,
    designs: Designs,
    // the sections of the last block
    layout: Layout,
    fade: Option<Fade>,
    // a change of type during a fade
    pending: Option<ModelType>,
    fade_length: usize,
    scratch: [Vec<f32>; 2],
    idle: bool,
    // (the specs: the spans a block took)
    #[cfg(test)]
    pub(crate) spans: usize,
}

impl FxFilter {
    pub fn new(sample_rate: f64, params: &[f64; PARAMS]) -> FxFilter {
        let knob = |value: f64, glide: f64| Smoothed::new(value, glide, sample_rate);
        let ty = type_of(params[TYPE]);
        let mut filter = FxFilter {
            sample_rate,
            ty,
            knobs: [
                knob(octaves(finite(params[CUTOFF])), SMOOTHING),
                knob(finite(params[RES]), SMOOTHING),
                knob(finite(params[DRIVE]), SMOOTHING),
                knob(finite(params[VAR]), SMOOTHING),
                knob(finite(params[PAN]), SMOOTHING),
            ],
            level: knob(level_gain(params[LEVEL]), GLIDE),
            mix: knob(finite(params[MIX]), GLIDE),
            left: ModelSlot::default(),
            right: ModelSlot::default(),
            split: false,
            lanes: LaneState::default(),
            designs: Designs::drooped(fx_droop),
            layout: ty.layout(),
            fade: None,
            pending: None,
            fade_length: max(1.0, round(FADE * sample_rate)) as usize,
            scratch: [Vec::new(), Vec::new()],
            idle: true,
            #[cfg(test)]
            spans: 0,
        };
        filter.forget();
        filter
    }

    /// room for blocks of `frames` (allocates: not while a block renders)
    pub fn grow(&mut self, frames: usize) {
        for scratch in self.scratch.iter_mut() {
            if scratch.len() < frames {
                *scratch = vec![0.0; frames];
            }
        }
    }

    pub fn idle(&self) -> bool {
        self.idle
    }

    // the filters of the left and the right channel (the left one's of both at one design)
    fn slots(&self) -> [&ModelSlot; 2] {
        [&self.left, if self.split { &self.right } else { &self.left }]
    }

    /// params by key (the bits of `present`); an idle filter takes them at once, a change of its type too (one that
    /// plays crossfades from the filter before)
    pub fn set(&mut self, present: u32, values: &[f64; PARAMS]) {
        let has = |key: usize| present & (1 << key) != 0;
        for (index, &key) in LINED.iter().enumerate() {
            if has(key) {
                let value = finite(values[key]);
                let value = if key == CUTOFF { octaves(value) } else { value };
                self.knobs[index].set(value, self.idle, None);
            }
        }
        if has(LEVEL) {
            self.level.set(level_gain(values[LEVEL]), self.idle, None);
        }
        if has(MIX) {
            self.mix.set(finite(values[MIX]), self.idle, None);
        }
        if has(TYPE) {
            self.switch(type_of(values[TYPE]));
        }
    }

    // a type: at once while idle, else a crossfade from the filter as it plays (after the one it is in)
    fn switch(&mut self, ty: ModelType) {
        if self.fade.is_some() {
            self.pending = (ty != self.ty).then_some(ty);
            return;
        }
        if ty == self.ty {
            return;
        }
        if !self.idle {
            // (the coefficients in the lanes as they ran: each channel through its own filter)
            self.fade = Some(Fade {
                layout: self.layout,
                coefs: lanes_of_coefs::<true>(self.slots()),
                lanes: self.lanes,
                left: self.fade_length,
            });
        }
        self.ty = ty;
        self.restart();
    }

    // the filter of the type from silence (its first span a design of its own)
    fn restart(&mut self) {
        self.left.reset();
        self.right.reset();
        self.split = false;
        self.lanes = LaneState::default();
    }

    /// the sound before is forgotten: the next one starts at the params as they are then
    pub fn forget(&mut self) {
        if let Some(ty) = self.pending.take() {
            self.ty = ty;
        }
        self.fade = None;
        self.restart();
        for knob in self.knobs.iter_mut() {
            knob.snap();
        }
        self.level.snap();
        self.mix.snap();
        self.idle = true;
    }

    /// a block; `moves` the lines of the routes (`Moves::filter`: the cutoff in octaves, the resonance, Drive, Var,
    /// Pan)
    pub fn process(
        &mut self,
        in_l: &[f32],
        in_r: &[f32],
        out_l: &mut [f32],
        out_r: &mut [f32],
        moves: &Moves,
    ) {
        let n = in_l.len();
        if n == 0 {
            return;
        }
        // (a NaN stays: not quiet, not finite)
        let peak = louder(loudest(in_l), loudest(in_r)) as f64;
        let quiet = peak < SILENCE;
        if self.idle && quiet {
            out_l.fill(0.0);
            out_r.fill(0.0);
            return;
        }
        self.idle = false;
        let frames = n as f64;
        let lines = moves.filter;
        let mut moved = [false; 5];
        for (index, knob) in self.knobs.iter_mut().enumerate() {
            moved[index] = knob.step(frames) || lines[index].is_some();
        }
        let leveled = self.level.step(frames);
        let mixed = self.mix.step(frames);
        let moving = moved.iter().any(|&knob| knob);
        let (ty, rate) = (self.ty, self.sample_rate);
        // the knobs at the end e of a span (a point of the lines: 32, 64… and the last sample)
        let knobs = &self.knobs;
        let at = |index: usize, e: usize| {
            let knob = &knobs[index];
            let along = knob.from + (knob.value - knob.from) * (e as f64 / frames);
            along + lines[index].map_or(0.0, |offsets| offsets[e.min(n - 1)])
        };
        let end = |s: usize| if moving { span_end(s, n) } else { n };
        // the sections over the block: the curve of Drive, the gain of FAT, the saturation of the resonance where any
        // span has them, or the coefficients its first span starts from (while a knob moves a line from where the
        // block before left them: a Drive or a FAT gone inside it was else left out at once, a step of the level)
        let (mut drive, mut fat, mut resonant) = (false, false, false);
        let mut s = 0;
        while s < n {
            let e = end(s);
            drive |= at(2, e) > 0.0;
            fat |= at(3, e) > 0.0;
            resonant |= at(1, e) >= RESONANT as f64;
            s = e;
        }
        if moving {
            // (the knobs they were worked out with; NaN of a filter from silence: none)
            for slot in self.slots() {
                let [_, q, v, d] = slot.last;
                drive |= d > 0.0;
                fat |= v > 0.0;
                resonant |= q >= RESONANT as f64;
            }
        }
        let layout = gated(ty, drive, fat, resonant);
        // the cutoff moves alone in the design (the knobs it is designed by still): the grid of its cells
        let by = ty.designed_by();
        let sweeps = (moved[0] || moved[4]) && (!by[0] || !moved[1]) && (!by[1] || !moved[3]);

        // the filter before a change of type, frozen, on a copy of the input
        let faded = match &mut self.fade {
            Some(fade) => {
                let b = n.min(fade.left);
                let [old_l, old_r] = &mut self.scratch;
                old_l[..b].copy_from_slice(&in_l[..b]);
                old_r[..b].copy_from_slice(&in_r[..b]);
                model_span(fade.layout, &fade.coefs, &mut fade.lanes, 0, b, old_l, old_r);
                fade.lanes.flush();
                b
            }
            None => 0,
        };

        out_l.copy_from_slice(in_l);
        out_r.copy_from_slice(in_r);
        let designs = Some(&self.designs);
        let (mut c, mut d, mut every) = (before::<true>(self.slots(), moving), LaneCoefs::still(), None);
        let (low, high) = (log2(MIN_FREQ), log2(MAX_FREQ));
        let hz = |octaves: f64| pow(2.0, min(max(octaves, low), high));
        let mut s = 0;
        while s < n {
            let span = end(s);
            // (a span whose cutoff goes further than JUMP times in pieces, model_spans::pieces: the knobs read at
            // their ends, the points of their lines; those of the right channel where it has its own, from the filter
            // both had in the span it splits)
            let (f, pan) = (at(0, span), pan_octaves(at(4, span)));
            let cutoffs =
                |f: f64, pan: f64, split: bool| (hz(f + pan), (split || pan != 0.0).then(|| hz(f - pan)));
            let (left, right) = cutoffs(f, pan, self.split);
            let mut count = 1;
            if moving {
                count = self.left.pieces(left, s, span, moving);
                if let Some(right) = right {
                    let from = if self.split { &self.right } else { &self.left };
                    count = count.max(from.pieces(right, s, span, moving));
                }
            }
            let start = s;
            for piece in 0..count {
                let e = piece_end(start, span, piece, count);
                let (pan, left, right) = if e == span {
                    (pan, left, right)
                } else {
                    let (f, pan) = (at(0, e), pan_octaves(at(4, e)));
                    let (left, right) = cutoffs(f, pan, self.split);
                    (pan, left, right)
                };
                let (q, dr, v) = (at(1, e), at(2, e), at(3, e));
                if pan != 0.0 && !self.split {
                    // (the right channel from the filter both had: its coefficients go on from there)
                    self.right = self.left;
                    self.split = true;
                }
                let pieces = count > 1;
                self.left
                    .step(ty, [left, q, dr, v], s, e, moving, sweeps, designs, rate, pieces);
                let fresh = self.left.take_fresh();
                if self.split {
                    // (a split filter has the cutoff of its right channel: worked out where it splits or is split)
                    let right = right.unwrap_or(left);
                    self.right
                        .step(ty, [right, q, dr, v], s, e, moving, sweeps, designs, rate, pieces);
                    self.right.take_fresh();
                }
                let slots = self.slots();
                let ramps = slots.map(|slot| slot.ramps);
                let line = spans::<true>(
                    layout, &mut c, &mut d, &mut every, slots, ramps, moving, [true; 2],
                );
                if fresh {
                    filter_model::keep_steps(&c, &mut self.lanes);
                }
                run_span(
                    layout,
                    line,
                    &mut c,
                    &d,
                    &every,
                    &mut self.lanes,
                    s,
                    e,
                    out_l,
                    out_r,
                );
                // (the tail of a filter decays: no denormals in its state)
                self.lanes.flush();
                #[cfg(test)]
                {
                    self.spans += 1;
                }
                s = e;
            }
        }
        self.layout = layout;
        // (both filters at one design again: one again)
        if self.split && !moving && self.left.coefs == self.right.coefs {
            self.split = false;
        }

        if faded > 0 {
            if let Some(fade) = &mut self.fade {
                let [old_l, old_r] = &self.scratch;
                crossfade(
                    out_l,
                    out_r,
                    [old_l, old_r],
                    0,
                    faded,
                    &mut fade.left,
                    self.fade_length,
                );
                if fade.left == 0 {
                    self.fade = None;
                    if let Some(ty) = self.pending.take() {
                        self.switch(ty);
                    }
                }
            }
        }

        // the level and the mix: out = level (dry · in + wet · filtered)
        if leveled || mixed || self.level.value != 1.0 || self.mix.value != 1.0 {
            let gains = |level: f64, mix: f64| {
                let (dry, wet) = mix_gains(mix);
                (level * dry, level * wet)
            };
            let to = gains(self.level.value, self.mix.value);
            let from = if (self.level.from, self.mix.from) == (self.level.value, self.mix.value) {
                to
            } else {
                gains(self.level.from, self.mix.from)
            };
            let channels = [(in_l, &mut *out_l), (in_r, &mut *out_r)];
            for (input, output) in channels {
                if from == to {
                    let (dry, wet) = (to.0 as f32, to.1 as f32);
                    for (y, x) in output.iter_mut().zip(input) {
                        *y = dry * *x + wet * *y;
                    }
                } else {
                    for (i, (y, x)) in output.iter_mut().zip(input).enumerate() {
                        let share = (i + 1) as f64 / frames;
                        let dry = (from.0 + (to.0 - from.0) * share) as f32;
                        let wet = (from.1 + (to.1 - from.1) * share) as f32;
                        *y = dry * *x + wet * *y;
                    }
                }
            }
        }

        // (a NaN is not silent)
        let output = louder(loudest(out_l), loudest(out_r)) as f64;
        if !output.is_finite() {
            out_l.fill(0.0);
            out_r.fill(0.0);
            self.forget();
        } else if quiet && output < SILENCE && self.fade.is_none() {
            self.forget();
        }
    }
}

#[cfg(test)]
mod tests;
