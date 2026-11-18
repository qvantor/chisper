import { FX_PARAMS } from '@chisper/preset-schema';
import { FxDefinition } from './types';
import { DistortionParam, DISTORTION_PRESETS } from './distortion-presets';
import { formatDb, formatHz } from './format';
import { DISTORTION_MODES } from './distortion-modes';
import { TONE_OPEN } from './distortion-params';

const { mode, drive, tone, level } = FX_PARAMS.distortion;

// the oversampled waveshaper is a unit of the chain core (dsp/distortion). Its output lags by DISTORTION_LATENCY,
// its slot delays the dry signal as much and mixes them linearly (the wet signal is the dry one reshaped)
export const distortion: FxDefinition<DistortionParam> = {
  label: 'Distortion',
  params: {
    mode: { ...mode, label: 'Mode', options: DISTORTION_MODES },
    drive: { ...drive, label: 'Drive', name: 'Input drive', precision: 10, formatValue: formatDb },
    tone: {
      ...tone,
      label: 'Tone',
      name: 'Tone cutoff',
      mode: 'log',
      precision: 1,
      formatValue: (value) => (value >= TONE_OPEN ? 'Open' : formatHz(value)),
    },
    level: {
      ...level,
      label: 'Level',
      name: 'Output level',
      precision: 10,
      fillFrom: 0,
      formatValue: formatDb,
    },
  },
  presets: DISTORTION_PRESETS,
  // the wet signal is the dry one reshaped, in time with it: the core mixes them linear, the dry one late by its
  // latency
  core: (params) => params,
};
