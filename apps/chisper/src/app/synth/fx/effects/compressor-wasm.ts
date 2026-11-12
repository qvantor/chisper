import { paramsCore, ParamsCoreExports } from '../../common/wasm/stereo-core';
import type { CompressorDspParams, CompressorOptions } from './compressor-params';
import type { CompressorMeterValues } from './compressor-params';

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

export interface CompressorExports extends ParamsCoreExports {
  // writes the meter into the first values of the buffer of the params
  fx_meter: (handle: number) => void;
}

export const createCompressorWasm = (
  exports: CompressorExports,
  sampleRate: number,
  { params }: CompressorOptions
) => {
  const { dsp, handle, command } = paramsCore<keyof CompressorDspParams>(
    exports,
    sampleRate,
    COMPRESSOR_KEYS,
    params
  );
  // what meter() gives, the same object every time: nothing is made on the audio thread
  const gains: CompressorMeterValues['gains'] = [0, 0, 0];
  const values: CompressorMeterValues = { gains, input: 0 };
  // (assigned: `idle` of the dsp stays a getter)
  return Object.assign(dsp, {
    // the gains of the bands and the peak of the input of the last block (its values hold until the next call:
    // who keeps them copies them)
    meter: (): CompressorMeterValues => {
      exports.fx_meter(handle);
      const buffer = command();
      gains[0] = buffer[0];
      gains[1] = buffer[1];
      gains[2] = buffer[2];
      values.input = buffer[3];
      return values;
    },
  });
};
