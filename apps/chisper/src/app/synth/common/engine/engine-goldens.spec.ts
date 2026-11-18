// first: the Math of JS as jsmath (test-utils/js-math.ts): the tables the TS builds the same on every machine
// (Node's own Math differs in the last bits on arm64), so are the goldens
import '../../../../test-utils/js-math';
import { chainState } from '../../../../test-utils/chain-render';
import { pick, Random, RATES } from '../../../../test-utils/fuzz-signals';
import { createBitsHash, createGoldens, FUZZ_SCALE } from '../../../../test-utils/parity';
import { seeded } from '../../../../test-utils/seeded';
import { oscScope, storeWith } from '../../../../test-utils/voice-dsp';
import { ChainRoute, ChainState, chainTarget, FX_KINDS, FxKind, LFO_SOURCE } from '../chain/chain-params';
import type { VoiceEvent, VoiceFilterOptions, VoiceOptions } from '../wavetable/voice-options';
import { createVoiceSharedWasm } from '../wavetable/wavetable-osc-wasm';
import { createEngineWasm, ENGINE_BROKEN, EngineWasm } from './engine-wasm';

// the Rust core of the whole node (dsp/engine): the voices summed into the chain, the effects, the master and the
// limiter in one block. The bits of every output sample of every block on the golden scenarios (their hashes in
// dsp/goldens/engine.json), and random ones: finite, under the ceiling of the limiter. Its halves have their own
// goldens (wavetable-osc.json, chain.json): engine-wasm.spec holds a block of the engine to them run one after
// the other

const goldens = createGoldens('engine');
afterAll(() => goldens.save());

const BLOCK = 128;
const saw = (size: number, harmonics: number, shift = 0) =>
  Array.from({ length: size }, (_, n) => {
    let sum = 0;
    for (let k = 1; k <= harmonics; k++) sum += Math.sin((2 * Math.PI * k * n) / size + shift * k) / k;
    return sum / 2;
  });
// a table of two frames: a saw and a duller one
const TABLES = { a: [saw(2048, 64), saw(2048, 8, 1)] };
const ENVELOPE = { attack: 0.005, hold: 0.01, decay: 0.08, sustain: 0.6, release: 0.15 };
const LOWPASS: VoiceFilterOptions = {
  type: 'low12',
  cutoff: 2400,
  resonance: 30,
  gain: 0,
  drive: 0,
  variation: 0,
};
const note = (unison: number, filter: VoiceFilterOptions | null, start = 0): VoiceOptions => ({
  osc: [
    { table: 'a', unison, phase: 0.25, phaseRand: 1 },
    { table: '', unison: 1, phase: 0, phaseRand: 0 },
  ],
  start,
  envelopes: [ENVELOPE, ENVELOPE, ENVELOPE],
  envStart: start,
  phrase: start,
  routes: [{ source: 1, param: 'position1', amount: 0.5, min: 0, max: 1 }],
  filter,
});

interface Scenario {
  rate: number;
  state: ChainState;
  limited?: boolean;
  blocks: number;
  // the voices: their events before the first block
  events: (rate: number) => VoiceEvent[];
  seed?: number;
  // what a block is told before it
  before?: (engine: EngineWasm, block: number, frame: number) => void;
}

// a chord of `frequencies` from `start` on, each note released at `release` seconds; its voices from `first` on
const chord = (
  frequencies: number[],
  release: number,
  gain = 0.5,
  filter = LOWPASS,
  first = 0,
  start = 0
): VoiceEvent[] =>
  frequencies.flatMap((frequency, index): VoiceEvent[] => {
    const voice = first + index;
    return [
      {
        kind: 'on',
        voice,
        options: note(1 + (index % 4), index % 2 ? filter : null, start),
        params: { frequency, gain1: gain, gain2: gain / 2, spread1: 20, position1: index / 8 },
      },
      { kind: 'set', voice, param: 'gate', value: 0, time: release + index * 0.01 },
    ];
  });

const run = (name: string, { rate, state, limited = true, blocks, events, seed = 1, before }: Scenario) => {
  const scope = oscScope();
  const { store } = storeWith(TABLES, scope);
  const shared = createVoiceSharedWasm(scope);
  if (state.lfos) shared.setLfos(state.lfos);
  const engine = createEngineWasm(scope, rate, state, store, shared, { limited, random: seeded(seed) });
  engine.voices.apply(events(rate));
  const hash = createBitsHash();
  const [outL, outR] = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  let sounded = false;
  for (let block = 0; block < blocks; block++) {
    const frame = block * BLOCK;
    before?.(engine, block, frame);
    const flags = engine.process(frame, outL, outR);
    if (flags === ENGINE_BROKEN) throw new Error(`${name}: block ${block} broke the engine`);
    engine.voices.reports();
    [outL, outR].forEach((out, channel) => {
      out.forEach((value, i) => {
        if (!Number.isFinite(value)) throw new Error(`${name}: block ${block}, ${channel}[${i}] is ${value}`);
        if (limited && Math.abs(value) > 1) throw new Error(`${name}: ${value} over the ceiling`);
        sounded ||= value !== 0;
      });
      hash.add(out, channel === 0);
    });
  }
  // (no stage of it failed)
  expect(engine.chain.reports()).toBe(0);
  engine.free();
  shared.free();
  store.free();
  return { golden: hash.digest(), sounded };
};

const RATE = 48000;
const blocksOf = (seconds: number, rate = RATE) => Math.ceil((seconds * rate) / BLOCK);
const ALL: FxKind[] = ['distortion', 'chorus', 'delay', 'compressor', 'reverb'];
const MIXES = {
  distortion: { mix: 0.7 },
  chorus: { mix: 0.5 },
  delay: { mix: 0.3, params: { time: 0.031 } },
  compressor: { mix: 1 },
  reverb: { mix: 0.3 },
};
const target = chainTarget;
const ROUTES: ChainRoute[] = [
  { target: target('distortion', 'level'), source: 0, amount: -9, min: -24, max: 12 },
  { target: target('delay', 'time'), source: LFO_SOURCE, amount: 0.004, min: 0.01, max: 1 },
  { target: target('reverb', 'mix'), source: LFO_SOURCE + 1, amount: 0.5, min: 0, max: 1 },
];
const lfos = () => ({
  at: 0,
  instantly: true,
  lfos: [0.2, 1.3, 0.05, 2].map((period, index) => ({
    mode: index % 2,
    delay: 0,
    rise: index === 1 ? 0.2 : 0,
    smooth: 0,
    phase: index / 4,
    anchor: { time: 0, phase: 0, period },
  })),
});
const A_MINOR = [110, 220, 261.63, 329.63, 440];

const SCENARIOS: Record<string, Scenario> = {
  'a chord through every effect, released into their tails': {
    rate: RATE,
    state: chainState(ALL, 1, MIXES),
    blocks: blocksOf(1.2),
    events: () => chord(A_MINOR, 0.4),
  },
  'no effect: a chord over the ceiling into the limiter': {
    rate: RATE,
    state: chainState([]),
    blocks: blocksOf(0.6),
    events: () => chord(A_MINOR, 0.3, 4),
  },
  'the knobs of the effects follow the note and the LFOs under the voices': {
    rate: 44100,
    state: chainState(ALL, 1, MIXES, {
      routes: ROUTES,
      lfos: lfos(),
      note: { envelopes: [ENVELOPE, ENVELOPE, ENVELOPE], start: 0, release: 0.4, velo: 0.8 },
    }),
    blocks: blocksOf(0.9, 44100),
    events: () => chord(A_MINOR.slice(0, 3), 0.4),
  },
  'a preset switch: the output fades, the voices end, the tails are forgotten, a new chord': {
    rate: RATE,
    state: chainState(['delay', 'reverb'], 1, MIXES),
    blocks: blocksOf(1),
    events: () => chord(A_MINOR, 10),
    before: (engine, block, frame) => {
      const at = (seconds: number) => block === Math.floor((seconds * RATE) / BLOCK);
      if (at(0.3)) {
        engine.chain.mute(0.02, frame);
        engine.voices.apply(
          A_MINOR.map((_, voice): VoiceEvent => ({ kind: 'set', voice, param: 'gate', value: -1, time: 0.3 }))
        );
      }
      if (at(0.4)) {
        engine.chain.clear();
        engine.chain.setMix(FX_KINDS.indexOf('reverb'), 0.6);
        engine.chain.unmute();
        engine.voices.apply(chord([146.83, 293.66], 0.7, 0.5, LOWPASS, 8, 0.4));
      }
    },
  },
  'at 96 kHz without the limiter: the render of an export': {
    rate: 96000,
    state: chainState(['distortion', 'chorus', 'reverb'], 1, MIXES),
    limited: false,
    blocks: blocksOf(0.5, 96000),
    events: () => chord(A_MINOR.slice(1, 4), 0.25, 0.3),
  },
};

describe('the engine: the golden scenarios', () => {
  Object.entries(SCENARIOS).forEach(([name, scenario]) =>
    it(name, () => {
      const { golden, sounded } = run(name, scenario);
      expect(sounded).toBe(true);
      goldens.check(name, golden);
    })
  );

  it('a scenario rendered again is the same bits (nothing of a render stays in the core)', () => {
    const name = 'a chord through every effect, released into their tails';
    expect(run(name, SCENARIOS[name]).golden.sha256).toBe(run(name, SCENARIOS[name]).golden.sha256);
  });
});

// a random chord through a random chain: the notes, their unisons and filters, their releases, the effects and
// their order
const randomScenario = (random: Random): Scenario => {
  const rate = pick(random, RATES);
  const kinds = ALL.filter(() => random() < 0.6).sort(() => random() - 0.5);
  const count = 1 + Math.floor(random() * 6);
  const release = 0.05 + random() * 0.2;
  const filter: VoiceFilterOptions = {
    ...LOWPASS,
    type: pick(random, ['lowpass', 'low12', 'ladder24', 'bandpass'] as const),
    cutoff: 200 + random() * 8000,
    resonance: random() * 60,
  };
  const frequencies = Array.from({ length: count }, () => 40 * 2 ** (random() * 6));
  const gain = 10 ** ((random() * 40 - 20) / 20);
  const moved = random() < 0.5;
  return {
    rate,
    state: chainState(kinds, 0.2 + 0.8 * random(), MIXES, {
      masterGain: 0.5 + random(),
      ...(moved && {
        routes: ROUTES,
        lfos: lfos(),
        note: { envelopes: [ENVELOPE, ENVELOPE, ENVELOPE], start: 0, release, velo: random() },
      }),
    }),
    limited: random() < 0.8,
    blocks: blocksOf(release + 0.2, rate),
    events: () => chord(frequencies, release, gain, filter),
    seed: Math.floor(random() * 1e6),
  };
};

describe('the engine: random scenarios', () => {
  it('stay finite, under the ceiling with the limiter, no stage failing', () => {
    const random = seeded(35);
    for (let index = 0; index < 20 * FUZZ_SCALE; index++) {
      const scenario = randomScenario(random);
      expect(() => run(`random ${index}`, scenario)).not.toThrow();
    }
  });
});
