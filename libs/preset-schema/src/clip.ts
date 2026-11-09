import { z } from 'zod';
import { TEMPO_MAX, TEMPO_MIN, tempoOf } from './tempo';
import { sha256Hex } from './hash';
import { isProfane } from './profanity';
import { editTokenSchema, normalizeName, turnstileTokenSchema } from './schema';

// a clip of the track: notes in a loop at its tempo, kept apart from the presets (a link `?clip=`). Times are whole
// ticks, CLIP_PPQ a quarter note (a beat), never rounded as the numbers of a preset are

// ticks a quarter note (a beat)
export const CLIP_PPQ = 960;
// a bar of 4/4
export const CLIP_BAR = 4 * CLIP_PPQ;
// the length of the loop: a beat (CLIP_PPQ) .. 32 bars
export const CLIP_LENGTH_MAX = 32 * CLIP_BAR;
// the length of a new clip: 4 bars
export const CLIP_LENGTH_DEFAULT = 4 * CLIP_BAR;
export const CLIP_NOTES_MAX = 2048;
export const CLIP_NAME_MAX_LENGTH = 40;
// C0: no note under it (MIDI 12; C-1 is 0)
export const CLIP_PITCH_MIN = 12;
export const CLIP_PITCH_MAX = 127;
export const CLIP_VELOCITY_MIN = 1;
export const CLIP_VELOCITY_MAX = 127;

// a note: its start and duration (ticks), its pitch (MIDI 12..127: C0 up, 60 = C4 of MIDI) and velocity (1..127)
export type ClipNote = [start: number, duration: number, pitch: number, velocity: number];

const tick = z.number().int().min(0);

export const clipNoteSchema = z.tuple([
  tick.max(CLIP_LENGTH_MAX - 1),
  z.number().int().min(1).max(CLIP_LENGTH_MAX),
  z.number().int().min(CLIP_PITCH_MIN).max(CLIP_PITCH_MAX),
  z.number().int().min(CLIP_VELOCITY_MIN).max(CLIP_VELOCITY_MAX),
]);

// trimmed, whitespace collapsed, at most CLIP_NAME_MAX_LENGTH; empty: none. Any words: the track holds the name as it
// was typed, one the filter refuses only can't be saved (savedClipSchema)
export const clipNameSchema = z.string().transform(normalizeName).pipe(z.string().max(CLIP_NAME_MAX_LENGTH));

export const CLIP_NAME_REFUSED = 'Please choose another name';

// a name a clip can be saved under (none: yes): not one the profanity filter refuses
export const clipNameAllowed = (name?: string) => !name || !isProfane(normalizeName(name));

export const clipSchema = z.object({
  // the tempo of the clip (it sets the tempo of the synth), on the grid of the tempo field
  bpm: z.number().min(TEMPO_MIN).max(TEMPO_MAX).transform(tempoOf),
  length: z.number().int().min(CLIP_PPQ).max(CLIP_LENGTH_MAX),
  notes: z.array(clipNoteSchema).max(CLIP_NOTES_MAX),
  name: clipNameSchema.optional(),
});

export interface Clip {
  bpm: number;
  length: number;
  notes: ClipNote[];
  name?: string;
}

// the order of the notes: by start, pitch, duration (then velocity: equal notes of other velocities stay apart)
export const compareNotes = (a: ClipNote, b: ClipNote) =>
  a[0] - b[0] || a[2] - b[2] || a[1] - b[1] || a[3] - b[3];

// the same note: start, duration, pitch and velocity
export const sameNote = (a: ClipNote, b: ClipNote) =>
  a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];

// validates (throws ZodError), sorts the notes (compareNotes), drops exact duplicates and those that start at the
// end of the loop or after it; an empty name is none. The keys in a fixed order: bpm, length, notes, name
export const normalizeClip = (data: unknown): Clip => {
  const { bpm, length, notes, name } = clipSchema.parse(data);
  const sorted = notes
    .filter(([start]) => start < length)
    .map((note) => [...note] as ClipNote)
    .sort(compareNotes)
    .filter((note, index, all) => index === 0 || !sameNote(note, all[index - 1]));
  return { bpm, length, notes: sorted, ...(name && { name }) };
};

// sha256 of a clip normalizeClip gave, without its name: the same notes at the same tempo under another name are the
// same clip
export const normalizedClipHash = ({ bpm, length, notes }: Omit<Clip, 'name'>) =>
  sha256Hex(JSON.stringify({ bpm, length, notes }));

// the hash of any clip (validated and normalized first)
export const clipHash = (data: unknown) => normalizedClipHash(normalizeClip(data));

// an empty clip of CLIP_LENGTH_DEFAULT at `bpm`
export const emptyClip = (bpm: number): Clip => ({
  bpm: tempoOf(bpm),
  length: CLIP_LENGTH_DEFAULT,
  notes: [],
});

// API

// a clip as it is saved: under a name it can be saved under (the issue on its name: the server tells it)
const savedClipSchema = clipSchema.refine(({ name }) => clipNameAllowed(name), {
  message: CLIP_NAME_REFUSED,
  path: ['name'],
});

export const saveClipRequestSchema = z.object({
  clip: savedClipSchema,
  turnstileToken: turnstileTokenSchema,
});
export type SaveClipRequest = z.input<typeof saveClipRequestSchema>;

export const updateClipRequestSchema = z.object({
  clip: savedClipSchema,
  editToken: editTokenSchema,
});
export type UpdateClipRequest = z.input<typeof updateClipRequestSchema>;

export interface ClipResponse {
  id: string;
  clip: Clip;
  createdAt: string;
}

export interface SaveClipResponse {
  id: string;
  // the same notes were saved before: their clip, no token
  existed: boolean;
  // the secret for editing the clip later, only when it was created
  editToken?: string;
}

export interface UpdateClipResponse {
  id: string;
}
