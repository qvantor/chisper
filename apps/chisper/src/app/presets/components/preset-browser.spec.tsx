import { act, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import toast from 'react-hot-toast';
import { PresetListItem } from '@chisper/preset-schema';
import { theme } from '@chisper/ui-kit';
import { cssColor } from '@chisper/ui-kit/test-utils';
import { fakePreset } from '../../../test-utils/presets-fixtures';
import { renderWithPresets } from '../../../test-utils/presets-wrapper';
import { getPreset, getTopPresets, listPresets, reportPreset, sharePreset } from '../services';
import { PresetBrowser } from './preset-browser';

jest.mock('../services', () => ({
  ...jest.requireActual('../services'),
  getPreset: jest.fn(),
  getTopPresets: jest.fn(),
  listPresets: jest.fn(),
  reportPreset: jest.fn(),
  sharePreset: jest.fn(),
}));

const getPresetMock = jest.mocked(getPreset);
const getTopPresetsMock = jest.mocked(getTopPresets);
const listPresetsMock = jest.mocked(listPresets);

const item = (id: string, name: string, uniqueUsers = 0): PresetListItem => ({ id, name, uniqueUsers });
const top = [item('t1', 'Top one', 12), item('t2', 'Top two')];

// a row's icon buttons: share, report
const rowButtons = async (name: string) =>
  within((await screen.findByText(name)).parentElement as HTMLElement).getAllByRole('button');

const nameColor = (name: string) => getComputedStyle(screen.getByText(name)).color;

const setup = () => {
  const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
  const onClose = jest.fn();
  const result = renderWithPresets(<PresetBrowser open onClose={onClose} />);
  return { ...result, user, onClose };
};

// debounces run on fake timers, waitFor/findBy advance them
beforeEach(() => {
  jest.useFakeTimers();
  getTopPresetsMock.mockResolvedValue(top);
  listPresetsMock.mockResolvedValue({ items: [item('a1', 'All one')], nextCursor: null });
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

  it('loads the selected preset and uses the list for ◀ ▶', async () => {
    const { user, presets } = setup();
    await user.click(await screen.findByText('Top two'));

    await waitFor(() => expect(presets[0].$current.value).toEqual({ id: 't2', name: 'Preset t2' }));
    expect(getPresetMock).toHaveBeenCalledWith('t2');
    expect(presets[0].$list.value).toEqual(top);
  });

  it('lists all presets sorted by the chosen order', async () => {
    const { user } = setup();
    await user.click(screen.getByRole('tab', { name: 'All' }));
    expect(await screen.findByText('All one')).toBeInTheDocument();
    expect(listPresetsMock).toHaveBeenLastCalledWith({ q: '', sort: 'new', cursor: undefined });

    expect(screen.getByRole('button', { name: 'New' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByText('A–Z'));
    await waitFor(() =>
      expect(listPresetsMock).toHaveBeenLastCalledWith({ q: '', sort: 'name', cursor: undefined })
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
      items: [item('s1', `Found ${q}`)],
      nextCursor: null,
    }));
    const { user } = setup();
    await user.type(screen.getByPlaceholderText('Search all presets'), '  bass ');

    expect(await screen.findByText('Found bass')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Search: bass' })).toHaveAttribute('aria-selected', 'true');
    expect(listPresetsMock).toHaveBeenCalledTimes(1);
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
      .mockResolvedValueOnce({ items: [item('a1', 'All one')], nextCursor: 'cursor-1' })
      .mockResolvedValueOnce({ items: [item('a2', 'All two')], nextCursor: null });

    try {
      const { user } = setup();
      await user.click(screen.getByRole('tab', { name: 'All' }));
      await screen.findByText('All one');
      await waitFor(() => expect(observers).not.toHaveLength(0));

      await act(async () => observers[observers.length - 1]([{ isIntersecting: true }]));
      expect(await screen.findByText('All two')).toBeInTheDocument();
      expect(screen.getByText('All one')).toBeInTheDocument();
      expect(listPresetsMock).toHaveBeenLastCalledWith({ q: '', sort: 'new', cursor: 'cursor-1' });
    } finally {
      globalThis.IntersectionObserver = original;
    }
  });

  it('copies a preset link without loading it', async () => {
    const { user } = setup();
    const [share] = await rowButtons('Top two');
    await user.click(share);

    expect(sharePreset).toHaveBeenCalledWith('t2');
    // only the first one opened on start
    expect(getPresetMock).not.toHaveBeenCalledWith('t2');
  });

  it('reports a preset after confirmation', async () => {
    jest.mocked(reportPreset).mockResolvedValue(undefined);
    const { user } = setup();
    const [, report] = await rowButtons('Top two');
    await user.click(report);
    await user.click(await screen.findByRole('button', { name: 'Report' }));

    expect(reportPreset).toHaveBeenCalledWith('t2');
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Thanks, the preset has been reported'));
    expect(getPresetMock).not.toHaveBeenCalledWith('t2');
  });

  it('shows report errors', async () => {
    jest.mocked(reportPreset).mockRejectedValue(new Error('Already reported'));
    const { user } = setup();
    const [, report] = await rowButtons('Top one');
    await user.click(report);
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
});
