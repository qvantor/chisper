import bytes from '@chisper/wasm/compressor.wasm';
import { COMPRESSOR_PROCESSOR } from '../../common/processors';
import { prewarmStereo } from '../../common/wasm/stereo-core';
import { instantiateCore } from '../../common/wasm/wasm-core';
import type {
  CompressorDspParams,
  CompressorMessage,
  CompressorMeterMessage,
  CompressorOptions,
} from './compressor-params';
import { CompressorExports, createCompressorWasm } from './compressor-wasm';
import { registerStereoProcessor } from './stereo-processor';

// the audio worklet module of the compressor with its Rust core (dsp/compressor), bundled by esbuild (`npm run
// worklets`) into assets/worklets/compressor.js with the bytes of compressor.wasm; it runs in the
// AudioWorkletGlobalScope: no window, document or React

declare const sampleRate: number;

// the meter, about this many times a second while it is watched
const METER_RATE = 30;

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
    // (the frames since the last message; nothing is read off the core while no one watches. `rested`: the meter
    // of a core at rest was posted, nothing moves until a sound. `message`: the one posted every time, the port
    // copies it, its meter is the values of the core)
    const dsp = createCompressorWasm(core, rate, options);
    const message: CompressorMeterMessage = { meter: dsp.meter() };
    return Object.assign(dsp, { metering: !!options.meter, waited: 0, rested: false, message });
  },
  (dsp, { params, meter }: CompressorMessage) => {
    if (params) dsp.set(params);
    if (meter !== undefined) {
      dsp.metering = meter;
      dsp.waited = 0;
      dsp.rested = false;
    }
  },
  // the knobs the envelopes move (fx-modulation.ts)
  (dsp, values) => dsp.set(values),
  (dsp, frames): CompressorMeterMessage | null => {
    if (!dsp.metering) return null;
    dsp.waited += frames;
    if (dsp.waited < sampleRate / METER_RATE) return null;
    dsp.waited = 0;
    const { idle } = dsp;
    if (idle && dsp.rested) return null;
    dsp.rested = idle;
    dsp.meter();
    return dsp.message;
  }
);
