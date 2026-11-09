import React from 'react';
import { focusTakesKeys } from '../../common/modules/keyboard-controller';
import { useTrack } from '../modules/track';
import { clamp, snapTick } from '../track-edit';
import { RollEditor } from './use-roll-editor';

// the letter of a key in any layout: its own when it is a Latin one (QWERTY, AZERTY, Dvorak), else the one of its
// place on QWERTY (Cyrillic, Greek…: Cmd+Я is Cmd+Z)
const letterOf = (e: KeyboardEvent) => {
  if (/^[a-z]$/i.test(e.key)) return e.key.toLowerCase();
  return /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : '';
};

// the keys of the roll while it is open, wherever the focus is but on a control that takes them (a text field: its
// name, the tempo; a select, a dialog; a value that took the arrows): Delete, the arrows (a semitone, an octave with
// Shift; a step of the grid, longer or shorter with Shift: the roll takes them, the octave of the computer keyboard
// stays), Cmd/Ctrl with A, C, X (with notes selected), V, D, L (legato), Z (undo, with Shift redo), B (draw mode);
// Shift+Q quantizes, Shift+R records, F follows the playhead, + and − zoom, Shift+F fits, ? lists them, Escape closes
// the list or clears the selection (Space: the track's, as anywhere). The letters by their place in a layout of
// other letters. None of them is a note of the computer keyboard but those it takes with Shift (+, ?, R, Q, which it
// stops): the others play on. Listened on the body: after the controls (they take a key first), before the notes of
// the computer keyboard and Space (the document's and the window's)
export const useRollKeys = (editor: RollEditor) => {
  const [, { toggleRecording }] = useTrack();
  const { selected, step, snap } = editor;
  const onKeyDown = (e: KeyboardEvent) => {
    if (focusTakesKeys(e)) return undefined;
    const command = e.metaKey || e.ctrlKey;
    const letter = letterOf(e);
    const run = (action: () => unknown) => {
      e.preventDefault();
      e.stopPropagation();
      action();
    };
    if (command) {
      if (letter === 'z') return run(e.shiftKey ? editor.redo : editor.undo);
      if (letter === 'a') return run(editor.selectAll);
      // (nothing selected: the copy of the page)
      if (letter === 'c' && selected.length) return run(editor.copy);
      if (letter === 'x' && selected.length) return run(editor.cut);
      if (letter === 'v')
        return run(() =>
          editor.paste(snapTick(clamp(editor.pointerTick.current, 0, editor.workspace - 1), step, snap))
        );
      if (letter === 'd') return run(editor.duplicate);
      if (letter === 'l') return run(editor.legato);
      if (letter === 'b') return run(editor.toggleDraw);
      return undefined;
    }
    if (e.altKey) return undefined;
    if (e.key === 'Delete' || e.key === 'Backspace') return run(editor.remove);
    if (e.key === 'Escape' && editor.shortcutsOpen) return run(() => editor.setShortcutsOpen(false));
    if (e.key === 'Escape' && selected.length) return run(editor.clearSelection);
    if (e.key === '?' || (e.shiftKey && e.code === 'Slash'))
      return run(() => editor.setShortcutsOpen(!editor.shortcutsOpen));
    if (e.key === '+') return run(editor.zoomIn);
    if (e.key === '-' || e.key === '_') return run(editor.zoomOut);
    if (e.shiftKey && letter === 'r') return run(toggleRecording);
    if (e.shiftKey && letter === 'q') return run(editor.quantize);
    if (letter === 'f') return run(e.shiftKey ? editor.fit : () => editor.setFollow(!editor.follow));
    // the roll takes the arrows (the octave of the computer keyboard stays), they move what is selected
    if (e.key.startsWith('Arrow') && !selected.length) return run(() => undefined);
    if (e.key === 'ArrowUp') return run(() => editor.transpose(e.shiftKey ? 12 : 1));
    if (e.key === 'ArrowDown') return run(() => editor.transpose(e.shiftKey ? -12 : -1));
    if (e.key === 'ArrowRight') return run(() => (e.shiftKey ? editor.stretch(1) : editor.nudge(1)));
    if (e.key === 'ArrowLeft') return run(() => (e.shiftKey ? editor.stretch(-1) : editor.nudge(-1)));
    return undefined;
  };
  const latest = React.useRef(onKeyDown);
  latest.current = onKeyDown;
  React.useEffect(() => {
    const listener = (e: KeyboardEvent) => latest.current(e);
    document.body.addEventListener('keydown', listener);
    return () => document.body.removeEventListener('keydown', listener);
  }, []);
};
