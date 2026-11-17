// the delay as its core takes it (dsp/chain/src/delay.rs), shared by the main thread, the worklet and the specs:
// no imports

// the seconds of the echoes (in BPM: of the division at the tempo, worked out on the main thread), the feedback,
// the mode (0 normal, 1 ping-pong), the seconds a channel comes late by (under 0 the right one), the bandpass
export interface DelayDspParams {
  time: number;
  fb: number;
  mode: number;
  pan: number;
  freq: number;
  q: number;
}

// seconds of a line: a bar at 60 BPM; a longer division plays this long
export const DELAY_LINE_MAX = 4;
