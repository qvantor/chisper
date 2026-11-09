import React from 'react';
import { styled } from 'styled-components';
import { CLIP_BAR, ClipNote } from '@chisper/preset-schema';
import { theme, useElementSize } from '@chisper/ui-kit';
import { useTrack } from '../modules/track';
import { addNote, moveNotes, noteAt, removeNotes, resizeTo, roundTick } from '../track-edit';
import { noteToAdd, RollView, scrollView, tickX, xTick, yPitch, zoomAt, zoomRows } from '../roll-view';
import { RollCorner, RollGrid } from './roll-cell';
import { RollHeader } from './roll-header';
import { RollKeys } from './roll-keys';
import { RollRuler } from './roll-ruler';
import { RollStrip } from './roll-strip';
import { useClipSaving } from './use-clip-saving';
import { useRollEditor } from './use-roll-editor';
import { useLoopEnd, useRollGrid } from './use-roll-grid';
import { useRollView } from './use-roll-view';

const KEYS_WIDTH = 36;
const RULER_HEIGHT = 22;
// px of a row in a fitted view (a finger)
const ROW = 18;
// px a finger moves before a press is a drag (a tap below it)
const TAP_SLOP = 6;
// a press within this many px of the right edge of a note drags its end (a finger is wider than a pointer)
const TOUCH_EDGE = 12;

// a phone shows a bar at most across: its notes wide enough for a finger
const fitSpan = (workspace: number) => Math.min(workspace, CLIP_BAR);

// a section of the synth: its header, then the screen of the roll
const Root = styled.div`
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px;
  background: ${theme.colors.primary};
  user-select: none;
`;

const Screen = styled.div`
  flex: 1 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 3px;
  background: ${theme.colors.primaryDark};
`;

const Body = styled.div`
  flex: 1 1;
  min-height: 0;
  display: grid;
  grid-template-columns: ${KEYS_WIDTH}px minmax(0, 1fr);
  grid-template-rows: ${RULER_HEIGHT}px minmax(0, 1fr);
`;

// a press on the grid: where it began and what it does once it moves (a tap does what a tap does)
type Press =
  | {
      kind: 'note';
      x: number;
      y: number;
      tick: number;
      pitch: number;
      index: number;
      edge: boolean;
      notes: ClipNote[];
      // the pitch of the note heard last (a new one plays)
      heard: number;
    }
  | { kind: 'pan'; x: number; y: number; view: RollView };

// the clip on a phone (the screen CLIP): its header (the name, Save, Share), a strip of Play, the position, the grid,
// undo and redo, and the roll of simple editing under its ruler (a tap plays from a bar of the loop; the loop follows
// the notes, its flag extends it) over 5 bars at least, a bar across. A tap on the grid adds a note (as long as the
// last one resized), on a note takes it away; a note dragged moves (each new pitch of it plays), its end dragged
// resizes it; a drag elsewhere scrolls, two fingers pinched zoom. No selection, no keys of the keyboard
export const MobileRoll = ({ presetId }: { presetId: () => string | null }) => {
  const [, { setLength, moveGesture }] = useTrack();
  // (no key to switch it: the view follows the playhead)
  const editor = useRollEditor({ follow: true });
  const { clip, notes, workspace, startDrag, endDrag, step, newLength, setLastLength, apply, audition } =
    editor;
  const { save, busy, captcha } = useClipSaving(presetId);
  const [ref, [width, height]] = useElementSize<HTMLDivElement>();
  const [view, setView] = useRollView(ref, width, height, editor, { row: ROW, span: fitSpan });
  const press = React.useRef<Press | null>(null);
  const moved = React.useRef(false);
  // the length of a note whose end is dragged
  const resized = React.useRef<number | null>(null);
  // the end of the loop as its flag is dragged (committed when let go)
  const [length, onEnd] = useLoopEnd(clip.length, setLength);
  // the fingers on the grid, and the pinch of two of them (their distance then, the view then)
  const fingers = React.useRef(new Map<number, [number, number]>());
  const pinch = React.useRef<{ distance: number; view: RollView } | null>(null);

  const { linesCanvas, notesCanvas, playhead } = useRollGrid(view, width, height, { step, length, notes });

  const pointOf = (e: React.PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    return [e.clientX - box.left, e.clientY - box.top] as [number, number];
  };

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!view) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const [x, y] = pointOf(e);
    fingers.current.set(e.pointerId, [x, y]);
    if (fingers.current.size === 2) {
      // a pinch: what one finger began ends
      if (press.current?.kind === 'note' && moved.current) endDrag();
      press.current = null;
      const [[x0, y0], [x1, y1]] = [...fingers.current.values()];
      pinch.current = { distance: Math.max(1, Math.hypot(x1 - x0, y1 - y0)), view };
      return;
    }
    moved.current = false;
    resized.current = null;
    const tick = xTick(view, x);
    const pitch = yPitch(view, y);
    const index = noteAt(notes, tick, pitch);
    press.current =
      index >= 0
        ? {
            kind: 'note',
            x,
            y,
            tick,
            pitch,
            index,
            edge: tickX(view, notes[index][0] + notes[index][1]) - x <= TOUCH_EDGE,
            notes,
            heard: notes[index][2],
          }
        : { kind: 'pan', x, y, view };
  };

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!view || !fingers.current.has(e.pointerId)) return;
    const [x, y] = pointOf(e);
    fingers.current.set(e.pointerId, [x, y]);
    const zoom = pinch.current;
    if (zoom && fingers.current.size >= 2) {
      const [[x0, y0], [x1, y1]] = [...fingers.current.values()];
      const ratio = Math.hypot(x1 - x0, y1 - y0) / zoom.distance;
      setView(zoomRows(zoomAt(zoom.view, ratio, (x0 + x1) / 2), ratio));
      return;
    }
    const current = press.current;
    if (!current) return;
    if (!moved.current) {
      if (Math.hypot(x - current.x, y - current.y) < TAP_SLOP) return;
      moved.current = true;
      if (current.kind === 'note') startDrag();
    }
    if (current.kind === 'pan') {
      const { view: from } = current;
      setView(scrollView(from, -(x - current.x) / from.scale, -Math.round((y - current.y) / from.row)));
      return;
    }
    const tick = xTick(view, x);
    const [start, , pitch, velocity] = current.notes[current.index];
    if (current.edge) {
      const end = Math.min(roundTick(tick, step), workspace);
      resized.current = Math.max(step, end - start);
      moveGesture(resizeTo(current.notes, [current.index], current.index, end, step).notes);
      return;
    }
    const edit = moveNotes(
      current.notes,
      [current.index],
      roundTick(start + tick - current.tick, step) - start,
      yPitch(view, y) - current.pitch,
      // (on the last line of the grid in the bars held at most)
      workspace - step + 1
    );
    moveGesture(edit.notes);
    // each new pitch of the note plays
    if (pitch + edit.semitones !== current.heard) {
      current.heard = pitch + edit.semitones;
      audition(current.heard, velocity);
    }
  };

  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    fingers.current.delete(e.pointerId);
    if (fingers.current.size < 2) pinch.current = null;
    const current = press.current;
    press.current = null;
    if (!current || !view) return;
    if (moved.current) {
      if (current.kind === 'note') endDrag();
      if (resized.current !== null) setLastLength(resized.current);
      return;
    }
    // a tap: a note taken away, or one added
    if (current.kind === 'note') {
      apply({ notes: removeNotes(notes, [current.index]), selected: [] });
      return;
    }
    const added = noteToAdd(
      xTick(view, current.x),
      yPitch(view, current.y),
      step,
      true,
      workspace,
      newLength
    );
    if (!added) return;
    const [start, duration, pitch] = added;
    apply(addNote(notes, start, pitch, duration));
    audition(pitch);
  };

  return (
    <Root data-testid='mobile-roll'>
      <RollHeader editor={editor} onSave={save} saving={busy} compact />
      <Screen>
        <RollStrip editor={editor} compact />
        <Body>
          <RollCorner aria-label='Notes'>{notes.length}</RollCorner>
          <RollRuler view={view} length={length} workspace={workspace} step={step} onEnd={onEnd} />
          <RollKeys view={view} />
          <RollGrid
            ref={ref}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            data-testid='mobile-roll-grid'
          >
            <canvas {...linesCanvas} />
            <canvas {...notesCanvas} />
            <canvas {...playhead} />
          </RollGrid>
        </Body>
      </Screen>
      {captcha}
    </Root>
  );
};
