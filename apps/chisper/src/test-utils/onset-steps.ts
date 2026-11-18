const WINDOW = 0.001;
const BEFORE = 0.01;
const SILENCE = 1e-6;

// the largest step between two neighbouring samples in the first millisecond of a note at the frame `start`
export const onsetJump = (samples: Float32Array, start: number, rate: number) => {
  let step = 0;
  const end = Math.min(samples.length, start + Math.round(WINDOW * rate));
  for (let i = Math.max(1, start); i < end; i++) step = Math.max(step, Math.abs(samples[i] - samples[i - 1]));
  return step;
};

// the click of a note at its start: that step in shares of the RMS of the 10 ms before it (a voice that starts
// from its filter at rest steps a small share of it; an amplitude that jumps under a sounding filter steps
// several times it). Null for a note out of a silence (nothing to measure the step against)
const onsetStep = (samples: Float32Array, start: number, rate: number): number | null => {
  const before = Math.round(BEFORE * rate);
  if (start < before) return null;
  let squares = 0;
  for (let i = start - before; i < start; i++) squares += samples[i] * samples[i];
  const rms = Math.sqrt(squares / before);
  if (rms < SILENCE) return null;
  return onsetJump(samples, start, rate) / rms;
};

// the steps of the notes that start at the frames `starts` (those out of a silence left out)
export const onsetSteps = (samples: Float32Array, starts: number[], rate: number) =>
  starts.map((start) => onsetStep(samples, start, rate)).filter((step): step is number => step !== null);
