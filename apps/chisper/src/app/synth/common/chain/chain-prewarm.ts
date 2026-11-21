import {
  ChainRoute,
  chainTarget,
  FX_KINDS,
  FxKind,
  LFO_SOURCE,
  LFO_TABLE,
  LFO_TARGET,
  neutralState,
} from './chain-params';
import { ChainExports, createChainWasm } from './chain-wasm';

// The functions of a core compile lazily, on their first call: as its module loads, the worklet renders with a
// chain of its own what the first node would compile in its first blocks, and frees it. Every effect on over an
// impulse above the ceiling of the limiter; then what a preset with routes runs: an envelope and the LFOs (one
// with a shape) on a knob of every effect, on the lines of the delay, of the EQ and of the mixes and on the rate of
// an LFO; the slots faded out and in again under them in another order (the gains that glide, a unit at rest, a
// slot that leaves the order), the delay in ping-pong, the compressor in three bands and the EQ of other types

const BLOCK = 128;
const ENVELOPE = { attack: 0.002, hold: 0, decay: 0.004, sustain: 0.5, release: 0.004 };
// a knob of a kind: the amount of its route, its range
const KNOBS: [FxKind, string, number, number, number][] = [
  ['distortion', 'level', 3, -24, 12],
  ['chorus', 'rate', 1, 0.01, 8],
  ['delay', 'time', 0.01, 0.001, 1],
  ['delay', 'fb', 0.2, 0, 0.9],
  ['delay', 'pan', 0.01, -0.1, 0.1],
  ['delay', 'freq', 500, 20, 20000],
  ['delay', 'q', 1, 0.01, 10],
  ['compressor', 'thresh', 0.2, 0, 1],
  ['reverb', 'size', 0.2, 0, 1],
  ['eq', 'f1', 400, 20, 20000],
  ['eq', 'g2', 6, -24, 24],
  ['eq', 'level', 0.1, 0, 1],
];

// the routes of the warm-up: ENV 1 and LFO 1 in turn on the knobs, ENV 2 and LFO 2 on the mixes, VELO on the rate
// of LFO 1
export const warmRoutes = (): ChainRoute[] => [
  ...KNOBS.map(([kind, key, amount, min, max], index) => ({
    target: chainTarget(kind, key),
    source: index % 2 ? LFO_SOURCE : 0,
    amount,
    min,
    max,
  })),
  ...FX_KINDS.map((kind, slot) => ({
    target: chainTarget(kind, 'mix'),
    source: slot % 2 ? 1 : LFO_SOURCE + 1,
    amount: -0.3,
    min: 0,
    max: 1,
  })),
  { target: LFO_TARGET, source: 3, amount: 1, min: 0.01, max: 100, scale: 'log' },
];

// the chain of a warm-up: every effect on at half its mix, in the order of the slots (the bands of the EQ not at
// 0 dB: they render)
export const warmState = () => {
  const state = neutralState();
  state.slots.eq.params = { ...state.slots.eq.params, t1: 1, g1: 6, g2: -6 };
  FX_KINDS.forEach((kind, slot) => {
    state.slots[kind].active = true;
    state.slots[kind].mix = 0.5;
    state.order.push(slot);
  });
  return state;
};

// whether every block rendered with every stage (a core that traps here would trap in a node too)
export const prewarmChain = (core: ChainExports, sampleRate: number) => {
  const state = warmState();
  const chain = createChainWasm(core, sampleRate, state);
  const input = new Float32Array(BLOCK);
  const [outL, outR] = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  input[0] = 1.5;
  let frame = 0;
  let whole = true;
  const render = (blocks: number) => {
    for (let block = 0; block < blocks; block++) {
      whole = chain.process(input, input, outL, outR, frame) && whole;
      FX_KINDS.forEach((_, slot) => chain.meter(slot));
      frame += BLOCK;
    }
  };
  render(3);

  // (a cycle of an LFO: four blocks)
  const period = (4 * BLOCK) / sampleRate;
  chain.setLfos({
    at: 0,
    instantly: true,
    lfos: [0, 1, 2, 3].map((lfo) => ({
      // (the first starts with the note, late and smoothed, its shape a ramp; the others free sines)
      mode: lfo ? 1 : 0,
      delay: lfo ? 0 : period / 4,
      rise: lfo ? 0 : period / 4,
      smooth: lfo ? 0 : period / 8,
      phase: 0,
      anchor: { time: 0, phase: 0, period },
      ...(lfo === 0 && { table: Float32Array.from({ length: LFO_TABLE }, (_, at) => at / LFO_TABLE) }),
    })),
  });
  chain.setRoutes(warmRoutes());
  const start = frame / sampleRate;
  chain.setNote({
    envelopes: [ENVELOPE, ENVELOPE, ENVELOPE],
    start,
    release: start + 2 * period,
    velo: 0.8,
  });
  render(4);
  FX_KINDS.forEach((_, slot) => chain.setActive(slot, false));
  render(4);
  FX_KINDS.forEach((_, slot) => {
    chain.setActive(slot, true);
    chain.setMix(slot, 0.7);
  });
  chain.setParams(FX_KINDS.indexOf('delay'), { mode: 1 });
  chain.setParams(FX_KINDS.indexOf('compressor'), { multi: 1 });
  chain.setParams(FX_KINDS.indexOf('eq'), { t1: 2, t2: 1 });
  chain.setOrder(state.order.slice().reverse());
  render(8);
  const failed = chain.reports();
  chain.free();
  return whole && failed === 0;
};
