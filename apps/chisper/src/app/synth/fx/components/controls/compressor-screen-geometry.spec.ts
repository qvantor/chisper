import { thresholdDb } from '../../effects/compressor-params';
import {
  bandBars,
  bandZones,
  crossovers,
  FREQ_RANGE,
  freqY,
  gainX,
  heldCrossover,
  LEVEL_FLOOR,
  levelX,
  levelY,
  METER_RANGE,
  PLOT_PAD,
  singleMarks,
  Size,
  transferCurve,
  transferOutput,
  unityLine,
  xGain,
  yFreq,
} from './compressor-screen-geometry';

const SIZE: Size = [200, 80];
const [WIDTH, HEIGHT] = SIZE;
const quiet = { gains: [0, 0, 0] as [number, number, number], input: 0 };

describe('the screen of the compressor', () => {
  describe('one band', () => {
    it('the output: the input up to the threshold, over it the ratio', () => {
      const threshold = thresholdDb(0.5);
      expect(transferOutput(threshold - 10, 0.5, 4)).toBe(threshold - 10);
      expect(transferOutput(threshold + 8, 0.5, 4)).toBeCloseTo(threshold + 2, 9);
      // a ratio under 1 is 1
      expect(transferOutput(threshold + 8, 0.5, 0)).toBeCloseTo(threshold + 8, 9);
    });

    it('the dry line goes from the bottom left of the screen to its right, under the bar of the reduction', () => {
      const [[left, bottom], [right, top]] = unityLine(SIZE);
      expect([left, bottom, right]).toEqual([0, HEIGHT - PLOT_PAD, WIDTH]);
      expect(top).toBeGreaterThan(singleMarks(null, SIZE).reduction.height);
    });

    it('the curve: on the dry line up to its knee at the threshold, flatter by the ratio over it', () => {
      const curve = transferCurve(0.5, 4, SIZE);
      const threshold = thresholdDb(0.5);
      expect(curve).toHaveLength(3);
      const [start, knee, end] = curve;
      expect(start).toEqual(unityLine(SIZE)[0]);
      expect(knee[0]).toBeCloseTo(levelX(threshold, SIZE), 9);
      expect(knee[1]).toBeCloseTo(levelY(threshold, SIZE), 9);
      expect(end[0]).toBe(WIDTH);
      expect(end[1]).toBeCloseTo(levelY(threshold - threshold / 4, SIZE), 9);
      // the slope over the knee is a quarter of the one under it
      const slope = (from: number[], to: number[]) => (to[1] - from[1]) / (to[0] - from[0]);
      expect(slope(knee, end)).toBeCloseTo(slope(start, knee) / 4, 9);
    });

    it('a threshold off the plot has no knee: the dry line at the knob 0, all of it flat at the knob 1', () => {
      expect(transferCurve(0, 4, SIZE)).toEqual(unityLine(SIZE));
      const low = transferCurve(1, 30, SIZE);
      expect(low).toHaveLength(2);
      // under the floor of the plot: held on its bottom
      low.forEach(([, y]) => expect(y).toBe(HEIGHT - PLOT_PAD));
      // every point is on the screen at any knob
      [0, 0.2, 0.5, 0.9, 1].forEach((thresh) =>
        [1, 4, 30].forEach((ratio) =>
          transferCurve(thresh, ratio, SIZE).forEach(([x, y]) => {
            expect(x).toBeGreaterThanOrEqual(0);
            expect(x).toBeLessThanOrEqual(WIDTH);
            expect(y).toBeGreaterThanOrEqual(PLOT_PAD);
            expect(y).toBeLessThanOrEqual(HEIGHT - PLOT_PAD);
          })
        )
      );
    });

    it('what moves: the reduction along the top from the right, held to its range; the dot at the level in and out', () => {
      const marks = singleMarks({ gains: [-12, -12, -12], input: 0.5 }, SIZE);
      expect(marks.reduction.y).toBe(0);
      expect(marks.reduction.width).toBeCloseTo((12 / METER_RANGE) * WIDTH, 9);
      expect(marks.reduction.x + marks.reduction.width).toBeCloseTo(WIDTH, 9);
      const input = 20 * Math.log10(0.5);
      expect(marks.dot?.[0]).toBeCloseTo(levelX(input, SIZE), 9);
      expect(marks.dot?.[1]).toBeCloseTo(levelY(input - 12, SIZE), 9);
      expect(singleMarks({ gains: [-100, 0, 0], input: 1 }, SIZE).reduction).toMatchObject({
        x: 0,
        width: WIDTH,
      });
      // a boost is not of one band
      expect(singleMarks({ gains: [6, 0, 0], input: 1 }, SIZE).reduction.width).toBe(0);
    });

    it('the dot goes down with the whole reduction, past the range of its bar, to the floor of the plot', () => {
      const deep = singleMarks({ gains: [-50, -50, -50], input: 1 }, SIZE);
      expect(deep.reduction).toMatchObject({ x: 0, width: WIDTH });
      expect(deep.dot?.[1]).toBeCloseTo(levelY(-50, SIZE), 9);
      expect(deep.dot?.[1]).toBeGreaterThan(levelY(-METER_RANGE, SIZE));
      expect(singleMarks({ gains: [-100, 0, 0], input: 1 }, SIZE).dot?.[1]).toBe(levelY(LEVEL_FLOOR, SIZE));
      // a boost doesn't lift it
      expect(singleMarks({ gains: [6, 0, 0], input: 0.5 }, SIZE).dot?.[1]).toBeCloseTo(
        levelY(20 * Math.log10(0.5), SIZE),
        9
      );
    });

    it('silence has no dot and no reduction', () => {
      expect(singleMarks(null, SIZE)).toMatchObject({
        dot: null,
        reduction: { width: 0 },
      });
      expect(singleMarks(quiet, SIZE).dot).toBeNull();
    });
  });

  describe('three bands', () => {
    it('the frequencies: log from 20 Hz at the bottom of the screen to 20 kHz at its top, and back', () => {
      expect(freqY(FREQ_RANGE[0], SIZE)).toBe(HEIGHT);
      expect(freqY(FREQ_RANGE[1], SIZE)).toBeCloseTo(0, 9);
      expect(freqY(1, SIZE)).toBe(HEIGHT);
      // an octave is as high everywhere
      expect(freqY(100, SIZE) - freqY(200, SIZE)).toBeCloseTo(freqY(4000, SIZE) - freqY(8000, SIZE), 9);
      [20, 131, 2500, 16000].forEach((hz) => expect(yFreq(freqY(hz, SIZE), SIZE)).toBeCloseTo(hz, 6));
      expect(yFreq(HEIGHT + 50, SIZE)).toBe(FREQ_RANGE[0]);
      expect(yFreq(-50, SIZE)).toBeCloseTo(FREQ_RANGE[1], 6);
    });

    it('the gains: 0 dB in the middle, a boost right of it, the ends of the range a pad from the edges, and back', () => {
      expect(gainX(0, SIZE)).toBe(WIDTH / 2);
      expect(gainX(METER_RANGE, SIZE)).toBe(WIDTH - PLOT_PAD);
      expect(gainX(-METER_RANGE, SIZE)).toBe(PLOT_PAD);
      expect(gainX(100, SIZE)).toBe(WIDTH - PLOT_PAD);
      [-24, -6.5, 0, 12, 24].forEach((db) => expect(xGain(gainX(db, SIZE), SIZE)).toBeCloseTo(db, 9));
      expect(xGain(WIDTH + 20, SIZE)).toBe(METER_RANGE);
      expect(xGain(-20, SIZE)).toBe(-METER_RANGE);
    });

    it('the crossovers as the core takes them: the high one never under the low one', () => {
      expect(crossovers(131, 2500)).toEqual([131, 2500]);
      expect(crossovers(3000, 300)).toEqual([3000, 3000]);
      expect(crossovers(5, 30000)).toEqual([...FREQ_RANGE]);
    });

    it('a crossover set stops at the other one; of crossed ones the high one is where the low one is', () => {
      expect(heldCrossover('xlow', 500, 131, 2500)).toBe(500);
      expect(heldCrossover('xlow', 4000, 131, 2500)).toBe(2500);
      expect(heldCrossover('xhigh', 1000, 131, 2500)).toBe(1000);
      expect(heldCrossover('xhigh', 100, 131, 2500)).toBe(131);
      // crossed: the low one goes down, not up; the high one up from it
      expect(heldCrossover('xlow', 3500, 3000, 300)).toBe(3000);
      expect(heldCrossover('xlow', 200, 3000, 300)).toBe(200);
      expect(heldCrossover('xhigh', 300, 3000, 300)).toBe(3000);
      expect(heldCrossover('xhigh', 5000, 3000, 300)).toBe(5000);
    });

    it('the bands: rows from the bottom of the screen up to a crossover, to the next, to the top', () => {
      const [low, mid, high] = bandZones(131, 2500, SIZE);
      expect(low.bottom).toBe(HEIGHT);
      expect(low.top).toBeCloseTo(freqY(131, SIZE), 9);
      expect(mid.bottom).toBe(low.top);
      expect(mid.top).toBeCloseTo(freqY(2500, SIZE), 9);
      expect(high.bottom).toBe(mid.top);
      expect(high.top).toBe(0);
      expect(mid.center).toBeCloseTo((mid.top + mid.bottom) / 2, 9);
      // a high crossover under the low one: no mid band
      const [, none] = bandZones(3000, 300, SIZE);
      expect(none.top).toBe(none.bottom);
    });

    it('the bars: a reduction left of the line of 0 dB, a boost right of it, held to the range, inside their rows', () => {
      const bars = bandBars({ gains: [-6, 12, -100], input: 1 }, bandZones(131, 2500, SIZE), SIZE);
      const zones = bandZones(131, 2500, SIZE);
      const [low, mid, high] = bars.gains;
      const reach = WIDTH / 2 - PLOT_PAD;
      expect(bars.middle).toBe(WIDTH / 2);
      expect(low.x + low.width).toBeCloseTo(WIDTH / 2, 9);
      expect(low.width).toBeCloseTo(reach / 4, 9);
      expect(mid.x).toBe(WIDTH / 2);
      expect(mid.width).toBeCloseTo(reach / 2, 9);
      expect(high.x).toBeCloseTo(PLOT_PAD, 9);
      expect(high.width).toBeCloseTo(reach, 9);
      bars.gains.forEach((bar, band) => {
        expect(bar.y).toBeGreaterThan(zones[band].top);
        expect(bar.y + bar.height).toBeLessThan(zones[band].bottom);
      });
      bandBars(null, bandZones(131, 2500, SIZE), SIZE).gains.forEach((bar) => expect(bar.width).toBe(0));
      // a band of no height has a bar of none
      expect(bandBars(null, bandZones(3000, 300, SIZE), SIZE).gains[1].height).toBe(0);
    });
  });
});
