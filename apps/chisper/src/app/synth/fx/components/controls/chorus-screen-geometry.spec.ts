import { depthMs, MAX_TAP_MS, tapDelayParam } from '../../effects/chorus-params';
import {
  AXIS,
  channelY,
  cutoffGlow,
  laneY,
  msX,
  plotBottom,
  Size,
  tapBars,
  tapEchoes,
  xDepth,
  xMs,
} from './chorus-screen-geometry';

const SIZE: Size = [240, 80];
// the plot: 16 px left of it, 8 right
const [LEFT, RIGHT] = [16, 232];

describe('chorus screen geometry', () => {
  it('the delay of a tap across the plot: 0 at its left, the longest a tap gets at its right, held to them', () => {
    expect(MAX_TAP_MS).toBe(82.5);
    expect(msX(0, SIZE)).toBe(LEFT);
    expect(msX(MAX_TAP_MS, SIZE)).toBe(RIGHT);
    expect(msX(MAX_TAP_MS / 2, SIZE)).toBe((LEFT + RIGHT) / 2);
    expect(msX(-5, SIZE)).toBe(LEFT);
    expect(msX(200, SIZE)).toBe(RIGHT);
    [0, 12.5, 82.5].forEach((ms) => expect(xMs(msX(ms, SIZE), SIZE)).toBeCloseTo(ms, 9));
    expect(xMs(0, SIZE)).toBe(0);
    expect(xMs(500, SIZE)).toBe(MAX_TAP_MS);
    // a screen with no plot yet
    expect(msX(40, [0, 80])).toBe(LEFT);
    expect(xMs(40, [0, 80])).toBe(0);
  });

  it('a lane for each tap over the ms: the taps of a channel together, the channels apart', () => {
    const lanes = [0, 1, 2, 3].map((tap) => laneY(tap, SIZE));
    expect(plotBottom(SIZE)).toBe(80 - AXIS);
    expect([...lanes].sort((a, b) => a - b)).toEqual(lanes);
    expect(lanes[0]).toBe(8);
    expect(lanes[3]).toBeCloseTo(plotBottom(SIZE) - 8, 9);
    const step = lanes[1] - lanes[0];
    expect(lanes[3] - lanes[2]).toBeCloseTo(step, 9);
    expect(lanes[2] - lanes[1]).toBeCloseTo(1.3 * step, 9);
    expect(channelY(0, SIZE)).toBeCloseTo((lanes[0] + lanes[1]) / 2, 9);
    expect(channelY(1, SIZE)).toBeCloseTo((lanes[2] + lanes[3]) / 2, 9);
  });

  it('the bar of a tap: from its delay (Delay 2 the first of a channel, Delay 1 the second) by the depth', () => {
    expect([0, 1, 2, 3].map(tapDelayParam)).toEqual(['d2', 'd1', 'd2', 'd1']);
    const bars = tapBars({ d1: 12, d2: 3, depth: 13 }, SIZE);
    expect(bars.map(({ from }) => from)).toEqual([3, 12, 3, 12].map((ms) => msX(ms, SIZE)));
    expect(bars.map(({ to }) => to)).toEqual([3, 12, 3, 12].map((ms) => msX(ms + depthMs(13), SIZE)));
    expect(bars.map(({ y }) => y)).toEqual([0, 1, 2, 3].map((tap) => laneY(tap, SIZE)));
    // no depth: a bar of no length
    tapBars({ d1: 5, d2: 0, depth: 0 }, SIZE).forEach(({ from, to }) => expect(to).toBe(from));
  });

  it('the depth of the end of a bar where it is dragged to, from the delay of its tap', () => {
    const [, second] = tapBars({ d1: 12, d2: 3, depth: 13 }, SIZE);
    expect(xDepth(second.to, 12, SIZE)).toBeCloseTo(13, 9);
    expect(xDepth(msX(12 + 62.5, SIZE), 12, SIZE)).toBeCloseTo(26, 9);
    // left of the start of the bar: under no depth (the knob stops at 0)
    expect(xDepth(msX(5, SIZE), 12, SIZE)).toBeLessThan(0);
  });

  it('the repeats of a tap: after each delay again, × the feedback each time, while they show', () => {
    // at 20, 30, 40 and 50 ms, the last with 0.0625 of the tap
    expect(tapEchoes(10, 0.5)).toBe(4);
    // never more than four
    expect(tapEchoes(10, 0.9)).toBe(4);
    // no room past the right of the plot
    expect(tapEchoes(30, 0.9)).toBe(1);
    expect(tapEchoes(50, 0.9)).toBe(0);
    // too faint to show, none without a feedback
    expect(tapEchoes(10, 0.1)).toBe(1);
    expect(tapEchoes(10, 0)).toBe(0);
    // a tap with no delay: they would all be on it
    expect(tapEchoes(0.2, 0.9)).toBe(0);
  });

  describe('the glow of the filter', () => {
    const alpha = (color: string) => Number(/, ([\d.]+)\)$/.exec(color)?.[1]);
    const hue = (color: string) => Number(/^hsla\((\d+),/.exec(color)?.[1]);

    it('a low pass: light from the middle of the screen, wider and brighter as it opens, violet to cyan', () => {
      const [closed, middle, open] = [20, 632.5, 20000].map((cut) => cutoffGlow(cut, false, SIZE));
      [closed, middle, open].forEach(({ x, y, inner, to }) => {
        expect([x, y, inner]).toEqual([120, 40, 0]);
        expect(alpha(to)).toBe(0);
      });
      expect(closed.outer).toBeCloseTo(240 * 0.22, 9);
      expect(open.outer).toBeCloseTo(240 * 0.67, 9);
      expect(middle.outer).toBeCloseTo((closed.outer + open.outer) / 2, 2);
      expect([closed, middle, open].map(({ from }) => hue(from))).toEqual([270, 225, 180]);
      expect([closed, middle, open].map(({ from }) => alpha(from))).toEqual([0.2, 0.35, 0.5]);
      // held to the range of the knob
      expect(cutoffGlow(1, false, SIZE)).toEqual(closed);
      expect(cutoffGlow(90000, false, SIZE)).toEqual(open);
    });

    it('a high pass: the middle dark, the more the higher it cuts, the light at the edges, fainter then', () => {
      const [closed, open] = [20, 20000].map((cut) => cutoffGlow(cut, true, SIZE));
      expect(alpha(closed.from)).toBe(0);
      expect(alpha(open.from)).toBe(0);
      expect(closed.inner).toBeCloseTo(240 * 0.04, 9);
      expect(open.inner).toBeCloseTo(240 * 0.4, 9);
      expect(closed.outer).toBe(open.outer);
      expect(open.outer).toBeGreaterThan(open.inner);
      expect([alpha(closed.to), alpha(open.to)]).toEqual([0.5, 0.2]);
      expect([hue(closed.to), hue(open.to)]).toEqual([270, 180]);
    });
  });
});
