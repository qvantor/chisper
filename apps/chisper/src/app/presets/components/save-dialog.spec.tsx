import { act, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import toast from 'react-hot-toast';
import { Clip, CLIP_BAR, clipHash } from '@chisper/preset-schema';
import { theme } from '@chisper/ui-kit';
import { cssColor } from '@chisper/ui-kit/test-utils';
import { fakeTrack } from '../../../test-utils/models';
import { renderWithPresets } from '../../../test-utils/presets-wrapper';
import { getClipEditToken, setClipEditToken } from '../../synth/track/services/clip-edit-tokens';
import { saveClip, updateClip } from '../../synth/track/services/clips-api';
import type { CurrentPreset } from '../modules/presets';
import {
  ApiRequestError,
  getEditToken,
  isNameAvailable,
  savePreset,
  setEditToken,
  sharePreset,
  updatePreset,
} from '../services';
import { SaveDialog } from './save-dialog';

jest.mock('../services', () => ({
  ...jest.requireActual('../services'),
  getPreset: jest.fn(),
  isNameAvailable: jest.fn(),
  savePreset: jest.fn(),
  updatePreset: jest.fn(),
  sharePreset: jest.fn(),
}));

jest.mock('../../synth/track/services/clips-api', () => ({
  fetchClip: jest.fn(),
  saveClip: jest.fn(),
  updateClip: jest.fn(),
}));

const saveClipMock = jest.mocked(saveClip);
const updateClipMock = jest.mocked(updateClip);
const isNameAvailableMock = jest.mocked(isNameAvailable);
const savePresetMock = jest.mocked(savePreset);
const updatePresetMock = jest.mocked(updatePreset);

const setup = () => {
  const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
  const onClose = jest.fn();
  const result = renderWithPresets(<SaveDialog open onClose={onClose} />);
  return { ...result, user, onClose };
};

// the dialog over the track, the current preset (of this browser when it has an edit token) set before it opens
const renderWith = (track = fakeTrack(), current?: CurrentPreset) => {
  const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
  const result = renderWithPresets(<SaveDialog open={false} onClose={jest.fn()} />, { track });
  if (current) act(() => result.presets[1].setSaved(current));
  result.rerender(<SaveDialog open onClose={jest.fn()} />);
  return { ...result, user, track };
};

const nameInput = () => screen.getByPlaceholderText('Preset name');

const submit = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.type(nameInput(), 'Bright pad');
  await user.click(screen.getByRole('button', { name: 'Pass captcha' }));
  await user.click(screen.getByRole('button', { name: 'Save' }));
};

// debounces run on fake timers, waitFor/findBy advance them
beforeEach(() => {
  jest.useFakeTimers();
  isNameAvailableMock.mockResolvedValue({ available: true });
});
afterEach(() => jest.useRealTimers());

describe('SaveDialog', () => {
  it('waits for the captcha before saving', async () => {
    const { user } = setup();
    await user.type(nameInput(), 'Bright pad');
    expect(screen.getByRole('button', { name: 'Checking...' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Pass captcha' }));
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('checks the name availability after typing stops', async () => {
    isNameAvailableMock.mockResolvedValue({ available: false });
    const { user } = setup();
    await user.type(nameInput(), 'Taken  Name');
    await user.click(screen.getByRole('button', { name: 'Pass captcha' }));

    expect(await screen.findByText('Name is already taken')).toBeInTheDocument();
    expect(getComputedStyle(screen.getByText('Name is already taken')).color).toBe(
      cssColor(theme.colors.red)
    );
    // checked once, with the normalized name, not on every keystroke
    expect(isNameAvailableMock).toHaveBeenCalledTimes(1);
    expect(isNameAvailableMock).toHaveBeenCalledWith('taken name');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('saves a new preset, stores its edit token and makes it current', async () => {
    savePresetMock.mockResolvedValue({
      id: 'p1',
      name: 'Bright pad',
      existed: false,
      editToken: 'secret',
      clipId: null,
    });
    const { user, presets } = setup();
    await submit(user);

    expect(await screen.findByText('“Bright pad” has been saved.')).toBeInTheDocument();
    expect(savePresetMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Bright pad', turnstileToken: 'captcha-token' })
    );
    expect(getEditToken('p1')).toBe('secret');
    expect(presets[0].$current.value).toEqual({ id: 'p1', name: 'Bright pad' });
    expect(screen.getByDisplayValue('http://localhost/?preset=p1')).toBeInTheDocument();
  });

  it('copies the link of the saved preset and closes with Done', async () => {
    savePresetMock.mockResolvedValue({ id: 'p1', name: 'Bright pad', existed: false, clipId: null });
    const { user, onClose } = setup();
    await submit(user);

    await user.click(await screen.findByRole('button', { name: 'Copy link' }));
    expect(sharePreset).toHaveBeenCalledWith('p1');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('saves with Enter in the name', async () => {
    savePresetMock.mockResolvedValue({ id: 'p1', name: 'Bright pad', existed: false, clipId: null });
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Pass captcha' }));
    await user.type(nameInput(), 'Bright pad{Enter}');

    expect(await screen.findByText('“Bright pad” has been saved.')).toBeInTheDocument();
  });

  it('closes with Cancel and the close key without saving', async () => {
    const { user, onClose } = setup();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Close' }));

    expect(onClose).toHaveBeenCalledTimes(2);
    expect(savePresetMock).not.toHaveBeenCalled();
  });

  it('tells when the same sound is already saved', async () => {
    savePresetMock.mockResolvedValue({ id: 'p0', name: 'Old one', existed: true, clipId: null });
    const { user } = setup();
    await submit(user);

    expect(await screen.findByText('This sound is already saved as “Old one”.')).toBeInTheDocument();
    expect(getEditToken('p0')).toBeUndefined();
  });

  it('shows the server error and rechecks the name on conflict', async () => {
    savePresetMock.mockRejectedValue(new ApiRequestError(409, 'Name is already taken'));
    const { user } = setup();
    await user.type(nameInput(), 'Bright pad');
    await waitFor(() => expect(isNameAvailableMock).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: 'Pass captcha' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Name is already taken'));
    await waitFor(() => expect(isNameAvailableMock).toHaveBeenCalledTimes(2));
    // the captcha token is single use
    expect(await screen.findByRole('button', { name: 'Checking...' })).toBeDisabled();
  });

  it('shows rate limit errors', async () => {
    savePresetMock.mockRejectedValue(new ApiRequestError(429, 'Too many presets, try again later'));
    const { user } = setup();
    await submit(user);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Too many presets, try again later'));
  });

  it('explains captcha errors and offers a retry', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('button', { name: 'Fail captcha' }));
    expect(screen.getByText(/Captcha is not allowed on localhost/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.queryByText(/Captcha is not allowed/)).not.toBeInTheDocument();
  });

  describe('preset saved from this browser', () => {
    const renderEditable = () => {
      setEditToken('p1', 'secret');
      return renderWith(fakeTrack(), { id: 'p1', name: 'Bright pad' });
    };

    it('overwrites the current preset with its edit token', async () => {
      updatePresetMock.mockResolvedValue({ id: 'p1', name: 'Brighter pad', clipId: null });
      const { user, presets } = renderEditable();
      expect(nameInput()).toHaveValue('Bright pad');
      expect(screen.getByText(/Save overwrites “Bright pad”/)).toBeInTheDocument();

      await user.clear(nameInput());
      await user.type(nameInput(), 'Brighter pad');
      await user.click(screen.getByRole('button', { name: 'Save' }));

      expect(await screen.findByText('“Brighter pad” has been updated.')).toBeInTheDocument();
      expect(updatePresetMock).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({ name: 'Brighter pad', editToken: 'secret' })
      );
      expect(presets[0].$current.value).toEqual({ id: 'p1', name: 'Brighter pad' });
      expect(savePresetMock).not.toHaveBeenCalled();
    });

    it('does not check its own name and requires a new name to save as new', async () => {
      const { user } = renderEditable();
      await user.click(screen.getByRole('button', { name: 'Pass captcha' }));

      expect(screen.getByRole('button', { name: 'Save as new' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
      expect(isNameAvailableMock).not.toHaveBeenCalled();
    });
  });
  describe('the clip of the track', () => {
    const riff: Clip = { bpm: 120, length: CLIP_BAR, notes: [[0, 480, 60, 100]], name: 'Riff' };

    // the track holds `clip` under `id` (null: not saved), saved as it is or changed since
    const trackWith = (clip: Clip, id: string | null = null, saved = id !== null) => {
      const track = fakeTrack();
      const [{ $clip, $id, $savedHash }] = track;
      $clip.next(clip);
      $id.next(id);
      $savedHash.next(saved ? clipHash(clip) : null);
      return track;
    };

    const clipBox = () => screen.queryByRole('checkbox', { name: /Default clip/ });
    // (the clip's captcha shows up first in the dialog, before the preset's)
    const passClipCaptcha = async (user: ReturnType<typeof userEvent.setup>) =>
      user.click((await screen.findAllByRole('button', { name: 'Pass captcha' }))[0]);

    it('is not offered while the track has no notes', () => {
      renderWith();
      expect(clipBox()).not.toBeInTheDocument();
    });

    it('saves a new preset with the saved clip of the track once it is checked', async () => {
      savePresetMock.mockResolvedValue({ id: 'p1', name: 'Bright pad', existed: false, clipId: 'c1' });
      const { user, presets } = renderWith(trackWith(riff, 'c1'));
      expect(clipBox()).not.toBeChecked();
      expect(screen.getByText('Default clip: “Riff”')).toBeInTheDocument();

      await user.click(clipBox() as HTMLElement);
      await submit(user);

      expect(await screen.findByText('“Bright pad” has been saved.')).toBeInTheDocument();
      expect(savePresetMock).toHaveBeenCalledWith(expect.objectContaining({ clipId: 'c1' }));
      // saved as it is: no request for the clip
      expect(saveClipMock).not.toHaveBeenCalled();
      expect(updateClipMock).not.toHaveBeenCalled();
      expect(presets[0].$current.value).toEqual({ id: 'p1', name: 'Bright pad', clipId: 'c1' });
    });

    it('saves a preset without a clip unless it is checked', async () => {
      savePresetMock.mockResolvedValue({ id: 'p1', name: 'Bright pad', existed: false, clipId: null });
      const { user, presets } = renderWith(trackWith(riff, 'c1'));
      await submit(user);

      await waitFor(() =>
        expect(savePresetMock).toHaveBeenCalledWith(expect.objectContaining({ clipId: null }))
      );
      expect(presets[0].$current.value).toEqual({ id: 'p1', name: 'Bright pad' });
    });

    it('saves a clip not saved yet first, with a captcha of its own', async () => {
      saveClipMock.mockResolvedValue({ id: 'c2', existed: false, editToken: 'clip-secret' });
      savePresetMock.mockResolvedValue({ id: 'p1', name: 'Bright pad', existed: false, clipId: 'c2' });
      const unnamed: Clip = { bpm: riff.bpm, length: riff.length, notes: riff.notes };
      const { user, track } = renderWith(trackWith(unnamed));
      expect(screen.getByText('Default clip: the clip of the track')).toBeInTheDocument();
      await user.click(clipBox() as HTMLElement);
      expect(screen.getByText('The clip is saved too, the preset opens with it.')).toBeInTheDocument();

      await submit(user);
      expect(savePresetMock).not.toHaveBeenCalled();
      await passClipCaptcha(user);

      expect(await screen.findByText('“Bright pad” has been saved.')).toBeInTheDocument();
      expect(saveClipMock).toHaveBeenCalledWith(unnamed, 'captcha-token');
      expect(getClipEditToken('c2')).toBe('clip-secret');
      expect(track[1].setSaved).toHaveBeenCalledWith('c2', unnamed);
      expect(savePresetMock).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Bright pad', turnstileToken: 'captcha-token', clipId: 'c2' })
      );
      // quietly: the dialog tells
      expect(toast.success).not.toHaveBeenCalled();
    });

    it('overwrites a clip of this browser changed since by its edit token first', async () => {
      setClipEditToken('c1', 'clip-secret');
      updateClipMock.mockResolvedValue({ id: 'c1' });
      savePresetMock.mockResolvedValue({ id: 'p1', name: 'Bright pad', existed: false, clipId: 'c1' });
      const { user } = renderWith(trackWith(riff, 'c1', false));
      await user.click(clipBox() as HTMLElement);
      expect(screen.getByText('The clip is saved too, the preset opens with it.')).toBeInTheDocument();
      await submit(user);

      await waitFor(() =>
        expect(savePresetMock).toHaveBeenCalledWith(expect.objectContaining({ clipId: 'c1' }))
      );
      expect(updateClipMock).toHaveBeenCalledWith('c1', riff, 'clip-secret');
      expect(saveClipMock).not.toHaveBeenCalled();
    });

    it('does not save the preset when the clip is not saved', async () => {
      setClipEditToken('c1', 'clip-secret');
      updateClipMock.mockRejectedValue(new ApiRequestError(429, 'Too many updates'));
      const { user } = renderWith(trackWith(riff, 'c1', false));
      await user.click(clipBox() as HTMLElement);
      await submit(user);

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Too many updates'));
      expect(savePresetMock).not.toHaveBeenCalled();
      // the dialog stays to try again
      expect(await screen.findByRole('button', { name: 'Save' })).toBeEnabled();
    });

    it('tells that the sound saved before keeps its clip', async () => {
      savePresetMock.mockResolvedValue({ id: 'p0', name: 'Old one', existed: true, clipId: null });
      const { user } = renderWith(trackWith(riff, 'c1'));
      await user.click(clipBox() as HTMLElement);
      await submit(user);

      expect(
        await screen.findByText('This sound is already saved as “Old one”. Its clip is unchanged.')
      ).toBeInTheDocument();
    });

    describe('of a preset saved from this browser with a clip', () => {
      const current = { id: 'p1', name: 'Bright pad', clipId: 'c1' };
      beforeEach(() => setEditToken('p1', 'secret'));

      it('keeps its clip open in the track checked, without a word', async () => {
        updatePresetMock.mockResolvedValue({ id: 'p1', name: 'Bright pad', clipId: 'c1' });
        const { user, presets } = renderWith(trackWith(riff, 'c1'), current);
        expect(clipBox()).toBeChecked();
        expect(screen.queryByText(/Save (replaces|leaves)/)).not.toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Save' }));
        expect(await screen.findByText('“Bright pad” has been updated.')).toBeInTheDocument();
        expect(updatePresetMock).toHaveBeenCalledWith('p1', expect.objectContaining({ clipId: 'c1' }));
        expect(presets[0].$current.value).toEqual(current);
      });

      it('takes its clip away once unchecked', async () => {
        updatePresetMock.mockResolvedValue({ id: 'p1', name: 'Bright pad', clipId: null });
        const { user, presets } = renderWith(trackWith(riff, 'c1'), current);
        await user.click(clipBox() as HTMLElement);
        expect(screen.getByText('Save leaves the preset without a clip.')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Save' }));
        expect(await screen.findByText('“Bright pad” has been updated.')).toBeInTheDocument();
        expect(updatePresetMock).toHaveBeenCalledWith('p1', expect.objectContaining({ clipId: null }));
        expect(presets[0].$current.value).toEqual({ id: 'p1', name: 'Bright pad' });
      });

      it('tells that another clip of the track replaces its clip', async () => {
        updatePresetMock.mockResolvedValue({ id: 'p1', name: 'Bright pad', clipId: 'c3' });
        const { user } = renderWith(trackWith(riff, 'c3'), current);
        expect(clipBox()).toBeChecked();
        expect(screen.getByText('Save replaces the clip the preset opens with.')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() =>
          expect(updatePresetMock).toHaveBeenCalledWith('p1', expect.objectContaining({ clipId: 'c3' }))
        );
      });

      it('tells that it is left without a clip while the track has no notes', () => {
        renderWith(fakeTrack(), current);
        expect(clipBox()).not.toBeInTheDocument();
        expect(screen.getByText('Save leaves the preset without a clip.')).toBeInTheDocument();
      });
    });
  });
});
