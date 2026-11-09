import React from 'react';
import { flushSync } from 'react-dom';
import { styled } from 'styled-components';
import cls from 'classnames';
import hexToRgba from 'hex-to-rgba';
import { LoadingOutlined } from '@ant-design/icons';
import { number } from '@chisper/math';
import { keepFocus, text10, text12, textBold12, theme } from '@chisper/ui-kit';
import { screenStyle } from '../section-bar';
import { screenItemStyle, screenLitStyle, screenScrollStyle } from '../dialog';
import {
  columnsOf,
  fileCount,
  FileOption,
  FilePath,
  folderDepth,
  isFolder,
  ListStatus,
  openFolders,
  startsWith,
} from './file-options';

const { colors } = theme;

const FOLDERS_WIDTH = 120;
const FILES_WIDTH = 240;

// the width of the browser: a column of folders for each level of them, the files in the rest (as wide for a list of
// files alone as for one level of folders)
export const browserWidth = (options: FileOption[]) =>
  FILES_WIDTH + FOLDERS_WIDTH * Math.max(1, folderDepth(options));

// as high whatever folder is open: the browser doesn't jump
const Screen = styled.div`
  ${screenStyle};
  display: flex;
  height: 248px;
  overflow: hidden;
`;

// a column of the screen, scrolled by itself (the offset parent of its rows); the files take the room the folders
// leave
const Column = styled.div`
  ${screenScrollStyle};
  position: relative;
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 3px;

  &.folders {
    flex: 0 0 ${FOLDERS_WIDTH}px;
  }

  & + & {
    border-left: 1px solid ${hexToRgba(colors.white, 0.08)};
  }
`;

// a folder or a file: the open folder and the current file lit in blue, as the preset playing is in the list of the
// presets; a press takes no focus (the keys of the keyboard still play, the notes sound the file chosen)
const Row = styled.button.attrs({ type: 'button', onMouseDown: keepFocus })`
  ${screenItemStyle};
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding-block: 0;
  border: none;
  background: transparent;
  text-align: left;
  cursor: pointer;

  &[aria-expanded='true'],
  &[aria-expanded='true']:hover,
  &[aria-current='true'],
  &[aria-current='true']:hover {
    ${screenLitStyle};
  }

  &:focus-visible {
    outline: 1px solid ${colors.secondAccent};
    outline-offset: -1px;
  }
`;

// blue where it is (or holds) the current file
const Name = styled.span`
  ${textBold12};
  flex: 1 1 auto;
  min-width: 0;
  line-height: 22px;
  color: ${colors.white};
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;

  .current > & {
    color: ${colors.secondAccent};
  }
`;

// the files of a folder, the size of a file: the numbers of the rows one under the other
const Note = styled.span`
  ${text10};
  flex: none;
  font-variant-numeric: tabular-nums;
  color: ${colors.primaryDarkHighContrast};
`;

const Empty = styled.div`
  ${text12};
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  color: ${colors.primaryDarkHighContrast};
`;

// the rows of a column (its buttons)
const rowsOf = (column: Element | null | undefined): HTMLButtonElement[] =>
  Array.from(column?.children ?? []).filter(
    (row): row is HTMLButtonElement => row instanceof HTMLButtonElement
  );

// the lit row of a column (the open folder, the current file) in its middle where it is out of sight (scrolled by
// hand: scrollIntoView would scroll the page too)
const showLit = (column: HTMLElement) => {
  const lit = column.querySelector<HTMLElement>('[aria-expanded="true"], [aria-current="true"]');
  if (!lit) return;
  const { offsetTop: top, offsetHeight: height } = lit;
  if (top >= column.scrollTop && top + height <= column.scrollTop + column.clientHeight) return;
  column.scrollTop = top - (column.clientHeight - height) / 2;
};

interface Props {
  // the options as shown (the folders alone on their levels skipped) and the value among them
  options: FileOption[];
  value: FilePath;
  status: ListStatus;
  // a file chosen: its path among the options shown
  onChoose: (path: string[]) => void;
  // the current file takes the focus once shown (the browser was opened with the keyboard)
  autoFocus?: boolean;
  // the screen (the select looks whether the focus is in it)
  screenRef: React.RefObject<HTMLDivElement | null>;
}

// the files of a list in columns, as the browser of a synth: the folders on the left, the files of the folder open on
// the right; it opens on the folder of the current file. The arrows go through the rows (↑ ↓) and the columns (→ ←)
export const FileBrowser = ({ options, value, status, onChoose, autoFocus, screenRef }: Props) => {
  // the folders opened by the user; until then those of the value (the list may load meanwhile)
  const [chosen, setChosen] = React.useState<string[] | null>(null);
  const opened = chosen ?? openFolders(options, value);
  const columns = columnsOf(options, opened);
  const focused = React.useRef(false);

  const open = (level: number, folder: string) =>
    setChosen(openFolders(options, [...opened.slice(0, level), folder]));

  // the open folder and the current file in sight; the current file focused once, when opened by the keyboard
  // (again when the list loads: its columns are laid out then)
  React.useLayoutEffect(() => {
    const element = screenRef.current;
    if (!element) return;
    const columnElements = Array.from(element.children) as HTMLElement[];
    columnElements.forEach(showLit);
    if (!autoFocus || focused.current) return;
    const last = columnElements[columnElements.length - 1];
    const row = element.querySelector<HTMLElement>('[aria-current="true"]') ?? rowsOf(last)[0];
    if (!row) return;
    row.focus({ preventScroll: true });
    focused.current = true;
  }, [options, autoFocus, screenRef]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const row = e.target instanceof HTMLButtonElement ? e.target : null;
    const column = row?.parentElement;
    if (!row || !column || !e.key.startsWith('Arrow')) return;
    // the arrows are the browser's (the octave of the keys stays)
    e.preventDefault();
    const level = Number(column.dataset['level']);
    const rows = rowsOf(column);
    const index = rows.indexOf(row);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      rows[number.thresholds(index + (e.key === 'ArrowDown' ? 1 : -1), 0, rows.length - 1)].focus();
    } else if (e.key === 'ArrowRight') {
      // a folder opened: its first row focused (its column, the next one, rendered at once)
      const option = columns[level]?.[index];
      if (!option || !isFolder(option)) return;
      flushSync(() => open(level, option.value));
      rowsOf(column.nextElementSibling)[0]?.focus();
    } else if (e.key === 'ArrowLeft') {
      rowsOf(column.previousElementSibling)
        .find((other) => other.getAttribute('aria-expanded') === 'true')
        ?.focus();
    }
  };

  return (
    <Screen ref={screenRef} onKeyDown={onKeyDown}>
      {options.length === 0 ? (
        <Empty>
          {status === 'pending' && <LoadingOutlined aria-label='Loading' />}
          {status === 'error' && "Couldn't load the list"}
          {status === 'success' && 'No files'}
        </Empty>
      ) : (
        columns.map((column, level) => (
          // a column of another folder is another: it starts at its top
          <Column
            key={opened.slice(0, level).join('/')}
            data-level={level}
            className={cls({ folders: level < columns.length - 1 })}
          >
            {column.map((option) => {
              const onPath = value[level] === option.value && startsWith(value, opened.slice(0, level));
              const current = onPath && level === value.length - 1;
              return isFolder(option) ? (
                <Row
                  key={option.value}
                  aria-expanded={opened[level] === option.value}
                  className={cls({ current: onPath && level < value.length - 1 })}
                  onClick={() => open(level, option.value)}
                >
                  <Name>{option.label}</Name>
                  <Note>{fileCount(option)}</Note>
                </Row>
              ) : (
                <Row
                  key={option.value}
                  aria-current={current || undefined}
                  className={cls({ current })}
                  onClick={() => onChoose([...opened.slice(0, level), option.value])}
                >
                  <Name>{option.label}</Name>
                  {option.note && <Note>{option.note}</Note>}
                </Row>
              );
            })}
          </Column>
        ))
      )}
    </Screen>
  );
};
