import { FX_PARAMS } from '@chisper/preset-schema';
import { mapValues } from 'lodash';
import { EQ_BANDS, type EqDspParams } from '../app/synth/fx/effects/eq-params';
import { createEqWasm, EqExports } from '../app/synth/fx/effects/eq-wasm';
import { FxChange, renderStereo } from './fx-render';
import { wasmCore } from './wasm';

// the Rust core of the EQ (dsp/chain/src/eq.rs) as the specs render it: through its facade, block by block (its
// mix is of its slot: the facade is all wet)

export const EQ_DEFAULTS: EqDspParams = mapValues(FX_PARAMS.eq, (param) => param.default);

let core: EqExports | undefined;
// one instance of the core for a spec file (a scope)
export const eqCore = () => (core ??= wasmCore<EqExports>('engine'));

export type EqChange = FxChange<EqDspParams>;

// the params of band `band` (0, 1): its type, frequency, resonance, gain
export const bandParams = (
  band: number,
  type: number,
  freq: number,
  reso: number,
  gain: number
): Partial<EqDspParams> => {
  const keys = EQ_BANDS[band];
  return { [keys.type]: type, [keys.freq]: freq, [keys.reso]: reso, [keys.gain]: gain };
};

// both channels through an EQ of `params` at `rate`, in blocks of 128: the outputs, whether it was idle after each
// block
export const renderEq = (
  params: Partial<EqDspParams>,
  rate: number,
  channels: [ArrayLike<number>, ArrayLike<number>],
  changes: EqChange[] = []
) => renderStereo(createEqWasm(eqCore(), rate, { params: { ...EQ_DEFAULTS, ...params } }), channels, changes);

// the response (dB) of an EQ at frequencies: an impulse through it, the DFT of what came out (it rings out in `n`:
// 1.4 s)
export const responseOf = (
  params: Partial<EqDspParams>,
  rate: number,
  frequencies: readonly number[],
  n = 2 ** Math.ceil(Math.log2(1.4 * rate))
) => {
  const impulse = new Float64Array(n);
  impulse[0] = 1;
  const { left } = renderEq(params, rate, [impulse, impulse]);
  return frequencies.map((hz) => {
    // (a DFT at the frequency itself: no bin to round it to)
    let [re, im] = [0, 0];
    const w = (2 * Math.PI * hz) / rate;
    for (let i = 0; i < n; i++) {
      re += left[i] * Math.cos(w * i);
      im -= left[i] * Math.sin(w * i);
    }
    return 10 * Math.log10(re * re + im * im);
  });
};
