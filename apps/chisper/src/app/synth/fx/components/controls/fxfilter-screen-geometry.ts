import { filterModel, number } from '@chisper/math';
import { fxFilterTypeOf } from '../../effects/fxfilter-params';
import { levelGain } from '../../effects/level';
import { curvePoints, POINTS, Size } from './eq-screen-geometry';

// The layout of the screen of the FX Filter (fxfilter-screen.tsx): the frequency across as the EQ's (log, 20 Hz..20
// kHz: freqX, xFreq of eq-screen-geometry), the gain up (dB, linear, more room under 0 dB than over it: a filter
// cuts), the response of the filter at the points of the curve (the design of the core with its droop: what it
// plays, the small signal; Drive as a sine of full scale comes out of it, as the chart of a voice draws it: driveGain2;
// the level), where its grip is and what dragging it sets: the cutoff across, the resonance up and down

// the dB at the top and the bottom of the screen: a resonance of 100 % peaks some 20 dB over 0
const DB_TOP = 24;
const DB_BOTTOM = -48;
// px from the top and the bottom to DB_TOP and DB_BOTTOM, to the ends of the travel of the resonance
const PAD_Y = 6;
// the dB with a line
export const DB_LINES = [-24, 0];

export const dbY = (db: number, [, height]: Size) =>
  PAD_Y + ((height - 2 * PAD_Y) * (DB_TOP - number.thresholds(db, DB_BOTTOM, DB_TOP))) / (DB_TOP - DB_BOTTOM);

// the resonance (%) up the screen: 0 at the bottom, 100 at the top
export const resY = (res: number, [, height]: Size) =>
  PAD_Y + (height - 2 * PAD_Y) * (1 - number.thresholds(res, 0, 100) / 100);
export const yRes = (px: number, [, height]: Size) =>
  number.thresholds(100 * (1 - (px - PAD_Y) / (height - 2 * PAD_Y)), 0, 100);

// the knobs of the filter as the screen draws them (those the routes move: its values; the cutoff of each channel
// apart)
export interface FilterKnobs {
  type: number;
  res: number;
  drive: number;
  fat: number;
  level: number;
}

// the gain (dB) of the filter at each point of the curve at a cutoff (of a channel: Pan moves it), into `out`
export const filterCurve = (
  { type, res, drive, fat, level }: FilterKnobs,
  cutoff: number,
  sampleRate: number,
  out: Float64Array
) => {
  const design = filterModel.fxFilterDesign(
    fxFilterTypeOf(type),
    { cutoff, resonance: res / 100, variation: fat / 100 },
    sampleRate
  );
  // (the level of the output: of the amplitude, its square of the power the response is)
  const drive2 = filterModel.driveGain2(drive / 100);
  const level2 = levelGain(level) ** 2;
  const { cos, sin } = curvePoints(sampleRate);
  for (let i = 0; i < POINTS; i++)
    out[i] = 10 * Math.log10(filterModel.designGain2At(design, cos[i], sin[i]) * drive2(cos[i]) * level2);
  return out;
};
