import { FX_PARAMS } from '@chisper/preset-schema';
import { COMPRESSOR_DEFAULTS as DEFAULTS } from '../../../../test-utils/compressor-render';
import { withoutAudioWorklet } from '../../../../test-utils/no-audio-worklet';
import { COMPRESSOR_PROCESSOR } from '../../common/processors';
import { compressor, formatBandThresholds } from './compressor';
import { COMPRESSOR_MODES } from './compressor-modes';
import { bandThresholdsDb, levelGain, makeupGain, thresholdDb } from './compressor-params';
import { COMPRESSOR_KEYS } from './compressor-wasm';
import { WORKLETS_PATH } from './load-worklet';
import type { FxMeterValues } from './types';

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
  const core = compressor.create(audioCtx);
  const [input, output] = createGain.mock.results.map(({ value }) => value as GainNode);
  // the input connects to the worklet node once it is created
  const node = () => (input.connect as jest.Mock).mock.calls[0]?.[0] as WorkletNodeStub | undefined;
  const messages = () => node()?.port.postMessage.mock.calls.map(([message]) => message);
  // a message of the processor
  const receive = (data: unknown) => node()?.port.onmessage?.({ data } as MessageEvent);
  return { audioCtx, core, input, output, node, messages, receive };
};

const METER: FxMeterValues = { gains: [-3, -6, 2], input: 0.5 };

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

  it('passes input and output gains at once, the worklet node joins them after the module loads', async () => {
    const { audioCtx, core, input, output, node } = setup();
    expect(core.input).toBe(input);
    expect(core.output).toBe(output);
    expect(node()).toBeUndefined();
    await flush();
    expect(audioCtx.audioWorklet.addModule).toHaveBeenCalledWith(
      new URL(`${WORKLETS_PATH}compressor.js`, document.baseURI).href
    );
    expect(node()?.name).toBe(COMPRESSOR_PROCESSOR);
    expect(node()?.connect).toHaveBeenCalledWith(output);
    expect(node()?.options).toMatchObject({ numberOfInputs: 1, outputChannelCount: [2], channelCount: 2 });
  });

  it('mixes inside: no latency, no linear mix of the slot', () => {
    const { core } = setup();
    expect(core.mixInside).toBe(true);
    expect(core.latency).toBeUndefined();
    expect(core.linearMix).toBeUndefined();
  });

  it('starts the processor with the defaults, the mix among them, its meter off', async () => {
    const { node } = setup();
    await flush();
    expect(node()?.options.processorOptions).toEqual({ params: DEFAULTS });
  });

  it('keeps the params set before the module loads, falsy ones and the mix included', async () => {
    const { core, node } = setup();
    core.setParam('thresh', 0);
    core.setParam('multi', 1);
    core.setParam('mix', 0);
    core.setParam('level', 0);
    core.setParam('unknown', 5);
    await flush();
    expect(node()?.options.processorOptions).toEqual({
      params: { ...DEFAULTS, thresh: 0, multi: 1, mix: 0, level: 0 },
    });
    expect(node()?.port.postMessage).not.toHaveBeenCalled();
  });

  it('posts every changed param and the routes of its knobs, ignores unknown keys', async () => {
    const { core, messages } = setup();
    await flush();
    core.setParam('multi', 0);
    core.setParam('mix', 0.5);
    core.setParam('below', 0);
    core.setParam('nope', 1);
    const route = { param: 'mix', source: 1, amount: 0.5, min: 0, max: 1 };
    core.setModulation({ note: null, routes: [route] });
    core.setModulation(null);
    expect(messages()).toEqual([
      { params: { multi: 0 } },
      { params: { mix: 0.5 } },
      { params: { below: 0 } },
      { mod: { note: null, routes: [route] } },
      { mod: null },
    ]);
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

  it('clear and destroy reach the processor, a destroyed one tells its watchers nothing', async () => {
    const { core, messages, node, receive } = setup();
    await flush();
    const watcher = jest.fn();
    core.meter?.watch(watcher);
    core.clear?.();
    const stub = node();
    core.destroy();
    expect(messages()).toEqual([{ meter: true }, { clear: true }, { stop: true }]);
    stub?.port.onmessage?.({ data: { meter: METER } } as MessageEvent);
    receive({ meter: METER });
    expect(watcher).not.toHaveBeenCalled();
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
