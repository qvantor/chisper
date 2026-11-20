import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { CLIP_PPQ } from '@chisper/preset-schema';
import { createSynth, createTrack, stopModels } from '../../../../test-utils/models';
import { TrackContext } from '../modules/track';
import { RollHeader } from './roll-header';

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve)));

afterEach(() => {
  cleanup();
  stopModels();
  jest.restoreAllMocks();
  sessionStorage.clear();
  localStorage.clear();
});

const editor = { shortcutsOpen: false, setShortcutsOpen: () => undefined } as unknown as React.ComponentProps<
  typeof RollHeader
>['editor'];

// the header alone (no models of the sound: no .wav), on a desktop with Close or `compact` as on a phone
const setup = async ({ compact = false } = {}) => {
  const modules = createSynth();
  await flush();
  const { track } = createTrack(modules);
  track[1].setNotes([[0, CLIP_PPQ, 60, 100]]);
  const onSave = jest.fn();
  const onClose = jest.fn();
  render(
    <TrackContext.Provider value={track}>
      <RollHeader
        editor={editor}
        onSave={onSave}
        saving={false}
        compact={compact}
        onClose={compact ? undefined : onClose}
      />
    </TrackContext.Provider>
  );
  return { track, onSave, onClose };
};

const group = (name: string) => screen.getByRole('group', { name });
const keysOf = (name: string) =>
  within(group(name))
    .getAllByRole('button')
    .map((key) => key.getAttribute('aria-label') ?? key.textContent);

describe('the header of the roll', () => {
  it('its keys in sections: the clip, its files, its link; the shortcuts and Close apart', async () => {
    await setup();
    expect(keysOf('Clip')).toEqual(['New clip', 'Import']);
    expect(keysOf('Download')).toEqual(['Export MIDI']);
    expect(keysOf('Link')).toEqual(['Save', 'More ways to save', 'Share']);
    for (const name of ['Shortcuts', 'Close']) {
      const key = screen.getByRole('button', { name });
      expect(key.closest('[role=group]')).toBeNull();
    }
  });

  it('a .mid downloaded by a key of the download icon and its extension; the notes of the clip', async () => {
    await setup();
    const key = screen.getByRole('button', { name: 'Export MIDI' });
    expect(key.textContent).toBe('.mid');
    expect(key.querySelector('svg')).toBeTruthy();
    const createObjectURL = jest.fn((_: Blob) => 'blob:x');
    Object.assign(URL, { createObjectURL, revokeObjectURL: jest.fn() });
    const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    fireEvent.click(key);
    expect(createObjectURL.mock.calls[0][0].type).toBe('audio/midi');
    expect((click.mock.instances[0] as unknown as HTMLAnchorElement).download).toBe('clip.mid');
  });

  it('the keys of the sections do what they did: a new clip, Save, a new link, Share, Close', async () => {
    const { track, onSave, onClose } = await setup();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    expect(onSave.mock.calls).toEqual([['save'], ['share']]);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'New clip' }));
    expect(track[0].$clip.value.notes).toEqual([]);
  });

  it('on a phone: the link alone (Save, Share), no clip, no .mid, no shortcuts', async () => {
    await setup({ compact: true });
    expect(keysOf('Link')).toEqual(['Save', 'Share']);
    expect(screen.queryByRole('group', { name: 'Clip' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Export MIDI' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Shortcuts' })).toBeNull();
    // (no .wav outside the synth: an empty section, not shown)
    expect(screen.queryByRole('group', { name: 'Download' })).toBeNull();
    const files = screen.getByTestId('roll-header').querySelector("[aria-label='Download']");
    expect(files?.childElementCount).toBe(0);
    expect(getComputedStyle(files as Element).display).toBe('none');
  });
});
