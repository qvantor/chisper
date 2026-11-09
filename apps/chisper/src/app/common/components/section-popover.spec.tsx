import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SectionPopover } from './section-popover';

const Section = ({ placement }: { placement?: 'bottomLeft' }) => {
  const [open, setOpen] = React.useState(false);
  return (
    <SectionPopover
      title='MIDI'
      extra={<span>IN</span>}
      content={<div>the screen</div>}
      width={320}
      placement={placement}
      open={open}
      onOpenChange={setOpen}
    >
      <button type='button'>Open</button>
    </SectionPopover>
  );
};

describe('SectionPopover', () => {
  it('opens under its key: the title and what is on the right of its header, the screen under it', async () => {
    render(<Section />);
    expect(screen.queryByText('the screen')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(await screen.findByText('the screen')).toBeInTheDocument();
    const header = screen.getByText('MIDI').parentElement as HTMLElement;
    expect(header).toHaveTextContent('MIDIIN');
    expect(header.nextElementSibling).toContainElement(screen.getByText('the screen'));
  });

  it('is as wide as given, within the width of a phone', async () => {
    render(<Section />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    const content = (await screen.findByText('the screen')).parentElement?.parentElement as HTMLElement;
    expect(content.style.width).toBe('320px');
    expect(window.getComputedStyle(content).maxWidth).toBe('calc(100vw - 44px)');
  });

  it('opens from the right edge of its key, or from its left one', async () => {
    const { unmount } = render(<Section />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    const popover = () => screen.getByText('the screen').closest('.ant-popover');
    await screen.findByText('the screen');
    expect(popover()).toHaveClass('ant-popover-placement-bottomRight');
    unmount();

    render(<Section placement='bottomLeft' />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await screen.findByText('the screen');
    expect(popover()).toHaveClass('ant-popover-placement-bottomLeft');
  });

  it('has nothing of its content once closed (nothing of it listens meanwhile)', async () => {
    render(<Section />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(await screen.findByText('the screen')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(screen.queryByText('the screen')).not.toBeInTheDocument());
  });
});
