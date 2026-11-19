import { BehaviorSubject } from 'rxjs';
import { isWorkletSupported, loadWorklet } from '../../fx/effects/load-worklet';
import type { FxStatus } from '../../fx/effects/types';
import { createLfoFeed, LfosState } from '../lfo/lfo-curve';
import {
  ENGINE_MODULE,
  ENGINE_NODE_OPTIONS,
  ENGINE_PROCESSOR,
  EngineMessage,
  EngineOptions,
  EngineReport,
  LfoReader,
  PROBED_NODE_OPTIONS,
} from './engine-params';

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

// a node whose core trapped out of its voices and its stages is made again this many times at most: what trapped
// is never freed (a free could trap again), the memory of the module is back with the page
export const MAX_REMAKES = 4;
export const spent = (what: string) =>
  console.error(`${what} failed ${MAX_REMAKES} times and is not made again: reload the page`);

// The node of the engine on the main thread (engine.worklet.ts: the voices, the effects, the master gain and the
// limiter in one core) → output, once its module has loaded. Until the node exists, or when the browser has no
// AudioWorklet or no wasm SIMD or the module failed, nothing plays (no fallback) and `$status` tells why; retry()
// loads a failed module again and makes a node of what its clients are then.
//
// Everything is told to the node in messages (no AudioParam): `post`. The LFOs are told it once (`lfos.take`, by
// the LFO model alone) for the voices and the chain: a half only says whether it reads one. They go to the node
// only while one of them reads an LFO and only for the halves that do (`lfos.use`: a state is a table
// of 8 KB the audio thread takes in; a half that starts to read gets the last ones); a node made later starts
// with the last ones
export const createEngineNode = (audioCtx: BaseAudioContext) => {
  const output = audioCtx.createGain();
  const $status = new BehaviorSubject<FxStatus>('loading');
  const clients: EngineClient[] = [];
  let node: AudioWorkletNode | undefined;
  let destroyed = false;
  // how many times a node was made again after its core trapped, whether the node of now ended so
  let rebuilds = 0;
  let trapped = false;
  // the load of now: one a failure or a retry left behind makes no node when it settles
  let loads = 0;
  // where the voices before the effects go (the probe of the perf build)
  let probe: AudioNode | null = null;

  const post = (message: EngineMessage, transfer?: Transferable[]) => {
    if (!node) return;
    if (transfer) node.port.postMessage(message, transfer);
    else node.port.postMessage(message);
  };

  const readers = new Set<LfoReader>();
  const feed = createLfoFeed((lfos) => post({ lfos, readers: [...readers] }));

  const setStatus = (status: FxStatus) => {
    $status.next(status);
    clients.forEach((client) => client.status?.(status));
  };

  // the processor ends (its engine is freed: it keeps its state in the memory of the module until then)
  const drop = (ended: boolean) => {
    const current = node;
    node = undefined;
    if (current) {
      current.port.postMessage({ stop: true } satisfies EngineMessage);
      current.disconnect();
    }
    clients.forEach((client) => client.stop?.(ended));
  };

  // (a processor that threw still takes messages: stopped, its engine is freed)
  const fail = (error: unknown) => {
    if (destroyed || $status.value === 'failed') return;
    console.error('The engine worklet failed', error);
    loads += 1;
    drop(true);
    setStatus('failed');
  };

  const load = () => {
    if (!isWorkletSupported(audioCtx, ENGINE_MODULE)) {
      setStatus('unsupported');
      return;
    }
    setStatus('loading');
    const own = ++loads;
    loadWorklet(audioCtx, ENGINE_MODULE)
      .then(() => {
        if (destroyed || own !== loads) return;
        const processorOptions: EngineOptions = Object.assign(
          {},
          ...clients.map((client) => client.options?.() ?? {})
        );
        const lfos = feed.initial();
        if (lfos) processorOptions.lfos = lfos;
        const current = new AudioWorkletNode(audioCtx, ENGINE_PROCESSOR, {
          ...(__PERF__ ? PROBED_NODE_OPTIONS : ENGINE_NODE_OPTIONS),
          processorOptions,
        });
        node = current;
        // the processor threw: it outputs silence from now on, a retry creates a new one; a node dropped
        // earlier (failed, then retried) must not fail the current one
        current.onprocessorerror = (event) => {
          if (node === current) fail(event);
        };
        current.port.onmessage = ({ data }: MessageEvent<EngineReport>) => {
          if (node !== current) return;
          // (the core trapped out of its voices and stages: its node is over, as one whose processor threw)
          if (data.broken) {
            trapped = true;
            fail(new Error('The engine core trapped'));
            return;
          }
          clients.forEach((client) => client.report?.(data));
        };
        current.connect(output, 0);
        if (probe) {
          current.connect(probe, 1, 0);
          post({ probe: true });
        }
        clients.forEach((client) => client.start?.());
        setStatus('ready');
      })
      .catch((error) => {
        if (own === loads) fail(error);
      });
  };
  load();

  return {
    output,
    $status,
    post,
    fail,
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
    // the voices as the chain takes them into input 0 of `target` (null: no more); the perf build: a node has the
    // output for it only there
    tapVoices: (target: AudioNode | null) => {
      if (!__PERF__) return;
      if (probe && node) node.disconnect(probe, 1, 0);
      probe = target;
      if (probe && node) node.connect(probe, 1, 0);
      post({ probe: target !== null });
    },
    // loads a failed module again (nothing to do in any other status)
    retry: () => {
      if ($status.value !== 'failed') return;
      if (trapped) {
        if (rebuilds >= MAX_REMAKES) {
          spent('The engine core');
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
      output.disconnect();
      $status.complete();
    },
  };
};
export type EngineNode = ReturnType<typeof createEngineNode>;
