import {
  createOscScope,
  createStoreReceiver,
  createTableStoreWasm,
  createVoiceSharedWasm,
} from '../wavetable/wavetable-osc-wasm';
import { FX_KINDS } from '../chain/chain-params';
import { createEngineHost, MakeEngine } from './engine-host';
import { createEngineRunner } from './engine-messages';
import { EngineOptions, EngineReport, isStoreMessage } from './engine-params';
import type { EngineExports } from './engine-wasm';

// of a render: what a note draws (one seed, two renders alike; none: at random, as the synth plays), the chain without
// its limiter (the level of the sound before it, no latency)
export type DirectEngineOptions = Pick<EngineOptions, 'seed' | 'unlimited'>;

// The engine of a render on the main thread: a core of its own (`exports`, an instance dropped with it) hosted as
// the node of the synth is (engine-host.ts: the chain and the voices are its clients), called block by block by
// whoever renders (`render`). A message is taken at once, at the frame of the next block; what a block tells goes
// to the clients right after it. Its store takes the tables of a builder of its own through a port, as the store
// of the worklet does. The time is the frames rendered: `frame`. A voice or a stage that trapped, a message it could
// not take: logged, the first of them kept (`fault`: a render ends on it, a file would lack what failed)
export const createDirectEngine = (
  exports: EngineExports,
  sampleRate: number,
  { seed, unlimited = false }: DirectEngineOptions = {}
) => {
  const scope = createOscScope(exports);
  const store = createTableStoreWasm(scope);
  const shared = createVoiceSharedWasm(scope);
  let fault: unknown = null;
  const failed = (error: unknown) => {
    console.error('A voice or a stage of the render failed', error);
    fault ??= error;
  };
  // the frame of the next block
  let frame = 0;
  let runner: ReturnType<typeof createEngineRunner> | null = null;
  // (the store answers the node of now: none, nothing)
  let tell: (report: EngineReport) => void = () => undefined;
  const fromStore = createStoreReceiver(
    store,
    (report) => tell(report),
    () => undefined
  );
  store.listen((freedBytes) => tell({ freedBytes }));

  const make: MakeEngine = (options, { report }) => {
    const own = createEngineRunner(
      scope,
      sampleRate,
      { ...options, ...(seed !== undefined && { seed }), ...(unlimited && { unlimited }) },
      store,
      shared,
      {
        onError: failed,
        post: report,
      }
    );
    runner = own;
    tell = report;
    return {
      post: (message) => {
        // (the store takes its messages whatever became of the engine)
        if (isStoreMessage(message)) fromStore(message);
        else own.take(message, frame);
      },
      close: () => {
        if (runner === own) runner = null;
        own.take({ stop: true }, frame);
      },
    };
  };
  const host = createEngineHost(() => Promise.resolve(make), 'render');

  return {
    ...host,
    get frame() {
      return frame;
    },
    // the first error of a voice, a stage or a message (none: null)
    get fault() {
      return fault;
    },
    // the frames the limiter delays the output by: 0 without an engine
    get latency() {
      return runner?.engine?.latency ?? 0;
    },
    // every slot of the chain at rest (or no engine)
    idle: () => FX_KINDS.every((_, slot) => runner?.engine?.chain.idle(slot) ?? true),
    // the engine of now (none yet, or it is over): the specs
    get wasm() {
      return runner?.engine ?? null;
    },
    // the next block into `outL`/`outR` (their length); false: no engine (none yet, or it is over), nothing rendered
    render: (outL: Float32Array, outR: Float32Array) => {
      const current = runner;
      const engine = current?.engine;
      if (!current || !engine) return false;
      const flags = engine.process(frame, outL, outR);
      frame += outL.length;
      return current.after(flags, outL.length);
    },
  };
};
