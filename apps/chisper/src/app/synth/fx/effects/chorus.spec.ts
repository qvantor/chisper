import { divisionIndex, FX_PARAMS, TEMPO_DIVISIONS } from '@chisper/preset-schema';
import { CHORUS_DEFAULTS as DEFAULTS, TAP_LATENCY_MS } from '../../../../test-utils/chorus-render';
import { withoutAudioWorklet } from '../../../../test-utils/no-audio-worklet';
import { CHORUS_PROCESSOR } from '../../common/processors';
import {
  chorus,
  chorusDivisionHz,
  chorusDivisionOf,
  chorusParamChange,
  chorusRate,
  chorusRateBounds,
  chorusStepsOf,
} from './chorus';
import { ChorusMeterValues, depthMs, levelGain } from './chorus-params';
import { CHORUS_KEYS } from './chorus-wasm';
import { WORKLETS_PATH } from './load-worklet';

interface WorkletNodeStub extends AudioWorkletNode {
  name: string;
  options: AudioWorkletNodeOptions;
  port: AudioWorkletNode['port'] & { postMessage: jest.Mock };
}

// the module loads asynchronously: the node exists after the pending promises settle
const flush = () => new Promise((resolve) => setTimeout(resolve));

const setup = () => {
  const audioCtx = new AudioContext();
  const createGain = jest.spyOn(audioCtx, 'createGain');
  const core = chorus.create(audioCtx);
  const [input, output] = createGain.mock.results.map(({ value }) => value as GainNode);
  // the input connects to the worklet node once it is created
  const node = () => (input.connect as jest.Mock).mock.calls[0]?.[0] as WorkletNodeStub | undefined;
  const messages = () => node()?.port.postMessage.mock.calls.map(([message]) => message);
  // a message of the processor
  const receive = (data: unknown) => node()?.port.onmessage?.({ data } as MessageEvent);
  return { audioCtx, core, input, output, node, messages, receive };
};

const METER: ChorusMeterValues = { phase: 0.25, rate: 2, d1: 5, d2: 0, depth: 26, cut: 1000, idle: false };

const SCHEMA_DEFAULTS = Object.fromEntries(
  Object.entries(FX_PARAMS.chorus).map(([key, { default: value }]) => [key, value])
);
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

  it('passes input and output gains at once, the worklet node joins them after the module loads', async () => {
    const { audioCtx, core, input, output, node } = setup();
    expect(core.input).toBe(input);
    expect(core.output).toBe(output);
    expect(node()).toBeUndefined();
    await flush();
    expect(audioCtx.audioWorklet.addModule).toHaveBeenCalledWith(
      new URL(`${WORKLETS_PATH}chorus.js`, document.baseURI).href
    );
    expect(node()?.name).toBe(CHORUS_PROCESSOR);
    expect(node()?.connect).toHaveBeenCalledWith(output);
    expect(node()?.options).toMatchObject({ numberOfInputs: 1, outputChannelCount: [2], channelCount: 2 });
  });

  it('mixes inside: no latency, no linear mix of the slot', () => {
    const { core } = setup();
    expect(core.mixInside).toBe(true);
    expect(core.latency).toBeUndefined();
    expect(core.linearMix).toBeUndefined();
  });

  it('its meter: asked of the processor while watched, each watcher gets its values', async () => {
    const { core, messages, receive } = setup();
    await flush();
    const [first, second] = [jest.fn(), jest.fn()];
    const stopFirst = core.meter?.watch(first);
    expect(messages()).toEqual([{ meter: true }]);
    const stopSecond = core.meter?.watch(second);
    expect(messages()).toHaveLength(1);
    receive({ meter: METER });
    expect(first).toHaveBeenCalledWith(METER);
    expect(second).toHaveBeenCalledWith(METER);
    // another message of the processor is not a meter
    receive({ other: 1 });
    receive(null);
    expect(first).toHaveBeenCalledTimes(1);
    stopFirst?.();
    // (left twice: once)
    stopFirst?.();
    expect(messages()).toHaveLength(1);
    receive({ meter: METER });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    stopSecond?.();
    expect(messages()).toEqual([{ meter: true }, { meter: false }]);
  });

  it('a meter watched before the module loads: the node starts with it on', async () => {
    const { core, node } = setup();
    const stop = core.meter?.watch(jest.fn());
    await flush();
    expect(node()?.options.processorOptions).toEqual({ params: DEFAULTS, meter: true });
    stop?.();
    expect(node()?.port.postMessage).toHaveBeenCalledWith({ meter: false });
  });

  it('a destroyed one tells its watchers nothing', async () => {
    const { core, node } = setup();
    await flush();
    const watcher = jest.fn();
    core.meter?.watch(watcher);
    const stub = node();
    core.destroy();
    stub?.port.onmessage?.({ data: { meter: METER } } as MessageEvent);
    expect(watcher).not.toHaveBeenCalled();
  });

  it('starts the processor with the defaults, the mix among them', async () => {
    const { node } = setup();
    await flush();
    expect(node()?.options.processorOptions).toEqual({ params: DEFAULTS });
  });

  it('keeps what is set before the module loads: falsy params, the mix, BPM at the tempo, not active', async () => {
    const { core, node } = setup();
    core.setParam('depth', 0);
    core.setParam('hpf', 1);
    core.setParam('mix', 0);
    core.setParam('level', 0);
    core.setParam('unknown', 5);
    core.setParam('sync', 1);
    core.setParam('div', divisionIndex('1/4'));
    core.setTempo?.(90);
    core.setActive(false);
    await flush();
    expect(node()?.options.processorOptions).toEqual({
      params: { ...DEFAULTS, depth: 0, hpf: 1, mix: 0, level: 0, rate: 1.5 },
      inactive: true,
    });
    expect(node()?.port.postMessage).not.toHaveBeenCalled();
  });

  it('posts every changed param and the routes of its knobs, ignores unknown keys', async () => {
    const { core, messages } = setup();
    await flush();
    core.setParam('fb', 0);
    core.setParam('mix', 0.25);
    core.setParam('d2', 3);
    core.setParam('nope', 1);
    const route = { param: 'depth', source: 1, amount: 4, min: 0, max: 26 };
    core.setModulation({ note: null, routes: [route] });
    core.setModulation(null);
    expect(messages()).toEqual([
      { params: { fb: 0 } },
      { params: { mix: 0.25 } },
      { params: { d2: 3 } },
      { mod: { note: null, routes: [route] } },
      { mod: null },
    ]);
  });

  it('Rate reaches the processor as the Hz in effect: its knob, in BPM its division at the tempo', async () => {
    const { core, messages } = setup();
    await flush();
    core.setParam('rate', 0);
    core.setParam('div', divisionIndex('1/2'));
    core.setParam('sync', 1);
    core.setTempo?.(60);
    core.setParam('trip', 1);
    core.setParam('div', divisionIndex('1/2T'));
    core.setParam('sync', 0);
    // a tempo in Hz changes nothing
    core.setTempo?.(140);
    expect(messages()).toEqual([
      { params: { rate: 0 } },
      { params: { rate: 0 } },
      { params: { rate: 1 } },
      { params: { rate: 0.5 } },
      { params: { rate: 0.5 } },
      { params: { rate: expect.closeTo(0.75, 9) } },
      { params: { rate: 0 } },
    ]);
  });

  it('tells the processor when it is not active (no feedback: its taps drain), once per change', async () => {
    const { core, messages } = setup();
    await flush();
    core.setActive(true);
    core.setActive(false);
    core.setActive(false);
    core.setActive(true);
    expect(messages()).toEqual([{ active: false }, { active: true }]);
  });

  it('clear and destroy reach the processor', async () => {
    const { core, messages } = setup();
    await flush();
    core.clear?.();
    core.destroy();
    expect(messages()).toEqual([{ clear: true }, { stop: true }]);
  });

  it('without AudioWorklet it is unsupported: no node, its status says so', async () => {
    withoutAudioWorklet();
    const { core, node } = setup();
    await flush();
    expect(core.$status?.value).toBe('unsupported');
    expect(node()).toBeUndefined();
    jest.restoreAllMocks();
  });
});
