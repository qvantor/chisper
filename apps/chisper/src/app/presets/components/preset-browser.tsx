import React from 'react';
import { styled } from 'styled-components';
import hexToRgba from 'hex-to-rgba';
import { Input } from 'antd';
import { AiOutlineFire, AiOutlineSearch, AiOutlineUnorderedList } from 'react-icons/ai';
import { useInfiniteQuery } from '@tanstack/react-query';
import { keepFocus, SwitchKey, SwitchKeys, textBold12, theme } from '@chisper/ui-kit';
import { useBehaviorSubject } from '@chisper/rxjs-react';
import { PresetListItem, PresetSort } from '@chisper/preset-schema';
import { Bar, Dialog, DialogScreen, DirtyDot, Key, ScreenHead, Spacer } from '../../common/components';
import { INIT_NAME, usePresets } from '../modules/presets';
import { useDebounced } from '../hooks/use-debounced';
import { listPresets } from '../services';
import { PresetList } from './preset-list';

const SEARCH_DEBOUNCE_MS = 300;

const { colors } = theme;

type ListTab = 'popular' | 'all';

// the keys of the sort: their names, their labels on the plate, what they do
const sortOptions: { name: string; label: string; hint: string; value: PresetSort }[] = [
  { name: 'New', label: 'NEW', hint: 'The newest first', value: 'new' },
  { name: 'A–Z', label: 'A–Z', hint: 'By name', value: 'name' },
  { name: 'Popular', label: 'POPULAR', hint: 'The most listened first', value: 'popular' },
];

const LINE = `1px solid ${colors.primaryDarkMediumContrast}`;

// the tabs on top of the screen, as the strips of values of the oscillator: a cell each, a line between them and
// under them
const TabStrip = styled.div`
  flex: none;
  display: flex;
  border-bottom: ${LINE};
`;

// a tab: large, in the blue of the labels of the screens, white once open with a line of the blue of the synth under
// it
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
  padding: 0 14px;
  border: none;
  background: transparent;
  color: ${colors.primaryDarkHighContrast};
  font-size: 13px;
  letter-spacing: 2px;
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
`;

const Ellipsis = styled.span`
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

// the search over the list, the sort keys after it (the list of all presets): the icon of the field in the blue of the
// screen
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

interface Props {
  open: boolean;
  onClose: () => void;
}

export const PresetBrowser = ({ open, onClose }: Props) => {
  const [{ $current, $dirty, $top, $topLoading }, { loadById, loadTop, setList }] = usePresets();
  const current = useBehaviorSubject($current);
  const dirty = useBehaviorSubject($dirty);
  const top = useBehaviorSubject($top);
  const topLoading = useBehaviorSubject($topLoading);
  const [tab, setTab] = React.useState<ListTab>('popular');
  const [search, setSearch] = React.useState('');
  const [sort, setSort] = React.useState<PresetSort>('new');
  const q = useDebounced(search.trim(), SEARCH_DEBOUNCE_MS);

  React.useEffect(() => {
    if (q) setTab('all');
  }, [q]);

  // popular presets are loaded by the model on start, retried here if that failed
  React.useEffect(() => {
    if (open && !$top.value) loadTop();
  }, [open, $top, loadTop]);

  const all = useInfiniteQuery({
    queryKey: ['presets', 'list', q, sort],
    queryFn: ({ pageParam }) => listPresets({ q, sort, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: open && tab === 'all',
    staleTime: 60 * 1000,
  });
  const allItems = React.useMemo(() => all.data?.pages.flatMap((page) => page.items) ?? [], [all.data]);

  // the preset is applied right away, the modal stays open to compare sounds
  const select = (items: PresetListItem[]) => (item: PresetListItem) => {
    setList(items);
    loadById(item.id);
  };

  const { fetchNextPage } = all;
  const loadMore = React.useCallback(() => fetchNextPage(), [fetchNextPage]);

  const tabs: { key: ListTab; label: string; icon: React.ReactNode }[] = [
    { key: 'popular', label: 'Popular', icon: <AiOutlineFire /> },
    {
      key: 'all',
      label: q ? `Search: ${q}` : 'All',
      icon: q ? <AiOutlineSearch /> : <AiOutlineUnorderedList />,
    },
  ];

  return (
    <Dialog title='Presets' open={open} onCancel={onClose} width={600}>
      <DialogScreen>
        <TabStrip role='tablist'>
          {tabs.map(({ key, label, icon }) => (
            <Tab key={key} role='tab' aria-selected={tab === key} onClick={() => setTab(key)}>
              {icon}
              <Ellipsis>{label}</Ellipsis>
            </Tab>
          ))}
        </TabStrip>
        <Search>
          <Input
            variant='borderless'
            prefix={<AiOutlineSearch />}
            placeholder='Search all presets'
            allowClear
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
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
        </Search>
        {tab === 'popular' ? (
          <PresetList
            key='popular'
            items={top ?? []}
            currentId={current?.id}
            loading={topLoading}
            onSelect={select(top ?? [])}
          />
        ) : (
          <PresetList
            key='all'
            items={allItems}
            currentId={current?.id}
            loading={all.isLoading || all.isFetchingNextPage}
            hasMore={all.hasNextPage}
            onLoadMore={loadMore}
            onSelect={select(allItems)}
          />
        )}
      </DialogScreen>
      <Bar>
        <Current>
          <Ellipsis>{current?.name ?? INIT_NAME}</Ellipsis>
          {dirty && <DirtyDot title='Changed' role='img' aria-label='Changed' />}
        </Current>
        <Spacer />
        <Key onClick={onClose}>Done</Key>
      </Bar>
    </Dialog>
  );
};
