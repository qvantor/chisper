import { act, createEvent, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import toast from 'react-hot-toast';
import { InfiniteData } from '@tanstack/react-query';
import { EMPTY_PRESET_INFO, Preset, PresetCounts, PresetListItem, PresetsPage } from '@chisper/preset-schema';
import { theme } from '@chisper/ui-kit';
import { cssColor } from '@chisper/ui-kit/test-utils';
import { recordAnalytics } from '../../../test-utils/analytics';
import { fakeTrack } from '../../../test-utils/models';
import { fakePreset, listItem, topItem } from '../../../test-utils/presets-fixtures';
import { renderWithPresets } from '../../../test-utils/presets-wrapper';
import {
  getPreset,
  getPresetCounts,
  getPresetsByIds,
  getTopPresets,
  listPresets,
  queryTopPresets,
  reportPreset,
  setEditToken,
  sharePreset,
  updatePresetInfo,
} from '../services';
import { PresetBrowser } from './preset-browser';

jest.mock('../services', () => ({
  ...jest.requireActual('../services'),
  getPreset: jest.fn(),
  getPresetCounts: jest.fn(),
  getPresetsByIds: jest.fn(),
  getTopPresets: jest.fn(),
  listPresets: jest.fn(),
  queryTopPresets: jest.fn(),
  reportPreset: jest.fn(),
  sharePreset: jest.fn(),
  updatePresetInfo: jest.fn(),
}));

const getPresetMock = jest.mocked(getPreset);
const getTopPresetsMock = jest.mocked(getTopPresets);
const listPresetsMock = jest.mocked(listPresets);
const queryTopPresetsMock = jest.mocked(queryTopPresets);
const getPresetsByIdsMock = jest.mocked(getPresetsByIds);
const getPresetCountsMock = jest.mocked(getPresetCounts);

const top = [
  listItem('t1', 'Top one', { uniqueUsers: 12 }),
  listItem('t2', 'Top two', {
    factory: true,
    description: 'A warm pad for chords',
    features: ['clip', 'ai', 'tempo-sync', 'mono', 'glide'],
  }),
  listItem('t3', 'Top three', { features: ['clip'] }),
];
const counts: PresetCounts = {
  total: 40,
  categories: {
    fx: { count: 30, subcategories: { game: 20, magic: 10 } },
    pad: { count: 5, subcategories: {} },
  },
};
const CLIP = { id: 'c1', clip: { bpm: 100, length: 3840, notes: [[0, 480, 60, 100]] } } as Preset['clip'];
// a preset with its clip
const withClip = async (id: string): Promise<Preset> => ({ ...(await fakePreset(id)), clip: CLIP });

// a row by its name and a key of it by its name
const rowOf = async (name: string) => (await screen.findByText(name)).closest('[data-preset]') as HTMLElement;
const rowKey = async (name: string, key: string | RegExp) =>
  within(await rowOf(name)).getByRole('button', { name: key });

const nameColor = (name: string) => getComputedStyle(screen.getByText(name)).color;

const setup = ({ track = fakeTrack() } = {}) => {
  const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
  const onClose = jest.fn();
  const result = renderWithPresets(<PresetBrowser open onClose={onClose} />, { track });
  return { ...result, user, onClose, track };
};

// debounces run on fake timers, waitFor/findBy advance them
beforeEach(() => {
  jest.useFakeTimers();
  getTopPresetsMock.mockResolvedValue(top);
  listPresetsMock.mockResolvedValue({ items: [listItem('a1', 'All one')], nextCursor: null });
  queryTopPresetsMock.mockResolvedValue([topItem('f1', 'Coin Grab')]);
  getPresetsByIdsMock.mockImplementation(async (ids) => ids.map((id) => listItem(id, `Own ${id}`)));
  getPresetCountsMock.mockResolvedValue(counts);
  getPresetMock.mockImplementation(fakePreset);
  // the preset opened on start is random: the first one
  jest.spyOn(Math, 'random').mockReturnValue(0);
});
afterEach(() => jest.useRealTimers());

describe('PresetBrowser', () => {
  it('shows popular presets with their unique users', async () => {
    setup();
    expect(await screen.findByText('Top one')).toBeInTheDocument();
    expect(screen.getByText('Top two')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    // numbered as the programs of a synth
    expect(screen.getByText('001')).toBeInTheDocument();
    expect(screen.getByText('002')).toBeInTheDocument();
    // the full list is loaded only when its tab is opened
    expect(listPresetsMock).not.toHaveBeenCalled();
    // the popular list comes from the model's request on start
    expect(getTopPresetsMock).toHaveBeenCalledTimes(1);
    expect(queryTopPresetsMock).not.toHaveBeenCalled();
  });

  it('retries the popular presets on open after a failed load on start', async () => {
    getTopPresetsMock.mockRejectedValueOnce(new Error('Server down'));
    const { rerender, presets } = renderWithPresets(<PresetBrowser open={false} onClose={jest.fn()} />);
    await waitFor(() => expect(presets[0].$topLoading.value).toBe(false));
    expect(presets[0].$top.value).toBeNull();

    rerender(<PresetBrowser open onClose={jest.fn()} />);
    expect(await screen.findByText('Top one')).toBeInTheDocument();
    expect(getTopPresetsMock).toHaveBeenCalledTimes(2);
  });

  it('shows an empty state', async () => {
    getTopPresetsMock.mockResolvedValue([]);
    setup();
    expect(await screen.findByText('No presets')).toBeInTheDocument();
  });

  describe('a list that fails to load', () => {
    const failure = () => Promise.reject(new TypeError('Failed to fetch'));
    const retryKey = () => screen.findByRole('button', { name: 'Retry' });

    it('tells it with Retry, not as empty: the popular presets, failing again on open', async () => {
      getTopPresetsMock.mockImplementation(failure);
      const { user } = setup();
      expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load the presets");
      expect(screen.queryByText('No presets')).not.toBeInTheDocument();
      // the list tells it, no toast
      expect(toast.error).not.toHaveBeenCalled();

      const asked = getTopPresetsMock.mock.calls.length;
      getTopPresetsMock.mockResolvedValue(top);
      await user.click(await retryKey());
      expect(await screen.findByText('Top one')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(getTopPresetsMock).toHaveBeenCalledTimes(asked + 1);
    });

    it('Favorites: Retry asks for it again, the spinner meanwhile; reported once', async () => {
      localStorage.setItem('presetFavorites', JSON.stringify(['t1']));
      const { fingerprints } = recordAnalytics();
      getPresetsByIdsMock.mockImplementationOnce(failure);
      const { user } = setup();
      await user.click(screen.getByRole('tab', { name: 'Favorites' }));
      const retry = await retryKey();
      expect(screen.queryByText(/No favorites yet/)).not.toBeInTheDocument();
      expect(fingerprints()).toEqual(['load:preset_list:TypeError']);

      let resolve: (items: PresetListItem[]) => void = () => undefined;
      getPresetsByIdsMock.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
      await user.click(retry);
      expect(await screen.findByLabelText('Loading')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      await act(async () => resolve([listItem('t1', 'Own t1')]));
      expect(await screen.findByText('Own t1')).toBeInTheDocument();
    });

    it('the Popular of a filter', async () => {
      queryTopPresetsMock.mockImplementationOnce(failure);
      const { user } = setup();
      await user.click(await screen.findByRole('button', { name: 'FX 30' }));
      await user.click(await retryKey());
      expect(await screen.findByText('Coin Grab')).toBeInTheDocument();
      expect(queryTopPresetsMock).toHaveBeenCalledTimes(2);
    });

    it('a next page of all presets: the rows loaded stay, Retry asks for that page', async () => {
      const observers: Array<(entries: Partial<IntersectionObserverEntry>[]) => void> = [];
      const original = globalThis.IntersectionObserver;
      globalThis.IntersectionObserver = jest.fn(
        (callback: (entries: Partial<IntersectionObserverEntry>[]) => void) => {
          observers.push(callback);
          return { observe: jest.fn(), disconnect: jest.fn() };
        }
      ) as unknown as typeof IntersectionObserver;
      listPresetsMock
        .mockResolvedValueOnce({ items: [listItem('a1', 'All one')], nextCursor: 'cursor-1' })
        .mockImplementationOnce(failure)
        .mockResolvedValueOnce({ items: [listItem('a2', 'All two')], nextCursor: null });

      try {
        const { user } = setup();
        await user.click(screen.getByRole('tab', { name: 'All' }));
        await screen.findByText('All one');
        await waitFor(() => expect(observers).not.toHaveLength(0));
        const watching = observers.length;
        await act(async () => observers[observers.length - 1]([{ isIntersecting: true }]));
        const retry = await retryKey();
        expect(screen.getByText('All one')).toBeInTheDocument();
        // no end of the list watched while it failed: no page asked for again by itself
        expect(observers).toHaveLength(watching);

        await user.click(retry);
        expect(await screen.findByText('All two')).toBeInTheDocument();
        expect(listPresetsMock).toHaveBeenCalledTimes(3);
        expect(listPresetsMock).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'cursor-1' }));
      } finally {
        globalThis.IntersectionObserver = original;
      }
    });
  });

  it('loads the selected preset and uses the list for ◀ ▶', async () => {
    const { user, presets } = setup();
    const { features } = recordAnalytics();
    await user.click(await screen.findByText('Top two'));

    await waitFor(() => expect(presets[0].$current.value).toEqual({ id: 't2', name: 'Preset t2' }));
    expect(getPresetMock).toHaveBeenCalledWith('t2');
    expect(presets[0].$list.value).toEqual(top);
    // opened from the list by the user
    expect(features()).toEqual(['preset:open']);
  });

  it('lists all presets sorted by the chosen order', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('tab', { name: 'All' }));
    expect(await screen.findByText('All one')).toBeInTheDocument();
    expect(listPresetsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ q: '', sort: 'new', cursor: undefined })
    );

    expect(screen.getByRole('button', { name: 'New' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByText('A–Z'));
    await waitFor(() =>
      expect(listPresetsMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ q: '', sort: 'name', cursor: undefined })
      )
    );
    expect(screen.getByRole('button', { name: 'A–Z' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'New' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('sorts only the list of all presets', async () => {
    const { user } = setup();
    expect(screen.getByRole('tab', { name: 'Popular' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('group', { name: 'Sort' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'All' }));
    expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Popular' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('group', { name: 'Sort' })).toBeInTheDocument();
  });

  it('gives each tab its own list: the scroll of one never moves to the other', async () => {
    const { user } = setup();
    await screen.findByText('Top one');
    const popular = screen.getByTestId('preset-list');

    await user.click(screen.getByRole('tab', { name: 'All' }));
    await screen.findByText('All one');
    expect(screen.getByTestId('preset-list')).not.toBe(popular);
  });

  it('searches all presets after typing stops', async () => {
    listPresetsMock.mockImplementation(async ({ q }) => ({
      items: [listItem('s1', `Found ${q}`)],
      nextCursor: null,
    }));
    const { user } = setup();
    await user.type(screen.getByPlaceholderText('Search all presets'), '  bass ');

    expect(await screen.findByText('Found bass')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Search: bass' })).toHaveAttribute('aria-selected', 'true');
    expect(listPresetsMock).toHaveBeenCalledTimes(1);
  });

  it('searches the Popular chosen again with a search typed', async () => {
    const { user } = setup();
    await screen.findByText('Top one');
    await user.type(screen.getByPlaceholderText('Search all presets'), 'two');
    expect(await screen.findByRole('tab', { name: 'Search: two' })).toHaveAttribute('aria-selected', 'true');

    await user.click(screen.getByRole('tab', { name: 'Popular' }));
    expect(await screen.findByText('Top two')).toBeInTheDocument();
    expect(screen.queryByText('Top one')).not.toBeInTheDocument();
    expect(screen.queryByText('Top three')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'false');

    // nothing of it: none
    await user.clear(screen.getByPlaceholderText('Search all presets'));
    await user.type(screen.getByPlaceholderText('Search all presets'), 'laser');
    await screen.findByRole('tab', { name: 'Search: laser' });
    await user.click(screen.getByRole('tab', { name: 'Popular' }));
    expect(await screen.findByText('No presets')).toBeInTheDocument();
  });

  it('loads the next page when the end of the list is visible', async () => {
    const observers: Array<(entries: Partial<IntersectionObserverEntry>[]) => void> = [];
    const original = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver = jest.fn(
      (callback: (entries: Partial<IntersectionObserverEntry>[]) => void) => {
        observers.push(callback);
        return { observe: jest.fn(), disconnect: jest.fn() };
      }
    ) as unknown as typeof IntersectionObserver;
    listPresetsMock
      .mockResolvedValueOnce({ items: [listItem('a1', 'All one')], nextCursor: 'cursor-1' })
      .mockResolvedValueOnce({ items: [listItem('a2', 'All two')], nextCursor: null });

    try {
      const { user } = setup();
      await user.click(screen.getByRole('tab', { name: 'All' }));
      await screen.findByText('All one');
      await waitFor(() => expect(observers).not.toHaveLength(0));

      await act(async () => observers[observers.length - 1]([{ isIntersecting: true }]));
      expect(await screen.findByText('All two')).toBeInTheDocument();
      expect(screen.getByText('All one')).toBeInTheDocument();
      expect(listPresetsMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ q: '', sort: 'new', cursor: 'cursor-1' })
      );
    } finally {
      globalThis.IntersectionObserver = original;
    }
  });

  it('copies a preset link without loading it', async () => {
    const { user } = setup();
    await user.click(await rowKey('Top two', 'Copy link'));

    expect(sharePreset).toHaveBeenCalledWith('t2');
    // only the first one opened on start
    expect(getPresetMock).not.toHaveBeenCalledWith('t2');
  });

  it('reports a preset after confirmation', async () => {
    jest.mocked(reportPreset).mockResolvedValue(undefined);
    const { user } = setup();
    await user.click(await rowKey('Top two', 'Report preset'));
    await user.click(await screen.findByRole('button', { name: 'Report' }));

    expect(reportPreset).toHaveBeenCalledWith('t2');
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Thanks, the preset has been reported'));
    expect(getPresetMock).not.toHaveBeenCalledWith('t2');
  });

  it('shows report errors', async () => {
    jest.mocked(reportPreset).mockRejectedValue(new Error('Already reported'));
    const { user } = setup();
    await user.click(await rowKey('Top one', 'Report preset'));
    await user.click(await screen.findByRole('button', { name: 'Report' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Already reported'));
  });

  it('lights the preset playing on the dark screen', async () => {
    const { user, presets } = setup();
    await waitFor(() => expect(presets[0].$current.value?.id).toBe('t1'));
    expect(
      getComputedStyle(screen.getByTestId('preset-list').parentElement as HTMLElement).backgroundColor
    ).toBe(cssColor(theme.colors.primaryDark));
    expect(nameColor('Top one')).toBe(cssColor(theme.colors.secondAccent));
    expect(nameColor('Top two')).toBe(cssColor(theme.colors.white));

    await user.click(screen.getByText('Top two'));
    await waitFor(() => expect(nameColor('Top two')).toBe(cssColor(theme.colors.secondAccent)));
    expect(nameColor('Top one')).toBe(cssColor(theme.colors.white));
  });

  it('names the preset playing under the list, its mark while it is changed', async () => {
    const { presets } = setup();
    expect(await screen.findByText('Preset t1')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Changed' })).not.toBeInTheDocument();

    act(() => presets[0].$dirty.next(true));
    expect(screen.getByRole('img', { name: 'Changed' })).toBeInTheDocument();
  });

  it('closes with Done and the close key', async () => {
    const { user, onClose } = setup();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  describe('a row', () => {
    it('shows the badge of a preset of the synth, not its description', async () => {
      setup();
      const row = await rowOf('Top two');
      expect(within(row).getByText('Factory')).toBeInTheDocument();
      expect(screen.queryByText('A warm pad for chords')).not.toBeInTheDocument();
      const plain = await rowOf('Top one');
      expect(within(plain).queryByText('Factory')).not.toBeInTheDocument();
    });

    it('shows the icons of what it does in one order, each named, its meaning on hover', async () => {
      const { user } = setup();
      const row = await rowOf('Top two');
      const marks = within(row)
        .getAllByRole('img')
        .map((mark) => mark.getAttribute('aria-label'));
      expect(marks).toEqual(['AI generated', 'Tempo-sync', 'Mono', 'Glide']);
      // the clip: the key that plays it, first, before the name
      const keys = within(row).getAllByRole('button');
      expect(keys[0]).toHaveAccessibleName('Play its clip');
      expect(
        keys[0].compareDocumentPosition(within(row).getByText('Top two')) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
      expect(within(await rowOf('Top one')).queryByRole('img')).not.toBeInTheDocument();
      expect(within(await rowOf('Top one')).queryByRole('button', { name: 'Play its clip' })).toBeNull();

      await user.hover(within(row).getByRole('img', { name: 'Mono' }));
      expect(await screen.findByText('Mono: Plays one note at a time')).toBeInTheDocument();
    });
  });

  describe('the info of the opened preset', () => {
    const strip = () => within(screen.getByRole('region', { name: 'Preset info' }));
    // its keys: shown on a phone alone (the media query jsdom doesn't take: hidden here)
    const stripKey = (name: string) => strip().getByRole('button', { name, hidden: true });

    it('has the keys of the preset opened for a phone: a star, Edit info of an own one, its link, a report', async () => {
      setEditToken('t1', 'token-of-t1-0123456789');
      jest.mocked(reportPreset).mockResolvedValue(undefined);
      const { user, presets } = setup();
      await waitFor(() => expect(presets[0].$current.value?.id).toBe('t1'));
      // hidden on a computer: a row has them
      expect(stripKey('Add to Favorites')).not.toBeVisible();

      await user.click(stripKey('Add to Favorites'));
      expect(presets[0].$favorites.value).toEqual(['t1']);
      expect(stripKey('Remove from Favorites')).toHaveAttribute('aria-pressed', 'true');
      await user.click(stripKey('Copy link'));
      expect(sharePreset).toHaveBeenCalledWith('t1');
      await user.click(stripKey('Report preset'));
      await user.click(await screen.findByRole('button', { name: 'Report' }));
      expect(reportPreset).toHaveBeenCalledWith('t1');

      await user.click(stripKey('Edit info'));
      // (its name as it opened)
      expect(await screen.findByRole('dialog', { name: 'Edit info' })).toHaveTextContent('Preset t1');
    });

    it('edits the info of the preset opened from another list, as it is known', async () => {
      setEditToken('t2', 'token-of-t2-0123456789');
      getPresetMock.mockImplementation(async (id) => ({
        ...(await fakePreset(id)),
        info: id === 't2' ? PAD : EMPTY_PRESET_INFO,
      }));
      const { user } = setup();
      // none of its own: no Edit info
      await waitFor(() => expect(stripKey('Copy link')).toBeInTheDocument());
      expect(strip().queryByRole('button', { name: 'Edit info', hidden: true })).toBeNull();

      await user.click(await screen.findByText('Top two'));
      await strip().findByText('A warm pad for chords');
      await user.click(screen.getByRole('tab', { name: 'Favorites' }));
      await user.click(stripKey('Edit info'));
      const dialog = within(await screen.findByRole('dialog', { name: 'Edit info' }));
      expect(dialog.getByLabelText('Description')).toHaveValue('A warm pad for chords');
    });

    const PAD = {
      category: 'pad' as const,
      subcategory: 'warm',
      description: 'A warm pad for chords',
      tags: ['warm' as const, 'dark' as const],
    };

    it('shows the category, the tags and the description of the preset opened, under the list', async () => {
      getPresetMock.mockImplementation(async (id) => ({
        ...(await fakePreset(id)),
        info: id === 't2' ? PAD : EMPTY_PRESET_INFO,
      }));
      const { user } = setup();
      // on start the first popular one: nothing told
      await waitFor(() => expect(strip().getByText('No description')).toBeInTheDocument());
      expect(strip().queryByText(/›/)).toBeNull();

      await user.click(await screen.findByText('Top two'));
      expect(await strip().findByText('A warm pad for chords')).toBeInTheDocument();
      expect(strip().getByText('Pad › Warm')).toBeInTheDocument();
      expect(strip().getByText('Warm · Dark')).toBeInTheDocument();
      expect(strip().queryByText('No description')).not.toBeInTheDocument();
      // the row tells none of it
      const row = await rowOf('Top two');
      expect(within(row).queryByText('A warm pad for chords')).not.toBeInTheDocument();

      // another list: the preset opened stays told
      await user.click(screen.getByRole('tab', { name: 'Favorites' }));
      expect(strip().getByText('A warm pad for chords')).toBeInTheDocument();

      await user.click(screen.getByRole('tab', { name: 'Popular' }));
      await user.click(await screen.findByText('Top three'));
      expect(await strip().findByText('No description')).toBeInTheDocument();
      expect(strip().queryByText('Pad › Warm')).not.toBeInTheDocument();
    });

    it('shows a category without a subcategory, tags alone', async () => {
      getPresetMock.mockImplementation(async (id) => ({
        ...(await fakePreset(id)),
        info:
          id === 't2'
            ? { ...EMPTY_PRESET_INFO, category: 'fx' as const }
            : { ...EMPTY_PRESET_INFO, tags: ['bright' as const] },
      }));
      const { user } = setup();
      expect(await strip().findByText('Bright')).toBeInTheDocument();
      await user.click(await screen.findByText('Top two'));
      expect(await strip().findByText('FX')).toBeInTheDocument();
      expect(strip().queryByText('Bright')).not.toBeInTheDocument();
    });
  });

  describe('categories and filters', () => {
    it('shows the categories with presets and their counts, the subcategories of the one chosen', async () => {
      const { user } = setup();
      const categories = within(screen.getByRole('group', { name: 'Categories' }));
      expect(await categories.findByRole('button', { name: 'FX 30' })).toBeInTheDocument();
      expect(categories.getByRole('button', { name: 'All 40' })).toHaveAttribute('aria-pressed', 'true');
      expect(categories.getByRole('button', { name: 'Pad 5' })).toBeInTheDocument();
      // none: hidden
      expect(categories.queryByRole('button', { name: /^Bass/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('group', { name: 'Subcategories' })).not.toBeInTheDocument();

      await user.click(categories.getByRole('button', { name: 'FX 30' }));
      const subcategories = within(screen.getByRole('group', { name: 'Subcategories' }));
      expect(subcategories.getByRole('button', { name: 'Game 20' })).toBeInTheDocument();
      expect(subcategories.getByRole('button', { name: 'Magic 10' })).toBeInTheDocument();
      expect(subcategories.queryByRole('button', { name: /^Impact/ })).not.toBeInTheDocument();
      // a pad has no subcategories with presets
      await user.click(categories.getByRole('button', { name: 'Pad 5' }));
      expect(screen.queryByRole('group', { name: 'Subcategories' })).not.toBeInTheDocument();
    });

    it('fills the Popular of a category from the server, the presets of ◀ ▶ those', async () => {
      const { user, presets } = setup();
      const { features } = recordAnalytics();
      await user.click(await screen.findByRole('button', { name: 'FX 30' }));
      expect(await screen.findByText('Coin Grab')).toBeInTheDocument();
      expect(screen.queryByText('Top one')).not.toBeInTheDocument();
      expect(queryTopPresetsMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ category: 'fx', subcategory: undefined, tags: [], features: [] })
      );

      await user.click(screen.getByRole('button', { name: 'Game 20' }));
      await waitFor(() =>
        expect(queryTopPresetsMock).toHaveBeenLastCalledWith(
          expect.objectContaining({ category: 'fx', subcategory: 'game' })
        )
      );
      await user.click(await screen.findByText('Coin Grab'));
      await waitFor(() => expect(presets[0].$list.value.map(({ id }) => id)).toEqual(['f1']));
      expect(features()).toEqual(['preset:category', 'preset:open']);

      // All: the unfiltered Popular again
      await user.click(screen.getByRole('button', { name: 'All 40' }));
      expect(await screen.findByText('Top one')).toBeInTheDocument();
    });

    it('draws a line in the Popular of a category before the rest of it, the numbers going on', async () => {
      queryTopPresetsMock.mockResolvedValue([
        topItem('p1', 'Pad one'),
        topItem('p2', 'Pad two'),
        topItem('p3', 'Pad three', false),
      ]);
      const { user } = setup();
      await user.click(await screen.findByRole('button', { name: 'Pad 5' }));
      const line = await screen.findByRole('separator', { name: 'Others in Pad' });
      expect(line).toHaveTextContent('Others in Pad');
      expect(line.previousElementSibling).toBe(await rowOf('Pad two'));
      expect(line.nextElementSibling).toBe(await rowOf('Pad three'));
      expect(await rowOf('Pad three')).toHaveTextContent('003');

      // the same category in All: no line
      listPresetsMock.mockResolvedValue({ items: [listItem('p3', 'Pad three')], nextCursor: null });
      await user.click(screen.getByRole('tab', { name: 'All' }));
      await waitFor(() => expect(screen.queryByText('Pad one')).not.toBeInTheDocument());
      expect(await screen.findByText('Pad three')).toBeInTheDocument();
      expect(screen.queryByRole('separator', { name: /^Others|^No popular/ })).not.toBeInTheDocument();

      // the Popular of no filter: no line
      await user.click(screen.getByRole('tab', { name: 'Popular' }));
      await user.click(screen.getByRole('button', { name: 'All 40' }));
      expect(await screen.findByText('Top one')).toBeInTheDocument();
      expect(screen.queryByRole('separator', { name: /^Others|^No popular/ })).not.toBeInTheDocument();
    });

    it('names a subcategory on its line, tells where none of it is popular, draws none where all are', async () => {
      const { user } = setup();
      await user.click(await screen.findByRole('button', { name: 'FX 30' }));
      expect(await screen.findByText('Coin Grab')).toBeInTheDocument();
      expect(screen.queryByRole('separator', { name: /^Others|^No popular/ })).not.toBeInTheDocument();

      queryTopPresetsMock.mockResolvedValue([
        topItem('g1', 'Coin Drop', false),
        topItem('g2', 'Coin Spin', false),
      ]);
      await user.click(screen.getByRole('button', { name: 'Game 20' }));
      const line = await screen.findByRole('separator', { name: 'No popular presets in FX › Game yet' });
      expect(line.previousElementSibling).toBeNull();
      expect(line.nextElementSibling).toBe(await rowOf('Coin Drop'));
    });

    it('searches the Popular of a category, its line as the server tells it', async () => {
      queryTopPresetsMock.mockResolvedValue([
        topItem('p1', 'Pad one'),
        topItem('p2', 'Pad two'),
        topItem('p3', 'Pad three', false),
      ]);
      const { user } = setup();
      await user.click(await screen.findByRole('button', { name: 'Pad 5' }));
      await screen.findByText('Pad one');
      await user.type(screen.getByPlaceholderText('Search all presets'), 'three');
      await screen.findByRole('tab', { name: 'Search: three' });
      await user.click(screen.getByRole('tab', { name: 'Popular' }));

      // its popular presets left out: not "none popular"
      const line = await screen.findByRole('separator', { name: 'Others in Pad' });
      expect(line.previousElementSibling).toBeNull();
      expect(line.nextElementSibling).toBe(await rowOf('Pad three'));
      expect(screen.queryByText('Pad one')).not.toBeInTheDocument();
    });

    it('draws the line of a filter of tags alone', async () => {
      queryTopPresetsMock.mockResolvedValue([topItem('d1', 'Dark one'), topItem('d2', 'Dark two', false)]);
      const { user } = setup();
      await screen.findByText('Top one');
      await user.click(screen.getByRole('button', { name: 'Filters' }));
      await user.click(
        within(screen.getByRole('group', { name: 'Tags' })).getByRole('button', { name: 'Dark' })
      );
      const line = await screen.findByRole('separator', { name: 'Others matching the filters' });
      expect(line.nextElementSibling).toBe(await rowOf('Dark two'));
    });

    it('filters the lists by tags, what the presets do and whose they are', async () => {
      const { user } = setup();
      const { features } = recordAnalytics();
      await user.click(screen.getByRole('tab', { name: 'All' }));
      await screen.findByText('All one');
      await user.click(screen.getByRole('button', { name: 'Filters' }));

      await user.click(
        within(screen.getByRole('group', { name: 'Tags' })).getByRole('button', { name: 'Dark' })
      );
      await user.click(
        within(screen.getByRole('group', { name: 'Features' })).getByRole('button', { name: 'With clip' })
      );
      await user.click(
        within(screen.getByRole('group', { name: 'Origin' })).getByRole('button', { name: 'Factory' })
      );

      await waitFor(() =>
        expect(listPresetsMock).toHaveBeenLastCalledWith(
          expect.objectContaining({ tags: ['dark'], features: ['clip'], origin: 'factory' })
        )
      );
      // the key tells how many are on
      expect(screen.getByRole('button', { name: 'Filters' })).toHaveTextContent('3');
      expect(features()).toEqual(['preset:tag', 'preset:filter']);
    });

    it('keeps the tags and features of a filter in the order of their lists, whatever the order chosen', async () => {
      const { user } = setup();
      await user.click(screen.getByRole('tab', { name: 'All' }));
      await screen.findByText('All one');
      await user.click(screen.getByRole('button', { name: 'Filters' }));
      const chip = (group: string, name: string) =>
        within(screen.getByRole('group', { name: group })).getByRole('button', { name });

      await user.click(chip('Tags', 'Wide'));
      await user.click(chip('Tags', 'Dark'));
      await user.click(chip('Features', 'Mono'));
      await user.click(chip('Features', 'With clip'));
      await waitFor(() =>
        expect(listPresetsMock).toHaveBeenLastCalledWith(
          expect.objectContaining({ tags: ['dark', 'wide'], features: ['clip', 'mono'] })
        )
      );
      // one taken off: the others stay in their order
      await user.click(chip('Tags', 'Dark'));
      await waitFor(() =>
        expect(listPresetsMock).toHaveBeenLastCalledWith(expect.objectContaining({ tags: ['wide'] }))
      );
    });
  });

  describe('the lists of this browser', () => {
    it('adds a preset to Favorites with its star, lists them in their tab, the last first', async () => {
      const { user, presets } = setup();
      const { features } = recordAnalytics();
      await user.click(await rowKey('Top two', 'Add to Favorites'));
      await user.click(await rowKey('Top one', 'Add to Favorites'));
      expect(presets[0].$favorites.value).toEqual(['t1', 't2']);
      expect(JSON.parse(localStorage.getItem('presetFavorites') ?? '')).toEqual(['t1', 't2']);
      expect(await rowKey('Top one', 'Remove from Favorites')).toHaveAttribute('aria-pressed', 'true');

      await user.click(screen.getByRole('tab', { name: 'Favorites' }));
      expect(await screen.findByText('Own t1')).toBeInTheDocument();
      expect(getPresetsByIdsMock).toHaveBeenLastCalledWith(['t1', 't2']);
      expect(screen.getAllByText(/^Own/).map((name) => name.textContent)).toEqual(['Own t1', 'Own t2']);
      expect(features()).toEqual(['preset:favorites']);

      await user.click(await rowKey('Own t1', 'Remove from Favorites'));
      expect(presets[0].$favorites.value).toEqual(['t2']);
    });

    it('keeps the rows it has while a changed list is asked for, a spinner under them for the rest', async () => {
      localStorage.setItem('presetFavorites', JSON.stringify(['t1', 't2']));
      localStorage.setItem('presetRecent', JSON.stringify(['t2', 't3']));
      const { user } = setup();
      await user.click(screen.getByRole('tab', { name: 'Favorites' }));
      expect(await screen.findByText('Own t1')).toBeInTheDocument();
      const never = () => new Promise<never>(() => undefined);

      // a star taken off: the rest as it was, no spinner
      getPresetsByIdsMock.mockImplementationOnce(never);
      await user.click(await rowKey('Own t1', 'Remove from Favorites'));
      expect(getPresetsByIdsMock).toHaveBeenLastCalledWith(['t2']);
      expect(screen.queryByText('Own t1')).not.toBeInTheDocument();
      expect(screen.getByText('Own t2')).toBeInTheDocument();
      expect(screen.queryByLabelText('Loading')).not.toBeInTheDocument();

      // another list: the rows known, the spinner for those to come, never the note of an empty list
      getPresetsByIdsMock.mockImplementationOnce(never);
      await user.click(screen.getByRole('tab', { name: 'Recent' }));
      expect(await screen.findByLabelText('Loading')).toBeInTheDocument();
      expect(screen.getByText('Own t2')).toBeInTheDocument();
      expect(screen.queryByText('No presets opened yet')).not.toBeInTheDocument();
    });

    it('lists the presets opened in Recent, those saved from this browser in Mine', async () => {
      setEditToken('m1', 'token-of-m1-0123456789');
      const { user } = setup();
      await user.click(await screen.findByText('Top two'));
      await waitFor(() => expect(getPresetMock).toHaveBeenCalledWith('t2'));

      await user.click(screen.getByRole('tab', { name: 'Recent' }));
      expect(await screen.findByText('Own t2')).toBeInTheDocument();
      // (the preset opened on start by itself is not)
      expect(getPresetsByIdsMock).toHaveBeenLastCalledWith(['t2']);

      await user.click(screen.getByRole('tab', { name: 'Mine' }));
      expect(await screen.findByText('Own m1')).toBeInTheDocument();
      expect(getPresetsByIdsMock).toHaveBeenLastCalledWith(['m1']);
    });

    it('keeps the order of Recent while it is open, asked for as a set: an opening moves no row, asks nothing', async () => {
      localStorage.setItem('presetRecent', JSON.stringify(['t1', 't2']));
      const { user, presets } = setup();
      const names = () => screen.getAllByText(/^Own/).map((name) => name.textContent);
      await user.click(screen.getByRole('tab', { name: 'Recent' }));
      expect(await screen.findByText('Own t1')).toBeInTheDocument();
      await user.click(screen.getByText('Own t2'));
      await waitFor(() => expect(presets[0].$recent.value).toEqual(['t2', 't1']));
      expect(names()).toEqual(['Own t1', 'Own t2']);

      // open again: the last opened first
      await user.click(screen.getByRole('tab', { name: 'Favorites' }));
      await user.click(screen.getByRole('tab', { name: 'Recent' }));
      expect(await screen.findByText('Own t2')).toBeInTheDocument();
      expect(names()).toEqual(['Own t2', 'Own t1']);
      expect(getPresetsByIdsMock).toHaveBeenCalledTimes(1);
    });

    it('filters a list of this browser here, by its category and the search', async () => {
      localStorage.setItem('presetFavorites', JSON.stringify(['p1', 'p2']));
      getPresetsByIdsMock.mockResolvedValue([
        listItem('p1', 'Deep Sub', { category: 'pad' }),
        listItem('p2', 'Laser', { category: 'fx', description: 'pew pew' }),
      ]);
      const { user } = setup();
      await user.click(screen.getByRole('tab', { name: 'Favorites' }));
      expect(await screen.findByText('Deep Sub')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'FX 30' }));
      expect(screen.queryByText('Deep Sub')).not.toBeInTheDocument();
      expect(screen.getByText('Laser')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'All 40' }));
      await user.type(screen.getByPlaceholderText('Search this list'), 'pew');
      await waitFor(() => expect(screen.queryByText('Deep Sub')).not.toBeInTheDocument());
      expect(screen.getByText('Laser')).toBeInTheDocument();
      // the tab stays: the search is of its list
      expect(screen.getByRole('tab', { name: 'Favorites' })).toHaveAttribute('aria-selected', 'true');
      expect(listPresetsMock).not.toHaveBeenCalled();
    });

    it('tells an empty list of this browser how to fill it', async () => {
      const { user } = setup();
      await user.click(screen.getByRole('tab', { name: 'Favorites' }));
      expect(
        await screen.findByText('No favorites yet: the star of a preset adds it here')
      ).toBeInTheDocument();
      expect(getPresetsByIdsMock).not.toHaveBeenCalled();
    });
  });

  describe('Edit info', () => {
    it('is offered for the presets saved from this browser: it saves their info', async () => {
      setEditToken('t2', 'token-of-t2-0123456789');
      const info = { ...EMPTY_PRESET_INFO, category: 'pad' as const, tags: ['warm' as const] };
      jest.mocked(updatePresetInfo).mockResolvedValue({ id: 't2', info });
      const { user, presets } = setup();
      expect(within(await rowOf('Top one')).queryByRole('button', { name: 'Edit info' })).toBeNull();
      await user.click(await rowKey('Top two', 'Edit info'));

      const dialog = within(await screen.findByRole('dialog', { name: 'Edit info' }));
      // its description as it is
      expect(dialog.getByLabelText('Description')).toHaveValue('A warm pad for chords');
      await user.click(
        within(dialog.getByRole('group', { name: 'Category' })).getByRole('button', { name: 'Pad' })
      );
      await user.click(
        within(dialog.getByRole('group', { name: 'Tags' })).getByRole('button', { name: 'Warm' })
      );
      await user.clear(dialog.getByLabelText('Description'));
      await user.click(dialog.getByRole('button', { name: 'Save' }));

      await waitFor(() =>
        expect(updatePresetInfo).toHaveBeenCalledWith('t2', {
          editToken: 'token-of-t2-0123456789',
          info: { category: 'pad', subcategory: null, description: null, tags: ['warm'] },
        })
      );
      expect(getPresetMock).not.toHaveBeenCalledWith('t2');
      await waitFor(() =>
        expect(presets[0].$top.value?.find(({ id }) => id === 't2')).toMatchObject({ category: 'pad' })
      );
    });

    it('tells the new info of the preset opened under the list', async () => {
      setEditToken('t2', 'token-of-t2-0123456789');
      const info = { ...EMPTY_PRESET_INFO, category: 'pad' as const, description: 'Soft and slow' };
      jest.mocked(updatePresetInfo).mockResolvedValue({ id: 't2', info });
      const { user } = setup();
      await user.click(await screen.findByText('Top two'));
      const strip = within(screen.getByRole('region', { name: 'Preset info' }));
      await waitFor(() => expect(strip.getByText('No description')).toBeInTheDocument());

      await user.click(await rowKey('Top two', 'Edit info'));
      const dialog = within(await screen.findByRole('dialog', { name: 'Edit info' }));
      await user.click(dialog.getByRole('button', { name: 'Save' }));
      expect(await strip.findByText('Soft and slow')).toBeInTheDocument();
      expect(strip.getByText('Pad')).toBeInTheDocument();
    });

    it('edits the preset opened with its info as known, not as its row loaded before a Save changed it', async () => {
      setEditToken('t2', 'token-of-t2-0123456789');
      const { user, presets } = setup();
      await user.click(await screen.findByText('Top two'));
      await waitFor(() => expect(presets[0].$current.value?.id).toBe('t2'));
      const info = {
        category: 'pad' as const,
        subcategory: 'warm',
        description: 'Soft and slow',
        tags: ['dark' as const],
      };
      act(() => presets[1].setSaved({ id: 't2', name: 'Preset t2', info }));
      const stripEdit = () =>
        within(screen.getByRole('region', { name: 'Preset info' })).getByRole('button', {
          name: 'Edit info',
          hidden: true,
        });

      for (const edit of [() => rowKey('Top two', 'Edit info'), async () => stripEdit()]) {
        await user.click(await edit());
        const dialog = within(await screen.findByRole('dialog', { name: 'Edit info' }));
        expect(
          within(dialog.getByRole('group', { name: 'Category' })).getByRole('button', { name: 'Pad' })
        ).toHaveAttribute('aria-pressed', 'true');
        expect(dialog.getByLabelText('Description')).toHaveValue('Soft and slow');
        await user.click(dialog.getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit info' })).toBeNull());
      }
    });

    it('changes its rows in the lists loaded, not asked for again; the counts again where it moved', async () => {
      setEditToken('a1', 'token-of-a1-0123456789');
      const info = { ...EMPTY_PRESET_INFO, category: 'pad' as const };
      jest.mocked(updatePresetInfo).mockResolvedValue({ id: 'a1', info });
      const { user, queryClient } = setup();
      await user.click(screen.getByRole('tab', { name: 'All' }));
      await user.click(await rowKey('All one', 'Edit info'));
      const dialog = within(await screen.findByRole('dialog', { name: 'Edit info' }));
      await user.click(
        within(dialog.getByRole('group', { name: 'Category' })).getByRole('button', { name: 'Pad' })
      );
      await user.click(dialog.getByRole('button', { name: 'Save' }));

      await waitFor(() => expect(getPresetCountsMock).toHaveBeenCalledTimes(2));
      const [[, list]] = queryClient.getQueriesData<InfiniteData<PresetsPage>>({
        queryKey: ['presets', 'list'],
      });
      expect(list?.pages[0].items[0]).toMatchObject({ id: 'a1', category: 'pad' });
      expect(listPresetsMock).toHaveBeenCalledTimes(1);
    });

    it('leaves the counts of the categories as they are where it stays in its category', async () => {
      setEditToken('t2', 'token-of-t2-0123456789');
      const info = { ...EMPTY_PRESET_INFO, tags: ['warm' as const] };
      jest.mocked(updatePresetInfo).mockResolvedValue({ id: 't2', info });
      const { user, presets } = setup();
      await user.click(await rowKey('Top two', 'Edit info'));
      const dialog = within(await screen.findByRole('dialog', { name: 'Edit info' }));
      await user.click(
        within(dialog.getByRole('group', { name: 'Tags' })).getByRole('button', { name: 'Warm' })
      );
      await user.click(dialog.getByRole('button', { name: 'Save' }));

      await waitFor(() =>
        expect(presets[0].$top.value?.find(({ id }) => id === 't2')).toMatchObject({ tags: ['warm'] })
      );
      expect(getPresetCountsMock).toHaveBeenCalledTimes(1);
    });

    it('refuses a description with a link', async () => {
      setEditToken('t2', 'token-of-t2-0123456789');
      const { user } = setup();
      await user.click(await rowKey('Top two', 'Edit info'));
      const dialog = within(await screen.findByRole('dialog', { name: 'Edit info' }));
      await user.type(dialog.getByLabelText('Description'), ' at www.spam.io');
      expect(dialog.getByText('No links in the description, please')).toBeInTheDocument();
      expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled();
    });
  });

  describe('the clip of a row', () => {
    beforeEach(() => getPresetMock.mockImplementation((id) => (id === 't1' ? fakePreset(id) : withClip(id))));

    it('opens the preset and plays its clip once its sound plays, the list open; Stop ends it', async () => {
      const { user, presets, track, onClose } = setup();
      const { features } = recordAnalytics();
      const [, { auditionClip, playAudition, endAudition }] = track;
      await user.click(await rowKey('Top two', 'Play its clip'));

      await waitFor(() => expect(presets[0].$current.value?.id).toBe('t2'));
      expect(auditionClip).toHaveBeenCalledWith(CLIP);
      expect(playAudition).toHaveBeenCalledTimes(1);
      expect(presets[0].$list.value).toEqual(top);
      expect(await rowKey('Top two', 'Stop its clip')).toHaveAttribute('aria-pressed', 'true');
      expect(features()).toEqual(['preset:audition']);

      await user.click(await rowKey('Top two', 'Stop its clip'));
      expect(endAudition).toHaveBeenCalled();
      expect(presets[0].$auditioning.value).toBeNull();
      expect(await rowKey('Top two', 'Play its clip')).toHaveAttribute('aria-pressed', 'false');
      // the preset stays
      expect(presets[0].$current.value?.id).toBe('t2');
      expect(onClose).not.toHaveBeenCalled();
    });

    it('switches to the clip of another row with its Play', async () => {
      const { user, presets, track } = setup();
      const [, { auditionClip, endAudition }] = track;
      await user.click(await rowKey('Top two', 'Play its clip'));
      await waitFor(() => expect(presets[0].$auditioning.value).toBe('t2'));
      await user.click(await rowKey('Top three', 'Play its clip'));

      await waitFor(() => expect(presets[0].$current.value?.id).toBe('t3'));
      expect(auditionClip).toHaveBeenCalledTimes(2);
      // (the clip of the track stays aside: not given back between them)
      expect(endAudition).not.toHaveBeenCalled();
      expect(await rowKey('Top three', 'Stop its clip')).toBeInTheDocument();
      expect(await rowKey('Top two', 'Play its clip')).toBeInTheDocument();
    });

    it('stops with a click on a row and with the list closed', async () => {
      const { user, presets, track, rerender } = setup();
      const [, { endAudition }] = track;
      await user.click(await rowKey('Top two', 'Play its clip'));
      await waitFor(() => expect(presets[0].$auditioning.value).toBe('t2'));

      await user.click(screen.getByText('Top one'));
      expect(endAudition).toHaveBeenCalledTimes(1);
      expect(presets[0].$auditioning.value).toBeNull();
      await waitFor(() => expect(presets[0].$current.value?.id).toBe('t1'));

      await user.click(await rowKey('Top two', 'Play its clip'));
      await waitFor(() => expect(presets[0].$auditioning.value).toBe('t2'));
      rerender(<PresetBrowser open={false} onClose={jest.fn()} />);
      expect(endAudition).toHaveBeenCalledTimes(2);
      expect(presets[0].$auditioning.value).toBeNull();
    });

    it('has no tooltip of its own', async () => {
      const { user } = setup();
      await user.hover(await rowKey('Top two', 'Play its clip'));
      act(() => jest.advanceTimersByTime(3000));
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });

    it('is off while REC records or a MIDI Clock leads the tempo, saying why', async () => {
      const track = fakeTrack();
      const { user } = setup({ track });
      act(() => track[0].$auditionBlocked.next('rec'));
      const key = await rowKey('Top two', 'Play its clip');
      expect(key).toBeDisabled();
      await user.hover(key.parentElement as HTMLElement);
      expect(await screen.findByText('Not while REC records')).toBeInTheDocument();

      act(() => track[0].$auditionBlocked.next('midi'));
      await user.hover(key.parentElement as HTMLElement);
      expect(await screen.findByText('Not while a MIDI Clock leads the tempo')).toBeInTheDocument();
      expect(key).toBeDisabled();
    });
  });

  describe('keys', () => {
    beforeEach(() => getPresetMock.mockImplementation((id) => (id === 't1' ? fakePreset(id) : withClip(id))));

    // the browser open on the preset opened on start (the first popular one)
    const ready = async (id = 't1', track = fakeTrack()) => {
      const result = setup({ track });
      await waitFor(() => expect(result.presets[0].$current.value?.id).toBe(id));
      getPresetMock.mockClear();
      return result;
    };
    const isLit = async (name: string) => expect(await rowOf(name)).toHaveAttribute('aria-current', 'true');

    it('the arrows open the next and the one before of the list, lit at once, the row shown', async () => {
      const scrollIntoView = jest.fn();
      Element.prototype.scrollIntoView = scrollIntoView;
      const { user, presets } = await ready();
      const { features } = recordAnalytics();
      let resolve: (preset: Preset) => void = () => undefined;
      getPresetMock.mockImplementationOnce(() => new Promise((r) => (resolve = r)));

      await user.keyboard('{ArrowDown}');
      expect(getPresetMock).toHaveBeenLastCalledWith('t2');
      // lit while it opens, the current one still the first
      await isLit('Top two');
      expect(presets[0].$current.value?.id).toBe('t1');
      expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest' });
      expect(scrollIntoView.mock.contexts.at(-1)).toBe(await rowOf('Top two'));
      await act(async () => resolve(await withClip('t2')));
      await waitFor(() => expect(presets[0].$current.value?.id).toBe('t2'));
      expect(presets[0].$list.value).toEqual(top);
      expect(features()).toEqual(['preset:open']);

      await user.keyboard('{ArrowDown}');
      await waitFor(() => expect(presets[0].$current.value?.id).toBe('t3'));
      // the end of the list: no step
      await user.keyboard('{ArrowRight}');
      expect(getPresetMock).toHaveBeenCalledTimes(2);
      await user.keyboard('{ArrowUp}');
      await waitFor(() => expect(presets[0].$current.value?.id).toBe('t2'));
      await user.keyboard('{ArrowLeft}');
      await waitFor(() => expect(presets[0].$current.value?.id).toBe('t1'));
      await user.keyboard('{ArrowLeft}');
      expect(getPresetMock).toHaveBeenCalledTimes(4);
      // (no clip played: Play is off)
      expect(presets[0].$auditioning.value).toBeNull();
      // @ts-expect-error jsdom has none
      delete Element.prototype.scrollIntoView;
    });

    it('the arrows go down Recent as it was when it opened: an opening takes no row up', async () => {
      localStorage.setItem('presetRecent', JSON.stringify(['r1', 'r2', 'r3']));
      const { user, presets } = await ready();
      await user.click(screen.getByRole('tab', { name: 'Recent' }));
      expect(await screen.findByText('Own r1')).toBeInTheDocument();
      for (const id of ['r1', 'r2', 'r3']) {
        await user.keyboard('{ArrowDown}');
        await waitFor(() => expect(presets[0].$current.value?.id).toBe(id));
      }
      expect(presets[0].$recent.value).toEqual(['r3', 'r2', 'r1']);
    });

    it('a list without the preset opened starts from its first or its last', async () => {
      const { user, presets } = await ready();
      await user.click(screen.getByRole('tab', { name: 'All' }));
      expect(await screen.findByText('All one')).toBeInTheDocument();
      await user.keyboard('{ArrowUp}');
      await waitFor(() => expect(presets[0].$current.value?.id).toBe('a1'));
    });

    it('the search field takes all but the up and down arrows', async () => {
      const { user, presets } = await ready();
      await user.click(screen.getByPlaceholderText('Search all presets'));
      await user.keyboard('{ArrowRight}');
      expect(getPresetMock).not.toHaveBeenCalled();
      await user.keyboard(' ');
      expect(screen.getByPlaceholderText('Search all presets')).toHaveValue(' ');
      expect(presets[0].$auditioning.value).toBeNull();

      await user.keyboard('{ArrowDown}');
      await waitFor(() => expect(presets[0].$current.value?.id).toBe('t2'));
    });

    // a track with notes in its loop
    const looping = () => {
      const track = fakeTrack();
      track[0].$clip.next({ ...track[0].$clip.value, notes: [[0, 480, 60, 100]] });
      return track;
    };

    it('Space plays the clip of the selected preset and stops it; nothing without one nor notes in the track', async () => {
      const { user, presets, track } = await ready();
      const [, { auditionClip, playAudition, holdAudition, endAudition, play }] = track;
      await user.keyboard(' ');
      expect(holdAudition).not.toHaveBeenCalled();
      expect(play).not.toHaveBeenCalled();
      expect(presets[0].$auditioning.value).toBeNull();

      await user.keyboard('{ArrowDown}');
      await waitFor(() => expect(presets[0].$current.value?.id).toBe('t2'));
      const { features } = recordAnalytics();
      await user.keyboard(' ');
      await waitFor(() => expect(playAudition).toHaveBeenCalledTimes(1));
      expect(auditionClip).toHaveBeenCalledWith(CLIP);
      expect(presets[0].$auditioning.value).toBe('t2');
      expect(await rowKey('Top two', 'Stop its clip')).toHaveAttribute('aria-pressed', 'true');
      expect(features()).toEqual(['preset:audition']);

      await user.keyboard(' ');
      expect(presets[0].$auditioning.value).toBeNull();
      expect(endAudition).toHaveBeenCalledTimes(1);
    });

    it('keeps playing as the arrows step: a preset without a clip opens silent, the next one plays', async () => {
      getTopPresetsMock.mockResolvedValue([
        listItem('c1', 'Clip one', { features: ['clip'] }),
        listItem('n1', 'No clip'),
        listItem('c2', 'Clip two', { features: ['clip'] }),
      ]);
      getPresetMock.mockImplementation((id) => (id === 'n1' ? fakePreset(id) : withClip(id)));
      const { user, presets, track } = await ready('c1');
      const [, { auditionClip, endAudition }] = track;
      await user.keyboard(' ');
      await waitFor(() => expect(presets[0].$auditioning.value).toBe('c1'));

      await user.keyboard('{ArrowDown}');
      await waitFor(() => expect(presets[0].$current.value?.id).toBe('n1'));
      expect(presets[0].$auditioning.value).toBeNull();
      expect(endAudition).toHaveBeenCalledTimes(1);

      await user.keyboard('{ArrowDown}');
      await waitFor(() => expect(presets[0].$auditioning.value).toBe('c2'));
      await waitFor(() => expect(presets[0].$current.value?.id).toBe('c2'));
      expect(auditionClip).toHaveBeenCalledTimes(2);

      // Space: Play off, the arrows open alone
      await user.keyboard(' ');
      expect(presets[0].$auditioning.value).toBeNull();
      await user.keyboard('{ArrowUp}{ArrowUp}');
      await waitFor(() => expect(presets[0].$current.value?.id).toBe('c1'));
      expect(presets[0].$auditioning.value).toBeNull();
      expect(auditionClip).toHaveBeenCalledTimes(2);
    });

    it('Space plays the loop of the track under a preset without a clip, and stops it', async () => {
      const { user, presets, track } = await ready('t1', looping());
      const [{ $armed }, { play, stop, holdAudition }] = track;
      await user.keyboard(' ');
      expect(play).toHaveBeenCalledTimes(1);
      expect($armed.value).toBe(true);
      expect(holdAudition).not.toHaveBeenCalled();
      expect(presets[0].$auditioning.value).toBeNull();

      await user.keyboard(' ');
      expect(stop).toHaveBeenCalledTimes(1);
      expect($armed.value).toBe(false);
    });

    it('keeps playing as the arrows step: the loop of the track under a preset without a clip', async () => {
      getTopPresetsMock.mockResolvedValue([
        listItem('c1', 'Clip one', { features: ['clip'] }),
        listItem('n1', 'No clip'),
        listItem('n2', 'No clip two'),
        listItem('c2', 'Clip two', { features: ['clip'] }),
      ]);
      getPresetMock.mockImplementation((id) => (id.startsWith('n') ? fakePreset(id) : withClip(id)));
      const { user, presets, track } = await ready('c1', looping());
      const [{ $armed }, { play, stop, endAudition, holdAudition }] = track;
      await user.keyboard(' ');
      await waitFor(() => expect(presets[0].$auditioning.value).toBe('c1'));

      // the clip heard ends, the loop of the track plays
      await user.keyboard('{ArrowDown}');
      await waitFor(() => expect(presets[0].$current.value?.id).toBe('n1'));
      expect(endAudition).toHaveBeenCalledTimes(1);
      expect(play).toHaveBeenCalledTimes(1);
      expect($armed.value).toBe(true);
      // it plays on
      await user.keyboard('{ArrowDown}');
      await waitFor(() => expect(presets[0].$current.value?.id).toBe('n2'));
      expect(play).toHaveBeenCalledTimes(1);
      expect(stop).not.toHaveBeenCalled();

      // the clip of the next one takes its place
      await user.keyboard('{ArrowDown}');
      await waitFor(() => expect(presets[0].$auditioning.value).toBe('c2'));
      expect(holdAudition).toHaveBeenCalledTimes(2);

      await user.keyboard(' ');
      expect(presets[0].$auditioning.value).toBeNull();
      expect($armed.value).toBe(false);
    });

    it('leaves a loop the track plays already to the arrows; Space stops it', async () => {
      const track = looping();
      track[0].$armed.next(true);
      const { user, presets } = await ready('t1', track);
      const [{ $armed }, { play, stop }] = track;
      await user.keyboard('{ArrowDown}');
      await waitFor(() => expect(presets[0].$current.value?.id).toBe('t2'));
      expect(presets[0].$auditioning.value).toBeNull();
      expect(play).not.toHaveBeenCalled();
      expect($armed.value).toBe(true);

      await user.keyboard(' ');
      expect(stop).toHaveBeenCalledTimes(1);
      expect($armed.value).toBe(false);
    });

    it('Play goes off with a click on a row and with its Stop', async () => {
      const { user, presets } = await ready();
      await user.click(await rowKey('Top two', 'Play its clip'));
      await waitFor(() => expect(presets[0].$auditioning.value).toBe('t2'));
      await user.click(screen.getByText('Top one'));
      await waitFor(() => expect(presets[0].$current.value?.id).toBe('t1'));
      await user.keyboard('{ArrowDown}');
      await waitFor(() => expect(presets[0].$current.value?.id).toBe('t2'));
      expect(presets[0].$auditioning.value).toBeNull();

      await user.click(await rowKey('Top two', 'Play its clip'));
      await waitFor(() => expect(presets[0].$auditioning.value).toBe('t2'));
      await user.click(await rowKey('Top two', 'Stop its clip'));
      await user.keyboard('{ArrowDown}');
      await waitFor(() => expect(presets[0].$current.value?.id).toBe('t3'));
      expect(presets[0].$auditioning.value).toBeNull();
    });

    it('takes one step a press: the auto-repeat of a key held is dropped', async () => {
      await ready();
      fireEvent.keyDown(document.body, { key: 'ArrowDown', repeat: true });
      fireEvent.keyDown(document.body, { key: ' ', repeat: true });
      expect(getPresetMock).not.toHaveBeenCalled();
    });

    it('takes Space from the page and from a focused key, never from a field', async () => {
      await ready();
      const space = (target: Element) => {
        const event = createEvent.keyDown(target, { key: ' ' });
        fireEvent(target, event);
        return event.defaultPrevented;
      };
      // (the Space of the track skips it)
      expect(space(document.body)).toBe(true);
      expect(space(screen.getByRole('button', { name: 'Done' }))).toBe(true);
      expect(space(screen.getByPlaceholderText('Search all presets'))).toBe(false);
    });

    it('does nothing while Edit info is open, nor with the list closed', async () => {
      setEditToken('t2', 'token-of-t2-0123456789');
      const { user, rerender, presets } = await ready();
      await user.click(await rowKey('Top two', 'Edit info'));
      await screen.findByRole('dialog', { name: 'Edit info' });
      fireEvent.keyDown(document.body, { key: 'ArrowDown' });
      fireEvent.keyDown(document.body, { key: ' ' });
      expect(getPresetMock).not.toHaveBeenCalled();

      rerender(<PresetBrowser open={false} onClose={jest.fn()} />);
      fireEvent.keyDown(document.body, { key: 'ArrowDown' });
      expect(getPresetMock).not.toHaveBeenCalled();
      expect(presets[0].$auditioning.value).toBeNull();
    });
  });
});
