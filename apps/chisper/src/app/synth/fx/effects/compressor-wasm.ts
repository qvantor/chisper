import { stereoCore, StereoCoreExports } from '../../common/wasm/stereo-core';
import { createView } from '../../common/wasm/wasm-core';
import type { CompressorDspParams, CompressorOptions } from './compressor-params';
import type { FxMeterValues } from './types';

// the Rust core of the compressor (dsp/compressor, compressor.wasm): a highpass, then one band (the louder channel
// against the threshold, the reduction smoothed by the attack and the release) or three (crossovers, the mean
// square of each band compressed down and up), the mix inside, the level

// the params in the order of the core (dsp/compressor/src/lib.rs)
export const COMPRESSOR_KEYS: readonly (keyof CompressorDspParams)[] = [
  'multi',
  'thresh',
  'ratio',
  'attack',
  'release',
  'gain',
  'xlow',
  'xhigh',
  'below',
  'low',
  'mid',
  'high',
  'level',
  'mix',
];

export interface CompressorExports extends StereoCoreExports {
  // the buffer of the params of fx_new and fx_set: the bits of the keys fx_set changes, then the params; fx_meter
  // writes the meter into its first values
  fx_command: () => number;
  fx_new: (sampleRate: number) => number;
  fx_set: (handle: number) => void;
  fx_idle: (handle: number) => number;
  fx_meter: (handle: number) => void;
}

export const createCompressorWasm = (
  exports: CompressorExports,
  sampleRate: number,
  { params }: CompressorOptions
) => {
  const view = createView(exports, Float64Array);
  const command = () => view(exports.fx_command(), COMPRESSOR_KEYS.length + 1);
  const options = command();
  COMPRESSOR_KEYS.forEach((key, i) => (options[1 + i] = params[key]));
  const handle = exports.fx_new(sampleRate);
  // what meter() gives, the same object every time: nothing is made on the audio thread
  const gains: FxMeterValues['gains'] = [0, 0, 0];
  const values: FxMeterValues = { gains, input: 0 };
  return {
    ...stereoCore(exports, handle),
    set: (changes: Partial<CompressorDspParams>) => {
      const buffer = command();
      let present = 0;
      for (let i = 0; i < COMPRESSOR_KEYS.length; i++) {
        const value = changes[COMPRESSOR_KEYS[i]];
        if (value === undefined) continue;
        present |= 1 << i;
        buffer[1 + i] = value;
      }
      buffer[0] = present;
      exports.fx_set(handle);
    },
    get idle() {
      return exports.fx_idle(handle) !== 0;
    },
    // the gains of the bands and the peak of the input of the last block (its values hold until the next call:
    // who keeps them copies them)
    meter: (): FxMeterValues => {
      exports.fx_meter(handle);
      const buffer = command();
      gains[0] = buffer[0];
      gains[1] = buffer[1];
      gains[2] = buffer[2];
      values.input = buffer[3];
      return values;
    },
  };
};
