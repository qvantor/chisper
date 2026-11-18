import { FX_MIX_PARAMS, FX_PARAMS, normalizePreset } from '@chisper/preset-schema';
import { mapValues } from 'lodash';
import { chainState, makeChain, renderChain } from '../../../../test-utils/chain-render';
import { DISTORTION_LATENCY, REFERENCE_PEAK } from './distortion-params';
import { DISTORTION_PRESETS } from './distortion-presets';
import { findFxPreset } from '.';

const PARAM_KEYS = Object.keys(FX_PARAMS.distortion).sort();

const SAMPLE_RATE = 48000;

// dB of a preset against the dry sound for the reference sine (a note at the fx input), mixed as the chain mixes
// the distortion in its slot: linearly, with the dry signal late by the latency
const loudnessDb = (id: string) => {
  const preset = DISTORTION_PRESETS.find((item) => item.id === id);
  if (!preset) throw new Error(id);
  const frames = 16384;
  const input = Float32Array.from(
    { length: frames },
    (_, frame) => REFERENCE_PEAK * Math.sin((2 * Math.PI * 220 * frame) / SAMPLE_RATE)
  );
  const state = chainState(['distortion'], preset.mix, { distortion: { params: preset.params } });
  const { left } = renderChain(makeChain(state, SAMPLE_RATE), [input, input]);
  let dry = 0;
  let mixed = 0;
  // the second half, settled
  for (let i = frames / 2; i < frames; i++) {
    dry += input[i - DISTORTION_LATENCY] ** 2;
    mixed += left[i] ** 2;
  }
  return 10 * Math.log10(mixed / dry);
};

describe('distortion presets', () => {
  it('has 7 presets with unique ids and names, one of them is the default', () => {
    expect(DISTORTION_PRESETS).toHaveLength(7);
    expect(new Set(DISTORTION_PRESETS.map(({ id }) => id)).size).toBe(DISTORTION_PRESETS.length);
    expect(new Set(DISTORTION_PRESETS.map(({ name }) => name)).size).toBe(DISTORTION_PRESETS.length);
    expect(DISTORTION_PRESETS.some(({ id }) => id === 'default')).toBe(true);
  });

  it('the default preset is the schema defaults, the state of a freshly added distortion', () => {
    const preset = DISTORTION_PRESETS.find((item) => item.id === 'default');
    expect(preset?.mix).toBe(FX_MIX_PARAMS.distortion.default);
    expect(preset?.params).toEqual(mapValues(FX_PARAMS.distortion, (param) => param.default));
  });

  // a preset saved with the synth must load back unchanged, otherwise it would show up as Custom
  it.each(DISTORTION_PRESETS)(
    '$name sets every param and passes the synth preset schema unchanged',
    (preset) => {
      expect(Object.keys(preset.params).sort()).toEqual(PARAM_KEYS);
      const distortion = { a: true, on: true, mix: preset.mix, ...preset.params };
      expect(normalizePreset({ fx: { distortion } }).fx.distortion).toEqual(distortion);
    }
  );

  it('Warm, mixed under the clean sound, is about as loud as it', () => {
    expect(Math.abs(loudnessDb('warm'))).toBeLessThan(0.5);
  });

  it('Parallel grit is a little hotter than the clean sound, so its edge is heard under it', () => {
    const loudness = loudnessDb('parallel-grit');
    expect(loudness).toBeGreaterThan(0.3);
    expect(loudness).toBeLessThan(2);
  });

  it('findFxPreset finds every preset by its mix and params', () => {
    DISTORTION_PRESETS.forEach((preset) => expect(findFxPreset('distortion', preset)).toBe(preset));
  });

  it('findFxPreset finds nothing when a param differs', () => {
    const [preset] = DISTORTION_PRESETS;
    expect(
      findFxPreset('distortion', { ...preset, params: { ...preset.params, drive: 12.5 } })
    ).toBeUndefined();
  });
});
