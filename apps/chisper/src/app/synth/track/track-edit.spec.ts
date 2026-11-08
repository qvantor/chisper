import { CLIP_BAR, CLIP_NOTES_MAX, CLIP_PITCH_MIN, CLIP_PPQ, ClipNote } from '@chisper/preset-schema';
import {
  addNote,
  autoLength,
  copyNotes,
  drawDuration,
  duplicateNotes,
  finishNote,
  GRID_STEPS,
  gridIndex,
  gridTicks,
  insertNotes,
  legato,
  lengthLabel,
  lengthParts,
  loopLength,
  moveNotes,
  moveVelocity,
  noteAt,
  notesEnd,
  notesIn,
  notesLabel,
  paintVelocity,
  pasteNotes,
  positionLabel,
  quantize,
  remapSelection,
  removeNotes,
  resizeNotes,
  resizeTo,
  roundTick,
  snapTick,
  transpose,
  withLength,
  workspaceLength,
} from './track-edit';

const notes: ClipNote[] = [
  [0, 240, 60, 100],
  [240, 240, 64, 90],
  [480, 480, 67, 80],
];

describe('track edit', () => {
  it('has the steps of the grid, straight and triplets', () => {
    expect(gridTicks('1/16')).toBe(240);
    expect(gridTicks('1/8T')).toBe(320);
    expect(gridTicks('1/64T')).toBe(40);
    // an unknown one: 1/16
    expect(gridTicks('x')).toBe(240);
    expect(gridIndex('x')).toBe(gridIndex('1/16'));
  });

  it('orders the steps of the grid from the longest: the Grid value steps up to finer ones', () => {
    const ticks = GRID_STEPS.map((step) => step.ticks);
    expect(ticks).toEqual([...ticks].sort((a, b) => b - a));
    expect(GRID_STEPS[gridIndex('1/8') + 1].id).toBe('1/8T');
  });

  it('draws a note to the line of the grid nearest the pointer, a step at least', () => {
    expect(drawDuration(240, 250, 240)).toBe(240);
    expect(drawDuration(240, 700, 240)).toBe(480);
    expect(drawDuration(240, 100, 240)).toBe(240);
    // off the grid: to the tick
    expect(drawDuration(240, 251.4, 240, true)).toBe(11);
    expect(drawDuration(240, 240, 240, true)).toBe(1);
  });

  it('snaps a tick to the line at or before it, or to the nearest one', () => {
    expect(snapTick(250, 240)).toBe(240);
    expect(snapTick(250.4, 240, false)).toBe(250);
    expect(roundTick(130, 240)).toBe(240);
  });

  it('finds the note under a tick and a pitch', () => {
    expect(noteAt(notes, 300, 64)).toBe(1);
    expect(noteAt(notes, 480, 64)).toBe(-1);
    expect(noteAt(notes, 100, 64)).toBe(-1);
  });

  it('adds a note in its place of the order, selected', () => {
    expect(addNote(notes, 120, 62, 240)).toEqual({
      notes: [notes[0], [120, 240, 62, 100], notes[1], notes[2]],
      selected: [1],
    });
    const full = Array.from({ length: CLIP_NOTES_MAX }, (_, i): ClipNote => [i, 1, 60, 100]);
    expect(addNote(full, 0, 60, 1).notes).toHaveLength(CLIP_NOTES_MAX);
  });

  it('removes notes', () => {
    expect(removeNotes(notes, [0, 2])).toEqual([notes[1]]);
  });

  it('moves the selected notes, as far as the first of them can go', () => {
    const { notes: moved, selected, semitones } = moveNotes(notes, [0, 1], 480, 2, CLIP_BAR);
    expect(moved).toEqual([[480, 240, 62, 100], notes[2], [720, 240, 66, 90]]);
    expect(selected).toEqual([0, 2]);
    expect(semitones).toBe(2);
    // not before 0, not over 127 (the semitones they went)
    const up = moveNotes(notes, [1], -1000, 100, CLIP_BAR);
    expect(up.notes[1]).toEqual([0, 240, 127, 90]);
    expect(up.semitones).toBe(127 - notes[1][2]);
    // not past the end of the loop
    expect(moveNotes(notes, [2], 5000, 0, CLIP_PPQ).notes[2]).toEqual([959, 480, 67, 80]);
    // not under C0
    const down = moveNotes(notes, [0, 1], 0, -100, CLIP_BAR);
    expect(down.notes.map(([, , pitch]) => pitch)).toEqual([CLIP_PITCH_MIN, 16, 67]);
    expect(down.semitones).toBe(CLIP_PITCH_MIN - notes[0][2]);
    expect(addNote([], 0, 3, 240).notes[0][2]).toBe(CLIP_PITCH_MIN);
  });

  it('resizes the selected notes, each at least the minimum', () => {
    expect(resizeNotes(notes, [0, 2], 120).notes).toEqual([[0, 360, 60, 100], notes[1], [480, 600, 67, 80]]);
    expect(resizeNotes(notes, [0], -1000, 60).notes[0]).toEqual([0, 60, 60, 100]);
    // the right edge of note 1 dragged to 600: the others by as much
    expect(resizeTo(notes, [1, 2], 1, 600, 60).notes).toEqual([
      notes[0],
      [240, 360, 64, 90],
      [480, 600, 67, 80],
    ]);
  });

  it('transposes the selected notes', () => {
    expect(transpose(notes, [2], 12).notes[2]).toEqual([480, 480, 79, 80]);
  });

  it('quantizes the starts and the ends of the selected notes, all of them when none is', () => {
    const loose: ClipNote[] = [
      [10, 200, 60, 100],
      [250, 10, 62, 100],
    ];
    expect(quantize(loose, [], 240).notes).toEqual([
      [0, 240, 60, 100],
      [240, 240, 62, 100],
    ]);
    expect(quantize(loose, [1], 240)).toEqual({
      notes: [loose[0], [240, 240, 62, 100]],
      selected: [1],
    });
  });

  it('makes the notes legato: each up to the next start, the last to the end of the loop', () => {
    const chord: ClipNote[] = [
      [0, 10, 60, 100],
      [0, 10, 64, 100],
      [480, 10, 67, 100],
    ];
    expect(legato(chord, [], CLIP_PPQ).notes).toEqual([
      [0, 480, 60, 100],
      [0, 480, 64, 100],
      [480, 480, 67, 100],
    ]);
  });

  it('moves the velocities of the selected notes together by one of them, each within 1..127', () => {
    const velocities = (edit: { notes: ClipNote[] }) => edit.notes.map(([, , , velocity]) => velocity);
    // the first to 110: the second as much
    expect(velocities(moveVelocity(notes, [0, 1], 0, 110))).toEqual([110, 100, 80]);
    // the second to 120: the first past the most stays at it
    expect(velocities(moveVelocity(notes, [0, 1], 1, 120))).toEqual([127, 120, 80]);
    expect(velocities(moveVelocity(notes, [0, 1, 2], 2, 0))).toEqual([21, 11, 1]);
    expect(moveVelocity(notes, [2], 2, 200).notes[2][3]).toBe(127);
  });

  it('selects the notes a rectangle touches', () => {
    expect(notesIn(notes, 200, 500, 60, 66)).toEqual([0, 1]);
    expect(notesIn(notes, 500, 200, 66, 60)).toEqual([0, 1]);
    expect(notesIn(notes, 0, 2000, 70, 80)).toEqual([]);
  });

  it('copies, pastes and duplicates the selected notes', () => {
    const copied = copyNotes(notes, [1, 2]);
    expect(copied).toEqual([
      [0, 240, 64, 90],
      [240, 480, 67, 80],
    ]);
    expect(pasteNotes(notes, copied, 960, CLIP_BAR)).toEqual({
      notes: [...notes, [960, 240, 64, 90], [1200, 480, 67, 80]],
      selected: [3, 4],
    });
    // past the end of the loop: left out
    expect(pasteNotes(notes, copied, 1100, 1200).notes).toHaveLength(4);
    // after the last of them, on the grid
    expect(duplicateNotes(notes, [0, 1], 240, CLIP_BAR)).toEqual({
      notes: [notes[0], notes[1], [480, 240, 60, 100], notes[2], [720, 240, 64, 90]],
      selected: [2, 4],
    });
  });

  it('paints the velocities of the notes along a line', () => {
    const velocities = (painted: ClipNote[]) => painted.map(([, , , v]) => v);
    // from 40 at 0 to 120 at 480: the note at 240 gets 80
    expect(velocities(paintVelocity(notes, [0, 40], [480, 120]))).toEqual([40, 80, 120]);
    // drawn backwards: the same
    expect(velocities(paintVelocity(notes, [480, 120], [0, 40]))).toEqual([40, 80, 120]);
    // a point paints the notes at it
    expect(velocities(paintVelocity(notes, [240, 127], [240, 127]))).toEqual([100, 127, 80]);
    // within the velocities
    expect(paintVelocity(notes, [0, -50], [480, 178])).toEqual([
      [0, 240, 60, 1],
      [240, 240, 64, 64],
      [480, 480, 67, 127],
    ]);
  });

  it('drops the notes past a shorter loop, ends those through its end there', () => {
    expect(withLength(notes, 480)).toEqual([notes[0], notes[1]]);
    expect(withLength(notes, 600)).toEqual([notes[0], notes[1], [480, 120, 67, 80]]);
  });

  it('ends a loop of notes at the end of the bar the last of them ends in, a bar at least', () => {
    expect(notesEnd([])).toBe(CLIP_BAR);
    expect(notesEnd(notes)).toBe(CLIP_BAR);
    expect(notesEnd([[3 * CLIP_BAR, CLIP_PPQ, 60, 100]])).toBe(4 * CLIP_BAR);
    // through the line of a bar: to the end of the next one
    expect(notesEnd([[CLIP_BAR - 10, 20, 60, 100]])).toBe(2 * CLIP_BAR);
    expect(notesEnd([[0, CLIP_BAR, 60, 100]])).toBe(CLIP_BAR);
  });

  it('takes the loop by the notes: 4 bars, longer to the end of their bar; keeps an end set apart by its flag', () => {
    const inBar = (bar: number): ClipNote[] => [[(bar - 1) * CLIP_BAR, CLIP_PPQ, 60, 100]];
    expect(autoLength([])).toBe(4 * CLIP_BAR);
    expect(autoLength(inBar(6))).toBe(6 * CLIP_BAR);
    // by the notes: 4 bars at least, grows and shrinks with them
    expect(loopLength({ length: 4 * CLIP_BAR, notes: [] }, inBar(3))).toBe(4 * CLIP_BAR);
    expect(loopLength({ length: 4 * CLIP_BAR, notes: inBar(3) }, inBar(6))).toBe(6 * CLIP_BAR);
    expect(loopLength({ length: 6 * CLIP_BAR, notes: inBar(6) }, inBar(1))).toBe(4 * CLIP_BAR);
    // shorter by its flag: kept while they end within it, a note past it takes it to the end of its bar
    expect(loopLength({ length: 2 * CLIP_BAR, notes: inBar(1) }, inBar(2))).toBe(2 * CLIP_BAR);
    expect(loopLength({ length: 2 * CLIP_BAR, notes: inBar(1) }, inBar(3))).toBe(3 * CLIP_BAR);
    expect(loopLength({ length: CLIP_PPQ, notes: [] }, [[0, 240, 60, 100]])).toBe(CLIP_PPQ);
    expect(loopLength({ length: 2 * CLIP_BAR, notes: inBar(1) }, [])).toBe(2 * CLIP_BAR);
    // longer by its flag (silence after them): kept
    expect(loopLength({ length: 6 * CLIP_BAR, notes: inBar(3) }, inBar(1))).toBe(6 * CLIP_BAR);
  });

  it('shows 5 bars at least, 2 empty ones after the notes, one after the loop, growing by 2', () => {
    const inBar = (bar: number): ClipNote[] => [[(bar - 1) * CLIP_BAR, CLIP_PPQ, 60, 100]];
    // a new clip: its loop of 4 bars in 5
    expect(workspaceLength([], 4 * CLIP_BAR)).toBe(5 * CLIP_BAR);
    expect(workspaceLength(inBar(3), 4 * CLIP_BAR)).toBe(5 * CLIP_BAR);
    // a note in the 4th of 5: 2 more
    expect(workspaceLength(inBar(4), 4 * CLIP_BAR)).toBe(7 * CLIP_BAR);
    expect(workspaceLength(inBar(5), 5 * CLIP_BAR)).toBe(7 * CLIP_BAR);
    expect(workspaceLength(inBar(6), 6 * CLIP_BAR)).toBe(9 * CLIP_BAR);
    // a loop of 5 or 6 bars by its flag: a bar after it at least
    expect(workspaceLength(inBar(1), 5 * CLIP_BAR)).toBe(7 * CLIP_BAR);
    expect(workspaceLength(inBar(1), 6 * CLIP_BAR)).toBe(7 * CLIP_BAR);
    // within the longest loop
    expect(workspaceLength(inBar(32), 32 * CLIP_BAR)).toBe(32 * CLIP_BAR);
  });

  it('splits the length into bars, beats and sixteenths', () => {
    expect(lengthParts(2 * CLIP_BAR + CLIP_PPQ + 240)).toEqual([2, 1, 1]);
  });

  it('tells the length and the count of the notes in words', () => {
    expect(lengthLabel(4 * CLIP_BAR)).toBe('4 bars');
    expect(lengthLabel(CLIP_BAR + CLIP_PPQ)).toBe('1 bar 1 beat');
    expect(lengthLabel(3 * CLIP_PPQ + 480)).toBe('3 beats 2/16');
    expect(notesLabel(1)).toBe('1 note');
    expect(notesLabel(0)).toBe('0 notes');
  });

  it('labels a position bar.beat from 1', () => {
    expect(positionLabel(0)).toBe('1.1');
    expect(positionLabel(CLIP_BAR + 2 * CLIP_PPQ + 10)).toBe('2.3');
  });

  describe('recording', () => {
    const length = 4 * CLIP_BAR;

    it('finishes a held note from its place in the loop, a tick long at least, cut at its end', () => {
      expect(finishNote({ tick: 480.4, pitch: 60, velocity: 90 }, 959.6, length)).toEqual([480, 480, 60, 90]);
      // pressed in the second pass: its place in the loop
      expect(finishNote({ tick: length + 100, pitch: 62, velocity: 64 }, length + 400, length)).toEqual([
        100, 300, 62, 64,
      ]);
      // released where it was pressed: a tick
      expect(finishNote({ tick: 10, pitch: 60, velocity: 100 }, 10, length)).toEqual([10, 1, 60, 100]);
      // held through the end of the loop: it ends there
      expect(finishNote({ tick: length - 200, pitch: 60, velocity: 100 }, length + 500, length)).toEqual([
        length - 200,
        200,
        60,
        100,
      ]);
      // under C0: an octave up (a clip has no note there), as a .mid's; above G9: G9
      expect(finishNote({ tick: 0, pitch: 5, velocity: 100 }, 10, length)[2]).toBe(17);
      expect(finishNote({ tick: 0, pitch: 12, velocity: 100 }, 10, length)[2]).toBe(12);
      expect(finishNote({ tick: 0, pitch: 130, velocity: 100 }, 10, length)[2]).toBe(127);
      // the loops from an origin (a pass REC ran the loop on from): its place from there
      expect(finishNote({ tick: 5000 + 100, pitch: 60, velocity: 90 }, 5000 + 400, length, 5000)).toEqual([
        100, 300, 60, 90,
      ]);
      // a tick before the end rounds into the next loop: at its start
      expect(finishNote({ tick: length - 0.2, pitch: 60, velocity: 100 }, length + 100, length)).toEqual([
        0, 100, 60, 100,
      ]);
    });

    it('adds recorded notes in their order, the notes there the same, none equal to one there or past the most', () => {
      const added: ClipNote[] = [
        [240, 120, 62, 70],
        [0, 240, 60, 100],
      ];
      const next = insertNotes(notes, added);
      expect(next).toEqual([notes[0], [240, 120, 62, 70], notes[1], notes[2]]);
      notes.forEach((note) => expect(next).toContain(note));
      const full = Array.from({ length: CLIP_NOTES_MAX }, (_, i): ClipNote => [i, 1, 60, 100]);
      expect(insertNotes(full, added)).toHaveLength(CLIP_NOTES_MAX);
    });

    it('keeps the selection on the same notes after notes were added among them', () => {
      const next = insertNotes(notes, [
        [0, 10, 50, 100],
        [300, 10, 50, 100],
      ]);
      expect(remapSelection(notes, next, [0, 2])).toEqual([1, 4]);
      expect(remapSelection(notes, next, [])).toEqual([]);
      // a note gone: left out
      expect(remapSelection(notes, notes.slice(1), [0, 1])).toEqual([0]);
    });
  });
});
