import { registrar } from 'standardized-audio-context-mock';
import { withoutAudioWorklet } from '../../../../test-utils/no-audio-worklet';
import { workletLoads } from '../../../../test-utils/worklet-loads';
import { eventsOf, voicesNodes } from '../../../../test-utils/voice-events';
import { MessageChannelStub, WorkerStub } from '../../../../test-utils/worker-stub';
import { createEngineNode } from '../engine/engine-node';
import { ENGINE_PROCESSOR } from '../engine/engine-params';
import { LfoWire, lfoTable, RETRIG } from '../lfo/lfo-curve';
import { createWavetableEngine, WavetableStatus } from './wavetable-engine';
import type { VoiceOptions } from './voice-options';

// the module loads asynchronously
const flush = () => new Promise((resolve) => setTimeout(resolve));
const createChannel = () => new MessageChannelStub() as unknown as MessageChannel;

const setup = ({ failFirstLoad = false } = {}) => {
  const audioCtx = new AudioContext();
  // (no audioWorklet without AudioWorklet)
  const addModule = audioCtx.audioWorklet?.addModule as jest.Mock;
  if (failFirstLoad) addModule.mockRejectedValueOnce(new Error('404'));
  // the node of the engine: the voices and their store are in it
  const core = createEngineNode(audioCtx);
  const engine = createWavetableEngine(core, { createChannel });
  const statuses: WavetableStatus[] = [];
  engine.$status.subscribe((status) => statuses.push(status));
  const worker = () => WorkerStub.created.at(-1);
  // the frames of the build messages posted to the worker
  const builds = () =>
    (worker()?.postMessage.mock.calls ?? [])
      .map(([message]) => message)
      .filter((message) => 'frames' in message);
  // the node of the engine (the last one made), everything it was posted and the events of the voices in it (a
  // state of the LFOs, a message of its own, as an event among them)
  const node = () => voicesNodes(audioCtx).at(-1);
  const posts = (stub = node()) => (stub?.port.postMessage.mock.calls ?? []).map(([message]) => message);
  const events = (stub = node()) => (stub ? eventsOf(stub) : []).flatMap((message) => message.events);
  // what its store and its voices post to the main thread: an ack of a version, its counters, the voices ended
  const report = (data: unknown, stub = node()) => stub?.port.onmessage?.({ data });
  const ack = (table: string, version: number) => report({ stored: table, version });
  // both answers to a stats request
  const answer = (worklet: unknown, builder: unknown) => {
    report({ stats: worklet });
    worker()?.onmessage?.({ data: { stats: builder } } as MessageEvent);
  };
  return {
    audioCtx,
    addModule,
    core,
    engine,
    statuses,
    worker,
    builds,
    node,
    posts,
    events,
    report,
    ack,
    answer,
  };
};

const NOTE: VoiceOptions = {
  osc: [{ table: 'osc1', unison: 2, phase: 0, phaseRand: 0 }, null],
  start: 1,
  envelopes: [{ attack: 0, hold: 0, decay: 0, sustain: 1, release: 0.1 }],
  envStart: 1,
  phrase: 0,
  routes: [],
  filter: null,
};

const saw = [-1, -0.5, 0, 0.5];
const sine = [0, 1, 0, -1];

describe('wavetable engine', () => {
  afterEach(() => jest.restoreAllMocks());

  it('ready with the node of the engine: its module loaded, a worker made for its store', async () => {
    const { addModule, statuses, worker, engine } = setup();
    expect(statuses).toEqual(['loading']);
    expect(workletLoads(addModule, 'engine')).toBe(1);
    expect(
      engine.createVoice(
        { osc: [], start: 0, envelopes: [], envStart: 0, phrase: 0, routes: [], filter: null },
        {}
      )
    ).toBeNull();
    await flush();
    expect(statuses).toEqual(['loading', 'ready']);
    expect(worker()?.url).toMatch(/assets\/worklets\/wavetable-worker\.js$/);
    const [toWorker, transfer] = worker()?.postMessage.mock.calls[0] ?? [];
    expect(toWorker).toEqual({ port: expect.any(Object) });
    expect(transfer).toEqual([toWorker.port]);
  });

  it('makes no node of its own: the node of the engine gets the other port of the channel, transferred', async () => {
    const { audioCtx, node, posts, worker } = setup();
    await flush();
    // the store and every voice in the one node
    expect(registrar.getAudioNodes(audioCtx as never, 'AudioWorkletNode' as never)).toHaveLength(1);
    expect(node()?.name).toBe(ENGINE_PROCESSOR);
    const [toStore, transfer] = node()?.port.postMessage.mock.calls[0] ?? [];
    expect(toStore).toEqual({ port: expect.any(Object) });
    expect(transfer).toEqual([toStore.port]);
    expect(toStore.port).not.toBe(worker()?.postMessage.mock.calls[0][0].port);
    // nothing else at rest
    expect(posts()).toHaveLength(1);
  });

  it('sends the latest frames of a table set before it was ready, copied and transferred', async () => {
    const { engine, builds, worker } = setup();
    engine.setTable('osc1', [saw]);
    engine.setTable('osc1', [saw, sine]);
    await flush();
    expect(builds()).toEqual([
      { table: 'osc1', version: 2, frames: [Float32Array.from(saw), Float32Array.from(sine)], morph: false },
    ]);
    const [message, transfer] = worker()?.postMessage.mock.calls[1] ?? [];
    expect(transfer).toEqual(message.frames.map(({ buffer }: Float32Array) => buffer));
  });

  it('numbers the versions of each table', async () => {
    const { engine, builds } = setup();
    await flush();
    engine.setTable('osc1', [saw]);
    engine.setTable('osc2', [sine]);
    engine.setTable('osc1', [sine]);
    expect(builds().map(({ table, version }) => [table, version])).toEqual([
      ['osc1', 1],
      ['osc2', 1],
      ['osc1', 2],
    ]);
  });

  it('removes a table through the worker', async () => {
    const { engine, worker } = setup();
    await flush();
    engine.setTable('osc1', [saw]);
    engine.removeTable('osc1');
    expect(worker()?.postMessage).toHaveBeenLastCalledWith({ table: 'osc1', version: 2, remove: true });
  });

  it('makes a voice once ready: its note on and the automation of its params as events, in f32', async () => {
    const { engine, posts, events } = setup();
    await flush();
    const voice = engine.createVoice(NOTE, { frequency: 220.1, gain1: 0.5 });
    expect(voice?.id).toBe(1);
    voice?.params.gate.cancelScheduledValues(1.5);
    voice?.params.gate.setValueAtTime(2.1, 1.5);
    voice?.params.gain1.setTargetAtTime(0.3, 1.5, 0.0033);
    voice?.params.frequency.exponentialRampToValueAtTime(440, 2);
    const other = engine.createVoice(NOTE, {});
    engine.setRoutes([1, 2], [{ source: 1, param: 'gain1', amount: 0.5, min: 0, max: 1 }]);
    engine.setFilter([2], null);
    // the knobs of a module (the noise) to the voices that play it, none: no event
    engine.setKnobs([1], 'noise', { level: 0.5, pan: -0.25, cents: 700 });
    engine.setKnobs([], 'noise', { level: 1, pan: 0, cents: 0 });
    // a microtask sends the events of the task, in one message
    expect(events()).toEqual([]);
    await Promise.resolve();
    expect(posts().filter((message) => 'events' in message)).toHaveLength(1);
    expect(events()).toEqual([
      { kind: 'on', voice: 1, options: NOTE, params: { frequency: Math.fround(220.1), gain1: 0.5 } },
      { kind: 'cancel', voice: 1, param: 'gate', time: 1.5 },
      { kind: 'set', voice: 1, param: 'gate', value: Math.fround(2.1), time: 1.5 },
      { kind: 'target', voice: 1, param: 'gain1', value: Math.fround(0.3), time: 1.5, constant: 0.0033 },
      { kind: 'ramp', voice: 1, param: 'frequency', value: 440, time: 2 },
      { kind: 'on', voice: 2, options: NOTE, params: {} },
      {
        kind: 'routes',
        voices: [1, 2],
        routes: [{ source: 1, param: 'gain1', amount: 0.5, min: 0, max: 1 }],
      },
      { kind: 'filter', voices: [2], filter: null },
      { kind: 'knobs', voices: [1], module: 'noise', values: { level: 0.5, pan: -0.25, cents: 700 } },
    ]);
    expect(other?.id).toBe(2);
  });

  it('tells a voice its late start and its end from the reports of the node; an ended voice is sent nothing', async () => {
    const { engine, report, events } = setup();
    await flush();
    const voice = engine.createVoice(NOTE, {});
    const [onStarted, onEnded] = [jest.fn(), jest.fn()];
    Object.assign(voice ?? {}, { onStarted, onEnded });
    report({ started: [[1, 140, 128]], ended: [1] });
    expect(onStarted).toHaveBeenCalledWith(140, 128);
    expect(onStarted.mock.invocationCallOrder[0]).toBeLessThan(onEnded.mock.invocationCallOrder[0]);
    // once
    report({ ended: [1] });
    expect(onEnded).toHaveBeenCalledTimes(1);
    voice?.params.gate.setValueAtTime(2, 1);
    await Promise.resolve();
    expect(events().map(({ kind }) => kind)).toEqual(['on']);
  });

  it('without AudioWorklet: unsupported as the node of the engine, no voices', async () => {
    withoutAudioWorklet();
    const { statuses, engine, core } = setup();
    await flush();
    expect(core.$status.value).toBe('unsupported');
    expect(statuses).toEqual(['unsupported']);
    expect(WorkerStub.created).toHaveLength(0);
    expect(
      engine.createVoice(
        { osc: [], start: 0, envelopes: [], envStart: 0, phrase: 0, routes: [], filter: null },
        {}
      )
    ).toBeNull();
  });

  it('without Worker: unsupported whatever the node is (it plays its chain all the same), no voices', async () => {
    Object.assign(globalThis, { Worker: undefined });
    const { statuses, engine, core, node, posts } = setup();
    expect(statuses).toEqual(['unsupported']);
    await flush();
    expect(core.$status.value).toBe('ready');
    expect(engine.$status.value).toBe('unsupported');
    expect(statuses).not.toContain('ready');
    // no store to send a table to, no port for the node
    engine.setTable('osc1', [saw]);
    expect(engine.$tables.value).toEqual({});
    expect(node()).toBeDefined();
    expect(posts()).toEqual([]);
    expect(
      engine.createVoice(
        { osc: [], start: 0, envelopes: [], envStart: 0, phrase: 0, routes: [], filter: null },
        {}
      )
    ).toBeNull();
  });

  it('without MessageChannel (and none passed): unsupported', () => {
    const audioCtx = new AudioContext();
    const engine = createWavetableEngine(createEngineNode(audioCtx));
    expect(engine.$status.value).toBe('unsupported');
  });

  it('a module that fails to load: failed; retry loads it again and sends the tables', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { engine, statuses, addModule, builds } = setup({ failFirstLoad: true });
    engine.setTable('osc1', [saw]);
    await flush();
    expect(statuses).toEqual(['loading', 'failed']);
    expect(error).toHaveBeenCalledWith('The engine worklet failed', expect.any(Error));
    expect(
      engine.createVoice(
        { osc: [], start: 0, envelopes: [], envStart: 0, phrase: 0, routes: [], filter: null },
        {}
      )
    ).toBeNull();

    engine.retry();
    expect(workletLoads(addModule, 'engine')).toBe(2);
    await flush();
    expect(statuses).toEqual(['loading', 'failed', 'loading', 'ready']);
    expect(builds()).toEqual([expect.objectContaining({ table: 'osc1', version: 1 })]);
  });

  it('an error of the worker fails the node of the engine; a node that fails: failed too, the worker terminated', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { core, engine, statuses, worker, node } = setup();
    await flush();
    const first = worker();
    const stub = node();
    const event = new Event('error');
    first?.onerror?.(event);
    expect(statuses.at(-1)).toBe('failed');
    expect(first?.terminate).toHaveBeenCalled();
    // the whole node: its processor stopped, the chain with it
    expect(core.$status.value).toBe('failed');
    expect(error).toHaveBeenCalledWith('The engine worklet failed', event);
    expect(stub?.port.postMessage).toHaveBeenLastCalledWith({ stop: true });
    expect(stub?.disconnect).toHaveBeenCalled();

    engine.retry();
    await flush();
    expect(statuses.at(-1)).toBe('ready');
    expect(worker()).not.toBe(first);
    // (the worker of before is not heard any more)
    first?.onerror?.(new Event('error'));
    expect(statuses.at(-1)).toBe('ready');
    node()?.onprocessorerror?.(new ErrorEvent('processorerror'));
    expect(statuses.at(-1)).toBe('failed');
    expect(worker()?.terminate).toHaveBeenCalled();
  });

  it('stays ready when a version fails to build: only its table keeps the one before', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { engine, statuses, worker } = setup();
    engine.setTable('osc1', [saw]);
    engine.setTable('osc2', [sine]);
    await flush();
    worker()?.onmessage?.({ data: { failed: 'osc1', version: 1, reason: 'RangeError' } } as MessageEvent);
    expect(error).toHaveBeenCalled();
    expect(statuses).toEqual(['loading', 'ready']);
    expect(worker()?.terminate).not.toHaveBeenCalled();
    expect(
      engine.createVoice(
        { osc: [], start: 0, envelopes: [], envStart: 0, phrase: 0, routes: [], filter: null },
        {}
      )
    ).not.toBeNull();
  });

  it('stays ready when a voice fails: the node tells it ended, the synth takes only that voice off', async () => {
    const { engine, statuses, worker, report } = setup();
    await flush();
    const voice = engine.createVoice(
      { osc: [], start: 0, envelopes: [], envStart: 0, phrase: 0, routes: [], filter: null },
      {}
    );
    const onEnded = jest.fn();
    Object.assign(voice ?? {}, { onEnded });
    report({ ended: [voice?.id] });
    expect(onEnded).toHaveBeenCalled();
    expect(statuses).toEqual(['loading', 'ready']);
    expect(worker()?.terminate).not.toHaveBeenCalled();
    expect(
      engine.createVoice(
        { osc: [], start: 0, envelopes: [], envStart: 0, phrase: 0, routes: [], filter: null },
        {}
      )
    ).not.toBeNull();
  });

  it('fails when the node of the engine fails: it stops, every voice ends; retry makes it again', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { engine, statuses, node, events } = setup();
    await flush();
    const first = node();
    const voice = engine.createVoice(NOTE, {});
    const onEnded = jest.fn();
    Object.assign(voice ?? {}, { onEnded });
    first?.onprocessorerror?.(new ErrorEvent('processorerror'));
    expect(statuses.at(-1)).toBe('failed');
    expect(onEnded).toHaveBeenCalled();
    expect(first?.port.postMessage).toHaveBeenCalledWith({ stop: true });
    expect(first?.disconnect).toHaveBeenCalled();
    // (the events of the task are dropped with it)
    await Promise.resolve();
    expect(events(first)).toEqual([]);

    engine.retry();
    await flush();
    expect(statuses.at(-1)).toBe('ready');
    expect(node()).not.toBe(first);
    expect(engine.createVoice(NOTE, {})?.id).toBe(2);
  });

  it('sends the pitch bend to the node, one event for every voice; a node made again takes it', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { engine, node, events } = setup();
    await flush();
    const first = node();
    engine.setBend(-350);
    await Promise.resolve();
    expect(events(first)).toEqual([{ kind: 'bend', cents: -350 }]);

    first?.onprocessorerror?.(new ErrorEvent('processorerror'));
    engine.retry();
    await flush();
    expect(node()).not.toBe(first);
    expect(events()).toEqual([{ kind: 'bend', cents: -350, instantly: true }]);
  });

  it('a node made at rest takes no bend', async () => {
    const { node, events } = setup();
    await flush();
    await Promise.resolve();
    expect(node()).toBeDefined();
    expect(events()).toEqual([]);
  });

  it('the LFOs go to the node of the engine: made with the last ones, every table with them, then told them only while a voice reads one', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { engine, node, events, report } = setup();
    const wire = (change: Partial<LfoWire> = {}): LfoWire => ({
      mode: RETRIG,
      delay: 0,
      rise: 0,
      smooth: 0,
      phase: 0,
      anchor: { time: 0, phase: 0, period: 0.5 },
      ...change,
    });
    const [sine, square] = [lfoTable('sine'), lfoTable('square')];
    // before it is ready: kept, the tables of the states before taken on; the node is made with them
    engine.setLfos({ at: 0.01, lfos: [wire({ table: sine }), wire({ table: sine }), wire(), wire()] });
    engine.setLfos({ at: 0.02, lfos: [wire({ delay: 1 }), wire({ table: square }), wire(), wire()] });
    await flush();
    const first = node();
    expect(first?.options.processorOptions.lfos).toEqual({
      at: 0,
      instantly: true,
      lfos: [wire({ delay: 1, table: sine }), wire({ table: square }), wire(), wire()],
    });
    expect(events(first)).toEqual([]);
    // ready, no voice reads an LFO: kept
    engine.setLfos({ at: 1.5, lfos: [wire({ phase: 0.5 }), wire(), wire(), wire()] });
    await Promise.resolve();
    expect(events(first)).toEqual([]);
    // a voice with a route of an LFO: the LFOs as they are before it, then every state as it comes (a message
    // of its own, at once: before the events of the task)
    const lfoRoute = { source: 4, param: 'gain1', amount: 0.5, min: 0, max: 1 };
    const voice = engine.createVoice({ ...NOTE, routes: [lfoRoute] }, {});
    engine.setLfos({ at: 2, lfos: [wire({ phase: 0.25 }), wire(), wire(), wire()] });
    await Promise.resolve();
    expect(events(first)).toEqual([
      {
        kind: 'lfos',
        at: 0,
        instantly: true,
        lfos: [wire({ phase: 0.5, table: sine }), wire({ table: square }), wire(), wire()],
      },
      { kind: 'lfos', at: 2, lfos: [wire({ phase: 0.25 }), wire(), wire(), wire()] },
      expect.objectContaining({ kind: 'on', voice: voice?.id }),
    ]);
    // its routes read none: kept; a route of an LFO again: the LFOs as they are first; ended: kept
    engine.setRoutes([voice?.id ?? 0], []);
    engine.setLfos({ at: 3, lfos: [wire({ phase: 0.75 }), wire(), wire(), wire()] });
    engine.setRoutes([voice?.id ?? 0], [lfoRoute]);
    report({ ended: [voice?.id] });
    engine.setLfos({ at: 4, lfos: [wire({ phase: 0.1 }), wire(), wire(), wire()] });
    await Promise.resolve();
    expect(events(first).slice(3)).toEqual([
      {
        kind: 'lfos',
        at: 0,
        instantly: true,
        lfos: [wire({ phase: 0.75, table: sine }), wire({ table: square }), wire(), wire()],
      },
      { kind: 'routes', voices: [voice?.id], routes: [] },
      { kind: 'routes', voices: [voice?.id], routes: [lfoRoute] },
    ]);

    // a node made again starts with the last ones; no voice reads one any more: it is told none
    const reader = engine.createVoice({ ...NOTE, routes: [lfoRoute] }, {});
    expect(reader).not.toBeNull();
    first?.onprocessorerror?.(new ErrorEvent('processorerror'));
    engine.retry();
    await flush();
    expect(node()).not.toBe(first);
    expect(node()?.options.processorOptions.lfos).toEqual({
      at: 0,
      instantly: true,
      lfos: [wire({ phase: 0.1, table: sine }), wire({ table: square }), wire(), wire()],
    });
    engine.setLfos({ at: 5, lfos: [wire({ phase: 0.2 }), wire(), wire(), wire()] });
    expect(events()).toEqual([]);
  });

  it('retry does nothing unless it failed', async () => {
    const { engine, addModule } = setup();
    engine.retry();
    await flush();
    engine.retry();
    expect(workletLoads(addModule, 'engine')).toBe(1);
  });

  it("destroy terminates the worker and completes the status; the node is the engine's to stop", async () => {
    const { core, engine, worker, node, events } = setup();
    await flush();
    const complete = jest.fn();
    engine.$status.subscribe({ complete });
    engine.$tables.subscribe({ complete });
    const voice = engine.createVoice(NOTE, {});
    const onEnded = jest.fn();
    Object.assign(voice ?? {}, { onEnded });
    const stub = node();
    engine.destroy();
    expect(worker()?.terminate).toHaveBeenCalled();
    // (the synth is gone too: no voice is told ended)
    expect(onEnded).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(2);
    // the events of the task are dropped
    await Promise.resolve();
    expect(events(stub)).toEqual([]);
    expect(stub?.port.postMessage).not.toHaveBeenCalledWith({ stop: true });
    core.destroy();
    expect(stub?.port.postMessage).toHaveBeenLastCalledWith({ stop: true });
    expect(stub?.disconnect).toHaveBeenCalled();
    expect(onEnded).not.toHaveBeenCalled();
  });

  describe('the state of each table', () => {
    it('sending, then stored or refused by the store; an answer for a version before the latest is late', async () => {
      const { engine, ack, report } = setup();
      engine.setTable('osc1', [saw]);
      engine.setTable('osc2', [sine]);
      // (sent once ready)
      expect(engine.$tables.value).toEqual({});
      await flush();
      expect(engine.$tables.value).toEqual({ osc1: 'sending', osc2: 'sending' });
      ack('osc1', 1);
      report({ refused: 'osc2', version: 1 });
      expect(engine.$tables.value).toEqual({ osc1: 'stored', osc2: 'refused' });
      engine.setTable('osc1', [sine]);
      ack('osc1', 1);
      expect(engine.$tables.value['osc1']).toBe('sending');
    });

    it('a version that failed to build: failed; removed, a table has no state', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { engine, worker } = setup();
      engine.setTable('osc1', [saw]);
      await flush();
      worker()?.onmessage?.({ data: { failed: 'osc1', version: 1, reason: 'RangeError' } } as MessageEvent);
      expect(engine.$tables.value).toEqual({ osc1: 'failed' });
      engine.removeTable('osc1');
      expect(engine.$tables.value).toEqual({});
    });

    it('none once the engine failed: the store is gone with them; retry sends them all again', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { engine, ack, worker, statuses } = setup();
      engine.setTable('osc1', [saw]);
      engine.setTable('osc2', [sine]);
      await flush();
      ack('osc1', 1);
      expect(engine.$tables.value).toEqual({ osc1: 'stored', osc2: 'sending' });
      const states: Record<string, string>[] = [];
      engine.$tables.subscribe((tables) => states.push(tables));
      worker()?.onerror?.(new Event('error'));
      expect(statuses.at(-1)).toBe('failed');
      expect(engine.$tables.value).toEqual({});
      // (a table set meanwhile has none either: no store to send it to)
      engine.setTable('osc1', [sine]);
      expect(engine.$tables.value).toEqual({});

      engine.retry();
      await flush();
      expect(engine.$tables.value).toEqual({ osc1: 'sending', osc2: 'sending' });
      expect(states.slice(0, 2)).toEqual([{ osc1: 'stored', osc2: 'sending' }, {}]);
    });

    it('retryTable sends a refused or failed version again, nothing else', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { engine, builds, report, worker } = setup();
      engine.setTable('osc1', [saw]);
      engine.setTable('osc2', [sine]);
      await flush();
      engine.retryTable('osc1');
      expect(builds()).toHaveLength(2);
      report({ refused: 'osc1', version: 1 });
      worker()?.onmessage?.({ data: { failed: 'osc2', version: 1, reason: 'RangeError' } } as MessageEvent);
      engine.retryTable('osc1');
      engine.retryTable('osc2');
      expect(builds().slice(2)).toEqual([
        expect.objectContaining({ table: 'osc1', version: 1 }),
        expect.objectContaining({ table: 'osc2', version: 1 }),
      ]);
      expect(engine.$tables.value).toEqual({ osc1: 'sending', osc2: 'sending' });
    });

    it('memory freed by the store sends a refused version again once; refused again, it waits for Retry', async () => {
      const { engine, builds, report, ack } = setup();
      engine.setTable('osc1', [saw]);
      engine.setTable('osc2', [sine]);
      await flush();
      ack('osc2', 1);
      report({ refused: 'osc1', version: 1 });
      report({ freedBytes: 1024 });
      expect(builds()).toHaveLength(3);
      expect(builds()[2]).toMatchObject({ table: 'osc1', version: 1 });
      report({ refused: 'osc1', version: 1 });
      report({ freedBytes: 1024 });
      expect(builds()).toHaveLength(3);
      expect(engine.$tables.value['osc1']).toBe('refused');
      // Retry, or a new version, may go once more
      engine.retryTable('osc1');
      report({ refused: 'osc1', version: 1 });
      report({ freedBytes: 1024 });
      expect(builds()).toHaveLength(5);
      ack('osc1', 1);
      expect(engine.$tables.value).toEqual({ osc1: 'stored', osc2: 'stored' });
    });
  });

  describe('pending tables', () => {
    it('lists the tables until the store acknowledges their latest version', async () => {
      const { engine, ack } = setup();
      engine.setTable('osc1', [saw]);
      engine.setTable('osc2', [sine]);
      await flush();
      expect(engine.pending()).toEqual(['osc1', 'osc2']);
      ack('osc1', 1);
      expect(engine.pending()).toEqual(['osc2']);
      engine.setTable('osc1', [sine]);
      // an ack of an older version doesn't count
      ack('osc1', 1);
      expect(engine.pending()).toEqual(['osc1', 'osc2']);
      ack('osc1', 2);
      ack('osc2', 1);
      expect(engine.pending()).toEqual([]);
    });

    it('numbers a table set again after its removal on from it: the store takes it over the version it holds', async () => {
      const { engine, ack, builds, worker } = setup();
      await flush();
      engine.setTable('osc1', [saw]);
      engine.setTable('osc1', [sine]);
      engine.removeTable('osc1');
      expect(worker()?.postMessage).toHaveBeenLastCalledWith({ table: 'osc1', version: 3, remove: true });
      engine.setTable('osc1', [saw]);
      expect(builds().at(-1)).toMatchObject({ table: 'osc1', version: 4 });
      // the ack of the removal doesn't count, the one of version 4 does
      ack('osc1', 3);
      expect(engine.pending()).toEqual(['osc1']);
      ack('osc1', 4);
      expect(engine.pending()).toEqual([]);
    });

    it('forgets a removed table, and its ack', async () => {
      const { engine, ack } = setup();
      engine.setTable('osc1', [saw]);
      await flush();
      engine.removeTable('osc1');
      ack('osc1', 2);
      expect(engine.pending()).toEqual([]);
      engine.setTable('osc1', [sine]);
      expect(engine.pending()).toEqual(['osc1']);
    });

    it('sends the tables again after a failure: pending until acknowledged again', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { engine, ack, worker, node, report } = setup();
      engine.setTable('osc1', [saw]);
      await flush();
      ack('osc1', 1);
      const failed = node();
      worker()?.onerror?.(new Event('error'));
      engine.retry();
      await flush();
      expect(engine.pending()).toEqual(['osc1']);
      // the store of the failed node is not heard anymore
      report({ stored: 'osc1', version: 1 }, failed);
      expect(engine.pending()).toEqual(['osc1']);
      ack('osc1', 1);
      expect(engine.pending()).toEqual([]);
    });
  });

  describe('stats', () => {
    const worklet = { tables: 1, versions: 1, bytes: 1024, voices: 2, frame: 128 };
    const builder = { pending: 0, pooled: 1, pool: 1024, builds: 1, lastMs: 3, totalMs: 3, maxMs: 3 };

    it('null unless ready', async () => {
      const { engine, core } = setup();
      expect(await engine.stats()).toBeNull();
      // (its module would load without AudioWorkletNode)
      engine.destroy();
      core.destroy();
      withoutAudioWorklet();
      expect(await setup().engine.stats()).toBeNull();
    });

    it('asks the store and the worker for their counters', async () => {
      const { engine, node, worker, answer } = setup();
      await flush();
      const asked = engine.stats();
      expect(node()?.port.postMessage).toHaveBeenLastCalledWith({ stats: true });
      expect(worker()?.postMessage).toHaveBeenLastCalledWith({ stats: true });
      answer(worklet, builder);
      expect(await asked).toEqual({ worklet, worker: builder });
    });

    it("null when an answer doesn't come in time; a late one doesn't answer the next request", async () => {
      const { engine, answer } = setup();
      await flush();
      expect(await engine.stats(5)).toBeNull();
      const next = engine.stats();
      answer({ ...worklet, frame: 1 }, builder);
      answer({ ...worklet, frame: 2 }, builder);
      expect((await next)?.worklet.frame).toBe(2);
    });

    it('a failure answers null', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { engine, worker } = setup();
      await flush();
      const asked = engine.stats();
      worker()?.onerror?.(new Event('error'));
      expect(await asked).toBeNull();
    });
  });

  it('a module that loads after the engine and its node are destroyed creates nothing', async () => {
    const { core, engine, node } = setup();
    const workers = WorkerStub.created.length;
    engine.destroy();
    core.destroy();
    await flush();
    expect(WorkerStub.created).toHaveLength(workers);
    expect(node()).toBeUndefined();
  });
});
