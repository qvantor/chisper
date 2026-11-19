import { registrar } from 'standardized-audio-context-mock';
import { createEngineRunner } from '../app/synth/common/engine/engine-messages';
import {
  EngineMessage,
  EngineOptions,
  EngineReport,
  isStoreMessage,
} from '../app/synth/common/engine/engine-params';
import { BuilderMessage, createTableBuilder } from '../app/synth/common/wavetable/wavetable-builder';
import type { StoreTableMessage } from '../app/synth/common/wavetable/voice-options';
import {
  createTableStoreWasm,
  createVoiceSharedWasm,
} from '../app/synth/common/wavetable/wavetable-osc-wasm';
import { VoicesNodeStub, voicesNodes } from './voice-events';
import { BLOCK, oscScope, seeded } from './voice-dsp';
import { WorkerStub } from './worker-stub';

// the engine of the models run offline: the worker's builder, the store and the whole node (the Rust core, one
// instance as one scope: the voices into the chain, the effects, the master gain and the limiter), as the worker
// and the worklet would run them. Create it before the synth core (it installs the worker); the builds run when
// flushWorker() says so (a note meanwhile plays the previous version), render() takes what the main thread sent
// the node (the events of the voices: their params by the timelines of the core; the knobs of the chain), renders
// it block by block, tells the node the starts and the ends of its voices and moves the context time on

// a message as a port gives it: a copy of its own (jsdom has no structuredClone)
const copy = <T>(value: T): T => {
  if (ArrayBuffer.isView(value)) return (value as unknown as Float32Array).slice() as unknown as T;
  if (Array.isArray(value)) return value.map(copy) as unknown as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)])) as T;
  return value;
};

export interface OfflineEngineOptions {
  // without the limiter (and its latency): the samples of the voices at their frames
  limited?: boolean;
}

export const createOfflineEngine = (random = seeded(1), { limited = true }: OfflineEngineOptions = {}) => {
  const queue: (() => void)[] = [];
  const replies: unknown[] = [];
  const builder = createTableBuilder(
    (run) => queue.push(run),
    (message) => replies.push(message)
  );
  // the worker's end of the channel to the store
  const builderPort = {
    onmessage: null as null | ((event: MessageEvent) => void),
    postMessage: (message: StoreTableMessage) => {
      if (message.remove) store.remove(message.table);
      else if (message.levels) store.set(message.table, message.version, message.levels);
      const node = current();
      node?.port.onmessage?.({ data: { stored: message.table, version: message.version } });
    },
  };
  // (the store keeps the versions in the memory of the core: it hands nothing back to the worker)
  const scope = oscScope();
  const store = createTableStoreWasm(scope);
  const shared = createVoiceSharedWasm(scope);
  let audioCtx: BaseAudioContext | null = null;
  // the events of a task of the main thread go when its microtask would send them
  let flushEvents = () => undefined as void;

  class OfflineWorker extends WorkerStub {
    override postMessage = jest.fn((message: BuilderMessage) =>
      builder.receive('port' in message ? { port: builderPort as unknown as MessagePort } : message)
    );
  }
  Object.assign(globalThis, { Worker: OfflineWorker });

  // the engine of each node of the context (a retry makes another), and the messages taken from it
  const nodes = new Map<VoicesNodeStub, { runner: ReturnType<typeof createEngineRunner>; read: number }>();
  const current = () => (audioCtx ? voicesNodes(audioCtx).at(-1) : undefined);
  let made = 0;
  // (a message the engine can't read fails the spec, not the block)
  const failed = (error: unknown) => {
    throw error;
  };
  const outL = new Float32Array(BLOCK);
  const outR = new Float32Array(BLOCK);

  // the nodes created since the last block get their engine, of the options they were made with, as the
  // processor makes it; what it tells its node as the processor posts it (a report is the processor's to keep: a
  // copy, as a port gives one)
  const discover = (context: BaseAudioContext) =>
    voicesNodes(context)
      .filter((node) => !nodes.has(node))
      .forEach((node) => {
        const options = (node.options.processorOptions ?? {}) as EngineOptions;
        const runner = createEngineRunner(scope, context.sampleRate, options, store, shared, {
          limited,
          random,
          onError: failed,
          post: (report: EngineReport) => node.port.onmessage?.({ data: copy(report) }),
        });
        nodes.set(node, { runner, read: 0 });
      });

  // `blocks` blocks of every node, summed: both channels
  const renderStereo = (blocks = 1, beforeBlock?: () => void) => {
    const context = audioCtx as BaseAudioContext;
    const left = new Float32Array(blocks * BLOCK);
    const right = new Float32Array(blocks * BLOCK);
    for (let i = 0; i < blocks; i++) {
      beforeBlock?.();
      flushEvents();
      discover(context);
      const frame = Math.round(context.currentTime * context.sampleRate);
      nodes.forEach((entry, node) => {
        const { runner } = entry;
        const messages = node.port.postMessage.mock.calls.map(([message]) => message as EngineMessage);
        const posted = messages.slice(entry.read);
        entry.read = messages.length;
        // what the main thread posted the node since the last block, as its processor takes it
        posted.forEach((message) => {
          if (!runner.engine || isStoreMessage(message)) return;
          made += message.events?.filter(({ kind }) => kind === 'on').length ?? 0;
          runner.take(message, frame);
        });
        const { engine } = runner;
        if (!engine) return;
        // (the core trapped out of its voices and stages: the node is over, the main thread is told)
        if (!runner.after(engine.process(frame, outL, outR), BLOCK)) return;
        for (let k = 0; k < BLOCK; k++) {
          left[i * BLOCK + k] += outL[k];
          right[i * BLOCK + k] += outR[k];
        }
      });
      registrar.getDeLorean(context as never)?.travel(BLOCK / context.sampleRate);
    }
    return [left, right];
  };

  return {
    store,
    shared,
    // the context of the synth core (render needs it) and its wavetable oscillator
    attach: (context: BaseAudioContext, engine: { flush: () => void }) => {
      audioCtx = context;
      flushEvents = engine.flush;
      discover(context);
    },
    flushWorker: () => queue.splice(0).forEach((run) => run()),
    // the worker's freed buffers kept for reuse
    pool: () => {
      replies.length = 0;
      builder.receive({ stats: true });
      return (replies[0] as { stats: { pooled: number; pool: number } }).stats;
    },
    // `blocks` blocks of the node (the voices through the chain); its left channel back
    render: (blocks = 1, beforeBlock?: () => void) => renderStereo(blocks, beforeBlock)[0],
    renderStereo,
    // the samples the limiter delays the sound by (0 without it)
    latency: () => [...nodes.values()].find(({ runner }) => runner.engine)?.runner.engine?.latency ?? 0,
    // the voices playing, and those made so far
    alive: () =>
      [...nodes.values()].reduce((sum, { runner }) => sum + (runner.engine?.voices.stats().voices ?? 0), 0),
    made: () => made,
  };
};
