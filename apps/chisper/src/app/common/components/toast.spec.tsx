import { act, fireEvent, render, screen } from '@testing-library/react';
import toast from 'react-hot-toast';
import { theme } from '@chisper/ui-kit';
import { cssColor } from '@chisper/ui-kit/test-utils';
import { Key } from './section-bar';
import { ToastAsk, Toasts } from './toast';

// the real toaster: every other app spec gets the mock
jest.unmock('react-hot-toast');

const { colors } = theme;

// the plate of the toast that shows the text, and the LED before the text
const plateOf = (text: string) => screen.getByText(text).closest('[data-type]') as HTMLElement;
const ledOf = (text: string) => screen.getByText(text).previousElementSibling as HTMLElement;

describe('Toasts', () => {
  afterEach(() => {
    act(() => toast.remove());
    jest.useRealTimers();
  });

  it('draws a toast of each type on its light plate, its LED lit by the type', () => {
    render(<Toasts />);
    act(() => {
      toast.success('Link copied');
      toast.error('Name is taken');
      toast('The clip is full');
    });

    expect(plateOf('Link copied')).toHaveAttribute('data-type', 'success');
    // dark text on the light of the plate
    expect(getComputedStyle(plateOf('Link copied')).backgroundColor).toBe(cssColor(colors.primary));
    expect(getComputedStyle(screen.getByText('Link copied')).color).toBe(
      cssColor(colors.primaryDarkMediumContrast)
    );
    expect(getComputedStyle(ledOf('Link copied')).backgroundColor).toBe(cssColor(colors.accent));
    expect(plateOf('Name is taken')).toHaveAttribute('data-type', 'error');
    expect(getComputedStyle(ledOf('Name is taken')).backgroundColor).toBe(cssColor(colors.red));
    expect(plateOf('The clip is full')).toHaveAttribute('data-type', 'blank');
    expect(getComputedStyle(ledOf('The clip is full')).backgroundColor).toBe(cssColor(colors.secondAccent));
  });

  it('is announced: the role and the politeness of the toast', () => {
    render(<Toasts />);
    act(() => {
      toast.error('Saving failed');
    });
    const plate = screen.getByRole('status');
    expect(plate).toHaveAttribute('aria-live', 'polite');
    expect(plate).toHaveTextContent('Saving failed');
  });

  it('resolves a message given as a function of the toast', () => {
    render(<Toasts />);
    act(() => {
      toast((t) => `Toast ${t.type}`);
    });
    expect(screen.getByText('Toast blank')).toBeInTheDocument();
  });

  it('an ask: its text, its keys in the bar under it', () => {
    const answer = jest.fn();
    render(<Toasts />);
    act(() => {
      toast.error(
        <ToastAsk text='No sound'>
          <Key onClick={answer}>Retry</Key>
        </ToastAsk>,
        { duration: Infinity }
      );
    });

    const text = screen.getByText('No sound');
    const key = screen.getByRole('button', { name: 'Retry' });
    expect(plateOf('No sound')).toHaveAttribute('data-type', 'error');
    expect(getComputedStyle(ledOf('No sound')).backgroundColor).toBe(cssColor(colors.red));
    // the text, then the bar
    const textEl = text.parentElement as HTMLElement;
    expect(textEl.nextElementSibling).toContainElement(key);
    fireEvent.click(key);
    expect(answer).toHaveBeenCalledTimes(1);
  });

  it('leaves once dismissed, gone after its delay', () => {
    jest.useFakeTimers();
    render(<Toasts />);
    let id = '';
    act(() => {
      id = toast('Thanks');
    });
    expect(plateOf('Thanks')).not.toHaveClass('leaving');

    act(() => toast.dismiss(id));
    expect(plateOf('Thanks')).toHaveClass('leaving');

    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(screen.queryByText('Thanks')).not.toBeInTheDocument();
  });

  it('a toast leaves by itself after its duration', () => {
    jest.useFakeTimers();
    render(<Toasts />);
    act(() => {
      toast.success('Saved');
    });
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(plateOf('Saved')).toHaveClass('leaving');
  });
});
