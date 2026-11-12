import { mapValues, pick } from 'lodash';
import {
  chorusDivisions,
  divisionSeconds,
  FX_MIX_PARAMS,
  FX_PARAMS,
  nearestDivision,
  quartersOf,
  TEMPO_DEFAULT,
  TEMPO_DIVISIONS,
} from '@chisper/preset-schema';
import { number } from '@chisper/math';
import { CHORUS_PROCESSOR } from '../../common/processors';
import { createLfoFeed } from '../../common/lfo/lfo-curve';
import { FxDefinition } from './types';
import { isOn, OFF_ON, tempoSync } from './tempo-sync';
import { ChorusDspParams, ChorusMessage, ChorusOptions, depthMs, levelGain } from './chorus-params';
import { ChorusParam, CHORUS_PRESETS } from './chorus-presets';
import { formatDb, formatHz, formatMillis } from './format';
import { createWorkletFx, STEREO_WORKLET_OPTIONS } from './worklet-fx';
import { FxModMessage, isLfoSource } from './fx-modulation';

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
// the knobs the worklet takes as they are (Rate goes there as the Hz in effect)
const CORE_KNOBS = ['d1', 'd2', 'depth', 'fb', 'cut', 'hpf', 'level'] as const;
const RATE_KNOBS: readonly ChorusParam[] = ['rate', 'sync', 'div', 'trip', 'dot'];

// The chorus runs in an audio worklet (its Rust core, dsp/chorus: chorus.worklet.ts):
// input → worklet node → output (createWorkletFx); the module loads asynchronously, until then the input goes
// nowhere and the params are kept, the node starts with them. It mixes the dry signal itself (mixInside: the law
// of its mix is its own), so the mix of the slot is one more of its params. In BPM a cycle of its LFO is a division
// of the tempo: the worklet gets its Hz. Not active (out of the chain, bypassed) it has no feedback: its taps drain
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
  create: (audioCtx) => {
    const values: Record<ChorusParam | 'mix', number> = {
      ...mapValues(FX_PARAMS.chorus, (param) => param.default),
      mix: FX_MIX_PARAMS.chorus.default,
    };
    // the tempo of the synth (BPM)
    let bpm = TEMPO_DEFAULT;
    let active = true;
    const dspParams = (): ChorusDspParams => ({
      ...pick(values, CORE_KNOBS),
      rate: chorusRate(values, bpm),
      mix: values.mix,
    });

    // the node starts with the params and the LFOs kept until the module has loaded
    const worklet = createWorkletFx(audioCtx, 'chorus', () => {
      const lfos = feed.initial();
      const processorOptions: ChorusOptions = {
        params: dspParams(),
        ...(lfos && { lfos }),
        ...(!active && { inactive: true }),
      };
      return new AudioWorkletNode(audioCtx, CHORUS_PROCESSOR, {
        ...STEREO_WORKLET_OPTIONS,
        processorOptions,
      });
    });
    const post = (message: ChorusMessage) => worklet.post(message);
    // the LFOs, only while a route of one moves a knob
    const feed = createLfoFeed((state) => {
      const message: FxModMessage = { lfos: state };
      worklet.post(message);
    });

    return {
      input: worklet.input,
      output: worklet.output,
      $status: worklet.$status,
      retry: worklet.retry,
      mixInside: true,
      // unknown keys are ignored
      setParam: (key, value) => {
        if (!(key in values)) return;
        values[key as ChorusParam | 'mix'] = value;
        if (RATE_KNOBS.includes(key as ChorusParam)) post({ params: { rate: chorusRate(values, bpm) } });
        else post({ params: { [key]: value } });
      },
      // not active: no feedback, the taps drain instead of ringing on
      setActive: (next) => {
        if (next === active) return;
        active = next;
        post({ active });
      },
      clear: worklet.clear,
      // the worklet moves the knobs once per block (the LFOs as they are first, once a route reads one)
      setModulation: (mod) => {
        feed.use(!!mod && mod.routes.some(({ source }) => isLfoSource(source)));
        const message: FxModMessage = { mod };
        worklet.post(message);
      },
      setLfos: feed.take,
      // in BPM a new tempo is a new rate
      setTempo: (next) => {
        bpm = next;
        if (isOn(values.sync)) post({ params: { rate: chorusRate(values, bpm) } });
      },
      destroy: worklet.destroy,
    };
  },
};
