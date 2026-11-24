import { BehaviorSubject } from 'rxjs';
import { captureEngineFailure, captureWorkerError, errorMessage } from '../../../common/services/analytics';
import type { FxStatus } from '../../fx/effects/types';
import { MACROS, MacrosState } from '../chain/chain-params';
import { createLfoFeed, LfosState } from '../lfo/lfo-curve';
import { EngineMessage, EngineOptions, EngineReport, LfoReader } from './engine-params';

// what plays in the node: the chain (chain.ts) and the voices with their store (wavetable-engine.ts). Each is told
// the status of the node (the one of now as it attaches), a node that was made (before the status is ready: it
// sends what a new node needs), the node gone (`ended`: it failed; else the engine is destroyed) and what the node
// posts; `options` is its share of the options a node is made with
export interface EngineClient {
  options?: () => Partial<EngineOptions>;
  status?: (status: FxStatus) => void;
  start?: () => void;
  stop?: (ended: boolean) => void;
  report?: (report: EngineReport) => void;
}

// the node of the synth (its failures are reported: analytics.ts), or the engine of a render (its export reports
// what failed in it)
export type EngineKind = 'live' | 'render';
// why a node failed: its module didn't load (or the node couldn't be made), its processor threw, its core trapped
// out of its voices and its stages
type EngineFailReason = 'load' | 'processor' | 'broken';

// what a host reports of the failures of its node and its clients (analytics.ts): a render none
interface EngineReporter {
  failure: typeof captureEngineFailure;
  worker: typeof captureWorkerError;
}
const REPORTERS: Record<EngineKind, EngineReporter> = {
  live: { failure: captureEngineFailure, worker: captureWorkerError },
  render: { failure: () => undefined, worker: () => undefined },
};

// a node whose core trapped out of its voices and its stages is made again this many times at most: what trapped
// is never freed (a free could trap again), the memory of the module is back with the page
export const MAX_REMAKES = 4;

// a node as its host has it: told the messages of the main thread, ended (its engine freed, it plays no more)
export interface EngineLink {
  post: (message: EngineMessage, transfer?: Transferable[]) => void;
  close: () => void;
}
// what a node tells its host: what it posts (`broken`: its core trapped out of its voices and its stages, the node
// is over), that it failed
export interface EngineLinkEvents {
  report: (report: EngineReport) => void;
  fail: (error: unknown) => void;
}
// makes a node of the options of the clients of now
export type MakeEngine = (options: EngineOptions, events: EngineLinkEvents) => EngineLink;
// what makes a node once its module has loaded; null where none can be (no AudioWorklet, no wasm SIMD)
export type LoadEngine = () => Promise<MakeEngine> | null;

// The host of the node of the engine on the main thread: the worklet node of the synth (engine-node.ts), or a core
// a render calls block by block (direct-engine.ts). Until a node exists, or where none can be or its module failed,
// nothing plays (no fallback) and `$status` tells why; retry() loads a failed module again and makes a node of what
// its clients are then.
//
// Everything is told to the node in messages: `post`. The LFOs are told it once (`lfos.take`, by the LFO model
// alone) for the voices and the chain: a half only says whether it reads one. They go to the node only while one of
// them reads an LFO and only for the halves that do (`lfos.use`: a state is a table of 8 KB the audio thread takes
// in; a half that starts to read gets the last ones); a node made later starts with the last ones. So are the levels
// of the macros (`macros.set`, by the synth), to both halves always (four numbers)
export const createEngineHost = (loadEngine: LoadEngine, kind: EngineKind = 'live') => {
  const what = kind === 'live' ? 'The engine worklet' : 'The engine of the render';
  const reporter = REPORTERS[kind];
  const $status = new BehaviorSubject<FxStatus>('loading');
  const clients: EngineClient[] = [];
  let link: EngineLink | undefined;
  let destroyed = false;
  // how many times a node was made again after its core trapped, whether the node of now ended so
  let rebuilds = 0;
  let trapped = false;
  // the load of now: one a failure or a retry left behind makes no node when it settles
  let loads = 0;

  const post = (message: EngineMessage, transfer?: Transferable[]) => link?.post(message, transfer);

  const readers = new Set<LfoReader>();
  const feed = createLfoFeed((lfos) => post({ lfos, readers: [...readers] }));
  // the levels of the macros as the last ones sent have them (a node made later starts with them)
  const macros = new Array<number>(MACROS).fill(0);

  const setStatus = (status: FxStatus) => {
    $status.next(status);
    clients.forEach((client) => client.status?.(status));
  };

  // the node ends (its engine is freed: it keeps its state in the memory of the module until then)
  const drop = (ended: boolean) => {
    const current = link;
    link = undefined;
    current?.close();
    clients.forEach((client) => client.stop?.(ended));
  };

  // `what` (`stage`: 'engine', an effect, 'limiter') failed MAX_REMAKES times
  const spent = (what: string, stage: string) => {
    console.error(`${what} failed ${MAX_REMAKES} times and is not made again: reload the page`);
    reporter.failure('spent', stage);
  };

  // (a node that threw still takes messages: stopped, its engine is freed). No reason: a client failed it, and
  // reported where (the worker of the store: wavetable-engine.ts)
  const fail = (error: unknown, reason?: EngineFailReason, trap?: string) => {
    if (destroyed || $status.value === 'failed') return;
    console.error(`${what} failed`, error);
    if (reason) reporter.failure(reason, 'engine', { message: errorMessage(error), trap });
    loads += 1;
    drop(true);
    setStatus('failed');
  };

  const load = () => {
    const loading = loadEngine();
    if (!loading) {
      setStatus('unsupported');
      return;
    }
    setStatus('loading');
    const own = ++loads;
    loading
      .then((make) => {
        if (destroyed || own !== loads) return;
        const options: EngineOptions = Object.assign(
          {},
          ...clients.map((client) => client.options?.() ?? {})
        );
        const lfos = feed.initial();
        if (lfos) options.lfos = lfos;
        if (macros.some((level) => level !== 0)) options.macros = [...macros];
        // (a node dropped earlier, failed then retried, must not fail or tell the current one)
        const current: EngineLink = make(options, {
          report: (report) => {
            if (link !== current) return;
            // (the core trapped out of its voices and stages: its node is over, as one that threw)
            if (report.broken) {
              trapped = true;
              fail(new Error('The engine core trapped'), 'broken', report.trap);
              return;
            }
            // the warm-up of its module failed; a voice (or a message) trapped: a stage that did is the chain's
            if (report.prewarm !== undefined) reporter.failure('prewarm', 'engine', { trap: report.prewarm });
            if (report.trap !== undefined && !report.failed)
              reporter.failure('trap', 'voice', { trap: report.trap });
            clients.forEach((client) => client.report?.(report));
          },
          fail: (error) => {
            if (link === current) fail(error, 'processor');
          },
        });
        link = current;
        clients.forEach((client) => client.start?.());
        setStatus('ready');
      })
      .catch((error) => {
        if (own === loads) fail(error, 'load');
      });
  };
  load();

  return {
    $status,
    post,
    // a client failed the node (the worker of the store), having reported why
    fail: (error: unknown) => fail(error),
    // what a client reports of its failures (a render: nothing), what failed MAX_REMAKES times
    report: reporter,
    spent,
    attach: (client: EngineClient) => {
      clients.push(client);
      client.status?.($status.value);
    },
    lfos: {
      // `reader` reads an LFO from now on, or no more
      use: (reader: LfoReader, reads: boolean) => {
        const joins = reads && !readers.has(reader) && readers.size > 0;
        if (reads) readers.add(reader);
        else readers.delete(reader);
        feed.use(readers.size > 0);
        // (the feed went on without it: the states it missed, as they are now, for it alone)
        const lfos = joins ? feed.initial() : null;
        if (lfos) post({ lfos, readers: [reader] });
      },
      // a state of the LFOs, told once (the LFO model through the wavetable engine): for every half that reads one
      take: (state: LfosState) => feed.take(state),
    },
    macros: {
      // levels of the macros (null: that macro as it is) for both halves, from `state.at` on
      set: (state: MacrosState) => {
        state.levels.forEach((level, k) => {
          if (level !== null && k < MACROS) macros[k] = level;
        });
        post({ macros: state });
      },
    },
    // loads a failed module again (nothing to do in any other status)
    retry: () => {
      if ($status.value !== 'failed') return;
      if (trapped) {
        if (rebuilds >= MAX_REMAKES) {
          spent('The engine core', 'engine');
          return;
        }
        rebuilds += 1;
        trapped = false;
      }
      load();
    },
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      drop(false);
      $status.complete();
    },
  };
};
export type EngineHost = ReturnType<typeof createEngineHost>;
