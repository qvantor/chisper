import { number, Vector2D } from '@chisper/math';
import { FX_PARAMS } from '@chisper/preset-schema';
import { thresholdDb } from '../../effects/compressor-params';
import type { FxMeterValues } from '../../effects/types';

// The screen of the compressor in css px, [width, height] (the level of the output is at the master knob).
// One band: the curve of the output over the input (dB), a dot on it where the signal is, the reduction as a bar
// along the top. Three bands: a row each, the high one at the top, between the crossovers up the frequencies; in
// each the line of its gain and the bar of what the compressor does to it, both from 0 dB in the middle
export type Size = readonly [number, number];
// a bar on it
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// the gains shown, dB each way of the line of 0: the range of the gain of a band (its point is on the same axis),
// a reduction or a boost past it stops at the end
export const METER_RANGE = FX_PARAMS.compressor.low.max;
// the levels shown: from -60 dB to full scale (both axes of the curve)
export const LEVEL_FLOOR = -60;
// the frequencies of the bands, log
export const FREQ_RANGE: readonly [number, number] = [20, 20000];
const REDUCTION_HEIGHT = 6;
const GAP = 4;
// px over and under the plot: a line or a point at an end of its range shows whole
export const PLOT_PAD = 5;
// px between the bar of a band and its crossovers
const BAND_INSET = 2;
// the curve starts this far under the top: the bar of the reduction is over it
const CURVE_TOP = REDUCTION_HEIGHT + GAP;

const levelDb = (level: number) => (level > 0 ? 20 * Math.log10(level) : LEVEL_FLOOR);
const share = (value: number, from: number, to: number) =>
  number.thresholds((value - from) / (to - from), 0, 1);

// --- one band

export const levelX = (db: number, [width]: Size) => share(db, LEVEL_FLOOR, 0) * width;
export const levelY = (db: number, [, height]: Size) =>
  height - PLOT_PAD - share(db, LEVEL_FLOOR, 0) * (height - PLOT_PAD - CURVE_TOP);

// the level out of the one band circuit for a level in (dB), settled: over the threshold of the knob the ratio
export const transferOutput = (input: number, thresh: number, ratio: number) => {
  const threshold = thresholdDb(thresh);
  return input <= threshold ? input : threshold + (input - threshold) / Math.max(ratio, 1);
};

// the line of the dry signal: the output is the input
export const unityLine = (size: Size): Vector2D[] => [
  [levelX(LEVEL_FLOOR, size), levelY(LEVEL_FLOOR, size)],
  [levelX(0, size), levelY(0, size)],
];

// the curve: the dry line up to the threshold (its knee, when it is on the plot), flatter over it
export const transferCurve = (thresh: number, ratio: number, size: Size): Vector2D[] => {
  const threshold = thresholdDb(thresh);
  const inputs = [LEVEL_FLOOR, ...(threshold > LEVEL_FLOOR && threshold < 0 ? [threshold] : []), 0];
  return inputs.map((input) => [levelX(input, size), levelY(transferOutput(input, thresh, ratio), size)]);
};

// what moves in one band: the reduction along the top from the right (it grows to the left, as the reduction of
// a band does), the dot where the signal is (its level in, its level out as the gain is now: it lags the curve by
// the attack and the release), none in silence. The bar stops at the end of its range, the dot goes on down the
// plot with the whole reduction
export const singleMarks = (
  values: FxMeterValues | null,
  size: Size
): { reduction: Rect; dot: Vector2D | null } => {
  const [width] = size;
  const depth = Math.max(-(values?.gains[0] ?? 0), 0);
  const reduction = Math.min(depth, METER_RANGE);
  const input = levelDb(values?.input ?? 0);
  const dot: Vector2D | null =
    input > LEVEL_FLOOR ? [levelX(input, size), levelY(Math.min(input, 0) - depth, size)] : null;
  return {
    reduction: {
      x: width * (1 - reduction / METER_RANGE),
      y: 0,
      width: (reduction / METER_RANGE) * width,
      height: REDUCTION_HEIGHT,
    },
    dot,
  };
};

// --- three bands

// the crossovers as the core takes them: the high one never under the low one
export const crossovers = (xlow: number, xhigh: number): [number, number] => {
  const [min, max] = FREQ_RANGE;
  const low = number.thresholds(xlow, min, max);
  return [low, number.thresholds(Math.max(xhigh, low), min, max)];
};

// a crossover as it is set here: the low one stops at the high one, the high one at the low one (a preset may
// have them crossed: the high one is then where the low one is)
export const heldCrossover = (param: 'xlow' | 'xhigh', value: number, xlow: number, xhigh: number) =>
  param === 'xlow' ? Math.min(value, Math.max(xhigh, xlow)) : Math.max(value, xlow);

const octaves = (hz: number) => Math.log2(hz / FREQ_RANGE[0]);
const SPAN = octaves(FREQ_RANGE[1]);

// the frequencies up the screen: 20 Hz at its bottom, 20 kHz at its top
export const freqY = (hz: number, [, height]: Size) =>
  height * (1 - number.thresholds(octaves(hz) / SPAN, 0, 1));
export const yFreq = (y: number, [, height]: Size) =>
  FREQ_RANGE[0] * 2 ** (number.thresholds(1 - y / height, 0, 1) * SPAN);

// the gains across it: 0 dB in the middle, a reduction left of it, a boost right
export const gainX = (db: number, [width]: Size) =>
  width / 2 + (number.thresholds(db, -METER_RANGE, METER_RANGE) / METER_RANGE) * (width / 2 - PLOT_PAD);
export const xGain = (x: number, [width]: Size) =>
  number.thresholds(((x - width / 2) / (width / 2 - PLOT_PAD)) * METER_RANGE, -METER_RANGE, METER_RANGE);

// the bands (low, mid, high) as rows, the low one at the bottom: from a crossover up to the next
export const bandZones = (xlow: number, xhigh: number, size: Size) => {
  const [low, high] = crossovers(xlow, xhigh);
  const edges = [size[1], freqY(low, size), freqY(high, size), 0];
  return [0, 1, 2].map((band) => ({
    bottom: edges[band],
    top: edges[band + 1],
    center: (edges[band] + edges[band + 1]) / 2,
  }));
};

// what moves in three bands: a bar in the row of each band from the line of 0 dB, to the left its reduction, to
// the right its boost
export const bandBars = (values: FxMeterValues | null, zones: ReturnType<typeof bandZones>, size: Size) => {
  const middle = gainX(0, size);
  return {
    middle,
    gains: zones.map(({ top, bottom }, band): Rect & { gain: number } => {
      const gain = number.thresholds(values?.gains[band] ?? 0, -METER_RANGE, METER_RANGE);
      const x = gainX(gain, size);
      return {
        x: Math.min(x, middle),
        y: top + BAND_INSET,
        width: Math.abs(x - middle),
        height: Math.max(bottom - top - 2 * BAND_INSET, 0),
        gain,
      };
    }),
  };
};
