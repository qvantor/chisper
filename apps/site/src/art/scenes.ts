import { NOISE_COLORS, random } from './noise';
import { ROLL, TRACK_CLIP, TRACK_LOOP } from './track';
import { frameAt, mix, partials, wave } from './wavetable';

// The waves behind the features: each shows what its part of the synth does to a wave, slowly moving (scripts/
// scenes.ts draws them on a canvas behind the section). Pure math: a scene at a time is its lines, each points of
// x (0..1 across the section) and a level (-1..1 around the middle of its band), a color, how opaque and how
// thick, a glow; the editor's pen a dot; the noise grain, its points dots; the notes of the track, bars.

export const SCENES = [
  'synthesis',
  'wavetables',
  'unison',
  'noise',
  'filter',
  'modulation',
  'effects',
  'playing',
  'track',
  'editor',
  'presets',
] as const;
export type Scene = (typeof SCENES)[number];

export const isScene = (name: string): name is Scene => (SCENES as readonly string[]).includes(name);

export type SceneLine = {
  points: number[];
  color: string;
  alpha: number;
  width: number;
  glow?: number;
  dash?: number[];
  dot?: [number, number];
  // its points are dots of this size, not a line
  grain?: number;
  // its points are the corners of bars (x0, top, x1, bottom of each), filled at this share of its alpha, edged
  bars?: number;
};

const TAU = 2 * Math.PI;
const BLUE = '#3498db';
const GREEN = '#2ecc71';
const GHOST = '#5a7fa4';
const SAMPLES = 240;

// the color of each feature: the square of its label and the light behind its picture (Landing.astro), its wave
export const FEATURE_COLORS: Record<Scene, string> = {
  synthesis: BLUE,
  wavetables: GREEN,
  unison: BLUE,
  // the silver of white noise
  noise: '#bdc3c7',
  filter: '#f1c40f',
  modulation: '#9b59b6',
  effects: '#e74c3c',
  playing: '#1abc9c',
  // the blue of the loop of the piano roll (its notes green)
  track: BLUE,
  editor: GREEN,
  presets: BLUE,
};

const share = (time: number, period: number) => 0.5 + 0.5 * wave(time, period);

// the tier of a light: the last of `tiers` (from the faintest) it reaches, -1 under all
const tierOf = (light: number, tiers: readonly { from: number }[]) => {
  let tier = -1;
  for (let i = 0; i < tiers.length; i++) if (light >= tiers[i].from) tier = i;
  return tier;
};

// what doesn't move is worked out on the first drawing, not as the page loads
const once = <T>(make: () => T) => {
  let value: T | undefined;
  return () => (value ??= make());
};

// a line of `level` over x in [from, to]
const curve = (level: (x: number) => number, from = 0, to = 1, samples = SAMPLES) => {
  const points = new Array<number>(2 * (samples + 1));
  for (let i = 0; i <= samples; i++) {
    const x = from + ((to - from) * i) / samples;
    points[2 * i] = x;
    points[2 * i + 1] = level(x);
  }
  return points;
};

// the largest |level| of a periodic level over one period
const peakOf = (level: (x: number) => number, samples = 256) =>
  Math.max(...Array.from({ length: samples }, (_, i) => Math.abs(level(i / samples))));

// a note whose frame changes as it plays: the frame (a sine to a saw) moves along the band and with the time, each
// part of the wave in the color of its frame (the blue of the sine, the green of the saw); a sine faint under it
const MORPH_CYCLES = 7;
const MORPH_PARTS = 12;
const MORPH_SAMPLES = 40;
// the peak of a frame at 33 shares of the table, linear between them
const FRAME_PEAKS = 32;
const framePeaks = once(() =>
  Array.from({ length: FRAME_PEAKS + 1 }, (_, i) => peakOf((x) => frameAt(i / FRAME_PEAKS, x)))
);
const framePeak = (t: number) => {
  const peaks = framePeaks();
  const i = Math.min(FRAME_PEAKS - 1, Math.floor(t * FRAME_PEAKS));
  return peaks[i] + (peaks[i + 1] - peaks[i]) * (t * FRAME_PEAKS - i);
};
const sineLine = once((): SceneLine => ({
  points: curve((x) => Math.sin(TAU * MORPH_CYCLES * x)),
  color: GHOST,
  alpha: 0.3,
  width: 1,
}));
const synthesis = (time: number): SceneLine[] => {
  const played = (x: number) => 0.5 + 0.5 * Math.sin(TAU * (0.8 * x - time / 16));
  const level = (x: number) => {
    const t = played(x);
    return frameAt(t, MORPH_CYCLES * x) / framePeak(t);
  };
  return [
    sineLine(),
    ...Array.from({ length: MORPH_PARTS }, (_, part): SceneLine => {
      const from = part / MORPH_PARTS;
      const to = (part + 1) / MORPH_PARTS;
      return {
        points: curve(level, from, to, MORPH_SAMPLES),
        color: mix(BLUE, GREEN, played((from + to) / 2)),
        alpha: 0.9,
        width: 2,
        glow: 8,
      };
    }),
  ];
};

// the position of the Wave knob moving through the frames of a table: its frames faint, the one it plays bright
const TABLE_CYCLES = 3;
const tableFrames = once(() =>
  [0, 0.33, 0.66, 1].map((t): SceneLine => {
    const peak = peakOf((x) => frameAt(t, x));
    return { points: curve((x) => frameAt(t, TABLE_CYCLES * x) / peak), color: GHOST, alpha: 0.35, width: 1 };
  })
);

const wavetables = (time: number): SceneLine[] => {
  const played = share(time, 14);
  const peak = peakOf((x) => frameAt(played, x), 128);
  return [
    ...tableFrames(),
    {
      points: curve((x) => frameAt(played, TABLE_CYCLES * x) / peak),
      color: mix(BLUE, GREEN, played),
      alpha: 0.95,
      width: 2,
      glow: 10,
    },
  ];
};

// voices of one wave a little apart in pitch: together in the middle, apart towards the edges, their phases drifting
const unisonPeak = once(() => peakOf((x) => partials(x, 6), 1024));
const unison = (time: number): SceneLine[] => {
  const voices = 7;
  const peak = unisonPeak();
  return Array.from({ length: voices }, (_, v) => {
    const offset = (v - (voices - 1) / 2) / ((voices - 1) / 2);
    const cycles = 3.2 * (1 + 0.05 * offset);
    const drift = 0.12 * offset * wave(time, 16);
    const centre = offset === 0;
    return {
      points: curve((x) => partials(cycles * (x - 0.5) + drift + 0.25, 6) / peak),
      color: centre ? GREEN : mix(BLUE, GREEN, 0.5 - 0.5 * Math.abs(offset)),
      alpha: centre ? 0.95 : 0.65 - 0.3 * Math.abs(offset),
      width: centre ? 2 : 1.2,
      glow: centre ? 10 : 0,
    };
  });
};

// noise as a cloud of particles that waves pass through: dots over the whole band (as high as the waves of the other
// features go), each drifting slowly on its own and bobbing a little; three waves in the colors of noise (white,
// pink, brown) travel across it, and the dots near a wave light up in its color, grow and gather onto it, so the
// waves are seen in the dots as they pass, then leave them to the cloud
const PARTICLES = 6000;
// how near a wave lights a dot (a share of the half of the band), how much the light pulls it onto the wave
const REACH = 0.11;
const PULL = 0.6;
const CLOUD = { alpha: 0.42, size: 2 };
// the lit dots by their light: from `from` up
const GLOWS = [
  { from: 0.25, alpha: 0.6, size: 2.3 },
  { from: 0.5, alpha: 0.82, size: 2.7 },
  { from: 0.75, alpha: 1, size: 3.1 },
];
const NOISE_COLOR = Object.fromEntries(NOISE_COLORS.map(({ name, color }) => [name, color]));
// the waves, each a sum of sines: `amp`, `cycles` across the band, going right through one in `period` seconds
// (left where negative)
const NOISE_WAVES = [
  {
    color: NOISE_COLOR.White,
    parts: [
      { amp: 0.42, cycles: 1.1, period: 8, phase: 0 },
      { amp: 0.14, cycles: 2.6, period: 5, phase: 1.3 },
    ],
  },
  {
    color: NOISE_COLOR.Pink,
    parts: [
      { amp: 0.5, cycles: 0.75, period: 11, phase: 2.1 },
      { amp: 0.1, cycles: 1.9, period: -7, phase: 0.4 },
    ],
  },
  {
    color: NOISE_COLOR.Brown,
    parts: [
      { amp: 0.32, cycles: 1.5, period: -13, phase: 4.2 },
      { amp: 0.12, cycles: 3.1, period: 9, phase: 2.7 },
    ],
  },
];

// the level of the wave `index` at x (0..1)
export const noiseWave = (index: number, x: number, time: number) => {
  let level = 0;
  for (const { amp, cycles, period, phase } of NOISE_WAVES[index].parts)
    level += amp * Math.sin(TAU * (cycles * x - time / period) + phase);
  return level;
};

// the waves at a time on a grid across the band, a dot reads its wave between two points of it: the sines of a
// frame once, not for every dot
const GRID = 512;
const waveGrids = (time: number) =>
  NOISE_WAVES.map((_, index) => {
    const levels = new Float64Array(GRID + 1);
    for (let j = 0; j <= GRID; j++) levels[j] = noiseWave(index, j / GRID, time);
    return levels;
  });
const onGrid = (levels: Float64Array, x: number) => {
  const at = x * GRID;
  const j = Math.min(GRID - 1, Math.floor(at));
  return levels[j] + (levels[j + 1] - levels[j]) * (at - j);
};

// where each dot rests (over the band, fewer at its edges: a uniform and a narrow triangle, short of the edges as it
// bobs), how fast it drifts right (shares of the band a second), when it bobs
const particles = once(() => {
  const next = random(11);
  return Array.from({ length: PARTICLES }, () => ({
    x: next(),
    level: 0.95 * (1.5 * next() + 0.25 * (next() + next()) - 1),
    drift: 0.003 + 0.007 * next(),
    phase: next(),
  }));
});

export type NoiseDot = {
  x: number;
  level: number;
  // the wave that lights it most and how much (0..1)
  wave: number;
  light: number;
};

// every dot at a time, in the same order at every time
export const noiseDots = (time: number): NoiseDot[] => {
  const grids = waveGrids(time);
  return particles().map(({ x: rest, level: base, drift, phase }) => {
    const x = (rest + drift * time) % 1;
    const level = base + 0.04 * Math.sin(TAU * (time / 4 + phase));
    let nearest = 0;
    let light = 0;
    let target = level;
    for (let i = 0; i < grids.length; i++) {
      const at = onGrid(grids[i], x);
      const near = Math.exp(-(((level - at) / REACH) ** 2));
      if (near > light) {
        nearest = i;
        light = near;
        target = at;
      }
    }
    return { x, level: level + (target - level) * PULL * light, wave: nearest, light };
  });
};

// the cloud, then the lit dots of each wave from the faintest
const noise = (time: number): SceneLine[] => {
  const cloud: number[] = [];
  const lit = NOISE_WAVES.map(() => GLOWS.map(() => [] as number[]));
  for (const dot of noiseDots(time)) {
    const glow = tierOf(dot.light, GLOWS);
    if (glow < 0) cloud.push(dot.x, dot.level);
    else lit[dot.wave][glow].push(dot.x, dot.level);
  }
  const dots = (points: number[], color: string, alpha: number, size: number): SceneLine => ({
    points,
    color,
    alpha,
    width: size,
    grain: size,
  });
  return [
    dots(cloud, FEATURE_COLORS.noise, CLOUD.alpha, CLOUD.size),
    ...NOISE_WAVES.flatMap(({ color }, i) =>
      GLOWS.map(({ alpha, size }, g) => dots(lit[i][g], color, alpha, size))
    ),
  ];
};

// a saw and what a resonant lowpass leaves of it, the cutoff going up and down; the saw (its peak the scale of
// both) still
const SAW_CYCLES = 3;
const SAW_HARMONICS = 24;
const saw = once(() => {
  const peak = peakOf((x) => partials(x, SAW_HARMONICS), 1024);
  const line: SceneLine = {
    points: curve((x) => partials(SAW_CYCLES * x, SAW_HARMONICS) / peak),
    color: GHOST,
    alpha: 0.4,
    width: 1,
  };
  return { peak, line };
});
const filter = (time: number): SceneLine[] => {
  const { peak, line } = saw();
  const cutoff = 1.6 + 7 * share(time, 12);
  // the gain of each harmonic at this cutoff
  const gains = Array.from(
    { length: SAW_HARMONICS + 1 },
    (_, h) => (1 / Math.sqrt(1 + (h / cutoff) ** 8)) * (1 + 1.4 * Math.exp(-((h - cutoff) ** 2) / 0.9))
  );
  return [
    line,
    {
      points: curve((x) => partials(SAW_CYCLES * x, SAW_HARMONICS, (h) => gains[h]) / peak),
      color: FEATURE_COLORS.filter,
      alpha: 0.9,
      width: 2,
      glow: 10,
    },
  ];
};

// a wave under the shape of an LFO moving along it: the shape bright, the wave it moves faint
const modulation = (time: number): SceneLine[] => {
  const shape = (x: number) => 0.18 + 0.82 * (0.5 + 0.5 * Math.sin(TAU * (1.2 * x - time / 9)));
  return [
    {
      points: curve((x) => shape(x) * Math.sin(TAU * 18 * x), 0, 1, 720),
      color: BLUE,
      alpha: 0.55,
      width: 1.1,
    },
    { points: curve(shape), color: FEATURE_COLORS.modulation, alpha: 0.95, width: 2, glow: 10 },
    { points: curve((x) => -shape(x)), color: FEATURE_COLORS.modulation, alpha: 0.6, width: 1.4 },
  ];
};

// a sine and the distortion's soft clip of it, the drive going up and down; the sine and the ceiling (dashed) still
const SINE_CYCLES = 2.5;
const CEILING = 0.82;
const sineAndCeiling = once((): SceneLine[] => {
  const ceiling = { color: FEATURE_COLORS.effects, alpha: 0.35, width: 1, dash: [6, 8] };
  return [
    { points: curve((x) => Math.sin(TAU * SINE_CYCLES * x)), color: GHOST, alpha: 0.4, width: 1 },
    { points: [0, CEILING, 1, CEILING], ...ceiling },
    { points: [0, -CEILING, 1, -CEILING], ...ceiling },
  ];
});
const effects = (time: number): SceneLine[] => {
  const drive = 1 + 6 * share(time, 10);
  return [
    ...sineAndCeiling(),
    {
      points: curve((x) => (CEILING * Math.tanh(drive * Math.sin(TAU * SINE_CYCLES * x))) / Math.tanh(drive)),
      color: FEATURE_COLORS.effects,
      alpha: 0.9,
      width: 2,
      glow: 10,
    },
  ];
};

// notes that glide into each other (portamento), passing by
const NOTES = [3, 4.5, 3.6, 5.4, 4, 3];
const glide = (position: number) => {
  // the pitch (cycles over the width) at a position of a loop of the notes, each gliding over the last third
  const steps = NOTES.length;
  const p = (((position % 1) + 1) % 1) * steps;
  const i = Math.floor(p);
  const into = Math.max(0, (p - i - 0.66) / 0.34);
  const eased = into * into * (3 - 2 * into);
  return NOTES[i] + (NOTES[(i + 1) % steps] - NOTES[i]) * eased;
};
const playing = (time: number): SceneLine[] => {
  const offset = time / 40;
  const samples = 480;
  let phase = 0;
  const points: number[] = [];
  for (let i = 0; i <= samples; i++) {
    const x = i / samples;
    if (i) phase += glide(x / 1.5 + offset) / samples;
    points.push(x, 0.85 * Math.sin(TAU * phase));
  }
  return [{ points, color: FEATURE_COLORS.playing, alpha: 0.9, width: 2, glow: 10 }];
};

// the notes of the clip of the page (art/track.ts) as on a piano roll scrolling under a still playhead: they fly
// right to left, TRACK_ACROSS beats across the band, TRACK_SPEED beats a second, the loop over and over; a note lights
// up as the playhead plays it and dims over TRACK_DIM beats after its end; the lines of the bars go with them. Its
// pitch is its level (the two octaves of the drawing over ±TRACK_SPAN), a note NOTE_HEIGHT high
const TRACK_ACROSS = 12;
const TRACK_SPEED = 0.6;
const TRACK_DIM = 1.5;
const TRACK_SPAN = 0.85;
const NOTE_HEIGHT = 0.056;
// in the gap between the text and the drawing
export const TRACK_PLAYHEAD = 0.5;
const UNLIT = { color: BLUE, alpha: 0.5, width: 1.2, fill: 0.25 };
// the lit notes by their light: from `from` up, from the blue of the loop to the green of the notes
const NOTE_GLOWS = [
  { from: 0.25, color: mix(BLUE, GREEN, 0.35), alpha: 0.65, width: 1.4, glow: 6, fill: 0.35 },
  { from: 0.5, color: mix(BLUE, GREEN, 0.7), alpha: 0.82, width: 1.6, glow: 9, fill: 0.4 },
  { from: 0.75, color: GREEN, alpha: 1, width: 1.8, glow: 12, fill: 0.45 },
];

// the beat of the loop at the playhead
const trackBeat = (time: number) => (time * TRACK_SPEED) % TRACK_LOOP;
// x of a beat `beats` after the one at the playhead
const beatAt = (beats: number) => TRACK_PLAYHEAD + beats / TRACK_ACROSS;
const noteLevel = (pitch: number) => TRACK_SPAN * ((2 * (pitch - ROLL.low)) / (ROLL.high - ROLL.low) - 1);

export type FlyingNote = {
  // its ends across the band (cut at its edges), its level
  from: number;
  to: number;
  level: number;
  // 1 while the playhead plays it, less as it goes away, 0 before it
  light: number;
};

// the notes on the band at a time: each of the loop, the one before and the one after (the band is shorter than a loop)
export const trackNotes = (time: number): FlyingNote[] => {
  const now = trackBeat(time);
  const notes: FlyingNote[] = [];
  for (const [start, length, pitch] of TRACK_CLIP) {
    for (const loop of [-1, 0, 1]) {
      const ahead = start + loop * TRACK_LOOP - now;
      const from = beatAt(ahead);
      const to = beatAt(ahead + length);
      if (to <= 0 || from >= 1) continue;
      const past = -(ahead + length);
      const light = past >= 0 ? Math.max(0, 1 - past / TRACK_DIM) : ahead <= 0 ? 1 : 0;
      notes.push({ from: Math.max(0, from), to: Math.min(1, to), level: noteLevel(pitch), light });
    }
  }
  return notes;
};

const playhead = once((): SceneLine => ({
  points: [TRACK_PLAYHEAD, -0.95, TRACK_PLAYHEAD, 0.95],
  color: '#ecf0f1',
  alpha: 0.4,
  width: 1.2,
  glow: 6,
}));

// the lines of the bars, the unlit notes, the playhead, the lit notes from the faintest
const track = (time: number): SceneLine[] => {
  const now = trackBeat(time);
  const bars: SceneLine[] = [];
  for (let beat = -TRACK_LOOP; beat < 2 * TRACK_LOOP; beat += 4) {
    const x = beatAt(beat - now);
    if (x >= 0 && x <= 1) bars.push({ points: [x, -0.95, x, 0.95], color: GHOST, alpha: 0.22, width: 1 });
  }
  const unlit: number[] = [];
  const lit = NOTE_GLOWS.map(() => [] as number[]);
  for (const { from, to, level, light } of trackNotes(time)) {
    const glow = tierOf(light, NOTE_GLOWS);
    (glow < 0 ? unlit : lit[glow]).push(from, level + NOTE_HEIGHT / 2, to, level - NOTE_HEIGHT / 2);
  }
  const notes = (points: number[], { color, alpha, width, fill }: typeof UNLIT, glow = 0): SceneLine => ({
    points,
    color,
    alpha,
    width,
    glow,
    bars: fill,
  });
  return [
    ...bars,
    notes(unlit, UNLIT),
    playhead(),
    ...NOTE_GLOWS.map((style, g) => notes(lit[g], style, style.glow)),
  ].filter(({ points }) => points.length > 0);
};

// a wave drawn by hand, point by point, a pen going along it
const DRAWN = [
  [0, 0],
  [0.06, 0.55],
  [0.12, 0.3],
  [0.2, 0.85],
  [0.28, 0.15],
  [0.36, -0.45],
  [0.43, -0.15],
  [0.5, -0.8],
  [0.58, -0.35],
  [0.66, 0.5],
  [0.74, 0.25],
  [0.82, -0.55],
  [0.9, -0.2],
  [1, 0],
];
const drawnAt = (x: number) => {
  const period = ((x % 1) + 1) % 1;
  const i = DRAWN.findIndex(([px]) => px >= period);
  if (i <= 0) return DRAWN[0][1];
  const [x0, y0] = DRAWN[i - 1];
  const [x1, y1] = DRAWN[i];
  const t = (period - x0) / (x1 - x0);
  // smooth between the points (a cosine ease)
  return y0 + (y1 - y0) * (0.5 - 0.5 * Math.cos(Math.PI * t));
};
const drawn = (x: number) => drawnAt(2 * x);
const drawnLine = once((): SceneLine => ({ points: curve(drawn), color: GHOST, alpha: 0.35, width: 1 }));
const editor = (time: number): SceneLine[] => {
  const pen = (time / 12) % 1;
  return [
    drawnLine(),
    {
      points: curve(drawn, 0, Math.max(pen, 0.001), Math.max(2, Math.round(SAMPLES * pen))),
      color: FEATURE_COLORS.editor,
      alpha: 0.95,
      width: 2,
      glow: 10,
      dot: [pen, drawn(pen)],
    },
  ];
};

// a shelf of different sounds: six small waves side by side, drifting, in the colors of the features
const SHELF = [
  GREEN,
  BLUE,
  FEATURE_COLORS.modulation,
  FEATURE_COLORS.filter,
  FEATURE_COLORS.effects,
  FEATURE_COLORS.playing,
];
const SHAPES: ((x: number) => number)[] = [
  (x) => Math.sin(TAU * x),
  (x) => partials(x, 8) / 1.6,
  (x) => partials(x, 9, (h) => (h % 2 ? 1 : 0)) / 0.9,
  (x) => (2 / Math.PI) * Math.asin(Math.sin(TAU * x)),
  (x) => Math.exp(-3 * (((x % 1) + 1) % 1)) * Math.sin(TAU * 3 * x),
  (x) => (Math.sin(TAU * x) + 0.5 * Math.sin(TAU * 3.7 * x + 1) + 0.3 * Math.sin(TAU * 7.3 * x + 2)) / 1.5,
];
const presets = (time: number): SceneLine[] =>
  SHAPES.map((shape, i) => {
    const from = i / SHAPES.length + 0.02;
    const to = (i + 1) / SHAPES.length - 0.02;
    const drift = time / 18 + i * 0.13;
    return {
      points: curve((x) => 0.7 * shape(((x - from) / (to - from)) * 1.5 + drift), from, to, 80),
      color: SHELF[i],
      alpha: 0.85,
      width: 1.8,
      glow: 8,
    };
  });

const DRAW: Record<Scene, (time: number) => SceneLine[]> = {
  synthesis,
  wavetables,
  unison,
  noise,
  filter,
  modulation,
  effects,
  playing,
  track,
  editor,
  presets,
};

export const sceneAt = (scene: Scene, time: number) => DRAW[scene](time);
