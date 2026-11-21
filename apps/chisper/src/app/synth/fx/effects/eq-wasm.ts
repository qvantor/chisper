import { CHAIN_KEYS } from '../../common/chain/chain-params';
import { paramsCore, UNIT, UnitExports } from '../../common/wasm/stereo-core';
import type { EqDspParams, EqOptions } from './eq-params';

// the Rust core of the EQ (dsp/chain/src/eq.rs, a unit of the chain in engine.wasm): two bands of the Audio EQ
// Cookbook (state variable filters of their responses, both channels in lanes of doubles), then the level

// the params in the order of the core (CHAIN_KEYS)
export const EQ_KEYS = CHAIN_KEYS.eq as readonly (keyof EqDspParams)[];

export type EqExports = UnitExports;

export const createEqWasm = (exports: EqExports, sampleRate: number, { params }: EqOptions) =>
  paramsCore<keyof EqDspParams>(exports, UNIT.eq, sampleRate, EQ_KEYS, params).dsp;
