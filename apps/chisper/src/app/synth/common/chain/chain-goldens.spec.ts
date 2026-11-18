// first: the Math of JS as jsmath (test-utils/js-math.ts): the inputs and the levels the TS builds the same on every
// machine (Node's own Math differs in the last bits on arm64), so are the goldens
import '../../../../test-utils/js-math';
import { chainState, makeChain } from '../../../../test-utils/chain-render';
import { pick, Random, randomBlocks, randomSignal, RATES, Signal } from '../../../../test-utils/fuzz-signals';
import { createGoldens, FUZZ_SCALE, runStereo, StereoCore } from '../../../../test-utils/parity';
import { seeded } from '../../../../test-utils/seeded';
import {
  CHAIN_KEYS,
  ChainRoute,
  ChainState,
  chainTarget,
  FX_KINDS,
  FxKind,
  LFO_SOURCE,
  LFO_TARGET,
  NEUTRAL_PARAMS,
} from './chain-params';
import type { ChainWasm } from './chain-wasm';

// the Rust core of the chain (dsp/chain): the bits of every output sample of every block on the golden scenarios
// (their hashes in dsp/goldens/chain.json: the slots, their mix, the master, the limiter, the modulation), and
// random ones: finite, under the ceiling of the limiter

const goldens = createGoldens('chain');
afterAll(() => goldens.save());

interface Scenario {
  rate: number;
  state: ChainState;
  limited?: boolean;
  blocks: number[];
  input: Signal;
  // what a block is told before it (its frame)
  before?: (chain: ChainWasm, block: number, frame: number) => void;
}

// a chain as a stereo core of the specs: a block at the frame after the one before
const stereo = (chain: ChainWasm): StereoCore & { chain: ChainWasm; frame: number } => {
  const core = {
    chain,
    frame: 0,
    process: (inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array) => {
      chain.process(inL, inR, outL, outR, core.frame);
      core.frame += outL.length;
    },
    free: chain.free,
  };
  return core;
};

const run = (name: string, { rate, state, limited = true, blocks, input, before }: Scenario) =>
  runStereo(name, {
    core: stereo(makeChain(state, rate, limited)),
    blocks,
    input,
    before: (core, block) => before?.(core.chain, block, core.frame),
    check: limited
      ? (outL, outR) =>
          [outL, outR].forEach((out) =>
            out.forEach((value) => {
              if (Math.abs(value) > 1) throw new Error(`${name}: ${value} over the ceiling`);
            })
          )
      : undefined,
  });

const RATE = 48000;
const quanta = (seconds: number, rate = RATE) => Array<number>(Math.ceil((seconds * rate) / 128)).fill(128);
const blockOf = (seconds: number) => Math.floor((seconds * RATE) / 128);
// notes of a few partials with silences between them, the channels apart
const notes: Signal = (n, channel) =>
  n % 12000 < 7000 ? 0.4 * Math.sin(n / 9 + channel) + 0.3 * Math.sin(n / 3.7) + 0.2 * Math.sin(n / 1.3) : 0;
const target = chainTarget;
const held = { attack: 0.02, hold: 0, decay: 0.1, sustain: 0.6, release: 0.2 };
const lfos = () => ({
  at: 0,
  instantly: true,
  lfos: [0.2, 1.3, 0.05, 2].map((period, index) => ({
    mode: index % 2,
    delay: index === 1 ? 0.05 : 0,
    rise: index === 1 ? 0.2 : 0,
    smooth: index === 2 ? 0.01 : 0,
    phase: index / 4,
    anchor: { time: 0, phase: 0, period },
  })),
});
const ROUTES: ChainRoute[] = [
  { target: target('distortion', 'level'), source: 0, amount: -9, min: -24, max: 12 },
  { target: target('distortion', 'mix'), source: LFO_SOURCE, amount: 0.5, min: 0, max: 1, bipolar: true },
  { target: target('chorus', 'mix'), source: 1, amount: 0.4, min: 0, max: 1 },
  { target: target('delay', 'time'), source: LFO_SOURCE, amount: 0.004, min: 0.01, max: 1 },
  { target: target('delay', 'fb'), source: 3, amount: 0.3, min: 0, max: 0.9 },
  {
    target: target('delay', 'pan'),
    source: LFO_SOURCE + 2,
    amount: 0.01,
    min: -0.05,
    max: 0.05,
    bipolar: true,
  },
  { target: target('delay', 'freq'), source: LFO_SOURCE + 1, amount: 2, min: 50, max: 17000, scale: 'log' },
  { target: target('compressor', 'thresh'), source: LFO_SOURCE + 3, amount: 0.3, min: 0, max: 1 },
  { target: target('reverb', 'mix'), source: LFO_SOURCE + 1, amount: 0.5, min: 0, max: 1 },
  { target: target('reverb', 'size'), source: 2, amount: 0.3, min: 0, max: 1 },
  // the note to the rate and the phase of LFO 1
  { target: LFO_TARGET, source: 0, amount: 1, min: 0.01, max: 100, scale: 'log' },
  { target: LFO_TARGET + 4, source: 3, amount: 0.25, min: 0, max: 1 },
];
const ALL: FxKind[] = ['distortion', 'chorus', 'delay', 'compressor', 'reverb'];
const MIXES = {
  distortion: { mix: 0.7 },
  chorus: { mix: 0.5 },
  delay: { mix: 0.3, params: { time: 0.031 } },
  compressor: { mix: 1 },
  reverb: { mix: 0.3 },
};

const GOLDEN: [string, Scenario][] = [
  ['the limiter alone', { rate: RATE, state: chainState([]), blocks: quanta(0.5), input: notes }],
  [
    'every effect in the default order',
    { rate: RATE, state: chainState(ALL, 1, MIXES), blocks: quanta(1), input: notes },
  ],
  [
    'another order, without the limiter',
    {
      rate: RATE,
      state: chainState(['reverb', 'compressor', 'delay', 'distortion'], 1, MIXES),
      limited: false,
      blocks: quanta(0.6),
      input: notes,
    },
  ],
  [
    'the knobs moved by a note and its LFOs',
    {
      rate: RATE,
      state: chainState(ALL, 1, MIXES, {
        routes: ROUTES,
        lfos: lfos(),
        note: { envelopes: [held, held, held], start: 0.05, release: 0.6, velo: 0.8 },
      }),
      blocks: quanta(1),
      input: notes,
    },
  ],
  [
    'slots switched, moved and mixed as it plays, the master and the mute',
    {
      rate: RATE,
      state: chainState(['distortion', 'delay'], 1, MIXES),
      blocks: quanta(1),
      input: notes,
      before: (chain, block) => {
        if (block === blockOf(0.1)) chain.setActive(0, false);
        if (block === blockOf(0.2)) chain.setOrder([4, 2, 0]);
        if (block === blockOf(0.2)) chain.setActive(4, true);
        if (block === blockOf(0.3)) chain.setActive(0, true);
        if (block === blockOf(0.4)) chain.setMix(2, 0.8);
        if (block === blockOf(0.5)) chain.setParams(2, { time: 0.011, mode: 1, pan: 0.01 });
        if (block === blockOf(0.6)) chain.setMasterGain(0.5);
        if (block === blockOf(0.7)) chain.mute(0.02);
        if (block === blockOf(0.8)) chain.clear();
        if (block === blockOf(0.85)) chain.unmute();
      },
    },
  ],
  [
    'events at their frames',
    {
      rate: RATE,
      state: chainState(['compressor', 'reverb'], 1, MIXES),
      blocks: quanta(0.5),
      input: notes,
      before: (chain, block) => {
        if (block !== 0) return;
        chain.setParams(3, { thresh: 0.8, ratio: 12 }, 4800);
        chain.setMix(4, 0.9, 9600);
        chain.setMasterGain(0.7, 14400);
        chain.setActive(3, false, 19200);
      },
    },
  ],
  [
    '96 kHz, blocks of 1000',
    {
      rate: 96000,
      state: chainState(ALL, 1, MIXES, { routes: ROUTES, lfos: lfos() }),
      blocks: Array<number>(60).fill(1000),
      input: notes,
    },
  ],
  [
    '192 kHz, blocks of 37',
    {
      rate: 192000,
      state: chainState(ALL, 1, MIXES),
      blocks: Array<number>(1500).fill(37),
      input: notes,
    },
  ],
];

const randomState = (random: Random): ChainState => {
  const kinds = ALL.filter(() => random() < 0.7).sort(() => random() - 0.5);
  const slots = Object.fromEntries(
    ALL.map((kind) => [
      kind,
      {
        mix: random(),
        params: Object.fromEntries(
          CHAIN_KEYS[kind]
            .filter(() => random() < 0.3)
            // (around the knob as it is: a value out of its range too)
            .map((key) => [key, NEUTRAL_PARAMS[kind][key] * (0.2 + 2 * random()) + (random() < 0.1 ? -1 : 0)])
        ),
      },
    ])
  );
  const routes = ROUTES.filter(() => random() < 0.4).map((route) => ({
    ...route,
    amount: route.amount * (2 * random() - 0.5),
  }));
  return chainState(kinds, 1, slots, {
    masterGain: random() < 0.3 ? 2 * random() : 1,
    routes,
    lfos: random() < 0.7 ? lfos() : null,
    note:
      random() < 0.7
        ? {
            envelopes: [held, held, held],
            start: 0.2 * random(),
            release: random() < 0.5 ? 0.25 : null,
            velo: random(),
          }
        : null,
  });
};

const randomScenario = (random: Random): Scenario => {
  const rate = pick(random, [...RATES, 192000]);
  const frames = Math.floor(random() * 0.3 * rate);
  const blocks = randomBlocks(random, frames);
  const changes = blocks.map(() => (random() < 0.1 ? Math.floor(random() * 8) : -1));
  const values = blocks.map(() => random());
  return {
    rate,
    state: randomState(random),
    limited: random() < 0.8,
    blocks,
    // (NaN, the infinities and 1e30 too: the chain takes them as 0)
    input: randomSignal(random, rate, frames, true),
    before: (chain, block) => {
      const value = values[block];
      const slot = Math.floor(value * FX_KINDS.length);
      const kind = FX_KINDS[slot];
      switch (changes[block]) {
        case 0:
          return chain.setActive(slot, value < 0.5);
        case 1:
          return chain.setMix(slot, value);
        case 2:
          return chain.setOrder(value < 0.3 ? [] : [slot, (slot + 2) % FX_KINDS.length]);
        case 3:
          return chain.setParams(slot, {
            [CHAIN_KEYS[kind][0]]: NEUTRAL_PARAMS[kind][CHAIN_KEYS[kind][0]] * 2 * value,
          });
        case 4:
          return chain.clear();
        case 5:
          return value < 0.5 ? chain.mute(0.01) : chain.unmute();
        case 6:
          return chain.setRoutes(value < 0.5 ? [] : ROUTES);
        case 7:
          return chain.setNote(
            value < 0.3 ? null : { envelopes: [held, held, held], start: value, release: null }
          );
        default:
          return undefined;
      }
    },
  };
};

describe('chain wasm core', () => {
  it.each(GOLDEN)('%s: its golden', (name, scenario) => {
    goldens.check(name, run(name, scenario));
  });

  const count = 200 * FUZZ_SCALE;
  it(`renders ${count} random scenarios, finite and under the ceiling of the limiter`, () => {
    for (let seed = 1; seed <= count; seed++) run(`seed ${seed}`, randomScenario(seeded(seed)));
  });
});
