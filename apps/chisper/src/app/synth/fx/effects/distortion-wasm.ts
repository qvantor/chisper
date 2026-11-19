import { CHAIN_KEYS } from '../../common/chain/chain-params';
import { paramsCore, UNIT, UnitExports } from '../../common/wasm/stereo-core';
import type { DistortionDspParams, DistortionOptions } from './distortion-params';

// the Rust core of the distortion (dsp/distortion, a unit of the chain in engine.wasm): drive → the curve of the mode oversampled (4×,
// the hard clip antialiased too) × its makeup gain → tone lowpass × level → DC blocker

// the params in the order of the core (CHAIN_KEYS)
export const DISTORTION_KEYS = CHAIN_KEYS.distortion as readonly (keyof DistortionDspParams)[];

export type DistortionExports = UnitExports;

export const createDistortionWasm = (
  exports: DistortionExports,
  sampleRate: number,
  { params }: DistortionOptions
) => paramsCore<keyof DistortionDspParams>(exports, UNIT.distortion, sampleRate, DISTORTION_KEYS, params).dsp;
