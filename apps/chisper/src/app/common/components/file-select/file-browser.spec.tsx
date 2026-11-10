import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { fileRow } from '../../../../test-utils/file-rows';
import { browserWidth, FileBrowser } from './file-browser';
import { FileOption, FilePath, ListStatus } from './file-options';

const analog: FileOption[] = [
  { value: 'Analog/Saw.wav', label: 'Saw', note: '2 kB' },
  { value: 'Analog/Square.wav', label: 'Square', note: '3 kB' },
  { value: 'Analog/Pulse.wav', label: 'Pulse' },
];
const options: FileOption[] = [
  { value: 'Analog', label: 'Analog', children: analog },
  { value: 'Basics', label: 'Basics', children: [{ value: 'Basics/Sine.wav', label: 'Sine' }] },
];
const packs: FileOption[] = [
  { value: 'ESW', label: 'ESW', children: options },
  {
    value: 'Other',
    label: 'Other',
    children: [
      { value: 'Keys', label: 'Keys', children: [{ value: 'Other/Keys/Rhodes.wav', label: 'Rhodes' }] },
    ],
  },
];

const setup = (
  value: FilePath = ['Analog', 'Analog/Square.wav'],
  {
    opts = options,
    status = 'success',
    autoFocus = false,
  }: { opts?: FileOption[]; status?: ListStatus; autoFocus?: boolean } = {}
) => {
  const onChoose = jest.fn();
  const view = render(
    <FileBrowser
      options={opts}
      value={value}
      status={status}
      onChoose={onChoose}
      autoFocus={autoFocus}
      screenRef={React.createRef()}
    />
  );
  return { ...view, onChoose };
};

// the columns of the screen
const columns = (container: HTMLElement) =>
  Array.from(container.firstElementChild?.children ?? []) as HTMLElement[];
const names = (column: HTMLElement) =>
  within(column)
    .getAllByRole('button')
    .map((key) => key.textContent);

describe('FileBrowser', () => {
  it('opens on the folder of the current file: the folders with their counts, the files with their notes', () => {
    const { container } = setup();
    const [folders, files] = columns(container);
    expect(columns(container)).toHaveLength(2);
    expect(names(folders)).toEqual(['Analog3', 'Basics1']);
    expect(names(files)).toEqual(['Saw2 kB', 'Square3 kB', 'Pulse']);
    expect(folders).toHaveClass('folders');
    expect(files).not.toHaveClass('folders');
  });

  it('lights the open folder and the current file, and marks the folder of the current file', () => {
    setup();
    expect(fileRow('Analog')).toHaveAttribute('aria-expanded', 'true');
    expect(fileRow('Basics')).toHaveAttribute('aria-expanded', 'false');
    expect(fileRow('Square')).toHaveAttribute('aria-current', 'true');
    expect(fileRow('Saw')).not.toHaveAttribute('aria-current');
    expect(fileRow('Analog')).toHaveClass('current');
    expect(fileRow('Square')).toHaveClass('current');
    expect(fileRow('Saw')).not.toHaveClass('current');
  });

  it('shows the files of another folder, the folder of the current file still marked', async () => {
    const { container } = setup();
    const files = columns(container)[1];
    await userEvent.click(fileRow('Basics'));
    expect(names(columns(container)[1])).toEqual(['Sine']);
    // (another column: it starts at its top)
    expect(columns(container)[1]).not.toBe(files);
    expect(fileRow('Basics')).toHaveAttribute('aria-expanded', 'true');
    expect(fileRow('Analog')).toHaveAttribute('aria-expanded', 'false');
    expect(fileRow('Analog')).toHaveClass('current');
    expect(fileRow('Basics')).not.toHaveClass('current');
    expect(fileRow('Sine')).not.toHaveAttribute('aria-current');
  });

  it('chooses a file by its path among the options', async () => {
    const { onChoose } = setup();
    await userEvent.click(fileRow('Basics'));
    await userEvent.click(fileRow('Sine'));
    expect(onChoose).toHaveBeenCalledWith(['Basics', 'Basics/Sine.wav']);
  });

  it('opens the first folder for a value the list has not, nothing lit', () => {
    setup(['Gone', 'Gone/Old.wav']);
    expect(fileRow('Analog')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByRole('button', { current: true })).toBeNull();
    expect(document.querySelector('.current')).toBeNull();
  });

  it('has a column of packs where there are several: a pack opens its first category', async () => {
    const { container, onChoose } = setup(['ESW', 'Basics', 'Basics/Sine.wav'], { opts: packs });
    expect(columns(container).map(names)).toEqual([['ESW4', 'Other1'], ['Analog3', 'Basics1'], ['Sine']]);
    expect(columns(container).map((column) => column.classList.contains('folders'))).toEqual([
      true,
      true,
      false,
    ]);
    expect(fileRow('ESW')).toHaveClass('current');
    expect(fileRow('Basics')).toHaveClass('current');

    await userEvent.click(fileRow('Other'));
    expect(columns(container).map(names)).toEqual([['ESW4', 'Other1'], ['Keys1'], ['Rhodes']]);
    await userEvent.click(fileRow('Rhodes'));
    expect(onChoose).toHaveBeenCalledWith(['Other', 'Keys', 'Other/Keys/Rhodes.wav']);
  });

  it('lists files without folders in one column', () => {
    const { container } = setup(['Analog/Saw.wav'], { opts: analog });
    expect(columns(container).map(names)).toEqual([['Saw2 kB', 'Square3 kB', 'Pulse']]);
    expect(fileRow('Saw')).toHaveAttribute('aria-current', 'true');
  });

  it.each([
    ['pending', () => screen.getByLabelText('Loading')],
    ['error', () => screen.getByText("Couldn't load the list")],
    ['success', () => screen.getByText('No files')],
  ] as const)('shows the load of an empty list (%s)', (status, note) => {
    setup(['Analog', 'Analog/Saw.wav'], { opts: [], status });
    expect(note()).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('takes no focus on a press of a row: the keys of the keyboard still play', () => {
    setup();
    expect(fireEvent.mouseDown(fileRow('Saw'))).toBe(false);
    expect(fireEvent.mouseDown(fileRow('Basics'))).toBe(false);
  });

  describe('the keyboard', () => {
    it('focuses the current file once shown when opened by it, nothing else', () => {
      const { unmount } = setup(undefined, { autoFocus: true });
      expect(fileRow('Square')).toHaveFocus();
      unmount();
      setup();
      expect(document.body).toHaveFocus();
    });

    it('focuses the first file of the folder open when the value is not in the list', () => {
      setup(['Gone', 'Gone/Old.wav'], { autoFocus: true });
      expect(fileRow('Saw')).toHaveFocus();
    });

    it('focuses the current file once the list loads', () => {
      const props = {
        value: ['Analog', 'Analog/Pulse.wav'],
        onChoose: jest.fn(),
        autoFocus: true,
        screenRef: React.createRef<HTMLDivElement>(),
      };
      const { rerender } = render(<FileBrowser {...props} options={[]} status='pending' />);
      expect(document.body).toHaveFocus();
      rerender(<FileBrowser {...props} options={options} status='success' />);
      expect(fileRow('Pulse')).toHaveFocus();
    });

    it('goes through the rows of a column by ↑ ↓, not past its ends; the arrows are its own', () => {
      setup(undefined, { autoFocus: true });
      expect(fireEvent.keyDown(fileRow('Square'), { key: 'ArrowDown' })).toBe(false);
      expect(fileRow('Pulse')).toHaveFocus();
      fireEvent.keyDown(fileRow('Pulse'), { key: 'ArrowDown' });
      expect(fileRow('Pulse')).toHaveFocus();
      expect(fireEvent.keyDown(fileRow('Pulse'), { key: 'ArrowUp' })).toBe(false);
      fireEvent.keyDown(fileRow('Square'), { key: 'ArrowUp' });
      fireEvent.keyDown(fileRow('Saw'), { key: 'ArrowUp' });
      expect(fileRow('Saw')).toHaveFocus();
    });

    it('goes to the folder open by ←, opens a folder and goes into it by →', () => {
      setup(undefined, { autoFocus: true });
      expect(fireEvent.keyDown(fileRow('Square'), { key: 'ArrowLeft' })).toBe(false);
      expect(fileRow('Analog')).toHaveFocus();
      fireEvent.keyDown(fileRow('Analog'), { key: 'ArrowDown' });
      expect(fireEvent.keyDown(fileRow('Basics'), { key: 'ArrowRight' })).toBe(false);
      expect(fileRow('Basics')).toHaveAttribute('aria-expanded', 'true');
      expect(fileRow('Sine')).toHaveFocus();
      // → on a file, ← in the first column: nothing
      fireEvent.keyDown(fileRow('Sine'), { key: 'ArrowRight' });
      expect(fileRow('Sine')).toHaveFocus();
      fireEvent.keyDown(fileRow('Sine'), { key: 'ArrowLeft' });
      fireEvent.keyDown(fileRow('Basics'), { key: 'ArrowLeft' });
      expect(fileRow('Basics')).toHaveFocus();
    });

    it('→ on the folder open goes into it', () => {
      setup(undefined, { autoFocus: true });
      fireEvent.keyDown(fileRow('Square'), { key: 'ArrowLeft' });
      fireEvent.keyDown(fileRow('Analog'), { key: 'ArrowRight' });
      expect(fileRow('Saw')).toHaveFocus();
    });

    it('chooses the file focused by Enter, leaves the other keys to the page', async () => {
      const { onChoose } = setup(undefined, { autoFocus: true });
      expect(fireEvent.keyDown(fileRow('Square'), { key: 'a', code: 'KeyA' })).toBe(true);
      await userEvent.keyboard('{ArrowDown}{Enter}');
      expect(onChoose).toHaveBeenCalledWith(['Analog', 'Analog/Pulse.wav']);
    });
  });

  describe('the scroll', () => {
    const ROW = 20;
    const COLUMN = 60;
    // the rows one under the other in a column 3 rows high
    beforeEach(() => {
      jest.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) {
        return Array.from(this.parentElement?.children ?? []).indexOf(this) * ROW;
      });
      jest.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(ROW);
      jest.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(COLUMN);
    });
    afterEach(() => jest.restoreAllMocks());

    const many: FileOption[] = [
      {
        value: 'Many',
        label: 'Many',
        children: Array.from({ length: 10 }, (_, i) => ({ value: `Many/${i}.wav`, label: `File ${i}` })),
      },
    ];

    it('brings the current file out of sight to the middle of its column', () => {
      const { container } = setup(['Many', 'Many/7.wav'], { opts: [...many, ...options] });
      const [folders, files] = columns(container);
      expect(files.scrollTop).toBe(7 * ROW - (COLUMN - ROW) / 2);
      expect(folders.scrollTop).toBe(0);
    });

    it('leaves a column whose lit row is in sight', () => {
      const { container } = setup(['Many', 'Many/2.wav'], { opts: many });
      expect(columns(container)[1].scrollTop).toBe(0);
    });
  });
});

describe('browserWidth', () => {
  it('gives a column of folders to each level of them, the rest to the files', () => {
    expect(browserWidth(options)).toBe(360);
    expect(browserWidth(packs)).toBe(480);
    expect(browserWidth(analog)).toBe(360);
    expect(browserWidth([])).toBe(360);
  });
});
