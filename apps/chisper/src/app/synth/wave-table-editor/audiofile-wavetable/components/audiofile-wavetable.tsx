import React from 'react';
import { styled } from 'styled-components';
import { useOscillatorContext } from '../../../oscillator';
import { WaveSelector } from '../../common/components';
import { AudiofileWavePicker } from './audiofile-wave-picker';
import { WavePreview } from './wave-preview';

const Root = styled.div`
  display: grid;
  grid-template-rows: 65px 1fr 1fr;
  gap: 20px;
  padding: 20px 20px 20px 0;
`;

interface Props {
  // back to the drop screen, for another file
  onAnotherFile: () => void;
}

export const AudiofileWavetable = ({ onAnotherFile }: Props) => {
  const [{ $waveTable, $position, $wave, $morph }, { setPosition }] = useOscillatorContext();
  return (
    <Root>
      <WaveSelector
        $wave={$wave}
        $waveTable={$waveTable}
        $position={$position}
        $morph={$morph}
        setPosition={setPosition}
      />
      <AudiofileWavePicker onAnotherFile={onAnotherFile} />
      <WavePreview />
    </Root>
  );
};
