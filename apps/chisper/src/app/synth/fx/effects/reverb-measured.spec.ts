import { readFileSync } from 'fs';
import { join } from 'path';
import { FX_PARAMS } from '@chisper/preset-schema';
import { chainState, makeChain, renderChain } from '../../../../test-utils/chain-render';
import { sceneChord, sceneDistance, sceneWindows } from '../../../../test-utils/reverb-scenes';
import {
  HALL_DEFAULTS,
  hallDecay,
  hallMix,
  hallReverb,
  HallMeasures,
  mids,
} from '../../../../test-utils/hall-reverb';
import { hfRatio, HF_RATIO, roomFactor, sizeFactor } from './reverb-decay';
import { FX_REGISTRY } from '.';

// The reverb against the Hall of the Audio Unit (dsp/measurements/reverb.json, scripts/renders/run.mjs
// --only=reverb): a chord of saws through ours at the knobs its params map to (hallReverb), read as the renders
// are. Two renders of the Hall itself are 2 dB of spectrum apart here (asleep and awake before the chord: its
// echoes fall otherwise on the windows), so ours is held to 3 dB, not to the bit

type Row = number[];
interface Measured extends HallMeasures {
  rate: number;
  size: { kParamSize: number; rt60: number[]; echo: number }[];
  cross: { kParamSize: number; kParamDelay?: number; rt60: number[] }[];
  wet: [number, number, number, number][];
  chord: number[];
  sceneTimes: number[];
  dry: Row[];
  scenes: { size: number; wet: number; windows: Row[] }[];
}

const measured: Measured = JSON.parse(
  readFileSync(join(__dirname, '../../../../../../../dsp/measurements/reverb.json'), 'utf8')
);
const R = measured.rate;
// a row of the file that is there
const found = <T>(row: T | undefined): T => {
  if (row === undefined) throw new Error('no such row in reverb.json');
  return row;
};

// the chord of the scenes (`about` of the file), built once: a render copies it
const CHORD = sceneChord(measured.chord, R);
const windowsOf = (left: Float32Array, right: Float32Array) =>
  sceneWindows(left, right, measured.sceneTimes, R);
const distance = (ours: Row[], theirs: Row[]) => sceneDistance(ours, theirs, measured.sceneTimes);

// the chord through our reverb in its slot, at the knobs and the mix of a Hall
const scene = (size: number, wet: number) => {
  const { params, mix } = hallReverb(measured, { size, wet });
  const core = FX_REGISTRY.reverb.core(params, 120, R);
  const { left, right } = renderChain(
    makeChain(chainState(['reverb'], mix, { reverb: { params: core } }), R, false),
    [CHORD, CHORD]
  );
  return distance(
    windowsOf(left, right),
    found(measured.scenes.find((s) => s.size === size && s.wet === wet)).windows
  );
};

jest.setTimeout(60000);

describe('the reverb against the Hall of the Audio Unit', () => {
  it('the stand passes the chord as it is', () => {
    const { spectrum, held } = distance(windowsOf(CHORD, CHORD), measured.dry);
    expect(spectrum).toBeLessThan(0.3);
    expect(held).toBeLessThan(0.3);
  });

  // the criterion of the scenes: 3 dB of spectrum, 1.5 dB of the level of the tail
  it.each([
    [25, 30, 3],
    [50, 30, 3],
    [75, 30, 3],
  ])('Size %d at Wet %d: the spectrum and the tail of the chord', (size, wet, limit) => {
    const { spectrum, tail, held } = scene(size, wet);
    expect(spectrum).toBeLessThan(limit);
    expect(tail).toBeLessThan(1.5);
    expect(held).toBeLessThan(1);
  });

  // Mostly wet, the echoes of the Hall colour the held chord (sparse lines, their modulation between its
  // partials): its spectrum there is 3 to 4 dB from ours; the knobs are those of Wet 30 (a Size maps to one room
  // whatever the Wet), the tail as near
  it('Size 50 at Wet 60: the tail, the spectrum within 3.5 dB', () => {
    const { spectrum, tail, held } = scene(50, 60);
    expect(spectrum).toBeLessThan(3.5);
    expect(tail).toBeLessThan(1.5);
    expect(held).toBeLessThan(1.5);
  });

  it('the knobs a Hall maps to are knobs of ours', () => {
    const ranges = FX_PARAMS.reverb;
    for (const size of [0, 10, 25, 35, 50, 62.5, 75, 90, 100])
      for (const decay of [0, 30, 100, 250])
        for (const [lowDamp, highDamp] of [
          [0, 35],
          [100, 0],
          [50, 100],
        ])
          for (const wet of [0, 30, 60, 100]) {
            const { params, mix } = hallReverb(measured, {
              size,
              decay,
              lowDamp,
              highDamp,
              preDelay: 0.5,
              wet,
            });
            (Object.keys(ranges) as (keyof typeof ranges)[]).forEach((key) => {
              expect(params[key]).toBeGreaterThanOrEqual(ranges[key].min);
              expect(params[key]).toBeLessThanOrEqual(ranges[key].max);
            });
            expect(mix).toBeGreaterThanOrEqual(0);
            expect(mix).toBeLessThanOrEqual(1);
          }
    expect(hallReverb(measured, { wet: 0 }).mix).toBe(0);
    expect(hallReverb(measured, { wet: 100 }).mix).toBe(1);
  });

  it('a larger Hall and a longer decay are larger and longer', () => {
    const sizes = [0, 25, 50, 75, 100].map((size) => hallReverb(measured, { size, wet: 30 }).params.size);
    sizes.slice(1).forEach((size, i) => expect(size).toBeGreaterThan(sizes[i]));
    for (const size of [25, 50, 75]) {
      const decays = [0, 20, 30, 50, 100].map(
        (decay) => hallReverb(measured, { size, decay, wet: 30 }).params.decay
      );
      decays.slice(1).forEach((decay, i) => expect(decay).toBeGreaterThanOrEqual(decays[i]));
    }
    // its dampings: less of the highs opens ours, more of the lows shortens ours
    const damp = (highDamp: number) => hallReverb(measured, { size: 25, highDamp, wet: 30 }).params.damp;
    expect(damp(0)).toBeGreaterThan(damp(35));
    expect(damp(35)).toBeGreaterThan(damp(75));
    const bass = (lowDamp: number) => hallReverb(measured, { lowDamp, wet: 30 }).params.bass;
    expect(bass(100)).toBeLessThan(bass(0));
  });

  it('the decay of a Hall by its Size and its decay is the measured one', () => {
    // on the axes of the sweeps
    measured.size.forEach((row) =>
      expect(hallDecay(measured, row.kParamSize, HALL_DEFAULTS.decay) / mids(measured, row.rt60)).toBeCloseTo(
        1,
        1
      )
    );
    // off them
    measured.cross
      .filter((row) => row.kParamDelay !== undefined)
      .forEach((row) => {
        const ratio = hallDecay(measured, row.kParamSize, found(row.kParamDelay)) / mids(measured, row.rt60);
        expect(ratio).toBeGreaterThan(0.84);
        expect(ratio).toBeLessThan(1.16);
      });
  });

  it('the gains of its Wet: sin² of a quarter turn the wet one, 1 less its square the dry one', () => {
    measured.wet.forEach(([wet, dryGain, wetGain, rest]) => {
      const [dry, mixed] = hallMix(wet);
      expect(dry).toBeCloseTo(dryGain, 3);
      expect(mixed).toBeCloseTo(wetGain, 3);
      expect(rest).toBeLessThan(-100);
    });
  });

  // the slot mixes by equal power: the dry signal of ours is that of the Hall within 1.5 dB up to Wet 60
  it('the mix of the slot keeps the dry signal of a Hall', () => {
    for (const wet of [10, 30, 50, 60]) {
      const { mix } = hallReverb(measured, { size: 50, wet });
      const ours = Math.cos((mix * Math.PI) / 2);
      expect(Math.abs(20 * Math.log10(ours / hallMix(wet)[0]))).toBeLessThan(1.5);
    }
  });

  // what of the Hall the laws of the core take: lines that grow with the Size as its first echo does (the top
  // of ours is its Size 75), highs that ring as long as the mids in a large one
  it('the top of the size is a hall of the Audio Unit, the top of the damping its open highs', () => {
    const echo = (size: number) => found(measured.size.find((row) => row.kParamSize === size)).echo;
    // (the first line of ours: 27.1 ms at the scale 1)
    expect(27.1 * sizeFactor(1)).toBeGreaterThan(echo(75));
    expect(27.1 * sizeFactor(1)).toBeLessThan(echo(90));
    expect(27.1 * sizeFactor(0.5)).toBeLessThan(echo(37.5));
    expect(sizeFactor(0.5) / roomFactor(0.5)).toBeLessThan(1.2);
    const large = found(measured.size.find((row) => row.kParamSize === 75)).rt60;
    expect(large[measured.octaves.indexOf(8000)] / large[measured.octaves.indexOf(1000)]).toBeGreaterThan(
      0.95
    );
    expect(hfRatio(20000)).toBe(1);
    expect(hfRatio(6000)).toBe(HF_RATIO);
  });
});
