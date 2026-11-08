import React from 'react';
import { ClipNote } from '@chisper/preset-schema';
import { useCanvas } from '@chisper/ui-kit';
import { useTrack } from '../modules/track';
import { drawGrid, drawNotes, drawPlaying, drawRecording } from '../roll-draw';
import { RollView, tickX } from '../roll-view';
import { usePlayhead } from './use-playhead';

const NO_SELECTION: ReadonlySet<number> = new Set();

interface GridContent {
  // the ticks of the lines of the grid
  step: number;
  // the loop (its end a line)
  length: number;
  notes: readonly ClipNote[];
  // the selected notes (none: the phone's roll)
  chosen?: ReadonlySet<number>;
}

// the canvases of the grid of a roll (`width` × `height`, the rolls of both layouts): its lines and the end of the
// loop, its notes, where the output plays (the notes it is in lit, every frame; the notes REC records growing up to
// it); `shown` the view they show (read in the frames)
export const useRollGrid = (
  view: RollView | null,
  width: number,
  height: number,
  { step, length, notes, chosen = NO_SELECTION }: GridContent
) => {
  const [{ recordingNotes }] = useTrack();
  const { canvas: linesCanvas, begin: beginLines } = useCanvas(width, height);
  const { canvas: notesCanvas, begin: beginNotes } = useCanvas(width, height);
  React.useEffect(() => {
    const context = beginLines();
    if (context && view) drawGrid(context, view, step, length);
  }, [beginLines, view, step, length]);
  React.useEffect(() => {
    const context = beginNotes();
    if (context && view) drawNotes(context, view, notes, chosen);
  }, [beginNotes, view, notes, chosen]);
  const shown = React.useRef(view);
  shown.current = view;
  const xOf = React.useCallback(
    (tick: number) => (view ? tickX(view, tick) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view?.tick0, view?.scale]
  );
  const playhead = usePlayhead(width, height, xOf, (context, tick) => {
    if (!shown.current) return;
    drawPlaying(context, shown.current, notes, tick);
    drawRecording(context, shown.current, recordingNotes());
  });
  return { linesCanvas, notesCanvas, playhead, shown };
};

// the end of the loop: where its flag is dragged (on the screen), set when let go
export const useLoopEnd = (length: number, setLength: (length: number) => void) => {
  const [end, setEnd] = React.useState<number | null>(null);
  const onEnd = (next: number, done: boolean) => {
    setEnd(done ? null : next);
    if (done) setLength(next);
  };
  return [end ?? length, onEnd] as const;
};
