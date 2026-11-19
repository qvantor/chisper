// The model types of the filter of a voice (after the types of a BiquadFilterNode in FILTER_TYPES of the preset
// schema): the types of the Audio Unit of the renders, measured in dsp/measurements/filter-types.json. Each is an
// analog prototype (s in units of the cutoff) whose feedbacks come a fraction of a sample late, as the reference
// has them (its resonance and its slope move with the cutoff), and a droop of the highs per stage. The core
// (filter_model.rs of dsp-core) realizes it in sections of the sample rate: the poles of the prototype matched
// (z = e^{sT}), the numerator matched in magnitude at DC, at nyquist and in the middle; this module has the same
// design (the chart draws what the core plays: a spec holds them alike)

export const MODEL_FILTER_TYPES = [
  'ladder6',
  'ladder12',
  'ladder18',
  'ladder24',
  'low6',
  'low12',
  'low18',
  'low24',
  'high6',
  'high12',
  'high18',
  'high24',
  'band12',
  'band24',
  'peak12',
  'peak24',
  'notch12',
  'notch24',
  'loweq6',
  'loweq12',
  'bandeq12',
  'higheq6',
  'higheq12',
] as const;
export type ModelFilterType = (typeof MODEL_FILTER_TYPES)[number];

export const isModelFilterType = (type: string): type is ModelFilterType =>
  (MODEL_FILTER_TYPES as readonly string[]).includes(type);

// the knobs of a model type: cutoff (Hz), resonance, variation (0..1: Comp, or the Gain of an EQ type)
export interface ModelKnobs {
  cutoff: number;
  resonance: number;
  variation: number;
}

type Complex = [number, number];
const mul = (a: Complex, b: Complex): Complex => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const div = (a: Complex, b: Complex): Complex => {
  const d = b[0] * b[0] + b[1] * b[1];
  return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d];
};
const cexp = (a: Complex): Complex => {
  const r = Math.exp(a[0]);
  return [r * Math.cos(a[1]), r * Math.sin(a[1])];
};
const abs2 = (a: Complex) => a[0] * a[0] + a[1] * a[1];

// the damping of the state variable filter by the resonance, 2 at 0 (two poles at the cutoff), a floor at 1 (the
// reference never rings for good; that of the EQ types, those of Normal saturate: SVF_FLOOR); the gain of its pass
// band (as a ladder's: 1 / (1 + k), k = 4 r)
const EQ_FLOOR = 0.0011;
const svfDamping = (resonance: number, floor: number) =>
  Math.max(2 * (1 - Math.sqrt(Math.sqrt(resonance))), floor);
const resonanceGain = (resonance: number) => 1 / (1 + 4 * resonance);
// the Gain of the EQ types (DB +/- of the reference): the gain of their band by the knob, 0 at 0, 1 (0 dB) at 0.5, 9 (+19 dB) at 1
export const eqGain = (variation: number) =>
  variation < 0.5
    ? ((t) => 1 - t * t * t)(1 - 2 * variation)
    : ((t) => 1 + 8 * (t * t * t))(2 * variation - 1);

// Comp (FAT of the reference, the variation of the types of Normal but the one-poles and the notches): a gain of
// 1 + 4 r fat into the sections (at Comp 1 it gives back what the resonance takes off the pass band; louder into the
// saturation of the core's resonance). A notch has none: the resonance takes nothing off its pass band, and Comp of the
// reference's Notch changes no bit of it
const fatFactor = (resonance: number, variation: number) => 1 + 4 * resonance * variation;
// (the floor of the types of Normal: their resonance saturates, at Res 1 a quiet sine at the cutoff already a little
// as the reference's)
const SVF_FLOOR = 0.0001;
// the feedback of a ladder (the reference's, every one of its MG Low: filter-resonance.json, the peaks of a quiet sine
// by Res and the cutoff): 4 r, a little less at higher cutoffs (w = π fc / fs), under its top (it never rings for
// good); its peak is over the cutoff under 1 kHz and under it at 6 kHz: the poles moved by a share of the cutoff (w
// held at 6.3 kHz of 48 kHz past it). Lines of w, no sines
const LADDER_FEEDBACK = [0.99908, 0.00151, 0.03781];
const LADDER_TOP = 3.99803;
const LADDER_TUNE = [0.00426, -0.0161, 0.41];
const ladderFeedbackOf = (resonance: number, w: number) => {
  const [c, c0, cw] = LADDER_FEEDBACK;
  return Math.min((4 * resonance * c + c0) * (1 - cw * w), LADDER_TOP);
};
// the share of the cutoff the poles of a ladder move by
const ladderTuneOf = (w: number) => {
  const [t0, tw, top] = LADDER_TUNE;
  return 1 + (t0 + tw * Math.min(w, top));
};

// the taps of a section: low, high, band (s / den, its gain 1/k at the cutoff), peak (low + band + high), notch
// (low + high)
type Tap = 'low' | 'high' | 'band' | 'peak' | 'notch';
// how a type is made: `ladder` (its tap after n of 4 poles), `svf` (one state variable filter, a second of damping
// c2 + c3 k²/4 for 24 dB, a one-pole after it for 18 dB), `pole` (a one-pole), `eq` (the input + (G - 1) the tap of
// a section of gain 1). D2: the droop of the highs of each stage, dB at (f/fs)² = 1; d: how late the feedback of a
// section comes, samples (fitted to the measurements)
type Structure =
  | { kind: 'ladder'; n: number; D2: number }
  | {
      kind: 'svf';
      tap: Tap;
      D2: number;
      d: number;
      second?: { c2: number; c3: number };
      pole?: { d: number };
    }
  | { kind: 'pole'; tap: 'low' | 'high'; D2: number; d: number }
  | { kind: 'eq'; tap: Tap; order: 1 | 2; D2: number; d: number };

const MODEL_STRUCTURES: Record<ModelFilterType, Structure> = {
  ladder6: { kind: 'ladder', n: 1, D2: 9.18 },
  ladder12: { kind: 'ladder', n: 2, D2: 9.1 },
  ladder18: { kind: 'ladder', n: 3, D2: 9.19 },
  ladder24: { kind: 'ladder', n: 4, D2: 9.11 },
  low6: { kind: 'pole', tap: 'low', D2: 6.45, d: 0.1127 },
  low12: { kind: 'svf', tap: 'low', D2: 7.28, d: 0.1316 },
  low18: { kind: 'svf', tap: 'low', D2: 6.67, d: 0.1338, pole: { d: 0.1118 } },
  low24: { kind: 'svf', tap: 'low', D2: 7.34, d: 0.1325, second: { c2: 1.0063, c3: 1.0137 } },
  high6: { kind: 'pole', tap: 'high', D2: 8.06, d: 0.1503 },
  high12: { kind: 'svf', tap: 'high', D2: 6.35, d: 0.1179 },
  high18: { kind: 'svf', tap: 'high', D2: 8.05, d: 0.1078, pole: { d: 0.1771 } },
  high24: { kind: 'svf', tap: 'high', D2: 6.42, d: 0.1142, second: { c2: 1, c3: 1 } },
  band12: { kind: 'svf', tap: 'band', D2: 7.04, d: 0.1153 },
  band24: { kind: 'svf', tap: 'band', D2: 6.86, d: 0.1109, second: { c2: 1, c3: 1 } },
  peak12: { kind: 'svf', tap: 'peak', D2: 6.18, d: 0.2001 },
  peak24: { kind: 'svf', tap: 'peak', D2: 6.26, d: 0.2124, second: { c2: 1.0657, c3: 0.6967 } },
  notch12: { kind: 'svf', tap: 'notch', D2: 2.9, d: 0.1305 },
  notch24: { kind: 'svf', tap: 'notch', D2: 2.3, d: 0.1359, second: { c2: 1, c3: 1 } },
  loweq6: { kind: 'eq', tap: 'low', order: 1, D2: 6.45, d: 0.1127 },
  loweq12: { kind: 'eq', tap: 'low', order: 2, D2: 7.28, d: 0.1316 },
  bandeq12: { kind: 'eq', tap: 'band', order: 2, D2: 7.04, d: 0.1153 },
  higheq6: { kind: 'eq', tap: 'high', order: 1, D2: 8.06, d: 0.1503 },
  higheq12: { kind: 'eq', tap: 'high', order: 2, D2: 6.35, d: 0.1179 },
};

// whether the variation of a type is the Gain of its band (the EQ types), not Comp
export const isEqFilterType = (type: string) =>
  isModelFilterType(type) && MODEL_STRUCTURES[type].kind === 'eq';

// the knobs a type uses besides the cutoff and Drive: the resonance (a one-pole has none: Low and High 6, the EQ ones
// of 6 dB) and the variation (Comp of a one-pole and of a notch is a gain of 1)
export const modelKnobsOf = (type: ModelFilterType) => {
  const s = MODEL_STRUCTURES[type];
  const onePole = s.kind === 'pole' || (s.kind === 'eq' && s.order === 1);
  const notch = s.kind === 'svf' && s.tap === 'notch';
  return { resonance: !onePole, variation: s.kind !== 'pole' && !notch };
};

// --- Drive (the curve before the sections: filter_model.rs of dsp-core) ---

// the curve: x - x³/(3 UT²) up to UT, 2 UT / 3 past it (UT of the core)
export const DRIVE_UT = 4.933;
// the gain of Drive (0..1) into the curve: (1 + d)⁴
export const driveGain = (drive: number) => {
  const d = 1 + Math.min(Math.max(drive, 0), 1);
  return d * d * d * d;
};
// the level of a sine of `amplitude` through Drive (0..1): the amplitude of its fundamental out of the gain and the
// curve over its own; 1 at 0 (the core leaves the curve out there). The chart draws Drive at a sine of full scale:
// as a loud sound comes out (a quiet one gets the gain itself, up to +24 dB)
export const driveLevel = (drive: number, amplitude = 1) => {
  if (drive <= 0 || amplitude <= 0) return 1;
  const a = driveGain(drive) * amplitude;
  const c = 1 / (3 * DRIVE_UT * DRIVE_UT);
  // within the cubic all the way: a - (3/4) c a³
  if (a <= DRIVE_UT) return (a - 0.75 * c * a * a * a) / amplitude;
  // the cubic up to θc of each quarter of the cycle, the flat top past it
  const t = Math.asin(DRIVE_UT / a);
  const sin2 = Math.sin(2 * t);
  const sines2 = t / 2 - sin2 / 4;
  const sines4 = (3 * t) / 8 - sin2 / 4 + Math.sin(4 * t) / 32;
  const fundamental =
    (4 / Math.PI) * (a * sines2 - c * a * a * a * sines4 + ((2 * DRIVE_UT) / 3) * Math.cos(t));
  return fundamental / amplitude;
};

// --- the analog prototype ---

// the poles of s² + k s e^{-sτ} + 1 (units of the cutoff): those of τ = 0 moved by Newton; a pair of complex ones or
// two real ones
// (from the start of the Taylor: within 1e-4 after 3 but where the pair turns from complex into real at the top)
const NEWTON_STEPS = 4;
// settled: a step under 1e-5 of the root (the next one under 1e-10 of it, the coefficients of the core are f32)
const SETTLED = 1e-10;
// a root by `steps` of Newton at most, and whether it settled
const svfRoot = (start: Complex, k: number, tau: number, steps: number): [Complex, boolean] => {
  let s = start;
  for (let i = 0; i < steps; i++) {
    const e = cexp([-s[0] * tau, -s[1] * tau]);
    const se = mul(s, e);
    const f: Complex = [s[0] * s[0] - s[1] * s[1] + k * se[0] + 1, 2 * s[0] * s[1] + k * se[1]];
    // f' = 2 s + k e (1 - s τ)
    const de = mul(e, [1 - s[0] * tau, -s[1] * tau]);
    const step = div(f, [2 * s[0] + k * de[0], 2 * s[1] + k * de[1]]);
    s = [s[0] - step[0], s[1] - step[1]];
    // (settled: a short feedback delay leaves the start of the Taylor a step from it)
    if (step[0] * step[0] + step[1] * step[1] <= SETTLED * (s[0] * s[0] + s[1] * s[1])) return [s, true];
  }
  return [s, false];
};
// under it (the cutoffs under about 6 kHz) a root starts from e^{-sτ} to the 2nd order: a step of Newton on
// (kτ²/2) s³ + (1 - kτ) s² + k s + 1, its error then about kτ³/6
const TAYLOR_TAU = 0.1;
// settled by Halley: a step under 1e-3 of the root (its error then about the cube of the step)
const SETTLED_HALLEY = 1e-6;
const taylorStep = (s: Complex, k: number, tau: number): Complex => {
  const [c, a] = [(k * tau * tau) / 2, 1 - k * tau];
  const s2 = mul(s, s);
  const s3 = mul(s2, s);
  const f: Complex = [c * s3[0] + a * s2[0] + k * s[0] + 1, c * s3[1] + a * s2[1] + k * s[1]];
  const step = div(f, [3 * c * s2[0] + 2 * a * s[0] + k, 3 * c * s2[1] + 2 * a * s[1]]);
  return [s[0] - step[0], s[1] - step[1]];
};
// a root by `steps` of Halley at most (f'' = 2 + kτ e^{-sτ}(sτ - 2) of the same exponential), and whether it settled
const svfRootHalley = (start: Complex, k: number, tau: number, steps: number): [Complex, boolean] => {
  let s = start;
  for (let i = 0; i < steps; i++) {
    const e = cexp([-s[0] * tau, -s[1] * tau]);
    const se = mul(s, e);
    const f: Complex = [s[0] * s[0] - s[1] * s[1] + k * se[0] + 1, 2 * s[0] * s[1] + k * se[1]];
    const de = mul(e, [1 - s[0] * tau, -s[1] * tau]);
    const d1: Complex = [2 * s[0] + k * de[0], 2 * s[1] + k * de[1]];
    const e2 = mul(e, [s[0] * tau - 2, s[1] * tau]);
    const d2: Complex = [2 + k * tau * e2[0], k * tau * e2[1]];
    // 2 f f' / (2 f'² - f f'')
    const [ff1, d11, ff2] = [mul(f, d1), mul(d1, d1), mul(f, d2)];
    const step = div([2 * ff1[0], 2 * ff1[1]], [2 * d11[0] - ff2[0], 2 * d11[1] - ff2[1]]);
    s = [s[0] - step[0], s[1] - step[1]];
    if (abs2(step) <= SETTLED_HALLEY * abs2(s)) return [s, true];
  }
  return [s, false];
};
// the root of a complex pair where τ is under TAYLOR_TAU: from the start of the Taylor moved by `taylorStep`, steps
// of Halley; and whether it settled
const svfRootNear = (start: Complex, k: number, tau: number): [Complex, boolean] =>
  svfRootHalley(taylorStep(start, k, tau), k, tau, NEWTON_STEPS);
// (on the real axis: steps of a real exponential)
const REAL_STEPS = 8;
// a real root by Newton from a real start and the slope of its last step, null if it doesn't settle within `half`
// of it (the pair is complex there, or it went to the root of the delay far to the left)
const svfRealRoot = (start: number, half: number, k: number, tau: number): [number, number] | null => {
  let s = tau < TAYLOR_TAU ? taylorStep([start, 0], k, tau)[0] : start;
  for (let i = 0; i < REAL_STEPS; i++) {
    const e = Math.exp(-s * tau);
    const slope = 2 * s + k * e * (1 - s * tau);
    const step = (s * s + k * s * e + 1) / slope;
    s -= step;
    if (step * step <= SETTLED * (s * s)) return Math.abs(s - start) < half ? [s, slope] : null;
  }
  return null;
};

// --- the poles of a prototype nearly without resonance ---

// In x = -s the poles are the roots of F(x) = x² + 1 - k x e^{xτ}. A damping over K_CUSP (Res under 1 %) has
// three real ones in a window of τ: the pair lands on the real axis (x1 < x2), then x2 meets the root of the delay
// x3 and leaves the axis with it, a pair over nyquist. Where a pair lands and where two meet is a double root:
// (x + 1/x) e^{-(x² - 1)/(x² + 1)} = k at τ = (x² - 1)/(x (x² + 1)), under X_CUSP and over it (at X_CUSP, K_CUSP,
// the three are one). The poles there: the pair until it lands, x1 and x2 while both are real, then x1 and the
// place where x2 met x3 (the second pole stays there: its z is under 0.01, the poles are continuous along τ)
const X_CUSP = 2.0581710272714924;
const K_CUSP = 1.371245024747284;
// (the damping of a second section is 2.02 at most: where the roots meet is under X_TOP)
const K_TOP = 3;
const X_TOP = 8;
// no root meets another under it (K_TOP aside: the window of the roots says so itself)
const TAU_MEET = 0.18;
// a pair this near the real axis (its imaginary part under 1 % of |s|: squared) is landing, Newton is slow there
const LANDED = 1e-4;
const SAFE_STEPS = 60;

// A root of `at` (its value and its slope) in lo..hi, where it rises or falls through 0: Newton from `start`, a
// step out of what is left of lo..hi is its middle (a double root, a start on the wrong side of a turn)
const safeRoot = (
  at: (x: number) => [number, number],
  lo: number,
  hi: number,
  start: number,
  rising: boolean
) => {
  let [a, b] = [lo, hi];
  // (a NaN: lo)
  let x = start > lo ? (start < hi ? start : hi) : lo;
  for (let i = 0; i < SAFE_STEPS; i++) {
    const [f, d] = at(x);
    if (f === 0) break;
    if (f > 0 === rising) b = x;
    else a = x;
    const next = x - f / d;
    const newton = next > a && next < b;
    const to = newton ? next : 0.5 * (a + b);
    const step = to - x;
    x = to;
    if (newton && step * step <= SETTLED * (x * x)) break;
  }
  return x;
};
// F and its slope
const realAt =
  (k: number, tau: number) =>
  (x: number): [number, number] => {
    const e = Math.exp(x * tau);
    return [x * x + 1 - k * x * e, 2 * x - k * e * (1 + x * tau)];
  };
// where x2 meets x3 at the damping k (over X_CUSP): the double root there
const meetRoot = (k: number) =>
  safeRoot(
    (x) => {
      const x2 = x * x;
      const m = (x + 1 / x) * Math.exp(-(x2 - 1) / (x2 + 1));
      return [m - k, (m * (x2 * x2 - 4 * x2 - 1)) / (x * (x2 + 1) * (x2 + 1))];
    },
    X_CUSP,
    X_TOP,
    X_CUSP + 3 * Math.sqrt(k - K_CUSP),
    true
  );
// whether x2 has met x3 at τ (the τ of the double root xm is under it)
const met = (xm: number, tau: number) => tau * (xm * (xm * xm + 1)) >= xm * xm - 1;
// x1 and the place x2 met x3
const metPoles = (k: number, tau: number, xm: number, start: number): [Complex, Complex] => [
  [-safeRoot(realAt(k, tau), 0, xm, start, false), 0],
  [-xm, 0],
];
// The poles before x2 meets x3 (xm), where Newton from the starts of the Taylor doesn't find them (near a double
// root, a start on the wrong side): from the minimum of F between x1 and x2 (Newton on F' from 0: F' is concave,
// its steps never pass it), under 0 two real roots each in its part of 0..xm, over 0 the pair before it lands (those
// of τ = 0 if it doesn't settle on one, as `svfPoles` takes them)
const windowPoles = (k: number, tau: number, xm: number): [Complex, Complex] => {
  let x = 0;
  for (let i = 0; i < SAFE_STEPS; i++) {
    const e = Math.exp(x * tau);
    const d2 = 2 - k * tau * e * (2 + x * tau);
    if (!(d2 > 0)) break;
    const step = (2 * x - k * e * (1 + x * tau)) / d2;
    x -= step;
    if (step * step <= SETTLED * (x * x)) break;
  }
  const e = Math.exp(x * tau);
  const f = x * x + 1 - k * x * e;
  // (F to the 2nd order about its minimum: its roots this far to each side, or up and down)
  const off = Math.sqrt(Math.abs((2 * f) / (2 - k * tau * e * (2 + x * tau))));
  const at = realAt(k, tau);
  if (f <= 0)
    return [
      [-safeRoot(at, 0, x, x - off, false), 0],
      [-safeRoot(at, x, xm, x + off, true), 0],
    ];
  const [s, settled] = svfRoot([-x, off], k, tau, SAFE_STEPS);
  if (settled && Number.isFinite(s[0]) && Number.isFinite(s[1]) && s[0] < 0)
    return [
      [s[0], Math.abs(s[1])],
      [s[0], -Math.abs(s[1])],
    ];
  const [p, q] = svfPolesOf(k);
  return [p, q];
};
// the poles where Newton from the starts of the Taylor doesn't find them: x2 has met x3 (xm) or not yet
const widePoles = (k: number, tau: number, xm: number, start: number): [Complex, Complex] =>
  met(xm, tau) ? metPoles(k, tau, xm, start) : windowPoles(k, tau, xm);

// --- the pair of a prototype with some resonance ---

// A damping under K_CUSP (Res over 1 %) has one real root at every τ, the root of the delay, and the pair never
// lands. At the top of the cutoff that root has come nearer than the pair (the pair past nyquist) and Newton from
// the start of the Taylor goes to it: the poles are the pair all the same, as they are at any resonance over it
// (continuous along the cutoff; along the resonance a step is left at the cusp, where the rule over it takes x1)
const PAIR_STEPS = 10;
// where the steps of Halley start there: they settle on the pair from it wherever the real root is (7 at most, 3.6
// a design), Newton's from the same start go to the real root at some τ
const PAIR_START: Complex = [-1.5, 2];
// where Newton from the start of the Taylor leaves the pair, nearly (it settles on it up to kτ 0.386 at the cusp,
// 0.44 at k 0.8, at every τ under k 0.7): no step of it is spent there
const PAIR_K = 0.75;
const PAIR_K_TAU = 0.38;
// The pair under K_CUSP where Newton from the start of the Taylor leaves it: Halley from PAIR_START; a root that is
// no pair of the cutoff (on the real axis, a turn of the delay further: |Im s| τ over π) or none: `deflatedPair`
const pairPoles = (k: number, tau: number): [Complex, Complex] => {
  const [s, settled] = svfRootHalley(PAIR_START, k, tau, PAIR_STEPS);
  const im = Math.abs(s[1]);
  if (settled && s[0] < 0 && im * im > LANDED * abs2(s) && im * tau < Math.PI)
    return [
      [s[0], im],
      [s[0], -im],
    ];
  return deflatedPair(k, tau);
};
// (the steps of Newton on the function without its real root: 7 at most from its start)
const DEFLATED_STEPS = 16;
const DEFLATED_START: Complex = [-1.5, 1.5];
// The pair with the real root x taken out of the way (the only one, F falls through it): Newton on f(s)/(s + x),
// which has no root there; those of τ = 0 if it doesn't settle
const deflatedPair = (k: number, tau: number): [Complex, Complex] => {
  let hi = 4;
  while (hi * hi + 1 > k * hi * Math.exp(hi * tau) && hi < 1e6) hi *= 2;
  const x = safeRoot(realAt(k, tau), 0, hi, 1.5, false);
  let s = DEFLATED_START;
  for (let i = 0; i < DEFLATED_STEPS; i++) {
    const e = cexp([-s[0] * tau, -s[1] * tau]);
    const se = mul(s, e);
    const f: Complex = [s[0] * s[0] - s[1] * s[1] + k * se[0] + 1, 2 * s[0] * s[1] + k * se[1]];
    const de = mul(e, [1 - s[0] * tau, -s[1] * tau]);
    // (f / (s + x))' / (f / (s + x)) = f'/f - 1/(s + x)
    const q = div(f, [s[0] + x, s[1]]);
    const step = div(f, [2 * s[0] + k * de[0] - q[0], 2 * s[1] + k * de[1] - q[1]]);
    s = [s[0] - step[0], s[1] - step[1]];
    if (abs2(step) <= SETTLED * abs2(s)) {
      if (Number.isFinite(s[0]) && Number.isFinite(s[1]) && s[0] < 0 && s[1] !== 0)
        return [
          [s[0], Math.abs(s[1])],
          [s[0], -Math.abs(s[1])],
        ];
      break;
    }
  }
  const [p, q] = svfPolesOf(k);
  return [p, q];
};

const svfPoles = (k: number, tau: number): [Complex, Complex] => {
  // from those of (1 - kτ) s² + k s + 1 (e^{-sτ} ≈ 1 - sτ); two real starts on the real axis while each settles in
  // its half of the gap between them on its own root (the slope there: x1 where F falls, x2 where it rises), else
  // in the complex plane, a real start a little off the axis (the pair may be complex where the start is not);
  // those of τ = 0 if it doesn't settle. Nearly without resonance (`wide`): where Newton doesn't find them,
  // `windowPoles`, past the meeting of x2 and x3 `metPoles`. Under the cusp (`pair`): the pair, `pairPoles` where
  // Newton doesn't settle on it
  const a = Math.max(1 - k * tau, 0.05);
  const disc = k * k - 4 * a;
  const wide = k > K_CUSP && k < K_TOP;
  const pair = k <= K_CUSP;
  if (pair && k > PAIR_K && k * tau > PAIR_K_TAU) return pairPoles(k, tau);
  let roots: Complex[];
  if (disc < 0) {
    // (a complex pair: one root, the other its conjugate)
    const start: Complex = [-k / (2 * a), Math.sqrt(-disc) / (2 * a)];
    const [s, settled] = tau < TAYLOR_TAU ? svfRootNear(start, k, tau) : svfRoot(start, k, tau, NEWTON_STEPS);
    const lost = !settled || s[1] * s[1] <= LANDED * abs2(s);
    // (it is landing, or has landed: Newton is slow about a double root, or went to one of two real ones)
    if (wide && lost) return widePoles(k, tau, meetRoot(k), k / (2 * a));
    // (it went to the real root, or is on its way)
    if (pair && tau >= TAYLOR_TAU && lost) return pairPoles(k, tau);
    roots = [s, s];
  } else {
    // (the starts are real, the pair is not)
    if (pair) return pairPoles(k, tau);
    const r = Math.sqrt(disc);
    const [p, q] = [(-k + r) / (2 * a), (-k - r) / (2 * a)];
    const half = r / (2 * a);
    // (where x2 meets x3, if worked out already)
    let xm: number | undefined;
    if (wide && tau >= TAU_MEET) {
      xm = meetRoot(k);
      if (met(xm, tau)) return metPoles(k, tau, xm, -p);
    }
    const [rp, rq] = [svfRealRoot(p, half, k, tau), svfRealRoot(q, half, k, tau)];
    if (rp !== null && rq !== null && (!wide || (rp[1] > 0 && rq[1] < 0)))
      return [
        [rp[0], 0],
        [rq[0], 0],
      ];
    if (wide) return widePoles(k, tau, xm ?? meetRoot(k), -p);
    roots = [svfRoot([p, 1e-3], k, tau, NEWTON_STEPS)[0], svfRoot([q, 1e-3], k, tau, NEWTON_STEPS)[0]];
  }
  if (!roots.every((s) => Number.isFinite(s[0]) && Number.isFinite(s[1]) && s[0] < 0)) roots = svfPolesOf(k);
  for (const s of roots)
    if (Math.abs(s[1]) > 1e-9)
      return [
        [s[0], Math.abs(s[1])],
        [s[0], -Math.abs(s[1])],
      ];
  return [
    [roots[0][0], 0],
    [roots[1][0], 0],
  ];
};
const svfPolesOf = (k: number): Complex[] => {
  const disc = (k * k) / 4 - 1;
  if (disc < 0)
    return [
      [-k / 2, Math.sqrt(-disc)],
      [-k / 2, -Math.sqrt(-disc)],
    ];
  return [
    [-k / 2 + Math.sqrt(disc), 0],
    [-k / 2 - Math.sqrt(disc), 0],
  ];
};
// the pole of s + e^{-sτ} (a one-pole whose feedback comes late), real, of τ up to LATE_TOP (`lateTau`): W₀(-τ)/τ,
// its principal root (s τ ≥ -1; the other is further left). Newton from -1 where it settles on it, else `latePole`
const polePole = (tau: number) => {
  let s = -1;
  for (let i = 0; i < NEWTON_STEPS; i++) {
    const e = Math.exp(-s * tau);
    const step = (s + e) / (1 - tau * e);
    s -= step;
    if (step * step <= SETTLED * (s * s)) {
      if (Number.isFinite(s) && s < 0 && s * tau >= -1) return s;
      break;
    }
  }
  return latePole(tau);
};
// the delay of a one-pole held at LATE_TOP: past it the pole of s + e^{-sτ} turns into a complex pair a one-pole
// can't follow (the cutoffs over 0.39 fs of High 6, 0.33 fs of the pole of High 18); held as where it is a double one
const LATE_TOP = 1 / Math.E;
const lateTau = (tau: number) => Math.min(tau, LATE_TOP);
// under it the series of W₀ at its branch point is the root within 1e-13
const LATE_SERIES = 1e-3;
// the pole of s + e^{-sτ} near the double one (Newton from -1 settles slowly there, or on another root): v = W₀(-τ)
// from the series at its branch point (p = √(2(1 - eτ))), steps of Halley on v eᵛ + τ; s = v/τ
const latePole = (tau: number) => {
  if (tau <= 0) return -1;
  const p = Math.sqrt(Math.max(2 * (1 - Math.E * tau), 0));
  let v = -1 + p * (1 + p * (-1 / 3 + p * (11 / 72 + p * (-43 / 540))));
  if (p >= LATE_SERIES) {
    for (let i = 0; i < REAL_STEPS; i++) {
      const e = Math.exp(v);
      const f = v * e + tau;
      const d1 = e * (v + 1);
      const step = f / (d1 - (e * (v + 2) * f) / (2 * d1));
      v -= step;
      if (step * step <= SETTLED * (v * v)) break;
    }
  }
  return v / tau;
};

// |den|² of the delayed state variable filter and one-pole at s = jx
// (|1 - x² + kx e^{-jxτ} j|², cos² + sin² = 1 taken out: a sine alone)
const svfDen2 = (x: number, k: number, tau: number) => {
  const u = 1 - x * x;
  return u * u + 2 * u * k * x * Math.sin(x * tau) + k * k * x * x;
};
const poleDen2 = (x: number, tau: number) => 1 - 2 * x * Math.sin(x * tau) + x * x;
// |numerator|² of a tap at s = jx
const tapNum2 = (tap: Tap, x: number) => {
  switch (tap) {
    case 'low':
      return 1;
    case 'high':
      return x * x * x * x;
    case 'band':
      return x * x;
    case 'peak':
      return (1 - x * x) * (1 - x * x) + x * x;
    case 'notch':
      return (1 - x * x) * (1 - x * x);
  }
};
// the droop of the highs (D2 dB at (f/fs)² = 1, of every stage) as the core has it: y = (1 - b) x + b x[n-1] over
// the output, its b such that at 16 kHz of 48 kHz (θ = 2π/3) it is the droop of the measurements (under it within
// 0.1 dB, at nyquist 0.7 dB short of it)
const droopOf = (D2: number) => {
  // |1 - b + b e^{-jθ}|² = 1 - 2b(1-b)(1 - cos θ) = 1 - 3b(1-b) at θ = 2π/3
  const ab = (1 - Math.exp(-D2 * (Math.LN10 / 90))) / 3;
  return 0.5 - Math.sqrt(0.25 - ab);
};

// --- the design: the sections the core runs ---

// a state variable filter of the core (trapezoidal integrators of g, damping k), its output the mix of the input,
// the band and the low; a one-pole (trapezoidal, g), its output the mix of the input and the low
export interface SvfSection {
  g: number;
  k: number;
  mix: [number, number, number];
}
export interface PoleSection {
  g: number;
  mix: [number, number];
}
// the sections of a type at its knobs, in the order they run: the state variable filters, then the one-pole
export interface ModelDesign {
  svf: SvfSection[];
  pole: PoleSection | null;
  // the droop of the highs: y = (1 - b) x + b x[n-1] after the sections
  droop: number;
  // the gain into the sections (Comp)
  fat: number;
}

type Den = [number, number];
// 1 + A1 z^-1 + A2 z^-2 of two poles of the prototype at w = π fc / fs (z = e^{s 2w})
const zDen = ([p, q]: [Complex, Complex], w: number): Den => {
  // a complex pair: one exponential, its conjugate the other; two real ones: no turn
  if (p[1] !== 0) {
    const zp = cexp([p[0] * 2 * w, p[1] * 2 * w]);
    return [-2 * zp[0], zp[0] * zp[0] + zp[1] * zp[1]];
  }
  const [zp, zq] = [Math.exp(p[0] * 2 * w), Math.exp(q[0] * 2 * w)];
  return [-(zp + zq), zp * zq];
};
// sin²(θ/2) and |A|² by it (|A(e^{jθ})|² = A0 (1 - φ) + A1 φ + A2 4 φ (1 - φ), Vicanek's basis)
const phiOf = (theta: number) => {
  const s = Math.sin(theta / 2);
  return s * s;
};
const denAt2 = ([A1, A2]: Den, phi: number) =>
  (1 + A1 + A2) * (1 + A1 + A2) * (1 - phi) + (1 - A1 + A2) * (1 - A1 + A2) * phi - 16 * A2 * phi * (1 - phi);
// numerators of a section from the target |H|² at θ, matched at DC, at θh (2π/3: 16 kHz of 48 kHz, where the
// tolerances end; nyquist floats) and at θm (`free`), with two zeros at DC (`high`: at θh), one zero at DC (`band`:
// at θh and θm), the zeros of a notch at θn (`notch`: at DC)
type Numerator = [number, number, number];
const THETA_H = (2 * Math.PI) / 3;
// sin²(θh / 2) = sin²(π/3)
const PHI_H = 0.75;
// b of |B|² = B0 (1-φ) + B1 φ + B2 4φ(1-φ) (Vicanek): b0 + b1 + b2 = √B0, b0 - b1 + b2 = √B1, b0 b2 = -B2/4
const factor = (B0: number, B1: number, B2: number): Numerator => {
  const r0 = Math.sqrt(Math.max(B0, 0));
  const r1 = Math.sqrt(Math.max(B1, 0));
  const W = 0.5 * (r0 + r1);
  const b0 = 0.5 * (W + Math.sqrt(Math.max(0, W * W + B2)));
  return [b0, 0.5 * (r0 - r1), b0 > 0 ? -B2 / (4 * b0) : 0];
};
const freeNumerator = (A: Den, m2: (theta: number) => number, thetaM: number): Numerator => {
  const B0 = m2(0) * denAt2(A, 0);
  // the two other points: (1-φ) B0 + φ B1 + 4φ(1-φ) B2 = m2 |A|²
  const tm = Math.min(thetaM, 0.9 * THETA_H);
  const tx = THETA_H;
  const [ph, pm] = [PHI_H, phiOf(tm)];
  const rh = m2(tx) * denAt2(A, ph) - (1 - ph) * B0;
  const rm = m2(tm) * denAt2(A, pm) - (1 - pm) * B0;
  const [qh, qm] = [4 * ph * (1 - ph), 4 * pm * (1 - pm)];
  const det = ph * qm - pm * qh;
  return factor(B0, (rh * qm - rm * qh) / det, (ph * rm - pm * rh) / det);
};
const highNumerator = (A: Den, m2: (theta: number) => number): Numerator => {
  // |c (1 - z^-1)²|² = 16 c² φ²
  const ph = PHI_H;
  const c = Math.sqrt(m2(THETA_H) * denAt2(A, ph)) / (4 * ph);
  return [c, -2 * c, c];
};
const bandNumerator = (A: Den, m2: (theta: number) => number, thetaM: number): Numerator => {
  // (1 - z^-1)(β0 + β1 z^-1): |1 - z^-1|² = 4φ, |β|² = Bb0 (1-φ) + Bb1 φ
  const [ph, pm] = [PHI_H, phiOf(Math.min(thetaM, 0.9 * THETA_H))];
  const rh = (m2(THETA_H) * denAt2(A, ph)) / (4 * ph);
  const rm = (m2(Math.min(thetaM, 0.9 * THETA_H)) * denAt2(A, pm)) / (4 * pm);
  const det = (1 - ph) * pm - (1 - pm) * ph;
  const Bb0 = Math.max(0, (rh * pm - rm * ph) / det);
  const Bb1 = Math.max(0, ((1 - ph) * rm - (1 - pm) * rh) / det);
  const b0 = 0.5 * (Math.sqrt(Bb0) + Math.sqrt(Bb1));
  const b1 = 0.5 * (Math.sqrt(Bb0) - Math.sqrt(Bb1));
  return [b0, b1 - b0, -b1];
};
const notchNumerator = (A: Den, m2: (theta: number) => number, thetaN: number): Numerator => {
  const cos = Math.cos(thetaN);
  const c = Math.sqrt(m2(0) * denAt2(A, 0)) / (2 - 2 * cos);
  return [c, -2 * c * cos, c];
};
// the zeros of a peak (1 + s + s²: s = -½ ± j√3/2) matched (z = e^{s 2w}), its gain at DC: for a cutoff under
// PEAK_ZEROS (θ: 15 kHz of 48 kHz), the numerator matched in magnitude can't hold its zeros (above it: matched at
// the cutoff)
const PEAK_ZEROS = 2;
const peakNumerator = (A: Den, m2: (theta: number) => number, w: number): Numerator => {
  const z = cexp([-w, Math.sqrt(3) * w]);
  const [c1, c2] = [-2 * z[0], z[0] * z[0] + z[1] * z[1]];
  const c = Math.sqrt(m2(0) * denAt2(A, 0)) / (1 + c1 + c2);
  return [c, c * c1, c * c2];
};

// the state variable filter of 1 + A1 z^-1 + A2 z^-2 and the numerator b: g² = (1+A1+A2)/(1-A1+A2), k, the mix
const svfOf = ([A1, A2]: Den, [b0, b1, b2]: Numerator): SvfSection => {
  const g = Math.sqrt((1 + A1 + A2) / (1 - A1 + A2));
  const k = (2 * (1 - A2)) / ((1 - A1 + A2) * g);
  const d0 = 1 + g * k + g * g;
  const x = (d0 * (b0 - b1 + b2)) / 4;
  return {
    g,
    k,
    mix: [x, (d0 * (b0 - b2)) / (2 * g) - x * k, (d0 * b1 - 2 * x * (g * g - 1)) / (2 * g * g)],
  };
};
// the numerator b0 + b1 z^-1 of a one-pole of the pole p: a low one matched at DC and θh, a high one (a zero at DC)
// at θh; |b0 + b1 z^-1|² = (b0+b1)² (1-φ) + (b0-b1)² φ, |1 - p z^-1|² = (1-p)² (1-φ) + (1+p)² φ
const poleNumerator = (
  p: number,
  m2: (theta: number) => number,
  tap: 'low' | 'high' | Tap
): [number, number] => {
  const ph = PHI_H;
  const den = (1 - p) * (1 - p) * (1 - ph) + (1 + p) * (1 + p) * ph;
  if (tap !== 'low') {
    const c = Math.sqrt((m2(THETA_H) * den) / ph) / 2;
    return [c, -c];
  }
  const B0 = m2(0) * (1 - p) * (1 - p);
  const B1 = Math.max(0, (m2(THETA_H) * den - B0 * (1 - ph)) / ph);
  return [0.5 * (Math.sqrt(B0) + Math.sqrt(B1)), 0.5 * (Math.sqrt(B0) - Math.sqrt(B1))];
};
// a one-pole of the pole p (z) and the numerator b0 + b1 z^-1
const poleOf = (p: number, b0: number, b1: number): PoleSection => {
  const x = (b0 - b1) / (1 + p);
  return { g: (1 - p) / (1 + p), mix: [x, (b0 - x) / ((1 - p) / 2)] };
};

// the pole frequency of a pair (units of θ) for the middle point of a match: of a complex pair its frequency, of two
// real ones their geometric mean; within (0, π)
// (|p| as the core has it: Math.hypot scales its terms, other bits)
const middleOf = ([p, q]: [Complex, Complex], w: number) => {
  const f = Math.sqrt(Math.sqrt(abs2(p)) * Math.sqrt(abs2(q)));
  return Math.min(Math.max(2 * w * f, Math.PI / 4), 0.95 * Math.PI);
};

// the one-pole of a prototype of delay tau (its low or its high tap) at w, xOf the frequency of θ in cutoffs
const poleSection = (delay: number, w: number, tap: Tap, xOf: (theta: number) => number) => {
  const tau = lateTau(delay);
  const p = Math.exp(polePole(tau) * 2 * w);
  const m2 = (theta: number) => (tap === 'low' ? 1 : xOf(theta) * xOf(theta)) / poleDen2(xOf(theta), tau);
  const [b0, b1] = poleNumerator(p, m2, tap);
  return poleOf(p, b0, b1);
};

const TOP_CUTOFF = 0.46;

// the sections of a type at its knobs and the sample rate
export const modelDesign = (type: ModelFilterType, knobs: ModelKnobs, sampleRate: number): ModelDesign => {
  const s = MODEL_STRUCTURES[type];
  // (a cutoff past 0.42 fs is designed there: its poles near nyquist, a section of the sample rate can't follow the
  // prototype; the reference is nearly open there)
  const fc = Math.min(Math.max(knobs.cutoff, 1), TOP_CUTOFF * sampleRate);
  const r = Math.min(Math.max(knobs.resonance, 0), 1);
  const v = Math.min(Math.max(knobs.variation, 0), 1);
  const w = (Math.PI * fc) / sampleRate;
  const fOf = (theta: number) => (theta * sampleRate) / (2 * Math.PI);
  const xOf = (theta: number) => fOf(theta) / fc;
  if (s.kind === 'ladder') return ladderDesign(s, fc, r, v, w, sampleRate);
  if (s.kind === 'eq') return eqDesign(s, fc, r, v, w, sampleRate);
  if (s.kind === 'pole')
    return { svf: [], pole: poleSection(2 * s.d * w, w, s.tap, xOf), droop: droopOf(s.D2), fat: 1 };
  const tau = 2 * s.d * w;
  const k = svfDamping(r, SVF_FLOOR);
  const gain = s.tap === 'notch' ? 1 : resonanceGain(r);
  const section = (kk: number, tap: Tap, g: number): SvfSection => {
    const poles = svfPoles(kk, tau);
    const A = zDen(poles, w);
    const m2 = (theta: number) => (g * g * tapNum2(tap, xOf(theta))) / svfDen2(xOf(theta), kk, tau);
    const thetaM = middleOf(poles, w);
    const b =
      tap === 'high'
        ? highNumerator(A, m2)
        : tap === 'band'
          ? bandNumerator(A, m2, thetaM)
          : tap === 'notch'
            ? notchNumerator(A, m2, Math.min(2 * w, Math.PI))
            : tap === 'peak' && 2 * w < PEAK_ZEROS
              ? peakNumerator(A, m2, w)
              : freeNumerator(A, m2, tap === 'peak' ? 2 * w : thetaM);
    return svfOf(A, b);
  };
  const svf = [section(k, s.tap, gain)];
  if (s.second) svf.push(section(s.second.c2 + (s.second.c3 * k * k) / 4, s.tap, 1));
  const pole = s.pole ? poleSection(2 * s.pole.d * w, w, s.tap, xOf) : null;
  const fat = s.tap === 'notch' ? 1 : fatFactor(r, v);
  return { svf, pole, droop: droopOf(s.D2 * (svf.length + (pole ? 1 : 0))), fat };
};

// an EQ type: the input + (G - 1) a tap (its own droop: the input has none), the whole response matched in magnitude
// on the poles of the tap
const eqDesign = (
  s: Extract<Structure, { kind: 'eq' }>,
  fc: number,
  r: number,
  v: number,
  w: number,
  sampleRate: number
): ModelDesign => {
  // (a one-pole: its delay held, of its tap and its pole alike)
  const tau = s.order === 1 ? lateTau(2 * s.d * w) : 2 * s.d * w;
  const G = eqGain(v) - 1;
  const fOf = (theta: number) => (theta * sampleRate) / (2 * Math.PI);
  const k = svfDamping(r, EQ_FLOOR);
  // the tap at s = jx (complex)
  const tap = (x: number): Complex => {
    if (s.order === 1) {
      const den: Complex = [Math.cos(x * tau), x - Math.sin(x * tau)];
      return div(s.tap === 'low' ? [1, 0] : [0, x], den);
    }
    const den: Complex = [1 - x * x + k * x * Math.sin(x * tau), k * x * Math.cos(x * tau)];
    return div(s.tap === 'low' ? [1, 0] : s.tap === 'high' ? [-x * x, 0] : [0, x], den);
  };
  const m2 = (theta: number) => {
    const f = fOf(theta);
    const t = tap(f / fc);
    const d = G * Math.pow(10, (-s.D2 * (f / sampleRate) * (f / sampleRate)) / 20);
    return abs2([1 + d * t[0], d * t[1]]);
  };
  if (s.order === 1) {
    const p = Math.exp(polePole(tau) * 2 * w);
    const [b0, b1] = poleNumerator(p, m2, 'low');
    return { svf: [], pole: poleOf(p, b0, b1), droop: 0, fat: 1 };
  }
  const poles = svfPoles(k, tau);
  const A = zDen(poles, w);
  if (s.tap === 'band')
    return { svf: [svfOf(A, freeNumerator(A, m2, middleOf(poles, w)))], pole: null, droop: 0, fat: 1 };
  // a shelf: the input + (G - 1) its tap, the tap of the phase of the prototype (its zeros at nyquist or DC, the
  // gain of the prototype at DC or at θh): the sum of the two is the shelf of the reference, its resonance too
  const [A1, A2] = A;
  const b: Numerator =
    s.tap === 'low'
      ? ((c) => [c, 2 * c, c])((1 + A1 + A2) / 4)
      : ((c) => [c, -2 * c, c])(Math.sqrt(abs2(tap(fOf(THETA_H) / fc)) * denAt2(A, PHI_H)) / (4 * PHI_H));
  const section = svfOf(A, b);
  section.mix = [1 + G * section.mix[0], G * section.mix[1], G * section.mix[2]];
  return { svf: [section], pole: null, droop: 0, fat: 1 };
};

// a ladder: the four poles of (1+s)⁴ + k (1 + s = k^¼ e^{jπ(2m+1)/4}), two sections, the one near the axis first
// with the droop; the numerator (1+s)^(4-n) shared between them
const ladderDesign = (
  s: Extract<Structure, { kind: 'ladder' }>,
  fc: number,
  r: number,
  v: number,
  w: number,
  sampleRate: number
): ModelDesign => {
  const k = ladderFeedbackOf(r, w);
  const q = Math.sqrt(Math.sqrt(k));
  const tune = ladderTuneOf(w);
  const pair = (m: number): [Complex, Complex] => {
    const a = (Math.PI * (2 * m + 1)) / 4;
    const p: Complex = [(-1 + q * Math.cos(a)) * tune, q * Math.sin(a) * tune];
    return [p, [p[0], -p[1]]];
  };
  const fOf = (theta: number) => (theta * sampleRate) / (2 * Math.PI);
  const nA = Math.ceil((4 - s.n) / 2);
  const nB = 4 - s.n - nA;
  // |(jx - p)(jx - p*)|²
  const quad2 = ([p]: [Complex, Complex], x: number) =>
    (p[0] * p[0] + (x - p[1]) * (x - p[1])) * (p[0] * p[0] + (x + p[1]) * (x + p[1]));
  const section = (poles: [Complex, Complex], n: number) => {
    const A = zDen(poles, w);
    const m2 = (theta: number) => {
      const x = fOf(theta) / fc;
      let num = 1;
      for (let i = 0; i < n; i++) num *= 1 + x * x;
      return num / quad2(poles, x);
    };
    return svfOf(A, freeNumerator(A, m2, middleOf(poles, w)));
  };
  return {
    svf: [section(pair(0), nA), section(pair(1), nB)],
    pole: null,
    droop: droopOf(s.D2),
    fat: fatFactor(r, v),
  };
};

// --- the response of a design ---

// |H|² of the sections at f
export const designGain2 = (design: ModelDesign, f: number, sampleRate: number) => {
  const theta = (2 * Math.PI * f) / sampleRate;
  return designGain2At(design, Math.cos(theta), Math.sin(theta));
};

// designGain2 at θ of these cos and sin (the chart holds them a point: no sines, no array a point)
export const designGain2At = ({ svf, pole, droop, fat }: ModelDesign, cos: number, sin: number) => {
  // z^-1 and z^-2
  const [z1r, z1i] = [cos, -sin];
  const [z2r, z2i] = [z1r * z1r - z1i * z1i, z1r * z1i + z1i * z1r];
  let gain = 1;
  for (const { g, k, mix } of svf) {
    const d0 = 1 + g * k + g * g;
    const denR = d0 + 2 * (g * g - 1) * z1r + (1 - g * k + g * g) * z2r;
    const denI = 2 * (g * g - 1) * z1i + (1 - g * k + g * g) * z2i;
    // the input, the band g (1 - z^-2) and the low g² (1 + z^-1)² over den
    const numR = mix[0] * denR + mix[1] * g * (1 - z2r) + mix[2] * g * g * (1 + 2 * z1r + z2r);
    const numI = mix[0] * denI + mix[1] * g * -z2i + mix[2] * g * g * (2 * z1i + z2i);
    gain *= (numR * numR + numI * numI) / (denR * denR + denI * denI);
  }
  if (pole) {
    const p = (1 - pole.g) / (1 + pole.g);
    const [denR, denI] = [1 - p * z1r, -p * z1i];
    const G = (1 - p) / 2;
    const numR = pole.mix[0] * denR + pole.mix[1] * G * (1 + z1r);
    const numI = pole.mix[0] * denI + pole.mix[1] * G * z1i;
    gain *= (numR * numR + numI * numI) / (denR * denR + denI * denI);
  }
  return fat * fat * gain * (1 - 2 * droop * (1 - droop) * (1 - z1r));
};
