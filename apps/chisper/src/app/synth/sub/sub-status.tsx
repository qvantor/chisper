import React from 'react';
import { styled } from 'styled-components';
import { useBehaviorSubject, useObservable } from '@chisper/rxjs-react';
import { SourceAlert } from '../../common/components';
import { useSub, useSynthCore } from '../common/modules';
import type { TableState } from '../common/wavetable/wavetable-engine';
import { oscillatorStatusMessage } from '../oscillator/components/oscillator-status';

// the pointer passes through to the shapes under it (another shape can be chosen), not through Retry
const Alert = styled(SourceAlert)`
  pointer-events: none;

  button {
    pointer-events: auto;
  }
`;

// why the shape of the sub doesn't play (its notes have no sub); none: it plays, or it is on its way
export const shapeStateMessage = (state: TableState | null) => {
  switch (state) {
    case 'refused':
      return 'Not enough memory for the shape';
    case 'failed':
      return 'The shape failed to build';
    default:
      return undefined;
  }
};

// over the shapes of the sub while it is on: why it can't play (the oscillators can't: Retry loads them again), else
// why its shape doesn't (Retry sends it again)
export const SubStatus = () => {
  const [{ wavetables }, { retryAudio }] = useSynthCore();
  const [{ $active, $shapeState }, { retryShape }] = useSub();
  const active = useBehaviorSubject($active);
  const status = useBehaviorSubject(wavetables.$status);
  const shapeState = useObservable($shapeState, null);
  if (!active) return null;
  const message = oscillatorStatusMessage(status);
  const shapeMessage = shapeStateMessage(shapeState);
  if (!message && !shapeMessage) return null;
  return (
    <Alert onRetry={message ? status === 'failed' && retryAudio : retryShape}>
      {message ? <>Sub can&apos;t play: {message}</> : shapeMessage}
    </Alert>
  );
};
