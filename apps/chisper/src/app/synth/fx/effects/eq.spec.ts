import { FX_MIX_PARAMS, FX_PARAMS } from '@chisper/preset-schema';
import { EQ_PASS, EQ_PEAK, EQ_SHELF } from '@chisper/math/eq';
import { EQ_DEFAULTS } from '../../../../test-utils/eq-render';
import { CHAIN_KEYS, NEUTRAL_PARAMS } from '../../common/chain/chain-params';
import { eq } from './eq';
import { EQ_BANDS, EQ_TYPES, eqTypeOptions } from './eq-params';
import { levelGain } from './level';
import { EQ_PRESETS } from './eq-presets';
import { EQ_KEYS } from './eq-wasm';

const RATE = 48000;

describe('eq', () => {
  it('the types of the bands by index, as the core has them, named by band', () => {
    expect(EQ_TYPES.map(({ id }) => id)).toEqual(['shelf', 'peak', 'pass']);
    expect([EQ_SHELF, EQ_PEAK, EQ_PASS]).toEqual([0, 1, 2]);
    expect(eqTypeOptions(0).map(({ label }) => label)).toEqual(['Low shelf', 'Peak', 'Low cut']);
    expect(eqTypeOptions(1).map(({ label }) => label)).toEqual(['High shelf', 'Peak', 'High cut']);
    expect(eq.params.t1.options).toEqual(eqTypeOptions(0));
    expect(eq.params.t2.options).toEqual(eqTypeOptions(1));
    expect(EQ_BANDS).toEqual([
      { type: 't1', freq: 'f1', reso: 'q1', gain: 'g1' },
      { type: 't2', freq: 'f2', reso: 'q2', gain: 'g2' },
    ]);
  });

  it('the laws of its knobs: the frequency on a log scale, the resonance in %, the gain and the level in dB', () => {
    const { params } = eq;
    expect(params.f1.mode).toBe('log');
    expect(params.f2.mode).toBe('log');
    expect(params.f1.formatValue?.(210)).toBe('210Hz');
    expect(params.f2.formatValue?.(2040)).toBe('2.0kHz');
    expect(params.q1.formatValue?.(60)).toBe('60%');
    expect(params.g2.formatValue?.(-4.5)).toBe('-4.5dB');
    expect(params.g1.fillFrom).toBe(0);
    expect(levelGain(0.5)).toBe(1);
    expect(levelGain(1)).toBe(4);
    expect(levelGain(0)).toBe(0);
    expect(params.level.formatValue?.(0.5)).toBe('0.0dB');
    expect(params.level.formatValue?.(1)).toBe('+12.0dB');
    expect(params.level.formatValue?.(0.25)).toBe('-12.0dB');
    expect(params.level.formatValue?.(0)).toBe('-∞dB');
    expect(params.f1.name).toBe('Band 1 frequency');
    expect(params.g2.name).toBe('Band 2 gain');
  });

  it('a knob for every param of the schema, the core takes them in its order (the mix is of its slot)', () => {
    expect(Object.keys(eq.params).sort()).toEqual(Object.keys(FX_PARAMS.eq).sort());
    expect([...EQ_KEYS].sort()).toEqual(Object.keys(FX_PARAMS.eq).sort());
    expect(CHAIN_KEYS.eq).toEqual(['t1', 'f1', 'q1', 'g1', 't2', 'f2', 'q2', 'g2', 'level']);
    // a route is `<source>:<effect>.<param>`: lower case letters and digits
    Object.keys(eq.params).forEach((key) => expect(key).toMatch(/^[a-z][a-z0-9]*$/));
  });

  it('the core takes its knobs as they are, falsy ones included, at any tempo and rate', () => {
    const params = { ...EQ_DEFAULTS, t1: 0, q1: 0, g1: 0, t2: 2, g2: -24, level: 0 };
    expect(eq.core(params, 120, RATE)).toEqual(params);
    expect(eq.core(params, 60, 96000)).toEqual(params);
  });

  it('its defaults are those of a chain made before the fx model: the sound as it is, all wet', () => {
    expect(eq.core(EQ_DEFAULTS, 120, RATE)).toEqual(NEUTRAL_PARAMS.eq);
    expect([EQ_DEFAULTS.g1, EQ_DEFAULTS.g2, levelGain(EQ_DEFAULTS.level)]).toEqual([0, 0, 1]);
    expect(FX_MIX_PARAMS.eq.default).toBe(1);
  });

  it('tells no meter, follows no tempo, its label and presets', () => {
    expect(eq.metered).toBeUndefined();
    expect(eq.paramChange).toBeUndefined();
    expect(eq.bounds).toBeUndefined();
    expect(eq.label).toBe('EQ');
    expect(eq.presets).toBe(EQ_PRESETS);
  });
});
