import type { ChainState } from '../chain/chain-params';
import { ChainExports, createChainWasm } from '../chain/chain-wasm';
import { createView } from '../wasm/wasm-core';
import {
  createVoiceScopeWasm,
  OscExports,
  OscScope,
  TableStoreWasm,
  VoiceSharedWasm,
} from '../wavetable/wavetable-osc-wasm';

// The engine core (dsp/engine, engine.wasm) as the worklet and a render on the main thread drive it: the voices
// of a node (createVoiceScopeWasm: their events) and a chain (createChainWasm: its events), both in the memory of
// one module, and the block of both in one call. The voices sum into the input of the chain inside the core: the
// only samples that cross to JS are the output. A trap is caught here: the stack pointer back, the voice ended or
// the effect dropped by the core, the block finished without it

export interface EngineExports extends OscExports, ChainExports {
  engine_new: (scope: number, store: number, shared: number, chain: number) => number;
  engine_free: (engine: number) => void;
  engine_process: (engine: number, frame: number) => number;
  engine_fail: (engine: number) => number;
  engine_resume: (engine: number) => number;
}

// what a block tells there is to read (lib.rs of the crate): the voices that started or ended (voices.reports), the
// stages that failed (chain.reports), the bytes the store freed (store.drain)
export const ENGINE_FLAGS = { voices: 1, stages: 2, freed: 4 };
// what process() returns in place of them when the chain trapped in no stage: the engine is where the trap left
// it, not to be used (the block is silent)
export const ENGINE_BROKEN = -1;
// engine_fail: the trap was in no stage of the chain; it was of the voices and in none of them (the block has none)
const BROKEN = 0;
const SILENCED = 2;
// the blocks in a row the voices may trap in none of them: a block without them now and then plays on, a node
// whose every block is one is silent for good and is over (ENGINE_BROKEN: the main thread makes another)
export const MAX_SILENCED = 8;
// the traps of one block after which it is given up (each ends a voice or drops a stage: thousands of voices)
const MAX_TRAPS = 4096;

export interface EngineWasmOptions {
  // without the limiter (a render at another rate runs one apart)
  limited?: boolean;
  random?: () => number;
  // what a voice or a stage that trapped threw
  onError?: (error: unknown) => void;
}

export const createEngineWasm = (
  scope: OscScope,
  sampleRate: number,
  state: ChainState,
  store: TableStoreWasm,
  shared: VoiceSharedWasm,
  { limited = true, random = Math.random, onError = () => undefined }: EngineWasmOptions = {}
) => {
  const exports = scope.exports as EngineExports;
  const voices = createVoiceScopeWasm(scope, sampleRate, store, shared, random, onError);
  const chain = createChainWasm(exports, sampleRate, state, { limited });
  const handle = exports.engine_new(voices.handle, store.handle, shared.handle, chain.handle);
  const [viewL, viewR, viewInL, viewInR] = [0, 1, 2, 3].map(() => createView(exports));
  // the block the chain has reserved: its frames, the address of its buffers (inL, inR, outL, outR)
  let frames = 0;
  let at = 0;
  let freed = false;
  // whether the block of now lost its voices, the blocks in a row that did
  let voiceless = false;
  let silenced = 0;

  // the rest of the block after a trap: what there is to read, ENGINE_BROKEN
  const recover = (stack: number, error: unknown) => {
    for (let traps = 0; traps < MAX_TRAPS; traps++) {
      exports.__stack_pointer.value = stack;
      onError(error);
      let told = 1;
      try {
        told = exports.engine_fail(handle);
      } catch {
        // the end of the voice trapped too: it is out of the scope all the same
      }
      if (told === BROKEN) return ENGINE_BROKEN;
      if (told === SILENCED) voiceless = true;
      try {
        return exports.engine_resume(handle);
      } catch (next) {
        error = next;
      }
    }
    exports.__stack_pointer.value = stack;
    return ENGINE_BROKEN;
  };

  return {
    voices,
    chain,
    // a block at `frame` of the context: every voice, their sum through the chain into the outputs. What there is
    // to read after it (ENGINE_FLAGS; a note on that trapped is of the voices too), or ENGINE_BROKEN (the chain
    // trapped in no stage, or the voices in none of them MAX_SILENCED blocks in a row)
    process: (frame: number, outL: Float32Array, outR: Float32Array) => {
      const n = outL.length;
      // (guarded here, not by instantiateCore: no closure per block)
      const stack = exports.__stack_pointer.value;
      let flags: number;
      voiceless = false;
      try {
        // (reserved when the length of a block changes: it allocates then, never after)
        if (n !== frames) {
          frames = 0;
          at = exports.chain_buffers(chain.handle, n);
          frames = n;
        }
        flags = exports.engine_process(handle, frame);
      } catch (error) {
        flags = frames === n ? recover(stack, error) : ENGINE_BROKEN;
      }
      silenced = voiceless ? silenced + 1 : 0;
      if (silenced >= MAX_SILENCED) flags = ENGINE_BROKEN;
      if (flags === ENGINE_BROKEN) {
        exports.__stack_pointer.value = stack;
        outL.fill(0);
        outR.fill(0);
        return ENGINE_BROKEN;
      }
      // (a view is made again if the memory grew)
      outL.set(viewL(at + 8 * n, n));
      outR.set(viewR(at + 12 * n, n));
      return voices.failing() ? flags | ENGINE_FLAGS.voices : flags;
    },
    // the voices of the last block as the chain took them, before its effects (the probe of the perf build; with no
    // effect playing the master gain is on them already)
    voicesInto: (outL: Float32Array, outR: Float32Array) => {
      const n = Math.min(frames, outL.length);
      outL.set(viewInL(at, n));
      outR.set(viewInR(at + 4 * frames, n));
    },
    // the samples the limiter delays the sound by
    latency: chain.latency,
    // every voice ends (their versions and mixes back to the store), the chain is freed: each whatever became of
    // the one before (a trap as a voice ends leaves no chain in the memory of the module), what it threw thrown on
    free: () => {
      if (freed) return;
      freed = true;
      try {
        exports.engine_free(handle);
      } finally {
        try {
          voices.free();
        } finally {
          chain.free();
        }
      }
    },
  };
};
export type EngineWasm = ReturnType<typeof createEngineWasm>;
