import { mapValues } from 'lodash';
import { FX_MIX_PARAMS, FX_PARAMS } from '@chisper/preset-schema';
import { FxPreset } from './types';
import { fxFilterIndexOf } from './fxfilter-params';

export type FxFilterParam = keyof typeof FX_PARAMS.fxfilter;

const DEFAULTS = mapValues(FX_PARAMS.fxfilter, (param) => param.default);

// the knobs are those of the Audio Unit, so its usual settings read the same here
export const FX_FILTER_PRESETS: FxPreset<FxFilterParam>[] = [
  // the schema defaults, the state of a freshly added effect: MG Low 6 at 425 Hz, the gentle top cut of the reference
  { id: 'default', name: 'Default', mix: FX_MIX_PARAMS.fxfilter.default, params: DEFAULTS },
  // the classic warm low pass of a ladder, a little resonant: what an LFO or an envelope on Cutoff sweeps
  {
    id: 'warm-ladder',
    name: 'Warm Ladder',
    mix: 1,
    params: { ...DEFAULTS, type: fxFilterIndexOf('ladder24'), cutoff: 1200, res: 25 },
  },
  // the top gone steeply: a pad or a bass pushed back
  {
    id: 'dark',
    name: 'Dark',
    mix: 1,
    params: { ...DEFAULTS, type: fxFilterIndexOf('low24'), cutoff: 600, res: 10 },
  },
  // the lows of a sound gone under 150 Hz (room for a bass and a kick)
  {
    id: 'low-cut',
    name: 'Low Cut',
    mix: 1,
    params: { ...DEFAULTS, type: fxFilterIndexOf('high12'), cutoff: 150 },
  },
  // a small loudspeaker: a band around 1.5 kHz, a touch of Drive
  {
    id: 'radio',
    name: 'Radio',
    mix: 1,
    params: { ...DEFAULTS, type: fxFilterIndexOf('band12'), cutoff: 1500, res: 35, drive: 30 },
  },
  // a resonant ladder driven hard: the squelch of an acid line under an envelope on Cutoff
  {
    id: 'squelch',
    name: 'Squelch',
    mix: 1,
    params: { ...DEFAULTS, type: fxFilterIndexOf('ladder24'), cutoff: 900, res: 70, drive: 25 },
  },
  // each channel its own cutoff: a resonant low pass wide across the stereo field
  {
    id: 'wide',
    name: 'Wide',
    mix: 1,
    params: { ...DEFAULTS, type: fxFilterIndexOf('low12'), cutoff: 2000, res: 40, pan: 25 },
  },
];
