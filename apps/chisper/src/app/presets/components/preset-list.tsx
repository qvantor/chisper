import React from 'react';
import { styled } from 'styled-components';
import cls from 'classnames';
import hexToRgba from 'hex-to-rgba';
import { Popconfirm, Tooltip } from 'antd';
import { LoadingOutlined } from '@ant-design/icons';
import { AiOutlineFire, AiOutlineFlag, AiOutlineLink } from 'react-icons/ai';
import toast from 'react-hot-toast';
import { text10, text12, textBold12, theme } from '@chisper/ui-kit';
import { PresetListItem } from '@chisper/preset-schema';
import { Key, screenItemStyle, screenLitStyle, screenScrollStyle } from '../../common/components';
import { reportPreset, sharePreset } from '../services';

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

// a row of a preset (a click loads it): its number in the list, as the programs of a synth are; the current one lit
// in blue, as a lit key of the synth; its keys show up while it is hovered
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
    .key.open {
      opacity: 1;
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

const Name = styled.span`
  ${textBold12};
  flex: 1 1 auto;
  min-width: 0;
  line-height: 22px;
  color: ${colors.white};
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;

  [aria-current='true'] > & {
    color: ${colors.secondAccent};
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

const Note = styled.div`
  ${text12};
  display: flex;
  justify-content: center;
  padding: 16px;
  color: ${colors.primaryDarkHighContrast};
`;

interface Props {
  items: PresetListItem[];
  currentId?: string;
  loading: boolean;
  hasMore?: boolean;
  onLoadMore?: () => void;
  onSelect: (item: PresetListItem) => void;
}

// the presets on the screen of the browser: their names, their listeners, a key to copy the link of one, another to
// report it
export const PresetList = ({ items, currentId, loading, hasMore, onLoadMore, onSelect }: Props) => {
  const root = React.useRef<HTMLDivElement>(null);
  const sentinel = React.useRef<HTMLDivElement>(null);
  // the preset whose report is being confirmed: its keys stay
  const [reporting, setReporting] = React.useState<string | null>(null);

  // infinite scroll: load the next page when the end of the list becomes visible
  React.useEffect(() => {
    if (!hasMore || loading || !sentinel.current) return;
    const observer = new IntersectionObserver(([entry]) => entry.isIntersecting && onLoadMore?.(), {
      root: root.current,
    });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [hasMore, loading, onLoadMore]);

  const share = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    sharePreset(id);
  };

  const report = (id: string) =>
    reportPreset(id)
      .then(() => toast.success('Thanks, the preset has been reported'))
      .catch((e) => toast.error(e.message));

  return (
    <List ref={root} data-testid='preset-list'>
      {items.map((item, index) => (
        <Row key={item.id} aria-current={item.id === currentId || undefined} onClick={() => onSelect(item)}>
          <Program aria-hidden>{String(index + 1).padStart(3, '0')}</Program>
          <Name>{item.name}</Name>
          <Popularity>
            {item.uniqueUsers > 0 && (
              <>
                <AiOutlineFire />
                {item.uniqueUsers}
              </>
            )}
          </Popularity>
          <Tooltip title='Copy link'>
            <Key className='key square' aria-label='Copy link' onClick={(e) => share(e, item.id)}>
              <AiOutlineLink />
            </Key>
          </Tooltip>
          <Popconfirm
            title='Report this preset?'
            okText='Report'
            open={reporting === item.id}
            onOpenChange={(open) => setReporting(open ? item.id : null)}
            onConfirm={(e) => {
              e?.stopPropagation();
              report(item.id);
            }}
            onCancel={(e) => e?.stopPropagation()}
          >
            <Key
              className={cls('key square', { open: reporting === item.id })}
              aria-label='Report preset'
              onClick={(e) => e.stopPropagation()}
            >
              <AiOutlineFlag />
            </Key>
          </Popconfirm>
        </Row>
      ))}
      {loading && (
        <Note>
          <LoadingOutlined aria-label='Loading' />
        </Note>
      )}
      {!loading && items.length === 0 && <Note>No presets</Note>}
      {hasMore && <div ref={sentinel} style={{ height: 1, flex: 'none' }} />}
    </List>
  );
};
