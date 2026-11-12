import bytes from '@chisper/wasm/compressor.wasm';
import { COMPRESSOR_PROCESSOR } from '../../common/processors';
import { prewarmStereo } from '../../common/wasm/stereo-core';
import { instantiateCore } from '../../common/wasm/wasm-core';
import type { CompressorDspParams, CompressorMessage, CompressorOptions } from './compressor-params';
import { CompressorExports, createCompressorWasm } from './compressor-wasm';
import { meterReport, watchMeter, withMeter } from './meter-report';
import { registerStereoProcessor } from './stereo-processor';

// the audio worklet module of the compressor with its Rust core (dsp/compressor), bundled by esbuild (`npm run
// worklets`) into assets/worklets/compressor.js with the bytes of compressor.wasm; it runs in the
// AudioWorkletGlobalScope: no window, document or React

declare const sampleRate: number;

const WARM: CompressorDspParams = {
  multi: 0,
  thresh: 0.9,
  ratio: 4,
  attack: 1,
  release: 50,
  gain: 0.1,
  xlow: 131,
  xhigh: 2500,
  below: 0.5,
  low: 0,
  mid: 0,
  high: 0,
  level: 0.5,
  mix: 1,
};

const core = instantiateCore<CompressorExports>(new WebAssembly.Module(bytes));
// (both circuits: the mode changes in the second block, the fade runs them together)
const warm = createCompressorWasm(core, sampleRate, { params: WARM });
prewarmStereo({
  process: (inL, inR, outL, outR) => {
    warm.process(inL, inR, outL, outR);
    warm.set({ multi: 1 });
    warm.meter();
  },
  free: warm.free,
});

registerStereoProcessor(
  COMPRESSOR_PROCESSOR,
  (rate, { processorOptions }) => {
    const options = processorOptions as CompressorOptions;
    return withMeter(createCompressorWasm(core, rate, options), !!options.meter);
  },
  (dsp, { params, meter }: CompressorMessage) => {
    if (params) dsp.set(params);
    if (meter !== undefined) watchMeter(dsp, meter);
  },
  // the knobs the envelopes move (fx-modulation.ts)
  (dsp, values) => dsp.set(values),
  (dsp, frames) => meterReport(dsp, frames, sampleRate)
);
