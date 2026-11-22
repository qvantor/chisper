import { warp } from '@chisper/math';
import { warpGlyphPoints } from './warp-mode-icons';

// the glyph square: x 6..22 left to right, y 18..2 bottom to top
const ys = (mode: number, knob: number) => warpGlyphPoints(mode, knob).map(([, y]) => y);

describe('the glyphs of the Warp modes', () => {
  it('draws Off as the diagonal from the bottom left to the top right', () => {
    const points = warpGlyphPoints(warp.WARP_OFF, 0);
    expect(points[0]).toEqual([6, 18]);
    expect(points.at(-1)).toEqual([22, 2]);
    points.forEach(([x, y]) => expect(x + y).toBeCloseTo(24, 5));
  });

  it('bends Bend + and Bend - from corner to corner, on either side of the diagonal', () => {
    for (const mode of [warp.WARP_BEND_UP, warp.WARP_BEND_DOWN]) {
      const points = warpGlyphPoints(mode, 0.7);
      expect(points[0]).toEqual([6, 18]);
      expect(points.at(-1)).toEqual([22, 2]);
    }
    // a quarter of the cycle in (the diagonal at y 14): Bend + lingers at the start of the frame (lower), Bend - is
    // past its quarter (higher)
    const quarter = 16;
    expect(ys(warp.WARP_BEND_UP, 0.7)[quarter]).toBeGreaterThan(14);
    expect(ys(warp.WARP_BEND_DOWN, 0.7)[quarter]).toBeLessThan(14);
  });

  it('draws Bend +/- at its two ends as Bend + and Bend -', () => {
    expect(ys(warp.WARP_BEND_BOTH, 0.1)[16]).toBeGreaterThan(14);
    expect(ys(warp.WARP_BEND_BOTH, 0.9)[16]).toBeLessThan(14);
  });

  it('draws PWM as a ramp up to the top, straight down at its edge and held at the bottom', () => {
    const points = warpGlyphPoints(warp.WARP_PWM, 0.375);
    // the edge at 40 of 64: x 16 · 0.625 + 6 = 16
    const edge = points.findIndex(([x, y]) => x === 16 && y === 2);
    expect(edge).toBeGreaterThan(0);
    expect(points[edge + 1]).toEqual([16, 18]);
    points.slice(edge + 1).forEach(([, y]) => expect(y).toBe(18));
    points.slice(0, edge).forEach(([x, y], i, ramp) => i > 0 && expect(y).toBeLessThan(ramp[i - 1][1]));
  });
});
