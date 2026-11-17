import { paramsCore, UNIT, UnitExports } from '../../common/wasm/stereo-core';
import type { DelayDspParams } from './delay-params';

// the Rust core of the delay (dsp/chain/src/delay.rs, a unit of chain.wasm): a line a channel read as a DelayNode
// reads it, a bandpass in the feedback, normal or ping-pong, a channel of the echoes late by Pan

// the params in the order of the core
export const DELAY_KEYS: readonly (keyof DelayDspParams)[] = ['time', 'fb', 'mode', 'pan', 'freq', 'q'];

export const createDelayWasm = (exports: UnitExports, sampleRate: number, params: DelayDspParams) =>
  paramsCore<keyof DelayDspParams>(exports, UNIT.delay, sampleRate, DELAY_KEYS, params).dsp;
