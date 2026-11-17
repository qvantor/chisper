import { paramsCore, UNIT, UnitExports } from '../../common/wasm/stereo-core';
import type { ChorusDspParams, ChorusMeterValues, ChorusOptions } from './chorus-params';

// the Rust core of the chorus (dsp/chorus, a unit of chain.wasm): four taps (two a channel, a line each, fed back into
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

export type ChorusExports = UnitExports;

export const createChorusWasm = (exports: ChorusExports, sampleRate: number, { params }: ChorusOptions) => {
  const { dsp, handle, command } = paramsCore<keyof ChorusDspParams>(
    exports,
    UNIT.chorus,
    sampleRate,
    CHORUS_KEYS,
    params
  );
  // what meter() gives, the same object every time: nothing is made on the audio thread
  const values: ChorusMeterValues = { phase: 0, rate: 0, d1: 0, d2: 0, depth: 0, cut: 0, idle: true };
  // (assigned: `idle` of the dsp stays a getter)
  return Object.assign(dsp, {
    // the LFO and the knobs of the taps as the core has them (its values hold until the next call: who keeps
    // them copies them)
    meter: (): ChorusMeterValues => {
      exports.unit_meter(handle);
      const buffer = command();
      values.phase = buffer[0];
      values.rate = buffer[1];
      values.d1 = buffer[2];
      values.d2 = buffer[3];
      values.depth = buffer[4];
      values.cut = buffer[5];
      values.idle = dsp.idle;
      return values;
    },
  });
};
