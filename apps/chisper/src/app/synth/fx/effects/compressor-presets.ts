import { mapValues } from 'lodash';
import { FX_MIX_PARAMS, FX_PARAMS } from '@chisper/preset-schema';
import { FxPreset } from './types';

export type CompressorParam = keyof typeof FX_PARAMS.compressor;

const DEFAULTS = mapValues(FX_PARAMS.compressor, (param) => param.default);
const ONE_BAND = 0;
const THREE_BANDS = 1;

// three bands pressed down hard over their thresholds and lifted under them, their gains those of the well known
// setting of that name, a makeup gain that brings a held note back to about its level
const OTT = {
  ...DEFAULTS,
  multi: THREE_BANDS,
  ratio: 20,
  below: 0.75,
  low: 10.3,
  mid: 5.7,
  high: 10.3,
  gain: 0.04,
};

// the knobs are those of the Audio Unit, so its usual settings read the same here
export const COMPRESSOR_PRESETS: FxPreset<CompressorParam>[] = [
  // the schema defaults, the state of a freshly added effect
  { id: 'default', name: 'Default', mix: FX_MIX_PARAMS.compressor.default, params: DEFAULTS },
  // a couple of dB off the peaks, slow enough to let the attacks through: the notes of a chord sit together
  {
    id: 'glue',
    name: 'Glue',
    mix: 1,
    params: { ...DEFAULTS, multi: ONE_BAND, thresh: 0.55, ratio: 2, attack: 30, release: 200, gain: 0.02 },
  },
  // fast and deep: every note at one level
  {
    id: 'tight',
    name: 'Tight',
    mix: 1,
    params: { ...DEFAULTS, multi: ONE_BAND, thresh: 0.65, ratio: 8, attack: 2, release: 60, gain: 0.08 },
  },
  // heavily squashed under the dry sound: its body without its peaks
  {
    id: 'parallel',
    name: 'Parallel',
    mix: 0.4,
    params: { ...DEFAULTS, multi: ONE_BAND, thresh: 0.75, ratio: 12, attack: 5, release: 120, gain: 0.15 },
  },
  // the dense, bright sound of modern basses and leads
  {
    id: 'ott',
    name: 'OTT',
    mix: 1,
    params: OTT,
  },
  // the same under the dry sound
  {
    id: 'ott-half',
    name: 'OTT 50%',
    mix: 0.5,
    params: OTT,
  },
  // the bands only pressed down, gently: an even tone, no lift of the quiet
  {
    id: 'multiband-glue',
    name: 'Multiband glue',
    mix: 1,
    params: { ...DEFAULTS, multi: THREE_BANDS, thresh: 0.45, ratio: 3, release: 150, gain: 0.03 },
  },
];
