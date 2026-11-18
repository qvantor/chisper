import { chainState, noise, slotOf } from '../../../../test-utils/chain-render';
import { installWorkletScope } from '../../../../test-utils/worklet-scope';
import {
  CHAIN_KEYS,
  ChainMessage,
  ChainRoute,
  ChainState,
  FX_KINDS,
  LFO_SOURCE,
  LIMITER_STAGE,
  TARGET_KEYS,
} from '../chain/chain-params';
import { TRAP_IN } from '../chain/chain-wasm';
import { LfosState, lfoTable, lfoTableFrom, RETRIG } from '../lfo/lfo-curve';
import type { VoiceEvent, VoiceOptions, VoiceRoute } from '../wavetable/voice-options';
import { buildLevels } from '../wavetable/wavetable-mipmap';
import type { VoiceParam } from '../wavetable/wavetable-osc-params';
import { STORE_CHUNK } from '../wavetable/wavetable-osc-wasm';
import { ENGINE_PROCESSOR, EngineMessage, EngineOptions, LfoReader } from './engine-params';
import type { EngineWasm } from './engine-wasm';

const RATE = 48000;
const processors = installWorkletScope(RATE);

const peak = (data: Float32Array) => data.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
const silent = (data: Float32Array) => data.every((value) => value === 0);

// ENV 1 at full level, the gate ends the voice at once
const FLAT = { attack: 0, hold: 0, decay: 0, sustain: 1, release: 0 };

const sine = Array.from({ length: 2048 }, (_, n) => Math.sin((2 * Math.PI * n) / 2048));
const saw = Array.from({ length: 2048 }, (_, n) => n / 1024 - 1);

interface Processor {
  port: { onmessage: (event: { data: unknown }) => void; postMessage: (message: unknown) => void };
  process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
  engine: EngineWasm | null;
  // what it posted, copied as a port copies it (the processor posts the same message every time)
  posts: jest.Mock;
}

// (the nodes of a test stop at its end: their voices give their versions back to the store of the scope)
const nodes: Processor[] = [];
afterEach(() => nodes.splice(0).forEach((processor) => processor.port.onmessage({ data: { stop: true } })));

const create = (options?: EngineOptions): Processor => {
  const processor = new processors[ENGINE_PROCESSOR](
    options ? { processorOptions: options } : {}
  ) as unknown as Processor;
  processor.posts = jest.fn();
  processor.port.postMessage = (message) => processor.posts(JSON.parse(JSON.stringify(message)));
  nodes.push(processor);
  return processor;
};
const tell = (processor: Processor, data: EngineMessage) => processor.port.onmessage({ data });
// what a node told the main thread
const reports = (processor: Processor) => processor.posts.mock.calls.map(([message]) => message);

// the chain alone on the input of its node, as its knobs have it
const fed = (state?: ChainState) => create({ ...(state && { state }), fed: true });

const voiceOptions = (table: string, more: Partial<VoiceOptions> = {}): VoiceOptions => ({
  osc: [{ table, unison: 1, phase: 0.25, phaseRand: 0 }, null],
  start: 0,
  envelopes: [FLAT, FLAT, FLAT],
  envStart: more.start ?? 0,
  routes: [],
  filter: null,
  phrase: 0,
  ...more,
});
// a note of `table` (at 100 Hz, gain 1 unless `params` say otherwise)
const on = (
  voice: number,
  table: string,
  more: Partial<VoiceOptions> = {},
  params: Partial<Record<VoiceParam, number>> = {}
): VoiceEvent => ({
  kind: 'on',
  voice,
  options: voiceOptions(table, { phrase: voice, ...more }),
  params: { gain1: 1, frequency: 100, ...params },
});
// a node playing one note of `table`, its events before its first block; its chain a wire without the limiter: its
// output is its voices
const voice = (
  table: string,
  options: Partial<VoiceOptions> = {},
  params: Partial<Record<VoiceParam, number>> = {},
  events: VoiceEvent[] = []
) => create({ unlimited: true, events: [on(1, table, { phrase: 0, ...options }, params), ...events] });

// a block at `frame`: the node gets `input` (none: no channel), its outputs of `channels` channels each
const block = (
  processor: Processor,
  frame: number,
  {
    input,
    channels = [2],
    frames = 128,
  }: { input?: Float32Array[]; channels?: number[]; frames?: number } = {}
) => {
  Object.assign(globalThis, { currentFrame: frame });
  const outputs = channels.map((count) => Array.from({ length: count }, () => new Float32Array(frames)));
  const alive = processor.process(input ? [input] : [[]], outputs);
  return { alive, outputs, left: outputs[0][0], right: outputs[0][1] };
};

// `blocks` blocks from `frame` on (of `input`, from its start), both channels of the output
const run = (processor: Processor, blocks: number, frame = 0, input?: Float32Array[]) => {
  const left = new Float32Array(blocks * 128);
  const right = new Float32Array(blocks * 128);
  for (let index = 0; index < blocks; index++) {
    const from = index * 128;
    const rendered = block(processor, frame + from, {
      input: input?.map((channel) => channel.subarray(from, from + 128)),
    });
    expect(rendered.alive).toBe(true);
    left.set(rendered.left, from);
    right.set(rendered.right, from);
  }
  return { left, right };
};

const stats = (processor: Processor) => {
  tell(processor, { stats: true });
  return processor.posts.mock.calls[processor.posts.mock.calls.length - 1][0].stats;
};

// a port of a MessageChannel: the worker posts to it, the store answers through it
const workerPort = () => ({
  onmessage: null as null | ((event: { data: unknown }) => void),
  postMessage: jest.fn(),
});
const withWorker = (processor: Processor) => {
  const port = workerPort();
  processor.port.onmessage({ data: { port } });
  return port;
};

// a version as the worker sends it to a store that asked for chunks: its layout, then chunks of `size` samples, each
// once the last was acked
const sendInChunks = (
  port: ReturnType<typeof workerPort>,
  table: string,
  version: number,
  frames: number[][],
  size = STORE_CHUNK
) => {
  const { data, ...layout } = buildLevels(frames);
  port.onmessage?.({ data: { table, version, begin: { ...layout, length: data.length } } });
  for (let at = 0; at < data.length; at += size) {
    const length = Math.min(size, data.length - at);
    const chunk = new ArrayBuffer(size * 4);
    new Float32Array(chunk, 0, length).set(data.subarray(at, at + length));
    port.onmessage?.({ data: { table, version, chunk, at, length, last: at + length >= data.length } });
    expect(port.postMessage).toHaveBeenLastCalledWith({ ack: chunk }, [chunk]);
  }
  return data;
};

// more routes than the command buffer holds: the core reads past it
const tooManyRoutes = (): VoiceRoute[] =>
  Array.from({ length: 1000 }, () => ({ source: 1, param: 'gain1', amount: 1, min: 0, max: 1 }));

// the LFOs at `level` all along (a shape of one value), there at once
const flatLfos = (level: number): LfosState => ({
  at: 0,
  instantly: true,
  lfos: [0, 1, 2, 3].map(() => ({
    mode: RETRIG,
    delay: 0,
    rise: 0,
    smooth: 0,
    phase: 0,
    anchor: { time: 0, phase: 0, period: 0.5 },
    table: lfoTableFrom([level]),
  })),
});
// the LFOs running free, a cycle 50 ms
const fastLfos = (): LfosState => ({
  at: -1,
  instantly: false,
  lfos: [0, 1, 2, 3].map(() => ({
    mode: 1,
    delay: 0,
    rise: 0,
    smooth: 0,
    phase: 0,
    anchor: { time: 0, phase: 0, period: 0.05 },
  })),
});
// the gain of oscillator 1 as 1 - LFO 1: silent while it is at 1
const LFO_ON_GAIN: VoiceRoute[] = [{ source: 4, param: 'gain1', amount: -1, min: 0, max: 1 }];
// the level of the distortion
const LEVEL = slotOf('distortion') * TARGET_KEYS + CHAIN_KEYS.distortion.indexOf('level');
const LFO_ON_LEVEL: ChainRoute[] = [{ target: LEVEL, source: LFO_SOURCE, amount: -12, min: -24, max: 12 }];
// the peaks of the blocks 20 to 60 of a render: how far a knob an LFO moves takes them apart
const sweep = (left: Float32Array) => {
  const peaks = Array.from({ length: 40 }, (_, index) =>
    peak(left.subarray((20 + index) * 128, (21 + index) * 128))
  );
  return Math.max(...peaks) / Math.min(...peaks);
};

describe('engine wasm worklet', () => {
  // (the errors as the module loaded: of its prewarm; clearMocks clears the calls before every test)
  let logged: unknown[][] = [];
  beforeAll(async () => {
    const error = jest.spyOn(console, 'error');
    await import('./engine.worklet');
    logged = [...error.mock.calls];
    error.mockRestore();
  });

  it('prewarms its core as it loads, without an error', () => {
    expect(logged).toEqual([]);
  });

  it('registers the one processor of the engine', () => {
    expect(Object.keys(processors)).toEqual([ENGINE_PROCESSOR]);
  });

  describe('a block', () => {
    it('renders the voices through the chain: the output is the limiter’s, late by its lookahead', () => {
      const events = [on(1, 'none', {}, { gain1: 0.25 })];
      const voices = run(create({ unlimited: true, events }), 20).left;
      const processor = create({ events });
      const { left, right } = run(processor, 20);
      const latency = processor.engine?.latency ?? 0;
      expect(latency).toBeGreaterThan(0);
      expect(peak(voices)).toBeCloseTo(0.25, 4);
      // (under the ceiling the limiter is its input)
      expect(left.subarray(latency)).toEqual(voices.subarray(0, voices.length - latency));
      expect(silent(left.subarray(0, latency))).toBe(true);
      expect(right).toEqual(left);
    });

    it('holds the voices under the ceiling of the limiter, not when made unlimited', () => {
      const events = [on(1, 'none'), on(2, 'none')];
      const unlimited = create({ unlimited: true, events });
      expect(unlimited.engine?.latency).toBe(0);
      expect(peak(run(unlimited, 20).left)).toBeCloseTo(2, 3);
      const limited = peak(run(create({ events }), 20).left);
      expect(limited).toBeGreaterThan(0.9);
      expect(limited).toBeLessThanOrEqual(10 ** (-0.5 / 20));
    });

    it('plays the voices through the effects of its state, the gains of its chain', () => {
      const events = [on(1, 'none', {}, { gain1: 0.25 })];
      const wire = run(create({ unlimited: true, events }), 40).left;
      const state = chainState(['distortion'], 1, { distortion: { params: { drive: 12 } } });
      const driven = run(create({ unlimited: true, events, state }), 40).left;
      expect(peak(driven)).toBeGreaterThan(0.01);
      expect(driven).not.toEqual(wire);
      const quiet = run(
        create({ unlimited: true, events, state: chainState([], 1, {}, { masterGain: 0.5 }) }),
        40
      ).left;
      expect(peak(quiet)).toBeCloseTo(0.5 * peak(wire), 5);
      const muted = create({ unlimited: true, events, state: chainState([], 1, {}, { muted: true }) });
      expect(peak(run(muted, 40).left)).toBe(0);
    });

    it('takes the knobs of the chain while the voices play', () => {
      const processor = create({ unlimited: true, events: [on(1, 'none', {}, { gain1: 0.25 })] });
      expect(peak(run(processor, 10).left)).toBeCloseTo(0.25, 4);
      tell(processor, { masterGain: 0.5 });
      expect(peak(run(processor, 10, 20 * 128).left)).toBeCloseTo(0.125, 4);
    });

    it('posts nothing while a block has nothing to tell', () => {
      const idle = create();
      run(idle, 20);
      expect(idle.posts).not.toHaveBeenCalled();
      const processor = voice('none');
      block(processor, 0);
      expect(reports(processor)).toEqual([{ started: [[1, 0, 0]] }]);
      // (by the flags of the block: neither the voices nor the chain are asked)
      const { voices, chain } = processor.engine as EngineWasm;
      const asked = [jest.spyOn(voices, 'reports'), jest.spyOn(chain, 'reports')];
      run(processor, 20, 128);
      asked.forEach((spy) => expect(spy).not.toHaveBeenCalled());
      expect(processor.posts).toHaveBeenCalledTimes(1);
    });

    it('renders into one channel when the node has one', () => {
      const { alive, left } = block(voice('none'), 0, { channels: [1] });
      expect(alive).toBe(true);
      expect(left[0]).toBeCloseTo(1, 4);
    });

    it('renders blocks of another length', () => {
      const whole = run(voice('none'), 4).left;
      const processor = voice('none');
      const first = block(processor, 0).left;
      const long = block(processor, 128, { frames: 256 }).left;
      const last = block(processor, 384).left;
      expect(first).toEqual(whole.subarray(0, 128));
      expect(long).toEqual(whole.subarray(128, 384));
      expect(last).toEqual(whole.subarray(384));
    });

    it('copies the voices as the chain took them into its second output while a probe listens', () => {
      const events = [on(1, 'none', {}, { gain1: 0.25 })];
      const twin = create({ unlimited: true, events });
      block(twin, 0);
      const state = chainState(['distortion'], 1, { distortion: { params: { drive: 12 } } });
      const processor = create({ unlimited: true, events, state });
      // (no probe yet: its second output is left as it is)
      expect(silent(block(processor, 0, { channels: [2, 2] }).outputs[1][0])).toBe(true);
      tell(processor, { probe: true });
      const probed = block(processor, 128, { channels: [2, 2] }).outputs;
      // (the voices of a node whose chain is a wire)
      const voices = block(twin, 128);
      expect(peak(probed[1][0])).toBeGreaterThan(0.2);
      expect(probed[1][0]).toEqual(voices.left);
      expect(probed[1][1]).toEqual(voices.right);
      expect(probed[0][0]).not.toEqual(probed[1][0]);
      // one channel of it, no second output at all
      expect(block(processor, 256, { channels: [2, 1] }).outputs[1][0][0]).not.toBe(0);
      expect(block(processor, 384).alive).toBe(true);
      tell(processor, { probe: false });
      expect(silent(block(processor, 512, { channels: [2, 2] }).outputs[1][0])).toBe(true);
    });
  });

  describe('the store of its tables', () => {
    it('stores a table posted whole to a node and acknowledges it, the voices of another play it', () => {
      const store = create();
      tell(store, { table: 'posted', version: 1, levels: buildLevels([sine.map((x) => x / 2)]) });
      expect(store.posts).toHaveBeenCalledWith({ stored: 'posted', version: 1 });
      const { left, right, alive } = block(voice('posted'), 0);
      expect(alive).toBe(true);
      expect(left[0]).toBeCloseTo(0.5, 4);
      expect(right[0]).toBeCloseTo(0.5, 4);
    });

    it('asks the worker for chunks once it has its port, takes a version in chunks and acks each', () => {
      const store = create();
      const port = withWorker(store);
      expect(port.postMessage).toHaveBeenCalledWith({ chunks: STORE_CHUNK });
      // chunks of 1000 samples: the version is the latest once its last chunk is in
      const data = sendInChunks(port, 'chunked', 1, [saw], 1000);
      expect(data.length).toBeGreaterThan(10000);
      expect(store.posts).toHaveBeenCalledWith({ stored: 'chunked', version: 1 });
      const chunked = block(voice('chunked'), 0).left;
      tell(create(), { table: 'whole', version: 1, levels: buildLevels([saw]) });
      expect(chunked).toEqual(block(voice('whole'), 0).left);
    });

    it('refuses a version it has no memory for: the latest one plays on', () => {
      const store = create();
      const port = withWorker(store);
      sendInChunks(port, 'big', 1, [sine]);
      const before = block(voice('big'), 0).left;
      // 4 GB of samples: more than the memory of a wasm32 core
      const layout = {
        frames: 1,
        harmonics: [1, 0],
        lengths: [256, 1],
        offsets: [0, 259],
        length: 2 ** 30 - 1,
      };
      port.onmessage?.({ data: { table: 'big', version: 2, begin: layout } });
      const chunk = new ArrayBuffer(16);
      port.onmessage?.({ data: { table: 'big', version: 2, chunk, at: 0, length: 4, last: true } });
      expect(port.postMessage).toHaveBeenLastCalledWith({ ack: chunk }, [chunk]);
      expect(store.posts).toHaveBeenLastCalledWith({ refused: 'big', version: 2 });
      expect(block(voice('big'), 0).left).toEqual(before);
    });

    it('removes a table: new voices play the sine until it comes again', () => {
      const store = create();
      tell(store, { table: 'removed', version: 1, levels: buildLevels([saw]) });
      tell(store, { table: 'removed', version: 2, remove: true });
      const { left } = block(voice('removed'), 0);
      expect(left[0]).toBeCloseTo(1, 4);
      expect(left[64]).toBeCloseTo(Math.cos((2 * Math.PI * 100 * 64) / RATE), 4);
    });

    it('keeps a replaced version while a voice plays it, then frees it and tells its bytes', () => {
      const store = create();
      const port = withWorker(store);
      const before = stats(store);
      const bytes = 4 * sendInChunks(port, 'held', 1, [saw]).length;
      // (the last node made tells what the store freed)
      const processor = voice('held');
      block(processor, 0);
      sendInChunks(port, 'held', 2, [sine]);
      expect(stats(store).versions - before.versions).toBe(2);
      processor.posts.mockClear();
      // the voice crossfades into version 2 within 10 ms, then version 1 goes
      for (let frame = 128; frame < 1280; frame += 128) block(processor, frame);
      expect(reports(processor)).toEqual([{ freedBytes: bytes }]);
      const after = stats(store);
      expect(after.versions - before.versions).toBe(1);
      expect(after.bytes - before.bytes).toBe(bytes);
    });

    it('answers the counters of the store and the voices at the current frame', () => {
      const store = create();
      Object.assign(globalThis, { currentFrame: 640 });
      const before = stats(store);
      expect(before.frame).toBe(640);
      const levels = buildLevels([saw]);
      tell(store, { table: 'counted', version: 1, levels });
      const processor = voice('counted');
      block(processor, 0);
      block(processor, 128);
      const after = stats(store);
      expect(after.tables - before.tables).toBe(1);
      expect(after.bytes - before.bytes).toBe(levels.data.byteLength);
      expect(after.voices - before.voices).toBe(1);
      // (on the flat of its level: its frame alone from the first block)
      expect(after.mixSamples - before.mixSamples).toBe(256);
    });

    it('counts the voices of the node and the events of their timelines', () => {
      const processor = create();
      tell(processor, {
        events: [
          on(1, 'none'),
          { kind: 'set', voice: 1, param: 'gain1', value: 0.5, time: 1 },
          { kind: 'ramp', voice: 1, param: 'frequency', value: 200, time: 1 },
        ],
      });
      expect(stats(processor)).toMatchObject({ scopeVoices: 1, events: 2 });
      // (those of another node are not its own)
      expect(stats(create())).toMatchObject({ scopeVoices: 0, events: 0 });
    });

    it('takes the tables and answers the counters whatever became of the engine of its node', () => {
      const stopped = create();
      tell(stopped, { stop: true });
      tell(stopped, { table: 'outlived', version: 1, levels: buildLevels([sine.map((x) => x / 2)]) });
      expect(stopped.posts).toHaveBeenCalledWith({ stored: 'outlived', version: 1 });
      expect(stats(stopped)).toMatchObject({ scopeVoices: 0, events: 0 });
      expect(block(voice('outlived'), 0).left[0]).toBeCloseTo(0.5, 4);
      const port = withWorker(stopped);
      sendInChunks(port, 'outlived', 2, [sine.map((x) => x / 4)]);
      expect(stopped.posts).toHaveBeenLastCalledWith({ stored: 'outlived', version: 2 });
      expect(block(voice('outlived'), 0).left[0]).toBeCloseTo(0.25, 4);
    });
  });

  describe('the voices', () => {
    it('plays the voices of the events posted to it, their sum into its output', () => {
      tell(create(), { table: 'node', version: 1, levels: buildLevels([sine.map((x) => x / 4)]) });
      const node = create({ unlimited: true });
      tell(node, { events: [on(1, 'node'), on(2, 'node')] });
      const { alive, left, right } = block(node, 0);
      expect(alive).toBe(true);
      // two voices of a quarter at phase 0.25
      expect(left[0]).toBeCloseTo(0.5, 4);
      expect(right[0]).toBeCloseTo(0.5, 4);
      expect(reports(node)).toEqual([
        {
          started: [
            [1, 0, 0],
            [2, 0, 0],
          ],
        },
      ]);
    });

    it('starts at its start frame and ends where its gate drops, then tells the main thread', () => {
      const gate: VoiceEvent = { kind: 'set', voice: 1, param: 'gate', value: 0, time: 266 / RATE };
      const processor = voice('none', { start: 200 / RATE }, {}, [gate]);
      expect(silent(block(processor, 0).left)).toBe(true);
      expect(block(processor, 128).left[72]).toBeCloseTo(1, 4);
      const { alive, left } = block(processor, 256);
      // the node plays on, its voice ended
      expect(alive).toBe(true);
      expect(silent(left.subarray(10))).toBe(true);
      expect(reports(processor)).toEqual([{ started: [[1, 200, 200]] }, { ended: [1] }]);
    });

    it('tells a start later than scheduled once: the fx and Poly follow it', () => {
      const processor = voice('none', { start: 100 / RATE });
      block(processor, 1280);
      block(processor, 1408);
      expect(reports(processor)).toEqual([{ started: [[1, 1280, 100]] }]);
    });

    it('tells a start on time once for every voice: a note may take it over (its envelopes start again)', () => {
      const mono = voice('none', { start: 200 / RATE, mono: true });
      const poly = voice('none', { start: 200 / RATE });
      for (const processor of [mono, poly]) {
        block(processor, 128);
        block(processor, 256);
      }
      expect(reports(mono)).toEqual([{ started: [[1, 200, 200]] }]);
      expect(reports(poly)).toEqual([{ started: [[1, 200, 200]] }]);
    });

    it('tells the starts (on time, later than scheduled) and the ends of a block in one message', () => {
      const node = create();
      block(node, 0);
      tell(node, {
        events: [
          on(1, 'none', { start: 100 / RATE }),
          on(2, 'none', { start: 1300 / RATE, mono: true }),
          on(3, 'none', { start: 1300 / RATE }),
          { kind: 'set', voice: 3, param: 'gate', value: 0, time: 1350 / RATE },
        ],
      });
      block(node, 1280);
      expect(reports(node)).toEqual([
        {
          started: [
            [1, 1280, 100],
            [2, 1300, 1300],
            [3, 1300, 1300],
          ],
          ended: [3],
        },
      ]);
    });

    it('takes the events of its options before its first block, a tap renders each voice into its channels', () => {
      const node = create({
        tap: true,
        events: [
          on(1, 'none'),
          on(2, 'none', { start: 64 / RATE, envStart: 64 / RATE }),
          { kind: 'set', voice: 1, param: 'gate', value: 0, time: 32 / RATE },
        ],
      });
      const channels = block(node, 0, { channels: [4] }).outputs[0];
      expect(channels[0][0]).toBeCloseTo(1, 4);
      expect(silent(channels[0].subarray(32))).toBe(true);
      expect(channels[2][63]).toBe(0);
      expect(channels[2][64]).toBeCloseTo(1, 4);
      // voice 1 ended where its gate dropped
      expect(reports(node)).toEqual([
        {
          started: [
            [1, 0, 0],
            [2, 64, 64],
          ],
          ended: [1],
        },
      ]);
      const next = block(node, 128, { channels: [4] }).outputs[0];
      expect(silent(next[0])).toBe(true);
      expect(next[2][0]).not.toBe(0);
    });

    it('taps the voices as they are before the chain: its effects, its gains and its limiter are not on them', () => {
      const events = [on(1, 'none'), on(2, 'none', {}, { frequency: 150 })];
      const alone = (event: VoiceEvent) => run(create({ unlimited: true, events: [event] }), 10);
      const state = chainState(['distortion'], 1, {}, { masterGain: 0.25 });
      const node = create({ tap: true, events, state });
      const taps = [0, 1, 2, 3].map(() => new Float32Array(10 * 128));
      for (let index = 0; index < 10; index++)
        block(node, index * 128, { channels: [4] }).outputs[0].forEach((channel, at) =>
          taps[at].set(channel, index * 128)
        );
      expect(peak(taps[0])).toBeCloseTo(1, 3);
      expect(taps[0]).toEqual(alone(events[0]).left);
      expect(taps[1]).toEqual(alone(events[0]).right);
      expect(taps[2]).toEqual(alone(events[1]).left);
      expect(taps[3]).toEqual(alone(events[1]).right);
    });

    it('takes the routes of a playing note from its port: the amounts glide', () => {
      const processor = voice('none');
      expect(block(processor, 0).left[0]).toBeCloseTo(1, 4);
      const routes: VoiceRoute[] = [{ source: 1, param: 'gain1', amount: -1, min: 0, max: 1 }];
      tell(processor, { events: [{ kind: 'routes', voices: [1], routes }] });
      [128, 256, 384, 512].forEach((frame) => block(processor, frame));
      expect(block(processor, 640).left.every((value) => Math.abs(value) < 1e-6)).toBe(true);
    });

    it('takes the filter of a playing note from its port', () => {
      const open = block(voice('none', {}, { frequency: 4000 }), 0).left;
      const processor = voice('none', {}, { frequency: 4000 });
      block(processor, 0);
      tell(processor, {
        events: [
          { kind: 'filter', voices: [1], filter: { type: 'lowpass', cutoff: 200, resonance: 0, gain: 0 } },
        ],
      });
      expect(peak(block(processor, 128).left)).toBeLessThan(peak(open) / 10);
    });

    it('ends a voice whose note on traps: it tells the main thread, its version goes back', () => {
      const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const store = create();
      tell(store, { table: 'thrown', version: 1, levels: buildLevels([saw]) });
      const held = stats(store).versions;
      const processor = voice('thrown', { routes: tooManyRoutes() });
      const { left, right } = block(processor, 0);
      expect(silent(left)).toBe(true);
      expect(silent(right)).toBe(true);
      expect(reports(processor)).toEqual([{ ended: [1] }]);
      tell(store, { table: 'thrown', version: 2, levels: buildLevels([sine]) });
      // version 1 is free: no voice holds it
      expect(stats(store).versions).toBe(held);
      expect(error).toHaveBeenCalledWith('A voice or a stage of the engine failed', expect.any(Error));
      error.mockRestore();
    });

    it('keeps playing when a message breaks the core: the error is told', () => {
      const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const node = create({ unlimited: true });
      tell(node, { events: [on(1, 'none')] });
      tell(node, { events: [{ kind: 'routes', voices: [1], routes: tooManyRoutes() }] });
      expect(error).toHaveBeenCalledWith('A voice or a stage of the engine failed', expect.any(Error));
      expect(block(node, 0).left[0]).toBeCloseTo(1, 4);
      error.mockRestore();
    });

    it('ends a voice that traps in its block and tells it, the others play on through the chain', () => {
      const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const state = () => chainState([], 1, {}, { masterGain: 0.5 });
      const second = on(2, 'none', {}, { frequency: 150 });
      // (the trap of the specs is past the render of a voice, where it finishes its block: its filter, its volume)
      const first = on(1, 'none', { filter: { type: 'lowpass', cutoff: 4000, resonance: 0, gain: 0 } });
      const processor = create({ unlimited: true, state: state(), events: [first, second] });
      const alone = run(create({ unlimited: true, state: state(), events: [second] }), 20).left;
      const both = run(processor, 10).left;
      expect(both).not.toEqual(alone.subarray(0, 10 * 128));
      processor.posts.mockClear();
      processor.engine?.voices.trap(1);
      // (from the block of the trap on: the voice that trapped is not in its sum)
      const rest = run(processor, 10, 10 * 128).left;
      expect(peak(rest)).toBeGreaterThan(0.4);
      expect(rest).toEqual(alone.subarray(10 * 128));
      expect(reports(processor)).toEqual([{ ended: [1] }]);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith('A voice or a stage of the engine failed', expect.anything());
      expect(stats(processor)).toMatchObject({ scopeVoices: 1 });
      error.mockRestore();
    });

    it('stops: its voices end and give their versions back, it renders no more', () => {
      const store = create();
      tell(store, { table: 'stopped', version: 1, levels: buildLevels([saw]) });
      const node = create();
      tell(node, { events: [on(1, 'stopped')] });
      block(node, 0);
      tell(store, { table: 'stopped', version: 2, levels: buildLevels([sine]) });
      const held = stats(node);
      expect(held).toMatchObject({ scopeVoices: 1 });
      tell(node, { stop: true });
      expect(stats(node)).toMatchObject({ versions: held.versions - 1, scopeVoices: 0, events: 0 });
      expect(block(node, 128).alive).toBe(false);
      expect(node.engine).toBeNull();
      // a message after the stop reaches nothing
      tell(node, { events: [on(2, 'stopped')] });
      tell(node, { masterGain: 2 });
      expect(stats(node)).toMatchObject({ scopeVoices: 0 });
    });
  });

  describe('the LFOs', () => {
    it('gives those of its options to the voices and to the chain at once', () => {
      const node = create({
        unlimited: true,
        lfos: flatLfos(1),
        events: [on(1, 'none', { routes: LFO_ON_GAIN })],
      });
      expect(silent(block(node, 0).left)).toBe(true);
      tell(node, { stop: true });
      const input = noise(60 * 128, 0.2);
      const state = () => chainState(['distortion'], 1, {}, { routes: LFO_ON_LEVEL });
      const own = run(fed(state()), 60, 0, input).left;
      const given = run(create({ fed: true, state: state(), lfos: fastLfos() }), 60, 0, input).left;
      expect(sweep(given)).toBeGreaterThan(2);
      expect(given).not.toEqual(own);
      // those of the state of its chain, when its options have none: the voices have them too
      expect(run(fed({ ...state(), lfos: fastLfos() }), 60, 0, input).left).toEqual(given);
      const voices = create({
        unlimited: true,
        state: { ...state(), lfos: flatLfos(1) },
        events: [on(1, 'none', { routes: LFO_ON_GAIN })],
      });
      expect(silent(block(voices, 0).left)).toBe(true);
    });

    it('takes those of a message: a route of LFO 1 on the gain follows them', () => {
      const node = create({
        unlimited: true,
        lfos: flatLfos(1),
        events: [on(1, 'none', { routes: LFO_ON_GAIN })],
      });
      expect(silent(block(node, 0).left)).toBe(true);
      tell(node, { lfos: flatLfos(0) });
      // the gain 1 from the state of the port on (past the glide of the shape)
      block(node, 128);
      block(node, 256);
      block(node, 384);
      expect(peak(block(node, 512).left)).toBeGreaterThan(0.5);
    });

    it('a state for one half is not taken by the other', () => {
      const state = () => chainState(['distortion'], 1, {}, { routes: LFO_ON_LEVEL });
      const events = [on(1, 'none', { routes: LFO_ON_GAIN }, { gain1: 0.5 })];
      const square: LfosState = {
        at: 0,
        instantly: true,
        lfos: flatLfos(0).lfos.map((lfo) => ({
          ...lfo,
          anchor: { time: 0, phase: 0, period: 0.05 },
          table: lfoTable('square'),
        })),
      };
      // (one node at a time: the LFOs of the voices are those of the scope)
      const play = (readers?: LfoReader[]) => {
        const node = create({ unlimited: true, state: state(), lfos: flatLfos(1), events });
        expect(silent(run(node, 4).left)).toBe(true);
        tell(node, { lfos: square, ...(readers && { readers }) });
        const { left } = run(node, 60, 4 * 128);
        tell(node, { stop: true });
        return left;
      };
      const both = play();
      expect(play(['voices', 'chain'])).toEqual(both);
      // the chain alone: the voice stays where LFO 1 at 1 has its gain
      expect(silent(play(['chain']))).toBe(true);
      // the voices alone: they sound, the level of the distortion where it was
      const voices = play(['voices']);
      expect(peak(voices)).toBeGreaterThan(0.1);
      expect(voices).not.toEqual(both);
    });

    it('loses only a state it can not read: the events that came with it are applied', () => {
      const logged = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const node = create({ unlimited: true });
      tell(node, {
        lfos: { at: 0, lfos: [{ table: {} } as unknown as LfosState['lfos'][number]] },
        events: [on(1, 'none')],
      });
      expect(logged).toHaveBeenCalledWith(expect.any(String), expect.any(TypeError));
      logged.mockRestore();
      expect(peak(block(node, 0).left)).toBeGreaterThan(0.1);
    });

    it('takes one message of them for the voices and for the chain', () => {
      const state = chainState(['distortion'], 1, {}, { routes: LFO_ON_LEVEL });
      const events = [on(1, 'none', { routes: LFO_ON_GAIN }, { gain1: 0.5 })];
      const node = create({ unlimited: true, state, lfos: flatLfos(1), events });
      expect(silent(run(node, 4).left)).toBe(true);
      // LFO 1 a square: the voice sounds while it is low, the level of the distortion follows it
      const square: LfosState = {
        at: 0,
        instantly: true,
        lfos: flatLfos(0).lfos.map((lfo) => ({
          ...lfo,
          anchor: { time: 0, phase: 0, period: 0.05 },
          table: lfoTable('square'),
        })),
      };
      tell(node, { lfos: square });
      const moved = run(node, 60, 4 * 128).left;
      expect(peak(moved)).toBeGreaterThan(0.1);
      // the same voices, the knob of the chain where it is
      const plain = create({
        unlimited: true,
        state: chainState(['distortion']),
        lfos: flatLfos(1),
        events,
      });
      run(plain, 4);
      tell(plain, { lfos: square });
      const unmoved = run(plain, 60, 4 * 128).left;
      expect(peak(unmoved)).toBeGreaterThan(0.1);
      expect(moved).not.toEqual(unmoved);
    });

    describe('a state that comes as a message', () => {
      it('is taken from the next block when it comes after its time: its Phase still glides', () => {
        const state = (phase: number, at: number, instantly = false): LfosState => ({
          at,
          instantly,
          lfos: [0, 1, 2, 3].map(() => ({
            mode: RETRIG,
            delay: 0,
            rise: 0,
            smooth: 0,
            phase,
            anchor: { time: 0, phase: 0, period: 0.5 },
            ...(instantly && { table: lfoTable('sine') }),
          })),
        });
        // (one node at a time: the LFOs are those of the scope, its options set them)
        const play = (next: LfosState) => {
          const node = create({
            unlimited: true,
            lfos: state(0, 0, true),
            events: [on(1, 'none', { routes: LFO_ON_GAIN })],
          });
          for (let frame = 0; frame < 512; frame += 128) block(node, frame);
          tell(node, { lfos: next });
          const played = [512, 640, 768, 896, 1024, 1152].map((frame) => block(node, frame).left);
          tell(node, { stop: true });
          return played;
        };
        // a state of a time long gone as one of the frame of the next block, not one there at once
        const late = play(state(0.5, 0));
        expect(late).toEqual(play(state(0.5, 512 / RATE)));
        expect(late[0]).not.toEqual(play(state(0.5, 0, true))[0]);
      });
    });
  });

  describe('the seed of its options', () => {
    // a note of random phases and a random start of nothing else: what it draws is all that differs
    const play = (seed?: number) => {
      const node = create({
        unlimited: true,
        ...(seed !== undefined && { seed }),
        events: [
          on(
            1,
            'none',
            { osc: [{ table: 'none', unison: 4, phase: 0, phaseRand: 1 }, null] },
            { spread1: 20 }
          ),
        ],
      });
      const { left } = run(node, 4);
      tell(node, { stop: true });
      return left;
    };

    it('draws the phases of a note alike in every node made with it, another seed others', () => {
      const first = play(5);
      expect(peak(first)).toBeGreaterThan(0.01);
      expect(play(5)).toEqual(first);
      expect(play(6)).not.toEqual(first);
      // (0 is a seed too)
      expect(play(0)).toEqual(play(0));
    });

    it('none: Math.random draws them', () => {
      const random = jest.spyOn(Math, 'random');
      play(5);
      expect(random).not.toHaveBeenCalled();
      play();
      expect(random).toHaveBeenCalled();
      random.mockRestore();
    });
  });

  describe('the chain alone on the input of its node', () => {
    it('is a wire with its limiter when made without a state', () => {
      const input = noise(20 * 128, 0.2);
      const processor = fed();
      const { left } = run(processor, 20, 0, input);
      const latency = processor.engine?.latency ?? 0;
      expect(latency).toBeGreaterThan(0);
      // (under the ceiling the limiter is its input, late by its lookahead)
      expect(Array.from(left.subarray(latency))).toEqual(
        Array.from(input[0].subarray(0, left.length - latency))
      );
    });

    it('plays no voice: the events of its options and of its port sound nowhere', () => {
      const processor = create({ fed: true, events: [on(1, 'none')] });
      tell(processor, { events: [on(2, 'none')] });
      expect(peak(run(processor, 20).left)).toBe(0);
      const input = noise(20 * 128, 0.2);
      const { left } = run(processor, 20, 20 * 128, input);
      expect(left).toEqual(run(fed(), 20, 20 * 128, input).left);
      expect(processor.posts).not.toHaveBeenCalled();
    });

    it('starts with the state of its node: the slots, their order, the gains', () => {
      const input = noise(40 * 128, 0.2);
      const wire = run(fed(), 40, 0, input).left;
      const state = chainState(['distortion'], 1, { distortion: { params: { drive: 12 } } });
      const driven = run(fed(state), 40, 0, input).left;
      expect(driven).not.toEqual(wire);
      expect(peak(driven)).toBeGreaterThan(0.01);
      const quiet = run(fed(chainState([], 1, {}, { masterGain: 0.5 })), 40, 0, input).left;
      expect(peak(quiet)).toBeCloseTo(0.5 * peak(wire), 5);
      expect(peak(run(fed(chainState([], 1, {}, { muted: true })), 40, 0, input).left)).toBe(0);
    });

    it('takes a mono input into both channels, no input as silence', () => {
      const input = noise(20 * 128, 0.2);
      const { left, right } = run(fed(), 20, 0, [input[0]]);
      expect(peak(left)).toBeGreaterThan(0.01);
      expect(right).toEqual(left);
      expect(peak(run(fed(), 20).left)).toBe(0);
    });

    it('applies the messages of the main thread: the knobs, the mix, the state, the order, the gains', () => {
      const input = noise(60 * 128, 0.2);
      const half = input.map((channel) => channel.subarray(30 * 128));
      const wire = run(fed(), 60, 0, input).left;
      const told = (messages: ChainMessage[]) => {
        const processor = fed();
        run(processor, 30, 0, input);
        messages.forEach((data) => tell(processor, data));
        return run(processor, 30, 30 * 128, half).left;
      };
      const tail = wire.subarray(30 * 128);
      const slot = slotOf('distortion');
      const active: ChainMessage[] = [{ order: [slot] }, { mix: [slot, 1] }, { active: [slot, true] }];
      const distorted = told(active);
      expect(distorted).not.toEqual(tail);
      expect(told([...active, { params: [slot, { drive: 12 }] }])).not.toEqual(distorted);
      expect(told([...active, { mix: [slot, 0.5] }])).not.toEqual(distorted);
      // (not in the order: a wire)
      expect(told([{ mix: [slot, 1] }, { active: [slot, true] }])).toEqual(tail);
      // (after the lookahead of the limiter: what it holds was at the gain before)
      expect(peak(told([{ masterGain: 0.5 }]).subarray(128))).toBeCloseTo(0.5 * peak(tail.subarray(128)), 2);
      expect(peak(told([{ mute: 0 }]).subarray(128))).toBe(0);
      expect(peak(told([{ mute: 0 }, { unmute: true }]))).toBeGreaterThan(0.01);
    });

    it('takes an event at its time, in seconds of the context', () => {
      const frames = 40 * 128;
      const input = [new Float32Array(frames).fill(0.25), new Float32Array(frames).fill(0.25)];
      const processor = fed();
      tell(processor, { at: (20 * 128) / RATE, masterGain: 0.5 });
      const { left } = run(processor, 40, 0, input);
      const latency = processor.engine?.latency ?? 0;
      expect(left[20 * 128 + latency - 1]).toBe(0.25);
      expect(left[20 * 128 + latency]).toBe(0.125);
    });

    it('takes what came after a mute with a time after it, with no block between them', () => {
      const input = noise(20 * 128, 0.2);
      const processor = fed();
      run(processor, 20, 0, input);
      // (a preset switch while the time of the context stands still: its mute, then its clear and its unmute)
      const messages: ChainMessage[] = [
        { mute: 0.02, at: (20 * 128) / RATE },
        { clear: true },
        { unmute: true },
      ];
      messages.forEach((data) => tell(processor, data));
      const { left } = run(processor, 20, 20 * 128, input);
      expect(peak(left.subarray(10 * 128))).toBeGreaterThan(0.01);
    });

    it('forgets the tails of the effects and the sound in the limiter on a clear', () => {
      const frames = 80 * 128;
      const input = noise(frames, 0.3);
      input.forEach((channel) => channel.fill(0, 10 * 128));
      const state = () => chainState(['delay'], 0.5, { delay: { params: { time: 0.03, fb: 0.8 } } });
      expect(peak(run(fed(state()), 80, 0, input).left.subarray(40 * 128))).toBeGreaterThan(1e-3);
      const processor = fed(state());
      run(processor, 20, 0, input);
      tell(processor, { clear: true });
      const rest = input.map((channel) => channel.subarray(20 * 128));
      expect(peak(run(processor, 60, 20 * 128, rest).left)).toBe(0);
    });

    it('moves the knobs by the routes of the last note, the note taken at its start', () => {
      const input = noise(60 * 128, 0.2);
      const state = chainState(['distortion']);
      const plain = run(fed(state), 60, 0, input).left;
      const held = { attack: 0, hold: 0, decay: 0, sustain: 1, release: 0 };
      const processor = fed(state);
      tell(processor, {
        routes: [{ target: LEVEL, source: 0, amount: -24, min: -24, max: 12 }],
        note: { envelopes: [held, held, held], start: (30 * 128) / RATE, release: null },
      });
      const moved = run(processor, 60, 0, input).left;
      expect(moved.subarray(0, 30 * 128)).toEqual(plain.subarray(0, 30 * 128));
      expect(peak(moved.subarray(50 * 128))).toBeLessThan(0.1 * peak(plain.subarray(50 * 128)));
      // an LFO of the state, a state that comes late for its time takes over now
      const swept = fed(state);
      tell(swept, { lfos: fastLfos(), routes: LFO_ON_LEVEL, note: null });
      expect(sweep(run(swept, 60, 0, input).left)).toBeGreaterThan(2);
    });

    it('posts the meter of an effect about 30 times a second, only while it is watched', () => {
      const second = Math.round(RATE / 128);
      const input = noise(second * 128, 0.5);
      const processor = fed(chainState(['compressor', 'chorus']));
      run(processor, second, 0, input);
      expect(processor.posts).not.toHaveBeenCalled();
      const compressor = slotOf('compressor');
      tell(processor, { meter: [compressor, true] });
      run(processor, second, second * 128, input);
      const { calls } = processor.posts.mock;
      expect(calls.length).toBeGreaterThanOrEqual(28);
      expect(calls.length).toBeLessThanOrEqual(31);
      const [kind, values] = calls[0][0].meter as [number, { gains: number[]; input: number }];
      expect(kind).toBe(compressor);
      expect(values.gains).toHaveLength(3);
      expect(values.input).toBeGreaterThan(0.1);
      processor.posts.mockClear();
      // the chorus too: its LFO and its knobs, whether it has anything to play
      tell(processor, { meter: [compressor, false] });
      tell(processor, { meter: [slotOf('chorus'), true] });
      run(processor, second, 2 * second * 128, input);
      const chorus = processor.posts.mock.calls[5][0].meter as [number, Record<string, unknown>];
      expect(chorus[0]).toBe(slotOf('chorus'));
      expect(Object.keys(chorus[1])).toEqual(['phase', 'rate', 'd1', 'd2', 'depth', 'cut', 'idle']);
      expect(chorus[1]['idle']).toBe(false);
      // a node made while a screen watches starts with its meter on; at rest it is posted once
      const watched = fed(chainState(['compressor'], 1, {}, { meters: [compressor] }));
      run(watched, second);
      expect(watched.posts).toHaveBeenCalledTimes(1);
    });

    it('plays on without an effect that trapped and tells which, the effect made again on a retry', () => {
      const input = noise(90 * 128, 0.2);
      const processor = fed(chainState(['chorus', 'distortion']));
      run(processor, 20, 0, input);
      processor.engine?.chain.trap(slotOf('chorus'));
      const part = (from: number) => input.map((channel) => channel.subarray(from * 128));
      const failed = run(processor, 20, 20 * 128, part(20)).left;
      expect(processor.posts.mock.calls).toEqual([[{ failed: [slotOf('chorus')] }]]);
      // the distortion alone from there on
      expect(peak(failed)).toBeGreaterThan(0.01);
      const alone = run(fed(chainState(['distortion'])), 40, 0, input).left.subarray(20 * 128);
      const difference = failed.subarray(10 * 128).map((value, i) => value - alone[10 * 128 + i]);
      expect(peak(difference)).toBeLessThan(1e-3);
      processor.engine?.chain.trap(-1);
      tell(processor, { retry: slotOf('chorus') });
      const again = run(processor, 50, 40 * 128, part(40)).left;
      const reference = run(fed(chainState(['distortion'])), 90, 0, input).left.subarray(40 * 128);
      expect(
        peak(again.subarray(30 * 128).map((value, i) => value - reference[30 * 128 + i]))
      ).toBeGreaterThan(0.01);
      // (the retry told it was made)
      expect(processor.posts.mock.calls).toEqual([
        [{ failed: [slotOf('chorus')] }],
        [{ remade: slotOf('chorus') }],
      ]);
    });

    it('tells a retry that could not make its effect: failed again, made by the next one', () => {
      const input = noise(40 * 128, 0.2);
      const chorus = slotOf('chorus');
      const processor = fed(chainState(['chorus']));
      run(processor, 10, 0, input);
      processor.engine?.chain.trap(chorus);
      run(processor, 10, 10 * 128, input);
      processor.engine?.chain.trap(chorus, TRAP_IN.make);
      tell(processor, { retry: chorus });
      processor.engine?.chain.trap(-1);
      tell(processor, { retry: chorus });
      expect(processor.posts.mock.calls).toEqual([
        [{ failed: [chorus] }],
        [{ failed: [chorus] }],
        [{ remade: chorus }],
      ]);
    });

    it('drops an effect that traps as a message sets its knob: the others play, the knobs after it are taken', () => {
      const input = noise(40 * 128, 0.2);
      const [chorus, distortion] = [slotOf('chorus'), slotOf('distortion')];
      const processor = fed(chainState(['chorus', 'distortion']));
      run(processor, 10, 0, input);
      processor.engine?.chain.trap(chorus, TRAP_IN.set);
      tell(processor, { params: [chorus, { rate: 2 }] });
      tell(processor, { params: [distortion, { level: -12 }] });
      const part = input.map((channel) => channel.subarray(10 * 128));
      const out = run(processor, 30, 10 * 128, part).left;
      expect(processor.posts.mock.calls).toEqual([[{ failed: [chorus] }]]);
      expect(processor.engine).not.toBeNull();
      // the distortion alone, at its new level
      const alone = fed(chainState(['distortion']));
      run(alone, 10, 0, input);
      tell(alone, { params: [distortion, { level: -12 }] });
      const reference = run(alone, 30, 10 * 128, part).left;
      const difference = out.subarray(15 * 128).map((value, i) => value - reference[15 * 128 + i]);
      expect(peak(reference.subarray(15 * 128))).toBeGreaterThan(0.01);
      expect(peak(difference)).toBeLessThan(1e-3);
    });

    it('is silent once its limiter trapped and tells it, the sound back on a retry', () => {
      const input = noise(60 * 128, 0.2);
      const processor = fed(chainState(['distortion']));
      expect(peak(run(processor, 20, 0, input).left)).toBeGreaterThan(0.01);
      processor.engine?.chain.trap(LIMITER_STAGE);
      const part = (from: number) => input.map((channel) => channel.subarray(from * 128));
      expect(peak(run(processor, 20, 20 * 128, part(20)).left)).toBe(0);
      expect(processor.posts.mock.calls).toEqual([[{ failed: [LIMITER_STAGE] }]]);
      processor.engine?.chain.trap(-1);
      tell(processor, { retry: LIMITER_STAGE });
      expect(peak(run(processor, 20, 40 * 128, part(40)).left)).toBeGreaterThan(0.01);
      expect(FX_KINDS).toHaveLength(LIMITER_STAGE);
    });

    it('a trap that is in no stage: silence, the main thread is told the core is over, the node ends', () => {
      const input = noise(20 * 128, 0.2);
      const processor = fed(chainState(['distortion']));
      run(processor, 10, 0, input);
      processor.engine?.chain.trap(LIMITER_STAGE + 1);
      const out = [[new Float32Array(128).fill(1), new Float32Array(128).fill(1)]];
      expect(processor.process([input.map((channel) => channel.subarray(0, 128))], out)).toBe(false);
      expect(peak(out[0][0])).toBe(0);
      expect(peak(out[0][1])).toBe(0);
      expect(processor.posts.mock.calls).toEqual([[{ broken: true }]]);
      expect(processor.engine).toBeNull();
      // (told once: no block after it, a message is ignored)
      expect(processor.process([[]], out)).toBe(false);
      tell(processor, { masterGain: 2 });
      expect(processor.posts).toHaveBeenCalledTimes(1);
    });

    it('posts no meter of an effect that trapped, its meter again once it is made again', () => {
      const second = Math.round(RATE / 128);
      const input = noise(second * 128, 0.5);
      const chorus = slotOf('chorus');
      const processor = fed(chainState(['chorus'], 1, {}, { meters: [chorus] }));
      run(processor, 20, 0, input);
      processor.engine?.chain.trap(chorus);
      processor.posts.mockClear();
      run(processor, second, 20 * 128, input);
      expect(processor.posts.mock.calls).toEqual([[{ failed: [chorus] }]]);
      processor.engine?.chain.trap(-1);
      tell(processor, { retry: chorus });
      processor.posts.mockClear();
      run(processor, second, (20 + second) * 128, input);
      const { calls } = processor.posts.mock;
      expect(calls.length).toBeGreaterThanOrEqual(28);
      const [slot, values] = calls[0][0].meter as [number, Record<string, unknown>];
      expect(slot).toBe(chorus);
      expect(typeof values['phase']).toBe('number');
      expect(typeof values['d1']).toBe('number');
    });

    it('ends when it is stopped: its core freed, no block rendered', () => {
      const processor = fed();
      tell(processor, { stop: true });
      expect(block(processor, 0).alive).toBe(false);
      // (a message after it is ignored)
      tell(processor, { masterGain: 2 });
      expect(processor.engine).toBeNull();
    });
  });

  describe('a trap of the chain under the voices', () => {
    const events = () => [
      on(1, 'none', {}, { gain1: 0.25 }),
      on(2, 'none', {}, { gain1: 0.25, frequency: 150 }),
    ];

    it('drops the effect that trapped and tells which: the voices and the other effects play on', () => {
      const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const chorus = slotOf('chorus');
      const processor = create({ state: chainState(['chorus', 'distortion']), events: events() });
      run(processor, 20);
      processor.posts.mockClear();
      processor.engine?.chain.trap(chorus);
      const failed = run(processor, 60, 20 * 128).left;
      expect(reports(processor)).toEqual([{ failed: [chorus] }]);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith('A voice or a stage of the engine failed', expect.anything());
      expect(stats(processor)).toMatchObject({ scopeVoices: 2 });
      // the voices through the distortion alone from there on (once what the chorus left in it has died away)
      const alone = run(create({ state: chainState(['distortion']), events: events() }), 80).left;
      expect(peak(failed.subarray(40 * 128))).toBeGreaterThan(0.1);
      const difference = failed.subarray(40 * 128).map((value, i) => value - alone[60 * 128 + i]);
      expect(peak(difference)).toBeLessThan(1e-3);
      // the effect made again on a retry
      processor.engine?.chain.trap(-1);
      processor.posts.mockClear();
      tell(processor, { retry: chorus });
      expect(reports(processor)).toEqual([{ remade: chorus }]);
      const again = run(processor, 40, 80 * 128).left;
      const reference = run(create({ state: chainState(['distortion']), events: events() }), 120).left;
      expect(
        peak(again.subarray(20 * 128).map((value, i) => value - reference[100 * 128 + i]))
      ).toBeGreaterThan(0.01);
      error.mockRestore();
    });

    it('in no stage: silence, the main thread is told the core is over, the node ends; its store lives on', () => {
      const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const processor = create({ state: chainState(['distortion']), events: events() });
      expect(peak(run(processor, 10).left)).toBeGreaterThan(0.1);
      processor.posts.mockClear();
      processor.engine?.chain.trap(LIMITER_STAGE + 1);
      Object.assign(globalThis, { currentFrame: 10 * 128 });
      const out = [
        [new Float32Array(128).fill(1), new Float32Array(128).fill(1)],
        [new Float32Array(128), new Float32Array(128)],
      ];
      expect(processor.process([[]], out)).toBe(false);
      expect(peak(out[0][0])).toBe(0);
      expect(peak(out[0][1])).toBe(0);
      expect(reports(processor)).toEqual([{ broken: true }]);
      expect(processor.engine).toBeNull();
      // (told once: no block after it, a message is ignored)
      expect(processor.process([[]], out)).toBe(false);
      tell(processor, { masterGain: 2 });
      tell(processor, { events: [on(3, 'none')] });
      tell(processor, { probe: true });
      expect(processor.posts).toHaveBeenCalledTimes(1);
      tell(processor, { table: 'after', version: 1, levels: buildLevels([sine.map((x) => x / 2)]) });
      expect(processor.posts).toHaveBeenLastCalledWith({ stored: 'after', version: 1 });
      expect(stats(processor)).toMatchObject({ scopeVoices: 0, events: 0 });
      // the node the main thread makes of its state plays
      expect(block(voice('after'), 0).left[0]).toBeCloseTo(0.5, 4);
      error.mockRestore();
    });
  });
});

describe('an engine worklet whose prewarm fails', () => {
  // the stores the module makes, in order: its own, then the prewarm's (their takeKernels spied)
  const stores: { takeKernels: jest.Mock; handle: number }[] = [];
  let logged: unknown[][] = [];
  let taken: unknown[][] = [];

  beforeAll(async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    // (the module once more, with a core of its own: its processor takes the place of the one above)
    await jest.isolateModulesAsync(async () => {
      // the scope of voices of the prewarm fails (after its samples: the kernels of the noise are built); those
      // of the nodes are made
      jest.doMock('../wavetable/wavetable-osc-wasm', () => {
        const actual = jest.requireActual('../wavetable/wavetable-osc-wasm');
        return {
          ...actual,
          createTableStoreWasm: (...args: unknown[]) => {
            const store = actual.createTableStoreWasm(...args);
            jest.spyOn(store, 'takeKernels');
            stores.push(store);
            return store;
          },
          createVoiceScopeWasm: jest.fn(actual.createVoiceScopeWasm).mockImplementationOnce(() => {
            throw new Error('a trap of the prewarm');
          }),
        };
      });
      await import('./engine.worklet');
    });
    logged = [...error.mock.calls];
    taken = [...stores[0].takeKernels.mock.calls];
    error.mockRestore();
  });

  it('logs it, gives the kernels the prewarm built to the store of the scope and registers the processor', () => {
    expect(logged).toEqual([['The prewarm of the engine failed', expect.any(Error)]]);
    expect(stores).toHaveLength(2);
    expect(taken).toEqual([[stores[1]]]);
    expect(processors[ENGINE_PROCESSOR]).toBeDefined();
  });

  it('plays all the same', () => {
    const store = create();
    tell(store, { table: 'posted', version: 1, levels: buildLevels([sine.map((x) => x / 2)]) });
    expect(store.posts).toHaveBeenCalledWith({ stored: 'posted', version: 1 });
    const { alive, left, right } = block(voice('posted'), 0);
    expect(alive).toBe(true);
    expect(left[0]).toBeCloseTo(0.5, 4);
    expect(right[0]).toBeCloseTo(0.5, 4);
  });
});
