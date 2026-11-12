import { mapValues, noop } from 'lodash';
import { FX_MIX_PARAMS, FX_PARAMS } from '@chisper/preset-schema';
import { number } from '@chisper/math';
import { COMPRESSOR_PROCESSOR } from '../../common/processors';
import { createLfoFeed } from '../../common/lfo/lfo-curve';
import { FxDefinition, FxMeterValues } from './types';
import { COMPRESSOR_MODES } from './compressor-modes';
import {
  bandThresholdsDb,
  CompressorDspParams,
  CompressorMessage,
  CompressorMeterMessage,
  CompressorOptions,
  levelGain,
  makeupGain,
  thresholdDb,
} from './compressor-params';
import { CompressorParam, COMPRESSOR_PRESETS } from './compressor-presets';
import { formatDb, formatHz, formatMillis } from './format';
import { createWorkletFx, STEREO_WORKLET_OPTIONS } from './worklet-fx';
import { FxModMessage, isLfoSource } from './fx-modulation';

const { multi, thresh, ratio, attack, release, gain, xlow, xhigh, below, low, mid, high, level } =
  FX_PARAMS.compressor;

const formatGain = (value: number) => formatDb(20 * Math.log10(value));
// the threshold knob in three bands: the thresholds of the low, the mid and the high one ('-32.4 / -28.8 / -34.1dB')
export const formatBandThresholds = (value: number) =>
  `${bandThresholdsDb(value)
    .map((db) => formatDb(db).slice(0, -2))
    .join(' / ')}dB`;
const band = { precision: 10, fillFrom: 0, formatValue: formatDb };

// The compressor runs in an audio worklet (its Rust core, dsp/compressor: compressor.worklet.ts):
// input → worklet node → output (createWorkletFx); the module loads asynchronously, until then the input goes
// nowhere and the params are kept, the node starts with them. It mixes the dry signal itself (mixInside: its
// bands are out of phase with the input, a mix in the slot would notch at the crossovers), so the mix of the slot
// is one more of its params. Its meter is posted only while someone watches it
export const compressor: FxDefinition<CompressorParam> = {
  label: 'Compressor',
  params: {
    multi: { ...multi, label: 'Mode', options: COMPRESSOR_MODES },
    thresh: {
      ...thresh,
      label: 'Thresh',
      name: 'Threshold',
      precision: 1000,
      formatValue: (value) => formatDb(thresholdDb(value)),
    },
    ratio: {
      ...ratio,
      label: 'Ratio',
      name: 'Ratio',
      mode: 'log',
      precision: 10,
      formatValue: (value) => `${value.toFixed(1)}:1`,
    },
    attack: {
      ...attack,
      label: 'Attack',
      name: 'Attack',
      mode: 'log',
      precision: 10,
      formatValue: formatMillis,
    },
    release: {
      ...release,
      label: 'Release',
      name: 'Release',
      mode: 'log',
      precision: 10,
      formatValue: formatMillis,
    },
    gain: {
      ...gain,
      label: 'Gain',
      name: 'Makeup gain',
      precision: 1000,
      formatValue: (value) => formatGain(makeupGain(value)),
    },
    xlow: {
      ...xlow,
      label: 'Low',
      name: 'Low crossover',
      mode: 'log',
      precision: 1,
      formatValue: formatHz,
    },
    xhigh: {
      ...xhigh,
      label: 'High',
      name: 'High crossover',
      mode: 'log',
      precision: 1,
      formatValue: formatHz,
    },
    below: {
      ...below,
      label: 'Below',
      name: 'Upward ratio (below the thresholds)',
      precision: 100,
      formatValue: number.percent,
    },
    low: { ...low, ...band, label: 'L', name: 'Low band gain' },
    mid: { ...mid, ...band, label: 'M', name: 'Mid band gain' },
    high: { ...high, ...band, label: 'H', name: 'High band gain' },
    level: {
      ...level,
      label: 'Level',
      name: 'Output level',
      precision: 1000,
      fillFrom: level.default,
      formatValue: (value) => (value <= 0 ? '-∞dB' : formatGain(levelGain(value))),
    },
  },
  presets: COMPRESSOR_PRESETS,
  create: (audioCtx) => {
    const values: CompressorDspParams = {
      ...mapValues(FX_PARAMS.compressor, (param) => param.default),
      mix: FX_MIX_PARAMS.compressor.default,
    };
    const listeners = new Set<(values: FxMeterValues) => void>();

    // the node starts with the params and the LFOs kept until the module has loaded, its meter on if watched
    const worklet = createWorkletFx(
      audioCtx,
      'compressor',
      () => {
        const lfos = feed.initial();
        const processorOptions: CompressorOptions = {
          params: { ...values },
          ...(lfos && { lfos }),
          ...(listeners.size > 0 && { meter: true }),
        };
        return new AudioWorkletNode(audioCtx, COMPRESSOR_PROCESSOR, {
          ...STEREO_WORKLET_OPTIONS,
          processorOptions,
        });
      },
      (data) => {
        const { meter } = (data ?? {}) as Partial<CompressorMeterMessage>;
        if (meter) listeners.forEach((listener) => listener(meter));
      }
    );
    const post = (message: CompressorMessage) => worklet.post(message);
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
        values[key as keyof CompressorDspParams] = value;
        post({ params: { [key]: value } });
      },
      // no loops to drain: the closed send silences the input, and the worklet idles once it is silent
      setActive: noop,
      clear: worklet.clear,
      // the worklet moves the knobs once per block (the LFOs as they are first, once a route reads one)
      setModulation: (mod) => {
        feed.use(!!mod && mod.routes.some(({ source }) => isLfoSource(source)));
        const message: FxModMessage = { mod };
        worklet.post(message);
      },
      setLfos: feed.take,
      meter: {
        watch: (listener) => {
          listeners.add(listener);
          if (listeners.size === 1) post({ meter: true });
          return () => {
            listeners.delete(listener);
            if (listeners.size === 0) post({ meter: false });
          };
        },
      },
      destroy: () => {
        listeners.clear();
        worklet.destroy();
      },
    };
  },
};
