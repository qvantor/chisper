import { CHAIN_KEYS } from '../../common/chain/chain-params';
import { paramsCore, UNIT, UnitExports } from '../../common/wasm/stereo-core';
import type { FxFilterDspParams, FxFilterOptions } from './fxfilter-params';

// the Rust core of the FX Filter (dsp/chain/src/fxfilter.rs, a unit of the chain in engine.wasm): the model types of
// the filter of a voice on the sum (their sections in lanes of f32, the droop of the reference), Pan, the level and
// the mix inside

// the params in the order of the core (CHAIN_KEYS), the mix last
export const FX_FILTER_KEYS = CHAIN_KEYS.fxfilter as readonly (keyof FxFilterDspParams | 'mix')[];

export type FxFilterExports = UnitExports;

export const createFxFilterWasm = (
  exports: FxFilterExports,
  sampleRate: number,
  { params, mix = 1 }: FxFilterOptions
) =>
  paramsCore<keyof FxFilterDspParams | 'mix'>(exports, UNIT.fxfilter, sampleRate, FX_FILTER_KEYS, {
    ...params,
    mix,
  }).dsp;
