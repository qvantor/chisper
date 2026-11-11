//! The sample-by-sample blocks of the effects (the dsp.ts of the app they came from)

use crate::simd::{F32x4, F64x2, TINY};
use crate::{int32, power_of_two_above};
use alloc::{vec, vec::Vec};
use jsmath::{exp, floor, max, round};

// the cubic hermite of four lanes of f32 (the one of the delay lines in doubles)
#[inline(always)]
fn hermite4(prev: F32x4, x0: F32x4, x1: F32x4, next: F32x4, t: F32x4) -> F32x4 {
    let half = F32x4::splat(0.5);
    let c1 = half * (x1 - prev);
    let c2 = prev - F32x4::splat(2.5) * x0 + F32x4::splat(2.0) * x1 - half * next;
    let c3 = half * (next - prev) + F32x4::splat(1.5) * (x0 - x1);
    ((c3 * t + c2) * t + c1) * t + x0
}

/// Delay lines in f32 read four at a time: LANES = 4, four lines written together, their samples side by side in
/// one ring (lane k reads line k), or LANES = 1, one line read at four delays. A ring of at least `max_delay`
/// samples; read before write, read(d) is the sample written d steps ago (d >= 2), fractional delays read with a
/// 4-point cubic hermite. The delays are doubles (a place in a ring of thousands of samples has too few bits
/// left for its fraction in f32), the samples and the hermite f32
pub struct Lines<const LANES: usize> {
    buffer: Vec<f32>,
    mask: i32,
    index: i32,
}

impl<const LANES: usize> Lines<LANES> {
    pub fn new(max_delay: f64) -> Lines<LANES> {
        let size = power_of_two_above(max_delay + 4.0);
        Lines {
            buffer: vec![0.0; size * LANES],
            mask: size as i32 - 1,
            index: 0,
        }
    }

    /// the lines at the delays of the lanes of `delay` (lanes 0 and 1, then 2 and 3)
    #[inline(always)]
    pub fn read(&self, delay: [F64x2; 2]) -> F32x4 {
        let (index, two) = (F64x2::splat(self.index as f64), F64x2::splat(2.0));
        let (lo, hi) = (index - two.max(delay[0]), index - two.max(delay[1]));
        let (floor_lo, floor_hi) = (lo.floor(), hi.floor());
        let t = F32x4::from_f64(lo - floor_lo, hi - floor_hi);
        // (a NaN delay reads at 0, one out of the ring wraps in it)
        let i = [
            floor_lo.lo() as i32,
            floor_lo.hi() as i32,
            floor_hi.lo() as i32,
            floor_hi.hi() as i32,
        ];
        let (buffer, mask) = (&self.buffer, self.mask);
        let at = |j: i32| {
            let sample = |lane: usize| {
                let place = (i[lane].wrapping_add(j) & mask) as usize * LANES + lane % LANES;
                // SAFETY: the place of a sample is under the size of the ring (the mask), its lane under LANES
                unsafe { *buffer.get_unchecked(place) }
            };
            F32x4::new(sample(0), sample(1), sample(2), sample(3))
        };
        hermite4(at(-1), at(0), at(1), at(2), t)
    }

    #[inline(always)]
    fn step(&mut self) {
        self.index = (self.index + 1) & self.mask;
    }

    pub fn clear(&mut self) {
        self.buffer.fill(0.0);
    }
}

impl Lines<4> {
    /// a sample of each line (what is too small to sound as 0: F32x4::flush)
    #[inline(always)]
    pub fn write(&mut self, value: F32x4) {
        value.flush().store(&mut self.buffer[4 * self.index as usize..]);
        self.step();
    }

    /// Schroeder allpasses of gliding delays, four at once: these lines as theirs
    #[inline(always)]
    pub fn allpass(&mut self, input: F32x4, delay: [F64x2; 2], gain: F32x4) -> F32x4 {
        let delayed = self.read(delay);
        let sum = input + gain * delayed;
        self.write(sum);
        delayed - gain * sum
    }
}

impl Lines<1> {
    #[inline(always)]
    pub fn write(&mut self, value: f32) {
        self.buffer[self.index as usize] = if value.abs() < TINY { 0.0 } else { value };
        self.step();
    }
}

// the cubic hermite of read() in lanes: the same operations in the same order
#[inline(always)]
fn hermite(prev: F64x2, x0: F64x2, x1: F64x2, next: F64x2, t: F64x2) -> F64x2 {
    let half = F64x2::splat(0.5);
    let c1 = half * (x1 - prev);
    let c2 = prev - F64x2::splat(2.5) * x0 + F64x2::splat(2.0) * x1 - half * next;
    let c3 = half * (next - prev) + F64x2::splat(1.5) * (x0 - x1);
    ((c3 * t + c2) * t + c1) * t + x0
}

/// a DelayLine of both channels: one ring of lanes (the channels of a reverb read at one delay and write every
/// sample: their indexes stay together), each lane read and written as a DelayLine of its own
pub struct StereoDelayLine {
    buffer: Vec<F64x2>,
    mask: usize,
    index: usize,
}

impl StereoDelayLine {
    pub fn new(max_delay: f64) -> StereoDelayLine {
        let size = power_of_two_above(max_delay + 4.0);
        StereoDelayLine {
            buffer: vec![F64x2::default(); size],
            mask: size - 1,
            index: 0,
        }
    }

    #[inline(always)]
    pub fn read(&self, delay: f64) -> F64x2 {
        let pos = self.index as f64 - max(2.0, delay);
        let i = floor(pos);
        let t = F64x2::splat(pos - i);
        let b = &self.buffer;
        let (i, mask) = (int32(i), self.mask as i32);
        let at = |k: i32| b[(i.wrapping_add(k) & mask) as usize];
        let (prev, x0, x1, next) = (at(-1), at(0), at(1), at(2));
        hermite(prev, x0, x1, next, t)
    }

    #[inline(always)]
    pub fn write(&mut self, value: F64x2) {
        self.buffer[self.index] = value;
        self.index = (self.index + 1) & self.mask;
    }

    pub fn clear(&mut self) {
        self.buffer.fill(F64x2::default());
    }
}

/// createFixedAllpass of both channels in the lanes: an allpass of a fixed delay, rounded to whole samples (one
/// delay, one gain: the diffusers of a reverb), each lane the allpass of its channel
pub struct StereoFixedAllpass {
    buffer: Vec<F64x2>,
    index: usize,
}

impl StereoFixedAllpass {
    pub fn new(delay: f64) -> StereoFixedAllpass {
        let length = max(1.0, round(delay)) as usize;
        StereoFixedAllpass {
            buffer: vec![F64x2::default(); length],
            index: 0,
        }
    }

    #[inline(always)]
    pub fn process(&mut self, input: F64x2, gain: F64x2) -> F64x2 {
        let delayed = self.buffer[self.index];
        let sum = input + gain * delayed;
        self.buffer[self.index] = sum;
        self.index = if self.index + 1 == self.buffer.len() {
            0
        } else {
            self.index + 1
        };
        delayed - gain * sum
    }

    pub fn clear(&mut self) {
        self.buffer.fill(F64x2::default());
    }
}

/// createSmoothed: a param that glides to its target with a time constant, stepped once per block; `from` is
/// its value at the start of the block
#[derive(Clone)]
pub struct Smoothed {
    pub from: f64,
    pub value: f64,
    target: f64,
    glide: f64,
    time_constant: f64,
    sample_rate: f64,
}

impl Smoothed {
    pub fn new(initial: f64, time_constant: f64, sample_rate: f64) -> Smoothed {
        Smoothed {
            from: initial,
            value: initial,
            target: initial,
            glide: time_constant,
            time_constant,
            sample_rate,
        }
    }

    /// set(value, instant, seconds): `seconds` None is the time constant of the param
    pub fn set(&mut self, value: f64, instant: bool, seconds: Option<f64>) {
        self.target = value;
        self.glide = seconds.unwrap_or(self.time_constant);
        if instant {
            self.from = value;
            self.value = value;
        }
    }

    pub fn snap(&mut self) {
        self.from = self.target;
        self.value = self.target;
    }

    /// true while gliding
    pub fn step(&mut self, frames: f64) -> bool {
        self.from = self.value;
        if self.value == self.target {
            return false;
        }
        self.value += (self.target - self.value) * (1.0 - exp(-frames / (self.glide * self.sample_rate)));
        if (self.target - self.value).abs() <= self.target.abs() * 1e-6 + 1e-9 {
            self.value = self.target;
        }
        true
    }
}

/// the loudest sample of a block (Math.max: a NaN stays)
pub fn peak(data: &[f32]) -> f64 {
    let mut loudest = 0.0;
    for value in data {
        loudest = max(loudest, (*value as f64).abs());
    }
    loudest
}

#[cfg(test)]
mod tests {
    use super::*;

    // a deterministic noise within ±1 (xorshift)
    fn noise(seed: u64) -> impl FnMut() -> f64 {
        let mut x = seed;
        move || {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            (x >> 11) as f64 / (1u64 << 52) as f64 - 1.0
        }
    }

    // a delay line in doubles: what a line of Lines reads, within the rounding of f32
    struct Exact {
        written: Vec<f64>,
    }

    impl Exact {
        fn read(&self, delay: f64) -> f64 {
            let pos = self.written.len() as f64 - max(delay, 2.0);
            let i = pos.floor();
            let t = pos - i;
            let at = |k: f64| {
                let place = i + k;
                // (before the first sample, or the one being written: read at a whole delay of 2, weighed 0)
                if place < 0.0 || place as usize >= self.written.len() {
                    0.0
                } else {
                    self.written[place as usize]
                }
            };
            let (prev, x0, x1, next) = (at(-1.0), at(0.0), at(1.0), at(2.0));
            let c1 = 0.5 * (x1 - prev);
            let c2 = prev - 2.5 * x0 + 2.0 * x1 - 0.5 * next;
            let c3 = 0.5 * (next - prev) + 1.5 * (x0 - x1);
            ((c3 * t + c2) * t + c1) * t + x0
        }
    }

    // the delays a reverb reads: fractional, under 2 (read at 2), up to the length of the lines
    fn delays(next: &mut impl FnMut() -> f64, step: usize, max: f64) -> [F64x2; 2] {
        let mut delay = || {
            if step.is_multiple_of(7) {
                1.25
            } else {
                (next() + 1.0) / 2.0 * max
            }
        };
        [F64x2::new(delay(), delay()), F64x2::new(delay(), delay())]
    }

    fn close(read: F32x4, exact: [f64; 4]) {
        for (ours, exact) in read.lanes().iter().zip(exact) {
            assert!((*ours as f64 - exact).abs() < 2e-6, "{ours} != {exact}");
        }
    }

    #[test]
    fn four_lines_read_each_at_its_delay() {
        let mut next = noise(1);
        let mut lines = Lines::<4>::new(1100.5);
        let mut exact: [Exact; 4] = core::array::from_fn(|_| Exact { written: Vec::new() });
        for step in 0..5000 {
            let values: [f64; 4] = core::array::from_fn(|_| next() as f32 as f64);
            lines.write(F32x4::new(
                values[0] as f32,
                values[1] as f32,
                values[2] as f32,
                values[3] as f32,
            ));
            for (line, value) in exact.iter_mut().zip(values) {
                line.written.push(value);
            }
            let delay = delays(&mut next, step, 1100.5);
            let of = [delay[0].lo(), delay[0].hi(), delay[1].lo(), delay[1].hi()];
            close(
                lines.read(delay),
                core::array::from_fn(|lane| exact[lane].read(of[lane])),
            );
        }
    }

    #[test]
    fn one_line_reads_at_four_delays() {
        let mut next = noise(2);
        let mut line = Lines::<1>::new(300.0);
        let mut exact = Exact { written: Vec::new() };
        for step in 0..3000 {
            let value = next() as f32;
            line.write(value);
            exact.written.push(value as f64);
            let delay = delays(&mut next, step, 300.0);
            let of = [delay[0].lo(), delay[0].hi(), delay[1].lo(), delay[1].hi()];
            close(
                line.read(delay),
                core::array::from_fn(|lane| exact.read(of[lane])),
            );
        }
    }

    // what is too small to sound is written as 0 (no denormals in the lines), a NaN stays
    #[test]
    fn the_lines_hold_no_denormals() {
        let mut lines = Lines::<4>::new(16.0);
        lines.write(F32x4::new(1e-30, -1e-39, 0.5, f32::NAN));
        let read = lines.read([F64x2::splat(1.0), F64x2::splat(1.0)]).lanes();
        // (a delay under 2 reads at 2: the samples before the write, 0)
        assert_eq!(read[..3], [0.0, 0.0, 0.0]);
        lines.write(F32x4::splat(0.0));
        let read = lines.read([F64x2::splat(2.0), F64x2::splat(2.0)]).lanes();
        assert_eq!(read[..3], [0.0, 0.0, 0.5]);
        assert!(read[3].is_nan());
        let mut line = Lines::<1>::new(16.0);
        line.write(-1e-39);
        line.write(0.0);
        assert!(line.read([F64x2::splat(2.0); 2]).lanes()[0].to_bits() == 0);
    }

    // four allpasses of whole delays: each the allpass of its delay and gain
    #[test]
    fn four_allpasses_are_an_allpass_each() {
        let mut next = noise(3);
        let mut lines = Lines::<4>::new(64.0);
        let delays = [5.0, 17.0, 31.0, 60.0];
        let gains = [0.5f32, -0.7, 0.3, 0.62];
        let mut rings: [Vec<f32>; 4] = core::array::from_fn(|_| Vec::new());
        for _ in 0..2000 {
            let input: [f32; 4] = core::array::from_fn(|_| next() as f32);
            let out = lines
                .allpass(
                    F32x4::load(&input),
                    [F64x2::new(delays[0], delays[1]), F64x2::new(delays[2], delays[3])],
                    F32x4::load(&gains),
                )
                .lanes();
            for lane in 0..4 {
                let ring = &mut rings[lane];
                let delayed = if ring.len() >= delays[lane] as usize {
                    ring[ring.len() - delays[lane] as usize]
                } else {
                    0.0
                };
                let sum = input[lane] + gains[lane] * delayed;
                ring.push(sum);
                assert!((out[lane] - (delayed - gains[lane] * sum)).abs() < 1e-6);
            }
        }
    }

    // a stereo line reads each channel at the delay, as a line of its own
    #[test]
    fn a_stereo_line_is_a_line_per_lane() {
        let mut next = noise(2);
        let mut stereo = StereoDelayLine::new(700.0);
        let (mut left, mut right) = (Exact { written: Vec::new() }, Exact { written: Vec::new() });
        for _ in 0..3000 {
            let delay = (next() + 1.0) / 2.0 * 700.0;
            let read = stereo.read(delay);
            // (its place in the ring is a smaller number than the one of the reference: the fraction rounds apart)
            assert!((read.lo() - left.read(delay)).abs() < 1e-11);
            assert!((read.hi() - right.read(delay)).abs() < 1e-11);
            let (l, r) = (next(), next());
            stereo.write(F64x2::new(l, r));
            left.written.push(l);
            right.written.push(r);
        }
    }

    // a Schroeder allpass of a whole delay reads the sample written that many steps ago
    #[test]
    fn a_stereo_fixed_allpass_is_an_allpass_of_its_whole_delay_per_lane() {
        let mut next = noise(4);
        for delay in [2.0, 3.4, 37.0, 241.6] {
            let mut stereo = StereoFixedAllpass::new(delay);
            let whole = round(delay) as usize;
            let mut rings: [Vec<f64>; 2] = [Vec::new(), Vec::new()];
            let gain = 0.62;
            for _ in 0..2000 {
                let input = [next(), next()];
                let out = stereo.process(F64x2::new(input[0], input[1]), F64x2::splat(gain));
                for (lane, out) in [out.lo(), out.hi()].into_iter().enumerate() {
                    let ring = &mut rings[lane];
                    let delayed = if ring.len() >= whole {
                        ring[ring.len() - whole]
                    } else {
                        0.0
                    };
                    let sum = input[lane] + gain * delayed;
                    ring.push(sum);
                    assert_eq!(out, delayed - gain * sum);
                }
            }
        }
    }
}
