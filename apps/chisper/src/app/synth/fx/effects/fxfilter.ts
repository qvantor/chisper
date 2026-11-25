import { FX_PARAMS } from '@chisper/preset-schema';
import { filterModel } from '@chisper/math';
import { FILTER_TYPE_NAMES } from '../../filter/filter-types';
import { FxDefinition } from './types';
import { FX_FILTER_PRESETS, FxFilterParam } from './fxfilter-presets';
import { FX_FILTER_TYPES, fxFilterTypeOf } from './fxfilter-params';
import { formatHz, formatPercent } from './format';
import { levelParam } from './level';

const { type, cutoff, res, drive, var: fat, pan, level } = FX_PARAMS.fxfilter;

// Pan as the reference shows it: % of its travel, the middle none
const formatPan = (value: number) => (Math.round(value) === 50 ? 'C' : formatPercent(value));

// The FX Filter is a unit of the chain core (dsp/chain/src/fxfilter.rs): the model types of the filter of a voice on
// the sum, with the knobs, the laws and the defaults of the FX Filter of the Audio Unit (dsp/measurements/
// fxfilter.json; MG Low 6 at 425 Hz). It mixes the dry signal itself (Law::Inside: the law of the reference, wet
// sin²(π mix / 2), dry 1 - wet², in time with it), so the mix of the slot is one more of its params
export const fxfilter: FxDefinition<FxFilterParam> = {
  label: 'Filter',
  params: {
    type: {
      ...type,
      label: 'Type',
      options: FX_FILTER_TYPES.map((id) => ({ id, label: FILTER_TYPE_NAMES[id] })),
    },
    cutoff: { ...cutoff, label: 'Cutoff', name: 'Cutoff', mode: 'log', precision: 1, formatValue: formatHz },
    res: { ...res, label: 'Res', name: 'Resonance', precision: 10, formatValue: formatPercent },
    drive: { ...drive, label: 'Drive', name: 'Drive', precision: 10, formatValue: formatPercent },
    var: {
      ...fat,
      label: 'Fat',
      name: 'Fat (the gain into the filter by the resonance)',
      precision: 10,
      formatValue: formatPercent,
    },
    pan: {
      ...pan,
      label: 'Pan',
      name: 'Cutoff of left against right',
      precision: 10,
      fillFrom: 50,
      formatValue: formatPan,
    },
    level: levelParam(level),
  },
  presets: FX_FILTER_PRESETS,
  core: (params) => params,
  // a one-pole (Low and High 6) reads no resonance; Low and High 6 and the notches no Fat (filterModel.modelKnobsOf)
  unheard: (params) => {
    const uses = filterModel.modelKnobsOf(fxFilterTypeOf(params['type']));
    return [...(uses.resonance ? [] : ['res']), ...(uses.variation ? [] : ['var'])];
  },
};
