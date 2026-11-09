import { Note, Notes } from '@chisper/ui-kit';
import { noteFrequency } from '../../common/constants';

export const getFq = ([octave, note]: Note) => noteFrequency[note] * 2 ** (octave - 1);
export const noteToString = ([octave, note]: Note) => `${note}${octave}`;
export const stringToNote = (value: string): Note => {
  // the octave may be negative (C-1 is MIDI note 0)
  const [, note, octave] = value.match(/^(.+?)(-?\d+)$/) ?? [];
  return [Number(octave), note as Notes];
};

const NOTE_NAMES: Notes[] = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// a MIDI note number (60: C4) as a note of the keys, and back
export const midiToNote = (midiNote: number): Note => {
  const octave = Math.floor(midiNote / 12 - 1);
  return [octave, NOTE_NAMES[midiNote % 12]];
};
export const noteToMidi = ([octave, note]: Note) => (octave + 1) * 12 + NOTE_NAMES.indexOf(note);
// the name of a MIDI note number (60: C4)
export const midiName = (midiNote: number) => noteToString(midiToNote(midiNote));

// MIDI notes by the octaves of the keys (the notes a piano lights), and back
export const pitchesByOctave = (pitches: readonly number[]) =>
  pitches.reduce<Record<number, Notes[]>>((octaves, pitch) => {
    const [octave, note] = midiToNote(pitch);
    (octaves[octave] ??= []).push(note);
    return octaves;
  }, {});
export const octavePitches = (octaves: Record<number, Notes[]>) =>
  Object.entries(octaves).flatMap(([octave, names]) =>
    names.map((name) => noteToMidi([Number(octave), name]))
  );
