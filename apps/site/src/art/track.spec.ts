import {
  LOOP_END_X,
  PLAYHEAD_X,
  ROLL,
  ROW,
  TRACK_CLIP,
  TRACK_LOOP,
  beatX,
  isBlack,
  keyLines,
  pitchY,
  rollLines,
  rollNotes,
  rollRows,
  rollStems,
  velocityColor,
} from './track';

describe('the clip of the page', () => {
  it('is a loop of chords and a melody inside the rows of the drawing, sorted by start', () => {
    expect(TRACK_CLIP.length).toBeGreaterThan(40);
    for (const [start, length, pitch, velocity] of TRACK_CLIP) {
      expect(start).toBeGreaterThanOrEqual(0);
      expect(start + length).toBeLessThanOrEqual(TRACK_LOOP);
      expect(length).toBeGreaterThan(0);
      expect(pitch).toBeGreaterThanOrEqual(ROLL.low);
      expect(pitch).toBeLessThanOrEqual(ROLL.high);
      expect(velocity).toBeGreaterThanOrEqual(1);
      expect(velocity).toBeLessThanOrEqual(127);
    }
    const starts = TRACK_CLIP.map(([start]) => start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    // a chord on the first beat of every bar
    for (const bar of [0, 4, 8, 12])
      expect(TRACK_CLIP.filter(([start]) => start === bar).length).toBeGreaterThanOrEqual(3);
  });

  it('never plays a pitch over itself', () => {
    for (const [i, [start, length, pitch]] of TRACK_CLIP.entries()) {
      for (const [other, length2, pitch2] of TRACK_CLIP.slice(i + 1)) {
        if (pitch === pitch2) expect(other >= start + length || start >= other + length2).toBe(true);
      }
    }
  });
});

describe('the piano roll of the drawing', () => {
  it('lays the rows of two octaves from C5 down to C3 between the ruler and the lane, C named', () => {
    const rows = rollRows();
    expect(rows).toHaveLength(25);
    expect(rows[0]).toMatchObject({ pitch: 72, y: ROLL.top, name: 'C5' });
    expect(rows.at(-1)?.name).toBe('C3');
    expect(rows.filter(({ name }) => name).map(({ name }) => name)).toEqual(['C5', 'C4', 'C3']);
    expect(pitchY(ROLL.low) + ROW).toBeCloseTo(ROLL.bottom, 9);
    expect(ROLL.bottom).toBeLessThan(ROLL.laneTop);
  });

  it('has the black keys of a piano: five an octave, never two side by side', () => {
    const black = rollRows().filter(({ black }) => black);
    expect(black.map(({ pitch }) => pitch % 12).slice(0, 5)).toEqual([10, 8, 6, 3, 1]);
    expect(black).toHaveLength(10);
    for (const { pitch } of black) expect(isBlack(pitch + 1) || isBlack(pitch - 1)).toBe(false);
    // a line through each black key and between the white keys side by side (B and C, E and F; under C3 the edge)
    expect(keyLines()).toHaveLength(10 + 5);
  });

  it('draws a line every sixteenth, brighter on the beats, brightest and numbered on the bars', () => {
    const lines = rollLines();
    expect(lines).toHaveLength(4 * ROLL.beats + 1);
    expect(lines[0]).toMatchObject({ x: ROLL.keys, kind: 'bar', bar: 1 });
    expect(lines.filter(({ kind }) => kind === 'bar').map(({ bar }) => bar)).toEqual([1, 2, 3, 4, 5]);
    expect(lines.filter(({ kind }) => kind === 'beat')).toHaveLength(ROLL.beats - 4);
    expect(lines.at(-1)?.x).toBeCloseTo(ROLL.width, 1);
  });

  it('draws every note in its row and at its time, inside the loop', () => {
    const notes = rollNotes();
    expect(notes).toHaveLength(TRACK_CLIP.length);
    notes.forEach((note, i) => {
      const [start, length, pitch] = TRACK_CLIP[i];
      expect(note.x).toBeCloseTo(beatX(start), 1);
      expect(note.x + note.width).toBeLessThanOrEqual(LOOP_END_X);
      expect(note.y).toBeCloseTo(pitchY(pitch) + 1, 1);
      expect(note.height).toBeCloseTo(ROW - 2, 1);
      expect(note.width).toBeCloseTo((length * (ROLL.width - ROLL.keys)) / ROLL.beats - 1, 1);
    });
  });

  it('colors a note by its velocity, those under the playhead lighter', () => {
    expect(velocityColor(127)).toBe('#2ecc71');
    expect(velocityColor(1)).not.toBe(velocityColor(127));
    const notes = rollNotes();
    const playing = notes.filter(({ playing }) => playing);
    // the chord of the third bar and a note of the melody
    expect(playing).toHaveLength(4);
    for (const note of playing) {
      expect(note.x).toBeLessThanOrEqual(PLAYHEAD_X);
      expect(note.x + note.width).toBeGreaterThan(PLAYHEAD_X);
    }
    notes.forEach((note, i) => {
      if (!note.playing) expect(note.color).toBe(velocityColor(TRACK_CLIP[i][3]));
      else expect(note.color).not.toBe(velocityColor(TRACK_CLIP[i][3]));
    });
    expect(PLAYHEAD_X).toBeGreaterThan(beatX(8));
    expect(PLAYHEAD_X).toBeLessThan(beatX(12));
  });

  it('puts a stem for every note in the lane, as high as its velocity', () => {
    const stems = rollStems();
    expect(stems).toHaveLength(TRACK_CLIP.length);
    stems.forEach(({ x, top, color }, i) => {
      const [start, , , velocity] = TRACK_CLIP[i];
      expect(x).toBeCloseTo(beatX(start) + 2, 1);
      expect(top).toBeGreaterThanOrEqual(ROLL.laneTop);
      expect(top).toBeLessThan(ROLL.laneBottom);
      expect(color).toBe(velocityColor(velocity));
    });
    const loudest = TRACK_CLIP.reduce((best, note, i) => (note[3] > TRACK_CLIP[best][3] ? i : best), 0);
    expect(Math.min(...stems.map(({ top }) => top))).toBe(stems[loudest].top);
  });
});
