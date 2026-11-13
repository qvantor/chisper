// the cases of the perf suite (README.md) as data: a snapshot of the synth (the format of getSnapshot(), the
// sections left out are the defaults) and the notes held through it (window.__chisperPerf.run); the runner
// opens a fresh page for each run. What doesn't need a browser is computed in the Jest specs (README: what
// moved to the specs)

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

const PPQ = 960;
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
const CLIP = {
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
];

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

// the cases of a run: all of them, or those --only names (ids, or the groups cpu and latency)
export const selectCases = ({ only }) => {
  const all = [...CPU_CASES, ...LATENCY_CASES];
  if (!only) return all;
  const wanted = only.split(',');
  return all.filter((kase) => wanted.includes(kase.id) || wanted.includes(kase.group));
};
