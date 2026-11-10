// The noise of the page: a random of a seed (the grain behind the section of the noise, art/scenes.ts, and the
// chart beside it) and the chart of the colors of noise, their spectra as an analyser shows them: white flat, pink
// −3 dB and brown −6 dB an octave, blue +3 and violet +6, all at 0 dB at 1 kHz, each a little rough as a measured
// spectrum is (rougher in the bass, where an analyser has fewer bins). Pure math: the build and the browser run the
// same.

// numbers of 0..1 from a seed (mulberry32): the same seed, the same numbers
export const random = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// the colors of noise, from the top of the treble down: their names as the synth's samples (the same in every
// language), their slopes in dB an octave
export const NOISE_COLORS = [
  { name: 'Violet', slope: 6, color: '#9b59b6' },
  { name: 'Blue', slope: 3, color: '#3498db' },
  { name: 'White', slope: 0, color: '#ecf0f1' },
  { name: 'Pink', slope: -3, color: '#f8a5c2' },
  { name: 'Brown', slope: -6, color: '#c58b5c' },
] as const;

// the box of the drawing (its viewBox), the chart in it (the names of the colors right of it, the frequencies under
// it, the levels left of it) and what it spans: 20 Hz to 20 kHz on a log scale, ±DB around 0 dB
export const CHART = { width: 600, height: 400, left: 58, right: 474, top: 24, bottom: 332, db: 38 };
const LOW = 20;
const HIGH = 20_000;
const REFERENCE = 1_000;
const SAMPLES = 96;
// how rough a spectrum is, in dB: at its low end, at its high end
const ROUGH = [2.2, 0.8] as const;

const middle = (CHART.top + CHART.bottom) / 2;
const round = (v: number) => Math.round(v * 10) / 10;

export const chartX = (hz: number) =>
  CHART.left + ((CHART.right - CHART.left) * Math.log(hz / LOW)) / Math.log(HIGH / LOW);
export const chartY = (db: number) => middle - (db * (CHART.bottom - CHART.top)) / (2 * CHART.db);

// the level of a color at a frequency, smooth: its slope over the octaves from 1 kHz
export const trend = (slope: number, hz: number) => slope * Math.log2(hz / REFERENCE);

// the spectrum of a color as x, y of the box: the trend and a roughness of a seed, smoothed over neighbours
const spectrum = (slope: number, seed: number) => {
  const next = random(seed);
  const raw = Array.from({ length: SAMPLES + 3 }, () => 2 * next() - 1);
  const xy: number[] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const share = i / SAMPLES;
    const hz = LOW * (HIGH / LOW) ** share;
    const rough = ROUGH[0] + (ROUGH[1] - ROUGH[0]) * share;
    const jitter = (raw[i] + 2 * raw[i + 1] + raw[i + 2]) / 4;
    xy.push(round(chartX(hz)), round(chartY(trend(slope, hz) + rough * jitter)));
  }
  return xy;
};

export type ChartLine = (typeof NOISE_COLORS)[number] & {
  xy: number[];
  // where its name goes: right of its end, at the level of its trend there
  end: [number, number];
};

export const noiseChart = (): ChartLine[] =>
  NOISE_COLORS.map((color, i) => ({
    ...color,
    xy: spectrum(color.slope, i + 1),
    end: [CHART.right, round(chartY(trend(color.slope, HIGH)))],
  }));

// the lines of the grid (every decade, every 12 dB) and the labels under and left of the chart
export const CHART_GRID = {
  hz: [100, 1_000, 10_000].map((hz) => round(chartX(hz))),
  db: [-24, -12, 0, 12, 24].map((db) => ({ db, y: round(chartY(db)) })),
  frequencies: [
    { label: '20 Hz', x: CHART.left, anchor: 'start' },
    { label: '1 kHz', x: round(chartX(REFERENCE)), anchor: 'middle' },
    { label: '20 kHz', x: CHART.right, anchor: 'end' },
  ],
};
