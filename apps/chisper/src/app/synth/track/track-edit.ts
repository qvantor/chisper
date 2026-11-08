import {
  CLIP_BAR,
  CLIP_LENGTH_DEFAULT,
  CLIP_LENGTH_MAX,
  CLIP_NOTES_MAX,
  CLIP_PITCH_MAX,
  CLIP_PITCH_MIN,
  CLIP_PPQ,
  CLIP_VELOCITY_MAX,
  CLIP_VELOCITY_MIN,
  ClipNote,
  compareNotes,
  sameNote,
} from '@chisper/preset-schema';
import { loopTick } from './track-events';

// the edits of the piano roll: pure functions of the notes of a clip (sorted by compareNotes) and the indexes of the
// selected ones; each returns the notes sorted again and where the selected ones went

export interface Edit {
  notes: ClipNote[];
  selected: number[];
}

// the steps of the grid: 1/4 .. 1/64, straight and triplets (ticks), from the longest (the Grid value steps through
// them: up is finer)
export interface GridStep {
  id: string;
  ticks: number;
}
export const GRID_STEPS: GridStep[] = [
  { id: '1/4', ticks: CLIP_PPQ },
  { id: '1/4T', ticks: (CLIP_PPQ * 2) / 3 },
  { id: '1/8', ticks: CLIP_PPQ / 2 },
  { id: '1/8T', ticks: CLIP_PPQ / 3 },
  { id: '1/16', ticks: CLIP_PPQ / 4 },
  { id: '1/16T', ticks: CLIP_PPQ / 6 },
  { id: '1/32', ticks: CLIP_PPQ / 8 },
  { id: '1/32T', ticks: CLIP_PPQ / 12 },
  { id: '1/64', ticks: CLIP_PPQ / 16 },
  { id: '1/64T', ticks: CLIP_PPQ / 24 },
];
export const GRID_DEFAULT = '1/16';
// the index of a step (the default one's for an unknown id)
export const gridIndex = (id: string) => {
  const index = GRID_STEPS.findIndex((step) => step.id === id);
  return index >= 0 ? index : GRID_STEPS.findIndex((step) => step.id === GRID_DEFAULT);
};
export const gridTicks = (id: string) => GRID_STEPS[gridIndex(id)].ticks;

// the velocity of a new note
export const NEW_VELOCITY = 100;

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

// a pitch of a clip: under C0 (no note of a clip is) up by the octaves it takes, at most G9
export const withinPitches = (pitch: number) =>
  Math.min(
    CLIP_PITCH_MAX,
    pitch < CLIP_PITCH_MIN ? pitch + 12 * Math.ceil((CLIP_PITCH_MIN - pitch) / 12) : pitch
  );

// `notes` sorted, the indexes of those of `selected` (indexes into `notes` before the sort) after it
const sorted = (notes: ClipNote[], selected: Iterable<number>): Edit => {
  const chosen = new Set(selected);
  const order = notes.map((note, index) => ({ note, index })).sort((a, b) => compareNotes(a.note, b.note));
  return {
    notes: order.map(({ note }) => note),
    selected: order.flatMap(({ index }, at) => (chosen.has(index) ? [at] : [])),
  };
};

// a tick on the grid (the line at or before it); off the grid (snap off) the tick itself
export const snapTick = (tick: number, grid: number, snap = true) =>
  snap ? Math.floor(tick / grid) * grid : Math.round(tick);

// a tick to the nearest line of the grid
export const roundTick = (tick: number, grid: number) => Math.round(tick / grid) * grid;

// the note under `tick` and `pitch` (the last one of those: drawn on top), -1: none
export const noteAt = (notes: readonly ClipNote[], tick: number, pitch: number) => {
  for (let i = notes.length - 1; i >= 0; i -= 1) {
    const [start, duration, notePitch] = notes[i];
    if (notePitch === pitch && start <= tick && tick < start + duration) return i;
  }
  return -1;
};

// a note added at `start` of `pitch` (one step of the grid long), selected alone; none past the most notes
export const addNote = (
  notes: readonly ClipNote[],
  start: number,
  pitch: number,
  duration: number,
  velocity = NEW_VELOCITY
): Edit => {
  if (notes.length >= CLIP_NOTES_MAX) return { notes: [...notes], selected: [] };
  const note: ClipNote = [
    Math.max(0, Math.round(start)),
    Math.max(1, Math.round(duration)),
    clamp(Math.round(pitch), CLIP_PITCH_MIN, CLIP_PITCH_MAX),
    clamp(Math.round(velocity), CLIP_VELOCITY_MIN, CLIP_VELOCITY_MAX),
  ];
  return sorted([...notes, note], [notes.length]);
};

export const removeNotes = (notes: readonly ClipNote[], indexes: Iterable<number>): ClipNote[] => {
  const removed = new Set(indexes);
  return notes.filter((_, index) => !removed.has(index));
};

// the selected notes moved by `ticks` and `semitones`, all of them as far as the first one can go (from 0, before
// the end of the loop, within the pitches); `semitones` of the edit: how far they went
export const moveNotes = (
  notes: readonly ClipNote[],
  indexes: readonly number[],
  ticks: number,
  semitones: number,
  length: number
): Edit & { semitones: number } => {
  if (indexes.length === 0) return { notes: [...notes], selected: [], semitones: 0 };
  const moved = indexes.map((index) => notes[index]);
  const starts = moved.map(([start]) => start);
  const pitches = moved.map(([, , pitch]) => pitch);
  const dt = clamp(Math.round(ticks), -Math.min(...starts), length - 1 - Math.max(...starts));
  const dp = clamp(
    Math.round(semitones),
    CLIP_PITCH_MIN - Math.min(...pitches),
    CLIP_PITCH_MAX - Math.max(...pitches)
  );
  const chosen = new Set(indexes);
  const edit = sorted(
    notes.map((note, index) =>
      chosen.has(index) ? ([note[0] + dt, note[1], note[2] + dp, note[3]] as ClipNote) : note
    ),
    indexes
  );
  return { ...edit, semitones: dp };
};

// the selected notes longer or shorter by `ticks`, each at least `min` long (a step of the grid, 1 off it)
export const resizeNotes = (
  notes: readonly ClipNote[],
  indexes: readonly number[],
  ticks: number,
  min = 1
): Edit => {
  const chosen = new Set(indexes);
  return sorted(
    notes.map((note, index) =>
      chosen.has(index)
        ? ([
            note[0],
            clamp(Math.round(note[1] + ticks), Math.min(min, note[1]), CLIP_LENGTH_MAX),
            note[2],
            note[3],
          ] as ClipNote)
        : note
    ),
    indexes
  );
};

// the selected notes end at `end` (their right edge dragged to the tick of the pointer), each at least `min` long
export const resizeTo = (
  notes: readonly ClipNote[],
  indexes: readonly number[],
  anchor: number,
  end: number,
  min = 1
) => {
  const [start, duration] = notes[anchor];
  return resizeNotes(notes, indexes, Math.max(min, end - start) - duration, min);
};

export const transpose = (notes: readonly ClipNote[], indexes: readonly number[], semitones: number) =>
  moveNotes(notes, indexes, 0, semitones, CLIP_LENGTH_MAX);

// the selected notes (all of them when none is) on the grid: their starts and ends to the nearest lines, each at least
// a step long
export const quantize = (notes: readonly ClipNote[], indexes: readonly number[], grid: number): Edit => {
  const chosen = new Set(indexes.length ? indexes : notes.map((_, index) => index));
  return sorted(
    notes.map((note, index) => {
      if (!chosen.has(index)) return note;
      const start = roundTick(note[0], grid);
      const end = Math.max(start + grid, roundTick(note[0] + note[1], grid));
      return [start, end - start, note[2], note[3]] as ClipNote;
    }),
    indexes
  );
};

// legato: each of the selected notes (all of them when none is) lasts up to the start of the next note after it (of
// any pitch), the last ones to the end of the loop
export const legato = (notes: readonly ClipNote[], indexes: readonly number[], length: number): Edit => {
  const chosen = new Set(indexes.length ? indexes : notes.map((_, index) => index));
  const starts = [...new Set(notes.map(([start]) => start))].sort((a, b) => a - b);
  return sorted(
    notes.map((note, index) => {
      if (!chosen.has(index)) return note;
      const next = starts.find((start) => start > note[0]) ?? Math.max(length, note[0] + 1);
      return [note[0], next - note[0], note[2], note[3]] as ClipNote;
    }),
    indexes
  );
};

// the length of a note drawn from `start` to the pointer at `tick`: its end at the nearest line of the grid, a step
// at least (off the grid: the tick, a tick at least)
export const drawDuration = (start: number, tick: number, step: number, free = false) => {
  const end = free ? Math.round(tick) : roundTick(tick, step);
  return Math.min(CLIP_LENGTH_MAX, Math.max(free ? 1 : step, end - start));
};

// velocities painted along a line from [tick, velocity] to [tick, velocity]: the notes that start within its ticks
// get its velocity at their start (in their order: notes it could reorder start together, they get one velocity)
export const paintVelocity = (
  notes: readonly ClipNote[],
  [t0, v0]: [number, number],
  [t1, v1]: [number, number]
): ClipNote[] => {
  const [from, to] = [Math.min(t0, t1), Math.max(t0, t1)];
  const at = (tick: number) => (t1 === t0 ? v1 : v0 + ((v1 - v0) * (tick - t0)) / (t1 - t0));
  return notes.map((note) => {
    const [start, duration, pitch] = note;
    if (start < from || start > to) return note;
    const velocity = clamp(Math.round(at(start)), CLIP_VELOCITY_MIN, CLIP_VELOCITY_MAX);
    return [start, duration, pitch, velocity] as ClipNote;
  });
};

// the velocities of the selected notes moved together: `anchor` (one of them) to `velocity`, the others by as much
// (they keep their differences; each within 1..127)
export const moveVelocity = (
  notes: readonly ClipNote[],
  indexes: readonly number[],
  anchor: number,
  velocity: number
): Edit => {
  const chosen = new Set(indexes);
  const by = clamp(Math.round(velocity), CLIP_VELOCITY_MIN, CLIP_VELOCITY_MAX) - notes[anchor][3];
  const moved = (value: number) => clamp(value + by, CLIP_VELOCITY_MIN, CLIP_VELOCITY_MAX);
  return sorted(
    notes.map((note, index) =>
      chosen.has(index) ? ([note[0], note[1], note[2], moved(note[3])] as ClipNote) : note
    ),
    indexes
  );
};

// the notes that a rectangle of ticks [t0, t1) and pitches [p0, p1] touches
export const notesIn = (notes: readonly ClipNote[], t0: number, t1: number, p0: number, p1: number) =>
  notes.flatMap(([start, duration, pitch], index) =>
    start < Math.max(t0, t1) &&
    start + duration > Math.min(t0, t1) &&
    pitch >= Math.min(p0, p1) &&
    pitch <= Math.max(p0, p1)
      ? [index]
      : []
  );

// copied notes: their starts from the first one of them
export const copyNotes = (notes: readonly ClipNote[], indexes: readonly number[]): ClipNote[] => {
  const copied = indexes.map((index) => notes[index]);
  if (!copied.length) return [];
  const first = Math.min(...copied.map(([start]) => start));
  return copied.map(([start, duration, pitch, velocity]) => [start - first, duration, pitch, velocity]);
};

// copied notes added from `at` (those that would start past the loop left out), selected
export const pasteNotes = (
  notes: readonly ClipNote[],
  copied: readonly ClipNote[],
  at: number,
  length: number
): Edit => {
  const added = copied
    .map(([start, duration, pitch, velocity]): ClipNote => [start + at, duration, pitch, velocity])
    .filter(([start]) => start < length)
    .slice(0, Math.max(0, CLIP_NOTES_MAX - notes.length));
  return sorted(
    [...notes, ...added],
    added.map((_, k) => notes.length + k)
  );
};

// the selected notes again right after them (from the end of the last one, on the grid), selected
export const duplicateNotes = (
  notes: readonly ClipNote[],
  indexes: readonly number[],
  grid: number,
  length: number
): Edit => {
  if (!indexes.length) return { notes: [...notes], selected: [] };
  const copied = indexes.map((index) => notes[index]);
  const first = Math.min(...copied.map(([start]) => start));
  const end = Math.max(...copied.map(([start, duration]) => start + duration));
  const span = Math.max(grid, Math.ceil((end - first) / grid) * grid);
  return pasteNotes(notes, copyNotes(notes, indexes), first + span, length);
};

// a note of a recording while it is held: where it was pressed (ticks from beat 0 of the transport, over the loops),
// its pitch and velocity
export interface HeldNote {
  tick: number;
  pitch: number;
  velocity: number;
}

// a held note of a recording as a note of the loop up to `end` (ticks over the loops; the loops from `origin`): from
// its place in the loop, a tick long at least, cut at the end of the loop (held through it: it doesn't go on from its
// start); under C0 an octave up, as a .mid's
export const finishNote = (
  { tick, pitch, velocity }: HeldNote,
  end: number,
  length: number,
  origin = 0
): ClipNote => {
  const from = Math.round(tick - origin);
  const start = loopTick(from, length);
  const duration = clamp(Math.round(end - origin) - from, 1, length - start);
  return [start, duration, withinPitches(pitch), clamp(velocity, CLIP_VELOCITY_MIN, CLIP_VELOCITY_MAX)];
};

// notes recorded added to the notes (sorted again; the notes there kept as they are, the same arrays), those equal to
// a note there left out, none past the most notes
export const insertNotes = (notes: readonly ClipNote[], added: readonly ClipNote[]): ClipNote[] => {
  const next = [...notes];
  added.forEach((note) => {
    if (next.length < CLIP_NOTES_MAX && !next.some((other) => sameNote(other, note))) next.push(note);
  });
  return next.sort(compareNotes);
};

// the selection (indexes into `before`) after the notes became `after`: the same notes where they went, those gone
// left out
export const remapSelection = (
  before: readonly ClipNote[],
  after: readonly ClipNote[],
  selected: readonly number[]
) => {
  const index = new Map(after.map((note, at) => [note, at]));
  return selected
    .flatMap((at) => {
      const moved = index.get(before[at]);
      return moved === undefined ? [] : [moved];
    })
    .sort((a, b) => a - b);
};

// the notes when the loop is `length` long (its end set by its flag): those that start at its end or after it go,
// those through it end there
export const withLength = (notes: readonly ClipNote[], length: number) =>
  notes
    .filter(([start]) => start < length)
    .map((note): ClipNote => {
      const [start, duration, pitch, velocity] = note;
      return start + duration > length ? [start, length - start, pitch, velocity] : note;
    });

// the tick the last of the notes ends at (0: none)
const lastEnd = (notes: readonly ClipNote[]) =>
  notes.reduce((end, [start, duration]) => Math.max(end, start + duration), 0);

// the loop of the notes: up to the end of the bar the last of them ends in, a bar at least
export const notesEnd = (notes: readonly ClipNote[]) =>
  Math.min(CLIP_LENGTH_MAX, Math.max(1, Math.ceil(lastEnd(notes) / CLIP_BAR)) * CLIP_BAR);

// the loop the notes make by themselves: 4 bars (a new clip's), longer up to the end of the bar the last of them ends in
export const autoLength = (notes: readonly ClipNote[]) => Math.max(CLIP_LENGTH_DEFAULT, notesEnd(notes));

// the loop after an edit of its notes: by the notes (autoLength), unless its end was set apart from them by its flag
// (shorter, a beat of a loop; or longer, silence after them): then it stays while they end within it, a note past it
// takes it to the end of its bar
export const loopLength = (
  before: { length: number; notes: readonly ClipNote[] },
  notes: readonly ClipNote[]
) => {
  if (before.length === autoLength(before.notes)) return autoLength(notes);
  return lastEnd(notes) <= before.length ? before.length : notesEnd(notes);
};

// the bars the roll shows: 5 at least, 2 empty ones at least after the bar the notes end in (a bar after the end of the
// loop: room to drag its flag on), growing by 2 (a note put in the 4th of 5 bars shows 7); within the longest loop
export const WORKSPACE_BARS = 5;
const WORKSPACE_AHEAD = 2;
const WORKSPACE_STEP = 2;
export const workspaceLength = (notes: readonly ClipNote[], length: number) => {
  const used = Math.max(Math.ceil(lastEnd(notes) / CLIP_BAR), Math.ceil(length / CLIP_BAR) - 1);
  let bars = WORKSPACE_BARS;
  while (bars - used < WORKSPACE_AHEAD) bars += WORKSPACE_STEP;
  return Math.min(CLIP_LENGTH_MAX, bars * CLIP_BAR);
};

// the length of the loop split: bars, beats and sixteenths
export const lengthParts = (length: number): [number, number, number] => [
  Math.floor(length / CLIP_BAR),
  Math.floor((length % CLIP_BAR) / CLIP_PPQ),
  Math.floor((length % CLIP_PPQ) / (CLIP_PPQ / 4)),
];

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

// the length of the loop in words: 4 bars, 2 bars 1 beat, 3 beats 2/16
export const lengthLabel = (length: number) => {
  const [bars, beats, sixteenths] = lengthParts(length);
  return [
    bars ? plural(bars, 'bar') : '',
    beats ? plural(beats, 'beat') : '',
    sixteenths ? `${sixteenths}/16` : '',
  ]
    .filter(Boolean)
    .join(' ');
};

export const notesLabel = (count: number) => plural(count, 'note');

// a position of the loop (ticks) as bar.beat, from 1
export const positionLabel = (tick: number) =>
  `${Math.floor(tick / CLIP_BAR) + 1}.${Math.floor((tick % CLIP_BAR) / CLIP_PPQ) + 1}`;
