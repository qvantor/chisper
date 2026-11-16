import { filterModel, number } from '@chisper/math';
import { FilterNumerics } from '../types';

// a knob of the filter as a type shows it: its label, its name (the tooltip, the menu) and its value with its unit
export interface FilterKnobLook {
  label: string;
  name: string;
  format: (value: number) => string;
}

// (the units: 440Hz, 2.50kHz, +3.0dB, 35%)
export const formatCutoff = (hz: number) =>
  hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 1 : 2)}kHz` : `${Math.round(hz)}Hz`;
const formatDb = (db: number) =>
  db === -Infinity ? '-∞dB' : `${db > 0.05 ? '+' : ''}${(Math.abs(db) < 0.05 ? 0 : db).toFixed(1)}dB`;
const formatPercent = (value: number) => `${number.round(value, 10)}%`;
// a Q to 3 significant digits (0.0100 to 1000)
const formatQ = (q: number) => (q >= 100 ? q.toFixed(0) : q.toPrecision(3));
// the Gain of the EQ types (their variation, 0..100 %) as the gain of their band: -∞ at 0, 0 dB at 50 %, +19 dB at
// 100 %
export const formatEqGain = (variation: number) =>
  formatDb(20 * Math.log10(filterModel.eqGain(number.thresholds(variation, 0, 100) / 100)));

// the types of a BiquadFilterNode whose Q is a Q (not the peak in dB of lowpass and highpass)
const Q_TYPES = new Set(['bandpass', 'notch', 'peaking', 'allpass']);

// the knobs of a type: Res in % of a model type, the peak in dB of a Biquad LP or HP, a Q of a Biquad BP, Notch or
// Bell; Gain in dB (a Biquad shelf or bell; the Gain of an EQ type is its variation, the gain of its band: another
// knob, named apart); Drive and Comp in % (Comp: FAT of the reference, the level the resonance takes off the pass
// band given back). Their names (the tooltip, the menu) all start with Filter
export const filterKnobLooks = (type: string): Record<FilterNumerics, FilterKnobLook> => {
  const model = filterModel.isModelFilterType(type);
  return {
    cutoff: { label: 'Cutoff', name: 'Filter cutoff', format: formatCutoff },
    resonance: model
      ? { label: 'Res', name: 'Filter resonance', format: formatPercent }
      : Q_TYPES.has(type)
        ? { label: 'Q', name: 'Filter Q', format: formatQ }
        : { label: 'Res', name: 'Filter resonance', format: formatDb },
    gain: { label: 'Gain', name: 'Filter gain', format: formatDb },
    drive: { label: 'Drive', name: 'Filter drive', format: formatPercent },
    variation: filterModel.isEqFilterType(type)
      ? { label: 'Gain', name: 'Filter band gain', format: formatEqGain }
      : { label: 'Comp', name: 'Filter compensation', format: formatPercent },
  };
};
