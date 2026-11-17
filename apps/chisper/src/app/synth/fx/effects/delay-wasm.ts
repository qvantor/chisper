import { CHAIN_KEYS } from '../../common/chain/chain-params';
import { paramsCore, UNIT, UnitExports } from '../../common/wasm/stereo-core';
import type { DelayDspParams } from './delay-params';

// the Rust core of the delay (dsp/chain/src/delay.rs, a unit of chain.wasm): a line a channel read as a DelayNode
// reads it, a bandpass in the feedback, normal or ping-pong, a channel of the echoes late by Pan

// the params in the order of the core (CHAIN_KEYS)
export const DELAY_KEYS = CHAIN_KEYS.delay as readonly (keyof DelayDspParams)[];

export const createDelayWasm = (exports: UnitExports, sampleRate: number, params: DelayDspParams) =>
  paramsCore<keyof DelayDspParams>(exports, UNIT.delay, sampleRate, DELAY_KEYS, params).dsp;
