//! The reverb (the tables of reverb-decay.ts and reverb-era.ts of the app; the goldens hold its sound, the Hall of
//! the reference Audio Unit its laws: dsp/measurements/reverb.json): a 16-line FDN with early reflections, input
//! diffusion and the input stage of the eras. The input stage runs in doubles, both channels in the lanes; the
//! lines, their allpasses and shelves, the early reflections and the output in f32, four samples of a line or four
//! lines of a sample in the lanes (the delays in doubles, a place in a group of four its share in f32). A unit of
//! the chain core (dsp/chain)

#![cfg_attr(target_arch = "wasm32", no_std)]

extern crate alloc;

use alloc::{boxed::Box, vec::Vec};

use dsp_core::biquad::{lowshelf_into, Biquad, FilterType};
use dsp_core::blocks::{louder, loudest, peak, Rows, Smoothed, StereoDelayLine, StereoFixedAllpass};
use dsp_core::simd::{transpose, F32x4, F64x2};
use dsp_core::stereo::{QuadBiquad, StereoBiquad};
use dsp_core::tanh::tanh4;
use jsmath::{cos, exp, floor, log, max, min, sin, sqrt, tanh, LN_10, PI, SQRT2};

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
const DAMP_KNEE: f64 = 8000.0;
const DAMP_OPEN: f64 = 20000.0;
const HALL_SIZE: f64 = 4.6;
const XOVER: f64 = 300.0;
const MAX_SHELF_CUT: f64 = -40.0;
// the most the low shelf lifts or cuts a pass (dB): past it its poles in f32 leave the unit circle (the long lines
// of a hall at the shortest decay: hundreds of dB), and a pass of so much loses all its lows anyway
const MAX_LOW_SHELF: f64 = 60.0;
const MIN_MODAL_OVERLAP: f64 = 0.19;

// the scale of the early reflections by the size
fn room_factor(size: f64) -> f64 {
    0.3 + size * 1.2
}

// The scale of the lines by the size: the one of the early reflections up to the middle of the knob, then the
// lines of a hall (the Hall of the reference: its first echoes tens of ms apart, its level flat for a while
// before it falls, a decay that long lines alone hold)
fn size_factor(size: f64) -> f64 {
    let s2 = size * size;
    room_factor(size) + HALL_SIZE * (s2 * s2 * size)
}

// What the lines at the scale `factor` give of a steady sound, the power of their outputs against the one that
// goes in (the energy of their response): a line gives g² / (1 - g²) of it, g what a pass through it keeps at the
// mids (it is heard after its first pass)
fn given(factor: f64, decay: f64) -> f64 {
    let mut sum = 0.0;
    for i in 0..LINE_TIMES.len() {
        sum += 1.0 / (exp((6.0 * LN_10 * loop_length(i, factor)) / decay) - 1.0);
    }
    sum
}

// the most the level of a tail is raised: lines far longer than the decay give a faint echo each, not a tail
const MAX_TAIL_LEVEL: f64 = 4.0;

// The level of the tail by the size: longer lines give less of a steady sound (a pass through them loses more of
// it), the tail is as loud as that of lines of the scale of the early reflections (the Hall of the reference: the
// energy of its response is the same at every Size)
fn tail_level(size: f64, factor: f64, decay: f64, total_loop: f64) -> f64 {
    let room = max(room_factor(size), modal_floor(decay, total_loop));
    if factor <= room {
        return 1.0;
    }
    let of_room = given(room, decay);
    if of_room <= 0.0 {
        return 1.0;
    }
    min(MAX_TAIL_LEVEL, sqrt(of_room / given(factor, decay)))
}

// how long the highs ring against the mids by the damping frequency: HF_RATIO up to DAMP_KNEE, then longer, as
// long as the mids at the top of the knob (no damping: the highs of a large hall of the reference ring as its mids)
fn hf_ratio(damp: f64) -> f64 {
    let x = max(0.0, min(1.0, log(damp / DAMP_KNEE) / log(DAMP_OPEN / DAMP_KNEE)));
    HF_RATIO + (1.0 - HF_RATIO) * (x * x)
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

// the shortest scale of the lines at a decay: their modes overlap at least MIN_MODAL_OVERLAP
fn modal_floor(decay: f64, total_loop: f64) -> f64 {
    (MIN_MODAL_OVERLAP * decay) / (2.2 * total_loop)
}

fn line_factor(size: f64, decay: f64, total_loop: f64) -> f64 {
    max(size_factor(size), modal_floor(decay, total_loop))
}

// lowshelf dB, highshelf dB of a pass that loses `db` at the mids (lineDecay of reverb-decay.ts), each within its
// bounds
fn shelves(db: f64, bass: f64, hf_ratio: f64) -> (f64, f64) {
    (
        max(-MAX_LOW_SHELF, min(MAX_LOW_SHELF, db * (1.0 - 1.0 / bass))),
        max(MAX_SHELF_CUT, -db * (1.0 / hf_ratio - 1.0)),
    )
}

// 10^(db / 20)
fn gain_of(db: f64) -> f64 {
    exp(db * (LN_10 / 20.0))
}

// The damping of a line: a high shelf of the first order (a gentle tilt: the highs of a hall ring shorter octave
// after octave, no step), 0 dB at DC, `db` at the top, half of it at the frequency of `k` = tan(π f / rate). Its
// section (b0, b1, b2, a1, a2)
fn damping(k: f64, db: f64) -> [f64; 5] {
    // (none: a wire)
    if db == 0.0 {
        return [1.0, 0.0, 0.0, 0.0, 0.0];
    }
    let root = gain_of(db / 2.0);
    let norm = 1.0 + root * k;
    [
        (root * (root + k)) / norm,
        (root * (k - root)) / norm,
        0.0,
        (root * k - 1.0) / norm,
        0.0,
    ]
}

// The low shelf of a line at XOVER: the lowshelf of a BiquadFilterNode of `db` (dsp_core::biquad), the cosine and
// the sine of its frequency worked out once (cos w, sin w / √2); 0 dB: a wire
fn low_shelf((cos, sin_root): (f64, f64), db: f64) -> [f64; 5] {
    let mut c = [1.0, 0.0, 0.0, 0.0, 0.0];
    if db != 0.0 {
        lowshelf_into(&mut c, gain_of(db / 2.0), cos, sin_root);
    }
    c
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
// (seconds at the scale 1, level): the even ones go left, the odd ones right
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
// the shortest delay a pass over groups of four samples reads: the four it has not written, the taps of a read
// after its place, a share of a sample that leaves it
const MIN_GROUP_DELAY: f64 = 8.0;

fn line_polarity(i: usize) -> f64 {
    if i % 4 < 2 {
        1.0
    } else {
        -1.0
    }
}

// the gain of an allpass of `delay` seconds: `gain`, less where it would ring longer than the decay
fn allpass_gain(delay: f64, decay: f64, gain: f64) -> f64 {
    min(gain, gain_of((-60.0 * delay) / (decay * ALLPASS_RING)))
}

// the input stage of both channels, the left one in the low lane, the right one in the high lane
struct Input {
    bandwidth: [StereoBiquad; 2],
    lowcut: StereoBiquad,
    body: StereoBiquad,
    predelay: StereoDelayLine,
    diffusers: [StereoFixedAllpass; 4],
}

// A delay that moves in a straight line over a block: `at` its start, `by` what it moves over it, `slope` what it
// moves a sample (samples)
#[derive(Clone, Copy)]
struct Glide {
    at: f64,
    by: f64,
    slope: f32,
}

impl Glide {
    fn new(from: f64, to: f64, frames: f64) -> Glide {
        Glide {
            at: from,
            by: to - from,
            slope: ((to - from) / frames) as f32,
        }
    }

    // the delay at the share `t` of the block (a read takes no delay under 2 samples)
    #[inline(always)]
    fn delay(&self, t: f64) -> f64 {
        max(2.0, self.at + self.by * t)
    }
}

// four lines of the FDN (4q..4q + 4): the even ones (lanes 0 and 2) go left, the odd ones right; each a ring of
// its own (Rows)
struct LineQuad {
    base: [f64; 4],
    allpass_base: [f64; 4],
    delay: Rows,
    allpass: Rows,
    low: QuadBiquad,
    high: QuadBiquad,
    input: F32x4,
    gain: F32x4,
    allpass_gain: F32x4,
    phase: [f64; 4],
    mod_from: [f64; 4],
    mod_to: [f64; 4],
}

impl LineQuad {
    // Line `row` of the quad over a chunk of `length`: read at its delay (the scale of the lines and its
    // modulation: a straight line over the block), through its Schroeder allpass of a gliding delay, into `outs`.
    // Four samples of time in the lanes: the delay of the first of a group in doubles (`t`: the share of the
    // block there), the shares of a sample of the next three from it in f32 (Rows::read4_at). A sample alone
    // (`lane`: a pass of one sample at a time) is its lane of its group, the same bits. One loop for every line
    // (a function of its own: the pass of a chunk calls it sixteen times)
    #[inline(never)]
    fn line(
        &mut self,
        row: usize,
        delay: Glide,
        allpass: Glide,
        t: &[f64; CHUNK / 4],
        outs: &mut [f32; CHUNK],
        length: usize,
        lane: Option<usize>,
    ) {
        let gain = F32x4::splat(self.allpass_gain.lanes()[row]);
        let back = lane.unwrap_or(0) as i32;
        // (a group over the end of the chunk: its samples past it are not used, an allpass writes them again
        // before it reads them)
        let mut g = 0;
        while g < length {
            let (at, offset) = (t[g / 4], g as i32 - back);
            let delayed = self.delay.read4_at(row, offset, delay.delay(at), delay.slope);
            let turned = self
                .allpass
                .read4_at(row, offset, allpass.delay(at), allpass.slope);
            let sum = delayed + gain * turned;
            let out = turned - gain * sum;
            if let Some(lane) = lane {
                self.allpass.write1(row, 0, sum.lanes()[lane]);
                outs[0] = out.lanes()[lane];
                break;
            }
            self.allpass.write4(row, g, sum);
            out.store(&mut outs[g..g + 4]);
            g += 4;
        }
    }
}

const QUADS: usize = LINE_TIMES.len() / 4;

// a value per lane of quad q (line 4q + lane)
fn lanes(q: usize, value: impl Fn(usize) -> f64) -> [f64; 4] {
    core::array::from_fn(|lane| value(4 * q + lane))
}
// the longest of the lines of quad q (their ring is one)
fn longest_of(q: usize, value: impl Fn(usize) -> f64) -> f64 {
    (0..4).fold(f64::NEG_INFINITY, |longest, lane| {
        max(longest, value(4 * q + lane))
    })
}

pub struct Reverb {
    sample_rate: f64,
    total_loop: f64,
    tube_offset: f64,
    // the cosine of XOVER and its sine over √2 (low_shelf)
    xover: (f64, f64),
    values: [Smoothed; PARAMS],
    targets: [f64; PARAMS],
    line_scale: Smoothed,
    // the level of the tail (tail_level) at the knobs update_decay last took, given to the sound as it goes into the
    // lines: a tail that rings keeps the level it went in at, a new level is of the sound after it (a block goes in
    // a straight line from the one before)
    level: f64,
    idle: bool,
    quiet_frames: f64,
    drain_frames: f64,
    input: Input,
    er_absorb: Biquad,
    // (its first row: the line of the early reflections, read four samples at a time as a line of the FDN is)
    er_line: Rows,
    er_delays: [f64; 8],
    diffuser_gains: [f64; 4],
    quads: Vec<LineQuad>,
    outs: [F32x4; QUADS],
    chunk: Box<Chunk>,
    // (the spec of the crate: every sample a chunk of its own, what the chunks are held to)
    #[cfg(test)]
    sample_by_sample: bool,
}

/// the most samples of a chunk of a block (process): groups of four
const CHUNK: usize = 64;
const LINES: usize = LINE_TIMES.len();

// The samples of a chunk between its passes. Of each group of four: the share of the block at its first sample
// (the glides). Of each sample: the diffused input of the lines at the level of the tail (left, right, left,
// right), what the line of the early reflections takes, the early reflections of each side. Of each line a row of its
// samples (four in a row are the lanes of a pass over time): its output; the sums of the lines of each lane, the
// reflection of them all
struct Chunk {
    t: [f64; CHUNK / 4],
    diffused: [F32x4; CHUNK],
    er_in: [f32; CHUNK],
    early: [[f32; CHUNK]; 2],
    outs: [[f32; CHUNK]; LINES],
    tail: [[f32; CHUNK]; 4],
    feedback: [f32; CHUNK],
}

impl Reverb {
    pub fn new(sample_rate: f64, params: &[f64; PARAMS]) -> Reverb {
        let samples = |seconds: f64| seconds * sample_rate;
        let total_loop = total_loop();
        let max_factor = room_factor(MAX_SIZE);
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
        let line_input = 0.5 * sqrt(8.0 / LINE_TIMES.len() as f64);
        let quads = (0..QUADS)
            .map(|q| {
                let input = lanes(q, |i| line_input * line_polarity(i)).map(|x| x as f32);
                LineQuad {
                    base: lanes(q, |i| samples(LINE_TIMES[i])),
                    allpass_base: lanes(q, |i| samples(LOOP_ALLPASS_TIMES[i])),
                    delay: Rows::new(
                        4,
                        longest_of(q, |i| samples(LINE_TIMES[i] * max_line_factor + MOD_DEPTH) + 2.0),
                    ),
                    allpass: Rows::new(
                        4,
                        longest_of(q, |i| samples(LOOP_ALLPASS_TIMES[i] * max_line_factor) + 2.0),
                    ),
                    low: QuadBiquad::default(),
                    high: QuadBiquad::default(),
                    input: F32x4::load(&input),
                    gain: F32x4::splat(1.0),
                    allpass_gain: F32x4::splat(LOOP_DIFFUSION as f32),
                    phase: [0.0; 4],
                    mod_from: [0.0; 4],
                    mod_to: [0.0; 4],
                }
            })
            .collect();
        let xover = (PI * XOVER) / (sample_rate / 2.0);
        let mut reverb = Reverb {
            sample_rate,
            total_loop,
            tube_offset: tanh(TUBE_BIAS),
            xover: (cos(xover), sin(xover) / SQRT2),
            values,
            targets: *params,
            line_scale: Smoothed::new(
                line_factor(params[SIZE], params[DECAY], total_loop),
                SIZE_GLIDE,
                sample_rate,
            ),
            level: TAIL_LEVEL,
            // (its lines are empty: nothing to clear, a knob set before its first sound is taken at once)
            idle: true,
            quiet_frames: 0.0,
            drain_frames,
            input,
            er_absorb: Biquad::default(),
            er_line: Rows::new(1, samples(ER_TAPS[ER_TAPS.len() - 1].0 * max_factor) + 2.0),
            er_delays: core::array::from_fn(|i| samples(ER_TAPS[i].0)),
            diffuser_gains: [DIFFUSION; 4],
            quads,
            outs: [F32x4::default(); QUADS],
            chunk: Box::new(Chunk {
                t: [0.0; CHUNK / 4],
                diffused: [F32x4::default(); CHUNK],
                er_in: [0.0; CHUNK],
                early: [[0.0; CHUNK]; 2],
                outs: [[0.0; CHUNK]; LINES],
                tail: [[0.0; CHUNK]; 4],
                feedback: [0.0; CHUNK],
            }),
            #[cfg(test)]
            sample_by_sample: false,
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

    // The gain and both shelves of a line come from the same values and its current length. Once a block while a
    // knob of them glides: an exponential a line for each (the cosines of the shelves are those of the block)
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
        self.level = TAIL_LEVEL * tail_level(self.values[SIZE].value, factor, decay, self.total_loop);
        let hf_ratio = hf_ratio(damp);
        let w = (PI * min(damp, 0.49 * rate)) / rate;
        let k = sin(w) / cos(w);
        for (q, quad) in self.quads.iter_mut().enumerate() {
            let mut gains = [0.0; 4];
            let mut allpass_gains = [0.0; 4];
            for lane in 0..4 {
                let i = 4 * q + lane;
                // what a pass through the line loses at the mids, dB
                let db = (60.0 * loop_length(i, factor)) / decay;
                let (low_db, high_db) = shelves(db, bass, hf_ratio);
                gains[lane] = gain_of(-db) as f32;
                allpass_gains[lane] =
                    allpass_gain(LOOP_ALLPASS_TIMES[i] * factor, decay, LOOP_DIFFUSION) as f32;
                quad.low.set_coefficients(lane, &low_shelf(self.xover, low_db));
                quad.high.set_coefficients(lane, &damping(k, high_db));
            }
            quad.gain = F32x4::load(&gains);
            quad.allpass_gain = F32x4::load(&allpass_gains);
        }
    }

    fn update_mod(&mut self, frames: f64) {
        let rate = self.sample_rate;
        let depth = self.values[DEPTH].value * (MOD_DEPTH * rate);
        for (q, quad) in self.quads.iter_mut().enumerate() {
            quad.mod_from = quad.mod_to;
            for lane in 0..4 {
                let i = 4 * q + lane;
                quad.phase[lane] =
                    (quad.phase[lane] + (2.0 * PI * MOD_RATES[i] * frames) / rate) % (2.0 * PI);
                quad.mod_to[lane] = line_polarity(i) * depth * sin(quad.phase[lane]);
            }
        }
    }

    // The samples of a chunk of this block, and whether its passes go four samples at a time. The lines are read
    // for a whole chunk before any of it is written, so the shortest delay of a line in the block (they move in
    // straight lines over it: at its start or its end) is past the chunk and the 2 samples a read takes after its
    // place. An allpass and the line of the early reflections are read and written four samples at a time: their
    // delays are past those (MIN_GROUP_DELAY), else (no reverb of the ranges of the params; a delay that is not a
    // number) every sample is a chunk of its own, one after the other
    fn chunk_length(&self, room: f64) -> (usize, bool) {
        let (from, to) = (self.line_scale.from, self.line_scale.value);
        let (mut line, mut allpass) = (f64::INFINITY, f64::INFINITY);
        for quad in self.quads.iter() {
            for lane in 0..4 {
                let start = quad.base[lane] * from + quad.mod_from[lane];
                let end = quad.base[lane] * to + quad.mod_to[lane];
                line = min(line, min(start, end));
                allpass = min(allpass, quad.allpass_base[lane] * min(from, to));
            }
        }
        #[cfg(test)]
        if self.sample_by_sample {
            return (1, false);
        }
        // (a NaN is under no bound)
        let grouped = allpass >= MIN_GROUP_DELAY
            && line >= MIN_GROUP_DELAY
            && self.er_delays[0] * room >= MIN_GROUP_DELAY;
        if grouped {
            ((min(CHUNK as f64, floor(line) - 2.0) as usize) & !3, true)
        } else {
            (1, false)
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
            if self.quiet_frames != 0.0 {
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
        let level_from = self.level;
        if self.step_all(&[SIZE, DECAY, BASS, DAMP], n) || scale_gliding {
            self.update_decay();
        }
        self.step_all(&[DEPTH, PRE, SEP, ER, DRIVE], n);
        self.update_mod(n);

        let rate = self.sample_rate;
        let tube_offset = self.tube_offset;
        let (size_from, size_value) = (self.values[SIZE].from, self.values[SIZE].value);
        let (scale_from, scale_value) = (self.line_scale.from, self.line_scale.value);
        let (pre_from, pre_value) = (self.values[PRE].from, self.values[PRE].value);
        let width = self.values[SEP].value;
        let er = self.values[ER].value as f32;
        let drive = self.values[DRIVE].value;
        let loop_scale = 2.0 / LINE_TIMES.len() as f32;
        // (the scale of the early reflections, as the level of the tail: a straight line over the block)
        let (room_from, room_to) = (room_factor(size_from), room_factor(size_value));
        let room_slope = (room_to - room_from) / n;
        let level_to = self.level;
        // mid/side: L = M + w·S, R = M - w·S
        let (same, cross) = (((1.0 + width) / 2.0) as f32, ((1.0 - width) / 2.0) as f32);
        let (chunk_length, grouped) = self.chunk_length(min(room_from, room_to));
        let input = &mut self.input;
        // (a stage of the input that is a wire is not run: the lowpasses of the era Now, a body of 0 dB)
        let banded = !(input.bandwidth[0].is_wire() && input.bandwidth[1].is_wire());
        let bodied = !input.body.is_wire();
        // The block in chunks: the input stage of a chunk a sample at a time, then four samples of time in the
        // lanes: the early reflections a tap at a time, the lines and their allpasses a line at a time (each a ring
        // of its own, Rows); the reflection; the shelves and the writes a quad at a time (four lines in the lanes);
        // the output. A line is read before the chunk writes it: what its reads take is in it already
        // (chunk_length), so every sample is worked out as one after the other would, to the bit: a sample alone
        // is its lane of the group it is in (the groups of a block start at its samples 0, 4, 8…)
        let chunk = &mut *self.chunk;
        let mut from = 0;
        while from < frames {
            let length = chunk_length.min(frames - from);
            let lane = if grouped { None } else { Some(from % 4) };
            let back = lane.unwrap_or(0);
            for (g, t) in chunk.t.iter_mut().enumerate().take(length.div_ceil(4)) {
                *t = ((from - back + 4 * g) as f64 + 1.0) / n;
            }

            // (the left channel in the low lane, the right one in the high lane)
            for k in 0..length {
                let s = from + k;
                let t = (s as f64 + 1.0) / n;
                let predelay = (pre_from + (pre_value - pre_from) * t) * rate;
                let level = level_from + (level_to - level_from) * t;

                let mut x = F64x2::new(in_l[s] as f64, in_r[s] as f64);
                if banded {
                    x = input.bandwidth[0].process(x);
                    x = input.bandwidth[1].process(x);
                }
                x = input.lowcut.process(tube(x, drive, tube_offset));
                if bodied {
                    x = input.body.process(x);
                }
                let pre = input.predelay.read(predelay);
                input.predelay.write(x);
                chunk.er_in[k] = self.er_absorb.process((pre.lo() + pre.hi()) / 2.0) as f32;

                let mut diff = pre;
                for i in 0..self.diffuser_gains.len() {
                    diff = input.diffusers[i].process(diff, F64x2::splat(self.diffuser_gains[i]));
                }
                // (left, right, left, right: the lines of a quad)
                let diff = diff * F64x2::splat(level);
                chunk.diffused[k] = F32x4::from_f64(diff, diff);
            }

            // the early reflections: each tap four samples at a time, the even ones left, the odd ones right; none
            // heard: none read
            let mut g = 0;
            while g < length {
                let (mut left, mut right) = (F32x4::default(), F32x4::default());
                if er != 0.0 {
                    let t = chunk.t[g / 4];
                    let room = room_from + (room_to - room_from) * t;
                    for (i, (_, level)) in ER_TAPS.iter().enumerate() {
                        let delay = self.er_delays[i];
                        let tap = self.er_line.read4_at(
                            0,
                            g as i32 - back as i32,
                            max(2.0, delay * room),
                            (delay * room_slope) as f32,
                        ) * F32x4::splat(*level as f32);
                        if i % 2 == 0 {
                            left = left + tap;
                        } else {
                            right = right + tap;
                        }
                    }
                }
                if let Some(lane) = lane {
                    chunk.early[0][0] = left.lanes()[lane];
                    chunk.early[1][0] = right.lanes()[lane];
                    self.er_line.write1(0, 0, chunk.er_in[0]);
                    break;
                }
                left.store(&mut chunk.early[0][g..g + 4]);
                right.store(&mut chunk.early[1][g..g + 4]);
                self.er_line.write4(0, g, F32x4::load(&chunk.er_in[g..g + 4]));
                g += 4;
            }
            self.er_line.advance(length);

            for (q, quad) in self.quads.iter_mut().enumerate() {
                for row in 0..4 {
                    let (base, allpass_base) = (quad.base[row], quad.allpass_base[row]);
                    quad.line(
                        row,
                        Glide::new(
                            base * scale_from + quad.mod_from[row],
                            base * scale_value + quad.mod_to[row],
                            n,
                        ),
                        Glide::new(allpass_base * scale_from, allpass_base * scale_value, n),
                        &chunk.t,
                        &mut chunk.outs[4 * q + row],
                        length,
                        lane,
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
            // The shelves and the writes of a quad over the chunk (its shelves wait for their sample before, not
            // for the other quads): four samples of its four lines turned into four lines of a sample (transpose),
            // through the shelves, turned back and written a line at a time
            for (q, quad) in self.quads.iter_mut().enumerate() {
                let (mut low, mut high) = (quad.low.clone(), quad.high.clone());
                let (input_gain, gain) = (quad.input, quad.gain);
                let rows = &chunk.outs[4 * q..4 * q + 4];
                let shelved = |low: &mut QuadBiquad, high: &mut QuadBiquad, out: F32x4, k: usize| {
                    let line_in = chunk.diffused[k] * input_gain + out - F32x4::splat(chunk.feedback[k]);
                    high.process(low.process(line_in * gain))
                };
                let mut k = 0;
                while grouped && k + 4 <= length {
                    let outs = transpose(core::array::from_fn(|row| F32x4::load(&rows[row][k..k + 4])));
                    let written = transpose(core::array::from_fn(|j| {
                        shelved(&mut low, &mut high, outs[j], k + j)
                    }));
                    for (row, samples) in written.into_iter().enumerate() {
                        quad.delay.write4(row, k, samples);
                    }
                    k += 4;
                }
                while k < length {
                    let out = F32x4::new(rows[0][k], rows[1][k], rows[2][k], rows[3][k]);
                    quad.delay.write(k, shelved(&mut low, &mut high, out, k));
                    k += 1;
                }
                let last = length - 1;
                self.outs[q] = F32x4::new(rows[0][last], rows[1][last], rows[2][last], rows[3][last]);
                (quad.low, quad.high) = (low, high);
                quad.delay.advance(length);
            }

            // the output: the early reflections and the tail of each side, their width
            let (er4, same4, cross4) = (F32x4::splat(er), F32x4::splat(same), F32x4::splat(cross));
            let mut k = 0;
            while grouped && k + 4 <= length {
                let s = from + k;
                let at = |values: &[f32; CHUNK]| F32x4::load(&values[k..k + 4]);
                let left = er4 * at(&chunk.early[0]) + (at(&chunk.tail[0]) + at(&chunk.tail[2]));
                let right = er4 * at(&chunk.early[1]) + (at(&chunk.tail[1]) + at(&chunk.tail[3]));
                let (y_l, y_r) = (left * same4 + right * cross4, right * same4 + left * cross4);
                y_l.store(&mut out_l[s..s + 4]);
                y_r.store(&mut out_r[s..s + 4]);
                k += 4;
            }
            while k < length {
                let s = from + k;
                let left = er * chunk.early[0][k] + (chunk.tail[0][k] + chunk.tail[2][k]);
                let right = er * chunk.early[1][k] + (chunk.tail[1][k] + chunk.tail[3][k]);
                let (y_l, y_r) = (left * same + right * cross, right * same + left * cross);
                out_l[s] = y_l;
                out_r[s] = y_r;
                k += 1;
            }
            from += length;
        }
        let output = louder(loudest(out_l), loudest(out_r));

        // the last line: a block that isn't finite (its input is: the chain; NaN through a path no one saw) would
        // stay in the lines until the reverb is off: forgotten, the block is silence
        if !output.is_finite() {
            self.clear();
            self.outs.fill(F32x4::default());
            out_l.fill(0.0);
            out_r.fill(0.0);
            return;
        }

        // a quiet one has drained: forget the tail, skip the next blocks
        let quiet = |value: &F32x4| value.lanes().iter().all(|lane| (lane.abs() as f64) < SILENCE);
        let drained =
            self.quiet_frames > self.drain_frames && (output as f64) < SILENCE && self.outs.iter().all(quiet);
        if drained {
            self.clear();
            self.idle = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    const BLOCK: usize = 128;

    // NaN or an infinity past the chain (it zeroes them, process doesn't): its block is silence, the lines
    // forget it, the next blocks sound, a silence drains
    #[test]
    fn a_block_that_is_not_finite_is_forgotten() {
        let params = [
            20.0, 0.0, 0.5, 2.0, 20000.0, 1.0, 0.2, 1.0, 0.0, 0.0, 24000.0, 0.0,
        ];
        let sine: Vec<f32> = (0..BLOCK).map(|i| (0.5 * sin(i as f64 * 0.21)) as f32).collect();
        let silence = vec![0.0; BLOCK];
        for special in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            let mut reverb = Reverb::new(48000.0, &params);
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
    // decay and the depth gliding (the delays of the lines move, slowly and over a sample a sample), the early
    // reflections heard and not, the eras, at the rates the shortest lines are shortest
    #[test]
    fn the_chunks_render_what_a_sample_after_the_other_would() {
        let mut seed = 7u32;
        let mut random = move || {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            (seed >> 8) as f64 / (1 << 24) as f64
        };
        for rate in [22050.0, 44100.0, 96000.0] {
            let params = [20.0, 0.01, 0.0, 0.3, 6000.0, 1.0, 1.0, 1.0, 0.5, 0.2, 9000.0, 2.0];
            let mut chunked = Reverb::new(rate, &params);
            let mut single = Reverb::new(rate, &params);
            single.sample_by_sample = true;
            let mut sounded = 0;
            for block in 0..160 {
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
                        (BASS, if block % 2 == 0 { 1.0 } else { 0.5 + random() }),
                        (ER, if block % 4 == 0 { 0.0 } else { random() }),
                        (BANDWIDTH, if block % 3 == 0 { rate / 2.0 } else { 9000.0 }),
                        (BODY, if block % 5 == 0 { 0.0 } else { 2.0 }),
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

    // the laws of the size and of the damping: the lines of the reflections up to the middle of the size, a hall
    // over it; the highs ring HF_RATIO of the decay up to the knee of the damping, as the mids at its top
    #[test]
    fn the_size_and_the_damping_open_at_the_top_of_their_knobs() {
        assert_eq!(size_factor(0.0), room_factor(0.0));
        assert!(size_factor(0.5) / room_factor(0.5) < 1.2);
        assert!((size_factor(1.0) - 6.1).abs() < 1e-9);
        // the tail of longer lines as loud: where they are those of the reflections its level is 1, at the top of
        // the size over it: the root of their lengths at a long decay, more at a shorter one, MAX_TAIL_LEVEL at
        // most (a decay the lines are far longer than, also one too short for either to give anything)
        let total = total_loop();
        assert_eq!(tail_level(0.0, size_factor(0.0), 2.0, total), 1.0);
        assert!(tail_level(0.5, size_factor(0.5), 2.0, total) < 1.2);
        let top = |decay: f64| tail_level(1.0, size_factor(1.0), decay, total);
        assert!(top(8.0) > sqrt(6.1 / 1.5) && top(8.0) < top(3.0) && top(3.0) < MAX_TAIL_LEVEL);
        assert_eq!(top(0.5), MAX_TAIL_LEVEL);
        assert_eq!(top(1e-4), 1.0);
        for damp in [500.0, 2000.0, DAMP_KNEE] {
            assert_eq!(hf_ratio(damp), HF_RATIO);
        }
        assert!(hf_ratio(12000.0) > HF_RATIO && hf_ratio(12000.0) < hf_ratio(16000.0));
        assert_eq!(hf_ratio(DAMP_OPEN), 1.0);
        // no damping: the shelf of the highs is a wire
        let (_, high_db) = shelves(3.0, 1.0, hf_ratio(DAMP_OPEN));
        assert_eq!(damping(0.5, high_db), [1.0, 0.0, 0.0, 0.0, 0.0]);
    }

    // the shelves of a line as their filters give them: the low one that of a BiquadFilterNode, the damping 0 dB
    // at DC, its dB at the top and half of them at its frequency
    #[test]
    fn the_shelves_of_a_line_are_their_filters() {
        let rate = 48000.0;
        let w = (PI * XOVER) / (rate / 2.0);
        for db in [-9.0, -0.5, 3.0] {
            let ours = low_shelf((cos(w), sin(w) / SQRT2), db);
            let mut node = [0.0; 5];
            dsp_core::biquad::coefficients_into(&mut node, Some(FilterType::Lowshelf), XOVER, 0.0, db, rate);
            for k in 0..5 {
                assert!((ours[k] - node[k]).abs() < 1e-12, "{db} dB, coefficient {k}");
            }
        }
        let gain_at = |c: &[f64; 5], w: f64| {
            let (re, im) = (c[0] + c[1] * cos(w), -c[1] * sin(w));
            let (dre, dim) = (1.0 + c[3] * cos(w), -c[3] * sin(w));
            10.0 * jsmath::log10((re * re + im * im) / (dre * dre + dim * dim))
        };
        for (frequency, db) in [(1000.0, -6.0), (6000.0, -20.0), (15000.0, -1.5)] {
            let w = (PI * frequency) / rate;
            let c = damping(sin(w) / cos(w), db);
            assert!(gain_at(&c, 0.0).abs() < 1e-9);
            assert!((gain_at(&c, PI) - db).abs() < 1e-9);
            assert!((gain_at(&c, 2.0 * w) - db / 2.0).abs() < 1e-9, "{frequency} Hz");
        }
    }

    // The sections of a pass as update_decay sets them, rounded to f32, at the ends of the knobs and the rates: the
    // poles of the low shelf inside the unit circle, the pass under 0 dB at every frequency (a low shelf of
    // hundreds of dB in f32 had its poles on the circle or past it: a DC that never drained, a tail that grew to
    // overflow)
    #[test]
    fn the_shelves_of_a_line_are_stable_in_f32_at_the_ends_of_their_knobs() {
        // the low shelf as the bass asks, within ±MAX_LOW_SHELF
        assert_eq!(shelves(8.0, 4.0, HF_RATIO).0, 6.0);
        assert_eq!(shelves(8.0, 0.25, HF_RATIO).0, -24.0);
        assert_eq!(shelves(300.0, 4.0, HF_RATIO).0, MAX_LOW_SHELF);
        assert_eq!(shelves(300.0, 0.25, HF_RATIO).0, -MAX_LOW_SHELF);
        let total = total_loop();
        let in_f32 = |c: [f64; 5]| c.map(|x| x as f32 as f64);
        // the power of a section at w
        let power = |c: &[f64; 5], w: f64| {
            let (c1, s1, c2, s2) = (cos(w), sin(w), cos(2.0 * w), sin(2.0 * w));
            let (re, im) = (c[0] + c[1] * c1 + c[2] * c2, -(c[1] * s1 + c[2] * s2));
            let (dre, dim) = (1.0 + c[3] * c1 + c[4] * c2, -(c[3] * s1 + c[4] * s2));
            (re * re + im * im) / (dre * dre + dim * dim)
        };
        for rate in [22050.0, 44100.0, 48000.0, 96000.0, 192000.0] {
            let w = (PI * XOVER) / (rate / 2.0);
            let xover = (cos(w), sin(w) / SQRT2);
            for size in [0.0, 0.5, 0.9, 0.97, 1.0] {
                for decay in [0.1, 0.104, 0.117, 0.3, 2.0, 20.0] {
                    let factor = line_factor(size, decay, total);
                    for bass in [0.25, 0.5, 2.0, 3.0, 3.5, 4.0] {
                        for damp in [500.0, 20000.0] {
                            let w = (PI * min(damp, 0.49 * rate)) / rate;
                            let k = sin(w) / cos(w);
                            for i in 0..LINE_TIMES.len() {
                                let db = (60.0 * loop_length(i, factor)) / decay;
                                let (low_db, high_db) = shelves(db, bass, hf_ratio(damp));
                                let low = in_f32(low_shelf(xover, low_db));
                                let high = in_f32(damping(k, high_db));
                                let gain = gain_of(-db) as f32 as f64;
                                let [_, _, _, a1, a2] = low;
                                assert!(
                                    1.0 + a1 + a2 > 0.0 && 1.0 - a1 + a2 > 0.0 && a2.abs() < 1.0,
                                    "{rate} Hz, size {size}, decay {decay}, bass {bass}, line {i}: \
                                     a low shelf of {low_db} dB, a1 {a1}, a2 {a2}"
                                );
                                for frequency in
                                    [0.0, 20.0, 100.0, 300.0, 1000.0, 5000.0, 15000.0, rate / 2.0]
                                {
                                    let w = (2.0 * PI * min(frequency, rate / 2.0)) / rate;
                                    let pass = gain * gain * power(&low, w) * power(&high, w);
                                    assert!(
                                        pass < 1.0,
                                        "{rate} Hz, size {size}, decay {decay}, bass {bass}, damp {damp}, \
                                         line {i}: {pass} at {frequency} Hz"
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // The hall at the ends of its knobs drains as any other: after a burst its tail is never louder than it was
    // right after it, and the reverb is idle within a second and a half of the burst
    #[test]
    fn the_hall_drains_at_the_ends_of_its_knobs() {
        let mut seed = 3u32;
        let mut noise = move || {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            ((seed >> 8) as f64 / (1 << 24) as f64 - 0.5) as f32
        };
        for rate in [44100.0, 48000.0, 96000.0] {
            for bass in [0.25, 3.5, 4.0] {
                let params = [
                    20.0,
                    0.0,
                    1.0,
                    0.1,
                    6000.0,
                    bass,
                    0.2,
                    1.0,
                    0.5,
                    0.0,
                    rate / 2.0,
                    0.0,
                ];
                let mut reverb = Reverb::new(rate, &params);
                let burst = (0.05 * rate) as usize;
                let (mut out_l, mut out_r) = (vec![0.0; BLOCK], vec![0.0; BLOCK]);
                let mut early = 0.0f32;
                let mut idle_at = None;
                let mut frame = 0;
                while frame < (3.0 * rate) as usize {
                    let input: Vec<f32> = (frame..frame + BLOCK)
                        .map(|n| if n < burst { noise() } else { 0.0 })
                        .collect();
                    reverb.process(&input, &input, &mut out_l, &mut out_r);
                    let peak = out_l
                        .iter()
                        .chain(&out_r)
                        .fold(0.0f32, |peak, x| peak.max(x.abs()));
                    assert!(peak.is_finite(), "{rate} Hz, bass {bass}: at {frame}");
                    frame += BLOCK;
                    if frame < burst + (0.1 * rate) as usize {
                        early = early.max(peak);
                    } else {
                        assert!(
                            peak <= early,
                            "{rate} Hz, bass {bass}: {peak} at {frame} over {early}"
                        );
                    }
                    if reverb.idle() && idle_at.is_none() {
                        idle_at = Some(frame as f64 / rate);
                    }
                }
                let idle_at = idle_at.unwrap_or(f64::INFINITY);
                assert!(
                    idle_at < 1.5 && reverb.idle(),
                    "{rate} Hz, bass {bass}: idle at {idle_at} s"
                );
            }
        }
    }
}
