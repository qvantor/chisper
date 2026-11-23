//! The warp of an oscillator (Warp of the Audio Unit, dsp/measurements/warp.json): a map of the phase each sample
//! reads its frame at, by the mode and the knob (0..1). The phase a voice keeps between spans is never warped: the
//! samples of a span are read through it (`warp_phases`: their phases in 0.32 into a buffer, the read loops of
//! voice.rs take them from it). The maps, as the renders give them to 1e-5 of a cycle:
//! - the bends, of d = 2φ - 1: w = 1/2 + (1 + a)/2 · d / ((1 - a) + 2a|d|), a Möbius map of each half (the inverse of
//!   the one of -a): Bend + a = 0.8k (the middle of the frame squeezed, its ends stretched), Bend - a = -0.8k,
//!   Bend +/- a = 0.8(1 - 2k) (as Bend + under 0.5, as Bend - over it, the frame as it is at 0.5)
//! - PWM: w = φ / (1 - k) until it reaches 1, then 0: the frame squeezed to the left, its sample 0 held over the rest
//!   (a cosine's mean is k, as the Audio Unit's: it keeps the offset), at 1 all the cycle: no tone, that sample of the
//!   level read held (silent of a frame that starts at 0)
//!
//! The knob the maps read is the knob with its routes through a one-pole of SMOOTHING (as the Audio Unit follows its
//! knob and its modulation: `smooth`), worked out at the points of a block, a line between them.
//!
//! In lanes of f32: a division a sample (no pow or log), the same operations in the same order in the native variant
//! (`warp_sample` is a lane: the specs and the chart of the app, libs/math/src/oscillator/warp.ts, hold it bit for bit).
//! Over a segment the param of a map is a line between its points (`line_param`): a of a bend (linear in the knob),
//! the edge 1 - k of PWM (its slope 1/(1 - k) is not: a line of it went off the map by -27 dB of the sound at an LFO
//! of 62.5 Hz), each sample φ / its edge

use crate::voice::{level_x, Phases, LEVEL_BAND, SPAN};
use dsp_core::simd::{F32x4, U32x4};
use jsmath::{ceil, exp, floor, log2, max, min};

/// the modes (WARP_MODES of the preset schema: a new one goes last)
pub const OFF: u32 = 0;
pub const BEND_UP: u32 = 1;
pub const BEND_DOWN: u32 = 2;
pub const BEND_BOTH: u32 = 3;
pub const PWM: u32 = 4;

/// the largest slope of PWM (its knob at 1 - 2^-24 and over: every sample reads phase 0)
const PWM_MAX: f64 = 16777216.0;
const HALF: u32 = 0x8000_0000;
// 2^-30: 2a / 2^31 of a bend
const BEND_SCALE: f32 = 1.0 / 1073741824.0;

/// seconds of the one-pole the knob of the warp goes through (its routes too; an LFO on it against the Audio Unit:
/// 11.3 ms, its knob automated: 10.5, dsp/measurements/warp.json)
pub const SMOOTHING: f64 = 0.0113;

/// the knob as the maps take it: within 0..1 (one that isn't a number: 0)
pub fn knob_of(knob: f64) -> f64 {
    if knob > 0.0 {
        min(knob, 1.0)
    } else {
        0.0
    }
}

/// the one-pole of time constant `tau` (samples) after `length` samples of its input moving linearly from x0 to x1,
/// from y (exact: y' = (x - y) / tau over the line); `pole` its exp(-length / tau), None: worked out here
pub fn smooth(y: f64, x0: f64, x1: f64, length: f64, tau: f64, pole: Option<f64>) -> f64 {
    let e = match pole {
        Some(e) => e,
        None => exp(-length / tau),
    };
    let lag = (x1 - x0) / length * tau;
    x1 - lag + (y - x0 + lag) * e
}

/// whether `mode` is a bend (else PWM; Off is no map)
pub fn bends(mode: u32) -> bool {
    matches!(mode, BEND_UP | BEND_DOWN | BEND_BOTH)
}

/// the param of the map of `mode` at the knob: a of a bend (-0.8..0.8), the slope of PWM (1..PWM_MAX), 0 of Off (a
/// knob that isn't a number: 0)
pub fn param(mode: u32, knob: f64) -> f64 {
    let k = knob_of(knob);
    match mode {
        BEND_UP => 0.8 * k,
        BEND_DOWN => -0.8 * k,
        BEND_BOTH => 0.8 * (1.0 - 2.0 * k),
        PWM => {
            if 1.0 - k <= 1.0 / PWM_MAX {
                PWM_MAX
            } else {
                1.0 / (1.0 - k)
            }
        }
        _ => 0.0,
    }
}

/// the param of the map of `mode` at the knob as a segment moves it in a line: a of a bend, the edge of PWM (1 - k,
/// 1/PWM_MAX at least: its slope 1/edge is `param`)
pub fn line_param(mode: u32, knob: f64) -> f64 {
    if mode == PWM {
        let edge = 1.0 - knob_of(knob);
        if edge <= 1.0 / PWM_MAX {
            1.0 / PWM_MAX
        } else {
            edge
        }
    } else {
        param(mode, knob)
    }
}

/// the levels the pitch moves up by at the param of a line (`line_param`): `wrap_levels`
pub fn line_levels(mode: u32, line: f64) -> f64 {
    wrap_levels(mode, if mode == PWM { 1.0 / line } else { line })
}

/// whether the map of `mode` at `param` leaves the phase as it is: the frame read as without a warp (the loops of
/// no warp, the same bits; of PWM its slope or its edge at 1)
pub fn neutral(mode: u32, param: f64) -> bool {
    match mode {
        BEND_UP | BEND_DOWN | BEND_BOTH => param == 0.0,
        PWM => param == 1.0,
        _ => true,
    }
}

/// the levels of a table (3 an octave) the pitch of a voice moves up by under the map: 3·log2 of its slope at the
/// wrap of the frame (φ = 0), where frames mostly change the fastest (a saw jumps there). A bend of a < 0 and PWM
/// squeeze it (their steepest, (1 - a)/(1 + a) and the slope), a bend of a > 0 stretches it: none (its steepest is
/// the middle; read a level up for it a saw at C0 would lose its harmonics over 18, the renders keep them all). A
/// voice reads them so of PWM; of a bend of a < 0 sample by sample (`local`)
pub fn wrap_levels(mode: u32, param: f64) -> f64 {
    let slope = match mode {
        BEND_UP | BEND_DOWN | BEND_BOTH if param < 0.0 => (1.0 - param) / (1.0 + param),
        PWM => param,
        _ => 1.0,
    };
    if slope > 1.0 {
        3.0 * log2(slope)
    } else {
        0.0
    }
}

/// one phase (0.32) through the map: a bend at a (`bend`) or PWM at its slope (as f32: the operations of a lane)
pub fn warp_sample(bend: bool, param: f32, phase: u32) -> u32 {
    if bend {
        let (h, g0, g1) = (1.0 + param, 1.0 - param, param * BEND_SCALE);
        // the phase from 1/2 (d · 2^31), and 2^31 + (1 + a) · it over the denominator
        let d = (phase ^ HALF) as i32 as f32;
        let q = (d * h) / (g0 + g1 * d.abs());
        (q as i32 as u32) ^ HALF
    } else {
        // the phase in 2^-24 of a cycle × the slope, phase 0 from 1 on
        let y = (phase >> 8) as f32 * param;
        if 16777216.0 > y {
            (y as i32 as u32) << 8
        } else {
            0
        }
    }
}

// The levels of a bend of a < 0 sample by sample (the reference, dsp/measurements/warp.json `notes`: the wrap of a
// frame squeezed reads few harmonics, its middle stretched many, a jump there as bright as unwarped): x of the pitch
// plus 3·log2 of the slope of the map at the sample, (1 + a)(1 - a) / den², down by LOCAL_DOWN at most (where it
// stretches the frame) and over a floor that rises to the levels of the wrap as the pitch has few harmonics (from 64
// to 24 at the nyquist: a level a sample of so few harmonics aliased 12 dB over the reference at C7, a level of the
// wrap over the cycle does as it does). Two levels a segment, lo and hi (the least and the most it reads), each sample
// between them at the share its x is at (`local_phases`: into a buffer of shares, the read loops of voice.rs)

// log2(1 + t) over t in [0, 1): a cubic of t (exact at both ends, within 1.1e-3 between)
const LOG2_C1: f32 = 1.420_864_5;
const LOG2_C2: f32 = -0.577_250_66;
const LOG2_C3: f32 = 0.156_386_1;

/// the levels under its pitch a stretched sample reads at most
pub const LOCAL_DOWN: f64 = 3.5;
// log2 of the harmonics of a pitch at the nyquist where the floor of a sample starts to rise (64), and where it is the
// levels of the wrap (24)
const LOCAL_FROM: f64 = 6.0;
const LOCAL_TO: f64 = 4.584962500721156;

/// whether a bend at a (`param`) reads its levels sample by sample
pub fn local(mode: u32, param: f64) -> bool {
    bends(mode) && param < 0.0
}

/// the most levels a bend at a moves the pitch of a sample by (at the wrap, its steepest; the middle, its least,
/// as many down): none at a >= 0
pub fn local_most(a: f64) -> f64 {
    if a < 0.0 {
        3.0 * log2((1.0 - a) / (1.0 + a))
    } else {
        0.0
    }
}

/// the floor of the levels of a sample of a bend whose most is `most` (local_most), a pitch of 2^harmonics harmonics
/// at the nyquist: -LOCAL_DOWN, up to the levels of the wrap as it has fewer
pub fn local_floor(most: f64, harmonics: f64) -> f64 {
    let rise = min(1.0, max(0.0, (LOCAL_FROM - harmonics) / (LOCAL_FROM - LOCAL_TO)));
    -LOCAL_DOWN + rise * (most + LOCAL_DOWN)
}

/// the levels of a segment read sample by sample: the x of its pitch unwarped (a line from x0 by dx a sample), the
/// floor of its levels (a line from f0 by df), the top level that sounds, the two levels read (lo < hi: a sample at
/// the share of hi its x is at)
pub(crate) struct LocalLevels {
    pub x0: f64,
    pub dx: f64,
    pub f0: f64,
    pub df: f64,
    pub top: f64,
    pub lo: f64,
    pub hi: f64,
}

/// a segment of a bend of a < 0 at an end: the most levels the slope of the map moves a sample by at its ends
/// (`local_most` of a there: worked out once a point of the oscillator, not once a voice and segment), the x of its
/// pitch unwarped there, log2 of the harmonics of its pitch at the nyquist there, the top level that sounds, its length
pub(crate) struct LocalLine {
    pub most: (f64, f64),
    pub x: (f64, f64),
    pub harmonics: (f64, f64),
    pub top: f64,
    pub length: f64,
}

/// the levels of a segment (`LocalLine`): the lines of its pitch and of its floor, lo the least x its samples read
/// (the least slope, the floor, the lower pitch), hi the most (the steepest, the higher pitch), under the top (inlined
/// into a segment of the voice read directly: a call of its own there cost a voice moved by an LFO 2 %)
#[inline(always)]
pub(crate) fn local_levels(line: &LocalLine) -> LocalLevels {
    let ((most0, most1), (x0, x1), (h0, h1)) = (line.most, line.x, line.harmonics);
    let (f0, f1) = (local_floor(most0, h0), local_floor(most1, h1));
    let low = max(0.0, min(x0, x1) + max(-max(most0, most1), min(f0, f1)));
    let high = min(line.top, max(x0, x1) + max(most0, most1));
    LocalLevels {
        x0,
        dx: (x1 - x0) / line.length,
        f0,
        df: (f1 - f0) / line.length,
        top: line.top,
        lo: floor(level_x(min(low, line.top))),
        hi: ceil(level_x(max(high, 0.0))),
    }
}

/// warp_phases of a bend of a < 0 (`local`), the share of the level hi of each sample into shares[s0..] (as the
/// phases: whole groups of 4)
#[inline(never)]
#[allow(clippy::too_many_arguments)]
pub(crate) fn local_phases(
    p0: f64,
    dp: f64,
    levels: &LocalLevels,
    ph: f64,
    inc: f64,
    d_inc: f64,
    buf: &mut [u32],
    shares: &mut [f32],
    s0: usize,
    s1: usize,
) -> f64 {
    if s1 > s0 + SPAN {
        let (mid, n) = (s0 + SPAN, SPAN as f64);
        let ph = local_phases(p0, dp, levels, ph, inc, d_inc, buf, shares, s0, mid);
        let rest = LocalLevels {
            x0: levels.x0 + levels.dx * n,
            f0: levels.f0 + levels.df * n,
            ..*levels
        };
        return local_phases(
            p0 + dp * n,
            dp,
            &rest,
            ph,
            inc + d_inc * n,
            d_inc,
            buf,
            shares,
            mid,
            s1,
        );
    }
    let mut phases = Phases::new(ph, inc, d_inc);
    if dp == 0.0 {
        local_pass::<false>(&mut phases, p0, dp, levels, buf, shares, s0, s1);
    } else {
        local_pass::<true>(&mut phases, p0, dp, levels, buf, shares, s0, s1);
    }
    phases.end(inc, d_inc, s1.saturating_sub(s0))
}

// (the phases as bend_pass maps them, the same bits; of a still a its 3·log2((1 + a)(1 - a)) once)
#[inline(always)]
#[allow(clippy::too_many_arguments)]
fn local_pass<const MOVING: bool>(
    phases: &mut Phases,
    p0: f64,
    dp: f64,
    levels: &LocalLevels,
    buf: &mut [u32],
    shares: &mut [f32],
    s0: usize,
    s1: usize,
) {
    let (mut a, step) = param_lanes(p0, dp);
    let (mut x, x_step) = param_lanes(levels.x0, levels.dx);
    let (mut floor, floor_step) = param_lanes(levels.f0, levels.df);
    let (one, zero, scale, half) = (
        F32x4::splat(1.0),
        F32x4::splat(0.0),
        F32x4::splat(BEND_SCALE),
        U32x4::splat(HALF),
    );
    let (three, six) = (F32x4::splat(3.0), F32x4::splat(6.0));
    let share = ShareLanes::new(levels);
    let (mut h, mut g0, mut g1) = (one + a, one - a, a * scale);
    let (mut lead, mut bent) = (three * log2_coarse(h * g0), zero.over(a));
    let mut s = s0;
    while s < s1 {
        let d = phases.group().xor(half).to_f32();
        let den = g0 + g1 * d.abs();
        let q = (d * h) / den;
        q.to_int().xor(half).store(&mut buf[s..s + 4]);
        // the levels of its slope (1 + a)(1 - a) / den² (none at a >= 0), over the floor, under the top
        let up = (lead - six * log2_coarse(den)).or_else(bent, zero);
        share.of(x, up, floor).store(&mut shares[s..s + 4]);
        if MOVING {
            a = a + step;
            (h, g0, g1) = (one + a, one - a, a * scale);
            (lead, bent) = (three * log2_coarse(h * g0), zero.over(a));
        }
        x = x + x_step;
        floor = floor + floor_step;
        phases.next();
        s += 4;
    }
}

// the share of the level hi of a sample from the levels of its slope (`up`), the x of its pitch and its floor: over
// the floor, under the top, the x of its level (level_x: the last LEVEL_BAND of a level a crossfade to the next)
struct ShareLanes {
    top: F32x4,
    band: F32x4,
    band_scale: F32x4,
    lo: F32x4,
    span: F32x4,
}

impl ShareLanes {
    #[inline(always)]
    fn new(levels: &LocalLevels) -> ShareLanes {
        ShareLanes {
            top: F32x4::splat(levels.top as f32),
            band: F32x4::splat((1.0 - LEVEL_BAND) as f32),
            band_scale: F32x4::splat((1.0 / LEVEL_BAND) as f32),
            lo: F32x4::splat(levels.lo as f32),
            span: F32x4::splat((1.0 / (levels.hi - levels.lo)) as f32),
        }
    }

    #[inline(always)]
    fn of(&self, x: F32x4, up: F32x4, floor: F32x4) -> F32x4 {
        let (one, zero) = (F32x4::splat(1.0), F32x4::splat(0.0));
        let level = (x + up.max(floor)).min(self.top).max(zero);
        let whole = level.floor();
        let at = whole + ((level - whole - self.band) * self.band_scale).max(zero).min(one);
        ((at - self.lo) * self.span).max(zero).min(one)
    }
}

/// local_phases of a still a in two: the phases, and the levels of the slope of each sample into ups[s0..] (`up` of
/// local_pass: of a and the phase alone, whatever the pitch of the voice; whole groups of 4), the shares of them by
/// `local_shares` (the cycle of a warped mix: the voices of a unison share the first, voice.rs WarpedCycle)
#[inline(never)]
pub(crate) fn local_ups(
    a: f64,
    ph: f64,
    inc: f64,
    buf: &mut [u32],
    ups: &mut [f32],
    s0: usize,
    s1: usize,
) -> f64 {
    if s1 > s0 + SPAN {
        let mid = s0 + SPAN;
        let ph = local_ups(a, ph, inc, buf, ups, s0, mid);
        return local_ups(a, ph, inc, buf, ups, mid, s1);
    }
    let mut phases = Phases::new(ph, inc, 0.0);
    let (a, _) = param_lanes(a, 0.0);
    let (one, zero, scale, half) = (
        F32x4::splat(1.0),
        F32x4::splat(0.0),
        F32x4::splat(BEND_SCALE),
        U32x4::splat(HALF),
    );
    let (three, six) = (F32x4::splat(3.0), F32x4::splat(6.0));
    let (h, g0, g1) = (one + a, one - a, a * scale);
    let (lead, bent) = (three * log2_coarse(h * g0), zero.over(a));
    let mut s = s0;
    while s < s1 {
        let d = phases.group().xor(half).to_f32();
        let den = g0 + g1 * d.abs();
        let q = (d * h) / den;
        q.to_int().xor(half).store(&mut buf[s..s + 4]);
        (lead - six * log2_coarse(den))
            .or_else(bent, zero)
            .store(&mut ups[s..s + 4]);
        phases.next();
        s += 4;
    }
    phases.end(inc, 0.0, s1.saturating_sub(s0))
}

/// the shares local_phases gives the samples s0..s1 of a still a whose `up` are ups[s0..] (local_ups), into
/// shares[s0..] (whole groups of 4; the pitch and the floor as its lanes step them)
#[inline(never)]
pub(crate) fn local_shares(levels: &LocalLevels, ups: &[f32], shares: &mut [f32], s0: usize, s1: usize) {
    if s1 > s0 + SPAN {
        let (mid, n) = (s0 + SPAN, SPAN as f64);
        local_shares(levels, ups, shares, s0, mid);
        let rest = LocalLevels {
            x0: levels.x0 + levels.dx * n,
            f0: levels.f0 + levels.df * n,
            ..*levels
        };
        return local_shares(&rest, ups, shares, mid, s1);
    }
    let (mut x, x_step) = param_lanes(levels.x0, levels.dx);
    let (mut floor, floor_step) = param_lanes(levels.f0, levels.df);
    let share = ShareLanes::new(levels);
    let mut s = s0;
    while s < s1 {
        let up = F32x4::load(&ups[s..s + 4]);
        share.of(x, up, floor).store(&mut shares[s..s + 4]);
        x = x + x_step;
        floor = floor + floor_step;
        s += 4;
    }
}

// log2 of lanes over 0 within 1.1e-3 (a level of a sample within 1e-2 of its slope's): the exponent of their bits and
// a cubic of the mantissa, no division
#[inline(always)]
fn log2_coarse(x: F32x4) -> F32x4 {
    let bits = x.bits();
    let exponent = bits.shifted(23).to_f32() - F32x4::splat(127.0);
    let mantissa = F32x4::from_bits(bits.and(U32x4::splat(0x007f_ffff)).or(U32x4::splat(0x3f80_0000)));
    let t = mantissa - F32x4::splat(1.0);
    exponent + t * (F32x4::splat(LOG2_C1) + t * (F32x4::splat(LOG2_C2) + t * F32x4::splat(LOG2_C3)))
}

/// the phases of the samples s0..s1 of a voice (its phase ph, its step inc moving by d_inc a sample, as the read loops
/// step them) through the map of a bend (`bend`) or PWM, the param of its line (`line_param`) from p0 moving by dp a
/// sample, into buf[s0..] (whole groups of 4: up to 3 past s1); the phase after them, as a read loop returns it (not
/// inlined: once a span of a warped voice, out of render_voices)
#[inline(never)]
pub(crate) fn warp_phases(
    bend: bool,
    p0: f64,
    dp: f64,
    ph: f64,
    inc: f64,
    d_inc: f64,
    buf: &mut [u32],
    s0: usize,
    s1: usize,
) -> f64 {
    if s1 > s0 + SPAN {
        let (mid, n) = (s0 + SPAN, SPAN as f64);
        let ph = warp_phases(bend, p0, dp, ph, inc, d_inc, buf, s0, mid);
        return warp_phases(bend, p0 + dp * n, dp, ph, inc + d_inc * n, d_inc, buf, mid, s1);
    }
    let mut phases = Phases::new(ph, inc, d_inc);
    match (bend, dp == 0.0) {
        (true, true) => bend_pass::<false>(&mut phases, p0, dp, buf, s0, s1),
        (true, false) => bend_pass::<true>(&mut phases, p0, dp, buf, s0, s1),
        // (a still edge: its slope, the bits of warp_sample)
        (false, true) => pwm_pass(&mut phases, 1.0 / p0, buf, s0, s1),
        (false, false) => pwm_line_pass(&mut phases, p0, dp, buf, s0, s1),
    }
    phases.end(inc, d_inc, s1.saturating_sub(s0))
}

// the param at the four samples of a group and its step to the next group
#[inline(always)]
fn param_lanes(p0: f64, dp: f64) -> (F32x4, F32x4) {
    (
        F32x4::new(
            p0 as f32,
            (p0 + dp) as f32,
            (p0 + 2.0 * dp) as f32,
            (p0 + 3.0 * dp) as f32,
        ),
        F32x4::splat((4.0 * dp) as f32),
    )
}

// the phases of a group through a bend: h = 1 + a, g0 = 1 - a, g1 = a · BEND_SCALE, `half` HALF in its lanes (the
// passes and the loop of a table under a still map, voice.rs render11_mapped: the same operations)
#[inline(always)]
pub(crate) fn bend_lanes(phases: U32x4, h: F32x4, g0: F32x4, g1: F32x4, half: U32x4) -> U32x4 {
    let d = phases.xor(half).to_f32();
    let q = (d * h) / (g0 + g1 * d.abs());
    q.to_int().xor(half)
}

// the phases of a group through PWM at its slope, `top` 2^24 in its lanes
#[inline(always)]
pub(crate) fn pwm_lanes(phases: U32x4, slope: F32x4, top: F32x4) -> U32x4 {
    let y = phases.shifted(8).to_f32() * slope;
    y.to_int().shifted_left(8).and(top.over(y))
}

// what bend_lanes and pwm_lanes take of a still param (a of a bend, the slope of PWM): h, g0, g1 and HALF, or the
// slope and 2^24
#[inline(always)]
pub(crate) fn bend_consts(a: f64) -> (F32x4, F32x4, F32x4, U32x4) {
    let (a, one) = (F32x4::splat(a as f32), F32x4::splat(1.0));
    (one + a, one - a, a * F32x4::splat(BEND_SCALE), U32x4::splat(HALF))
}

#[inline(always)]
pub(crate) fn pwm_consts(slope: f64) -> (F32x4, F32x4) {
    (F32x4::splat(slope as f32), F32x4::splat(16777216.0))
}

// (loops of their own, not inlined: called once a span of a warped voice)
#[inline(never)]
fn bend_pass<const MOVING: bool>(
    phases: &mut Phases,
    p0: f64,
    dp: f64,
    buf: &mut [u32],
    s0: usize,
    s1: usize,
) {
    let (mut a, step) = param_lanes(p0, dp);
    let (one, scale, half) = (F32x4::splat(1.0), F32x4::splat(BEND_SCALE), U32x4::splat(HALF));
    let (mut h, mut g0, mut g1) = (one + a, one - a, a * scale);
    let mut s = s0;
    while s < s1 {
        bend_lanes(phases.group(), h, g0, g1, half).store(&mut buf[s..s + 4]);
        if MOVING {
            a = a + step;
            (h, g0, g1) = (one + a, one - a, a * scale);
        }
        phases.next();
        s += 4;
    }
}

#[inline(never)]
fn pwm_pass(phases: &mut Phases, slope: f64, buf: &mut [u32], s0: usize, s1: usize) {
    let (slope, top) = (F32x4::splat(slope as f32), F32x4::splat(16777216.0));
    let mut s = s0;
    while s < s1 {
        pwm_lanes(phases.group(), slope, top).store(&mut buf[s..s + 4]);
        phases.next();
        s += 4;
    }
}

// PWM whose edge moves: its edge a line from e0 by de a sample (lanes of f32 added up: never under 1/PWM_MAX), each
// phase over it (a division a group)
#[inline(never)]
fn pwm_line_pass(phases: &mut Phases, e0: f64, de: f64, buf: &mut [u32], s0: usize, s1: usize) {
    let (mut edge, step) = param_lanes(e0, de);
    let (least, top) = (F32x4::splat((1.0 / PWM_MAX) as f32), F32x4::splat(16777216.0));
    let mut s = s0;
    while s < s1 {
        let y = phases.group().shifted(8).to_f32() / edge.max(least);
        y.to_int()
            .shifted_left(8)
            .and(top.over(y))
            .store(&mut buf[s..s + 4]);
        edge = edge + step;
        phases.next();
        s += 4;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MODES: [u32; 4] = [BEND_UP, BEND_DOWN, BEND_BOTH, PWM];
    const CYCLE: f64 = 4294967296.0;

    // the map of the renders in doubles (dsp/measurements/warp.json)
    fn measured(mode: u32, k: f64, phi: f64) -> f64 {
        if mode == PWM {
            return if phi < 1.0 - k { phi / (1.0 - k) } else { 0.0 };
        }
        let a = param(mode, k);
        let d = 2.0 * phi - 1.0;
        0.5 + 0.5 * (1.0 + a) * d / ((1.0 - a) + 2.0 * a * d.abs())
    }

    #[test]
    fn a_lane_is_the_map_of_the_renders() {
        for mode in MODES {
            for k in [0.0, 0.1, 0.35, 0.5, 0.8, 0.95] {
                let p = param(mode, k) as f32;
                for j in 0..4096u32 {
                    let phase = j.wrapping_mul(1048573).wrapping_add(12345);
                    let phi = phase as f64 / CYCLE;
                    let w = warp_sample(bends(mode), p, phase) as f64 / CYCLE;
                    let expected = measured(mode, k, phi);
                    // (PWM at its edge: a sample either side; the wrap of a bend: either end of the cycle)
                    let error = min((w - expected).abs(), 1.0 - (w - expected).abs());
                    let edge = mode == PWM && (phi - (1.0 - k)).abs() < 1e-6;
                    assert!(
                        edge || error < 2e-6,
                        "mode {mode} knob {k} φ {phi}: {w}, not {expected}"
                    );
                }
            }
        }
    }

    #[test]
    fn the_map_moves_with_the_knob_without_a_step() {
        // a knob a little further moves every phase as the map of the renders moves it (continuous in the knob: no
        // step of the lanes of their own)
        for mode in MODES {
            for i in 0..100 {
                let (k, next) = (i as f64 / 100.0, (i as f64 + 0.01) / 100.0);
                let (p, q) = (param(mode, k) as f32, param(mode, next) as f32);
                for j in 0..512u32 {
                    let phase = j << 23 | 0x5555;
                    let (a, b) = (
                        warp_sample(bends(mode), p, phase),
                        warp_sample(bends(mode), q, phase),
                    );
                    let moved = (b.wrapping_sub(a) as i32) as f64 / CYCLE;
                    let phi = phase as f64 / CYCLE;
                    let exact = measured(mode, next, phi) - measured(mode, k, phi);
                    // (PWM: a phase that crosses its edge goes to 0)
                    let crossed = mode == PWM && (a == 0) != (b == 0);
                    assert!(
                        crossed || (moved - exact).abs() < 4e-6,
                        "mode {mode} knob {k} φ {phi}: {moved}"
                    );
                }
            }
        }
    }

    #[test]
    fn the_smoothing_is_the_one_pole_of_a_line() {
        // against the one-pole stepped in a million little steps over a line of its input, and over a block cut in
        // segments of other lengths (the same, a pole worked out or given)
        let tau = SMOOTHING * 48000.0;
        for (y, x0, x1, length) in [
            (0.2, 0.8, 0.8, 32.0),
            (0.0, 0.1, 0.9, 32.0),
            (0.7, 0.3, 0.2, 17.0),
        ] {
            let mut fine = y;
            let steps = 1_000_000;
            let dt = length / steps as f64;
            for i in 0..steps {
                let x = x0 + (x1 - x0) * (i as f64 + 0.5) / steps as f64;
                fine += (x - fine) * (1.0 - exp(-dt / tau));
            }
            let exact = smooth(y, x0, x1, length, tau, None);
            assert!((exact - fine).abs() < 1e-9, "{exact} {fine}");
            assert_eq!(smooth(y, x0, x1, length, tau, Some(exp(-length / tau))), exact);
        }
        // a still input: toward it by exp(-length / tau), there at once when it is there
        assert_eq!(smooth(0.5, 0.5, 0.5, 32.0, tau, None), 0.5);
        let step = smooth(0.0, 1.0, 1.0, tau, tau, None);
        assert!((step - (1.0 - exp(-1.0))).abs() < 1e-15);
    }

    #[test]
    fn the_knob_is_taken_within_its_range() {
        for knob in [
            -0.5,
            0.0,
            0.3,
            1.0,
            1.7,
            f64::NAN,
            f64::INFINITY,
            f64::NEG_INFINITY,
        ] {
            for mode in MODES {
                assert_eq!(param(mode, knob_of(knob)), param(mode, knob), "{mode} {knob}");
            }
        }
    }

    #[test]
    fn a_moving_edge_of_pwm_is_the_map_at_the_knob_of_each_sample() {
        // the knob a line over a segment (an LFO of 100 Hz moves it by 0.4 over 120 samples): each sample the map of
        // the renders at the knob there, within the f32 of a lane (a phase at its edge either way)
        for (k0, k1) in [(0.1, 0.5), (0.9, 0.3), (0.95, 1.0), (0.0, 0.999)] {
            let n = 117;
            let (e0, e1) = (line_param(PWM, k0), line_param(PWM, k1));
            let (buf, _) = pass(false, e0, (e1 - e0) / n as f64, 0.0137, 0.0, 3, 3 + n);
            for (s, (w, phase)) in buf.iter().zip(unwarped(0.3, 0.0137, 0.0, n)).enumerate() {
                let k = k0 + (k1 - k0) * s as f64 / n as f64;
                let phi = phase as f64 / CYCLE;
                let expected = measured(PWM, k, phi);
                let error = (*w as f64 / CYCLE - expected).abs();
                let edge = (phi - (1.0 - k)).abs() < 1e-5;
                // (the edge in f32 lanes added up: a few 1e-8, against the edge itself)
                let tolerance = 1e-6 + 2e-7 / (1.0 - k);
                assert!(
                    edge || error < tolerance,
                    "{k0}..{k1} sample {s} φ {phi}: {w} not {expected}"
                );
            }
        }
        // the edge at its least: every phase 0
        let (buf, _) = pass(false, 0.3, (1.0 / PWM_MAX - 0.3) / 64.0, 0.0137, 0.0, 0, 96);
        assert!(buf[64..96].iter().all(|w| *w == 0));
    }

    #[test]
    fn a_bend_under_0_maps_as_the_bends_and_reads_the_levels_of_each_slope() {
        // the phases of bend_pass, bit for bit; the share of hi of each sample the one of its x in doubles (the
        // levels of its slope over the floor under the top, level_x), within the f32 of a lane
        let level_x = |x: f64| {
            let whole = jsmath::floor(x);
            whole + min(1.0, max(0.0, (x - whole - (1.0 - LEVEL_BAND)) / LEVEL_BAND))
        };
        for (a0, da, x0, dx, f0) in [
            (-0.72, 0.0, 8.3, 0.0, -3.5),
            (-0.3, 0.004, 12.1, 0.01, -1.0),
            (0.2, -0.01, 15.6, -0.02, 0.4),
            (-0.8, 0.0, 26.0, 0.0, 9.5),
        ] {
            let (n, s0) = (117, 3);
            let most = local_most(min(a0, a0 + da * n as f64));
            let least = -most;
            let top = 27.0;
            let lo = jsmath::floor(level_x(max(0.0, min(x0, x0 + dx * n as f64) + max(least, f0))));
            let hi = jsmath::ceil(level_x(min(top, max(x0, x0 + dx * n as f64) + most)));
            let hi = max(hi, lo + 1.0);
            let levels = LocalLevels {
                x0,
                dx,
                f0,
                df: 0.0,
                top,
                lo,
                hi,
            };
            let (mut buf, mut shares, mut bent) = (vec![0; 140], vec![0.0; 140], vec![0; 140]);
            let (ph, inc, s1) = (0.3, 0.0137, s0 + n);
            let end = local_phases(a0, da, &levels, ph, inc, 0.0, &mut buf, &mut shares, s0, s1);
            assert_eq!(end, warp_phases(true, a0, da, ph, inc, 0.0, &mut bent, s0, s1));
            assert_eq!(buf[s0..s0 + n], bent[s0..s0 + n]);
            // the same bits of a still a in two (local_ups, local_shares)
            let bits = |shares: &[f32]| shares[s0..s1].iter().map(|v| v.to_bits()).collect::<Vec<_>>();
            if da == 0.0 && dx == 0.0 {
                let (mut again, mut ups, mut second) = (vec![0; 140], vec![0.0; 140], vec![0.0; 140]);
                assert_eq!(local_ups(a0, ph, inc, &mut again, &mut ups, s0, s1), end);
                local_shares(&levels, &ups, &mut second, s0, s1);
                assert_eq!(again[s0..s1], buf[s0..s1]);
                assert_eq!(bits(&second), bits(&shares));
            }
            for (j, phase) in unwarped(0.3, 0.0137, 0.0, n).into_iter().enumerate() {
                let a = a0 + da * j as f64;
                let d = 2.0 * (phase as f64 / CYCLE) - 1.0;
                let den = (1.0 - a) + 2.0 * a * d.abs();
                let up = if a < 0.0 {
                    3.0 * log2((1.0 + a) * (1.0 - a) / (den * den))
                } else {
                    0.0
                };
                let x = max(0.0, min(top, x0 + dx * j as f64 + max(up, f0)));
                let share = min(1.0, max(0.0, (level_x(x) - lo) / (hi - lo)));
                let got = shares[s0 + j] as f64;
                // (log2_coarse: an x within 1e-2, five times that over the crossfade of a level, LEVEL_BAND)
                assert!(
                    (got - share).abs() < 5e-2 / (hi - lo),
                    "{a0} sample {j}: {got} not {share}"
                );
            }
        }
    }

    #[test]
    fn the_coarse_log2_is_within_a_thousandth() {
        let mut x = 0.01f32;
        while x < 100.0 {
            let got = log2_coarse(F32x4::new(x, x * 1.1, x * 1.3, x * 1.7)).lanes();
            for (lane, factor) in [1.0f32, 1.1, 1.3, 1.7].into_iter().enumerate() {
                let exact = log2((x * factor) as f64);
                assert!(
                    (got[lane] as f64 - exact).abs() < 1.1e-3,
                    "{x}: {} not {exact}",
                    got[lane]
                );
            }
            x *= 1.013;
        }
        assert_eq!(
            log2_coarse(F32x4::new(1.0, 2.0, 0.5, 8.0)).lanes(),
            [0.0, 1.0, -1.0, 3.0]
        );
    }

    #[test]
    fn the_floor_of_a_sample_rises_to_the_levels_of_the_wrap_as_its_pitch_has_few_harmonics() {
        let most = local_most(-0.6);
        assert!((most - 3.0 * log2(1.6 / 0.4)).abs() < 1e-12);
        assert_eq!(local_most(0.3), 0.0);
        // 64 harmonics and more: LOCAL_DOWN under the pitch; 24 and fewer: the levels of the wrap
        assert_eq!(local_floor(most, 10.0), -LOCAL_DOWN);
        assert_eq!(local_floor(most, 6.0), -LOCAL_DOWN);
        assert!((local_floor(most, log2(24.0)) - most).abs() < 1e-12);
        assert_eq!(local_floor(most, 2.0), most);
        let between = local_floor(most, 5.3);
        assert!(between > -LOCAL_DOWN && between < most);
        // a >= 0: never over the pitch
        assert!(local_floor(local_most(0.4), 2.0) <= 0.0);
        assert!(local(BEND_DOWN, param(BEND_DOWN, 0.3)));
        assert!(local(BEND_BOTH, param(BEND_BOTH, 0.8)) && !local(BEND_BOTH, param(BEND_BOTH, 0.2)));
        assert!(!local(BEND_UP, param(BEND_UP, 0.7)) && !local(PWM, param(PWM, 0.7)));
    }

    #[test]
    fn the_line_of_pwm_is_its_edge_whose_slope_is_its_param() {
        for knob in [0.0, 0.25, 0.5, 0.9, 1.0 - 1e-9, 1.0, 1.5, f64::NAN] {
            let line = line_param(PWM, knob);
            assert_eq!(1.0 / line, param(PWM, knob), "{knob}");
            assert_eq!(line_levels(PWM, line), wrap_levels(PWM, param(PWM, knob)));
            assert_eq!(neutral(PWM, line), neutral(PWM, param(PWM, knob)));
        }
        for mode in [BEND_UP, BEND_DOWN, BEND_BOTH] {
            assert_eq!(line_param(mode, 0.7), param(mode, 0.7));
        }
    }

    #[test]
    fn the_neutral_knobs_leave_the_phase() {
        assert!(neutral(BEND_UP, param(BEND_UP, 0.0)));
        assert!(neutral(BEND_DOWN, param(BEND_DOWN, 0.0)));
        assert!(neutral(BEND_BOTH, param(BEND_BOTH, 0.5)));
        assert!(neutral(PWM, param(PWM, 0.0)));
        assert!(neutral(OFF, param(OFF, 0.7)));
        assert!(!neutral(BEND_BOTH, param(BEND_BOTH, 0.0)));
        assert!(!neutral(PWM, param(PWM, 0.01)));
        // a knob that isn't a number: neutral
        assert!(neutral(BEND_UP, param(BEND_UP, f64::NAN)));
    }

    #[test]
    fn the_levels_follow_the_slope_at_the_wrap() {
        assert_eq!(wrap_levels(BEND_UP, param(BEND_UP, 1.0)), 0.0);
        assert!((wrap_levels(BEND_DOWN, param(BEND_DOWN, 1.0)) - 3.0 * log2(9.0)).abs() < 1e-12);
        assert!((wrap_levels(BEND_BOTH, param(BEND_BOTH, 1.0)) - 3.0 * log2(9.0)).abs() < 1e-12);
        assert_eq!(wrap_levels(BEND_BOTH, param(BEND_BOTH, 0.0)), 0.0);
        assert!((wrap_levels(PWM, param(PWM, 0.75)) - 6.0).abs() < 1e-12);
        assert_eq!(wrap_levels(PWM, param(PWM, 1.0)), 3.0 * log2(PWM_MAX));
        assert_eq!(wrap_levels(OFF, 0.0), 0.0);
    }

    // the passes of a span from sample 3 (a group out of step with the block), the param still and moving
    fn pass(bend: bool, p0: f64, dp: f64, inc: f64, d_inc: f64, s0: usize, s1: usize) -> (Vec<u32>, f64) {
        let mut buf = vec![0; 140];
        let end = warp_phases(bend, p0, dp, 0.3, inc, d_inc, &mut buf, s0, s1);
        (buf[s0..s1].to_vec(), end)
    }

    // the phases the read loops step over s0..s1 (Phases, as render11 reads them)
    fn unwarped(ph: f64, inc: f64, d_inc: f64, n: usize) -> Vec<u32> {
        let mut phases = Phases::new(ph, inc, d_inc);
        let mut out = Vec::new();
        while out.len() < n {
            out.extend(phases.group().lanes());
            phases.next();
        }
        out.truncate(n);
        out
    }

    #[test]
    fn the_pass_is_the_lanes_of_the_map() {
        // (PWM by its edge: the lanes of its slope)
        for (bend, p) in [
            (true, 0.56),
            (true, -0.72),
            (false, 1.0 / 1.8),
            (false, 1.0 / PWM_MAX),
        ] {
            let lane = if bend { p } else { 1.0 / p } as f32;
            for d_inc in [0.0, 3e-6] {
                let (buf, end) = pass(bend, p, 0.0, 0.0137, d_inc, 3, 120);
                for (s, (w, phase)) in buf.iter().zip(unwarped(0.3, 0.0137, d_inc, 117)).enumerate() {
                    assert_eq!(*w, warp_sample(bend, lane, phase), "sample {s}");
                }
                // the phase after it is the one of the read loops (never warped)
                assert_eq!(end, Phases::new(0.3, 0.0137, d_inc).end(0.0137, d_inc, 117));
            }
        }
    }

    #[test]
    fn a_span_cut_elsewhere_warps_the_same_phases() {
        // a still step and param: the same bits however the block is cut (a span from the phase the one before
        // ends at)
        for (bend, p0) in [(true, -0.5), (false, 0.8), (true, 0.3)] {
            let (whole, end) = pass(bend, p0, 0.0, 0.021, 0.0, 0, 96);
            let (first, mid) = pass(bend, p0, 0.0, 0.021, 0.0, 0, 32);
            let mut buf = vec![0; 140];
            let end2 = warp_phases(bend, p0, 0.0, mid, 0.021, 0.0, &mut buf, 32, 96);
            assert_eq!(end, end2);
            assert_eq!(&whole[..32], &first[..]);
            assert_eq!(&whole[32..], &buf[32..96]);
        }
        // a moving param: its lanes in f32 from another start, a phase within a few thousandths of a sample of a
        // table of 4096
        for (bend, p0, dp) in [(true, -0.5, 0.004), (false, 0.8, -0.002)] {
            let (whole, _) = pass(bend, p0, dp, 0.021, 0.0, 0, 96);
            let (_, mid) = pass(bend, p0, dp, 0.021, 0.0, 0, 32);
            let mut buf = vec![0; 140];
            warp_phases(bend, p0 + dp * 32.0, dp, mid, 0.021, 0.0, &mut buf, 32, 96);
            for s in 32..96 {
                let (a, b) = (whole[s], buf[s]);
                assert!(
                    (a.wrapping_sub(b) as i32).unsigned_abs() < 1 << 12,
                    "sample {s}: {a} {b}"
                );
            }
        }
    }
}
