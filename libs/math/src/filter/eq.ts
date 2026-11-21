// The EQ of the effects (dsp/chain/src/eq.rs): two bands, each a filter of the Audio EQ Cookbook at the rate of
// the context with the laws of the reference (dsp/measurements/eq.json): band 1 a low shelf, a peak or a highpass,
// band 2 a high shelf, a peak or a lowpass; the frequency 21.53 Hz..20 kHz (at any rate), the gain ±24 dB (none on
// a pass), the resonance (0..100 %, x its share) a Q of 0.1 + 18.9 x⁴ of a peak and a pass, of 0.4 + 1.7416 x³ of
// a shelf. The core realizes a band as a state variable filter of g, k and the shares of the input, the band and
// the low (A. Simper's forms of the cookbook types); eqDesign is its design, the same operations (a spec holds them
// alike bit for bit), the chart draws the gain of it

// the types of a band, by index (EQ_TYPES of eq-params.ts names them): a shelf, a peak, a pass
export const EQ_SHELF = 0;
export const EQ_PEAK = 1;
export const EQ_PASS = 2;

export const EQ_MIN_FREQ = 21.53;
export const EQ_MAX_FREQ = 20000;
export const EQ_MAX_GAIN = 24;
// the highest frequency a band is designed at, a share of the rate: under nyquist (20 kHz from 40 kHz on)
const TOP = 0.499;

// g (the prewarped frequency), k (the damping), the shares of the input, the band and the low
export type EqDesign = [number, number, number, number, number];

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

// the amplitude A of a gain (dB), the square root of the gain of a peak at its frequency
const amplitude = (gain: number) => Math.pow(10, clamp(gain, -EQ_MAX_GAIN, EQ_MAX_GAIN) / 40);

// the type of a value of its param (a value over a pass is a pass, as the reference has it)
export const eqTypeOf = (value: number) => (value >= 1.5 ? EQ_PASS : value >= 0.5 ? EQ_PEAK : EQ_SHELF);

// the Q of a peak and a pass at a resonance (%) and the resonance of a Q
export const eqQ = (reso: number) => {
  const x = clamp(reso / 100, 0, 1);
  const x2 = x * x;
  return 0.1 + 18.9 * (x2 * x2);
};
export const eqResoOfQ = (q: number) => 100 * ((clamp(q, 0.1, 19) - 0.1) / 18.9) ** 0.25;

// the design of band `band` (0, 1) of type `type` (eqTypeOf) at its frequency (Hz), resonance (%) and gain (dB)
export const eqDesign = (
  band: number,
  type: number,
  freq: number,
  reso: number,
  gain: number,
  sampleRate: number
): EqDesign => {
  const f = clamp(freq, EQ_MIN_FREQ, Math.min(EQ_MAX_FREQ, TOP * sampleRate));
  const w = (Math.PI * f) / sampleRate;
  const t = Math.sin(w) / Math.cos(w);
  if (type === EQ_SHELF) {
    const x = clamp(reso / 100, 0, 1);
    const k = 1 / (0.4 + 1.7416 * (x * x * x));
    const a = amplitude(gain);
    return band === 0
      ? [t / Math.sqrt(a), k, 1, k * (a - 1), a * a - 1]
      : [t * Math.sqrt(a), k, a * a, k * (1 - a) * a, 1 - a * a];
  }
  const q = eqQ(reso);
  if (type === EQ_PEAK) {
    const a = amplitude(gain);
    const k = 1 / (q * a);
    return [t, k, 1, k * (a * a - 1), 0];
  }
  if (band === 0) {
    const k = 1 / q;
    return [t, k, 1, -k, -1];
  }
  return [t, 1 / q, 0, 0, 1];
};

// the power gain |H|² of a band at θ of these cos and sin: m0 + m1 (the band) + m2 (the low) of the bilinear
// transform of a state variable filter, s = (1 - z⁻¹) / (g (1 + z⁻¹))
export const eqGain2At = ([g, k, m0, m1, m2]: EqDesign, cos: number, sin: number) => {
  const [z1r, z1i] = [cos, -sin];
  const [z2r, z2i] = [z1r * z1r - z1i * z1i, 2 * z1r * z1i];
  const denR = 1 + g * k + g * g + 2 * (g * g - 1) * z1r + (1 - g * k + g * g) * z2r;
  const denI = 2 * (g * g - 1) * z1i + (1 - g * k + g * g) * z2i;
  const numR = m0 * denR + m1 * g * (1 - z2r) + m2 * g * g * (1 + 2 * z1r + z2r);
  const numI = m0 * denI - m1 * g * z2i + m2 * g * g * (2 * z1i + z2i);
  return (numR * numR + numI * numI) / (denR * denR + denI * denI);
};

// the gain (dB) of bands at a frequency
export const eqGainDb = (designs: readonly EqDesign[], f: number, sampleRate: number) => {
  const theta = (2 * Math.PI * f) / sampleRate;
  const [cos, sin] = [Math.cos(theta), Math.sin(theta)];
  return 10 * Math.log10(designs.reduce((gain, design) => gain * eqGain2At(design, cos, sin), 1));
};
