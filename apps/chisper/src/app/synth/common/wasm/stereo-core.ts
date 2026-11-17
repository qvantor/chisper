import { FX_KINDS, FxKind, LIMITER_STAGE, MAX_PARAMS } from '../chain/chain-params';
import { CoreExports, createView } from './wasm-core';

// the kinds of the units of the chain core (dsp/chain/src/units.rs): the effects in the order of FX_TYPES, then
// the limiter
export const UNIT = {
  ...Object.fromEntries(FX_KINDS.map((kind, index) => [kind, index])),
  limiter: LIMITER_STAGE,
} as Record<FxKind | 'limiter', number>;

// the C ABI of an effect alone in the chain core (dsp/chain): unit_new makes one of a kind (its options in the
// buffer of unit_command, from its second value on, in the order of its keys), unit_buffers reserves a block of
// `frames` (inL, inR, outL, outR one after another), unit_process renders it, unit_set changes the params of the
// bits of the first value of the buffer (1 << key), unit_clear forgets the sound before, unit_meter writes what a
// screen draws into the buffer
export interface UnitExports extends CoreExports {
  unit_command: () => number;
  unit_new: (kind: number, sampleRate: number) => number;
  unit_buffers: (handle: number, frames: number) => number;
  unit_process: (handle: number) => void;
  unit_set: (handle: number, routed: boolean) => void;
  unit_clear: (handle: number) => void;
  unit_idle: (handle: number) => number;
  unit_latency: (handle: number) => number;
  unit_meter: (handle: number) => number;
  unit_free: (handle: number) => void;
}

// the buffer of unit_command: the bits of unit_set, then the params
const COMMAND = 1 + MAX_PARAMS;

// copies `source` into the block, a shorter one padded with NaN (the TS cores read undefined there)
const copyIn = (target: Float32Array, source: Float32Array) => {
  if (source.length === target.length) target.set(source);
  else {
    target.set(source.subarray(0, target.length));
    target.fill(NaN, Math.min(source.length, target.length));
  }
};

// process() of a unit: the inputs into its memory, the block rendered, the
// outputs out of it; clear() empties its state (a preset switch: the next sound starts at the params as they are
// then); free() frees its handle (the processor is stopped)
export const stereoCore = (exports: UnitExports, handle: number) => {
  // a view per channel: no array is created per block
  const [viewInL, viewInR, viewOutL, viewOutR] = [0, 1, 2, 3].map(() => createView(exports));
  let freed = false;
  return {
    process: (inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array) => {
      const frames = outL.length;
      const bytes = 4 * frames;
      // (guarded here, not by instantiateCore: no closure per block; unit_buffers grows the block)
      const stack = exports.__stack_pointer.value;
      let at: number;
      try {
        at = exports.unit_buffers(handle, frames);
        copyIn(viewInL(at, frames), inL);
        copyIn(viewInR(at + bytes, frames), inR);
        exports.unit_process(handle);
      } catch (error) {
        exports.__stack_pointer.value = stack;
        throw error;
      }
      // (a view is made again if the memory grew)
      outL.set(viewOutL(at + 2 * bytes, frames));
      outR.set(viewOutR(at + 3 * bytes, frames));
    },
    clear: () => exports.unit_clear(handle),
    free: () => {
      if (freed) return;
      freed = true;
      exports.unit_free(handle);
    },
  };
};

// the dsp of a unit of `kind` with `params` (`keys` in its order): set() changes those
// given (`routed`: a route moves them), idle says it has nothing to play; its `handle` and `command` (its buffer)
// for what else it exports
export const paramsCore = <K extends string>(
  exports: UnitExports,
  kind: number,
  sampleRate: number,
  keys: readonly K[],
  params: Record<K, number>
) => {
  const view = createView(exports, Float64Array);
  // (a static of the core: it never moves)
  const at = exports.unit_command();
  const command = () => view(at, COMMAND);
  const options = command();
  options[0] = 0;
  keys.forEach((key, i) => (options[1 + i] = params[key]));
  const handle = exports.unit_new(kind, sampleRate);
  const dsp = {
    ...stereoCore(exports, handle),
    set: (changes: Partial<Record<K, number>>, routed = false) => {
      const buffer = command();
      let present = 0;
      for (let i = 0; i < keys.length; i++) {
        const value = changes[keys[i]];
        if (value === undefined) continue;
        present |= 1 << i;
        buffer[1 + i] = value;
      }
      buffer[0] = present;
      exports.unit_set(handle, routed);
    },
    get idle() {
      return exports.unit_idle(handle) !== 0;
    },
  };
  return { dsp, handle, command };
};
