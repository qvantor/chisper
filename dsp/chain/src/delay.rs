//! The delay, as the native nodes it replaces played it (dsp/measurements/delay.json: renders of that graph, the
//! specs hold it to them): a line a channel, a bandpass after each (the filter of a BiquadFilterNode, its
//! coefficients once a block) inside the feedback, the echoes tapped after it; normal (each line into itself) or
//! ping-pong (the mono sum into the left line, the lines into each other); Pan delays one channel of the echoes.
//! A line is read as a DelayNode reads it: linear between two samples, never under a quantum of 128 (a DelayNode
//! in a cycle). Time glides as a tape (a pole of 100 ms a sample: the echoes bend once), Pan through a pole of
//! 10 ms, the gains in 10 ms. What a line feeds back comes a quantum late, as in that graph (Chromium renders a
//! cycle so: an echo comes Time + 128 samples after the one before, with the feedback as it is when it comes; of
//! ping-pong only the way from the left line to the right one is late): `LOOP_LATE`, a deliberate copy of the sound the presets were made with.
//!
//! The lines and the echoes are f32 (a DelayNode's), the filter doubles, both channels in its lanes. A segment of
//! 32 samples reads its lines, filters, then writes them: no sample of it is read before it is written (the
//! quantum). While nothing moves a segment is a copy out of each ring and one pass of lanes; a Time or a Pan
//! that moves reads sample by sample. A value written is flushed to 0 under 1e-25 (wasm has no flush-to-zero)

use alloc::{vec, vec::Vec};

use dsp_core::biquad::{coefficients_into, FilterType};
use dsp_core::blocks::{louder, loudest, Smoothed};
use dsp_core::power_of_two_above;
use dsp_core::simd::{F32x4, F64x2};
use jsmath::{ceil, exp, max, min};

/// the params: the seconds of the echoes (in BPM: of the division, worked out on the main thread), the feedback,
/// the mode (0 normal, 1 ping-pong), the seconds a channel comes late by (under 0 the right one), the bandpass
pub const TIME: usize = 0;
pub const FB: usize = 1;
pub const MODE: usize = 2;
pub const PAN: usize = 3;
pub const FREQ: usize = 4;
pub const Q: usize = 5;
pub const PARAMS: usize = 6;

/// seconds of a line, of the offset of a channel
pub const LINE_MAX: f64 = 4.0;
pub const PAN_MAX: f64 = 0.05;
/// the samples a line is never read under
pub const QUANTUM: f64 = 128.0;

/// the samples a line gets its feedback late by (the right line of ping-pong: what the left one sends it)
pub const LOOP_LATE: usize = 128;

const GLIDE: f64 = 0.01;
const TIME_GLIDE: f64 = 0.1;
const SILENCE: f32 = 1e-10;
const SEGMENT: usize = 32;

/// what the routes move in a block, as offsets from the knobs (seconds, gains, Hz), a value a sample: the lines of
/// `modulation`. `time` on both lines, `fb` on the gains of the mode, `pan` on the offset of each channel, the
/// filter once a block
#[derive(Default, Clone, Copy)]
pub struct Moves<'a> {
    pub time: Option<&'a [f64]>,
    pub fb: Option<&'a [f64]>,
    pub pan: [Option<&'a [f64]>; 2],
    pub freq: f64,
    pub q: f64,
}

// a ring of a power of two; `at` is where the next sample goes
struct Ring {
    data: Vec<f32>,
    mask: usize,
    at: usize,
}

impl Ring {
    fn new(samples: f64) -> Ring {
        let size = power_of_two_above(samples + SEGMENT as f64 + 2.0);
        Ring {
            data: vec![0.0; size],
            mask: size - 1,
            at: 0,
        }
    }

    fn clear(&mut self) {
        self.data.fill(0.0);
    }

    fn write(&mut self, block: &[f32]) {
        let size = self.data.len();
        let first = (size - self.at).min(block.len());
        self.data[self.at..self.at + first].copy_from_slice(&block[..first]);
        self.data[..block.len() - first].copy_from_slice(&block[first..]);
        self.at = (self.at + block.len()) & self.mask;
    }

    // out.len() samples from `back` before `at` on
    fn copy(&self, back: usize, out: &mut [f32]) {
        let size = self.data.len();
        let start = (self.at + size - back) & self.mask;
        let first = (size - start).min(out.len());
        let rest = out.len() - first;
        out[..first].copy_from_slice(&self.data[start..start + first]);
        out[first..].copy_from_slice(&self.data[..rest]);
    }

    // `count` samples of a delay that holds, from the one `back` before `at` on, each `share` of the way to the
    // next one (the lanes of a whole segment: past `count` they read zeros)
    fn read_steady(&self, back: usize, share: f32, out: &mut [f32; SEGMENT], count: usize) {
        let mut taps = [0.0f32; SEGMENT + 4];
        self.copy(back, &mut taps[..count + 1]);
        if share == 0.0 {
            out[..count].copy_from_slice(&taps[..count]);
            return;
        }
        let share = F32x4::splat(share);
        for i in (0..SEGMENT).step_by(4) {
            let a = F32x4::load(&taps[i..i + 4]);
            let b = F32x4::load(&taps[i + 1..i + 5]);
            (a + share * (b - a)).store(&mut out[i..i + 4]);
        }
    }

    // the sample `delay` before the one `ahead` of `at`, linear between two (the share as read_steady has it: the
    // same bits)
    #[inline(always)]
    fn tap(&self, ahead: usize, delay: f64) -> f32 {
        let whole = ceil(delay);
        let share = (whole - delay) as f32;
        let at = self.at + ahead + self.data.len() - whole as usize;
        let a = self.data[at & self.mask];
        let b = self.data[(at + 1) & self.mask];
        a + share * (b - a)
    }
}

// a value that follows its target through a pole stepped every sample (setTargetAtTime of an AudioParam), at its
// target once near, as Chromium has it: within e^-10 of it (ten time constants), of a target of 0 under `zero`
#[derive(Clone, Copy)]
struct Pole {
    value: f64,
    target: f64,
    step: f64,
    zero: f64,
}

// (measured on the offset of a channel: between 2.8e-5 and 7.5e-5 s)
const NEAR: f64 = 4.539992976248485e-5;

impl Pole {
    // `unit`: what 1 of the AudioParam is in the units of the value (a time in samples: the rate)
    fn new(value: f64, seconds: f64, sample_rate: f64, unit: f64) -> Pole {
        Pole {
            value,
            target: value,
            step: 1.0 - exp(-1.0 / (seconds * sample_rate)),
            zero: NEAR * unit,
        }
    }

    fn moving(&self) -> bool {
        self.value != self.target
    }

    // the value of this sample, then a step to the next one
    #[inline(always)]
    fn next(&mut self) -> f64 {
        let value = self.value;
        if value != self.target {
            self.value += (self.target - value) * self.step;
            let left = (self.target - self.value).abs();
            if left < NEAR * self.target.abs() || (self.target == 0.0 && left < self.zero) {
                self.value = self.target;
            }
        }
        value
    }
}

// the bandpass of both channels (left in the low lane) in the form a BiquadFilterNode has it: its state is the
// two samples before of its input and of its output, so coefficients that move mid-sound ring as its do (the
// transposed form of dsp_core keeps sums of them: the same filter while they hold, another one while they glide)
#[derive(Default)]
struct Bandpass {
    c: [f64; 5],
    x1: F64x2,
    x2: F64x2,
    y1: F64x2,
    y2: F64x2,
}

impl Bandpass {
    fn process_block(&mut self, input: &[F64x2], output: &mut [F64x2], frames: usize) {
        let [b0, b1, b2, a1, a2] = self.c.map(F64x2::splat);
        let (mut x1, mut x2, mut y1, mut y2) = (self.x1, self.x2, self.y1, self.y2);
        for (x, y) in input[..frames].iter().zip(output[..frames].iter_mut()) {
            let x = *x;
            let out = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
            x2 = x1;
            x1 = x;
            y2 = y1;
            y1 = out;
            *y = out;
        }
        (self.x1, self.x2, self.y1, self.y2) = (x1, x2, y1, y2);
    }

    fn clear(&mut self) {
        self.x1 = F64x2::default();
        self.x2 = F64x2::default();
        self.y1 = F64x2::default();
        self.y2 = F64x2::default();
    }
}

fn clamp(value: f64, low: f64, high: f64) -> f64 {
    min(max(value, low), high)
}

#[inline(always)]
fn flushed(value: f32) -> f32 {
    if value.abs() < 1e-25 {
        0.0
    } else {
        value
    }
}

pub struct Delay {
    sample_rate: f64,
    // the samples of the echoes, of the offset of each channel
    time: Pole,
    pans: [Pole; 2],
    feedback: Pole,
    // the share of ping-pong in the gains
    cross: Pole,
    freq: Smoothed,
    q: Smoothed,
    // the bandpass as its coefficients have it
    designed: (f64, f64),
    filter: Bandpass,
    lines: [Ring; 2],
    offsets: [Ring; 2],
    longest: f64,
    idle: bool,
    quiet_frames: f64,
    silent_frames: f64,
    #[cfg(test)]
    pub(crate) sample_by_sample: bool,
}

// a value as an AudioParam holds it: the nodes this delay is held to read their times and their filter in f32
fn single(value: f64) -> f64 {
    value as f32 as f64
}

fn sides(pan: f64, sample_rate: f64) -> [f64; 2] {
    let pan = clamp(pan, -PAN_MAX, PAN_MAX);
    [
        single(max(0.0, pan)) * sample_rate,
        single(max(0.0, -pan)) * sample_rate,
    ]
}

fn mode(value: f64) -> f64 {
    if value >= 0.5 {
        1.0
    } else {
        0.0
    }
}

impl Delay {
    pub fn new(sample_rate: f64, params: &[f64; PARAMS]) -> Delay {
        let longest = LINE_MAX * sample_rate;
        // (the rings of the offsets keep the quantum the feedback is late by too)
        let room = max(PAN_MAX * sample_rate, LOOP_LATE as f64);
        let [left, right] = sides(params[PAN], sample_rate);
        let mut delay = Delay {
            sample_rate,
            time: Pole::new(
                single(params[TIME]) * sample_rate,
                TIME_GLIDE,
                sample_rate,
                sample_rate,
            ),
            pans: [
                Pole::new(left, GLIDE, sample_rate, sample_rate),
                Pole::new(right, GLIDE, sample_rate, sample_rate),
            ],
            feedback: Pole::new(params[FB], GLIDE, sample_rate, 1.0),
            cross: Pole::new(mode(params[MODE]), GLIDE, sample_rate, 1.0),
            freq: Smoothed::new(params[FREQ], GLIDE, sample_rate),
            q: Smoothed::new(params[Q], GLIDE, sample_rate),
            designed: (f64::NAN, f64::NAN),
            filter: Bandpass::default(),
            lines: [Ring::new(longest), Ring::new(longest)],
            offsets: [Ring::new(room), Ring::new(room)],
            longest,
            idle: true,
            quiet_frames: 0.0,
            silent_frames: 0.0,
            #[cfg(test)]
            sample_by_sample: false,
        };
        delay.design(0.0, 0.0);
        delay
    }

    pub fn idle(&self) -> bool {
        self.idle
    }

    /// params by key (the bits of `present`); an idle delay takes them at once
    pub fn set(&mut self, present: u32, changes: &[f64; PARAMS]) {
        let has = |key: usize| present & (1 << key) != 0;
        if has(TIME) {
            self.time.target = single(changes[TIME]) * self.sample_rate;
        }
        if has(PAN) {
            let targets = sides(changes[PAN], self.sample_rate);
            self.pans[0].target = targets[0];
            self.pans[1].target = targets[1];
        }
        if has(FB) {
            self.feedback.target = changes[FB];
        }
        if has(MODE) {
            self.cross.target = mode(changes[MODE]);
        }
        if has(FREQ) {
            self.freq.set(changes[FREQ], self.idle, None);
        }
        if has(Q) {
            self.q.set(changes[Q], self.idle, None);
        }
        if self.idle {
            self.snap();
        }
    }

    fn snap(&mut self) {
        self.time.value = self.time.target;
        self.pans[0].value = self.pans[0].target;
        self.pans[1].value = self.pans[1].target;
        self.feedback.value = self.feedback.target;
        self.cross.value = self.cross.target;
        self.freq.snap();
        self.q.snap();
    }

    // the coefficients of the bandpass of a block: the knobs as its first sample has them (a k-rate AudioParam),
    // moved by their routes
    fn design(&mut self, freq: f64, q: f64) {
        let designed = (single(self.freq.from + freq), single(self.q.from + q));
        if designed != self.designed {
            self.designed = designed;
            coefficients_into(
                &mut self.filter.c,
                Some(FilterType::Bandpass),
                designed.0,
                designed.1,
                0.0,
                self.sample_rate,
            );
        }
    }

    /// the echoes are forgotten: the next sound starts at the params as they are then
    pub fn forget(&mut self) {
        if !self.idle {
            for ring in self.lines.iter_mut().chain(self.offsets.iter_mut()) {
                ring.clear();
            }
        }
        self.filter.clear();
        self.idle = true;
        self.silent_frames = 0.0;
    }

    // `count` samples from `s` of a block of `frames`
    #[inline(always)]
    fn segment(
        &mut self,
        input: [&[f32]; 2],
        out_l: &mut [f32],
        out_r: &mut [f32],
        s: usize,
        count: usize,
        moves: &Moves,
        steady: bool,
    ) {
        let rate = self.sample_rate;
        // the lines, read before this segment is written
        let mut read = [[0.0f32; SEGMENT]; 2];
        let held = !self.time.moving() && moves.time.is_none();
        #[cfg(test)]
        let held = held && !self.sample_by_sample;
        if held {
            let delay = clamp(self.time.value, QUANTUM, self.longest);
            let whole = ceil(delay);
            let share = (whole - delay) as f32;
            for channel in 0..2 {
                self.lines[channel].read_steady(whole as usize, share, &mut read[channel], count);
            }
        } else {
            for i in 0..count {
                let moved = moves.time.map_or(0.0, |offsets| offsets[s + i]) * rate;
                let delay = clamp(self.time.next() + moved, QUANTUM, self.longest);
                read[0][i] = self.lines[0].tap(i, delay);
                read[1][i] = self.lines[1].tap(i, delay);
            }
        }

        // the bandpass of both channels
        let mut dry = [F64x2::default(); SEGMENT];
        let mut wet = [F64x2::default(); SEGMENT];
        for i in 0..count {
            dry[i] = F64x2::new(read[0][i] as f64, read[1][i] as f64);
        }
        self.filter.process_block(&dry, &mut wet, count);
        let mut echo = [[0.0f32; SEGMENT]; 2];
        for i in 0..count {
            echo[0][i] = wet[i].lo() as f32;
            echo[1][i] = wet[i].hi() as f32;
        }

        // into the lines: the input and the feedback by the mode
        let mut source = [[0.0f32; SEGMENT]; 2];
        source[0][..count].copy_from_slice(&input[0][s..s + count]);
        source[1][..count].copy_from_slice(&input[1][s..s + count]);
        // (the echoes of a quantum ago, out of the rings of the offsets: what a line feeds back comes that late,
        // with the gain of now)
        let mut old = [[0.0f32; SEGMENT]; 2];
        self.offsets[0].copy(LOOP_LATE, &mut old[0][..count]);
        self.offsets[1].copy(LOOP_LATE, &mut old[1][..count]);
        let mut written = [[0.0f32; SEGMENT]; 2];
        #[cfg(test)]
        let steady = steady && !self.sample_by_sample;
        if steady {
            let feedback = F32x4::splat(self.feedback.value as f32);
            let ping_pong = self.cross.value != 0.0;
            let half = F32x4::splat(0.5);
            for i in (0..SEGMENT).step_by(4) {
                let [in_l, in_r] = [0, 1].map(|channel| F32x4::load(&source[channel][i..i + 4]));
                let [old_l, old_r] = [0, 1].map(|channel| F32x4::load(&old[channel][i..i + 4]));
                let (left, right) = if ping_pong {
                    let echo_r = F32x4::load(&echo[1][i..i + 4]);
                    (in_l * half + in_r * half + echo_r * feedback, old_l * feedback)
                } else {
                    (in_l + old_l * feedback, in_r + old_r * feedback)
                };
                left.flush().store(&mut written[0][i..i + 4]);
                right.flush().store(&mut written[1][i..i + 4]);
            }
        } else {
            for i in 0..count {
                let moved = moves.fb.map_or(0.0, |offsets| offsets[s + i]);
                let feedback = self.feedback.next() + moved;
                let cross = self.cross.next();
                let own = (feedback * (1.0 - cross)) as f32;
                let other = (feedback * cross) as f32;
                let (in_l, in_r) = (source[0][i], source[1][i]);
                let left = in_l * (1.0 - 0.5 * cross) as f32
                    + in_r * (0.5 * cross) as f32
                    + echo[1][i] * other
                    + old[0][i] * own;
                let right = in_r * (1.0 - cross) as f32 + old[1][i] * own + old[0][i] * other;
                written[0][i] = flushed(left);
                written[1][i] = flushed(right);
            }
        }
        self.lines[0].write(&written[0][..count]);
        self.lines[1].write(&written[1][..count]);

        // the echoes out, a channel late by its offset
        let outs = [&mut out_l[s..s + count], &mut out_r[s..s + count]];
        for (channel, out) in outs.into_iter().enumerate() {
            let pan = &mut self.pans[channel];
            let offsets = moves.pan[channel];
            let ring = &mut self.offsets[channel];
            ring.write(&echo[channel][..count]);
            let held = !pan.moving() && offsets.is_none();
            if held && pan.value == 0.0 {
                out.copy_from_slice(&echo[channel][..count]);
            } else if held {
                let whole = ceil(pan.value);
                let share = (whole - pan.value) as f32;
                let mut late = [0.0f32; SEGMENT];
                ring.read_steady(count + whole as usize, share, &mut late, count);
                out.copy_from_slice(&late[..count]);
            } else {
                let longest = PAN_MAX * rate;
                for i in 0..count {
                    let moved = offsets.map_or(0.0, |offsets| offsets[s + i]) * rate;
                    let delay = clamp(pan.next() + moved, 0.0, longest);
                    // (written already: `count` - i before `at`)
                    out[i] = ring.tap(ring.data.len() - count + i, delay);
                }
            }
        }
    }

    pub fn process(
        &mut self,
        in_l: &[f32],
        in_r: &[f32],
        out_l: &mut [f32],
        out_r: &mut [f32],
        moves: &Moves,
    ) {
        let frames = out_l.len();
        let n = frames as f64;
        // (a NaN is not quiet)
        let input = louder(loudest(in_l), loudest(in_r));
        self.quiet_frames = if input < SILENCE {
            self.quiet_frames + n
        } else {
            0.0
        };
        if self.idle {
            if self.quiet_frames != 0.0 {
                out_l.fill(0.0);
                out_r.fill(0.0);
                return;
            }
            self.idle = false;
            self.snap();
        }

        self.freq.step(n);
        self.q.step(n);
        self.design(moves.freq, moves.q);

        let mut s = 0;
        while s < frames {
            let count = SEGMENT.min(frames - s);
            // (the gains of a segment hold: its lanes)
            let steady = !self.feedback.moving() && !self.cross.moving() && moves.fb.is_none();
            self.segment([in_l, in_r], out_l, out_r, s, count, moves, steady);
            s += count;
        }

        // a block that isn't finite (its input is: the chain; NaN through a path no one saw) would stay in the
        // lines for good: forgotten, the block is silence
        let output = louder(loudest(out_l), loudest(out_r));
        if !output.is_finite() {
            self.forget();
            out_l.fill(0.0);
            out_r.fill(0.0);
            return;
        }

        // silent in and out for longer than the echoes and the offset take: nothing left to come back
        self.silent_frames = if output < SILENCE {
            self.silent_frames + n
        } else {
            0.0
        };
        let longest = max(self.time.value, self.time.target)
            + PAN_MAX * self.sample_rate
            + QUANTUM
            + LOOP_LATE as f64
            + n;
        if self.quiet_frames > longest && self.silent_frames > longest {
            self.forget();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;
    use alloc::vec::Vec;

    // a seeded noise in [-1, 1)
    fn noise(seed: u32) -> impl FnMut() -> f32 {
        let mut state = seed;
        move || {
            state = state.wrapping_mul(1664525).wrapping_add(1013904223);
            (state >> 8) as f32 / 8388608.0 - 1.0
        }
    }

    fn render(
        delay: &mut Delay,
        input: &[Vec<f32>; 2],
        blocks: &mut dyn FnMut() -> usize,
        mut before: impl FnMut(&mut Delay, usize),
    ) -> [Vec<f32>; 2] {
        let frames = input[0].len();
        let mut out = [vec![0.0f32; frames], vec![0.0f32; frames]];
        let mut at = 0;
        while at < frames {
            let count = blocks().min(frames - at);
            before(delay, at);
            let [left, right] = &mut out;
            delay.process(
                &input[0][at..at + count],
                &input[1][at..at + count],
                &mut left[at..at + count],
                &mut right[at..at + count],
                &Moves::default(),
            );
            at += count;
        }
        out
    }

    fn bits(data: &[f32]) -> Vec<u32> {
        data.iter().map(|value| value.to_bits()).collect()
    }

    const PARAMS_OF: [[f64; PARAMS]; 4] = [
        [0.0123, 0.7, 0.0, 0.0, 1000.0, 0.01],
        [0.02, 0.85, 1.0, 0.0071, 3000.0, 2.0],
        [0.005, 0.5, 0.0, -0.0123, 300.0, 0.7],
        [0.05, 0.9, 1.0, 0.05, 9000.0, 0.3],
    ];

    // the copies and the lanes of a segment are the taps and the sums of a sample after the other, however the
    // blocks are cut, while the knobs hold and as they glide
    #[test]
    fn the_segments_render_what_a_sample_after_the_other_would() {
        for (case, &rate) in [22050.0, 44100.0, 96000.0, 192000.0].iter().enumerate() {
            let params = PARAMS_OF[case];
            let mut source = noise(7 + case as u32);
            let frames = 30000;
            let input = [
                (0..frames).map(|_| source() * 0.5).collect::<Vec<f32>>(),
                (0..frames).map(|_| source() * 0.5).collect::<Vec<f32>>(),
            ];
            let mut lengths = noise(99);
            let mut cut = || 1 + ((lengths() + 1.0) * 150.0) as usize;
            let mut fast = Delay::new(rate, &params);
            let rendered = render(&mut fast, &input, &mut cut, |_, _| {});
            let mut slow = Delay::new(rate, &params);
            slow.sample_by_sample = true;
            let mut one = || 1usize;
            let reference = render(&mut slow, &input, &mut one, |_, _| {});
            assert_eq!(bits(&rendered[0]), bits(&reference[0]), "left at {rate}");
            assert_eq!(bits(&rendered[1]), bits(&reference[1]), "right at {rate}");
            assert!(rendered[0].iter().any(|value| value.abs() > 0.01));
        }
    }

    // a knob that changes at a frame glides the same in blocks of 128 and sample by sample (the filter is of a
    // block: left as it is)
    #[test]
    fn the_glides_do_not_follow_the_blocks() {
        let rate = 48000.0;
        let mut source = noise(3);
        let frames = 128 * 200;
        let input = [
            (0..frames).map(|_| source() * 0.5).collect::<Vec<f32>>(),
            (0..frames).map(|_| source() * 0.5).collect::<Vec<f32>>(),
        ];
        let change = |delay: &mut Delay, at: usize| {
            if at == 128 * 20 {
                let mut values = [0.0; PARAMS];
                values[TIME] = 0.03;
                values[FB] = 0.2;
                values[MODE] = 1.0;
                values[PAN] = -0.004;
                delay.set(1 << TIME | 1 << FB | 1 << MODE | 1 << PAN, &values);
            }
        };
        let mut fast = Delay::new(rate, &PARAMS_OF[0]);
        let mut quantum = || 128usize;
        let rendered = render(&mut fast, &input, &mut quantum, change);
        let mut slow = Delay::new(rate, &PARAMS_OF[0]);
        slow.sample_by_sample = true;
        let mut cut = || 128usize;
        let reference = render(&mut slow, &input, &mut cut, change);
        assert_eq!(bits(&rendered[0]), bits(&reference[0]));
        assert_eq!(bits(&rendered[1]), bits(&reference[1]));
    }

    // a click comes back after Time, then every Time and a quantum
    #[test]
    fn an_echo_comes_a_quantum_after_the_time() {
        let rate = 44100.0;
        let mut delay = Delay::new(rate, &[441.0 / rate, 0.5, 0.0, 0.0, 1000.0, 0.01]);
        let frames = 4096;
        let mut input = [vec![0.0f32; frames], vec![0.0f32; frames]];
        input[0][0] = 1.0;
        let mut quantum = || 128usize;
        let out = render(&mut delay, &input, &mut quantum, |_, _| {});
        // (the first sample of each: the bandpass rings after it)
        let loud: Vec<usize> = (1..frames)
            .filter(|&i| out[0][i].abs() > 0.1 && out[0][i - 1].abs() <= 0.1 && out[0][i - 2].abs() <= 0.1)
            .collect();
        assert_eq!(loud, vec![441, 441 + 569, 441 + 2 * 569]);
        assert!(out[1].iter().all(|value| *value == 0.0));
    }

    // NaN or an infinity past the chain (it zeroes them, process doesn't) goes into a line: the block it would
    // come out in is silence, the lines forget it, the next blocks sound, a silence goes idle
    #[test]
    fn a_block_that_is_not_finite_is_forgotten() {
        let rate = 48000.0;
        let mut delay = Delay::new(rate, &PARAMS_OF[0]);
        let mut source = noise(5);
        let block = |source: &mut dyn FnMut() -> f32| (0..128).map(|_| source() * 0.5).collect::<Vec<f32>>();
        let mut out = [vec![0.0f32; 128], vec![0.0f32; 128]];
        let run = |delay: &mut Delay, input: &[f32], out: &mut [Vec<f32>; 2]| {
            let [left, right] = out;
            delay.process(input, input, left, right, &Moves::default());
        };
        for _ in 0..20 {
            run(&mut delay, &block(&mut source), &mut out);
        }
        assert!(out[0].iter().any(|value| *value != 0.0));
        let mut bad = block(&mut source);
        bad[17] = f32::NAN;
        run(&mut delay, &bad, &mut out);
        let mut forgot = false;
        let mut sounded = false;
        for _ in 0..40 {
            run(&mut delay, &block(&mut source), &mut out);
            assert!(out[0].iter().chain(out[1].iter()).all(|value| value.is_finite()));
            if delay.idle() {
                forgot = true;
                assert!(out[0].iter().chain(out[1].iter()).all(|value| *value == 0.0));
            } else if forgot {
                sounded = sounded || out[0].iter().any(|value| *value != 0.0);
            }
        }
        assert!(forgot && sounded);
        let silence = vec![0.0f32; 128];
        for _ in 0..(rate as usize) {
            run(&mut delay, &silence, &mut out);
            if delay.idle() {
                break;
            }
        }
        assert!(delay.idle());
        run(&mut delay, &silence, &mut out);
        assert!(out[0].iter().all(|value| *value == 0.0));
    }
}
