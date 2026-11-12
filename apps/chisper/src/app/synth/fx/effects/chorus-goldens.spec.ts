// first: the Math of JS as jsmath (test-utils/js-math.ts): the inputs and the levels the TS builds the same on every
// machine (Node's own Math differs in the last bits on arm64), so are the goldens
import '../../../../test-utils/js-math';
import { FX_PARAMS } from '@chisper/preset-schema';
import { CHORUS_DEFAULTS, chorusCore } from '../../../../test-utils/chorus-render';
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
import { ChorusDspParams } from './chorus-params';
import { CHORUS_KEYS, createChorusWasm } from './chorus-wasm';

// the Rust core of the chorus (dsp/chorus): the bits of every output sample of every block on the golden scenarios
// (their hashes in dsp/goldens/chorus.json), and random ones: finite

const core = chorusCore();
const goldens = createGoldens('chorus');
afterAll(() => goldens.save());

type Chorus = ReturnType<typeof createChorusWasm>;
interface Scenario {
  rate: number;
  params: ChorusDspParams;
  blocks: number[];
  input: Signal;
  // the params set before a block (a message or the knobs the routes move)
  changes?: Record<number, Partial<ChorusDspParams>[]>;
}

const run = (name: string, { rate, params, blocks, input, changes = {} }: Scenario) =>
  runStereo<Chorus>(name, {
    core: createChorusWasm(core, rate, { params }),
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
const BASE = CHORUS_DEFAULTS;

const GOLDEN: [string, Scenario][] = [
  ['fresh', { rate: RATE, params: BASE, blocks: quanta(0.6), input: beat }],
  [
    'a fast LFO, long taps, a high feedback, a high pass',
    {
      rate: RATE,
      params: { ...BASE, rate: 7, d1: 18, d2: 9, depth: 3, fb: 0.9, cut: 700, hpf: 1, mix: 0.8 },
      blocks: quanta(0.6),
      input: beat,
    },
  ],
  [
    'a flanger: taps at 0 with no depth, the feedback at its top',
    {
      rate: RATE,
      params: { ...BASE, rate: 0.5, d1: 0, d2: 0, depth: 0, fb: 0.95, cut: 20000, mix: 1 },
      blocks: quanta(0.4),
      input: beat,
    },
  ],
  [
    'the LFO at its top over all of its depth: the taps cross samples in every group',
    {
      rate: RATE,
      params: { ...BASE, rate: 20, depth: 26, fb: 0.3, cut: 6000 },
      blocks: quanta(0.4),
      input: beat,
    },
  ],
  [
    'the delays, the depth and the rate jump: the taps glide there',
    {
      rate: RATE,
      params: { ...BASE, rate: 1, depth: 4 },
      blocks: quanta(0.5),
      input: beat,
      changes: {
        [blockOf(0.05)]: [{ d1: 20, d2: 12 }],
        [blockOf(0.2)]: [{ depth: 0, rate: 9 }],
        [blockOf(0.35)]: [{ d1: 0, d2: 0, depth: 26 }],
      },
    },
  ],
  [
    'the filter switched and swept, the mix and the level',
    {
      rate: RATE,
      params: { ...BASE, rate: 2, depth: 2 },
      blocks: quanta(0.4),
      input: beat,
      changes: {
        [blockOf(0.05)]: [{ hpf: 1, cut: 5000 }],
        [blockOf(0.15)]: [{ hpf: 0, cut: 80, mix: 1, level: 1 }],
        [blockOf(0.3)]: [{ cut: 20000, mix: 0, level: 0.2 }],
      },
    },
  ],
  [
    'idle, sound, idle again',
    {
      rate: RATE,
      params: { ...BASE, fb: 0.2 },
      blocks: quanta(1.6),
      input: (n, channel) => (n > 4800 && n < 14400 ? beat(n, channel) : 0),
    },
  ],
  [
    'the feedback, the cutoff and the mix moved by an envelope every block',
    {
      rate: RATE,
      params: { ...BASE, rate: 3, depth: 2 },
      blocks: quanta(0.3),
      input: beat,
      changes: Object.fromEntries(
        quanta(0.3).map((_, block) => [
          block,
          [
            {
              fb: 0.5 + 0.4 * Math.sin(block / 7),
              cut: 2000 * 2 ** (2 * Math.cos(block / 5)),
              mix: 0.5 + 0.5 * Math.sin(block / 9),
            },
          ],
        ])
      ),
    },
  ],
  [
    '96 kHz, blocks of 1000',
    {
      rate: 96000,
      params: { ...BASE, rate: 4, depth: 6, fb: 0.5 },
      blocks: Array<number>(40).fill(1000),
      input: beat,
    },
  ],
  [
    '22.05 kHz, blocks of 37: the taps under the samples of a group',
    {
      rate: 22050,
      params: { ...BASE, rate: 2, depth: 1, fb: 0.6 },
      blocks: Array<number>(300).fill(37),
      input: beat,
    },
  ],
];

// a value of a param in its range, sometimes its top beyond it (the core clamps what it needs to)
const valueOf = (random: Random, key: keyof ChorusDspParams) => {
  if (key === 'mix') return random() * (random() < 0.1 ? 1.3 : 1);
  const { min, max } = FX_PARAMS.chorus[key];
  if (key === 'hpf') return Math.floor(random() * 2);
  return min + random() * (max - min) * (random() < 0.1 ? 1.3 : 1);
};

const randomScenario = (random: Random): Scenario => {
  const rate = pick(random, RATES);
  const frames = Math.floor(random() * 0.3 * rate);
  const blocks = randomBlocks(random, frames);
  const changes: Record<number, Partial<ChorusDspParams>[]> = {};
  blocks.forEach((_, block) => {
    if (random() > 0.2) return;
    changes[block] = [
      Object.fromEntries(CHORUS_KEYS.filter(() => random() < 0.3).map((key) => [key, valueOf(random, key)])),
    ];
  });
  return {
    rate,
    params: Object.fromEntries(
      CHORUS_KEYS.map((key) => [key, valueOf(random, key)])
    ) as unknown as ChorusDspParams,
    blocks,
    // (NaN, the infinities and 1e30 too: the core takes them as 0)
    input: randomSignal(random, rate, frames, true),
    changes,
  };
};

describe('chorus wasm core', () => {
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
    const wasm = createChorusWasm(core, RATE, { params: scenario.params });
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
