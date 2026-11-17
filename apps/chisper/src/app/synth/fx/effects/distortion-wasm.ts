import { paramsCore, UNIT, UnitExports } from '../../common/wasm/stereo-core';
import type { DistortionDspParams, DistortionOptions } from './distortion-params';

// the Rust core of the distortion (dsp/distortion, a unit of chain.wasm): drive → the curve of the mode oversampled (4×,
// the hard clip antialiased too) × its makeup gain → tone lowpass × level → DC blocker

// the params in the order of the core (dsp/distortion/src/lib.rs)
export const DISTORTION_KEYS: readonly (keyof DistortionDspParams)[] = ['mode', 'drive', 'tone', 'level'];

export type DistortionExports = UnitExports;

export const createDistortionWasm = (
  exports: DistortionExports,
  sampleRate: number,
  { params }: DistortionOptions
) => paramsCore<keyof DistortionDspParams>(exports, UNIT.distortion, sampleRate, DISTORTION_KEYS, params).dsp;
