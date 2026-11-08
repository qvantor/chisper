import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { cssColor, hoverSwitchKey, switchKeyTip } from '../common/test-utils';
import { theme } from '../common/constants';
import {
  ActionKey,
  FollowIcon,
  LegatoIcon,
  QuantizeIcon,
  SelectIcon,
  SnapIcon,
  SWITCH_KEY_TIP_DELAY,
  SwitchKey,
  SwitchKeys,
  TripletIcon,
} from './index';

describe('SwitchKey', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('is a key pressed while it is on, its full name for screen readers', () => {
    const onChange = jest.fn();
    const { rerender } = render(<SwitchKey on={false} label='T' name='Triplets' onChange={onChange} />);
    const key = screen.getByRole('button', { name: 'Triplets' });
    expect(key.textContent).toBe('T');
    expect(key.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(key);
    expect(onChange).toHaveBeenLastCalledWith(true);
    rerender(<SwitchKey on label='T' name='Triplets' onChange={onChange} />);
    expect(key.getAttribute('aria-pressed')).toBe('true');
    expect(key.classList.contains('on')).toBe(true);
    fireEvent.click(key);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('is lit green while on, or in its own color', () => {
    const { rerender } = render(<SwitchKey on label='T' name='Triplets' />);
    const key = screen.getByRole('button', { name: 'Triplets' });
    expect(getComputedStyle(key).color).toBe(cssColor(theme.colors.accent));
    rerender(<SwitchKey on label='T' name='Triplets' lit={theme.colors.red} />);
    expect(getComputedStyle(key).color).toBe(cssColor(theme.colors.red));
  });

  it('does nothing while disabled', () => {
    const onChange = jest.fn();
    render(<SwitchKey on={false} label='BPM' name='Tempo sync' onChange={onChange} disabled />);
    fireEvent.click(screen.getByRole('button', { name: 'Tempo sync' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows an icon instead of the label, its name for screen readers', () => {
    render(<SwitchKey on={false} icon={<TripletIcon />} name='Triplets' />);
    const key = screen.getByRole('button', { name: 'Triplets' });
    expect(key.textContent).toBe('');
    expect(key.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows the four corners of a frame on the key of selecting', () => {
    render(<SwitchKey on={false} icon={<SelectIcon />} name='Select notes' />);
    const icon = screen.getByRole('button', { name: 'Select notes' }).querySelector('svg');
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    expect(icon?.querySelectorAll('path')).toHaveLength(4);
  });

  it('shows the playhead and an arrow on the key of following it', () => {
    render(<SwitchKey on icon={<FollowIcon />} name='Follow the playhead' />);
    const key = screen.getByRole('button', { name: 'Follow the playhead' });
    expect(key.textContent).toBe('');
    expect(key.querySelector('svg')?.querySelectorAll('path')).toHaveLength(4);
  });

  it('shows a magnet on the key of snapping to the grid', () => {
    render(<SwitchKey on icon={<SnapIcon />} name='Snap to the grid' />);
    const key = screen.getByRole('button', { name: 'Snap to the grid' });
    expect(key.textContent).toBe('');
    expect(key.querySelector('svg')?.querySelectorAll('path')).toHaveLength(2);
  });

  it('hovered 700 ms tells its name and what it does, no title of the browser', () => {
    render(<SwitchKey on={false} label='BPM' name='Tempo sync' hint='Time in note values' />);
    const key = screen.getByRole('button', { name: 'Tempo sync' });
    expect(key.hasAttribute('title')).toBe(false);
    expect(SWITCH_KEY_TIP_DELAY).toBe(700);
    fireEvent.mouseEnter(key.parentElement as HTMLElement);
    act(() => {
      jest.advanceTimersByTime(SWITCH_KEY_TIP_DELAY - 1);
    });
    expect(screen.queryByRole('tooltip')).toBeNull();
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(screen.getByRole('tooltip').textContent).toBe('Tempo syncTime in note values');
  });

  it('passed over shows no tooltip', () => {
    render(<SwitchKey on={false} label='BPM' name='Tempo sync' />);
    const wrap = screen.getByRole('button', { name: 'Tempo sync' }).parentElement as HTMLElement;
    fireEvent.mouseEnter(wrap);
    act(() => {
      jest.advanceTimersByTime(SWITCH_KEY_TIP_DELAY / 2);
    });
    fireEvent.mouseLeave(wrap);
    act(() => {
      jest.advanceTimersByTime(SWITCH_KEY_TIP_DELAY * 2);
    });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('takes no focus: not in the tab order, a press keeps it where it was', () => {
    const onChange = jest.fn();
    render(
      <>
        <input aria-label='Name' />
        <SwitchKey on={false} label='BPM' name='Tempo sync' onChange={onChange} />
      </>
    );
    const field = screen.getByRole('textbox', { name: 'Name' });
    field.focus();
    const key = screen.getByRole('button', { name: 'Tempo sync' });
    expect(key.tabIndex).toBe(-1);
    // the default of the press (the focus) prevented, the click still switches it
    expect(fireEvent.mouseDown(key)).toBe(false);
    fireEvent.click(key);
    expect(onChange).toHaveBeenCalledWith(true);
    expect(document.activeElement).toBe(field);
  });

  it('disabled, tells why too, only while it is', () => {
    const props = {
      on: false,
      label: 'T',
      name: 'Triplets',
      hint: 'In triplets',
      disabledHint: 'Turn on BPM',
    };
    const { rerender } = render(<SwitchKey {...props} disabled />);
    hoverSwitchKey(screen.getByRole('button', { name: 'Triplets' }));
    expect(screen.getByRole('tooltip').textContent).toBe('TripletsIn tripletsTurn on BPM');
    rerender(<SwitchKey {...props} />);
    expect(screen.getByRole('tooltip').textContent).toBe('TripletsIn triplets');
  });
});

describe('SwitchKeys', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('is a group of keys under its name', () => {
    render(
      <SwitchKeys aria-label='Tempo'>
        <SwitchKey on label='BPM' name='Tempo sync' />
        <SwitchKey on={false} icon={<TripletIcon />} name='Triplets' disabled />
      </SwitchKeys>
    );
    const group = screen.getByRole('group', { name: 'Tempo' });
    const keys = within(group).getAllByRole('button');
    expect(keys.map((key) => key.getAttribute('aria-label'))).toEqual(['Tempo sync', 'Triplets']);
    expect(group.classList.contains('stack')).toBe(false);
    expect(group.classList.contains('fill')).toBe(false);
    expect(group.style.flexGrow).toBe('');
    expect(group.hasAttribute('aria-disabled')).toBe(false);
  });

  it('fills a strip with the plates beside it: as many shares of its width as it has keys', () => {
    render(
      <div>
        <SwitchKeys aria-label='Playback' fill>
          <SwitchKey on name='Loop' />
          <SwitchKey on={false} name='One-shot' />
          {null}
        </SwitchKeys>
        <SwitchKeys aria-label='Pitch' fill>
          <SwitchKey on={false} name='Pitch Track' />
        </SwitchKeys>
      </div>
    );
    const groups = ['Playback', 'Pitch'].map((name) => screen.getByRole('group', { name }));
    expect(groups.map((group) => group.classList.contains('fill'))).toEqual([true, true]);
    // a key not rendered takes no share
    expect(groups.map((group) => group.style.flexGrow)).toEqual(['2', '1']);
  });

  it('stacks the first key over the others; all of it off: faded as a whole, every key disabled, its reason', () => {
    const { rerender } = render(
      <SwitchKeys aria-label='Tempo' disabled disabledHint='Turn on the delay' stack className='beside'>
        <SwitchKey on label='BPM' name='Tempo sync' />
        <SwitchKey on={false} icon={<TripletIcon />} name='Triplets' disabled disabledHint='Turn on BPM' />
      </SwitchKeys>
    );
    const group = screen.getByRole('group', { name: 'Tempo' });
    expect([...group.classList]).toEqual(expect.arrayContaining(['stack', 'beside']));
    expect(group.getAttribute('aria-disabled')).toBe('true');
    expect((screen.getByRole('button', { name: 'Tempo sync' }) as HTMLButtonElement).disabled).toBe(true);
    // the plate's reason first
    expect(switchKeyTip('Triplets')).toBe('TripletsTurn on the delay');
    rerender(
      <SwitchKeys aria-label='Tempo' disabledHint='Turn on the delay' stack>
        <SwitchKey on label='BPM' name='Tempo sync' />
        <SwitchKey on={false} icon={<TripletIcon />} name='Triplets' disabled disabledHint='Turn on BPM' />
      </SwitchKeys>
    );
    expect(group.hasAttribute('aria-disabled')).toBe(false);
    expect((screen.getByRole('button', { name: 'Tempo sync' }) as HTMLButtonElement).disabled).toBe(false);
    expect(switchKeyTip('Tempo sync')).toBe('Tempo sync');
    expect(switchKeyTip('Triplets')).toBe('TripletsTurn on BPM');
  });
});

describe('ActionKey', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('does its action on a click, never pressed nor lit, its full name for screen readers', () => {
    const onClick = jest.fn();
    render(<ActionKey label='QUANT' name='Quantize' onClick={onClick} />);
    const key = screen.getByRole('button', { name: 'Quantize' });
    expect(key.textContent).toBe('QUANT');
    expect(key.hasAttribute('aria-pressed')).toBe(false);
    fireEvent.click(key);
    fireEvent.click(key);
    expect(onClick).toHaveBeenCalledTimes(2);
    expect(key.classList.contains('on')).toBe(false);
  });

  it('shows an icon of its action instead of a label: notes on a grid, notes up to the next', () => {
    render(
      <>
        <ActionKey name='Quantize' icon={<QuantizeIcon />} />
        <ActionKey name='Legato' icon={<LegatoIcon />} />
      </>
    );
    const icon = (name: string) => screen.getByRole('button', { name }).querySelector('svg');
    expect(screen.getByRole('button', { name: 'Quantize' }).textContent).toBe('');
    expect(icon('Quantize')?.querySelectorAll('rect')).toHaveLength(2);
    expect(icon('Legato')?.querySelectorAll('rect')).toHaveLength(3);
  });

  it('takes no focus, does nothing while disabled and tells why', () => {
    const onClick = jest.fn();
    render(
      <>
        <button type='button'>before</button>
        <ActionKey name='Undo' hint='Cmd/Ctrl+Z' onClick={onClick} disabled disabledHint='Nothing to undo' />
      </>
    );
    const key = screen.getByRole('button', { name: 'Undo' });
    expect(key.getAttribute('tabindex')).toBe('-1');
    fireEvent.click(key);
    expect(onClick).not.toHaveBeenCalled();
    expect(switchKeyTip('Undo')).toBe('UndoCmd/Ctrl+ZNothing to undo');
  });

  it('on a plate all off: disabled with the reason of the plate', () => {
    render(
      <SwitchKeys aria-label='Edits' disabled disabledHint='The clock leads'>
        <ActionKey name='Quantize' label='Q' />
      </SwitchKeys>
    );
    expect((screen.getByRole('button', { name: 'Quantize' }) as HTMLButtonElement).disabled).toBe(true);
    expect(switchKeyTip('Quantize')).toBe('QuantizeThe clock leads');
  });
});
