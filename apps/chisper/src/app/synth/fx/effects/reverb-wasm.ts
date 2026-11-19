import { CHAIN_KEYS } from '../../common/chain/chain-params';
import { paramsCore, UNIT, UnitExports } from '../../common/wasm/stereo-core';
import type { ReverbDspParams, ReverbOptions } from './reverb-params';

// the Rust core of the reverb (dsp/reverb, a unit of the chain in engine.wasm)

// the params in the order of the core (CHAIN_KEYS)
export const REVERB_KEYS = CHAIN_KEYS.reverb as readonly (keyof ReverbDspParams)[];

export type ReverbExports = UnitExports;

export const createReverbWasm = (exports: ReverbExports, sampleRate: number, { params }: ReverbOptions) =>
  paramsCore<keyof ReverbDspParams>(exports, UNIT.reverb, sampleRate, REVERB_KEYS, params).dsp;
