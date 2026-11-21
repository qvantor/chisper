import { readFileSync } from 'fs';
import { join } from 'path';
import FFT from 'fft.js';
import { bandParams, renderEq } from '../../../../test-utils/eq-render';
import { EQ_BANDS, type EqDspParams } from './eq-params';
import { levelGain } from './level';

// The EQ against the Audio Unit (dsp/measurements/eq.json, scripts/renders/run.mjs --only=eq): the impulse of the
// stand (after its quiet tone) through the core at the rate of the renders, read as the stand reads it (the FFT of
// 2^16 samples from the impulse over the one of the input, at the bins of `frequencies`). The bands are the
// cookbook at the rate of the context with the laws of the reference (scripts/eq-fit/fit.mjs finds them in the
// measurements); they are compared where the reference is over -40 dB (under it the noise of the stand)

type Row = [number, number, number, number, number, number[]];
interface Measured {
  rate: number;
  frequencies: number[];
  qFrequencies: number[];
  fresh: [number, number][];
  level: [number, number][];
  defaults: [number, number, number[]][];
  clamps: Row[];
  phase: [number, number, number, number, number, [number, number][]][];
  q: [number, number, number[]][];
  grid: Row[];
  rates: Record<string, { frequencies: number[]; rows: Row[] }>;
}
const MEASURED: Measured = JSON.parse(
  readFileSync(join(__dirname, '../../../../../../../dsp/measurements/eq.json'), 'utf8')
);
const { rate: RATE } = MEASURED;

const N = 1 << 16;
// the sample of the stand at a rate: a quiet tone of 1 kHz until 0.35 s (fading out over 2000 samples), an impulse
// at 0.4 s, room for the FFT after it
const stand = (rate: number) => {
  const at = Math.round(0.4 * rate);
  const signal = new Float64Array(at + N + 1000);
  const end = Math.round(0.35 * rate);
  for (let i = 0; i < end; i++)
    signal[i] = 1e-3 * Math.sin((2 * Math.PI * 1000 * i) / rate) * Math.min(1, (end - i) / 2000);
  signal[at] = 0.5;
  return { signal, at };
};
const fft = new FFT(N);
const transform = (x: Float32Array, from: number) => {
  const bins = fft.createComplexArray();
  fft.realTransform(bins, x.subarray(from, from + N));
  return bins as number[];
};
const stands = new Map<number, { signal: Float64Array; at: number; dry: number[] }>();
const standAt = (rate: number) => {
  let found = stands.get(rate);
  if (!found) {
    const { signal, at } = stand(rate);
    found = { signal, at, dry: transform(Float32Array.from(signal), at - 64) };
    stands.set(rate, found);
  }
  return found;
};

// the response [dB, degrees] of the core of `params` at `frequencies` (bins of N at `rate`), as the stand reads it
const respond = (params: Partial<EqDspParams>, frequencies: number[], rate = RATE) => {
  const { signal, at, dry } = standAt(rate);
  const { left } = renderEq(params, rate, [signal, signal]);
  const bins = transform(left, at - 64);
  return frequencies.map((hz) => {
    const k = Math.round((hz * N) / rate);
    const power = dry[2 * k] ** 2 + dry[2 * k + 1] ** 2;
    const re = (bins[2 * k] * dry[2 * k] + bins[2 * k + 1] * dry[2 * k + 1]) / power;
    const im = (bins[2 * k + 1] * dry[2 * k] - bins[2 * k] * dry[2 * k + 1]) / power;
    return [10 * Math.log10(re * re + im * im), (Math.atan2(im, re) * 180) / Math.PI];
  });
};
// the params of band `band` of the measurements (1, 2)
const paramsOf = (band: number, type: number, freq: number, reso: number, gain: number) =>
  bandParams(band - 1, type, freq, reso, gain);

// the worst difference (dB) of a response of ours from a measured one, where the measured one is over -40 dB, from
// `from` Hz to `to` Hz
const worst = (ours: number[], measured: number[], frequencies: number[], from = 20, to = Infinity) =>
  measured.reduce(
    (most, db, i) =>
      db > -40 && frequencies[i] >= from && frequencies[i] <= to
        ? Math.max(most, Math.abs(ours[i] - db))
        : most,
    0
  );
// the response (dB) of ours of a row of the measurements at their frequencies
const rowDb = ([band, type, freq, reso, gain]: Row) =>
  respond(paramsOf(band, type, freq, reso, gain), MEASURED.frequencies).map(([db]) => db);

// the grid by band and type
const GROUPS = [
  [1, 0, 'low shelf'],
  [2, 0, 'high shelf'],
  [1, 1, 'peak of band 1'],
  [2, 1, 'peak of band 2'],
  [1, 2, 'highpass'],
  [2, 2, 'lowpass'],
] as const;

describe('eq against the Audio Unit', () => {
  jest.setTimeout(60000);

  it('a fresh one is the sound as it is', () => {
    MEASURED.fresh.forEach(([db]) => expect(Math.abs(db)).toBeLessThan(0.005));
    respond({}, MEASURED.frequencies).forEach(([db]) => expect(Math.abs(db)).toBeLessThan(1e-6));
  });

  it('its defaults are those of the reference: shelves at 210 Hz and 2.04 kHz of 60 %', () => {
    MEASURED.defaults.forEach(([band, gain, measured]) => {
      const ours = respond({ [EQ_BANDS[band - 1].gain]: gain }, MEASURED.frequencies).map(([db]) => db);
      expect(worst(ours, measured, MEASURED.frequencies)).toBeLessThan(0.05);
    });
  });

  it('its level: × 4 knob²', () => {
    MEASURED.level.forEach(([knob, db]) => expect(20 * Math.log10(levelGain(knob))).toBeCloseTo(db, 2));
  });

  it.each(GROUPS)(
    'band %d, type %d (%s): the response of the grid, to 0.1 dB to 16 kHz, 0.02 dB over it (the task: 0.3 dB, 1 dB)',
    (band, type) => {
      const rows = MEASURED.grid.filter(([b, t]) => b === band && t === type);
      expect(rows.length).toBeGreaterThan(20);
      rows.forEach((row) => {
        const ours = rowDb(row);
        expect(worst(ours, row[5], MEASURED.frequencies, 20, 16000)).toBeLessThan(0.1);
        expect(worst(ours, row[5], MEASURED.frequencies, 16000)).toBeLessThan(0.02);
      });
    }
  );

  it('its knobs out of their ranges are at their ends, as there', () => {
    MEASURED.clamps.forEach((row) =>
      expect(worst(rowDb(row), row[5], MEASURED.frequencies)).toBeLessThan(0.05)
    );
  });

  it('the resonance by its law: the sweep at 1 kHz, every type', () => {
    MEASURED.q.forEach(([type, reso, measured]) => {
      const ours = respond(paramsOf(1, type, 1000, reso, 12), MEASURED.qFrequencies).map(([db]) => db);
      expect(worst(ours, measured, MEASURED.qFrequencies)).toBeLessThan(0.05);
    });
  });

  it('its phase is the one of the reference: minimum phase, the same filters', () => {
    MEASURED.phase.forEach(([band, type, freq, reso, gain, measured]) => {
      const ours = respond(paramsOf(band, type, freq, reso, gain), MEASURED.frequencies);
      measured.forEach(([db, degrees], i) => {
        if (db < -40 || MEASURED.frequencies[i] < 20) return;
        const apart = Math.abs(((ours[i][1] - degrees + 540) % 360) - 180);
        expect(apart).toBeLessThan(1);
      });
    });
  });

  it('at another rate the bands are designed at it, as there (the bilinear transform of the rate)', () => {
    Object.entries(MEASURED.rates).forEach(([rate, { frequencies, rows }]) =>
      rows.forEach(([band, type, freq, reso, gain, measured]) => {
        const ours = respond(paramsOf(band, type, freq, reso, gain), frequencies, +rate).map(([db]) => db);
        expect(worst(ours, measured, frequencies)).toBeLessThan(0.05);
      })
    );
  });
});
