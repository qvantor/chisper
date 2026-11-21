// The laws of the EQ of the reference out of its responses (dsp/measurements/eq.json, scripts/renders/run.mjs
// --only=eq): `node scripts/eq-fit/fit.mjs`. Each band is a biquad of the Audio EQ Cookbook at the rate of the
// render (a shelf, a peak, a pass by its type and band); the Q of each resonance of the sweep (band 1 at 1 kHz) is
// fitted, then the constants of its law (Q(0) + b·x^p, x the share of the resonance), the frequencies of the
// defaults; then the worst difference of the whole grid from the cookbook with those laws (eq.rs, eq.ts)
import { readFileSync } from 'node:fs';

const root = new URL('../..', import.meta.url).pathname;
const data = JSON.parse(readFileSync(`${root}dsp/measurements/eq.json`, 'utf8'));
const rate = data.rate;

// the cookbook: [b0, b1, b2, a0, a1, a2] of a kind
const cookbook = (kind, f0, Q, gainDb, fs) => {
  const w0 = (2 * Math.PI * f0) / fs;
  const c = Math.cos(w0);
  const al = Math.sin(w0) / (2 * Q);
  const A = 10 ** (gainDb / 40);
  const sq = 2 * Math.sqrt(A) * al;
  switch (kind) {
    case 'lowpass':
      return [(1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al];
    case 'highpass':
      return [(1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al];
    case 'peak':
      return [1 + al * A, -2 * c, 1 - al * A, 1 + al / A, -2 * c, 1 - al / A];
    case 'lowshelf':
      return [
        A * (A + 1 - (A - 1) * c + sq),
        2 * A * (A - 1 - (A + 1) * c),
        A * (A + 1 - (A - 1) * c - sq),
        A + 1 + (A - 1) * c + sq,
        -2 * (A - 1 + (A + 1) * c),
        A + 1 + (A - 1) * c - sq,
      ];
    default:
      return [
        A * (A + 1 + (A - 1) * c + sq),
        -2 * A * (A - 1 + (A + 1) * c),
        A * (A + 1 + (A - 1) * c - sq),
        A + 1 - (A - 1) * c + sq,
        2 * (A - 1 - (A + 1) * c),
        A + 1 - (A - 1) * c - sq,
      ];
  }
};
const dbAt = ([b0, b1, b2, a0, a1, a2], f, fs) => {
  const w = (2 * Math.PI * f) / fs;
  const num = Math.hypot(
    b0 + b1 * Math.cos(w) + b2 * Math.cos(2 * w),
    b1 * Math.sin(w) + b2 * Math.sin(2 * w)
  );
  const den = Math.hypot(
    a0 + a1 * Math.cos(w) + a2 * Math.cos(2 * w),
    a1 * Math.sin(w) + a2 * Math.sin(2 * w)
  );
  return 20 * Math.log10(num / den);
};
const kindOf = (band, type) =>
  type >= 2
    ? band === 1
      ? 'highpass'
      : 'lowpass'
    : type === 1
      ? 'peak'
      : band === 1
        ? 'lowshelf'
        : 'highshelf';
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// the worst and the rms difference (dB) of a measured response from a design, where it is over `floor` dB, from
// `from` Hz to `top` Hz
const differ = (gains, frequencies, c, fs, { from = 30, top = 16000, floor = -40 } = {}) => {
  let worst = 0;
  let sum = 0;
  let n = 0;
  frequencies.forEach((f, i) => {
    if (f < from || f > top || gains[i] < floor) return;
    const e = dbAt(c, f, fs) - gains[i];
    worst = Math.max(worst, Math.abs(e));
    sum += e * e;
    n++;
  });
  return { worst, rms: Math.sqrt(sum / Math.max(1, n)) };
};
// the minimum of a function of one value (golden section)
const argmin = (cost, lo, hi) => {
  for (let k = 0; k < 120; k++) {
    const m1 = lo + (hi - lo) * 0.382;
    const m2 = lo + (hi - lo) * 0.618;
    if (cost(m1) < cost(m2)) hi = m2;
    else lo = m1;
  }
  return (lo + hi) / 2;
};

// the Q of each resonance of the sweep
const qs = { 0: [], 1: [], 2: [] };
for (const [type, reso, gains] of data.q) {
  const kind = kindOf(1, type);
  const gain = type === 2 ? 0 : 12;
  const cost = (lq) =>
    differ(gains, data.qFrequencies, cookbook(kind, 1000, Math.exp(lq), gain, rate), rate).rms;
  qs[type].push([reso / 100, Math.exp(argmin(cost, Math.log(0.01), Math.log(100)))]);
}
// a law Q(0) + b·x^p: b by least squares at a power p
const law = (points, p) => {
  const [, q0] = points[0];
  let num = 0;
  let den = 0;
  for (const [x, q] of points.slice(1)) {
    num += (q - q0) * x ** p;
    den += x ** (2 * p);
  }
  const b = num / den;
  const worst = Math.max(...points.map(([x, q]) => Math.abs(q0 + b * x ** p - q) / q));
  return { q0, b, worst };
};
console.log('the Q of the resonance (band 1 at 1 kHz):');
for (const [type, points] of Object.entries(qs)) {
  const fits = [2, 3, 4, 5].map((p) => ({ p, ...law(points, p) }));
  const best = fits.reduce((a, b) => (b.worst < a.worst ? b : a));
  console.log(
    `  ${kindOf(1, +type)}: Q = ${best.q0.toFixed(4)} + ${best.b.toFixed(4)}·x^${best.p} (worst ${(100 * best.worst).toFixed(2)} % of Q)`
  );
}

// the laws as the core has them
const qOf = (type, reso) => {
  const x = clamp(reso / 100, 0, 1);
  return type === 0 ? 0.4 + 1.7416 * x ** 3 : 0.1 + 18.9 * x ** 4;
};
// the lowest frequency: that of a peak set under it
const [, , , lowReso, lowGain, lowGains] = data.clamps.find(
  ([band, type, freq]) => band === 1 && type === 1 && freq < 20
);
const lowest = Math.exp(
  argmin(
    (lf) =>
      differ(
        lowGains,
        data.frequencies,
        cookbook('peak', Math.exp(lf), qOf(1, lowReso), lowGain, rate),
        rate,
        { from: 20 }
      ).rms,
    Math.log(10),
    Math.log(40)
  )
);
console.log(`the lowest frequency: ${lowest.toFixed(2)} Hz (22050 / 1024 = ${(22050 / 1024).toFixed(2)})`);

const designOf = (band, type, freq, reso, gain, fs) =>
  cookbook(
    kindOf(band, Math.min(2, type)),
    clamp(freq, 21.53, 20000),
    qOf(Math.min(2, type), reso),
    type >= 2 ? 0 : clamp(gain, -24, 24),
    fs
  );

// the frequencies of the defaults: a shelf at 60 %
for (const [band, gain, gains] of data.defaults) {
  const cost = (lf) =>
    differ(gains, data.frequencies, designOf(band, 0, Math.exp(lf), 60, gain, rate), rate).rms;
  const f0 = Math.exp(argmin(cost, Math.log(50), Math.log(10000)));
  const { worst } = differ(gains, data.frequencies, designOf(band, 0, f0, 60, gain, rate), rate);
  console.log(`default band ${band} (gain ${gain}): ${f0.toFixed(1)} Hz, worst ${worst.toFixed(3)} dB`);
}
console.log(
  'level:',
  data.level.map(([v, db]) => `${v}: ${db} dB (4v²: ${(20 * Math.log10(4 * v * v)).toFixed(3)})`).join(', ')
);

// the grid, the clamps and the other rate against the laws
const worstOf = (rows, fs, region, frequencies = data.frequencies) =>
  rows.reduce(
    (worst, [band, type, freq, reso, gain, gains]) =>
      Math.max(
        worst,
        differ(gains, frequencies, designOf(band, type, freq, reso, gain, fs), fs, region).worst
      ),
    0
  );
const other = data.rates[96000];
for (const [name, region] of Object.entries({
  'to 16 kHz': { from: 30, top: 16000 },
  'over 16 kHz': { from: 16000, top: 21000 },
  'under 30 Hz': { from: 20, top: 30 },
})) {
  const grid = worstOf(data.grid, rate, region);
  const clamps = worstOf(data.clamps, rate, region);
  const rates = worstOf(other.rows, 96000, region, other.frequencies);
  console.log(
    `${name}: grid ${grid.toFixed(3)} dB, clamps ${clamps.toFixed(3)} dB, at 96 kHz ${rates.toFixed(3)} dB`
  );
}
