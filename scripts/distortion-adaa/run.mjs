// A prototype outside the core: the aliasing of the distortion curves with the oversampling of the core (4× for
// the soft clip, 8× for the hard clip) against antiderivative antialiasing (ADAA) of the 1st and the 2nd order at
// a lower factor. The scenes are those of distortion-dsp.spec.ts (its aliasDb: the power off the harmonics of the
// tone over the power on them), with higher notes next to them.
//
//   node scripts/distortion-adaa/run.mjs
//
// The oversampling is the one of dsp-core (stereo.rs): a polyphase Kaiser sinc (β 5) of 32 taps a phase at the
// input rate, the interpolator cut at 0.9 of the nyquist, the decimator at the nyquist. The curves run in doubles
// and, the ADAA of the 1st order, in f32 as the lanes of the core would work them out (`f32`: the difference of
// two antiderivatives; `f32 Δ`: the difference worked out as one, without the cancellation).
import FFT from 'fft.js';

const RATE = 48000;
const N = 8192;
const TAPS = 32;
const BETA = 5;
const DRIVE = 10 ** (12 / 20);
const f32 = Math.fround;

// libs/math/src/filter/fir.ts
const besselI0 = (x) => {
  let sum = 1;
  let term = 1;
  for (let k = 1; term > sum * 1e-16; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
  }
  return sum;
};
const sinc = (x) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
const kaiserSinc = (x, halfWidth, beta, cutoff = 1) => {
  if (x <= -halfWidth || x >= halfWidth) return 0;
  const r = x / halfWidth;
  return (cutoff * sinc(cutoff * x) * besselI0(beta * Math.sqrt(1 - r * r))) / besselI0(beta);
};
const sincPhase = (phase, factor, cutoff, beta = BETA) => {
  const kernel = Float64Array.from({ length: TAPS }, (_, j) =>
    kaiserSinc(j - TAPS / 2 + phase / factor, TAPS / 2, beta, cutoff)
  );
  const sum = kernel.reduce((a, b) => a + b);
  return kernel.map((tap) => tap / sum);
};

// the input at `factor` × its rate
const upsample = (input, factor) => {
  const phases = Array.from({ length: factor }, (_, p) => sincPhase(p, factor, 0.9));
  const out = new Float64Array(input.length * factor);
  for (let n = TAPS; n < input.length; n++) {
    for (let p = 0; p < factor; p++) {
      let sum = 0;
      for (let j = 0; j < TAPS; j++) sum += phases[p][j] * input[n - j];
      out[n * factor + p] = sum;
    }
  }
  return out;
};
// back to the input rate: the lowpass at its nyquist, every `factor`-th point
const downsample = (points, factor, beta = BETA) => {
  const length = TAPS * factor;
  const taps = Float64Array.from(
    { length },
    (_, i) => kaiserSinc(i / factor - TAPS / 2, TAPS / 2, beta, 1) / factor
  );
  const out = new Float64Array(points.length / factor);
  for (let n = TAPS; n < out.length; n++) {
    let sum = 0;
    for (let i = 0; i < length; i++) sum += taps[i] * points[n * factor - i];
    out[n] = sum;
  }
  return out;
};

// The cascade: 4× in two stages of 2×. The first interpolates by 2 with a sinc as the one stage (cut at 0.9 of the
// nyquist; the images of the top partials are next to them), its window `centre` samples wide each way, which is
// its delay; `advance` reads its points that much of a sample later (the half point an ADAA of the 1st order at 4×
// delays: 1/8). The second is a halfband (a Kaiser sinc cut at a quarter of its rate, every other tap 0, its centre
// the input itself): the band between the sound and its images is wide by then, a few taps do. Back down the same
// way. The delay is 2 × centre + (the halves of both halfbands) / 4 samples: 32 for a centre of 15 and halfbands of
// 7 and 11 taps (the one of the one stage, the latency the chain is held to), 35 for 16 and 11 and 15 taps
const SPAN = 32;
const halfband = (length, beta) => {
  const half = (length - 1) / 2;
  return Float64Array.from({ length }, (_, i) => 0.5 * kaiserSinc((i - half) / 2, (half + 1) / 2, beta, 1));
};
// (`lift`: the sinc less that share of itself a point of 2× before and after, which lifts the top as much as the
// mean of two points of 4×, the ADAA of the 1st order, takes off sounds under the ceiling: cos(π f / 4 fs), -0.12
// dB at 10 kHz and -0.47 at 20; 1/32 leaves -0.005 and -0.08)
const upsample2 = (input, centre, beta, advance, lift = 0) => {
  const phases = [0, 1].map((p) => {
    const at = (x) => kaiserSinc(x, centre, beta, 0.9);
    const kernel = Float64Array.from({ length: SPAN }, (_, j) => {
      const x = j - centre + p / 2 + advance;
      return (1 + 2 * lift) * at(x) - lift * (at(x - 0.5) + at(x + 0.5));
    });
    const sum = kernel.reduce((a, b) => a + b);
    return kernel.map((tap) => tap / sum);
  });
  const out = new Float64Array(input.length * 2);
  for (let n = SPAN; n < input.length; n++) {
    for (let p = 0; p < 2; p++) {
      let sum = 0;
      for (let j = 0; j < SPAN; j++) sum += phases[p][j] * input[n - j];
      out[n * 2 + p] = sum;
    }
  }
  return out;
};
const downsample2 = (points, centre, beta) => {
  const taps = Float64Array.from({ length: 2 * SPAN }, (_, i) => kaiserSinc(i / 2 - centre, centre, beta, 1));
  const sum = taps.reduce((a, b) => a + b);
  const out = new Float64Array(points.length / 2);
  for (let n = SPAN; n < out.length; n++) {
    let value = 0;
    for (let i = 0; i < taps.length; i++) value += (taps[i] / sum) * points[n * 2 - i];
    out[n] = value;
  }
  return out;
};
const halfbandUp = (input, taps) => {
  const out = new Float64Array(input.length * 2);
  for (let m = taps.length; m < out.length; m++) {
    let sum = 0;
    // (the input between zeros: the taps at its samples)
    for (let i = m % 2; i < taps.length; i += 2) sum += 2 * taps[i] * input[(m - i) / 2];
    out[m] = sum;
  }
  return out;
};
const halfbandDown = (points, taps) => {
  const out = new Float64Array(points.length / 2);
  for (let n = taps.length; n < out.length; n++) {
    let sum = 0;
    for (let i = 0; i < taps.length; i++) sum += taps[i] * points[2 * n - i];
    out[n] = sum;
  }
  return out;
};
// the cascades: [centre, β of the sincs up and down, the halfbands up and down]
const CASCADE = { centre: 15, beta: [5, 5], halfbands: [halfband(7, 4), halfband(11, 5)] };
const CASCADE_35 = { centre: 16, beta: [7, 7], halfbands: [halfband(11, 6), halfband(15, 7)] };
const cascade =
  (shape, { centre, beta, halfbands: [up, down] }, advance = 0, lift = 0) =>
  (driven) =>
    downsample2(
      halfbandDown(shape(halfbandUp(upsample2(driven, centre, beta[0], advance, lift), up)), down),
      centre,
      beta[1]
    );

// Li2(-u), 0 <= u <= 1 (Landen: a series in u / (1 + u) <= 1/2)
const dilogMinus = (u) => {
  const z = u / (1 + u);
  let sum = 0;
  let power = 1;
  for (let k = 1; k < 60; k++) {
    power *= z;
    sum += power / (k * k);
  }
  return -sum - 0.5 * Math.log1p(u) ** 2;
};

// a curve, its first and second antiderivatives
const SOFT = {
  f: Math.tanh,
  // ln cosh
  F1: (x) => Math.abs(x) + Math.log1p(Math.exp(-2 * Math.abs(x))) - Math.LN2,
  F2: (x) => {
    const a = Math.abs(x);
    const value = (a * a) / 2 - a * Math.LN2 + 0.5 * dilogMinus(Math.exp(-2 * a)) + Math.PI ** 2 / 24;
    return x < 0 ? -value : value;
  },
};
const HARD = {
  f: (x) => Math.max(-1, Math.min(1, x)),
  F1: (x) => (Math.abs(x) <= 1 ? (x * x) / 2 : Math.abs(x) - 0.5),
  F2: (x) => {
    const a = Math.abs(x);
    const value = a <= 1 ? (a * a * a) / 6 : (a * a) / 2 - a / 2 + 1 / 6;
    return x < 0 ? -value : value;
  },
};

const plain =
  ({ f }) =>
  (points) =>
    points.map(f);
// the 1st order: the mean of the curve between two points
const adaa1 =
  ({ f, F1 }, eps = 1e-6) =>
  (points) => {
    const out = new Float64Array(points.length);
    for (let n = 1; n < points.length; n++) {
      const [a, b] = [points[n], points[n - 1]];
      out[n] = Math.abs(a - b) < eps ? f((a + b) / 2) : (F1(a) - F1(b)) / (a - b);
    }
    return out;
  };
// the same in f32: the antiderivatives rounded to f32 and subtracted
const adaa1Float =
  ({ f, F1 }, eps) =>
  (points) => {
    const out = new Float64Array(points.length);
    for (let n = 1; n < points.length; n++) {
      const [a, b] = [f32(points[n]), f32(points[n - 1])];
      const d = f32(a - b);
      out[n] = Math.abs(d) < eps ? f32(f(f32(f32(a + b) / 2))) : f32(f32(f32(F1(a)) - f32(F1(b))) / d);
    }
    return out;
  };
// the soft clip in f32 with the difference of ln cosh as one value: with d = |a| - |b| and e = exp(-2 |b|),
// ln cosh a - ln cosh b = d + log1p(e expm1(-2 d) / (1 + e)); each step rounded to f32
const softDeltaFloat =
  (eps = 1e-5) =>
  (points) => {
    const out = new Float64Array(points.length);
    for (let n = 1; n < points.length; n++) {
      const [a, b] = [f32(points[n]), f32(points[n - 1])];
      const dx = f32(a - b);
      if (Math.abs(dx) < eps) {
        out[n] = f32(Math.tanh(f32(f32(a + b) / 2)));
        continue;
      }
      const d = f32(Math.abs(a) - Math.abs(b));
      const e = f32(Math.exp(f32(-2 * Math.abs(b))));
      const ratio = f32(f32(e * f32(Math.expm1(f32(-2 * d)))) / f32(1 + e));
      out[n] = f32(f32(d + f32(Math.log1p(ratio))) / dx);
    }
    return out;
  };
// the hard clip in f32, its antiderivative a polynomial in each piece
const hardFloat = (eps) => adaa1Float(HARD, eps);
// the hard clip in f32 with the difference as one value: x²/2 less the square of what is over the ceiling,
// m = max(|x| - 1, 0), so the mean is (a + b) / 2 - (m(a) - m(b)) / (a - b) × (m(a) + m(b)) / 2; no cancellation
// (m(a) - m(b) is within a - b), the same point twice: the curve itself
const hardDeltaFloat = () => (points) => {
  const over = (x) => f32(Math.max(f32(Math.abs(x) - 1), 0));
  const out = new Float64Array(points.length);
  for (let n = 1; n < points.length; n++) {
    const [a, b] = [f32(points[n]), f32(points[n - 1])];
    const d = f32(a - b);
    if (d === 0) {
      out[n] = HARD.f(a);
      continue;
    }
    const [ma, mb] = [over(a), over(b)];
    out[n] = f32(f32(f32(a + b) * 0.5) - f32(f32(f32(ma - mb) / d) * f32(f32(ma + mb) * 0.5)));
  }
  return out;
};
// the 2nd order (Parker, Zavalishin, Le Bihan 2016)
const adaa2 =
  ({ f, F1, F2 }, eps = 1e-5) =>
  (points) => {
    const D = (a, b) => (Math.abs(a - b) < eps ? F1((a + b) / 2) : (F2(a) - F2(b)) / (a - b));
    const out = new Float64Array(points.length);
    for (let n = 2; n < points.length; n++) {
      const [x0, x1, x2] = [points[n], points[n - 1], points[n - 2]];
      if (Math.abs(x0 - x2) >= eps) {
        out[n] = (2 / (x0 - x2)) * (D(x0, x1) - D(x1, x2));
        continue;
      }
      const mid = (x0 + x2) / 2;
      const delta = mid - x1;
      out[n] =
        Math.abs(delta) < eps ? f((mid + x1) / 2) : (2 / delta) * (F1(mid) + (F2(x1) - F2(mid)) / delta);
    }
    return out;
  };

const render = (input, factor, shape) => {
  const driven = Float64Array.from(input, (x) => x * DRIVE);
  if (factor === 1) return shape(driven);
  // (a chain of its own)
  if (factor === 0) return shape(driven);
  return downsample(shape(upsample(driven, factor)), factor);
};

// distortion-dsp.spec.ts
const spectrum = (data, from) => {
  const fft = new FFT(N);
  const out = fft.createComplexArray();
  fft.realTransform(
    out,
    Array.from({ length: N }, (_, i) => data[from + i])
  );
  return Array.from({ length: N / 2 }, (_, k) => out[2 * k] ** 2 + out[2 * k + 1] ** 2);
};
const binFreq = (k) => (k * RATE) / N;
const db = (power) => 10 * Math.log10(power + 1e-300);
const aliasDb = (data, from, k0, maxFreq = RATE / 2) => {
  let [harmonics, aliases] = [0, 0];
  spectrum(data, from).forEach((value, k) => {
    if (k === 0 || binFreq(k) > maxFreq) return;
    if (k % k0 === 0) harmonics += value;
    else aliases += value;
  });
  return db(aliases) - db(harmonics);
};
const evenDb = (data, from, k0) => {
  const power = spectrum(data, from);
  return Math.max(...[0, 2, 4, 6, 8].map((n) => db(power[n * k0]) - db(power[k0])));
};

const LENGTH = 3 * N;
const sine = (k0) =>
  Float64Array.from({ length: LENGTH }, (_, n) => 0.5 * Math.sin((2 * Math.PI * k0 * n) / N));
const saw = (k0) => {
  const count = Math.floor(N / 2 / k0);
  const table = Array.from({ length: N }, (_, n) => {
    let sum = 0;
    for (let k = 1; k <= count; k++) sum += Math.sin((2 * Math.PI * k * k0 * n) / N) / k;
    return sum;
  });
  const loudest = Math.max(...table.map(Math.abs));
  return Float64Array.from({ length: LENGTH }, (_, n) => (0.5 * table[n % N]) / loudest);
};

// the scenes: `limit` where a spec holds the core to one (the naive curve less `better` dB too)
const SCENES = [
  { name: 'sine 2 kHz', input: sine(341), k0: 341, soft: -95, hard: null },
  { name: 'sine 7 kHz', input: sine(1195), k0: 1195, soft: null, hard: -60 },
  { name: 'sine 10 kHz', input: sine(1707), k0: 1707, soft: null, hard: null },
  { name: 'saw 521 Hz, < 16 kHz', input: saw(89), k0: 89, maxFreq: 16000, soft: -85, hard: null },
];

const VARIANTS = {
  soft: [
    ['naive 1×', 1, plain(SOFT)],
    ['4× (the core)', 4, plain(SOFT)],
    ['2×', 2, plain(SOFT)],
    ['2× ADAA 1', 2, adaa1(SOFT)],
    ['2× ADAA 1, f32', 2, adaa1Float(SOFT, 0.014)],
    ['2× ADAA 1, f32 Δ', 2, softDeltaFloat()],
    ['2× ADAA 2', 2, adaa2(SOFT)],
    ['4× ADAA 1', 4, adaa1(SOFT)],
    ['4× cascade', 0, cascade(plain(SOFT), CASCADE)],
    ['4× cascade, 35 samples', 0, cascade(plain(SOFT), CASCADE_35)],
  ],
  hard: [
    ['naive 1×', 1, plain(HARD)],
    ['8× (the core)', 8, plain(HARD)],
    ['4×', 4, plain(HARD)],
    ['2× ADAA 1', 2, adaa1(HARD)],
    ['2× ADAA 1, f32', 2, hardFloat(0.014)],
    ['2× ADAA 2', 2, adaa2(HARD)],
    ['4× ADAA 1', 4, adaa1(HARD)],
    ['4× ADAA 1, f32', 4, hardFloat(0.014)],
    ['4× ADAA 2', 4, adaa2(HARD)],
    ['4× ADAA 1, f32 Δ', 4, hardDeltaFloat()],
    ['4× cascade, ADAA 1 f32 Δ', 0, cascade(hardDeltaFloat(), CASCADE, 1 / 8)],
    ['the same, its top lifted', 0, cascade(hardDeltaFloat(), CASCADE, 1 / 8, 1 / 32)],
    ['4× casc. 35, ADAA 1 f32 Δ', 0, cascade(hardDeltaFloat(), CASCADE_35, 1 / 8)],
  ],
};

const cell = (value) => (Number.isFinite(value) ? value.toFixed(1) : '–').padStart(8);
for (const [mode, variants] of Object.entries(VARIANTS)) {
  console.log(`\n${mode} clip at a drive of 12 dB: the aliases, dB under the harmonics`);
  console.log(
    `${''.padEnd(28)}${SCENES.map(({ name, [mode]: limit }) => `${name}${limit ? ` (${limit})` : ''}`.padStart(28)).join('')}${'even harmonics'.padStart(18)}`
  );
  for (const [name, factor, shape] of variants) {
    const cells = SCENES.map(({ input, k0, maxFreq, [mode]: limit }) => {
      const value = aliasDb(render(input, factor, shape), N, k0, maxFreq);
      return `${cell(value)}${limit && factor !== 1 ? (value < limit ? ' ok' : ' no') : '   '}`.padStart(28);
    });
    const even = evenDb(render(sine(171), factor, shape), N, 171);
    console.log(`${name.padEnd(28)}${cells.join('')}${cell(even).padStart(18)}`);
  }
}
