// first: the Math of JS as jsmath (test-utils/js-math.ts): the design of the chart worked out as the core does
import '../../../test-utils/js-math';
import { filterModel } from '@chisper/math';
import { seeded } from '../../../test-utils/seeded';
import { wasmCore } from '../../../test-utils/wasm';
import type { CoreExports } from '../common/wasm/wasm-core';

// The design of the model types the chart draws (libs/math/src/filter/model.ts) against the one the core plays
// (model_design of dsp/dsp-core/src/filter_model.rs, osc_model_design of the perf build of wavetable-osc): the same
// code, so the same bits under jsmath. A change of one is made in the other; filter-types-measured.spec holds the
// design of the chart to the Audio Unit

interface DesignExports extends CoreExports {
  osc_command: () => number;
  osc_model_design: (
    type: number,
    cutoff: number,
    resonance: number,
    variation: number,
    rate: number
  ) => number;
}

// the values osc_model_design writes: the count of the state variable filters, g, k and the mix of two, whether it
// has a one-pole, its g and mix, the droop, FAT
const FIELDS = [
  'svfs',
  ...[0, 1].flatMap((s) => ['g', 'k', 'mix[0]', 'mix[1]', 'mix[2]'].map((f) => `svf[${s}].${f}`)),
  'pole',
  'pole.g',
  'pole.mix[0]',
  'pole.mix[1]',
  'droop',
  'fat',
];

const core = wasmCore<DesignExports>('engine');

const coreDesign = (
  index: number,
  { cutoff, resonance, variation }: filterModel.ModelKnobs,
  rate: number
) => {
  if (!core.osc_model_design(index, cutoff, resonance, variation, rate)) throw new Error(`no type ${index}`);
  return [...new Float64Array(core.memory.buffer, core.osc_command() >>> 0, FIELDS.length)];
};

const chartDesign = (type: filterModel.ModelFilterType, knobs: filterModel.ModelKnobs, rate: number) => {
  const { svf, pole, droop, fat } = filterModel.modelDesign(type, knobs, rate);
  const section = (s: filterModel.SvfSection | undefined) => (s ? [s.g, s.k, ...s.mix] : [0, 0, 0, 0, 0]);
  return [
    svf.length,
    ...section(svf[0]),
    ...section(svf[1]),
    pole ? 1 : 0,
    ...(pole ? [pole.g, ...pole.mix] : [0, 0, 0]),
    droop,
    fat,
  ];
};

// the knobs where the two differ (Object.is: the same bits, -0 not 0), the first few of them
const mismatches = (cases: { knobs: filterModel.ModelKnobs; rate: number }[]) => {
  const found: string[] = [];
  let count = 0;
  filterModel.MODEL_FILTER_TYPES.forEach((type, index) => {
    for (const { knobs, rate } of cases) {
      const chart = chartDesign(type, knobs, rate);
      const played = coreDesign(index, knobs, rate);
      const at = chart.findIndex((value, i) => !Object.is(value, played[i]));
      if (at < 0) continue;
      count++;
      if (found.length < 5)
        found.push(
          `${type} ${JSON.stringify(knobs)} at ${rate}: ${FIELDS[at]} chart ${chart[at]} ≠ core ${played[at]}`
        );
    }
  });
  return count ? [`${count} designs differ`, ...found] : [];
};

const RATES = [44100, 48000, 96000];

describe('the design of the model types: the chart and the core', () => {
  it('has the same types in the same order', () => {
    expect(core.osc_model_design(filterModel.MODEL_FILTER_TYPES.length, 1000, 0, 0, 48000)).toBe(0);
    filterModel.MODEL_FILTER_TYPES.forEach((_, index) =>
      expect(core.osc_model_design(index, 1000, 0, 0, 48000)).toBe(1)
    );
  });

  it('gives the same bits over a grid of the knobs: their ends, past them, a cutoff over the top of a design', () => {
    const cutoffs = [0.5, 1, 20, 110, 440, 1000, 3000, 8000, 15000, 19000, 22000, 30000];
    const resonances = [-0.1, 0, 0.05, 0.4, 0.6, 0.9, 1, 1.2];
    const variations = [0, 0.25, 0.5, 1];
    const cases = RATES.flatMap((rate) =>
      cutoffs.flatMap((cutoff) =>
        resonances.flatMap((resonance) =>
          variations.map((variation) => ({ knobs: { cutoff, resonance, variation }, rate }))
        )
      )
    );
    expect(mismatches(cases)).toEqual([]);
  });

  // nearly without resonance the poles of a prototype are real ones found another way (the pair as it lands, the
  // two real roots, past the meeting of the second with the root of the delay): every 1/24 octave from 0.02 fs to
  // the top, Res from 0 to 1.2 % (over 1 % the pair again)
  it('gives the same bits where the poles of a prototype nearly without resonance are real', () => {
    const resonances = [0, 0.00002, 0.0002, 0.0005, 0.001, 0.003, 0.008, 0.0092, 0.012];
    const cases = RATES.flatMap((rate) => {
      const cutoffs: number[] = [];
      for (let f = 0.02 * rate; f < 0.47 * rate; f *= 2 ** (1 / 24)) cutoffs.push(f);
      return cutoffs.flatMap((cutoff) =>
        resonances.map((resonance) => ({ knobs: { cutoff, resonance, variation: 0 }, rate }))
      );
    });
    expect(mismatches(cases)).toEqual([]);
  });

  // with some resonance the real root of a prototype comes nearer than its pair at the top of the cutoff and the
  // pair is found another way there (steps of Halley from a start of its own; the second sections too)
  it('gives the same bits where the real root of a prototype passes its pair', () => {
    const resonances = [0.0096, 0.0099, 0.0105, 0.02, 0.03, 0.05, 0.1, 0.2, 0.5, 1];
    const cases = RATES.flatMap((rate) => {
      const cutoffs: number[] = [];
      for (let f = 0.1 * rate; f < 0.47 * rate; f *= 2 ** (1 / 48)) cutoffs.push(f);
      return cutoffs.flatMap((cutoff) =>
        resonances.map((resonance) => ({ knobs: { cutoff, resonance, variation: 0 }, rate }))
      );
    });
    expect(mismatches(cases)).toEqual([]);
  });

  it('gives the same bits at random knobs', () => {
    const random = seeded(0x5eed);
    const cases = Array.from({ length: 1500 }, () => ({
      knobs: {
        // (log-uniform over the cutoffs of the knob and past them)
        cutoff: 10 * 2400 ** random(),
        resonance: random(),
        variation: random(),
      },
      rate: RATES[Math.floor(random() * RATES.length)],
    }));
    expect(mismatches(cases)).toEqual([]);
  });
});
