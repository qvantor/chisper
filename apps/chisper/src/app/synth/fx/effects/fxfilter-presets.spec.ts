import { FX_MIX_PARAMS, FX_PARAMS, normalizePreset } from '@chisper/preset-schema';
import { mapValues } from 'lodash';
import { fxFilterResponse } from '../../../../test-utils/fxfilter-render';
import { FX_FILTER_PRESETS } from './fxfilter-presets';
import { findFxPreset } from '.';

const PARAM_KEYS = Object.keys(FX_PARAMS.fxfilter).sort();
const RATE = 48000;
const N = 1 << 14;

// dB of a preset at frequencies (each channel), as the core plays it: a quiet impulse through it, the DFT
const responseDb = (id: string, frequencies: number[], channel = 0) => {
  const preset = FX_FILTER_PRESETS.find((item) => item.id === id);
  if (!preset) throw new Error(id);
  return fxFilterResponse(preset.params, RATE, frequencies, {
    amplitude: 0.001,
    n: N,
    channel,
    mix: preset.mix,
  });
};

describe('fxfilter presets', () => {
  it('has 7 presets with unique ids and names, one of them is the default', () => {
    expect(FX_FILTER_PRESETS.map(({ id }) => id)).toEqual([
      'default',
      'warm-ladder',
      'dark',
      'low-cut',
      'radio',
      'squelch',
      'wide',
    ]);
    expect(new Set(FX_FILTER_PRESETS.map(({ name }) => name)).size).toBe(FX_FILTER_PRESETS.length);
  });

  it('the default preset is the schema defaults: a fresh filter of the reference, all wet', () => {
    const preset = FX_FILTER_PRESETS.find(({ id }) => id === 'default');
    expect(preset?.mix).toBe(FX_MIX_PARAMS.fxfilter.default);
    expect(preset?.params).toEqual(mapValues(FX_PARAMS.fxfilter, (param) => param.default));
  });

  it.each(FX_FILTER_PRESETS)('$id sets every param, within the schema ranges', ({ mix, params }) => {
    expect(Object.keys(params).sort()).toEqual(PARAM_KEYS);
    const { fx } = normalizePreset({ fx: { fxfilter: { a: true, mix, ...params } } });
    expect(fx.fxfilter).toMatchObject({ mix, ...params });
  });

  it.each(FX_FILTER_PRESETS)('$id is found back by its values', ({ id, mix, params }) => {
    expect(findFxPreset('fxfilter', { mix, params })?.id).toBe(id);
  });

  it('each does what it is named for', () => {
    // a gentle top cut: the lows as they are, 6 dB an octave over 425 Hz
    const [bass, corner, top] = responseDb('default', [60, 425, 6800]);
    expect(Math.abs(bass)).toBeLessThan(0.5);
    expect(corner).toBeLessThan(-2);
    expect(top).toBeLessThan(-20);
    // the lows kept (the pass band of the reference a little down by its resonance), the highs far down
    const [lows, highs] = responseDb('dark', [100, 5000]);
    expect(Math.abs(lows)).toBeLessThan(3.5);
    expect(highs - lows).toBeLessThan(-35);
    // the lows cut, the rest as it is
    const [rumble, body] = responseDb('low-cut', [30, 2000]);
    expect(rumble).toBeLessThan(-20);
    expect(Math.abs(body)).toBeLessThan(0.5);
    // a band: both ends far under its middle
    const [low, band, high] = responseDb('radio', [100, 1500, 12000]);
    expect(band - low).toBeGreaterThan(20);
    expect(band - high).toBeGreaterThan(20);
    // a resonant peak at its cutoff
    const [under, peak] = responseDb('squelch', [100, 900]);
    expect(peak - under).toBeGreaterThan(3);
    // each channel its cutoff: the left one brighter than the right one
    const [left] = responseDb('wide', [6000], 0);
    const [right] = responseDb('wide', [6000], 1);
    expect(left - right).toBeGreaterThan(6);
  });
});
