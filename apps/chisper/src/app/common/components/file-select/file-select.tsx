import React from 'react';
import { styled } from 'styled-components';
import { isEqual } from 'lodash';
import { LoadProgress, LoadShare, SelectDumb, theme } from '@chisper/ui-kit';
import { BrowserKey } from './browser-key';
import { FileOption, FilePath, leafPaths, ListStatus, skipSingleFolders } from './file-options';

const { colors } = theme;

const Strip = styled(SelectDumb)`
  min-width: 0;
`;

// the name takes the room the arrows leave, never more: a long name is cut, the row stays as wide as its place.
// The progress of a load is drawn on its background
const Name = styled.div`
  position: relative;
  flex: 1 1 0;
  min-width: 0;
  align-self: stretch;
  display: flex;
`;

// the key of the browser at the right end of the row, its name from the left
const Key = styled(BrowserKey)`
  /* the row as high as the other selects */
  line-height: normal;
  text-align: left;
  border-radius: 0 3px 3px 0;
`;

// the share of the bar a load creeps in to at once: on a slow line it moves before its first bytes
const LOAD_START = 0.25;

// the progress of the load of the file chosen (0..1, null: none loading, failed), drawn on the background of the name
export const SelectProgress = ({ progress }: { progress: LoadShare }) => (
  <LoadProgress progress={progress} look='gradient' color={colors.accent} start={LOAD_START} />
);

interface Props {
  options: FileOption[];
  value: FilePath;
  setValue: (value: FilePath) => void;
  // a SelectProgress of the file chosen (a component of its own reads it: it changes with every chunk downloaded,
  // the select renders not)
  progress?: React.ReactNode;
  // the name shown of the value
  label: string;
  // the header of its browser (Wavetable, Noise)
  title: string;
  // the load of the list
  status: ListStatus;
}

// a file of a list (a wavetable, a noise): its name between ◀ ▶, which go through all the files across folders; a
// click on the name opens the browser of the list under it (BrowserKey). Value and setValue are whole paths, the
// single folders included
export const FileSelect = ({ options, value, setValue, progress, label, title, status }: Props) => {
  const leaves = React.useMemo(() => leafPaths(options), [options]);
  const { prefix } = skipSingleFolders(options);
  // the arrows go through all the files across folders and wrap around; from an unknown value (-1) next is
  // the first, previous the last. A value without the skipped folders is shown as chosen, so it is found too
  const step = (delta: number) => () => {
    if (leaves.length === 0) return;
    const full = [...prefix, ...value];
    const current = leaves.findIndex((leaf) => isEqual(leaf, value) || isEqual(leaf, full));
    const index = current === -1 && delta < 0 ? -1 : current + delta;
    setValue(leaves[(index + leaves.length) % leaves.length]);
  };

  return (
    <Strip prev={step(-1)} next={step(1)}>
      <Name>
        {progress}
        <Key
          options={options}
          value={value}
          setValue={setValue}
          label={label}
          title={title}
          status={status}
        />
      </Name>
    </Strip>
  );
};
