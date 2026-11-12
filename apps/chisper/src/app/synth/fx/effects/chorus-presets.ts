import { mapValues } from 'lodash';
import { divisionIndex, FX_MIX_PARAMS, FX_PARAMS } from '@chisper/preset-schema';
import { FxPreset } from './types';

export type ChorusParam = keyof typeof FX_PARAMS.chorus;

const defaults = mapValues(FX_PARAMS.chorus, (param) => param.default);
// a preset in Hz: the knobs it sets over the defaults (BPM off)
const hz = (params: Partial<Record<ChorusParam, number>>): Record<ChorusParam, number> => ({
  ...defaults,
  ...params,
});
// a preset in BPM: a cycle of the LFO a division of the tempo
const bpm = (id: string, params: Partial<Record<ChorusParam, number>>) =>
  hz({ ...params, sync: 1, div: divisionIndex(id) });

// the level stays at its middle (0 dB): the mix keeps a note about as loud as the dry one
export const CHORUS_PRESETS: FxPreset<ChorusParam>[] = [
  // the schema defaults, the state of a freshly added effect: a slow, deep sweep, dark
  { id: 'default', name: 'Default', mix: FX_MIX_PARAMS.chorus.default, params: defaults },
  // a little width under the dry sound
  {
    id: 'subtle',
    name: 'Subtle',
    mix: 0.3,
    params: hz({ rate: 0.25, d1: 8, d2: 4, depth: 1, fb: 0, cut: 8000 }),
  },
  // the classic: two taps a channel a few ms apart, slowly detuned against each other
  {
    id: 'wide',
    name: 'Wide',
    mix: 0.5,
    params: hz({ rate: 0.5, d1: 12, d2: 6, depth: 2, fb: 0.1, cut: 10000 }),
  },
  // faster and thicker, a string machine
  {
    id: 'ensemble',
    name: 'Ensemble',
    mix: 0.6,
    params: hz({ rate: 1.6, d1: 9, d2: 5, depth: 1.5, fb: 0.2, cut: 6000 }),
  },
  // short taps with a high feedback: the comb of a flanger, sweeping
  {
    id: 'flange',
    name: 'Flange',
    mix: 0.5,
    params: hz({ rate: 0.15, d1: 1, d2: 0, depth: 1.2, fb: 0.8, cut: 14000 }),
  },
  // the wet signal alone, fast and shallow: the pitch wobbles
  {
    id: 'warble',
    name: 'Warble',
    mix: 1,
    params: hz({ rate: 5, d1: 4, d2: 4, depth: 0.5, fb: 0, cut: 12000 }),
  },
  // long taps, dark, with a tail
  {
    id: 'dark',
    name: 'Dark',
    mix: 0.5,
    params: hz({ rate: 0.3, d1: 18, d2: 11, depth: 3, fb: 0.35, cut: 1500 }),
  },
  // the lows stay dry and in place: only the highs spread
  {
    id: 'air',
    name: 'Air',
    mix: 0.45,
    params: hz({ rate: 0.4, d1: 7, d2: 3, depth: 2, fb: 0.1, cut: 600, hpf: 1 }),
  },
  // a sweep of two bars, in time
  {
    id: 'tempo-sweep',
    name: 'Tempo sweep',
    mix: 0.5,
    params: bpm('2 bar', { d1: 6, d2: 1, depth: 6, fb: 0.3, cut: 9000 }),
  },
];
