import { mix } from './wavetable';

// The clip of the page: a loop of four bars, chords and a melody over them, as the piano roll of the synth shows it
// (TrackDiagram.astro, on a dark screen beside the section of the track); the scene behind that section flies the
// same notes through its playhead (art/scenes.ts). Pure math: the build and the browser run the same.

// a note: its start and length in beats (quarter notes), its pitch (MIDI: 60 is C4) and velocity (1..127)
export type TrackNote = [start: number, length: number, pitch: number, velocity: number];

// the length of the loop in beats: four bars of 4/4
export const TRACK_LOOP = 16;

// the chords, a bar each (Am, F, C, G): struck on the first beat and again off the third, the top note softer
const CHORDS = [
  [52, 57, 60],
  [53, 57, 60],
  [52, 55, 60],
  [50, 55, 59],
];

// the melody over them, in eighths and sixteenths up to C5
const MELODY: TrackNote[] = [
  [0, 0.5, 64, 96],
  [0.5, 0.5, 69, 84],
  [1, 1, 72, 118],
  [2, 0.5, 71, 90],
  [2.5, 0.5, 69, 78],
  [3, 0.75, 64, 100],
  [3.75, 0.25, 67, 70],
  [4, 1.5, 69, 112],
  [5.5, 0.5, 72, 92],
  [6, 0.5, 69, 80],
  [6.5, 0.5, 65, 74],
  [7, 1, 67, 104],
  [8, 0.5, 64, 94],
  [8.5, 0.5, 67, 82],
  [9, 0.75, 72, 120],
  [9.75, 0.25, 71, 72],
  [10, 0.5, 72, 98],
  [10.5, 0.5, 67, 80],
  [11, 1, 64, 106],
  [12, 1, 71, 114],
  [13, 0.5, 69, 88],
  [13.5, 0.5, 67, 76],
  [14, 0.5, 62, 86],
  [14.5, 0.5, 64, 80],
  [15, 1, 71, 108],
];

// every note of the clip by its start, then its pitch
export const TRACK_CLIP: TrackNote[] = [
  ...CHORDS.flatMap((chord, bar) =>
    chord.flatMap((pitch, i): TrackNote[] => [
      [4 * bar, 2, pitch, 84 - 8 * i],
      [4 * bar + 2.5, 1.5, pitch, 66 - 6 * i],
    ])
  ),
  ...MELODY,
].sort((a, b) => a[0] - b[0] || a[2] - b[2]);

// the box of the drawing (its viewBox): the column of the keys left of the rows, the ruler over them, the lane of
// the velocities under them; the beats across (the loop and half a bar past its end), the pitches of the rows (C3 to
// C5, two octaves) and the beat the playhead is on (in the third bar)
export const ROLL = {
  width: 600,
  height: 400,
  keys: 48,
  top: 26,
  bottom: 302,
  laneTop: 316,
  laneBottom: 392,
  beats: 18,
  low: 48,
  high: 72,
  playhead: 9.25,
};

// the colors of the piano roll of the synth (ROLL_COLORS of its roll-draw.ts): its dark screen, its lines, the keys,
// the notes of the accent, the loop of the second accent
export const ROLL_COLORS = {
  background: '#121a22',
  ruler: '#17222c',
  line: '#2c3e50',
  high: '#5a7fa4',
  note: '#2ecc71',
  loop: '#3498db',
  keyWhite: '#ecf0f1',
  keyBlack: '#2c3e50',
  keyLine: '#bdc3c7',
  keyLabel: '#7f8c8d',
  playhead: '#ffffff',
};

export const ROW = (ROLL.bottom - ROLL.top) / (ROLL.high - ROLL.low + 1);
const BEAT = (ROLL.width - ROLL.keys) / ROLL.beats;

const round = (v: number) => Math.round(v * 100) / 100;

export const beatX = (beat: number) => ROLL.keys + beat * BEAT;
// the top of the row of a pitch
export const pitchY = (pitch: number) => ROLL.top + (ROLL.high - pitch) * ROW;

export const isBlack = (pitch: number) => [1, 3, 6, 8, 10].includes(pitch % 12);

// the name of a C (C4 is 60, as the synth names it); none for the other pitches
const cName = (pitch: number) => (pitch % 12 === 0 ? `C${pitch / 12 - 1}` : '');

// the color of a note of a velocity, from the dark of the lines (soft) to the full accent (loud), as the synth
// colors it
export const velocityColor = (velocity: number) =>
  mix(ROLL_COLORS.line, ROLL_COLORS.note, 0.35 + (0.65 * velocity) / 127);

// the rows from the top: each its pitch, top, whether its key is black, the name of a C
export const rollRows = () =>
  Array.from({ length: ROLL.high - ROLL.low + 1 }, (_, i) => {
    const pitch = ROLL.high - i;
    return { pitch, y: round(pitchY(pitch)), black: isBlack(pitch), name: cName(pitch) };
  });

// the lines between the white keys (under the black keys): through the middle of a black key, under a C and an F
export const keyLines = () =>
  rollRows().flatMap(({ pitch, y }) => {
    if (isBlack(pitch)) return [round(y + ROW / 2)];
    return pitch % 12 === 0 || pitch % 12 === 5 ? [round(y + ROW)] : [];
  });

export type LineKind = 'step' | 'beat' | 'bar';

// the lines of the grid: a sixteenth, a beat or a bar (its number in the ruler)
export const rollLines = () =>
  Array.from({ length: 4 * ROLL.beats + 1 }, (_, i) => {
    const beat = i / 4;
    const kind: LineKind = i % 16 === 0 ? 'bar' : i % 4 === 0 ? 'beat' : 'step';
    return { x: round(beatX(beat)), kind, bar: kind === 'bar' ? beat / 4 + 1 : 0 };
  });

const playing = ([start, length]: TrackNote) => start <= ROLL.playhead && ROLL.playhead < start + length;

// the notes as boxes: a unit between notes that follow each other, a unit over and under each in its row; those the
// playhead is in lighter, as the synth shows them
export const rollNotes = () =>
  TRACK_CLIP.map((note) => {
    const [start, length, pitch, velocity] = note;
    const color = velocityColor(velocity);
    const lit = playing(note);
    return {
      x: round(beatX(start)),
      y: round(pitchY(pitch) + 1),
      width: round(length * BEAT - 1),
      height: round(ROW - 2),
      color: lit ? mix(color, '#ffffff', 0.35) : color,
      playing: lit,
    };
  });

// a stem in the lane for each note, at its start, as high as its velocity
export const rollStems = () =>
  TRACK_CLIP.map(([start, , , velocity]) => ({
    x: round(beatX(start) + 2),
    top: round(ROLL.laneBottom - ((ROLL.laneBottom - ROLL.laneTop) * velocity) / 127),
    color: velocityColor(velocity),
  }));

export const PLAYHEAD_X = round(beatX(ROLL.playhead));
export const LOOP_END_X = round(beatX(TRACK_LOOP));
