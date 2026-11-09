import React from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import toast from 'react-hot-toast';
import type { Preset } from '@chisper/preset-schema';
import { fakePreset } from '../../../test-utils/presets-fixtures';
import { renderWithPresets } from '../../../test-utils/presets-wrapper';
import { getPreset, getTopPresets, sharePreset } from '../services';
import { PresetSection } from './preset-section';

jest.mock('../services', () => ({
  ...jest.requireActual('../services'),
  getPreset: jest.fn(),
  getTopPresets: jest.fn(() => new Promise(() => undefined)),
  isNameAvailable: jest.fn(() => new Promise(() => undefined)),
  sharePreset: jest.fn(),
}));

const getPresetMock = jest.mocked(getPreset);
const getTopPresetsMock = jest.mocked(getTopPresets);

const list = [
  { id: 'a', name: 'A', uniqueUsers: 0 },
  { id: 'b', name: 'B', uniqueUsers: 0 },
  { id: 'c', name: 'C', uniqueUsers: 0 },
];

beforeEach(() => {
  getPresetMock.mockImplementation(fakePreset);
  // the preset opened on start is random: the first one
  jest.spyOn(Math, 'random').mockReturnValue(0);
});

describe('PresetSection', () => {
  const setupSection = (actions?: React.ReactNode) => {
    const user = userEvent.setup();
    const result = renderWithPresets(<PresetSection actions={actions} />);
    const prev = screen.getByRole('button', { name: 'Previous preset' });
    const next = screen.getByRole('button', { name: 'Next preset' });
    // the name follows ◀
    const name = prev.nextElementSibling as HTMLElement;
    return { ...result, user, prev, next, name };
  };

  it('shows Init without a preset and the current preset name with a dirty mark', () => {
    const { name, presets } = setupSection();
    expect(name).toHaveTextContent(/^Init$/);

    act(() => presets[1].setSaved({ id: 'a', name: 'Bright pad' }));
    expect(name).toHaveTextContent(/^Bright pad$/);

    act(() => presets[0].$dirty.next(true));
    expect(name).toHaveTextContent(/^Bright pad \*$/);
  });

  it('opens a popular preset on start and steps through the popular presets', async () => {
    getTopPresetsMock.mockResolvedValueOnce(list);
    const { user, prev, next, name, presets } = setupSection();
    expect(prev).toBeEnabled();
    expect(next).toBeEnabled();
    await waitFor(() => expect(name).toHaveTextContent(/^Preset a$/));

    await user.click(prev);
    await waitFor(() => expect(presets[0].$current.value?.id).toBe('c'));
    await user.click(next);
    await waitFor(() => expect(presets[0].$current.value?.id).toBe('a'));
    await user.click(next);
    await waitFor(() => expect(name).toHaveTextContent(/^Preset b$/));
    expect(getTopPresetsMock).toHaveBeenCalledTimes(1);
  });

  it('Init between the name and ▶ leaves the preset and its changes', async () => {
    const { user, name, next, presets } = setupSection();
    const init = screen.getByRole('button', { name: 'Init preset' });
    expect(name.nextElementSibling).toBe(init);
    expect(init.nextElementSibling).toBe(next);

    act(() => presets[1].setSaved({ id: 'a', name: 'Bright pad' }));
    act(() => presets[0].$dirty.next(true));
    expect(name).toHaveTextContent(/^Bright pad \*$/);
    expect(window.location.search).toBe('?preset=a');

    await user.click(init);
    expect(name).toHaveTextContent(/^Init$/);
    expect(presets[0].$current.value).toBeNull();
    expect(window.location.search).toBe('');
  });

  it('shows the chosen preset at once over the bar of its loading, the current one back if it fails', async () => {
    getTopPresetsMock.mockResolvedValueOnce(list);
    const { user, next, name } = setupSection();
    await waitFor(() => expect(name).toHaveTextContent(/^Preset a$/));
    expect(screen.queryByRole('progressbar')).toBeNull();

    let resolve!: (preset: Preset) => void;
    getPresetMock.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    await user.click(next);
    expect(name).toHaveTextContent(/^B$/);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('10');
    const b = await fakePreset('b');
    await act(async () => resolve(b));
    expect(name).toHaveTextContent(/^Preset b$/);
    // (the switch of this wrapper is immediate: the sound is loaded at once)
    expect(screen.queryByRole('progressbar')).toBeNull();

    let reject!: (error: Error) => void;
    getPresetMock.mockReturnValueOnce(new Promise((_, r) => (reject = r)));
    await user.click(next);
    expect(name).toHaveTextContent(/^C$/);
    await act(async () => reject(new Error('Not found')));
    expect(name).toHaveTextContent(/^Preset b$/);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(toast.error).toHaveBeenCalledWith('Not found');
  });

  it('shows Loading… for the preset of a link until it comes, no dirty mark while it loads', async () => {
    window.history.replaceState(null, '', '/?preset=x');
    let resolve!: (preset: Preset) => void;
    getPresetMock.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const { name, presets } = setupSection();
    expect(name).toHaveTextContent(/^Loading…$/);
    act(() => presets[0].$dirty.next(true));
    expect(name).toHaveTextContent(/^Loading…$/);

    const x = await fakePreset('x');
    await act(async () => resolve(x));
    expect(name).toHaveTextContent(/^Preset x$/);
    window.history.replaceState(null, '', '/');
  });

  it('opens the preset browser by the name', async () => {
    const { user, name } = setupSection();
    await user.click(name);
    expect(await screen.findByRole('dialog', { name: 'Presets' })).toBeInTheDocument();
  });

  it('opens the save dialog by Save and by Cmd/Ctrl+S', async () => {
    const { user } = setupSection();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('dialog', { name: 'Save preset' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Save preset' })).not.toBeInTheDocument()
    );

    const event = new KeyboardEvent('keydown', {
      code: 'KeyS',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      document.dispatchEvent(event);
    });
    expect(await screen.findByRole('dialog', { name: 'Save preset' })).toBeInTheDocument();
    // the browser's own "save page" is suppressed
    expect(event.defaultPrevented).toBe(true);
  });

  it('does not open the save dialog for a plain S', async () => {
    setupSection();
    fireEvent.keyDown(document, { code: 'KeyS' });
    await act(() => Promise.resolve());
    expect(screen.queryByRole('dialog', { name: 'Save preset' })).not.toBeInTheDocument();
  });

  it('shares only a saved preset', async () => {
    const { user, presets } = setupSection();
    await user.click(screen.getByRole('button', { name: 'Share' }));
    expect(toast.error).toHaveBeenCalledWith('Save the preset first to share it');
    expect(sharePreset).not.toHaveBeenCalled();

    act(() => presets[1].setSaved({ id: 'a', name: 'Bright pad' }));
    await user.click(screen.getByRole('button', { name: 'Share' }));
    expect(sharePreset).toHaveBeenCalledWith('a');
  });

  it('renders extra actions after Save and Share', () => {
    setupSection(<button type='button'>Extra</button>);
    const extra = screen.getByRole('button', { name: 'Extra' });
    expect(screen.getByRole('button', { name: 'Share' }).nextElementSibling).toBe(extra);
  });
});
