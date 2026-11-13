//! The chorus, as measured on the Audio Unit (dsp/measurements/chorus.json, the specs hold it to them). Four taps,
//! two of each channel: a tap is a delay line of its own, fed by its channel and by its own output × the feedback,
//! read at `LATENCY` + its delay knob (Delay 2 the first tap of a channel, Delay 1 the second) + the travel of the
//! depth × a triangle LFO (the taps of a channel half a cycle apart, the right channel a quarter ahead of the
//! left), the delay following its target through one pole of 20 ms (so the triangle is rounded, and a knob
//! glides). The taps of a channel × 0.5 each go through a state variable filter of two passes a sample (low or
//! high pass, its resonance fixed), outside the feedback; the mix is inside (wet sin²(π mix / 2), dry 1 - wet²),
//! then the level (× 4 knob²).
//!
//! The lines are `Rows` of f32: four samples of time of a tap in the lanes of a read (so a group of four samples
//! is four reads and four writes), while every delay stays over the five samples a group needs written before it;
//! else (a low rate) sample by sample, the same bits. The delays are doubles, a line between the points of the
//! LFO every SEGMENT samples (the pole steps there, towards the triangle at the middle of the segment); a read
//! is of a four of the segment (`Rows::read4_line`: the place of its first sample in doubles, the others by the
//! slope of the line), a sample alone its lane of that four: how a block is cut never changes a sample. The filter is doubles (its
//! integrators at a low cutoff). A short delay with a feedback is a flanger: the same lines.
//!
//! The C ABI of a stereo core and fx_set, fx_clear, fx_idle, fx_meter (what a screen draws its taps of); the
//! params of fx_new and fx_set come through fx_command (chorus-wasm.ts)

#![cfg_attr(target_arch = "wasm32", no_std)]

extern crate alloc;

use alloc::boxed::Box;
use wasm_rt as _;

use dsp_core::blocks::{louder, loudest, Rows, Smoothed};
use dsp_core::io::StereoIo;
use dsp_core::simd::{F32x4, F64x2};
use jsmath::{exp, floor, max, min, pow, sin, PI};

// the params, in the order of CHORUS_KEYS of chorus-wasm.ts
pub const RATE: usize = 0;
pub const D1: usize = 1;
pub const D2: usize = 2;
pub const DEPTH: usize = 3;
pub const FB: usize = 4;
pub const CUT: usize = 5;
pub const HPF: usize = 6;
pub const LEVEL: usize = 7;
pub const MIX: usize = 8;
pub const PARAMS: usize = 9;

const GLIDE: f64 = 0.01;
const SILENCE: f32 = 1e-10;
/// the samples between two points of the LFO
pub const SEGMENT: usize = 32;
/// what a tap is late by with its knob at 0, seconds (5.25 samples at 44.1 kHz)
pub const LATENCY: f64 = 5.25 / 44100.0;
/// the knobs at their tops: the delays (ms), the depth, the seconds its top moves a tap by
pub const MAX_DELAY: f64 = 20.0;
pub const MAX_DEPTH: f64 = 26.0;
pub const TRAVEL: f64 = 0.0625;
/// the pole a delay follows its target through, seconds
pub const FOLLOW: f64 = 0.02;
pub const MAX_RATE: f64 = 20.0;
pub const MAX_FEEDBACK: f64 = 0.95;
// the filter: its damping (a resonance of √2), the top of its coefficient (stable under it)
const DAMPING: f64 = core::f64::consts::FRAC_1_SQRT_2;
const MAX_COEFFICIENT: f64 = 1.35;
// a group of four samples reads what was written before it: every delay over this many samples
const GROUP_DELAY: f64 = 5.0;
// the LFO of each tap, cycles ahead of the first: L first, L second, R first, R second
const PHASES: [f64; 4] = [0.0, 0.5, 0.25, 0.75];

// a triangle 0..1 of a phase in cycles, 1 at a whole one
fn triangle(phase: f64) -> f64 {
    let x = phase - floor(phase + 0.5);
    1.0 - 2.0 * x.abs()
}

fn clamp(value: f64, low: f64, high: f64) -> f64 {
    min(max(value, low), high)
}

// a param as it is kept: the mode of the filter is 0 or 1
fn kept(key: usize, value: f64) -> f64 {
    if key != HPF {
        value
    } else if value >= 0.5 {
        1.0
    } else {
        0.0
    }
}

// the gains of a block at its end: the dry signal, the wet one (of two taps), the feedback, the coefficient of
// the filter, the share of its high pass
#[derive(Clone, Copy, Default)]
struct Gains {
    dry: f32,
    wet: f32,
    feedback: f32,
    coefficient: f64,
    high: f64,
}

// The filter: a state variable filter of two passes a sample (low += f band; high = x - low - q band; band += f
// high, twice over the same x), the output of the second pass. Its integrators after both passes and its output
// are sums of the integrators before and of x: one step, each a row of [low, band, x] (three operations from
// the state before to the next, where the passes one after the other are a dozen)
#[derive(Clone, Copy)]
struct Passes {
    low: [F64x2; 3],
    band: [F64x2; 3],
    out: [F64x2; 3],
}

impl Passes {
    // of the coefficient f and the share of the high pass in the output
    #[inline(always)]
    fn new(f: f64, high: f64) -> Passes {
        let q = DAMPING;
        // a pass: low' = low + f band, band' = -f low + (1 - f² - f q) band + f x
        let kept = 1.0 - f * f - f * q;
        let low = [1.0 - f * f, f + f * kept, f * f];
        let band = [-(f + kept * f), kept * kept - f * f, f * kept + f];
        // the high pass of the second pass: x - low'' - q band'
        let highs = [q * f - low[0], -(low[1] + q * kept), 1.0 - low[2] - q * f];
        Passes {
            low: low.map(F64x2::splat),
            band: band.map(F64x2::splat),
            out: core::array::from_fn(|i| F64x2::splat(low[i] + high * (highs[i] - low[i]))),
        }
    }
}

/// What a screen draws the taps of: the LFO (cycles) and the knobs that place them, as the core has them now
/// (`chorusTaps` of chorus-params.ts is `targets` of them), and the cutoff of the filter (the glow of the screen)
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Meter {
    pub phase: f64,
    pub rate: f64,
    pub d1: f64,
    pub d2: f64,
    pub depth: f64,
    pub cut: f64,
}

pub struct Chorus {
    sample_rate: f64,
    values: [Smoothed; PARAMS],
    gains: Gains,
    lines: Rows,
    // the LFO (cycles), the samples of its segment rendered, the delay of each tap (samples) at the start of the
    // segment and its step a sample, whether the segment renders in groups of four
    phase: f64,
    at: usize,
    from: [f64; 4],
    step: [f64; 4],
    grouped: bool,
    // the share of a segment of the pole
    follow: f64,
    // the filter: its low and band integrators (L, R)
    low: F64x2,
    band: F64x2,
    idle: bool,
    // samples of the longest tap
    longest: f64,
    quiet_frames: f64,
    silent_frames: f64,
    #[cfg(test)]
    sample_by_sample: bool,
    pub io: StereoIo,
}

impl Chorus {
    pub fn new(sample_rate: f64, params: &[f64; PARAMS]) -> Chorus {
        let longest = (LATENCY + MAX_DELAY * 0.001 + TRAVEL) * sample_rate;
        let mut chorus = Chorus {
            sample_rate,
            values: core::array::from_fn(|key| Smoothed::new(kept(key, params[key]), GLIDE, sample_rate)),
            gains: Gains::default(),
            lines: Rows::new(longest + 4.0),
            phase: 0.0,
            at: SEGMENT,
            from: [0.0; 4],
            step: [0.0; 4],
            grouped: false,
            follow: 1.0 - exp(-(SEGMENT as f64) / (FOLLOW * sample_rate)),
            low: F64x2::default(),
            band: F64x2::default(),
            idle: true,
            longest,
            quiet_frames: 0.0,
            silent_frames: 0.0,
            #[cfg(test)]
            sample_by_sample: false,
            io: StereoIo::default(),
        };
        chorus.update();
        chorus.from = chorus.targets(0.0);
        chorus
    }

    pub fn idle(&self) -> bool {
        self.idle
    }

    fn value(&self, key: usize) -> f64 {
        self.values[key].value
    }

    pub fn meter(&self) -> Meter {
        Meter {
            phase: self.phase,
            rate: clamp(self.value(RATE), 0.0, MAX_RATE),
            d1: clamp(self.value(D1), 0.0, MAX_DELAY),
            d2: clamp(self.value(D2), 0.0, MAX_DELAY),
            depth: clamp(self.value(DEPTH), 0.0, MAX_DEPTH),
            cut: clamp(self.value(CUT), 20.0, 20000.0),
        }
    }

    /// params by key (the bits of `present`); an idle chorus takes them at once
    pub fn set(&mut self, present: u32, changes: &[f64; PARAMS]) {
        for key in 0..PARAMS {
            if present & (1 << key) != 0 {
                // (the delays and the depth glide through the pole of the taps, the rate is the step of the LFO)
                let instant = self.idle || matches!(key, RATE | D1 | D2 | DEPTH);
                self.values[key].set(kept(key, changes[key]), instant, None);
            }
        }
    }

    // the gains of the params as they are at the end of the block
    fn update(&mut self) {
        let rate = self.sample_rate;
        let mix = clamp(self.value(MIX), 0.0, 1.0);
        let level = 4.0 * self.value(LEVEL) * self.value(LEVEL);
        let share = sin(0.5 * PI * mix);
        let wet = share * share;
        // the cutoff the filter has by its knob, two passes a sample: its coefficient at twice the rate
        let knob = clamp(self.value(CUT), 20.0, 20000.0);
        let cutoff = 50.0 * pow(knob / 50.0, 0.95);
        self.gains = Gains {
            dry: ((1.0 - wet * wet) * level) as f32,
            wet: (0.5 * wet * level) as f32,
            feedback: clamp(self.value(FB), 0.0, MAX_FEEDBACK) as f32,
            coefficient: min(2.0 * sin(PI * cutoff / (2.0 * rate)), MAX_COEFFICIENT),
            high: clamp(self.value(HPF), 0.0, 1.0),
        };
    }

    // where the taps go (samples) with the LFO at `ahead` cycles from now
    fn targets(&self, ahead: f64) -> [f64; 4] {
        let rate = self.sample_rate;
        let travel = clamp(self.value(DEPTH), 0.0, MAX_DEPTH) / MAX_DEPTH * TRAVEL * rate;
        let first = (LATENCY + clamp(self.value(D2), 0.0, MAX_DELAY) * 0.001) * rate;
        let second = (LATENCY + clamp(self.value(D1), 0.0, MAX_DELAY) * 0.001) * rate;
        core::array::from_fn(|tap| {
            let base = if tap % 2 == 0 { first } else { second };
            // (never under the two samples a read needs: a rate under 17 kHz)
            max(base, 2.0) + travel * triangle(self.phase + ahead + PHASES[tap])
        })
    }

    // the next segment: the taps step towards where the LFO has them at its middle, the LFO moves on
    fn segment(&mut self) {
        let cycles = clamp(self.value(RATE), 0.0, MAX_RATE) * SEGMENT as f64 / self.sample_rate;
        let targets = self.targets(0.5 * cycles);
        let mut shortest = f64::INFINITY;
        for tap in 0..4 {
            let from = self.from[tap] + self.step[tap] * SEGMENT as f64;
            let to = from + (targets[tap] - from) * self.follow;
            self.from[tap] = from;
            self.step[tap] = (to - from) / SEGMENT as f64;
            shortest = min(shortest, min(from, to));
        }
        self.phase += cycles;
        self.phase -= floor(self.phase);
        self.at = 0;
        self.grouped = shortest > GROUP_DELAY;
        #[cfg(test)]
        if self.sample_by_sample {
            self.grouped = false;
        }
    }

    /// forgets what it holds (the lines, the filter): the LFO goes on
    pub fn forget(&mut self) {
        if !self.idle {
            self.lines.clear();
        }
        self.low = F64x2::default();
        self.band = F64x2::default();
        self.idle = true;
        self.silent_frames = 0.0;
    }

    // `count` samples (four, or one) from `s` of the block: the lanes are its samples (of one, the first)
    #[inline(always)]
    fn group(
        &mut self,
        input: [&[f32]; 2],
        out_l: &mut [f32],
        out_r: &mut [f32],
        s: usize,
        count: usize,
        from: Gains,
        steps: Gains,
        steady: Option<Passes>,
    ) {
        let four = count == 4;
        let (x_l, x_r) = if four {
            (F32x4::load(&input[0][s..s + 4]), F32x4::load(&input[1][s..s + 4]))
        } else {
            (F32x4::splat(input[0][s]), F32x4::splat(input[1][s]))
        };
        // the place of each sample in the block (the gains): a line from its start
        let block = (s + 1) as f32;
        let places = F32x4::new(block, block + 1.0, block + 2.0, block + 3.0);
        // the delays: a line from the start of the segment, read by fours of the segment (one sample is its lane
        // of its four)
        let lane = self.at % 4;
        let first = (self.at - lane + 1) as f64;
        let taps: [F32x4; 4] = core::array::from_fn(|tap| {
            let (delay, slope) = (self.from[tap] + self.step[tap] * first, self.step[tap] as f32);
            let read = self.lines.read4_line(tap, lane, delay, slope);
            if four {
                read
            } else {
                F32x4::splat(read.lanes()[lane])
            }
        });
        let feedback = F32x4::splat(from.feedback) + F32x4::splat(steps.feedback) * places;
        for tap in 0..4 {
            let fed = if tap < 2 { x_l } else { x_r } + feedback * taps[tap];
            if four {
                self.lines.write4(tap, 0, fed);
            } else {
                self.lines.write1(tap, 0, fed.lanes()[0]);
            }
        }
        self.lines.advance(count);
        self.at += count;

        // the filter, sample by sample (L and R the lanes): its two passes as one step of its integrators
        let (wet_l, wet_r) = ((taps[0] + taps[1]).lanes(), (taps[2] + taps[3]).lanes());
        let mut pass = steady.unwrap_or_else(|| Passes::new(from.coefficient, from.high));
        let (mut low, mut band) = (self.low, self.band);
        let mut filtered = [[0.0f32; 4]; 2];
        for k in 0..count {
            if steady.is_none() {
                let position = (s + 1 + k) as f64;
                pass = Passes::new(
                    from.coefficient + steps.coefficient * position,
                    from.high + steps.high * position,
                );
            }
            let x = F64x2::new(wet_l[k] as f64, wet_r[k] as f64);
            let y = pass.out[0] * low + pass.out[1] * band + pass.out[2] * x;
            let next = pass.low[0] * low + pass.low[1] * band + pass.low[2] * x;
            band = pass.band[0] * low + pass.band[1] * band + pass.band[2] * x;
            low = next;
            filtered[0][k] = y.lo() as f32;
            filtered[1][k] = y.hi() as f32;
        }
        self.low = low;
        self.band = band;

        let dry = F32x4::splat(from.dry) + F32x4::splat(steps.dry) * places;
        let wet = F32x4::splat(from.wet) + F32x4::splat(steps.wet) * places;
        let y_l = dry * x_l + wet * F32x4::load(&filtered[0]);
        let y_r = dry * x_r + wet * F32x4::load(&filtered[1]);
        if four {
            y_l.store(&mut out_l[s..s + 4]);
            y_r.store(&mut out_r[s..s + 4]);
        } else {
            out_l[s] = y_l.lanes()[0];
            out_r[s] = y_r.lanes()[0];
        }
    }

    pub fn process(&mut self, in_l: &[f32], in_r: &[f32], out_l: &mut [f32], out_r: &mut [f32]) {
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
                // the LFO goes on
                self.phase += clamp(self.value(RATE), 0.0, MAX_RATE) * n / self.sample_rate;
                self.phase -= floor(self.phase);
                return;
            }
            self.idle = false;
            for value in self.values.iter_mut() {
                value.snap();
            }
            self.update();
            // the taps where the LFO has them, a segment starting
            self.from = self.targets(0.0);
            self.step = [0.0; 4];
            self.at = SEGMENT;
        }

        let mut moved = false;
        for value in self.values.iter_mut() {
            moved |= value.step(n);
        }
        let from = self.gains;
        if moved {
            self.update();
        }
        let to = self.gains;
        let steps = Gains {
            dry: (to.dry - from.dry) / frames as f32,
            wet: (to.wet - from.wet) / frames as f32,
            feedback: (to.feedback - from.feedback) / frames as f32,
            coefficient: (to.coefficient - from.coefficient) / n,
            high: (to.high - from.high) / n,
        };

        // the filter of the block, if it does not glide
        let steady =
            (steps.coefficient == 0.0 && steps.high == 0.0).then(|| Passes::new(from.coefficient, from.high));
        let input = [in_l, in_r];
        let mut s = 0;
        while s < frames {
            if self.at == SEGMENT {
                self.segment();
            }
            // a four of the segment whole in the block, its taps far enough, is a group; else its samples one by one
            let whole = self.at.is_multiple_of(4) && frames - s >= 4;
            let count = if self.grouped && whole { 4 } else { 1 };
            self.group(input, out_l, out_r, s, count, from, steps, steady);
            s += count;
        }

        // the last line: a block that isn't finite (its input is: process_io; NaN through a path no one saw) would
        // stay in the lines for good: forgotten, the block is silence
        let output = louder(loudest(out_l), loudest(out_r));
        let state = max(
            max(self.low.lo().abs(), self.low.hi().abs()),
            max(self.band.lo().abs(), self.band.hi().abs()),
        );
        if !output.is_finite() || !state.is_finite() {
            self.forget();
            out_l.fill(0.0);
            out_r.fill(0.0);
            return;
        }

        // silent in and out for longer than the longest tap: nothing left in a line to come back
        self.silent_frames = if output < SILENCE {
            self.silent_frames + n
        } else {
            0.0
        };
        let longest = self.longest + n;
        if self.quiet_frames > longest && self.silent_frames > longest {
            self.forget();
        }
    }

    fn process_io(&mut self) {
        let mut io = core::mem::take(&mut self.io);
        // (NaN or an infinity of the graph as 0: one would stay in a line for good)
        io.finite_inputs();
        let (in_l, in_r, out_l, out_r) = io.split();
        self.process(in_l, in_r, out_l, out_r);
        self.io = io;
    }
}

// the params of fx_new and of fx_set in the order of the keys, after the bits of the keys fx_set changes (1 << key),
// written by the JS wrapper
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

/// a chorus at the rate of the context, its params in the command buffer
#[no_mangle]
pub extern "C" fn fx_new(sample_rate: f64) -> *mut Chorus {
    Box::into_raw(Box::new(Chorus::new(sample_rate, &command().1)))
}

/// # Safety
/// `chorus` comes from fx_new and was not freed
#[no_mangle]
pub unsafe extern "C" fn fx_free(chorus: *mut Chorus) {
    drop(Box::from_raw(chorus));
}

/// # Safety
/// `chorus` comes from fx_new and was not freed
#[no_mangle]
pub unsafe extern "C" fn fx_buffers(chorus: *mut Chorus, frames: usize) -> *mut f32 {
    (*chorus).io.reserve(frames)
}

/// # Safety
/// `chorus` comes from fx_new and was not freed, its buffers reserved for the block
#[no_mangle]
pub unsafe extern "C" fn fx_process(chorus: *mut Chorus) {
    (*chorus).process_io();
}

/// the params that changed, in the command buffer
///
/// # Safety
/// `chorus` comes from fx_new and was not freed
#[no_mangle]
pub unsafe extern "C" fn fx_set(chorus: *mut Chorus) {
    let (present, changes) = command();
    (*chorus).set(present, &changes);
}

/// # Safety
/// `chorus` comes from fx_new and was not freed
#[no_mangle]
pub unsafe extern "C" fn fx_clear(chorus: *mut Chorus) {
    (*chorus).forget();
}

/// # Safety
/// `chorus` comes from fx_new and was not freed
#[no_mangle]
pub unsafe extern "C" fn fx_idle(chorus: *mut Chorus) -> bool {
    (*chorus).idle()
}

/// the meter into the command buffer: the LFO (cycles), then the rate, the delays, the depth and the cutoff as
/// they are
///
/// # Safety
/// `chorus` comes from fx_new and was not freed
#[no_mangle]
pub unsafe extern "C" fn fx_meter(chorus: *mut Chorus) {
    let meter = (*chorus).meter();
    let values = [
        meter.phase,
        meter.rate,
        meter.d1,
        meter.d2,
        meter.depth,
        meter.cut,
    ];
    let command = core::ptr::addr_of_mut!(COMMAND) as *mut f64;
    for (k, value) in values.iter().enumerate() {
        *command.add(k) = *value;
    }
}

#[cfg(test)]
mod tests;
