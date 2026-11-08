import React from 'react';
import { styled } from 'styled-components';
import hexToRgba from 'hex-to-rgba';
import { CLIP_BAR, CLIP_LENGTH_MAX, CLIP_PPQ } from '@chisper/preset-schema';
import { theme, useCanvas, useElementSize } from '@chisper/ui-kit';
import { useBehaviorSubject } from '@chisper/rxjs-react';
import { useTransport } from '../../common/modules';
import { useTrack } from '../modules/track';
import { drawRuler } from '../roll-draw';
import { endInView, loopEndAt, RollView, tickX, xTick } from '../roll-view';
import { releaseLost, RollCell } from './roll-cell';

// px of the flag of the end of the loop
const FLAG_WIDTH = 12;

// the end of the loop: a flag of the color of the loop on the ruler, its line down the roll (drawn by the grid)
const Flag = styled.div`
  position: absolute;
  top: 0;
  bottom: 0;
  width: ${FLAG_WIDTH}px;
  margin-left: -${FLAG_WIDTH - 1}px;
  cursor: ew-resize;
  touch-action: none;
  outline: none;

  &::before {
    content: '';
    position: absolute;
    top: 0;
    right: 0;
    width: ${FLAG_WIDTH - 1}px;
    height: 70%;
    background: ${theme.colors.secondAccent};
    clip-path: polygon(0 0, 100% 0, 100% 100%, 0 60%);
    transition: filter 150ms;
  }

  &::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    right: 0;
    width: 2px;
    background: ${theme.colors.secondAccent};
  }

  &:hover::before,
  &:focus-visible::before,
  &.dragged::before {
    filter: drop-shadow(0 0 4px ${hexToRgba(theme.colors.secondAccent, 0.9)}) brightness(1.15);
  }
`;

interface Props {
  view: RollView | null;
  // the loop and the bars of the roll (ticks)
  length: number;
  workspace: number;
  // the ticks the end of the loop steps by when dragged (the grid)
  step: number;
  // the end of the loop moved to a tick, on the screen (`done`: let go)
  onEnd: (tick: number, done: boolean) => void;
}

// the bars over the roll: a press on one of the loop plays from it (not while a MIDI Clock leads), the flag of its end dragged along the steps
// (← → move it a bar); the flag moves within the screen of the roll: dragged past its edge it stays at the last
// step in it, an arrow that would take it out does nothing; a drag whose release is lost sets the end it was dragged
// to (`releaseLost`)
export const RollRuler = ({ view, length, workspace, step, onEnd }: Props) => {
  const [, { playFrom }] = useTrack();
  const [{ $source }] = useTransport();
  const onPlayFrom = useBehaviorSubject($source) === 'midi' ? null : playFrom;
  const [ref, [width, height]] = useElementSize<HTMLDivElement>();
  const { canvas, begin } = useCanvas(width, height);
  const [hoverBar, setHoverBar] = React.useState<number | null>(null);
  // the end the flag was dragged to last, null while it isn't (a ref: the moves before the render that shows it count)
  const drag = React.useRef<number | null>(null);
  const [dragging, setDragging] = React.useState(false);
  // the view across (the ruler draws nothing again as it moves up or down)
  const across = React.useMemo(
    () => view,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view?.tick0, view?.scale]
  );
  React.useEffect(() => {
    const context = begin();
    if (context && across)
      drawRuler(context, { ...across, width, height }, length, workspace, onPlayFrom ? hoverBar : null);
  }, [begin, across, width, height, length, workspace, hoverBar, onPlayFrom]);
  // the tick at a pointer over the ruler (its flag too)
  const tickAt = (e: React.PointerEvent) =>
    view && ref.current ? xTick(view, e.clientX - ref.current.getBoundingClientRect().left) : 0;
  const barAt = (e: React.PointerEvent) => {
    const tick = tickAt(e);
    return tick >= 0 && tick < length ? Math.floor(tick / CLIP_BAR) : null;
  };
  const x = view ? tickX(view, length) : -FLAG_WIDTH;
  // the flag let go: the end at `end`, else where it was dragged to last
  const finish = (end?: number) => {
    const last = drag.current;
    if (last === null) return;
    drag.current = null;
    setDragging(false);
    onEnd(end ?? last, true);
  };
  return (
    <RollCell
      ref={ref}
      style={{ cursor: onPlayFrom ? 'pointer' : 'default' }}
      onPointerMove={(e) => {
        if (drag.current === null) setHoverBar(barAt(e));
      }}
      onPointerLeave={() => setHoverBar(null)}
      onPointerDown={(e) => {
        if (!view || e.button !== 0 || !onPlayFrom) return;
        const bar = barAt(e);
        if (bar !== null) onPlayFrom((bar * CLIP_BAR) / CLIP_PPQ);
      }}
      data-testid='roll-ruler'
    >
      <canvas {...canvas} />
      {x > -FLAG_WIDTH && x < width + FLAG_WIDTH && (
        <Flag
          className={dragging ? 'dragged' : undefined}
          style={{ left: x }}
          role='slider'
          tabIndex={0}
          aria-label='The end of the loop'
          aria-valuemin={CLIP_PPQ / CLIP_BAR}
          aria-valuemax={CLIP_LENGTH_MAX / CLIP_BAR}
          aria-valuenow={length / CLIP_BAR}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            e.currentTarget.setPointerCapture?.(e.pointerId);
            drag.current = length;
            setDragging(true);
            setHoverBar(null);
          }}
          onPointerMove={(e) => {
            if (drag.current === null || !view) return;
            e.stopPropagation();
            if (releaseLost(e)) {
              finish();
              return;
            }
            drag.current = loopEndAt(view, tickAt(e), step);
            onEnd(drag.current, false);
          }}
          onPointerUp={(e) => finish(view ? loopEndAt(view, tickAt(e), step) : undefined)}
          onPointerCancel={() => finish()}
          onLostPointerCapture={() => finish()}
          onKeyDown={(e) => {
            const bars = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[e.key];
            if (!bars || !view) return;
            e.preventDefault();
            e.stopPropagation();
            // to the next line of a bar on that side (a beat at least), on the screen
            const next = Math.min(
              CLIP_LENGTH_MAX,
              Math.max(
                CLIP_PPQ,
                bars > 0
                  ? (Math.floor(length / CLIP_BAR) + 1) * CLIP_BAR
                  : (Math.ceil(length / CLIP_BAR) - 1) * CLIP_BAR
              )
            );
            if (next !== length && endInView(view, next)) onEnd(next, true);
          }}
        />
      )}
    </RollCell>
  );
};
