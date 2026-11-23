import React from 'react';
import cls from 'classnames';
import { Popconfirm, Tooltip } from 'antd';
import { AiFillStar, AiOutlineEdit, AiOutlineFlag, AiOutlineLink, AiOutlineStar } from 'react-icons/ai';
import toast from 'react-hot-toast';
import { Key } from '../../common/components';
import { usePresets } from '../modules/presets';
import { reportPreset, sharePreset } from '../services';

// the dialog of the presets on a phone: the tabs their icons alone, a row its number, its Play and its name (the keys
// of the selected preset in the strip under the list)
export const NARROW = '@media (max-width: 560px)';

// a key of a row acts alone: the row isn't clicked
export const only = (action: () => void) => (e: React.MouseEvent) => {
  e.stopPropagation();
  action();
};

interface Props {
  id: string;
  favorite: boolean;
  // Edit info (none: not a preset saved from this browser)
  onEditInfo?: () => void;
}

// the keys of a preset: a star, Edit info of an own one, its link copied, a report (confirmed). Each acts alone: a row
// they are on isn't clicked. Classed `key` (a row shows them while hovered), `on` a star that is on, `open` the report
// being confirmed
export const PresetKeys = ({ id, favorite, onEditInfo }: Props) => {
  const [, { toggleFavorite }] = usePresets();
  const [reporting, setReporting] = React.useState(false);
  const report = () =>
    reportPreset(id)
      .then(() => toast.success('Thanks, the preset has been reported'))
      .catch((e) => toast.error(e.message));

  return (
    <>
      <Tooltip title={favorite ? 'Remove from Favorites' : 'Add to Favorites'}>
        <Key
          className={cls('key square', { on: favorite })}
          aria-label={favorite ? 'Remove from Favorites' : 'Add to Favorites'}
          aria-pressed={favorite}
          onClick={only(() => toggleFavorite(id))}
        >
          {favorite ? <AiFillStar /> : <AiOutlineStar />}
        </Key>
      </Tooltip>
      {onEditInfo && (
        <Tooltip title='Edit info: its category, tags and description'>
          <Key className='key square' aria-label='Edit info' onClick={only(onEditInfo)}>
            <AiOutlineEdit />
          </Key>
        </Tooltip>
      )}
      <Tooltip title='Copy link'>
        <Key className='key square' aria-label='Copy link' onClick={only(() => sharePreset(id))}>
          <AiOutlineLink />
        </Key>
      </Tooltip>
      <Popconfirm
        title='Report this preset?'
        okText='Report'
        open={reporting}
        onOpenChange={setReporting}
        onConfirm={(e) => {
          e?.stopPropagation();
          report();
        }}
        onCancel={(e) => e?.stopPropagation()}
      >
        <Key
          className={cls('key square', { open: reporting })}
          aria-label='Report preset'
          onClick={(e) => e.stopPropagation()}
        >
          <AiOutlineFlag />
        </Key>
      </Popconfirm>
    </>
  );
};
