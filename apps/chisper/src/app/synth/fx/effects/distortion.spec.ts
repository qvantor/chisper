import { mapValues } from 'lodash';
import { FX_PARAMS } from '@chisper/preset-schema';
import { CHAIN_KEYS, NEUTRAL_PARAMS } from '../../common/chain/chain-params';
import { distortion } from './distortion';
import { DISTORTION_MODES } from './distortion-modes';
import { DISTORTION_LATENCY, TONE_OPEN } from './distortion-params';
import { DISTORTION_PRESETS } from './distortion-presets';

const DEFAULTS = mapValues(FX_PARAMS.distortion, (param) => param.default);

describe('distortion', () => {
  it('a mode switch over the curves, drive and level in dB, the top of the tone is open', () => {
    const { params } = distortion;
    expect(params.mode.options?.map(({ id }) => id)).toEqual(DISTORTION_MODES.map(({ id }) => id));
    expect(params.drive.formatValue?.(12)).toBe('+12.0dB');
    expect(params.level.formatValue?.(-6)).toBe('-6.0dB');
    expect(params.level.formatValue?.(0)).toBe('0.0dB');
    expect(params.tone.formatValue?.(2500)).toBe('2.5kHz');
    expect(params.tone.formatValue?.(FX_PARAMS.distortion.tone.max)).toBe('Open');
    expect(TONE_OPEN).toBe(FX_PARAMS.distortion.tone.max);
  });

  it('a knob for every param of the schema with its range', () => {
    const { params } = distortion;
    expect(Object.keys(params).sort()).toEqual(Object.keys(FX_PARAMS.distortion).sort());
    (Object.keys(FX_PARAMS.distortion) as (keyof typeof FX_PARAMS.distortion)[]).forEach((key) =>
      expect(params[key]).toMatchObject(FX_PARAMS.distortion[key])
    );
    expect(params.tone.mode).toBe('log');
    // the level fills from 0 dB, on top of the makeup gain
    expect(params.level.fillFrom).toBe(0);
    // a route is `<source>:<effect>.<param>`: lower case letters and digits
    Object.keys(params).forEach((key) => expect(key).toMatch(/^[a-z][a-z0-9]*$/));
    expect(distortion.label).toBe('Distortion');
    expect(distortion.presets).toBe(DISTORTION_PRESETS);
  });

  it('the core takes its knobs as they are, falsy ones included, at any tempo and rate', () => {
    expect(distortion.core(DEFAULTS, 120, 48000)).toEqual(DEFAULTS);
    const params = { mode: 1, drive: 0, tone: 3000, level: -3 };
    expect(distortion.core(params, 120, 48000)).toEqual(params);
    expect(distortion.core(params, 60, 96000)).toEqual(params);
  });

  it('gives the core every param of its kind and no other, the defaults those a chain starts with', () => {
    DISTORTION_PRESETS.forEach(({ params }) =>
      expect(Object.keys(distortion.core(params, 120, 48000)).sort()).toEqual(
        [...CHAIN_KEYS.distortion].sort()
      )
    );
    expect(distortion.core(DEFAULTS, 120, 48000)).toEqual(NEUTRAL_PARAMS.distortion);
  });

  it('follows no tempo, its routes are within its knobs, it has no meter', () => {
    expect(distortion.paramChange).toBeUndefined();
    expect(distortion.bounds).toBeUndefined();
    expect(distortion.metered).toBeUndefined();
  });

  // the oversampling filters are linear phase: the chain delays the dry signal of its slot as much
  it('its output lags by 32 samples', () => {
    expect(DISTORTION_LATENCY).toBe(32);
  });
});
