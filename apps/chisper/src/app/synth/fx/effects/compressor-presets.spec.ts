import { FX_MIX_PARAMS, FX_PARAMS, normalizePreset } from '@chisper/preset-schema';
import { mapValues } from 'lodash';
import { quadrature, renderCompressor } from '../../../../test-utils/compressor-render';
import { dB } from '../../../../test-utils/measures';
import { COMPRESSOR_PRESETS } from './compressor-presets';
import { findFxPreset } from '.';

const PARAM_KEYS = Object.keys(FX_PARAMS.compressor).sort();
const RATE = 48000;

// dB of a preset against the dry sound: a note of two partials at the level of a patch (a peak of -9 dB), held
const loudnessDb = (id: string) => {
  const preset = COMPRESSOR_PRESETS.find((item) => item.id === id);
  if (!preset) throw new Error(id);
  const [low] = quadrature(RATE, 220, [[-12, 1.5]], { mono: true });
  const [high] = quadrature(RATE, 3300, [[-24, 1.5]], { mono: true });
  const input = low.map((value, i) => value + high[i]);
  const out = renderCompressor({ ...preset.params, mix: preset.mix }, RATE, [input, input]);
  let [wet, dry] = [0, 0];
  for (let i = RATE; i < input.length; i++) {
    wet += out.left[i] ** 2;
    dry += input[i] ** 2;
  }
  return dB(Math.sqrt(wet / dry));
};

describe('compressor presets', () => {
  it('has 7 presets with unique ids and names, one of them is the default', () => {
    expect(COMPRESSOR_PRESETS).toHaveLength(7);
    expect(new Set(COMPRESSOR_PRESETS.map(({ id }) => id)).size).toBe(COMPRESSOR_PRESETS.length);
    expect(new Set(COMPRESSOR_PRESETS.map(({ name }) => name)).size).toBe(COMPRESSOR_PRESETS.length);
    expect(COMPRESSOR_PRESETS.some(({ id }) => id === 'default')).toBe(true);
  });

  it('the default preset is the schema defaults: a fresh compressor, one band, all wet', () => {
    const preset = COMPRESSOR_PRESETS.find(({ id }) => id === 'default');
    expect(preset?.mix).toBe(FX_MIX_PARAMS.compressor.default);
    expect(preset?.params).toEqual(mapValues(FX_PARAMS.compressor, (param) => param.default));
    expect(preset?.params.multi).toBe(0);
  });

  it.each(COMPRESSOR_PRESETS)('$id sets every param, within the schema ranges', ({ mix, params }) => {
    expect(Object.keys(params).sort()).toEqual(PARAM_KEYS);
    const { fx } = normalizePreset({ fx: { compressor: { a: true, mix, ...params } } });
    expect(fx.compressor).toMatchObject({ mix, ...params });
  });

  it.each(COMPRESSOR_PRESETS)('$id is found back by its values', ({ id, mix, params }) => {
    expect(findFxPreset('compressor', { mix, params })?.id).toBe(id);
  });

  it('a held note keeps about its level in the one band presets, the bands pressed down and up are louder', () => {
    // the peaks of the note are a little over the threshold of a fresh one: a couple of dB off
    expect(loudnessDb('default')).toBeLessThan(0);
    expect(loudnessDb('default')).toBeGreaterThan(-4);
    ['glue', 'tight', 'parallel', 'multiband-glue'].forEach((id) => {
      expect(Math.abs(loudnessDb(id))).toBeLessThan(4);
    });
    expect(loudnessDb('ott')).toBeGreaterThan(1);
    expect(loudnessDb('ott')).toBeLessThan(12);
    // half of it under the dry sound: in between
    expect(loudnessDb('ott-half')).toBeGreaterThan(0);
    expect(loudnessDb('ott-half')).toBeLessThan(loudnessDb('ott'));
  });
});
