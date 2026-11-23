import { mapValues } from 'lodash';
import { divisionIndex, FX_MIX_PARAMS, FX_PARAMS } from '@chisper/preset-schema';
import { FxPreset } from './types';

export type DelayParam = keyof typeof FX_PARAMS.delay;

const NORMAL = 0;
const PING_PONG = 1;
// the time in ms: BPM off, its division the default one
const MS = { sync: 0, div: FX_PARAMS.delay.div.default, trip: 0, dot: 0 };
// the time in a division of the tempo (a triplet with TRIP, a dotted one with DOT)
const bpm = (id: string) => ({
  sync: 1,
  div: divisionIndex(id),
  trip: id.endsWith('T') ? 1 : 0,
  dot: id.endsWith('D') ? 1 : 0,
});

// The presets voiced on the delay of the native nodes, kept for the laws of this one (the Audio Unit's): their echoes
// as loud against the dry sound (the wet sin², the dry 1 - wet²), the same decay and tone. Ping-pong takes its
// feedback and its bandpass once a round (the right echo is the left one): about the square of the feedback, a
// bandpass a little narrower, fitted to the energy of each round and of each octave of the echoes (within 0.6 dB);
// the comb keeps its decay in seconds
export const DELAY_PRESETS: FxPreset<DelayParam>[] = [
  // the schema defaults, the state of a freshly added effect
  {
    id: 'default',
    name: 'Default',
    mix: FX_MIX_PARAMS.delay.default,
    params: mapValues(FX_PARAMS.delay, (param) => param.default),
  },
  {
    id: 'slapback',
    name: 'Slapback',
    mix: 0.45,
    params: { ...MS, mode: NORMAL, time: 0.09, fb: 0.1, pan: 0, freq: 2500, q: 0.3 },
  },
  {
    id: 'stereo-widener',
    name: 'Stereo widener',
    mix: 0.48,
    params: { ...MS, mode: NORMAL, time: 0.012, fb: 0, pan: 0.018, freq: 6000, q: 0.05 },
  },
  {
    id: 'digital-echo',
    name: 'Digital echo',
    mix: 0.41,
    params: { ...MS, mode: NORMAL, time: 0.3, fb: 0.45, pan: 0, freq: 9000, q: 0.05 },
  },
  {
    id: 'ping-pong-250',
    name: 'Ping-pong 250ms',
    mix: 0.39,
    params: { ...MS, mode: PING_PONG, time: 0.25, fb: 0.2, pan: 0, freq: 2000, q: 0.22 },
  },
  {
    id: 'echo-375',
    name: 'Echo 375ms',
    mix: 0.41,
    params: { ...MS, mode: NORMAL, time: 0.375, fb: 0.4, pan: 0.01, freq: 1800, q: 0.3 },
  },
  {
    id: 'echo-500',
    name: 'Echo 500ms',
    mix: 0.41,
    params: { ...MS, mode: NORMAL, time: 0.5, fb: 0.35, pan: 0, freq: 2500, q: 0.2 },
  },
  {
    id: 'ping-pong-wide',
    name: 'Wide ping-pong',
    mix: 0.41,
    params: { ...MS, mode: PING_PONG, time: 0.4, fb: 0.3, pan: 0.02, freq: 3500, q: 0.12 },
  },
  {
    id: 'tape-echo',
    name: 'Tape echo',
    mix: 0.45,
    params: { ...MS, mode: NORMAL, time: 0.33, fb: 0.55, pan: 0, freq: 1200, q: 0.8 },
  },
  {
    id: 'dub',
    name: 'Dub',
    mix: 0.45,
    params: { ...MS, mode: PING_PONG, time: 0.5, fb: 0.56, pan: 0, freq: 800, q: 1.51 },
  },
  {
    id: 'ambient-wash',
    name: 'Ambient wash',
    mix: 0.5,
    params: { ...MS, mode: PING_PONG, time: 0.6, fb: 0.72, pan: 0.03, freq: 3000, q: 0.07 },
  },
  {
    id: 'lo-fi',
    name: 'Lo-fi',
    mix: 0.48,
    params: { ...MS, mode: NORMAL, time: 0.16, fb: 0.5, pan: 0, freq: 1500, q: 2.5 },
  },
  {
    id: 'comb',
    name: 'Metallic comb',
    mix: 0.41,
    params: { ...MS, mode: NORMAL, time: 0.03, fb: 0.81, pan: 0, freq: 5000, q: 0.5 },
  },
  // in time with the tempo: the dotted eighth of a lead, a quarter bouncing between the sides
  {
    id: 'dotted-eighth',
    name: 'Dotted 1/8',
    mix: 0.41,
    params: { ...bpm('1/8D'), mode: NORMAL, time: 0.375, fb: 0.4, pan: 0, freq: 2500, q: 0.2 },
  },
  {
    id: 'ping-pong-quarter',
    name: 'Ping-pong 1/4',
    mix: 0.39,
    params: { ...bpm('1/4'), mode: PING_PONG, time: 0.5, fb: 0.2, pan: 0, freq: 2000, q: 0.22 },
  },
];
