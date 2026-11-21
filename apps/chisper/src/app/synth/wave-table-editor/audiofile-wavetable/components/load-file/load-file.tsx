import React from 'react';
import toast from 'react-hot-toast';
import { styled } from 'styled-components';
import { AUDIO_ACCEPT, FileDrop, isAudioFile, textLight14, theme } from '@chisper/ui-kit';
import { featureUsed } from '../../../../../common/services/analytics';
import { MAX_FRAMES } from '../../../../common/wavetable/wavetable-mipmap';
import { AudioFile, readAudioFile } from '../../../../services/audio-file';
import { Wavetable } from '../../../../services/wavetable';
import { Button, Examples } from './examples';

const DropText = styled.div`
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  height: 100%;
  gap: 5px;

  h1 {
    text-transform: uppercase;
    font-weight: 600;
    color: ${theme.colors.primaryLowContrast};
  }

  span {
    ${textLight14};
    color: ${theme.colors.primaryMediumContrast};
  }
`;

const Choose = styled(Button)`
  margin-top: 20px;
`;

// the longest audio file cut into waves
export const MAX_SECONDS = 12;

const waves = (count: number) => `${count} wave${count === 1 ? '' : 's'}`;

interface Props {
  // the samples of an audio file, cut into waves next
  onLoad: (samples: Float32Array) => void;
  // a WAV wavetable, its waves as they are
  onWavetable: (wavetable: Wavetable) => void;
}

// a file dropped, chosen (a finger or a pen too: nothing to drag there) or an example: a WAV wavetable plays at once,
// an audio file of MAX_SECONDS at most goes to the cutter; a toast says why another one is not taken
export const LoadFile = ({ onLoad, onWavetable }: Props) => {
  const input = React.useRef<HTMLInputElement>(null);
  // whether the file was taken
  const load = async (buffer: ArrayBuffer, name: string) => {
    let file: AudioFile;
    try {
      file = await readAudioFile(buffer);
    } catch {
      toast.error(`${name} can't be read as audio`);
      return false;
    }
    if (file.kind === 'wavetable') {
      const { wavetable, frames } = file;
      onWavetable(wavetable);
      const kept = wavetable.frames.length;
      toast.success(
        kept < frames
          ? `${name}: the first ${kept} of ${waves(frames)}`
          : `${name}: a wavetable of ${waves(kept)}`
      );
      return true;
    }
    if (file.samples.length / file.sampleRate > MAX_SECONDS) {
      toast.error(`${name} is longer than ${MAX_SECONDS} seconds`);
      return false;
    }
    onLoad(file.samples);
    return true;
  };
  // a file of the user (not an example)
  const loadFile = async (file: File) => {
    if (await load(await file.arrayBuffer(), file.name)) featureUsed('wavetable_editor', 'audio_import');
  };
  const onChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // the same file may be chosen again
    e.target.value = '';
    if (!file) return;
    if (!isAudioFile(file)) {
      toast.error(`${file.name} is not an audio file`);
      return;
    }
    await loadFile(file);
  };
  return (
    <FileDrop onFileDrop={loadFile}>
      <DropText>
        <h1>Drop an audio file or a WAV wavetable here</h1>
        <span>
          Audio up to {MAX_SECONDS} seconds, a wavetable of up to {MAX_FRAMES} waves
        </span>
        <input
          ref={input}
          type='file'
          accept={AUDIO_ACCEPT}
          onChange={onChosen}
          hidden
          aria-label='Audio or wavetable file'
        />
        <Choose onClick={() => input.current?.click()}>Choose a file</Choose>
        <Examples onLoad={load} />
      </DropText>
    </FileDrop>
  );
};
