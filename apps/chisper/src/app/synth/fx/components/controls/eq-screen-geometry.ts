import { number } from '@chisper/math';
import { EQ_PASS, EqDesign, eqDesign, eqGain2At, eqQ, eqResoOfQ, eqTypeOf } from '@chisper/math/eq';
import type { EqBandKeys } from '../../effects/eq-params';

// The layout of the screen of the EQ (eq-screen.tsx): the frequency across (log, 20 Hz..20 kHz), the gain up
// (dB, linear), the response of each band at the points of the curve (the design of the core: what it plays), where
// the point of a band is and what dragging it sets

// css px: [width, height]
export type Size = readonly [number, number];

// the frequencies at the edges of the screen (the knobs stop at 21.53 Hz and 20 kHz)
const LEFT_HZ = 20;
const RIGHT_HZ = 20000;

// the dB at the top of the screen (the bottom is under it as far): a gain of ±24 dB and the bumps of a shelf or a
// pass of a high resonance over it
export const DB_TOP = 27;
// px from the left and the right edge to 20 Hz and 20 kHz, from the top and the bottom to ±DB_TOP
const PAD_X = 6;
const PAD_Y = 6;
// the frequencies with a line across the screen, the labelled ones, the dB with a line
export const FREQ_LINES = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
export const FREQ_LABELS: [number, string][] = [
  [100, '100'],
  [1000, '1k'],
  [10000, '10k'],
];
export const DB_LINES = [-12, 0, 12];
// the points of a curve across the screen
export const POINTS = 192;

const OCTAVES = Math.log2(RIGHT_HZ / LEFT_HZ);

export const freqX = (hz: number, [width]: Size) =>
  PAD_X + ((width - 2 * PAD_X) * Math.log2(number.thresholds(hz, LEFT_HZ, RIGHT_HZ) / LEFT_HZ)) / OCTAVES;
export const xFreq = (px: number, [width]: Size) =>
  number.thresholds(LEFT_HZ * 2 ** ((OCTAVES * (px - PAD_X)) / (width - 2 * PAD_X)), LEFT_HZ, RIGHT_HZ);
export const dbY = (db: number, [, height]: Size) =>
  PAD_Y + ((height - 2 * PAD_Y) * (DB_TOP - number.thresholds(db, -DB_TOP, DB_TOP))) / (2 * DB_TOP);
export const yDb = (px: number, [, height]: Size) =>
  DB_TOP - (2 * DB_TOP * (px - PAD_Y)) / (height - 2 * PAD_Y);

// the frequencies of the points of a curve and the cos and sin of each at a rate (the z of the response; over nyquist,
// under 40 kHz, the response at nyquist: there is nothing over it, its z would turn back): made once a rate
const cache = new Map<number, { hz: Float64Array; cos: Float64Array; sin: Float64Array }>();
export const curvePoints = (sampleRate: number) => {
  let points = cache.get(sampleRate);
  if (!points) {
    const hz = Float64Array.from({ length: POINTS }, (_, i) => LEFT_HZ * 2 ** ((OCTAVES * i) / (POINTS - 1)));
    const theta = hz.map((f) => Math.min(Math.PI, (2 * Math.PI * f) / sampleRate));
    points = { hz, cos: theta.map(Math.cos), sin: theta.map(Math.sin) };
    cache.set(sampleRate, points);
  }
  return points;
};

// the knobs of a band as the screen draws it
export interface BandKnobs {
  type: number;
  freq: number;
  reso: number;
  gain: number;
}
export const bandKnobs = (
  params: Record<string, number>,
  { type, freq, reso, gain }: EqBandKeys
): BandKnobs => ({
  type: params[type],
  freq: params[freq],
  reso: params[reso],
  gain: params[gain],
});

export const bandDesign = (
  band: number,
  { type, freq, reso, gain }: BandKnobs,
  sampleRate: number
): EqDesign => eqDesign(band, eqTypeOf(type), freq, reso, gain, sampleRate);

// the gain (dB) of a band at each point of the curve, into `out`
export const bandCurve = (design: EqDesign, sampleRate: number, out: Float64Array) => {
  const { cos, sin } = curvePoints(sampleRate);
  for (let i = 0; i < POINTS; i++) out[i] = 10 * Math.log10(eqGain2At(design, cos[i], sin[i]));
  return out;
};

// where the point of a band is: at its frequency, the gain of a shelf or a peak, the gain a pass has there (its Q:
// a drag up and down moves its resonance)
export const bandPoint = (knobs: BandKnobs, size: Size): [number, number] => {
  const db = eqTypeOf(knobs.type) === EQ_PASS ? 20 * Math.log10(eqQ(knobs.reso)) : knobs.gain;
  return [freqX(knobs.freq, size), dbY(db, size)];
};

// the value of the up and down of a band at a place on the screen: the gain of a shelf or a peak, the resonance of
// a pass
export const bandUpDown = (type: number, px: number, size: Size) =>
  eqTypeOf(type) === EQ_PASS ? eqResoOfQ(10 ** (yDb(px, size) / 20)) : yDb(px, size);
