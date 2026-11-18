import { CHAIN_KEYS } from '../../common/chain/chain-params';
import { paramsCore, UNIT, UnitExports } from '../../common/wasm/stereo-core';
import { compressorMeterReader } from './compressor-params';
import type { CompressorDspParams, CompressorMeterValues, CompressorOptions } from './compressor-params';

// the Rust core of the compressor (dsp/compressor, a unit of chain.wasm): a highpass, then one band (the louder channel
// against the threshold, the reduction smoothed by the attack and the release) or three (crossovers, the mean
// square of each band compressed down and up), the mix inside, the level

// the params in the order of the core (CHAIN_KEYS)
export const COMPRESSOR_KEYS = CHAIN_KEYS.compressor as readonly (keyof CompressorDspParams)[];

export type CompressorExports = UnitExports;

export const createCompressorWasm = (
  exports: CompressorExports,
  sampleRate: number,
  { params }: CompressorOptions
) => {
  const { dsp, handle, command } = paramsCore<keyof CompressorDspParams>(
    exports,
    UNIT.compressor,
    sampleRate,
    COMPRESSOR_KEYS,
    params
  );
  const read = compressorMeterReader();
  // (assigned: `idle` of the dsp stays a getter)
  return Object.assign(dsp, {
    // the gains of the bands and the peak of the input of the last block (its values hold until the next call:
    // who keeps them copies them)
    meter: (): CompressorMeterValues => {
      exports.unit_meter(handle);
      return read(command());
    },
  });
};
