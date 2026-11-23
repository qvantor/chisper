import FFT from 'fft.js';
import { NEUTRAL_PARAMS } from '../app/synth/common/chain/chain-params';
import type { UnitExports } from '../app/synth/common/wasm/stereo-core';
import type { DelayDspParams } from '../app/synth/fx/effects/delay-params';
import { createDelayWasm } from '../app/synth/fx/effects/delay-wasm';
import { FxChange, renderStereo } from './fx-render';
import { wasmCore } from './wasm';

// the delay as its specs render it, and the knobs of the delay of the Audio Unit it is held to as ours
// (dsp/measurements/delay.json, scripts/renders/run.mjs --only=delay)

let core: UnitExports | undefined;
// one instance for a spec file
export const delayCore = () => (core ??= wasmCore<UnitExports>('engine'));

export const DELAY_DEFAULTS = NEUTRAL_PARAMS.delay as unknown as DelayDspParams;

export const renderDelay = (
  params: Partial<DelayDspParams>,
  input: [ArrayLike<number>, ArrayLike<number>],
  changes: FxChange<DelayDspParams>[] = [],
  rate = 44100
) => renderStereo(createDelayWasm(delayCore(), rate, { ...DELAY_DEFAULTS, ...params }), input, changes);

// the plain params of the delay of the Audio Unit, as its state names them
export interface AudioUnitDelay {
  kParamTimeL?: number;
  kParamBeatSync?: number;
  kParamFeedback?: number;
  kParamWet?: number;
  kParamFreq?: number;
  kParamBW?: number;
  kParamMode?: number;
}

// a fresh one (measured: `fresh`)
export const AUDIO_UNIT_DELAY = {
  kParamFeedback: 40,
  kParamWet: 30,
  kParamFreq: Math.sqrt(40 * 18000),
  kParamBW: 6.75,
  kParamMode: 0,
};

// the laws of its knobs, as measured:
// - a free time is 1 ms over its echo, which comes at a whole sample 2 before it: max(8, ceil((knob - 0.001) ·
//   rate)) - 2 samples after the sound (ours: the nearest sample of Time, so 1.5 samples under it)
export const freeSeconds = (knob: number, rate: number) => knob - 0.001 - 1.5 / rate;
// - a time in sync is a division by its knob (the knob up to each: `sync`), its echo 2 samples before it too
const SYNC_BEATS: [upTo: number, beats: number][] = [
  [0.006, 1 / 16],
  [0.015, 1 / 8],
  [0.03, 1 / 4],
  [0.06, 1 / 2],
  [0.11, 1],
  [0.18, 2],
  [0.28, 4],
  [0.41, 8],
];
export const syncBeats = (knob: number) => SYNC_BEATS.find(([upTo]) => knob < upTo)?.[1] ?? 16;
// - its bandpass is the one of ours (the cookbook's, 0 dB at its peak) at kParamFreq, as wide as kParamBW (0.75 to
//   8.25) says: Q = 1 / (2 sinh(0.6 BW))
const qOfWidth = (width: number) => 1 / (2 * Math.sinh(0.6 * Math.min(Math.max(width, 0.75), 8.25)));
// - the feedback and the mix are ours (kParamFeedback / 100, kParamWet / 100: the mix of a slot of echoes), mode 1
//   is ping-pong
export const delayOfAudioUnit = (knobs: AudioUnitDelay, rate = 44100, bpm = 120): DelayDspParams => {
  const { kParamTimeL = 0.1, kParamBeatSync = 1 } = knobs;
  const all = { ...AUDIO_UNIT_DELAY, ...knobs };
  return {
    time:
      kParamBeatSync === 0 ? freeSeconds(kParamTimeL, rate) : (syncBeats(kParamTimeL) * 60) / bpm - 2 / rate,
    fb: all.kParamFeedback / 100,
    mode: all.kParamMode === 1 ? 1 : 0,
    pan: 0,
    freq: all.kParamFreq,
    q: qOfWidth(all.kParamBW),
  };
};

// the phase of a signal sample by sample (unwrapped), out of its analytic signal
const phaseOf = (x: ArrayLike<number>) => {
  let size = 1;
  while (size < x.length) size <<= 1;
  const fft = new FFT(size);
  const input = new Float64Array(size);
  input.set(x);
  const bins = fft.createComplexArray();
  fft.realTransform(bins, input);
  fft.completeSpectrum(bins);
  for (let k = 1; k < size; k++) {
    const scale = k < size / 2 ? 2 : k === size / 2 ? 1 : 0;
    bins[2 * k] *= scale;
    bins[2 * k + 1] *= scale;
  }
  const z = fft.createComplexArray();
  fft.inverseTransform(z, bins);
  const phase = new Float64Array(x.length);
  for (let n = 0; n < x.length; n++) {
    const p = Math.atan2(z[2 * n + 1], z[2 * n]);
    phase[n] = n === 0 ? p : p + 2 * Math.PI * Math.round((phase[n - 1] - p) / (2 * Math.PI));
  }
  return phase;
};

// the delay (samples) a sine of `period` samples through a delay is read at, sample by sample: the phase of the wet
// signal against the dry one (as scripts/renders/run.mjs reads the renders of the Audio Unit), the branch of a whole
// period whose mean over [from, to) is nearest `mean`
export const readDelays = (
  wet: ArrayLike<number>,
  dry: ArrayLike<number>,
  period: number,
  mean: number,
  [from, to]: [number, number]
) => {
  const [a, b] = [phaseOf(dry), phaseOf(wet)];
  const d = Float64Array.from(a, (p, n) => ((p - b[n]) * period) / (2 * Math.PI));
  let average = 0;
  for (let n = from; n < to; n++) average += d[n] / (to - from);
  const branch = Math.round((mean - average) / period) * period;
  return d.map((value) => value + branch);
};
