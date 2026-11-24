// first: the Math of JS as jsmath (test-utils/js-math.ts): the inputs and the levels the TS builds the same on every
// machine (Node's own Math differs in the last bits on arm64), so are the goldens
import '../../../../test-utils/js-math';
import { FX_PARAMS } from '@chisper/preset-schema';
import { FX_FILTER_DEFAULTS, fxFilterCore } from '../../../../test-utils/fxfilter-render';
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
import { FX_FILTER_TYPES, FxFilterDspParams, fxFilterIndexOf } from './fxfilter-params';
import { createFxFilterWasm, FX_FILTER_KEYS } from './fxfilter-wasm';

// the Rust core of the FX Filter (dsp/chain/src/fxfilter.rs): the bits of every output sample of every block on the
// golden scenarios (their hashes in dsp/goldens/fxfilter.json), and random ones: finite

const core = fxFilterCore();
const goldens = createGoldens('fxfilter');
afterAll(() => goldens.save());

type Params = FxFilterDspParams & { mix: number };
type Filter = ReturnType<typeof createFxFilterWasm>;
interface Scenario {
  rate: number;
  params: FxFilterDspParams;
  mix?: number;
  blocks: number[];
  input: Signal;
  // the params set before a block (a message or the knobs the routes move)
  changes?: Record<number, Partial<Params>[]>;
}

const run = (name: string, { rate, params, mix = 1, blocks, input, changes = {} }: Scenario) =>
  runStereo<Filter>(name, {
    core: createFxFilterWasm(core, rate, { params, mix }),
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
const BASE = FX_FILTER_DEFAULTS;
const type = fxFilterIndexOf;

const GOLDEN: [string, Scenario][] = [
  ...FX_FILTER_TYPES.map((name): [string, Scenario] => [
    `${name}, Res 60, Drive 20`,
    {
      rate: RATE,
      params: { ...BASE, type: type(name), cutoff: 900, res: 60, drive: 20 },
      blocks: quanta(0.1),
      input: pulse,
    },
  ]),
  [
    'ladder24 driven, Fat, the level up, half wet',
    {
      rate: RATE,
      params: { ...BASE, type: type('ladder24'), cutoff: 400, res: 85, drive: 70, var: 60, level: 0.8 },
      mix: 0.5,
      blocks: quanta(0.2),
      input: tone,
    },
  ],
  [
    'Pan apart, then back to the middle',
    {
      rate: RATE,
      params: { ...BASE, type: type('low12'), cutoff: 1200, res: 50, pan: 10 },
      blocks: quanta(0.4),
      input: tone,
      changes: { [blockOf(0.1)]: [{ pan: 70 }], [blockOf(0.2)]: [{ pan: 50 }] },
    },
  ],
  [
    'the knobs glide far, a type changes in a glide, another during its fade',
    {
      rate: RATE,
      params: { ...BASE, type: type('low24'), cutoff: 100, res: 40 },
      blocks: quanta(0.4),
      input: tone,
      changes: {
        [blockOf(0.05)]: [{ cutoff: 8000, res: 95, drive: 50 }],
        [blockOf(0.07)]: [{ type: type('high12') }],
        [blockOf(0.072)]: [{ type: type('band24') }],
        [blockOf(0.2)]: [{ cutoff: 50, level: 0.2, mix: 0.3 }],
      },
    },
  ],
  [
    'idle, sound, its tail, idle again',
    {
      rate: RATE,
      params: { ...BASE, type: type('ladder12'), cutoff: 600, res: 30 },
      blocks: quanta(1.6),
      input: (n, channel) => (n > 4800 && n < 14400 ? pulse(n, channel) : 0),
    },
  ],
  [
    'cutoff and resonance moved by an envelope every block',
    {
      rate: RATE,
      params: { ...BASE, type: type('ladder24'), cutoff: 800, res: 50 },
      blocks: quanta(0.3),
      input: tone,
      changes: Object.fromEntries(
        quanta(0.3).map((_, block) => [
          block,
          [{ cutoff: 800 * 2 ** (2 * Math.sin(block / 7)), res: 50 + 30 * Math.cos(block / 5) }],
        ])
      ),
    },
  ],
  [
    '22.05 kHz, blocks of 1000, a cutoff over nyquist',
    {
      rate: 22050,
      params: { ...BASE, type: type('high24'), cutoff: 20000, res: 30, pan: 0 },
      blocks: Array<number>(20).fill(1000),
      input: tone,
    },
  ],
];

// a value of a param in its range, sometimes past its ends (the core holds them there)
const valueOf = (random: Random, key: keyof Params) => {
  if (key === 'mix') return random();
  const { min, max } = FX_PARAMS.fxfilter[key];
  if (key === 'type') return Math.floor(random() * (max + 2));
  const value = min + random() * (max - min);
  return random() < 0.1 ? value * 1.3 - 0.1 * max : value;
};

const randomScenario = (random: Random): Scenario => {
  const rate = pick(random, RATES);
  const frames = Math.floor(random() * 0.3 * rate);
  const blocks = randomBlocks(random, frames);
  const changes: Record<number, Partial<Params>[]> = {};
  blocks.forEach((_, block) => {
    if (random() > 0.2) return;
    changes[block] = [
      Object.fromEntries(
        FX_FILTER_KEYS.filter(() => random() < 0.4).map((key) => [key, valueOf(random, key)])
      ),
    ];
  });
  return {
    rate,
    params: Object.fromEntries(
      FX_FILTER_KEYS.filter((key) => key !== 'mix').map((key) => [key, valueOf(random, key)])
    ) as unknown as FxFilterDspParams,
    mix: random(),
    blocks,
    // (NaN, the infinities and 1e30 too: the core takes them as 0)
    input: randomSignal(random, rate, frames, true),
    changes,
  };
};

describe('fxfilter wasm core', () => {
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
    const wasm = createFxFilterWasm(core, RATE, { params: scenario.params });
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
