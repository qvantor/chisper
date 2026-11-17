//! The effects of the chain by kind: one type over the crates of the effects, their params by index in the order
//! of each crate. A new effect is a variant here

use alloc::boxed::Box;

use crate::delay::{Delay, Moves};
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
pub const LIMITER: u32 = 5;

/// the slots of the chain: one of each effect, a slot by its kind
pub const SLOTS: usize = 5;

/// how a slot mixes its effect in: the dry and the wet gain by equal power (the wet signal unrelated to the dry
/// one: echoes, a reverb), linear (in time with it: the distortion), or the effect mixes inside (the param of
/// its mix: the slot passes it alone)
#[derive(Clone, Copy, PartialEq)]
pub enum Law {
    EqualPower,
    Linear,
    Inside(usize),
}

pub fn law(kind: u32) -> Law {
    match kind {
        DISTORTION => Law::Linear,
        CHORUS => Law::Inside(chorus::MIX),
        COMPRESSOR => Law::Inside(compressor::MIX),
        _ => Law::EqualPower,
    }
}

/// the most params a kind has (the compressor: 14)
pub const MAX_PARAMS: usize = 16;
/// the most values a meter gives
pub const MAX_METER: usize = 8;

pub enum Unit {
    Distortion(Box<Distortion>),
    Chorus(Box<Chorus>),
    Delay(Box<Delay>),
    Compressor(Box<Compressor>),
    Reverb(Box<Reverb>),
    Limiter(Box<Limiter>),
}

fn head<const N: usize>(params: &[f64; MAX_PARAMS]) -> [f64; N] {
    core::array::from_fn(|key| params[key])
}

impl Unit {
    /// an effect of `kind` at `sample_rate`, its params in the order of its crate; `active` is of the reverb (an
    /// inactive one fades out). None for a kind no one knows
    pub fn new(kind: u32, sample_rate: f64, params: &[f64; MAX_PARAMS], active: bool) -> Option<Unit> {
        Some(match kind {
            DISTORTION => Unit::Distortion(Box::new(Distortion::new(sample_rate, &head(params)))),
            CHORUS => Unit::Chorus(Box::new(Chorus::new(sample_rate, &head(params)))),
            DELAY => Unit::Delay(Box::new(Delay::new(sample_rate, &head(params)))),
            COMPRESSOR => Unit::Compressor(Box::new(Compressor::new(sample_rate, &head(params)))),
            REVERB => Unit::Reverb(Box::new(Reverb::new(sample_rate, &head(params), active))),
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
            Unit::Limiter(_) => {}
        }
    }

    pub fn set_active(&mut self, active: bool) {
        if let Unit::Reverb(unit) = self {
            unit.set_active(active);
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

    /// a block of the delay with what the routes move in it
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
