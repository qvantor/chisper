import React from 'react';
import { styled } from 'styled-components';
import hexToRgba from 'hex-to-rgba';
import { number } from '@chisper/math';
import { theme } from '../common/constants';
import { useElementSize } from '../common/hooks';
import { MarkCanvas, usePickupMark } from '../common/utils/use-mod-mark';

// px of the line of the travel along the bottom of a value, the mark a light dot as high as it
const TRACK_HEIGHT = 4;
const MARK_RADIUS = TRACK_HEIGHT / 2;
const MARK_ALPHA = 0.9;

// the range of the value, as wide as it (--drag-value-track: its color where the default is too strong)
export const Track = styled.div`
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: ${TRACK_HEIGHT}px;
  background: var(--drag-value-track, ${hexToRgba(theme.colors.white, 0.2)});
  pointer-events: none;
`;

// a mark on the line (where the live routes move the value now, where the controller is): a canvas over it the mark
// is painted on (MarkCanvas)
export const ModMark = styled.canvas`
  position: absolute;
  left: 0;
  bottom: 0;
  height: ${TRACK_HEIGHT}px;
  pointer-events: none;
`;

// the mark at a share of the line of `width` px: a light dot on it, within it
export const markCanvas = (width: number): MarkCanvas => ({
  paint: (context, share) => {
    context.globalAlpha = MARK_ALPHA;
    context.fillStyle = theme.colors.white;
    context.beginPath();
    context.arc(
      number.thresholds(share * width, MARK_RADIUS, width - MARK_RADIUS),
      MARK_RADIUS,
      MARK_RADIUS,
      0,
      2 * Math.PI
    );
    context.fill();
  },
  width,
  height: TRACK_HEIGHT,
});

interface PickupTrackProps {
  // where the controller is: a share of the travel
  share: number;
  className?: string;
}

// where the controller is while a value without a line of routes waits for it (MIDI Learn, Pickup): the line of its
// travel along its bottom and the mark on it, rendered by the value while it waits (in a box of its own:
// `position: relative`)
export const PickupTrack = ({ share, className }: PickupTrackProps) => {
  const [ref, [width]] = useElementSize<HTMLDivElement>();
  const mark = React.useMemo(() => markCanvas(width), [width]);
  const { pickupMark } = usePickupMark(mark, share);
  return (
    <Track ref={ref} className={className} data-testid='pickup-track'>
      <ModMark {...pickupMark} style={{ width }} data-testid='value-pickup-mark' />
    </Track>
  );
};
