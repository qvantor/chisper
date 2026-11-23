import React from 'react';
import { styled } from 'styled-components';
import hexToRgba from 'hex-to-rgba';
import { Input } from 'antd';
import {
  AiOutlineFilter,
  AiOutlineFire,
  AiOutlineHistory,
  AiOutlineSearch,
  AiOutlineStar,
  AiOutlineUnorderedList,
  AiOutlineUser,
} from 'react-icons/ai';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { keepFocus, SwitchKey, SwitchKeys, textBold12, theme } from '@chisper/ui-kit';
import { useBehaviorSubject } from '@chisper/rxjs-react';
import {
  categoryPath,
  isFiltered,
  matchesPresetFilter,
  PresetListItem,
  PresetSort,
} from '@chisper/preset-schema';
import {
  Bar,
  Dialog,
  DialogScreen,
  DirtyDot,
  Key,
  LitKey,
  ScreenHead,
  Spacer,
} from '../../common/components';
import { featureUsed } from '../../common/services/analytics';
import { AuditionBlock, useTrack } from '../../synth/track/modules/track';
import { INIT_NAME, keepOrder, stepIndex, usePresets } from '../modules/presets';
import { useBrowserKeys } from '../hooks/use-browser-keys';
import { useDebounced } from '../hooks/use-debounced';
import { getPresetCounts, getPresetsByIds, listPresets, queryTopPresets } from '../services';
import { CurrentInfo } from './current-info';
import { EditedPreset, InfoDialog } from './info-dialog';
import { CategoryBar, FilterChange, FilterChoice, FilterPanel } from './preset-filters';
import { NARROW, PresetKeys } from './preset-keys';
import { PresetList } from './preset-list';

const SEARCH_DEBOUNCE_MS = 300;

const { colors } = theme;

type ListTab = 'popular' | 'all' | 'favorites' | 'recent' | 'mine';

const NO_IDS: string[] = [];

// a list of the screen failing is seen: reported (app/query-client.ts)
const LIST_LOAD = { load: 'preset_list' };

const EMPTY: Record<ListTab, string> = {
  popular: 'No presets',
  all: 'No presets',
  favorites: 'No favorites yet: the star of a preset adds it here',
  recent: 'No presets opened yet',
  mine: 'No presets saved from this browser',
};

// the keys of the sort: their names, their labels on the plate, what they do
const sortOptions: { name: string; label: string; hint: string; value: PresetSort }[] = [
  { name: 'New', label: 'NEW', hint: 'The newest first', value: 'new' },
  { name: 'A–Z', label: 'A–Z', hint: 'By name', value: 'name' },
  { name: 'Popular', label: 'POPULAR', hint: 'The most listened first', value: 'popular' },
];

// the label of the line of the Popular of a filter before its presets that aren't popular (the server fills it with
// them): another one where none of it is
const othersLabel = ({ category, subcategory }: FilterChoice, nonePopular: boolean) => {
  const scope = category ? `in ${categoryPath(category, subcategory)}` : 'matching the filters';
  return nonePopular ? `No popular presets ${scope} yet` : `Others ${scope}`;
};

// a Popular list of the server with the search of the field (none: as it is)
const searched = <T extends PresetListItem>(list: T[] | null | undefined, q: string) =>
  list && q ? list.filter((item) => matchesPresetFilter(item, { q })) : (list ?? undefined);

const LINE = `1px solid ${colors.primaryDarkMediumContrast}`;

// the tabs on top of the screen, as the strips of values of the oscillator: a cell each, a line between them and
// under them
const TabStrip = styled.div`
  flex: none;
  display: flex;
  border-bottom: ${LINE};
`;

// a tab: large, in the blue of the labels of the screens, white once open with a line of the blue of the synth under
// it; on a phone its icon alone
const Tab = styled.button.attrs({ type: 'button', onMouseDown: keepFocus })`
  ${textBold12};
  position: relative;
  flex: 1 1 0;
  min-width: 0;
  height: 38px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 0 10px;
  border: none;
  background: transparent;
  color: ${colors.primaryDarkHighContrast};
  font-size: 12px;
  letter-spacing: 1.5px;
  text-transform: uppercase;
  cursor: pointer;
  transition:
    color 150ms,
    background 150ms;

  & + & {
    border-left: ${LINE};
  }

  svg {
    flex: none;
    font-size: 16px;
  }

  &::after {
    content: '';
    position: absolute;
    left: 18%;
    right: 18%;
    bottom: -1px;
    height: 2px;
    border-radius: 1px;
    background: ${colors.secondAccent};
    opacity: 0;
    transform: scaleX(0.4);
    transition:
      opacity 150ms,
      transform 200ms;
  }

  &:hover {
    color: ${colors.white};
    background: ${hexToRgba(colors.primaryDarkMediumContrast, 0.6)};
  }

  &[aria-selected='true'] {
    color: ${colors.white};
    background: linear-gradient(to top, ${hexToRgba(colors.secondAccent, 0.18)}, transparent 75%);
  }

  &[aria-selected='true'] svg {
    color: ${colors.secondAccent};
  }

  &[aria-selected='true']::after {
    opacity: 1;
    transform: none;
  }

  &:focus-visible {
    outline: none;
    color: ${colors.white};
  }

  ${NARROW} {
    padding: 0 4px;

    .label {
      display: none;
    }
  }
`;

const Ellipsis = styled.span`
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

// the search over the list, the sort keys and the key of the filters after it: the icon of the field in the blue of
// the screen
const Search = styled(ScreenHead)`
  gap: 4px;
  padding: 2px 5px 2px 0;

  .ant-input-prefix {
    color: ${colors.primaryDarkHighContrast};
    font-size: 14px;
  }
`;

// the plate of the sort keys, outlined on the dark of the screen
const Sort = styled(SwitchKeys)`
  flex: none;
  height: 22px;
  box-shadow: inset 0 0 0 1px ${colors.primaryDarkMediumContrast};
`;

// the preset playing: its name, a blue dot while it is changed (as the dot of a clip not saved)
const Current = styled.span`
  min-width: 0;
  display: flex;
  align-items: center;
  padding-left: 2px;
`;

// why the clip of a row can't play now
const AUDITION_BLOCKS: Record<AuditionBlock, string> = {
  rec: 'Not while REC records',
  midi: 'Not while a MIDI Clock leads the tempo',
};

interface QueryState {
  isError: boolean;
  isFetching: boolean;
}

// a query of a list that failed, asked again: the list loads
const refetching = ({ isError, isFetching }: QueryState) => isError && isFetching;

// what asks a query that failed again (undefined: it didn't fail, or it is asked again)
const failed = ({ isError, isFetching }: QueryState, again: () => unknown) =>
  isError && !isFetching ? () => void again() : undefined;

// the field of the search: what is typed stays in it (a key renders no list), the browser gets it trimmed once the
// typing pauses
const SearchField = ({ placeholder, onSearch }: { placeholder: string; onSearch: (q: string) => void }) => {
  const [search, setSearch] = React.useState('');
  const q = useDebounced(search.trim(), SEARCH_DEBOUNCE_MS);
  React.useEffect(() => onSearch(q), [q, onSearch]);
  return (
    <Input
      variant='borderless'
      prefix={<AiOutlineSearch />}
      placeholder={placeholder}
      allowClear
      value={search}
      onChange={(e) => setSearch(e.target.value)}
    />
  );
};

interface Props {
  open: boolean;
  // a dialog over it (Save, ⌘S): its keys are that dialog's
  covered?: boolean;
  onClose: () => void;
}

export const PresetBrowser = ({ open, covered = false, onClose }: Props) => {
  const [
    { $current, $currentInfo, $opening, $dirty, $top, $topLoading, $favorites, $recent, $mine, $auditioning },
    { loadById, loadTop, setList, audition, stopAudition },
  ] = usePresets();
  const [{ $auditionBlocked, $armed, $clip }, { play: playTrack, stop: stopTrack }] = useTrack();
  const current = useBehaviorSubject($current);
  const currentInfo = useBehaviorSubject($currentInfo);
  const opening = useBehaviorSubject($opening);
  const dirty = useBehaviorSubject($dirty);
  const top = useBehaviorSubject($top);
  const topLoading = useBehaviorSubject($topLoading);
  const favorites = useBehaviorSubject($favorites);
  const recent = useBehaviorSubject($recent);
  const mine = useBehaviorSubject($mine);
  const auditioning = useBehaviorSubject($auditioning);
  const auditionBlock = useBehaviorSubject($auditionBlocked);
  const [tab, setTab] = React.useState<ListTab>('popular');
  const [q, setQ] = React.useState('');
  const [sort, setSort] = React.useState<PresetSort>('new');
  // the filter of the server (the search apart: All sends it, the other lists are searched here)
  const [filter, setFilter] = React.useState<FilterChoice>({ tags: [], features: [] });
  const [filtersOpen, setFiltersOpen] = React.useState(false);
  // the preset whose info is edited (null: none)
  const [editing, setEditing] = React.useState<EditedPreset | null>(null);
  // Play on (its key, Space): a step of the arrows plays the clip of the next preset, one without a clip the loop of
  // the track (none: it opens silent, Play stays on); off by Space, Stop, a click on a row, the list closed, the track
  // unable to play a clip (REC, MIDI Clock)
  const playMode = React.useRef(false);
  // Recent in the order it had as its tab opened, while it is open: an opening takes no row up (the arrows go down
  // it, a row clicked stays under the pointer); one new to it comes first
  const recentOrder = React.useRef(recent);
  const recentShown = React.useMemo(
    () => (recentOrder.current = open && tab === 'recent' ? keepOrder(recentOrder.current, recent) : recent),
    [open, tab, recent]
  );
  // the lists of this browser: its own ids, filtered here
  const ownIds: Partial<Record<ListTab, string[]>> = { favorites, recent: recentShown, mine };
  const personal = tab in ownIds;

  // a search from Popular looks in all presets (Popular chosen again: its presets of the search)
  React.useEffect(() => {
    if (q) setTab((tab) => (tab === 'popular' ? 'all' : tab));
  }, [q]);

  // popular presets are loaded by the model on start, again here if that failed (the list tells a failure here)
  const [topFailed, setTopFailed] = React.useState(false);
  const retryTop = React.useCallback(() => {
    setTopFailed(false);
    loadTop({ silent: true }).then((list) => setTopFailed(list === null));
  }, [loadTop]);
  React.useEffect(() => {
    if (open && !$top.value) retryTop();
  }, [open, $top, retryTop]);

  // the clip heard stops with the list closed
  React.useEffect(() => {
    if (open) return;
    playMode.current = false;
    stopAudition();
  }, [open, stopAudition]);

  React.useEffect(() => {
    if (auditionBlock) playMode.current = false;
  }, [auditionBlock]);

  const filtered = isFiltered(filter);
  const choices = filter.tags.length + filter.features.length + (filter.origin ? 1 : 0);

  const counts = useQuery({
    queryKey: ['presets', 'counts'],
    queryFn: getPresetCounts,
    enabled: open,
    staleTime: 5 * 60 * 1000,
  });

  const filteredTop = useQuery({
    queryKey: ['presets', 'top', filter],
    queryFn: () => queryTopPresets(filter),
    enabled: open && tab === 'popular' && filtered,
    staleTime: 60 * 1000,
    meta: LIST_LOAD,
  });

  const all = useInfiniteQuery({
    queryKey: ['presets', 'list', q, sort, filter],
    queryFn: ({ pageParam }) => listPresets({ ...filter, q, sort, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: open && tab === 'all',
    staleTime: 60 * 1000,
    meta: LIST_LOAD,
  });
  const allItems = React.useMemo(() => all.data?.pages.flatMap((page) => page.items) ?? [], [all.data]);
  const topShown = React.useMemo(() => searched(top, q), [top, q]);
  const filteredTopShown = React.useMemo(() => searched(filteredTop.data, q), [filteredTop.data, q]);

  // the ids of the list of this browser open, asked for as a set (Recent moved by an opening asks nothing), shown in
  // their order; the rows known stay while a changed set is asked for (a star taken off: none missing)
  const ids = ownIds[tab] ?? NO_IDS;
  const idSet = React.useMemo(() => [...ids].sort(), [ids]);
  const own = useQuery({
    queryKey: ['presets', 'ids', idSet],
    queryFn: () => getPresetsByIds(idSet),
    enabled: open && personal && idSet.length > 0,
    staleTime: 60 * 1000,
    placeholderData: keepPreviousData,
    meta: LIST_LOAD,
  });
  const [ownItems, ownMissing] = React.useMemo(() => {
    const byId = new Map(own.data?.map((item) => [item.id, item]));
    const shown = ids.flatMap((id) => {
      const item = byId.get(id);
      return item && matchesPresetFilter(item, { ...filter, q }) ? [item] : [];
    });
    return [shown, ids.some((id) => !byId.has(id))];
  }, [own.data, ids, filter, q]);

  // the list of the tab, whether it loads, what loads it again where it failed (a Retry of the list instead of its
  // empty note; loading again after a failure too)
  const [items, loading, retry] = ((): [PresetListItem[], boolean, (() => void) | undefined] => {
    if (tab === 'popular' && !filtered)
      return [topShown ?? [], topLoading || (!top && !topFailed), topFailed ? retryTop : undefined];
    if (tab === 'popular') {
      const { refetch } = filteredTop;
      return [
        filteredTopShown ?? [],
        filteredTop.isLoading || refetching(filteredTop),
        failed(filteredTop, refetch),
      ];
    }
    if (tab === 'all') {
      const { refetch, fetchNextPage, isFetchNextPageError } = all;
      return [
        allItems,
        all.isLoading || all.isFetchingNextPage || refetching(all),
        failed(all, isFetchNextPageError ? fetchNextPage : refetch),
      ];
    }
    return [
      ownItems,
      own.isLoading || (own.isPlaceholderData && ownMissing) || refetching(own),
      failed(own, own.refetch),
    ];
  })();
  // the Popular of a filter: the first of its presets that isn't popular, a line before it (-1: none); whether none of
  // it is popular, as the server tells (a search may leave out those that are)
  const othersAt =
    tab === 'popular' && filtered ? (filteredTopShown?.findIndex((item) => !item.popular) ?? -1) : -1;
  const nonePopular = filteredTop.data?.[0]?.popular === false;

  // the selected preset: the one being opened, else the current one (lit in the list); as it is now for a key (a
  // step before the render of the one before)
  const selectedId = opening?.id ?? current?.id;
  const selectedNow = () => $opening.value?.id ?? $current.value?.id;
  const playable = (item: PresetListItem) => item.features.includes('clip') && !auditionBlock;

  // the preset is applied right away, the modal stays open to compare sounds (◀ ▶ walk this list; loadById opens the
  // preset of a link too: the use is the click's); a clip heard stops
  const openItem = (item: PresetListItem) => {
    stopAudition();
    featureUsed('preset', 'open');
    setList(items);
    loadById(item.id);
  };
  const select = (item: PresetListItem) => {
    playMode.current = false;
    openItem(item);
  };
  // its preset opens as a click would, its clip plays
  const listen = (item: PresetListItem) => {
    playMode.current = true;
    setList(items);
    audition(item.id);
  };
  const stopListening = () => {
    playMode.current = false;
    stopAudition();
  };

  // Space: Play off, or on with the clip of the selected preset (none: nothing to play)
  // the loop of the track (the piano roll) under a preset without a clip, as the Space of the track plays it: none
  // without notes
  const playLoop = () => {
    if ($armed.value || $clip.value.notes.length === 0) return;
    playMode.current = true;
    playTrack();
  };

  // Space: what plays stops (a clip heard, the loop of the track), else the clip of the selected preset plays, without
  // one (or unable to: REC, a MIDI Clock) the loop of the track
  const togglePlay = () => {
    if (playMode.current || $auditioning.value !== null || $armed.value) {
      stopListening();
      if ($armed.value) stopTrack();
      return;
    }
    const id = selectedNow();
    const item = items.find((other) => other.id === id);
    if (item && playable(item)) return listen(item);
    // the current preset, not in this list
    if (!item && id && $current.value?.id === id && $current.value.clipId && !auditionBlock) {
      playMode.current = true;
      return audition(id);
    }
    playLoop();
  };
  // an arrow: the preset after or before the selected one in this list (not in it: the first or the last), its clip
  // heard while Play is on
  const step = (direction: 1 | -1) => {
    if (items.length === 0) return;
    const id = selectedNow();
    const index = items.findIndex((item) => item.id === id);
    const next = stepIndex(items.length, index, direction, false);
    if (next === index) return;
    const item = items[next];
    if (!playMode.current) return openItem(item);
    if (playable(item)) return listen(item);
    // (a clip heard stops: the loop of the track is back, stopped)
    openItem(item);
    playLoop();
  };
  useBrowserKeys(open && !covered && editing === null, { onToggle: togglePlay, onStep: step });

  const changeFilter: FilterChange = (patch, used) => {
    if (used) featureUsed('preset', used);
    setFilter({ ...filter, ...patch });
  };
  const chooseTab = (next: ListTab) => {
    if (next === 'favorites' && tab !== next) featureUsed('preset', 'favorites');
    setTab(next);
  };

  // the opened preset as Edit info of the strip takes it: its info as known (a Save may have changed it since its
  // row was loaded), else its row (none: no Edit info)
  const edited: EditedPreset | null = current
    ? currentInfo
      ? { id: current.id, name: current.name, ...currentInfo }
      : (items.find((item) => item.id === current.id) ?? null)
    : null;
  // a row as Edit info takes it: of the opened preset with its info as known
  const editRow = (item: PresetListItem) => {
    const info = item.id === $current.value?.id ? $currentInfo.value : null;
    setEditing(info ? { ...item, ...info } : item);
  };

  const { fetchNextPage } = all;
  const loadMore = React.useCallback(() => fetchNextPage(), [fetchNextPage]);
  const favoriteIds = React.useMemo(() => new Set(favorites), [favorites]);
  const mineIds = React.useMemo(() => new Set(mine), [mine]);

  const tabs: { key: ListTab; label: string; icon: React.ReactNode }[] = [
    { key: 'popular', label: 'Popular', icon: <AiOutlineFire /> },
    {
      key: 'all',
      label: q && tab === 'all' ? `Search: ${q}` : 'All',
      icon: q && tab === 'all' ? <AiOutlineSearch /> : <AiOutlineUnorderedList />,
    },
    { key: 'favorites', label: 'Favorites', icon: <AiOutlineStar /> },
    { key: 'recent', label: 'Recent', icon: <AiOutlineHistory /> },
    { key: 'mine', label: 'Mine', icon: <AiOutlineUser /> },
  ];

  return (
    <Dialog title='Presets' open={open} onCancel={onClose} width={680}>
      <DialogScreen>
        <TabStrip role='tablist'>
          {tabs.map(({ key, label, icon }) => (
            <Tab
              key={key}
              role='tab'
              aria-selected={tab === key}
              aria-label={label}
              onClick={() => chooseTab(key)}
            >
              {icon}
              <Ellipsis className='label'>{label}</Ellipsis>
            </Tab>
          ))}
        </TabStrip>
        <CategoryBar counts={counts.data ?? null} filter={filter} onChange={changeFilter} />
        <Search>
          <SearchField placeholder={personal ? 'Search this list' : 'Search all presets'} onSearch={setQ} />
          {tab === 'all' && (
            <Sort aria-label='Sort'>
              {sortOptions.map(({ name, label, hint, value }) => (
                <SwitchKey
                  key={value}
                  name={name}
                  label={label}
                  hint={hint}
                  on={sort === value}
                  onChange={() => setSort(value)}
                />
              ))}
            </Sort>
          )}
          {/* the key of the filters: lit while one is on, how many on it */}
          <LitKey
            aria-label='Filters'
            aria-expanded={filtersOpen}
            aria-pressed={choices > 0}
            onClick={() => setFiltersOpen(!filtersOpen)}
          >
            <AiOutlineFilter />
            {choices > 0 && choices}
          </LitKey>
        </Search>
        {filtersOpen && <FilterPanel filter={filter} onChange={changeFilter} />}
        <PresetList
          key={tab}
          items={items}
          currentId={selectedId}
          loading={loading}
          hasMore={tab === 'all' && all.hasNextPage}
          onLoadMore={loadMore}
          onRetry={retry}
          onSelect={select}
          empty={filtered || q ? 'No presets' : EMPTY[tab]}
          divider={othersAt >= 0 ? { at: othersAt, label: othersLabel(filter, nonePopular) } : undefined}
          favorites={favoriteIds}
          auditioning={auditioning}
          auditionBlocked={auditionBlock && AUDITION_BLOCKS[auditionBlock]}
          onAudition={listen}
          onStopAudition={stopListening}
          editable={mineIds}
          onEditInfo={editRow}
        />
        <CurrentInfo
          keys={
            current && (
              <PresetKeys
                key={current.id}
                id={current.id}
                favorite={favoriteIds.has(current.id)}
                onEditInfo={mineIds.has(current.id) && edited ? () => setEditing(edited) : undefined}
              />
            )
          }
        />
      </DialogScreen>
      <Bar>
        <Current>
          <Ellipsis>{current?.name ?? INIT_NAME}</Ellipsis>
          {dirty && <DirtyDot title='Changed' role='img' aria-label='Changed' />}
        </Current>
        <Spacer />
        <Key onClick={onClose}>Done</Key>
      </Bar>
      <InfoDialog preset={editing} onClose={() => setEditing(null)} />
    </Dialog>
  );
};
