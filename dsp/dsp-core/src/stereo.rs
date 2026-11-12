//! The stereo blocks: the left channel in the low lane, the right one in the high lane, each lane worked out as
//! the mono block does it for its channel; the oversampling chain of the distortion in f32

use crate::biquad::{coefficients_into, FilterType};
use crate::consts::{
    CASCADE_DOWN_PHASE, CASCADE_HALF_DOWN, CASCADE_HALF_UP, CASCADE_UP_LATE_PHASES, CASCADE_UP_PHASES,
};
use crate::fir::{dot, lanes_of, phases, TAPS};
use crate::simd::{F32x4, F64x2};
use crate::tanh::tanh4;
use alloc::{vec, vec::Vec};
use core::ops::{Add, Mul, Sub};
use jsmath::{exp, PI};

/// createBiquad of both channels: one set of coefficients, a state per lane
#[derive(Clone, Default)]
pub struct StereoBiquad {
    c: [f64; 5],
    z1: F64x2,
    z2: F64x2,
}

impl StereoBiquad {
    pub fn new() -> StereoBiquad {
        StereoBiquad {
            c: [1.0, 0.0, 0.0, 0.0, 0.0],
            z1: F64x2::default(),
            z2: F64x2::default(),
        }
    }

    pub fn set(&mut self, ty: FilterType, frequency: f64, q: f64, gain: f64, sample_rate: f64) {
        coefficients_into(&mut self.c, Some(ty), frequency, q, gain, sample_rate);
    }

    /// one sample of both channels
    #[inline(always)]
    pub fn process(&mut self, input: F64x2) -> F64x2 {
        let [b0, b1, b2, a1, a2] = self.c.map(F64x2::splat);
        let out = b0.mul(input).add(self.z1);
        self.z1 = b1.mul(input).sub(a1.mul(out)).add(self.z2);
        self.z2 = b2.mul(input).sub(a2.mul(out));
        out
    }

    /// output[s] of input[s] for s < frames
    pub fn process_block(&mut self, input: &[F64x2], output: &mut [F64x2], frames: usize) {
        let [b0, b1, b2, a1, a2] = self.c.map(F64x2::splat);
        let mut z1 = self.z1;
        let mut z2 = self.z2;
        for (x, y) in input[..frames].iter().zip(output[..frames].iter_mut()) {
            let x = *x;
            let out = b0.mul(x).add(z1);
            z1 = b1.mul(x).sub(a1.mul(out)).add(z2);
            z2 = b2.mul(x).sub(a2.mul(out));
            *y = out;
        }
        self.z1 = z1;
        self.z2 = z2;
    }

    pub fn clear(&mut self) {
        self.z1 = F64x2::default();
        self.z2 = F64x2::default();
    }
}

/// four biquads at once in f32 (four lines of a reverb): the coefficients of each lane, a state per lane
#[derive(Clone)]
pub struct QuadBiquad {
    // [coefficient][lane]
    values: [[f32; 4]; 5],
    c: [F32x4; 5],
    z1: F32x4,
    z2: F32x4,
}

impl Default for QuadBiquad {
    fn default() -> Self {
        let values = [[1.0; 4], [0.0; 4], [0.0; 4], [0.0; 4], [0.0; 4]];
        QuadBiquad {
            values,
            c: values.map(|lanes| F32x4::load(&lanes)),
            z1: F32x4::default(),
            z2: F32x4::default(),
        }
    }
}

impl QuadBiquad {
    /// the coefficients of lane `lane` (0..4), worked out in doubles
    pub fn set(&mut self, lane: usize, ty: FilterType, frequency: f64, q: f64, gain: f64, sample_rate: f64) {
        let mut c = [0.0; 5];
        coefficients_into(&mut c, Some(ty), frequency, q, gain, sample_rate);
        for k in 0..5 {
            self.values[k][lane] = c[k] as f32;
            self.c[k] = F32x4::load(&self.values[k]);
        }
    }

    #[inline(always)]
    pub fn process(&mut self, input: F32x4) -> F32x4 {
        let [b0, b1, b2, a1, a2] = self.c;
        let output = b0 * input + self.z1;
        self.z1 = b1 * input - a1 * output + self.z2;
        self.z2 = b2 * input - a2 * output;
        output
    }

    pub fn clear(&mut self) {
        self.z1 = F32x4::default();
        self.z2 = F32x4::default();
    }
}

/// createDcBlocker of both channels
pub struct StereoDcBlocker {
    r: f64,
    x1: F64x2,
    y1: F64x2,
}

impl StereoDcBlocker {
    pub fn new(cutoff: f64, sample_rate: f64) -> StereoDcBlocker {
        StereoDcBlocker {
            r: exp((-2.0 * PI * cutoff) / sample_rate),
            x1: F64x2::default(),
            y1: F64x2::default(),
        }
    }

    /// data[0..frames) in place
    pub fn process_block(&mut self, data: &mut [F64x2], frames: usize) {
        let r = F64x2::splat(self.r);
        let mut x1 = self.x1;
        let mut y1 = self.y1;
        for value in data[..frames].iter_mut() {
            let x = *value;
            y1 = x.sub(x1).add(r.mul(y1));
            x1 = x;
            *value = y1;
        }
        self.x1 = x1;
        self.y1 = y1;
    }

    pub fn clear(&mut self) {
        self.x1 = F64x2::default();
        self.y1 = F64x2::default();
    }
}

/// the points per sample of a chain
pub const OVERSAMPLING: usize = 4;

/// the samples a chain delays its input by: CENTER each way in its first stage, 2 in its halfbands
pub const CHAIN_LATENCY: usize = 2 * CENTER + (HALF_UP + HALF_DOWN) / OVERSAMPLING;

// the samples the sinc of the first stage reaches each way (30 of its 32 taps: the latency of the chain is the 32
// samples of one stage of 4×), the centres of the halfbands (7 and 11 taps) in points
const CENTER: usize = 15;
const HALF_UP: usize = 3;
const HALF_DOWN: usize = 5;

// the taps the other way round: a window of a buffer runs forward in time
static UP: [[f32; TAPS]; 2] = phases(&CASCADE_UP_PHASES, true, 1.0);
static UP_LATE: [[f32; TAPS]; 2] = phases(&CASCADE_UP_LATE_PHASES, true, 1.0);
// (the average of both streams in the taps)
static DOWN: [[f32; TAPS]; 1] = phases(&CASCADE_DOWN_PHASE, true, 0.5);

// the samples of before the first stage works out again in every block, for the halfband that reads their points
// (it keeps no points of its own: a chain that starts has those of one that ran all along)
const BEFORE: usize = 2;

/// the samples of input a chain reads before those of a block: an input buffer holds them, then the block
pub const INPUT_CARRY: usize = TAPS - 1 + BEFORE;

// the points of before in the buffers: of the shaped planes (the halfband down), of the streams of the last stage
const SHAPED_BEFORE: usize = 8;

/// An oversampling chain of both channels in f32: 4× in two stages of 2×, a latency of CHAIN_LATENCY. up() works
/// out the points of a block at 2× (a sinc of 30 taps a phase at the input rate), shape() those at 4× (a halfband:
/// every other point is one of 2×, the ones between a FIR of 4 taps) with a curve and the gains on them, down()
/// brings them back to the input rate (a halfband of 6 taps and its centre, then the sinc). The curve of a `hard`
/// chain is the clip at ±1 antialiased (its mean between a point and the one before: an antiderivative
/// antialiasing of the 1st order), which delays by half a point and takes off some of the top (-0.5 dB at 20 kHz
/// under the ceiling): its first stage reads as much later and lifts the top as much.
/// scripts/distortion-adaa/run.mjs measures the aliases of this against one stage of 4× or 8×
pub struct Chain {
    hard: bool,
    // of each channel: the points at 2× (BEFORE samples of before, then the block; + 4: the lanes), the shaped
    // points at 4× by parity (SHAPED_BEFORE of before), the streams at 2× by parity (the even ones delayed to
    // the centre of the sinc, the odd ones its window)
    points: [Vec<f32>; 2],
    shaped: [[Vec<f32>; 2]; 2],
    center: [Vec<f32>; 2],
    window: [Vec<f32>; 2],
    frames: usize,
}

// a buffer of `length` that keeps the first `kept` values of the one before
fn grown(old: &[f32], kept: usize, length: usize) -> Vec<f32> {
    let mut buffer = vec![0.0f32; length];
    if old.len() >= kept {
        buffer[..kept].copy_from_slice(&old[..kept]);
    }
    buffer
}

// the mean of the clip at ±1 between the points a and b: with m(x) = max(|x| - 1, 0), what a point is over the
// ceiling, the antiderivative of the clip is x² / 2 - m(x)² / 2, so its mean is
// (a + b) / 2 - (m(a) - m(b)) / (a - b) × (m(a) + m(b)) / 2: no difference of two near values is divided
// (m(a) - m(b) is within a - b). The same point twice: its clip
#[inline(always)]
fn clip_mean(a: F32x4, b: F32x4) -> F32x4 {
    let (one, half) = (F32x4::splat(1.0), F32x4::splat(0.5));
    let over = |x: F32x4| (x.abs() - one).max(F32x4::default());
    let (ma, mb) = (over(a), over(b));
    let d = a - b;
    let mean = (a + b) * half - (ma - mb) / d * ((ma + mb) * half);
    a.min(one)
        .max(F32x4::default() - one)
        .or_else(d.equal(F32x4::default()), mean)
}

impl Chain {
    pub fn new(hard: bool) -> Chain {
        Chain {
            hard,
            points: [Vec::new(), Vec::new()],
            shaped: [[Vec::new(), Vec::new()], [Vec::new(), Vec::new()]],
            center: [Vec::new(), Vec::new()],
            window: [Vec::new(), Vec::new()],
            frames: 0,
        }
    }

    /// the buffers of blocks of `frames` (allocates: not while a block renders)
    pub fn grow(&mut self, frames: usize) {
        if frames <= self.frames && !self.points[0].is_empty() {
            return;
        }
        for channel in 0..2 {
            self.points[channel] = vec![0.0f32; 2 * (BEFORE + frames) + 4];
            for plane in self.shaped[channel].iter_mut() {
                *plane = grown(plane, SHAPED_BEFORE, SHAPED_BEFORE + 2 * frames + 4);
            }
            self.center[channel] = grown(&self.center[channel], CENTER, CENTER + frames + 2);
            self.window[channel] = grown(&self.window[channel], TAPS, TAPS + frames + 2);
        }
        self.frames = frames;
    }

    /// the points at 2× of a block: `input` of each channel is INPUT_CARRY samples of before, then the frames
    pub fn up(&mut self, input: [&[f32]; 2], frames: usize) {
        let taps = if self.hard { &UP_LATE } else { &UP };
        let taps = [lanes_of(&taps[0]), lanes_of(&taps[1])];
        for (points, input) in self.points.iter_mut().zip(input) {
            let input = &input[..INPUT_CARRY + frames];
            for (s, pair) in points[..2 * (BEFORE + frames)].chunks_exact_mut(2).enumerate() {
                pair[0] = dot(&input[s..], &taps[0]);
                pair[1] = dot(&input[s..], &taps[1]);
            }
        }
    }

    /// The points at 4× of the block with the curve and the gain of their sample on them: tanh, or the mean of
    /// the clip (a `hard` chain). `gains` holds frames + 3 values. The even points are a FIR of the points at 2×
    /// (the halfband: 4 taps), the odd ones those points themselves, 1 before
    pub fn shape(&mut self, gains: &[f32], frames: usize) {
        let [c0, c1] = HALF_UP_TAPS.map(F32x4::splat);
        for (points, [even, odd]) in self.points.iter().zip(self.shaped.iter_mut()) {
            let (even, odd) = (&mut even[SHAPED_BEFORE..], &mut odd[SHAPED_BEFORE..]);
            let mut j = 0;
            while j < 2 * frames {
                // point j of the block is 2 × BEFORE + j of the buffer
                let at = |k: usize| F32x4::load(&points[2 * BEFORE + j - k..]);
                let e = (at(0) + at(3)) * c0 + (at(1) + at(2)) * c1;
                let o = at(1);
                let (g0, g1) = (gains[j / 2], gains[j / 2 + 1]);
                let gain = F32x4::new(g0, g0, g1, g1);
                let (e, o) = if self.hard {
                    // (in time: the odd point before, the even one, the odd one)
                    (clip_mean(e, at(2)), clip_mean(o, e))
                } else {
                    (tanh4(e), tanh4(o))
                };
                (e * gain).store(&mut even[j..]);
                (o * gain).store(&mut odd[j..]);
                j += 4;
            }
        }
    }

    /// points of 0 for the block (a chain that stopped empties its decimator)
    pub fn silence(&mut self, frames: usize) {
        for plane in self.shaped.iter_mut().flatten() {
            plane[SHAPED_BEFORE..SHAPED_BEFORE + 2 * frames].fill(0.0);
        }
    }

    /// The points of the block back at the input rate into (or added to) output[channel][0..frames): the halfband
    /// (6 taps of the even points and the odd one at its centre) brings them to 2×, then the sinc cut at the
    /// nyquist (the even stream at its centre alone, the odd one through its taps), the streams averaged. The
    /// block is then the one before
    pub fn down(&mut self, output: [&mut [f32]; 2], frames: usize, add: bool) {
        let [h0, h1, h2] = HALF_DOWN_TAPS.map(F32x4::splat);
        let half = F32x4::splat(0.5);
        let taps = lanes_of(&DOWN[0]);
        let streams = self.center.iter_mut().zip(self.window.iter_mut());
        for (([even, odd], (center, window)), output) in self.shaped.iter_mut().zip(streams).zip(output) {
            let mut j = 0;
            while j < 2 * frames {
                let at = |k: usize| F32x4::load(&even[SHAPED_BEFORE + j - k..]);
                let sum = ((at(0) + at(5)) * h0 + (at(1) + at(4)) * h1) + (at(2) + at(3)) * h2;
                let [u0, u1, u2, u3] = (F32x4::load(&odd[SHAPED_BEFORE + j - 3..]) * half + sum).lanes();
                let s = j / 2;
                center[CENTER + s] = u0;
                window[TAPS + s] = u1;
                center[CENTER + s + 1] = u2;
                window[TAPS + s + 1] = u3;
                j += 4;
            }
            for (s, out) in output[..frames].iter_mut().enumerate() {
                let value = 0.5 * center[s];
                *out = if add { *out + value } else { value };
                *out += dot(&window[s..], &taps);
            }
            for plane in [even, odd] {
                plane.copy_within(2 * frames..2 * frames + SHAPED_BEFORE, 0);
            }
            center.copy_within(frames..frames + CENTER, 0);
            window.copy_within(frames..frames + TAPS, 0);
        }
    }

    /// no points of before: the decimator at 0 (a chain that starts, or cleared)
    pub fn clear(&mut self) {
        for plane in self.shaped.iter_mut().flatten() {
            plane[..SHAPED_BEFORE].fill(0.0);
        }
        for channel in 0..2 {
            self.center[channel][..CENTER].fill(0.0);
            self.window[channel][..TAPS].fill(0.0);
        }
    }
}

// the even taps of the halfbands in f32 (the first half: they are symmetric)
static HALF_UP_TAPS: [f32; 2] = [CASCADE_HALF_UP[0] as f32, CASCADE_HALF_UP[1] as f32];
static HALF_DOWN_TAPS: [f32; 3] = [
    CASCADE_HALF_DOWN[0] as f32,
    CASCADE_HALF_DOWN[1] as f32,
    CASCADE_HALF_DOWN[2] as f32,
];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::biquad::Biquad;

    #[test]
    fn the_mean_of_the_clip_between_two_points() {
        // against the integral of the clip worked out in steps, in doubles
        let exact = |a: f64, b: f64| {
            if a == b {
                return a.clamp(-1.0, 1.0);
            }
            let steps = 20000;
            let sum: f64 = (0..steps)
                .map(|k| (b + (a - b) * (k as f64 + 0.5) / steps as f64).clamp(-1.0, 1.0))
                .sum();
            sum / steps as f64
        };
        let points = [
            -3.7, -1.000001, -1.0, -0.99, -0.3, -1e-7, 0.0, 1e-7, 0.4, 0.999999, 1.0, 1.0000001, 1.3, 2.0,
            3.9,
        ];
        for &a in &points {
            for &b in &points {
                let mean = clip_mean(F32x4::splat(a), F32x4::splat(b)).lanes();
                assert!(
                    (mean[0] as f64 - exact(a as f64, b as f64)).abs() < 2e-7,
                    "{a} {b}: {}",
                    mean[0]
                );
                assert_eq!(mean[0].to_bits(), mean[3].to_bits());
            }
        }
        // each lane its own points: the same one twice next to others
        let mean = clip_mean(F32x4::new(0.5, 2.0, -3.0, 0.2), F32x4::new(0.5, 2.0, -3.0, 0.4)).lanes();
        assert_eq!(
            mean,
            [
                0.5,
                1.0,
                -1.0,
                clip_mean(F32x4::splat(0.2), F32x4::splat(0.4)).lanes()[0]
            ]
        );
    }

    #[test]
    fn a_chain_passes_a_sound_under_the_ceiling_delayed_by_its_latency() {
        for hard in [false, true] {
            let frames = 256;
            let mut chain = Chain::new(hard);
            chain.grow(frames);
            // a quiet sine of 1 kHz at 48 kHz: tanh and the clip are the sound itself there
            let wave = |i: usize| 1e-3 * jsmath::sin(2.0 * PI * 1000.0 * i as f64 / 48000.0);
            let input: Vec<f32> = (0..INPUT_CARRY + 2 * frames).map(|i| wave(i) as f32).collect();
            let gains = vec![1.0f32; frames + 3];
            let (mut left, mut right) = (vec![0.0f32; frames], vec![0.0f32; frames]);
            for block in 0..2 {
                let window = &input[block * frames..];
                chain.up([window, window], frames);
                chain.shape(&gains, frames);
                chain.down([&mut left, &mut right], frames, false);
            }
            for s in 0..frames {
                // sample s of the second block: INPUT_CARRY + frames + s of the input
                let dry = wave(INPUT_CARRY + frames + s - CHAIN_LATENCY);
                assert!(
                    (left[s] as f64 - dry).abs() < 3e-6,
                    "{hard} {s}: {} {dry}",
                    left[s]
                );
                assert_eq!(left[s].to_bits(), right[s].to_bits());
            }
        }
    }

    #[test]
    fn the_lanes_of_a_biquad_are_a_biquad_each() {
        let (rate, mut x) = (48000.0, 0.3);
        let mut stereo = StereoBiquad::new();
        let mut quad = QuadBiquad::default();
        let (mut left, mut right) = (Biquad::default(), Biquad::default());
        let mut each: [Biquad; 4] = core::array::from_fn(|_| Biquad::default());
        stereo.set(FilterType::Lowpass, 3000.0, 0.7, 0.0, rate);
        left.set(FilterType::Lowpass, 3000.0, 0.7, 0.0, rate);
        right.set(FilterType::Lowpass, 3000.0, 0.7, 0.0, rate);
        let shelves = [
            (FilterType::Lowshelf, 200.0, -2.5),
            (FilterType::Highshelf, 6000.0, -7.0),
            (FilterType::Lowshelf, 300.0, 4.0),
            (FilterType::Highshelf, 12000.0, -30.0),
        ];
        for (lane, (ty, frequency, gain)) in shelves.into_iter().enumerate() {
            quad.set(lane, ty, frequency, 0.0, gain, rate);
            each[lane].set(ty, frequency, 0.0, gain, rate);
        }
        for s in 0..2000 {
            x = jsmath::sin(x * 3.7 + s as f64);
            let input = F64x2::new(x, -0.5 * x);
            let both = stereo.process(input);
            assert_eq!(
                [both.lo().to_bits(), both.hi().to_bits()],
                [
                    left.process(input.lo()).to_bits(),
                    right.process(input.hi()).to_bits()
                ]
            );
            // in f32: within its rounding of the biquads in doubles
            let lanes = [x, -0.5 * x, 0.25 * x, -x].map(|value| value as f32);
            let out = quad.process(F32x4::load(&lanes)).lanes();
            for lane in 0..4 {
                let exact = each[lane].process(lanes[lane] as f64);
                assert!(
                    (out[lane] as f64 - exact).abs() < 2e-5,
                    "{} != {exact}",
                    out[lane]
                );
            }
        }
    }
}
