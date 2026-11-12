import React from 'react';
import { styled } from 'styled-components';
import { theme } from '../common/constants';

interface Props {
  onFileDrop?: (file: File) => void;
}

// the names of audio files, for those a system gives no type (a .wav often comes without one)
const AUDIO_EXTENSIONS = 'wav wave aif aiff aifc caf mp3 ogg oga opus flac m4a aac webm'.split(' ');
const AUDIO_NAME = new RegExp(`\\.(${AUDIO_EXTENSIONS.join('|')})$`, 'i');

// the audio files a file dialog offers (`accept` of its input)
export const AUDIO_ACCEPT = ['audio/*', ...AUDIO_EXTENSIONS.map((extension) => `.${extension}`)].join(',');

// an audio file by its type or by its name
export const isAudioFile = ({ type, name }: Pick<File, 'type' | 'name'>) =>
  type.startsWith('audio/') || AUDIO_NAME.test(name);

interface StyledProps {
  $droppable: boolean;
}

const FileDropRoot = styled.div<StyledProps>`
  transition: all 150ms;
  background: ${({ $droppable }) => ($droppable ? theme.colors.primaryLowContrast : theme.colors.primary)};

  box-shadow: ${({ $droppable }) =>
    $droppable
      ? `inset 0 0 0 10px ${theme.colors.primaryLowContrast}, inset 0 0 0 11px ${theme.colors.primary}`
      : 'none'};
`;

export const FileDrop = ({ children, onFileDrop }: React.PropsWithChildren<Props>) => {
  const [droppable, setDroppable] = React.useState(false);
  // a dragged file tells only its type (no name): an audio one, or one of no type, may be dropped
  const onDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const item = e.dataTransfer.items[0];
    if (item?.kind === 'file' && (item.type === '' || item.type.startsWith('audio/'))) setDroppable(true);
  };
  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  };
  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!droppable) return;
    setDroppable(false);
    const file = e.dataTransfer.files[0];
    if (file && isAudioFile(file)) onFileDrop?.(file);
  };
  const onDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDroppable(false);
  };
  return (
    <FileDropRoot
      $droppable={droppable}
      onDragEnter={onDragEnter}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      {children}
    </FileDropRoot>
  );
};
