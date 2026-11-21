import { mapValues, omit } from 'lodash';
import { divisionIndex, FX_MIX_PARAMS, FX_PARAMS, TEMPO_DIVISIONS } from '@chisper/preset-schema';
import { CHORUS_DEFAULTS as DEFAULTS, TAP_LATENCY_MS } from '../../../../test-utils/chorus-render';
import { CHAIN_KEYS, NEUTRAL_PARAMS } from '../../common/chain/chain-params';
import {
  chorus,
  chorusDivisionHz,
  chorusDivisionOf,
  chorusParamChange,
  chorusRate,
  chorusRateBounds,
  chorusStepsOf,
} from './chorus';
import { depthMs } from './chorus-params';
import { levelGain } from './level';
import { CHORUS_PRESETS } from './chorus-presets';
import { CHORUS_KEYS } from './chorus-wasm';

const RATE = 48000;

const SCHEMA_DEFAULTS = mapValues(FX_PARAMS.chorus, (param) => param.default);
const ids = (steps: readonly number[]) => steps.map((step) => TEMPO_DIVISIONS[step].id);

describe('chorus', () => {
  it('the laws of its knobs: the rate in Hz on a scale of a power, the taps in ms, the level in dB', () => {
    const { params } = chorus;
    expect(params.rate.mode).toBe('pow');
    expect(params.rate.formatValue?.(0.078)).toBe('0.078Hz');
    expect(params.rate.formatValue?.(2.5)).toBe('2.50Hz');
    expect(params.d1.formatValue?.(5)).toBe('5.0ms');
    expect(params.d2.formatValue?.(12)).toBe('12ms');
    expect(depthMs(0)).toBe(0);
    expect(depthMs(26)).toBe(62.5);
    expect(params.depth.formatValue?.(26)).toBe('63ms');
    expect(params.depth.formatValue?.(2)).toBe('4.8ms');
    expect(params.fb.formatValue?.(0.095)).toBe('10%');
    expect(params.cut.mode).toBe('log');
    expect(params.cut.formatValue?.(1000)).toBe('1.0kHz');
    expect(levelGain(0.5)).toBe(1);
    expect(params.level.formatValue?.(0.5)).toBe('0.0dB');
    expect(params.level.formatValue?.(1)).toBe('+12.0dB');
    expect(params.level.formatValue?.(0)).toBe('-∞dB');
    expect(TAP_LATENCY_MS).toBeCloseTo(0.119, 3);
    // the switches are not targets of the routes: they have options
    (['sync', 'div', 'trip', 'dot', 'hpf'] as const).forEach((key) =>
      expect(params[key].options?.length).toBeGreaterThan(1)
    );
    expect(params.hpf.options?.map(({ id }) => id)).toEqual(['lpf', 'hpf']);
  });

  it('a knob for every param of the schema; the core takes its knobs and the mix in its order', () => {
    expect(Object.keys(chorus.params).sort()).toEqual(Object.keys(FX_PARAMS.chorus).sort());
    const tempo = ['sync', 'div', 'trip', 'dot'];
    expect([...CHORUS_KEYS].sort()).toEqual(
      [...Object.keys(FX_PARAMS.chorus).filter((key) => !tempo.includes(key)), 'mix'].sort()
    );
    // a route is `<source>:<effect>.<param>`: lower case letters and digits
    Object.keys(chorus.params).forEach((key) => expect(key).toMatch(/^[a-z][a-z0-9]*$/));
  });

  describe('in BPM', () => {
    const BPM = { ...SCHEMA_DEFAULTS, sync: 1 };

    it('the steps of Rate: 8 bar … 1/32 a cycle, faster to the right, with TRIP and DOT theirs', () => {
      const straight = ids(chorusStepsOf(BPM));
      expect(straight[0]).toBe('8 bar');
      expect(straight[straight.length - 1]).toBe('1/32');
      expect(straight).toHaveLength(9);
      expect(ids(chorusStepsOf({ ...BPM, trip: 1 }))).toContain('1/4T');
      expect(ids(chorusStepsOf({ ...BPM, dot: 1 }))).toContain('2 bar D');
      expect(chorusStepsOf({ ...BPM, trip: 1, dot: 1 })).toHaveLength(27);
      // the same array for the same switches
      expect(chorusStepsOf({ ...BPM })).toBe(chorusStepsOf(BPM));
    });

    it('a cycle of the LFO is its division at the tempo, the top of Rate at most', () => {
      expect(chorusDivisionHz(divisionIndex('1 bar'), 120)).toBe(0.5);
      expect(chorusDivisionHz(divisionIndex('1/4'), 90)).toBeCloseTo(1.5, 9);
      expect(chorusDivisionHz(divisionIndex('1/32'), 300)).toBe(20);
      expect(chorusRate({ ...BPM, div: divisionIndex('2 bar') }, 120)).toBe(0.25);
      expect(chorusRate({ ...BPM, sync: 0, rate: 3 }, 120)).toBe(3);
      // a division that is not a step (TRIP off): its straight one
      expect(chorusDivisionOf({ ...BPM, div: divisionIndex('1/4T') })).toBe(divisionIndex('1/4'));
    });

    it('the bounds of the routes to Rate: its slowest and its fastest step, none in Hz', () => {
      expect(chorusRateBounds(SCHEMA_DEFAULTS, 120)).toBeUndefined();
      expect(chorusRateBounds(BPM, 120)).toEqual([1 / 16, 16]);
      expect(chorusRateBounds({ ...BPM, trip: 1 }, 120)).toEqual([1 / 16, 20]);
    });

    it('a change of the user: BPM takes the nearest division, HZ its rate, TRIP and DOT a step of theirs', () => {
      const hz = { ...SCHEMA_DEFAULTS, rate: 2 };
      expect(chorusParamChange(hz, 'sync', 1, 120)).toEqual({ sync: 1, div: divisionIndex('1/4') });
      expect(chorusParamChange({ ...hz, rate: 0 }, 'sync', 1, 120)).toEqual({
        sync: 1,
        div: divisionIndex('8 bar'),
      });
      const synced = { ...BPM, div: divisionIndex('1/8') };
      expect(chorusParamChange(synced, 'sync', 0, 120)).toEqual({ sync: 0, rate: 4 });
      expect(chorusParamChange(synced, 'sync', 1, 120)).toEqual({ sync: 1 });
      const triplet = { ...BPM, trip: 1, div: divisionIndex('1/8T') };
      expect(chorusParamChange(triplet, 'trip', 0, 120)).toEqual({ trip: 0, div: divisionIndex('1/8') });
      expect(chorusParamChange(synced, 'depth', 0, 120)).toEqual({ depth: 0 });
    });
  });

  it('the core takes its knobs as they are, falsy ones included, Rate as the Hz in effect', () => {
    expect(chorus.core(SCHEMA_DEFAULTS, 120, RATE)).toEqual(omit(DEFAULTS, 'mix'));
    const params = { ...SCHEMA_DEFAULTS, rate: 0, depth: 0, fb: 0, hpf: 1, level: 0, d2: 3 };
    expect(chorus.core(params, 120, RATE)).toEqual({
      rate: 0,
      d1: SCHEMA_DEFAULTS.d1,
      d2: 3,
      depth: 0,
      fb: 0,
      cut: SCHEMA_DEFAULTS.cut,
      hpf: 1,
      level: 0,
    });
    // the rate of the context changes nothing
    expect(chorus.core(params, 120, 96000)).toEqual(chorus.core(params, 120, RATE));
  });

  it('Rate reaches the core as the Hz in effect: its knob, in BPM its division at the tempo', () => {
    const rate = (params: Partial<typeof SCHEMA_DEFAULTS>, bpm: number) =>
      chorus.core({ ...SCHEMA_DEFAULTS, ...params }, bpm, RATE)['rate'];
    const half = { rate: 0, div: divisionIndex('1/2') };
    // HZ: the division waits
    expect(rate(half, 120)).toBe(0);
    expect(rate({ ...half, sync: 1 }, 120)).toBe(1);
    expect(rate({ ...half, sync: 1 }, 60)).toBe(0.5);
    // a triplet is a step only with TRIP: its straight division without
    const triplet = { ...half, sync: 1, div: divisionIndex('1/2T') };
    expect(rate(triplet, 60)).toBe(0.5);
    expect(rate({ ...triplet, trip: 1 }, 60)).toBeCloseTo(0.75, 9);
    // the top of Rate at most
    expect(rate({ sync: 1, div: divisionIndex('1/32') }, 300)).toBe(FX_PARAMS.chorus.rate.max);
    // a tempo in Hz changes nothing
    expect(rate({ rate: 3 }, 140)).toBe(3);
  });

  it('gives the core the params of its kind but the mix: the mix of its slot is the mix inside', () => {
    const tempo = ['sync', 'div', 'trip', 'dot'];
    CHORUS_PRESETS.forEach(({ params }) => {
      const keys = Object.keys(chorus.core(params, 120, RATE));
      keys.forEach((key) => expect(CHAIN_KEYS.chorus).toContain(key));
      keys.forEach((key) => expect(tempo).not.toContain(key));
      expect([...keys, 'mix'].sort()).toEqual([...CHAIN_KEYS.chorus].sort());
    });
    // the defaults: those a chain starts with
    expect({ ...chorus.core(SCHEMA_DEFAULTS, 120, RATE), mix: FX_MIX_PARAMS.chorus.default }).toEqual(
      NEUTRAL_PARAMS.chorus
    );
  });

  it('follows the tempo by its definition: a change of the user, the bounds of the routes to Rate', () => {
    expect(chorus.paramChange).toBe(chorusParamChange);
    const bpm = { ...SCHEMA_DEFAULTS, sync: 1 };
    expect(chorus.bounds?.(SCHEMA_DEFAULTS, 120)).toEqual({ rate: undefined });
    expect(chorus.bounds?.(bpm, 120)).toEqual({ rate: [1 / 16, 16] });
    expect(chorus.bounds?.(bpm, 60)).toEqual({ rate: [1 / 32, 8] });
  });

  it('tells a meter while a screen watches it', () => {
    expect(chorus.metered).toBe(true);
    expect(chorus.label).toBe('Chorus');
    expect(chorus.presets).toBe(CHORUS_PRESETS);
  });
});
