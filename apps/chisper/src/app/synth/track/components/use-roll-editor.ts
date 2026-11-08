import React from 'react';
import { filter, skip, Subject } from 'rxjs';
import { ClipNote } from '@chisper/preset-schema';
import { useBehaviorSubject } from '@chisper/rxjs-react';
import { DEFAULT_VELOCITY, useInputController } from '../../common/modules';
import { midiToNote } from '../../services';
import { useTrack } from '../modules/track';
import {
  copyNotes,
  duplicateNotes,
  Edit,
  GRID_DEFAULT,
  gridTicks,
  legato,
  moveNotes,
  pasteNotes,
  quantize,
  remapSelection,
  removeNotes,
  resizeNotes,
  transpose,
  workspaceLength,
} from '../track-edit';

// ms a note sounds when it is added, selected or dragged to another pitch with the sound on
const AUDITION_MS = 250;

// the notes copied (the clipboard of the page, shared by the rolls of both layouts)
let clipboard: ClipNote[] = [];

// select: a press selects and drags, a double click adds a note; draw: a press draws a note (dragged: its length),
// on a note takes it away
export type RollMode = 'select' | 'draw';

// what the view of the roll is asked to do: zoom in or out across, fit the loop
export type ViewCommand = 'in' | 'out' | 'fit';

// an equal selection keeps the one there (a drag that moves nothing, a note recorded beside them, renders nothing)
const keepEqual = (current: number[], next: number[]) =>
  next.length === current.length && next.every((index, i) => index === current[i]) ? current : next;

// the editor of the piano roll: the selected notes (indexes into the notes of the clip), the bars it shows (the
// notes go anywhere in them, the loop follows them), the grid and its snap, the mode (draw by default), the length of
// a new note (the last one drawn or resized, a step of the grid before), the sound of an edit (on by default),
// whether the view follows the playhead (off by default: `follow` of the options, the phone's has no key of it; on
// while REC records as the roll opens, and as REC goes on: it runs the loop on into the bars after the view),
// and the edits of the strip and the keys on them (on the selected notes; Quantize and Legato on all of them while
// none is). None of it is kept past the session
export const useRollEditor = ({ follow: following = false }: { follow?: boolean } = {}) => {
  const [{ $clip, $recorded, $recording }, actions] = useTrack();
  const [, { onPress, onRelease }] = useInputController();
  const clip = useBehaviorSubject($clip);
  const [selected, select] = React.useState<number[]>([]);
  const setSelected = React.useCallback(
    (next: number[]) => select((current) => keepEqual(current, next)),
    []
  );
  const chosen = React.useMemo(() => new Set(selected), [selected]);
  const [grid, setGrid] = React.useState(GRID_DEFAULT);
  const [snap, setSnap] = React.useState(true);
  const [mode, setMode] = React.useState<RollMode>('draw');
  const [lastLength, setLastLength] = React.useState<number | null>(null);
  const [sound, setSound] = React.useState(true);
  const [follow, setFollow] = React.useState(() => following || $recording.value);
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);
  const [view$] = React.useState(() => new Subject<ViewCommand>());
  // the tick under the pointer last (a paste goes there)
  const pointerTick = React.useRef(0);
  // the bars of the roll while a drag holds them (null: none does): they follow the notes once it is let go, so the
  // view doesn't move under the pointer
  const [held, setHeld] = React.useState<number | null>(null);
  const notes = clip.notes;
  const step = gridTicks(grid);
  const live = workspaceLength(notes, clip.length);
  // the bars the roll shows and edits within: 5 at least, 2 more once a note is in the last but one
  const workspace = held ?? live;

  // the selection within the notes (an undo may leave fewer of them)
  React.useEffect(() => {
    select((current) => (current.every((index) => index < notes.length) ? current : []));
  }, [notes.length]);
  // REC on: the view follows the playhead (off again by its key, it stays off until REC goes on again)
  React.useEffect(() => {
    const subscription = $recording.pipe(skip(1), filter(Boolean)).subscribe(() => setFollow(true));
    return () => subscription.unsubscribe();
  }, [$recording]);
  // notes recorded among them: the selected ones stay selected where they went
  React.useEffect(() => {
    const subscription = $recorded.subscribe(({ before, after }) =>
      select((current) =>
        current.length ? keepEqual(current, remapSelection(before, after, current)) : current
      )
    );
    return () => subscription.unsubscribe();
  }, [$recorded]);

  const apply = React.useCallback(
    ({ notes: next, selected: chosen }: Edit) => {
      actions.setNotes(next);
      setSelected(chosen);
    },
    [actions, setSelected]
  );
  const all = () => notes.map((_, index) => index);

  // the note heard last while it sounds, and the timer that releases it
  const heard = React.useRef<{ pitch: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  // a note heard as it is added, selected or dragged to another pitch (the source of the roll: not the keys' nor the
  // track's); the one heard before is released at once (a note dragged over the rows plays each of them in turn)
  const audition = React.useCallback(
    (pitch: number, velocity = DEFAULT_VELOCITY) => {
      if (!sound) return;
      const release = (note: number) => onRelease(midiToNote(note), { source: 'roll' });
      if (heard.current) {
        clearTimeout(heard.current.timer);
        release(heard.current.pitch);
      }
      onPress(midiToNote(pitch), velocity, { source: 'roll' });
      const timer = setTimeout(() => {
        heard.current = null;
        release(pitch);
      }, AUDITION_MS);
      heard.current = { pitch, timer };
    },
    [sound, onPress, onRelease]
  );

  return {
    clip,
    notes,
    selected,
    // the selected notes as a set
    chosen,
    setSelected,
    clearSelection: () => setSelected([]),
    grid,
    setGrid,
    step,
    snap,
    setSnap,
    mode,
    setMode,
    toggleDraw: () => setMode((current) => (current === 'draw' ? 'select' : 'draw')),
    // the length of a new note
    newLength: lastLength ?? step,
    setLastLength,
    sound,
    setSound,
    follow,
    setFollow,
    shortcutsOpen,
    setShortcutsOpen,
    view$,
    zoomIn: () => view$.next('in'),
    zoomOut: () => view$.next('out'),
    fit: () => view$.next('fit'),
    pointerTick,
    workspace,
    // a drag of notes (its moves one step of the undo) holds the bars of the roll until it ends or is given up
    startDrag: () => {
      actions.startGesture();
      setHeld(live);
    },
    endDrag: () => {
      actions.endGesture();
      setHeld(null);
    },
    cancelDrag: () => {
      actions.cancelGesture();
      setHeld(null);
    },
    apply,
    audition,
    selectAll: () => setSelected(all()),
    remove: () => selected.length > 0 && apply({ notes: removeNotes(notes, selected), selected: [] }),
    // the selected notes a semitone up or down (an octave: 12)
    transpose: (semitones: number) => selected.length && apply(transpose(notes, selected, semitones)),
    // the selected notes along the grid (a step) or longer or shorter by a step
    nudge: (steps: number) =>
      selected.length && apply(moveNotes(notes, selected, steps * step, 0, workspace)),
    stretch: (steps: number) => selected.length && apply(resizeNotes(notes, selected, steps * step, step)),
    quantize: () => apply(quantize(notes, selected, step, clip.length)),
    legato: () => apply(legato(notes, selected, clip.length)),
    duplicate: () => selected.length && apply(duplicateNotes(notes, selected, step, workspace)),
    copy: () => {
      if (selected.length) clipboard = copyNotes(notes, selected);
    },
    cut: () => {
      if (!selected.length) return;
      clipboard = copyNotes(notes, selected);
      apply({ notes: removeNotes(notes, selected), selected: [] });
    },
    // the notes copied from `at` (ticks)
    paste: (at: number) => clipboard.length > 0 && apply(pasteNotes(notes, clipboard, at, workspace)),
    undo: () => {
      actions.undo();
      setSelected([]);
    },
    redo: () => {
      actions.redo();
      setSelected([]);
    },
  };
};

export type RollEditor = ReturnType<typeof useRollEditor>;
