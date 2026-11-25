import { readFileSync } from 'fs';
import { join } from 'path';
import { filterModel } from '@chisper/math';
import { chainState, makeChain, renderChain, slotOf } from '../../../../test-utils/chain-render';
import { fxFilterResponse, renderFxFilter } from '../../../../test-utils/fxfilter-render';
import { dB, toneOf } from '../../../../test-utils/measures';
import { CHAIN_KEYS, LFO_SOURCE, TARGET_KEYS } from '../../common/chain/chain-params';
import { FREE as FREE_LFO, lfoTable } from '../../common/lfo/lfo-curve';
import { FX_FILTER_TYPES, fxFilterIndexOf, FxFilterType, fxFilterPanOctaves } from './fxfilter-params';
import { levelGain } from './level';

// The FX Filter against the one of the Audio Unit (dsp/measurements/fxfilter.json, scripts/renders/run.mjs
// --only=fxfilter,fxfilter-routes,fxfilter-lfo). Its responses are those of the filter of a voice (filter-types.json) with more
// droop of the highs (filterModel.fxFilterDroop: by its sections): the core at the rate of the renders (48 kHz), its
// response the DFT of a quiet impulse through it at the harmonics of the measurements (where the reference is over
// -40 dB, to 12 kHz: over it the droop of a type of two sections is one filter's, the reference's more, 1 to 2 dB at
// 14 kHz); at Res 100 % (its resonance saturating) the multisine of the renders through it; Pan, the mix, the level,
// Drive, a route of a macro on the cutoff, LFO 1 on it by the laws of the reference

type Row = [string, number | 'max', number, number[]];
interface Measured {
  rate: number;
  f0: number;
  top: number;
  input: number;
  harmonics: Record<string, number[]>;
  panHarmonics: Record<string, number[]>;
  freshHarmonics: number[];
  fresh: [number[], number[]];
  untyped: [number, number, number[]][];
  responses: Row[];
  pan: [number, number, number[], number[]][];
  mix: { rows: [number, number, number, number][]; dry: [number, number, number] };
  level: [number, number][];
  driveLaw: [number, number][];
  driveCurves: [string, number, number, number, number[]][];
  routes: { rows: [number, number][]; wet: number; dryLevel: number };
  lfo: { amount: number; knob: number; cases: { res: number; division: string; hz: number }[] };
  lfoRows: [index: number, sample: number, level: number][];
}
const MEASURED: Measured = JSON.parse(
  readFileSync(join(__dirname, '../../../../../../../dsp/measurements/fxfilter.json'), 'utf8')
);
const { rate: RATE, f0: F0 } = MEASURED;

// the names of the reference and ours
const TYPES: Record<string, FxFilterType> = {
  'MG Low 6': 'ladder6',
  'MG Low 12': 'ladder12',
  'MG Low 18': 'ladder18',
  'MG Low 24': 'ladder24',
  'Low 6': 'low6',
  'Low 12': 'low12',
  'Low 18': 'low18',
  'Low 24': 'low24',
  'High 6': 'high6',
  'High 12': 'high12',
  'High 18': 'high18',
  'High 24': 'high24',
  'Band 12': 'band12',
  'Band 24': 'band24',
  'Peak 12': 'peak12',
  'Peak 24': 'peak24',
  'Notch 12': 'notch12',
  'Notch 24': 'notch24',
};
const cutOf = (cut: number | 'max') => (cut === 'max' ? 22050 : cut);

// the response (dB) of the core of these params at `frequencies`: an impulse of 0.01 (the small signal: a sine of
// the measurements under the saturation of its resonance), the DFT of what came out at each one
const N = 1 << 15;
const responseOf = (params: Parameters<typeof renderFxFilter>[0], frequencies: number[], channel = 0) =>
  fxFilterResponse(params, RATE, frequencies, { amplitude: 0.01, n: N, channel });

// the worst difference (dB) of ours from the measured where the measured is over -40 dB, to `top` Hz
const worst = (ours: number[], measured: number[], harmonics: number[], top = 12000) =>
  harmonics.reduce(
    (most, h, i) =>
      h * F0 > top || measured[i] < -40 ? most : Math.max(most, Math.abs(ours[i] - measured[i])),
    0
  );

describe('fxfilter against the Audio Unit', () => {
  it('is MG Low 6 at the knob of a half (425 Hz), all wet, without a type or a knob written', () => {
    const [left, right] = MEASURED.fresh;
    const params = { type: fxFilterIndexOf('ladder6'), cutoff: 425 };
    const hs = MEASURED.freshHarmonics;
    const ours = responseOf(
      params,
      hs.map((h) => h * F0)
    );
    expect(worst(ours, left, hs)).toBeLessThan(0.3);
    expect(right).toEqual(left);
    MEASURED.untyped.forEach(([cut, res, gains]) => {
      const harmonics = MEASURED.harmonics[cut];
      const typed = responseOf(
        { type: 0, cutoff: cut, res: res * 100 },
        harmonics.map((h) => h * F0)
      );
      expect(worst(typed, gains, harmonics)).toBeLessThan(0.5);
    });
  });

  // a type at its cutoff and resonance, Drive and Fat 0: within 0.5 dB to 12 kHz of cutoffs up to 3 kHz at Res up to
  // a half; more of some types around a cutoff of 3 kHz (the model of the voice has them so: filter-types-measured
  // .spec holds it to the voice of the reference with the like)
  const TOLERANCE: Partial<Record<FxFilterType, number>> = {
    low6: 0.7,
    low12: 1,
    low18: 1.1,
    low24: 1.3,
    high12: 1,
    high18: 1,
    high24: 1.5,
    band12: 0.9,
    band24: 1.2,
    peak12: 1.1,
    peak24: 1.8,
    notch12: 1.3,
    notch24: 1.3,
  };
  it.each(FX_FILTER_TYPES.map((type) => [type]))('%s plays the responses of the reference', (type) => {
    const name = Object.keys(TYPES).find((key) => TYPES[key] === type);
    const rows = MEASURED.responses.filter(
      ([t, cut, res]) => t === name && cut !== 'max' && cut <= 3000 && res <= 0.5
    );
    expect(rows.length).toBeGreaterThan(0);
    rows.forEach(([, cut, res, gains]) => {
      const harmonics = MEASURED.harmonics[cut];
      const ours = responseOf(
        { type: fxFilterIndexOf(type), cutoff: cutOf(cut), res: res * 100 },
        harmonics.map((h) => h * F0)
      );
      expect([cut, res, worst(ours, gains, harmonics)]).toEqual([cut, res, expect.any(Number)]);
      expect(worst(ours, gains, harmonics)).toBeLessThan(TOLERANCE[type] ?? 0.5);
    });
  });

  // Res 100 %: the resonance saturates under the multisine of the renders (its peak 14 to 30 dB over the small
  // signal's, which an impulse would read), so the multisine itself through the core, at the level the rack takes it
  // (`input` under the sample), read as the renders are (Hann over 1 s from 0.5 s): every type of a cutoff up to 3
  // kHz within its tolerance, MG Low up to 300 Hz. Not held: MG Low from 1 kHz (its peak higher: 1.8 dB at 3 kHz,
  // 5.5 dB off around it), every type at 8 kHz (its peak 3 dB higher)
  it('at Res 100 % plays the responses of the reference through its multisine', () => {
    const { top: TOP } = MEASURED;
    // a sum of the harmonics by a phasor each (a cosine a sample of 657 harmonics was a second of the spec)
    const multisine = (rate: number, length: number) => {
      const x = new Float64Array(length);
      for (let h = 1; h <= TOP; h++) {
        const w = (2 * Math.PI * h * F0) / rate;
        const phi = (Math.PI * h * (h - 1)) / TOP;
        const [cw, sw] = [Math.cos(w), Math.sin(w)];
        let [c, s] = [Math.cos(phi), Math.sin(phi)];
        for (let i = 0; i < length; i++) {
          x[i] += c;
          [c, s] = [c * cw - s * sw, s * cw + c * sw];
        }
      }
      return x;
    };
    // (its amplitude 0.09 in the sample of 44.1 kHz)
    const peak = multisine(44100, Math.round(1.6 * 44100)).reduce(
      (most, v) => Math.max(most, Math.abs(v)),
      0
    );
    const each = (0.09 / peak) * 10 ** (MEASURED.input / 20);
    const x = multisine(RATE, Math.round(1.6 * RATE)).map((v) => v * each);
    // the amplitudes of `frequencies` in y (toneOf's Hann over 1 s from 0.5 s, a phasor a frequency)
    const n = RATE;
    const levels = (y: ArrayLike<number>, frequencies: number[]) => {
      let sum = 0;
      const windowed = Float64Array.from({ length: n }, (_, i) => {
        const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
        sum += w;
        return y[n / 2 + i] * w;
      });
      return frequencies.map((hz) => {
        const step = (2 * Math.PI * hz) / RATE;
        const [cw, sw] = [Math.cos(step), Math.sin(step)];
        let [c, s] = [Math.cos(step * (n / 2)), Math.sin(step * (n / 2))];
        let [re, im] = [0, 0];
        for (let i = 0; i < n; i++) {
          re += windowed[i] * c;
          im += windowed[i] * s;
          [c, s] = [c * cw - s * sw, s * cw + c * sw];
        }
        return (2 * Math.hypot(re, im)) / sum;
      });
    };
    const rows = MEASURED.responses.filter(
      ([name, cut, res]) =>
        res === 1 && cut !== 'max' && cut <= (TYPES[name].startsWith('ladder') ? 300 : 3000)
    );
    expect(rows).toHaveLength(14 * 4 + 4 * 2);
    rows.forEach(([name, cut, , gains]) => {
      const type = TYPES[name];
      const harmonics = MEASURED.harmonics[cut];
      const frequencies = harmonics.map((h) => h * F0);
      const y = renderFxFilter({ type: fxFilterIndexOf(type), cutoff: cutOf(cut), res: 100 }, RATE, [
        x,
        x,
      ]).left;
      const ours = levels(y, frequencies).map((level) => dB(level / each));
      expect([name, cut, worst(ours, gains, harmonics) < (TOLERANCE[type] ?? 0.5)]).toEqual([
        name,
        cut,
        true,
      ]);
    });
  });

  // Pan: the cutoff of the left channel up and of the right one down by 32 x³ semitones (Low 12 at Res 0.75: its
  // peaks where the reference has them), both responses within 1 dB (the model of the voice at Res 0.75)
  it('pans the cutoffs of its channels by the law of the reference', () => {
    MEASURED.pan.forEach(([cut, pan, left, right]) => {
      const harmonics = MEASURED.panHarmonics[cut];
      const params = { type: fxFilterIndexOf('low12'), cutoff: cut, res: 75, pan };
      const frequencies = harmonics.map((h) => h * F0);
      expect([cut, pan, worst(responseOf(params, frequencies, 0), left, harmonics)]).toEqual([
        cut,
        pan,
        expect.any(Number),
      ]);
      expect(worst(responseOf(params, frequencies, 0), left, harmonics)).toBeLessThan(1);
      expect(worst(responseOf(params, frequencies, 1), right, harmonics)).toBeLessThan(1);
    });
    expect(fxFilterPanOctaves(0)).toBeCloseTo(32 / 12, 12);
    expect(fxFilterPanOctaves(100)).toBeCloseTo(-32 / 12, 12);
  });

  // the mix: a render at Wet w is a·(Wet 0) + b·(Wet 100), a = 1 - b², b = sin²(π w / 2), the dry signal in time
  it('mixes as the reference: wet sin²(π mix / 2), dry 1 - wet²', () => {
    MEASURED.mix.rows.forEach(([wet, a, b]) => {
      const share = Math.sin((Math.PI * wet) / 200);
      const w = share * share;
      expect(Math.abs(w - b)).toBeLessThan(0.001);
      expect(Math.abs(1 - w * w - a)).toBeLessThan(0.001);
    });
    expect(MEASURED.mix.dry[0]).toBeCloseTo(1, 3);
    // the core: Low 12 at 1 kHz, Res 50 on a tone of 3 partials, at Wet 0, 25, 50, 100
    const tone = Float64Array.from(
      { length: 8192 },
      (_, i) => 0.3 * Math.sin(i / 7) + 0.2 * Math.sin(i / 2.3) + 0.1 * Math.sin(i / 0.9)
    );
    const params = { type: fxFilterIndexOf('low12'), cutoff: 1000, res: 50 };
    const at = (mix: number) => renderFxFilter(params, RATE, [tone, tone], [], mix).left;
    const [dry, wet] = [at(0), at(1)];
    expect(Array.from(dry.subarray(0, 64))).toEqual(Array.from(Float32Array.from(tone.subarray(0, 64))));
    [0.25, 0.5, 0.9].forEach((mix) => {
      const y = at(mix);
      const share = Math.sin((Math.PI * mix) / 2);
      const w = share * share;
      for (let i = 0; i < 8192; i += 13)
        expect(Math.abs(y[i] - ((1 - w * w) * dry[i] + w * wet[i]))).toBeLessThan(1e-6);
    });
  });

  it('has the level of the reference: × 4 knob², of the dry signal too', () => {
    const frequency = 3 * F0;
    MEASURED.level
      .filter(([knob]) => knob > 0)
      .forEach(([knob, gain]) => expect(Math.abs(dB(levelGain(knob)) - gain)).toBeLessThan(0.05));
    const tone = Float64Array.from(
      { length: 2 * RATE },
      (_, i) => 0.1 * Math.sin((2 * Math.PI * frequency * i) / RATE)
    );
    const through = (level: number, mix: number) =>
      toneOf(
        renderFxFilter({ type: fxFilterIndexOf('low12'), cutoff: 22050, level }, RATE, [tone, tone], [], mix)
          .left,
        frequency,
        RATE,
        RATE / 2,
        RATE
      ).amplitude;
    // (the reference at Wet 0, Level 0.25: its dry signal 12 dB down)
    expect(MEASURED.routes.dryLevel - MEASURED.routes.wet).toBeCloseTo(-12.04, 1);
    const unity = through(0.5, 1);
    expect(dB(through(0.25, 1) / unity)).toBeCloseTo(-12.04, 1);
    expect(dB(through(0.25, 0) / unity)).toBeCloseTo(-12.04, 1);
  });

  // Drive: the gain of a quiet sine by the knob ((1 + d)⁴), the saturation of louder ones (the curve of the filter
  // of a voice: filter-types-measured.spec holds it, the same in the core)
  it('drives as the reference', () => {
    const frequency = 220;
    const sine = (amplitude: number) =>
      Float64Array.from(
        { length: 1.5 * RATE },
        (_, i) => amplitude * Math.sin((2 * Math.PI * frequency * i) / RATE)
      );
    const gainOf = (drive: number, amplitude: number, type: FxFilterType) => {
      const input = sine(amplitude);
      const out = renderFxFilter({ type: fxFilterIndexOf(type), cutoff: 22050, drive: drive * 100 }, RATE, [
        input,
        input,
      ]).left;
      const from = RATE / 2;
      const level = (x: ArrayLike<number>) => toneOf(x, frequency, RATE, from, RATE).amplitude;
      return dB(level(out) / level(input));
    };
    MEASURED.driveLaw.forEach(([drive, gain]) =>
      expect(Math.abs(gainOf(drive, 0.001, 'low12') - gain)).toBeLessThan(0.1)
    );
    MEASURED.driveCurves
      .filter(([, drive, amplitude]) => drive > 0 && amplitude <= 0.3)
      .forEach(([name, drive, amplitude, gain]) =>
        expect([
          name,
          drive,
          amplitude,
          Math.abs(gainOf(drive, amplitude, TYPES[name]) - gain) < 0.15,
        ]).toEqual([name, drive, amplitude, true])
      );
    expect(filterModel.driveGain(1)).toBe(16);
  });

  // a route of a macro on the cutoff: an amount of the travel of the knob of the reference (136.8 semitones), ours of
  // the travel of the knob in octaves (log2(22050 / 8.176)): the same within 0.03 %
  it('moves its cutoff by a route as the reference does', () => {
    const ours = Math.log2(22050 / 8.176);
    expect(Math.abs(ours / (136.8 / 12) - 1)).toBeLessThan(0.0003);
    const tone = Float64Array.from(
      { length: RATE },
      (_, i) => 0.3 * Math.sin((2 * Math.PI * 2000 * i) / RATE)
    );
    const knob = 440 * 2 ** ((136.8 * 0.5 - 69) / 12);
    MEASURED.routes.rows
      .filter(([amount]) => Math.abs(amount) <= 30)
      .forEach(([amount, level]) => {
        const cutoff = knob * 2 ** ((ours * amount) / 100);
        const out = renderFxFilter({ type: fxFilterIndexOf('low12'), cutoff }, RATE, [tone, tone]).left;
        const ourLevel = dB(toneOf(out, 2000, RATE, RATE / 2, RATE / 2).amplitude / 0.3);
        // (the reference read at its peaks over a period, its level against the sample at the rack -9 dB)
        expect([amount, Math.abs(ourLevel - (level - MEASURED.routes.wet)) < 0.5]).toEqual([amount, true]);
      });
  });

  // LFO 1 (a triangle from 0 up, from the note) on the cutoff by 30 % of the travel of the knob of the reference (ours
  // that share of its octaves) from 425 Hz: the level of a sine of 2 kHz through Low 12 along a cycle, at 2 to 16 Hz
  // and Res 0 and 50 %, within 0.3 dB of the renders at every point (0.2 at most: the routes of the core are lines
  // read at the points of their spans, the reference smooths none: the same depth at 16 Hz as at 2)
  it('follows LFO 1 on its cutoff as the reference does', () => {
    const { amount, knob, cases } = MEASURED.lfo;
    const cutoff = 440 * 2 ** ((136.8 * knob - 69) / 12);
    const octaves = (amount / 100) * Math.log2(22050 / 8.176);
    const period = RATE / 2000;
    // the sine of the renders (from sample 0 here: the rows are counted from its start)
    const sine = Float32Array.from(
      { length: Math.round(2.6 * RATE) },
      (_, i) => 0.3 * Math.sin((2 * Math.PI * 2000 * i) / RATE) * Math.min(1, (i * 44100) / RATE / 2000)
    );
    const target = slotOf('fxfilter') * TARGET_KEYS + CHAIN_KEYS.fxfilter.indexOf('cutoff');
    cases.forEach(({ res, division, hz }, index) => {
      const lfos = [0, 1, 2, 3].map(() => ({
        mode: FREE_LFO,
        delay: 0,
        rise: 0,
        smooth: 0,
        phase: 0,
        anchor: { time: 0, phase: 0, period: 1 / hz },
        table: lfoTable('triangle'),
      }));
      const state = chainState(
        ['fxfilter'],
        1,
        { fxfilter: { params: { type: fxFilterIndexOf('low12'), cutoff, res: res * 100 } } },
        {
          routes: [{ target, source: LFO_SOURCE, amount: octaves, min: 8.176, max: 22050, scale: 'log' }],
          lfos: { at: 0, instantly: true, lfos },
        }
      );
      const { left } = renderChain(makeChain(state, RATE), [sine, sine]);
      // the level of the sine at `n` (dB against 0.3): the rms of a period, centred, × √2
      const levelAt = (n: number) => {
        let sum = 0;
        for (let k = -period / 2; k < period / 2; k++) sum += left[n + k] ** 2;
        return dB(Math.sqrt((2 * sum) / period) / 0.3);
      };
      // (the reference against its dry sine through the rack)
      const rows = MEASURED.lfoRows
        .filter(([of]) => of === index)
        .map(([, n, level]) => [levelAt(n), level - MEASURED.routes.wet]);
      const off = Math.max(...rows.map(([ours, theirs]) => Math.abs(ours - theirs)));
      expect([res, division, off < 0.3]).toEqual([res, division, true]);
      const swing = (values: number[]) => Math.max(...values) - Math.min(...values);
      const depth = swing(rows.map(([ours]) => ours)) / swing(rows.map(([, theirs]) => theirs));
      expect([res, division, Math.abs(depth - 1) < 0.02]).toEqual([res, division, true]);
    });
  });
});
