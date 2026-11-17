// first: the Math of JS as jsmath (test-utils/js-math.ts): the inputs and the levels the TS builds the same on every
// machine (Node's own Math differs in the last bits on arm64), so are the goldens
import '../../../../test-utils/js-math';
import { FX_PARAMS } from '@chisper/preset-schema';
import { DELAY_DEFAULTS, delayCore } from '../../../../test-utils/delay-render';
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
import type { DelayDspParams } from './delay-params';
import { createDelayWasm, DELAY_KEYS } from './delay-wasm';

// the Rust core of the delay (dsp/chain/src/delay.rs): the bits of every output sample of every block on the golden
// scenarios (their hashes in dsp/goldens/delay.json), and random ones: finite

const core = delayCore();
const goldens = createGoldens('delay');
afterAll(() => goldens.save());

type Delay = ReturnType<typeof createDelayWasm>;
interface Scenario {
  rate: number;
  params: DelayDspParams;
  blocks: number[];
  input: Signal;
  // the params set before a block (a message)
  changes?: Record<number, Partial<DelayDspParams>[]>;
}

const run = (name: string, { rate, params, blocks, input, changes = {} }: Scenario) =>
  runStereo<Delay>(name, {
    core: createDelayWasm(core, rate, params),
    blocks,
    input,
    before: (dsp, block) => changes[block]?.forEach((change) => dsp.set(change)),
  });

const RATE = 48000;
const quanta = (seconds: number, rate = RATE) => Array<number>(Math.ceil((seconds * rate) / 128)).fill(128);
const blockOf = (seconds: number) => Math.floor((seconds * RATE) / 128);
// bursts of a few partials, the channels apart
const bursts: Signal = (n, channel) =>
  n % 4800 < 600 ? 0.5 * Math.sin(n / 7 + channel) + 0.3 * Math.sin(n / 3.5) + 0.1 * Math.sin(n / 1.2) : 0;
const BASE: DelayDspParams = { ...DELAY_DEFAULTS, time: 0.031 };

const GOLDEN: [string, Scenario][] = [
  ['normal, the defaults', { rate: RATE, params: BASE, blocks: quanta(0.4), input: bursts }],
  [
    'ping-pong, a channel late',
    {
      rate: RATE,
      params: { ...BASE, mode: 1, fb: 0.8, pan: 0.011 },
      blocks: quanta(0.4),
      input: bursts,
    },
  ],
  [
    'a narrow bandpass, the other channel late',
    {
      rate: RATE,
      params: { ...BASE, time: 0.0123, fb: 0.9, freq: 2500, q: 3, pan: -0.0037 },
      blocks: quanta(0.4),
      input: bursts,
    },
  ],
  [
    'the time glides down and up',
    {
      rate: RATE,
      params: { ...BASE, fb: 0.7 },
      blocks: quanta(0.6),
      input: bursts,
      changes: { [blockOf(0.1)]: [{ time: 0.01 }], [blockOf(0.3)]: [{ time: 0.08 }] },
    },
  ],
  [
    'the mode, the feedback, the pan and the filter glide',
    {
      rate: RATE,
      params: BASE,
      blocks: quanta(0.6),
      input: bursts,
      changes: {
        [blockOf(0.1)]: [{ mode: 1, fb: 0.85 }],
        [blockOf(0.2)]: [{ pan: 0.02, freq: 4000, q: 1.5 }],
        [blockOf(0.4)]: [{ mode: 0, pan: -0.005, freq: 300 }],
      },
    },
  ],
  [
    'idle, sound, idle again',
    {
      rate: RATE,
      params: { ...BASE, fb: 0.3 },
      blocks: quanta(2.5),
      input: (n, channel) => (n > 4800 && n < 14400 ? bursts(n, channel) : 0),
    },
  ],
  [
    '96 kHz, blocks of 1000',
    {
      rate: 96000,
      params: { ...BASE, mode: 1, pan: 0.003 },
      blocks: Array<number>(40).fill(1000),
      input: bursts,
    },
  ],
  [
    '192 kHz, blocks of 37',
    {
      rate: 192000,
      params: { ...BASE, time: 0.0071, fb: 0.6 },
      blocks: Array<number>(800).fill(37),
      input: bursts,
    },
  ],
];

// a value of a param in its range, sometimes beyond its top (the core clamps its times)
const valueOf = (random: Random, key: keyof DelayDspParams) => {
  const { min, max } = FX_PARAMS.delay[key];
  if (key === 'mode') return Math.floor(random() * 2);
  return min + random() * (max - min) * (random() < 0.1 ? 1.3 : 1);
};

const randomScenario = (random: Random): Scenario => {
  const rate = pick(random, RATES);
  const frames = Math.floor(random() * 0.3 * rate);
  const blocks = randomBlocks(random, frames);
  const changes: Record<number, Partial<DelayDspParams>[]> = {};
  blocks.forEach((_, block) => {
    if (random() > 0.2) return;
    changes[block] = [
      Object.fromEntries(DELAY_KEYS.filter(() => random() < 0.4).map((key) => [key, valueOf(random, key)])),
    ];
  });
  return {
    rate,
    params: Object.fromEntries(
      DELAY_KEYS.map((key) => [key, valueOf(random, key)])
    ) as unknown as DelayDspParams,
    blocks,
    // (NaN, the infinities and 1e30 too: the core takes them as 0)
    input: randomSignal(random, rate, frames, true),
    changes,
  };
};

describe('delay wasm core', () => {
  it.each(GOLDEN)('%s: its golden', (name, scenario) => {
    goldens.check(name, run(name, scenario));
  });

  const count = 300 * FUZZ_SCALE;
  it(`renders ${count} random scenarios, finite`, () => {
    for (let seed = 1; seed <= count; seed++) run(`seed ${seed}`, randomScenario(seeded(seed)));
  });

  const idleScenario = () => (GOLDEN.find(([name]) => name.startsWith('idle')) as [string, Scenario])[1];

  it('takes NaN and the infinities as 0: finite all along, idle after the sound', () => {
    const scenario = idleScenario();
    const input = withSpecials(scenario.input);
    const wasm = createDelayWasm(core, RATE, scenario.params);
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

  it('goes idle in the silences, sounds in between', () => {
    const scenario = idleScenario();
    const wasm = createDelayWasm(core, RATE, scenario.params);
    let frame = 0;
    const idles: boolean[] = [];
    scenario.blocks.forEach((n) => {
      const input = Float32Array.from({ length: n }, (_, i) => scenario.input(frame + i, 0));
      const outs = [0, 1].map(() => new Float32Array(n));
      wasm.process(input, input, outs[0], outs[1]);
      idles.push(wasm.idle);
      frame += n;
    });
    // idle before the sound (4800 frames), awake through it and its echoes, idle again after them
    expect(idles[0]).toBe(true);
    expect(idles[60]).toBe(false);
    expect(idles.filter((idle) => idle).length).toBeGreaterThan(10);
    expect(idles.at(-1)).toBe(true);
    wasm.free();
  });
});
