import { FX_PARAMS } from '@chisper/preset-schema';
import { EQ_PASS, eqTypeOf } from '@chisper/math/eq';
import { FxDefinition, FxParamDef } from './types';
import { EQ_BANDS, eqTypeOptions } from './eq-params';
import { EqParam, EQ_PRESETS } from './eq-presets';
import { formatDb, formatHz, formatPercent } from './format';
import { levelParam } from './level';

const { t1, f1, q1, g1, t2, f2, q2, g2, level } = FX_PARAMS.eq;

const freq = { label: 'Freq', mode: 'log', precision: 1, formatValue: formatHz } as const;
const reso = { label: 'Q', precision: 10, formatValue: formatPercent } as const;
const gain = { label: 'Gain', precision: 10, fillFrom: 0, formatValue: formatDb } as const;
const band = (
  index: number
): Record<'type' | 'freq' | 'reso' | 'gain', Omit<FxParamDef, 'min' | 'max' | 'default'>> => ({
  type: { label: 'Type', options: eqTypeOptions(index) },
  freq: { ...freq, name: `Band ${index + 1} frequency` },
  reso: { ...reso, name: `Band ${index + 1} resonance` },
  gain: { ...gain, name: `Band ${index + 1} gain` },
});
const [one, two] = [band(0), band(1)];

// The EQ is a unit of the chain core (dsp/chain/src/eq.rs): two bands of the Audio EQ Cookbook with the knobs, the
// laws and the defaults of the Audio Unit (dsp/measurements/eq.json), then the level. Its slot mixes it linearly (the
// wet signal is the dry one filtered, in time with it: no latency); a mix under 1 combs with the phase of the bands
export const eq: FxDefinition<EqParam> = {
  label: 'EQ',
  params: {
    t1: { ...t1, ...one.type },
    f1: { ...f1, ...one.freq },
    q1: { ...q1, ...one.reso },
    g1: { ...g1, ...one.gain },
    t2: { ...t2, ...two.type },
    f2: { ...f2, ...two.freq },
    q2: { ...q2, ...two.reso },
    g2: { ...g2, ...two.gain },
    level: levelParam(level),
  },
  presets: EQ_PRESETS,
  core: (params) => params,
  // a pass reads no gain; a shelf or a peak at 0 dB no route moves the gain of is the input whatever its frequency
  // and resonance (the core leaves such a band out: neutral of eq.rs)
  unheard: (params, routed) =>
    EQ_BANDS.flatMap(({ type, freq, reso, gain }) => {
      if (eqTypeOf(params[type]) === EQ_PASS) return [gain];
      return params[gain] === 0 && !routed.includes(gain) ? [freq, reso] : [];
    }),
};
