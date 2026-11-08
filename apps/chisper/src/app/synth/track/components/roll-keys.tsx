import React from 'react';
import { combineLatest, Observable, of } from 'rxjs';
import { singlePointerTracker, useCanvas, useElementSize } from '@chisper/ui-kit';
import { DEFAULT_VELOCITY, useInputController } from '../../common/modules';
import { midiToNote, octavePitches } from '../../services';
import { useTrack } from '../modules/track';
import { drawKeyLights, drawKeys } from '../roll-draw';
import { inPitches, RollView, yPitch } from '../roll-view';
import { RollCell } from './roll-cell';

const NONE: ReadonlySet<number> = new Set();

interface Props {
  view: RollView | null;
  // the row under the pointer on the grid
  hover$?: Observable<number | null>;
  // the pitches of the selected notes
  selected?: ReadonlySet<number>;
}

// the keys of the rows: a press plays the note (the source of the roll), let go releases it (its release lost too: a
// move without a button, the window left; one pointer at a time). Over them, on a canvas of their own, the notes the
// track plays, those the keyboards hold (the computer's, the piano, MIDI, these keys), the row under the pointer and a
// mark on the pitches of the selected notes
export const RollKeys = ({ view, hover$, selected = NONE }: Props) => {
  const [{ $sounding }] = useTrack();
  const [{ $pressed }, { onPress, onRelease }] = useInputController();
  const [ref, [width, height]] = useElementSize<HTMLDivElement>();
  const { canvas: keysCanvas, begin: beginKeys } = useCanvas(width, height);
  const { canvas: lightsCanvas, begin: beginLights } = useCanvas(width, height);
  const held = React.useRef<number | null>(null);
  const [track] = React.useState(singlePointerTracker);
  // the rows of the view (the keys draw nothing again as it moves across)
  const rows = React.useMemo(
    () => view,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view?.top, view?.row, view?.height]
  );
  React.useEffect(() => {
    const context = beginKeys();
    if (context && rows) drawKeys(context, rows, width);
  }, [beginKeys, rows, width, height]);
  React.useEffect(() => {
    if (!rows) return undefined;
    const subscription = combineLatest([hover$ ?? of(null), $sounding, $pressed]).subscribe(
      ([hover, sounding, pressed]) => {
        const context = beginLights();
        if (context)
          drawKeyLights(context, rows, width, { hover, sounding, pressed: octavePitches(pressed), selected });
      }
    );
    return () => subscription.unsubscribe();
  }, [beginLights, rows, width, height, hover$, $sounding, $pressed, selected]);
  const release = () => {
    if (held.current !== null) onRelease(midiToNote(held.current), { source: 'roll' });
    held.current = null;
  };
  return (
    <RollCell
      ref={ref}
      style={{ cursor: 'pointer' }}
      onPointerDown={(e) => {
        if (!view || e.button !== 0) return;
        const pitch = yPitch(view, e.clientY - e.currentTarget.getBoundingClientRect().top);
        if (!inPitches(pitch) || !track(e, undefined, release)) return;
        e.currentTarget.setPointerCapture?.(e.pointerId);
        held.current = pitch;
        onPress(midiToNote(pitch), DEFAULT_VELOCITY, { source: 'roll' });
      }}
      data-testid='roll-keys'
    >
      <canvas {...keysCanvas} />
      <canvas {...lightsCanvas} data-testid='roll-key-lights' />
    </RollCell>
  );
};
