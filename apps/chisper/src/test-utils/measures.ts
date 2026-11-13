import type { SubShape } from '@chisper/preset-schema';

// measures of the outputs of the core as of the renders of the reference AU (dsp/measurements/*.json)

// the frequency of a sine by its rising zero crossings over the samples from..to
export const frequencyOf = (x: Float32Array, rate: number, from = 4800, to = x.length) => {
  const crossings: number[] = [];
  for (let i = from; i < to - 1; i++)
    if (x[i] <= 0 && x[i + 1] > 0) crossings.push(i + x[i] / (x[i] - x[i + 1]));
  return ((crossings.length - 1) / (crossings[crossings.length - 1] - crossings[0])) * rate;
};
export const semitones = (hz: number, base: number) => 12 * Math.log2(hz / base);

export const dB = (value: number) => 20 * Math.log10(value);

// the complex amplitude of a tone of `hz` in x over n samples from `from` (Hann): its amplitude and its phase
// (degrees) against a sine from sample 0
export const toneOf = (x: ArrayLike<number>, hz: number, rate: number, from: number, n: number) => {
  let [re, im, sum] = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const phase = (2 * Math.PI * hz * (from + i)) / rate;
    re += x[from + i] * w * Math.sin(phase);
    im += x[from + i] * w * Math.cos(phase);
    sum += w;
  }
  return { amplitude: (2 * Math.hypot(re, im)) / sum, phase: (Math.atan2(im, re) * 180) / Math.PI };
};

// a share of a cycle within 0..1
export const turns = (value: number) => ((value % 1) + 1) % 1;
// the distance of two phases around a cycle (turns)
export const apart = (a: number, b: number) => Math.min(turns(a - b), turns(b - a));

// a shape of the sub as the renders name it (sub.json)
export const renderedShape = (shape: SubShape) => (shape === 'round-rect' ? 'roundRect' : shape);
