import React from 'react';
import { styled } from 'styled-components';
import cls from 'classnames';
import hexToRgba from 'hex-to-rgba';
import { isEqual } from 'lodash';
import {
  ContentContainer,
  keepFocus,
  LoadProgress,
  MiddleEllipsis,
  SelectDumb,
  theme,
} from '@chisper/ui-kit';
import { SectionPopover } from '../section-popover';
import { browserWidth, FileBrowser } from './file-browser';
import { FileOption, FilePath, leafPaths, ListStatus, skipSingleFolders, startsWith } from './file-options';

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

// the key of the browser: the name cut in its middle (it never widens the row), over the progress of its load; lit
// while its browser is open. A press takes no focus (the keys of the keyboard still play)
const NameKey = styled.button.attrs({ type: 'button', onMouseDown: keepFocus })`
  ${ContentContainer}
  position: relative;
  min-width: 0;
  /* the row as high as the other selects */
  line-height: normal;
  text-align: left;
  cursor: pointer;
  border-radius: 0 3px 3px 0;
  transition: background 120ms;

  &:hover {
    background: ${hexToRgba(colors.primaryDarkMediumContrast, 0.4)};
  }

  &.open {
    background: ${hexToRgba(colors.primaryDarkMediumContrast, 0.6)};
  }

  &:focus-visible {
    outline: 1px solid ${colors.secondAccent};
    outline-offset: -1px;
  }
`;

// the share of the bar a load creeps in to at once: on a slow line it moves before its first bytes
const LOAD_START = 0.25;

// the progress of the load of the file chosen (0..1, null: none loading), drawn on the background of the name
export const SelectProgress = ({ progress }: { progress: number | null }) => (
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
// click on the name opens the browser of the list under it. Value and setValue are whole paths, the single folders
// included
export const FileSelect = ({ options, value, setValue, progress, label, title, status }: Props) => {
  const [open, setOpen] = React.useState(false);
  // opened with the keyboard (a click without a pointer): the browser focuses its current file
  const [byKeyboard, setByKeyboard] = React.useState(false);
  const key = React.useRef<HTMLButtonElement>(null);
  const screen = React.useRef<HTMLDivElement>(null);
  const leaves = React.useMemo(() => leafPaths(options), [options]);
  const { prefix, options: shownOptions } = skipSingleFolders(options);
  // a value out of the skipped folders is passed as it is
  const shownValue = startsWith(value, prefix) ? value.slice(prefix.length) : value;
  // the arrows go through all the files across folders and wrap around; from an unknown value (-1) next is
  // the first, previous the last. A value without the skipped folders is shown as chosen, so it is found too
  const step = (delta: number) => () => {
    if (leaves.length === 0) return;
    const full = [...prefix, ...value];
    const current = leaves.findIndex((leaf) => isEqual(leaf, value) || isEqual(leaf, full));
    const index = current === -1 && delta < 0 ? -1 : current + delta;
    setValue(leaves[(index + leaves.length) % leaves.length]);
  };
  const onOpenChange = (next: boolean) => {
    // the focus in the browser goes back to its key (the browser is gone)
    if (!next && screen.current?.contains(document.activeElement)) key.current?.focus();
    setOpen(next);
  };
  const choose = (path: string[]) => {
    setValue([...prefix, ...path]);
    onOpenChange(false);
  };

  return (
    <Strip prev={step(-1)} next={step(1)}>
      <Name>
        {progress}
        <SectionPopover
          title={title}
          width={browserWidth(shownOptions)}
          placement='bottomLeft'
          open={open}
          onOpenChange={onOpenChange}
          content={
            <FileBrowser
              options={shownOptions}
              value={shownValue}
              status={status}
              onChoose={choose}
              autoFocus={byKeyboard}
              screenRef={screen}
            />
          }
        >
          <NameKey
            ref={key}
            className={cls({ open })}
            aria-haspopup='true'
            aria-expanded={open}
            // (before the click of the popover: it renders its content at once, flushed)
            onClickCapture={(e) => setByKeyboard(e.detail === 0)}
          >
            <MiddleEllipsis text={label} />
          </NameKey>
        </SectionPopover>
      </Name>
    </Strip>
  );
};
