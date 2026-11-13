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
        self.read_from(self.index, delay)
    }

    #[inline(always)]
    fn read_from(&self, index: i32, delay: [F64x2; 2]) -> F32x4 {
        let (index, two) = (F64x2::splat(index as f64), F64x2::splat(2.0));
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

/// Four delay lines in f32, each a ring of its own (`Lines<4>` keeps their samples side by side), so four samples
/// in a row of a line are one load: its reads and writes go four samples of time in the lanes (read4, write4)
/// where those of `Lines<4>` go four lines. A read is the one of `Lines::read`, sample by sample: the same place,
/// the same hermite, the same bits. The lines are written together (`advance`); the first GUARD samples of a ring
/// are kept after its end too, so the taps of a read never wrap
pub struct Rows {
    buffer: Vec<f32>,
    stride: usize,
    size: usize,
    mask: i32,
    index: i32,
}

const GUARD: usize = 8;

impl Rows {
    pub fn new(max_delay: f64) -> Rows {
        let size = power_of_two_above(max_delay + 4.0);
        Rows {
            buffer: vec![0.0; 4 * (size + GUARD)],
            stride: size + GUARD,
            size,
            mask: size as i32 - 1,
            index: 0,
        }
    }

    /// line `row` at four samples in a row, the first `ahead` writes from now, each at its delay: what
    /// `Lines::read` gives one after the other (if what they read is written: delay > 5 of what their group
    /// writes, more than `ahead` + 5 of what is written after)
    #[inline(always)]
    pub fn read4(&self, row: usize, ahead: usize, delay: [F64x2; 2]) -> F32x4 {
        let first = (self.index + ahead as i32) & self.mask;
        let two = F64x2::splat(2.0);
        if first + 3 <= self.mask {
            let at = first as f64;
            let (lo, hi) = (
                F64x2::new(at, at + 1.0) - two.max(delay[0]),
                F64x2::new(at + 2.0, at + 3.0) - two.max(delay[1]),
            );
            let (floor_lo, floor_hi) = (lo.floor(), hi.floor());
            let i = floor_lo.lo() as i32;
            // their places one after the other (delays that glide: almost always): the taps of all four in a
            // row of the ring, from the one before the first
            let in_a_row = floor_lo.hi() as i32 == i.wrapping_add(1)
                && floor_hi.lo() as i32 == i.wrapping_add(2)
                && floor_hi.hi() as i32 == i.wrapping_add(3);
            if in_a_row {
                let t = F32x4::from_f64(lo - floor_lo, hi - floor_hi);
                let from = row * self.stride + (i.wrapping_sub(1) & self.mask) as usize;
                let taps = &self.buffer[from..from + 7];
                return hermite4(
                    F32x4::load(taps),
                    F32x4::load(&taps[1..]),
                    F32x4::load(&taps[2..]),
                    F32x4::load(&taps[3..]),
                    t,
                );
            }
        }
        self.read_each(row, first, delay)
    }

    // read4 where its samples are not in a row (the index wraps in the group, a delay jumps or is not a number):
    // each on its own. Rare: a function of its own, not in the loops of read4
    #[inline(never)]
    fn read_each(&self, row: usize, first: i32, delay: [F64x2; 2]) -> F32x4 {
        let two = F64x2::splat(2.0);
        let index = |k: i32| ((first + k) & self.mask) as f64;
        let (lo, hi) = (
            F64x2::new(index(0), index(1)) - two.max(delay[0]),
            F64x2::new(index(2), index(3)) - two.max(delay[1]),
        );
        let (floor_lo, floor_hi) = (lo.floor(), hi.floor());
        let t = F32x4::from_f64(lo - floor_lo, hi - floor_hi);
        let i = [
            floor_lo.lo() as i32,
            floor_lo.hi() as i32,
            floor_hi.lo() as i32,
            floor_hi.hi() as i32,
        ];
        let at = |j: i32| {
            let sample =
                |k: usize| self.buffer[row * self.stride + (i[k].wrapping_add(j) & self.mask) as usize];
            F32x4::new(sample(0), sample(1), sample(2), sample(3))
        };
        hermite4(at(-1), at(0), at(1), at(2), t)
    }

    /// line `row` at four samples in a row, the first `back` writes before now, their delays a line: `delay` of the
    /// first, each next one `slope` longer. Their places are one sample and 1 - slope apart: the share of a sample
    /// of each is the one of the first less its slopes, in f32 (where read4 works out each place in doubles); while
    /// it stays within the sample of its lane the taps of all four are a row of the ring. Not the bits of read4: a
    /// read of its own, the same for a lane whoever of its group is asked (a group cut by a block reads its
    /// samples one by one, each its lane with the same `back` to the first)
    #[inline(always)]
    pub fn read4_line(&self, row: usize, back: usize, delay: f64, slope: f32) -> F32x4 {
        let at = (self.index - back as i32) as f64 - delay;
        let whole = floor(at);
        let i = whole as i32;
        let t = F32x4::splat((at - whole) as f32) - F32x4::splat(slope) * F32x4::new(0.0, 1.0, 2.0, 3.0);
        let last = t.lanes()[3];
        if (0.0..1.0).contains(&last) {
            let from = row * self.stride + (i.wrapping_sub(1) & self.mask) as usize;
            let taps = &self.buffer[from..from + 7];
            return hermite4(
                F32x4::load(taps),
                F32x4::load(&taps[1..]),
                F32x4::load(&taps[2..]),
                F32x4::load(&taps[3..]),
                t,
            );
        }
        self.read_line_each(row, i, t)
    }

    // read4_line where a share leaves the sample of its lane (a delay that moves fast, or crosses a sample in
    // the group): each lane from the sample its share is in
    #[inline(never)]
    fn read_line_each(&self, row: usize, i: i32, t: F32x4) -> F32x4 {
        let whole = t.floor();
        let t = t - whole;
        let moved = whole.lanes();
        let at = |j: i32| {
            let sample = |k: usize| {
                let place = i
                    .wrapping_add(k as i32)
                    .wrapping_add(moved[k] as i32)
                    .wrapping_add(j);
                self.buffer[row * self.stride + (place & self.mask) as usize]
            };
            F32x4::new(sample(0), sample(1), sample(2), sample(3))
        };
        hermite4(at(-1), at(0), at(1), at(2), t)
    }

    /// four samples in a row of line `row`, the first `ahead` writes from now (what is too small to sound as 0)
    #[inline(always)]
    pub fn write4(&mut self, row: usize, ahead: usize, value: F32x4) {
        let value = value.flush();
        let first = ((self.index + ahead as i32) & self.mask) as usize;
        if first >= GUARD && first + 4 <= self.size {
            let from = row * self.stride + first;
            value.store(&mut self.buffer[from..from + 4]);
            return;
        }
        self.write_each(row, first, value);
    }

    // write4 at the ends of the ring (its guard, its wrap): each sample on its own
    #[inline(never)]
    fn write_each(&mut self, row: usize, first: usize, value: F32x4) {
        let line = &mut self.buffer[row * self.stride..(row + 1) * self.stride];
        for (k, sample) in value.lanes().into_iter().enumerate() {
            let place = (first + k) & (self.size - 1);
            line[place] = sample;
            if place < GUARD {
                line[self.size + place] = sample;
            }
        }
    }

    /// a sample of line `row`, `ahead` writes from now
    #[inline(always)]
    pub fn write1(&mut self, row: usize, ahead: usize, value: f32) {
        let place = ((self.index + ahead as i32) & self.mask) as usize;
        let sample = if value.abs() < TINY { 0.0 } else { value };
        self.buffer[row * self.stride + place] = sample;
        if place < GUARD {
            self.buffer[row * self.stride + self.size + place] = sample;
        }
    }

    /// a sample of each line, `ahead` writes from now
    #[inline(always)]
    pub fn write(&mut self, ahead: usize, value: F32x4) {
        let place = ((self.index + ahead as i32) & self.mask) as usize;
        for (row, sample) in value.flush().lanes().into_iter().enumerate() {
            self.buffer[row * self.stride + place] = sample;
            if place < GUARD {
                self.buffer[row * self.stride + self.size + place] = sample;
            }
        }
    }

    /// `frames` samples of every line are written: the next ones come after them
    #[inline(always)]
    pub fn advance(&mut self, frames: usize) {
        self.index = (self.index + frames as i32) & self.mask;
    }

    pub fn clear(&mut self) {
        self.buffer.fill(0.0);
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

/// the loudest sample of a block in lanes (a NaN stays)
pub fn loudest(data: &[f32]) -> f32 {
    let mut lanes = F32x4::splat(0.0);
    let mut chunks = data.chunks_exact(4);
    for chunk in &mut chunks {
        lanes = lanes.max(F32x4::load(chunk).abs());
    }
    let [a, b, c, d] = lanes.lanes();
    let mut peak = F32x4::new(a, b, 0.0, 0.0).max(F32x4::new(c, d, 0.0, 0.0));
    for value in chunks.remainder() {
        peak = peak.max(F32x4::splat(value.abs()));
    }
    let [a, b, ..] = peak.lanes();
    louder(a, b)
}

/// the louder of two peaks (a NaN stays: f32::max would drop it)
pub fn louder(a: f32, b: f32) -> f32 {
    F32x4::splat(a).max(F32x4::splat(b)).lanes()[0]
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

    // Rows against Lines<4>, to the bit: the samples of a line four in a row (delays that glide, jump, sit at the
    // clamp, are not numbers; over the wrap of the ring and of its index), an allpass in groups of four
    #[test]
    fn rows_read_and_write_as_four_lines_do() {
        let mut next = noise(5);
        let (mut lines, mut allpasses) = (Lines::<4>::new(300.0), Lines::<4>::new(300.0));
        let (mut rows, mut turned) = (Rows::new(300.0), Rows::new(300.0));
        let bits = |values: [f32; 4]| values.map(f32::to_bits);
        let mut glide: [f64; 4] = [40.3, 7.0, 150.9, 299.0];
        for group in 0..3000 {
            // the delays of the four samples of each line: gliding, with a jump or a NaN now and then
            let delays: [[f64; 4]; 4] = core::array::from_fn(|row| {
                core::array::from_fn(|k| {
                    glide[row] += 0.37 * next();
                    glide[row] = glide[row].clamp(6.5, 299.5);
                    match (group + row) % 97 {
                        13 if k == 2 => 250.0 * (next() + 1.0) / 2.0 + 6.0,
                        29 => f64::NAN,
                        _ => glide[row],
                    }
                })
            });
            let inputs: [[f32; 4]; 4] = core::array::from_fn(|_| core::array::from_fn(|_| next() as f32));
            // sample after sample, four lines in the lanes
            let mut read = [[0.0f32; 4]; 4];
            let mut passed = [[0.0f32; 4]; 4];
            for k in 0..4 {
                let delay = [
                    F64x2::new(delays[0][k], delays[1][k]),
                    F64x2::new(delays[2][k], delays[3][k]),
                ];
                let delayed = lines.read(delay);
                let out = allpasses.allpass(delayed, delay, F32x4::splat(0.5)).lanes();
                for row in 0..4 {
                    read[row][k] = delayed.lanes()[row];
                    passed[row][k] = out[row];
                }
                lines.write(F32x4::new(inputs[0][k], inputs[1][k], inputs[2][k], inputs[3][k]));
            }
            // line after line, four samples in the lanes
            for row in 0..4 {
                let delay = [
                    F64x2::new(delays[row][0], delays[row][1]),
                    F64x2::new(delays[row][2], delays[row][3]),
                ];
                let delayed = rows.read4(row, 0, delay);
                assert_eq!(bits(delayed.lanes()), bits(read[row]), "group {group} line {row}");
                let behind = turned.read4(row, 0, delay);
                let sum = delayed + F32x4::splat(0.5) * behind;
                turned.write4(row, 0, sum);
                let out = behind - F32x4::splat(0.5) * sum;
                assert_eq!(
                    bits(out.lanes()),
                    bits(passed[row]),
                    "allpass, group {group} line {row}"
                );
            }
            for k in 0..4 {
                rows.write(
                    k,
                    F32x4::new(inputs[0][k], inputs[1][k], inputs[2][k], inputs[3][k]),
                );
            }
            rows.advance(4);
            turned.advance(4);
        }
    }

    #[test]
    fn rows_hold_no_denormals() {
        let mut rows = Rows::new(64.0);
        rows.write4(1, 0, F32x4::new(1e-30, -1e-39, 0.5, -1e-26));
        rows.write(4, F32x4::splat(1e-38));
        rows.write1(2, 5, 1e-40);
        assert!(rows.buffer.iter().all(|x| *x == 0.0 || x.abs() >= TINY));
        assert_eq!(rows.buffer.iter().filter(|x| **x != 0.0).count(), 2);
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

    // a read of a line of delays is the one of read4 (to the rounding of its shares in f32), whether its samples
    // stay within their own or a delay crosses one, and a lane is the same whichever of its four asks
    #[test]
    fn a_line_of_delays_reads_what_the_delays_do() {
        let mut rows = Rows::new(4000.0);
        let mut seed = 5u32;
        let mut noise = || {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            (seed >> 8) as f32 / (1 << 23) as f32 - 1.0
        };
        for _ in 0..1200 {
            for row in 0..4 {
                rows.write1(row, 0, noise());
            }
            rows.advance(1);
        }
        for (delay, slope) in [
            (40.25, 1e-4),
            (300.9995, 0.01),
            (7.5, -0.3),
            (2000.2, 0.7),
            (64.0, 0.0),
            (90.3, -1.6),
        ] {
            for row in 0..4 {
                let line = rows.read4_line(row, 0, delay, slope as f32).lanes();
                let each = rows
                    .read4(
                        row,
                        0,
                        [
                            F64x2::new(delay, delay + slope),
                            F64x2::new(delay + 2.0 * slope, delay + 3.0 * slope),
                        ],
                    )
                    .lanes();
                for lane in 0..4 {
                    assert!(
                        (line[lane] - each[lane]).abs() < 2e-5,
                        "{delay} {slope}: {line:?} {each:?}"
                    );
                }
                // the samples of the four after a write each: their lanes as they were
                let mut later = Rows {
                    buffer: rows.buffer.clone(),
                    ..Rows::new(4000.0)
                };
                later.index = rows.index;
                for back in 1..4 {
                    later.advance(1);
                    let lanes = later.read4_line(row, back, delay, slope as f32).lanes();
                    assert_eq!(lanes[back].to_bits(), line[back].to_bits());
                }
            }
        }
    }
}
