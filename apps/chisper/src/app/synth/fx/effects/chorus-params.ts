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
  // the meter is watched already
  meter?: boolean;
}

// main thread → worklet: changed params; `active` false while the effect is out of the chain or bypassed (no
// feedback then: its taps drain, an old tail never comes back); `meter` asks for the meter (true) or stops it
export interface ChorusMessage {
  params?: Partial<ChorusDspParams>;
  active?: boolean;
  meter?: boolean;
}

// what a screen draws the taps of: the LFO of the core (cycles: it starts with its node and never stops, no one
// else knows it), and its rate (Hz), delays (ms) and depth as the core has them now (the routes move them in the
// worklet), the cutoff of its filter (Hz, as the routes have it: the glow of the screen); `idle`: nothing sounds in
// it (its LFO goes on)
export interface ChorusMeterValues {
  phase: number;
  rate: number;
  d1: number;
  d2: number;
  depth: number;
  cut: number;
  idle: boolean;
}

// worklet → main thread, about 30 times a second while the meter is asked for and the core is not idle (idle:
// once)
export interface ChorusMeterMessage {
  meter: ChorusMeterValues;
}

// the laws of the knobs, as measured (dsp/chorus/src/lib.rs has them too): the ms the depth moves a tap by at the
// top of its LFO, the level (0..4, 1 at the middle)
const DEPTH_TOP = 26;
const TRAVEL_MS = 62.5;
export const depthMs = (depth: number) => (depth / DEPTH_TOP) * TRAVEL_MS;
export const levelGain = (knob: number) => 4 * knob * knob;

// Where the LFO has the taps (`targets` of the core, in ms past the latency of a tap): L first, L second, R first,
// R second; the first tap of a channel on Delay 2, the second on Delay 1, the taps of a channel half a cycle
// apart, the right channel a quarter ahead. Written into `taps` (nothing is made a frame)
export const TAPS = 4;
const TAP_PHASES = [0, 0.5, 0.25, 0.75];
// the channel of a tap (0 L, 1 R) and the knob of its delay
export const tapChannel = (tap: number) => tap >> 1;
export const tapDelayParam = (tap: number) => (tap % 2 === 0 ? 'd2' : 'd1');
// a triangle 0..1 of a phase in cycles, 1 at a whole one
const triangle = (phase: number) => 1 - 2 * Math.abs(phase - Math.floor(phase + 0.5));
export const chorusTaps = (
  phase: number,
  params: Pick<ChorusDspParams, 'd1' | 'd2' | 'depth'>,
  taps: number[] = []
) => {
  const travel = depthMs(params.depth);
  for (let tap = 0; tap < TAPS; tap++) {
    taps[tap] = params[tapDelayParam(tap)] + travel * triangle(phase + TAP_PHASES[tap]);
  }
  return taps;
};
// the pole a tap follows its target through, ms (FOLLOW of the core), and the longest a tap is (both knobs at
// their tops: MAX_DELAY of the core and the travel)
export const TAP_FOLLOW_MS = 20;
const MAX_DELAY_MS = 20;
export const MAX_TAP_MS = MAX_DELAY_MS + TRAVEL_MS;
