import { biquad, filterModel } from '@chisper/math';
import { FilterProps as Knobs } from '../types';

// the knobs of a response: Var and Drive of a model type (none: 0)
type FilterProps = Omit<Knobs, 'drive' | 'variation'> & Partial<Pick<Knobs, 'drive' | 'variation'>>;

type Coefficients = biquad.Coefficients;

const MIN_FREQ = 10;
const MAX_FREQ = 20000;
export const DB_RANGE = 48;

const POINTS = 256;

// a frequency of the chart: its x (a share of the width, log) and the trig terms of z = e^{jw}, they depend only on
// the frequency and the sample rate
type Point = { freq: number; x: number; cos1: number; sin1: number; cos2: number; sin2: number };

const point = (freq: number, sampleRate: number, x = 0): Point => {
  const w = (2 * Math.PI * freq) / sampleRate;
  return { freq, x, cos1: Math.cos(w), sin1: Math.sin(w), cos2: Math.cos(2 * w), sin2: Math.sin(2 * w) };
};

// the last frequency of the chart: nyquist at low sample rates (above it the response folds back and isn't heard)
const lastFreq = (sampleRate: number) => Math.min(MAX_FREQ, sampleRate / 2);

// the x of a frequency (a share of the width, log): the grid spans the width, also when it ends below MAX_FREQ
export const frequencyX = (freq: number, sampleRate: number) =>
  Math.log(freq / MIN_FREQ) / Math.log(lastFreq(sampleRate) / MIN_FREQ);

// log-spaced grid up to nyquist
const grids = new Map<number, Point[]>();
const getGrid = (sampleRate: number) => {
  let grid = grids.get(sampleRate);
  if (!grid) {
    const maxFreq = lastFreq(sampleRate);
    grid = Array.from({ length: POINTS }, (_, i) =>
      point(MIN_FREQ * Math.pow(maxFreq / MIN_FREQ, i / (POINTS - 1)), sampleRate, i / (POINTS - 1))
    );
    grids.set(sampleRate, grid);
  }
  return grid;
};

// the chart reads the coefficients instead of BiquadFilterNode.getFrequencyResponse(): that reads the
// params' computed values, which change only when the audio thread renders, so the chart would lag (or
// freeze while the context is suspended, e.g. before the first user gesture) after setValueAtTime
const biquadCoefficients = (
  type: BiquadFilterType,
  { cutoff, resonance, gain }: FilterProps,
  sampleRate: number
): Coefficients => biquad.coefficients(type, { frequency: cutoff, Q: resonance, gain }, sampleRate);

const magnitudeDb = (coefficients: Coefficients, { cos1, sin1, cos2, sin2 }: Point) =>
  biquad.magnitudeDbAt(coefficients, cos1, sin1, cos2, sin2);

const clampDb = (db: number) => (Number.isNaN(db) ? -DB_RANGE : Math.min(DB_RANGE, Math.max(-DB_RANGE, db)));

// the response of a type at its knobs (dB at a point): a model type its sections as the core runs them (its Res, Var
// and Drive in %), the others their biquad. Drive: the level of a sine of full scale through its curve (as a loud
// sound comes out of it) and, while it is over 0, the average of two samples of its antialiasing, (1 + cos θ) / 2 of
// |H|²
const responseOf = (type: string, props: FilterProps, sampleRate: number): ((p: Point) => number) => {
  if (filterModel.isModelFilterType(type)) {
    const design = filterModel.modelDesign(
      type,
      { cutoff: props.cutoff, resonance: props.resonance / 100, variation: (props.variation ?? 0) / 100 },
      sampleRate
    );
    const drive = filterModel.driveGain2((props.drive ?? 0) / 100);
    return (p) => 10 * Math.log10(filterModel.designGain2At(design, p.cos1, p.sin1) * drive(p.cos1));
  }
  const coefficients = biquadCoefficients(type as BiquadFilterType, props, sampleRate);
  return (p) => magnitudeDb(coefficients, p);
};

export const frequencyResponseDb = (type: string, props: FilterProps, freq: number, sampleRate: number) =>
  clampDb(responseOf(type, props, sampleRate)(point(freq, sampleRate)));

// the points of the chart: the grid and the exact cutoff, their frequencies, their x (a share of the width: the
// grid spans it, also when it ends below MAX_FREQ, nyquist at low sample rates) and the response at each (dB)
export interface ResponseBuffers {
  freqs: Float64Array;
  xs: Float64Array;
  dbs: Float64Array;
}

export const responseBuffers = (): ResponseBuffers => ({
  freqs: new Float64Array(POINTS + 1),
  xs: new Float64Array(POINTS + 1),
  dbs: new Float64Array(POINTS + 1),
});

// the response over the grid into the buffers (no array per point: the chart is drawn every frame while its knobs
// are modulated), the exact cutoff point in its place keeps narrow peaks and notches visible; the number of points
export const responseInto = (
  type: string,
  props: FilterProps,
  sampleRate: number,
  { freqs, xs, dbs }: ResponseBuffers
) => {
  const response = responseOf(type, props, sampleRate);
  const grid = getGrid(sampleRate);
  const last = grid[grid.length - 1].freq;
  const { cutoff } = props;
  let exact =
    cutoff > MIN_FREQ && cutoff < last ? point(cutoff, sampleRate, frequencyX(cutoff, sampleRate)) : null;
  let count = 0;
  for (let i = 0; i < grid.length; i++) {
    let p = grid[i];
    // the exact cutoff before the first point above it, that point next
    if (exact && p.freq > cutoff) {
      p = exact;
      exact = null;
      i--;
    }
    freqs[count] = p.freq;
    xs[count] = p.x;
    dbs[count++] = clampDb(response(p));
  }
  return count;
};
