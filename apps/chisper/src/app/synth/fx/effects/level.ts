import type { ParamRange } from '@chisper/preset-schema';
import type { FxParamDef } from './types';
import { formatDb } from './format';

// the Level knob of the chorus, the compressor and the EQ, as measured (their cores have it too): × 4 knob² (0 dB at
// the middle, +12 dB at the top)
export const levelGain = (knob: number) => 4 * knob * knob;

// the knob of the Level of an effect over its range
export const levelParam = (range: ParamRange): FxParamDef => ({
  ...range,
  label: 'Level',
  name: 'Output level',
  precision: 1000,
  fillFrom: range.default,
  formatValue: (value) => (value <= 0 ? '-∞dB' : formatDb(20 * Math.log10(levelGain(value)))),
});
