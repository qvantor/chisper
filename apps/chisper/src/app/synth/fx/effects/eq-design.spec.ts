// first: the Math of JS as jsmath (test-utils/js-math.ts): the design of the chart worked out as the core does
import '../../../../test-utils/js-math';
import { EQ_PASS, EQ_PEAK, EQ_SHELF, eqDesign, eqTypeOf } from '@chisper/math/eq';
import { seeded } from '../../../../test-utils/seeded';
import { wasmCore } from '../../../../test-utils/wasm';
import type { CoreExports } from '../../common/wasm/wasm-core';

// The design of the bands the screen draws (libs/math/src/filter/eq.ts) against the one the core plays (design of
// dsp/chain/src/eq.rs, chain_eq_design of the perf build): the same code, so the same bits under jsmath. A change of
// one is made in the other; eq-dsp.spec holds what the core plays to the curve, eq-measured.spec to the Audio Unit

interface DesignExports extends CoreExports {
  unit_command: () => number;
  chain_eq_design: (
    band: number,
    type: number,
    freq: number,
    reso: number,
    gain: number,
    rate: number
  ) => number;
}

const FIELDS = ['g', 'k', 'm0', 'm1', 'm2'];

const core = wasmCore<DesignExports>('engine');

const coreDesign = (band: number, type: number, freq: number, reso: number, gain: number, rate: number) => {
  const count = core.chain_eq_design(band, type, freq, reso, gain, rate);
  return [...new Float64Array(core.memory.buffer, core.unit_command() >>> 0, count)];
};

interface Case {
  band: number;
  type: number;
  freq: number;
  reso: number;
  gain: number;
  rate: number;
}

// the knobs where the two differ (Object.is: the same bits, -0 not 0), the first few of them
const mismatches = (cases: Case[]) => {
  const found: string[] = [];
  let count = 0;
  for (const { band, type, freq, reso, gain, rate } of cases) {
    const drawn = eqDesign(band, eqTypeOf(type), freq, reso, gain, rate);
    const played = coreDesign(band, type, freq, reso, gain, rate);
    const at = drawn.findIndex((value, i) => !Object.is(value, played[i]));
    if (at < 0 && played.length === FIELDS.length) continue;
    count++;
    if (found.length < 5)
      found.push(
        `band ${band} type ${type} ${freq} Hz ${reso} % ${gain} dB at ${rate}: ${FIELDS[at]} chart ${drawn[at]} ≠ core ${played[at]}`
      );
  }
  return count ? [`${count} designs differ`, ...found] : [];
};

const RATES = [22050, 44100, 48000, 96000, 192000];

describe('the design of the bands of the EQ: the screen and the core', () => {
  it('gives the same bits over a grid of the knobs: their ends, past them, every type and band', () => {
    const cases: Case[] = [];
    for (const rate of RATES)
      for (const band of [0, 1])
        for (const type of [EQ_SHELF, EQ_PEAK, EQ_PASS, 0.6, 2.7, -1])
          for (const freq of [5, 20, 21.5, 100, 999.9, 4000, 11000, 19999, 20000, 30000])
            for (const reso of [-10, 0, 0.1, 37.5, 60, 99.9, 100, 150])
              for (const gain of [-40, -24, -6.5, 0, 0.1, 12, 24, 30])
                cases.push({ band, type, freq, reso, gain, rate });
    expect(mismatches(cases)).toEqual([]);
  });

  it('gives the same bits at random knobs', () => {
    const random = seeded(0x0e9);
    const cases = Array.from({ length: 3000 }, (): Case => ({
      band: random() < 0.5 ? 0 : 1,
      type: Math.floor(random() * 3),
      // (log-uniform over the frequencies of the knob and past them)
      freq: 10 * 2400 ** random(),
      reso: -5 + 110 * random(),
      gain: -30 + 60 * random(),
      rate: RATES[Math.floor(random() * RATES.length)],
    }));
    expect(mismatches(cases)).toEqual([]);
  });
});
