import { wave } from '@chisper/math';
import type { SubShape } from '@chisper/preset-schema';

// The shapes of the sub (sub.rs of the core): one cycle each, a table of the store of one frame of 2048 samples whose
// levels the worker builds as for any table (wavetable-mipmap), sent the first time a shape is on (the sub model).
// Sine has none: the sub plays the sine of the store. As the shapes of the renders (dsp/measurements/sub.json
// `shapes`: their harmonics at C2 against the amplitude of the sine, their phases against n × that of the first),
// a cycle from the phase a note starts at at Phase 0, where every shape goes down from: saw, square and pulse ideal
// (their harmonics within 0.1 dB of the renders: a saw that rises from its bottom, a square low then high, a pulse
// low for PULSE_WIDTH of a cycle), up to the nyquist of the frame; triangle and rounded rect as measured, up to
// harmonic 40 and 12 (the rest under -64 and -69 dB). The DC of the pulse is dropped, as the tables drop it

export const SUB_FRAME = 2048;
// the share of a cycle the pulse is low for (sub.json `shapes.pulse`: its harmonics, least squares)
export const PULSE_WIDTH = 0.27051;
// the amplitude of the first harmonic of a shape against the one of the sine (sub.json)
const SAW_LEVEL = 0.72769;
const SQUARE_LEVEL = 0.86577;
const PULSE_LEVEL = 0.71311;

// the harmonics 1.. of a measured shape: [amplitude against the sine, phase against n × the phase of the first
// (degrees)]
type Measured = readonly (readonly [number, number])[];
const TRIANGLE: Measured = [
  [0.9876, 0],
  [0.01664, 176.3],
  [0.1083, -180],
  [0.008234, -7.3],
  [0.03795, 0.2],
  [0.005403, 169],
  [0.01857, -179.3],
  [0.003988, -14.7],
  [0.01064, 1.6],
  [0.003088, 161.7],
  [0.006647, -176.9],
  [0.002487, -22],
  [0.004374, 5.4],
  [0.002058, 154.3],
  [0.003002, -171.1],
  [0.001715, -29.4],
  [0.002101, 13.9],
  [0.001458, 146.9],
  [0.001544, -159.1],
  [0.001201, -36.9],
  [0.001158, 30.1],
  [0.001029, 139.4],
  [0.0009006, -138.8],
  [0.0008577, -44.4],
  [0.0007719, 53],
  [0.000729, 131.8],
  [0.0006861, -116.2],
  [0.0006004, -52.1],
  [0.0006433, 72.6],
  [0.0005146, 124],
  [0.0006433, -100.8],
  [0.0004288, -59.9],
  [0.0006433, 83.9],
  [0.0003431, 116],
  [0.0006004, -92.9],
  [0.0002573, -68.2],
  [0.0006004, 89.2],
  [0.0002144, 107.4],
  [0.0005575, -89.5],
  [0.0001287, -77.4],
];
const ROUND_RECT: Measured = [
  [1.002, 0],
  [0.0211, -125.2],
  [0.003002, 165.6],
  [0.005789, 93.2],
  [0.0208, -179.3],
  [0.002058, 51.6],
  [0.002359, -7.8],
  [0.002187, -80.4],
  [0.004589, 3.3],
  [0.0009434, 171.3],
  [0.00253, 179],
  [0.0008148, 52.3],
];

const HARMONICS = SUB_FRAME / 2 - 1;

// the table of a shape (null: the sine of the store)
export const subTable = (shape: SubShape) => (shape === 'sine' ? null : `sub:${shape}`);

// the Fourier series of a shape (realWithImag of @chisper/math: x(t) = Σ real[n]·cos(2πnt) + imag[n]·sin(2πnt))
export const subSpectrum = (shape: SubShape): [Float64Array, Float64Array] => {
  const real = new Float64Array(HARMONICS + 1);
  const imag = new Float64Array(HARMONICS + 1);
  // harmonic n at amplitude a and phase ψ: a·sin(2πnt + ψ)
  const add = (n: number, a: number, psi: number) => {
    real[n] = a * Math.sin(psi);
    imag[n] = a * Math.cos(psi);
  };
  // a measured shape from the phase of the sine a note starts at: half a cycle on (it goes down)
  const measured = (harmonics: Measured) =>
    harmonics.forEach(([a, phase], i) => add(i + 1, a, (phase * Math.PI) / 180 + (i + 1) * Math.PI));
  switch (shape) {
    case 'sine':
      add(1, 1, Math.PI);
      break;
    case 'saw':
      // 2t - 1 at the peak SAW_LEVEL · π / 2: -Σ sin(2πnt) / n
      for (let n = 1; n <= HARMONICS; n++) add(n, SAW_LEVEL / n, Math.PI);
      break;
    case 'square':
      for (let n = 1; n <= HARMONICS; n += 2) add(n, SQUARE_LEVEL / n, Math.PI);
      break;
    case 'pulse': {
      // A - 2A·[t < w]: the cosines -2A·sin(2πnw) / πn, the sines -2A·(1 - cos(2πnw)) / πn
      const height = (PULSE_LEVEL * Math.PI) / (4 * Math.sin(Math.PI * PULSE_WIDTH));
      for (let n = 1; n <= HARMONICS; n++) {
        const angle = 2 * Math.PI * n * PULSE_WIDTH;
        real[n] = (-2 * height * Math.sin(angle)) / (Math.PI * n);
        imag[n] = (-2 * height * (1 - Math.cos(angle))) / (Math.PI * n);
      }
      break;
    }
    case 'triangle':
      measured(TRIANGLE);
      break;
    case 'round-rect':
      measured(ROUND_RECT);
      break;
  }
  return [real, imag];
};

// one cycle of a shape: the frame of its table
export const subShapeFrame = (shape: SubShape) => {
  const [real, imag] = subSpectrum(shape);
  return wave.fromRealWithImag(real, imag, HARMONICS, SUB_FRAME, new Float32Array(SUB_FRAME));
};
