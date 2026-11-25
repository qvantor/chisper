import {
  delayDivisions,
  divisionSeconds,
  FX_PARAMS,
  nearestDivision,
  quartersOf,
  TEMPO_DIVISIONS,
} from '@chisper/preset-schema';
import { pick } from 'lodash';
import { number } from '@chisper/math';
import { FxDefinition } from './types';
import { OFF_ON, tempoSync } from './tempo-sync';
import { DelayParam, DELAY_PRESETS } from './delay-presets';
import { formatHz, formatMs } from './format';
import { DELAY_LINE_MAX } from './delay-params';

const { time, sync, div, trip, dot, fb, mode, pan, freq, q } = FX_PARAMS.delay;

// the knobs the core takes as they are (Time as the seconds of its echoes)
const CORE_KNOBS = ['fb', 'mode', 'pan', 'freq', 'q'] as const;

// seconds of the echoes of a division at a tempo (DELAY_LINE_MAX at most)
export const delayDivisionSeconds = (division: number, bpm: number) =>
  Math.min(DELAY_LINE_MAX, divisionSeconds(division, bpm));
// Time in BPM: its steps 1/64 … 1 bar, with TRIP and DOT their triplets and dotted ones; BPM takes the division
// nearest to Time, MS the seconds of the division
const synced = tempoSync({
  knob: 'time',
  range: time,
  steps: delayDivisions,
  valueOf: delayDivisionSeconds,
  nearest: (seconds, bpm, steps) => nearestDivision(quartersOf(seconds, bpm), steps),
});
export const {
  stepsOf: delayStepsOf,
  divisionOf: delayDivisionOf,
  // the seconds of the echoes: of Time, in BPM of its division at the tempo
  value: delayTime,
  bounds: delayTimeBounds,
  paramChange: delayParamChange,
} = synced;

// the delay of the chain core (dsp/chain/src/delay.rs): a line a channel, a bandpass in the feedback, normal (each
// line feeds itself) or ping-pong (the mono sum into the left line, its echoes into the right one, which gives them
// back as they are a Time later and feeds the left line: the feedback once a round), Pan a channel of the echoes
// late. Time moves as a tape, the echoes bend: the knob and the offset of its routes (those of Pan too) through the
// one-pole of the Audio Unit (TIME_SMOOTHING of the core, measured: an LFO on its time); in BPM (sync) it is its
// division at the tempo of the synth, a line DELAY_LINE_MAX long. A knob the envelopes and the LFOs move follows
// them in the core, the offset of its routes added to the knob as it glides
export const delay: FxDefinition<DelayParam> = {
  label: 'Delay',
  params: {
    mode: {
      ...mode,
      label: 'Mode',
      options: [
        { id: 'normal', label: 'Normal' },
        { id: 'ping-pong', label: 'Ping-pong' },
      ],
    },
    pan: {
      ...pan,
      label: 'Pan',
      name: 'Stereo offset',
      precision: 1000,
      fillFrom: 0,
      formatValue: (value) => {
        const ms = Math.round(value * 1000);
        if (ms === 0) return '0ms';
        return `${ms < 0 ? 'L' : 'R'} ${Math.abs(ms)}ms`;
      },
    },
    time: {
      ...time,
      label: 'Time',
      name: 'Delay time',
      formatValue: formatMs,
    },
    // the switches of BPM: not targets of the routes (they have options)
    sync: {
      ...sync,
      label: 'BPM',
      name: 'Tempo sync',
      options: [
        { id: 'ms', label: 'MS' },
        { id: 'bpm', label: 'BPM' },
      ],
    },
    div: {
      ...div,
      label: 'Time',
      name: 'Delay time',
      options: TEMPO_DIVISIONS.map(({ id }) => ({ id, label: id })),
    },
    trip: { ...trip, label: 'T', name: 'Triplets', options: OFF_ON },
    dot: { ...dot, label: 'D', name: 'Dotted', options: OFF_ON },
    fb: {
      ...fb,
      label: 'Feedback',
      precision: 100,
      formatValue: number.percent,
    },
    freq: {
      ...freq,
      label: 'Freq',
      name: 'Filter freq',
      mode: 'log',
      precision: 1,
      formatValue: formatHz,
    },
    q: {
      ...q,
      label: 'Q',
      name: 'Resonance',
      mode: 'log',
      precision: 100,
    },
  },
  presets: DELAY_PRESETS,
  paramChange: delayParamChange,
  tempo: { knob: 'time', stepsOf: delayStepsOf, divisionOf: delayDivisionOf },
  bounds: (params, bpm) => ({ time: delayTimeBounds(params, bpm) }),
  // Time as the seconds of the echoes: in BPM of its division at the tempo
  core: (params, bpm) => ({ ...pick(params, CORE_KNOBS), time: delayTime(params, bpm) }),
};
