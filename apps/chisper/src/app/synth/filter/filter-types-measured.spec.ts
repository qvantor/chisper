import { readFileSync } from 'fs';
import { join } from 'path';
import { filterModel } from '@chisper/math';
import { dB } from '../../../test-utils/measures';

// The model types of the filter against the Audio Unit (dsp/measurements/filter-types.json, scripts/renders/run.mjs
// --only=filter-types): the response of the design the core plays (filter-model.spec holds the core to it) at the
// harmonics the renders read, the laws of Drive, DB +/- and FAT. The tolerances: ±0.5 dB to 16 kHz for a cutoff
// up to 8 kHz and Res up to 50 % (above -40 dB, where it is heard against the passband); the 18 and 24 dB ones,
// Band 24 and Notch (away from its notch) within 0.7 dB; Peak to a cutoff of 3 kHz; the EQ ones at DB +/- of 25 to
// 75 %. Deliberate differences: a cutoff near nyquist (a section of the sample rate can't follow the prototype of the
// reference there: up to 1–2 dB at 16 kHz with a cutoff over 15 kHz), the dip of High EQ at DB +/- 0 (the input and
// the tap of the reference out of phase), the resonant shelves of Low and High EQ 12 at the top of DB +/-. The
// saturation of the resonance (the `fat` rows louder than 0.001) is the core's: the cargo test `saturation` of
// dsp-core/src/filter_model.rs holds the core to them (level, the 3rd harmonic, the resonance of Res 1)

type Row = [string, number | 'max', number, number[]];
type EqRow = [string, number, number, number, number[]];
type SineRow = [string, number, number, number, number, number[]];
interface Measured {
  rate: number;
  f0: number;
  harmonics: Record<string, number[]>;
  responses: Row[];
  eq: EqRow[];
  dbLaw: [number, number, number][];
  driveLaw: [number, number][];
  driveCurves: [string, number, number, number, number[]][];
  fat: SineRow[];
  fatResponses: [string, number, number, number[]][];
}
const MEASURED: Measured = JSON.parse(
  readFileSync(join(__dirname, '../../../../../../dsp/measurements/filter-types.json'), 'utf8')
);
const { rate: RATE, f0: F0 } = MEASURED;

// the types by their names in the reference (MG Low as Ladder)
const TYPES: Record<string, filterModel.ModelFilterType> = {
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
  'Low EQ 6': 'loweq6',
  'Low EQ 12': 'loweq12',
  'Band EQ 12': 'bandeq12',
  'High EQ 6': 'higheq6',
  'High EQ 12': 'higheq12',
};

const responseDb = (type: filterModel.ModelFilterType, knobs: filterModel.ModelKnobs, f: number) =>
  10 * Math.log10(filterModel.designGain2(filterModel.modelDesign(type, knobs, RATE), f, RATE));

// the worst difference (dB) of ours from a measured row at the harmonics read (to 16 kHz, above -40 dB, away from
// the notch of a notch)
const worstOf = (
  type: filterModel.ModelFilterType,
  cut: number | 'max',
  knobs: filterModel.ModelKnobs,
  gains: number[]
) => {
  const design = filterModel.modelDesign(type, knobs, RATE);
  let worst = 0;
  MEASURED.harmonics[cut].forEach((h, i) => {
    const f = h * F0;
    if (f > 16000 || gains[i] < -40) return;
    if (type.startsWith('notch') && Math.abs(Math.log2(f / knobs.cutoff)) < 0.3) return;
    const e = 10 * Math.log10(filterModel.designGain2(design, f, RATE)) - gains[i];
    if (Math.abs(e) > Math.abs(worst)) worst = e;
  });
  return worst;
};

const TOLERANCE: Partial<Record<filterModel.ModelFilterType, number>> = {
  low18: 0.7,
  low24: 0.7,
  high18: 0.7,
  high24: 0.7,
  band24: 0.7,
  notch12: 0.7,
  notch24: 1.1,
  peak12: 0.7,
  // (its Res 0 a band of 6 dB down that the reference cuts deeper, 1.2 dB)
  peak24: 1.3,
};

describe('the model types of the filter against the Audio Unit', () => {
  const rows = MEASURED.responses.filter(([name, cut, res]) => {
    const type = TYPES[name];
    const top = type.startsWith('peak') ? 3000 : 8000;
    return cut !== 'max' && cut <= top && res <= 0.5;
  });

  it.each(rows.map(([name, cut, res, gains]) => [name, cut, res, gains] as const))(
    '%s at %s Hz, Res %s',
    (name, cut, res, gains) => {
      const type = TYPES[name];
      const worst = worstOf(type, cut, { cutoff: cut as number, resonance: res, variation: 0 }, gains);
      expect(Math.abs(worst)).toBeLessThan(TOLERANCE[type] ?? 0.5);
    }
  );

  it.each(
    MEASURED.responses
      .filter(
        ([name, cut, res]) => res === 0.75 && cut !== 'max' && cut <= 8000 && !TYPES[name].startsWith('peak')
      )
      .map(([name, cut, , gains]) => [name, cut, gains] as const)
  )('%s at %s Hz: its resonance (Res 75 %) within 1.5 dB', (name, cut, gains) => {
    const worst = worstOf(TYPES[name], cut, { cutoff: cut as number, resonance: 0.75, variation: 0 }, gains);
    expect(Math.abs(worst)).toBeLessThan(1.5);
  });

  // a cutoff of 15 kHz without resonance: the poles of the prototype are real there and the second has met the
  // root of the delay (the design keeps it where they met). Low and Band as below 8 kHz, Notch within 1.5 dB, High
  // within 3 dB (near nyquist: the deliberate difference above; two poles on one root were 6 to 12 dB off for High,
  // 4 to 9 dB for Notch)
  it.each(
    MEASURED.responses
      .filter(
        ([name, cut, res]) => cut === 15000 && res === 0 && /^(Low|High|Band|Notch) (12|18|24)$/.test(name)
      )
      .map(([name, cut, , gains]) => [name, cut, gains] as const)
  )('%s at %s Hz without resonance', (name, cut, gains) => {
    const worst = worstOf(TYPES[name], cut, { cutoff: cut as number, resonance: 0, variation: 0 }, gains);
    const within = name.startsWith('High') ? 3 : name.startsWith('Notch') ? 1.5 : 0.5;
    expect(Math.abs(worst)).toBeLessThan(within);
  });

  it.each(
    MEASURED.eq
      .filter(([, cut, res, v]) => v >= 0.25 && v <= 0.75 && res <= 0.5 && cut <= 3000)
      .map(([name, cut, res, v, gains]) => [name, cut, res, v, gains] as const)
  )('%s at %s Hz, Res %s, DB +/- %s', (name, cut, res, v, gains) => {
    const type = TYPES[name];
    const worst = worstOf(type, cut, { cutoff: cut, resonance: res, variation: v }, gains);
    expect(Math.abs(worst)).toBeLessThan(type === 'loweq12' ? 1.5 : 0.8);
  });

  it('DB +/- is the gain of the band of the EQ types: 0 at 0, 0 dB at 50 %, +19 dB at 100 %', () => {
    MEASURED.dbLaw.forEach(([v, low]) => {
      // (Low EQ 6 at 1 kHz on 32.7 Hz: the shelf all there, the input of the highpass besides it at 0)
      if (v === 0) return;
      expect(dB(filterModel.eqGain(v))).toBeCloseTo(low, 0);
      expect(Math.abs(dB(filterModel.eqGain(v)) - low)).toBeLessThan(0.1);
    });
  });

  it('Drive is a gain of (1 + d)⁴ into the filter', () => {
    MEASURED.driveLaw.forEach(([drive, gain]) => {
      expect(Math.abs(dB(filterModel.driveGain(drive)) - gain)).toBeLessThan(0.05);
    });
  });

  it('the curve of Drive: its level and its odd harmonics on a sine', () => {
    // the fundamental and the third of x - x³/(3 UT²) clipped at UT, of a sine of amplitude A × (1 + d)⁴
    const UT = filterModel.DRIVE_UT;
    const curve = (u: number) =>
      Math.abs(u) < UT ? u - (u * u * u) / (3 * UT * UT) : Math.sign(u) * ((2 * UT) / 3);
    const harmonic = (k: number, amplitude: number) => {
      let sum = 0;
      for (let i = 0; i < 4096; i++)
        sum += curve(amplitude * Math.sin((2 * Math.PI * i) / 4096)) * Math.sin((2 * Math.PI * k * i) / 4096);
      return (2 * sum) / 4096;
    };
    MEASURED.driveCurves
      .filter(([type]) => type === 'Low 12')
      .forEach(([, drive, amplitude, gain, harmonics]) => {
        const u = amplitude * filterModel.driveGain(drive);
        const [h1, h3] = [harmonic(1, u), harmonic(3, u)];
        expect(Math.abs(dB(h1 / amplitude) - gain)).toBeLessThan(0.1);
        // (a third under -100 dB: the measurement's floor)
        if (harmonics[1] > -100) expect(Math.abs(dB(Math.abs(h3) / h1) - harmonics[1])).toBeLessThan(1.5);
      });
  });

  it('FAT is a gain of 1 + 4 Res FAT into the filter: the quiet response with it within 0.5 dB (Res to 75 %)', () => {
    // (the multisine at 1 kHz; the pass band too: the reference's FAT gives back the drop of its resonance there)
    MEASURED.fatResponses
      .filter(([name, res]) => res <= 0.75 && TYPES[name] !== undefined)
      .forEach(([name, res, v, gains]) => {
        const worst = worstOf(TYPES[name], 1000, { cutoff: 1000, resonance: res, variation: v }, gains);
        expect([name, res, v, Math.abs(worst) < 0.5]).toEqual([name, res, v, true]);
      });
  });

  it('FAT lifts the small resonance as the reference does (a quiet sine at the cutoff)', () => {
    MEASURED.fat
      .filter(([name, res, , amplitude]) => amplitude === 0.001 && res < 1 && TYPES[name] !== undefined)
      .forEach(([name, res, v, , gain]) => {
        const type = TYPES[name];
        const cutoff = 440 * 2 ** ((83 - 69) / 12);
        expect([
          name,
          res,
          v,
          Math.abs(responseDb(type, { cutoff, resonance: res, variation: v }, cutoff) - gain) < 1.5,
        ]).toEqual([name, res, v, true]);
      });
  });
});
