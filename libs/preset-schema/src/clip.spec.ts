import {
  CLIP_LENGTH_MAX,
  CLIP_NAME_REFUSED,
  CLIP_PPQ,
  CLIP_NOTES_MAX,
  ClipNote,
  clipHash,
  clipNameAllowed,
  clipSchema,
  emptyClip,
  normalizeClip,
  saveClipRequestSchema,
  updateClipRequestSchema,
} from './clip';

const clip = {
  bpm: 128,
  length: 4 * 3840,
  notes: [
    [960, 480, 64, 100],
    [0, 960, 60, 90],
    [0, 960, 48, 80],
  ] as ClipNote[],
};

describe('clip schema', () => {
  it('takes a clip of whole ticks', () => {
    expect(clipSchema.parse(clip)).toEqual(clip);
  });

  it('puts the tempo on the grid of the field, refuses one out of range', () => {
    expect(clipSchema.parse({ ...clip, bpm: 128.123 }).bpm).toBe(128.12);
    expect(() => clipSchema.parse({ ...clip, bpm: 10 })).toThrow();
    expect(() => clipSchema.parse({ ...clip, bpm: 400 })).toThrow();
  });

  it('keeps the length within a beat and 32 bars', () => {
    expect(clipSchema.parse({ ...clip, length: CLIP_PPQ }).length).toBe(CLIP_PPQ);
    expect(clipSchema.parse({ ...clip, length: CLIP_LENGTH_MAX }).length).toBe(122880);
    expect(() => clipSchema.parse({ ...clip, length: CLIP_PPQ - 1 })).toThrow();
    expect(() => clipSchema.parse({ ...clip, length: CLIP_LENGTH_MAX + 1 })).toThrow();
    expect(() => clipSchema.parse({ ...clip, length: 1000.5 })).toThrow();
  });

  it.each([
    ['a fractional start', [0.5, 10, 60, 100]],
    ['a negative start', [-1, 10, 60, 100]],
    ['no duration', [0, 0, 60, 100]],
    ['a pitch over 127', [0, 10, 128, 100]],
    ['a pitch under C0', [0, 10, 11, 100]],
    ['velocity 0', [0, 10, 60, 0]],
    ['velocity over 127', [0, 10, 60, 128]],
    ['a missing value', [0, 10, 60]],
  ])('refuses %s', (_, note) => {
    expect(() => clipSchema.parse({ ...clip, notes: [note] })).toThrow();
  });

  it('takes at most CLIP_NOTES_MAX notes', () => {
    const notes = (count: number) => Array.from({ length: count }, (_, i) => [i, 1, 60, 100]);
    expect(
      clipSchema.parse({ ...clip, length: CLIP_LENGTH_MAX, notes: notes(CLIP_NOTES_MAX) }).notes
    ).toHaveLength(CLIP_NOTES_MAX);
    expect(() =>
      clipSchema.parse({ ...clip, length: CLIP_LENGTH_MAX, notes: notes(CLIP_NOTES_MAX + 1) })
    ).toThrow();
  });

  it('takes a name of up to 40 characters, trimmed, whatever its words (refused only on a save)', () => {
    expect(clipSchema.parse({ ...clip, name: '  Bass   line ' }).name).toBe('Bass line');
    expect(clipSchema.parse({ ...clip, name: '' }).name).toBe('');
    expect(() => clipSchema.parse({ ...clip, name: 'x'.repeat(41) })).toThrow();
    expect(clipSchema.parse({ ...clip, name: 'fuck' }).name).toBe('fuck');
    expect(clipSchema.parse({ ...clip, name: ' Sexy  pad' }).name).toBe('Sexy pad');
  });
});

describe('clipNameAllowed', () => {
  it('refuses a name the profanity filter refuses, its false matches too', () => {
    expect(clipNameAllowed('fuck')).toBe(false);
    expect(clipNameAllowed('  Sexy   pad ')).toBe(false);
    expect(clipNameAllowed('Pussycat')).toBe(false);
  });

  it('allows any other name, none and an empty one', () => {
    expect(clipNameAllowed('Bass line')).toBe(true);
    expect(clipNameAllowed(undefined)).toBe(true);
    expect(clipNameAllowed('')).toBe(true);
  });
});

describe('normalizeClip', () => {
  it('sorts the notes by start, pitch and duration', () => {
    const { notes } = normalizeClip({
      ...clip,
      notes: [
        [960, 480, 64, 100],
        [0, 960, 60, 90],
        [0, 480, 60, 90],
        [0, 960, 48, 80],
      ],
    });
    expect(notes).toEqual([
      [0, 960, 48, 80],
      [0, 480, 60, 90],
      [0, 960, 60, 90],
      [960, 480, 64, 100],
    ]);
  });

  it('drops exact duplicates, keeps a note of another velocity', () => {
    const { notes } = normalizeClip({
      ...clip,
      notes: [
        [0, 960, 60, 90],
        [0, 960, 60, 90],
        [0, 960, 60, 100],
      ],
    });
    expect(notes).toEqual([
      [0, 960, 60, 90],
      [0, 960, 60, 100],
    ]);
  });

  it('drops the notes that start at the end of the loop or after it, keeps one through its end', () => {
    const { notes } = normalizeClip({
      ...clip,
      length: 3840,
      notes: [
        [3000, 2000, 60, 90],
        [3840, 10, 60, 90],
        [5000, 10, 60, 90],
      ],
    });
    expect(notes).toEqual([[3000, 2000, 60, 90]]);
  });

  it('keeps the keys in a fixed order, drops an empty name', () => {
    expect(Object.keys(normalizeClip({ notes: [], name: 'A', length: 3840, bpm: 120 }))).toEqual([
      'bpm',
      'length',
      'notes',
      'name',
    ]);
    expect(normalizeClip({ ...clip, name: ' ' })).not.toHaveProperty('name');
  });

  it('does not change the notes it was given', () => {
    const notes: ClipNote[] = [
      [960, 480, 64, 100],
      [0, 960, 60, 90],
    ];
    normalizeClip({ ...clip, notes });
    expect(notes[0]).toEqual([960, 480, 64, 100]);
  });
});

describe('clipHash', () => {
  it('is the same for the same notes in another order, under another name', () => {
    const reversed = { ...clip, notes: [...clip.notes].reverse(), name: 'Other' };
    expect(clipHash(reversed)).toBe(clipHash(clip));
    expect(clipHash(clip)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes with the tempo, the length and a note', () => {
    const hash = clipHash(clip);
    expect(clipHash({ ...clip, bpm: 127 })).not.toBe(hash);
    expect(clipHash({ ...clip, length: 3840 })).not.toBe(hash);
    expect(clipHash({ ...clip, notes: [[0, 960, 60, 91]] })).not.toBe(hash);
  });

  it('takes a name the filter refuses: the hash of the same notes', () => {
    expect(clipHash({ ...clip, name: 'Sexy pad' })).toBe(clipHash(clip));
    expect(normalizeClip({ ...clip, name: 'fuck' }).name).toBe('fuck');
  });

  it('is the golden hash of a clip', () => {
    expect(clipHash(clip)).toBe(clipHash({ bpm: 128, length: 15360, notes: [...clip.notes] }));
    expect(clipHash(emptyClip(120))).toMatchInlineSnapshot(
      `"c5f822aabbdf9cac7dd2511571a5bbae4aa8a79e63ade9319844148c12800f9a"`
    );
  });
});

describe('the requests of the clips', () => {
  it('takes a clip and a token', () => {
    expect(saveClipRequestSchema.safeParse({ clip, turnstileToken: 't' }).success).toBe(true);
    expect(saveClipRequestSchema.safeParse({ clip }).success).toBe(false);
    expect(updateClipRequestSchema.safeParse({ clip, editToken: 'x'.repeat(32) }).success).toBe(true);
    expect(updateClipRequestSchema.safeParse({ clip, editToken: 'short' }).success).toBe(false);
  });

  it('refuse a name the filter refuses, the issue on the name of the clip', () => {
    const named = { ...clip, name: 'Sexy pad' };
    const requests = [
      saveClipRequestSchema.safeParse({ clip: named, turnstileToken: 't' }),
      updateClipRequestSchema.safeParse({ clip: named, editToken: 'x'.repeat(32) }),
    ];
    requests.forEach((parsed) => {
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues).toEqual([
        expect.objectContaining({ code: 'custom', path: ['clip', 'name'], message: CLIP_NAME_REFUSED }),
      ]);
    });
    expect(
      saveClipRequestSchema.safeParse({ clip: { ...clip, name: 'Pad' }, turnstileToken: 't' }).success
    ).toBe(true);
  });
});
