import { divisionWithin } from '@chisper/preset-schema';
import { number } from '@chisper/math';

// a knob of an effect in BPM (Time of the delay, Rate of the chorus): its params `sync` (the switch), `div` (its
// division), `trip` and `dot` (which divisions are its steps)

export const isOn = (value: number) => value >= 0.5;

export const OFF_ON = [
  { id: 'off', label: 'Off' },
  { id: 'on', label: 'On' },
];

type Params = Record<string, number>;

interface Options {
  // the key of the knob and its range
  knob: string;
  range: { min: number; max: number };
  // the steps of the knob in BPM by TRIP and DOT, left to right
  steps: (trip: boolean, dot: boolean) => number[];
  // a division in the units of the knob at a tempo (as the effect plays it)
  valueOf: (division: number, bpm: number) => number;
  // the step nearest to a value of the knob at a tempo
  nearest: (value: number, bpm: number, steps: number[]) => number;
}

export const tempoSync = ({ knob, range, steps, valueOf, nearest }: Options) => {
  // the same array for the same switches: the knob, the travel of its routes
  const table = [false, true].map((trip) => [false, true].map((dot) => steps(trip, dot)));
  const stepsOf = (params: Params) => table[+isOn(params['trip'])][+isOn(params['dot'])];
  // the division of the knob in BPM: one of its steps
  const divisionOf = (params: Params) => divisionWithin(Math.round(params['div']), stepsOf(params));
  // the value in effect: of the knob, in BPM of its division at the tempo
  const value = (params: Params, bpm: number) =>
    isOn(params['sync']) ? valueOf(divisionOf(params), bpm) : params[knob];
  return {
    stepsOf,
    divisionOf,
    value,
    // the bounds of the routes to the knob in BPM at a tempo: from the first of its steps to the last (none: those
    // of the knob)
    bounds: (params: Params, bpm: number): [number, number] | undefined => {
      if (!isOn(params['sync'])) return undefined;
      const all = stepsOf(params);
      return [valueOf(all[0], bpm), valueOf(all[all.length - 1], bpm)];
    },
    // a change of the user at a tempo, as of an LFO and the envelopes: BPM takes the division nearest to the knob,
    // BPM off the value of the division (within the range of the knob); TRIP or DOT switched off the straight
    // division of a triplet or a dotted one
    paramChange: (params: Params, key: string, next: number, bpm: number): Params => {
      if (key === 'sync' && isOn(next) !== isOn(params['sync']))
        return isOn(next)
          ? { sync: next, div: nearest(params[knob], bpm, stepsOf(params)) }
          : { sync: next, [knob]: number.thresholds(value(params, bpm), range.min, range.max) };
      if (key === 'trip' || key === 'dot')
        return { [key]: next, div: divisionOf({ ...params, [key]: next }) };
      return { [key]: next };
    },
  };
};
