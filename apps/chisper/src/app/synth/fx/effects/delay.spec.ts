import { mapValues } from 'lodash';
import { divisionIndex, FX_PARAMS, TEMPO_DIVISIONS } from '@chisper/preset-schema';
import { DELAY_DEFAULTS, renderDelay } from '../../../../test-utils/delay-render';
import { CHAIN_KEYS, NEUTRAL_PARAMS } from '../../common/chain/chain-params';
import {
  delay,
  delayDivisionOf,
  delayDivisionSeconds,
  delayParamChange,
  delayStepsOf,
  delayTime,
  delayTimeBounds,
} from './delay';
import { DELAY_LINE_MAX } from './delay-params';
import { DELAY_PRESETS } from './delay-presets';

const FX_DEFAULTS = mapValues(FX_PARAMS.delay, (param) => param.default);

const RATE = 44100;
// the samples of Time in the renders (10 ms), what the feedback of a line comes late by, the shortest echo
const TIME = 441;
const LATE = 1;
const SHORTEST = 129;

// both channels silent but a click at their first sample
const click = (left: number, right: number, frames = 4096): [Float32Array, Float32Array] => {
  const channels: [Float32Array, Float32Array] = [new Float32Array(frames), new Float32Array(frames)];
  channels[0][0] = left;
  channels[1][0] = right;
  return channels;
};
// where the echoes start: the samples over a level that follow 64 quieter ones
const echoes = (data: Float32Array, level = 0.03) =>
  [...data.keys()].filter(
    (i) =>
      Math.abs(data[i]) > level && data.subarray(Math.max(0, i - 64), i).every((v) => Math.abs(v) <= level)
  );
const peak = (data: Float32Array) => data.reduce((max, value) => Math.max(max, Math.abs(value)), 0);

describe('delay', () => {
  it('a knob for every param of the schema with its range, the switches of BPM not targets of the routes', () => {
    const { params } = delay;
    expect(Object.keys(params).sort()).toEqual(Object.keys(FX_PARAMS.delay).sort());
    (Object.keys(FX_PARAMS.delay) as (keyof typeof FX_PARAMS.delay)[]).forEach((key) =>
      expect(params[key]).toMatchObject(FX_PARAMS.delay[key])
    );
    (['mode', 'sync', 'div', 'trip', 'dot'] as const).forEach((key) =>
      expect(params[key].options?.length).toBeGreaterThan(1)
    );
    expect(params.mode.options?.map(({ id }) => id)).toEqual(['normal', 'ping-pong']);
    expect(params.sync.options?.map(({ id }) => id)).toEqual(['ms', 'bpm']);
    expect(params.div.options?.map(({ id }) => id)).toEqual(TEMPO_DIVISIONS.map(({ id }) => id));
    (['time', 'fb', 'pan', 'freq', 'q'] as const).forEach((key) =>
      expect(params[key].options).toBeUndefined()
    );
    // a route is `<source>:<effect>.<param>`: lower case letters and digits
    Object.keys(params).forEach((key) => expect(key).toMatch(/^[a-z][a-z0-9]*$/));
    expect(delay.label).toBe('Delay');
    expect(delay.presets).toBe(DELAY_PRESETS);
    expect(delay.metered).toBeUndefined();
  });

  it('the core takes its knobs as they are, falsy ones included, Time as the seconds of its echoes', () => {
    expect(delay.core(FX_DEFAULTS, 120, RATE)).toEqual(DELAY_DEFAULTS);
    const params = { ...FX_DEFAULTS, time: 0.45, fb: 0, mode: 1, pan: -0.02, freq: 3000, q: 2 };
    expect(delay.core(params, 120, RATE)).toEqual({
      time: 0.45,
      fb: 0,
      mode: 1,
      pan: -0.02,
      freq: 3000,
      q: 2,
    });
    expect(delay.core({ ...params, pan: 0, mode: 0 }, 120, RATE)).toMatchObject({ pan: 0, mode: 0 });
    // the rate of the context changes nothing
    expect(delay.core(params, 120, 96000)).toEqual(delay.core(params, 120, RATE));
  });

  it('gives the core every param of its kind and no other, the defaults those a chain starts with', () => {
    const tempo = ['sync', 'div', 'trip', 'dot'];
    DELAY_PRESETS.forEach(({ params }) => {
      const keys = Object.keys(delay.core(params, 120, RATE));
      expect([...keys].sort()).toEqual([...CHAIN_KEYS.delay].sort());
      keys.forEach((key) => expect(tempo).not.toContain(key));
    });
    expect(delay.core(FX_DEFAULTS, 120, RATE)).toEqual(NEUTRAL_PARAMS.delay);
  });

  describe('in BPM', () => {
    const at = (id: string) => divisionIndex(id);

    // the seconds of the echoes the core gets
    const time = (params: Record<string, number>, bpm: number) =>
      delay.core({ ...FX_DEFAULTS, ...params }, bpm, RATE)['time'];

    it('plays the division of Time at the tempo', () => {
      // MS: the division waits
      expect(time({ div: at('1/4') }, 120)).toBe(0.2);
      expect(time({ div: at('1/4'), sync: 1 }, 120)).toBe(0.5);
      expect(time({ div: at('1/8D'), sync: 1, dot: 1 }, 120)).toBe(0.375);
      // a new tempo: the division there
      expect(time({ div: at('1/8D'), sync: 1, dot: 1 }, 60)).toBe(0.75);
      // back to MS: Time
      expect(time({ div: at('1/8D'), sync: 0, dot: 1 }, 60)).toBe(0.2);
    });

    it('steps Time through the same array for the same switches', () => {
      const steps = delayStepsOf({ trip: 0, dot: 0 });
      expect(delayStepsOf({ trip: 0, dot: 0, div: at('1/4') })).toBe(steps);
      expect(steps.map((division) => TEMPO_DIVISIONS[division].id)).toEqual([
        '1/64',
        '1/32',
        '1/16',
        '1/8',
        '1/4',
        '1/2',
        '1 bar',
      ]);
      expect(delayStepsOf({ trip: 1, dot: 0 })).not.toBe(steps);
      expect(delayStepsOf({ trip: 1, dot: 1 })).toBe(delayStepsOf({ trip: 1, dot: 1 }));
    });

    it('a change of BPM, TRIP or DOT sets the division or the seconds of Time with it (delayParamChange)', () => {
      const ms = { ...FX_DEFAULTS, time: 0.3 };
      // 0.6 quarters at 120: 1/8; at 60 0.3 quarters: 1/16
      expect(delayParamChange(ms, 'sync', 1, 120)).toEqual({ sync: 1, div: at('1/8') });
      expect(delayParamChange(ms, 'sync', 1, 60)).toEqual({ sync: 1, div: at('1/16') });
      // MS again: nothing else
      expect(delayParamChange(ms, 'sync', 0, 120)).toEqual({ sync: 0 });
      const bpm = { ...ms, sync: 1, div: at('1/4') };
      expect(delayParamChange(bpm, 'sync', 0, 120)).toEqual({ sync: 0, time: 0.5 });
      // within the range of Time
      expect(delayParamChange({ ...bpm, div: at('1 bar') }, 'sync', 0, 60)).toEqual({ sync: 0, time: 1 });
      expect(delayParamChange({ ...bpm, div: at('1/64') }, 'sync', 0, 300)).toEqual({
        sync: 0,
        time: 0.0125,
      });
      const triplet = { ...bpm, trip: 1, div: at('1/8T') };
      expect(delayParamChange(triplet, 'trip', 0, 120)).toEqual({ trip: 0, div: at('1/8') });
      expect(delayParamChange(triplet, 'dot', 1, 120)).toEqual({ dot: 1, div: at('1/8T') });
      expect(delayParamChange(bpm, 'fb', 0.7, 120)).toEqual({ fb: 0.7 });
    });

    it('takes the straight division of a triplet or a dotted one its switch is off for', () => {
      expect(time({ sync: 1, div: at('1/4T') }, 120)).toBe(0.5);
      expect(time({ sync: 1, div: at('1/4T'), trip: 1 }, 120)).toBeCloseTo(1 / 3, 12);
      expect(delayDivisionOf({ ...FX_DEFAULTS, sync: 1, div: at('1/4T') })).toBe(at('1/4'));
    });

    it('plays a bar at 60 BPM at most: 4 s, a line that long', () => {
      expect(time({ sync: 1, div: at('1 bar') }, 20)).toBe(4);
      expect(delayDivisionSeconds(at('1 bar'), 60)).toBe(4);
      expect(delayDivisionSeconds(at('1 bar'), 59)).toBe(4);
      expect(delayTime({ ...FX_DEFAULTS, sync: 1, div: at('1/4') }, 120)).toBe(0.5);
      expect(DELAY_LINE_MAX).toBe(4);
    });

    it('a new tempo in MS changes nothing', () => {
      expect(delay.core(FX_DEFAULTS, 60, RATE)).toEqual(delay.core(FX_DEFAULTS, 120, RATE));
    });

    it('bounds the routes to Time by its divisions at the tempo, 4 s at most', () => {
      expect(delayTimeBounds({ ...FX_DEFAULTS }, 120)).toBeUndefined();
      // 1/64 … 1 bar at 120
      expect(delayTimeBounds({ ...FX_DEFAULTS, sync: 1 }, 120)).toEqual([0.03125, 2]);
      // with TRIP from 1/64T, a bar at 40 longer than the lines
      expect(delayTimeBounds({ ...FX_DEFAULTS, sync: 1, trip: 1 }, 40)).toEqual([1.5 / 16 / (3 / 2), 4]);
      // the definition gives them by the knob
      expect(delay.bounds?.(FX_DEFAULTS, 120)).toEqual({ time: undefined });
      expect(delay.bounds?.({ ...FX_DEFAULTS, sync: 1 }, 120)).toEqual({ time: [0.03125, 2] });
      expect(delay.paramChange).toBe(delayParamChange);
    });
  });

  // the unit of the chain core (dsp/chain/src/delay.rs): delay-measured and delay-goldens hold its sound
  describe('in the core', () => {
    it('normal: each line feeds itself, an echo Time and a sample after the one before, quieter by the feedback', () => {
      const { left, right } = renderDelay({ time: TIME / RATE, fb: 0.5 }, click(1, 0));
      expect(echoes(left).slice(0, 3)).toEqual([TIME, 2 * TIME + LATE, 3 * TIME + 2 * LATE]);
      expect(peak(right)).toBe(0);
      const levels = [0, 1, 2].map((n) => peak(left.subarray(n * (TIME + LATE) + TIME - 8).subarray(0, 64)));
      // (the bandpass in the feedback spreads an echo: its peak a little under the feedback)
      expect(levels[1] / levels[0]).toBeGreaterThan(0.4);
      expect(levels[1] / levels[0]).toBeLessThanOrEqual(0.5);
      expect(levels[2] / levels[1]).toBeGreaterThan(0.4);
      expect(levels[2] / levels[1]).toBeLessThanOrEqual(0.5);
    });

    it('no feedback: one echo', () => {
      const { left } = renderDelay({ time: TIME / RATE, fb: 0 }, click(1, 0));
      expect(echoes(left)).toEqual([TIME]);
      expect(peak(left.subarray(TIME + 256))).toBeLessThan(1e-3);
    });

    it('ping-pong: the mono sum goes into the left line, the echoes alternate between the channels', () => {
      const one = renderDelay({ time: TIME / RATE, fb: 0.5, mode: 1 }, click(1, 0));
      // (the right line gives the echo of the left one back as it is, a Time later: the feedback once a round)
      expect(echoes(one.left).slice(0, 2)).toEqual([TIME, 3 * TIME + LATE]);
      expect(echoes(one.right).slice(0, 2)).toEqual([2 * TIME, 4 * TIME + LATE]);
      expect(one.right.subarray(TIME, 2 * TIME + 256)).toEqual(one.left.subarray(0, TIME + 256));
      // half of a click of one channel, whichever it is
      const other = renderDelay({ time: TIME / RATE, fb: 0.5, mode: 1 }, click(0, 1));
      expect(other.left).toEqual(one.left);
      expect(other.right).toEqual(one.right);
      const normal = renderDelay({ time: TIME / RATE, fb: 0.5 }, click(1, 0));
      expect(one.left[TIME]).toBeCloseTo(normal.left[TIME] / 2, 6);
    });

    it('pan delays the right channel of the echoes when negative, the left one when positive', () => {
      const run = (pan: number) => renderDelay({ time: TIME / RATE, fb: 0.5, pan }, click(1, 1));
      const centre = run(0);
      expect(echoes(centre.left)[0]).toBe(TIME);
      expect(echoes(centre.right)[0]).toBe(TIME);
      const toLeft = run(-0.01);
      expect(echoes(toLeft.left)[0]).toBe(TIME);
      expect(echoes(toLeft.right).slice(0, 2)).toEqual([2 * TIME, 3 * TIME + LATE]);
      const toRight = run(0.01);
      expect(echoes(toRight.left).slice(0, 2)).toEqual([2 * TIME, 3 * TIME + LATE]);
      expect(echoes(toRight.right)[0]).toBe(TIME);
      // the late channel is the other one, late by whole samples
      expect(toRight.left.subarray(TIME, TIME + 2048)).toEqual(toRight.right.subarray(0, 2048));
    });

    it('a line is never read under a segment of the core: the shortest echo', () => {
      const { left } = renderDelay({ time: 0.001, fb: 0.5 }, click(1, 0));
      expect(echoes(left).slice(0, 2)).toEqual([SHORTEST, 2 * SHORTEST + LATE]);
    });

    it('a Time that holds is whole samples: an echo is the sound as the line got it', () => {
      const { left } = renderDelay({ time: (TIME + 0.4) / RATE, fb: 0, q: 0.0001 }, click(1, 0));
      expect(echoes(left)).toEqual([TIME]);
      const late = renderDelay({ time: (TIME + 0.6) / RATE, fb: 0, q: 0.0001 }, click(1, 0));
      expect(echoes(late.left)).toEqual([TIME + 1]);
    });

    it('Freq and Q are the bandpass of the echoes: a narrow one rings quieter', () => {
      const wide = renderDelay({ time: TIME / RATE, fb: 0, freq: 1000, q: 0.01 }, click(1, 0));
      const narrow = renderDelay({ time: TIME / RATE, fb: 0, freq: 1000, q: 8 }, click(1, 0));
      expect(peak(wide.left)).toBeGreaterThan(0.8);
      expect(peak(narrow.left)).toBeLessThan(0.2);
      expect(peak(narrow.left)).toBeGreaterThan(0);
    });
  });

  it('formats pan by side', () => {
    const format = delay.params.pan.formatValue;
    expect(format?.(-0.012)).toBe('L 12ms');
    expect(format?.(0.05)).toBe('R 50ms');
    expect(format?.(0.0001)).toBe('0ms');
  });

  it('formats the frequency in Hz and kHz', () => {
    const format = delay.params.freq.formatValue;
    expect(format?.(440)).toBe('440Hz');
    expect(format?.(2500)).toBe('2.5kHz');
  });
});
