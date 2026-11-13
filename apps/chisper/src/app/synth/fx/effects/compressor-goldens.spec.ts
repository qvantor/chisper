// first: the Math of JS as jsmath (test-utils/js-math.ts): the inputs and the levels the TS builds the same on every
// machine (Node's own Math differs in the last bits on arm64), so are the goldens
import '../../../../test-utils/js-math';
import { FX_PARAMS } from '@chisper/preset-schema';
import { COMPRESSOR_DEFAULTS, compressorCore } from '../../../../test-utils/compressor-render';
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
import { CompressorDspParams } from './compressor-params';
import { COMPRESSOR_KEYS, createCompressorWasm } from './compressor-wasm';

// the Rust core of the compressor (dsp/compressor): the bits of every output sample of every block on the golden
// scenarios (their hashes in dsp/goldens/compressor.json), and random ones: finite

const core = compressorCore();
const goldens = createGoldens('compressor');
afterAll(() => goldens.save());

type Compressor = ReturnType<typeof createCompressorWasm>;
interface Scenario {
  rate: number;
  params: CompressorDspParams;
  blocks: number[];
  input: Signal;
  // the params set before a block (a message or the knobs the envelopes move)
  changes?: Record<number, Partial<CompressorDspParams>[]>;
}

const run = (name: string, { rate, params, blocks, input, changes = {} }: Scenario) =>
  runStereo<Compressor>(name, {
    core: createCompressorWasm(core, rate, { params }),
    blocks,
    input,
    before: (dsp, block) => changes[block]?.forEach((change) => dsp.set(change)),
  });

const RATE = 48000;
const quanta = (seconds: number, rate = RATE) => Array<number>(Math.ceil((seconds * rate) / 128)).fill(128);
const blockOf = (seconds: number) => Math.floor((seconds * RATE) / 128);
// a chord with a beat: loud and quiet by turns, the channels apart
const beat: Signal = (n, channel) => {
  const level = n % 9600 < 3000 ? 0.7 : 0.04;
  return level * (0.5 * Math.sin(n / 7 + channel) + 0.3 * Math.sin(n / 61) + 0.2 * Math.sin(n / 1.7));
};
const BASE = COMPRESSOR_DEFAULTS;
const MULTI: CompressorDspParams = { ...BASE, multi: 1 };

const GOLDEN: [string, Scenario][] = [
  ['one band, fresh', { rate: RATE, params: BASE, blocks: quanta(0.6), input: beat }],
  [
    'one band, fast and deep, a makeup gain, half a mix',
    {
      rate: RATE,
      params: { ...BASE, thresh: 0.75, ratio: 12, attack: 0.5, release: 20, gain: 0.2, mix: 0.5 },
      blocks: quanta(0.6),
      input: beat,
    },
  ],
  ['three bands, fresh', { rate: RATE, params: MULTI, blocks: quanta(0.6), input: beat }],
  [
    'three bands, down and up, their gains',
    {
      rate: RATE,
      params: { ...MULTI, ratio: 20, below: 0.75, low: 4, mid: -2, high: 6, release: 40, mix: 0.8 },
      blocks: quanta(0.6),
      input: beat,
    },
  ],
  [
    'the mode switched during its fade, and back',
    {
      rate: RATE,
      params: { ...BASE, thresh: 0.7, below: 0.5 },
      blocks: quanta(0.4),
      input: beat,
      changes: {
        [blockOf(0.05)]: [{ multi: 1 }],
        [blockOf(0.05) + 2]: [{ multi: 0 }],
        [blockOf(0.2)]: [{ multi: 1 }],
      },
    },
  ],
  [
    'the crossovers glide, one over the other',
    {
      rate: RATE,
      params: { ...MULTI, below: 0.3 },
      blocks: quanta(0.4),
      input: beat,
      changes: {
        [blockOf(0.05)]: [{ xlow: 900, xhigh: 400 }],
        [blockOf(0.2)]: [{ xlow: 60, xhigh: 9000 }],
      },
    },
  ],
  [
    'idle, sound, idle again',
    {
      rate: RATE,
      params: { ...MULTI, below: 1, release: 30 },
      blocks: quanta(1.6),
      input: (n, channel) => (n > 4800 && n < 14400 ? beat(n, channel) : 0),
    },
  ],
  [
    'the threshold, the makeup and the mix moved by an envelope every block',
    {
      rate: RATE,
      params: { ...BASE, thresh: 0.7 },
      blocks: quanta(0.3),
      input: beat,
      changes: Object.fromEntries(
        quanta(0.3).map((_, block) => [
          block,
          [
            {
              thresh: 0.7 + 0.2 * Math.sin(block / 7),
              gain: 0.1 + 0.1 * Math.cos(block / 5),
              mix: 0.5 + 0.5 * Math.sin(block / 9),
            },
          ],
        ])
      ),
    },
  ],
  [
    '96 kHz, blocks of 1000, three bands',
    {
      rate: 96000,
      params: { ...MULTI, ratio: 8, below: 0.5 },
      blocks: Array<number>(40).fill(1000),
      input: beat,
    },
  ],
  [
    '22.05 kHz, blocks of 37, one band',
    {
      rate: 22050,
      params: { ...BASE, thresh: 0.8, attack: 3 },
      blocks: Array<number>(300).fill(37),
      input: beat,
    },
  ],
];

// a value of a param in its range, sometimes its top beyond it (the core clamps what it needs to)
const valueOf = (random: Random, key: keyof CompressorDspParams) => {
  if (key === 'mix') return random() * (random() < 0.1 ? 1.3 : 1);
  const { min, max } = FX_PARAMS.compressor[key];
  if (key === 'multi') return Math.floor(random() * 2);
  return min + random() * (max - min) * (random() < 0.1 ? 1.3 : 1);
};

const randomScenario = (random: Random): Scenario => {
  const rate = pick(random, RATES);
  const frames = Math.floor(random() * 0.3 * rate);
  const blocks = randomBlocks(random, frames);
  const changes: Record<number, Partial<CompressorDspParams>[]> = {};
  blocks.forEach((_, block) => {
    if (random() > 0.2) return;
    changes[block] = [
      Object.fromEntries(
        COMPRESSOR_KEYS.filter(() => random() < 0.3).map((key) => [key, valueOf(random, key)])
      ),
    ];
  });
  return {
    rate,
    params: Object.fromEntries(
      COMPRESSOR_KEYS.map((key) => [key, valueOf(random, key)])
    ) as unknown as CompressorDspParams,
    blocks,
    // (NaN, the infinities and 1e30 too: the core takes them as 0)
    input: randomSignal(random, rate, frames, true),
    changes,
  };
};

describe('compressor wasm core', () => {
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
    const wasm = createCompressorWasm(core, RATE, { params: scenario.params });
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
