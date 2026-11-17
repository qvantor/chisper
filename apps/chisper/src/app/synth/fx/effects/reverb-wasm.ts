import { paramsCore, UNIT, UnitExports } from '../../common/wasm/stereo-core';
import type { ReverbDspParams, ReverbOptions } from './reverb-params';

// the Rust core of the reverb (dsp/reverb, a unit of chain.wasm), with the API of createReverbDsp

// the params in the order of the core (dsp/reverb/src/lib.rs)
export const REVERB_KEYS: readonly (keyof ReverbDspParams)[] = [
  'lowcut',
  'pre',
  'size',
  'decay',
  'damp',
  'bass',
  'depth',
  'sep',
  'er',
  'drive',
  'bandwidth',
  'body',
];

export type ReverbExports = UnitExports;

export const createReverbWasm = (
  exports: ReverbExports,
  sampleRate: number,
  { params, active }: ReverbOptions
) => {
  const { dsp, handle } = paramsCore<keyof ReverbDspParams>(
    exports,
    UNIT.reverb,
    sampleRate,
    REVERB_KEYS,
    params,
    !!active
  );
  // (assigned: `idle` of the dsp stays a getter)
  return Object.assign(dsp, {
    setActive: (value: boolean) => exports.unit_set_active(handle, value),
  });
};
