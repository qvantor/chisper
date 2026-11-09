import React from 'react';
import { ClipNote } from '@chisper/preset-schema';
import { theme, useCanvas, useElementSize } from '@chisper/ui-kit';
import { useTrack } from '../modules/track';
import { drawLane } from '../roll-draw';
import { headAt, laneVelocity, RollView, stemNotes, stemSpan, xTick } from '../roll-view';
import { moveVelocity, paintVelocity } from '../track-edit';
import { releaseLost, RollCell, RollCorner } from './roll-cell';
import { RollEditor } from './use-roll-editor';

// px from the stem pressed and its heads the pointer moves across and the stem stays held (the hand drifts as it
// drags up and down: past it, painting over a chord would set its notes to one value)
const HOLD_REACH = 12;

// a drag on the lane: the velocity of the notes of a stem (a chord: all of them; by a selected note, the selected
// notes only, those of other stems too, never the others there nor those of a stem beside), moved together: the one
// whose head is nearest the press (`anchor`) to the pointer, the others by as much (they keep their differences),
// held up and down past the lane (`last` its point, `at` the pointer's px, `notes` as they are) until the pointer
// moves across within the lane away from the stem (`span`, px across; a hand drifts as it drags up and down: out of
// the lane, or a move more up or down than across, it stays held), then painted on over every note it passes; a press
// between the stems paints at once (freehand from point to point; with Shift a line from the press over the notes as
// they were). One step of the undo either way
type LaneDrag =
  | {
      kind: 'stem';
      span: [number, number];
      last: [number, number];
      at: [number, number];
      base: ClipNote[];
      notes: ClipNote[];
      targets: number[];
      anchor: number;
    }
  | {
      kind: 'paint';
      base: ClipNote[];
      notes: ClipNote[];
      from: [number, number];
      last: [number, number];
      line: boolean;
    };

interface Props {
  view: RollView | null;
  editor: RollEditor;
}

// the corner of the lane (VEL, the velocity being set as it is dragged), then the lane: two cells of the grid
// of the roll (a drag renders them alone). The velocities of the notes under the roll (1..127 of MIDI, the
// most at the top): a stem from the bottom up to a head across at the start of each (roll-draw.ts), taken by
// the stem or its heads, dragged up or down (held past the lane too), painted across the notes the pointer
// passes once it moves away from the stem or from a press between the stems (the cursor tells which: ↕ or a
// cross); a pointer past the lane sets its edge. A drag whose release is lost ends as it was (`releaseLost`)
export const VelocityLane = ({ view, editor }: Props) => {
  const [, { startGesture, moveGesture, endGesture }] = useTrack();
  const { notes, selected, chosen } = editor;
  const [ref, [width, height]] = useElementSize<HTMLDivElement>();
  const { canvas, begin } = useCanvas(width, height);
  const drag = React.useRef<LaneDrag | null>(null);
  // the velocity being set (null: none is)
  const [value, onValue] = React.useState<number | null>(null);
  // the view across (the lane draws nothing again as it moves up or down)
  const across = React.useMemo(
    () => view,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view?.tick0, view?.scale]
  );
  React.useEffect(() => {
    const context = begin();
    if (context && across) drawLane(context, { ...across, width, height }, notes, chosen);
  }, [begin, across, width, height, notes, chosen]);

  const pointAt = (e: React.PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - box.left;
    const y = e.clientY - box.top;
    return { x, y, tick: view ? xTick(view, x) : 0, velocity: laneVelocity(height, y) };
  };
  // every note the pointer passes, selected or not
  const paint = (current: Extract<LaneDrag, { kind: 'paint' }>, to: [number, number]) => {
    const painted = current.line
      ? paintVelocity(current.base, current.from, to)
      : paintVelocity(current.notes, current.last, to);
    moveGesture(painted);
    current.notes = painted;
    current.last = to;
  };
  // from a point over the notes as they are (a stem left: as it set them)
  const startPaint = (
    from: [number, number],
    line: boolean,
    base: ClipNote[] = notes
  ): Extract<LaneDrag, { kind: 'paint' }> => ({ kind: 'paint', base, notes: base, from, last: from, line });
  // let go: the velocities as they are, one step of the undo
  const end = () => {
    if (!drag.current) return;
    drag.current = null;
    endGesture();
    onValue(null);
  };

  return (
    <>
      <RollCorner aria-label='Velocity' style={value === null ? undefined : { color: theme.colors.accent }}>
        {value ?? 'VEL'}
      </RollCorner>
      <RollCell
        ref={ref}
        onPointerDown={(e) => {
          if (!view || e.button !== 0) return;
          const { x, y, tick, velocity } = pointAt(e);
          e.currentTarget.setPointerCapture?.(e.pointerId);
          startGesture();
          // the stem or a head of a selected note within reach: the selected ones (not the others there, nor those
          // of a stem nearer); else all the notes of the nearest stem. The lane selects none
          const ofSelected = e.shiftKey ? [] : stemNotes(notes, view, x, chosen);
          const stem = e.shiftKey || ofSelected.length ? ofSelected : stemNotes(notes, view, x);
          const targets = ofSelected.length ? selected : stem;
          onValue(velocity);
          if (!targets.length) {
            const current = startPaint([tick, velocity], e.shiftKey);
            drag.current = current;
            paint(current, [tick, velocity]);
            return;
          }
          const anchor = headAt(notes, stem, height, y);
          const held = moveVelocity(notes, targets, anchor, velocity).notes;
          const span = stemSpan(notes, view, stem, HOLD_REACH);
          drag.current = {
            kind: 'stem',
            span,
            last: [tick, velocity],
            base: notes,
            notes: held,
            targets,
            anchor,
            at: [x, y],
          };
          moveGesture(held);
        }}
        onPointerMove={(e) => {
          if (drag.current && releaseLost(e)) end();
          const current = drag.current;
          if (!current) {
            // what a press does there: takes a stem (up and down), else paints
            if (view)
              e.currentTarget.style.cursor = stemNotes(notes, view, pointAt(e).x).length
                ? 'ns-resize'
                : 'crosshair';
            return;
          }
          const { x, y, tick, velocity } = pointAt(e);
          onValue(velocity);
          if (current.kind === 'paint') {
            paint(current, [tick, velocity]);
            return;
          }
          const [fromX, fromY] = current.at;
          current.at = [x, y];
          const byStem = x >= current.span[0] && x <= current.span[1];
          const across = y >= 0 && y <= height && Math.abs(x - fromX) > Math.abs(y - fromY);
          if (byStem || !across) {
            current.last = [tick, velocity];
            current.notes = moveVelocity(current.base, current.targets, current.anchor, velocity).notes;
            moveGesture(current.notes);
            return;
          }
          // moved across within the lane away from the stem: painted on from its last point held
          const painting = startPaint(current.last, false, current.notes);
          drag.current = painting;
          paint(painting, [tick, velocity]);
        }}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
        data-testid='roll-velocity'
      >
        <canvas {...canvas} />
      </RollCell>
    </>
  );
};
