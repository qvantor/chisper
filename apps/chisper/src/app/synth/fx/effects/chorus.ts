import { pick } from 'lodash';
import {
  chorusDivisions,
  divisionSeconds,
  FX_PARAMS,
  nearestDivision,
  quartersOf,
  TEMPO_DIVISIONS,
} from '@chisper/preset-schema';
import { number } from '@chisper/math';
import { FxDefinition } from './types';
import { OFF_ON, tempoSync } from './tempo-sync';
import { depthMs, levelGain } from './chorus-params';
import { ChorusParam, CHORUS_PRESETS } from './chorus-presets';
import { formatDb, formatHz, formatMillis } from './format';

const { rate, sync, div, trip, dot, d1, d2, depth, fb, cut, hpf, level } = FX_PARAMS.chorus;

// Hz of the LFO with a division a cycle at a tempo (the top of Rate at most)
export const chorusDivisionHz = (division: number, bpm: number) =>
  Math.min(rate.max, 1 / divisionSeconds(division, bpm));
// Rate in BPM: its steps 8 bar … 1/32 a cycle (faster to the right), with TRIP and DOT their triplets and dotted
// ones; BPM takes the division nearest to a cycle of Rate (the longest for an LFO that stands), Hz the rate of the
// division
const synced = tempoSync({
  knob: 'rate',
  range: rate,
  steps: (trip, dot) => [...chorusDivisions(trip, dot)].reverse(),
  valueOf: chorusDivisionHz,
  nearest: (hz, bpm, steps) => (hz > 0 ? nearestDivision(quartersOf(1 / hz, bpm), steps) : steps[0]),
});
export const {
  stepsOf: chorusStepsOf,
  divisionOf: chorusDivisionOf,
  // Hz of the LFO: of Rate, in BPM of its division at the tempo
  value: chorusRate,
  bounds: chorusRateBounds,
  paramChange: chorusParamChange,
} = synced;

const formatRate = (value: number) => `${value < 1 ? value.toFixed(3) : value.toFixed(2)}Hz`;
const tap = { precision: 100, formatValue: formatMillis };
// the knobs the core takes as they are (Rate goes there as the Hz in effect)
const CORE_KNOBS = ['d1', 'd2', 'depth', 'fb', 'cut', 'hpf', 'level'] as const;

// The chorus is a unit of the chain core (dsp/chorus). It mixes the dry signal itself (Law::Inside: the law of
// its mix is its own), so the mix of the slot is one more of its params. In BPM a cycle of its LFO is a division
// of the tempo: the core gets its Hz. Its meter (the LFO of the core and the knobs of its taps, ChorusMeterValues)
// comes only while it is watched
export const chorus: FxDefinition<ChorusParam> = {
  label: 'Chorus',
  params: {
    rate: { ...rate, label: 'Rate', name: 'LFO rate', mode: 'pow', precision: 1000, formatValue: formatRate },
    // the switches of BPM: not targets of the routes (they have options)
    sync: {
      ...sync,
      label: 'BPM',
      name: 'Tempo sync',
      options: [
        { id: 'hz', label: 'HZ' },
        { id: 'bpm', label: 'BPM' },
      ],
    },
    div: {
      ...div,
      label: 'Rate',
      name: 'LFO rate',
      options: TEMPO_DIVISIONS.map(({ id }) => ({ id, label: id })),
    },
    trip: { ...trip, label: 'T', name: 'Triplets', options: OFF_ON },
    dot: { ...dot, label: 'D', name: 'Dotted', options: OFF_ON },
    d1: { ...d1, ...tap, label: 'Delay 1', name: 'Delay of the second taps' },
    d2: { ...d2, ...tap, label: 'Delay 2', name: 'Delay of the first taps' },
    depth: {
      ...depth,
      label: 'Depth',
      name: 'LFO depth',
      precision: 100,
      formatValue: (value) => formatMillis(depthMs(value)),
    },
    fb: { ...fb, label: 'Feedback', precision: 1000, formatValue: number.percent },
    cut: { ...cut, label: 'Cutoff', name: 'Filter cutoff', mode: 'log', precision: 1, formatValue: formatHz },
    hpf: {
      ...hpf,
      label: 'Filter',
      name: 'Filter type',
      options: [
        { id: 'lpf', label: 'Low pass' },
        { id: 'hpf', label: 'High pass' },
      ],
    },
    level: {
      ...level,
      label: 'Level',
      name: 'Output level',
      precision: 1000,
      fillFrom: level.default,
      formatValue: (value) => (value <= 0 ? '-∞dB' : formatDb(20 * Math.log10(levelGain(value)))),
    },
  },
  presets: CHORUS_PRESETS,
  paramChange: chorusParamChange,
  bounds: (params, bpm) => ({ rate: chorusRateBounds(params, bpm) }),
  // Rate in BPM as the Hz of its division at the tempo (the mix of its slot is the mix inside the core)
  core: (params, bpm) => ({ ...pick(params, CORE_KNOBS), rate: chorusRate(params, bpm) }),
  metered: true,
};
