//! The effects of the chain by kind: one type over the crates of the effects, their params by index in the order
//! of each crate. A new effect is a variant here

use alloc::boxed::Box;

use crate::delay::Delay;
use crate::eq::Eq;
use chorus::Chorus;
use compressor::Compressor;
use distortion::Distortion;
use dsp_core::stereo::CHAIN_LATENCY;
use limiter::Limiter;
use reverb::Reverb;

/// the kinds, the effects in the order of FX_TYPES of the preset schema, then the limiter
pub const DISTORTION: u32 = 0;
pub const CHORUS: u32 = 1;
pub const DELAY: u32 = 2;
pub const COMPRESSOR: u32 = 3;
pub const REVERB: u32 = 4;
pub const EQ: u32 = 5;
pub const LIMITER: u32 = 6;

/// what the routes move in a block, as offsets from the knobs (seconds, gains, Hz), a value a sample: the lines of
/// `modulation`. Of the delay `time` on both lines, `fb` on the gains of the mode, `pan` on the offset of each
/// channel, the filter once a block; of the EQ (`eq::Eq`) the frequency (in octaves), the resonance and the gain
/// of each band
#[derive(Default, Clone, Copy)]
pub struct Moves<'a> {
    pub time: Option<&'a [f64]>,
    pub fb: Option<&'a [f64]>,
    pub pan: [Option<&'a [f64]>; 2],
    pub freq: f64,
    pub q: f64,
    pub eq: [Option<&'a [f64]>; 6],
}

/// the slots of the chain: one of each effect, a slot by its kind
pub const SLOTS: usize = 6;

/// how a slot mixes its effect in: the dry and the wet gain by equal power (the wet signal unrelated to the dry
/// one: echoes, a reverb), linear (in time with it: the distortion, the EQ), or the effect mixes inside (the param
/// of its mix: the slot passes it alone)
#[derive(Clone, Copy, PartialEq)]
pub enum Law {
    EqualPower,
    Linear,
    Inside(usize),
}

pub fn law(kind: u32) -> Law {
    match kind {
        DISTORTION | EQ => Law::Linear,
        CHORUS => Law::Inside(chorus::MIX),
        COMPRESSOR => Law::Inside(compressor::MIX),
        _ => Law::EqualPower,
    }
}

/// the most params a kind has (the compressor: 14)
pub const MAX_PARAMS: usize = 16;
/// the most values a meter gives
pub const MAX_METER: usize = 8;

/// the params of a kind by the names the app has them under (CHAIN_KEYS of chain-params.ts), each at its key in
/// its crate, and how many there are: a spec holds the app to them (a param without a name is "")
#[cfg(feature = "perf")]
pub fn key_names(kind: u32) -> ([&'static str; MAX_PARAMS], usize) {
    let mut names = [""; MAX_PARAMS];
    let mut name = |key: usize, text: &'static str| names[key] = text;
    let count = match kind {
        DISTORTION => {
            name(distortion::MODE, "mode");
            name(distortion::DRIVE, "drive");
            name(distortion::TONE, "tone");
            name(distortion::LEVEL, "level");
            distortion::PARAMS
        }
        CHORUS => {
            name(chorus::RATE, "rate");
            name(chorus::D1, "d1");
            name(chorus::D2, "d2");
            name(chorus::DEPTH, "depth");
            name(chorus::FB, "fb");
            name(chorus::CUT, "cut");
            name(chorus::HPF, "hpf");
            name(chorus::LEVEL, "level");
            name(chorus::MIX, "mix");
            chorus::PARAMS
        }
        DELAY => {
            name(crate::delay::TIME, "time");
            name(crate::delay::FB, "fb");
            name(crate::delay::MODE, "mode");
            name(crate::delay::PAN, "pan");
            name(crate::delay::FREQ, "freq");
            name(crate::delay::Q, "q");
            crate::delay::PARAMS
        }
        COMPRESSOR => {
            name(compressor::MULTI, "multi");
            name(compressor::THRESH, "thresh");
            name(compressor::RATIO, "ratio");
            name(compressor::ATTACK, "attack");
            name(compressor::RELEASE, "release");
            name(compressor::GAIN, "gain");
            name(compressor::XLOW, "xlow");
            name(compressor::XHIGH, "xhigh");
            name(compressor::BELOW, "below");
            name(compressor::LOW, "low");
            name(compressor::MID, "mid");
            name(compressor::HIGH, "high");
            name(compressor::LEVEL, "level");
            name(compressor::MIX, "mix");
            compressor::PARAMS
        }
        REVERB => {
            name(reverb::LOWCUT, "lowcut");
            name(reverb::PRE, "pre");
            name(reverb::SIZE, "size");
            name(reverb::DECAY, "decay");
            name(reverb::DAMP, "damp");
            name(reverb::BASS, "bass");
            name(reverb::DEPTH, "depth");
            name(reverb::SEP, "sep");
            name(reverb::ER, "er");
            name(reverb::DRIVE, "drive");
            name(reverb::BANDWIDTH, "bandwidth");
            name(reverb::BODY, "body");
            reverb::PARAMS
        }
        EQ => {
            name(crate::eq::T1, "t1");
            name(crate::eq::F1, "f1");
            name(crate::eq::Q1, "q1");
            name(crate::eq::G1, "g1");
            name(crate::eq::T2, "t2");
            name(crate::eq::F2, "f2");
            name(crate::eq::Q2, "q2");
            name(crate::eq::G2, "g2");
            name(crate::eq::LEVEL, "level");
            crate::eq::PARAMS
        }
        _ => 0,
    };
    (names, count)
}

pub enum Unit {
    Distortion(Box<Distortion>),
    Chorus(Box<Chorus>),
    Delay(Box<Delay>),
    Compressor(Box<Compressor>),
    Reverb(Box<Reverb>),
    Eq(Box<Eq>),
    Limiter(Box<Limiter>),
}

fn head<const N: usize>(params: &[f64; MAX_PARAMS]) -> [f64; N] {
    core::array::from_fn(|key| params[key])
}

impl Unit {
    /// an effect of `kind` at `sample_rate`, its params in the order of its crate. None for a kind no one knows
    pub fn new(kind: u32, sample_rate: f64, params: &[f64; MAX_PARAMS]) -> Option<Unit> {
        Some(match kind {
            DISTORTION => Unit::Distortion(Box::new(Distortion::new(sample_rate, &head(params)))),
            CHORUS => Unit::Chorus(Box::new(Chorus::new(sample_rate, &head(params)))),
            DELAY => Unit::Delay(Box::new(Delay::new(sample_rate, &head(params)))),
            COMPRESSOR => Unit::Compressor(Box::new(Compressor::new(sample_rate, &head(params)))),
            REVERB => Unit::Reverb(Box::new(Reverb::new(sample_rate, &head(params)))),
            EQ => Unit::Eq(Box::new(Eq::new(sample_rate, &head(params)))),
            LIMITER => Unit::Limiter(Box::new(Limiter::new(sample_rate))),
            _ => return None,
        })
    }

    /// the params of the bits of `present` (1 << key); `routed`: a route moves them (the reverb glides its room
    /// faster then)
    pub fn set(&mut self, present: u32, values: &[f64; MAX_PARAMS], routed: bool) {
        match self {
            Unit::Distortion(unit) => unit.set(present, &head(values)),
            Unit::Chorus(unit) => unit.set(present, &head(values)),
            Unit::Delay(unit) => unit.set(present, &head(values)),
            Unit::Compressor(unit) => unit.set(present, &head(values)),
            Unit::Reverb(unit) => {
                let mut changes = [(0usize, 0.0f64); reverb::PARAMS];
                let mut count = 0;
                for key in 0..reverb::PARAMS {
                    if present & (1 << key) != 0 {
                        changes[count] = (key, values[key]);
                        count += 1;
                    }
                }
                unit.set(&changes[..count], routed);
            }
            Unit::Eq(unit) => unit.set(present, &head(values)),
            Unit::Limiter(_) => {}
        }
    }

    /// the buffers of blocks of `frames` (allocates: not while a block renders)
    pub fn grow(&mut self, frames: usize) {
        match self {
            Unit::Distortion(unit) => unit.grow(frames),
            Unit::Compressor(unit) => unit.grow(frames),
            _ => {}
        }
    }

    /// a block of silence while idle, nothing rendered: what such a block leaves behind (the LFO of the chorus
    /// goes on, the meter of the compressor is at rest)
    pub fn rest(&mut self, frames: usize) {
        match self {
            Unit::Chorus(unit) => unit.rest(frames),
            Unit::Compressor(unit) => unit.rest(),
            _ => {}
        }
    }

    /// a block of the delay or the EQ with what the routes move in it
    #[inline]
    pub fn process_moved(
        &mut self,
        in_l: &[f32],
        in_r: &[f32],
        out_l: &mut [f32],
        out_r: &mut [f32],
        moves: &Moves,
    ) {
        match self {
            Unit::Delay(unit) => unit.process(in_l, in_r, out_l, out_r, moves),
            Unit::Eq(unit) => unit.process(in_l, in_r, out_l, out_r, moves),
            _ => self.process(in_l, in_r, out_l, out_r),
        }
    }

    #[inline]
    pub fn process(&mut self, in_l: &[f32], in_r: &[f32], out_l: &mut [f32], out_r: &mut [f32]) {
        match self {
            Unit::Distortion(unit) => unit.process(in_l, in_r, out_l, out_r),
            Unit::Chorus(unit) => unit.process(in_l, in_r, out_l, out_r),
            Unit::Delay(unit) => unit.process(in_l, in_r, out_l, out_r, &Moves::default()),
            Unit::Compressor(unit) => unit.process(in_l, in_r, out_l, out_r),
            Unit::Reverb(unit) => unit.process(in_l, in_r, out_l, out_r),
            Unit::Eq(unit) => unit.process(in_l, in_r, out_l, out_r, &Moves::default()),
            Unit::Limiter(unit) => unit.process(in_l, in_r, out_l, out_r),
        }
    }

    /// the sound before is forgotten: the next one starts at the params as they are then
    pub fn forget(&mut self) {
        match self {
            Unit::Distortion(unit) => unit.forget(),
            Unit::Chorus(unit) => unit.forget(),
            Unit::Delay(unit) => unit.forget(),
            Unit::Compressor(unit) => unit.forget(),
            Unit::Reverb(unit) => unit.forget(),
            Unit::Eq(unit) => unit.forget(),
            Unit::Limiter(unit) => unit.forget(),
        }
    }

    /// nothing to play: a block of silence would be silence and change nothing
    pub fn idle(&self) -> bool {
        match self {
            Unit::Distortion(unit) => unit.idle(),
            Unit::Chorus(unit) => unit.idle(),
            Unit::Delay(unit) => unit.idle(),
            Unit::Compressor(unit) => unit.idle(),
            Unit::Reverb(unit) => unit.idle(),
            Unit::Eq(unit) => unit.idle(),
            Unit::Limiter(unit) => unit.idle(),
        }
    }

    /// the samples the wet signal comes late by
    pub fn latency(&self) -> usize {
        match self {
            Unit::Distortion(_) => CHAIN_LATENCY,
            Unit::Limiter(unit) => unit.latency,
            _ => 0,
        }
    }

    /// what a screen draws, into `values`: how many there are (0: the kind has no meter). The chorus: its LFO
    /// (cycles), the rate, the delays, the depth and the cutoff as they are; the compressor: the gains of the
    /// three bands (dB), the peak of the input
    pub fn meter(&self, values: &mut [f64; MAX_METER]) -> usize {
        match self {
            Unit::Chorus(unit) => {
                let meter = unit.meter();
                values[..6].copy_from_slice(&[
                    meter.phase,
                    meter.rate,
                    meter.d1,
                    meter.d2,
                    meter.depth,
                    meter.cut,
                ]);
                6
            }
            Unit::Compressor(unit) => {
                let meter = unit.meter();
                values[..4].copy_from_slice(&[
                    meter.gains[0] as f64,
                    meter.gains[1] as f64,
                    meter.gains[2] as f64,
                    meter.input as f64,
                ]);
                4
            }
            _ => 0,
        }
    }

    /// a value that is not finite reaches no effect (one would stay in its state); the limiter takes them itself
    pub fn guards_input(&self) -> bool {
        !matches!(self, Unit::Limiter(_))
    }
}
