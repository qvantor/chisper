import React from 'react';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { Tabs } from './index';

const setup = () => {
  const onSelect = jest.fn();
  render(
    <Tabs activeTab='Manual' onSelect={onSelect}>
      <Tabs.Tab id='Manual' name={<svg />}>
        <p>drawing</p>
      </Tabs.Tab>
      <Tabs.Tab id='Audio file'>
        <p>audio</p>
      </Tabs.Tab>
    </Tabs>
  );
  return { onSelect, user: userEvent.setup() };
};

describe('Tabs', () => {
  it('names a tab of an icon by its id, shows the content of the active one', () => {
    setup();

    const manual = screen.getByRole('tab', { name: 'Manual' });
    expect(manual.getAttribute('aria-selected')).toBe('true');
    expect(manual.getAttribute('title')).toBe('Manual');
    expect(screen.getByRole('tab', { name: 'Audio file' }).getAttribute('aria-selected')).toBe('false');
    expect(screen.queryByText('drawing')).not.toBeNull();
    expect(screen.queryByText('audio')).toBeNull();
  });

  it('selects a tab by a click or from the keyboard', async () => {
    const { onSelect, user } = setup();

    await user.click(screen.getByRole('tab', { name: 'Audio file' }));
    screen.getByRole('tab', { name: 'Manual' }).focus();
    await user.keyboard('{Enter}');

    expect(onSelect.mock.calls).toEqual([['Audio file'], ['Manual']]);
  });
});
