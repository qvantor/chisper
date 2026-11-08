import React from 'react';
import { styled } from 'styled-components';
import { onFrame, SegmentDisplay } from '@chisper/ui-kit';
import { useBehaviorSubject } from '@chisper/rxjs-react';
import { useTrack } from '../modules/track';
import { positionLabel } from '../track-edit';

const START = '1.1';

// the bar and the beat the output plays, set when they change (every beat: no render a frame)
const usePlayPosition = () => {
  const [{ $playing, positionAt }] = useTrack();
  const playing = useBehaviorSubject($playing);
  const [label, setLabel] = React.useState(START);
  React.useEffect(() => {
    if (!playing) {
      setLabel(START);
      return undefined;
    }
    return onFrame(() => {
      const position = positionAt();
      setLabel(position === null ? START : positionLabel(position));
    });
  }, [playing, positionAt]);
  return label;
};

const Position = styled.span`
  min-width: 36px;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
`;

// as text (the preview of the clip on a phone)
export const PlayPosition = () => <Position aria-label='Position'>{usePlayPosition()}</Position>;

const Screen = styled.div`
  display: flex;
  align-items: center;
  height: 100%;
  padding: 0 10px;
`;

// on the seven segments of the synth's displays: the bar (two cells), the beat smaller
export const PositionDisplay = ({ height = 18 }: { height?: number }) => (
  <Screen aria-label='Position' role='status'>
    <SegmentDisplay value={usePlayPosition().padStart(4, ' ')} small={1} height={height} />
  </Screen>
);
