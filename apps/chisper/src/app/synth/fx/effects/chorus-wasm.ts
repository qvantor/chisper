import { CHAIN_KEYS } from '../../common/chain/chain-params';
import { paramsCore, UNIT, UnitExports } from '../../common/wasm/stereo-core';
import { chorusMeterReader } from './chorus-params';
import type { ChorusDspParams, ChorusMeterValues, ChorusOptions } from './chorus-params';

// the Rust core of the chorus (dsp/chorus, a unit of the chain in engine.wasm): four taps (two a channel, a line each, fed back into
// itself) moved by a triangle LFO, a filter of the wet signal, the mix inside, the level

// the params in the order of the core (CHAIN_KEYS)
export const CHORUS_KEYS = CHAIN_KEYS.chorus as readonly (keyof ChorusDspParams)[];

export type ChorusExports = UnitExports;

export const createChorusWasm = (exports: ChorusExports, sampleRate: number, { params }: ChorusOptions) => {
  const { dsp, handle, command } = paramsCore<keyof ChorusDspParams>(
    exports,
    UNIT.chorus,
    sampleRate,
    CHORUS_KEYS,
    params
  );
  const read = chorusMeterReader();
  // (assigned: `idle` of the dsp stays a getter)
  return Object.assign(dsp, {
    // the LFO and the knobs of the taps as the core has them (its values hold until the next call: who keeps
    // them copies them)
    meter: (): ChorusMeterValues => {
      exports.unit_meter(handle);
      return read(command(), dsp.idle);
    },
  });
};
