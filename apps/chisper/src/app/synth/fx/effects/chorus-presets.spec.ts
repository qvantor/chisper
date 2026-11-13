import { FX_MIX_PARAMS, FX_PARAMS, normalizePreset, TEMPO_DIVISIONS } from '@chisper/preset-schema';
import { mapValues } from 'lodash';
import { renderChorus } from '../../../../test-utils/chorus-render';
import { dB } from '../../../../test-utils/measures';
import { chorusDivisionOf, chorusRate } from './chorus';
import { CHORUS_PRESETS } from './chorus-presets';
import { findFxPreset } from '.';

const PARAM_KEYS = Object.keys(FX_PARAMS.chorus).sort();
const RATE = 48000;

// dB of a preset against the dry sound: a note of three partials, held for four seconds
const loudnessDb = (id: string) => {
  const preset = CHORUS_PRESETS.find((item) => item.id === id);
  if (!preset) throw new Error(id);
  const input = Float64Array.from({ length: 4 * RATE }, (_, i) =>
    [220, 660, 3300].reduce(
      (sum, hz, k) => sum + (0.2 / (k + 1)) * Math.sin((2 * Math.PI * hz * i) / RATE),
      0
    )
  );
  const { rate, d1, d2, depth, fb, cut, hpf, level } = preset.params;
  const params = {
    rate: chorusRate(preset.params, 120),
    d1,
    d2,
    depth,
    fb,
    cut,
    hpf,
    level,
    mix: preset.mix,
  };
  void rate;
  const out = renderChorus(params, RATE, [input, input]);
  let [wet, dry] = [0, 0];
  for (let i = RATE / 2; i < input.length; i++) {
    wet += out.left[i] ** 2 + out.right[i] ** 2;
    dry += 2 * input[i] ** 2;
  }
  return dB(Math.sqrt(wet / dry));
};

describe('chorus presets', () => {
  it('has 9 presets with unique ids and names, one of them is the default', () => {
    expect(CHORUS_PRESETS).toHaveLength(9);
    expect(new Set(CHORUS_PRESETS.map(({ id }) => id)).size).toBe(CHORUS_PRESETS.length);
    expect(new Set(CHORUS_PRESETS.map(({ name }) => name)).size).toBe(CHORUS_PRESETS.length);
    expect(CHORUS_PRESETS.some(({ id }) => id === 'default')).toBe(true);
  });

  it('the default preset is the schema defaults: a fresh chorus, in Hz, half of it wet', () => {
    const preset = CHORUS_PRESETS.find(({ id }) => id === 'default');
    expect(preset?.mix).toBe(FX_MIX_PARAMS.chorus.default);
    expect(preset?.params).toEqual(mapValues(FX_PARAMS.chorus, (param) => param.default));
    expect(preset?.params.sync).toBe(0);
  });

  it.each(CHORUS_PRESETS)('$id sets every param, within the schema ranges', ({ mix, params }) => {
    expect(Object.keys(params).sort()).toEqual(PARAM_KEYS);
    const { fx } = normalizePreset({ fx: { chorus: { a: true, mix, ...params } } });
    expect(fx.chorus).toMatchObject({ mix, ...params });
  });

  it.each(CHORUS_PRESETS)('$id is found back by its values', ({ id, mix, params }) => {
    expect(findFxPreset('chorus', { mix, params })?.id).toBe(id);
  });

  it('the one in BPM names a step of Rate, the others keep the default division', () => {
    const synced = CHORUS_PRESETS.filter(({ params }) => params.sync === 1);
    expect(synced.map(({ id }) => id)).toEqual(['tempo-sweep']);
    synced.forEach(({ params }) => {
      expect(chorusDivisionOf(params)).toBe(params.div);
      expect(TEMPO_DIVISIONS[params.div].id).toBe('2 bar');
    });
    CHORUS_PRESETS.filter(({ params }) => params.sync === 0).forEach(({ params }) =>
      expect(params.div).toBe(FX_PARAMS.chorus.div.default)
    );
  });

  // (the partials of a note fall on the peaks or the dips of its combs: within 5 dB of the dry one)
  it.each(CHORUS_PRESETS)('$id keeps a held note about as loud as the dry one', ({ id }) => {
    expect(Math.abs(loudnessDb(id))).toBeLessThan(5);
  });
});
