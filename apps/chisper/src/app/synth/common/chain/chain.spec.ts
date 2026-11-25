import {
  chainNode,
  chainNodes,
  chainPosts,
  chainReports,
  flushChain as flush,
} from '../../../../test-utils/chain-node';
import { recordAnalytics } from '../../../../test-utils/analytics';
import { withoutAudioWorklet } from '../../../../test-utils/no-audio-worklet';
import { workletLoads } from '../../../../test-utils/worklet-loads';
import type { FxStatus } from '../../fx/effects/types';
import { createEngineNode } from '../engine/engine-node';
import { ENGINE_PROCESSOR, PROBED_NODE_OPTIONS } from '../engine/engine-params';
import type { LfosState } from '../lfo/lfo-curve';
import { createChain } from './chain';
import {
  ChainNote,
  ChainRoute,
  FX_KINDS,
  LFO_SOURCE,
  LIMITER_STAGE,
  NEUTRAL_PARAMS,
  neutralState,
} from './chain-params';

const DISTORTION = FX_KINDS.indexOf('distortion');
const CHORUS = FX_KINDS.indexOf('chorus');
const DELAY = FX_KINDS.indexOf('delay');
const COMPRESSOR = FX_KINDS.indexOf('compressor');
const REVERB = FX_KINDS.indexOf('reverb');
const STAGES = [...FX_KINDS.keys(), LIMITER_STAGE];

const setup = ({ failFirstLoad = false } = {}) => {
  const audioCtx = new AudioContext();
  const addModule = audioCtx.audioWorklet?.addModule as jest.Mock | undefined;
  if (failFirstLoad) addModule?.mockRejectedValueOnce(new Error('404'));
  // (the node of a synth core: the LFOs are told it, not the chain)
  const engine = createEngineNode(audioCtx);
  const chain = createChain(audioCtx, engine);
  const statuses: FxStatus[] = [];
  chain.$status.subscribe((status) => statuses.push(status));
  const stages = () => STAGES.map((stage) => chain.status(stage).value);
  return { audioCtx, addModule, engine, chain, statuses, stages };
};

// a chain whose node exists, what it was posted so far forgotten
const ready = async (options?: Parameters<typeof setup>[0]) => {
  const context = setup(options);
  await flush();
  const node = chainNode(context.audioCtx);
  return { ...context, node, posts: () => chainPosts(node) };
};

// a route of an envelope and one of an LFO to knobs of the delay
const ENV_ROUTE: ChainRoute = { target: DELAY * 32 + 1, source: 1, amount: 0.5, min: 0, max: 0.9 };
const LFO_ROUTE: ChainRoute = { target: DELAY * 32, source: LFO_SOURCE + 1, amount: 0.2, min: 0.01, max: 1 };
const FLAT = { attack: 0, hold: 0, decay: 0, sustain: 1, release: 0 };
const note = (start: number): ChainNote => ({ envelopes: [FLAT, FLAT, FLAT], start, release: null });

// a state of the LFOs from `at` on, LFO 1 with a shape when `table` is given (a state has only those that changed)
const lfos = (at: number, table?: Float32Array): LfosState => ({
  at,
  lfos: [0, 1, 2, 3].map((index) => ({
    mode: 0,
    delay: 0,
    rise: 0,
    smooth: 0,
    phase: at,
    anchor: { time: at, phase: 0, period: 1 },
    ...(index === 0 && table && { table }),
  })),
});

describe('createChain', () => {
  afterEach(() => jest.restoreAllMocks());

  describe('the module and the node', () => {
    it('adds the module of the engine once and is silent while it loads', () => {
      const { audioCtx, addModule, engine, statuses, stages } = setup();
      expect(statuses).toEqual(['loading']);
      expect(stages()).toEqual(STAGES.map(() => 'loading'));
      expect(workletLoads(addModule as jest.Mock, 'engine')).toBe(1);
      expect(addModule).toHaveBeenCalledTimes(1);
      // no fallback: no node, nothing plays unlimited
      expect(chainNodes(audioCtx)).toHaveLength(0);
      expect(engine.output.connect).not.toHaveBeenCalled();
    });

    it('plays in the node of the engine, into its output, once the module has loaded', async () => {
      const { audioCtx, engine, statuses, stages } = setup();
      await flush();
      expect(statuses).toEqual(['loading', 'ready']);
      expect(stages()).toEqual(STAGES.map(() => 'ready'));
      expect(chainNodes(audioCtx)).toHaveLength(1);
      const node = chainNode(audioCtx);
      expect(node.name).toBe(ENGINE_PROCESSOR);
      // no input: the voices play inside it, nothing goes into it or around its limiter (the specs are a perf
      // build: its second output is the probe's)
      expect(node.options).toMatchObject(PROBED_NODE_OPTIONS);
      expect(node.options.numberOfInputs).toBe(0);
      // its first output alone, the one after the limiter
      expect((node.connect as jest.Mock).mock.calls).toEqual([[engine.output, 0]]);
    });

    it('a chain no one told anything starts neutral: no effect, the master open, nothing followed', async () => {
      const { audioCtx } = setup();
      await flush();
      const { state } = chainNode(audioCtx).options.processorOptions;
      expect(state).toEqual(neutralState());
      expect(state.order).toEqual([]);
      FX_KINDS.forEach((kind) =>
        expect(state.slots[kind]).toEqual({ params: NEUTRAL_PARAMS[kind], mix: 1, active: false })
      );
      // (a copy: a knob turned later doesn't change the constants)
      expect(state.slots.delay.params).not.toBe(NEUTRAL_PARAMS.delay);
    });

    it('without AudioWorklet: unsupported at once, nothing to load, nothing throws', async () => {
      withoutAudioWorklet();
      const { engine, audioCtx, chain, statuses, stages } = setup();
      expect(statuses).toEqual(['unsupported']);
      expect(stages()).toEqual(STAGES.map(() => 'unsupported'));
      chain.retry();
      chain.retryStage(LIMITER_STAGE);
      chain.setMix(DELAY, 0.5);
      chain.setMasterGain(0.5);
      chain.setRoutes([LFO_ROUTE]);
      engine.lfos.take(lfos(0));
      chain.clear();
      await flush();
      expect(statuses).toEqual(['unsupported']);
      expect(chainNodes(audioCtx)).toHaveLength(0);
      expect(() => chain.destroy()).not.toThrow();
    });

    it('without wasm SIMD (Safari before 16.4): unsupported, its core could not be compiled', async () => {
      const validate = jest.spyOn(WebAssembly, 'validate').mockReturnValue(false);
      const { audioCtx, addModule, statuses } = setup();
      validate.mockRestore();
      await flush();
      expect(statuses).toEqual(['unsupported']);
      expect(addModule).not.toHaveBeenCalled();
      expect(chainNodes(audioCtx)).toHaveLength(0);
    });

    it('a module that fails to load: failed, every stage with it, no node is made', async () => {
      const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { audioCtx, statuses, stages } = setup({ failFirstLoad: true });
      await flush();
      expect(statuses).toEqual(['loading', 'failed']);
      expect(stages()).toEqual(STAGES.map(() => 'failed'));
      expect(error).toHaveBeenCalledWith('The engine worklet failed', expect.any(Error));
      expect(chainNodes(audioCtx)).toHaveLength(0);
    });

    it('retry loads a failed module again and makes the node', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { audioCtx, addModule, chain, engine, statuses, stages } = setup({ failFirstLoad: true });
      await flush();
      chain.retry();
      expect(workletLoads(addModule as jest.Mock, 'engine')).toBe(2);
      expect(stages()).toEqual(STAGES.map(() => 'loading'));
      await flush();
      expect(statuses).toEqual(['loading', 'failed', 'loading', 'ready']);
      expect(stages()).toEqual(STAGES.map(() => 'ready'));
      expect(chainNode(audioCtx).connect).toHaveBeenCalledWith(engine.output, 0);
    });

    it('retry does nothing while loading or ready', async () => {
      const { audioCtx, addModule, chain, statuses } = setup();
      chain.retry();
      await flush();
      chain.retry();
      await flush();
      expect(addModule).toHaveBeenCalledTimes(1);
      expect(chainNodes(audioCtx)).toHaveLength(1);
      expect(statuses).toEqual(['loading', 'ready']);
    });

    it('a node that can not be made: failed, retry makes it', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const Stub = AudioWorkletNode;
      Object.assign(globalThis, {
        AudioWorkletNode: function AudioWorkletNode() {
          throw new Error('InvalidStateError');
        },
      });
      const { audioCtx, addModule, chain, engine, statuses } = setup();
      await flush();
      expect(statuses).toEqual(['loading', 'failed']);
      expect(chainNodes(audioCtx)).toHaveLength(0);

      Object.assign(globalThis, { AudioWorkletNode: Stub });
      chain.retry();
      await flush();
      expect(statuses).toEqual(['loading', 'failed', 'loading', 'ready']);
      // (the module had loaded: it is not added again)
      expect(addModule).toHaveBeenCalledTimes(1);
      expect(chainNode(audioCtx).connect).toHaveBeenCalledWith(engine.output, 0);
    });

    it('a processor error: failed, the node stopped (its core freed) and dropped, the master silent', async () => {
      const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { chain, node, statuses, stages, posts } = await ready();
      const event = new Event('processorerror');
      node.onprocessorerror?.call(node, event as ErrorEvent);
      expect(statuses).toEqual(['loading', 'ready', 'failed']);
      expect(stages()).toEqual(STAGES.map(() => 'failed'));
      expect(error).toHaveBeenCalledWith('The engine worklet failed', event);
      expect(posts()).toEqual([{ stop: true }]);
      expect(node.disconnect).toHaveBeenCalled();
      // dropped: it is told nothing more
      chain.setMix(DELAY, 0.5);
      chain.clear();
      expect(posts()).toEqual([{ stop: true }]);
    });

    it('a core that trapped out of its stages: failed as a processor that threw, a retry makes a new node', async () => {
      const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { audioCtx, chain, node, statuses, stages, posts } = await ready();
      chainReports(node, { broken: true });
      expect(statuses).toEqual(['loading', 'ready', 'failed']);
      expect(stages()).toEqual(STAGES.map(() => 'failed'));
      expect(error).toHaveBeenCalledWith(
        'The engine worklet failed',
        expect.objectContaining({ message: 'The engine core trapped' })
      );
      expect(posts()).toEqual([{ stop: true }]);
      expect(node.disconnect).toHaveBeenCalled();
      chain.retry();
      await flush();
      expect(statuses).toEqual(['loading', 'ready', 'failed', 'loading', 'ready']);
      expect(chainNode(audioCtx)).not.toBe(node);
      expect(stages()).toEqual(STAGES.map(() => 'ready'));
    });

    it('a node is made again after its core trapped 4 times at most: then the chain stays failed', async () => {
      const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { audioCtx, chain, statuses } = await ready();
      for (let remake = 0; remake < 4; remake++) {
        chainReports(chainNode(audioCtx), { broken: true });
        chain.retry();
        await flush();
        expect(chain.$status.value).toBe('ready');
      }
      expect(chainNodes(audioCtx)).toHaveLength(5);
      chainReports(chainNode(audioCtx), { broken: true });
      chain.retry();
      await flush();
      expect(chain.$status.value).toBe('failed');
      expect(chainNodes(audioCtx)).toHaveLength(5);
      expect(statuses.slice(-2)).toEqual(['ready', 'failed']);
      expect(error).toHaveBeenLastCalledWith(expect.stringContaining('not made again'));
    });

    it('a processor that threw is not counted: its node is made again every time', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { audioCtx, chain } = await ready();
      for (let remake = 0; remake < 6; remake++) {
        const node = chainNode(audioCtx);
        node.onprocessorerror?.call(node, new Event('processorerror') as ErrorEvent);
        chain.retry();
        await flush();
        expect(chain.$status.value).toBe('ready');
      }
      expect(chainNodes(audioCtx)).toHaveLength(7);
    });

    it('a retry after a processor error makes a new node with the state of now', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { audioCtx, addModule, chain, engine, node, statuses } = await ready();
      chain.setOrder([REVERB]);
      chain.setActive(REVERB, true);
      node.onprocessorerror?.call(node, new Event('processorerror') as ErrorEvent);
      // a knob turned while there is no node
      chain.setParams(REVERB, { decay: 5 });
      chain.setMix(REVERB, 0.4);
      chain.retry();
      await flush();
      expect(statuses).toEqual(['loading', 'ready', 'failed', 'loading', 'ready']);
      expect(addModule).toHaveBeenCalledTimes(1);
      expect(chainNodes(audioCtx)).toHaveLength(2);
      const next = chainNode(audioCtx);
      expect(next).not.toBe(node);
      expect(next.options.processorOptions.state).toMatchObject({
        order: [REVERB],
        slots: { reverb: { params: { ...NEUTRAL_PARAMS.reverb, decay: 5 }, mix: 0.4, active: true } },
      });
      expect(next.connect).toHaveBeenCalledWith(engine.output, 0);
      // it has it all already: nothing is posted again
      expect(chainPosts(next)).toEqual([]);
      chain.setMix(REVERB, 0.6);
      expect(chainPosts(next)).toEqual([{ mix: [REVERB, 0.6] }]);
    });

    it('a node dropped earlier fails nothing and tells nothing', async () => {
      const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { audioCtx, chain, node, statuses } = await ready();
      const listener = jest.fn();
      chain.watch(COMPRESSOR, listener);
      node.onprocessorerror?.call(node, new Event('processorerror') as ErrorEvent);
      chain.retry();
      await flush();
      const next = chainNode(audioCtx);
      error.mockClear();

      node.onprocessorerror?.call(node, new Event('processorerror') as ErrorEvent);
      chainReports(node, { meter: [COMPRESSOR, { reduction: 1 }], failed: [REVERB] });
      expect(statuses[statuses.length - 1]).toBe('ready');
      expect(chain.status(REVERB).value).toBe('ready');
      expect(listener).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(next.disconnect).not.toHaveBeenCalled();

      chainReports(next, { meter: [COMPRESSOR, { reduction: 2 }] });
      expect(listener.mock.calls).toEqual([[{ reduction: 2 }]]);
    });
  });

  describe('the slots', () => {
    it('setParams posts the params that changed, by the keys of the core', async () => {
      const { chain, posts } = await ready();
      chain.setParams(DELAY, { ...NEUTRAL_PARAMS.delay, time: 0.5, fb: 0 });
      // a tick of a knob: the others as they were
      chain.setParams(DELAY, { ...NEUTRAL_PARAMS.delay, time: 0.5, fb: 0, pan: -0.02 });
      chain.setParams(DISTORTION, { drive: 0 });
      expect(posts()).toEqual([
        { params: [DELAY, { time: 0.5, fb: 0 }] },
        { params: [DELAY, { pan: -0.02 }] },
        { params: [DISTORTION, { drive: 0 }] },
      ]);
    });

    it('setParams posts nothing when no param changed', async () => {
      const { chain, posts } = await ready();
      chain.setParams(REVERB, { ...NEUTRAL_PARAMS.reverb });
      chain.setParams(REVERB, {});
      chain.setParams(CHORUS, { depth: 3 });
      chain.setParams(CHORUS, { depth: 3 });
      expect(posts()).toEqual([{ params: [CHORUS, { depth: 3 }] }]);
      // back to what it was: a change again
      chain.setParams(CHORUS, { depth: NEUTRAL_PARAMS.chorus['depth'] });
      expect(posts()).toHaveLength(2);
    });

    it('setMix and setActive post a change of their slot, once', async () => {
      const { chain, posts } = await ready();
      // (the neutral state: all wet, not playing)
      chain.setMix(DELAY, 1);
      chain.setActive(DELAY, false);
      expect(posts()).toEqual([]);

      chain.setMix(DELAY, 0.3);
      chain.setMix(DELAY, 0.3);
      chain.setMix(REVERB, 0);
      chain.setMix(REVERB, 0);
      chain.setActive(DELAY, true);
      chain.setActive(DELAY, true);
      chain.setActive(DELAY, false);
      expect(posts()).toEqual([
        { mix: [DELAY, 0.3] },
        { mix: [REVERB, 0] },
        { active: [DELAY, true] },
        { active: [DELAY, false] },
      ]);
    });

    it('setOrder posts the slots of the chain when they or their order change', async () => {
      const { chain, posts } = await ready();
      chain.setOrder([]);
      expect(posts()).toEqual([]);
      const order = [DELAY, REVERB];
      chain.setOrder(order);
      chain.setOrder([DELAY, REVERB]);
      chain.setOrder([REVERB, DELAY]);
      chain.setOrder([]);
      expect(posts()).toEqual([{ order: [DELAY, REVERB] }, { order: [REVERB, DELAY] }, { order: [] }]);
      // the chain keeps its own copy: the array of the caller changed later is still a change
      chain.setOrder(order);
      order.push(CHORUS);
      chain.setOrder(order);
      expect(posts()[posts().length - 1]).toEqual({ order: [DELAY, REVERB, CHORUS] });
    });

    it('nothing is posted before the node exists: it is made with what the chain was told', async () => {
      const { audioCtx, chain } = setup();
      expect(() => {
        chain.setParams(DELAY, { time: 0.5, fb: 0 });
        chain.setParams(DELAY, { time: 0.25 });
        chain.setMix(DELAY, 0);
        chain.setActive(DELAY, true);
        chain.setMix(COMPRESSOR, 0.5);
        chain.setOrder([REVERB, DELAY]);
        chain.setMasterGain(0.25);
        chain.mute(0.05);
        chain.clear();
      }).not.toThrow();
      await flush();
      const node = chainNode(audioCtx);
      expect(chainPosts(node)).toEqual([]);
      const expected = neutralState();
      expected.slots.delay = { params: { ...NEUTRAL_PARAMS.delay, time: 0.25, fb: 0 }, mix: 0, active: true };
      expected.slots.compressor.mix = 0.5;
      expected.order = [REVERB, DELAY];
      expected.masterGain = 0.25;
      expected.muted = true;
      expect(node.options.processorOptions.state).toEqual(expected);
    });
  });

  describe('the master', () => {
    it('setMasterGain, mute, unmute and clear are posted every time, a mute with the time of now', async () => {
      const { audioCtx, chain, posts } = await ready();
      const at = audioCtx.currentTime;
      chain.setMasterGain(0.5);
      chain.setMasterGain(0.5);
      chain.setMasterGain(0);
      chain.mute(0.03);
      chain.mute(0.03);
      chain.clear();
      chain.clear();
      chain.unmute();
      chain.unmute();
      expect(posts()).toEqual([
        { masterGain: 0.5 },
        { masterGain: 0.5 },
        { masterGain: 0 },
        { mute: 0.03, at },
        { mute: 0.03, at },
        { clear: true },
        { clear: true },
        { unmute: true },
        { unmute: true },
      ]);
    });

    it('a node made later is muted or not as the chain was left, at its master gain', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { audioCtx, chain, node } = await ready();
      const remade = async () => {
        const current = chainNode(audioCtx);
        current.onprocessorerror?.call(current, new Event('processorerror') as ErrorEvent);
        chain.retry();
        await flush();
        return chainNode(audioCtx).options.processorOptions.state;
      };
      chain.setMasterGain(0);
      chain.mute(0.03);
      expect(await remade()).toMatchObject({ masterGain: 0, muted: true });
      chain.unmute();
      chain.setMasterGain(0.7);
      expect(await remade()).toMatchObject({ masterGain: 0.7, muted: false });
      expect(chainNodes(audioCtx)).toHaveLength(3);
      expect(chainNodes(audioCtx)[0]).toBe(node);
    });
  });

  describe('the routes and the note', () => {
    it('a note is not sent while no route follows it, the first routes come with the note of now', async () => {
      const { chain, posts } = await ready();
      chain.setNote(note(1));
      chain.setNote(note(2));
      expect(posts()).toEqual([]);
      chain.setRoutes([ENV_ROUTE]);
      expect(posts()).toEqual([{ note: note(2), routes: [ENV_ROUTE] }]);
    });

    it('the first routes without a note yet say so', async () => {
      const { chain, posts } = await ready();
      chain.setRoutes([ENV_ROUTE]);
      expect(posts()).toEqual([{ note: null, routes: [ENV_ROUTE] }]);
    });

    it('later routes come alone, the same ones are not sent again', async () => {
      const { chain, posts } = await ready();
      chain.setRoutes([]);
      expect(posts()).toEqual([]);
      chain.setRoutes([ENV_ROUTE]);
      chain.setRoutes([{ ...ENV_ROUTE }]);
      const more = [ENV_ROUTE, { ...ENV_ROUTE, source: 2, bipolar: true }];
      chain.setRoutes(more);
      chain.setRoutes([]);
      chain.setRoutes([]);
      expect(posts()).toEqual([{ note: null, routes: [ENV_ROUTE] }, { routes: more }, { routes: [] }]);
    });

    it('setNote is posted while routes exist, a release and no note too', async () => {
      const { chain, posts } = await ready();
      chain.setRoutes([ENV_ROUTE]);
      chain.setNote(note(1));
      chain.setNote({ ...note(1), release: 2, from: [0, 0.5, 0], velo: 0.8 });
      chain.setNote(null);
      expect(posts().slice(1)).toEqual([
        { note: note(1) },
        { note: { ...note(1), release: 2, from: [0, 0.5, 0], velo: 0.8 } },
        { note: null },
      ]);
    });

    it('the routes gone, the notes are kept here: routes again come with the last one', async () => {
      const { chain, posts } = await ready();
      chain.setRoutes([ENV_ROUTE]);
      chain.setNote(note(1));
      chain.setRoutes([]);
      chain.setNote(note(2));
      chain.setNote(note(3));
      chain.setRoutes([LFO_ROUTE]);
      expect(posts().slice(2)).toEqual([{ routes: [] }, { note: note(3), routes: [LFO_ROUTE] }]);
    });

    it('a node made later starts with the routes and the note', async () => {
      const { audioCtx, chain } = setup();
      chain.setNote(note(4));
      chain.setRoutes([ENV_ROUTE]);
      await flush();
      const node = chainNode(audioCtx);
      expect(node.options.processorOptions.state).toMatchObject({ routes: [ENV_ROUTE], note: note(4) });
      // (they were its first routes, but it has the note: the next ones come alone)
      chain.setRoutes([ENV_ROUTE, LFO_ROUTE]);
      expect(chainPosts(node)).toEqual([{ routes: [ENV_ROUTE, LFO_ROUTE] }]);
    });
  });

  describe('the LFOs', () => {
    const table = new Float32Array([0, 1, 0]);

    it('are not posted while no route reads one: a state is a table the audio thread takes in', async () => {
      const { engine, chain, posts } = await ready();
      engine.lfos.take(lfos(0, table));
      chain.setRoutes([ENV_ROUTE]);
      engine.lfos.take(lfos(1));
      expect(posts()).toEqual([{ note: null, routes: [ENV_ROUTE] }]);
    });

    it('a route of an LFO: the LFOs as they are at once, before the routes, then every state', async () => {
      const { engine, chain, posts } = await ready();
      engine.lfos.take(lfos(0, table));
      engine.lfos.take(lfos(1));
      chain.setRoutes([ENV_ROUTE, LFO_ROUTE]);
      // the knobs of the last state, the shape of the one before (a state has only the tables that changed)
      const merged = lfos(1, table).lfos;
      expect(posts()).toEqual([
        { lfos: { at: 0, instantly: true, lfos: merged }, readers: ['chain'] },
        { note: null, routes: [ENV_ROUTE, LFO_ROUTE] },
      ]);
      engine.lfos.take(lfos(2));
      expect(posts()[2]).toEqual({ lfos: lfos(2), readers: ['chain'] });
      // other routes that still read one: the LFOs are not sent again
      chain.setRoutes([LFO_ROUTE]);
      expect(posts().slice(3)).toEqual([{ routes: [LFO_ROUTE] }]);
    });

    it('the source of a route tells: an envelope and the velocity read none, LFO 1 to 4 do', async () => {
      const { engine, chain, posts } = await ready();
      engine.lfos.take(lfos(0));
      [0, 1, 2, 3].forEach((source) => chain.setRoutes([{ ...ENV_ROUTE, source }]));
      expect(posts().some((message) => message.lfos)).toBe(false);
      chain.setRoutes([{ ...ENV_ROUTE, source: LFO_SOURCE }]);
      expect(posts().filter((message) => message.lfos)).toHaveLength(1);
      chain.setRoutes([{ ...ENV_ROUTE, source: LFO_SOURCE + 3 }]);
      expect(posts().filter((message) => message.lfos)).toHaveLength(1);
    });

    it('the last route of an LFO gone: no state any more; one again: the LFOs as they are by then', async () => {
      const { engine, chain, posts } = await ready();
      chain.setRoutes([LFO_ROUTE]);
      engine.lfos.take(lfos(1, table));
      chain.setRoutes([ENV_ROUTE]);
      engine.lfos.take(lfos(2));
      engine.lfos.take(lfos(3));
      expect(posts().slice(2)).toEqual([{ routes: [ENV_ROUTE] }]);
      chain.setRoutes([LFO_ROUTE]);
      expect(posts().slice(3)).toEqual([
        { lfos: { at: 0, instantly: true, lfos: lfos(3, table).lfos }, readers: ['chain'] },
        { routes: [LFO_ROUTE] },
      ]);
    });

    it('a route of an LFO before any state: nothing to send, the first state comes as it is', async () => {
      const { engine, chain, posts } = await ready();
      chain.setRoutes([LFO_ROUTE]);
      expect(posts()).toEqual([{ note: null, routes: [LFO_ROUTE] }]);
      engine.lfos.take(lfos(1, table));
      expect(posts()[1]).toEqual({ lfos: lfos(1, table), readers: ['chain'] });
    });

    it('a node made later starts with the LFOs as they are, every shape with them; none told: none', async () => {
      const first = setup();
      await flush();
      expect(chainNode(first.audioCtx).options.processorOptions.state.lfos).toBeNull();
      expect(chainNode(first.audioCtx).options.processorOptions).not.toHaveProperty('lfos');

      const { engine, audioCtx, chain } = setup();
      engine.lfos.take(lfos(0, table));
      engine.lfos.take(lfos(1));
      chain.setRoutes([LFO_ROUTE]);
      await flush();
      const node = chainNode(audioCtx);
      // (those of the node: its voices and its chain have them at once)
      expect(node.options.processorOptions.lfos).toEqual({
        at: 0,
        instantly: true,
        lfos: lfos(1, table).lfos,
      });
      expect(node.options.processorOptions.state.lfos).toBeNull();
      // it reads one already: the states go on
      engine.lfos.take(lfos(2));
      expect(chainPosts(node)).toEqual([{ lfos: lfos(2), readers: ['chain'] }]);
    });
  });

  describe('the meters', () => {
    it('watch tells the worklet and gives the listener the meter of its slot', async () => {
      const { chain, node, posts } = await ready();
      const compressor = jest.fn();
      const chorus = jest.fn();
      chain.watch(COMPRESSOR, compressor);
      chain.watch(CHORUS, chorus);
      expect(posts()).toEqual([{ meter: [COMPRESSOR, true] }, { meter: [CHORUS, true] }]);

      chainReports(node, { meter: [COMPRESSOR, { reduction: [1, 2, 3] }] });
      chainReports(node, { meter: [CHORUS, { lfo: 0.5 }] });
      // (a slot no one watches)
      chainReports(node, { meter: [REVERB, { level: 1 }] });
      expect(compressor.mock.calls).toEqual([[{ reduction: [1, 2, 3] }]]);
      expect(chorus.mock.calls).toEqual([[{ lfo: 0.5 }]]);
    });

    it('watch(null) stops it: the worklet is told, a meter still on its way is dropped', async () => {
      const { chain, node, posts } = await ready();
      const listener = jest.fn();
      chain.watch(COMPRESSOR, listener);
      chain.watch(COMPRESSOR, null);
      expect(posts()).toEqual([{ meter: [COMPRESSOR, true] }, { meter: [COMPRESSOR, false] }]);
      chainReports(node, { meter: [COMPRESSOR, { reduction: 1 }] });
      expect(listener).not.toHaveBeenCalled();
    });

    it('another listener of a slot takes its place', async () => {
      const { chain, node } = await ready();
      const [first, second] = [jest.fn(), jest.fn()];
      chain.watch(CHORUS, first);
      chain.watch(CHORUS, second);
      chainReports(node, { meter: [CHORUS, 1] });
      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledWith(1);
    });

    it('a node made later starts with the meters that are watched, each once', async () => {
      const { audioCtx, chain } = setup();
      const listener = jest.fn();
      chain.watch(COMPRESSOR, listener);
      chain.watch(CHORUS, jest.fn());
      chain.watch(COMPRESSOR, listener);
      chain.watch(REVERB, jest.fn());
      chain.watch(REVERB, null);
      await flush();
      const node = chainNode(audioCtx);
      expect(node.options.processorOptions.state.meters).toEqual([CHORUS, COMPRESSOR]);
      expect(chainPosts(node)).toEqual([]);
      // watched before it existed: its listener is told
      chainReports(node, { meter: [COMPRESSOR, 3] });
      expect(listener).toHaveBeenCalledWith(3);
    });
  });

  describe('a stage that failed in the core', () => {
    it('is failed alone: the others play on, the chain is ready', async () => {
      const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { chain, node, statuses, stages } = await ready();
      const reverb: FxStatus[] = [];
      chain.status(REVERB).subscribe((status) => reverb.push(status));
      chainReports(node, { failed: [REVERB] });
      expect(reverb).toEqual(['ready', 'failed']);
      expect(stages()).toEqual(STAGES.map((stage) => (stage === REVERB ? 'failed' : 'ready')));
      expect(statuses).toEqual(['loading', 'ready']);
      expect(error).toHaveBeenCalledWith('A stage of the chain failed', [REVERB]);
      // the node stays
      expect(node.disconnect).not.toHaveBeenCalled();
    });

    it('is reported by its effect (the limiter), with the trap that failed it', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { errors, fingerprints } = recordAnalytics();
      const { node } = await ready();
      chainReports(node, { failed: [REVERB, LIMITER_STAGE], trap: 'unreachable' });
      // (a retry that failed again: no trap told)
      chainReports(node, { failed: [DELAY] });
      expect(fingerprints()).toEqual(['engine:stage:reverb', 'engine:stage:limiter', 'engine:stage:delay']);
      expect(errors.map(({ properties }) => properties['trap'] ?? null)).toEqual([
        'unreachable',
        'unreachable',
        null,
      ]);
    });

    it('the limiter is a stage of its own, several may fail', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { chain, node, stages } = await ready();
      chainReports(node, { failed: [LIMITER_STAGE] });
      expect(chain.status(LIMITER_STAGE).value).toBe('failed');
      expect(FX_KINDS.map((_, slot) => chain.status(slot).value)).toEqual(FX_KINDS.map(() => 'ready'));
      chainReports(node, { failed: [DISTORTION, DELAY] });
      expect(stages()).toEqual(['failed', 'ready', 'failed', 'ready', 'ready', 'ready', 'ready', 'failed']);
    });

    it('retryStage has its unit made again: loading until the node tells it is, the other failed ones stay', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { chain, node, stages, posts } = await ready();
      chainReports(node, { failed: [REVERB, LIMITER_STAGE] });
      chain.retryStage(REVERB);
      expect(posts()).toEqual([{ retry: REVERB }]);
      expect(stages()).toEqual(['ready', 'ready', 'ready', 'ready', 'loading', 'ready', 'ready', 'failed']);
      chainReports(node, { remade: REVERB });
      expect(stages()).toEqual(['ready', 'ready', 'ready', 'ready', 'ready', 'ready', 'ready', 'failed']);
      chain.retryStage(LIMITER_STAGE);
      expect(posts()).toEqual([{ retry: REVERB }, { retry: LIMITER_STAGE }]);
      chainReports(node, { remade: LIMITER_STAGE });
      expect(stages()).toEqual(STAGES.map(() => 'ready'));
    });

    it('a stage the node could not make again is failed again, and can be retried', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { chain, node, posts } = await ready();
      const statuses: FxStatus[] = [];
      chain.status(REVERB).subscribe((status) => statuses.push(status));
      chainReports(node, { failed: [REVERB] });
      chain.retryStage(REVERB);
      chainReports(node, { failed: [REVERB] });
      expect(statuses).toEqual(['ready', 'failed', 'loading', 'failed']);
      chain.retryStage(REVERB);
      chainReports(node, { remade: REVERB });
      expect(posts()).toEqual([{ retry: REVERB }, { retry: REVERB }]);
      expect(statuses).toEqual(['ready', 'failed', 'loading', 'failed', 'loading', 'ready']);
    });

    it('a node made anew has no stage failed or loading', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { chain, node, stages } = await ready();
      chainReports(node, { failed: [REVERB] });
      chain.retryStage(REVERB);
      chainReports(node, { broken: true });
      chain.retry();
      await flush();
      expect(stages()).toEqual(STAGES.map(() => 'ready'));
    });

    it('retryStage without a node (its core trapped) does nothing: no remake of the stage is spent', async () => {
      const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { chain, audioCtx, node, posts } = await ready();
      chainReports(node, { failed: [REVERB] });
      chainReports(node, { broken: true });
      // (the Retry of the effect: the chain, then its stage, while the node is gone and while the module loads)
      for (let click = 0; click < 6; click++) chain.retryStage(REVERB);
      chain.retry();
      for (let click = 0; click < 6; click++) chain.retryStage(REVERB);
      // (the node that ended was told to stop, nothing else)
      expect(posts()).toEqual([{ stop: true }]);
      await flush();
      expect(chain.status(REVERB).value).toBe('ready');
      // the stage of the new node fails: it is made again, its remakes are all there
      const [, next] = chainNodes(audioCtx);
      for (let remake = 0; remake < 4; remake++) {
        chainReports(next, { failed: [REVERB] });
        chain.retryStage(REVERB);
        expect(chain.status(REVERB).value).toBe('loading');
      }
      expect(chainPosts(next)).toEqual([0, 1, 2, 3].map(() => ({ retry: REVERB })));
      expect(error).not.toHaveBeenCalledWith(expect.stringContaining('not made again'));
    });

    it('a stage is made again 4 times at most: then it stays failed, the others are still made again', async () => {
      const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { chain, node, posts } = await ready();
      for (let remake = 0; remake < 5; remake++) {
        chainReports(node, { failed: [DELAY] });
        chain.retryStage(DELAY);
      }
      expect(posts()).toEqual([0, 1, 2, 3].map(() => ({ retry: DELAY })));
      expect(chain.status(DELAY).value).toBe('failed');
      expect(error).toHaveBeenLastCalledWith(expect.stringContaining('not made again'));
      const { fingerprints } = recordAnalytics();
      chain.retryStage(DELAY);
      expect(fingerprints()).toEqual(['engine:spent:delay']);
      chainReports(node, { failed: [REVERB] });
      chain.retryStage(REVERB);
      expect(posts()).toHaveLength(5);
      expect(chain.status(REVERB).value).toBe('loading');
      chainReports(node, { remade: REVERB });
      expect(chain.status(REVERB).value).toBe('ready');
      expect(chain.status(DELAY).value).toBe('failed');
    });

    it('retryStage of a stage that did not fail does nothing, nor a second one', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { chain, node, posts } = await ready();
      chain.retryStage(DELAY);
      chain.retryStage(LIMITER_STAGE);
      expect(posts()).toEqual([]);
      chainReports(node, { failed: [DELAY] });
      chain.retryStage(DELAY);
      chain.retryStage(DELAY);
      expect(posts()).toEqual([{ retry: DELAY }]);
    });

    it('a stage that fails again after its retry is failed again', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { chain, node } = await ready();
      const statuses: FxStatus[] = [];
      chain.status(CHORUS).subscribe((status) => statuses.push(status));
      chainReports(node, { failed: [CHORUS] });
      // told twice: one change
      chainReports(node, { failed: [CHORUS] });
      chain.retryStage(CHORUS);
      chainReports(node, { failed: [CHORUS] });
      expect(statuses).toEqual(['ready', 'failed', 'loading', 'failed']);
    });

    it('the retry of the module is not for it: nothing loads, it stays failed', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { audioCtx, addModule, chain, node } = await ready();
      chainReports(node, { failed: [REVERB] });
      chain.retry();
      await flush();
      expect(addModule).toHaveBeenCalledTimes(1);
      expect(chainNodes(audioCtx)).toHaveLength(1);
      expect(chain.status(REVERB).value).toBe('failed');
    });

    it('a new node has every unit new: no stage is failed any more', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { audioCtx, chain, node, stages } = await ready();
      chainReports(node, { failed: [REVERB] });
      node.onprocessorerror?.call(node, new Event('processorerror') as ErrorEvent);
      expect(stages()).toEqual(STAGES.map(() => 'failed'));
      chain.retry();
      expect(stages()).toEqual(STAGES.map(() => 'loading'));
      await flush();
      expect(stages()).toEqual(STAGES.map(() => 'ready'));
      // nothing to make again in the new one
      chain.retryStage(REVERB);
      expect(chainPosts(chainNode(audioCtx))).toEqual([]);
    });
  });

  describe('destroy', () => {
    it('stops the processor, disconnects everything and completes the statuses', async () => {
      const { chain, engine, node, posts } = await ready();
      const completed = jest.fn();
      chain.$status.subscribe({ complete: completed });
      STAGES.forEach((stage) => chain.status(stage).subscribe({ complete: completed }));
      const listener = jest.fn();
      chain.watch(CHORUS, listener);
      chain.destroy();
      engine.destroy();
      expect(posts()).toEqual([{ meter: [CHORUS, true] }, { stop: true }]);
      expect(node.disconnect).toHaveBeenCalled();
      expect(engine.output.disconnect).toHaveBeenCalled();
      expect(completed).toHaveBeenCalledTimes(1 + STAGES.length);

      // nothing reaches it or comes from it any more
      chain.setMix(DELAY, 0.5);
      chain.clear();
      chainReports(node, { meter: [CHORUS, 1], failed: [REVERB] });
      node.onprocessorerror?.call(node, new Event('processorerror') as ErrorEvent);
      expect(posts()).toHaveLength(2);
      expect(listener).not.toHaveBeenCalled();
    });

    it('destroyed while its module loads: no node is made', async () => {
      const { audioCtx, chain, engine, statuses } = setup();
      chain.destroy();
      engine.destroy();
      await flush();
      expect(chainNodes(audioCtx)).toHaveLength(0);
      expect(statuses).toEqual(['loading']);
    });

    it('destroyed while a failed module is reported: no error, nothing throws', async () => {
      const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { chain, engine, statuses } = setup({ failFirstLoad: true });
      chain.destroy();
      engine.destroy();
      await flush();
      expect(error).not.toHaveBeenCalled();
      expect(statuses).toEqual(['loading']);
    });
  });
});
