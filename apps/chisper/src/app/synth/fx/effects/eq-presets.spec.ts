import { FX_MIX_PARAMS, FX_PARAMS, normalizePreset } from '@chisper/preset-schema';
import { mapValues } from 'lodash';
import { responseOf } from '../../../../test-utils/eq-render';
import { EQ_PRESETS } from './eq-presets';
import { findFxPreset } from '.';

const PARAM_KEYS = Object.keys(FX_PARAMS.eq).sort();
const RATE = 48000;

// dB of a preset at frequencies, as the core plays it
const responseDb = (id: string, frequencies: number[]) => {
  const preset = EQ_PRESETS.find((item) => item.id === id);
  if (!preset) throw new Error(id);
  return responseOf(preset.params, RATE, frequencies);
};

describe('eq presets', () => {
  it('has 5 presets with unique ids and names, one of them is the default', () => {
    expect(EQ_PRESETS).toHaveLength(5);
    expect(new Set(EQ_PRESETS.map(({ id }) => id)).size).toBe(EQ_PRESETS.length);
    expect(new Set(EQ_PRESETS.map(({ name }) => name)).size).toBe(EQ_PRESETS.length);
    expect(EQ_PRESETS.map(({ id }) => id)).toEqual(['default', 'low-cut', 'air', 'mid-scoop', 'telephone']);
  });

  it('the default preset is the schema defaults: a fresh EQ, all wet, the sound as it is', () => {
    const preset = EQ_PRESETS.find(({ id }) => id === 'default');
    expect(preset?.mix).toBe(FX_MIX_PARAMS.eq.default);
    expect(preset?.params).toEqual(mapValues(FX_PARAMS.eq, (param) => param.default));
    responseDb('default', [30, 300, 3000, 15000]).forEach((db) => expect(db).toBeCloseTo(0, 6));
  });

  it.each(EQ_PRESETS)('$id sets every param, within the schema ranges', ({ mix, params }) => {
    expect(Object.keys(params).sort()).toEqual(PARAM_KEYS);
    const { fx } = normalizePreset({ fx: { eq: { a: true, mix, ...params } } });
    expect(fx.eq).toMatchObject({ mix, ...params });
  });

  it.each(EQ_PRESETS)('$id is found back by its values', ({ id, mix, params }) => {
    expect(findFxPreset('eq', { mix, params })?.id).toBe(id);
  });

  it('each does what it is named for', () => {
    // the lows cut, the rest as it is (a corner of Q 0.69: -3 dB there)
    const [rumble, corner, body] = responseDb('low-cut', [30, 120, 1000]);
    expect(rumble).toBeLessThan(-20);
    expect(corner).toBeCloseTo(-3.2, 0);
    expect(Math.abs(body)).toBeLessThan(0.2);
    // the highs up 4 dB, the mids as they are
    const [mids, highs] = responseDb('air', [1000, 18000]);
    expect(Math.abs(mids)).toBeLessThan(0.2);
    expect(highs).toBeCloseTo(4, 0);
    // the mids down 8 dB, the lows and the highs about as they are
    const [lows, middle, top] = responseDb('mid-scoop', [60, 700, 12000]);
    expect(middle).toBeCloseTo(-8, 3);
    expect(Math.abs(lows)).toBeLessThan(1);
    expect(Math.abs(top)).toBeLessThan(1);
    // a band from 400 Hz to 3 kHz: the lows and the highs far under it
    const [low, band, high] = responseDb('telephone', [80, 1100, 12000]);
    expect(Math.abs(band)).toBeLessThan(2);
    expect(low).toBeLessThan(-20);
    expect(high).toBeLessThan(-20);
  });
});
