import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { fileRow } from '../../../../test-utils/file-rows';
import { FileOption, FilePath, ListStatus } from './file-options';
import { FileSelect, SelectProgress } from './file-select';

const options: FileOption[] = [
  {
    value: 'A',
    label: 'A',
    children: [
      { value: 'A/1.wav', label: 'A1' },
      { value: 'A/2.wav', label: 'A2' },
    ],
  },
  {
    value: 'B',
    label: 'B',
    children: [
      { value: 'B/1.wav', label: 'B1' },
      { value: 'B/2.wav', label: 'B2' },
    ],
  },
];
const pack: FileOption[] = [{ value: 'Pack', label: 'Pack', children: options }];

const setup = (value: FilePath, opts = options, status: ListStatus = 'success') => {
  const setValue = jest.fn();
  const user = userEvent.setup();
  render(
    <FileSelect
      options={opts}
      value={value}
      setValue={setValue}
      label='Current'
      title='Wavetable'
      status={status}
    />
  );
  return { setValue, user };
};

const next = () => screen.getByRole('button', { name: 'Next' });
const previous = () => screen.getByRole('button', { name: 'Previous' });
const nameKey = () => screen.getByRole('button', { name: 'Current' });
// a click of the keyboard (Enter, Space on the focused key): no pointer, its detail 0 (user-event gives 1)
const pressByKeyboard = async () => {
  nameKey().focus();
  fireEvent.click(nameKey(), { detail: 0 });
  await screen.findByText('Wavetable');
};
// the browser open (a pointer's click: the focus stays)
const browse = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(nameKey());
  await screen.findByText('Wavetable');
};

describe('FileSelect', () => {
  it('shows its label on the key of its browser', () => {
    setup(['A', 'A/1.wav']);
    expect(nameKey()).toHaveTextContent('Current');
    expect(nameKey()).toHaveAttribute('aria-expanded', 'false');
  });

  it('draws the progress of a load on the background of the name, nothing while none loads', () => {
    const props = {
      options,
      value: ['A', 'A/1.wav'],
      setValue: jest.fn(),
      label: 'Current',
      title: 'Wavetable',
      status: 'success' as const,
    };
    const { rerender } = render(<FileSelect {...props} progress={<SelectProgress progress={0.4} />} />);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('40');
    rerender(<FileSelect {...props} progress={<SelectProgress progress={null} />} />);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(nameKey()).toBeInTheDocument();
  });

  // the arrows go through the files across folders and wrap around
  it.each([
    { from: ['A', 'A/2.wav'], button: previous, to: ['A', 'A/1.wav'], name: 'previous: the file before' },
    { from: ['A', 'A/2.wav'], button: next, to: ['B', 'B/1.wav'], name: 'next: into the next folder' },
    {
      from: ['B', 'B/1.wav'],
      button: previous,
      to: ['A', 'A/2.wav'],
      name: 'previous: into the folder before',
    },
    {
      from: ['B', 'B/2.wav'],
      button: next,
      to: ['A', 'A/1.wav'],
      name: 'next from the last file: the first',
    },
    {
      from: ['A', 'A/1.wav'],
      button: previous,
      to: ['B', 'B/2.wav'],
      name: 'previous from the first: the last',
    },
    {
      from: ['C', 'C/1.wav'],
      button: next,
      to: ['A', 'A/1.wav'],
      name: 'next from an unknown value: the first',
    },
    {
      from: ['C', 'C/1.wav'],
      button: previous,
      to: ['B', 'B/2.wav'],
      name: 'previous from an unknown: the last',
    },
  ])('$name', async ({ from, button, to }) => {
    const { user, setValue } = setup(from);
    await user.click(button());
    expect(setValue).toHaveBeenCalledWith(to);
  });

  it('steps through files of the top level and of folders', async () => {
    const mixed: FileOption[] = [{ value: 'top.wav', label: 'top' }, ...options];
    const { user, setValue } = setup(['top.wav'], mixed);
    await user.click(next());
    expect(setValue).toHaveBeenLastCalledWith(['A', 'A/1.wav']);
    await user.click(previous());
    expect(setValue).toHaveBeenLastCalledWith(['B', 'B/2.wav']);
  });

  it('does nothing without options', async () => {
    const { user, setValue } = setup([], []);
    await user.click(next());
    await user.click(previous());
    expect(setValue).not.toHaveBeenCalled();
  });

  describe('its browser', () => {
    it('opens under the name as a section: its title, as wide as its columns, from the left of the name', async () => {
      const { user } = setup(['B', 'B/1.wav']);
      await browse(user);
      expect(nameKey()).toHaveAttribute('aria-expanded', 'true');
      expect(nameKey()).toHaveClass('open');
      const content = screen.getByText('Wavetable').parentElement?.parentElement as HTMLElement;
      expect(content.style.width).toBe('360px');
      expect(content.closest('.ant-popover')).toHaveClass('ant-popover-placement-bottomLeft');
      expect(fileRow('B1')).toHaveAttribute('aria-current', 'true');
    });

    it('sets a file chosen and closes', async () => {
      const { user, setValue } = setup(['B', 'B/1.wav']);
      await browse(user);
      await user.click(fileRow('A'));
      await user.click(fileRow('A2'));
      expect(setValue).toHaveBeenCalledWith(['A', 'A/2.wav']);
      await waitFor(() => expect(screen.queryByText('Wavetable')).not.toBeInTheDocument());
      expect(nameKey()).toHaveAttribute('aria-expanded', 'false');
    });

    it('shows the load of its list', async () => {
      const { user } = setup(['A', 'A/1.wav'], [], 'pending');
      await browse(user);
      expect(screen.getByLabelText('Loading')).toBeInTheDocument();
    });

    it('takes no focus when opened by a pointer, nor on a press of the name', async () => {
      const { user } = setup(['B', 'B/1.wav']);
      expect(fireEvent.mouseDown(nameKey())).toBe(false);
      await browse(user);
      expect(document.body).toHaveFocus();
    });

    it('focuses the current file when opened by the keyboard, the name again once a file is chosen', async () => {
      const { user, setValue } = setup(['B', 'B/1.wav']);
      await pressByKeyboard();
      await waitFor(() => expect(fileRow('B1')).toHaveFocus());
      await user.keyboard('{ArrowDown}{Enter}');
      expect(setValue).toHaveBeenCalledWith(['B', 'B/2.wav']);
      expect(nameKey()).toHaveFocus();
    });

    it('gives the focus back to the name when closed by Escape', async () => {
      const { user } = setup(['B', 'B/1.wav']);
      await pressByKeyboard();
      await waitFor(() => expect(fileRow('B1')).toHaveFocus());
      await act(() => user.keyboard('{Escape}'));
      expect(nameKey()).toHaveAttribute('aria-expanded', 'false');
      expect(nameKey()).toHaveFocus();
    });
  });

  describe('a single folder', () => {
    it('is not a column: the browser starts inside it', async () => {
      const { user } = setup(['Pack', 'B', 'B/1.wav'], pack);
      await browse(user);
      expect(screen.queryByText('Pack')).toBeNull();
      expect(fileRow('B')).toHaveAttribute('aria-expanded', 'true');
      expect(fileRow('B1')).toHaveAttribute('aria-current', 'true');
    });

    it('is put back into a path chosen in the browser', async () => {
      const { user, setValue } = setup(['Pack', 'B', 'B/1.wav'], pack);
      await browse(user);
      await user.click(fileRow('A'));
      await user.click(fileRow('A2'));
      expect(setValue).toHaveBeenCalledWith(['Pack', 'A', 'A/2.wav']);
    });

    it.each([
      { from: ['Pack', 'A', 'A/2.wav'], button: next, to: ['Pack', 'B', 'B/1.wav'] },
      { from: ['Pack', 'A', 'A/1.wav'], button: previous, to: ['Pack', 'B', 'B/2.wav'] },
      { from: ['Pack', 'B', 'B/2.wav'], button: next, to: ['Pack', 'A', 'A/1.wav'] },
    ])('stays in the paths of the arrows: $from to $to', async ({ from, button, to }) => {
      const { user, setValue } = setup(from, pack);
      await user.click(button());
      expect(setValue).toHaveBeenCalledWith(to);
    });

    // e.g. from a preset: the browser shows it as chosen, the arrows go to its neighbours
    it('a value without it is shown and stepped from', async () => {
      const { user, setValue } = setup(['A', 'A/2.wav'], pack);
      await browse(user);
      expect(fileRow('A2')).toHaveAttribute('aria-current', 'true');
      await user.click(next());
      expect(setValue).toHaveBeenLastCalledWith(['Pack', 'B', 'B/1.wav']);
      await user.click(previous());
      expect(setValue).toHaveBeenLastCalledWith(['Pack', 'A', 'A/1.wav']);
    });

    it('a value outside it is shown as none of its files', async () => {
      const { user } = setup(['Old', 'Old/1.wav'], pack);
      await browse(user);
      expect(fileRow('A')).toHaveAttribute('aria-expanded', 'true');
      expect(screen.queryByRole('button', { current: true })).toBeNull();
    });
  });
});
