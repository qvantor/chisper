// the cases of the perf suite (README.md) as data: a snapshot of the synth (the format of getSnapshot(), the
// sections left out are the defaults) and the notes held through it (window.__chisperPerf.run); the runner
// opens a fresh page for each run. What doesn't need a browser is computed in the Jest specs (README: what
// moved to the specs)

import fs from 'fs';
import path from 'path';
// (the model types of the filter as the chart has them; Node strips the types)
import { MODEL_FILTER_TYPES } from '../../libs/math/src/filter/model.ts';

// the tables the cases play (their keys in the bucket, 256 frames each)
export const TABLES = {
  saw303: 'ESW Core Tables/Analog/ESW Analog - 303 Saw.wav',
  pwm: 'ESW Core Tables/Basics/ESW Basics - PWM Saw 01.wav',
  // the default of the app: an oscillator that is off still loads it
  saws: 'ESW Core Tables/Basics/ESW Basics - Saw Collection.wav',
};

// the path of a table in the list of the app: its folders, then its key
const tablePath = (key) => [...key.split('/').slice(0, -1), key];

const osc = (key, values = {}) => ({
  a: true,
  p: tablePath(key),
  w: 128,
  u: 1,
  d: 0,
  o: 0,
  g: 0.5,
  ph: 0.5,
  pr: 1,
  ...values,
});
const OFF = { a: false };
const FILTER = { a: true, t: 'lowpass', cut: 2500, res: 6 };
// the filter of F1: a ladder with its resonance saturating, Drive and FAT on (the costliest model type)
const LADDER24 = { a: true, t: 'ladder24', cut: 2500, res: 60, dr: 40, v: 50 };
const NO_FILTER = { a: false };
const ADSR = { attack: 0.01, hold: 0.1, decay: 0.3, sustain: 0.8, release: 0.3 };
// a sharp onset for the latency cases: no attack, every unison voice at its phase
const SHARP = { attack: 0, hold: 0.1, decay: 0, sustain: 1, release: 0.05 };
const VOICING = { leg: false, port: 0, max: 12 };

const fx = (added = []) => ({
  o: ['distortion', 'delay', 'reverb'],
  distortion: { a: added.includes('distortion'), on: true, mix: 1, drive: 8, mode: 0 },
  delay: { a: added.includes('delay'), on: true, mix: 0.3, time: 0.3, fb: 0.5 },
  reverb: { a: added.includes('reverb'), on: true, mix: 0.3, decay: 3 },
});

// the velocity takes nothing of the volume (Amp 0): no amp on the voices, the work of a tree before the velocity
// (an A/B run against one compares the same work; a tree before it leaves `vel` out)
const NO_VELOCITY = { amp: 0 };

const patch = (values = {}) => ({
  osc1: osc(TABLES.saw303),
  osc2: OFF,
  filter: NO_FILTER,
  v: VOICING,
  fx: fx(),
  ...values,
  env: { e1: ADSR, ...values.env, vel: NO_VELOCITY },
});

const BOTH_U8 = {
  osc1: osc(TABLES.saw303, { u: 8, d: 25 }),
  osc2: osc(TABLES.pwm, { u: 8, d: 35, o: -1, w: 64 }),
};
// the heavy patch (measured on the iPhone): 2 oscillators × u8 on two tables of 256 frames, the filter, every
// effect, Poly 12
const HEAVY = patch({ ...BOTH_U8, filter: FILTER, fx: fx(['distortion', 'delay', 'reverb']) });
// the sub of the sub cases: the Sine an octave under the note (the sine of the store: no table of its own). A tree
// without the sub (the reference of an A/B run) drops it from the snapshot (the schema strips the key): there S5s
// plays S5 and SUB voices with no source on, the shift is the cost of the sub
const SUB = { a: true, o: -1 };
// the notes the CPU cases hold
const HELD = ['C3', 'D3', 'E3', 'G3', 'A3', 'C4', 'D4', 'E4', 'G4', 'A4', 'B4', 'C5'];

// --- the clip of the track cases (libs/preset-schema/src/clip.ts) ---

export const PPQ = 960;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
// MIDI 60 is C4 (services/note.ts)
const pitchOf = (name) => {
  const [, note, octave] = name.match(/^(.+?)(-?\d+)$/);
  return (Number(octave) + 1) * 12 + NOTE_NAMES.indexOf(note);
};
const nameOf = (pitch) => `${NOTE_NAMES[pitch % 12]}${Math.floor(pitch / 12) - 1}`;

// 2 bars at 120 BPM: a chord of 4 held through each bar, an arpeggio of 16ths over it (each a dotted 32nd long):
// ~10 notes on a second, up to 12 voices with their releases where the chords change (Poly 12: stealing). No
// pitch overlaps itself: the script of a reference plays the same notes through the keys
const ARPEGGIO = ['C4', 'E4', 'G4', 'B4', 'C5', 'B4', 'G4', 'E4'];
export const CLIP = {
  bpm: 120,
  length: 8 * PPQ,
  notes: [
    ...[0, 4 * PPQ].flatMap((bar) =>
      ['C3', 'E3', 'G3', 'B3'].map((name) => [bar, 4 * PPQ - PPQ / 8, pitchOf(name), 100])
    ),
    ...Array.from({ length: 32 }, (_, k) => [(k * PPQ) / 4, (3 * PPQ) / 16, pitchOf(ARPEGGIO[k % 8]), 100]),
  ],
};

// the clip as a script of the test hook (window.__chisperPerf.run): its notes through the keys, looped over
// `seconds` (a tree without the track, the reference of an A/B run, plays the same notes so)
export const clipSteps = ({ bpm, length, notes }, seconds) => {
  const ms = 60000 / bpm / PPQ;
  const loops = Math.ceil((seconds * 1000) / (length * ms));
  return Array.from({ length: loops }, (_, loop) =>
    notes.flatMap(([start, duration, pitch]) => [
      { at: (loop * length + start) * ms, note: nameOf(pitch), on: true },
      { at: (loop * length + start + duration) * ms, note: nameOf(pitch), on: false },
    ])
  ).flat();
};

// the heavy patch at Poly 4 as a pluck with no attack and a long release (the envelope of WAVEFORM-41): over the
// chord of the clip every note of its arpeggio steals a voice, which fades out under a new one (an attack under
// MIN_TAKE_ATTACK of synth.ts: a voice more for its fade, the shorter the quieter it is, a voice made at every
// note). A tree of before plays the note on the stolen voice: against it the shift is the cost of that
const PLUCK = { attack: 0, hold: 0, decay: 0.36, sustain: 0, release: 1.24 };
const STEALING = { ...HEAVY, v: { ...VOICING, max: 4 }, env: { ...HEAVY.env, e1: PLUCK } };

// --- CPU and memory: the notes are held (or the clip plays), xctrace records 10 s after a warm-up ---

export const CPU_CASES = [
  {
    id: 'S5',
    group: 'cpu',
    title: 'the heavy patch, 12 notes',
    snapshot: HEAVY,
    notes: HELD,
  },
  {
    id: 'F1',
    group: 'cpu',
    title: 'the heavy patch through Ladder 24 (Res 60, Drive 40, FAT 50), 12 notes',
    snapshot: { ...HEAVY, filter: LADDER24 },
    // (a tree without the model types of the filter can't take the snapshot: the heavy patch there, its lowpass)
    fallback: HEAVY,
    notes: HELD,
  },
  {
    id: 'S5s',
    group: 'cpu',
    title: 'the heavy patch and the sub, 12 notes',
    snapshot: { ...HEAVY, sub: SUB },
    notes: HELD,
  },
  {
    id: 'SUB',
    group: 'cpu',
    title: 'the sub alone, 12 notes',
    snapshot: patch({ osc1: OFF, sub: SUB }),
    notes: HELD,
  },
  {
    id: 'C1',
    group: 'cpu',
    title: 'the heavy patch and the compressor (three bands, down and up), 12 notes',
    snapshot: {
      ...HEAVY,
      fx: { ...HEAVY.fx, compressor: { a: true, on: true, mix: 1, multi: 1, below: 0.5, ratio: 8 } },
    },
    notes: HELD,
  },
  {
    id: 'CH1',
    group: 'cpu',
    title: 'the heavy patch and the chorus (a fast LFO, a high feedback), 12 notes',
    snapshot: {
      ...HEAVY,
      fx: { ...HEAVY.fx, chorus: { a: true, on: true, mix: 0.5, rate: 2, depth: 4, fb: 0.5, cut: 8000 } },
    },
    notes: HELD,
  },
  {
    id: 'T1',
    group: 'cpu',
    title: 'the heavy patch, a clip played by the track',
    snapshot: HEAVY,
    clip: CLIP,
    roll: false,
  },
  {
    id: 'T2',
    group: 'cpu',
    title: 'T1 with the piano roll open',
    snapshot: HEAVY,
    clip: CLIP,
    roll: true,
  },
  {
    id: 'T3',
    group: 'cpu',
    title: 'T1 at Poly 4 with no attack: a voice stolen at every note',
    snapshot: STEALING,
    clip: CLIP,
    roll: false,
  },
];

// --- the matrix (--only=matrix): every part alone over a light patch, at rest and modulated by LFO 1 (8 Hz) ---
// What costs what in the browser: the light patch (one oscillator, u1, no filter, no effect, 12 notes held), the
// oscillators, every filter type (at rest, Drive/Var high, every knob moved by LFO 1) and every effect (at rest,
// in its modes, every knob moved by LFO 1). Read it with `matrix.mjs` (Mcps over the light patch)

const LIGHT = patch({ osc1: osc(TABLES.saw303) });
const LFO_FAST = { lfo: { l1: { rate: 8 } } };
const withMod = (snapshot, targets, amount = 0.3) => ({
  ...snapshot,
  ...LFO_FAST,
  mod: Object.fromEntries(targets.map((target) => [`lfo1:${target}`, { a: amount, bi: true }])),
});
const fxOnly = (type, values = {}) => ({
  ...LIGHT,
  fx: { o: [type], [type]: { a: true, on: true, ...values } },
});
const matrixCase = (id, title, snapshot) => ({ id, group: 'matrix', title, snapshot, notes: HELD });

const filterCases = () => [
  matrixCase('lowpass rest', 'web lowpass at rest', {
    ...LIGHT,
    filter: { a: true, t: 'lowpass', cut: 1200, res: 6 },
  }),
  matrixCase(
    'lowpass mod',
    'web lowpass, cutoff, res and gain moved by LFO 1',
    withMod({ ...LIGHT, filter: { a: true, t: 'lowpass', cut: 1200, res: 6, gain: 0 } }, [
      'filter.cutoff',
      'filter.resonance',
      'filter.gain',
    ])
  ),
  ...MODEL_FILTER_TYPES.flatMap((type) => {
    const filter = { a: true, t: type, cut: 1200, res: 50, dr: 0, v: 0 };
    const knobs = ['filter.cutoff', 'filter.resonance', 'filter.drive', 'filter.var', 'filter.gain'];
    return [
      matrixCase(`${type} rest`, `${type} at rest (Res 50)`, { ...LIGHT, filter }),
      matrixCase(`${type} drive100`, `${type} Drive 100, Var 100`, {
        ...LIGHT,
        filter: { ...filter, dr: 100, v: 100 },
      }),
      matrixCase(
        `${type} mod`,
        `${type}, every knob moved by LFO 1`,
        withMod({ ...LIGHT, filter: { ...filter, dr: 40, v: 40 } }, knobs)
      ),
    ];
  }),
];

const FX_MATRIX = {
  distortion: {
    rest: [{ mode: 0 }, { mode: 1, drive: 12 }],
    knobs: ['drive', 'tone', 'level', 'mix'],
    values: { mode: 0, drive: 8, tone: 8000 },
  },
  chorus: {
    rest: [
      { rate: 0.5, depth: 10, fb: 0.1 },
      { rate: 2, depth: 26, fb: 0.9, d1: 15, d2: 10 },
    ],
    knobs: ['rate', 'd1', 'd2', 'depth', 'fb', 'cut', 'level', 'mix'],
    values: { rate: 2, depth: 10, fb: 0.5, cut: 8000, mix: 0.5 },
  },
  delay: {
    rest: [
      { time: 0.3, fb: 0.5 },
      { time: 0.3, fb: 0.9, mode: 1, q: 3 },
    ],
    knobs: ['time', 'fb', 'pan', 'freq', 'q', 'mix'],
    values: { time: 0.3, fb: 0.5, mix: 0.5 },
  },
  compressor: {
    rest: [
      { multi: 0, thresh: 0.5, ratio: 8 },
      { multi: 1, thresh: 0.5, ratio: 8, below: 0.5 },
    ],
    knobs: [
      'thresh',
      'ratio',
      'attack',
      'release',
      'gain',
      'xlow',
      'xhigh',
      'below',
      'low',
      'mid',
      'high',
      'level',
      'mix',
    ],
    values: { multi: 1, thresh: 0.5, ratio: 8, below: 0.5, mix: 1 },
  },
  reverb: {
    rest: [
      { decay: 1, size: 0.3, mix: 0.3 },
      { decay: 10, size: 1, mix: 0.5 },
    ],
    knobs: ['lowcut', 'pre', 'size', 'decay', 'damp', 'bass', 'depth', 'sep', 'er', 'mix'],
    values: { decay: 3, size: 0.5, mix: 0.3 },
  },
  eq: {
    rest: [
      { t1: 1, f1: 400, q1: 50, g1: 6 },
      { t1: 2, f1: 120, q1: 42, t2: 1, f2: 5000, q2: 70, g2: -9 },
    ],
    knobs: ['f1', 'q1', 'g1', 'f2', 'q2', 'g2', 'level', 'mix'],
    values: { t1: 1, f1: 400, q1: 50, g1: 6, t2: 0, f2: 6000, g2: -4 },
  },
  fxfilter: {
    rest: [
      { type: 5, cutoff: 1500, res: 20 },
      { type: 3, cutoff: 900, res: 70, drive: 40, var: 30, pan: 30 },
    ],
    knobs: ['cutoff', 'res', 'drive', 'var', 'pan', 'level', 'mix'],
    values: { type: 3, cutoff: 1200, res: 50, drive: 30 },
  },
};
const fxCases = () =>
  Object.entries(FX_MATRIX).flatMap(([type, { rest, knobs, values }]) => [
    ...rest.map((v, i) =>
      matrixCase(`${type} rest ${i + 1}`, `${type} at rest: ${JSON.stringify(v)}`, fxOnly(type, v))
    ),
    matrixCase(
      `${type} mod`,
      `${type}, every knob moved by LFO 1`,
      withMod(
        fxOnly(type, values),
        knobs.map((k) => `${type}.${k}`)
      )
    ),
  ]);

const OSC_CASES = [
  matrixCase('light (osc u1)', 'one oscillator, u1, no filter, no effect', LIGHT),
  matrixCase('osc u8', 'one oscillator, unison 8', patch({ osc1: osc(TABLES.saw303, { u: 8, d: 25 }) })),
  matrixCase('osc 2 x u8', 'two oscillators, unison 8', patch(BOTH_U8)),
  matrixCase('sub', 'light patch and the sub', { ...LIGHT, sub: SUB }),
];

export const MATRIX_CASES = [...OSC_CASES, ...filterCases(), ...fxCases()];

// --- latency: real input, one run each (README: latency) ---

// keys of the QWERTY keyboard of the app and their notes (keyboard-controller.ts)
export const KEYS = [
  ['KeyQ', 'C4'],
  ['KeyW', 'D4'],
  ['KeyE', 'E4'],
  ['KeyR', 'F4'],
  ['KeyT', 'G4'],
  ['KeyY', 'A4'],
  ['KeyU', 'B4'],
  ['KeyI', 'C5'],
];

const SHARP_PATCH = patch({ osc1: osc(TABLES.saw303, { pr: 0 }), env: { e1: SHARP } });

export const LATENCY_CASES = [
  {
    id: 'L1',
    group: 'latency',
    title: 'single notes, a key every 300 ms',
    snapshot: SHARP_PATCH,
    count: 50,
    interval: 300,
    probe: true,
  },
  {
    id: 'L3',
    group: 'latency',
    title: '8 notes held (2 × u8), single notes on top',
    snapshot: patch({ ...BOTH_U8, env: { e1: SHARP } }),
    count: 50,
    interval: 300,
    held: ['C2', 'E2', 'G2', 'B2', 'C3', 'E3', 'G3', 'B3'],
  },
];

// a preset of a database as a case (--preset=<file>: its `data`, as `select data from presets` gives it): the 12
// notes held through it, a CPU case as S5. The id is P1; a tree that can't take its snapshot fails the case
export const presetCase = (file) => {
  const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    id: 'P1',
    group: 'cpu',
    title: `the preset ${path.basename(file)}, 12 notes`,
    snapshot,
    notes: HELD,
  };
};

// the files a snapshot plays: the keys of its tables (the oscillators, off or on: an oscillator that is off still
// loads its table) and of its noise sample
export const snapshotFiles = (snapshot) => ({
  tables: ['osc1', 'osc2'].map((name) => snapshot[name]?.p?.at(-1)).filter(Boolean),
  noises: [snapshot.noise?.p?.at(-1)].filter(Boolean),
});

// the cases of a run: all of them, or those --only names (ids, or the groups cpu and latency); `preset`: the file
// of the preset case, which comes after them
export const selectCases = ({ only, preset }) => {
  const all = [...CPU_CASES, ...(preset ? [presetCase(preset)] : []), ...LATENCY_CASES];
  if (only === 'matrix') {
    const match = process.env.MATRIX_MATCH && new RegExp(process.env.MATRIX_MATCH);
    return match ? MATRIX_CASES.filter(({ id }) => match.test(id)) : MATRIX_CASES;
  }
  if (!only) return all;
  const wanted = only.split(',');
  return all.filter((kase) => wanted.includes(kase.id) || wanted.includes(kase.group));
};
