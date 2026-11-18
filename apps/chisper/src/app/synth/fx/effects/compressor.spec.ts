import { mapValues, omit } from 'lodash';
import { FX_MIX_PARAMS, FX_PARAMS } from '@chisper/preset-schema';
import { COMPRESSOR_DEFAULTS as DEFAULTS } from '../../../../test-utils/compressor-render';
import { CHAIN_KEYS, NEUTRAL_PARAMS } from '../../common/chain/chain-params';
import { compressor, formatBandThresholds } from './compressor';
import { COMPRESSOR_MODES } from './compressor-modes';
import { bandThresholdsDb, levelGain, makeupGain, thresholdDb } from './compressor-params';
import { COMPRESSOR_PRESETS } from './compressor-presets';
import { COMPRESSOR_KEYS } from './compressor-wasm';

const SCHEMA_DEFAULTS = mapValues(FX_PARAMS.compressor, (param) => param.default);
const RATE = 48000;

describe('compressor', () => {
  it('the laws of its knobs: the threshold, the makeup and the level in dB, the times in ms', () => {
    const { params } = compressor;
    expect(params.multi.options?.map(({ id }) => id)).toEqual(COMPRESSOR_MODES.map(({ id }) => id));
    expect(thresholdDb(0)).toBeCloseTo(1.397, 3);
    expect(thresholdDb(0.5)).toBeCloseTo(60 * Math.log10(0.5) + 1.397, 6);
    expect(thresholdDb(1)).toBeCloseTo(-120 + 1.397, 3);
    expect(params.thresh.formatValue?.(0.5)).toBe('-16.7dB');
    // three bands: the thresholds of the bands, those of the middle of the knob with its square
    expect(bandThresholdsDb(0)).toEqual([1.397, 1.397, 1.397]);
    [-33.8, -30.2, -35.5].forEach((db, band) => {
      expect(bandThresholdsDb(0.5)[band]).toBeCloseTo(db + 1.397, 6);
      expect(bandThresholdsDb(1)[band]).toBeCloseTo(4 * db + 1.397, 6);
      expect(bandThresholdsDb(2)[band]).toBeCloseTo(4 * db + 1.397, 6);
    });
    expect(bandThresholdsDb(-1)).toEqual(bandThresholdsDb(0));
    expect(formatBandThresholds(0.5)).toBe('-32.4 / -28.8 / -34.1dB');
    expect(formatBandThresholds(0)).toBe('+1.4 / +1.4 / +1.4dB');
    expect(makeupGain(0)).toBe(1);
    expect(makeupGain(1)).toBe(32);
    expect(params.gain.formatValue?.(0)).toBe('0.0dB');
    expect(params.gain.formatValue?.(1)).toBe('+30.1dB');
    expect(levelGain(0.5)).toBe(1);
    expect(levelGain(1)).toBe(4);
    expect(params.level.formatValue?.(0.5)).toBe('0.0dB');
    expect(params.level.formatValue?.(1)).toBe('+12.0dB');
    expect(params.level.formatValue?.(0)).toBe('-∞dB');
    expect(params.ratio.formatValue?.(4)).toBe('4.0:1');
    expect(params.attack.formatValue?.(0.5)).toBe('0.5ms');
    expect(params.release.formatValue?.(90)).toBe('90ms');
    expect(params.release.formatValue?.(1000)).toBe('1.0s');
    expect(params.xlow.formatValue?.(131)).toBe('131Hz');
    expect(params.xhigh.formatValue?.(2500)).toBe('2.5kHz');
    expect(params.below.formatValue?.(0.5)).toBe('50%');
    expect(params.mid.formatValue?.(-6)).toBe('-6.0dB');
  });

  it('a knob for every param of the schema, the core takes them and the mix in its order', () => {
    expect(Object.keys(compressor.params).sort()).toEqual(Object.keys(FX_PARAMS.compressor).sort());
    expect([...COMPRESSOR_KEYS].sort()).toEqual([...Object.keys(FX_PARAMS.compressor), 'mix'].sort());
    // a route is `<source>:<effect>.<param>`: lower case letters and digits
    Object.keys(compressor.params).forEach((key) => expect(key).toMatch(/^[a-z][a-z0-9]*$/));
  });

  it('the core takes its knobs as they are, falsy ones included, at any tempo and rate', () => {
    expect(compressor.core(SCHEMA_DEFAULTS, 120, RATE)).toEqual(omit(DEFAULTS, 'mix'));
    const params = { ...SCHEMA_DEFAULTS, multi: 1, thresh: 0, gain: 0, below: 0, level: 0, mid: -6 };
    expect(compressor.core(params, 120, RATE)).toEqual(params);
    expect(compressor.core(params, 60, 96000)).toEqual(params);
  });

  it('gives the core the params of its kind but the mix: the mix of its slot is the mix inside', () => {
    COMPRESSOR_PRESETS.forEach(({ params }) => {
      const keys = Object.keys(compressor.core(params, 120, RATE));
      keys.forEach((key) => expect(CHAIN_KEYS.compressor).toContain(key));
      expect([...keys, 'mix'].sort()).toEqual([...CHAIN_KEYS.compressor].sort());
    });
    // the defaults: those a chain starts with
    expect({ ...compressor.core(SCHEMA_DEFAULTS, 120, RATE), mix: FX_MIX_PARAMS.compressor.default }).toEqual(
      NEUTRAL_PARAMS.compressor
    );
  });

  it('tells a meter while a screen watches it, follows no tempo, its routes are within its knobs', () => {
    expect(compressor.metered).toBe(true);
    expect(compressor.paramChange).toBeUndefined();
    expect(compressor.bounds).toBeUndefined();
    expect(compressor.label).toBe('Compressor');
    expect(compressor.presets).toBe(COMPRESSOR_PRESETS);
  });
});
