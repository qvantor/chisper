import type React from 'react';
import { HandleProps } from '../../handle';

// the knobs of the filter: cutoff, resonance, gain (the types of a BiquadFilterNode), drive and variation (Comp,
// or the Gain of the band of an EQ type: the model types); their labels and units: filterKnobLooks
export type FilterNumerics = 'cutoff' | 'resonance' | 'gain' | 'drive' | 'variation';

export type FilterParams = {
  // a type of a BiquadFilterNode or a model type (@chisper/math: MODEL_FILTER_TYPES)
  type: string;
  cutoff: number;
  resonance: number;
  gain: number;
  drive: number;
  variation: number;
};

export type FilterRange = Required<Pick<HandleProps, 'min' | 'max'>> &
  Pick<HandleProps, 'precision' | 'mode' | 'plotSize' | 'disabled'>;
export type FilterRanges = Record<FilterNumerics, FilterRange>;

export type CommonFilterProps = FilterParams & {
  active?: boolean;
  sampleRate: number;
  // the choice of the type, over the chart (the app's browser of the types)
  typeSelect: React.ReactNode;
  setNumericValue: (key: FilterNumerics, value: number) => void;
  ranges: FilterRanges;
  // the modulation of each knob (its routes and drop target) and its id of MIDI Learn
  modulation?: Partial<
    Record<
      FilterNumerics,
      Pick<HandleProps, 'modulations' | 'modTarget' | 'onClearModulations' | 'midiTarget'>
    >
  >;
  // the default of each knob (its menu sets it, within the range of the type)
  defaults?: Partial<FilterProps>;
};

export type FilterProps = Pick<FilterParams, FilterNumerics>;
