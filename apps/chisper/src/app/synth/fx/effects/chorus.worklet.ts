import bytes from '@chisper/wasm/chorus.wasm';
import { CHORUS_PROCESSOR } from '../../common/processors';
import { prewarmStereo } from '../../common/wasm/stereo-core';
import { instantiateCore } from '../../common/wasm/wasm-core';
import type { ChorusDspParams, ChorusMessage, ChorusMeterValues, ChorusOptions } from './chorus-params';
import { ChorusExports, createChorusWasm } from './chorus-wasm';
import { MeterDsp, meterReport, watchMeter, withMeter } from './meter-report';
import { registerStereoProcessor } from './stereo-processor';

// the audio worklet module of the chorus with its Rust core (dsp/chorus), bundled by esbuild (`npm run worklets`)
// into assets/worklets/chorus.js with the bytes of chorus.wasm; it runs in the AudioWorkletGlobalScope: no
// window, document or React

declare const sampleRate: number;

const WARM: ChorusDspParams = {
  rate: 1,
  d1: 5,
  d2: 0,
  depth: 26,
  fb: 0.5,
  cut: 1000,
  hpf: 0,
  level: 0.5,
  mix: 0.5,
};

const core = instantiateCore<ChorusExports>(new WebAssembly.Module(bytes));
// (the gains and the filter gliding in the second block)
const warm = createChorusWasm(core, sampleRate, { params: WARM });
prewarmStereo({
  process: (inL, inR, outL, outR) => {
    warm.process(inL, inR, outL, outR);
    warm.set({ hpf: 1, cut: 4000, mix: 1, fb: 0.1 });
    warm.meter();
  },
  free: warm.free,
});

// the params as the core has them: while the effect is not active its feedback is 0 (the one of its knob kept)
const apply = (dsp: ChorusDsp, params: Partial<ChorusDspParams>) => {
  if (params.fb !== undefined) dsp.fb = params.fb;
  dsp.set(dsp.active || params.fb === undefined ? params : { ...params, fb: 0 });
};
type ChorusDsp = ReturnType<typeof createChorusWasm> &
  MeterDsp<ChorusMeterValues> & { active: boolean; fb: number };

registerStereoProcessor(
  CHORUS_PROCESSOR,
  (rate, { processorOptions }): ChorusDsp => {
    const { params, inactive = false, meter = false } = processorOptions as ChorusOptions;
    const wasm = createChorusWasm(core, rate, { params: inactive ? { ...params, fb: 0 } : params });
    return Object.assign(withMeter(wasm, meter), { active: !inactive, fb: params.fb });
  },
  (dsp, { params, active, meter }: ChorusMessage) => {
    if (params) apply(dsp, params);
    if (meter !== undefined) watchMeter(dsp, meter);
    if (active !== undefined && active !== dsp.active) {
      dsp.active = active;
      dsp.set({ fb: active ? dsp.fb : 0 });
    }
  },
  // the knobs the routes move (fx-modulation.ts)
  (dsp, values) => apply(dsp, values),
  // its LFO and the knobs of its taps, while a screen shows them
  (dsp, frames) => meterReport(dsp, frames, sampleRate)
);
