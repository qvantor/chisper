import {
  ChainSlot,
  ChainState,
  FX_KINDS,
  FxKind,
  neutralState,
} from '../app/synth/common/chain/chain-params';
import { ChainExports, ChainWasm, createChainWasm } from '../app/synth/common/chain/chain-wasm';
import { wasmCore } from './wasm';

// the chain as its specs render it: the core through its facade, block by block

let core: ChainExports | undefined;
// one instance for a spec file
export const chainCore = () => (core ??= wasmCore<ChainExports>('engine'));

export const slotOf = (kind: FxKind) => FX_KINDS.indexOf(kind);

// a state with `kinds` in the chain in this order, each playing at `mix` (its params: the neutral ones, `slots`
// over them)
export const chainState = (
  kinds: FxKind[],
  mix = 1,
  slots: Partial<Record<FxKind, Partial<ChainSlot>>> = {},
  rest: Partial<ChainState> = {}
): ChainState => {
  const state = neutralState();
  kinds.forEach((kind) => {
    state.slots[kind].active = true;
    state.slots[kind].mix = mix;
    state.order.push(slotOf(kind));
  });
  (Object.keys(slots) as FxKind[]).forEach((kind) => {
    const { params, ...other } = slots[kind] ?? {};
    Object.assign(state.slots[kind], other);
    Object.assign(state.slots[kind].params, params);
  });
  return { ...state, ...rest };
};

const BLOCK = 128;

// both channels through a chain in blocks of 128 (`before` a block: its frame), then it is freed
export const renderChain = (
  chain: ChainWasm,
  [left, right]: [ArrayLike<number>, ArrayLike<number>],
  before: (chain: ChainWasm, frame: number) => void = () => undefined
) => {
  const frames = left.length;
  const [inL, inR] = [Float32Array.from(left), Float32Array.from(right)];
  const [outL, outR] = [new Float32Array(frames), new Float32Array(frames)];
  for (let start = 0; start < frames; start += BLOCK) {
    const end = Math.min(start + BLOCK, frames);
    before(chain, start);
    chain.process(
      inL.subarray(start, end),
      inR.subarray(start, end),
      outL.subarray(start, end),
      outR.subarray(start, end),
      start
    );
  }
  chain.free();
  return { left: outL, right: outR };
};

export const makeChain = (state: ChainState, rate = 48000, limited = false) =>
  createChainWasm(chainCore(), rate, state, { limited });

// a seeded noise within ±level (whole numbers: the same bits everywhere)
export const noise = (frames: number, level = 0.4, seed = 1): [Float32Array, Float32Array] => {
  let state = seed;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return ((state >>> 8) / 0x800000 - 1) * level;
  };
  const left = Float32Array.from({ length: frames }, next);
  const right = Float32Array.from({ length: frames }, next);
  return [left, right];
};
