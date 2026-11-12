import type { LfosState } from '../../common/lfo/lfo-curve';
// the params, the options and the messages of the chorus (its Rust core, dsp/chorus: chorus-wasm.ts), no signal
// processing here

// the params of the core: rate (Hz of its LFO: in BPM the one of its division at the tempo), d1 and d2 (ms of the
// second and the first tap of a channel), depth (0..26: how far the LFO moves the taps), fb (0..0.95, of each tap
// into itself), cut (Hz of the filter), hpf (1: a high pass), level (the knob, 0..1) and the mix of its slot
// (0..1), which the core applies itself
export interface ChorusDspParams {
  rate: number;
  d1: number;
  d2: number;
  depth: number;
  fb: number;
  cut: number;
  hpf: number;
  level: number;
  mix: number;
}

export interface ChorusOptions {
  params: ChorusDspParams;
  // the LFOs as they are when the node is made (stereo-processor.ts)
  lfos?: LfosState;
  // out of the chain or bypassed already
  inactive?: boolean;
}

// main thread → worklet: changed params; `active` false while the effect is out of the chain or bypassed (no
// feedback then: its taps drain, an old tail never comes back)
export interface ChorusMessage {
  params?: Partial<ChorusDspParams>;
  active?: boolean;
}

// the laws of the knobs, as measured (dsp/chorus/src/lib.rs has them too): the ms the depth moves a tap by at the
// top of its LFO, the level (0..4, 1 at the middle)
const DEPTH_TOP = 26;
const TRAVEL_MS = 62.5;
export const depthMs = (depth: number) => (depth / DEPTH_TOP) * TRAVEL_MS;
export const levelGain = (knob: number) => 4 * knob * knob;
