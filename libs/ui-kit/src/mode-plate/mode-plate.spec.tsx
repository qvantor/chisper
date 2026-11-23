import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ModeOption, ModePlate } from './index';

const options: ModeOption<number>[] = [
  { id: 0, label: 'Off', icon: <svg data-testid='icon-off' />, off: true },
  { id: 1, label: 'Bend +', icon: <svg data-testid='icon-up' />, hint: 'Squeezes the middle' },
  { id: 2, label: 'PWM', icon: <svg data-testid='icon-pwm' /> },
];

const Stateful = ({
  initial,
  onChange,
  compact,
}: {
  initial: number;
  onChange: jest.Mock;
  compact?: boolean;
}) => {
  const [value, setValue] = React.useState(initial);
  return (
    <ModePlate
      name='Warp mode'
      options={options}
      value={value}
      compact={compact}
      onChange={(id) => {
        onChange(id);
        setValue(id);
      }}
    />
  );
};

const setup = (initial = 0, compact?: boolean) => {
  const onChange = jest.fn();
  const user = userEvent.setup();
  render(<Stateful initial={initial} onChange={onChange} compact={compact} />);
  const plate = screen.getByRole('button', { name: 'Warp mode' });
  return { onChange, user, plate };
};

const menu = () => screen.queryByRole('menu', { name: 'Warp mode' });

describe('ModePlate', () => {
  it('shows the glyph and the name of the current mode, unlit while it is the one that does nothing', () => {
    const { plate } = setup(0);
    expect(plate.textContent).toBe('Off');
    expect(within(plate).queryByTestId('icon-off')).not.toBeNull();
    expect(within(plate).queryByTestId('icon-up')).toBeNull();
    expect(plate.classList.contains('lit')).toBe(false);
    expect(plate.getAttribute('aria-haspopup')).toBe('menu');
    expect(plate.getAttribute('aria-expanded')).toBe('false');
  });

  it('is lit while its mode does something', () => {
    const { plate } = setup(1);
    expect(plate.textContent).toBe('Bend +');
    expect(plate.classList.contains('lit')).toBe(true);
  });

  it('compact, shows the glyph alone', () => {
    const { plate } = setup(2, true);
    expect(plate.textContent).toBe('');
    expect(within(plate).queryByTestId('icon-pwm')).not.toBeNull();
    expect(plate.classList.contains('compact')).toBe(true);
  });

  it('opens the menu of every mode, the current one checked, with their glyphs and hints', async () => {
    const { user, plate } = setup(1);
    expect(menu()).toBeNull();
    await user.click(plate);
    const list = menu();
    expect(list).not.toBeNull();
    expect(plate.getAttribute('aria-expanded')).toBe('true');
    const items = within(list as HTMLElement).getAllByRole('menuitemradio');
    expect(items.map((item) => item.getAttribute('aria-label'))).toEqual(['Off', 'Bend +', 'PWM']);
    expect(items.map((item) => item.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    expect(within(items[1]).queryByTestId('icon-up')).not.toBeNull();
    expect(items[1].textContent).toContain('Squeezes the middle');
    expect(within(list as HTMLElement).getByText('Warp mode')).toBeDefined();
  });

  it('a mode chosen is set and closes the menu', async () => {
    const { user, plate, onChange } = setup(0);
    await user.click(plate);
    await user.click(screen.getByRole('menuitemradio', { name: 'PWM' }));
    expect(onChange).toHaveBeenCalledWith(2);
    expect(menu()).toBeNull();
    expect(plate.textContent).toBe('PWM');
    expect(plate.classList.contains('lit')).toBe(true);
  });

  it('a press of the plate closes the menu it opened', async () => {
    const { user, plate, onChange } = setup(0);
    await user.click(plate);
    await user.click(plate);
    expect(menu()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('closes on Escape and on a press out of it, nothing chosen', async () => {
    const { user, plate, onChange } = setup(0);
    await user.click(plate);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(menu()).toBeNull();
    await user.click(plate);
    fireEvent.pointerDown(document.body);
    expect(menu()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});
