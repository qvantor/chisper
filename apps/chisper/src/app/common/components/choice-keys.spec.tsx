import { fireEvent, render, screen } from '@testing-library/react';
import { ChoiceKeys } from './choice-keys';

const OPTIONS = [
  { value: 'all', label: 'All', name: 'All channels' },
  { value: '0', label: '1', name: 'Channel 1' },
  { value: '1', label: '2' },
];

describe('ChoiceKeys', () => {
  it('is a group of radios named by their names, or by their labels', () => {
    render(<ChoiceKeys aria-label='Channel' options={OPTIONS} value='all' onChange={jest.fn()} />);
    const group = screen.getByRole('radiogroup', { name: 'Channel' });
    expect(Array.from(group.children, (key) => key.getAttribute('role'))).toEqual([
      'radio',
      'radio',
      'radio',
    ]);
    expect(screen.getByRole('radio', { name: 'All channels' })).toHaveTextContent('All');
    expect(screen.getByRole('radio', { name: 'Channel 1' })).toHaveTextContent('1');
    expect(screen.getByRole('radio', { name: '2' })).toBeInTheDocument();
  });

  it('checks the key of the value', () => {
    const { rerender } = render(
      <ChoiceKeys aria-label='Channel' options={OPTIONS} value='all' onChange={jest.fn()} />
    );
    const checked = () =>
      screen.getAllByRole('radio').map((key) => key.getAttribute('aria-checked') === 'true');
    expect(checked()).toEqual([true, false, false]);

    rerender(<ChoiceKeys aria-label='Channel' options={OPTIONS} value='1' onChange={jest.fn()} />);
    expect(checked()).toEqual([false, false, true]);
  });

  it('chooses another value, not the one chosen (a choice may reload the page)', () => {
    const onChange = jest.fn();
    render(<ChoiceKeys aria-label='Channel' options={OPTIONS} value='all' onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'All channels' }));
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('radio', { name: 'Channel 1' }));
    expect(onChange).toHaveBeenCalledWith('0');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('gives each key its value (a flash finds the key of a channel)', () => {
    render(<ChoiceKeys aria-label='Channel' options={OPTIONS} value='all' onChange={jest.fn()} />);
    expect(screen.getAllByRole('radio').map((key) => key.getAttribute('data-value'))).toEqual([
      'all',
      '0',
      '1',
    ]);
  });

  it('keeps the focus where it is on a press (the QWERTY keys go on playing)', () => {
    render(<ChoiceKeys aria-label='Channel' options={OPTIONS} value='all' onChange={jest.fn()} />);
    // the default of a mousedown is what focuses a key
    expect(fireEvent.mouseDown(screen.getByRole('radio', { name: 'Channel 1' }))).toBe(false);
  });
});
