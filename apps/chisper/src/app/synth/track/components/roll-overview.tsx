import React from 'react';
import { ClipNote } from '@chisper/preset-schema';
import { useCanvas, useElementSize } from '@chisper/ui-kit';
import { drawOverview, drawOverviewWindow } from '../roll-draw';
import {
  clampView,
  overviewHit,
  overviewResize,
  overviewTickAt,
  overviewX,
  RollView,
  visibleTicks,
} from '../roll-view';
import { releaseLost, RollCell } from './roll-cell';
import { usePlayhead } from './use-playhead';

const CURSORS = { start: 'ew-resize', end: 'ew-resize', inside: 'grab', outside: 'pointer' } as const;

// what a press on the overview drags: an edge of the window (the zoom), or the window (`grab`: the ticks from its
// start to the pointer)
type Drag = { kind: 'start' | 'end' } | { kind: 'move'; grab: number };

interface Props {
  view: RollView | null;
  notes: readonly ClipNote[];
  // the loop and the bars of the roll (ticks)
  length: number;
  workspace: number;
  onView: (view: RollView) => void;
}

// the bars of the roll over it, their notes and the window of the view: the window dragged scrolls the view (a press
// beside it takes its middle there first), its edges dragged zoom it (a drag whose release is lost ends: `releaseLost`);
// where the output plays a line on a canvas of its own (every frame it moves, nothing else drawn again)
export const RollOverview = ({ view, notes, length, workspace, onView }: Props) => {
  const [ref, [width, height]] = useElementSize<HTMLDivElement>();
  const { canvas, begin } = useCanvas(width, height);
  const { canvas: windowCanvas, begin: beginWindow } = useCanvas(width, height);
  const drag = React.useRef<Drag | null>(null);
  React.useEffect(() => {
    const context = begin();
    if (context) drawOverview(context, notes, length, workspace, width, height);
  }, [begin, notes, length, workspace, width, height]);
  React.useEffect(() => {
    const context = beginWindow();
    if (context && view) drawOverviewWindow(context, view, workspace, width, height);
  }, [beginWindow, view, workspace, width, height]);
  const playheadX = React.useCallback(
    (tick: number) => overviewX(workspace, width, tick),
    [workspace, width]
  );
  const playhead = usePlayhead(width, height, playheadX);
  const xOf = (e: React.PointerEvent<HTMLDivElement>) =>
    e.clientX - e.currentTarget.getBoundingClientRect().left;
  const apply = (e: React.PointerEvent<HTMLDivElement>, current: Drag) => {
    if (!view) return;
    const x = xOf(e);
    onView(
      current.kind === 'move'
        ? clampView({ ...view, tick0: overviewTickAt(workspace, width, x) - current.grab }, workspace)
        : overviewResize(view, workspace, width, x, current.kind)
    );
  };
  // let go (the cursor of where the pointer is from its next move)
  const end = (element: HTMLElement) => {
    drag.current = null;
    element.style.cursor = '';
  };
  return (
    <RollCell
      ref={ref}
      aria-label='Overview of the bars'
      onPointerDown={(e) => {
        if (e.button !== 0 || !view) return;
        e.currentTarget.setPointerCapture?.(e.pointerId);
        const x = xOf(e);
        const hit = overviewHit(view, workspace, width, x);
        const current: Drag =
          hit === 'start' || hit === 'end'
            ? { kind: hit }
            : {
                kind: 'move',
                grab:
                  hit === 'inside'
                    ? overviewTickAt(workspace, width, x) - view.tick0
                    : visibleTicks(view) / 2,
              };
        drag.current = current;
        if (current.kind === 'move' && hit === 'outside') apply(e, current);
        e.currentTarget.style.cursor = current.kind === 'move' ? 'grabbing' : 'ew-resize';
      }}
      onPointerMove={(e) => {
        if (drag.current && releaseLost(e)) end(e.currentTarget);
        if (drag.current) apply(e, drag.current);
        else if (view) e.currentTarget.style.cursor = CURSORS[overviewHit(view, workspace, width, xOf(e))];
      }}
      onPointerUp={(e) => end(e.currentTarget)}
      onPointerCancel={(e) => end(e.currentTarget)}
      onLostPointerCapture={(e) => end(e.currentTarget)}
      data-testid='roll-overview'
    >
      <canvas {...canvas} />
      <canvas {...windowCanvas} data-testid='roll-overview-window' />
      <canvas {...playhead} data-testid='roll-overview-playhead' />
    </RollCell>
  );
};
