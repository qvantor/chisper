import React from 'react';
import { onFrame } from '@chisper/ui-kit';
import { useBehaviorSubject } from '@chisper/rxjs-react';
import { useTrack } from '../modules/track';
import {
  clampTop,
  clampView,
  fitLoop,
  fitView,
  followView,
  ROW_DEFAULT,
  RollView,
  scrollView,
  viewAcross,
  ZOOM_STEP,
  zoomAt,
  zoomRows,
} from '../roll-view';
import { RollEditor } from './use-roll-editor';

interface Options {
  // px of a row in a fitted view
  row?: number;
  // the ticks a fitted view shows across, of the bars of the roll (by default the loop and a bar after it: Fit)
  span?: (workspace: number) => number;
  // the ticks the view shows across when it opens, from the start (fitted by default)
  open?: number;
}

const WHEEL_ZOOM = 0.002;

// the view of a roll of `width` × `height` px within the bars of the roll (`workspace` of the editor): `open` ticks
// across once it has a size (fitted without), fitted on Fit (the loop and a bar after it across, `fitLoop`; a
// phone's `span` of the bars), kept on a new size, zoomed by the commands of the editor; once the bars grow it stays
// (the new ones show on the overview: its window narrower), once they shrink it stays within them. The
// wheel over `element` scrolls (Shift: across), Cmd/Ctrl zooms across around the pointer, Alt the rows; while the
// track plays it follows the playhead (`follow` of the editor)
export const useRollView = (
  element: React.RefObject<HTMLElement | null>,
  width: number,
  height: number,
  editor: RollEditor,
  { row = ROW_DEFAULT, span, open }: Options = {}
) => {
  const [{ $playing, positionAt }] = useTrack();
  const playing = useBehaviorSubject($playing);
  const [view, setView] = React.useState<RollView | null>(null);
  const { notes, workspace, view$, follow, clip } = editor;
  const fitted = React.useRef({ notes, workspace, length: clip.length });
  fitted.current = { notes, workspace, length: clip.length };
  // every change of the view within the bars
  const update = React.useCallback(
    (change: (current: RollView) => RollView) =>
      setView((current) => current && clampView(change(current), fitted.current.workspace)),
    []
  );
  const fit = React.useCallback(() => {
    const { notes: shown, workspace: bars, length } = fitted.current;
    return span
      ? fitView(shown, bars, width, height, row, span(bars))
      : fitLoop(shown, length, width, height, row);
  }, [width, height, row, span]);

  React.useEffect(() => {
    if (width <= 0 || height <= 0) return;
    setView((current) =>
      current
        ? clampView(
            { ...current, width, height, top: clampTop(current.top, { height, row: current.row }) },
            fitted.current.workspace
          )
        : clampView(
            open ? viewAcross(fitted.current.notes, width, height, row, open) : fit(),
            fitted.current.workspace
          )
    );
    // (a new size keeps the place: opened once)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height]);

  // the bars grew or shrank: the view stays where it is (more of them: the overview shows them, no jump of the
  // roll), within them (fewer: no wider than them, scrolled within them)
  React.useEffect(() => {
    setView((current) => current && clampView(current, workspace));
  }, [workspace]);

  React.useEffect(() => {
    const subscription = view$.subscribe((command) => {
      if (command === 'fit') {
        if (width > 0 && height > 0) setView(fit());
        return;
      }
      update((current) => zoomAt(current, command === 'in' ? ZOOM_STEP : 1 / ZOOM_STEP));
    });
    return () => subscription.unsubscribe();
  }, [view$, fit, update, width, height]);

  React.useEffect(() => {
    const target = element.current;
    if (!target) return undefined;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const x = e.clientX - target.getBoundingClientRect().left;
      update((current) => {
        const delta = e.deltaY || e.deltaX;
        if (e.ctrlKey || e.metaKey) return zoomAt(current, Math.exp(-delta * WHEEL_ZOOM), x);
        if (e.altKey) return zoomRows(current, Math.exp(-delta * WHEEL_ZOOM));
        if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY))
          return scrollView(current, delta / current.scale);
        const rows = Math.sign(delta) * Math.max(1, Math.round(Math.abs(delta) / current.row));
        return { ...current, top: clampTop(current.top - rows, current) };
      });
    };
    target.addEventListener('wheel', onWheel, { passive: false });
    return () => target.removeEventListener('wheel', onWheel);
  }, [element, update]);

  // the playhead followed: the view goes to it as the following starts (on while the track plays, Play with it on),
  // then pages when it leaves it (a view scrolled away from it is left alone)
  const current = React.useRef(view);
  current.current = view;
  React.useEffect(() => {
    if (!playing || !follow) return undefined;
    let previous: number | null = null;
    return onFrame(() => {
      const tick = positionAt();
      const shown = current.current;
      if (tick === null || !shown) return;
      const tick0 = followView(shown, previous, tick);
      previous = tick;
      if (tick0 !== null) update((last) => ({ ...last, tick0 }));
    });
  }, [playing, follow, positionAt, update]);

  // a change of the view from outside (a pinch, a drag of the overview): within the bars
  const set = React.useCallback((next: RollView) => setView(clampView(next, fitted.current.workspace)), []);
  return [view, set] as const;
};
