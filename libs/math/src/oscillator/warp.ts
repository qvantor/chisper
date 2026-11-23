// The Warp of an oscillator (warp.rs of the core, measured: dsp/measurements/warp.json): the map of the phase each
// sample reads its frame at, by the mode (an index of WARP_MODES of the presets) and the knob (0..1). The same
// operations as the core in f32 (Math.fround after each), so the chart draws the frame the voices play: a spec holds
// them bit for bit through osc_warp of the perf build.
// - the bends, of d = 2φ - 1: w = 1/2 + (1 + a)/2 · d / ((1 - a) + 2a|d|) (a Möbius map of each half): Bend + a = 0.8k,
//   Bend - a = -0.8k, Bend +/- a = 0.8(1 - 2k)
// - PWM: w = φ / (1 - k) until it reaches 1, then 0 (the first sample of the frame held over the rest)

export const WARP_OFF = 0;
export const WARP_BEND_UP = 1;
export const WARP_BEND_DOWN = 2;
export const WARP_BEND_BOTH = 3;
export const WARP_PWM = 4;

// seconds of the one-pole the voices read the knob through, its routes too (SMOOTHING of warp.rs: the chart draws the
// knob where its routes move it through it)
export const WARP_SMOOTHING = 0.0113;

// the largest slope of PWM: its knob at 1 - 2^-24 and over reads phase 0 at every sample
const PWM_MAX = 16777216;
const CYCLE = 4294967296;
// 2^-30: 2a / 2^31 of a bend
const BEND_SCALE = 1 / 1073741824;
const f = Math.fround;

export const warpBends = (mode: number) =>
  mode === WARP_BEND_UP || mode === WARP_BEND_DOWN || mode === WARP_BEND_BOTH;

// the param of the map of `mode` at the knob: a of a bend (-0.8..0.8), the slope of PWM (1..PWM_MAX), 0 of Off (a
// knob that isn't a number: 0)
export const warpParam = (mode: number, knob: number) => {
  const k = knob > 0 ? Math.min(knob, 1) : 0;
  switch (mode) {
    case WARP_BEND_UP:
      return 0.8 * k;
    case WARP_BEND_DOWN:
      return -0.8 * k;
    case WARP_BEND_BOTH:
      return 0.8 * (1 - 2 * k);
    case WARP_PWM:
      return 1 - k <= 1 / PWM_MAX ? PWM_MAX : 1 / (1 - k);
    default:
      return 0;
  }
};

// whether the map leaves every phase as it is (the frame as without a warp)
export const warpNeutral = (mode: number, param: number) =>
  warpBends(mode) ? param === 0 : mode === WARP_PWM ? param === 1 : true;

// the levels of a table (3 an octave) the pitch moves up by under the map: 3·log2 of its slope at the wrap of the
// frame (Bend - and PWM squeeze it, Bend + stretches it: none)
export const warpLevels = (mode: number, param: number) => {
  const slope = warpBends(mode) && param < 0 ? (1 - param) / (1 + param) : mode === WARP_PWM ? param : 1;
  return slope > 1 ? 3 * Math.log2(slope) : 0;
};

// f32 to i32 as wasm's i32.trunc_sat_f32_s: toward 0, saturated, NaN 0
const truncSat = (x: number) => (x !== x ? 0 : Math.max(-2147483648, Math.min(2147483647, Math.trunc(x))));

// one phase (0.32: an integer 0..2^32 - 1) through the map at its param: a bend (`bend`) or PWM, a lane of the core
export const warpSample = (bend: boolean, param: number, phase: number) => {
  const p = f(param);
  if (bend) {
    const [h, g0, g1] = [f(1 + p), f(1 - p), f(p * BEND_SCALE)];
    const d = f((phase ^ 0x80000000) | 0);
    const q = f(f(d * h) / f(g0 + f(g1 * Math.abs(d))));
    return (truncSat(q) ^ 0x80000000) >>> 0;
  }
  const y = f(f(phase >>> 8) * p);
  return 16777216 > y ? (truncSat(y) << 8) >>> 0 : 0;
};

// the phase φ (a share of the cycle) through the map of `mode` at `knob`
export const warpPhase = (mode: number, knob: number, phi: number) => {
  const param = warpParam(mode, knob);
  if (warpNeutral(mode, param)) return phi;
  const phase = Math.floor((phi - Math.floor(phi)) * CYCLE) >>> 0;
  return warpSample(warpBends(mode), param, phase) / CYCLE;
};

// a frame (one cycle) as the voices play it through the map of `mode` at `knob`, into `out` (as long as the frame):
// sample j at the warped phase of j / length, linear between the samples of the frame (the frame itself where the
// map is neutral)
export const warpFrame = (frame: ArrayLike<number>, mode: number, knob: number, out: Float64Array) => {
  const { length } = frame;
  const param = warpParam(mode, knob);
  if (warpNeutral(mode, param)) {
    for (let j = 0; j < length; j++) out[j] = frame[j];
    return out;
  }
  const bend = warpBends(mode);
  for (let j = 0; j < length; j++) {
    const x = (warpSample(bend, param, Math.floor((j / length) * CYCLE) >>> 0) / CYCLE) * length;
    const i = Math.min(length - 1, Math.floor(x));
    const a = frame[i];
    out[j] = a + (frame[(i + 1) % length] - a) * (x - i);
  }
  return out;
};
