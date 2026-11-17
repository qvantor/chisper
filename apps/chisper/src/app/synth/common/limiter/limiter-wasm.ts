import { stereoCore, UNIT, UnitExports } from '../wasm/stereo-core';

// the Rust core of the master limiter (dsp/limiter, a unit of chain.wasm), with the API of createLimiterDsp
export type LimiterExports = UnitExports;

export const createLimiterWasm = (exports: LimiterExports, sampleRate: number) => {
  const handle = exports.unit_new(UNIT.limiter, sampleRate);
  return {
    ...stereoCore(exports, handle),
    latency: exports.unit_latency(handle),
    // it has let go and its input has been +0 long enough: the next block of +0 is skipped (the specs)
    get idle() {
      return exports.unit_idle(handle) !== 0;
    },
  };
};
