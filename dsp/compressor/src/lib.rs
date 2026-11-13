//! The compressor, as measured on the Audio Unit (dsp/measurements/compressor.json, the specs hold it to them). A
//! highpass of one pole at 12 Hz, then one of two circuits:
//! - one band: the level of the louder channel at every sample against the threshold, its reduction (dB) smoothed
//!   by the attack (twice as fast as its knob) and the release, the gain × the makeup;
//! - three bands (Linkwitz-Riley crossovers of the 4th order, their sum an allpass): in each the mean square of both
//!   channels over 5 ms, its peak held and released, compressed down over a threshold and up under another (the
//!   gain held to -40..+36 dB: a silence stays one), × the gain of the band × the makeup. The Attack knob does
//!   nothing here.
//!
//! The mix is inside: the dry signal is the sum of the bands before their gains, in phase with them (a mix outside
//! would notch at the crossovers); then the level. Deliberate differences: the ratio stops before the limiter of the
//! Audio Unit (another circuit, with a latency), the thresholds, ratios and dead bands of each band are its defaults.
//!
//! All of it in lanes of f32 (dsp_core::simd): the band splitting is state variable filters (a low cutoff holds
//! in f32), four samples of the one band circuit are a lane each for its log2 and 2^x (math.rs: bits and
//! polynomials, no jsmath in a sample), the three bands are the lanes of one detector, their gain worked out every
//! SPAN samples and linear between. A fade between the circuits runs both. The C ABI of a stereo core and fx_set,
//! fx_clear, fx_idle, fx_meter; the params of fx_new and fx_set come through fx_command (compressor-wasm.ts)

#![cfg_attr(target_arch = "wasm32", no_std)]

extern crate alloc;

pub mod math;

use alloc::{boxed::Box, vec, vec::Vec};
use wasm_rt as _;

use dsp_core::blocks::{louder, loudest, Smoothed};
use dsp_core::io::StereoIo;
use dsp_core::simd::{F32x4, U32x4};
use jsmath::{cos, exp, log10, log2, max, min, pow, sin, PI, SQRT2};
use math::{exp2, log2 as log2_lanes};

// the params, in the order of COMPRESSOR_KEYS of compressor-wasm.ts
pub const MULTI: usize = 0;
pub const THRESH: usize = 1;
pub const RATIO: usize = 2;
pub const ATTACK: usize = 3;
pub const RELEASE: usize = 4;
pub const GAIN: usize = 5;
pub const XLOW: usize = 6;
pub const XHIGH: usize = 7;
pub const BELOW: usize = 8;
pub const LOW: usize = 9;
pub const MID: usize = 10;
pub const HIGH: usize = 11;
pub const LEVEL: usize = 12;
pub const MIX: usize = 13;
pub const PARAMS: usize = 14;

const GLIDE: f64 = 0.01;
const SILENCE: f32 = 1e-10;
const BLOCK: usize = 128;
/// the samples of a span of the bands: their gains are worked out at its end, linear from those of the end
/// before (their detector is a mean of 5 ms: a point every sixth of a millisecond follows it)
pub const SPAN: usize = 8;
// a mean square held that grows this many times over a span (3 dB) is a hit: its span gets the gains of every
// sample (a line from the gains of before would lift its first samples by what the quiet before it was lifted)
const JUMP: f32 = 2.0;
// the rack of the Audio Unit works this much under its output: a level of ours is one of its own × this
const SCALE: f64 = 1.1745;
// dB per doubling of an amplitude: the levels and the gains are log2 here
const DB: f64 = 6.020599913279624;
const HIGHPASS: f64 = 12.0;
// one band: the knob at 1 is a threshold of -120 dB, the reduction under this is none (its release ends)
const FLOOR_DB: f64 = -120.0;
const RELEASED: f32 = 1e-4 / DB as f32;
// the attack of the one band circuit: its time constant is this share of the knob
const ATTACK_SHARE: f64 = 0.5;
// the makeup gain: 1 at the knob 0, 32 (30.1 dB) at 1
const MAKEUP: f64 = 31.0;
// three bands (low, mid, high): the thresholds over which a band is compressed down at the knob 0.5 (they scale
// with its square), the dead band under each down to the threshold of the upward compression, the seconds of the
// mean square, the release of each band as a share of the knob (of its mean square: half of it for a level)
const ABOVE: [f64; 3] = [-33.8, -30.2, -35.5];
const DEAD: [f64; 3] = [7.0, 11.6, 5.3];
const MEAN: f64 = 0.005;
const RELEASE_SHARE: [f64; 3] = [0.48, 0.48, 0.225];
const GAIN_FLOOR: f64 = -40.0;
const GAIN_CEILING: f64 = 36.0;
// (log2, as the gains of the bands are worked out)
const FLOOR: f32 = (GAIN_FLOOR / DB) as f32;
const CEILING: f32 = (GAIN_CEILING / DB) as f32;
const MIN_CROSSOVER: f64 = 20.0;

// the lanes of the bands: low, mid, high (the fourth is none)
#[inline(always)]
fn bands(low: f32, mid: f32, high: f32) -> F32x4 {
    F32x4::new(low, mid, high, 0.0)
}

// A section of a crossover (Butterworth, 2nd order) as a state variable filter: the trapezoidal integrators ic1
// (the band) and ic2 (the low) of the lanes step, returns twice the band and twice the low. As the filter of a
// voice: a state is three operations from the one before, its small shares are added to it (a low cutoff holds
// in f32)
#[derive(Clone, Copy, Default)]
struct Section {
    ic1: F32x4,
    ic2: F32x4,
}

#[derive(Clone, Copy, Default)]
struct Cutoff {
    c1: F32x4,
    a2: F32x4,
    a3: F32x4,
}

impl Cutoff {
    // with g the prewarped cutoff, k = √2 the damping and d = 1 + g (g + k): 2 g (g + k) / d, 2 g / d, 2 g² / d
    fn new(frequency: f64, sample_rate: f64) -> Cutoff {
        let w = PI * frequency / sample_rate;
        let g = sin(w) / cos(w);
        let d = 1.0 + g * (g + SQRT2);
        Cutoff {
            c1: F32x4::splat((2.0 * g * (g + SQRT2) / d) as f32),
            a2: F32x4::splat((2.0 * g / d) as f32),
            a3: F32x4::splat((2.0 * g * g / d) as f32),
        }
    }
}

impl Section {
    #[inline(always)]
    fn tick(&mut self, c: &Cutoff, x: F32x4) -> (F32x4, F32x4) {
        let v3 = x - self.ic2;
        let n1 = (self.ic1 - c.c1 * self.ic1) + c.a2 * v3;
        let n2 = (self.ic2 + c.a2 * self.ic1) + c.a3 * v3;
        let twice = (self.ic1 + n1, self.ic2 + n2);
        self.ic1 = n1;
        self.ic2 = n2;
        twice
    }

    fn flush(&mut self) {
        self.ic1 = self.ic1.flush();
        self.ic2 = self.ic2.flush();
    }
}

// the shares of the input, of twice the band and of twice the low in an output of a section, per lane
#[derive(Clone, Copy)]
struct Mix {
    x: F32x4,
    band: F32x4,
    low: F32x4,
}

impl Mix {
    #[inline(always)]
    fn of(&self, x: F32x4, (band, low): (F32x4, F32x4)) -> F32x4 {
        self.x * x + self.band * band + self.low * low
    }
}

const K: f32 = core::f32::consts::SQRT_2;

// the lowpass in the lanes 0 and 1, the highpass in 2 and 3
fn split() -> Mix {
    Mix {
        x: F32x4::new(0.0, 0.0, 1.0, 1.0),
        band: F32x4::new(0.0, 0.0, -K / 2.0, -K / 2.0),
        low: F32x4::new(0.5, 0.5, -0.5, -0.5),
    }
}
// the allpass (what a lowpass and a highpass of the 4th order sum to) in the lanes 0 and 1, the lowpass in 2 and 3
fn pass_and_low() -> Mix {
    Mix {
        x: F32x4::new(1.0, 1.0, 0.0, 0.0),
        band: F32x4::new(-K, -K, 0.0, 0.0),
        low: F32x4::new(0.0, 0.0, 0.5, 0.5),
    }
}

// what a block works with, from the params at its end (worked out when one moved)
#[derive(Clone, Copy, Default)]
struct Curve {
    // one band: the threshold (log2 of a level of ours), the share of the level over it taken off
    threshold: f32,
    slope: f32,
    attack: f32,
    release: f32,
    // three bands: the thresholds (log2), the share of the level under the lower one added, the steps of the mean
    // square and of its release
    above: F32x4,
    below: F32x4,
    up: f32,
    mean: f32,
    held: F32x4,
}

// the gains of a block at one of its ends: of the dry signal, of the compressed one, of each band
#[derive(Clone, Copy, Default)]
struct Gains {
    dry: f32,
    wet: f32,
    bands: [f32; 3],
}

/// what the meter shows: the gain of each band (dB; all three the one of the one band circuit) and the peak of
/// the input of the last block
#[derive(Clone, Copy, Default)]
pub struct Meter {
    pub gains: [f32; 3],
    pub input: f32,
}

pub struct Compressor {
    sample_rate: f64,
    values: [Smoothed; PARAMS],
    curve: Curve,
    gains: Gains,
    low: Cutoff,
    high: Cutoff,
    // the highpass: the state of the lowpass it takes off (L, R), the share of a step of it
    blocked: F32x4,
    highpass: f32,
    // one band: the reduction (log2, 0 and up)
    reduction: f32,
    // three bands: the sections (the first and second of each crossover), the mean squares, their peaks held, the
    // gains of the bands at the end of the last span
    sections: [Section; 4],
    mean: F32x4,
    held: F32x4,
    band_gains: F32x4,
    // the gains of the bands (log2) at the last point
    shown: F32x4,
    // the circuits that rendered the last block: one band, three bands
    running: [bool; 2],
    // the input after the highpass while both circuits render
    work: [Vec<f32>; 2],
    idle: bool,
    quiet_frames: f64,
    meter: Meter,
    #[cfg(test)]
    every_sample: bool,
    pub io: StereoIo,
}

// a param as it is kept: the mode is 0 or 1
fn kept(key: usize, value: f64) -> f64 {
    if key != MULTI {
        value
    } else if value >= 0.5 {
        1.0
    } else {
        0.0
    }
}

impl Compressor {
    pub fn new(sample_rate: f64, params: &[f64; PARAMS]) -> Compressor {
        let mut compressor = Compressor {
            sample_rate,
            values: core::array::from_fn(|key| Smoothed::new(kept(key, params[key]), GLIDE, sample_rate)),
            curve: Curve::default(),
            gains: Gains::default(),
            low: Cutoff::default(),
            high: Cutoff::default(),
            blocked: F32x4::splat(0.0),
            highpass: {
                // g / (1 + g) of the prewarped cutoff g
                let w = PI * HIGHPASS / sample_rate;
                let g = sin(w) / cos(w);
                (g / (1.0 + g)) as f32
            },
            reduction: 0.0,
            sections: [Section::default(); 4],
            mean: F32x4::splat(0.0),
            held: F32x4::splat(0.0),
            band_gains: F32x4::splat(0.0),
            shown: F32x4::splat(0.0),
            running: [false; 2],
            work: [Vec::new(), Vec::new()],
            idle: true,
            quiet_frames: 0.0,
            meter: Meter::default(),
            #[cfg(test)]
            every_sample: false,
            io: StereoIo::default(),
        };
        compressor.grow(BLOCK);
        compressor.update();
        compressor
    }

    pub fn idle(&self) -> bool {
        self.idle
    }

    pub fn meter(&self) -> Meter {
        self.meter
    }

    // the buffers of blocks of `frames` (allocates: not while a block renders)
    fn grow(&mut self, frames: usize) {
        for buffer in self.work.iter_mut() {
            if buffer.len() < frames {
                *buffer = vec![0.0; frames];
            }
        }
    }

    fn value(&self, key: usize) -> f64 {
        self.values[key].value
    }

    // the curve, the crossovers and the gains of the params as they are at the end of the block
    fn update(&mut self) {
        let rate = self.sample_rate;
        let scale = log2(SCALE);
        let step = |seconds: f64| 1.0 - exp(-1.0 / (max(seconds, 1e-6) * rate));
        let slope = 1.0 - 1.0 / max(self.value(RATIO), 1.0);
        let knob = min(max(self.value(THRESH), 0.0), 1.0);
        let threshold = max(FLOOR_DB, 60.0 * log10(max(1.0 - knob, 1e-9)));
        let release = self.value(RELEASE) * 0.001;
        let squared = (2.0 * knob) * (2.0 * knob);
        let above: [f64; 3] = core::array::from_fn(|band| ABOVE[band] * squared / DB + scale);
        let held: [f64; 3] = core::array::from_fn(|band| 1.0 - step(RELEASE_SHARE[band] * release));
        self.curve = Curve {
            threshold: (threshold / DB + scale) as f32,
            slope: slope as f32,
            attack: step(ATTACK_SHARE * self.value(ATTACK) * 0.001) as f32,
            release: step(release) as f32,
            above: bands(above[0] as f32, above[1] as f32, above[2] as f32),
            below: bands(
                (above[0] - DEAD[0] / DB) as f32,
                (above[1] - DEAD[1] / DB) as f32,
                (above[2] - DEAD[2] / DB) as f32,
            ),
            up: min(max(self.value(BELOW), 0.0), 1.0) as f32,
            mean: step(MEAN) as f32,
            held: bands(held[0] as f32, held[1] as f32, held[2] as f32),
        };
        // the crossovers: the low one under 0.45 of the rate, the high one never under it
        let low = min(max(self.value(XLOW), MIN_CROSSOVER), 0.45 * rate);
        let high = min(max(self.value(XHIGH), low), 0.45 * rate);
        self.low = Cutoff::new(low, rate);
        self.high = Cutoff::new(high, rate);
        // the gains
        let mix = min(max(self.value(MIX), 0.0), 1.0);
        let level = 4.0 * self.value(LEVEL) * self.value(LEVEL);
        let makeup = 1.0 + MAKEUP * min(max(self.value(GAIN), 0.0), 1.0);
        self.gains = Gains {
            dry: ((1.0 - mix) * level) as f32,
            wet: (mix * makeup * level) as f32,
            bands: [LOW, MID, HIGH].map(|key| pow(10.0, self.value(key) / 20.0) as f32),
        };
    }

    /// the tail is forgotten (a preset switch, the output muted): the state is empty, the next sound starts at the
    /// params as they are then, no glide from those of before
    pub fn forget(&mut self) {
        self.blocked = F32x4::splat(0.0);
        self.reduction = 0.0;
        self.sections = [Section::default(); 4];
        self.mean = F32x4::splat(0.0);
        self.held = F32x4::splat(0.0);
        self.shown = F32x4::splat(0.0);
        self.running = [false; 2];
        // (the meter of the block that ends idle is the one of a core at rest: the worklet posts it once)
        self.meter.gains = [0.0; 3];
        self.idle = true;
    }

    /// set(changes): the params of `changes` whose bit is in `present` (1 << key)
    pub fn set(&mut self, present: u32, changes: &[f64; PARAMS]) {
        for key in 0..PARAMS {
            if present & (1 << key) != 0 {
                self.values[key].set(kept(key, changes[key]), self.idle, None);
            }
        }
    }

    // The one band circuit over `frames` of `source` (the input after the highpass) into the outputs: × `weight`
    // (the fade between the circuits, per sample from weight.0 by weight.1). Four samples are a lane each: their
    // levels (log2) and their gains (2^x) in the lanes, the reduction smoothed one after another in between
    #[allow(clippy::too_many_arguments)]
    fn one_band(
        &mut self,
        source: [&[f32]; 2],
        out_l: &mut [f32],
        out_r: &mut [f32],
        frames: usize,
        from: Gains,
        steps: Gains,
        weight: (f32, f32),
    ) {
        let curve = self.curve;
        let threshold = F32x4::splat(curve.threshold);
        let slope = F32x4::splat(curve.slope);
        let zero = F32x4::splat(0.0);
        let ramp = F32x4::new(1.0, 2.0, 3.0, 4.0);
        let four = F32x4::splat(4.0);
        let mut dry = F32x4::splat(from.dry) + F32x4::splat(steps.dry) * ramp;
        let mut wet = F32x4::splat(from.wet) + F32x4::splat(steps.wet) * ramp;
        let mut share = F32x4::splat(weight.0) + F32x4::splat(weight.1) * ramp;
        let (dry_step, wet_step, share_step) = (
            F32x4::splat(steps.dry) * four,
            F32x4::splat(steps.wet) * four,
            F32x4::splat(weight.1) * four,
        );
        let mut reduction = self.reduction;
        let mut s = 0;
        while s < frames {
            let count = (frames - s).min(4);
            let (l, r) = if count == 4 {
                (F32x4::load(&source[0][s..]), F32x4::load(&source[1][s..]))
            } else {
                let mut pad = [[0.0f32; 4]; 2];
                pad[0][..count].copy_from_slice(&source[0][s..s + count]);
                pad[1][..count].copy_from_slice(&source[1][s..s + count]);
                (F32x4::load(&pad[0]), F32x4::load(&pad[1]))
            };
            let level = log2_lanes(l.abs().max(r.abs()));
            let targets = ((level - threshold).max(zero) * slope).lanes();
            let mut reductions = [0.0f32; 4];
            for k in 0..count {
                let target = targets[k];
                if target > reduction {
                    reduction += (target - reduction) * curve.attack;
                } else {
                    reduction += (target - reduction) * curve.release;
                    if reduction < RELEASED {
                        reduction = 0.0;
                    }
                }
                reductions[k] = reduction;
            }
            let gain = (dry + wet * exp2(zero - F32x4::load(&reductions))) * share;
            let (left, right) = (l * gain, r * gain);
            if count == 4 {
                left.store(&mut out_l[s..]);
                right.store(&mut out_r[s..]);
            } else {
                out_l[s..s + count].copy_from_slice(&left.lanes()[..count]);
                out_r[s..s + count].copy_from_slice(&right.lanes()[..count]);
            }
            dry = dry + dry_step;
            wet = wet + wet_step;
            share = share + share_step;
            s += 4;
        }
        self.reduction = reduction;
    }

    // the gains of the bands (dry + wet × the gain of its level × its own) for the mean squares held now
    #[inline(always)]
    fn point(&mut self, gains: &Gains) -> F32x4 {
        let curve = &self.curve;
        let level = log2_lanes(self.held) * F32x4::splat(0.5);
        let zero = F32x4::splat(0.0);
        let down = (level - curve.above).max(zero) * F32x4::splat(curve.slope);
        let up = (curve.below - level).max(zero) * F32x4::splat(curve.up);
        let gain = (up - down).max(F32x4::splat(FLOOR)).min(F32x4::splat(CEILING));
        self.shown = gain;
        let own = bands(gains.bands[0], gains.bands[1], gains.bands[2]);
        // (the fourth lane is no band: its gain is 0)
        (F32x4::splat(gains.dry) + F32x4::splat(gains.wet) * exp2(gain) * own) * bands(1.0, 1.0, 1.0)
    }

    // The three band circuit over `frames` of `source` into the outputs (added to them × `weight` while the
    // circuits fade, else written). A sample is four ticks of sections in the lanes (L, R, L, R):
    // the low crossover, the lowpass of its first section in the lanes 0 and 1, the highpass in 2 and 3, twice;
    // then the high crossover: the low band through its allpass, what is over the low crossover split again.
    // The bands of up to SPAN samples are kept, the gains of their end worked out, each sample then gets the
    // gains on the line from those of the end before (no lag behind the detector; a block ends a span). A span of
    // a hit (JUMP) gets the gains of each of its samples instead (as measured: `onset` and `gaps` of
    // dsp/measurements/compressor.json)
    #[allow(clippy::too_many_arguments)]
    fn three_bands(
        &mut self,
        source: [&[f32]; 2],
        out_l: &mut [f32],
        out_r: &mut [f32],
        frames: usize,
        from: Gains,
        steps: Gains,
        weight: Option<(f32, f32)>,
    ) {
        let (low, high_cut) = (self.low, self.high);
        let (split, pass_and_low) = (split(), pass_and_low());
        let mean_step = F32x4::splat(self.curve.mean);
        let held_share = self.curve.held;
        let [mut a, mut b, mut c, mut d] = self.sections;
        let (mut mean, mut held) = (self.mean, self.held);
        let mut band_gains = self.band_gains;
        let mut lefts = [F32x4::splat(0.0); SPAN];
        let mut rights = [F32x4::splat(0.0); SPAN];
        #[cfg(test)]
        let span = if self.every_sample { 1 } else { SPAN };
        #[cfg(not(test))]
        let span = SPAN;
        let mut helds = [F32x4::splat(0.0); SPAN];
        let any = |mask: U32x4| {
            let [a, b, c, d] = mask.lanes();
            (a | b | c | d) != 0
        };
        let mut write = |at: usize, left: f32, right: f32| match weight {
            Some((from, step)) => {
                let share = from + step * (at + 1) as f32;
                out_l[at] += left * share;
                out_r[at] += right * share;
            }
            None => {
                out_l[at] = left;
                out_r[at] = right;
            }
        };
        let now = |t: f32| Gains {
            dry: from.dry + steps.dry * t,
            wet: from.wet + steps.wet * t,
            bands: core::array::from_fn(|band| from.bands[band] + steps.bands[band] * t),
        };
        let mut s = 0;
        while s < frames {
            let count = (frames - s).min(span);
            let held_before = held;
            for k in 0..count {
                let (l, r) = (source[0][s + k], source[1][s + k]);
                let x = F32x4::new(l, r, l, r);
                let first = split.of(x, a.tick(&low, x));
                // (low L, low R, the rest L, the rest R)
                let second = split.of(first, b.tick(&low, first));
                let third = c.tick(&high_cut, second);
                // the low band through the allpass of the high crossover, the lowpass of the rest
                let passed = pass_and_low.of(second, third);
                // (its highpass in the lanes 2 and 3, the only ones read)
                let upper = split.of(second, third);
                // (the lowpass of the rest L, R, its highpass L, R) → (mid L, mid R, high L, high R)
                let fourth = passed.pick::<2, 3, 6, 7>(upper);
                let last = split.of(fourth, d.tick(&high_cut, fourth));
                let left = passed.pick::<0, 4, 6, 6>(last);
                let right = passed.pick::<1, 5, 7, 7>(last);
                mean = mean + (left * left + right * right - mean) * mean_step;
                held = mean.max(held * held_share);
                lefts[k] = left;
                rights[k] = right;
                helds[k] = held;
            }
            if any(held.over(held_before * F32x4::splat(JUMP))) {
                for k in 0..count {
                    self.held = helds[k];
                    band_gains = self.point(&now((s + k + 1) as f32));
                    write(
                        s + k,
                        (lefts[k] * band_gains).sum(),
                        (rights[k] * band_gains).sum(),
                    );
                }
                self.running[1] = true;
                s += count;
                continue;
            }
            self.held = held;
            let target = self.point(&now((s + count) as f32));
            let band_step = if self.running[1] {
                (target - band_gains) * F32x4::splat(1.0 / count as f32)
            } else {
                // the first span of a circuit that starts: no gains to come from
                band_gains = target;
                self.running[1] = true;
                F32x4::splat(0.0)
            };
            for k in 0..count {
                band_gains = band_gains + band_step;
                write(
                    s + k,
                    (lefts[k] * band_gains).sum(),
                    (rights[k] * band_gains).sum(),
                );
            }
            // (the end of the line to the bit: the next one starts there)
            band_gains = target;
            s += count;
        }
        for section in [&mut a, &mut b, &mut c, &mut d] {
            section.flush();
        }
        self.sections = [a, b, c, d];
        self.mean = mean.flush();
        self.held = held.flush();
        self.band_gains = band_gains;
    }

    // at rest: nothing of the sound of before is left in a gain (the one band released; the mean squares held
    // under the levels where the gains of the bands stop changing, or flushed to 0: a small Below never lifts a
    // band to the ceiling of the gain, its gain stops only there)
    fn rested(&self) -> bool {
        if self.running[0] && self.reduction != 0.0 {
            return false;
        }
        if !self.running[1] {
            return true;
        }
        let held = self.held.lanes();
        let levels = (log2_lanes(self.held) * F32x4::splat(0.5)).lanes();
        let curve = &self.curve;
        let (above, below) = (curve.above.lanes(), curve.below.lanes());
        (0..3).all(|band| {
            let flat = if curve.up > 0.0 {
                below[band] - CEILING / curve.up
            } else {
                above[band]
            };
            held[band] == 0.0 || levels[band] < flat
        })
    }

    pub fn process(&mut self, in_l: &[f32], in_r: &[f32], out_l: &mut [f32], out_r: &mut [f32]) {
        let frames = out_l.len();
        let n = frames as f64;
        let input = louder(loudest(in_l), loudest(in_r));
        self.meter.input = input;
        // (a NaN is not quiet)
        self.quiet_frames = if input < SILENCE {
            self.quiet_frames + n
        } else {
            0.0
        };
        if self.idle {
            if self.quiet_frames != 0.0 {
                out_l.fill(0.0);
                out_r.fill(0.0);
                self.meter.gains = [0.0; 3];
                return;
            }
            self.idle = false;
            for value in self.values.iter_mut() {
                value.snap();
            }
            self.update();
        }

        let mut moved = false;
        for value in self.values.iter_mut() {
            moved |= value.step(n);
        }
        let from = self.gains;
        if moved {
            self.update();
        }
        let fade = (self.values[MULTI].from, self.values[MULTI].value);
        let to = self.gains;
        let inverse = 1.0 / frames as f32;
        let steps = Gains {
            dry: (to.dry - from.dry) * inverse,
            wet: (to.wet - from.wet) * inverse,
            bands: core::array::from_fn(|band| (to.bands[band] - from.bands[band]) * inverse),
        };

        // the highpass, into the buffers the circuits read
        self.grow(frames);
        let [mut work_l, mut work_r] = core::mem::take(&mut self.work);
        let step = F32x4::splat(self.highpass);
        let mut blocked = self.blocked;
        for s in 0..frames {
            let x = F32x4::new(in_l[s], in_r[s], 0.0, 0.0);
            // a trapezoidal integrator: the lowpass is the state and a step, the state then a step further
            let v = (x - blocked) * step;
            let low = blocked + v;
            blocked = low + v;
            let [l, r, ..] = (x - low).lanes();
            work_l[s] = l;
            work_r[s] = r;
        }
        self.blocked = blocked.flush();

        let needed = [fade.0 < 1.0 || fade.1 < 1.0, fade.0 > 0.0 || fade.1 > 0.0];
        if needed[0] && !self.running[0] {
            self.reduction = 0.0;
        }
        if needed[1] && !self.running[1] {
            self.sections = [Section::default(); 4];
            self.mean = F32x4::splat(0.0);
            self.held = F32x4::splat(0.0);
        }
        self.running[0] = needed[0];
        if !needed[1] {
            self.running[1] = false;
        }
        let source = [&work_l[..frames], &work_r[..frames]];
        if needed[0] && needed[1] {
            // a fade between the circuits: the one band × its share, the bands added × theirs
            let share = ((fade.1 - fade.0) / n) as f32;
            let single = (1.0 - fade.0 as f32, -share);
            self.one_band(source, out_l, out_r, frames, from, steps, single);
            self.three_bands(
                source,
                out_l,
                out_r,
                frames,
                from,
                steps,
                Some((fade.0 as f32, share)),
            );
        } else if needed[0] {
            self.one_band(source, out_l, out_r, frames, from, steps, (1.0, 0.0));
        } else {
            self.three_bands(source, out_l, out_r, frames, from, steps, None);
        }
        self.work = [work_l, work_r];
        let single = -self.reduction * DB as f32;
        let shown = self.shown.lanes();
        self.meter.gains = core::array::from_fn(|band| {
            let bands = shown[band] * DB as f32;
            let share = fade.1 as f32;
            single * (1.0 - share) + bands * share
        });

        // the last line: a block that isn't finite (its input is: process_io; NaN through a path no one saw) would
        // stay in the state for good: forgotten, the block is silence
        let output = louder(loudest(out_l), loudest(out_r));
        if !output.is_finite() {
            self.forget();
            out_l.fill(0.0);
            out_r.fill(0.0);
            return;
        }

        // silent in and out, the gains at rest: nothing to remember (a param that still glides, one a route moves
        // at every block, keeps no core awake: the next sound starts at the params as they are then)
        if self.quiet_frames > n && output < SILENCE && self.rested() {
            self.forget();
        }
    }

    fn process_io(&mut self) {
        let mut io = core::mem::take(&mut self.io);
        // (NaN or an infinity of the graph as 0: one would silence the effect for good)
        io.finite_inputs();
        let (in_l, in_r, out_l, out_r) = io.split();
        self.process(in_l, in_r, out_l, out_r);
        self.io = io;
    }
}

// the params of fx_new and of fx_set in the order of the keys, after the bits of the keys fx_set changes (1 << key),
// written by the JS wrapper; fx_meter writes what it shows into its first values
static mut COMMAND: [f64; PARAMS + 1] = [0.0; PARAMS + 1];

fn command() -> (u32, [f64; PARAMS]) {
    // SAFETY: one thread (the audio thread of the scope); the wrapper writes it right before the call reading it
    let command = unsafe { *core::ptr::addr_of!(COMMAND) };
    (command[0] as u32, core::array::from_fn(|key| command[1 + key]))
}

#[no_mangle]
pub extern "C" fn fx_command() -> *mut f64 {
    core::ptr::addr_of_mut!(COMMAND) as *mut f64
}

/// a compressor at the rate of the context, its params in the command buffer
#[no_mangle]
pub extern "C" fn fx_new(sample_rate: f64) -> *mut Compressor {
    Box::into_raw(Box::new(Compressor::new(sample_rate, &command().1)))
}

/// # Safety
/// `compressor` comes from fx_new and was not freed
#[no_mangle]
pub unsafe extern "C" fn fx_free(compressor: *mut Compressor) {
    drop(Box::from_raw(compressor));
}

/// # Safety
/// `compressor` comes from fx_new and was not freed
#[no_mangle]
pub unsafe extern "C" fn fx_buffers(compressor: *mut Compressor, frames: usize) -> *mut f32 {
    let compressor = &mut *compressor;
    // the block buffers grow here, not while it renders
    compressor.grow(frames);
    compressor.io.reserve(frames)
}

/// # Safety
/// `compressor` comes from fx_new and was not freed, its buffers reserved for the block
#[no_mangle]
pub unsafe extern "C" fn fx_process(compressor: *mut Compressor) {
    (*compressor).process_io();
}

/// the params that changed, in the command buffer
///
/// # Safety
/// `compressor` comes from fx_new and was not freed
#[no_mangle]
pub unsafe extern "C" fn fx_set(compressor: *mut Compressor) {
    let (present, changes) = command();
    (*compressor).set(present, &changes);
}

/// # Safety
/// `compressor` comes from fx_new and was not freed
#[no_mangle]
pub unsafe extern "C" fn fx_clear(compressor: *mut Compressor) {
    (*compressor).forget();
}

/// # Safety
/// `compressor` comes from fx_new and was not freed
#[no_mangle]
pub unsafe extern "C" fn fx_idle(compressor: *mut Compressor) -> bool {
    (*compressor).idle()
}

/// the meter into the command buffer: the gains of the three bands (dB), the peak of the input
///
/// # Safety
/// `compressor` comes from fx_new and was not freed
#[no_mangle]
pub unsafe extern "C" fn fx_meter(compressor: *mut Compressor) {
    let meter = (*compressor).meter();
    let values = [
        meter.gains[0] as f64,
        meter.gains[1] as f64,
        meter.gains[2] as f64,
        meter.input as f64,
    ];
    let command = core::ptr::addr_of_mut!(COMMAND) as *mut f64;
    for (k, value) in values.iter().enumerate() {
        *command.add(k) = *value;
    }
}

#[cfg(test)]
mod tests;
