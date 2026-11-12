import React from 'react';
import { useOscillatorContext } from '../../oscillator';
import { Wavetable } from '../../services/wavetable';
import { AudiofileProvider } from './modules';
import { LoadFile, AudiofileWavetable } from './components';

// the audio file being cut, kept while the editor is closed (back on the tab, its waves are cut again)
const NO_AUDIO = new Float32Array(0);
let initialBuffer: Float32Array = NO_AUDIO;

interface Props {
  // a WAV wavetable was taken as it is (the editor shows its waves on the drawing tab)
  onWavetable?: () => void;
}

// the drop screen until a file is taken; an audio file is cut into waves here, a WAV wavetable plays as it is
export default ({ onWavetable }: Props) => {
  const oscillator = useOscillatorContext();
  const [, { setWaveTable }] = oscillator;
  const [audioBuffer, setAudioBuffer] = React.useState<Float32Array>(initialBuffer);
  const setAudioBufferInternal = (buffer: Float32Array) => {
    initialBuffer = buffer;
    setAudioBuffer(buffer);
  };
  const takeWavetable = ({ frames, morph }: Wavetable) => {
    // an audio file cut before is let go: back on this tab the drop screen shows, the table stays
    setAudioBufferInternal(NO_AUDIO);
    setWaveTable(frames, morph);
    onWavetable?.();
  };

  if (audioBuffer.length === 0)
    return <LoadFile onLoad={setAudioBufferInternal} onWavetable={takeWavetable} />;

  return (
    <AudiofileProvider initial={{ audioBuffer }} oscillator={oscillator}>
      <AudiofileWavetable onAnotherFile={() => setAudioBufferInternal(NO_AUDIO)} />
    </AudiofileProvider>
  );
};
