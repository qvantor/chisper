import { EQ_PASS, EQ_PEAK, EQ_SHELF, eqDesign, eqGainDb, eqQ } from '@chisper/math/eq';
import {
  bandCurve,
  bandDesign,
  bandPoint,
  bandUpDown,
  curvePoints,
  DB_TOP,
  dbY,
  freqX,
  POINTS,
  Size,
  xFreq,
  yDb,
} from './eq-screen-geometry';

const SIZE: Size = [240, 80];
const RATE = 48000;

describe('the screen of the EQ', () => {
  it('the frequency across on octaves, 20 Hz to 20 kHz inside its edges; the gain up, ±27 dB', () => {
    expect(freqX(20, SIZE)).toBeCloseTo(6, 9);
    expect(freqX(20000, SIZE)).toBeCloseTo(234, 9);
    // (an octave is an octave anywhere)
    expect(freqX(200, SIZE) - freqX(100, SIZE)).toBeCloseTo(freqX(8000, SIZE) - freqX(4000, SIZE), 9);
    expect(freqX(5, SIZE)).toBe(freqX(20, SIZE));
    [20, 99.5, 1000, 15000, 20000].forEach((hz) => expect(xFreq(freqX(hz, SIZE), SIZE)).toBeCloseTo(hz, 6));
    expect(xFreq(-50, SIZE)).toBe(20);
    expect(xFreq(500, SIZE)).toBe(20000);
    expect(dbY(DB_TOP, SIZE)).toBeCloseTo(6, 9);
    expect(dbY(0, SIZE)).toBeCloseTo(40, 9);
    expect(dbY(-DB_TOP, SIZE)).toBeCloseTo(74, 9);
    expect(dbY(-60, SIZE)).toBe(dbY(-DB_TOP, SIZE));
    [-24, -3.5, 0, 12].forEach((db) => expect(yDb(dbY(db, SIZE), SIZE)).toBeCloseTo(db, 9));
  });

  it('the curve of a band is the response of the core: its design at the points, octaves apart', () => {
    const { hz } = curvePoints(RATE);
    expect(hz).toHaveLength(POINTS);
    expect(hz[0]).toBeCloseTo(20, 9);
    expect(hz[POINTS - 1]).toBeCloseTo(20000, 6);
    // (the same points of a rate, made once)
    expect(curvePoints(RATE)).toBe(curvePoints(RATE));
    const knobs = { type: EQ_PEAK, freq: 900, reso: 70, gain: -9 };
    const design = bandDesign(1, knobs, RATE);
    expect(design).toEqual(eqDesign(1, EQ_PEAK, 900, 70, -9, RATE));
    const curve = bandCurve(design, RATE, new Float64Array(POINTS));
    [0, 50, 100, 191].forEach((i) => expect(curve[i]).toBeCloseTo(eqGainDb([design], hz[i], RATE), 9));
    // (a value of the type param between two: the type the core takes)
    expect(bandDesign(0, { ...knobs, type: 1.6 }, RATE)).toEqual(eqDesign(0, EQ_PASS, 900, 70, -9, RATE));
  });

  it('under 40 kHz the points over nyquist are at nyquist: the curve does not turn back', () => {
    const rate = 32000;
    const { hz, cos, sin } = curvePoints(rate);
    const over = [...hz.keys()].filter((i) => hz[i] > rate / 2);
    expect(over.length).toBeGreaterThan(5);
    over.forEach((i) => {
      expect(cos[i]).toBe(-1);
      expect(sin[i]).toBe(Math.sin(Math.PI));
    });
    // a lowpass of band 2 falls on to nyquist and stays there
    const curve = bandCurve(
      bandDesign(1, { type: EQ_PASS, freq: 5000, reso: 30, gain: 0 }, rate),
      rate,
      new Float64Array(POINTS)
    );
    const from = hz.findIndex((f) => f > 6000);
    for (let i = from + 1; i < POINTS; i++) expect(curve[i]).toBeLessThanOrEqual(curve[i - 1]);
    expect(curve[POINTS - 1]).toBeLessThan(-100);
    // (at 48 kHz every point is under nyquist, as before)
    expect(curvePoints(RATE).cos[POINTS - 1]).toBeCloseTo(Math.cos((2 * Math.PI * 20000) / RATE), 12);
  });

  it('the point of a shelf or a peak at its frequency and gain, of a pass at its Q there: a drag moves those', () => {
    expect(bandPoint({ type: EQ_SHELF, freq: 210, reso: 60, gain: 6 }, SIZE)).toEqual([
      freqX(210, SIZE),
      dbY(6, SIZE),
    ]);
    const [, y] = bandPoint({ type: EQ_PASS, freq: 3000, reso: 50, gain: 12 }, SIZE);
    expect(y).toBeCloseTo(dbY(20 * Math.log10(eqQ(50)), SIZE), 9);
    // up and down: the gain of a shelf or a peak, the resonance of a pass (its Q where the pointer is)
    expect(bandUpDown(EQ_PEAK, dbY(-7.5, SIZE), SIZE)).toBeCloseTo(-7.5, 9);
    expect(bandUpDown(EQ_PASS, dbY(20 * Math.log10(eqQ(80)), SIZE), SIZE)).toBeCloseTo(80, 6);
    expect(bandUpDown(EQ_PASS, 0, SIZE)).toBe(100);
    expect(bandUpDown(EQ_PASS, 80, SIZE)).toBe(0);
  });
});
