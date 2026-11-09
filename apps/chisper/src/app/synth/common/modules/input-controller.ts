import { Subject } from 'rxjs';
import { rxModel, rxModelReact, ObjectBS, PrimitiveBS } from '@chisper/rxjs-react';
import { Note, Notes } from '@chisper/ui-kit';
import { noteToString, stringToNote } from '../../services';

// the velocity of a note of the computer keyboard and of the piano on the screen (MIDI: 1..127)
export const DEFAULT_VELOCITY = 100;

// who plays a note: the computer keyboard and the piano on the screen (keys), a MIDI input (midi), the clip of the
// track (track), the keys of the piano roll (roll). Each holds its own notes: the same note of two of them is two
// voices, each released by its own source
export type NoteSource = 'keys' | 'midi' | 'track' | 'roll';

// a note of a source at a time: `at` the seconds of the context it plays at (the track sends its notes ahead of
// their time); none: now
export interface NoteTiming {
  source?: NoteSource;
  at?: number;
}

// a note pressed and its velocity
export interface NoteOn {
  note: Note;
  velocity: number;
  source: NoteSource;
  at?: number;
}

// a note released
export interface NoteOff {
  note: Note;
  source: NoteSource;
  at?: number;
}

// the key of a note of a source (the voices of the synth are held under it)
export const sourceKey = (source: NoteSource, note: Note) => `${source}:${noteToString(note)}`;

// the note of a key (sourceKey)
export const noteOfKey = (key: string) => stringToNote(key.slice(key.indexOf(':') + 1));

const emptyPressed = (): Record<number, Notes[]> => ({
  '-1': [],
  0: [],
  1: [],
  2: [],
  3: [],
  4: [],
  5: [],
  6: [],
  7: [],
  8: [],
  9: [],
});

// the notes held by the sources (a note two of them hold once), as $pressed shows them
const pressedOf = (held: Map<string, Note>) => {
  const pressed = emptyPressed();
  held.forEach(([octave, name]) => {
    if (!pressed[octave].includes(name)) pressed[octave].push(name);
  });
  return pressed;
};

export const inputController = () =>
  rxModel(() => {
    const $onPress = new Subject<NoteOn>();
    const $onRelease = new Subject<NoteOff>();
    // the notes held (the keys light up): of every source but the track, which lights its own at the time they
    // sound (the track model)
    const $pressed = new ObjectBS<Record<number, Notes[]>>(emptyPressed());
    // the pitch bend: a share of its range, -1 (all the way down) .. 1 (up), 0 at rest; the MIDI input and the
    // wheel set it, the last one wins
    const $bend = new PrimitiveBS<number>(0);
    // the notes each source holds, by sourceKey: a note pressed again by its source is nothing, one of another
    // source is another voice
    const held = new Map<string, Note>();
    return { $pressed, $onPress, $onRelease, $bend, held };
  }).actions(({ $pressed, $onPress, $onRelease, $bend, held }) => {
    const show = (source: NoteSource) => {
      if (source === 'track') return;
      const shown = new Map([...held].filter(([key]) => !key.startsWith('track:')));
      $pressed.next(pressedOf(shown));
    };
    return {
      onPress: (note: Note, velocity = DEFAULT_VELOCITY, { source = 'keys', at }: NoteTiming = {}) => {
        const key = sourceKey(source, note);
        if (held.has(key)) return;
        held.set(key, note);
        $onPress.next({ note, velocity, source, ...(at !== undefined && { at }) });
        show(source);
      },
      onRelease: (note: Note, { source = 'keys', at }: NoteTiming = {}) => {
        const key = sourceKey(source, note);
        // (not held by its source: another source's note, or released already)
        if (!held.delete(key)) return;
        $onRelease.next({ note, source, ...(at !== undefined && { at }) });
        show(source);
      },
      setBend: (bend: number) => $bend.next(bend),
    };
  });

export const {
  ModelProvider: InputControllerProvider,
  useModel: useInputController,
  Context: InputControllerContext,
} = rxModelReact('inputController', inputController);

export type InputControllerModule = ReturnType<typeof useInputController>;
