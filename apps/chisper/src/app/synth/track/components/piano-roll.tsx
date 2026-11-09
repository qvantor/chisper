import React from 'react';
import { BehaviorSubject } from 'rxjs';
import { styled } from 'styled-components';
import hexToRgba from 'hex-to-rgba';
import { CLIP_BAR, CLIP_PPQ, ClipNote } from '@chisper/preset-schema';
import { text12, theme, useCanvas, useElementSize } from '@chisper/ui-kit';
import { useTrack } from '../modules/track';
import {
  addNote,
  drawDuration,
  moveNotes,
  noteAt,
  notesIn,
  removeNotes,
  resizeTo,
  roundTick,
} from '../track-edit';
import { drawHover, RollHover, RubberBand } from '../roll-draw';
import { EDGE_PX, inPitches, noteToAdd, tickX, xTick, yPitch } from '../roll-view';
import { releaseLost, RollCorner, RollGrid } from './roll-cell';
import { RollKeys } from './roll-keys';
import { RollOverview } from './roll-overview';
import { RollRuler } from './roll-ruler';
import { modKey } from './roll-shortcuts';
import { useLoopEnd, useRollGrid } from './use-roll-grid';
import { RollEditor } from './use-roll-editor';
import { useRollView } from './use-roll-view';
import { VelocityLane } from './velocity-lane';

const KEYS_WIDTH = 56;
const RULER_HEIGHT = 22;
const VELOCITY_HEIGHT = 83;
const OVERVIEW_HEIGHT = 24;
// px a press on the grid moves before it is a drag (a drawn note takes the length it is dragged to from then)
const DRAG_SLOP = 3;
// the button of a pointer that takes notes away
const RIGHT_BUTTON = 2;
// the cursor while it does
const ERASE_CURSOR = 'not-allowed';
// the view as it opens: 3.5 bars across from the start (Fit: all the bars)
const VIEW_OPTIONS = { open: 3.5 * CLIP_BAR };

const Root = styled.div`
  flex: 1 1;
  min-height: 0;
  display: grid;
  grid-template-columns: ${KEYS_WIDTH}px minmax(0, 1fr);
  grid-template-rows: ${OVERVIEW_HEIGHT}px ${RULER_HEIGHT}px minmax(0, 1fr) ${VELOCITY_HEIGHT}px;
  background: ${theme.colors.primaryDark};
  outline: none;
  user-select: none;
`;

// the empty clip: how to add notes, over the middle of the grid
const Empty = styled.div`
  ${text12};
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  color: ${hexToRgba(theme.colors.white, 0.55)};
  pointer-events: none;
  text-align: center;

  b {
    color: ${theme.colors.white};
    font-weight: 600;
  }

  small {
    font-size: 11px;
    color: ${theme.colors.primaryDarkHighContrast};
  }
`;

// what a drag of the pointer does on the notes
type Drag =
  | {
      kind: 'move';
      x: number;
      tick: number;
      pitch: number;
      anchor: number;
      notes: ClipNote[];
      selected: number[];
      // the pitch of the note under the pointer heard last (a new one plays)
      heard: number;
    }
  | { kind: 'resize'; anchor: number; notes: ClipNote[]; selected: number[]; duration: number }
  | { kind: 'rubber'; tick: number; pitch: number; keep: number[] }
  | {
      kind: 'draw';
      x: number;
      start: number;
      pitch: number;
      base: ClipNote[];
      free: boolean;
      moved: boolean;
      duration: number;
    }
  | { kind: 'erase'; notes: ClipNote[] };

const NO_HOVER: RollHover = { pitch: null, ghost: null, rubber: null };

const sameGhost = (a: RollHover['ghost'], b: RollHover['ghost']) =>
  a === b || (!!a && !!b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]);

interface Props {
  editor: RollEditor;
}

// the piano roll of the clip (desktop) over 5 bars at least (2 more once a note is in the last but one: the bars of
// the editor; the loop follows the notes, its end a flag on the ruler): the overview of the bars over all (its window
// dragged scrolls, its edges zoom), the bars (a press plays from one of the loop), the notes on a canvas over the grid,
// the keys left of them (a press plays a note), their velocities under them; where the output plays on a canvas of its
// own, the notes it is in lit. The row and (draw mode) the note a press would add under the pointer on an overlay, the selection
// rectangle too (no render a move). A press on a note selects and drags it (Shift adds it; its right edge resizes;
// with the sound of the edits each new pitch of the note under the pointer plays);
// select mode: a press elsewhere drags a rectangle that selects, a double click adds a note or takes one away; draw
// mode: a press elsewhere adds a note, dragged across it takes that length, the right button takes a note away
// (dragged over notes, those too); in select mode the right button changes nothing (no menu of the browser in
// either). A new note is as long as the last one drawn or resized. A drag holds the bars (the view doesn't move under
// it). Escape gives a drag up; one whose release is lost ends where it was (`releaseLost`). The keys of the window:
// use-roll-keys.ts
export const PianoRoll = ({ editor }: Props) => {
  const [, { setLength, moveGesture }] = useTrack();
  const {
    clip,
    notes,
    workspace,
    startDrag,
    endDrag,
    cancelDrag,
    selected,
    chosen,
    setSelected,
    step,
    snap,
    mode,
    newLength,
    setLastLength,
    apply,
    audition,
  } = editor;
  const [gridRef, [width, height]] = useElementSize<HTMLDivElement>();
  const [view, setView] = useRollView(gridRef, width, height, editor, VIEW_OPTIONS);
  // the end of the loop as it is dragged (committed when let go)
  const [length, onEnd] = useLoopEnd(clip.length, setLength);
  const drag = React.useRef<Drag | null>(null);
  const [hover$] = React.useState(() => new BehaviorSubject<number | null>(null));
  const hover = React.useRef<RollHover>(NO_HOVER);

  const chosenPitches = React.useMemo(
    () => new Set(selected.map((index) => notes[index]?.[2])),
    [selected, notes]
  );
  const { linesCanvas, notesCanvas, playhead, shown } = useRollGrid(view, width, height, {
    step,
    length,
    notes,
    chosen,
  });
  const { canvas: overlayCanvas, begin: beginOverlay } = useCanvas(width, height);

  // the overlay: the row under the pointer, the note a press would add, the rectangle of the selection
  const paintOverlay = React.useCallback(() => {
    const context = beginOverlay();
    if (context && shown.current) drawHover(context, shown.current, hover.current);
  }, [beginOverlay, shown]);
  React.useEffect(paintOverlay, [paintOverlay, view]);
  // another mode: no note it would draw until the pointer moves
  React.useEffect(() => {
    hover.current = { ...hover.current, ghost: null };
    paintOverlay();
  }, [mode, paintOverlay]);
  const setHover = (next: Partial<RollHover>) => {
    const merged = { ...hover.current, ...next };
    const before = hover.current;
    if (
      merged.pitch === before.pitch &&
      sameGhost(merged.ghost, before.ghost) &&
      merged.rubber === before.rubber
    )
      return;
    hover.current = merged;
    paintOverlay();
    if (hover$.value !== merged.pitch) hover$.next(merged.pitch);
  };

  // the tick and the pitch under a pointer event on the grid
  const at = (e: React.PointerEvent | React.MouseEvent) => {
    const box = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - box.left;
    const y = e.clientY - box.top;
    return view ? { x, y, tick: xTick(view, x), pitch: yPitch(view, y) } : null;
  };
  // a tick to the grid (Alt or Snap off: free)
  const toGrid = (tick: number, free: boolean) => (snap && !free ? roundTick(tick, step) : Math.round(tick));
  // the note a press there adds, within the bars of the roll (the loop follows a note past its end)
  const toAdd = (tick: number, pitch: number, free: boolean) =>
    noteToAdd(tick, pitch, step, snap && !free, workspace, newLength);
  const onEdge = (index: number, x: number) =>
    !!view && tickX(view, notes[index][0] + notes[index][1]) - x <= EDGE_PX;

  const onGridDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // the right button takes notes away in draw mode; in select mode it changes nothing
    const erase = e.button === RIGHT_BUTTON && mode === 'draw';
    if ((e.button !== 0 && !erase) || !view) return;
    const point = at(e);
    if (!point) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const { x, tick, pitch } = point;
    const hit = noteAt(notes, tick, pitch);
    setHover({ ghost: null });
    if (erase) {
      // a note under it goes; dragged on, the notes it passes go too
      startDrag();
      const rest = hit >= 0 ? removeNotes(notes, [hit]) : notes;
      if (hit >= 0) {
        moveGesture(rest);
        setSelected([]);
      }
      drag.current = { kind: 'erase', notes: rest };
      e.currentTarget.style.cursor = ERASE_CURSOR;
      return;
    }
    // draw mode: a press on an empty place draws a note; on a note it selects and drags it as in select mode
    if (mode === 'draw' && hit < 0) {
      const added = toAdd(tick, pitch, e.altKey);
      if (!added) return;
      const [start, duration] = added;
      startDrag();
      const edit = addNote(notes, start, pitch, duration);
      moveGesture(edit.notes);
      setSelected(edit.selected);
      audition(pitch);
      drag.current = {
        kind: 'draw',
        x,
        start,
        pitch,
        base: notes,
        free: !snap || e.altKey,
        moved: false,
        duration,
      };
      return;
    }
    if (hit < 0) {
      drag.current = { kind: 'rubber', tick, pitch, keep: e.shiftKey ? selected : [] };
      if (!e.shiftKey) setSelected([]);
      return;
    }
    let next = selected;
    if (e.shiftKey) {
      next = chosen.has(hit) ? selected.filter((index) => index !== hit) : [...selected, hit];
      setSelected(next);
      if (!next.includes(hit)) return;
    } else if (!chosen.has(hit)) {
      next = [hit];
      setSelected(next);
      audition(notes[hit][2], notes[hit][3]);
    }
    startDrag();
    drag.current = onEdge(hit, x)
      ? { kind: 'resize', anchor: hit, notes, selected: next, duration: notes[hit][1] }
      : {
          kind: 'move',
          x,
          tick,
          pitch,
          anchor: hit,
          notes,
          selected: next,
          heard: notes[hit][2],
        };
  };

  const onGridMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const point = at(e);
    if (!point || !view) return;
    editor.pointerTick.current = point.tick;
    // its release lost: let go where it was (this move only hovers)
    if (drag.current && releaseLost(e)) onGridUp();
    const current = drag.current;
    if (!current) {
      // the cursor of what a press does there, the note it would add
      const hit = noteAt(notes, point.tick, point.pitch);
      const edge = hit >= 0 && onEdge(hit, point.x);
      const draw = mode === 'draw';
      e.currentTarget.style.cursor = edge ? 'ew-resize' : hit >= 0 ? 'grab' : draw ? 'crosshair' : 'default';
      setHover({
        pitch: inPitches(point.pitch) ? point.pitch : null,
        // the note a press would draw (select mode draws none)
        ghost: !draw || hit >= 0 ? null : toAdd(point.tick, point.pitch, e.altKey),
      });
      return;
    }
    setHover({ pitch: point.pitch });
    if (current.kind === 'rubber') {
      const box: RubberBand = { t0: current.tick, t1: point.tick, p0: current.pitch, p1: point.pitch };
      setHover({ rubber: box });
      const touched = notesIn(notes, box.t0, box.t1, box.p0, box.p1);
      setSelected([...new Set([...current.keep, ...touched])]);
      return;
    }
    if (current.kind === 'erase') {
      const hit = noteAt(current.notes, point.tick, point.pitch);
      if (hit < 0) return;
      current.notes = removeNotes(current.notes, [hit]);
      moveGesture(current.notes);
      setSelected([]);
      return;
    }
    if (current.kind === 'draw') {
      if (!current.moved && Math.abs(point.x - current.x) < DRAG_SLOP) return;
      current.moved = true;
      current.duration = Math.min(
        drawDuration(current.start, point.tick, step, current.free || e.altKey),
        workspace - current.start
      );
      const edit = addNote(current.base, current.start, current.pitch, current.duration);
      moveGesture(edit.notes);
      setSelected(edit.selected);
      return;
    }
    if (current.kind === 'move') {
      const anchor = current.notes[current.anchor];
      const start = toGrid(anchor[0] + point.tick - current.tick, e.altKey);
      const semitones = point.pitch - current.pitch;
      // (the last of them on the last line of the grid in the bars at most)
      const edit = moveNotes(
        current.notes,
        current.selected,
        start - anchor[0],
        semitones,
        workspace - step + 1
      );
      moveGesture(edit.notes);
      setSelected(edit.selected);
      // a new pitch of the note under the pointer plays (the sound of the edits on)
      const heard = anchor[2] + edit.semitones;
      if (heard !== current.heard) {
        current.heard = heard;
        audition(heard, anchor[3]);
      }
      return;
    }
    const free = e.altKey || !snap;
    // the end within the bars held
    const to = Math.min(toGrid(point.tick, e.altKey), workspace);
    const edit = resizeTo(current.notes, current.selected, current.anchor, to, free ? 1 : step);
    const anchor = current.notes[current.anchor];
    current.duration = Math.max(free ? 1 : step, to - anchor[0]);
    moveGesture(edit.notes);
    setSelected(edit.selected);
  };

  const onGridUp = () => {
    const current = drag.current;
    drag.current = null;
    setHover({ rubber: null });
    // (the cursor of where the pointer is from its next move)
    if (current?.kind === 'erase' && gridRef.current) gridRef.current.style.cursor = '';
    if (!current || current.kind === 'rubber') return;
    endDrag();
    if (current.kind === 'draw' && current.moved) setLastLength(current.duration);
    if (current.kind === 'resize') setLastLength(current.duration);
  };

  // a double click (select mode) on a note takes it away, elsewhere adds one as long as the last one drawn
  const onGridDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (mode === 'draw') return;
    const point = at(e);
    if (!point) return;
    const hit = noteAt(notes, point.tick, point.pitch);
    if (hit >= 0) {
      apply({ notes: removeNotes(notes, [hit]), selected: [] });
      return;
    }
    const added = toAdd(point.tick, point.pitch, e.altKey);
    if (!added) return;
    const [start, duration, pitch] = added;
    apply(addNote(notes, start, pitch, duration));
    audition(pitch);
  };

  // Escape gives a drag up: the notes as they were before it (the window's Escape clears the selection otherwise)
  const onKeyDown = (e: React.KeyboardEvent) => {
    const current = drag.current;
    if (e.key !== 'Escape' || !current) return;
    e.preventDefault();
    drag.current = null;
    if (current.kind === 'rubber') setSelected(current.keep);
    else cancelDrag();
    if (current.kind === 'erase' && gridRef.current) gridRef.current.style.cursor = '';
    setHover({ rubber: null });
  };

  const counter = selected.length ? `${selected.length}/${notes.length}` : String(notes.length);
  return (
    <Root
      tabIndex={0}
      onKeyDown={onKeyDown}
      data-testid='piano-roll'
      aria-label='Piano roll'
      data-mode={mode}
      data-roll-focus
    >
      <RollCorner aria-hidden />
      <RollOverview view={view} notes={notes} length={length} workspace={workspace} onView={setView} />
      <RollCorner aria-label='Notes' title={selected.length ? 'Selected of the notes' : 'Notes'}>
        {counter}
      </RollCorner>
      <RollRuler
        view={view}
        length={length}
        workspace={workspace}
        // dragged along the grid (off it a sixteenth)
        step={snap ? step : CLIP_PPQ / 4}
        onEnd={onEnd}
      />
      <RollKeys view={view} hover$={hover$} selected={chosenPitches} />
      <RollGrid
        ref={gridRef}
        onPointerDown={onGridDown}
        onPointerMove={onGridMove}
        onPointerUp={onGridUp}
        onPointerCancel={onGridUp}
        onLostPointerCapture={onGridUp}
        onPointerLeave={() => !drag.current && setHover({ pitch: null, ghost: null })}
        onDoubleClick={onGridDoubleClick}
        // the right button takes notes away (draw mode): no menu of the browser, in select mode either
        onContextMenu={(e) => e.preventDefault()}
        data-testid='roll-grid'
      >
        <canvas {...linesCanvas} />
        <canvas {...notesCanvas} data-testid='roll-notes' />
        <canvas {...overlayCanvas} data-testid='roll-overlay' />
        <canvas {...playhead} />
        {notes.length === 0 && (
          <Empty data-testid='roll-empty'>
            {mode === 'draw' ? (
              <span>
                <b>Click and drag</b> to draw notes
              </span>
            ) : (
              <span>
                <b>Double-click</b> to add a note, <b>{modKey}B</b> or the pencil to draw them
              </span>
            )}
            <small>or drop a .mid file here</small>
          </Empty>
        )}
      </RollGrid>
      <VelocityLane view={view} editor={editor} />
    </Root>
  );
};
