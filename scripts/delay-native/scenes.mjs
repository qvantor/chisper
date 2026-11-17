// the scenes of the delay of the native nodes (run.mjs renders them into dsp/measurements/delay.json; the spec of
// the core makes the same inputs: delay-measured.spec.ts has its copy of `clicks` and `tone`, the JSON names which)

// two clicks and a burst of noise of whole numbers (the same bits everywhere): the left channel first, the right
// one three frames later, half as loud and upside down
export const clicks = (frames) => {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  left[0] = 1;
  right[3] = -0.5;
  let seed = 12345;
  const next = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 8) / 0x1000000 - 0.5;
  };
  for (let i = 16; i < 272; i++) {
    left[i] = next() * 0.5;
    right[i] = next() * 0.25;
  }
  return [left, right];
};

// a train of clicks every 441 frames, the right channel 100 frames after the left one: what a Time that moves bends
export const train = (frames) => {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i += 441) {
    left[i] = 0.5;
    if (i + 100 < frames) right[i + 100] = -0.5;
  }
  return [left, right];
};

const INPUTS = { clicks, train };
const DEFAULTS = { time: 0.2, fb: 0.5, mode: 0, pan: 0, freq: 1000, q: 0.01 };

const scene = (name, params, { rate = 44100, frames = 8192, input = 'clicks', changes = [] } = {}) => ({
  name,
  rate,
  frames,
  kind: input,
  params: { ...DEFAULTS, ...params },
  changes,
  input: INPUTS[input](frames),
});

export const SCENES = [
  // whole samples of delay (0.02 s: 882), the wide bandpass of the defaults
  scene('normal', { time: 0.02 }),
  // between two samples: the line read linear
  scene('fractional', { time: 0.012345, fb: 0.8 }),
  scene('ping-pong', { time: 0.015, fb: 0.7, mode: 1 }),
  scene('pan right', { time: 0.02, pan: 0.0123 }),
  scene('pan left', { time: 0.02, pan: -0.004 }),
  scene('narrow filter', { time: 0.01, fb: 0.9, freq: 3000, q: 3 }),
  scene('low filter', { time: 0.02, fb: 0.9, freq: 200, q: 0.7 }),
  scene('48 kHz', { time: 0.0123, fb: 0.6, pan: 0.001, freq: 5000, q: 1 }, { rate: 48000 }),
  // Time moves as a tape: down, then up
  scene(
    'time glide',
    { time: 0.03, fb: 0.6 },
    {
      frames: 16384,
      input: 'train',
      changes: [
        { frame: 1280, params: { time: 0.012 } },
        { frame: 8960, params: { time: 0.04 } },
      ],
    }
  ),
  // the gains and the filter glide: the feedback, the mode, the pan, the bandpass
  scene(
    'knobs glide',
    { time: 0.011, fb: 0.3 },
    {
      frames: 16384,
      input: 'train',
      changes: [
        { frame: 1280, params: { fb: 0.85 } },
        { frame: 3840, params: { mode: 1 } },
        { frame: 6400, params: { pan: 0.01, freq: 2500, q: 2 } },
        { frame: 10240, params: { mode: 0, pan: -0.003 } },
      ],
    }
  ),
];
