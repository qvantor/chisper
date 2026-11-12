import { FX_MIX_PARAMS, FX_PARAMS } from '@chisper/preset-schema';
import { mapValues } from 'lodash';
import type { CompressorDspParams } from '../app/synth/fx/effects/compressor-params';
import { CompressorExports, createCompressorWasm } from '../app/synth/fx/effects/compressor-wasm';
import { dB } from './measures';
import { wasmCore } from './wasm';

// the Rust core of the compressor (dsp/compressor) as the specs render it: through its facade, block by block

export const COMPRESSOR_DEFAULTS: CompressorDspParams = {
  ...mapValues(FX_PARAMS.compressor, (param) => param.default),
  mix: FX_MIX_PARAMS.compressor.default,
};

const BLOCK = 128;
let core: CompressorExports | undefined;
// one instance of the core for a spec file (a scope)
export const compressorCore = () => (core ??= wasmCore<CompressorExports>('compressor'));

export interface CompressorChange {
  // the frame of the block it is set before
  at: number;
  params?: Partial<CompressorDspParams>;
  clear?: boolean;
}

// both channels through a compressor of `params` at `rate`, in blocks of 128: the outputs, whether it was idle
// after each block and its meter then
export const renderCompressor = (
  params: Partial<CompressorDspParams>,
  rate: number,
  [left, right]: [ArrayLike<number>, ArrayLike<number>],
  changes: CompressorChange[] = []
) => {
  const dsp = createCompressorWasm(compressorCore(), rate, { params: { ...COMPRESSOR_DEFAULTS, ...params } });
  const frames = left.length;
  const [outL, outR] = [new Float32Array(frames), new Float32Array(frames)];
  const idle: boolean[] = [];
  const meters: ReturnType<typeof dsp.meter>[] = [];
  for (let start = 0; start < frames; start += BLOCK) {
    const n = Math.min(BLOCK, frames - start);
    changes
      .filter(({ at }) => at >= start && at < start + BLOCK)
      .forEach((change) => {
        if (change.params) dsp.set(change.params);
        if (change.clear) dsp.clear();
      });
    const [inL, inR] = [left, right].map((channel) =>
      Float32Array.from({ length: n }, (_, i) => channel[start + i])
    );
    const [blockL, blockR] = [new Float32Array(n), new Float32Array(n)];
    dsp.process(inL, inR, blockL, blockR);
    outL.set(blockL, start);
    outR.set(blockR, start);
    idle.push(dsp.idle);
    // (the core gives the same object every time)
    const { gains, input } = dsp.meter();
    meters.push({ gains: [...gains], input });
  }
  dsp.free();
  return { left: outL, right: outR, idle, meters };
};

// a sine of both channels a quarter of a cycle apart (its level is hypot(L, R) at every sample), or alike (mono):
// [dB, seconds] one after another, × `scale`
export const quadrature = (
  rate: number,
  hz: number,
  segments: [number, number][],
  { mono = false, scale = 1 } = {}
): [Float64Array, Float64Array] => {
  const total = Math.round(segments.reduce((sum, [, seconds]) => sum + seconds, 0) * rate);
  const [left, right] = [new Float64Array(total), new Float64Array(total)];
  let i = 0;
  for (const [level, seconds] of segments) {
    const a = scale * 10 ** (level / 20);
    for (let k = 0; k < Math.round(seconds * rate); k++, i++) {
      const phase = (2 * Math.PI * hz * i) / rate;
      left[i] = a * Math.sin(phase);
      right[i] = a * (mono ? Math.sin(phase) : Math.cos(phase));
    }
  }
  return [left, right];
};

// the gain (dB) of the outputs against the inputs at a frame: the levels of both channels
export const gainAt = (
  out: { left: ArrayLike<number>; right: ArrayLike<number> },
  [left, right]: [ArrayLike<number>, ArrayLike<number>],
  frame: number
) => dB(Math.hypot(out.left[frame], out.right[frame]) / Math.hypot(left[frame], right[frame]));
