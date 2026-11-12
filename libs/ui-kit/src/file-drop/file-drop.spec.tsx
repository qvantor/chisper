import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { FileDrop, isAudioFile } from './index';

const file = (name: string, type: string) => new File(['RIFF'], name, { type });

// a drag of one file: what the page sees while it moves (its kind and type) and what it gets when dropped
const drag = (dropped: File) => {
  const dataTransfer = { items: [{ kind: 'file', type: dropped.type }], files: [dropped] };
  const target = screen.getByText('Drop here');
  fireEvent.dragEnter(target, { dataTransfer });
  fireEvent.drop(target, { dataTransfer });
};

describe('FileDrop', () => {
  it('takes an audio file by its type, or by its name where it has none', () => {
    const onFileDrop = jest.fn();
    render(
      <FileDrop onFileDrop={onFileDrop}>
        <span>Drop here</span>
      </FileDrop>
    );

    const wav = file('Table.WAV', '');
    drag(wav);
    const mp3 = file('bass', 'audio/mpeg');
    drag(mp3);
    drag(file('notes.txt', 'text/plain'));
    drag(file('notes.txt', ''));

    expect(onFileDrop.mock.calls).toEqual([[wav], [mp3]]);
  });
});

describe('isAudioFile', () => {
  it.each([
    ['a.wav', '', true],
    ['a.aiff', 'application/octet-stream', true],
    ['a.flac', '', true],
    ['a', 'audio/ogg', true],
    ['a.png', 'image/png', false],
    ['wav', '', false],
  ])('%s of type "%s": %s', (name, type, audio) => {
    expect(isAudioFile({ name, type })).toBe(audio);
  });
});
