import { registrar } from 'standardized-audio-context-mock';
import { withoutAudioWorklet } from '../../../../test-utils/no-audio-worklet';
import { workletLoads } from '../../../../test-utils/worklet-loads';
import type { FxStatus } from '../../fx/effects/types';
import { lfoTable } from '../lfo/lfo-curve';
import type { LfosState, LfoWire } from '../lfo/lfo-curve';
import { EngineClient, MAX_REMAKES } from './engine-host';
import { createEngineNode } from './engine-node';
import { ENGINE_MODULE, ENGINE_PROCESSOR, EngineOptions, PROBED_NODE_OPTIONS } from './engine-params';

interface NodeStub extends AudioWorkletNode {
  name: string;
  options: AudioWorkletNodeOptions & { processorOptions: EngineOptions };
  port: AudioWorkletNode['port'] & { postMessage: jest.Mock };
  connect: jest.Mock;
  disconnect: jest.Mock;
}

// the module loads asynchronously: the node exists after the pending promises settle
const flush = () => new Promise((resolve) => setTimeout(resolve));

const setup = ({ failFirstLoad = false } = {}) => {
  const audioCtx = new AudioContext();
  // (no audioWorklet without AudioWorklet)
  const addModule = audioCtx.audioWorklet?.addModule as jest.Mock | undefined;
  if (failFirstLoad) addModule?.mockRejectedValueOnce(new Error('404'));
  const engine = createEngineNode(audioCtx);
  const statuses: FxStatus[] = [];
  engine.$status.subscribe((status) => statuses.push(status));
  // the nodes of the engine the context has had, in the order they were made (a retry makes another)
  const nodes = () =>
    (registrar.getAudioNodes(audioCtx as never, 'AudioWorkletNode' as never) as unknown as NodeStub[]).filter(
      ({ name }) => name === ENGINE_PROCESSOR
    );
  return { audioCtx, addModule, engine, statuses, nodes };
};

// an engine whose node exists
const ready = async () => {
  const context = setup();
  await flush();
  const node = context.nodes()[0];
  return { ...context, node, posts: () => posts(node) };
};

// everything a node was posted, in order
const posts = (node: NodeStub) => node.port.postMessage.mock.calls.map(([message]) => message);
// a message of the processor, its error
const reports = (node: NodeStub, data: unknown) => node.port.onmessage?.({ data } as MessageEvent);
const throws = (node: NodeStub, event = new Event('processorerror')) => {
  node.onprocessorerror?.call(node, event as ErrorEvent);
  return event;
};

// a client that keeps what it is told, in order
const client = (options?: EngineClient['options']) => {
  const told: unknown[] = [];
  const it: EngineClient = {
    status: (status) => told.push(status),
    start: () => told.push('start'),
    stop: (ended) => told.push({ stop: ended }),
    report: (report) => told.push({ report }),
    ...(options && { options }),
  };
  return { it, told };
};

const wire = (change: Partial<LfoWire> = {}): LfoWire => ({
  mode: 0,
  delay: 0,
  rise: 0,
  smooth: 0,
  phase: 0,
  anchor: { time: 0, phase: 0, period: 1 },
  ...change,
});
// a state of the LFOs from `at` on, LFO 1 as `change` has it (a state has only the tables that changed)
const lfos = (at: number, change: Partial<LfoWire> = {}): LfosState => ({
  at,
  lfos: [wire({ phase: at, ...change }), wire(), wire(), wire()],
});

describe('createEngineNode', () => {
  afterEach(() => jest.restoreAllMocks());

  describe('the module and the node', () => {
    it('adds the module of the engine once and has no node while it loads', () => {
      const { audioCtx, addModule, engine, statuses, nodes } = setup();
      expect(statuses).toEqual(['loading']);
      expect(addModule).toHaveBeenCalledTimes(1);
      expect(workletLoads(addModule as jest.Mock, ENGINE_MODULE)).toBe(1);
      expect(String(addModule?.mock.calls[0][0])).toMatch(/assets\/worklets\/engine\.js$/);
      // silent until then: no node, its output goes nowhere by itself
      expect(nodes()).toHaveLength(0);
      expect(engine.output.context).toBe(audioCtx);
      expect(engine.output.connect).not.toHaveBeenCalled();
    });

    it('makes the one node into its output once the module has loaded: ready', async () => {
      const { audioCtx, engine, statuses, nodes } = setup();
      await flush();
      expect(statuses).toEqual(['loading', 'ready']);
      expect(registrar.getAudioNodes(audioCtx as never, 'AudioWorkletNode' as never)).toHaveLength(1);
      const [node] = nodes();
      // no input; the specs are a perf build: its second output is the probe's
      expect(node.options).toEqual({ ...PROBED_NODE_OPTIONS, processorOptions: {} });
      expect(node.numberOfInputs).toBe(0);
      expect(node.numberOfOutputs).toBe(2);
      // the output of its limiter alone: the probe has none while no one taps the voices
      expect(node.connect.mock.calls).toEqual([[engine.output, 0]]);
      // everything it needs it was made with: nothing is posted
      expect(posts(node)).toEqual([]);
    });

    it('without AudioWorklet: unsupported at once, nothing to load, nothing throws', async () => {
      withoutAudioWorklet();
      const { engine, statuses, nodes } = setup();
      const { it: listener, told } = client();
      engine.attach(listener);
      expect(statuses).toEqual(['unsupported']);
      engine.retry();
      engine.post({ stats: true });
      engine.lfos.use('voices', true);
      engine.lfos.take(lfos(0));
      engine.tapVoices(engine.output);
      await flush();
      expect(statuses).toEqual(['unsupported']);
      expect(told).toEqual(['unsupported']);
      expect(nodes()).toHaveLength(0);
      expect(() => engine.destroy()).not.toThrow();
    });

    it('in a context that is not secure (http on a LAN IP): unsupported', () => {
      withoutAudioWorklet({ secureContext: false });
      expect(setup().statuses).toEqual(['unsupported']);
    });

    it('without wasm SIMD (Safari before 16.4): unsupported, its core could not be compiled', async () => {
      const validate = jest.spyOn(WebAssembly, 'validate').mockReturnValue(false);
      const { addModule, statuses, nodes } = setup();
      validate.mockRestore();
      await flush();
      expect(statuses).toEqual(['unsupported']);
      expect(addModule).not.toHaveBeenCalled();
      expect(nodes()).toHaveLength(0);
    });

    it('a module that fails to load: failed, no node', async () => {
      const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { statuses, nodes } = setup({ failFirstLoad: true });
      await flush();
      expect(statuses).toEqual(['loading', 'failed']);
      expect(error).toHaveBeenCalledWith('The engine worklet failed', expect.any(Error));
      expect(nodes()).toHaveLength(0);
    });

    it('retry loads a failed module again and makes the node', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { addModule, engine, statuses, nodes } = setup({ failFirstLoad: true });
      await flush();
      engine.retry();
      expect(workletLoads(addModule as jest.Mock, ENGINE_MODULE)).toBe(2);
      expect(statuses).toEqual(['loading', 'failed', 'loading']);
      await flush();
      expect(statuses).toEqual(['loading', 'failed', 'loading', 'ready']);
      expect(nodes()).toHaveLength(1);
      expect(nodes()[0].connect).toHaveBeenCalledWith(engine.output, 0);
    });

    it('retry does nothing while loading or ready', async () => {
      const { addModule, engine, statuses, nodes } = setup();
      engine.retry();
      await flush();
      engine.retry();
      await flush();
      expect(addModule).toHaveBeenCalledTimes(1);
      expect(nodes()).toHaveLength(1);
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
      const { addModule, engine, statuses, nodes } = setup();
      const { it: listener, told } = client();
      engine.attach(listener);
      await flush();
      expect(statuses).toEqual(['loading', 'failed']);
      // (no node was made: none started; its clients are told all the same that none plays)
      expect(told).toEqual(['loading', { stop: true }, 'failed']);

      Object.assign(globalThis, { AudioWorkletNode: Stub });
      engine.retry();
      await flush();
      expect(statuses).toEqual(['loading', 'failed', 'loading', 'ready']);
      // (the module had loaded: it is not added again)
      expect(addModule).toHaveBeenCalledTimes(1);
      expect(nodes()).toHaveLength(1);
    });
  });

  describe('a node that failed', () => {
    it('a processor error: failed, the node stopped (its core freed) and disconnected, told nothing more', async () => {
      const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { engine, node, statuses, posts } = await ready();
      const { it: listener, told } = client();
      engine.attach(listener);
      const event = throws(node);
      expect(statuses).toEqual(['loading', 'ready', 'failed']);
      expect(error).toHaveBeenCalledWith('The engine worklet failed', event);
      expect(posts()).toEqual([{ stop: true }]);
      expect(node.disconnect.mock.calls).toEqual([[]]);
      // the clients: the node is gone, it ended; then the status
      expect(told).toEqual(['ready', { stop: true }, 'failed']);
      // dropped: it is told nothing more
      engine.post({ stats: true });
      engine.lfos.use('voices', true);
      engine.lfos.take(lfos(1));
      engine.tapVoices(engine.output);
      expect(posts()).toEqual([{ stop: true }]);
      // the output stays for the node to come
      expect(engine.output.disconnect).not.toHaveBeenCalled();
    });

    it('fail: a client fails it the same way (the worker of the store), once', async () => {
      const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { engine, node, statuses, posts } = await ready();
      const { it: listener, told } = client();
      engine.attach(listener);
      const reason = new Event('error');
      engine.fail(reason);
      engine.fail(new Event('error'));
      expect(statuses).toEqual(['loading', 'ready', 'failed']);
      expect(error.mock.calls).toEqual([['The engine worklet failed', reason]]);
      expect(posts()).toEqual([{ stop: true }]);
      expect(node.disconnect).toHaveBeenCalledTimes(1);
      expect(told).toEqual(['ready', { stop: true }, 'failed']);
    });

    it('a retry after a processor error makes a new node of what its clients are then', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { addModule, engine, node, statuses, nodes } = await ready();
      let unlimited = false;
      engine.attach({ options: () => ({ unlimited }) });
      throws(node);
      unlimited = true;
      engine.retry();
      await flush();
      expect(statuses).toEqual(['loading', 'ready', 'failed', 'loading', 'ready']);
      expect(addModule).toHaveBeenCalledTimes(1);
      expect(nodes()).toHaveLength(2);
      const next = nodes()[1];
      expect(next.options.processorOptions).toEqual({ unlimited: true });
      expect(next.connect.mock.calls).toEqual([[engine.output, 0]]);
      // what is posted from now on is for it
      engine.post({ stats: true });
      expect(posts(next)).toEqual([{ stats: true }]);
      expect(posts(node)).toEqual([{ stop: true }]);
    });

    it('a core that trapped out of its voices and stages: failed as a processor that threw, a retry makes a new node', async () => {
      const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { engine, node, statuses, nodes, posts } = await ready();
      const { it: listener, told } = client();
      engine.attach(listener);
      reports(node, { broken: true });
      expect(statuses).toEqual(['loading', 'ready', 'failed']);
      expect(error).toHaveBeenCalledWith('The engine worklet failed', expect.any(Error));
      expect(posts()).toEqual([{ stop: true }]);
      expect(node.disconnect).toHaveBeenCalled();
      // (not a report for the clients: they are told the node ended)
      expect(told).toEqual(['ready', { stop: true }, 'failed']);
      engine.retry();
      await flush();
      expect(statuses).toEqual(['loading', 'ready', 'failed', 'loading', 'ready']);
      expect(nodes()).toHaveLength(2);
      expect(told.slice(3)).toEqual(['loading', 'start', 'ready']);
    });

    it(`a node is made again after its core trapped ${MAX_REMAKES} times at most: then the engine stays failed`, async () => {
      const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { engine, statuses, nodes } = await ready();
      for (let remake = 0; remake < MAX_REMAKES; remake++) {
        reports(nodes().at(-1) as NodeStub, { broken: true });
        engine.retry();
        await flush();
        expect(engine.$status.value).toBe('ready');
      }
      expect(nodes()).toHaveLength(MAX_REMAKES + 1);
      reports(nodes().at(-1) as NodeStub, { broken: true });
      engine.retry();
      await flush();
      expect(engine.$status.value).toBe('failed');
      expect(nodes()).toHaveLength(MAX_REMAKES + 1);
      expect(statuses.slice(-2)).toEqual(['ready', 'failed']);
      expect(error).toHaveBeenLastCalledWith(expect.stringContaining('not made again'));
      // (every time it is asked)
      error.mockClear();
      engine.retry();
      expect(error).toHaveBeenCalledTimes(1);
      expect(engine.$status.value).toBe('failed');
    });

    it('a processor that threw is not counted: its node is made again every time', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { engine, nodes } = await ready();
      for (let remake = 0; remake < MAX_REMAKES + 2; remake++) {
        throws(nodes().at(-1) as NodeStub);
        engine.retry();
        await flush();
        expect(engine.$status.value).toBe('ready');
      }
      expect(nodes()).toHaveLength(MAX_REMAKES + 3);
    });

    it('a node dropped earlier fails nothing and tells nothing', async () => {
      const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { engine, node, statuses, nodes } = await ready();
      throws(node);
      engine.retry();
      await flush();
      const next = nodes()[1];
      const { it: listener, told } = client();
      engine.attach(listener);
      error.mockClear();

      throws(node);
      reports(node, { ended: [1], failed: [0] });
      reports(node, { broken: true });
      expect(statuses.at(-1)).toBe('ready');
      expect(told).toEqual(['ready']);
      expect(error).not.toHaveBeenCalled();
      expect(next.disconnect).not.toHaveBeenCalled();
      expect(posts(next)).toEqual([]);
      // (its trap is not one of the node of now: a retry has nothing to do, none of its remakes is spent)
      engine.retry();
      expect(statuses.at(-1)).toBe('ready');

      reports(next, { ended: [2] });
      expect(told).toEqual(['ready', { report: { ended: [2] } }]);
    });
  });

  describe('the clients', () => {
    it('are told the status of now as they attach, then every change', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { engine, nodes } = setup();
      const early = client();
      engine.attach(early.it);
      expect(early.told).toEqual(['loading']);
      await flush();
      const late = client();
      engine.attach(late.it);
      // (one that attaches to a node that plays is not told its start)
      expect(late.told).toEqual(['ready']);
      throws(nodes()[0]);
      const last = client();
      engine.attach(last.it);
      expect(last.told).toEqual(['failed']);
      engine.retry();
      await flush();
      expect(early.told).toEqual([
        'loading',
        'start',
        'ready',
        { stop: true },
        'failed',
        'loading',
        'start',
        'ready',
      ]);
      expect(late.told).toEqual(['ready', { stop: true }, 'failed', 'loading', 'start', 'ready']);
      expect(last.told).toEqual(['failed', 'loading', 'start', 'ready']);
    });

    it('start comes before ready, the node already there: what a client sends then is the first it gets', async () => {
      const { engine, nodes } = setup();
      const seen: unknown[] = [];
      const port = {} as MessagePort;
      engine.attach({
        start: () => {
          seen.push(['start', engine.$status.value, nodes().length]);
          engine.post({ port }, [port]);
        },
        status: (status) => {
          seen.push([status, nodes().length]);
          if (status === 'ready') engine.post({ stats: true });
        },
      });
      await flush();
      expect(seen).toEqual([
        ['loading', 0],
        ['start', 'loading', 1],
        ['ready', 1],
      ]);
      expect(nodes()[0].port.postMessage.mock.calls).toEqual([[{ port }, [port]], [{ stats: true }]]);
    });

    it('each gives its share of the options the node is made with, in the order they attached', async () => {
      const { engine, nodes } = setup();
      const events = [{ kind: 'bend' as const, cents: 100 }];
      engine.attach({ options: () => ({ tap: true, unlimited: true }) });
      // (none of its own)
      engine.attach({});
      engine.attach({ options: () => ({ events, unlimited: false }) });
      await flush();
      expect(nodes()[0].options).toEqual({
        ...PROBED_NODE_OPTIONS,
        processorOptions: { tap: true, events, unlimited: false },
      });
    });

    it('every one gets what the node posts, whole', async () => {
      const { engine, node } = await ready();
      const [first, second] = [client(), client()];
      engine.attach(first.it);
      engine.attach(second.it);
      // (no report of its own)
      engine.attach({ status: () => undefined });
      const report = { started: [[1, 140, 128]], ended: [1], failed: [2], stored: 'osc1', version: 3 };
      reports(node, report);
      reports(node, { stats: { voices: 1 } });
      expect(first.told).toEqual(['ready', { report }, { report: { stats: { voices: 1 } } }]);
      expect(second.told).toEqual(first.told);
      expect((first.told[1] as { report: unknown }).report).toBe(report);
    });

    it('a client with no method at all is fine through a whole life of the node', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { engine, nodes } = setup();
      engine.attach({});
      await flush();
      reports(nodes()[0], { ended: [1] });
      throws(nodes()[0]);
      engine.retry();
      await flush();
      expect(() => engine.destroy()).not.toThrow();
      expect(nodes()).toHaveLength(2);
    });
  });

  describe('post', () => {
    it('does nothing before a node exists, with a transfer list or without', async () => {
      const { engine, nodes } = setup();
      const port = {} as MessagePort;
      expect(() => engine.post({ stats: true })).not.toThrow();
      expect(() => engine.post({ port }, [port])).not.toThrow();
      await flush();
      // (not kept for the node either: a client sends what a new node needs at its start)
      expect(posts(nodes()[0])).toEqual([]);
    });

    it('posts a message as it is, its transfer list only when there is one', async () => {
      const { engine, node } = await ready();
      const port = {} as MessagePort;
      const events = { events: [{ kind: 'bend' as const, cents: -350 }] };
      engine.post(events);
      engine.post({ port }, [port]);
      engine.post({ mix: [1, 0.5] }, []);
      expect(node.port.postMessage.mock.calls).toEqual([
        [events],
        [{ port }, [port]],
        [{ mix: [1, 0.5] }, []],
      ]);
      expect(node.port.postMessage.mock.calls[0][0]).toBe(events);
    });
  });

  describe('the LFOs', () => {
    const [sine, square] = [lfoTable('sine'), lfoTable('square')];

    it('are not posted while no one reads one: a state is a table the audio thread takes in', async () => {
      const { engine, posts } = await ready();
      engine.lfos.take(lfos(0, { table: sine }));
      engine.lfos.take(lfos(1));
      // (no reader is still no reader)
      engine.lfos.use('voices', false);
      expect(posts()).toEqual([]);
    });

    it('a reader: the LFOs as they are at once, every table with them, then every state as it comes', async () => {
      const { engine, posts } = await ready();
      engine.lfos.take(lfos(0, { table: sine }));
      engine.lfos.take(lfos(1, { delay: 2 }));
      engine.lfos.use('voices', true);
      expect(posts()).toEqual([
        {
          lfos: { at: 0, instantly: true, lfos: lfos(1, { delay: 2, table: sine }).lfos },
          readers: ['voices'],
        },
      ]);
      const next = lfos(2, { table: square });
      engine.lfos.take(next);
      engine.lfos.take(lfos(3));
      expect(posts().slice(1)).toEqual([
        { lfos: next, readers: ['voices'] },
        { lfos: lfos(3), readers: ['voices'] },
      ]);
      // (as it came: not a copy, not merged)
      expect(posts()[1].lfos).toBe(next);
      // it reads on: nothing is sent again
      engine.lfos.use('voices', true);
      expect(posts()).toHaveLength(3);
    });

    it('a reader before any state: nothing to send, the first state comes as it is', async () => {
      const { engine, posts } = await ready();
      engine.lfos.use('chain', true);
      expect(posts()).toEqual([]);
      engine.lfos.take(lfos(1, { table: sine }));
      expect(posts()).toEqual([{ lfos: lfos(1, { table: sine }), readers: ['chain'] }]);
    });

    it('every state told is sent: the LFO model alone tells them, once for both halves', async () => {
      const { engine, posts } = await ready();
      engine.lfos.use('voices', true);
      engine.lfos.use('chain', true);
      const state = lfos(1, { table: sine });
      engine.lfos.take(state);
      // (no state is held back by what it is made of: one of the same LFOs is the next state)
      engine.lfos.take({ at: 5, lfos: state.lfos });
      expect(posts()).toEqual([
        { lfos: state, readers: ['voices', 'chain'] },
        { lfos: { at: 5, lfos: state.lfos }, readers: ['voices', 'chain'] },
      ]);
    });

    it('two readers: one message for both, until neither reads; one again: the LFOs as they are by then', async () => {
      const { engine, posts } = await ready();
      engine.lfos.take(lfos(0, { table: sine }));
      engine.lfos.use('voices', true);
      engine.lfos.take(lfos(1));
      expect(posts()).toHaveLength(2);
      // the chain reads from now on: the LFOs as they are for it alone (it took none of the states before)
      engine.lfos.use('chain', true);
      expect(posts().slice(2)).toEqual([
        { lfos: { at: 0, instantly: true, lfos: lfos(1, { table: sine }).lfos }, readers: ['chain'] },
      ]);
      // (it reads on: nothing again)
      engine.lfos.use('chain', true);
      expect(posts()).toHaveLength(3);
      engine.lfos.take(lfos(2));
      expect(posts().slice(3)).toEqual([{ lfos: lfos(2), readers: ['voices', 'chain'] }]);
      // the voices read none any more, the chain does: a state is for it alone
      engine.lfos.use('voices', false);
      engine.lfos.use('voices', false);
      engine.lfos.take(lfos(3));
      expect(posts().slice(4)).toEqual([{ lfos: lfos(3), readers: ['chain'] }]);
      engine.lfos.use('chain', false);
      engine.lfos.take(lfos(4, { table: square }));
      engine.lfos.take(lfos(5));
      expect(posts()).toHaveLength(5);
      engine.lfos.use('voices', true);
      expect(posts().slice(5)).toEqual([
        { lfos: { at: 0, instantly: true, lfos: lfos(5, { table: square }).lfos }, readers: ['voices'] },
      ]);
    });

    it('two readers before any state: nothing to send the second one', async () => {
      const { engine, posts } = await ready();
      engine.lfos.use('voices', true);
      engine.lfos.use('chain', true);
      expect(posts()).toEqual([]);
    });

    it('a node made later starts with the LFOs as they are, every table with them; read meanwhile: every state after', async () => {
      const { engine, nodes } = setup();
      engine.lfos.take(lfos(0, { table: sine }));
      engine.lfos.use('voices', true);
      engine.lfos.take(lfos(1, { delay: 2 }));
      await flush();
      const [node] = nodes();
      expect(node.options.processorOptions).toEqual({
        lfos: { at: 0, instantly: true, lfos: lfos(1, { delay: 2, table: sine }).lfos },
      });
      // it has them already: none is posted for the reader of before
      expect(posts(node)).toEqual([]);
      engine.lfos.take(lfos(2));
      expect(posts(node)).toEqual([{ lfos: lfos(2), readers: ['voices'] }]);
    });

    it('a node made again starts with the last ones, read or not; none told: none', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { engine, node, nodes } = await ready();
      expect(node.options.processorOptions).not.toHaveProperty('lfos');
      throws(node);
      // (told while there is no node)
      engine.lfos.take(lfos(1, { table: square }));
      engine.lfos.take(lfos(2));
      engine.retry();
      await flush();
      const next = nodes()[1];
      expect(next.options.processorOptions.lfos).toEqual({
        at: 0,
        instantly: true,
        lfos: lfos(2, { table: square }).lfos,
      });
      expect(posts(next)).toEqual([]);
    });

    it('the LFOs go after the share of the clients in the options: a client can not replace them', async () => {
      const { engine, nodes } = setup();
      const stale = lfos(9);
      engine.attach({ options: () => ({ lfos: stale, tap: true }) });
      engine.lfos.take(lfos(1, { table: sine }));
      await flush();
      expect(nodes()[0].options.processorOptions).toEqual({
        tap: true,
        lfos: { at: 0, instantly: true, lfos: lfos(1, { table: sine }).lfos },
      });
    });
  });

  describe('tapVoices', () => {
    it('connects the second output of the node to the input of the target and tells the node to fill it', async () => {
      const { audioCtx, engine, node, posts } = await ready();
      const target = audioCtx.createGain();
      engine.tapVoices(target);
      expect(node.connect.mock.calls).toEqual([
        [engine.output, 0],
        [target, 1, 0],
      ]);
      expect(posts()).toEqual([{ probe: true }]);
      expect(node.disconnect).not.toHaveBeenCalled();
    });

    it('null: the target is let go, the node fills its second output no more', async () => {
      const { audioCtx, engine, node, posts } = await ready();
      const target = audioCtx.createGain();
      engine.tapVoices(target);
      engine.tapVoices(null);
      expect(node.disconnect.mock.calls).toEqual([[target, 1, 0]]);
      expect(posts()).toEqual([{ probe: true }, { probe: false }]);
      // (no target to let go: the node is told all the same)
      engine.tapVoices(null);
      expect(node.disconnect).toHaveBeenCalledTimes(1);
      expect(posts()).toEqual([{ probe: true }, { probe: false }, { probe: false }]);
      // the output of the limiter stays
      expect(node.connect).toHaveBeenCalledTimes(2);
    });

    it('another target takes the place of the one before', async () => {
      const { audioCtx, engine, node, posts } = await ready();
      const [first, second] = [audioCtx.createGain(), audioCtx.createGain()];
      engine.tapVoices(first);
      engine.tapVoices(second);
      expect(node.disconnect.mock.calls).toEqual([[first, 1, 0]]);
      expect(node.connect.mock.calls.slice(1)).toEqual([
        [first, 1, 0],
        [second, 1, 0],
      ]);
      expect(posts()).toEqual([{ probe: true }, { probe: true }]);
    });

    it('before a node exists: the node made later is tapped, told before its clients start', async () => {
      const { audioCtx, engine, nodes } = setup();
      const target = audioCtx.createGain();
      engine.tapVoices(target);
      engine.attach({ start: () => engine.post({ stats: true }) });
      await flush();
      const [node] = nodes();
      expect(node.connect.mock.calls).toEqual([
        [engine.output, 0],
        [target, 1, 0],
      ]);
      expect(posts(node)).toEqual([{ probe: true }, { stats: true }]);
    });

    it('a node made again is tapped as the one before; a tap let go meanwhile: not', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { audioCtx, engine, node, nodes } = await ready();
      const target = audioCtx.createGain();
      engine.tapVoices(target);
      throws(node);
      // (all of the node that failed is disconnected)
      expect(node.disconnect.mock.calls).toEqual([[]]);
      engine.retry();
      await flush();
      const second = nodes()[1];
      expect(second.connect.mock.calls).toEqual([
        [engine.output, 0],
        [target, 1, 0],
      ]);
      expect(posts(second)).toEqual([{ probe: true }]);

      throws(second);
      engine.tapVoices(null);
      engine.retry();
      await flush();
      const third = nodes()[2];
      expect(third.connect.mock.calls).toEqual([[engine.output, 0]]);
      expect(posts(third)).toEqual([]);
      expect(second.disconnect.mock.calls).toEqual([[]]);
    });
  });

  describe('destroy', () => {
    it('stops the processor, disconnects the node and the output, completes the status', async () => {
      const { engine, node, statuses, posts } = await ready();
      const completed = jest.fn();
      engine.$status.subscribe({ complete: completed });
      const { it: listener, told } = client();
      engine.attach(listener);
      engine.destroy();
      expect(posts()).toEqual([{ stop: true }]);
      expect(node.disconnect.mock.calls).toEqual([[]]);
      expect(engine.output.disconnect).toHaveBeenCalledTimes(1);
      expect(completed).toHaveBeenCalledTimes(1);
      // the clients: the node is gone, not ended (no status after it)
      expect(told).toEqual(['ready', { stop: false }]);
      expect(statuses).toEqual(['loading', 'ready']);
    });

    it('nothing reaches the node or comes from it any more, a second destroy does nothing', async () => {
      const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { audioCtx, addModule, engine, node, statuses, nodes, posts } = await ready();
      const { it: listener, told } = client();
      engine.attach(listener);
      engine.destroy();
      engine.destroy();
      engine.post({ stats: true });
      engine.lfos.use('voices', true);
      engine.lfos.take(lfos(1));
      engine.tapVoices(audioCtx.createGain());
      reports(node, { ended: [1] });
      reports(node, { broken: true });
      throws(node);
      engine.fail(new Error('late'));
      engine.retry();
      await flush();
      expect(posts()).toEqual([{ stop: true }]);
      expect(node.connect).toHaveBeenCalledTimes(1);
      expect(told).toEqual(['ready', { stop: false }]);
      expect(statuses).toEqual(['loading', 'ready']);
      expect(error).not.toHaveBeenCalled();
      expect(engine.output.disconnect).toHaveBeenCalledTimes(1);
      expect(addModule).toHaveBeenCalledTimes(1);
      expect(nodes()).toHaveLength(1);
    });

    it('destroyed while its module loads: no node is made, no client starts', async () => {
      const { engine, statuses, nodes } = setup();
      const completed = jest.fn();
      engine.$status.subscribe({ complete: completed });
      const { it: listener, told } = client();
      engine.attach(listener);
      engine.destroy();
      await flush();
      expect(nodes()).toHaveLength(0);
      expect(statuses).toEqual(['loading']);
      expect(told).toEqual(['loading', { stop: false }]);
      expect(completed).toHaveBeenCalledTimes(1);
      expect(engine.output.disconnect).toHaveBeenCalledTimes(1);
    });

    it('destroyed while a failed module is reported: no error, nothing throws', async () => {
      const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { engine, statuses } = setup({ failFirstLoad: true });
      engine.destroy();
      await flush();
      expect(error).not.toHaveBeenCalled();
      expect(statuses).toEqual(['loading']);
    });

    it('destroyed after it failed: nothing to stop twice, the output disconnected', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { engine, node, posts } = await ready();
      const { it: listener, told } = client();
      engine.attach(listener);
      throws(node);
      engine.destroy();
      expect(posts()).toEqual([{ stop: true }]);
      expect(node.disconnect).toHaveBeenCalledTimes(1);
      expect(told).toEqual(['ready', { stop: true }, 'failed', { stop: false }]);
      expect(engine.output.disconnect).toHaveBeenCalledTimes(1);
    });
  });
});
