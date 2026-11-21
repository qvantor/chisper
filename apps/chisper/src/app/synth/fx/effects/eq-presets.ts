import { mapValues } from 'lodash';
import { FX_MIX_PARAMS, FX_PARAMS } from '@chisper/preset-schema';
import { EQ_PASS, EQ_PEAK, EQ_SHELF } from '@chisper/math/eq';
import { FxPreset } from './types';

export type EqParam = keyof typeof FX_PARAMS.eq;

const DEFAULTS = mapValues(FX_PARAMS.eq, (param) => param.default);

// the knobs are those of the Audio Unit, so its usual settings read the same here; the resonance of a flat corner
// (Q 0.707): 42 % of a pass, 56 % of a shelf
export const EQ_PRESETS: FxPreset<EqParam>[] = [
  // the schema defaults, the state of a freshly added effect: shelves at 0 dB, the sound as it is
  { id: 'default', name: 'Default', mix: FX_MIX_PARAMS.eq.default, params: DEFAULTS },
  // the rumble and the mud under a part gone: a highpass of 12 dB an octave at 120 Hz
  {
    id: 'low-cut',
    name: 'Low Cut',
    mix: 1,
    params: { ...DEFAULTS, t1: EQ_PASS, f1: 120, q1: 42 },
  },
  // brightness over 10 kHz: a high shelf up 4 dB
  {
    id: 'air',
    name: 'Air',
    mix: 1,
    params: { ...DEFAULTS, t2: EQ_SHELF, f2: 10000, q2: 56, g2: 4 },
  },
  // the mids pulled back, the lows and the highs left: a wide peak down 8 dB at 700 Hz
  {
    id: 'mid-scoop',
    name: 'Mid Scoop',
    mix: 1,
    params: { ...DEFAULTS, t1: EQ_PEAK, f1: 700, q1: 44, g1: -8 },
  },
  // the band of a phone line: highpass at 400 Hz, lowpass at 3 kHz, each a little resonant
  {
    id: 'telephone',
    name: 'Telephone',
    mix: 1,
    params: { ...DEFAULTS, t1: EQ_PASS, f1: 400, q1: 50, t2: EQ_PASS, f2: 3000, q2: 50 },
  },
];
