import React from 'react';
import { useBehaviorSubject, useObservable } from '@chisper/rxjs-react';
import { SourceAlert } from '../../../common/components';
import { useNoise, useSynthCore } from '../../common/modules';
import type { TableState } from '../../common/wavetable/wavetable-engine';
import { oscillatorStatusMessage } from '../../oscillator/components/oscillator-status';

// why the sample of the noise doesn't play (the one before it does); none: it plays, or it is on its way
export const sampleStateMessage = (state: TableState | null) => {
  switch (state) {
    case 'refused':
      return 'Not enough memory for the sample';
    case 'failed':
      return 'The sample failed to load';
    default:
      return undefined;
  }
};

// over the overview of the noise while it is on: why it can't play (the oscillators can't: Retry loads them
// again), else why its sample doesn't (Retry sends it again)
export const NoiseStatus = () => {
  const [{ wavetables }, { retryAudio }] = useSynthCore();
  const [{ $active, $sampleState }, { retrySample }] = useNoise();
  const active = useBehaviorSubject($active);
  const status = useBehaviorSubject(wavetables.$status);
  const sampleState = useObservable($sampleState, null);
  if (!active) return null;
  const message = oscillatorStatusMessage(status);
  const sampleMessage = sampleStateMessage(sampleState);
  if (!message && !sampleMessage) return null;
  return (
    <SourceAlert onRetry={message ? status === 'failed' && retryAudio : retrySample}>
      {message ? <>Noise can&apos;t play: {message}</> : sampleMessage}
    </SourceAlert>
  );
};
