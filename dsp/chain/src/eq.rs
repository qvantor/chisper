//! The EQ, as the one of the effect rack of the reference (dsp/measurements/eq.json: its responses, the specs hold
//! it to them): two bands, each a filter of the Audio EQ Cookbook of a type, a frequency, a resonance and a gain
//! (its bilinear transform at the rate of the context, as the reference has it at the rate of its host: cramped at
//! nyquist), then the level. Band 1 is a low shelf, a peak or a highpass, band 2 a high shelf, a peak or a lowpass
//! (a pass 12 dB an octave, its gain none). The laws of the reference: the frequency 21.53 Hz..20 kHz (at any
//! rate), the gain ±24 dB, the resonance (0..100 %, x its share) a Q of 0.1 + 18.9 x⁴ of a peak and a pass, of
//! 0.4 + 1.7416 x³ of a shelf; the level a gain of 4 v² (0 dB at a half). The defaults of the reference: shelves
//! of 60 % at 210 Hz and 2.04 kHz (209.6 and 2040.5 measured), 0 dB.
//!
//! A band is a state variable filter with the response of its type (the forms of A. Simper: the same curves),
//! both channels in the lanes of F64x2, all in doubles. A block goes in segments of SEGMENT samples. While its knobs
//! rest a band's coefficients stand; while they glide (GLIDE, the frequency in octaves) or the routes move them
//! (the lines of `Moves`: an offset a sample, of the frequency in octaves too) the band is designed at the end of
//! each segment and its coefficients go there as lines, a step a sample (never at once; a design that came out as
//! the one before is no line). A change of type fades the design from the one before to the new one in FADE. A
//! band of a shelf or a peak at 0 dB is the input as it is, whatever its frequency and resonance do: not rendered,
//! its state forgotten (a pass reads no gain). Silent in and out, the states are forgotten (idle); those of a
//! channel silent alone (the other plays on) are flushed to 0 under TINY_F64 at the end of each segment: none of
//! them ever comes near a denormal. A sample goes out as 0 under TINY (its tail would reach the denormals of f32
//! long before the states those of doubles)

use dsp_core::blocks::{louder, loudest, Smoothed};
use dsp_core::finite;
use dsp_core::simd::{F64x2, TINY};
use jsmath::{cos, log2, max, min, pow, sin, sqrt, PI};

use crate::units::Moves;

/// the params: of each band its type (SHELF, PEAK, PASS), frequency (Hz), resonance (%) and gain (dB), then the
/// level (a knob)
pub const T1: usize = 0;
pub const F1: usize = 1;
pub const Q1: usize = 2;
pub const G1: usize = 3;
pub const T2: usize = 4;
pub const F2: usize = 5;
pub const Q2: usize = 6;
pub const G2: usize = 7;
pub const LEVEL: usize = 8;
pub const PARAMS: usize = 9;

/// the keys of each band: type, frequency, resonance, gain
pub const BANDS: [[usize; 4]; 2] = [[T1, F1, Q1, G1], [T2, F2, Q2, G2]];

/// the types of a band (EQ_TYPES of eq-params.ts): a shelf (low of band 1, high of band 2), a peak, a pass (high
/// of band 1, low of band 2); a value over them is a pass, as the reference has it
pub const SHELF: u32 = 0;
pub const PEAK: u32 = 1;
pub const PASS: u32 = 2;

pub const MIN_FREQ: f64 = 21.53;
pub const MAX_FREQ: f64 = 20000.0;
pub const MAX_GAIN: f64 = 24.0;
// the highest frequency a band is designed at, a share of the rate: under nyquist (20 kHz from 40 kHz on)
const TOP: f64 = 0.499;

const GLIDE: f64 = 0.01;
const FADE: f64 = 0.01;
/// the samples a moving band is designed every
pub const SEGMENT: usize = 32;
const SILENCE: f64 = 1e-10;

/// the type of a value of its param
pub fn type_of(value: f64) -> u32 {
    if value >= 1.5 {
        PASS
    } else if value >= 0.5 {
        PEAK
    } else {
        SHELF
    }
}

fn clamp(value: f64, low: f64, high: f64) -> f64 {
    min(max(value, low), high)
}

/// the prewarped frequency tan(π f / rate) of a frequency (Hz) within the knob and under nyquist
pub fn warp(freq: f64, sample_rate: f64) -> f64 {
    let f = clamp(freq, MIN_FREQ, min(MAX_FREQ, TOP * sample_rate));
    let w = PI * f / sample_rate;
    sin(w) / cos(w)
}

/// the amplitude A of a gain (dB), the square root of the gain of a peak at its frequency
pub fn amplitude(gain: f64) -> f64 {
    pow(10.0, clamp(gain, -MAX_GAIN, MAX_GAIN) / 40.0)
}

/// the design of band `band` (0, 1) of type `ty` at the prewarped frequency `t` (warp), its resonance (%) and the
/// amplitude `a` of its gain (amplitude; a pass reads none): g (the prewarped frequency), k (the damping) and the
/// shares of the input, the band and the low of a state variable filter with the response of the cookbook type;
/// eqDesign of libs/math/src/filter/eq.ts is the same operations (a spec holds them alike bit for bit)
pub fn design_of(band: usize, ty: u32, t: f64, reso: f64, a: f64) -> [f64; 5] {
    let x = clamp(reso / 100.0, 0.0, 1.0);
    if ty == SHELF {
        let k = 1.0 / (0.4 + 1.7416 * (x * x * x));
        if band == 0 {
            [t / sqrt(a), k, 1.0, k * (a - 1.0), a * a - 1.0]
        } else {
            [t * sqrt(a), k, a * a, k * (1.0 - a) * a, 1.0 - a * a]
        }
    } else {
        let x2 = x * x;
        let q = 0.1 + 18.9 * (x2 * x2);
        if ty == PEAK {
            let k = 1.0 / (q * a);
            [t, k, 1.0, k * (a * a - 1.0), 0.0]
        } else if band == 0 {
            let k = 1.0 / q;
            [t, k, 1.0, -k, -1.0]
        } else {
            [t, 1.0 / q, 0.0, 0.0, 1.0]
        }
    }
}

/// the design of a band at its knobs (design_of of their warp and amplitude)
pub fn design(band: usize, ty: u32, freq: f64, reso: f64, gain: f64, sample_rate: f64) -> [f64; 5] {
    let a = if ty == PASS { 1.0 } else { amplitude(gain) };
    design_of(band, ty, warp(freq, sample_rate), reso, a)
}

// the last value a step of a design was worked out of and what it gave: worked out again only when it moved
#[derive(Clone, Copy)]
struct Kept {
    from: f64,
    value: f64,
}

impl Kept {
    fn new() -> Kept {
        Kept {
            from: f64::NAN,
            value: 0.0,
        }
    }

    #[inline(always)]
    fn of(&mut self, from: f64, work: impl Fn(f64) -> f64) -> f64 {
        if from != self.from {
            self.from = from;
            self.value = work(from);
        }
        self.value
    }
}

// the coefficients of a design: with d = 1 + g (g + k) the steps of the integrators 2 g (g + k) / d, 2 g / d and
// 2 g² / d, then the shares of the input, of the band (halved) and of the low (halved): svf_coefs of
// dsp_core::filter_model, in doubles
fn coefs([g, k, m0, m1, m2]: [f64; 5]) -> [f64; 6] {
    let d = 1.0 + g * (g + k);
    [
        2.0 * g * (g + k) / d,
        2.0 * g / d,
        2.0 * g * g / d,
        m0,
        m1 / 2.0,
        m2 / 2.0,
    ]
}

// a sample through a state variable filter (the trapezoidal integrators ic1, the band, and ic2, the low, step to
// 2 v - ic of the band and the low v): svf_step of dsp_core::filter_model in the lanes of doubles
#[inline(always)]
fn tick(c: &[F64x2; 6], state: &mut [F64x2; 2], x: F64x2) -> F64x2 {
    let [c1, a2, a3, m0, h1, h2] = *c;
    let [ic1, ic2] = *state;
    let v3 = x - ic2;
    let n1 = (ic1 - c1 * ic1) + a2 * v3;
    let n2 = (ic2 + a2 * ic1) + a3 * v3;
    *state = [n1, n2];
    m0 * x + h1 * (ic1 + n1) + h2 * (ic2 + n2)
}

fn lanes(c: &[f64; 6]) -> [F64x2; 6] {
    c.map(F64x2::splat)
}

struct Band {
    index: usize,
    ty: u32,
    // log2 of Hz
    freq: Smoothed,
    reso: Smoothed,
    gain: Smoothed,
    // the design faded from (the one before a change of type) and the samples of the fade left
    fade: Option<([f64; 5], f64)>,
    // the design of the last segment, its coefficients; the steps of a design as they were last worked out (Hz of
    // the octaves of the frequency, the prewarped frequency of Hz, the amplitude of the gain)
    designed: [f64; 5],
    hz: Kept,
    warped: Kept,
    amp: Kept,
    coefs: [f64; 6],
    state: [F64x2; 2],
    // rendered in this block: not neutral, or moving
    moving: bool,
    // (the specs: the coefficients of a segment at once, a stair; the segments the coefficients went as lines in)
    #[cfg(test)]
    pub(crate) stairs: bool,
    #[cfg(test)]
    pub(crate) lined: usize,
    // (the specs: the designs of its knobs at their targets)
    #[cfg(test)]
    pub(crate) designs: usize,
}

impl Band {
    fn new(index: usize, params: &[f64; PARAMS], sample_rate: f64) -> Band {
        let [ty, freq, reso, gain] = BANDS[index].map(|key| finite(params[key]));
        let mut band = Band {
            index,
            ty: type_of(ty),
            freq: Smoothed::new(log2(clamp(freq, MIN_FREQ, MAX_FREQ)), GLIDE, sample_rate),
            reso: Smoothed::new(reso, GLIDE, sample_rate),
            gain: Smoothed::new(gain, GLIDE, sample_rate),
            fade: None,
            designed: [0.0; 5],
            hz: Kept::new(),
            warped: Kept::new(),
            amp: Kept::new(),
            coefs: [0.0; 6],
            state: [F64x2::default(); 2],
            moving: false,
            #[cfg(test)]
            stairs: false,
            #[cfg(test)]
            lined: 0,
            #[cfg(test)]
            designs: 0,
        };
        band.snap(sample_rate);
        band
    }

    // the knobs at their targets, the design of them
    fn snap(&mut self, sample_rate: f64) {
        self.freq.snap();
        self.reso.snap();
        self.gain.snap();
        self.fade = None;
        self.designed = design(
            self.index,
            self.ty,
            pow(2.0, self.freq.value),
            self.reso.value,
            self.gain.value,
            sample_rate,
        );
        self.coefs = coefs(self.designed);
        #[cfg(test)]
        {
            self.designs += 1;
        }
    }

    // whether one of its keys was among them
    fn set(&mut self, present: u32, values: &[f64; PARAMS], instant: bool) -> bool {
        let has = |key: usize| present & (1 << key) != 0;
        let keys = BANDS[self.index];
        let [ty, freq, reso, gain] = keys;
        if has(ty) {
            let next = type_of(finite(values[ty]));
            if next != self.ty {
                self.ty = next;
                // (from the design as it is: one in a fade too)
                self.fade = Some((self.designed, 0.0));
            }
        }
        if has(freq) {
            let octaves = log2(clamp(finite(values[freq]), MIN_FREQ, MAX_FREQ));
            self.freq.set(octaves, instant, None);
        }
        if has(reso) {
            self.reso.set(finite(values[reso]), instant, None);
        }
        if has(gain) {
            self.gain.set(finite(values[gain]), instant, None);
        }
        keys.iter().any(|&key| has(key))
    }

    // the input as it is, its knobs at rest: a shelf or a peak at 0 dB
    fn neutral(&self) -> bool {
        self.ty != PASS && self.gain.value == 0.0 && self.gain.from == 0.0 && self.fade.is_none()
    }

    // the block of `frames` starts: its glides step; `lines` the offsets of the frequency (octaves), the resonance
    // and the gain. It moves when what moves changes its sound: a pass reads no gain, a shelf or a peak at 0 dB
    // (no line on its gain) is the input whatever its frequency and resonance
    fn start(&mut self, frames: f64, lines: [Option<&[f64]>; 3]) {
        let [freq, reso, gain] =
            [&mut self.freq, &mut self.reso, &mut self.gain].map(|knob| knob.step(frames));
        let gain = self.ty != PASS && (gain || lines[2].is_some());
        let shape = freq || reso || lines[0].is_some() || lines[1].is_some();
        self.moving = self.fade.is_some() || gain || (shape && !self.neutral());
        if !self.moving && self.neutral() {
            // (a band that sounds again starts from rest)
            self.state = [F64x2::default(); 2];
        }
    }

    // the segment of `data` that ends `end` samples into the block of `frames`
    fn segment(
        &mut self,
        data: &mut [F64x2],
        end: usize,
        frames: usize,
        lines: [Option<&[f64]>; 3],
        rate: f64,
    ) {
        if !self.moving {
            if !self.neutral() {
                self.rest(data);
            }
            return;
        }
        // the knobs at the last sample of the segment, moved by their lines (a step of the design whose knob stood
        // still is not worked out again)
        let share = end as f64 / frames as f64;
        let along = |knob: &Smoothed| knob.from + (knob.value - knob.from) * share;
        let line = |offsets: Option<&[f64]>| offsets.map_or(0.0, |offsets| offsets[end - 1]);
        let hz = self
            .hz
            .of(along(&self.freq) + line(lines[0]), |octaves| pow(2.0, octaves));
        let t = self.warped.of(hz, |hz| warp(hz, rate));
        let a = if self.ty == PASS {
            1.0
        } else {
            self.amp.of(along(&self.gain) + line(lines[2]), amplitude)
        };
        let mut designed = design_of(self.index, self.ty, t, along(&self.reso) + line(lines[1]), a);
        if let Some((from, done)) = &mut self.fade {
            *done += data.len() as f64;
            let length = FADE * rate;
            if *done >= length {
                self.fade = None;
            } else {
                let share = *done / length;
                for (value, from) in designed.iter_mut().zip(from.iter()) {
                    *value = from + (*value - from) * share;
                }
            }
        }
        self.designed = designed;
        let target = coefs(designed);
        #[cfg(test)]
        if self.stairs {
            self.coefs = target;
        }
        if target == self.coefs {
            // (the knobs moved nothing: lines that stand, a glide whose steps came out the same)
            self.rest(data);
            return;
        }
        #[cfg(test)]
        {
            self.lined += 1;
        }
        // the coefficients as lines to the design, a step a sample, at it on the last one
        let count = data.len() as f64;
        let mut c = lanes(&self.coefs);
        let step = lanes(&core::array::from_fn(|i| (target[i] - self.coefs[i]) / count));
        let mut state = self.state;
        let last = data.len() - 1;
        for x in data[..last].iter_mut() {
            for (value, step) in c.iter_mut().zip(step.iter()) {
                *value = *value + *step;
            }
            *x = tick(&c, &mut state, *x);
        }
        data[last] = tick(&lanes(&target), &mut state, data[last]);
        self.state = state.map(F64x2::flush);
        self.coefs = target;
    }

    // a segment at the coefficients as they stand
    fn rest(&mut self, data: &mut [F64x2]) {
        let c = lanes(&self.coefs);
        let mut state = self.state;
        for x in data.iter_mut() {
            *x = tick(&c, &mut state, *x);
        }
        self.state = state.map(F64x2::flush);
    }
}

pub struct Eq {
    sample_rate: f64,
    bands: [Band; 2],
    // the gain of the level (4 v²)
    level: Smoothed,
    idle: bool,
    // (the specs: the samples a moving band is designed every, SEGMENT at most)
    #[cfg(test)]
    pub(crate) every: usize,
}

/// the gain of a knob of the level: 4 v² (0 dB at a half; the EQ and the filter)
pub(crate) fn level_gain(knob: f64) -> f64 {
    let knob = max(0.0, finite(knob));
    4.0 * (knob * knob)
}

impl Eq {
    pub fn new(sample_rate: f64, params: &[f64; PARAMS]) -> Eq {
        Eq {
            sample_rate,
            bands: [
                Band::new(0, params, sample_rate),
                Band::new(1, params, sample_rate),
            ],
            level: Smoothed::new(level_gain(params[LEVEL]), GLIDE, sample_rate),
            idle: true,
            #[cfg(test)]
            every: SEGMENT,
        }
    }

    pub fn idle(&self) -> bool {
        self.idle
    }

    /// params by key (the bits of `present`); an idle EQ takes them at once, designing the bands they are of alone
    /// (the others are at their designs since it went idle: a route on the level sets it every block)
    pub fn set(&mut self, present: u32, values: &[f64; PARAMS]) {
        for band in self.bands.iter_mut() {
            if band.set(present, values, self.idle) && self.idle {
                band.snap(self.sample_rate);
            }
        }
        if present & (1 << LEVEL) != 0 {
            self.level.set(level_gain(values[LEVEL]), self.idle, None);
        }
    }

    fn snap(&mut self) {
        for band in self.bands.iter_mut() {
            band.snap(self.sample_rate);
        }
        self.level.snap();
    }

    /// the sound before is forgotten: the next one starts at the params as they are then
    pub fn forget(&mut self) {
        for band in self.bands.iter_mut() {
            band.state = [F64x2::default(); 2];
        }
        self.snap();
        self.idle = true;
    }

    /// a block; `moves` the lines of the routes (`Moves::eq`: the frequency, the resonance and the gain of each
    /// band)
    pub fn process(
        &mut self,
        in_l: &[f32],
        in_r: &[f32],
        out_l: &mut [f32],
        out_r: &mut [f32],
        moves: &Moves,
    ) {
        let frames = in_l.len();
        if frames == 0 {
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
        let lines = |band: usize| -> [Option<&[f64]>; 3] { core::array::from_fn(|i| moves.eq[band * 3 + i]) };
        let n = frames as f64;
        for (index, band) in self.bands.iter_mut().enumerate() {
            band.start(n, lines(index));
        }
        let leveled = self.level.step(n) || self.level.value != 1.0;
        let (from, to) = (self.level.from, self.level.value);
        // the bands at 0 dB and the level at 0 dB, all of them at rest: the input as it is (one not finite goes the
        // way of the others, out as silence)
        if !leveled && peak.is_finite() && self.bands.iter().all(|band| !band.moving && band.neutral()) {
            out_l.copy_from_slice(in_l);
            out_r.copy_from_slice(in_r);
            if quiet {
                self.forget();
            }
            return;
        }
        #[cfg(not(test))]
        let every = SEGMENT;
        #[cfg(test)]
        let every = self.every;
        let mut start = 0;
        while start < frames {
            let count = every.min(frames - start);
            let end = start + count;
            let mut data = [F64x2::default(); SEGMENT];
            let data = &mut data[..count];
            for (i, x) in data.iter_mut().enumerate() {
                *x = F64x2::new(in_l[start + i] as f64, in_r[start + i] as f64);
            }
            for (index, band) in self.bands.iter_mut().enumerate() {
                band.segment(data, end, frames, lines(index), self.sample_rate);
            }
            if leveled && from == to {
                let gain = F64x2::splat(to);
                for x in data.iter_mut() {
                    *x = *x * gain;
                }
            } else if leveled {
                for (i, x) in data.iter_mut().enumerate() {
                    let gain = from + (to - from) * ((start + i + 1) as f64 / n);
                    *x = *x * F64x2::splat(gain);
                }
            }
            // (a sample under TINY goes out as 0: the tail of a channel silent alone comes to the denormals of f32
            // while its states are still far over those of doubles)
            for (i, x) in data.iter().enumerate() {
                let x = x.flush_under(TINY as f64);
                out_l[start + i] = x.lo() as f32;
                out_r[start + i] = x.hi() as f32;
            }
            start = end;
        }
        // (a NaN is not silent)
        let output = louder(loudest(out_l), loudest(out_r)) as f64;
        if !output.is_finite() {
            out_l.fill(0.0);
            out_r.fill(0.0);
            self.forget();
        } else if quiet && output < SILENCE {
            self.forget();
        }
    }
}

#[cfg(test)]
mod tests;
