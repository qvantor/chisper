//! The reverb (the tables of reverb-decay.ts and reverb-era.ts of the app; the goldens hold its sound): a 16-line
//! FDN with early reflections, input diffusion and the input stage of the eras. The input stage runs in doubles,
//! both channels in the lanes; the lines, their allpasses and shelves and the early reflections in f32, four lines
//! in the lanes (their delays in doubles). The C ABI of a stereo core (fx_new, fx_buffers, fx_process, fx_free) and
//! fx_set, fx_set_active, fx_clear, fx_idle; the params of fx_new and fx_set come through fx_command
//! (reverb-wasm.ts wraps it)

#![cfg_attr(target_arch = "wasm32", no_std)]

extern crate alloc;

use alloc::{boxed::Box, vec::Vec};
use wasm_rt as _;

use dsp_core::biquad::{Biquad, FilterType};
use dsp_core::blocks::{peak, Lines, Rows, Smoothed, StereoDelayLine, StereoFixedAllpass};
use dsp_core::io::StereoIo;
use dsp_core::simd::{F32x4, F64x2};
use dsp_core::stereo::{QuadBiquad, StereoBiquad};
use dsp_core::tanh::tanh4;
use jsmath::{floor, max, min, pow, sin, tanh, PI};

// the params, in the order of REVERB_KEYS of reverb-wasm.ts
pub const LOWCUT: usize = 0;
pub const PRE: usize = 1;
pub const SIZE: usize = 2;
pub const DECAY: usize = 3;
pub const DAMP: usize = 4;
pub const BASS: usize = 5;
pub const DEPTH: usize = 6;
pub const SEP: usize = 7;
pub const ER: usize = 8;
pub const DRIVE: usize = 9;
pub const BANDWIDTH: usize = 10;
pub const BODY: usize = 11;
pub const PARAMS: usize = 12;

// reverb-decay.ts
const LINE_TIMES: [f64; 16] = [
    0.0271, 0.0297, 0.0319, 0.0343, 0.0371, 0.0397, 0.0411, 0.0437, 0.0473, 0.0509, 0.0531, 0.0569, 0.0593,
    0.0637, 0.0679, 0.0733,
];
const LOOP_ALLPASS_TIMES: [f64; 16] = [
    0.0053, 0.0079, 0.0061, 0.0089, 0.0047, 0.0071, 0.0097, 0.0059, 0.0083, 0.0067, 0.0101, 0.0049, 0.0073,
    0.0091, 0.0057, 0.0087,
];
const HF_RATIO: f64 = 0.25;
const XOVER: f64 = 300.0;
const MAX_SHELF_CUT: f64 = -40.0;
const MIN_MODAL_OVERLAP: f64 = 0.19;

fn size_factor(size: f64) -> f64 {
    0.3 + size * 1.2
}

fn loop_length(i: usize, factor: f64) -> f64 {
    (LINE_TIMES[i] + LOOP_ALLPASS_TIMES[i]) * factor
}

fn total_loop() -> f64 {
    let mut sum = 0.0;
    for i in 0..LINE_TIMES.len() {
        sum += loop_length(i, 1.0);
    }
    sum
}

fn line_factor(size: f64, decay: f64, total_loop: f64) -> f64 {
    max(
        size_factor(size),
        (MIN_MODAL_OVERLAP * decay) / (2.2 * total_loop),
    )
}

// gain, lowshelf dB, highshelf dB of a pass through a line `length` seconds long
fn line_decay(length: f64, decay: f64, bass: f64) -> (f64, f64, f64) {
    let db = (60.0 * length) / decay;
    (
        pow(10.0, -db / 20.0),
        db * (1.0 - 1.0 / bass),
        max(MAX_SHELF_CUT, -db * (1.0 / HF_RATIO - 1.0)),
    )
}

// reverb-era.ts
const BODY_FREQ: f64 = 300.0;
const BODY_Q: f64 = 0.7;
const TUBE_RANGE: f64 = 8.0;
const TUBE_BIAS: f64 = 0.3;
const MIN_DRIVE: f64 = 1e-4;

// The tube of both channels: (tanh(drive x + bias) - tanh(bias)) / (drive (1 - tanh(bias)²)), a curve of slope 1
// at 0 that bends one way more than the other (its 2nd harmonic). Worked out as the tanh of a sum gives it,
// tanh(u) / (drive (1 + tanh(bias) tanh(u))) of u = drive x: no difference of two near values, so the rational
// tanh of the lanes in f32 does (dsp_core::tanh, a tenth of the time of the one in doubles) at any drive
#[inline(always)]
fn tube(input: F64x2, drive: f64, offset: f64) -> F64x2 {
    let x = F64x2::splat(-TUBE_RANGE).max(F64x2::splat(TUBE_RANGE).min(input));
    if drive < MIN_DRIVE {
        return x;
    }
    let u = F64x2::splat(drive) * x;
    let bent = tanh4(F32x4::from_f64(u, u));
    let out = bent / (F32x4::splat(drive as f32) * (F32x4::splat(1.0) + F32x4::splat(offset as f32) * bent));
    let [left, right, ..] = out.lanes();
    F64x2::new(left as f64, right as f64)
}

// reverb-dsp.ts
const MAX_PREDELAY: f64 = 0.3;
const MAX_SIZE: f64 = 1.0;
const MAX_DECAY: f64 = 20.0;
const ER_TAPS: [(f64, f64); 8] = [
    (0.0043, 0.9),
    (0.0089, 0.8),
    (0.0131, 0.72),
    (0.0187, 0.63),
    (0.0233, 0.55),
    (0.0301, 0.47),
    (0.0379, 0.4),
    (0.0457, 0.34),
];
const DIFFUSER_TIMES: [f64; 4] = [0.0047, 0.0036, 0.0127, 0.0093];
const DIFFUSION: f64 = 0.55;
const LOOP_DIFFUSION: f64 = 0.5;
const ALLPASS_RING: f64 = 0.5;
const MOD_DEPTH: f64 = 0.0015;
const MOD_RATES: [f64; 16] = [
    0.29, 0.31, 0.37, 0.41, 0.43, 0.47, 0.49, 0.53, 0.57, 0.61, 0.63, 0.67, 0.71, 0.73, 0.79, 0.83,
];
const TAIL_LEVEL: f64 = 0.48;
const SIZE_GLIDE: f64 = 0.1;
const GLIDE: f64 = 0.01;
const SILENCE: f64 = 1e-10;
const BUTTERWORTH_Q: f64 = -3.01;

fn line_polarity(i: usize) -> f64 {
    if i % 4 < 2 {
        1.0
    } else {
        -1.0
    }
}

fn allpass_gain(delay: f64, decay: f64, gain: f64) -> f64 {
    min(gain, pow(10.0, (-3.0 * delay) / (decay * ALLPASS_RING)))
}

// the input stage of both channels, the left one in the low lane, the right one in the high lane
struct Input {
    bandwidth: [StereoBiquad; 2],
    lowcut: StereoBiquad,
    body: StereoBiquad,
    predelay: StereoDelayLine,
    diffusers: [StereoFixedAllpass; 4],
}

// four lines of the FDN (4q..4q + 4) in the lanes: the even ones (lanes 0 and 2) go left, the odd ones right. The
// delays are doubles, two lanes each
struct LineQuad {
    base: [F64x2; 2],
    allpass_base: [F64x2; 2],
    delay: Rows,
    allpass: Rows,
    low: QuadBiquad,
    high: QuadBiquad,
    input: F32x4,
    gain: F32x4,
    allpass_gain: F32x4,
    phase: [f64; 4],
    mod_from: [F64x2; 2],
    mod_to: [F64x2; 2],
}

impl LineQuad {
    // Line `row` of the quad over a chunk of `length`, a `group` of samples at a time (4: in the lanes; 1: a sample
    // after the other): read at its delay (the scale of the lines and its modulation at each sample: `factor`,
    // `t`), through its Schroeder allpass of a gliding delay, into `outs`. One loop for every line (a function of
    // its own: the pass of a chunk calls it sixteen times)
    #[inline(never)]
    fn line(
        &mut self,
        row: usize,
        t: &[f64; CHUNK],
        factor: &[f64; CHUNK],
        outs: &mut [f32; CHUNK],
        length: usize,
        group: usize,
    ) {
        // the values of the line: of lane `row` of its quad
        let of = |pairs: &[F64x2; 2]| {
            let pair = pairs[row / 2];
            F64x2::splat(if row.is_multiple_of(2) {
                pair.lo()
            } else {
                pair.hi()
            })
        };
        let (base, allpass_base) = (of(&self.base), of(&self.allpass_base));
        let (mod_from, mod_to) = (of(&self.mod_from), of(&self.mod_to));
        let gain = F32x4::splat(self.allpass_gain.lanes()[row]);
        // (a group over the end of the chunk: its samples past it are not used, an allpass writes them again
        // before it reads them)
        let pair = |values: &[f64; CHUNK], at: usize| {
            let at = at.min(CHUNK - 2);
            F64x2::new(values[at], values[at + 1])
        };
        let mut g = 0;
        while g < length {
            let t2 = [pair(t, g), pair(t, g + 2)];
            let factor2 = [pair(factor, g), pair(factor, g + 2)];
            let delay: [F64x2; 2] = core::array::from_fn(|half| {
                let modulation = mod_from + (mod_to - mod_from) * t2[half];
                base * factor2[half] + modulation
            });
            let delayed = self.delay.read4(row, g, delay);
            let turned = self
                .allpass
                .read4(row, g, [allpass_base * factor2[0], allpass_base * factor2[1]]);
            let sum = delayed + gain * turned;
            let out = turned - gain * sum;
            if group == 4 {
                self.allpass.write4(row, g, sum);
                out.store(&mut outs[g..g + 4]);
            } else {
                self.allpass.write1(row, g, sum.lanes()[0]);
                outs[g] = out.lanes()[0];
            }
            g += group;
        }
    }
}

const QUADS: usize = LINE_TIMES.len() / 4;

// a value per lane of quad q (line 4q + lane), as doubles (lanes 0 and 1, then 2 and 3) and as f32
fn pairs(q: usize, value: impl Fn(usize) -> f64) -> [F64x2; 2] {
    [
        F64x2::new(value(4 * q), value(4 * q + 1)),
        F64x2::new(value(4 * q + 2), value(4 * q + 3)),
    ]
}
fn lanes(q: usize, value: impl Fn(usize) -> f64) -> F32x4 {
    let [lo, hi] = pairs(q, value);
    F32x4::from_f64(lo, hi)
}
// the longest of the lines of quad q (their ring is one)
fn longest_of(q: usize, value: impl Fn(usize) -> f64) -> f64 {
    (0..4).fold(f64::NEG_INFINITY, |longest, lane| {
        max(longest, value(4 * q + lane))
    })
}

// the sums of the lanes that go left (0 and 2) and right (1 and 3), as doubles
#[inline(always)]
fn sides(value: F32x4) -> (f64, f64) {
    let [a, b, c, d] = value.lanes();
    ((a + c) as f64, (b + d) as f64)
}

pub struct Reverb {
    sample_rate: f64,
    total_loop: f64,
    tube_offset: f64,
    values: [Smoothed; PARAMS],
    targets: [f64; PARAMS],
    line_scale: Smoothed,
    active: bool,
    fade: Smoothed,
    idle: bool,
    quiet_frames: f64,
    drain_frames: f64,
    input: Input,
    er_absorb: Biquad,
    er_line: Lines<1>,
    er_delays: [f64; 8],
    diffuser_gains: [f64; 4],
    quads: Vec<LineQuad>,
    outs: [F32x4; QUADS],
    chunk: Box<Chunk>,
    // (the spec of the crate: every sample a chunk of its own, what the chunks are held to)
    #[cfg(test)]
    sample_by_sample: bool,
    pub io: StereoIo,
}

/// the most samples of a chunk of a block (process)
const CHUNK: usize = 64;
const LINES: usize = LINE_TIMES.len();

// The samples of a chunk between its passes. Of each sample: its share of the block and the scale of the lines there
// (the glides), the fade, the diffused input of the lines (left, right, left, right), the early reflections. Of
// each line a row of its samples (four in a row are the lanes of a pass over time): its output; the sums of the
// lines of each lane, the reflection of them all
struct Chunk {
    t: [f64; CHUNK],
    factor: [f64; CHUNK],
    fade: [f64; CHUNK],
    diffused: [F32x4; CHUNK],
    early: [F32x4; CHUNK],
    outs: [[f32; CHUNK]; LINES],
    tail: [[f32; CHUNK]; 4],
    feedback: [f32; CHUNK],
}

impl Reverb {
    pub fn new(sample_rate: f64, params: &[f64; PARAMS], active: bool) -> Reverb {
        let samples = |seconds: f64| seconds * sample_rate;
        let total_loop = total_loop();
        let max_factor = size_factor(MAX_SIZE);
        let max_line_factor = line_factor(MAX_SIZE, MAX_DECAY, total_loop);
        let values: [Smoothed; PARAMS] = core::array::from_fn(|key| {
            let time_constant = if key == PRE || key == SIZE {
                SIZE_GLIDE
            } else {
                GLIDE
            };
            Smoothed::new(params[key], time_constant, sample_rate)
        });
        let mut longest = f64::NEG_INFINITY;
        for i in 0..LINE_TIMES.len() {
            longest = max(longest, loop_length(i, max_line_factor));
        }
        let diffusers_total =
            ((DIFFUSER_TIMES[0] + DIFFUSER_TIMES[1]) + DIFFUSER_TIMES[2]) + DIFFUSER_TIMES[3];
        let drain_frames =
            samples(MAX_PREDELAY + ER_TAPS[ER_TAPS.len() - 1].0 * max_factor + diffusers_total + longest);
        let input = Input {
            bandwidth: [StereoBiquad::new(), StereoBiquad::new()],
            lowcut: StereoBiquad::new(),
            body: StereoBiquad::new(),
            predelay: StereoDelayLine::new(samples(MAX_PREDELAY) + 1.0),
            diffusers: core::array::from_fn(|i| StereoFixedAllpass::new(samples(DIFFUSER_TIMES[i]))),
        };
        let line_input = 0.5 * jsmath::sqrt(8.0 / LINE_TIMES.len() as f64);
        let quads = (0..QUADS)
            .map(|q| LineQuad {
                base: pairs(q, |i| samples(LINE_TIMES[i])),
                allpass_base: pairs(q, |i| samples(LOOP_ALLPASS_TIMES[i])),
                delay: Rows::new(longest_of(q, |i| {
                    samples(LINE_TIMES[i] * max_line_factor + MOD_DEPTH) + 2.0
                })),
                allpass: Rows::new(longest_of(q, |i| {
                    samples(LOOP_ALLPASS_TIMES[i] * max_line_factor) + 2.0
                })),
                low: QuadBiquad::default(),
                high: QuadBiquad::default(),
                input: lanes(q, |i| line_input * line_polarity(i)),
                gain: F32x4::splat(1.0),
                allpass_gain: F32x4::splat(LOOP_DIFFUSION as f32),
                phase: [0.0; 4],
                mod_from: [F64x2::default(); 2],
                mod_to: [F64x2::default(); 2],
            })
            .collect();
        let mut reverb = Reverb {
            sample_rate,
            total_loop,
            tube_offset: tanh(TUBE_BIAS),
            values,
            targets: *params,
            line_scale: Smoothed::new(
                line_factor(params[SIZE], params[DECAY], total_loop),
                SIZE_GLIDE,
                sample_rate,
            ),
            active,
            fade: Smoothed::new(if active { 1.0 } else { 0.0 }, GLIDE, sample_rate),
            idle: !active,
            quiet_frames: 0.0,
            drain_frames,
            input,
            er_absorb: Biquad::default(),
            er_line: Lines::new(samples(ER_TAPS[ER_TAPS.len() - 1].0 * max_factor) + 2.0),
            er_delays: core::array::from_fn(|i| samples(ER_TAPS[i].0)),
            diffuser_gains: [DIFFUSION; 4],
            quads,
            outs: [F32x4::default(); QUADS],
            chunk: Box::new(Chunk {
                t: [0.0; CHUNK],
                factor: [0.0; CHUNK],
                fade: [0.0; CHUNK],
                diffused: [F32x4::default(); CHUNK],
                early: [F32x4::default(); CHUNK],
                outs: [[0.0; CHUNK]; LINES],
                tail: [[0.0; CHUNK]; 4],
                feedback: [0.0; CHUNK],
            }),
            #[cfg(test)]
            sample_by_sample: false,
            io: StereoIo::default(),
        };
        reverb.update_input();
        reverb.update_decay();
        reverb.update_mod(0.0);
        reverb
    }

    pub fn idle(&self) -> bool {
        self.idle
    }

    fn update_input(&mut self) {
        let rate = self.sample_rate;
        let bandwidth = self.values[BANDWIDTH].value;
        let lowcut = self.values[LOWCUT].value;
        let body = self.values[BODY].value;
        let input = &mut self.input;
        for node in input.bandwidth.iter_mut() {
            node.set(FilterType::Lowpass, bandwidth, BUTTERWORTH_Q, 0.0, rate);
        }
        input
            .lowcut
            .set(FilterType::Highpass, lowcut, BUTTERWORTH_Q, 0.0, rate);
        input.body.set(FilterType::Peaking, BODY_FREQ, BODY_Q, body, rate);
    }

    // the gain and both shelves of a line come from the same values and its current length
    fn update_decay(&mut self) {
        let rate = self.sample_rate;
        let factor = self.line_scale.value;
        let damp = self.values[DAMP].value;
        self.er_absorb
            .set(FilterType::Lowpass, damp, BUTTERWORTH_Q, 0.0, rate);
        let decay = self.values[DECAY].value;
        for (i, time) in DIFFUSER_TIMES.iter().enumerate() {
            self.diffuser_gains[i] = allpass_gain(*time, decay, DIFFUSION);
        }
        let bass = self.values[BASS].value;
        for (q, quad) in self.quads.iter_mut().enumerate() {
            let mut gains = [0.0; 4];
            let mut allpass_gains = [0.0; 4];
            for lane in 0..4 {
                let i = 4 * q + lane;
                let (gain, low_db, high_db) = line_decay(loop_length(i, factor), decay, bass);
                gains[lane] = gain as f32;
                allpass_gains[lane] =
                    allpass_gain(LOOP_ALLPASS_TIMES[i] * factor, decay, LOOP_DIFFUSION) as f32;
                quad.low.set(lane, FilterType::Lowshelf, XOVER, 0.0, low_db, rate);
                quad.high
                    .set(lane, FilterType::Highshelf, damp, 0.0, high_db, rate);
            }
            quad.gain = F32x4::load(&gains);
            quad.allpass_gain = F32x4::load(&allpass_gains);
        }
    }

    fn update_mod(&mut self, frames: f64) {
        let rate = self.sample_rate;
        let depth = self.values[DEPTH].value * (MOD_DEPTH * rate);
        for (q, quad) in self.quads.iter_mut().enumerate() {
            let mut to = [0.0; 4];
            for lane in 0..4 {
                let i = 4 * q + lane;
                quad.phase[lane] =
                    (quad.phase[lane] + (2.0 * PI * MOD_RATES[i] * frames) / rate) % (2.0 * PI);
                to[lane] = line_polarity(i) * depth * sin(quad.phase[lane]);
            }
            quad.mod_from = quad.mod_to;
            quad.mod_to = [F64x2::new(to[0], to[1]), F64x2::new(to[2], to[3])];
        }
    }

    // The samples of a chunk of this block and of a group of its passes over time. The lines are read for a whole
    // chunk before any of it is written, so the shortest delay of a line in the block (they move in straight lines
    // over it: at its start or its end) is past the chunk and the 2 samples a read takes after its place; at
    // least 1. An allpass is read and written four samples at a time: its delay is past those and the 2 of a
    // read, else (no reverb of the ranges of the params; a delay that is not a number) every sample is a chunk
    // and a group of its own, one after the other
    fn chunk_length(&self) -> (usize, usize) {
        let (from, to) = (self.line_scale.from, self.line_scale.value);
        let (from2, to2) = (F64x2::splat(from), F64x2::splat(to));
        let (mut line, mut allpass) = (f64::INFINITY, f64::INFINITY);
        for quad in self.quads.iter() {
            for half in 0..2 {
                let start = quad.base[half] * from2 + quad.mod_from[half];
                let end = quad.base[half] * to2 + quad.mod_to[half];
                let least = start.min(end);
                line = min(line, min(least.lo(), least.hi()));
                let least = (quad.allpass_base[half] * from2).min(quad.allpass_base[half] * to2);
                allpass = min(allpass, min(least.lo(), least.hi()));
            }
        }
        #[cfg(test)]
        if self.sample_by_sample {
            return (1, 1);
        }
        // (a NaN is under no bound)
        if allpass >= 6.0 && line >= 3.0 {
            (min(CHUNK as f64, floor(line) - 2.0) as usize, 4)
        } else {
            (1, 1)
        }
    }

    fn snap(&mut self) {
        for value in self.values.iter_mut() {
            value.snap();
        }
        self.line_scale.snap();
    }

    fn clear(&mut self) {
        let input = &mut self.input;
        for node in input.bandwidth.iter_mut() {
            node.clear();
        }
        input.lowcut.clear();
        input.body.clear();
        input.predelay.clear();
        for diffuser in input.diffusers.iter_mut() {
            diffuser.clear();
        }
        self.er_absorb.clear();
        self.er_line.clear();
        for quad in self.quads.iter_mut() {
            quad.delay.clear();
            quad.allpass.clear();
            quad.low.clear();
            quad.high.clear();
            quad.mod_from = quad.mod_to;
        }
    }

    /// set(changes, routed): `changes` the keys and values of the params that changed, in the order of the message
    pub fn set(&mut self, changes: &[(usize, f64)], routed: bool) {
        let glide = if routed { Some(GLIDE) } else { None };
        let mut size_changed = false;
        for &(key, value) in changes {
            if key >= PARAMS {
                continue;
            }
            if key == SIZE {
                size_changed = true;
            }
            self.targets[key] = value;
            self.values[key].set(value, self.idle, glide);
        }
        let factor = line_factor(self.targets[SIZE], self.targets[DECAY], self.total_loop);
        self.line_scale
            .set(factor, self.idle, if size_changed { glide } else { None });
    }

    pub fn set_active(&mut self, value: bool) {
        self.active = value;
        self.fade.set(if value { 1.0 } else { 0.0 }, false, None);
    }

    /// the tail is forgotten (a preset switch, the output muted): as once drained, the lines are empty, the next
    /// sound starts at the params as they are then, no glide from those of before
    pub fn forget(&mut self) {
        // (an idle reverb has cleared them: the lines of the largest room are megabytes)
        if !self.idle {
            self.clear();
        }
        self.outs.fill(F32x4::default());
        self.idle = true;
    }

    // stepAll of the values of `keys`: each is stepped, true if any of them glides
    fn step_all(&mut self, keys: &[usize], frames: f64) -> bool {
        let mut gliding = false;
        for &key in keys {
            gliding = self.values[key].step(frames) || gliding;
        }
        gliding
    }

    pub fn process(&mut self, in_l: &[f32], in_r: &[f32], out_l: &mut [f32], out_r: &mut [f32]) {
        let frames = out_l.len();
        let n = frames as f64;
        let input_peak = max(peak(in_l), peak(in_r));
        self.quiet_frames = if input_peak < SILENCE {
            self.quiet_frames + n
        } else {
            0.0
        };
        if self.idle {
            if !self.active || self.quiet_frames != 0.0 {
                out_l.fill(0.0);
                out_r.fill(0.0);
                return;
            }
            self.idle = false;
            self.snap();
            self.update_input();
            self.update_decay();
        }

        // the values by what they recompute while gliding
        if self.step_all(&[LOWCUT, BANDWIDTH, BODY], n) {
            self.update_input();
        }
        let scale_gliding = self.line_scale.step(n);
        if self.step_all(&[DECAY, BASS, DAMP], n) || scale_gliding {
            self.update_decay();
        }
        self.step_all(&[SIZE, DEPTH, PRE, SEP, ER, DRIVE], n);
        self.fade.step(n);
        self.update_mod(n);

        let rate = self.sample_rate;
        let tube_offset = self.tube_offset;
        let (size_from, size_value) = (self.values[SIZE].from, self.values[SIZE].value);
        let (scale_from, scale_value) = (self.line_scale.from, self.line_scale.value);
        let (pre_from, pre_value) = (self.values[PRE].from, self.values[PRE].value);
        let (fade_from, fade_value) = (self.fade.from, self.fade.value);
        let width = self.values[SEP].value;
        let er = self.values[ER].value;
        let drive = self.values[DRIVE].value;
        let loop_scale = 2.0 / LINE_TIMES.len() as f32;
        let mut output_peak = F64x2::default();
        let (chunk_length, group) = self.chunk_length();
        let input = &mut self.input;
        // the early reflections: four taps a read (the even ones left, the odd ones right), their line one
        let er_taps: [F32x4; ER_TAPS.len() / 4] = core::array::from_fn(|q| lanes(q, |i| ER_TAPS[i].1));
        let er_delays: [[F64x2; 2]; ER_TAPS.len() / 4] =
            core::array::from_fn(|q| pairs(q, |i| self.er_delays[i]));
        let (er4, tail_level) = (F32x4::splat(er as f32), F32x4::splat(TAIL_LEVEL as f32));
        // The block in chunks: the input stage of a chunk, then the lines and their allpasses a line at a time (four
        // samples of time in the lanes: a line is a ring of its own, Rows), the reflection, the shelves and the
        // writes a quad at a time (four lines in the lanes), the output. A line is read before the chunk writes
        // it: what its reads take is in it already (chunk_length), so every sample is worked out as one after the
        // other would, to the bit
        let chunk = &mut *self.chunk;
        // (the left channel in the low lane, the right one in the high lane; of the lines the even ones left, the
        // odd ones right)
        let mut from = 0;
        while from < frames {
            let length = chunk_length.min(frames - from);
            for k in 0..length {
                let s = from + k;
                let t = (s as f64 + 1.0) / n;
                let room_scale = size_factor(size_from + (size_value - size_from) * t);
                let predelay = (pre_from + (pre_value - pre_from) * t) * rate;
                chunk.t[k] = t;
                chunk.factor[k] = scale_from + (scale_value - scale_from) * t;
                chunk.fade[k] = fade_from + (fade_value - fade_from) * t;

                let banded = input.bandwidth[0].process(F64x2::new(in_l[s] as f64, in_r[s] as f64));
                let mut x = input.bandwidth[1].process(banded);
                x = input
                    .body
                    .process(input.lowcut.process(tube(x, drive, tube_offset)));
                let pre = input.predelay.read(predelay);
                input.predelay.write(x);

                let mut early = F32x4::default();
                let room_scale2 = F64x2::splat(room_scale);
                for q in 0..er_taps.len() {
                    let [lo, hi] = er_delays[q];
                    early = early + er_taps[q] * self.er_line.read([lo * room_scale2, hi * room_scale2]);
                }
                self.er_line
                    .write(self.er_absorb.process((pre.lo() + pre.hi()) / 2.0) as f32);

                let mut diff = pre;
                for i in 0..self.diffuser_gains.len() {
                    diff = input.diffusers[i].process(diff, F64x2::splat(self.diffuser_gains[i]));
                }
                // (left, right, left, right: the lines of a quad)
                chunk.diffused[k] = F32x4::from_f64(diff, diff);
                chunk.early[k] = early;
            }

            for (q, quad) in self.quads.iter_mut().enumerate() {
                for row in 0..4 {
                    quad.line(
                        row,
                        &chunk.t,
                        &chunk.factor,
                        &mut chunk.outs[4 * q + row],
                        length,
                        group,
                    );
                }
                quad.allpass.advance(length);
            }
            // the sum of the lines of each lane (quad after quad), then the Householder reflection of the lines:
            // each takes its output less 2 / N of the sum of all (the lanes added as F32x4::sum adds them)
            let mut g = 0;
            while g < length {
                let lane = |row: usize| {
                    let mut tail = F32x4::default();
                    for q in 0..QUADS {
                        tail = tail + F32x4::load(&chunk.outs[4 * q + row][g..g + 4]);
                    }
                    tail
                };
                let tails = [lane(0), lane(1), lane(2), lane(3)];
                for (row, tail) in tails.iter().enumerate() {
                    tail.store(&mut chunk.tail[row][g..g + 4]);
                }
                let sum = (tails[0] + tails[2]) + (tails[1] + tails[3]);
                (sum * F32x4::splat(loop_scale)).store(&mut chunk.feedback[g..g + 4]);
                g += 4;
            }
            // (the quads of a sample together: the shelves of each wait for their sample before, not for each other)
            for k in 0..length {
                let gain4 = F32x4::splat(chunk.fade[k] as f32);
                let feedback = F32x4::splat(chunk.feedback[k]);
                for (q, quad) in self.quads.iter_mut().enumerate() {
                    let row = |row: usize| chunk.outs[4 * q + row][k];
                    let out = F32x4::new(row(0), row(1), row(2), row(3));
                    let line_in = chunk.diffused[k] * quad.input + out - feedback;
                    let y = quad.high.process(quad.low.process(line_in * quad.gain * gain4));
                    quad.delay.write(k, y);
                    if k + 1 == length {
                        self.outs[q] = out;
                    }
                }
            }
            for quad in self.quads.iter_mut() {
                quad.delay.advance(length);
            }

            for k in 0..length {
                let s = from + k;
                let gain = chunk.fade[k];
                let tail = F32x4::new(
                    chunk.tail[0][k],
                    chunk.tail[1][k],
                    chunk.tail[2][k],
                    chunk.tail[3][k],
                );
                // mid/side: L = M + w·S, R = M - w·S
                let (side_l, side_r) = sides(er4 * chunk.early[k] + tail_level * tail);
                let y_l = gain * ((side_l * (1.0 + width)) / 2.0 + (side_r * (1.0 - width)) / 2.0);
                let y_r = gain * ((side_r * (1.0 + width)) / 2.0 + (side_l * (1.0 - width)) / 2.0);
                out_l[s] = y_l as f32;
                out_r[s] = y_r as f32;
                output_peak = output_peak.max(F64x2::new(y_l, y_r).abs());
            }
            from += length;
        }
        let output_peak = max(output_peak.lo(), output_peak.hi());

        // the last line: a block that isn't finite (its input is: process_io; NaN through a path no one saw) would
        // stay in the lines until the reverb is off: forgotten, the block is silence
        if output_peak.is_nan() || output_peak > f32::MAX as f64 {
            self.clear();
            self.outs.fill(F32x4::default());
            out_l.fill(0.0);
            out_r.fill(0.0);
            return;
        }

        // the inactive reverb has faded out, a quiet one has drained: forget the tail, skip the next blocks
        let faded = !self.active && self.fade.value == 0.0;
        let drained = self.quiet_frames > self.drain_frames
            && output_peak < SILENCE
            && self
                .outs
                .iter()
                .all(|value| value.lanes().iter().all(|lane| (lane.abs() as f64) < SILENCE));
        if faded || drained {
            self.clear();
            self.idle = true;
        }
    }

    fn process_io(&mut self) {
        let mut io = core::mem::take(&mut self.io);
        // (NaN or an infinity of the graph as 0: one would stay in the lines until the reverb is off)
        io.finite_inputs();
        let (in_l, in_r, out_l, out_r) = io.split();
        self.process(in_l, in_r, out_l, out_r);
        self.io = io;
    }
}

// the params of fx_new ([active, ...PARAMS]) and fx_set ([count, key, value, …]), written by the JS wrapper
static mut COMMAND: [f64; 2 * PARAMS + 2] = [0.0; 2 * PARAMS + 2];

fn command() -> &'static [f64; 2 * PARAMS + 2] {
    // SAFETY: one thread (the audio thread of the scope); the wrapper writes it right before the call reading it
    unsafe { &*core::ptr::addr_of!(COMMAND) }
}

/// the buffer the wrapper writes the params of fx_new and fx_set into
#[no_mangle]
pub extern "C" fn fx_command() -> *mut f64 {
    core::ptr::addr_of_mut!(COMMAND) as *mut f64
}

/// a reverb at the rate of the context, its options in the command buffer: active, then the params
#[no_mangle]
pub extern "C" fn fx_new(sample_rate: f64) -> *mut Reverb {
    let command = command();
    let params: [f64; PARAMS] = core::array::from_fn(|key| command[1 + key]);
    Box::into_raw(Box::new(Reverb::new(sample_rate, &params, command[0] != 0.0)))
}

/// # Safety
/// `reverb` comes from fx_new and was not freed
#[no_mangle]
pub unsafe extern "C" fn fx_free(reverb: *mut Reverb) {
    drop(Box::from_raw(reverb));
}

/// # Safety
/// `reverb` comes from fx_new and was not freed
#[no_mangle]
pub unsafe extern "C" fn fx_buffers(reverb: *mut Reverb, frames: usize) -> *mut f32 {
    (*reverb).io.reserve(frames)
}

/// # Safety
/// `reverb` comes from fx_new and was not freed, its buffers reserved for the block
#[no_mangle]
pub unsafe extern "C" fn fx_process(reverb: *mut Reverb) {
    (*reverb).process_io();
}

/// the params changed, in the command buffer: their count, then key and value of each
///
/// # Safety
/// `reverb` comes from fx_new and was not freed
#[no_mangle]
pub unsafe extern "C" fn fx_set(reverb: *mut Reverb, routed: bool) {
    let command = command();
    let count = (command[0] as usize).min(PARAMS);
    let mut changes = [(0usize, 0.0f64); PARAMS];
    for (i, change) in changes.iter_mut().enumerate().take(count) {
        *change = (command[1 + 2 * i] as usize, command[2 + 2 * i]);
    }
    (*reverb).set(&changes[..count], routed);
}

/// # Safety
/// `reverb` comes from fx_new and was not freed
#[no_mangle]
pub unsafe extern "C" fn fx_set_active(reverb: *mut Reverb, active: bool) {
    (*reverb).set_active(active);
}

/// # Safety
/// `reverb` comes from fx_new and was not freed
#[no_mangle]
pub unsafe extern "C" fn fx_clear(reverb: *mut Reverb) {
    (*reverb).forget();
}

/// # Safety
/// `reverb` comes from fx_new and was not freed
#[no_mangle]
pub unsafe extern "C" fn fx_idle(reverb: *mut Reverb) -> bool {
    (*reverb).idle()
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    const BLOCK: usize = 128;

    // NaN or an infinity past the io (process_io zeroes them, process doesn't): its block is silence, the lines
    // forget it, the next blocks sound, a silence drains
    #[test]
    fn a_block_that_is_not_finite_is_forgotten() {
        let params = [
            20.0, 0.0, 0.5, 2.0, 20000.0, 1.0, 0.2, 1.0, 0.0, 0.0, 24000.0, 0.0,
        ];
        let sine: Vec<f32> = (0..BLOCK).map(|i| (0.5 * sin(i as f64 * 0.21)) as f32).collect();
        let silence = vec![0.0; BLOCK];
        for special in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            let mut reverb = Reverb::new(48000.0, &params, true);
            let mut poisoned = sine.clone();
            poisoned[17] = special;
            let (mut out_l, mut out_r) = (vec![0.0; BLOCK], vec![0.0; BLOCK]);
            reverb.process(&sine, &sine, &mut out_l, &mut out_r);
            reverb.process(&poisoned, &sine, &mut out_l, &mut out_r);
            assert!(out_l.iter().chain(&out_r).all(|x| *x == 0.0));
            for _ in 0..40 {
                reverb.process(&sine, &sine, &mut out_l, &mut out_r);
                assert!(out_l.iter().chain(&out_r).all(|x| x.is_finite()));
            }
            assert!(out_l.iter().any(|x| x.abs() > 1e-3));
            for _ in 0..4000 {
                reverb.process(&silence, &silence, &mut out_l, &mut out_r);
            }
            assert!(reverb.idle);
        }
    }

    // the tube in f32 against its formula in doubles: at every drive, the smallest too (no difference of near
    // values), a silence stays one
    #[test]
    fn the_tube_is_its_curve_at_every_drive() {
        let offset = tanh(TUBE_BIAS);
        for drive in [MIN_DRIVE, 1e-3, 0.15, 1.0, 5.0] {
            for step in -80..=80 {
                let x = step as f64 * 0.1;
                let exact = (tanh(drive * x + TUBE_BIAS) - offset) / (drive * (1.0 - offset * offset));
                let ours = tube(F64x2::new(x, -x), drive, offset);
                assert!(
                    (ours.lo() - exact).abs() <= 1e-6 * max(1.0, exact.abs()),
                    "drive {drive} at {x}: {} of {exact}",
                    ours.lo()
                );
            }
            assert_eq!(tube(F64x2::splat(0.0), drive, offset).lo(), 0.0);
        }
    }

    // the passes over chunks give the bits of a sample after the other: blocks of any length, the size, the
    // decay and the depth gliding (the delays of the lines move), at the rates the shortest lines are shortest
    #[test]
    fn the_chunks_render_what_a_sample_after_the_other_would() {
        let mut seed = 7u32;
        let mut random = move || {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            (seed >> 8) as f64 / (1 << 24) as f64
        };
        for rate in [22050.0, 44100.0, 96000.0] {
            let params = [20.0, 0.01, 0.0, 0.3, 6000.0, 1.0, 1.0, 1.0, 0.5, 0.2, 9000.0, 2.0];
            let mut chunked = Reverb::new(rate, &params, true);
            let mut single = Reverb::new(rate, &params, true);
            single.sample_by_sample = true;
            let mut sounded = 0;
            for block in 0..120 {
                let frames = if block % 3 == 0 {
                    128
                } else {
                    1 + (random() * 700.0) as usize
                };
                if block % 9 == 4 {
                    // (routed every other time: the glide of an envelope)
                    let changes = [
                        (SIZE, random()),
                        (DECAY, 0.1 + 12.0 * random()),
                        (DEPTH, 1.5 * random()),
                    ];
                    for reverb in [&mut chunked, &mut single] {
                        reverb.set(&changes, block % 2 == 0);
                    }
                }
                let input: Vec<f32> = (0..frames).map(|_| (random() - 0.5) as f32).collect();
                let mut outs = [
                    vec![0.0f32; frames],
                    vec![0.0; frames],
                    vec![0.0; frames],
                    vec![0.0; frames],
                ];
                let [l, r, sl, sr] = &mut outs;
                chunked.process(&input, &input, l, r);
                single.process(&input, &input, sl, sr);
                let bits = |values: &[f32]| values.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
                assert_eq!(bits(l), bits(sl), "{rate} Hz, block {block} of {frames}");
                assert_eq!(bits(r), bits(sr), "{rate} Hz, block {block} of {frames}");
                sounded += l.iter().filter(|x| **x != 0.0).count();
            }
            assert!(sounded > 10000);
        }
    }
}
