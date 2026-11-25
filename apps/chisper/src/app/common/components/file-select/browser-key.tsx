import React from 'react';
import { styled } from 'styled-components';
import cls from 'classnames';
import hexToRgba from 'hex-to-rgba';
import { ContentContainer, keepFocus, MiddleEllipsis, theme } from '@chisper/ui-kit';
import { SectionPopover } from '../section-popover';
import { browserWidth, FileBrowser } from './file-browser';
import { FileOption, FilePath, ListStatus, skipSingleFolders, startsWith } from './file-options';

const { colors } = theme;

// the key of the browser: the name cut in its middle (it never widens its place); lit while its browser is open. A
// press takes no focus (the keys of the keyboard still play)
const NameKey = styled.button.attrs({ type: 'button', onMouseDown: keepFocus })`
  ${ContentContainer}
  position: relative;
  min-width: 0;
  cursor: pointer;
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

  &:disabled {
    cursor: default;
    pointer-events: none;
  }
`;

interface Props {
  options: FileOption[];
  value: FilePath;
  setValue: (value: FilePath) => void;
  // the name shown of the value
  label: string;
  // the header of its browser (Wavetable, Noise)
  title: string;
  // the load of the list
  status: ListStatus;
  disabled?: boolean;
  className?: string;
}

// the name of a file of a list (a wavetable, a noise, the type of a filter) on a key: a click opens the browser of the
// list under it. Value and setValue are whole paths, the single folders included (the browser starts inside them)
export const BrowserKey = ({
  options,
  value,
  setValue,
  label,
  title,
  status,
  disabled,
  className,
}: Props) => {
  const [open, setOpen] = React.useState(false);
  // opened with the keyboard (a click without a pointer): the browser focuses its current file
  const [byKeyboard, setByKeyboard] = React.useState(false);
  const key = React.useRef<HTMLButtonElement>(null);
  const screen = React.useRef<HTMLDivElement>(null);
  const { prefix, options: shownOptions } = skipSingleFolders(options);
  // a value out of the skipped folders is passed as it is
  const shownValue = startsWith(value, prefix) ? value.slice(prefix.length) : value;
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
        className={cls(className, { open })}
        disabled={disabled}
        aria-haspopup='true'
        aria-expanded={open}
        // (before the click of the popover: it renders its content at once, flushed)
        onClickCapture={(e) => setByKeyboard(e.detail === 0)}
      >
        <MiddleEllipsis text={label} />
      </NameKey>
    </SectionPopover>
  );
};
