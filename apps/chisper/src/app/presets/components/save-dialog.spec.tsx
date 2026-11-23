import { act, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import toast from 'react-hot-toast';
import { InfiniteData } from '@tanstack/react-query';
import { Clip, CLIP_BAR, clipHash, EMPTY_PRESET_INFO, PresetInfo, PresetsPage } from '@chisper/preset-schema';
import { theme } from '@chisper/ui-kit';
import { cssColor } from '@chisper/ui-kit/test-utils';
import { fakeTrack } from '../../../test-utils/models';
import { listItem } from '../../../test-utils/presets-fixtures';
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
const renderWith = (track = fakeTrack(), current?: CurrentPreset & { info?: PresetInfo }) => {
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
      info: EMPTY_PRESET_INFO,
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
    savePresetMock.mockResolvedValue({
      id: 'p1',
      name: 'Bright pad',
      existed: false,
      clipId: null,
      info: EMPTY_PRESET_INFO,
    });
    const { user, onClose } = setup();
    await submit(user);

    await user.click(await screen.findByRole('button', { name: 'Copy link' }));
    expect(sharePreset).toHaveBeenCalledWith('p1');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('saves with Enter in the name', async () => {
    savePresetMock.mockResolvedValue({
      id: 'p1',
      name: 'Bright pad',
      existed: false,
      clipId: null,
      info: EMPTY_PRESET_INFO,
    });
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

  it('tells when the same sound is already saved, with the info it has', async () => {
    const info = {
      ...EMPTY_PRESET_INFO,
      category: 'pad' as const,
      subcategory: 'warm',
      tags: ['soft' as const],
    };
    savePresetMock.mockResolvedValue({ id: 'p0', name: 'Old one', existed: true, clipId: null, info });
    const { user } = setup();
    await submit(user);

    expect(
      await screen.findByText(
        'This sound is already saved as “Old one”. Its category and tags stay as they were: Pad › Warm · Soft.'
      )
    ).toBeInTheDocument();
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

  describe('its info', () => {
    const group = (name: string) => within(screen.getByRole('group', { name }));
    const pressed = (name: string) =>
      group(name)
        .getAllByRole('button')
        .filter((key) => key.getAttribute('aria-pressed') === 'true')
        .map((key) => key.textContent);

    it('offers a category guessed by the name until one is chosen, saves it with tags and a description', async () => {
      savePresetMock.mockResolvedValue({
        id: 'p1',
        name: 'Deep bass',
        existed: false,
        clipId: null,
        info: EMPTY_PRESET_INFO,
      });
      const { user } = setup();
      expect(pressed('Category')).toEqual([]);
      await user.type(nameInput(), 'Deep pad');
      expect(pressed('Category')).toEqual(['Pad']);
      await user.clear(nameInput());
      await user.type(nameInput(), 'Deep bass');
      expect(pressed('Category')).toEqual(['Bass']);

      // chosen: the name no longer moves it
      await user.click(group('Subcategory').getByRole('button', { name: 'Sub' }));
      await user.type(nameInput(), ' pad');
      expect(pressed('Category')).toEqual(['Bass']);
      await user.clear(nameInput());
      await user.type(nameInput(), 'Deep bass');
      await user.click(group('Tags').getByRole('button', { name: 'Warm' }));
      await user.click(group('Tags').getByRole('button', { name: 'Dark' }));
      await user.type(screen.getByLabelText('Description'), '  Round  and low ');
      await user.click(screen.getByRole('button', { name: 'Pass captcha' }));
      await user.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() =>
        expect(savePresetMock).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'Deep bass',
            info: {
              category: 'bass',
              subcategory: 'sub',
              description: 'Round and low',
              tags: ['dark', 'warm'],
            },
          })
        )
      );
    });

    it('starts a new preset of another’s with its category and tags, not the words of its author', async () => {
      savePresetMock.mockResolvedValue({
        id: 'p2',
        name: 'My lead',
        existed: false,
        clipId: null,
        info: EMPTY_PRESET_INFO,
      });
      const info = {
        category: 'lead' as const,
        subcategory: 'soft',
        description: 'Made for my EP',
        tags: ['soft' as const],
      };
      const { user } = renderWith(fakeTrack(), { id: 'p1', name: 'Their lead', info });
      expect(pressed('Category')).toEqual(['Lead']);
      expect(pressed('Subcategory')).toEqual(['Soft']);
      expect(pressed('Tags')).toEqual(['Soft']);
      expect(screen.getByLabelText('Description')).toHaveValue('');

      await user.clear(nameInput());
      await user.type(nameInput(), 'My lead');
      await user.click(screen.getByRole('button', { name: 'Pass captcha' }));
      await user.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() =>
        expect(savePresetMock).toHaveBeenCalledWith(
          expect.objectContaining({ name: 'My lead', info: { ...info, description: null } })
        )
      );
    });

    it('guesses the category of a preset whose info has none, keeps its tags', async () => {
      const info = { ...EMPTY_PRESET_INFO, tags: ['soft' as const] };
      renderWith(fakeTrack(), { id: 'p0', name: 'Warm pad', info });
      expect(pressed('Category')).toEqual(['Pad']);
      expect(pressed('Tags')).toEqual(['Soft']);
    });

    it('takes 3 tags at most, a category off with a click again', async () => {
      const { user } = setup();
      await user.type(nameInput(), 'Thing');
      for (const tag of ['Dark', 'Warm', 'Soft'])
        await user.click(group('Tags').getByRole('button', { name: tag }));
      expect(group('Tags').getByRole('button', { name: 'Wide' })).toBeDisabled();
      expect(group('Tags').getByRole('button', { name: 'Dark' })).toBeEnabled();

      await user.click(group('Category').getByRole('button', { name: 'Keys' }));
      expect(pressed('Category')).toEqual(['Keys']);
      await user.click(group('Category').getByRole('button', { name: 'Keys' }));
      expect(pressed('Category')).toEqual([]);
    });

    it('saves nothing with a link in the description, saying why', async () => {
      const { user } = setup();
      await user.type(nameInput(), 'Spam');
      await user.type(screen.getByLabelText('Description'), 'see www.spam.io');
      await user.click(screen.getByRole('button', { name: 'Pass captcha' }));
      expect(screen.getByText('No links in the description, please')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    });

    it('saves nothing with a word refused in the description, naming it; one of a sound passes', async () => {
      const { user } = setup();
      await user.type(nameInput(), 'Hits');
      const description = screen.getByLabelText('Description');
      await user.type(description, 'Assorted hits from a cockpit,');
      await user.click(screen.getByRole('button', { name: 'Pass captcha' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
      expect(screen.queryByText(/out of the description/)).not.toBeInTheDocument();

      await user.type(description, ' and shit!');
      expect(screen.getByText('Please leave “shit” out of the description')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    });

    it('starts an overwrite from the info of the preset, sends it with the sound', async () => {
      setEditToken('p1', 'secret');
      updatePresetMock.mockResolvedValue({
        id: 'p1',
        name: 'Bright pad',
        clipId: null,
        info: EMPTY_PRESET_INFO,
      });
      const info = {
        category: 'lead' as const,
        subcategory: 'soft',
        description: 'Airy',
        tags: ['soft' as const],
      };
      const { user } = renderWith(fakeTrack(), { id: 'p1', name: 'Bright pad', info });
      // (not the guess of its name)
      expect(pressed('Category')).toEqual(['Lead']);
      expect(pressed('Subcategory')).toEqual(['Soft']);
      expect(screen.getByLabelText('Description')).toHaveValue('Airy');

      await user.click(group('Tags').getByRole('button', { name: 'Bright' }));
      await user.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() =>
        expect(updatePresetMock).toHaveBeenCalledWith(
          'p1',
          expect.objectContaining({ info: { ...info, tags: ['bright', 'soft'] } })
        )
      );
    });

    describe('an overwrite in the lists of the browser loaded', () => {
      const info = {
        category: 'lead' as const,
        subcategory: 'soft',
        description: 'Airy',
        tags: ['soft' as const],
      };
      const FILTER = { tags: [], features: [] };
      const row = listItem('p1', 'Bright pad', info);
      const other = listItem('p2', 'Other');
      // the preset of this browser opened with `info`, its rows loaded in each kind of list; the server answers `saved`
      const overwriteWith = (saved: PresetInfo) => {
        setEditToken('p1', 'secret');
        updatePresetMock.mockResolvedValue({ id: 'p1', name: 'Bright pad', clipId: null, info: saved });
        const result = renderWith(fakeTrack(), { id: 'p1', name: 'Bright pad', info });
        const { queryClient } = result;
        queryClient.setQueryData(['presets', 'top', FILTER], [row, other]);
        queryClient.setQueryData(['presets', 'ids', ['p1', 'p2']], [other, row]);
        queryClient.setQueryData<InfiniteData<PresetsPage>>(['presets', 'list', '', 'new', FILTER], {
          pages: [{ items: [row], nextCursor: null }],
          pageParams: [undefined],
        });
        return { ...result, invalidate: jest.spyOn(queryClient, 'invalidateQueries') };
      };
      const COUNTS = { queryKey: ['presets', 'counts'] };

      it('changes its rows (an Edit info of one starts from it); the counts again where it moved', async () => {
        const moved = { ...info, category: 'pad' as const, subcategory: null };
        const { user, queryClient, invalidate } = overwriteWith(moved);
        await user.click(group('Category').getByRole('button', { name: 'Pad' }));
        await user.click(screen.getByRole('button', { name: 'Save' }));
        expect(await screen.findByText('“Bright pad” has been updated.')).toBeInTheDocument();

        const updated = { ...row, ...moved };
        expect(queryClient.getQueryData(['presets', 'top', FILTER])).toEqual([updated, other]);
        expect(queryClient.getQueryData(['presets', 'ids', ['p1', 'p2']])).toEqual([other, updated]);
        expect(
          queryClient.getQueryData<InfiniteData<PresetsPage>>(['presets', 'list', '', 'new', FILTER])
            ?.pages[0].items
        ).toEqual([updated]);
        expect(invalidate).toHaveBeenCalledWith(COUNTS);
      });

      it('leaves the counts of the categories as they are where it stays in its category', async () => {
        const tagged = { ...info, tags: ['bright' as const, 'soft' as const] };
        const { user, queryClient, invalidate } = overwriteWith(tagged);
        await user.click(group('Tags').getByRole('button', { name: 'Bright' }));
        await user.click(screen.getByRole('button', { name: 'Save' }));
        expect(await screen.findByText('“Bright pad” has been updated.')).toBeInTheDocument();
        expect(queryClient.getQueryData(['presets', 'top', FILTER])).toEqual([{ ...row, ...tagged }, other]);
        expect(invalidate).not.toHaveBeenCalledWith(COUNTS);
      });
    });

    it('overwrites with the info as it was when it isn’t known and not changed', async () => {
      setEditToken('p1', 'secret');
      updatePresetMock.mockResolvedValue({
        id: 'p1',
        name: 'Bright pad',
        clipId: null,
        info: EMPTY_PRESET_INFO,
      });
      // (a preset of the tab before: its info not known)
      const { user } = renderWith(fakeTrack(), { id: 'p1', name: 'Bright pad' });
      await user.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(updatePresetMock).toHaveBeenCalled());
      expect(updatePresetMock.mock.calls[0][1].info).toBeUndefined();
    });
  });

  describe('preset saved from this browser', () => {
    const renderEditable = () => {
      setEditToken('p1', 'secret');
      return renderWith(fakeTrack(), { id: 'p1', name: 'Bright pad' });
    };

    it('overwrites the current preset with its edit token', async () => {
      updatePresetMock.mockResolvedValue({
        id: 'p1',
        name: 'Brighter pad',
        clipId: null,
        info: EMPTY_PRESET_INFO,
      });
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
      savePresetMock.mockResolvedValue({
        id: 'p1',
        name: 'Bright pad',
        existed: false,
        clipId: 'c1',
        info: EMPTY_PRESET_INFO,
      });
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
      savePresetMock.mockResolvedValue({
        id: 'p1',
        name: 'Bright pad',
        existed: false,
        clipId: null,
        info: EMPTY_PRESET_INFO,
      });
      const { user, presets } = renderWith(trackWith(riff, 'c1'));
      await submit(user);

      await waitFor(() =>
        expect(savePresetMock).toHaveBeenCalledWith(expect.objectContaining({ clipId: null }))
      );
      expect(presets[0].$current.value).toEqual({ id: 'p1', name: 'Bright pad' });
    });

    it('saves a clip not saved yet first, with a captcha of its own', async () => {
      saveClipMock.mockResolvedValue({ id: 'c2', existed: false, editToken: 'clip-secret' });
      savePresetMock.mockResolvedValue({
        id: 'p1',
        name: 'Bright pad',
        existed: false,
        clipId: 'c2',
        info: EMPTY_PRESET_INFO,
      });
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
      savePresetMock.mockResolvedValue({
        id: 'p1',
        name: 'Bright pad',
        existed: false,
        clipId: 'c1',
        info: EMPTY_PRESET_INFO,
      });
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
      savePresetMock.mockResolvedValue({
        id: 'p0',
        name: 'Old one',
        existed: true,
        clipId: null,
        info: EMPTY_PRESET_INFO,
      });
      const { user } = renderWith(trackWith(riff, 'c1'));
      await user.click(clipBox() as HTMLElement);
      await submit(user);

      expect(
        await screen.findByText(
          'This sound is already saved as “Old one”. Its clip is unchanged. Its category and tags stay as they were: none.'
        )
      ).toBeInTheDocument();
    });

    describe('of a preset saved from this browser with a clip', () => {
      const current = { id: 'p1', name: 'Bright pad', clipId: 'c1' };
      beforeEach(() => setEditToken('p1', 'secret'));

      it('keeps its clip open in the track checked, without a word', async () => {
        updatePresetMock.mockResolvedValue({
          id: 'p1',
          name: 'Bright pad',
          clipId: 'c1',
          info: EMPTY_PRESET_INFO,
        });
        const { user, presets } = renderWith(trackWith(riff, 'c1'), current);
        expect(clipBox()).toBeChecked();
        expect(screen.queryByText(/Save (replaces|leaves)/)).not.toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Save' }));
        expect(await screen.findByText('“Bright pad” has been updated.')).toBeInTheDocument();
        expect(updatePresetMock).toHaveBeenCalledWith('p1', expect.objectContaining({ clipId: 'c1' }));
        expect(presets[0].$current.value).toEqual(current);
      });

      it('takes its clip away once unchecked', async () => {
        updatePresetMock.mockResolvedValue({
          id: 'p1',
          name: 'Bright pad',
          clipId: null,
          info: EMPTY_PRESET_INFO,
        });
        const { user, presets } = renderWith(trackWith(riff, 'c1'), current);
        await user.click(clipBox() as HTMLElement);
        expect(screen.getByText('Save leaves the preset without a clip.')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Save' }));
        expect(await screen.findByText('“Bright pad” has been updated.')).toBeInTheDocument();
        expect(updatePresetMock).toHaveBeenCalledWith('p1', expect.objectContaining({ clipId: null }));
        expect(presets[0].$current.value).toEqual({ id: 'p1', name: 'Bright pad' });
      });

      it('tells that another clip of the track replaces its clip', async () => {
        updatePresetMock.mockResolvedValue({
          id: 'p1',
          name: 'Bright pad',
          clipId: 'c3',
          info: EMPTY_PRESET_INFO,
        });
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
