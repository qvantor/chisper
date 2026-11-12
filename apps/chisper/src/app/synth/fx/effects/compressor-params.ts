import type { LfosState } from '../../common/lfo/lfo-curve';
// the params, the options and the messages of the compressor (its Rust core, dsp/compressor: compressor-wasm.ts),
// no signal processing here

// the compressor params (FX_PARAMS.compressor and the mix of its slot, which the core applies itself): multi (0 one
// band, 1 three), thresh (the knob, 0..1), ratio, attack and release (ms), gain (the makeup knob, 0..1), xlow and
// xhigh (the crossovers, Hz), below (the ratio of the upward compression of the bands, 0..1), low, mid and high
// (the gains of the bands, dB), level (the knob, 0..1), mix (0..1)
export interface CompressorDspParams {
  multi: number;
  thresh: number;
  ratio: number;
  attack: number;
  release: number;
  gain: number;
  xlow: number;
  xhigh: number;
  below: number;
  low: number;
  mid: number;
  high: number;
  level: number;
  mix: number;
}

export interface CompressorOptions {
  params: CompressorDspParams;
  // the LFOs as they are when the node is made (stereo-processor.ts)
  lfos?: LfosState;
  // the meter is watched already
  meter?: boolean;
}

// main thread → worklet: changed params; `meter` asks for the meter (true) or stops it
export interface CompressorMessage {
  params?: Partial<CompressorDspParams>;
  meter?: boolean;
}

// the gains of the bands (dB: under 0 a reduction, over it a boost of its upward compression) and the peak of its
// input
export interface CompressorMeterValues {
  gains: [number, number, number];
  input: number;
}

// worklet → main thread, about 30 times a second while the meter is asked for and something sounds: the gain of
// the low, mid and high bands (all three the one of the one band circuit) and the peak of the input
export interface CompressorMeterMessage {
  meter: CompressorMeterValues;
}

// the laws of the knobs, as measured: the threshold of the one band circuit (dB of a peak at the output of the
// synth; -120 dB at the top of the knob), the makeup gain (1..32) and the level (0..4, 1 at the middle)
const THRESHOLD_FLOOR = -120;
// the effects of the Audio Unit work this much (dB) under its output
const THRESHOLD_SCALE = 1.397;
export const thresholdDb = (knob: number) =>
  Math.max(THRESHOLD_FLOOR, 60 * Math.log10(Math.max(1 - knob, 1e-9))) + THRESHOLD_SCALE;
// the thresholds of the three bands (low, mid, high), which the same knob moves: those of its middle, with its
// square (ABOVE of dsp/compressor/src/lib.rs; compressor-dsp.spec.ts holds the core to them)
const BAND_THRESHOLDS = [-33.8, -30.2, -35.5] as const;
export const bandThresholdsDb = (knob: number): [number, number, number] => {
  const squared = (2 * Math.min(Math.max(knob, 0), 1)) ** 2;
  const [low, mid, high] = BAND_THRESHOLDS;
  return [low * squared + THRESHOLD_SCALE, mid * squared + THRESHOLD_SCALE, high * squared + THRESHOLD_SCALE];
};
export const makeupGain = (knob: number) => 1 + 31 * knob;
export const levelGain = (knob: number) => 4 * knob * knob;
