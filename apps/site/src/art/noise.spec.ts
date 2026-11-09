import { CHART, CHART_GRID, chartX, chartY, noiseChart, random } from './noise';

// a spectrum back in octaves from 1 kHz and dB
const levels = (xy: number[]) => {
  const perOctave = (CHART.right - CHART.left) / Math.log2(1000);
  const perDb = (CHART.bottom - CHART.top) / (2 * CHART.db);
  const octaves: number[] = [];
  const db: number[] = [];
  for (let i = 0; i < xy.length; i += 2) {
    octaves.push((xy[i] - chartX(1000)) / perOctave);
    db.push((chartY(0) - xy[i + 1]) / perDb);
  }
  return { octaves, db };
};

// the slope of the least squares line through the points, and its level at 0
const fit = (xs: number[], ys: number[]) => {
  const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;
  const [mx, my] = [mean(xs), mean(ys)];
  const slope =
    xs.reduce((sum, x, i) => sum + (x - mx) * (ys[i] - my), 0) /
    xs.reduce((sum, x) => sum + (x - mx) ** 2, 0);
  return { slope, at0: my - slope * mx };
};

describe('random', () => {
  it('gives the same numbers of 0..1 for the same seed, others for another', () => {
    const a = random(7);
    const b = random(7);
    const c = random(8);
    const first = Array.from({ length: 50 }, () => a());
    expect(Array.from({ length: 50 }, () => b())).toEqual(first);
    expect(Array.from({ length: 50 }, () => c())).not.toEqual(first);
    for (const value of first) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe('the chart of the colors of noise', () => {
  const lines = noiseChart();

  it('draws violet, blue, white, pink and brown, from the top of the treble down', () => {
    expect(lines.map((line) => line.name)).toEqual(['Violet', 'Blue', 'White', 'Pink', 'Brown']);
    const ends = lines.map((line) => line.end[1]);
    expect(ends).toEqual([...ends].sort((a, b) => a - b));
    // the names right of the ends stay apart
    for (let i = 1; i < ends.length; i++) expect(ends[i] - ends[i - 1]).toBeGreaterThan(30);
  });

  it.each([
    ['Violet', 6],
    ['Blue', 3],
    ['White', 0],
    ['Pink', -3],
    ['Brown', -6],
  ])('%s goes by %i dB an octave through 0 dB at 1 kHz, a little rough', (name, slope) => {
    const line = lines.find((l) => l.name === name);
    const { octaves, db } = levels(line?.xy ?? []);
    const trend = fit(octaves, db);
    expect(trend.slope).toBeCloseTo(slope, 0);
    expect(Math.abs(trend.at0)).toBeLessThan(1);
    const off = db.map((level, i) => level - slope * octaves[i]);
    expect(Math.max(...off.map(Math.abs))).toBeLessThanOrEqual(2.3);
    // rough, not a ruler
    expect(new Set(off.map((v) => v.toFixed(1))).size).toBeGreaterThan(20);
  });

  it('spans 20 Hz to 20 kHz inside its box, the same every time', () => {
    for (const { xy } of lines) {
      expect(xy[0]).toBeCloseTo(CHART.left, 0);
      expect(xy.at(-2)).toBeCloseTo(CHART.right, 0);
      for (let i = 0; i < xy.length; i += 2) {
        expect(xy[i + 1]).toBeGreaterThanOrEqual(CHART.top);
        expect(xy[i + 1]).toBeLessThanOrEqual(CHART.bottom);
      }
    }
    expect(noiseChart()).toEqual(lines);
  });

  it('has a grid of decades and of 12 dB, its frequencies under it', () => {
    expect(CHART_GRID.hz).toHaveLength(3);
    expect(CHART_GRID.db.map(({ db }) => db)).toEqual([-24, -12, 0, 12, 24]);
    expect(CHART_GRID.frequencies.map(({ label }) => label)).toEqual(['20 Hz', '1 kHz', '20 kHz']);
  });
});
