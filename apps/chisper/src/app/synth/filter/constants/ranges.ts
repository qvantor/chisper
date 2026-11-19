import { cloneDeep, merge } from 'lodash';
import { FilterNumerics, FilterParams, FilterRange, FilterRanges } from '@chisper/ui-kit';
import { filterModel } from '@chisper/math';
import {
  FILTER_TYPES,
  FilterType,
  isWebFilterType,
  PRESET_DEFAULTS,
  WebFilterType,
} from '@chisper/preset-schema';

const deepFreeze = <T extends object>(value: T): T => {
  Object.values(value).forEach((item) => item && typeof item === 'object' && deepFreeze(item));
  return Object.freeze(value);
};

export const defaultFilterRanges: FilterRanges = {
  cutoff: { min: 10, max: 22050, precision: 1, mode: 'log', plotSize: 200 },
  resonance: { min: 0, max: 20, precision: 10 },
  gain: { min: 0, max: 1, precision: 100 },
  drive: { min: 0, max: 100, precision: 10 },
  variation: { min: 0, max: 100, precision: 10 },
};

const disabled: Partial<FilterRange> = { min: -1000, max: 1000, disabled: true };

// the knobs of a type of a BiquadFilterNode: no Drive, no Var
const webRanges: Record<WebFilterType, Partial<Record<FilterNumerics, Partial<FilterRange>>>> = {
  lowpass: {
    gain: disabled,
  },
  highpass: {
    gain: disabled,
  },
  bandpass: {
    resonance: { min: 0.01, max: 1000, precision: 100, mode: 'log' },
    gain: disabled,
  },
  lowshelf: {
    resonance: disabled,
    gain: { min: -40, max: 40 },
  },
  highshelf: {
    resonance: disabled,
    gain: { min: -40, max: 40 },
  },
  peaking: {
    gain: { min: 0, max: 40 },
    resonance: { min: 0, max: 10, precision: 100 },
  },
  notch: {
    gain: disabled,
    resonance: { min: 0.001, max: 10, precision: 10000, plotSize: 200, mode: 'log' },
  },
  allpass: {},
};

// Res of a model type in %
const MODEL_RESONANCE: FilterRange = { min: 0, max: 100, precision: 10 };

// the knobs of a model type: Res, Drive and Var in % (Var: Comp, or the Gain of the band of an EQ one), no Gain; Res
// and Var where it uses them (a one-pole has no resonance; Comp of Low 6, High 6 and the notches is a gain of 1)
const modelRangesOf = (type: filterModel.ModelFilterType) => {
  const uses = filterModel.modelKnobsOf(type);
  return {
    resonance: uses.resonance ? MODEL_RESONANCE : disabled,
    gain: disabled,
    variation: uses.variation ? undefined : disabled,
  };
};

// the knobs of each type: its ranges over the defaults (a disabled knob is not used by it); worked out once, read on
// every note and render (frozen: shared by all who read them)
const FILTER_RANGES = Object.fromEntries(
  FILTER_TYPES.map((type) => [
    type,
    deepFreeze(
      merge(
        cloneDeep(defaultFilterRanges),
        isWebFilterType(type)
          ? { ...webRanges[type], drive: disabled, variation: disabled }
          : modelRangesOf(type)
      )
    ),
  ])
) as Record<FilterType, FilterRanges>;

export const rangesOf = (type: FilterType): FilterRanges => FILTER_RANGES[type];

// what Var of a type is: Comp, or the Gain of the band of an EQ type (null: a type that doesn't use it)
export type VariationKind = 'comp' | 'eq';
export const variationKindOf = (type: FilterType): VariationKind | null =>
  rangesOf(type).variation.disabled ? null : filterModel.isEqFilterType(type) ? 'eq' : 'comp';

// the Gain of the band of an EQ type at 0 dB (eqGain of 0.5)
const EQ_UNITY = 50;
// Var of an empty filter of a type: Comp 0 %, the Gain of the band of an EQ type 0 dB
export const variationDefaultOf = (type: FilterType) =>
  filterModel.isEqFilterType(type) ? EQ_UNITY : PRESET_DEFAULTS.filter.v;

// the knobs of an empty filter of a type (within the range of the type: the knob clamps them; Var of an EQ type, the
// Gain of its band, at 0 dB)
export const filterDefaultsOf = (type: FilterType): Omit<FilterParams, 'type'> => ({
  cutoff: PRESET_DEFAULTS.filter.cut,
  resonance: PRESET_DEFAULTS.filter.res,
  gain: PRESET_DEFAULTS.filter.gain,
  drive: PRESET_DEFAULTS.filter.dr,
  variation: variationDefaultOf(type),
});

// the travel of Res of a type, whose share a change of type between a type of a BiquadFilterNode (dB or a Q) and a
// model one (%) keeps: of a model type its % also where it doesn't use it (a one-pole between two that do keeps it)
export const resonanceTravelOf = (type: FilterType): FilterRange =>
  isWebFilterType(type) ? rangesOf(type).resonance : MODEL_RESONANCE;
