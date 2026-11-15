import { readFileSync } from 'fs';
import { join } from 'path';
import { filterModel } from '@chisper/math';
import { dB, toneOf } from '../../../test-utils/measures';

// The resonance of the ladders (MG Low) and of Low and Band 12 against the Audio Unit by the cutoff
// (dsp/measurements/filter-resonance.json, scripts/renders/run.mjs --only=filter-resonance): a quiet sine (1e-4) at a
// note, the cutoff some cents under it, its gain over 0.5..1.5 s (Hann) as the renders read it. The design the core
// plays is run in time (its sections, the droop: the core's small signal) so that a resonance of Res 1, which
// doesn't settle within the window under 1 kHz, is read as the reference's is. Its saturation (`levels`) is the
// core's: the cargo test `the_resonance_saturates_by_the_cutoff` of dsp-core/src/filter_model.rs

type PeakRow = [string, number, number, number, number];
interface Measured {
  rate: number;
  peaks: PeakRow[];
  fine: PeakRow[];
}
const MEASURED: Measured = JSON.parse(
  readFileSync(join(__dirname, '../../../../../../dsp/measurements/filter-resonance.json'), 'utf8')
);
const RATE = MEASURED.rate;
const TYPES: Record<string, filterModel.ModelFilterType> = {
  'MG Low 12': 'ladder12',
  'MG Low 24': 'ladder24',
  'Low 12': 'low12',
  'Band 12': 'band12',
};
const noteHz = (note: number) => 440 * 2 ** ((note - 69) / 12);

// the gain (dB) of a sine of f through a design, read over 0.5..1.5 s of it (Hann)
const sineGain = (design: filterModel.ModelDesign, f: number) => {
  const coefs = design.svf.map(({ g, k, mix }) => {
    const d = 1 + g * (g + k);
    return [(2 * g * (g + k)) / d, (2 * g) / d, (2 * g * g) / d, mix[0], mix[1] / 2, mix[2] / 2];
  });
  const state = design.svf.map(() => [0, 0]);
  const from = RATE / 2;
  const [x, out] = [new Float64Array(from + RATE), new Float64Array(from + RATE)];
  let before = 0;
  for (let i = 0; i < from + RATE; i++) {
    x[i] = Math.sin((2 * Math.PI * f * i) / RATE);
    let y = x[i] * design.fat;
    coefs.forEach(([c1, a2, a3, m0, h1, h2], j) => {
      const [ic1, ic2] = state[j];
      const v3 = y - ic2;
      const n1 = ic1 - c1 * ic1 + a2 * v3;
      const n2 = ic2 + a2 * ic1 + a3 * v3;
      y = m0 * y + h1 * (ic1 + n1) + h2 * (ic2 + n2);
      state[j] = [n1, n2];
    });
    out[i] = (1 - design.droop) * y + design.droop * before;
    before = y;
  }
  return dB(toneOf(out, f, RATE, from, RATE).amplitude / toneOf(x, f, RATE, from, RATE).amplitude);
};
const ours = ([name, res, note, cents]: PeakRow) => {
  const f = noteHz(note);
  const knobs = { cutoff: f * 2 ** (-cents / 1200), resonance: res, variation: 0 };
  return sineGain(filterModel.modelDesign(TYPES[name], knobs, RATE), f);
};

// the rows of a type, Res and note: a curve around its peak
const curves = (rows: PeakRow[]) => {
  const out = new Map<string, PeakRow[]>();
  rows.forEach((row) => {
    const key = `${row[0]} ${row[1]} ${row[2]}`;
    out.set(key, [...(out.get(key) ?? []), row]);
  });
  return [...out].map(([key, curve]) => [key, curve] as const);
};
const peakOf = (gains: number[]) => Math.max(...gains);

describe('the resonance of the filter against the Audio Unit by the cutoff', () => {
  // MG Low 24 on fine grids at Res 0.8..1, MG Low 12 at Res 0.9 and 1 (5 cents apart)
  const ladders = curves([...MEASURED.fine, ...MEASURED.peaks.filter(([name]) => name === 'MG Low 12')]);

  it.each(ladders.filter(([, [[, res]]]) => res < 1))(
    '%s: its curve within 1.1 dB (to 15 dB under its peak)',
    (_, curve) => {
      const top = peakOf(curve.map((row) => row[4]));
      const worst = Math.max(
        ...curve.filter((row) => row[4] > top - 15).map((row) => Math.abs(ours(row) - row[4]))
      );
      expect(worst).toBeLessThan(1.1);
    }
  );

  // (a resonance some cents wide: its peak within 1.5 dB, where it is within 4 cents of the reference's; on the grid
  // of MG Low 12, 5 cents apart, the peak falls between its points: within 2.5 dB and a step)
  it.each(ladders.filter(([, [[, res]]]) => res === 1))('%s: its peak and where it is', (_, curve) => {
    const gains = curve.map(ours);
    const theirs = curve.map((row) => row[4]);
    const step = Math.abs(curve[1][3] - curve[0][3]);
    const coarse = step > 1;
    expect(Math.abs(peakOf(gains) - peakOf(theirs))).toBeLessThan(coarse ? 2.5 : 1.5);
    const centsOf = (values: number[]) => curve[values.indexOf(peakOf(values))][3];
    expect(Math.abs(centsOf(gains) - centsOf(theirs))).toBeLessThanOrEqual(coarse ? step : 4);
  });

  it.each(curves(MEASURED.peaks.filter(([name, res]) => !name.startsWith('MG') && res < 1)))(
    '%s: within 0.1 dB',
    (_, curve) => {
      curve.forEach((row) => expect(Math.abs(ours(row) - row[4])).toBeLessThan(0.1));
    }
  );
});
