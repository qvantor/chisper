import React from 'react';
import { onFrame, useCanvas } from '@chisper/ui-kit';
import { useBehaviorSubject } from '@chisper/rxjs-react';
import { useTrack } from '../modules/track';
import { ROLL_COLORS } from '../roll-draw';

// a canvas over a chart of the clip with a line where the output plays, drawn every frame it moved to another pixel
// while the track plays (no render, nothing in the DOM changes); `xOf` the x of a position of the loop (ticks), null:
// off the canvas; `lit` draws under the line what the position lights (the notes it is in)
export const usePlayhead = (
  width: number,
  height: number,
  xOf: (tick: number) => number | null,
  lit?: (context: CanvasRenderingContext2D, tick: number) => void
) => {
  const [{ $playing, positionAt }] = useTrack();
  const playing = useBehaviorSubject($playing);
  const { canvas, begin } = useCanvas(width, height);
  const lights = React.useRef(lit);
  lights.current = lit;
  React.useEffect(() => {
    begin();
    if (!playing) return undefined;
    let last: number | null = NaN;
    return onFrame(() => {
      const position = positionAt();
      const at = position === null ? null : xOf(position);
      const x = at === null ? null : Math.round(at);
      if (x === last) return;
      last = x;
      const context = begin();
      if (!context || x === null || position === null) return;
      lights.current?.(context, position);
      context.fillStyle = ROLL_COLORS.playhead;
      context.fillRect(x - 0.5, 0, 1.5, height);
    });
  }, [playing, begin, xOf, height, positionAt]);
  return canvas;
};
