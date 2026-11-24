import FFT from 'fft.js';

// The scenes of the reverb of the reference Audio Unit (dsp/measurements/reverb.json, reverb-presets.json:
// scripts/renders/run.mjs): a chord of saws, the windows of a render read as the renders are, how far ours are from
// those of the Audio Unit

type Row = number[];
const WINDOW = 4096;
const BANDS = 25;
const dB = (energy: number) => 10 * Math.log10(energy + 1e-30);
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

// the chord of the scenes (`chord` of the file: its notes, each the sum of its harmonics under 16 kHz at 0.12 / h,
// gated from 0.2 s to 2.03 s), 6 s at `rate`
export const sceneChord = (notes: number[], rate: number) => {
  const x = new Float32Array(6 * rate);
  for (const f of notes)
    for (let h = 1; h * f < 16000; h++)
      for (let i = Math.round(0.2 * rate); i < Math.round(2.03 * rate); i++) {
        const t = i / rate;
        const gate = Math.min(1, (t - 0.2) / 0.005, (2.03 - t) / 0.03);
        x[i] += ((0.12 * gate) / h) * Math.sin(2 * Math.PI * h * f * t);
      }
  return x;
};

// the windows of a render at `times` as the file has those of the Audio Unit: [level, the share of each third
// octave]
export const sceneWindows = (
  left: Float32Array,
  right: Float32Array,
  times: number[],
  rate: number
): Row[] => {
  const fft = new FFT(WINDOW);
  return times.map((t) => {
    const from = Math.round(t * rate) - WINDOW / 2;
    let square = 0;
    const mid = new Array<number>(WINDOW);
    for (let i = 0; i < WINDOW; i++) {
      const [a, b] = [left[from + i] ?? 0, right[from + i] ?? 0];
      square += (a * a + b * b) / 2;
      mid[i] = ((a + b) / 2) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WINDOW));
    }
    const bins = fft.createComplexArray();
    fft.realTransform(bins, mid);
    const bands = new Float64Array(BANDS);
    let total = 0;
    for (let k = 4; k < WINDOW / 2; k++) {
      const e = bins[2 * k] ** 2 + bins[2 * k + 1] ** 2;
      total += e;
      const b = Math.floor(3 * Math.log2((k * rate) / WINDOW / 50) + 0.5);
      if (b >= 0 && b < BANDS) bands[b] += e;
    }
    return [dB(square / WINDOW), ...Array.from(bands, (e) => dB(e / (total + 1e-30) + 1e-9))];
  });
};

// the octaves the files read RT60 in: [centre, from, to] Hz
export const RT_OCTAVES = [63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000].map(
  (c) => [c, c / Math.SQRT2, Math.min(20000, c * Math.SQRT2)] as const
);

// the signal of `x` in each [lo, hi] Hz of `ranges` (the bins of one FFT of all of it)
const bandsOf = (x: ArrayLike<number>, ranges: (readonly [number, number])[], rate: number) => {
  let n = 1;
  while (n < x.length) n <<= 1;
  const fft = new FFT(n);
  const input = new Array<number>(n).fill(0);
  for (let i = 0; i < x.length; i++) input[i] = x[i];
  const spectrum = fft.createComplexArray();
  fft.realTransform(spectrum, input);
  fft.completeSpectrum(spectrum);
  const back = fft.createComplexArray();
  return ranges.map(([lo, hi]) => {
    const bins = spectrum.slice();
    for (let k = 0; k < n; k++) {
      const f = (Math.min(k, n - k) * rate) / n;
      if (f < lo || f > hi) bins[2 * k] = bins[2 * k + 1] = 0;
    }
    fft.inverseTransform(back, bins);
    return Float64Array.from({ length: x.length }, (_, i) => back[2 * i]);
  });
};

// The measures of a response to the impulse `dry` (at `at`) as the files have those of the Audio Unit: RT60 (s) of
// each octave (the fall of the energy left from -5 to -25 dB, from 0.1 s after the impulse, times 3), the first
// sound (ms, the first sample over 2 % of the peak), the side against the mid over 0.2..1 s (dB), the energy of all
// of it against the dry impulse (dB, over 40 Hz)
export const responseMeasures = (
  left: Float32Array,
  right: Float32Array,
  dry: Float32Array,
  at: number,
  rate: number
) => {
  const [l, r, d] = [left, right, dry].map((x) => bandsOf(x, [[40, 21000]], rate)[0]);
  let dryEnergy = 0;
  for (let i = at - 8; i < at + 400; i++) dryEnergy += 2 * d[i] * d[i];
  let wet = 0;
  for (let i = at - 8; i < l.length; i++) wet += l[i] * l[i] + r[i] * r[i];
  const mono = Float64Array.from(l, (x, i) => (x + r[i]) / 2);
  let top = 0;
  for (let i = at - 8; i < l.length; i++) top = Math.max(top, Math.abs(l[i]), Math.abs(r[i]));
  let first = at - 8;
  while (first < l.length && Math.max(Math.abs(l[first]), Math.abs(r[first])) <= top * 0.02) first++;
  let side = 0;
  let mid = 0;
  for (let i = at + Math.round(0.2 * rate); i < at + rate; i++) {
    side += ((l[i] - r[i]) / 2) ** 2;
    mid += ((l[i] + r[i]) / 2) ** 2;
  }
  const rt60 = (x: Float64Array) => {
    const from = at + Math.round(0.1 * rate);
    const remaining = new Float64Array(x.length - from);
    let sum = 0;
    for (let i = x.length - 1; i >= from; i--) remaining[i - from] = sum += x[i] * x[i];
    const reach = (level: number) => remaining.findIndex((e) => dB(e / remaining[0]) < level);
    const [a, b] = [reach(-5), reach(-25)];
    return b > 0 ? ((b - a) / rate) * 3 : NaN;
  };
  return {
    rt60: bandsOf(
      mono,
      RT_OCTAVES.map(([, lo, hi]) => [lo, hi] as const),
      rate
    ).map(rt60),
    first: ((first - at) / rate) * 1000,
    side: dB(side / (mid + 1e-30)),
    energy: dB(wet / dryEnergy),
  };
};

// How far the windows of ours are from those of the Audio Unit, over the windows where either is over -60 dB:
// `spectrum` the mean difference of the third octaves within 40 dB of the loudest, `tail` that of the levels from
// 2.2 s on (the chord is released at 2 s), `held` of the levels before
export const sceneDistance = (ours: Row[], theirs: Row[], times: number[]) => {
  const rows = ours
    .map((o, i) => ({ t: times[i], o, s: theirs[i] }))
    .filter(({ o, s }) => Math.max(o[0], s[0]) > -60);
  const spectra = rows.map(({ o, s }) => {
    const top = Math.max(...o.slice(1), ...s.slice(1));
    const apart: number[] = [];
    for (let b = 1; b <= BANDS; b++)
      if (Math.max(o[b], s[b]) > top - 40)
        apart.push(Math.abs(Math.max(o[b], top - 40) - Math.max(s[b], top - 40)));
    return mean(apart);
  });
  const levels = (from: number, to: number) =>
    mean(
      rows
        .filter(({ t }) => t >= from && t < to)
        .map(({ o, s }) => Math.abs(Math.max(o[0], -70) - Math.max(s[0], -70)))
    );
  return { spectrum: mean(spectra), tail: levels(2.2, Infinity), held: levels(0, 2.2) };
};
