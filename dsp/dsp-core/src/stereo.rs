//! The stereo blocks: the left channel in the low lane, the right one in the high lane, each lane worked out as
//! the mono block does it for its channel; the oversampling chains of the distortion in f32

use crate::biquad::{coefficients_into, FilterType};
use crate::consts::{DOWN8_PHASES, DOWN_PHASES, UP8_PHASES, UP_PHASES};
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

const HALF: usize = TAPS / 2;

/// the points per sample of the 8× chain
pub const OVERSAMPLING8: usize = 8;

// the taps the other way round: a window of a buffer runs forward in time
static UP4: [[f32; TAPS]; 4] = phases(&UP_PHASES, true, 1.0);
static UP8: [[f32; TAPS]; 8] = phases(&UP8_PHASES, true, 1.0);
// (the average of the streams in the taps: 1 / the ratio, a power of two)
static DOWN4: [[f32; TAPS]; 3] = phases(&DOWN_PHASES, true, 0.25);
static DOWN8: [[f32; TAPS]; 7] = phases(&DOWN8_PHASES, true, 0.125);

/// the samples of input a chain reads before those of a block: an input buffer holds them, then the block
pub const INPUT_CARRY: usize = TAPS - 1;

/// An oversampling chain of both channels in f32 (the oversampler.ts of the app, 4× or 8×, 32 taps a phase at the
/// input rate, a latency of OVERSAMPLER_LATENCY): up() works out the points of a block, shape() puts a curve and
/// the gains on them, down() brings them back to the input rate. The points of a phase are a plane of their own, in
/// time order after the TAPS last ones of the block before, so a FIR reads a window of a slice
pub struct Chain {
    ratio: usize,
    up: &'static [[f32; TAPS]],
    down: &'static [[f32; TAPS]],
    // [channel][phase]: TAPS + frames points (+ 3: the curve runs four at a time)
    planes: [Vec<Vec<f32>>; 2],
    frames: usize,
}

impl Chain {
    pub fn new(ratio: usize) -> Chain {
        let eight = ratio == OVERSAMPLING8;
        Chain {
            ratio,
            up: if eight { &UP8 } else { &UP4 },
            down: if eight { &DOWN8 } else { &DOWN4 },
            planes: [Vec::new(), Vec::new()],
            frames: 0,
        }
    }

    /// the planes of blocks of `frames` (allocates: not while a block renders)
    pub fn grow(&mut self, frames: usize) {
        if frames <= self.frames && !self.planes[0].is_empty() {
            return;
        }
        for channel in self.planes.iter_mut() {
            let mut planes = Vec::with_capacity(self.ratio);
            for p in 0..self.ratio {
                let mut plane = vec![0.0f32; TAPS + frames + 3];
                if let Some(old) = channel.get(p) {
                    plane[..TAPS].copy_from_slice(&old[..TAPS]);
                }
                planes.push(plane);
            }
            *channel = planes;
        }
        self.frames = frames;
    }

    /// the points of a block: `input` of each channel is INPUT_CARRY samples of before, then the frames
    pub fn up(&mut self, input: [&[f32]; 2], frames: usize) {
        for (channel, input) in self.planes.iter_mut().zip(input) {
            let input = &input[..INPUT_CARRY + frames];
            for (plane, taps) in channel.iter_mut().zip(self.up) {
                let taps = lanes_of(taps);
                for (s, point) in plane[TAPS..TAPS + frames].iter_mut().enumerate() {
                    *point = dot(&input[s..], &taps);
                }
            }
        }
    }

    /// curve(point) × the gain of its sample on the points of the block: tanh, or a clip at ±1 (`hard`).
    /// `gains` holds frames + 3 values
    pub fn shape(&mut self, hard: bool, gains: &[f32], frames: usize) {
        let (low, high) = (F32x4::splat(-1.0), F32x4::splat(1.0));
        for plane in self.planes.iter_mut().flatten() {
            let points = &mut plane[TAPS..];
            let mut s = 0;
            while s < frames {
                let x = F32x4::load(&points[s..]);
                let y = if hard { x.min(high).max(low) } else { tanh4(x) };
                (y * F32x4::load(&gains[s..])).store(&mut points[s..]);
                s += 4;
            }
        }
    }

    /// points of 0 for the block (a chain that stopped empties its decimator)
    pub fn silence(&mut self, frames: usize) {
        for plane in self.planes.iter_mut().flatten() {
            plane[TAPS..TAPS + frames].fill(0.0);
        }
    }

    /// the points of the block back at the input rate into (or added to) output[channel][0..frames): point q of a
    /// step weighed with phase ratio - q of the sinc cut at the nyquist, phase 0 the center point alone, the
    /// streams averaged. The block is then the one before
    pub fn down(&mut self, output: [&mut [f32]; 2], frames: usize, add: bool) {
        let center = 1.0 / self.ratio as f32;
        for (channel, output) in self.planes.iter_mut().zip(output) {
            let output = &mut output[..frames];
            for (s, out) in output.iter_mut().enumerate() {
                let value = center * channel[0][s + HALF];
                *out = if add { *out + value } else { value };
            }
            for q in 1..self.ratio {
                let taps = lanes_of(&self.down[self.ratio - 1 - q]);
                let plane = &channel[q][..TAPS + frames];
                for (s, out) in output.iter_mut().enumerate() {
                    *out += dot(&plane[s..], &taps);
                }
            }
            for plane in channel.iter_mut() {
                plane.copy_within(frames..frames + TAPS, 0);
            }
        }
    }

    /// no points of before: the decimator at 0 (a chain that starts, or cleared)
    pub fn clear(&mut self) {
        for plane in self.planes.iter_mut().flatten() {
            plane[..TAPS].fill(0.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::biquad::Biquad;

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
