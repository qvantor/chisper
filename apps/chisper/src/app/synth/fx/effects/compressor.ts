import { FX_PARAMS } from '@chisper/preset-schema';
import { number } from '@chisper/math';
import { FxDefinition } from './types';
import { COMPRESSOR_MODES } from './compressor-modes';
import { bandThresholdsDb, makeupGain, thresholdDb } from './compressor-params';
import { CompressorParam, COMPRESSOR_PRESETS } from './compressor-presets';
import { formatDb, formatHz, formatMillis } from './format';
import { levelParam } from './level';

const { multi, thresh, ratio, attack, release, gain, xlow, xhigh, below, low, mid, high, level } =
  FX_PARAMS.compressor;

const formatGain = (value: number) => formatDb(20 * Math.log10(value));
// the threshold knob in three bands: the thresholds of the low, the mid and the high one ('-32.4 / -28.8 / -34.1dB')
export const formatBandThresholds = (value: number) =>
  `${bandThresholdsDb(value)
    .map((db) => formatDb(db).slice(0, -2))
    .join(' / ')}dB`;
const band = { precision: 10, fillFrom: 0, formatValue: formatDb };

// The compressor is a unit of the chain core (dsp/compressor). It mixes the dry signal itself (Law::Inside: its
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
    level: levelParam(level),
  },
  presets: COMPRESSOR_PRESETS,
  // (the mix of its slot is the mix inside the core)
  core: (params) => params,
  metered: true,
};
