//! The delay, as the one of the Audio Unit plays (dsp/measurements/delay.json: clicks through its rack, the specs
//! hold this one to them): a line a channel, a bandpass after each inside the feedback, the echoes tapped after
//! it. Normal: each line into itself. Ping-pong: the mono sum into the left line, its echoes into the right one,
//! which gives them back as they are (no filter, no gain: the right echo is the left one a Time later) and feeds
//! the left line with them. What a line is fed back comes a sample late (measured: an echo comes Time after the
//! sound, then every Time + 1 sample). Pan delays one channel of the echoes (ours: the Audio Unit has none).
//!
//! A Time that holds is a whole number of samples (the Audio Unit's: its echoes are never between two samples, so
//! a repeat loses no highs to the reading), an offset of a channel too: a read is a copy out of the ring. A Time
//! on its way or under a route reads linear between two samples, a tape: its knob through a pole of
//! TIME_SMOOTHING a sample, its routes (and those of Pan) through the same one at the points of their lines (the
//! chain's modulation), as the Audio Unit follows its time and the LFOs on it (measured: `lfo` of delay.json, the
//! two the one pole of their sum); Pan a pole of 10 ms, the gains glide in 10 ms. A time holds once within 1e-5
//! of a sample of its knob (the read jumps by no more than that). A line is never read under SHORTEST samples:
//! a segment of up to 128 reads its lines, filters, then writes them, no sample of it read before it is written.
//!
//! The lines and the echoes are f32, the filter doubles, both channels in its lanes (the right one of ping-pong
//! runs on for the way back to normal), two samples a step (`Kept`). A value written is flushed to 0 under 1e-25
//! (wasm has no flush-to-zero), an echo out of the filter too, the outputs the bandpass keeps under TINY_F64
//! every 32 samples (a line emptied while the other one plays). While nothing moves a segment is one loop of
//! four samples at once from the rings into them (`fused`): the bits of the passes of the plain order, which a
//! segment takes when a knob moves, a ring wraps in it or it is no whole fours

use alloc::boxed::Box;
use alloc::{vec, vec::Vec};

use dsp_core::biquad::{coefficients_into, FilterType};
use dsp_core::blocks::{louder, loudest, Smoothed};
use dsp_core::power_of_two_above;
use dsp_core::simd::{F32x4, F64x2};
use jsmath::{ceil, exp, floor, max, min};

use crate::units::Moves;

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

const SEGMENT: usize = 128;
/// the samples a line is never read under (a segment reads them before it writes: the two samples of a read
/// between are both written)
const SHORTEST: f64 = (SEGMENT + 1) as f64;
// the samples between two flushes of what the bandpass keeps
const FLUSH: usize = 32;

const GLIDE: f64 = 0.01;
/// seconds of the one-pole the time goes through, its knob and its routes (and those of Pan): the Audio Unit's,
/// an LFO on its times at 2 to 16 Hz (delay.json, `lfo`: 22.7 ms, within 3 samples of its renders)
pub const TIME_SMOOTHING: f64 = 0.0227;
const SILENCE: f32 = 1e-10;

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

    // where the sample `delay` before the one `ahead` of `at` is: the sample at or before it, the share of the
    // way to the next one (the same of every ring written alike)
    #[inline(always)]
    fn place(&self, ahead: usize, delay: f64) -> (usize, f32) {
        let whole = ceil(delay);
        (
            self.at + ahead + self.data.len() - whole as usize,
            (whole - delay) as f32,
        )
    }

    // the sample of a place, linear between two (a whole delay: the sample itself, the bits of `copy`)
    #[inline(always)]
    fn read(&self, (at, share): (usize, f32)) -> f32 {
        let a = self.data[at & self.mask];
        let b = self.data[(at + 1) & self.mask];
        a + share * (b - a)
    }
}

// a value that follows its target through a pole stepped every sample, at its target once within `near` of it
#[derive(Clone, Copy)]
struct Pole {
    value: f64,
    target: f64,
    step: f64,
    near: f64,
}

// a gain: within e^-10 of 1 (ten time constants)
const NEAR_GAIN: f64 = 4.539992976248485e-5;
// a time in samples: where it holds, the read jumps by that share of a sample (the step of a tone at full scale
// under -90 dB; a share of the knob was samples of a long Time)
pub(crate) const NEAR_SAMPLES: f64 = 1e-5;

impl Pole {
    fn new(value: f64, seconds: f64, sample_rate: f64, near: f64) -> Pole {
        Pole {
            value,
            target: value,
            step: 1.0 - exp(-1.0 / (seconds * sample_rate)),
            near,
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
            if (self.target - self.value).abs() < self.near {
                self.value = self.target;
            }
        }
        value
    }
}

// the arrays of a segment: a sample after the one before it (index 0: the last one of the segment before), room
// for the lanes of its end
const ROOM: usize = SEGMENT + 4;

// the coefficients of the bandpass in the lanes of both channels (b1 of a bandpass is 0), and those of the
// second sample of a pair: a1² - a2, a1 a2
#[derive(Clone, Copy)]
struct Coefs {
    b0: F64x2,
    b2: F64x2,
    a1: F64x2,
    a2: F64x2,
    c1: F64x2,
    c2: F64x2,
}

// what the bandpass keeps of both channels (left in the low lane): the two samples before of its input, the
// three of its output, the part of the input of the sample before (t = b0 x + b2 x2). Two samples a step: the
// first of a pair by the two outputs before it, the second by the same two (y[n] = t[n] - a1 t[n-1] + (a1² - a2)
// y[n-2] + a1 a2 y[n-3]: the sum of the first with the sample between worked in), so a pair waits for the pair
// before over one product and one sum, not two. Which samples are second is counted from the first one that
// sounds after a silence: however the blocks are cut, the same sums. A new design keeps the pair it comes in the
// middle of (`Bandpass::design`)
#[derive(Clone, Copy, Default)]
struct Kept {
    x1: F64x2,
    x2: F64x2,
    y1: F64x2,
    y2: F64x2,
    y3: F64x2,
    t1: F64x2,
}

impl Kept {
    // a sample alone, the first of a pair
    #[inline(always)]
    fn first(&mut self, k: &Coefs, x: F64x2) -> F64x2 {
        let t = k.b0 * x + k.b2 * self.x2;
        let out = (t - k.a2 * self.y2) - k.a1 * self.y1;
        (self.x2, self.x1, self.t1) = (self.x1, x, t);
        (self.y3, self.y2, self.y1) = (self.y2, self.y1, out);
        out
    }

    // a sample alone, the second of a pair
    #[inline(always)]
    fn second(&mut self, k: &Coefs, x: F64x2) -> F64x2 {
        let t = k.b0 * x + k.b2 * self.x2;
        let out = ((t - k.a1 * self.t1) + k.c2 * self.y3) + k.c1 * self.y2;
        (self.x2, self.x1, self.t1) = (self.x1, x, t);
        (self.y3, self.y2, self.y1) = (self.y2, self.y1, out);
        out
    }

    // a pair at once: the sums of `first`, then of `second`
    #[inline(always)]
    fn pair(&mut self, k: &Coefs, x: F64x2, next: F64x2) -> (F64x2, F64x2) {
        let t = k.b0 * x + k.b2 * self.x2;
        let after = k.b0 * next + k.b2 * self.x1;
        let out = (t - k.a2 * self.y2) - k.a1 * self.y1;
        let second = ((after - k.a1 * t) + k.c2 * self.y2) + k.c1 * self.y1;
        (self.x2, self.x1, self.t1) = (x, next, after);
        (self.y3, self.y2, self.y1) = (self.y1, out, second);
        (out, second)
    }

    // four samples of the left channel and of the right one to doubles in lanes, their echoes back (in f32 under
    // TINY as 0): two pairs, or (`odd`: the first one the second of a pair) the end of a pair, a pair and the
    // start of the next one (`first` then `second` are the sums of `pair`)
    #[inline(always)]
    fn quad(&mut self, k: &Coefs, left: F32x4, right: F32x4, odd: bool) -> (F32x4, F32x4) {
        let (a, b) = left.pick::<0, 4, 1, 5>(right).to_f64();
        let (c, d) = left.pick::<2, 6, 3, 7>(right).to_f64();
        let (o0, o1, o2, o3) = if odd {
            let o0 = self.second(k, a);
            let (o1, o2) = self.pair(k, b, c);
            (o0, o1, o2, self.first(k, d))
        } else {
            let (o0, o1) = self.pair(k, a, b);
            let (o2, o3) = self.pair(k, c, d);
            (o0, o1, o2, o3)
        };
        let (low, high) = (F32x4::from_f64(o0, o1), F32x4::from_f64(o2, o3));
        (
            low.pick::<0, 2, 4, 6>(high).flush(),
            low.pick::<1, 3, 5, 7>(high).flush(),
        )
    }

    #[inline(always)]
    fn flush(&mut self) {
        self.y1 = self.y1.flush();
        self.y2 = self.y2.flush();
        self.y3 = self.y3.flush();
    }
}

#[derive(Default)]
struct Bandpass {
    c: [f64; 5],
    kept: Kept,
    // the next sample is the second of a pair
    second: bool,
}

impl Bandpass {
    #[inline(always)]
    fn coefs(&self) -> Coefs {
        let [b0, _, b2, a1, a2] = self.c.map(F64x2::splat);
        Coefs {
            b0,
            b2,
            a1,
            a2,
            c1: a1 * a1 - a2,
            c2: a1 * a2,
        }
    }

    // `frames` samples of both channels (`[1 + i]` of sample i), the echoes out the same way
    #[inline(always)]
    fn process_block(&mut self, input: &[[f32; ROOM]; 2], output: &mut [[f32; ROOM]; 2], frames: usize) {
        let k = self.coefs();
        let mut kept = self.kept;
        let sample = |i: usize| F64x2::new(input[0][1 + i] as f64, input[1][1 + i] as f64);
        let put = |output: &mut [[f32; ROOM]; 2], i: usize, out: F64x2| {
            output[0][1 + i] = flushed(out.lo() as f32);
            output[1][1 + i] = flushed(out.hi() as f32);
        };
        let mut i = 0;
        if self.second && frames > 0 {
            put(output, 0, kept.second(&k, sample(0)));
            i = 1;
        }
        let mut flush = i + FLUSH;
        while i + 4 <= frames {
            let left = F32x4::load(&input[0][1 + i..5 + i]);
            let right = F32x4::load(&input[1][1 + i..5 + i]);
            let (echo_l, echo_r) = kept.quad(&k, left, right, false);
            echo_l.store(&mut output[0][1 + i..5 + i]);
            echo_r.store(&mut output[1][1 + i..5 + i]);
            i += 4;
            if i >= flush {
                flush = i + FLUSH;
                kept.flush();
            }
        }
        if i + 2 <= frames {
            let (out, after) = kept.pair(&k, sample(i), sample(i + 1));
            put(output, i, out);
            put(output, i + 1, after);
            i += 2;
        }
        if i < frames {
            put(output, i, kept.first(&k, sample(i)));
        }
        kept.flush();
        self.second ^= frames & 1 == 1;
        self.kept = kept;
    }

    // the coefficients of a bandpass at `freq`, `q` (between two blocks). A pair the block starts in the middle of
    // goes on as if they had filtered its first sample: the second is worked from the outputs before the pair, the
    // part of the sample between (t1) the one they give the output it had (y1 = t1 - a2 y3 - a1 y2)
    fn design(&mut self, freq: f64, q: f64, sample_rate: f64) {
        coefficients_into(&mut self.c, Some(FilterType::Bandpass), freq, q, 0.0, sample_rate);
        if self.second {
            let k = self.coefs();
            let kept = &mut self.kept;
            kept.t1 = (kept.y1 + k.a2 * kept.y3) + k.a1 * kept.y2;
        }
    }

    fn clear(&mut self) {
        self.kept = Kept::default();
        self.second = false;
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

// what a segment works in (kept: nothing of it is cleared between two)
struct Scratch {
    // the lines as read, the echoes out of the bandpass: [1 + i] of sample i
    read: [[f32; ROOM]; 2],
    echo: [[f32; ROOM]; 2],
    written: [[f32; SEGMENT]; 2],
    // the right channel out while the mode is on its way
    right: [f32; SEGMENT],
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
    scratch: Box<Scratch>,
    longest: f64,
    idle: bool,
    quiet_frames: f64,
    silent_frames: f64,
    #[cfg(test)]
    pub(crate) sample_by_sample: bool,
    // (the segments the one loop took)
    #[cfg(test)]
    pub(crate) fused: usize,
}

// a time in whole samples (the nearest)
fn whole(seconds: f64, sample_rate: f64) -> f64 {
    floor(seconds * sample_rate + 0.5)
}

fn sides(pan: f64, sample_rate: f64) -> [f64; 2] {
    let pan = clamp(pan, -PAN_MAX, PAN_MAX);
    [
        whole(max(0.0, pan), sample_rate),
        whole(max(0.0, -pan), sample_rate),
    ]
}

fn mode(value: f64) -> f64 {
    if value >= 0.5 {
        1.0
    } else {
        0.0
    }
}

// four samples of a block from i (past its end: zeros)
#[inline(always)]
fn lanes(block: &[f32], i: usize) -> F32x4 {
    if i + 4 <= block.len() {
        F32x4::load(&block[i..i + 4])
    } else {
        let mut last = [0.0f32; 4];
        last[..block.len() - i].copy_from_slice(&block[i..]);
        F32x4::load(&last)
    }
}

impl Delay {
    pub fn new(sample_rate: f64, params: &[f64; PARAMS]) -> Delay {
        let longest = floor(LINE_MAX * sample_rate);
        let room = PAN_MAX * sample_rate + 1.0;
        let [left, right] = sides(params[PAN], sample_rate);
        let mut delay = Delay {
            sample_rate,
            time: Pole::new(
                whole(params[TIME], sample_rate),
                TIME_SMOOTHING,
                sample_rate,
                NEAR_SAMPLES,
            ),
            pans: [
                Pole::new(left, GLIDE, sample_rate, NEAR_SAMPLES),
                Pole::new(right, GLIDE, sample_rate, NEAR_SAMPLES),
            ],
            feedback: Pole::new(params[FB], GLIDE, sample_rate, NEAR_GAIN),
            cross: Pole::new(mode(params[MODE]), GLIDE, sample_rate, NEAR_GAIN),
            freq: Smoothed::new(params[FREQ], GLIDE, sample_rate),
            q: Smoothed::new(params[Q], GLIDE, sample_rate),
            designed: (f64::NAN, f64::NAN),
            filter: Bandpass::default(),
            lines: [Ring::new(longest), Ring::new(longest)],
            offsets: [Ring::new(room), Ring::new(room)],
            scratch: Box::new(Scratch {
                read: [[0.0; ROOM]; 2],
                echo: [[0.0; ROOM]; 2],
                written: [[0.0; SEGMENT]; 2],
                right: [0.0; SEGMENT],
            }),
            longest,
            idle: true,
            quiet_frames: 0.0,
            silent_frames: 0.0,
            #[cfg(test)]
            sample_by_sample: false,
            #[cfg(test)]
            fused: 0,
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
            self.time.target = whole(changes[TIME], self.sample_rate);
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

    // the coefficients of the bandpass of a block: the knobs as its first sample has them, moved by their routes
    fn design(&mut self, freq: f64, q: f64) {
        let designed = (self.freq.from + freq, self.q.from + q);
        if designed != self.designed {
            self.designed = designed;
            self.filter.design(designed.0, designed.1, self.sample_rate);
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
        self.scratch.read[1][0] = 0.0;
        self.scratch.echo[0][0] = 0.0;
        self.scratch.echo[1][0] = 0.0;
        self.idle = true;
        self.silent_frames = 0.0;
    }

    // a segment while nothing moves, in one loop of four samples at once: the lines read where they are,
    // filtered (from the second of a pair too: a sound that started on an odd sample), the echoes into the rings
    // of the offsets and out, the lines written. False (nothing done): it is no whole fours or a ring wraps in it;
    // `segment` renders it then, the same bits
    #[inline(always)]
    fn fused(
        &mut self,
        input: [&[f32]; 2],
        out_l: &mut [f32],
        out_r: &mut [f32],
        s: usize,
        count: usize,
    ) -> bool {
        let size = self.lines[0].data.len();
        let at = self.lines[0].at;
        let delay = clamp(self.time.value, SHORTEST, self.longest) as usize;
        let start = (at + size - delay) & self.lines[0].mask;
        let spot = self.offsets[0].at;
        if !count.is_multiple_of(4)
            || start + count > size
            || at + count > size
            || spot + count > self.offsets[0].data.len()
        {
            return false;
        }
        let k = self.filter.coefs();
        let mut kept = self.filter.kept;
        let odd = self.filter.second;
        let ping_pong = self.cross.value != 0.0;
        let feedback = F32x4::splat(self.feedback.value as f32);
        let half = F32x4::splat(0.5);
        let direct = [self.pans[0].value == 0.0, self.pans[1].value == 0.0];
        let scratch = &mut *self.scratch;
        // (their last lane: the sample before the segment)
        let mut last_l = F32x4::splat(scratch.echo[0][0]);
        let mut last_r = F32x4::splat(scratch.echo[1][0]);
        let mut last_read = F32x4::splat(scratch.read[1][0]);
        let [line_l, line_r] = &mut self.lines;
        let [late_l, late_r] = &mut self.offsets;
        let (in_l, in_r) = (&input[0][s..s + count], &input[1][s..s + count]);
        let (to_l, to_r) = (&mut out_l[s..s + count], &mut out_r[s..s + count]);
        for i in (0..count).step_by(4) {
            let read_l = F32x4::load(&line_l.data[start + i..]);
            let read_r = F32x4::load(&line_r.data[start + i..]);
            let (echo_l, echo_r) = kept.quad(&k, read_l, read_r, odd);
            let right = if ping_pong { read_r } else { echo_r };
            echo_l.store(&mut late_l.data[spot + i..]);
            right.store(&mut late_r.data[spot + i..]);
            if direct[0] {
                echo_l.store(&mut to_l[i..]);
            }
            if direct[1] {
                right.store(&mut to_r[i..]);
            }
            let (dry_l, dry_r) = (F32x4::load(&in_l[i..]), F32x4::load(&in_r[i..]));
            let (left, back) = if ping_pong {
                let old = last_read.pick::<3, 4, 5, 6>(read_r);
                (dry_l * half + dry_r * half + old * feedback, echo_l)
            } else {
                let old_l = last_l.pick::<3, 4, 5, 6>(echo_l);
                let old_r = last_r.pick::<3, 4, 5, 6>(echo_r);
                (dry_l + old_l * feedback, dry_r + old_r * feedback)
            };
            left.flush().store(&mut line_l.data[at + i..]);
            back.flush().store(&mut line_r.data[at + i..]);
            (last_l, last_r, last_read) = (echo_l, echo_r, read_r);
            if (i + 4).is_multiple_of(FLUSH) {
                kept.flush();
            }
        }
        kept.flush();
        self.filter.kept = kept;
        scratch.echo[0][0] = last_l.lanes()[3];
        scratch.echo[1][0] = last_r.lanes()[3];
        scratch.read[1][0] = last_read.lanes()[3];
        for ring in [line_l, line_r, &mut *late_l, &mut *late_r] {
            ring.at = (ring.at + count) & ring.mask;
        }
        if !direct[0] {
            late_l.copy(count + self.pans[0].value as usize, to_l);
        }
        if !direct[1] {
            late_r.copy(count + self.pans[1].value as usize, to_r);
        }
        true
    }

    // `count` samples from `s` of a block
    #[inline(always)]
    fn segment(
        &mut self,
        input: [&[f32]; 2],
        out_l: &mut [f32],
        out_r: &mut [f32],
        s: usize,
        count: usize,
        moves: &Moves,
    ) {
        // (the specs of the crate: no copy, lanes or loop of a segment, the reference those are held to)
        #[cfg(test)]
        let plain = self.sample_by_sample;
        #[cfg(not(test))]
        let plain = false;
        let rate = self.sample_rate;
        let held = !self.time.moving() && moves.time.is_none() && !plain;
        // (the gains of a segment hold but for a route on the feedback: its lanes)
        let steady = !self.feedback.moving() && !self.cross.moving() && !plain;
        let still = |channel: usize| !self.pans[channel].moving() && moves.pan[channel].is_none();
        let one_loop = held && steady && moves.fb.is_none() && still(0) && still(1);
        if one_loop && self.fused(input, out_l, out_r, s, count) {
            #[cfg(test)]
            {
                self.fused += 1;
            }
            return;
        }
        let Scratch {
            read,
            echo,
            written,
            right,
        } = &mut *self.scratch;
        // the lines, read before this segment is written
        if held {
            let delay = clamp(self.time.value, SHORTEST, self.longest) as usize;
            self.lines[0].copy(delay, &mut read[0][1..1 + count]);
            self.lines[1].copy(delay, &mut read[1][1..1 + count]);
        } else {
            for i in 0..count {
                let moved = moves.time.map_or(0.0, |offsets| offsets[s + i]) * rate;
                let delay = clamp(self.time.next() + moved, SHORTEST, self.longest);
                let place = self.lines[0].place(i, delay);
                read[0][1 + i] = self.lines[0].read(place);
                read[1][1 + i] = self.lines[1].read(place);
            }
        }

        // the bandpass of both channels
        self.filter.process_block(read, echo, count);

        // into the lines: the input and, a sample late, the feedback by the mode
        let ping_pong = self.cross.value != 0.0;
        if steady {
            let still = F32x4::splat(self.feedback.value as f32);
            let half = F32x4::splat(0.5);
            for i in (0..count).step_by(4) {
                // (under a route: the feedback of each sample, as a sample alone has it)
                let feedback = match moves.fb {
                    Some(offsets) => {
                        // (a lane past the segment is never written)
                        let of = |k: usize| {
                            offsets
                                .get(s + i + k)
                                .map_or(0.0, |offset| (self.feedback.value + offset) as f32)
                        };
                        F32x4::new(of(0), of(1), of(2), of(3))
                    }
                    None => still,
                };
                let [in_l, in_r] = [0, 1].map(|channel| lanes(&input[channel][s..s + count], i));
                let (left, back) = if ping_pong {
                    let old = F32x4::load(&read[1][i..i + 4]);
                    (
                        in_l * half + in_r * half + old * feedback,
                        F32x4::load(&echo[0][1 + i..5 + i]),
                    )
                } else {
                    let [old_l, old_r] = [0, 1].map(|channel| F32x4::load(&echo[channel][i..i + 4]));
                    (in_l + old_l * feedback, in_r + old_r * feedback)
                };
                left.flush().store(&mut written[0][i..i + 4]);
                back.flush().store(&mut written[1][i..i + 4]);
            }
        } else {
            for i in 0..count {
                let moved = moves.fb.map_or(0.0, |offsets| offsets[s + i]);
                let feedback = self.feedback.next() + moved;
                let cross = self.cross.next();
                let own = (feedback * (1.0 - cross)) as f32;
                let other = (feedback * cross) as f32;
                let (in_l, in_r) = (input[0][s + i], input[1][s + i]);
                let left = in_l * (1.0 - 0.5 * cross) as f32
                    + in_r * (0.5 * cross) as f32
                    + echo[0][i] * own
                    + read[1][i] * other;
                let back = in_r * (1.0 - cross) as f32 + echo[1][i] * own + echo[0][1 + i] * cross as f32;
                written[0][i] = flushed(left);
                written[1][i] = flushed(back);
                right[i] = echo[1][1 + i] * (1.0 - cross) as f32 + read[1][1 + i] * cross as f32;
            }
        }
        self.lines[0].write(&written[0][..count]);
        self.lines[1].write(&written[1][..count]);

        // the echoes out (the right one of ping-pong: its line as read), a channel late by its offset
        let echoes: [&[f32]; 2] = [
            &echo[0][1..1 + count],
            if !steady {
                &right[..count]
            } else if ping_pong {
                &read[1][1..1 + count]
            } else {
                &echo[1][1..1 + count]
            },
        ];
        let outs = [&mut out_l[s..s + count], &mut out_r[s..s + count]];
        for (channel, out) in outs.into_iter().enumerate() {
            let pan = &mut self.pans[channel];
            let offsets = moves.pan[channel];
            let ring = &mut self.offsets[channel];
            ring.write(echoes[channel]);
            let held = !pan.moving() && offsets.is_none() && !plain;
            if held && pan.value == 0.0 {
                out.copy_from_slice(echoes[channel]);
            } else if held {
                ring.copy(count + pan.value as usize, out);
            } else {
                // (the farthest a held offset is: `sides`)
                let longest = whole(PAN_MAX, rate);
                for (i, sample) in out.iter_mut().enumerate() {
                    let moved = offsets.map_or(0.0, |offsets| offsets[s + i]) * rate;
                    let delay = clamp(pan.next() + moved, 0.0, longest);
                    // (written already: `count` - i before `at`)
                    *sample = ring.read(ring.place(ring.data.len() - count + i, delay));
                }
            }
        }
        // the last sample of each, the one before the next segment
        read[1][0] = read[1][count];
        echo[0][0] = echo[0][count];
        echo[1][0] = echo[1][count];
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
            // (the pairs of the bandpass from the first sample that sounds)
            let first = (0..frames)
                .find(|&i| !(in_l[i].abs() < SILENCE && in_r[i].abs() < SILENCE))
                .unwrap_or(0);
            self.filter.second = first & 1 == 1;
        }

        self.freq.step(n);
        self.q.step(n);
        self.design(moves.freq, moves.q);

        let mut s = 0;
        while s < frames {
            let count = SEGMENT.min(frames - s);
            self.segment([in_l, in_r], out_l, out_r, s, count, moves);
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
        // (a route on Time reads a line anywhere: an echo may be as late as the line is long)
        let time = if moves.time.is_some() {
            self.longest
        } else {
            max(max(self.time.value, self.time.target), SHORTEST)
        };
        let longest = time + PAN_MAX * self.sample_rate + 2.0 + n;
        if self.quiet_frames > longest && self.silent_frames > longest {
            self.forget();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::{bits, noise, signal};
    use alloc::vec;
    use alloc::vec::Vec;

    // the offsets of the routes over a render, a value a sample: of Time, of the feedback, of each offset, of Freq
    // and Q (the one of the first sample of a block: a design a block)
    #[derive(Default)]
    struct Routes {
        time: Option<Vec<f64>>,
        fb: Option<Vec<f64>>,
        pan: [Option<Vec<f64>>; 2],
        freq: Option<Vec<f64>>,
        q: Option<Vec<f64>>,
    }

    fn render_moved(
        delay: &mut Delay,
        input: &[Vec<f32>; 2],
        blocks: &mut dyn FnMut() -> usize,
        mut before: impl FnMut(&mut Delay, usize),
        routes: &Routes,
    ) -> [Vec<f32>; 2] {
        let frames = input[0].len();
        let mut out = [vec![0.0f32; frames], vec![0.0f32; frames]];
        let mut at = 0;
        while at < frames {
            let count = blocks().min(frames - at);
            before(delay, at);
            let [left, right] = &mut out;
            let [time, fb, pan_l, pan_r] = [&routes.time, &routes.fb, &routes.pan[0], &routes.pan[1]]
                .map(|values| values.as_deref().map(|values| &values[at..at + count]));
            let [freq, q] =
                [&routes.freq, &routes.q].map(|values| values.as_ref().map_or(0.0, |values| values[at]));
            let moves = Moves {
                time,
                fb,
                pan: [pan_l, pan_r],
                freq,
                q,
                ..Moves::default()
            };
            delay.process(
                &input[0][at..at + count],
                &input[1][at..at + count],
                &mut left[at..at + count],
                &mut right[at..at + count],
                &moves,
            );
            at += count;
        }
        out
    }

    fn render(
        delay: &mut Delay,
        input: &[Vec<f32>; 2],
        blocks: &mut dyn FnMut() -> usize,
        before: impl FnMut(&mut Delay, usize),
    ) -> [Vec<f32>; 2] {
        render_moved(delay, input, blocks, before, &Routes::default())
    }

    // `input` through a delay of `params` in `blocks`, and sample by sample without the copies, the lanes and the
    // one loop of a segment: the same bits of both channels. The first one back (its `fused`), its output
    fn same_bits(
        rate: f64,
        params: &[f64; PARAMS],
        input: &[Vec<f32>; 2],
        blocks: &mut dyn FnMut() -> usize,
        routes: &Routes,
        what: &str,
    ) -> (Delay, [Vec<f32>; 2]) {
        let mut fast = Delay::new(rate, params);
        let rendered = render_moved(&mut fast, input, blocks, |_, _| {}, routes);
        let mut slow = Delay::new(rate, params);
        slow.sample_by_sample = true;
        let reference = render_moved(&mut slow, input, &mut || 1usize, |_, _| {}, routes);
        assert_eq!(slow.fused, 0);
        assert_eq!(bits(&rendered[0]), bits(&reference[0]), "left {what}");
        assert_eq!(bits(&rendered[1]), bits(&reference[1]), "right {what}");
        (fast, rendered)
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
            let input = signal(7 + case as u32, 30000, 0.5);
            let mut lengths = noise(99);
            let mut cut = || 1 + ((lengths() + 1.0) * 150.0) as usize;
            let (_, rendered) = same_bits(
                rate,
                &PARAMS_OF[case],
                &input,
                &mut cut,
                &Routes::default(),
                &format!("at {rate}"),
            );
            assert!(rendered[0].iter().any(|value| value.abs() > 0.01));
            assert!(rendered[1].iter().any(|value| value.abs() > 0.01));
        }
    }

    // blocks of 128 while nothing moves take the one loop (but where a ring of the offsets wraps), a sound from an
    // odd sample too (the first sample of each the second of a pair): the bits of a sample after the other, in
    // both modes, a channel late or none
    #[test]
    fn the_one_loop_renders_what_a_sample_after_the_other_would() {
        let rate = 48000.0;
        for (case, params) in PARAMS_OF.iter().enumerate() {
            for start in [0usize, 1, 77] {
                let mut input = signal(31 + case as u32, 128 * 400, 0.5);
                input[0][..start].fill(0.0);
                input[1][..start].fill(0.0);
                let (fast, _) = same_bits(
                    rate,
                    params,
                    &input,
                    &mut || 128usize,
                    &Routes::default(),
                    &format!("of case {case} from {start}"),
                );
                assert_eq!(fast.filter.second, start & 1 == 1);
                assert!(
                    fast.fused > 380 && fast.fused < 400,
                    "case {case} from {start}: {}",
                    fast.fused
                );
            }
        }
    }

    // Freq and Q moved by their routes (a design a block): the one loop, a sound from an odd sample too, renders
    // what the passes of the plain order would in the same blocks, in both modes
    #[test]
    fn the_one_loop_follows_a_bandpass_that_moves() {
        let rate = 48000.0;
        let frames = 128 * 300;
        let wave = |depth: f64, period: f64| -> Option<Vec<f64>> {
            Some(
                (0..frames)
                    .map(|i| depth * jsmath::sin(i as f64 * core::f64::consts::TAU / period))
                    .collect(),
            )
        };
        for params in [PARAMS_OF[1], PARAMS_OF[2]] {
            // (Freq ±60 % of its knob, Q ±50 %)
            let routes = Routes {
                freq: wave(0.6 * params[FREQ], 9000.0),
                q: wave(0.5 * params[Q], 5000.0),
                ..Routes::default()
            };
            for start in [0usize, 1, 77] {
                let mut input = signal(51, frames, 0.5);
                input[0][..start].fill(0.0);
                input[1][..start].fill(0.0);
                let mut fast = Delay::new(rate, &params);
                let rendered = render_moved(&mut fast, &input, &mut || 128usize, |_, _| {}, &routes);
                let mut slow = Delay::new(rate, &params);
                slow.sample_by_sample = true;
                let reference = render_moved(&mut slow, &input, &mut || 128usize, |_, _| {}, &routes);
                assert_eq!(fast.filter.second, start & 1 == 1);
                assert!(fast.fused > 280, "from {start}: {}", fast.fused);
                assert_eq!(bits(&rendered[0]), bits(&reference[0]), "left from {start}");
                assert_eq!(bits(&rendered[1]), bits(&reference[1]), "right from {start}");
            }
        }
    }

    // a sound that starts in the middle of a block, at an odd sample or an even one: the pairs of the bandpass
    // are counted from it, so the blocks it starts in render the bits of a sample after the other
    #[test]
    fn the_pairs_are_counted_from_the_first_sample_that_sounds() {
        let rate = 48000.0;
        for start in [0usize, 1, 76, 77, 127, 128, 129] {
            let mut input = signal(41, 128 * 60, 0.5);
            input[0][..start].fill(0.0);
            input[1][..start].fill(0.0);
            for blocks in [128usize, 37, 4] {
                same_bits(
                    rate,
                    &PARAMS_OF[0],
                    &input,
                    &mut || blocks,
                    &Routes::default(),
                    &format!("from {start} in blocks of {blocks}"),
                );
            }
        }
    }

    // the two samples a step of the bandpass are the bandpass a sample a step, to the last digits (both channels of
    // both samples)
    #[test]
    fn a_pair_is_the_two_samples_one_after_the_other() {
        let apart = |a: F64x2, b: F64x2| max((a.lo() - b.lo()).abs(), (a.hi() - b.hi()).abs());
        for (freq, q) in [
            (1000.0, 0.01),
            (50.0, 3.0),
            (17000.0, 3.0),
            (300.0, 0.7),
            (60.0, 0.05),
        ] {
            let mut filter = Bandpass::default();
            filter.design(freq, q, 48000.0);
            let k = filter.coefs();
            let (mut pairs, mut plain) = (Kept::default(), Kept::default());
            let mut source = noise(9);
            let mut worst = 0.0f64;
            for _ in 0..50000 {
                let x = F64x2::new(source() as f64, source() as f64);
                let next = F64x2::new(source() as f64, source() as f64);
                let (a, b) = pairs.pair(&k, x, next);
                let (c, d) = (plain.first(&k, x), plain.first(&k, next));
                worst = max(worst, max(apart(a, c), apart(b, d)));
            }
            assert!(worst < 1e-9, "{freq} Hz, Q {q}: {worst}");
        }
    }

    // a new design before every block (Freq and Q swept), the blocks of any length, a sound from the first sample of
    // a pair or from the second (one from an odd sample): the pairs go on as the bandpass a sample a step would with
    // the coefficients of each block (the second of a pair at the start of a block was worked from an output of the
    // design before: the echoes 25 to 63 dB under the signal)
    #[test]
    fn the_pairs_go_on_through_a_new_design() {
        let rate = 48000.0;
        let frames = 48000;
        let input = signal(17, frames, 0.5);
        for second in [false, true] {
            let mut filter = Bandpass {
                second,
                ..Bandpass::default()
            };
            let mut plain = Kept::default();
            let (mut read, mut echo) = ([[0.0f32; ROOM]; 2], [[0.0f32; ROOM]; 2]);
            let mut lengths = noise(3);
            let (mut worst, mut peak) = (0.0f64, 0.0f64);
            let mut at = 0;
            while at < frames {
                let count = (1 + ((lengths() + 1.0) * 64.0) as usize)
                    .min(SEGMENT)
                    .min(frames - at);
                // (3 octaves each way around 1 kHz, Q from 0.7 to 5)
                let phase = at as f64 * core::f64::consts::TAU / 9000.0;
                let freq = 1000.0 * jsmath::pow(8.0, jsmath::sin(phase));
                let q = 0.7 + 4.3 * (0.5 + 0.5 * jsmath::sin(0.37 * phase));
                filter.design(freq, q, rate);
                let k = filter.coefs();
                for channel in 0..2 {
                    read[channel][1..1 + count].copy_from_slice(&input[channel][at..at + count]);
                }
                filter.process_block(&read, &mut echo, count);
                for i in 0..count {
                    let out = plain.first(&k, F64x2::new(input[0][at + i] as f64, input[1][at + i] as f64));
                    for (channel, value) in [out.lo(), out.hi()].into_iter().enumerate() {
                        worst = max(worst, (echo[channel][1 + i] as f64 - value).abs());
                        peak = max(peak, value.abs());
                    }
                }
                at += count;
            }
            let db = 20.0 * jsmath::log10(worst / peak);
            assert!(
                db < -120.0,
                "a sound from the second of a pair: {second}, {db} dB"
            );
        }
    }

    // a knob that changes at a frame glides the same in blocks of 128 and sample by sample (the filter is of a
    // block: left as it is)
    #[test]
    fn the_glides_do_not_follow_the_blocks() {
        let rate = 48000.0;
        let input = signal(3, 128 * 200, 0.5);
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

    // a glide of Time up to a long one, of an offset back to none or out to its farthest: where it comes to its
    // knob (the read held at whole samples from then on) a tone through it goes on as a tone, no step (it was one
    // of samples: e^-10 of the knob; at 22050 Hz the farthest offset held, 1103 samples, was one more than a
    // moving one could read)
    #[test]
    fn a_glide_comes_to_its_knob_without_a_step() {
        let cases = [
            (48000.0, TIME, 0.05, 1.0),
            (48000.0, PAN, 0.01, 0.0),
            (48000.0, PAN, -0.01, 0.0),
            (22050.0, PAN, 0.0, PAN_MAX),
            (22050.0, PAN, 0.0, -PAN_MAX),
        ];
        for (rate, key, from, to) in cases {
            let frames = rate as usize * 3;
            let amplitude = 0.5;
            let tone: Vec<f32> = (0..frames)
                .map(|i| (amplitude * jsmath::sin(i as f64 * core::f64::consts::TAU * 1000.0 / rate)) as f32)
                .collect();
            let input = [tone.clone(), tone];
            // (a block a quarter of a second in)
            let change = 128 * 94;
            // (the second difference of the tone at its most)
            let sine = jsmath::sin(core::f64::consts::PI * 1000.0 / rate);
            let most = amplitude * 4.0 * sine * sine;
            let mut params = [0.05, 0.0, 0.0, 0.0, 1000.0, 0.01];
            params[key] = from;
            let mut delay = Delay::new(rate, &params);
            let mut last_moving = 0;
            let mut quantum = || 128usize;
            let out = render(&mut delay, &input, &mut quantum, |delay, at| {
                if at == change {
                    let mut values = [0.0; PARAMS];
                    values[key] = to;
                    delay.set(1 << key, &values);
                }
                if delay.time.moving() || delay.pans.iter().any(Pole::moving) {
                    last_moving = at;
                }
            });
            assert!(
                last_moving > change && last_moving + 1024 < frames,
                "{key} {to}: {last_moving}"
            );
            for channel in &out {
                let worst = (last_moving - 512..last_moving + 640)
                    .map(|i| (channel[i] - 2.0 * channel[i - 1] + channel[i - 2]).abs() as f64)
                    .fold(0.0, max);
                assert!(
                    worst < 1.01 * most,
                    "{key} {from} → {to}: {worst} (a tone: {most})"
                );
            }
        }
    }

    // the routes (a value a sample on Time, on the feedback, on the offsets, each alone and all at once, in both
    // modes): the segments render what a sample after the other would, however the blocks are cut
    #[test]
    fn the_routes_render_what_a_sample_after_the_other_would() {
        let rate = 48000.0;
        let frames = 20000;
        let input = signal(21, frames, 0.5);
        let wave = |depth: f64, period: f64, phase: f64| -> Option<Vec<f64>> {
            Some(
                (0..frames)
                    .map(|i| depth * jsmath::sin(phase + i as f64 * core::f64::consts::TAU / period))
                    .collect(),
            )
        };
        let time = wave(0.004, 3111.0, 0.3);
        let fb = wave(0.2, 977.0, 1.0);
        let pan = [wave(0.002, 1531.0, 0.0), wave(0.003, 2203.0, 2.0)];
        let cases = [
            Routes {
                time: time.clone(),
                ..Routes::default()
            },
            Routes {
                fb: fb.clone(),
                ..Routes::default()
            },
            Routes {
                pan: pan.clone(),
                ..Routes::default()
            },
            Routes {
                time,
                fb,
                pan,
                ..Routes::default()
            },
        ];
        for (case, routes) in cases.iter().enumerate() {
            for params in [PARAMS_OF[0], PARAMS_OF[1]] {
                let mut lengths = noise(5 + case as u32);
                let mut cut = || 1 + ((lengths() + 1.0) * 150.0) as usize;
                let what = format!("of case {case}");
                let (_, rendered) = same_bits(rate, &params, &input, &mut cut, routes, &what);
                assert!(rendered[1].iter().any(|value| value.abs() > 0.01));
            }
        }
    }

    // a channel silent alone while the other plays on keeps the delay awake: once its line has emptied, the
    // bandpass of its lane comes to 0 at a flush before it rings down into the denormals (it stood there, a few of
    // their steps over the smallest)
    #[test]
    fn the_bandpass_of_a_channel_silent_alone_never_comes_near_a_denormal() {
        let frames = 16 * 48000;
        let mut input = signal(11, frames, 0.5);
        input[0][48000..].fill(0.0);
        let denormal = |x: f64| x != 0.0 && x.abs() < f64::MIN_POSITIVE;
        let mut worst = [0usize; 3];
        for (case, q) in [0.01, 1.0, 5.0].into_iter().enumerate() {
            let mut delay = Delay::new(48000.0, &[0.0123, 0.3, 0.0, 0.0, 1000.0, q]);
            let mut quantum = || 128usize;
            render(&mut delay, &input, &mut quantum, |delay, _| {
                let Kept { y1, y2, .. } = delay.filter.kept;
                worst[case] += [y1.lo(), y1.hi(), y2.lo(), y2.hi()]
                    .into_iter()
                    .filter(|x| denormal(*x))
                    .count();
            });
            if worst[case] > 0 {
                continue;
            }
            assert!(!delay.idle(), "Q {q}");
            let Kept { y1, y2, .. } = delay.filter.kept;
            assert_eq!(
                [y1.lo().to_bits(), y2.lo().to_bits()],
                [0, 0],
                "Q {q}: the left lane rests at +0"
            );
            assert!(y1.hi() != 0.0 && y2.hi() != 0.0, "Q {q}: the right one plays");
        }
        // (the values of the bandpass in the denormals at the ends of the blocks, of each Q)
        assert_eq!(worst, [0; 3]);
    }

    // the first sample of each echo of a channel over 0.1 (the bandpass rings after it)
    fn echoes(channel: &[f32]) -> Vec<usize> {
        (2..channel.len())
            .filter(|&i| channel[i].abs() > 0.1 && channel[i - 1].abs() <= 0.1 && channel[i - 2].abs() <= 0.1)
            .collect()
    }

    fn click(frames: usize, left: f32, right: f32) -> [Vec<f32>; 2] {
        let mut input = [vec![0.0f32; frames], vec![0.0f32; frames]];
        input[0][0] = left;
        input[1][0] = right;
        input
    }

    // a click comes back after Time, then every Time and a sample, a channel in itself
    #[test]
    fn an_echo_comes_a_sample_after_the_time() {
        let rate = 44100.0;
        let mut delay = Delay::new(rate, &[441.0 / rate, 0.5, 0.0, 0.0, 1000.0, 0.01]);
        let input = click(4096, 1.0, 0.0);
        let mut quantum = || 128usize;
        let out = render(&mut delay, &input, &mut quantum, |_, _| {});
        assert_eq!(echoes(&out[0]), vec![441, 441 + 442, 441 + 2 * 442]);
        assert!(out[1].iter().all(|value| *value == 0.0));
    }

    // a Time between two samples is the nearest one: an echo is a sample of the line as it was written
    #[test]
    fn a_time_that_holds_is_whole_samples() {
        let rate = 44100.0;
        for (time, at) in [(440.4, 440), (440.6, 441), (300.5, 301)] {
            let mut delay = Delay::new(rate, &[time / rate, 0.0, 0.0, 0.0, 1000.0, 0.0001]);
            let input = click(1024, 1.0, 1.0);
            let mut quantum = || 128usize;
            let out = render(&mut delay, &input, &mut quantum, |_, _| {});
            assert_eq!(echoes(&out[0]), vec![at], "{time}");
            assert_eq!(echoes(&out[1]), vec![at], "{time}");
        }
    }

    // ping-pong: half of both channels comes out of the left one after Time, of the right one a Time later as
    // it came out of the left one (the same samples: no filter, no gain on the way), then the feedback once a
    // round, a sample late
    #[test]
    fn ping_pong_gives_the_right_channel_the_left_echo_a_time_later() {
        let rate = 44100.0;
        let time = 300usize;
        for (left, right) in [(1.0, 0.0), (0.0, 1.0)] {
            let mut delay = Delay::new(rate, &[time as f64 / rate, 0.8, 1.0, 0.0, 1000.0, 0.01]);
            let input = click(4096, left, right);
            let mut quantum = || 128usize;
            let out = render(&mut delay, &input, &mut quantum, |_, _| {});
            assert_eq!(echoes(&out[0])[..2], [time, 3 * time + 1], "{left} {right}");
            assert_eq!(echoes(&out[1])[..2], [2 * time, 4 * time + 1], "{left} {right}");
            assert_eq!(bits(&out[1][time..2 * time + 64]), bits(&out[0][..time + 64]));
            // (the second echo of the left one: the first through the feedback and the bandpass again)
            let peak = |from: usize| {
                out[0][from..from + 64]
                    .iter()
                    .fold(0.0f32, |most, value| most.max(value.abs()))
            };
            assert!(peak(3 * time + 1) < 0.85 * peak(time) && peak(3 * time + 1) > 0.7 * peak(time));
        }
    }

    // a route that moves Time past its knob: the echo of a short sound comes after the knob moved, not after the
    // knob (the lines are not forgotten before it); without the route the delay goes idle after its knob
    #[test]
    fn an_echo_a_route_moves_later_still_comes() {
        let rate = 48000.0;
        let frames = 48000;
        let mut input = [vec![0.0f32; frames], vec![0.0f32; frames]];
        for i in 0..960 {
            input[0][i] = 0.5;
            input[1][i] = 0.5;
        }
        let offsets = vec![0.4f64; 128];
        let run = |moved: bool| {
            let mut delay = Delay::new(rate, &[0.05, 0.0, 0.0, 0.0, 1000.0, 0.01]);
            let mut out = [vec![0.0f32; frames], vec![0.0f32; frames]];
            let mut idle_at = None;
            for at in (0..frames).step_by(128) {
                let moves = Moves {
                    time: moved.then_some(&offsets[..]),
                    ..Moves::default()
                };
                let [left, right] = &mut out;
                delay.process(
                    &input[0][at..at + 128],
                    &input[1][at..at + 128],
                    &mut left[at..at + 128],
                    &mut right[at..at + 128],
                    &moves,
                );
                if delay.idle() && idle_at.is_none() && at > 960 {
                    idle_at = Some(at);
                }
            }
            (out, idle_at)
        };
        let (moved, _) = run(true);
        let echo = (0.45 * rate) as usize;
        assert!(moved[0][..echo - 128].iter().all(|value| value.abs() < 1e-6));
        assert!(moved[0][echo..echo + 2048].iter().any(|value| value.abs() > 0.01));
        let (still, idle_at) = run(false);
        assert!(still[0][2400..4800].iter().any(|value| value.abs() > 0.01));
        assert!(idle_at.is_some());
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
