import { FX_PARAMS } from '@chisper/preset-schema';
import { mapValues } from 'lodash';
import type { FxFilterDspParams } from '../app/synth/fx/effects/fxfilter-params';
import { createFxFilterWasm, FxFilterExports } from '../app/synth/fx/effects/fxfilter-wasm';
import { FxChange, renderStereo } from './fx-render';
import { dB } from './measures';
import { wasmCore } from './wasm';

// the Rust core of the FX Filter (dsp/chain/src/fxfilter.rs) as the specs render it: through its facade, block by
// block, its mix inside (all wet unless said)

export const FX_FILTER_DEFAULTS: FxFilterDspParams = mapValues(FX_PARAMS.fxfilter, (param) => param.default);

let core: FxFilterExports | undefined;
// one instance of the core for a spec file (a scope)
export const fxFilterCore = () => (core ??= wasmCore<FxFilterExports>('engine'));

export type FxFilterChange = FxChange<FxFilterDspParams & { mix: number }>;

// both channels through a filter of `params` at `rate`, in blocks of 128: the outputs, whether it was idle after
// each block
export const renderFxFilter = (
  params: Partial<FxFilterDspParams>,
  rate: number,
  channels: [ArrayLike<number>, ArrayLike<number>],
  changes: FxFilterChange[] = [],
  mix = 1
) =>
  renderStereo(
    createFxFilterWasm(fxFilterCore(), rate, { params: { ...FX_FILTER_DEFAULTS, ...params }, mix }),
    channels,
    changes
  );

// the response (dB) of a filter of `params` at `frequencies` (of a channel): an impulse of `amplitude` (quiet: the
// small signal) through it, the DFT of `n` samples of what came out at each one
export const fxFilterResponse = (
  params: Partial<FxFilterDspParams>,
  rate: number,
  frequencies: readonly number[],
  { amplitude, n, channel = 0, mix = 1 }: { amplitude: number; n: number; channel?: number; mix?: number }
) => {
  const impulse = new Float64Array(n);
  impulse[0] = amplitude;
  const out = renderFxFilter(params, rate, [impulse, impulse], [], mix);
  const y = channel ? out.right : out.left;
  return frequencies.map((hz) => {
    // (a DFT at the frequency itself: no bin to round it to)
    let [re, im] = [0, 0];
    const w = (2 * Math.PI * hz) / rate;
    for (let i = 0; i < n; i++) {
      re += y[i] * Math.cos(w * i);
      im -= y[i] * Math.sin(w * i);
    }
    return dB(Math.hypot(re, im) / amplitude);
  });
};
