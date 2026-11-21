import { BehaviorSubject } from 'rxjs';
import { errorMessage } from '../../../common/services/analytics';
import { workletUrl } from '../../fx/effects/load-worklet';
import type { EngineHost } from '../engine/engine-host';
import type { EngineReport } from '../engine/engine-params';
import type { LfosState } from '../lfo/lfo-curve';
import { isLfoSource } from '../../fx/effects/fx-modulation';
import type {
  BuilderFailedMessage,
  BuilderPortMessage,
  BuilderStats,
  BuilderStatsMessage,
  BuildMessage,
  BuildSampleMessage,
} from './wavetable-builder';
import type {
  KnobsModule,
  StatsRequest,
  StoreStatsMessage,
  StoreTableMessage,
  VoiceEvent,
  VoiceFilterOptions,
  VoiceModuleKnobs,
  VoiceOptions,
  VoiceRoute,
  VoiceVelocity,
} from './voice-options';
import { VOICE_PARAMETERS, VoiceParam } from './wavetable-osc-params';

// the worker (wavetable.worker.ts), bundled by `npm run worklets` into assets/worklets/
export const WAVETABLE_WORKER = 'wavetable-worker';

// loading: the module of the engine is being added; unsupported: no AudioWorklet (http on a LAN IP, old Safari)
// or no Worker; failed: the module, the node or the worker failed, retry() loads it again (a voice that fails
// only ends: the synth takes it off). Without it the synth doesn't play: there is no native fallback
export type WavetableStatus = 'loading' | 'ready' | 'unsupported' | 'failed';

// the latest version of a table: on its way to the store (built, sent in chunks), stored (new notes play it),
// refused by the store (no memory for it) or failed to build in the worker; refused and failed: the version
// before it plays on, retryTable() sends it again
export type TableState = 'sending' | 'stored' | 'refused' | 'failed';

// a param of a voice as the synth automates it: the calls of an AudioParam it makes, each sent to the node
// as an event (its value in f32, as an AudioParam keeps it), worked out there by the formulas of the spec
export interface ParamAutomation {
  setValueAtTime: (value: number, time: number) => void;
  setTargetAtTime: (value: number, time: number, constant: number) => void;
  exponentialRampToValueAtTime: (value: number, time: number) => void;
  cancelScheduledValues: (time: number) => void;
}

// a voice of the engine node: its params; the node tells its start (the frames it started and was scheduled at,
// once) and its end (released to 0, stolen, failed, or the node failed)
export interface VoiceHandle {
  readonly id: number;
  readonly params: Record<VoiceParam, ParamAutomation>;
  onStarted: ((started: number, scheduled: number) => void) | null;
  onEnded: (() => void) | null;
}

// the worker and the channel to the store (jsdom has neither: the specs pass stubs)
export interface WavetableEngineDependencies {
  createWorker?: (url: string) => Worker;
  createChannel?: () => MessageChannel;
}

const defaultChannel = () => new MessageChannel();

// the counters of the store, the voices and the worker (the perf test hook)
export interface WavetableEngineStats {
  worklet: StoreStatsMessage['stats'];
  worker: BuilderStats;
}
type Waiter<T> = (answer: T | null) => void;

// the wavetable oscillator of a core, one for both oscillators, in the node of the engine (`engine`: engine-host.ts,
// the worklet node or the engine of a render; it has the store of the tables and the voices of every note, the chain
// after them): it
// makes the worker that builds the levels of the tables, connected to the store by a MessageChannel: the levels go
// from the worker to the audio thread, transferred, never through the main thread. setTable() sends a new version
// of a table (the latest frames are kept: they are sent once it is ready, and again after a retry); createVoice()
// makes the voice of a note, null until it is ready (a note played meanwhile is not played later). What the voices
// do goes to the node as events, those of a task in one message (a microtask sends them), in the order they were
// made
export const createWavetableEngine = (
  engine: EngineHost,
  {
    createWorker = (url) => new Worker(url),
    createChannel = typeof MessageChannel === 'undefined' ? undefined : defaultChannel,
  }: WavetableEngineDependencies = {}
) => {
  // (jsdom has neither: the engine plays its chain all the same)
  const supported = typeof Worker !== 'undefined' && createChannel !== undefined;
  const $status = new BehaviorSubject<WavetableStatus>('loading');
  const $tables = new BehaviorSubject<Record<string, TableState>>({});
  // (a sample of the noise: its channels at its rate)
  const tables = new Map<
    string,
    | { version: number; frames: ArrayLike<number>[]; morph: boolean }
    | { version: number; sample: { channels: ArrayLike<number>[]; rate: number } }
  >();
  // the tables whose refused version was sent again once the store freed memory (once a version: refused again,
  // it waits for retryTable)
  const retried = new Set<string>();
  // the last version of each table, kept after a removal: versions only grow, so a table set again after it was
  // removed is newer than the version the store may still hold (the worker replaces a waiting removal with it)
  const versions = new Map<string, number>();
  const nextVersion = (table: string) => {
    const version = (versions.get(table) ?? 0) + 1;
    versions.set(table, version);
    return version;
  };
  // whether the node is there with the worker of its store
  let live = false;
  let destroyed = false;
  let worker: Worker | null = null;
  // the voices playing, by id (unique in the engine: the node of a retry starts empty), and the events of this
  // task
  const handles = new Map<number, VoiceHandle>();
  let lastVoice = 0;
  let events: VoiceEvent[] = [];
  // the pitch bend of the voices (cents): a node made again (Retry) takes it at once
  let bend = 0;
  // the LFOs (every state merged: a node made again takes them at once), sent on only while a voice reads one:
  // the voices whose routes read an LFO
  const lfoVoices = new Set<number>();
  const tellLfos = () => engine.lfos.use('voices', lfoVoices.size > 0);
  const readsLfo = (routes: VoiceRoute[]) => routes.some(({ source }) => isLfoSource(source));
  let sending = false;
  // the version of each table the store has acknowledged (when it is the latest, new voices play it)
  const stored = new Map<string, number>();
  // the answers to stats requests, in the order they were asked (each port answers in order)
  const storeWaiters: Waiter<StoreStatsMessage['stats']>[] = [];
  const workerWaiters: Waiter<BuilderStats>[] = [];

  // the events of this task to the engine node, in one message
  const flush = () => {
    sending = false;
    if (events.length === 0) return;
    const message = { events };
    events = [];
    if (live) engine.post(message);
  };
  const enqueue = (event: VoiceEvent) => {
    events.push(event);
    if (sending) return;
    sending = true;
    queueMicrotask(flush);
  };

  // the node is gone (it frees its voices: their tables go back to the store); `end`: every voice is ended (the
  // synth lets their keys go)
  const teardown = (end: boolean) => {
    live = false;
    worker?.terminate();
    worker = null;
    events = [];
    const ended = [...handles.values()];
    handles.clear();
    lfoVoices.clear();
    tellLfos();
    if (end) ended.forEach((handle) => handle.onEnded?.());
    stored.clear();
    storeWaiters.splice(0).forEach((answer) => answer(null));
    workerWaiters.splice(0).forEach((answer) => answer(null));
    // the store is gone with every table in it: none has a state until the engine is ready again (every one is
    // sent then), as before it first was (a table on its way would wait for an answer that never comes)
    if (end && Object.keys($tables.value).length > 0) $tables.next({});
  };

  // the starts and the ends of a block of the engine node
  const report = (data: EngineReport) => {
    const { started, ended } = data;
    // the answers of the store: its counters (the perf build), the memory it freed (a refused version is sent
    // again, once), a version refused or stored
    if (data.stats) storeWaiters.shift()?.(data.stats);
    if (data.freedBytes !== undefined) retryRefused();
    if (data.refused !== undefined && data.version !== undefined)
      answer(data.refused, data.version, 'refused');
    if (data.stored !== undefined && data.version !== undefined) {
      if (tables.get(data.stored)?.version === data.version) stored.set(data.stored, data.version);
      answer(data.stored, data.version, 'stored');
    }
    if (!started && !ended) return;
    started?.forEach(([id, at, scheduled]) => handles.get(id)?.onStarted?.(at, scheduled));
    ended?.forEach((id) => {
      const handle = handles.get(id);
      handles.delete(id);
      lfoVoices.delete(id);
      handle?.onEnded?.();
    });
    tellLfos();
  };

  // the params of voice `id`: their calls as events (none once it has ended)
  const automation = (id: number, param: VoiceParam): ParamAutomation => {
    const automate = (kind: 'set' | 'target' | 'ramp', value: number, time: number, constant?: number) => {
      if (handles.has(id))
        enqueue({
          kind,
          voice: id,
          param,
          value: Math.fround(value),
          time,
          ...(constant !== undefined && { constant }),
        });
    };
    return {
      setValueAtTime: (value, time) => automate('set', value, time),
      setTargetAtTime: (value, time, constant) => automate('target', value, time, constant),
      exponentialRampToValueAtTime: (value, time) => automate('ramp', value, time),
      cancelScheduledValues: (time) => {
        if (handles.has(id)) enqueue({ kind: 'cancel', voice: id, param, time });
      },
    };
  };

  const setState = (table: string, state: TableState | null) => {
    const { [table]: _, ...others } = $tables.value;
    $tables.next(state ? { ...others, [table]: state } : others);
  };
  // an answer for the latest version of a table (one for a version before it is late: not its state)
  const answer = (table: string, version: number, state: TableState) => {
    if (tables.get(table)?.version === version) setState(table, state);
  };

  // the frames (the channels of a sample) are copied into arrays of their own, transferred to the worker
  const send = (table: string) => {
    const entry = tables.get(table);
    if (!worker || !entry) return;
    setState(table, 'sending');
    if ('sample' in entry) {
      const channels = entry.sample.channels.map((channel) => Float32Array.from(channel));
      const message: BuildSampleMessage = {
        table,
        version: entry.version,
        sample: { channels, rate: entry.sample.rate },
      };
      worker.postMessage(
        message,
        channels.map(({ buffer }) => buffer)
      );
      return;
    }
    const frames = entry.frames.map((frame) => Float32Array.from(frame));
    const message: BuildMessage = { table, version: entry.version, frames, morph: entry.morph };
    worker.postMessage(
      message,
      frames.map(({ buffer }) => buffer)
    );
  };

  // the store freed memory: every table whose latest version it refused is sent again, once
  const retryRefused = () =>
    Object.entries($tables.value).forEach(([table, state]) => {
      if (state !== 'refused' || retried.has(table)) return;
      retried.add(table);
      send(table);
    });

  // a node was made: the worker of its store (the port of one end of their channel to each), the bend of now
  const start = () => {
    if (!supported || destroyed) return;
    const created = createWorker(workletUrl(WAVETABLE_WORKER));
    // an error of the worker itself (its script) fails the engine; a version that failed to build only its
    // table: it plays the version before, the engine stays ready
    created.onerror = (event) => {
      if (worker !== created) return;
      engine.report.worker(event, WAVETABLE_WORKER);
      engine.fail(event);
    };
    created.onmessage = ({ data }: MessageEvent<BuilderStatsMessage | BuilderFailedMessage>) => {
      if (worker !== created) return;
      if ('failed' in data) {
        console.error(`The version ${data.version} of the table ${data.failed} failed to build`, data.reason);
        engine.report.failure('table', 'build', { cause: errorMessage(data.reason) });
        answer(data.failed, data.version, 'failed');
        return;
      }
      // (the counters of the perf build)
      if (__PERF__ && data.stats) workerWaiters.shift()?.(data.stats);
    };
    const { port1, port2 } = (createChannel as () => MessageChannel)();
    const toStore: BuilderPortMessage = { port: port1 };
    const toWorker: BuilderPortMessage = { port: port2 };
    engine.post(toStore, [port1]);
    created.postMessage(toWorker, [port2]);
    worker = created;
    live = true;
    if (bend !== 0) enqueue({ kind: 'bend', cents: bend, instantly: true });
  };

  engine.attach({
    start,
    stop: teardown,
    report,
    // (ready: every table to the store of the node)
    status: (status) => {
      const next = supported ? status : 'unsupported';
      if (destroyed) return;
      if ($status.value !== next) $status.next(next);
      if (status === 'ready' && supported) tables.forEach((_, table) => send(table));
    },
  });

  return {
    $status,
    $tables,
    // a new version of the table (the frames of the model, read when it is sent; with a morph the worker
    // expands them to 256: wavetable-frames.ts)
    setTable: (table: string, frames: ArrayLike<number>[], morph = false) => {
      tables.set(table, { version: nextVersion(table), frames, morph });
      retried.delete(table);
      send(table);
    },
    // a new version of a sample of the noise (its channels at `rate`, read when it is sent): a table of the store
    // as the oscillators' are (its state in $tables, retryTable, removeTable); the worker builds its levels
    setSample: (table: string, channels: ArrayLike<number>[], rate: number) => {
      tables.set(table, { version: nextVersion(table), sample: { channels, rate } });
      retried.delete(table);
      send(table);
    },
    // the latest version of a table the store refused or the worker failed to build, sent again (a refusal after
    // it is sent again once more when the store frees memory)
    retryTable: (table: string) => {
      const state = $tables.value[table];
      if (state !== 'refused' && state !== 'failed') return;
      retried.delete(table);
      send(table);
    },
    // the table is gone (its oscillator was destroyed): the store frees it once no voice plays it
    removeTable: (table: string) => {
      const entry = tables.get(table);
      tables.delete(table);
      stored.delete(table);
      retried.delete(table);
      setState(table, null);
      if (!entry) return;
      const version = nextVersion(table);
      if (!worker) return;
      const message: StoreTableMessage = { table, version, remove: true };
      worker.postMessage(message);
    },
    // the voice of a note, its options and the values of its params at the note on (in f32); a voice that fails
    // ends alone (the synth takes it off), the store, the worker and the other voices play on
    createVoice: (options: VoiceOptions, values: Partial<Record<VoiceParam, number>>): VoiceHandle | null => {
      if ($status.value !== 'ready' || destroyed) return null;
      const id = ++lastVoice;
      const params = Object.fromEntries(
        VOICE_PARAMETERS.map(({ name }) => [name, automation(id, name as VoiceParam)])
      ) as Record<VoiceParam, ParamAutomation>;
      const handle: VoiceHandle = { id, params, onStarted: null, onEnded: null };
      handles.set(id, handle);
      const initial = Object.fromEntries(
        Object.entries(values).map(([name, value]) => [name, Math.fround(value)])
      ) as Partial<Record<VoiceParam, number>>;
      // (the LFOs before the voice that reads them)
      if (readsLfo(options.routes)) lfoVoices.add(id);
      tellLfos();
      enqueue({ kind: 'on', voice: id, options, params: initial });
      return handle;
    },
    // the routes, the filter, the velocity of playing voices changed (one event for them all)
    setRoutes: (ids: number[], routes: VoiceRoute[]) => {
      if (ids.length === 0) return;
      const reads = readsLfo(routes);
      ids.forEach((id) => (reads ? lfoVoices.add(id) : lfoVoices.delete(id)));
      tellLfos();
      enqueue({ kind: 'routes', voices: ids, routes });
    },
    setFilter: (ids: number[], filter: VoiceFilterOptions | null) => {
      if (ids.length > 0) enqueue({ kind: 'filter', voices: ids, filter });
    },
    // (from `time`, seconds of the context: a note of the track is sent ahead of its time; none: now)
    setVelocity: (ids: number[], velocity: VoiceVelocity, time?: number) => {
      if (ids.length > 0)
        enqueue({ kind: 'velocity', voices: ids, velocity, ...(time !== undefined && { time }) });
    },
    // new knobs of a module of playing voices (those no param carries: the noise's)
    setKnobs: <M extends KnobsModule>(ids: number[], module: M, values: VoiceModuleKnobs[M]) => {
      if (ids.length > 0) enqueue({ kind: 'knobs', voices: ids, module, values } as VoiceEvent);
    },
    // the pitch bend of every voice (cents on top of their detunes), new ones start with it: the node glides there
    setBend: (cents: number) => {
      bend = cents;
      enqueue({ kind: 'bend', cents });
    },
    // the LFOs of every voice from `state.at` on (their tables only when they changed), while a voice reads one
    // (the LFOs as they are first, once one does); a node made later (ready, Retry) takes the last ones at once
    setLfos: (state: LfosState) => engine.lfos.take(state),
    // the events of this task to the node now (the specs)
    flush,
    // the tables whose latest version the store hasn't acknowledged yet (a note meanwhile plays the previous
    // version, or a sine for a new table); the perf build only
    pending: () =>
      __PERF__
        ? [...tables].filter(([table, { version }]) => stored.get(table) !== version).map(([table]) => table)
        : [],
    // the counters of the store, the voices and the worker (the perf build); null unless ready or when an
    // answer doesn't come in time (a late answer still takes its own request: the queues stay in order)
    stats: (timeout = 1000): Promise<WavetableEngineStats | null> => {
      if (!__PERF__ || !live || !worker) return Promise.resolve(null);
      const request: StatsRequest = { stats: true };
      const ask = <T>(waiters: Waiter<T>[], post: () => void) =>
        new Promise<T | null>((resolve) => {
          const timer = setTimeout(() => resolve(null), timeout);
          waiters.push((answer) => {
            clearTimeout(timer);
            resolve(answer);
          });
          post();
        });
      const builder = worker;
      return Promise.all([
        ask(storeWaiters, () => engine.post(request)),
        ask(workerWaiters, () => builder.postMessage(request)),
      ]).then(([worklet, built]) => (worklet && built ? { worklet, worker: built } : null));
    },
    retry: engine.retry,
    destroy: () => {
      destroyed = true;
      teardown(false);
      $status.complete();
      $tables.complete();
    },
  };
};
export type WavetableEngine = ReturnType<typeof createWavetableEngine>;
