import type { filterModel } from '@chisper/math';

// the params, the types and the laws of the FX Filter (its Rust core: dsp/chain/src/fxfilter.rs, fxfilter-wasm.ts;
// its designs: filterModel.fxFilterDesign of @chisper/math), no signal processing here

// the params as the core takes them (CHAIN_KEYS.fxfilter but the mix, which is its slot's): the type (an index into
// FX_FILTER_TYPES), the cutoff (Hz), the resonance, Drive and Var (%), Pan (%, 50 none), the level (the knob, 0..1)
export interface FxFilterDspParams {
  type: number;
  cutoff: number;
  res: number;
  drive: number;
  var: number;
  pan: number;
  level: number;
}

export interface FxFilterOptions {
  params: FxFilterDspParams;
  // the mix (inside the core, Law::Inside; 1 all wet by default)
  mix?: number;
}

// the types (FX_PARAMS.fxfilter.type is an index into them): those of Normal of the Audio Unit, each a model type of
// the filter of a voice; new types are appended only, the indexes are saved in presets (TYPES of fxfilter.rs: a spec
// holds them alike)
export const FX_FILTER_TYPES = [
  'ladder6',
  'ladder12',
  'ladder18',
  'ladder24',
  'low6',
  'low12',
  'low18',
  'low24',
  'high6',
  'high12',
  'high18',
  'high24',
  'band12',
  'band24',
  'peak12',
  'peak24',
  'notch12',
  'notch24',
] as const satisfies readonly filterModel.ModelFilterType[];
export type FxFilterType = (typeof FX_FILTER_TYPES)[number];

// the type of a value of its param (one no type has: MG Low 6, as the core takes it)
export const fxFilterTypeOf = (value: number): FxFilterType =>
  FX_FILTER_TYPES[Math.round(value)] ?? 'ladder6';
export const fxFilterIndexOf = (type: FxFilterType) => FX_FILTER_TYPES.indexOf(type);

// the semitones of the cutoff of a channel by Pan at its ends (pan_octaves of the core: 32 x³, x the share of the way
// from the middle)
const PAN_SEMITONES = 32;
// the octaves of the cutoff of the left channel over the knob by Pan (of the right one under it): 0 at 50
export const fxFilterPanOctaves = (pan: number) => {
  const x = Math.min(1, Math.max(-1, (50 - pan) / 50));
  return (PAN_SEMITONES / 12) * (x * x * x);
};
