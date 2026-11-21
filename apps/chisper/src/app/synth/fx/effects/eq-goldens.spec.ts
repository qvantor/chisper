// first: the Math of JS as jsmath (test-utils/js-math.ts): the inputs and the levels the TS builds the same on every
// machine (Node's own Math differs in the last bits on arm64), so are the goldens
import '../../../../test-utils/js-math';
import { FX_PARAMS } from '@chisper/preset-schema';
import { EQ_PASS, EQ_PEAK, EQ_SHELF } from '@chisper/math/eq';
import { EQ_DEFAULTS, eqCore } from '../../../../test-utils/eq-render';
import {
  pick,
  Random,
  randomBlocks,
  randomSignal,
  RATES,
  Signal,
  withSpecials,
} from '../../../../test-utils/fuzz-signals';
import { createGoldens, expectFinite, FUZZ_SCALE, runStereo } from '../../../../test-utils/parity';
import { seeded } from '../../../../test-utils/seeded';
import { EqDspParams } from './eq-params';
import { createEqWasm, EQ_KEYS } from './eq-wasm';

// the Rust core of the EQ (dsp/chain/src/eq.rs): the bits of every output sample of every block on the golden
// scenarios (their hashes in dsp/goldens/eq.json), and random ones: finite

const core = eqCore();
const goldens = createGoldens('eq');
afterAll(() => goldens.save());

type Eq = ReturnType<typeof createEqWasm>;
interface Scenario {
  rate: number;
  params: EqDspParams;
  blocks: number[];
  input: Signal;
  // the params set before a block (a message or the knobs the envelopes move)
  changes?: Record<number, Partial<EqDspParams>[]>;
}

const run = (name: string, { rate, params, blocks, input, changes = {} }: Scenario) =>
  runStereo<Eq>(name, {
    core: createEqWasm(core, rate, { params }),
    blocks,
    input,
    before: (dsp, block) => changes[block]?.forEach((change) => dsp.set(change)),
  });

const RATE = 48000;
const quanta = (seconds: number, rate = RATE) => Array<number>(Math.ceil((seconds * rate) / 128)).fill(128);
// a tone of a few partials, a narrow pulse (broadband)
const tone: Signal = (n, channel) =>
  0.5 * Math.sin(n / 7 + channel) + 0.3 * Math.sin(n / 3.5) + 0.1 * Math.sin(n / 1.2);
const pulse: Signal = (n) => (n % 109 < 8 ? 0.8 : -0.06);
const blockOf = (seconds: number) => Math.floor((seconds * RATE) / 128);
const BASE = EQ_DEFAULTS;

const GOLDEN: [string, Scenario][] = [
  ...[EQ_SHELF, EQ_PEAK, EQ_PASS].flatMap((type) =>
    [0, 1].map((band): [string, Scenario] => [
      `band ${band + 1}, type ${type}`,
      {
        rate: RATE,
        params:
          band === 0
            ? { ...BASE, t1: type, f1: 300, q1: 70, g1: 9 }
            : { ...BASE, t2: type, f2: 4000, q2: 30, g2: -12 },
        blocks: quanta(0.1),
        input: pulse,
      },
    ])
  ),
  [
    'both bands, the level up',
    {
      rate: RATE,
      params: { ...BASE, t1: EQ_PASS, f1: 90, q1: 85, t2: EQ_PEAK, f2: 6000, q2: 50, g2: 18, level: 0.8 },
      blocks: quanta(0.2),
      input: tone,
    },
  ],
  [
    'the knobs glide far, a type changes in a glide',
    {
      rate: RATE,
      params: { ...BASE, t1: EQ_PEAK, f1: 100, q1: 40, g1: -18 },
      blocks: quanta(0.4),
      input: tone,
      changes: {
        [blockOf(0.05)]: [{ f1: 8000, q1: 95, g1: 24 }],
        [blockOf(0.07)]: [{ t1: EQ_PASS, g2: 12 }],
        [blockOf(0.2)]: [{ t1: EQ_SHELF, f1: 50, level: 0.2 }],
      },
    },
  ],
  [
    'a gain to 0 dB and back: the band rests, then sounds again',
    {
      rate: RATE,
      params: { ...BASE, t2: EQ_SHELF, g2: 9 },
      blocks: quanta(0.4),
      input: tone,
      changes: { [blockOf(0.05)]: [{ g2: 0 }], [blockOf(0.25)]: [{ g2: -6 }] },
    },
  ],
  [
    'idle, sound, idle again',
    {
      rate: RATE,
      params: { ...BASE, t1: EQ_PEAK, f1: 200, q1: 60, g1: 12 },
      blocks: quanta(1.6),
      input: (n, channel) => (n > 4800 && n < 14400 ? pulse(n, channel) : 0),
    },
  ],
  [
    'gains moved by an envelope every block',
    {
      rate: RATE,
      params: { ...BASE, t1: EQ_PEAK, f1: 800, q1: 50 },
      blocks: quanta(0.3),
      input: tone,
      changes: Object.fromEntries(
        quanta(0.3).map((_, block) => [
          block,
          [{ g1: 12 * Math.sin(block / 7), f2: 3000 + 2000 * Math.cos(block / 5), g2: 6 }],
        ])
      ),
    },
  ],
  [
    '22.05 kHz, blocks of 1000, a frequency over nyquist',
    {
      rate: 22050,
      params: { ...BASE, t1: EQ_PASS, f1: 60, t2: EQ_PEAK, f2: 20000, q2: 50, g2: 12 },
      blocks: Array<number>(20).fill(1000),
      input: tone,
    },
  ],
];

// a value of a param in its range, sometimes past its ends (the core holds them there)
const valueOf = (random: Random, key: keyof EqDspParams) => {
  const { min, max } = FX_PARAMS.eq[key];
  if (key === 't1' || key === 't2') return Math.floor(random() * (max + 1));
  const value = min + random() * (max - min);
  return random() < 0.1 ? value * 1.3 - 0.1 * max : value;
};

const randomScenario = (random: Random): Scenario => {
  const rate = pick(random, RATES);
  const frames = Math.floor(random() * 0.3 * rate);
  const blocks = randomBlocks(random, frames);
  const changes: Record<number, Partial<EqDspParams>[]> = {};
  blocks.forEach((_, block) => {
    if (random() > 0.2) return;
    changes[block] = [
      Object.fromEntries(EQ_KEYS.filter(() => random() < 0.4).map((key) => [key, valueOf(random, key)])),
    ];
  });
  return {
    rate,
    params: Object.fromEntries(EQ_KEYS.map((key) => [key, valueOf(random, key)])) as unknown as EqDspParams,
    blocks,
    // (NaN, the infinities and 1e30 too: the core takes them as 0)
    input: randomSignal(random, rate, frames, true),
    changes,
  };
};

describe('eq wasm core', () => {
  it.each(GOLDEN)('%s: its golden', (name, scenario) => {
    goldens.check(name, run(name, scenario));
  });

  const count = 600 * FUZZ_SCALE;
  it(`renders ${count} random scenarios, finite`, () => {
    for (let seed = 1; seed <= count; seed++) run(`seed ${seed}`, randomScenario(seeded(seed)));
  });

  it('takes NaN and the infinities as 0: finite all along, idle after the sound', () => {
    const [, scenario] = GOLDEN.find(([name]) => name.startsWith('idle')) as [string, Scenario];
    const input = withSpecials(scenario.input);
    const wasm = createEqWasm(core, RATE, { params: scenario.params });
    let frame = 0;
    scenario.blocks.forEach((n, block) => {
      const [inL, inR] = [0, 1].map((channel) =>
        Float32Array.from({ length: n }, (_, i) => input(frame + i, channel))
      );
      const outs = [0, 1].map(() => new Float32Array(n));
      wasm.process(inL, inR, outs[0], outs[1]);
      outs.forEach((out) => expectFinite('specials', block, out));
      frame += n;
    });
    expect(wasm.idle).toBe(true);
    wasm.free();
  });
});
