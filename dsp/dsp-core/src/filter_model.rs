//! The model types of a filter: those of the Audio Unit of the renders (dsp/measurements/filter-types.json), its
//! Normal ones (MG Low 6–24 as Ladder, Low and High 6–24, Band, Peak and Notch 12 and 24) and its EQ ones. Each is
//! an analog prototype (s in units of the cutoff) whose feedbacks come a fraction of a sample late, as the reference
//! has them (its resonance and its slope move with the cutoff), with a droop of the highs. Realized in sections of
//! the sample rate: the poles of the prototype matched (z = e^{sT}), the numerator matched in magnitude at DC, at
//! 16 kHz of 48 kHz and in the middle; state variable filters (trapezoidal integrators) and one-poles, their outputs
//! the mix of their taps. The design of libs/math/src/filter/model.ts, operation for operation (the chart of the
//! app draws it): the Math of JS from jsmath, the same bits
//!
//! Drive: the gain (1 + d)⁴ into the curve of the reference (a cubic up to UT, flat past it) before the sections.
//! FAT (the variation of the types of Normal but the one-poles and the notches) is a gain of 1 + 4 r fat into the
//! sections after it; DB +/- (the one of the EQ types) is the gain of their band. A notch has no FAT: the resonance
//! takes nothing off its pass band (a gain of 1), and the variation of the reference's Notch changes no bit of it
//!
//! The resonance saturates (the measurements of a loud sine at the cutoff, `fat` of filter-types.json): the damping
//! of the first section k = K0 - A·m, A = K0 - k what the resonance takes off the damping of Res 0, m of the level b
//! of the sample before: of a state variable filter the integrator of its band, m = 1/(1 + u²/2), u = b/L,
//! L = c·P·A (P the inverse of the gain of the pass band; the second section of a 24 dB one too, its L of the output
//! level); of a ladder the output of its sections, m = L/max(|b|, L): a clip. The steps of its integrators are worked
//! out again every 4 samples of a block (the same samples of every voice: a voice plays the same bits with another in
//! its lanes or alone). FAT drives it
//! harder (its gain before it: at a small signal the response × F, louder the resonance squeezed, its harmonics up)

use jsmath::{cos, exp, max, min, pow, sin, sqrt, LN_10, PI};

/// a model type, by its index after the types of a BiquadFilterNode in FILTER_TYPES of the preset schema
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ModelType {
    Ladder6,
    Ladder12,
    Ladder18,
    Ladder24,
    Low6,
    Low12,
    Low18,
    Low24,
    High6,
    High12,
    High18,
    High24,
    Band12,
    Band24,
    Peak12,
    Peak24,
    Notch12,
    Notch24,
    LowEq6,
    LowEq12,
    BandEq12,
    HighEq6,
    HighEq12,
}

pub const MODEL_TYPES: [ModelType; 23] = [
    ModelType::Ladder6,
    ModelType::Ladder12,
    ModelType::Ladder18,
    ModelType::Ladder24,
    ModelType::Low6,
    ModelType::Low12,
    ModelType::Low18,
    ModelType::Low24,
    ModelType::High6,
    ModelType::High12,
    ModelType::High18,
    ModelType::High24,
    ModelType::Band12,
    ModelType::Band24,
    ModelType::Peak12,
    ModelType::Peak24,
    ModelType::Notch12,
    ModelType::Notch24,
    ModelType::LowEq6,
    ModelType::LowEq12,
    ModelType::BandEq12,
    ModelType::HighEq6,
    ModelType::HighEq12,
];

impl ModelType {
    /// the type of an index among the model types (None: unknown)
    pub fn from_index(index: u32) -> Option<ModelType> {
        MODEL_TYPES.get(index as usize).copied()
    }

    /// whether its variation is FAT (a gain into its sections): a ladder and the state variable filters, not the
    /// one-poles (their FAT is a gain of 1), the notches (the variation of the reference's does nothing) nor the EQ
    /// ones (their variation is the gain of their band)
    pub fn has_fat(self) -> bool {
        match structure(self) {
            Structure::Ladder { .. } => true,
            Structure::Svf { tap, .. } => tap != Tap::Notch,
            _ => false,
        }
    }

    /// whether its design depends on the resonance and on the variation besides the cutoff: FAT is not of the
    /// design but its gain (`fat_of`), a one-pole has neither, an EQ one-pole no resonance (by the type, not its
    /// structure: a span of a voice asks; the test `a_design_is_of_the_knobs_it_is_designed_by`)
    pub fn designed_by(self) -> [bool; 2] {
        use ModelType::*;
        match self {
            Low6 | High6 => [false, false],
            LowEq6 | HighEq6 => [false, true],
            LowEq12 | BandEq12 | HighEq12 => [true, true],
            _ => [true, false],
        }
    }

    /// the gain of FAT of its design at the resonance and the variation (0..1): 1 of a type without it (those
    /// designed by the variation, the one-poles and the notches)
    pub fn fat_of(self, resonance: f64, variation: f64) -> f64 {
        if !self.has_fat() {
            return 1.0;
        }
        fat_factor(min(max(resonance, 0.0), 1.0), min(max(variation, 0.0), 1.0))
    }

    /// the sections it runs: state variable filters (0..2) and whether a one-pole follows them
    pub fn layout(self) -> Layout {
        match structure(self) {
            Structure::Ladder { .. } => Layout {
                svfs: 2,
                sat: true,
                clip: true,
                ..Layout::default()
            },
            Structure::Svf { second, pole, .. } => Layout {
                svfs: if second.is_some() { 2 } else { 1 },
                pole: pole.is_some(),
                sat: true,
                sat2: second.is_some(),
                ..Layout::default()
            },
            Structure::Pole { .. } => Layout {
                pole: true,
                ..Layout::default()
            },
            Structure::Eq { order, .. } => Layout {
                svfs: if order == 2 { 1 } else { 0 },
                pole: order == 1,
                ..Layout::default()
            },
        }
    }
}

/// the sections a type runs, whether the curve of Drive runs before them (Drive over 0: at 0 the curve is the
/// input within -52 dB at a level of 1, it is left out), whether its resonance saturates (the types of Normal but
/// the one-poles; the second section of a 24 dB one too; a ladder clips), whether the gain of FAT runs (FAT over 0
/// of a type that has it: at 0 it is 1)
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct Layout {
    pub svfs: usize,
    pub pole: bool,
    pub drive: bool,
    pub sat: bool,
    pub sat2: bool,
    pub clip: bool,
    pub fat: bool,
}

/// the gain of Drive (0..1) into the curve
pub fn drive_gain(drive: f64) -> f64 {
    let d = 1.0 + min(max(drive, 0.0), 1.0);
    d * d * d * d
}

/// the curve of Drive: x - x³/(3 UT²) up to UT, 2 UT / 3 past it (the measurements)
pub const UT: f32 = 4.933;
pub const CUBIC: f32 = 1.0 / (3.0 * UT * UT);

// the damping of the state variable filter by the resonance, 2 at 0, a floor at 1 (the reference never rings for
// good; that of the EQ types, those of Normal saturate: SVF_FLOOR); the gain of its pass band (a ladder's:
// 1 / (1 + k), k = 4 r)
const EQ_FLOOR: f64 = 0.0011;
fn svf_damping(resonance: f64, floor: f64) -> f64 {
    max(2.0 * (1.0 - sqrt(sqrt(resonance))), floor)
}
fn resonance_gain(resonance: f64) -> f64 {
    1.0 / (1.0 + 4.0 * resonance)
}
/// DB +/- of the EQ types: the gain of their band, 0 at 0, 1 at 0.5, 9 (+19 dB) at 1
pub fn eq_gain(variation: f64) -> f64 {
    if variation < 0.5 {
        let t = 1.0 - 2.0 * variation;
        1.0 - t * t * t
    } else {
        let t = 2.0 * variation - 1.0;
        1.0 + 8.0 * (t * t * t)
    }
}
fn fat_factor(resonance: f64, variation: f64) -> f64 {
    1.0 + 4.0 * resonance * variation
}
// (the floor of the types of Normal: their resonance saturates, at Res 1 a quiet sine at the cutoff already a little
// as the reference's)
const SVF_FLOOR: f64 = 0.0001;
// the feedback of a ladder (the reference's, every one of its MG Low: filter-resonance.json, the peaks of a quiet sine
// by Res and the cutoff): 4 r, a little less at higher cutoffs (w = π fc / fs), under its top; its peak is over the
// cutoff under 1 kHz and under it at 6 kHz: the poles moved by a share of the cutoff (w held at 6.3 kHz of 48 kHz
// past it). Lines of w, no sines (a design of Res 100 % is worked out nearly every span)
const LADDER_FEEDBACK: [f64; 3] = [0.99908, 0.00151, 0.03781];
const LADDER_TOP: f64 = 3.99803;
const LADDER_TUNE: [f64; 3] = [0.00426, -0.0161, 0.41];
fn ladder_feedback_of(resonance: f64, w: f64) -> f64 {
    let [c, c0, cw] = LADDER_FEEDBACK;
    min((4.0 * resonance * c + c0) * (1.0 - cw * w), LADDER_TOP)
}
// the share of the cutoff the poles of a ladder move by
fn ladder_tune_of(w: f64) -> f64 {
    let [t0, tw, top] = LADDER_TUNE;
    1.0 + (t0 + tw * min(w, top))
}

// the saturation of the resonance of a type: of a state variable filter L = c·P·A (fitted to the `fat` rows of the
// measurements: Low, High, Band and Peak 12, Low 24; the others as their kin), of a ladder its clip at the output
// of its sections: 1.42 of MG Low 24 over the gain of the poles it leaves out at the cutoff (√2 each)
// (High and Peak: L = c·P^1.25·A, their 3rd harmonic at Res 0.5 as the reference's too)
fn saturation_of(ty: ModelType) -> (f64, bool) {
    use ModelType::*;
    match ty {
        Low12 | Low18 | Notch12 | Notch24 => (2.21, false),
        Low24 => (2.1, false),
        High12 | High18 | High24 => (1.6, true),
        Band12 | Band24 => (2.18, false),
        Peak12 | Peak24 => (1.65, true),
        _ => (0.0, false),
    }
}
// the level of the saturation of a state variable filter (Low, Band and Notch) by the cutoff (w = π fc / fs): the
// reference's saturated resonance quieter over 2 kHz (filter-resonance.json `levels` of Low and Band 12; the steps
// worked out every 4 samples of a block see a fast resonance louder): 1 - a x + b x² of x = w² - w0² from 1.5 kHz of
// 48 kHz to 6.3 kHz, held past it
const SVF_LEVEL: [f64; 4] = [3.966, 17.47, 0.0042, 0.1685];
fn svf_level_of(w: f64) -> f64 {
    let [a, b, from, to] = SVF_LEVEL;
    let x = max(min(w * w, to) - from, 0.0);
    1.0 - a * x + b * (x * x)
}
const LADDER_CLIP: f64 = 1.42;
// clipped, a ladder damps its first section 3 times as at Res 0 (the reference's output then barely grows with its
// input: FAT driving it harder, its level within 0.8 dB)
const LADDER_CLIPPED: f64 = 3.0;
// the L of the second section of a 24 dB state variable filter: of the output level (Low 24: its 3rd harmonic as the
// reference's, its level too)
const SECOND_LEVEL: f64 = 5.5;
// the damping a clipped ladder takes 3 times: of the poles -1 + rest^¼ e^{±jπ/4} (`rest` of its structure: the
// feedback of its Res 0 the saturation was fitted with; svf: 2)
fn ladder_rest_damping(rest: f64) -> f64 {
    let q = sqrt(sqrt(rest));
    let sigma = 1.0 - q * (sqrt(2.0) / 2.0);
    (2.0 * sigma) / sqrt(sigma * sigma + (q * q) / 2.0)
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Tap {
    Low,
    High,
    Band,
    Peak,
    Notch,
}

// how a type is made (model.ts: MODEL_STRUCTURES; `rest` of a ladder the core's alone): d2 the droop of each stage
// (dB at (f/fs)² = 1), d how late the feedback of a section comes (samples)
#[derive(Clone, Copy, Debug)]
enum Structure {
    Ladder {
        n: u32,
        d2: f64,
        rest: f64,
    },
    Svf {
        tap: Tap,
        d2: f64,
        d: f64,
        second: Option<(f64, f64)>,
        pole: Option<f64>,
    },
    Pole {
        tap: Tap,
        d2: f64,
        d: f64,
    },
    Eq {
        tap: Tap,
        order: u32,
        d2: f64,
        d: f64,
    },
}

fn structure(ty: ModelType) -> Structure {
    use ModelType::*;
    use Structure::*;
    let svf = |tap, d2, d| Svf {
        tap,
        d2,
        d,
        second: None,
        pole: None,
    };
    match ty {
        Ladder6 => Ladder {
            n: 1,
            d2: 9.18,
            rest: 0.0132,
        },
        Ladder12 => Ladder {
            n: 2,
            d2: 9.1,
            rest: 0.0194,
        },
        Ladder18 => Ladder {
            n: 3,
            d2: 9.19,
            rest: 0.0258,
        },
        Ladder24 => Ladder {
            n: 4,
            d2: 9.11,
            rest: 0.0277,
        },
        Low6 => Pole {
            tap: Tap::Low,
            d2: 6.45,
            d: 0.1127,
        },
        Low12 => svf(Tap::Low, 7.28, 0.1316),
        Low18 => Svf {
            tap: Tap::Low,
            d2: 6.67,
            d: 0.1338,
            second: None,
            pole: Some(0.1118),
        },
        Low24 => Svf {
            tap: Tap::Low,
            d2: 7.34,
            d: 0.1325,
            second: Some((1.0063, 1.0137)),
            pole: None,
        },
        High6 => Pole {
            tap: Tap::High,
            d2: 8.06,
            d: 0.1503,
        },
        High12 => svf(Tap::High, 6.35, 0.1179),
        High18 => Svf {
            tap: Tap::High,
            d2: 8.05,
            d: 0.1078,
            second: None,
            pole: Some(0.1771),
        },
        High24 => Svf {
            tap: Tap::High,
            d2: 6.42,
            d: 0.1142,
            second: Some((1.0, 1.0)),
            pole: None,
        },
        Band12 => svf(Tap::Band, 7.04, 0.1153),
        Band24 => Svf {
            tap: Tap::Band,
            d2: 6.86,
            d: 0.1109,
            second: Some((1.0, 1.0)),
            pole: None,
        },
        Peak12 => svf(Tap::Peak, 6.18, 0.2001),
        Peak24 => Svf {
            tap: Tap::Peak,
            d2: 6.26,
            d: 0.2124,
            second: Some((1.0657, 0.6967)),
            pole: None,
        },
        Notch12 => svf(Tap::Notch, 2.9, 0.1305),
        Notch24 => Svf {
            tap: Tap::Notch,
            d2: 2.3,
            d: 0.1359,
            second: Some((1.0, 1.0)),
            pole: None,
        },
        LowEq6 => Eq {
            tap: Tap::Low,
            order: 1,
            d2: 6.45,
            d: 0.1127,
        },
        LowEq12 => Eq {
            tap: Tap::Low,
            order: 2,
            d2: 7.28,
            d: 0.1316,
        },
        BandEq12 => Eq {
            tap: Tap::Band,
            order: 2,
            d2: 7.04,
            d: 0.1153,
        },
        HighEq6 => Eq {
            tap: Tap::High,
            order: 1,
            d2: 8.06,
            d: 0.1503,
        },
        HighEq12 => Eq {
            tap: Tap::High,
            order: 2,
            d2: 6.35,
            d: 0.1179,
        },
    }
}

// --- complex numbers ---

type Complex = (f64, f64);
fn mul(a: Complex, b: Complex) -> Complex {
    (a.0 * b.0 - a.1 * b.1, a.0 * b.1 + a.1 * b.0)
}
fn div(a: Complex, b: Complex) -> Complex {
    let d = b.0 * b.0 + b.1 * b.1;
    ((a.0 * b.0 + a.1 * b.1) / d, (a.1 * b.0 - a.0 * b.1) / d)
}
fn cexp(a: Complex) -> Complex {
    let r = exp(a.0);
    (r * cos(a.1), r * sin(a.1))
}
fn abs2(a: Complex) -> f64 {
    a.0 * a.0 + a.1 * a.1
}
fn hypot(a: f64, b: f64) -> f64 {
    sqrt(a * a + b * b)
}

// --- the analog prototype ---

// (from the start of the Taylor: within 1e-4 after 3 but where the pair turns from complex into real at the top)
const NEWTON_STEPS: usize = 4;
// settled: a step under 1e-5 of the root (the next one under 1e-10 of it, the coefficients are f32)
const SETTLED: f64 = 1e-10;

/// a root by `steps` of Newton at most, and whether it settled
#[inline(never)]
fn svf_root(start: Complex, k: f64, tau: f64, steps: usize) -> (Complex, bool) {
    let mut s = start;
    for _ in 0..steps {
        let e = cexp((-s.0 * tau, -s.1 * tau));
        let se = mul(s, e);
        let f = (s.0 * s.0 - s.1 * s.1 + k * se.0 + 1.0, 2.0 * s.0 * s.1 + k * se.1);
        let de = mul(e, (1.0 - s.0 * tau, -s.1 * tau));
        let step = div(f, (2.0 * s.0 + k * de.0, 2.0 * s.1 + k * de.1));
        s = (s.0 - step.0, s.1 - step.1);
        // (settled: a short feedback delay leaves the start of the Taylor a step from it)
        if step.0 * step.0 + step.1 * step.1 <= SETTLED * (s.0 * s.0 + s.1 * s.1) {
            return (s, true);
        }
    }
    (s, false)
}

// under it (the cutoffs under about 6 kHz) a root starts from e^{-sτ} to the 2nd order: a step of Newton on
// (kτ²/2) s³ + (1 - kτ) s² + k s + 1, its error then about kτ³/6
const TAYLOR_TAU: f64 = 0.1;
// settled by Halley: a step under 1e-3 of the root (its error then about the cube of the step)
const SETTLED_HALLEY: f64 = 1e-6;

// a step of Newton on the cubic of the Taylor to the 2nd order
fn taylor_step(s: Complex, k: f64, tau: f64) -> Complex {
    let (c, a) = ((k * tau * tau) / 2.0, 1.0 - k * tau);
    let s2 = mul(s, s);
    let s3 = mul(s2, s);
    let f = (c * s3.0 + a * s2.0 + k * s.0 + 1.0, c * s3.1 + a * s2.1 + k * s.1);
    let d = (3.0 * c * s2.0 + 2.0 * a * s.0 + k, 3.0 * c * s2.1 + 2.0 * a * s.1);
    let step = div(f, d);
    (s.0 - step.0, s.1 - step.1)
}

/// a root of s² + k s e^{-sτ} + 1 by `steps` of Halley at most (f'' = 2 + kτ e^{-sτ}(sτ - 2) of the same
/// exponential), and whether it settled
#[inline(never)]
fn svf_root_halley(start: Complex, k: f64, tau: f64, steps: usize) -> (Complex, bool) {
    let mut s = start;
    for _ in 0..steps {
        let e = cexp((-s.0 * tau, -s.1 * tau));
        let se = mul(s, e);
        let f = (s.0 * s.0 - s.1 * s.1 + k * se.0 + 1.0, 2.0 * s.0 * s.1 + k * se.1);
        let de = mul(e, (1.0 - s.0 * tau, -s.1 * tau));
        let d1 = (2.0 * s.0 + k * de.0, 2.0 * s.1 + k * de.1);
        let e2 = mul(e, (s.0 * tau - 2.0, s.1 * tau));
        let d2 = (2.0 + k * tau * e2.0, k * tau * e2.1);
        // 2 f f' / (2 f'² - f f'')
        let (ff1, d11, ff2) = (mul(f, d1), mul(d1, d1), mul(f, d2));
        let step = div(
            (2.0 * ff1.0, 2.0 * ff1.1),
            (2.0 * d11.0 - ff2.0, 2.0 * d11.1 - ff2.1),
        );
        s = (s.0 - step.0, s.1 - step.1);
        if abs2(step) <= SETTLED_HALLEY * abs2(s) {
            return (s, true);
        }
    }
    (s, false)
}

/// the root of a complex pair of s² + k s e^{-sτ} + 1 where τ is under TAYLOR_TAU: from the start of the Taylor
/// moved by `taylor_step`, steps of Halley; and whether it settled
fn svf_root_near(start: Complex, k: f64, tau: f64) -> (Complex, bool) {
    svf_root_halley(taylor_step(start, k, tau), k, tau, NEWTON_STEPS)
}

// (on the real axis: steps of a real exponential)
const REAL_STEPS: usize = 8;

/// a real root of s² + k s e^{-sτ} + 1 by Newton from a real start and the slope of its last step, None if it
/// doesn't settle within `half` of it (the pair is complex there, or it went to the root of the delay far to the
/// left)
#[inline(never)]
fn svf_real_root(start: f64, half: f64, k: f64, tau: f64) -> Option<(f64, f64)> {
    let mut s = if tau < TAYLOR_TAU {
        taylor_step((start, 0.0), k, tau).0
    } else {
        start
    };
    for _ in 0..REAL_STEPS {
        let e = exp(-s * tau);
        let slope = 2.0 * s + k * e * (1.0 - s * tau);
        let step = (s * s + k * s * e + 1.0) / slope;
        s -= step;
        if step * step <= SETTLED * (s * s) {
            return ((s - start).abs() < half).then_some((s, slope));
        }
    }
    None
}

// --- the poles of a prototype nearly without resonance ---

// In x = -s the poles are the roots of F(x) = x² + 1 - k x e^{xτ}. A damping over K_CUSP (Res under 1 %) has
// three real ones in a window of τ: the pair lands on the real axis (x1 < x2), then x2 meets the root of the delay
// x3 and leaves the axis with it, a pair over nyquist. Where a pair lands and where two meet is a double root:
// (x + 1/x) e^{-(x² - 1)/(x² + 1)} = k at τ = (x² - 1)/(x (x² + 1)), under X_CUSP and over it (at X_CUSP, K_CUSP,
// the three are one). The poles there: the pair until it lands, x1 and x2 while both are real, then x1 and the
// place where x2 met x3 (the second pole stays there: its z is under 0.01, the poles are continuous along τ)
const X_CUSP: f64 = 2.0581710272714924;
const K_CUSP: f64 = 1.371245024747284;
// (the damping of a second section is 2.02 at most: where the roots meet is under X_TOP)
const K_TOP: f64 = 3.0;
const X_TOP: f64 = 8.0;
// no root meets another under it (K_TOP aside: the window of the roots says so itself)
const TAU_MEET: f64 = 0.18;
// a pair this near the real axis (its imaginary part under 1 % of |s|: squared) is landing, Newton is slow there
const LANDED: f64 = 1e-4;
const SAFE_STEPS: usize = 60;

/// A root of `at` (its value and its slope) in lo..hi, where it rises or falls through 0: Newton from `start`, a
/// step out of what is left of lo..hi is its middle (a double root, a start on the wrong side of a turn)
#[inline(always)]
fn safe_root(at: impl Fn(f64) -> (f64, f64), lo: f64, hi: f64, start: f64, rising: bool) -> f64 {
    let (mut a, mut b) = (lo, hi);
    // (a NaN: lo)
    let mut x = if start > lo {
        if start < hi {
            start
        } else {
            hi
        }
    } else {
        lo
    };
    for _ in 0..SAFE_STEPS {
        let (f, d) = at(x);
        if f == 0.0 {
            break;
        }
        if (f > 0.0) == rising {
            b = x;
        } else {
            a = x;
        }
        let next = x - f / d;
        let newton = next > a && next < b;
        let to = if newton { next } else { 0.5 * (a + b) };
        let step = to - x;
        x = to;
        if newton && step * step <= SETTLED * (x * x) {
            break;
        }
    }
    x
}

/// a root of F in lo..hi (`safe_root` of F and its slope)
#[inline(never)]
fn real_root(k: f64, tau: f64, lo: f64, hi: f64, start: f64, rising: bool) -> f64 {
    safe_root(
        |x| {
            let e = exp(x * tau);
            (x * x + 1.0 - k * x * e, 2.0 * x - k * e * (1.0 + x * tau))
        },
        lo,
        hi,
        start,
        rising,
    )
}

/// where x2 meets x3 at the damping k (over X_CUSP): the double root there
#[inline(never)]
fn meet_root(k: f64) -> f64 {
    safe_root(
        |x| {
            let x2 = x * x;
            let m = (x + 1.0 / x) * exp(-(x2 - 1.0) / (x2 + 1.0));
            (
                m - k,
                (m * (x2 * x2 - 4.0 * x2 - 1.0)) / (x * (x2 + 1.0) * (x2 + 1.0)),
            )
        },
        X_CUSP,
        X_TOP,
        X_CUSP + 3.0 * sqrt(k - K_CUSP),
        true,
    )
}

/// whether x2 has met x3 at τ (the τ of the double root xm is under it)
fn met(xm: f64, tau: f64) -> bool {
    tau * (xm * (xm * xm + 1.0)) >= xm * xm - 1.0
}

/// x1 and the place x2 met x3
fn met_poles(k: f64, tau: f64, xm: f64, start: f64) -> [Complex; 2] {
    [(-real_root(k, tau, 0.0, xm, start, false), 0.0), (-xm, 0.0)]
}

/// the poles where Newton from the starts of the Taylor doesn't find them: x2 has met x3 (xm) or not yet
fn wide_poles(k: f64, tau: f64, xm: f64, start: f64) -> [Complex; 2] {
    if met(xm, tau) {
        met_poles(k, tau, xm, start)
    } else {
        window_poles(k, tau, xm)
    }
}

/// The poles before x2 meets x3 (xm), where Newton from the starts of the Taylor doesn't find them (near a double
/// root, a start on the wrong side): from the minimum of F between x1 and x2 (Newton on F' from 0: F' is concave,
/// its steps never pass it), under 0 two real roots each in its part of 0..xm, over 0 the pair before it lands (those
/// of τ = 0 if it doesn't settle on one, as `svf_poles` takes them)
#[inline(never)]
fn window_poles(k: f64, tau: f64, xm: f64) -> [Complex; 2] {
    let mut x = 0.0;
    for _ in 0..SAFE_STEPS {
        let e = exp(x * tau);
        let d2 = 2.0 - k * tau * e * (2.0 + x * tau);
        // (a NaN too)
        if d2.partial_cmp(&0.0) != Some(core::cmp::Ordering::Greater) {
            break;
        }
        let step = (2.0 * x - k * e * (1.0 + x * tau)) / d2;
        x -= step;
        if step * step <= SETTLED * (x * x) {
            break;
        }
    }
    let e = exp(x * tau);
    let f = x * x + 1.0 - k * x * e;
    // (F to the 2nd order about its minimum: its roots this far to each side, or up and down)
    let off = sqrt(((2.0 * f) / (2.0 - k * tau * e * (2.0 + x * tau))).abs());
    if f <= 0.0 {
        return [
            (-real_root(k, tau, 0.0, x, x - off, false), 0.0),
            (-real_root(k, tau, x, xm, x + off, true), 0.0),
        ];
    }
    let (s, settled) = svf_root((-x, off), k, tau, SAFE_STEPS);
    if settled && s.0.is_finite() && s.1.is_finite() && s.0 < 0.0 {
        return [(s.0, s.1.abs()), (s.0, -s.1.abs())];
    }
    svf_poles_of(k)
}

// --- the pair of a prototype with some resonance ---

// A damping under K_CUSP (Res over 1 %) has one real root at every τ, the root of the delay, and the pair never
// lands. At the top of the cutoff that root has come nearer than the pair (the pair past nyquist) and Newton from
// the start of the Taylor goes to it: the poles are the pair all the same, as they are at any resonance over it
// (continuous along the cutoff; along the resonance a step is left at the cusp, where the rule over it takes x1)
const PAIR_STEPS: usize = 10;
// where the steps of Halley start there: they settle on the pair from it wherever the real root is (7 at most, 3.6
// a design), Newton's from the same start go to the real root at some τ
const PAIR_START: Complex = (-1.5, 2.0);
// where Newton from the start of the Taylor leaves the pair, nearly (it settles on it up to kτ 0.386 at the cusp,
// 0.44 at k 0.8, at every τ under k 0.7): no step of it is spent there
const PAIR_K: f64 = 0.75;
const PAIR_K_TAU: f64 = 0.38;

/// The pair of s² + k s e^{-sτ} + 1 under K_CUSP where Newton from the start of the Taylor leaves it: Halley from
/// PAIR_START; a root that is no pair of the cutoff (on the real axis, a turn of the delay further: |Im s| τ over π)
/// or none: `deflated_pair`
#[inline(never)]
fn pair_poles(k: f64, tau: f64) -> [Complex; 2] {
    let (s, settled) = svf_root_halley(PAIR_START, k, tau, PAIR_STEPS);
    let im = s.1.abs();
    if settled && s.0 < 0.0 && im * im > LANDED * abs2(s) && im * tau < PI {
        return [(s.0, im), (s.0, -im)];
    }
    deflated_pair(k, tau)
}

// (the steps of Newton on the function without its real root: 7 at most from its start)
const DEFLATED_STEPS: usize = 16;
const DEFLATED_START: Complex = (-1.5, 1.5);

/// The pair with the real root x taken out of the way (the only one, F falls through it): Newton on f(s)/(s + x),
/// which has no root there; those of τ = 0 if it doesn't settle
#[inline(never)]
fn deflated_pair(k: f64, tau: f64) -> [Complex; 2] {
    let mut hi = 4.0;
    while hi * hi + 1.0 > k * hi * exp(hi * tau) && hi < 1e6 {
        hi *= 2.0;
    }
    let x = real_root(k, tau, 0.0, hi, 1.5, false);
    let mut s = DEFLATED_START;
    for _ in 0..DEFLATED_STEPS {
        let e = cexp((-s.0 * tau, -s.1 * tau));
        let se = mul(s, e);
        let f = (s.0 * s.0 - s.1 * s.1 + k * se.0 + 1.0, 2.0 * s.0 * s.1 + k * se.1);
        let de = mul(e, (1.0 - s.0 * tau, -s.1 * tau));
        // (f / (s + x))' / (f / (s + x)) = f'/f - 1/(s + x)
        let q = div(f, (s.0 + x, s.1));
        let step = div(f, (2.0 * s.0 + k * de.0 - q.0, 2.0 * s.1 + k * de.1 - q.1));
        s = (s.0 - step.0, s.1 - step.1);
        if abs2(step) <= SETTLED * abs2(s) {
            if s.0.is_finite() && s.1.is_finite() && s.0 < 0.0 && s.1 != 0.0 {
                return [(s.0, s.1.abs()), (s.0, -s.1.abs())];
            }
            break;
        }
    }
    svf_poles_of(k)
}

/// the poles of s² + k s e^{-sτ} + 1 (units of the cutoff): those of (1 - kτ) s² + k s + 1 moved by Newton; two real
/// starts on the real axis while each settles in its half of the gap between them on its own root (the slope there:
/// x1 where F falls, x2 where it rises), else in the complex plane (a real start a little off the axis: the pair
/// may be complex where the start is not); a pair or two real ones, those of τ = 0 if it doesn't settle. Nearly
/// without resonance (`wide`): where Newton doesn't find them `window_poles`, past the meeting of x2 and x3
/// `met_poles`. Under the cusp (`pair`): the pair, `pair_poles` where Newton doesn't settle on it
#[inline(never)]
fn svf_poles(k: f64, tau: f64) -> [Complex; 2] {
    let a = max(1.0 - k * tau, 0.05);
    let disc = k * k - 4.0 * a;
    let wide = k > K_CUSP && k < K_TOP;
    let pair = k <= K_CUSP;
    if pair && k > PAIR_K && k * tau > PAIR_K_TAU {
        return pair_poles(k, tau);
    }
    let roots = if disc < 0.0 {
        // (a complex pair: one root, the other its conjugate)
        let start = (-k / (2.0 * a), sqrt(-disc) / (2.0 * a));
        let (s, settled) = if tau < TAYLOR_TAU {
            svf_root_near(start, k, tau)
        } else {
            svf_root(start, k, tau, NEWTON_STEPS)
        };
        let lost = !settled || s.1 * s.1 <= LANDED * abs2(s);
        // (it is landing, or has landed: Newton is slow about a double root, or went to one of two real ones)
        if wide && lost {
            return wide_poles(k, tau, meet_root(k), k / (2.0 * a));
        }
        // (it went to the real root, or is on its way)
        if pair && tau >= TAYLOR_TAU && lost {
            return pair_poles(k, tau);
        }
        [s, s]
    } else {
        // (the starts are real, the pair is not)
        if pair {
            return pair_poles(k, tau);
        }
        let r = sqrt(disc);
        let (p, q) = ((-k + r) / (2.0 * a), (-k - r) / (2.0 * a));
        let half = r / (2.0 * a);
        // (where x2 meets x3, if worked out already)
        let mut xm = None;
        if wide && tau >= TAU_MEET {
            let x = meet_root(k);
            if met(x, tau) {
                return met_poles(k, tau, x, -p);
            }
            xm = Some(x);
        }
        if let (Some((p, falls)), Some((q, rises))) =
            (svf_real_root(p, half, k, tau), svf_real_root(q, half, k, tau))
        {
            if !wide || (falls > 0.0 && rises < 0.0) {
                return [(p, 0.0), (q, 0.0)];
            }
        }
        if wide {
            return wide_poles(k, tau, xm.unwrap_or_else(|| meet_root(k)), -p);
        }
        [
            svf_root((p, 1e-3), k, tau, NEWTON_STEPS).0,
            svf_root((q, 1e-3), k, tau, NEWTON_STEPS).0,
        ]
    };
    let settled = roots
        .iter()
        .all(|s| s.0.is_finite() && s.1.is_finite() && s.0 < 0.0);
    let roots = if settled { roots } else { svf_poles_of(k) };
    // a complex one: its pair; else the two real ones
    for s in roots {
        if s.1.abs() > 1e-9 {
            return [(s.0, s.1.abs()), (s.0, -s.1.abs())];
        }
    }
    [(roots[0].0, 0.0), (roots[1].0, 0.0)]
}

// the poles of s² + k s + 1
fn svf_poles_of(k: f64) -> [Complex; 2] {
    let disc = k * k / 4.0 - 1.0;
    if disc < 0.0 {
        return [(-k / 2.0, sqrt(-disc)), (-k / 2.0, -sqrt(-disc))];
    }
    [(-k / 2.0 + sqrt(disc), 0.0), (-k / 2.0 - sqrt(disc), 0.0)]
}

/// the pole of s + e^{-sτ}, real, of τ up to LATE_TOP (`late_tau`): W₀(-τ)/τ, its principal root (s τ ≥ -1; the
/// other is further left). Newton from -1 where it settles on it, else `late_pole`
#[inline(never)]
fn pole_pole(tau: f64) -> f64 {
    let mut s = -1.0;
    for _ in 0..NEWTON_STEPS {
        let e = exp(-s * tau);
        let step = (s + e) / (1.0 - tau * e);
        s -= step;
        if step * step <= SETTLED * (s * s) {
            if s.is_finite() && s < 0.0 && s * tau >= -1.0 {
                return s;
            }
            break;
        }
    }
    late_pole(tau)
}

/// the delay of a one-pole held at LATE_TOP: past it the pole of s + e^{-sτ} turns into a complex pair a one-pole
/// can't follow (the cutoffs over 0.39 fs of High 6, 0.33 fs of the pole of High 18); held as where it is a double one
fn late_tau(tau: f64) -> f64 {
    min(tau, LATE_TOP)
}

// under it the series of W₀ at its branch point is the root within 1e-13
const LATE_SERIES: f64 = 1e-3;

/// the pole of s + e^{-sτ} near the double one (Newton from -1 settles slowly there, or on another root): v = W₀(-τ)
/// from the series at its branch point (p = √(2(1 - eτ))), steps of Halley on v eᵛ + τ; s = v/τ
#[inline(never)]
fn late_pole(tau: f64) -> f64 {
    if tau <= 0.0 {
        return -1.0;
    }
    let p = sqrt(max(2.0 * (1.0 - core::f64::consts::E * tau), 0.0));
    let mut v = -1.0 + p * (1.0 + p * (-1.0 / 3.0 + p * (11.0 / 72.0 + p * (-43.0 / 540.0))));
    if p >= LATE_SERIES {
        for _ in 0..REAL_STEPS {
            let e = exp(v);
            let f = v * e + tau;
            let d1 = e * (v + 1.0);
            let step = f / (d1 - (e * (v + 2.0) * f) / (2.0 * d1));
            v -= step;
            if step * step <= SETTLED * (v * v) {
                break;
            }
        }
    }
    v / tau
}

// (|1 - x² + kx e^{-jxτ} j|², cos² + sin² = 1 taken out: a sine alone)
#[inline(never)]
fn svf_den2(x: f64, k: f64, tau: f64) -> f64 {
    let u = 1.0 - x * x;
    u * u + 2.0 * u * k * x * sin(x * tau) + k * k * x * x
}
#[inline(never)]
fn pole_den2(x: f64, tau: f64) -> f64 {
    1.0 - 2.0 * x * sin(x * tau) + x * x
}
fn tap_num2(tap: Tap, x: f64) -> f64 {
    match tap {
        Tap::Low => 1.0,
        Tap::High => x * x * x * x,
        Tap::Band => x * x,
        Tap::Peak => (1.0 - x * x) * (1.0 - x * x) + x * x,
        Tap::Notch => (1.0 - x * x) * (1.0 - x * x),
    }
}

// --- the design ---

/// a state variable filter (trapezoidal integrators of g, damping k), its output the mix of the input, the band and
/// the low
#[derive(Clone, Copy, PartialEq, Debug, Default)]
pub struct SvfSection {
    pub g: f64,
    pub k: f64,
    pub mix: [f64; 3],
}

/// a one-pole (trapezoidal, g), its output the mix of the input and the low
#[derive(Clone, Copy, PartialEq, Debug, Default)]
pub struct PoleSection {
    pub g: f64,
    pub mix: [f64; 2],
}

/// the saturation of the resonance of the first section and of the second (a 24 dB state variable filter): their
/// damping k0 - a·m, whether it clips (a ladder)
#[derive(Clone, Copy, PartialEq, Debug, Default)]
pub struct Saturation {
    pub k0: [f64; 2],
    pub a: [f64; 2],
    pub l: [f64; 2],
    pub clip: bool,
}

/// the sections of a type at its knobs, in the order they run: its state variable filters, its one-pole, then the
/// droop of the highs y = (1 - b) x + b x[n-1]; the gain into them (FAT), the saturation of the first section
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct ModelDesign {
    pub svf: [SvfSection; 2],
    pub svfs: usize,
    pub pole: Option<PoleSection>,
    pub droop: f64,
    pub fat: f64,
    pub sat: Saturation,
}

impl Default for ModelDesign {
    fn default() -> ModelDesign {
        ModelDesign {
            svf: Default::default(),
            svfs: 0,
            pole: None,
            droop: 0.0,
            fat: 1.0,
            sat: Saturation::default(),
        }
    }
}

type Den = (f64, f64);
type Numerator = [f64; 3];

#[inline(never)]
fn z_den(poles: [Complex; 2], w: f64) -> Den {
    let (p, q) = (poles[0], poles[1]);
    // a complex pair: one exponential, its conjugate the other; two real ones: no turn
    if p.1 != 0.0 {
        let zp = cexp((p.0 * 2.0 * w, p.1 * 2.0 * w));
        return (-2.0 * zp.0, zp.0 * zp.0 + zp.1 * zp.1);
    }
    let (zp, zq) = (exp(p.0 * 2.0 * w), exp(q.0 * 2.0 * w));
    (-(zp + zq), zp * zq)
}
#[inline(never)]
fn phi_of(theta: f64) -> f64 {
    let s = sin(theta / 2.0);
    s * s
}
fn den_at2((a1, a2): Den, phi: f64) -> f64 {
    let (p, m) = (1.0 + a1 + a2, 1.0 - a1 + a2);
    p * p * (1.0 - phi) + m * m * phi - 16.0 * a2 * phi * (1.0 - phi)
}
const THETA_H: f64 = (2.0 * PI) / 3.0;
// sin²(θh / 2) = sin²(π/3)
const PHI_H: f64 = 0.75;

#[inline(never)]
fn factor(b0: f64, b1: f64, b2: f64) -> Numerator {
    let r0 = sqrt(max(b0, 0.0));
    let r1 = sqrt(max(b1, 0.0));
    let w = 0.5 * (r0 + r1);
    let n0 = 0.5 * (w + sqrt(max(0.0, w * w + b2)));
    [n0, 0.5 * (r0 - r1), if n0 > 0.0 { -b2 / (4.0 * n0) } else { 0.0 }]
}

#[inline(never)]
fn free_numerator(a: Den, m2: &dyn Fn(f64) -> f64, theta_m: f64) -> Numerator {
    let b0 = m2(0.0) * den_at2(a, 0.0);
    let tm = min(theta_m, 0.9 * THETA_H);
    let tx = THETA_H;
    let (ph, pm) = (PHI_H, phi_of(tm));
    let rh = m2(tx) * den_at2(a, ph) - (1.0 - ph) * b0;
    let rm = m2(tm) * den_at2(a, pm) - (1.0 - pm) * b0;
    let (qh, qm) = (4.0 * ph * (1.0 - ph), 4.0 * pm * (1.0 - pm));
    let det = ph * qm - pm * qh;
    factor(b0, (rh * qm - rm * qh) / det, (ph * rm - pm * rh) / det)
}
#[inline(never)]
fn high_numerator(a: Den, m2: &dyn Fn(f64) -> f64) -> Numerator {
    let ph = PHI_H;
    let c = sqrt(m2(THETA_H) * den_at2(a, ph)) / (4.0 * ph);
    [c, -2.0 * c, c]
}
#[inline(never)]
fn band_numerator(a: Den, m2: &dyn Fn(f64) -> f64, theta_m: f64) -> Numerator {
    let tm = min(theta_m, 0.9 * THETA_H);
    let (ph, pm) = (PHI_H, phi_of(tm));
    let rh = (m2(THETA_H) * den_at2(a, ph)) / (4.0 * ph);
    let rm = (m2(tm) * den_at2(a, pm)) / (4.0 * pm);
    let det = (1.0 - ph) * pm - (1.0 - pm) * ph;
    let bb0 = max(0.0, (rh * pm - rm * ph) / det);
    let bb1 = max(0.0, ((1.0 - ph) * rm - (1.0 - pm) * rh) / det);
    let n0 = 0.5 * (sqrt(bb0) + sqrt(bb1));
    let n1 = 0.5 * (sqrt(bb0) - sqrt(bb1));
    [n0, n1 - n0, -n1]
}
#[inline(never)]
fn notch_numerator(a: Den, m2: &dyn Fn(f64) -> f64, theta_n: f64) -> Numerator {
    let c0 = cos(theta_n);
    let c = sqrt(m2(0.0) * den_at2(a, 0.0)) / (2.0 - 2.0 * c0);
    [c, -2.0 * c * c0, c]
}
const PEAK_ZEROS: f64 = 2.0;
#[inline(never)]
fn peak_numerator(a: Den, m2: &dyn Fn(f64) -> f64, w: f64) -> Numerator {
    let z = cexp((-w, sqrt(3.0) * w));
    let (c1, c2) = (-2.0 * z.0, z.0 * z.0 + z.1 * z.1);
    let c = sqrt(m2(0.0) * den_at2(a, 0.0)) / (1.0 + c1 + c2);
    [c, c * c1, c * c2]
}

#[inline(never)]
fn svf_of((a1, a2): Den, [b0, b1, b2]: Numerator) -> SvfSection {
    let g = sqrt((1.0 + a1 + a2) / (1.0 - a1 + a2));
    let k = (2.0 * (1.0 - a2)) / ((1.0 - a1 + a2) * g);
    let d0 = 1.0 + g * k + g * g;
    let x = (d0 * (b0 - b1 + b2)) / 4.0;
    SvfSection {
        g,
        k,
        mix: [
            x,
            (d0 * (b0 - b2)) / (2.0 * g) - x * k,
            (d0 * b1 - 2.0 * x * (g * g - 1.0)) / (2.0 * g * g),
        ],
    }
}

#[inline(never)]
fn pole_numerator(p: f64, m2: &dyn Fn(f64) -> f64, low: bool) -> [f64; 2] {
    let ph = PHI_H;
    let den = (1.0 - p) * (1.0 - p) * (1.0 - ph) + (1.0 + p) * (1.0 + p) * ph;
    if !low {
        let c = sqrt((m2(THETA_H) * den) / ph) / 2.0;
        return [c, -c];
    }
    let b0 = m2(0.0) * (1.0 - p) * (1.0 - p);
    let b1 = max(0.0, (m2(THETA_H) * den - b0 * (1.0 - ph)) / ph);
    [0.5 * (sqrt(b0) + sqrt(b1)), 0.5 * (sqrt(b0) - sqrt(b1))]
}
#[inline(never)]
fn pole_of(p: f64, b0: f64, b1: f64) -> PoleSection {
    let x = (b0 - b1) / (1.0 + p);
    PoleSection {
        g: (1.0 - p) / (1.0 + p),
        mix: [x, (b0 - x) / ((1.0 - p) / 2.0)],
    }
}

// the one-pole of a prototype of delay tau (its low or its high tap) at w, x_of the frequency of θ in cutoffs
fn pole_section(tau: f64, w: f64, low: bool, x_of: &dyn Fn(f64) -> f64) -> PoleSection {
    let tau = late_tau(tau);
    let p = exp(pole_pole(tau) * 2.0 * w);
    let m2 = |theta: f64| {
        let x = x_of(theta);
        (if low { 1.0 } else { x * x }) / pole_den2(x, tau)
    };
    let [b0, b1] = pole_numerator(p, &m2, low);
    pole_of(p, b0, b1)
}

#[inline(never)]
fn middle_of(poles: [Complex; 2], w: f64) -> f64 {
    let f = sqrt(hypot(poles[0].0, poles[0].1) * hypot(poles[1].0, poles[1].1));
    min(max(2.0 * w * f, PI / 4.0), 0.95 * PI)
}

// the droop y = (1 - b) x + b x[n-1]: b such that at θ = 2π/3 it is the droop of d2
#[inline(never)]
fn droop_of(d2: f64) -> f64 {
    let ab = (1.0 - exp(-d2 * (LN_10 / 90.0))) / 3.0;
    0.5 - sqrt(0.25 - ab)
}

/// the droop b (y = (1 - b) x + b x[n-1]) with `db` more of it at (f/fs)² = 1, its dB at θ = 2π/3 those of
/// `droop_of` (whose exp(-d2 ln 10 / 90) is 1 - 3 b (1 - b): no logarithm): the FX Filter of the reference droops more
/// than the filter of a voice (dsp/measurements/fxfilter.json)
pub fn more_droop(b: f64, db: f64) -> f64 {
    let ab = (1.0 - (1.0 - 3.0 * (b * (1.0 - b))) * exp(-db * (LN_10 / 90.0))) / 3.0;
    0.5 - sqrt(0.25 - ab)
}

const TOP_CUTOFF: f64 = 0.46;
const LATE_TOP: f64 = 1.0 / core::f64::consts::E;

/// the sections of type `ty` at its knobs (cutoff in Hz, resonance and variation 0..1) and the sample rate
pub fn model_design(
    ty: ModelType,
    cutoff: f64,
    resonance: f64,
    variation: f64,
    sample_rate: f64,
) -> ModelDesign {
    let s = structure(ty);
    let fc = min(max(cutoff, 1.0), TOP_CUTOFF * sample_rate);
    let r = min(max(resonance, 0.0), 1.0);
    let v = min(max(variation, 0.0), 1.0);
    let w = (PI * fc) / sample_rate;
    let f_of = |theta: f64| (theta * sample_rate) / (2.0 * PI);
    let x_of = |theta: f64| f_of(theta) / fc;
    let mut design = match s {
        Structure::Ladder { n, d2, .. } => ladder_design(n, d2, fc, r, v, w, sample_rate),
        Structure::Eq { tap, order, d2, d } => eq_design(tap, order, d2, d, fc, r, v, w, sample_rate),
        Structure::Pole { tap, d2, d } => ModelDesign {
            pole: Some(pole_section(2.0 * d * w, w, tap == Tap::Low, &x_of)),
            droop: droop_of(d2),
            ..ModelDesign::default()
        },
        Structure::Svf {
            tap,
            d2,
            d,
            second,
            pole,
        } => {
            let mut design = ModelDesign::default();
            let tau = 2.0 * d * w;
            let k = svf_damping(r, SVF_FLOOR);
            let gain = if tap == Tap::Notch { 1.0 } else { resonance_gain(r) };
            let section = |kk: f64, g: f64| {
                let poles = svf_poles(kk, tau);
                let a = z_den(poles, w);
                let m2 = |theta: f64| {
                    let x = x_of(theta);
                    (g * g * tap_num2(tap, x)) / svf_den2(x, kk, tau)
                };
                let theta_m = middle_of(poles, w);
                let b = match tap {
                    Tap::High => high_numerator(a, &m2),
                    Tap::Band => band_numerator(a, &m2, theta_m),
                    Tap::Notch => notch_numerator(a, &m2, min(2.0 * w, PI)),
                    Tap::Peak if 2.0 * w < PEAK_ZEROS => peak_numerator(a, &m2, w),
                    Tap::Peak => free_numerator(a, &m2, 2.0 * w),
                    Tap::Low => free_numerator(a, &m2, theta_m),
                };
                svf_of(a, b)
            };
            design.svf[0] = section(k, gain);
            design.svfs = 1;
            if let Some((c2, c3)) = second {
                design.svf[1] = section(c2 + (c3 * k * k) / 4.0, 1.0);
                design.svfs = 2;
            }
            if let Some(pd) = pole {
                design.pole = Some(pole_section(2.0 * pd * w, w, tap == Tap::Low, &x_of));
            }
            let stages = design.svfs + design.pole.is_some() as usize;
            design.droop = droop_of(d2 * stages as f64);
            design.fat = if tap == Tap::Notch { 1.0 } else { fat_factor(r, v) };
            design
        }
    };
    let (c, steep) = saturation_of(ty);
    let pass = |tap: Tap| {
        let p = if tap == Tap::Notch { 1.0 } else { 1.0 + 4.0 * r };
        if steep {
            p * sqrt(sqrt(p))
        } else {
            p
        }
    };
    let (rest, l) = match s {
        Structure::Ladder { n, rest, .. } => (
            LADDER_CLIPPED * ladder_rest_damping(rest),
            LADDER_CLIP * [2.0 * sqrt(2.0), 2.0, sqrt(2.0), 1.0][n as usize - 1],
        ),
        // (High and Peak not measured over 1 kHz: as they are)
        Structure::Svf { tap, .. } => (2.0, c * pass(tap) * if steep { 1.0 } else { svf_level_of(w) }),
        _ => (0.0, 0.0),
    };
    if l > 0.0 {
        let k = design.svf[0].k;
        let k0 = max(k, rest);
        let a = k0 - k;
        let clip = matches!(s, Structure::Ladder { .. });
        // (of a state variable filter × A; never 0: q is over it)
        design.sat.k0[0] = k0;
        design.sat.a[0] = a;
        design.sat.l[0] = if clip { l } else { max(l * a, 0.01) };
        design.sat.clip = clip;
        if let Structure::Svf {
            second: Some((c2, c3)),
            ..
        } = s
        {
            let k = design.svf[1].k;
            let k0 = max(k, c2 + c3);
            design.sat.k0[1] = k0;
            design.sat.a[1] = k0 - k;
            design.sat.l[1] = SECOND_LEVEL;
        }
    }
    design
}

#[inline(never)]
#[allow(clippy::too_many_arguments)]
fn eq_design(
    tap: Tap,
    order: u32,
    d2: f64,
    d: f64,
    fc: f64,
    r: f64,
    v: f64,
    w: f64,
    sample_rate: f64,
) -> ModelDesign {
    // (a one-pole: its delay held, of its tap and its pole alike)
    let tau = if order == 1 {
        late_tau(2.0 * d * w)
    } else {
        2.0 * d * w
    };
    let gain = eq_gain(v) - 1.0;
    let f_of = |theta: f64| (theta * sample_rate) / (2.0 * PI);
    let k = svf_damping(r, EQ_FLOOR);
    let tap_at = |x: f64| -> Complex {
        if order == 1 {
            let den = (cos(x * tau), x - sin(x * tau));
            return div(if tap == Tap::Low { (1.0, 0.0) } else { (0.0, x) }, den);
        }
        let den = (1.0 - x * x + k * x * sin(x * tau), k * x * cos(x * tau));
        let num = match tap {
            Tap::Low => (1.0, 0.0),
            Tap::High => (-x * x, 0.0),
            _ => (0.0, x),
        };
        div(num, den)
    };
    let m2 = |theta: f64| {
        let f = f_of(theta);
        let t = tap_at(f / fc);
        let dd = gain * pow(10.0, (-d2 * (f / sample_rate) * (f / sample_rate)) / 20.0);
        abs2((1.0 + dd * t.0, dd * t.1))
    };
    let mut design = ModelDesign::default();
    if order == 1 {
        let p = exp(pole_pole(tau) * 2.0 * w);
        let [b0, b1] = pole_numerator(p, &m2, true);
        design.pole = Some(pole_of(p, b0, b1));
        return design;
    }
    let poles = svf_poles(k, tau);
    let a = z_den(poles, w);
    design.svfs = 1;
    if tap == Tap::Band {
        design.svf[0] = svf_of(a, free_numerator(a, &m2, middle_of(poles, w)));
        return design;
    }
    // a shelf: the input + (G - 1) its tap of the phase of the prototype
    let (a1, a2) = a;
    let b = if tap == Tap::Low {
        let c = (1.0 + a1 + a2) / 4.0;
        [c, 2.0 * c, c]
    } else {
        let ph = PHI_H;
        let c = sqrt(abs2(tap_at(f_of(THETA_H) / fc)) * den_at2(a, ph)) / (4.0 * ph);
        [c, -2.0 * c, c]
    };
    let mut section = svf_of(a, b);
    section.mix = [
        1.0 + gain * section.mix[0],
        gain * section.mix[1],
        gain * section.mix[2],
    ];
    design.svf[0] = section;
    design
}

// cos and sin of π(2m + 1)/4, the turns of the pairs of poles of a ladder (Math.cos and Math.sin of them, one of them
// a bit under 1/√2: the test `the_turns_of_a_ladder_are_those_of_jsmath`)
#[allow(clippy::approx_constant)]
const LADDER_TURNS: [(f64, f64); 2] = [
    (0.7071067811865476, 0.7071067811865475),
    (-0.7071067811865475, 0.7071067811865476),
];

#[inline(never)]
fn ladder_design(n: u32, d2: f64, fc: f64, r: f64, v: f64, w: f64, sample_rate: f64) -> ModelDesign {
    let k = ladder_feedback_of(r, w);
    let q = sqrt(sqrt(k));
    let tune = ladder_tune_of(w);
    let pair = |m: usize| -> [Complex; 2] {
        let (cos_a, sin_a) = LADDER_TURNS[m];
        let p = ((-1.0 + q * cos_a) * tune, q * sin_a * tune);
        [p, (p.0, -p.1)]
    };
    let f_of = |theta: f64| (theta * sample_rate) / (2.0 * PI);
    let na = (4 - n).div_ceil(2);
    let nb = 4 - n - na;
    let quad2 =
        |p: Complex, x: f64| (p.0 * p.0 + (x - p.1) * (x - p.1)) * (p.0 * p.0 + (x + p.1) * (x + p.1));
    let section = |poles: [Complex; 2], power: u32| {
        let a = z_den(poles, w);
        let m2 = |theta: f64| {
            let x = f_of(theta) / fc;
            let mut num = 1.0;
            for _ in 0..power {
                num *= 1.0 + x * x;
            }
            num / quad2(poles[0], x)
        };
        svf_of(a, free_numerator(a, &m2, middle_of(poles, w)))
    };
    ModelDesign {
        svf: [section(pair(0), na), section(pair(1), nb)],
        svfs: 2,
        pole: None,
        droop: droop_of(d2),
        fat: fat_factor(r, v),
        sat: Saturation::default(),
    }
}

// --- the grid of the cutoff ---

/// A cell of the grid of the cutoff: 16 an octave, the doubles of one exponent and one top 4 bits of the mantissa
/// (the index and the share of a cutoff are bits of it: no logarithm). Its index, its edges (Hz), how far in the
/// cutoff is (0..1)
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Cell {
    pub index: u32,
    pub edges: [f64; 2],
    pub share: f32,
}

const SHARE_BITS: u32 = 48;

/// The cell of a cutoff among those a design takes as they are (from 1 Hz, both edges under the top cutoff of the
/// sample rate; None past them and of a NaN). A filter whose cutoff moves alone takes the coefficients between the
/// designs at the edges of its cell (`Coefs::between`), not a design of its own a span (a design costs some
/// sines): its response is the design's within 0.1 dB away from a resonance, its cutoff within 0.4 % (a cell is
/// 3 to 6 % wide, the steps of the integrators nearly lines of the cutoff across it), its sections stable (the
/// tests `between_the_designs_of_a_cell`)
pub fn cutoff_cell(cutoff: f64, sample_rate: f64) -> Option<Cell> {
    if !(1.0..32768.0).contains(&cutoff) {
        return None;
    }
    let bits = cutoff.to_bits();
    let exponent = (bits >> 52) - 1023;
    let fraction = bits & ((1 << SHARE_BITS) - 1);
    let low = f64::from_bits(bits - fraction);
    let width = f64::from_bits((exponent + 1023 - 4) << 52);
    if low + width > TOP_CUTOFF * sample_rate {
        return None;
    }
    Some(Cell {
        index: (exponent * 16 + ((bits >> SHARE_BITS) & 15)) as u32,
        edges: [low, low + width],
        share: (fraction as f64 / (1u64 << SHARE_BITS) as f64) as f32,
    })
}

// --- the sections in lanes of f32 ---

use crate::simd::{F32x4, U32x4};
use core::ops::{Add, Mul};

/// the coefficients of a design in f32: of each state variable filter the steps of its integrators and the shares of
/// its taps (c1, a2, a3 of the integrators, the input, the band halved, the low halved: the tick of the voice filter),
/// of the one-pole G = g / (1 + g) and its taps, of the droop 1 - b and b, the gain of Drive into the curve, the gain
/// into the sections (FAT); of the saturation of each section g, 2g, a·l², g·a·l², g + k0, 1 + g (g + k0), l², l
/// (`sat`), worked out of its g, k0, a, l (`saturation`: `sat_products`)
#[derive(Clone, Copy, PartialEq, Debug, Default)]
pub struct Coefs {
    pub svf: [[f32; 6]; 2],
    pub pole: [f32; 3],
    pub droop: [f32; 2],
    pub drive: f32,
    pub fat: f32,
    pub sat: [[f32; 8]; 2],
    pub saturation: [[f32; 4]; 2],
}

/// The saturation of a section as `sat_steps` reads it (g, 2g, a·l², g·a·l², g + k0, 1 + g (g + k0), l², l) of its
/// g, k0, a, l in f32: that of a design and that of each refresh along a line are this one function of them. A line
/// of the products themselves is no section: between two designs whose cutoff and resonance are far apart its g·a·l²
/// is over g times its a·l², its damping under 0 (a burst at a jump of both); along g, k0, a, l the damping of the
/// small signal, k0 - a, goes from that of one to that of the other
#[inline(always)]
pub fn sat_products<T: Copy + Add<Output = T> + Mul<Output = T>>([g, k0, a, l]: [T; 4], one: T) -> [T; 8] {
    let (l2, gk) = (l * l, g + k0);
    let al = a * l2;
    [g, g + g, al, g * al, gk, one + g * gk, l2, l]
}

/// the coefficients in f32 of a state variable filter of g, k and the shares of its taps (the input, the band, the
/// low): with d = 1 + g (g + k), c = 2 g (g + k) / d, 2 g / d and 2 g² / d of the integrators, then the input, the
/// band halved and the low halved (worked out in doubles: of a model type and of a BiquadFilterNode alike)
#[inline(always)]
pub fn svf_coefs(g: f64, k: f64, mix: [f64; 3]) -> [f32; 6] {
    let d = 1.0 + g * (g + k);
    [
        2.0 * g * (g + k) / d,
        2.0 * g / d,
        2.0 * g * g / d,
        mix[0],
        mix[1] / 2.0,
        mix[2] / 2.0,
    ]
    .map(|value| value as f32)
}

impl Coefs {
    pub fn of(design: &ModelDesign, drive: f64) -> Coefs {
        let svf = |s: &SvfSection| svf_coefs(s.g, s.k, s.mix);
        let pole = design.pole.unwrap_or_default();
        let sat = design.sat;
        let saturation: [[f32; 4]; 2] = core::array::from_fn(|i| {
            [design.svf[i].g, sat.k0[i], sat.a[i], sat.l[i]].map(|value| value as f32)
        });
        Coefs {
            svf: [svf(&design.svf[0]), svf(&design.svf[1])],
            pole: [pole.g / (1.0 + pole.g), pole.mix[0], pole.mix[1]].map(|value| value as f32),
            droop: [1.0 - design.droop, design.droop].map(|value| value as f32),
            drive: drive_gain(drive) as f32,
            fat: design.fat as f32,
            sat: saturation.map(|section| sat_products(section, 1.0)),
            saturation,
        }
    }

    /// the coefficients the share `t` of the way from these to `to`: a + (b - a) t of each, in f32 (the gain of
    /// Drive: these'; the saturation: its products of g, k0, a, l so: `sat_products`)
    pub fn between(&self, to: &Coefs, t: f32) -> Coefs {
        let mut out = *self;
        out.set_between(self, to, t);
        out
    }

    /// `between` of `from` and `to` in place (the gain of Drive stays)
    #[inline]
    pub fn set_between(&mut self, from: &Coefs, to: &Coefs, t: f32) {
        let share = F32x4::splat(t);
        let fours = |a: &[f32], b: &[f32], out: &mut [f32]| {
            for ((a, b), out) in a
                .chunks_exact(4)
                .zip(b.chunks_exact(4))
                .zip(out.chunks_exact_mut(4))
            {
                let (x, y) = (F32x4::load(a), F32x4::load(b));
                (x + (y - x) * share).store(out);
            }
        };
        fours(
            from.svf.as_flattened(),
            to.svf.as_flattened(),
            self.svf.as_flattened_mut(),
        );
        fours(
            from.saturation.as_flattened(),
            to.saturation.as_flattened(),
            self.saturation.as_flattened_mut(),
        );
        self.sat = self.saturation.map(|section| sat_products(section, 1.0));
        let one = |a: f32, b: f32| a + (b - a) * t;
        self.pole = core::array::from_fn(|k| one(from.pole[k], to.pole[k]));
        self.droop = core::array::from_fn(|k| one(from.droop[k], to.droop[k]));
        self.fat = one(from.fat, to.fat);
    }

    /// whether these, the coefficients between the designs at the edges of a cell at its middle, are those of
    /// `design`, the design there: the steps of the integrators within SMOOTH of theirs, the taps within it of the
    /// largest of their section, and the cutoff of each state variable filter off by under an eighth of the width of
    /// its resonance (k/8: its peak within 0.1 dB). A cell a design is not smooth across (its poles turn from a pair
    /// into two real ones, another numerator takes over) fails it, so does a resonance as narrow as the floor of the
    /// damping (Res 100 %)
    pub fn near(&self, design: &Coefs) -> bool {
        let narrow = self.offs(design).iter().any(|&(off, width)| off > width);
        if narrow {
            return false;
        }
        let close = |a: f32, b: f32, scale: f32| (a - b).abs() <= SMOOTH * scale.abs();
        let largest = |taps: &[f32]| {
            taps.iter().fold(
                0.0f32,
                |most, tap| if tap.abs() > most { tap.abs() } else { most },
            )
        };
        let sections = self.svf.iter().zip(&design.svf).all(|(ours, theirs)| {
            let taps = largest(&theirs[3..]);
            (0..3).all(|k| close(ours[k], theirs[k], theirs[k]))
                && (3..6).all(|k| close(ours[k], theirs[k], taps))
        });
        let taps = largest(&design.pole[1..]);
        sections
            && close(self.pole[0], design.pole[0], design.pole[0])
            && (1..3).all(|k| close(self.pole[k], design.pole[k], taps))
    }
}

impl Coefs {
    // of each state variable filter how far its cutoff is off that of `design` (|g/g' - 1|) and an eighth of the width
    // of its resonance there (k/8; a section without steps: 0 of 1). g and k of a section from its steps: c1 =
    // a2 (g + k), a3 = a2 g
    fn offs(&self, design: &Coefs) -> [(f64, f64); 2] {
        core::array::from_fn(|i| {
            let (ours, theirs) = (&self.svf[i], &design.svf[i]);
            let [c1, a2, a3] = [theirs[0], theirs[1], theirs[2]].map(|x| x as f64);
            if a2 == 0.0 {
                return (0.0, 1.0);
            }
            let (g, k) = (a3 / a2, c1 / a2 - a3 / a2);
            let g_ours = ours[2] as f64 / ours[1] as f64;
            ((g_ours / g - 1.0).abs(), k / 8.0)
        })
    }

    /// how far the cutoffs of these, between the designs at the edges of a cell at its middle, are off those of
    /// `design`, the design there, in eighths of the width of their resonance (over 1: not `near`). Far over it (a
    /// resonance as narrow as the floor of the damping) the cells next to it are not near either: the error of the
    /// middle of a cell is some square of its width, which is 3 to 6 % of its cutoff (4 times at most)
    pub fn narrowness(&self, design: &Coefs) -> f64 {
        self.offs(design)
            .iter()
            .fold(0.0, |most, &(off, width)| max(most, off / width))
    }
}

/// how near the coefficients between the edges of a cell are to the design at its middle where the design is smooth
/// across it (the steps of the integrators are lines of the cutoff and its square: 0.1 % off at most in a cell 6 %
/// wide)
const SMOOTH: f32 = 0.004;

/// the coefficients of the lanes: those of a voice in its lanes (two voices: 0 and 1, 2 and 3)
#[derive(Clone, Copy, Default)]
pub struct LaneCoefs {
    pub svf: [[F32x4; 6]; 2],
    pub pole: [F32x4; 3],
    pub droop: [F32x4; 2],
    pub drive: F32x4,
    pub fat: F32x4,
    pub sat: [[F32x4; 8]; 2],
    pub saturation: [[F32x4; 4]; 2],
}

impl LaneCoefs {
    pub fn of(p: &Coefs, q: &Coefs) -> LaneCoefs {
        let lanes = |a: f32, b: f32| F32x4::new(a, a, b, b);
        // (four coefficients of each at a time: two loads, four picks, no lane put in one by one)
        let fours = |p: &[f32], q: &[f32], out: &mut [F32x4]| {
            for ((p, q), out) in p
                .chunks_exact(4)
                .zip(q.chunks_exact(4))
                .zip(out.chunks_exact_mut(4))
            {
                let (p, q) = (F32x4::load(p), F32x4::load(q));
                out[0] = p.pick::<0, 0, 4, 4>(q);
                out[1] = p.pick::<1, 1, 5, 5>(q);
                out[2] = p.pick::<2, 2, 6, 6>(q);
                out[3] = p.pick::<3, 3, 7, 7>(q);
            }
        };
        let mut svf = [[F32x4::splat(0.0); 6]; 2];
        fours(p.svf.as_flattened(), q.svf.as_flattened(), svf.as_flattened_mut());
        let mut sat = [[F32x4::splat(0.0); 8]; 2];
        fours(p.sat.as_flattened(), q.sat.as_flattened(), sat.as_flattened_mut());
        let mut saturation = [[F32x4::splat(0.0); 4]; 2];
        fours(
            p.saturation.as_flattened(),
            q.saturation.as_flattened(),
            saturation.as_flattened_mut(),
        );
        LaneCoefs {
            svf,
            pole: core::array::from_fn(|k| lanes(p.pole[k], q.pole[k])),
            droop: core::array::from_fn(|k| lanes(p.droop[k], q.droop[k])),
            drive: lanes(p.drive, q.drive),
            fat: lanes(p.fat, q.fat),
            sat,
            saturation,
        }
    }

    /// its lanes where those of `mask` are set (all their bits or none), else those of `other` (the coefficients of
    /// one voice of two from another)
    #[inline(always)]
    pub fn pick(&self, other: &LaneCoefs, mask: U32x4) -> LaneCoefs {
        let pick = |a: F32x4, b: F32x4| a.or_else(mask, b);
        LaneCoefs {
            svf: core::array::from_fn(|i| core::array::from_fn(|k| pick(self.svf[i][k], other.svf[i][k]))),
            pole: core::array::from_fn(|k| pick(self.pole[k], other.pole[k])),
            droop: core::array::from_fn(|k| pick(self.droop[k], other.droop[k])),
            drive: pick(self.drive, other.drive),
            fat: pick(self.fat, other.fat),
            sat: core::array::from_fn(|i| core::array::from_fn(|k| pick(self.sat[i][k], other.sat[i][k]))),
            saturation: core::array::from_fn(|i| {
                core::array::from_fn(|k| pick(self.saturation[i][k], other.saturation[i][k]))
            }),
        }
    }

    /// its lanes 1 and 2 swapped: of `of(p, q)` p in the lanes 0 and 2, q in 1 and 3 (the left and the right
    /// channel of a stereo signal fed [L, R, L, R] each through its own filter)
    pub fn mixed(&self) -> LaneCoefs {
        let mix = |a: F32x4| a.pick::<0, 2, 1, 3>(a);
        LaneCoefs {
            svf: self.svf.map(|row| row.map(mix)),
            pole: self.pole.map(mix),
            droop: self.droop.map(mix),
            drive: mix(self.drive),
            fat: mix(self.fat),
            sat: self.sat.map(|row| row.map(mix)),
            saturation: self.saturation.map(|row| row.map(mix)),
        }
    }

    /// the step of coefficients that stay: -0 of each (x + -0 is x bit for bit, a -0 too)
    #[inline(always)]
    pub fn still() -> LaneCoefs {
        let still = F32x4::splat(-0.0);
        LaneCoefs {
            svf: [[still; 6]; 2],
            pole: [still; 3],
            droop: [still; 2],
            drive: still,
            fat: still,
            sat: [[still; 8]; 2],
            saturation: [[still; 4]; 2],
        }
    }

    /// The lanes onto the lines of their spans. Of the voices whose span starts here (`stepped`, a mask of their
    /// lanes) and is a line (`ramping`): the step `d` a refresh of what the sections of the layout read along the
    /// span, (`to` - these) × `inv` (1 / the refreshes of the span; of a saturating section its g, k0, a, l, the
    /// products `advance` works out of them); what is read at its ends alone (the steps of a section for its
    /// saturation, the gain of Drive for its curve: `keep_steps`, `drive_rest`) and the droop (a cutoff doesn't move
    /// it) is that of `to` at once; what the layout reads nowhere stays as it is (a pass has one layout, its first
    /// span starts from all the coefficients of the block before). Of the stepped voices whose span is no line the
    /// step is -0 (x + -0 is x bit for bit, a -0 too: their coefficients are those of `to` already). The others keep
    /// their steps
    #[inline(always)]
    pub fn steer(
        &mut self,
        d: &mut LaneCoefs,
        to: &LaneCoefs,
        layout: Layout,
        inv: F32x4,
        ramping: U32x4,
        stepped: U32x4,
    ) {
        let still = F32x4::splat(-0.0);
        // (every lane on a line from here: no lane picked, the same bits)
        let all = ramping.all();
        // `moves`: read along the span; else `ends`: read at its ends
        let line = |c: &mut F32x4, d: &mut F32x4, to: F32x4, moves: bool, ends: bool| {
            if moves {
                let step = (to - *c) * inv;
                *d = if all {
                    step
                } else {
                    step.or_else(ramping, still).or_else(stepped, *d)
                };
            } else if ends {
                *c = if all { to } else { to.or_else(stepped, *c) };
            }
        };
        line(&mut self.drive, &mut d.drive, to.drive, layout.drive, true);
        line(&mut self.fat, &mut d.fat, to.fat, layout.fat, false);
        let saturating = [layout.sat, layout.sat2];
        for i in 0..2 {
            let on = i < layout.svfs;
            for k in 0..3 {
                let moves = on && !saturating[i];
                line(&mut self.svf[i][k], &mut d.svf[i][k], to.svf[i][k], moves, true);
            }
            for k in 3..6 {
                line(&mut self.svf[i][k], &mut d.svf[i][k], to.svf[i][k], on, false);
            }
            for k in 0..4 {
                let moves = on && saturating[i];
                line(
                    &mut self.saturation[i][k],
                    &mut d.saturation[i][k],
                    to.saturation[i][k],
                    moves,
                    false,
                );
            }
        }
        for k in 0..3 {
            line(&mut self.pole[k], &mut d.pole[k], to.pole[k], layout.pole, false);
        }
        for k in 0..2 {
            line(&mut self.droop[k], &mut d.droop[k], to.droop[k], false, true);
        }
    }

    /// A refresh on along the line of a span (`d` of `steer`), before the `tick` of that refresh: what the sections of
    /// the layout read along the span (of a saturating section its g, k0, a, l in place of its steps, the products
    /// of its saturation worked out of them: those of a lane that stays are its own, `sat_products` of its g, k0, a, l
    /// as they are). Each coefficient by its place, no loop over them: they stay in registers through the samples of
    /// a span; their steps are read from memory (`step_of`: in registers too they would be more than there are, the
    /// state of the sections spilled at every sample)
    #[inline(always)]
    pub fn advance(&mut self, layout: Layout, step: &LaneCoefs) {
        #[inline(always)]
        fn section(c: &mut [F32x4; 6], d: &[F32x4; 6], saturating: bool) {
            if !saturating {
                c[0] = c[0] + step_of(&d[0]);
                c[1] = c[1] + step_of(&d[1]);
                c[2] = c[2] + step_of(&d[2]);
            }
            c[3] = c[3] + step_of(&d[3]);
            c[4] = c[4] + step_of(&d[4]);
            c[5] = c[5] + step_of(&d[5]);
        }
        #[inline(always)]
        fn saturation(sat: &mut [F32x4; 8], c: &mut [F32x4; 4], d: &[F32x4; 4]) {
            c[0] = c[0] + step_of(&d[0]);
            c[1] = c[1] + step_of(&d[1]);
            c[2] = c[2] + step_of(&d[2]);
            c[3] = c[3] + step_of(&d[3]);
            *sat = sat_products(*c, F32x4::splat(1.0));
        }
        if layout.drive {
            self.drive = self.drive + step_of(&step.drive);
        }
        if layout.fat {
            self.fat = self.fat + step_of(&step.fat);
        }
        if layout.svfs > 0 {
            section(&mut self.svf[0], &step.svf[0], layout.sat);
        }
        if layout.svfs > 1 {
            section(&mut self.svf[1], &step.svf[1], layout.sat2);
        }
        if layout.pole {
            self.pole[0] = self.pole[0] + step_of(&step.pole[0]);
            self.pole[1] = self.pole[1] + step_of(&step.pole[1]);
            self.pole[2] = self.pole[2] + step_of(&step.pole[2]);
        }
        if layout.svfs > 0 && layout.sat {
            saturation(&mut self.sat[0], &mut self.saturation[0], &step.saturation[0]);
        }
        if layout.svfs > 1 && layout.sat2 {
            saturation(&mut self.sat[1], &mut self.saturation[1], &step.saturation[1]);
        }
    }
}

// a step of the line of a span, read where it is at every refresh (not kept in a register over the loop)
#[inline(always)]
fn step_of(step: &F32x4) -> F32x4 {
    // (a reference: valid and aligned to read)
    unsafe { core::ptr::read_volatile(step) }
}

/// the state of the sections in lanes: the input of the curve of Drive before, the integrators of each state variable filter (the band, the low), the one-pole, the input
/// of the droop before (the output of the sections of a ladder: the level it clips by); of each saturating section the
/// steps of its integrators (c1, a2, a3) worked out last
#[derive(Clone, Copy, Default)]
pub struct LaneState {
    pub drive: F32x4,
    pub svf: [[F32x4; 2]; 2],
    pub pole: F32x4,
    pub droop: F32x4,
    pub sat: [[F32x4; 3]; 2],
}

impl LaneState {
    /// its lanes where those of `mask` are set (all their bits or none), else those of `other` (the state of one voice
    /// of two from another: no lane taken out and put back)
    #[inline(always)]
    pub fn pick(&self, other: &LaneState, mask: U32x4) -> LaneState {
        let pick = |a: F32x4, b: F32x4| a.or_else(mask, b);
        LaneState {
            drive: pick(self.drive, other.drive),
            svf: core::array::from_fn(|i| core::array::from_fn(|k| pick(self.svf[i][k], other.svf[i][k]))),
            pole: pick(self.pole, other.pole),
            droop: pick(self.droop, other.droop),
            sat: core::array::from_fn(|i| core::array::from_fn(|k| pick(self.sat[i][k], other.sat[i][k]))),
        }
    }

    /// the decaying state with no denormals (wasm has no flush to zero)
    #[inline(always)]
    pub fn flush(&mut self) {
        for section in self.svf.iter_mut() {
            section[0] = section[0].flush();
            section[1] = section[1].flush();
        }
        self.pole = self.pole.flush();
        self.droop = self.droop.flush();
        self.drive = self.drive.flush();
    }
}

/// A sample of the lanes through a state variable filter (also the one of a BiquadFilterNode type): the trapezoidal
/// integrators ic1 (the band) and ic2 (the low) step to n1 = 2 v1 - ic1 and n2 = 2 v2 - ic2 of the band v1 and the
/// low v2. Written so that a state is three operations from the one before (the loop waits for nothing else) and its
/// small shares are added to it, not folded into coefficients next to 1 (those would lose a low cutoff in f32)
#[inline(always)]
pub fn svf_tick(c: &[F32x4; 6], state: &mut [F32x4; 2], x: F32x4) -> F32x4 {
    svf_step([c[0], c[1], c[2]], c, state, x)
}

// a state variable filter of the steps k (c1, a2, a3) and the taps of c
#[inline(always)]
fn svf_step([c1, a2, a3]: [F32x4; 3], c: &[F32x4; 6], state: &mut [F32x4; 2], x: F32x4) -> F32x4 {
    let [_, _, _, m0, h1, h2] = *c;
    let [ic1, ic2] = *state;
    let v3 = x - ic2;
    let n1 = (ic1 - c1 * ic1) + a2 * v3;
    let n2 = (ic2 + a2 * ic1) + a3 * v3;
    let y = m0 * x + h1 * (ic1 + n1) + h2 * (ic2 + n2);
    *state = [n1, n2];
    y
}

// the steps of the integrators of a section with its resonance saturated by the level b: its damping k = k0 - a·l²/q
// (q = l² + b²/2; l·max(|b|, l) as it clips), 1 + g (g + k) over q: one division
#[inline(always)]
fn sat_steps(sc: &[F32x4; 8], b: F32x4, clip: bool) -> [F32x4; 3] {
    let [g, g2, al, gal, gk, e, l2, l] = *sc;
    let q = if clip {
        l * b.abs().max(l)
    } else {
        l2 + F32x4::splat(0.5) * (b * b)
    };
    let t = g2 / (e * q - gal);
    let a2 = q * t;
    [(gk * q - al) * t, a2, g * a2]
}

/// a span without the saturation keeps the steps of its sections for one with it (from its first sample they are
/// those of the small signal)
#[inline(always)]
pub fn keep_steps(c: &LaneCoefs, s: &mut LaneState) {
    s.sat[0] = [c.svf[0][0], c.svf[0][1], c.svf[0][2]];
    s.sat[1] = [c.svf[1][0], c.svf[1][1], c.svf[1][2]];
}

/// The curve of Drive on the input × its gain, antialiased as the reference has it: the curve averaged over each
/// sample (the middle of the step of its input and its distortion, the curve less its input, averaged: the difference
/// of its antiderivative over the step; a lowpass of cos(πf/fs), the images past nyquist down: a saw driven hard
/// keeps the highs of the reference's). The distortion is -c v³ of the input clipped to ±UT (v), less the excess e
/// of |u| past UT (its antiderivative -c v⁴/4 - e (UT/3 + e/2)): the difference of each part is a product of the
/// differences of v and of e, never one of two antiderivatives (those grow as u², f32 would lose the step in them).
/// A step under 1e-5: the curve at the middle of the two (worked out only when a lane has such a step: the bits are
/// those of picking it in every lane)
#[inline(always)]
fn drive(c: &LaneCoefs, s: &mut LaneState, x: F32x4) -> F32x4 {
    let u = x * c.drive;
    let before = s.drive;
    s.drive = u;
    let step = u - before;
    let clip = |u: F32x4| u.max(F32x4::splat(-UT)).min(F32x4::splat(UT));
    let (v0, v1) = (clip(before), clip(u));
    let (a0, a1) = (before.abs(), u.abs());
    let (b0, b1) = (v0.abs(), v1.abs());
    // (within ±UT both: 0, past it both on one side: the step, each without a rounding)
    let de = (a1 - a0) - (b1 - b0);
    let cubic = F32x4::splat(-CUBIC / 4.0) * ((v1 - v0) * (v1 + v0)) * (v1 * v1 + v0 * v0);
    let flat = de * (F32x4::splat(UT / 3.0) + F32x4::splat(0.5) * ((a0 - b0) + (a1 - b1)));
    let averaged = (cubic - flat) / step;
    let apart = step.abs().over(F32x4::splat(1e-5));
    let half = F32x4::splat(0.5) * (u + before);
    if apart.all() {
        return half + averaged;
    }
    half + averaged.or_else(apart, distortion(half))
}

// the distortion of the curve of Drive: the curve less its input, -c u³ up to UT, the flat top past it
#[inline(always)]
fn distortion(u: F32x4) -> F32x4 {
    let v = u.max(F32x4::splat(-UT)).min(F32x4::splat(UT));
    (v - F32x4::splat(CUBIC) * (v * (v * v))) - u
}

/// the curve of Drive left out over a span: its state takes the last input there (a span with it again starts from it,
/// no step from the input before the span without it)
#[inline(always)]
pub fn drive_rest(c: &LaneCoefs, s: &mut LaneState, x: F32x4) {
    s.drive = x * c.drive;
}

/// a sample of the lanes through the sections of a layout: Drive (its gain, then the curve), the state variable
/// filters, the one-pole, the droop (the layout read at every sample: one loop for every type, the branches the same
/// at every sample). `refresh`: the steps of the saturating sections worked out again (every 4 samples of a block)
#[inline(always)]
pub fn tick(layout: Layout, c: &LaneCoefs, s: &mut LaneState, x: F32x4, refresh: bool) -> F32x4 {
    let mut y = if layout.drive { drive(c, s, x) } else { x };
    if layout.fat {
        y = y * c.fat;
    }
    if layout.svfs > 0 {
        if layout.sat && refresh {
            // the level: the integrator of the band, the output of the sections of a ladder before (it clips there)
            let level = if layout.clip { s.droop } else { s.svf[0][0] };
            s.sat[0] = sat_steps(&c.sat[0], level, layout.clip);
            if layout.sat2 {
                s.sat[1] = sat_steps(&c.sat[1], s.svf[1][0], false);
            }
        }
        y = if layout.sat {
            svf_step(s.sat[0], &c.svf[0], &mut s.svf[0], y)
        } else {
            svf_tick(&c.svf[0], &mut s.svf[0], y)
        };
        if layout.svfs > 1 {
            y = if layout.sat2 {
                svf_step(s.sat[1], &c.svf[1], &mut s.svf[1], y)
            } else {
                svf_tick(&c.svf[1], &mut s.svf[1], y)
            };
        }
    }
    if layout.pole {
        let [g, x0, x1] = c.pole;
        let v = (y - s.pole) * g;
        let low = v + s.pole;
        s.pole = low + v;
        y = x0 * y + x1 * low;
    }
    let out = c.droop[0] * y + c.droop[1] * s.droop;
    s.droop = y;
    out
}

/// |H|² of a design at f (its sections and droop): the response the core plays, as model.ts draws it
pub fn design_gain2(design: &ModelDesign, f: f64, sample_rate: f64) -> f64 {
    let theta = (2.0 * PI * f) / sample_rate;
    let z1 = (cos(theta), -sin(theta));
    let z2 = mul(z1, z1);
    let mut gain = 1.0;
    for s in &design.svf[..design.svfs] {
        let (g, k) = (s.g, s.k);
        let d0 = 1.0 + g * k + g * g;
        let den = (
            d0 + 2.0 * (g * g - 1.0) * z1.0 + (1.0 - g * k + g * g) * z2.0,
            2.0 * (g * g - 1.0) * z1.1 + (1.0 - g * k + g * g) * z2.1,
        );
        let num = (
            s.mix[0] * den.0 + s.mix[1] * g * (1.0 - z2.0) + s.mix[2] * g * g * (1.0 + 2.0 * z1.0 + z2.0),
            s.mix[0] * den.1 + s.mix[1] * g * -z2.1 + s.mix[2] * g * g * (2.0 * z1.1 + z2.1),
        );
        gain *= abs2(num) / abs2(den);
    }
    if let Some(pole) = design.pole {
        let p = (1.0 - pole.g) / (1.0 + pole.g);
        let den = (1.0 - p * z1.0, -p * z1.1);
        let g = (1.0 - p) / 2.0;
        let num = (
            pole.mix[0] * den.0 + pole.mix[1] * g * (1.0 + z1.0),
            pole.mix[0] * den.1 + pole.mix[1] * g * z1.1,
        );
        gain *= abs2(num) / abs2(den);
    }
    design.fat * design.fat * gain * (1.0 - 2.0 * design.droop * (1.0 - design.droop) * (1.0 - z1.0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec::Vec;

    const RATE: f64 = 48000.0;

    // the lanes 0 and 1 of an impulse of `length` through a design (an amplitude the curve of Drive and the
    // saturation of the resonance leave be: the saturating section, with FAT if it gives back, plays the design)
    fn impulse_response(ty: ModelType, design: &ModelDesign, length: usize) -> Vec<f32> {
        let coefs = Coefs::of(design, 0.0);
        let c = LaneCoefs::of(&coefs, &coefs);
        let mut state = LaneState::default();
        let layout = Layout {
            fat: true,
            ..ty.layout()
        };
        (0..length)
            .map(|i| {
                let x = F32x4::splat(if i == 0 { 1e-3 } else { 0.0 });
                tick(layout, &c, &mut state, x, i % 4 == 0).lanes()[0] * 1e3
            })
            .collect()
    }

    // Res 1: the EQ types (no saturation) are damped by their floor, never ringing for good; those of Normal by
    // theirs, a tenth of it (their resonance saturates)
    #[test]
    fn the_floors_of_the_damping() {
        assert_eq!(svf_damping(1.0, EQ_FLOOR), EQ_FLOOR);
        assert_eq!(svf_damping(1.0, SVF_FLOOR), SVF_FLOOR);
        let eq = model_design(ModelType::LowEq12, 1000.0, 1.0, 0.75, 48000.0).svf[0].k;
        let normal = model_design(ModelType::Low12, 1000.0, 1.0, 0.0, 48000.0).svf[0].k;
        assert!(eq > 5.0 * normal, "{eq} {normal}");
    }

    // a design worked out with 0 for a knob its type is not designed by, its FAT then `fat_of`, is the design of
    // the knobs, bit for bit (the filter of a voice shares it among the values of that knob)
    #[test]
    fn a_design_is_of_the_knobs_it_is_designed_by() {
        for ty in MODEL_TYPES {
            let [by_res, by_var] = ty.designed_by();
            let notch = matches!(ty, ModelType::Notch12 | ModelType::Notch24);
            assert_eq!(ty.has_fat(), by_res && !by_var && !notch, "{ty:?}");
            for cutoff in [20.0, 150.0, 1000.0, 4000.0, 11000.0, 21000.0] {
                for r in [0.0, 0.05, 0.3, 0.7, 0.97, 1.0] {
                    for v in [0.0, 0.25, 0.6, 1.0] {
                        let design = model_design(ty, cutoff, r, v, RATE);
                        let mut alone = model_design(
                            ty,
                            cutoff,
                            if by_res { r } else { 0.0 },
                            if by_var { v } else { 0.0 },
                            RATE,
                        );
                        alone.fat = ty.fat_of(r, v);
                        assert_eq!(alone, design, "{ty:?} {cutoff} {r} {v}");
                    }
                }
            }
        }
    }

    #[test]
    fn the_turns_of_a_ladder_are_those_of_jsmath() {
        for (m, &(cos_a, sin_a)) in LADDER_TURNS.iter().enumerate() {
            let a = (PI * (2.0 * m as f64 + 1.0)) / 4.0;
            assert_eq!(cos_a.to_bits(), cos(a).to_bits());
            assert_eq!(sin_a.to_bits(), sin(a).to_bits());
        }
    }

    // the poles of the prototype under the cusp (some resonance: k up to 1.37), every τ up to the top of Peak: a pair
    // at every τ, a root of s² + k s e^{-sτ} + 1 within 1e-7 (the steps of Halley under τ 0.1), never those of τ = 0
    // (the next but one test: which pair). Nearly without resonance (k over K_CUSP) the next test holds them
    #[test]
    fn the_poles_of_the_prototype_settle() {
        let f = |s: Complex, k: f64, tau: f64| {
            let e = cexp((-s.0 * tau, -s.1 * tau));
            let se = mul(s, e);
            (s.0 * s.0 - s.1 * s.1 + k * se.0 + 1.0, 2.0 * s.0 * s.1 + k * se.1)
        };
        for ti in 1..=130 {
            let tau = ti as f64 * 0.005;
            for ki in 0..=137 {
                let k = max(ki as f64 * 0.01, 0.0001);
                let poles = svf_poles(k, tau);
                let scale = 1.0 + k * abs2(poles[0]);
                assert!(
                    poles[0].1 > 0.0 && poles[1] == (poles[0].0, -poles[0].1) && poles != svf_poles_of(k),
                    "k {k} tau {tau}: {poles:?}"
                );
                let residual = sqrt(abs2(f(poles[0], k, tau)));
                assert!(
                    residual < 1e-7 * scale,
                    "k {k} tau {tau}: {poles:?} leaves {residual:e}"
                );
            }
        }
    }

    // Nearly without resonance (k over K_CUSP, up to the 2.02 of a second section), every τ up to the top of Peak:
    // the poles against the roots of F(x) = x² + 1 - k x e^{xτ} found by bisection. The pair until it lands (τa), x1
    // and x2 while both are real, then x1 and the place x2 met x3 (τb, `meet_root`): never a root of the delay, a
    // pole that didn't settle or those of τ = 0. A real root is within 1e-9 of it away from a double one (Newton
    // halves its step there: within 2e-5 of it, the step it settles at), a pair leaves 1e-7 at most (the steps of
    // Halley under τ 0.1)
    #[test]
    fn the_poles_nearly_without_resonance_are_the_roots_on_the_real_axis() {
        let value = |x: f64, k: f64, tau: f64| x * x + 1.0 - k * x * exp(x * tau);
        let bisect = |g: &dyn Fn(f64) -> f64, mut a: f64, mut b: f64| {
            for _ in 0..200 {
                let c = 0.5 * (a + b);
                if g(a) * g(c) <= 0.0 {
                    b = c;
                } else {
                    a = c;
                }
            }
            0.5 * (a + b)
        };
        let meets = |x: f64| (x + 1.0 / x) * exp(-(x * x - 1.0) / (x * x + 1.0));
        let tau_of = |x: f64| (x * x - 1.0) / (x * (x * x + 1.0));
        assert!((meets(X_CUSP) - K_CUSP).abs() < 1e-14);
        let (mut pairs, mut windows, mut met_ones) = (0, 0, 0);
        for k in [
            1.3713, 1.372, 1.375, 1.381, 1.4, 1.45, 1.5, 1.532, 1.6, 1.644, 1.7, 1.8, 1.9, 1.95, 1.99, 1.999,
            2.0, 2.01, 2.02,
        ] {
            let xm = bisect(&|x| meets(x) - k, X_CUSP, X_TOP);
            let xa = if k >= 2.0 {
                1.0
            } else {
                bisect(&|x| meets(x) - k, 1.0, X_CUSP)
            };
            let (ta, tb) = (if k >= 2.0 { 0.0 } else { tau_of(xa) }, tau_of(xm));
            assert!(
                (meet_root(k) - xm).abs() < 1e-9,
                "k {k}: {} of {xm}",
                meet_root(k)
            );
            for i in 1..=6200 {
                let tau = i as f64 * 1e-4;
                let poles = svf_poles(k, tau);
                let at = || format!("k {k} tau {tau} (lands {ta}, meets {tb}): {poles:?}");
                // (how near a double root: there a root is found within the step Newton settles at)
                let near = (tau - ta).abs() < 2e-3 || (tau - tb).abs() < 2e-3;
                let within = if near { 2e-5 } else { 1e-9 };
                if tau >= tb + 1e-9 {
                    met_ones += 1;
                    let x1 = bisect(&|x| value(x, k, tau), 1e-9, xm);
                    assert!(poles[0].1 == 0.0 && poles[1] == (-meet_root(k), 0.0), "{}", at());
                    assert!((poles[0].0 + x1).abs() < 1e-9 * x1, "{}: x1 {x1}", at());
                } else if tau > ta + 1e-9 && tau < tb - 1e-9 {
                    windows += 1;
                    let x1 = bisect(&|x| value(x, k, tau), 1e-9, xa);
                    let x2 = bisect(&|x| value(x, k, tau), xa, xm);
                    assert!(poles[0].1 == 0.0 && poles[1].1 == 0.0, "{}", at());
                    assert!(
                        (poles[0].0 + x1).abs() < within * x1 && (poles[1].0 + x2).abs() < within * x2,
                        "{}: x1 {x1}, x2 {x2}",
                        at()
                    );
                } else if tau < ta - 1e-9 {
                    pairs += 1;
                    let s = poles[0];
                    let e = cexp((-s.0 * tau, -s.1 * tau));
                    let se = mul(s, e);
                    let residual = hypot(s.0 * s.0 - s.1 * s.1 + k * se.0 + 1.0, 2.0 * s.0 * s.1 + k * se.1);
                    assert!(
                        s.1 > 0.0 && poles[1] == (s.0, -s.1) && s.0 < 0.0 && residual < 1e-7,
                        "{}: leaves {residual:e}",
                        at()
                    );
                }
            }
        }
        assert!(
            pairs > 15000 && windows > 15000 && met_ones > 60000,
            "{pairs} {windows} {met_ones}"
        );
    }

    // Under the cusp (a damping under K_CUSP: Res over 1 %, the second sections at any) at every τ up to the top of
    // Peak the poles are the pair, never the real root that passes under it at the top of the cutoff, a pole that
    // didn't settle or those of τ = 0. The pair here: followed along τ at k 0.5 (far from the cusp, Newton from the
    // one before never leaves it), then along the damping up to the cusp in steps of 1e-3, of 1e-5 from 1.33 (the
    // pair turns fast about the cusp)
    #[test]
    fn the_poles_under_the_cusp_are_the_pair() {
        let newton = |mut s: Complex, k: f64, tau: f64| {
            for _ in 0..60 {
                let e = cexp((-s.0 * tau, -s.1 * tau));
                let se = mul(s, e);
                let f = (s.0 * s.0 - s.1 * s.1 + k * se.0 + 1.0, 2.0 * s.0 * s.1 + k * se.1);
                let de = mul(e, (1.0 - s.0 * tau, -s.1 * tau));
                let step = div(f, (2.0 * s.0 + k * de.0, 2.0 * s.1 + k * de.1));
                s = (s.0 - step.0, s.1 - step.1);
                if abs2(step) <= 1e-28 * abs2(s) {
                    break;
                }
            }
            s
        };
        let real = |k: f64, tau: f64| {
            let (mut a, mut b) = (0.0, 1e4);
            for _ in 0..200 {
                let c = 0.5 * (a + b);
                if c * c + 1.0 - k * c * exp(c * tau) > 0.0 {
                    a = c;
                } else {
                    b = c;
                }
            }
            0.5 * (a + b)
        };
        let mut from = svf_poles_of(0.5)[0];
        let (mut checked, mut passed) = (0, 0);
        for ti in 1..=310 {
            let tau = ti as f64 * 0.002;
            from = newton(from, 0.5, tau);
            let (mut s, mut k) = (from, 0.5);
            let mut i = 0;
            while k < 1.371 {
                k = if k < 1.33 - 1e-9 { k + 1e-3 } else { k + 1e-5 };
                s = newton(s, k, tau);
                assert!(
                    s.1 > 0.05 && s.0 < 0.0,
                    "k {k} tau {tau}: the pair is lost at {s:?}"
                );
                i += 1;
                if i % 10 != 0 {
                    continue;
                }
                // (and the pair without the real root, where Halley would not settle on it)
                for poles in [svf_poles(k, tau), deflated_pair(k, tau)] {
                    let off = hypot(poles[0].0 - s.0, poles[0].1 - s.1);
                    assert!(
                        off < 1e-6 * hypot(s.0, s.1) && poles[1] == (poles[0].0, -poles[0].1),
                        "k {k} tau {tau}: {poles:?} of {s:?}"
                    );
                }
                checked += 1;
                // (the real root nearer than the pair: it has passed under it)
                if real(k, tau) < -s.0 {
                    passed += 1;
                }
            }
        }
        assert!(checked > 100000 && passed > 10000, "{checked} {passed}");
    }

    // The design along the cutoff, every type of a state variable filter from 0.02 fs up to the top: no step of a
    // section (g and k against themselves, a tap against the largest) over 0.1 % a step of 0.005 % of the cutoff
    // (1 % of a Peak: its second pole is nearer). Nearly without resonance (Res 0 to 0.8 %: where the poles of the
    // prototype are real) x2 meets x3 and the second pole turns as a square root (a step of 0.03 % at most there, of
    // a Peak 0.3 %); a pole that jumped to another root moved a section by 5 % to some hundred times (clicks of a
    // sweep through 0.22 to 0.31 fs). With resonance (Res 1 to 100 %; about the cusp, Res 1 %, the pair and the
    // real root trade places fast: 0.09 %, a Peak 0.9 %; at Res 100 % the damping of a High at its floor moves
    // 0.101 % at the top): the pair wherever the real root is, a pole that went to it moved a section by 80 % to ten
    // times (Res 2 to 10 %, the second section of a Peak 24 at any; clicks of a sweep through 0.26 to 0.45 fs). Aside:
    // the numerator of a Peak, another one from a cutoff of fs/π (PEAK_ZEROS); the EQ types with resonance at a
    // DB of 0.25 (fully cut, DB 0, the band of Band EQ 12 leaves its numerator as a square root: not a pole)
    #[test]
    fn the_design_is_continuous_along_the_cutoff() {
        const RATE: f64 = 48000.0;
        let step_of = |from: &ModelDesign, to: &ModelDesign| {
            let mut most = 0.0;
            for (p, q) in from.svf[..from.svfs].iter().zip(&to.svf) {
                let taps = q.mix.iter().fold(1.0, |m, x| max(m, x.abs()));
                most = max(most, (q.g / p.g - 1.0).abs());
                most = max(most, (q.k / p.k - 1.0).abs());
                for (a, b) in p.mix.iter().zip(&q.mix) {
                    most = max(most, (b - a).abs() / taps);
                }
            }
            most
        };
        let sweep = |ty: ModelType, r: f64, v: f64, ratio: f64, from: f64| {
            let peak = matches!(ty, ModelType::Peak12 | ModelType::Peak24);
            let zeros = PEAK_ZEROS * RATE / (2.0 * PI);
            let (mut f, mut most, mut at) = (from, 0.0, 0.0);
            let mut before = model_design(ty, f, r, v, RATE);
            while f * ratio < TOP_CUTOFF * RATE {
                let to = f * ratio;
                let design = model_design(ty, to, r, v, RATE);
                let step = step_of(&before, &design);
                if step > most && !(peak && f < zeros && to >= zeros) {
                    (most, at) = (step, to);
                }
                (f, before) = (to, design);
            }
            (most, at)
        };
        for ty in MODEL_TYPES {
            let (peak, eq) = match structure(ty) {
                Structure::Svf { tap, .. } => (tap == Tap::Peak, false),
                Structure::Eq { order: 2, .. } => (false, true),
                _ => continue,
            };
            for r in [0.0, 2e-5, 2e-4, 0.001, 0.003, 0.008] {
                let (most, at) = sweep(ty, r, 0.0, 1.00005, 0.02 * RATE);
                assert!(
                    most < if peak { 0.01 } else { 0.001 },
                    "{ty:?} Res {r}: a step of {most:e} at {at} Hz"
                );
            }
            for r in [
                0.0092, 0.0096, 0.0099, 0.0105, 0.012, 0.02, 0.03, 0.05, 0.1, 0.2, 0.5, 1.0,
            ] {
                let (most, at) = sweep(ty, r, if eq { 0.25 } else { 0.0 }, 1.00005, 0.02 * RATE);
                let top = if r == 1.0 { 1.2 } else { 1.0 };
                assert!(
                    most < top * if peak { 0.01 } else { 0.001 },
                    "{ty:?} Res {r}: a step of {most:e} at {at} Hz"
                );
            }
        }
        // (the sweep of the preset that clicked, a step of 0.001 %: Low 24 from 0.2 fs)
        let (most, at) = sweep(ModelType::Low24, 0.0, 0.0, 1.00001, 0.2 * RATE);
        assert!(most < 1e-4, "a step of {most:e} at {at} Hz");
    }

    #[test]
    fn the_sections_in_lanes_play_the_design() {
        for ty in MODEL_TYPES {
            for (cutoff, resonance, variation) in
                [(200.0, 0.0, 0.0), (1000.0, 0.5, 0.25), (6000.0, 0.8, 0.75)]
            {
                let design = model_design(ty, cutoff, resonance, variation, RATE);
                let h = impulse_response(ty, &design, 1 << 15);
                for f in [50.0, 300.0, 1000.0, 3000.0, 9000.0, 15000.0] {
                    let w = 2.0 * PI * f / RATE;
                    let (mut re, mut im) = (0.0, 0.0);
                    for (n, v) in h.iter().enumerate() {
                        re += *v as f64 * cos(w * n as f64);
                        im -= *v as f64 * sin(w * n as f64);
                    }
                    let played = 10.0 * jsmath::log10(re * re + im * im);
                    let designed = 10.0 * jsmath::log10(design_gain2(&design, f, RATE));
                    // (to -80 dB: where f32 still holds the tail)
                    if designed > -80.0 {
                        assert!(
                            (played - designed).abs() < 0.02,
                            "{ty:?} {cutoff} Hz {resonance} {variation} at {f} Hz: {played} dB played, {designed} designed"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn its_sections_are_stable_wherever_the_knobs_are() {
        for ty in MODEL_TYPES {
            for rate in [44100.0, 48000.0, 96000.0] {
                for cutoff in [8.0, 30.0, 200.0, 2000.0, 12000.0, 22050.0, 40000.0] {
                    for resonance in [0.0, 0.3, 0.9, 1.0] {
                        for variation in [0.0, 0.5, 1.0] {
                            let d = model_design(ty, cutoff, resonance, variation, rate);
                            for s in &d.svf[..d.svfs] {
                                assert!(
                                    s.g > 0.0 && s.k > 0.0 && s.mix.iter().all(|m| m.is_finite()),
                                    "{ty:?} {rate} {cutoff} {resonance} {variation} {s:?}"
                                );
                            }
                            if let Some(p) = d.pole {
                                assert!(p.g > 0.0 && p.mix.iter().all(|m| m.is_finite()), "{ty:?} {p:?}");
                            }
                            assert!((0.0..0.5).contains(&d.droop));
                        }
                    }
                }
            }
        }
    }

    // the pole of s + e^{-sτ} up to τ = 1/e, where it is a double one: the principal root (s τ ≥ -1), settled
    #[test]
    fn the_pole_of_a_late_one_pole() {
        for i in 0..=10000 {
            let tau = min(i as f64 * 1e-4, LATE_TOP);
            let s = pole_pole(tau);
            let residual = (s + exp(-s * tau)).abs();
            assert!(
                s.is_finite() && s < 0.0 && s * tau >= -1.0 && residual < 1e-9 * s.abs(),
                "tau {tau}: {s} leaves {residual:e}"
            );
        }
        assert!((pole_pole(LATE_TOP) + core::f64::consts::E).abs() < 1e-6);
    }

    // every cutoff up to the top (every 1/48 octave, every 10 Hz over 8 kHz: a pole that turned unstable did so in
    // windows of some 100 Hz): every section stable, the response finite
    #[test]
    fn no_cutoff_up_to_the_top_has_an_unstable_section() {
        for rate in [44100.0, 48000.0, 96000.0] {
            let top = TOP_CUTOFF * rate;
            let mut cutoffs: Vec<f64> = (0..)
                .map(|i| pow(2.0, i as f64 / 48.0))
                .take_while(|&f| f < 8000.0)
                .collect();
            cutoffs.extend((0..).map(|i| 8000.0 + 10.0 * i as f64).take_while(|&f| f < top));
            cutoffs.push(top);
            for ty in MODEL_TYPES {
                for (resonance, variation) in [(0.0, 0.0), (0.5, 1.0), (1.0, 0.0)] {
                    for &cutoff in &cutoffs {
                        let d = model_design(ty, cutoff, resonance, variation, rate);
                        let at = || format!("{ty:?} {rate} {cutoff} Hz {resonance} {variation}");
                        for s in &d.svf[..d.svfs] {
                            assert!(
                                s.g > 0.0 && s.k > 0.0 && s.mix.iter().all(|m| m.is_finite()),
                                "{} {s:?}",
                                at()
                            );
                        }
                        if let Some(p) = d.pole {
                            assert!(p.g > 0.0 && p.mix.iter().all(|m| m.is_finite()), "{} {p:?}", at());
                        }
                        assert!((0.0..0.5).contains(&d.droop), "{}", at());
                        assert!(design_gain2(&d, 0.25 * rate, rate).is_finite(), "{}", at());
                    }
                }
            }
        }
    }

    #[test]
    fn drive_is_the_gain_into_the_curve_of_the_reference() {
        assert_eq!(drive_gain(0.0), 1.0);
        assert_eq!(drive_gain(1.0), 16.0);
        assert_eq!(drive_gain(0.5), 5.0625);
        // the curve: a cubic up to UT, flat past it at 2 UT / 3 (a held input: its distortion averaged over no step,
        // the curve itself)
        let curve = |x: f32| {
            let c = Coefs {
                drive: 1.0,
                fat: 1.0,
                droop: [1.0, 0.0],
                ..Default::default()
            };
            let mut state = LaneState::default();
            let layout = Layout {
                svfs: 0,
                pole: false,
                drive: true,
                sat: false,
                sat2: false,
                clip: false,
                fat: false,
            };
            let lanes = LaneCoefs::of(&c, &c);
            tick(layout, &lanes, &mut state, F32x4::splat(x), true);
            tick(layout, &lanes, &mut state, F32x4::splat(x), true).lanes()[0]
        };
        assert!((curve(10.0) - 2.0 * UT / 3.0).abs() < 1e-5);
        assert_eq!(curve(10.0), -curve(-10.0));
        assert!((curve(0.1) - (0.1 - CUBIC * 0.001)).abs() < 1e-7);
    }

    #[test]
    fn the_distortion_of_drive_is_averaged_over_each_step() {
        // a ramp through the knee: each output the mean of the curve over the step from the input before
        let c = Coefs {
            drive: 1.0,
            fat: 1.0,
            droop: [1.0, 0.0],
            ..Default::default()
        };
        let lanes = LaneCoefs::of(&c, &c);
        let layout = Layout {
            svfs: 0,
            pole: false,
            drive: true,
            sat: false,
            sat2: false,
            clip: false,
            fat: false,
        };
        let mut state = LaneState::default();
        let exact = |u: f64| {
            let ut = UT as f64;
            let v = u.clamp(-ut, ut);
            v - (CUBIC as f64) * v * v * v
        };
        let mut before = 0.0f64;
        for i in 0..200 {
            let u = -8.0 + 0.08 * i as f64;
            let y = tick(layout, &lanes, &mut state, F32x4::splat(u as f32), true).lanes()[0] as f64;
            // the mean of the curve over [before, u] by the midpoint rule of 64 points: of its distortion, plus the
            // middle of the step
            let mean = (0..64)
                .map(|k| {
                    let t = before + (u - before) * (k as f64 + 0.5) / 64.0;
                    exact(t) - t
                })
                .sum::<f64>()
                / 64.0;
            if i > 0 {
                let middle = 0.5 * (u + before);
                assert!(
                    (y - (middle + mean)).abs() < 2e-4,
                    "{u}: {y} against {}",
                    middle + mean
                );
            }
            before = u;
        }
    }

    // Drive 100 (× 16) on a low sine: past UT the antiderivative grows as u² (some -80 at u 16), its steps near a peak
    // are some 1e-4: the mean of the step as a difference of two of them in f32 would be off by ulp/step (some 0.03)
    #[test]
    fn a_hard_drive_of_a_slow_input_is_averaged_without_a_loss() {
        let c = Coefs {
            drive: 16.0,
            fat: 1.0,
            droop: [1.0, 0.0],
            ..Default::default()
        };
        let lanes = LaneCoefs::of(&c, &c);
        let layout = Layout {
            svfs: 0,
            pole: false,
            drive: true,
            sat: false,
            sat2: false,
            clip: false,
            fat: false,
        };
        let (ut, cubic) = (UT as f64, CUBIC as f64);
        let antiderivative = |u: f64| {
            let v = u.clamp(-ut, ut);
            let e = u.abs() - v.abs();
            -cubic * (v * v) * (v * v) / 4.0 - e * (ut / 3.0 + e / 2.0)
        };
        let curve = |u: f64| {
            let v = u.clamp(-ut, ut);
            v - cubic * v * v * v
        };
        let mut state = LaneState::default();
        let mut before = 0.0f64;
        let mut worst = 0.0f64;
        for i in 0..1200 {
            let x = sin(2.0 * PI * 40.0 * i as f64 / 48000.0) as f32;
            let y = tick(layout, &lanes, &mut state, F32x4::splat(x), true).lanes()[0] as f64;
            let u = (x * 16.0) as f64;
            let exact = if (u - before).abs() < 1e-5 {
                curve(0.5 * (u + before))
            } else {
                0.5 * (u + before) + (antiderivative(u) - antiderivative(before)) / (u - before)
            };
            worst = max(worst, (y - exact).abs());
            before = u;
        }
        assert!(worst < 1e-5, "{worst}");
    }

    #[test]
    fn db_is_the_gain_of_the_band_of_the_eq_types() {
        assert_eq!(eq_gain(0.0), 0.0);
        assert_eq!(eq_gain(0.5), 1.0);
        assert_eq!(eq_gain(1.0), 9.0);
        assert_eq!(eq_gain(0.75), 2.0);
        assert!((eq_gain(0.25) - 0.875).abs() < 1e-12);
    }
}

#[cfg(test)]
mod saturation {
    use super::*;
    extern crate std;
    use alloc::string::String;
    use alloc::vec::Vec;

    const RATE: f64 = 48000.0;

    // the rows of a table `key` of a file of the measurements: its name, then its numbers
    fn rows_of(file: &str, key: &str) -> Vec<(String, Vec<f64>)> {
        let path = std::format!("{}/../measurements/{file}", env!("CARGO_MANIFEST_DIR"));
        let text = std::fs::read_to_string(path).unwrap();
        let from = text.find(&std::format!("\"{key}\": [")).unwrap();
        text[from..]
            .lines()
            .skip(1)
            .take_while(|line| line.trim_start().starts_with("[\""))
            .map(|line| {
                let line = line.trim().trim_end_matches(',');
                let name = line.split('"').nth(1).unwrap().into();
                let numbers = line
                    .split([',', '[', ']'])
                    .filter_map(|part| part.trim().parse().ok())
                    .collect();
                (name, numbers)
            })
            .collect()
    }

    // the rows `fat` of the measurements: a sine at the cutoff (B5, 987.77 Hz) of each amplitude through a type at
    // Res and FAT, its fundamental (dB over the input) and its harmonics 2..7 (dB under the fundamental)
    fn measured() -> Vec<(String, f64, f64, f64, f64, Vec<f64>)> {
        rows_of("filter-types.json", "fat")
            .into_iter()
            .map(|(name, n)| (name, n[0], n[1], n[2], n[3], n[4..].to_vec()))
            .collect()
    }

    fn type_of(name: &str) -> ModelType {
        use ModelType::*;
        match name {
            "Low 12" => Low12,
            "Low 24" => Low24,
            "High 12" => High12,
            "Band 12" => Band12,
            "Peak 12" => Peak12,
            "MG Low 12" => Ladder12,
            "MG Low 24" => Ladder24,
            _ => panic!("{name}"),
        }
    }

    // the fundamental of a sine of `amplitude` at the cutoff through the lanes (dB over the input), its 3rd and 5th
    // harmonics (dB under it): 0.5..1.5 s read (a Hann window), as the renders
    pub fn sine_at_cutoff(ty: ModelType, resonance: f64, fat: f64, amplitude: f64) -> [f64; 3] {
        sine_at(
            ty,
            440.0 * jsmath::pow(2.0, 14.0 / 12.0),
            resonance,
            fat,
            amplitude,
        )
    }

    // the same at a cutoff of its own
    fn sine_at(ty: ModelType, cutoff: f64, resonance: f64, fat: f64, amplitude: f64) -> [f64; 3] {
        let design = model_design(ty, cutoff, resonance, fat, RATE);
        let coefs = Coefs::of(&design, 0.0);
        let c = LaneCoefs::of(&coefs, &coefs);
        let layout = Layout {
            fat: true,
            ..ty.layout()
        };
        let mut state = LaneState::default();
        let (n, from) = (72000, 24000);
        let mut sums = [(0.0, 0.0); 3];
        let mut weights = 0.0;
        for i in 0..n {
            let phase = 2.0 * PI * cutoff * i as f64 / RATE;
            let x = F32x4::splat((amplitude * sin(phase)) as f32);
            let y = tick(layout, &c, &mut state, x, i % 4 == 0).lanes()[0] as f64;
            state.flush();
            if i >= from {
                let w = 0.5 - 0.5 * cos(2.0 * PI * (i - from) as f64 / (n - from - 1) as f64);
                for (k, h) in [1.0, 3.0, 5.0].iter().enumerate() {
                    sums[k].0 += y * w * cos(h * phase);
                    sums[k].1 += y * w * sin(h * phase);
                }
                weights += w;
            }
        }
        let amplitude_of = |(re, im): (f64, f64)| 2.0 * jsmath::sqrt(re * re + im * im) / weights;
        let h1 = amplitude_of(sums[0]);
        let db = |x: f64| 20.0 * jsmath::log10(max(x, 1e-30));
        [
            db(h1 / amplitude),
            db(amplitude_of(sums[1]) / h1),
            db(amplitude_of(sums[2]) / h1),
        ]
    }

    // The tolerances, from the measurements: the level within 0.85 dB (a ladder 1.1: its resonance of Res 0.9 0.76
    // over the reference's), a quiet sine (0.001, the resonance of Res 1 among them) within 1 dB (a ladder at Res 1
    // 1.5); the 3rd harmonic
    // where the reference's is over -60 dB within 1.7 dB (High 12 2.2). Deliberate differences: a ladder gives more 3rd
    // harmonic than the reference as it clips (MG Low 24 to 3 dB, MG Low 12 to 12 dB as it starts to clip: its level
    // as the reference's, FAT included, held instead) and none under its clip (the reference's under -60 dB there);
    // h5 not held
    // (cargo test --release -p dsp-core saturation -- --nocapture: the table)
    #[test]
    fn the_resonance_saturates_as_the_reference() {
        let rows = measured();
        assert_eq!(rows.len(), 7 * 3 * 3 * 6);
        let mut failures = Vec::new();
        for (name, resonance, fat, amplitude, gain, harmonics) in &rows {
            let ty = type_of(name);
            let [level, h3, h5] = sine_at_cutoff(ty, *resonance, *fat, *amplitude);
            let ladder = name.starts_with("MG");
            std::println!(
                "{name:9} r {resonance} v {fat} a {amplitude:6}: level {:+.2}, h3 {:+.1} ({}), h5 {:+.1} ({})",
                level - gain,
                h3 - harmonics[1],
                harmonics[1],
                h5 - harmonics[3],
                harmonics[3],
            );
            // (a ladder at Res 1 under its clip: a cent off its peak, a few cents wide, is 1.3 dB: its peak by the cutoff
            // held by the spec filter-resonance-measured)
            let quiet = if ladder && *resonance == 1.0 { 1.5 } else { 1.0 };
            let tolerance = if *amplitude == 0.001 || (ladder && *resonance == 1.0 && *amplitude == 0.03) {
                quiet
            } else if ladder {
                1.1
            } else {
                0.85
            };
            if (level - gain).abs() >= tolerance {
                failures.push(std::format!(
                    "{name} Res {resonance} FAT {fat} at {amplitude}: {level} dB, the reference {gain}"
                ));
            }
            let third = match ty {
                ModelType::High12 => 2.2,
                ModelType::Ladder24 => 3.0,
                ModelType::Ladder12 => 12.5,
                _ => 1.7,
            };
            if harmonics[1] > -60.0 && (h3 - harmonics[1]).abs() >= third {
                failures.push(std::format!(
                    "{name} Res {resonance} FAT {fat} at {amplitude}: h3 {h3} dB, the reference {}",
                    harmonics[1]
                ));
            }
        }
        assert!(failures.is_empty(), "{failures:#?}");
    }

    // The rows `levels` of filter-resonance.json: a sine at the cutoff from 131 Hz to 6.3 kHz (MG Low 12 and 24, Low
    // and Band 12 at Res 0.9 and 1) by its amplitude: the level of the saturated resonance (0.1 and louder) within
    // 1 dB, over 3 kHz 1.5 dB. Deliberate differences: a sine of full scale over 3 kHz to 2.5 dB (the steps of a
    // saturating section worked out every 4 samples); the quieter ones (the small signal of a narrow resonance at Res 1, a cent off it some dB:
    // the spec filter-resonance-measured holds its peak)
    #[test]
    fn the_resonance_saturates_by_the_cutoff() {
        let rows = rows_of("filter-resonance.json", "levels");
        assert_eq!(rows.len(), 4 * 2 * 7 * 5);
        let mut failures = Vec::new();
        for (name, n) in &rows {
            let (resonance, note, amplitude, gain) = (n[0], n[1], n[2], n[3]);
            if amplitude < 0.1 {
                continue;
            }
            let cutoff = 440.0 * jsmath::pow(2.0, (note - 69.0) / 12.0);
            let [level, ..] = sine_at(type_of(name), cutoff, resonance, 0.0, amplitude);
            let tolerance = match (cutoff > 3000.0, amplitude == 1.0) {
                (true, true) => 2.5,
                (true, false) => 1.5,
                _ => 1.0,
            };
            std::println!(
                "{name:9} r {resonance} {cutoff:6.0} Hz a {amplitude}: {:+.2}",
                level - gain
            );
            if (level - gain).abs() >= tolerance {
                failures.push(std::format!(
                    "{name} Res {resonance} at {cutoff:.0} Hz, {amplitude}: {level:.2} dB, the reference {gain}"
                ));
            }
        }
        assert!(failures.is_empty(), "{failures:#?}");
    }

    #[test]
    fn a_ring_of_res_1_decays_and_stays_bounded() {
        // a loud burst at the cutoff, then silence: the ring under the burst and going down (no self-oscillation,
        // FAT's give-back no bloom)
        for ty in MODEL_TYPES.into_iter().filter(|ty| ty.layout().sat) {
            for fat in [0.0, 1.0] {
                let cutoff = 440.0 * jsmath::pow(2.0, 14.0 / 12.0);
                let design = model_design(ty, cutoff, 1.0, fat, RATE);
                let coefs = Coefs::of(&design, 0.0);
                let c = LaneCoefs::of(&coefs, &coefs);
                let layout = Layout {
                    fat: true,
                    ..ty.layout()
                };
                let mut state = LaneState::default();
                let mut peaks = [0.0f32; 8];
                for i in 0..48000 * 2 {
                    let x = if i < 12000 {
                        sin(2.0 * PI * cutoff * i as f64 / RATE) as f32
                    } else {
                        0.0
                    };
                    let y = tick(layout, &c, &mut state, F32x4::splat(x), i % 4 == 0).lanes()[0];
                    state.flush();
                    assert!(y.is_finite());
                    let slot = i / 12000;
                    peaks[slot] = peaks[slot].max(y.abs());
                }
                for k in 2..8 {
                    assert!(
                        peaks[k] < peaks[k - 1] && peaks[k] < peaks[0] * 1.01,
                        "{ty:?} FAT {fat}: {peaks:?}"
                    );
                }
            }
        }
    }
}

#[cfg(test)]
mod grid {
    use super::*;
    extern crate std;

    const RATE: f64 = 48000.0;

    // the design the coefficients play (their sections read back: g, k and the taps of each)
    fn design_of(c: &Coefs, layout: Layout) -> ModelDesign {
        let mut design = ModelDesign {
            svfs: layout.svfs,
            droop: c.droop[1] as f64,
            fat: c.fat as f64,
            ..ModelDesign::default()
        };
        for i in 0..layout.svfs {
            let [c1, a2, a3, m0, h1, h2] = c.svf[i].map(|x| x as f64);
            let g = a3 / a2;
            design.svf[i] = SvfSection {
                g,
                k: c1 / a2 - g,
                mix: [m0, 2.0 * h1, 2.0 * h2],
            };
        }
        if layout.pole {
            let [gg, x0, x1] = c.pole.map(|x| x as f64);
            design.pole = Some(PoleSection {
                g: gg / (1.0 - gg),
                mix: [x0, x1],
            });
        }
        design
    }

    // whether the integrators of the steps (c1, a2, a3) decay: the eigenvalues of their step inside the unit circle
    fn decays([c1, a2, a3]: [f64; 3]) -> bool {
        let det = (1.0 - c1) * (1.0 - a3) + a2 * a2;
        let trace = 2.0 - c1 - a3;
        det.abs() < 1.0 && trace.abs() < 1.0 + det
    }

    // Along a line between two designs whose cutoff (up to 4 times: a line's JUMP) and resonance are far apart, the
    // saturating sections decay all the way, at the small signal and as they saturate: their g, k0, a, l go along it,
    // the products of the saturation are those of them (`sat_products`). A line of the products themselves is no
    // section: its damping goes under 0 between such designs (a burst where the cutoff and the resonance jump together)
    #[test]
    fn a_line_of_the_saturation_is_a_section_all_the_way() {
        let mut products_grow = 0;
        for ty in MODEL_TYPES.into_iter().filter(|ty| ty.layout().sat) {
            let layout = ty.layout();
            let design = |cutoff: f64, r: f64| Coefs::of(&model_design(ty, cutoff, r, 0.0, RATE), 0.0);
            for (f0, r0, f1, r1) in [
                (5306.0, 0.42, 13235.0, 0.959),
                (3960.0, 0.406, 13860.0, 0.962),
                (1000.0, 0.4, 3900.0, 1.0),
                (12000.0, 1.0, 3000.0, 0.45),
                (300.0, 0.6, 1200.0, 1.0),
                (6000.0, 0.4, 18000.0, 1.0),
            ] {
                let ends = [design(f0, r0), design(f1, r1)];
                for t in [0.1f32, 0.25, 0.5, 0.75, 0.9] {
                    let between = ends[0].between(&ends[1], t);
                    for i in 0..layout.svfs {
                        if !(i == 0 && layout.sat || i == 1 && layout.sat2) {
                            continue;
                        }
                        let products: [f32; 8] = core::array::from_fn(|k| {
                            ends[0].sat[i][k] + (ends[1].sat[i][k] - ends[0].sat[i][k]) * t
                        });
                        for level in [0.0f32, 0.1, 1.0, 10.0] {
                            let steps = |sat: [f32; 8]| {
                                sat_steps(&sat.map(F32x4::splat), F32x4::splat(level), layout.clip)
                                    .map(|x| x.lanes()[0] as f64)
                            };
                            assert!(
                                decays(steps(between.sat[i])),
                                "{ty:?} {f0} {r0} → {f1} {r1} at {t}, section {i}, level {level}"
                            );
                            products_grow += !decays(steps(products)) as usize;
                        }
                    }
                }
            }
        }
        assert!(products_grow > 0);
    }

    #[test]
    fn a_cell_is_the_cutoffs_of_an_exponent_and_four_bits() {
        let cell = cutoff_cell(1100.0, RATE).unwrap();
        assert_eq!(cell.edges, [1088.0, 1152.0]);
        assert_eq!(cell.share, (12.0 / 64.0) as f32);
        // 16 an octave, each from where the one before ends, by their index
        let mut f = 1.0;
        let mut index = 0;
        while let Some(cell) = cutoff_cell(f, RATE) {
            assert_eq!((cell.index, cell.edges[0], cell.share), (index, f, 0.0));
            let inside = cutoff_cell(f + 0.75 * (cell.edges[1] - f), RATE).unwrap();
            assert_eq!(
                (inside.index, inside.edges, inside.share),
                (index, cell.edges, 0.75)
            );
            (f, index) = (cell.edges[1], index + 1);
        }
        assert_eq!(cutoff_cell(2.0, RATE).unwrap().index, 16);
        // the last one ends under the top cutoff of a design; past it, under 1 Hz, of a NaN: none
        assert!(f <= TOP_CUTOFF * RATE && f > 0.9 * TOP_CUTOFF * RATE);
        for off in [0.5, 0.0, -100.0, f64::NAN, f64::INFINITY, 0.47 * RATE, 40000.0] {
            assert!(cutoff_cell(off, RATE).is_none(), "{off}");
        }
        // (a low sample rate: its own top)
        assert!(cutoff_cell(6000.0, 8000.0).is_none() && cutoff_cell(3000.0, 8000.0).is_some());
    }

    #[test]
    fn the_coefficients_between_two_are_theirs_at_the_ends() {
        let design = |cutoff: f64| Coefs::of(&model_design(ModelType::Low24, cutoff, 0.7, 0.4, RATE), 0.3);
        let (low, high) = (design(1024.0), design(1088.0));
        assert_eq!(low.between(&high, 0.0), low);
        let half = low.between(&high, 0.5);
        for (k, value) in half.svf.as_flattened().iter().enumerate() {
            let (a, b) = (low.svf.as_flattened()[k], high.svf.as_flattened()[k]);
            assert_eq!(value.to_bits(), (a + (b - a) * 0.5).to_bits());
        }
        // (the saturation: g, k0, a, l so, its products of them)
        for (k, value) in half.saturation.as_flattened().iter().enumerate() {
            let (a, b) = (
                low.saturation.as_flattened()[k],
                high.saturation.as_flattened()[k],
            );
            assert_eq!(value.to_bits(), (a + (b - a) * 0.5).to_bits());
        }
        assert_eq!(
            half.sat,
            half.saturation.map(|section| sat_products(section, 1.0))
        );
        assert_eq!(low.sat, low.saturation.map(|section| sat_products(section, 1.0)));
        assert_eq!(
            (half.drive, half.droop, half.fat),
            (low.drive, low.droop, low.fat)
        );
        // in place: the gain of Drive stays
        let mut kept = Coefs {
            drive: 7.0,
            ..Coefs::default()
        };
        kept.set_between(&low, &high, 0.5);
        assert_eq!(kept, Coefs { drive: 7.0, ..half });
    }

    #[test]
    fn the_lanes_of_two_voices_have_the_coefficients_of_each() {
        let design = |ty: ModelType, cutoff: f64| Coefs::of(&model_design(ty, cutoff, 0.7, 0.4, RATE), 0.3);
        let (p, q) = (
            design(ModelType::Low18, 500.0),
            design(ModelType::Ladder24, 3000.0),
        );
        let c = LaneCoefs::of(&p, &q);
        let lanes = |a: f32, b: f32| [a, a, b, b].map(f32::to_bits);
        let bits = |lane: F32x4| lane.lanes().map(f32::to_bits);
        for i in 0..2 {
            for k in 0..6 {
                assert_eq!(bits(c.svf[i][k]), lanes(p.svf[i][k], q.svf[i][k]));
            }
            for k in 0..8 {
                assert_eq!(bits(c.sat[i][k]), lanes(p.sat[i][k], q.sat[i][k]));
            }
            for k in 0..4 {
                assert_eq!(
                    bits(c.saturation[i][k]),
                    lanes(p.saturation[i][k], q.saturation[i][k])
                );
            }
        }
        for k in 0..3 {
            assert_eq!(bits(c.pole[k]), lanes(p.pole[k], q.pole[k]));
        }
        for k in 0..2 {
            assert_eq!(bits(c.droop[k]), lanes(p.droop[k], q.droop[k]));
        }
        assert_eq!(bits(c.drive), lanes(p.drive, q.drive));
        assert_eq!(bits(c.fat), lanes(p.fat, q.fat));
    }

    // Every type, across the resonance and the variation, every cell: where the coefficients between its edges are
    // the design's at its middle (a smooth cell), they play the design's sections inside it too: the cutoff of each
    // (g, of a one-pole too) within 0.12 % and its damping (k) within 0.15 % of it under 6 kHz, the integrators
    // decaying everywhere (the saturating ones at their small signal too). Under Res 100 %: under 3 kHz 99 % of the
    // cells are smooth, under 12 kHz 99.8 % (the cell a pair lands in, the one x2 meets x3 in; over it the numerators
    // of a design change, a pair with some resonance turns real: such a cell takes designs); a resonance as narrow
    // as the floor of the damping (Res 100 %) mostly takes designs
    #[test]
    fn between_the_designs_of_a_cell() {
        let (mut rough, mut cells) = ([0usize; 3], [0usize; 3]);
        let (mut narrow, mut narrow_cells) = (0usize, 0usize);
        for ty in MODEL_TYPES {
            let layout = ty.layout();
            for r in [0.0, 0.05, 0.5, 0.85, 0.95, 0.98, 1.0] {
                for v in [0.0, 0.6] {
                    let design = |cutoff: f64| Coefs::of(&model_design(ty, cutoff, r, v, RATE), 0.0);
                    let mut f = 16.0;
                    while let Some(cell) = cutoff_cell(f, RATE) {
                        f = cell.edges[1];
                        let region = [3000.0, 12000.0, RATE]
                            .iter()
                            .position(|top| cell.edges[1] <= *top)
                            .unwrap();
                        let edges = cell.edges.map(design);
                        let middle = design(0.5 * (cell.edges[0] + cell.edges[1]));
                        let smooth = edges[0].between(&edges[1], 0.5).near(&middle);
                        if r == 1.0 {
                            narrow_cells += 1;
                            narrow += !smooth as usize;
                        } else {
                            cells[region] += 1;
                            rough[region] += !smooth as usize;
                        }
                        if !smooth {
                            continue;
                        }
                        for t in [0.2f32, 0.35, 0.65, 0.8] {
                            let at = cell.edges[0] + (cell.edges[1] - cell.edges[0]) * t as f64;
                            let between = edges[0].between(&edges[1], t);
                            let (theirs, ours) =
                                (design_of(&design(at), layout), design_of(&between, layout));
                            for i in 0..layout.svfs {
                                let steps = [between.svf[i][0], between.svf[i][1], between.svf[i][2]];
                                assert!(decays(steps.map(|x| x as f64)), "{ty:?} {r} {v} at {at}");
                                if (i == 0 && layout.sat) || (i == 1 && layout.sat2) {
                                    let lanes: [F32x4; 8] = between.sat[i].map(F32x4::splat);
                                    let small = sat_steps(&lanes, F32x4::splat(0.0), layout.clip);
                                    assert!(
                                        decays(small.map(|x| x.lanes()[0] as f64)),
                                        "{ty:?} {r} {v} at {at}: saturating"
                                    );
                                }
                                if cell.edges[1] <= 6000.0 {
                                    let (g, k) = (theirs.svf[i].g, theirs.svf[i].k);
                                    assert!(
                                        (ours.svf[i].g / g - 1.0).abs() < 0.0012
                                            && (ours.svf[i].k - k).abs() < 0.0015 * k,
                                        "{ty:?} {r} {v} at {at}: {:?}, the design {:?}",
                                        ours.svf[i],
                                        theirs.svf[i]
                                    );
                                }
                            }
                            if let (Some(ours), Some(theirs)) = (ours.pole, theirs.pole) {
                                let near = cell.edges[1] > 6000.0 || (ours.g / theirs.g - 1.0).abs() < 0.0012;
                                assert!(
                                    ours.g > 0.0 && near,
                                    "{ty:?} {r} {v} at {at}: {ours:?}, the design {theirs:?}"
                                );
                            }
                        }
                    }
                }
            }
        }
        assert!(rough[0] * 100 < cells[0], "{rough:?} of {cells:?}");
        assert!(rough[1] * 500 < cells[1], "{rough:?} of {cells:?}");
        // (Res 100 %: three cells in four)
        assert!(narrow * 3 > 2 * narrow_cells, "{narrow} of {narrow_cells}");
    }
}

#[cfg(test)]
mod timing {
    use super::*;
    extern crate std;

    // (cargo test --release -p dsp-core design_cost -- --ignored --nocapture)
    #[test]
    #[ignore]
    fn design_cost() {
        for ty in [
            ModelType::Low12,
            ModelType::Low24,
            ModelType::Ladder24,
            ModelType::Low6,
            ModelType::Low18,
        ] {
            let n = 200_000;
            let start = std::time::Instant::now();
            let mut sink = 0.0;
            for i in 0..n {
                let cutoff = 200.0 + (i % 1000) as f64 * 10.0;
                let d = model_design(ty, cutoff, 0.3, 0.2, 48000.0);
                sink += d.svf[0].g;
            }
            let ns = start.elapsed().as_nanos() as f64 / n as f64;
            std::println!("{ty:?}: {ns:.0} ns a design ({sink})");
        }
        // without resonance, the cutoffs over 0.19 fs: the second pole of the prototype has met the root of the delay
        // (two real roots under it)
        for (ty, from) in [
            (ModelType::Low24, 200.0),
            (ModelType::Low24, 9200.0),
            (ModelType::Low12, 9200.0),
        ] {
            let n = 200_000;
            let start = std::time::Instant::now();
            let mut sink = 0.0;
            for i in 0..n {
                let cutoff = from + (i % 1000) as f64 * 10.0;
                let d = model_design(ty, cutoff, 0.0, 0.0, 48000.0);
                sink += d.svf[0].g;
            }
            let ns = start.elapsed().as_nanos() as f64 / n as f64;
            std::println!("{ty:?} without resonance from {from} Hz: {ns:.0} ns a design ({sink})");
        }
        // with some resonance at the top of the cutoff: the real root of the prototype nearer than its pair (the
        // pair by `pair_poles`; the second section of a Peak 24 at any resonance)
        for (ty, r, from) in [
            (ModelType::Low12, 0.02, 17000.0),
            (ModelType::Low24, 0.05, 17000.0),
            (ModelType::Peak24, 0.2, 12000.0),
        ] {
            let n = 200_000;
            let start = std::time::Instant::now();
            let mut sink = 0.0;
            for i in 0..n {
                let cutoff = from + (i % 1000) as f64 * 5.0;
                let d = model_design(ty, cutoff, r, 0.0, 48000.0);
                sink += d.svf[0].g;
            }
            let ns = start.elapsed().as_nanos() as f64 / n as f64;
            std::println!("{ty:?} Res {r} from {from} Hz: {ns:.0} ns a design ({sink})");
        }
        // the tick of a pair of voices through Low 12: plain, saturating
        let design = model_design(ModelType::Low12, 1200.0, 0.3, 0.0, 48000.0);
        let coefs = Coefs::of(&design, 0.0);
        let c = LaneCoefs::of(&coefs, &coefs);
        for (name, sat) in [("plain", false), ("sat", true)] {
            let layout = Layout {
                sat,
                ..ModelType::Low12.layout()
            };
            let mut state = LaneState::default();
            let n = 4_000_000;
            let start = std::time::Instant::now();
            let mut sink = F32x4::splat(0.0);
            for i in 0..n {
                let x = F32x4::splat(((i % 97) as f32 - 48.0) * 0.02);
                sink = sink + tick(layout, &c, &mut state, x, i % 4 == 0);
            }
            std::println!(
                "Low 12 {name}: {:.2} ns a tick ({})",
                start.elapsed().as_nanos() as f64 / n as f64,
                sink.lanes()[0]
            );
        }
        let n = 1_000_000;
        let start = std::time::Instant::now();
        let mut sink = 0.0;
        for i in 0..n {
            sink += sin(i as f64 * 1e-3) + cos(i as f64 * 1e-3);
        }
        std::println!(
            "sin + cos: {:.1} ns ({sink})",
            start.elapsed().as_nanos() as f64 / n as f64
        );
        let start = std::time::Instant::now();
        for i in 0..n {
            sink += exp(-(i as f64) * 1e-6);
        }
        std::println!(
            "exp: {:.1} ns ({sink})",
            start.elapsed().as_nanos() as f64 / n as f64
        );
    }
}
