import bytes from '@chisper/wasm/engine.wasm';
import { prewarmChain, warmState } from '../chain/chain-prewarm';
import { instantiateCore } from '../wasm/wasm-core';
import type { StoreStatsMessage } from '../wavetable/voice-options';
import { prewarmVoices } from '../wavetable/voices-prewarm';
import {
  createOscScope,
  createStoreReceiver,
  createTableStoreWasm,
  createVoiceSharedWasm,
  StoreFreedBytesMessage,
} from '../wavetable/wavetable-osc-wasm';
import { createEngineRunner } from './engine-messages';
import {
  ENGINE_PROCESSOR,
  EngineMessage,
  EngineOptions,
  EngineReport,
  isStoreMessage,
} from './engine-params';
import { createEngineWasm, ENGINE_BROKEN, ENGINE_FLAGS, EngineExports, EngineWasm } from './engine-wasm';

// The audio worklet module of the synth with its Rust core (dsp/engine), bundled by esbuild (`npm run worklets`)
// into assets/worklets/engine.js with the bytes of engine.wasm, compiled as the module loads (needs wasm SIMD). It
// runs in the AudioWorkletGlobalScope (one per AudioContext): no window, document or React. One node plays
// everything: the voices of every note from the tables of the store (they come from the worker in chunks, over a
// port the node is given), their sum through the chain (the effects, the master gain, the limiter) inside the
// core. A thin wrapper: the messages of the main thread become the events and the calls of the core (the seconds
// of the context its frames), a block is one call, what the core tells goes back (the voices that started and
// ended, a stage that failed or was made again, the meters of the effects only while a screen watches them)

declare const sampleRate: number;
declare const currentFrame: number;
interface AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare const AudioWorkletProcessor: { prototype: AudioWorkletProcessor; new (): AudioWorkletProcessor };
declare function registerProcessor(
  name: string,
  processor: new (options: AudioWorkletNodeOptions) => AudioWorkletProcessor
): void;

const core = instantiateCore<EngineExports>(new WebAssembly.Module(bytes));
const scope = createOscScope(core);
const failed = (error: unknown) => console.error('A voice or a stage of the engine failed', error);

// the store of the context: it and what the voices share outlive a node (the node of a retry takes them over)
const store = createTableStoreWasm(scope);
// The functions of a block compile lazily, on their first call: as the module loads, the chain alone, then the
// voices of the warm-up (voices-prewarm.ts) in an engine of their own with every effect on: the block of the
// node is the one compiled. A prewarm that fails (a trap of the core on some engine) leaves its functions to the
// first note and what it made where it is: a voice may still hold its versions; the synth plays all the same
try {
  prewarmChain(core, sampleRate);
  prewarmVoices(scope, store, sampleRate, (warmStore, warmShared) => {
    const engine = createEngineWasm(scope, sampleRate, warmState(), warmStore, warmShared);
    return {
      apply: engine.voices.apply,
      process: engine.process,
      reports: () => [engine.voices.reports(), engine.chain.reports()],
      free: engine.free,
    };
  });
} catch (error) {
  console.error('The prewarm of the engine failed', error);
}
const shared = createVoiceSharedWasm(scope);

// a channel a node has not (one output of 2 channels has both): written and never read, an input never written
let scratch = new Float32Array(128);
let zeros = new Float32Array(128);
let sum = [new Float32Array(128), new Float32Array(128)];

class EngineProcessor extends AudioWorkletProcessor {
  // the engine of the node, its messages and what its blocks leave to read (engine-messages.ts)
  private runner: ReturnType<typeof createEngineRunner>;
  // the pair of channels of each voice (tap)
  private pairs: Map<number, number> | null = null;
  private fed: boolean;
  private probed = false;
  // the frame of the next block (none before the first one): the time of now for a state of the LFOs
  private next = -Infinity;
  private post = (report: EngineReport) => this.port.postMessage(report);
  // (none: the node is over)
  private get engine() {
    return this.runner.engine;
  }
  private fromStore: (event: MessageEvent) => void;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const processorOptions = (options.processorOptions ?? {}) as EngineOptions;
    // (the engine of the options, as a render on the main thread makes it)
    this.runner = createEngineRunner(scope, sampleRate, processorOptions, store, shared, {
      onError: failed,
      post: this.post,
    });
    this.fed = processorOptions.fed ?? false;
    if (processorOptions.tap) this.pairs = new Map();
    // (the processor of a retry takes the store over)
    store.listen((freedBytes) => this.post({ freedBytes } satisfies StoreFreedBytesMessage));
    this.fromStore = createStoreReceiver(store, this.post, () => {
      // the counters of the store and of the voices of the scope (the perf build)
      if (!__PERF__) return;
      const { voices: scopeVoices, events: held } = this.engine?.voices.stats() ?? {
        voices: 0,
        events: 0,
      };
      const answer: StoreStatsMessage = {
        stats: { ...store.stats(), ...shared.stats(), scopeVoices, events: held, frame: currentFrame },
      };
      this.post(answer);
    });
    this.port.onmessage = (event: MessageEvent<EngineMessage>) => this.take(event);
  }

  private take(event: MessageEvent<EngineMessage>) {
    const message = event.data;
    // (the store takes its messages whatever became of the engine: the tables are the context's)
    if (isStoreMessage(message)) {
      this.fromStore(event);
      return;
    }
    this.runner.take(message, this.next);
    if (!message.stop && message.probe !== undefined) this.probed = message.probe;
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const { engine } = this;
    if (!engine) return false;
    const output = outputs[0];
    const outL = output[0];
    const frames = outL.length;
    this.next = currentFrame + frames;
    if (scratch.length !== frames) {
      scratch = new Float32Array(frames);
      zeros = new Float32Array(frames);
      sum = [new Float32Array(frames), new Float32Array(frames)];
    }
    let flags: number;
    if (this.fed) flags = this.feed(engine, inputs[0], output);
    else if (this.pairs) flags = this.tapped(engine, this.pairs, output);
    else flags = engine.process(currentFrame, outL, output[1] ?? scratch);
    if (!this.runner.after(flags, frames)) return false;
    if (this.probed && outputs.length > 1) engine.voicesInto(outputs[1][0], outputs[1][1] ?? scratch);
    return true;
  }

  // the chain alone on the input of the node (no voice plays: the parity of the browsers, the benches)
  private feed(engine: EngineWasm, input: Float32Array[] | undefined, output: Float32Array[]) {
    const inL = input?.[0] ?? zeros;
    const inR = input?.[1] ?? inL;
    const whole = engine.chain.process(inL, inR, output[0], output[1] ?? output[0], currentFrame);
    return whole ? ENGINE_FLAGS.stages : ENGINE_BROKEN;
  }

  // each voice into its pair of channels, as it is before the chain (the parity of the browsers)
  private tapped(engine: EngineWasm, pairs: Map<number, number>, output: Float32Array[]) {
    const n = output[0].length;
    const flags = engine.process(currentFrame, sum[0], sum[1]);
    if (flags === ENGINE_BROKEN) return flags;
    for (let channel = 0; channel < output.length; channel++) output[channel].fill(0);
    engine.voices.taps(n).forEach(({ voice, left, right }) => {
      const pair = pairs.get(voice) ?? pairs.size;
      pairs.set(voice, pair);
      output[2 * pair]?.set(left);
      output[2 * pair + 1]?.set(right);
    });
    return flags;
  }
}

registerProcessor(ENGINE_PROCESSOR, EngineProcessor);
