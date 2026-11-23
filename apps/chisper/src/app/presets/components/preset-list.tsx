import React from 'react';
import { styled } from 'styled-components';
import hexToRgba from 'hex-to-rgba';
import { Tooltip } from 'antd';
import { LoadingOutlined } from '@ant-design/icons';
import { AiOutlineFire } from 'react-icons/ai';
import { text10, text12, textBold12, theme } from '@chisper/ui-kit';
import { PRESET_FEATURES, PresetListItem } from '@chisper/preset-schema';
import { LitKey, screenItemStyle, screenLitStyle, screenScrollStyle, TipWrap } from '../../common/components';
import { FeatureMark, PlayIcon, StopIcon } from './feature-icons';
import { NARROW, only, PresetKeys } from './preset-keys';

const { colors } = theme;

// as high whatever it holds: the dialog doesn't jump between the tabs
const List = styled.div`
  ${screenScrollStyle};
  height: 50vh;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 3px;
`;

// a row of a preset (a click loads it): its number in the list, as the programs of a synth are, the Play of its clip
// before its name; the current one lit in blue, as a lit key of the synth; its keys show up while it is hovered (a
// star that is on and the Play always). On a phone its name has the room: what it does, its listeners and its keys
// (in the strip under the list, of the selected one) are hidden
const Row = styled.div`
  ${screenItemStyle};
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  padding-block: 2px;
  padding-inline-end: 3px;
  cursor: pointer;

  &[aria-current='true'],
  &[aria-current='true']:hover {
    ${screenLitStyle};
  }

  // (a touch screen shows them all: no hover there)
  @media (hover: hover) {
    .key {
      opacity: 0;
      transition:
        opacity 120ms,
        background 120ms;
    }

    &:hover .key,
    .key:focus-visible,
    .key.open,
    .key.on {
      opacity: 1;
    }
  }

  ${NARROW} {
    .wide,
    .key {
      display: none;
    }
  }
`;

const Program = styled.span`
  ${text10};
  flex: none;
  width: 28px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.5px;
  color: ${hexToRgba(colors.primaryDarkHighContrast, 0.7)};
  transition: color 120ms;

  [aria-current='true'] > & {
    color: ${colors.secondAccent};
  }
`;

// the Play of its clip: a column of every row (none: empty), the names one under the other; as small as the icons of
// what it does, in the blue of the screen, white while its row is hovered, lit while it plays
const Play = styled.span`
  flex: none;
  width: 24px;
  display: flex;

  button {
    color: ${colors.primaryDarkHighContrast};
  }

  svg {
    width: 13px;
    height: 13px;
  }

  [data-preset]:hover > & button:not([aria-pressed='true']):not(:disabled),
  & button:not([aria-pressed='true']):focus-visible {
    color: ${colors.white};
  }

  & button[aria-pressed='true'] {
    color: ${colors.secondAccent};
  }
`;

// its name, a badge of a preset of the synth after it (its description is under the list, of the current one alone)
const Title = styled.div`
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
`;

const Name = styled.span`
  ${textBold12};
  min-width: 0;
  line-height: 22px;
  color: ${colors.white};
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;

  [aria-current='true'] & {
    color: ${colors.secondAccent};
  }
`;

const Badge = styled.span`
  ${text10};
  flex: none;
  padding: 0 4px;
  border: 1px solid ${colors.primaryDarkMediumContrast};
  border-radius: 2px;
  color: ${colors.primaryDarkHighContrast};
  font-weight: 600;
  font-size: 9px;
  line-height: 13px;
  letter-spacing: 1px;
  text-transform: uppercase;
`;

// what it does but its clip (its Play says it): its icons, always in the same order
const MARKED = PRESET_FEATURES.filter((feature) => feature !== 'clip');

// a column each: the icons of the rows one under the other
const Marks = styled.span`
  flex: none;
  display: grid;
  grid-template-columns: repeat(${MARKED.length}, 14px);
  align-items: center;
  justify-items: center;
  column-gap: 4px;

  & > span {
    display: flex;
  }
`;

// its listeners, the counts of the rows one under the other
const Popularity = styled.span`
  ${text12};
  flex: none;
  min-width: 44px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 3px;
  margin-right: 4px;
  font-variant-numeric: tabular-nums;
  color: ${colors.primaryDarkHighContrast};
`;

// the line before the presets of the Popular of a filter that aren't popular: its label, a line on to the end of the
// row
const Divider = styled.div`
  ${text10};
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 8px 4px;
  font-weight: 600;
  letter-spacing: 1.2px;
  text-transform: uppercase;
  color: ${colors.primaryDarkHighContrast};

  &::after {
    content: '';
    flex: 1 1 auto;
    border-top: 1px solid ${colors.primaryDarkMediumContrast};
  }
`;

const Note = styled.div`
  ${text12};
  display: flex;
  justify-content: center;
  gap: 6px;
  padding: 16px;
  color: ${colors.primaryDarkHighContrast};
`;

// a text button, as the Retry of a failed effect
const Retry = styled.button.attrs({ type: 'button' })`
  padding: 0;
  border: none;
  background: none;
  font: inherit;
  font-weight: bold;
  color: ${colors.secondAccent};
  text-decoration: underline;
  cursor: pointer;

  &:focus {
    outline: none;
  }

  &:focus-visible {
    outline: 1px solid ${colors.secondAccent};
    outline-offset: 2px;
  }
`;

interface Props {
  items: PresetListItem[];
  currentId?: string;
  loading: boolean;
  hasMore?: boolean;
  onLoadMore?: () => void;
  // the list (or its next page) failed to load: what loads it again (none: it didn't fail)
  onRetry?: () => void;
  onSelect: (item: PresetListItem) => void;
  // shown where the list is empty
  empty: string;
  // a line with its label before the row at `at` (the rest of the Popular of a filter)
  divider?: { at: number; label: string };
  favorites: ReadonlySet<string>;
  // the preset whose clip plays (null: none), why none can play now (null: they can)
  auditioning: string | null;
  auditionBlocked: string | null;
  onAudition: (item: PresetListItem) => void;
  onStopAudition: () => void;
  // the presets saved from this browser: their info can be edited
  editable: ReadonlySet<string>;
  onEditInfo: (item: PresetListItem) => void;
}

// the presets on the screen of the browser: the Play of a clip, their names (a badge of those of the synth), what
// they do, their listeners; a star, Edit info of own ones, keys to copy the link of one and to report it
export const PresetList = ({
  items,
  currentId,
  loading,
  hasMore,
  onLoadMore,
  onRetry,
  onSelect,
  empty,
  divider,
  favorites,
  auditioning,
  auditionBlocked,
  onAudition,
  onStopAudition,
  editable,
  onEditInfo,
}: Props) => {
  const root = React.useRef<HTMLDivElement>(null);
  const sentinel = React.useRef<HTMLDivElement>(null);

  // infinite scroll: load the next page when the end of the list becomes visible
  React.useEffect(() => {
    if (!hasMore || loading || !sentinel.current) return;
    const observer = new IntersectionObserver(([entry]) => entry.isIntersecting && onLoadMore?.(), {
      root: root.current,
    });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [hasMore, loading, onLoadMore]);

  // the selected row in view (an arrow stepped to it, the list opened on it): once a preset, as soon as its row is
  // there (a page loaded after it doesn't scroll back to it)
  const shown = React.useRef<string | undefined>(undefined);
  React.useEffect(() => {
    if (!currentId || shown.current === currentId || !root.current) return;
    const row = [...root.current.querySelectorAll<HTMLElement>('[data-preset]')].find(
      (element) => element.dataset['preset'] === currentId
    );
    if (!row) return;
    shown.current = currentId;
    row.scrollIntoView?.({ block: 'nearest' });
  }, [currentId, items]);

  const clipKey = (item: PresetListItem) => {
    const playing = auditioning === item.id;
    const blocked = !playing && auditionBlocked !== null;
    const key = (
      <LitKey
        className='square'
        aria-label={playing ? 'Stop its clip' : 'Play its clip'}
        aria-pressed={playing}
        disabled={blocked}
        onClick={only(() => (playing ? onStopAudition() : onAudition(item)))}
      >
        {playing ? <StopIcon /> : <PlayIcon />}
      </LitKey>
    );
    // no tooltip: only why it can't play now
    return blocked ? (
      <Tooltip title={auditionBlocked}>
        <TipWrap>{key}</TipWrap>
      </Tooltip>
    ) : (
      key
    );
  };

  return (
    <List ref={root} data-testid='preset-list'>
      {items.map((item, index) => (
        <React.Fragment key={item.id}>
          {divider?.at === index && (
            <Divider role='separator' aria-label={divider.label}>
              {divider.label}
            </Divider>
          )}
          <Row
            data-preset={item.id}
            aria-current={item.id === currentId || undefined}
            onClick={() => onSelect(item)}
          >
            <Program aria-hidden>{String(index + 1).padStart(3, '0')}</Program>
            <Play>{item.features.includes('clip') && clipKey(item)}</Play>
            <Title>
              <Name>{item.name}</Name>
              {item.factory && <Badge>Factory</Badge>}
            </Title>
            <Marks className='wide'>
              {MARKED.map((feature) => (
                <span key={feature}>
                  {item.features.includes(feature) && <FeatureMark feature={feature} />}
                </span>
              ))}
            </Marks>
            <Popularity className='wide'>
              {item.uniqueUsers > 0 && (
                <>
                  <AiOutlineFire />
                  {item.uniqueUsers}
                </>
              )}
            </Popularity>
            <PresetKeys
              id={item.id}
              favorite={favorites.has(item.id)}
              onEditInfo={editable.has(item.id) ? () => onEditInfo(item) : undefined}
            />
          </Row>
        </React.Fragment>
      ))}
      {loading && (
        <Note>
          <LoadingOutlined aria-label='Loading' />
        </Note>
      )}
      {!loading && onRetry && (
        <Note role='alert'>
          Couldn't load the presets
          <Retry onClick={onRetry}>Retry</Retry>
        </Note>
      )}
      {!loading && !onRetry && items.length === 0 && <Note>{empty}</Note>}
      {hasMore && !onRetry && <div ref={sentinel} style={{ height: 1, flex: 'none' }} />}
    </List>
  );
};
