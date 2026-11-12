import { paramsCore, ParamsCoreExports } from '../../common/wasm/stereo-core';
import type { ChorusDspParams, ChorusOptions } from './chorus-params';

// the Rust core of the chorus (dsp/chorus, chorus.wasm): four taps (two a channel, a line each, fed back into
// itself) moved by a triangle LFO, a filter of the wet signal, the mix inside, the level

// the params in the order of the core (dsp/chorus/src/lib.rs)
export const CHORUS_KEYS: readonly (keyof ChorusDspParams)[] = [
  'rate',
  'd1',
  'd2',
  'depth',
  'fb',
  'cut',
  'hpf',
  'level',
  'mix',
];

export type ChorusExports = ParamsCoreExports;

export const createChorusWasm = (exports: ChorusExports, sampleRate: number, { params }: ChorusOptions) =>
  paramsCore<keyof ChorusDspParams>(exports, sampleRate, CHORUS_KEYS, params).dsp;
