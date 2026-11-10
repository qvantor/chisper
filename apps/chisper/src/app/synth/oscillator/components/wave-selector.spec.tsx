import React from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { FileOption } from '../../../common/components';
import { createOscillator } from '../../../../test-utils/models';
import { OscillatorContext } from '../hooks';
import { useWavetables } from '../hooks/use-wavetables';
import { fileRow } from '../../../../test-utils/file-rows';
import { WaveSelector } from './wave-selector';

jest.mock('../hooks/use-wavetables', () => ({
  ...jest.requireActual('../hooks/use-wavetables'),
  useWavetables: jest.fn(),
}));

const files: FileOption[] = [
  { value: 'ESW/Analog/Saw.wav', label: 'Saw', note: '2.1 MB' },
  { value: 'ESW/Analog/Square.wav', label: 'Square', note: '2.1 MB' },
];

const categories: FileOption[] = [
  { value: 'Analog', label: 'Analog', children: files },
  { value: 'Basics', label: 'Basics', children: [{ value: 'ESW/Basics/Sine.wav', label: 'Sine' }] },
];

const wavetables: FileOption[] = [{ value: 'ESW', label: 'ESW', children: categories }];

// the tables load at once: the first one before the render, the ones switched to inside the click
// (user-event has its own @testing-library/dom, without the act of @testing-library/react)
const setup = async (
  initialWavePath = ['ESW', 'Analog', 'ESW/Analog/Square.wav'],
  options = wavetables,
  status = 'success'
) => {
  (useWavetables as jest.Mock).mockReturnValue({ options, status });
  const oscillator = createOscillator(undefined, 'osc1', { active: true, initialWavePath }, () =>
    Promise.resolve({ frames: [[0, 1, 0, -1]], morph: false })
  );
  const [model] = oscillator;
  await waitFor(() => expect(model.$waveTableLoading.value).toBe(false));
  const user = userEvent.setup();
  render(
    <OscillatorContext.Provider value={oscillator}>
      <WaveSelector />
    </OscillatorContext.Provider>
  );
  const click = (element: Element) => act(() => user.click(element));
  const path = () => model.$waveTablePath.value;
  return { click, path, model };
};

const next = () => screen.getByRole('button', { name: 'Next' });
const previous = () => screen.getByRole('button', { name: 'Previous' });
// the key of the browser, named by the table shown
const nameKey = () => document.querySelector('button[aria-haspopup]') as HTMLElement;
// the screen of the browser under its WAVETABLE header
const browser = () => screen.getByText('Wavetable').parentElement?.nextElementSibling as HTMLElement;
const row = (name: string) => fileRow(name, browser());
const columns = () =>
  Array.from(browser().firstElementChild?.children ?? [], (column) =>
    within(column as HTMLElement)
      .getAllByRole('button')
      .map((key) => key.firstElementChild?.textContent)
  );

describe('WaveSelector', () => {
  it('shows the name of the current wavetable, without its size', async () => {
    await setup();
    expect(nameKey()).toHaveTextContent(/^Square$/);
  });

  it('opens a browser of the tables: the only pack is not a column, the category of the table is open', async () => {
    const { click } = await setup();
    await click(nameKey());
    expect(columns()).toEqual([
      ['Analog', 'Basics'],
      ['Saw', 'Square'],
    ]);
    expect(row('Analog')).toHaveAttribute('aria-expanded', 'true');
    expect(row('Square')).toHaveAttribute('aria-current', 'true');
    expect(row('Square')).toHaveTextContent('Square2.1 MB');
  });

  it('a table chosen in the browser sets the whole path, the pack included', async () => {
    const { click, path } = await setup();
    await click(nameKey());
    await click(row('Basics'));
    await click(row('Sine'));
    expect(path()).toEqual(['ESW', 'Basics', 'ESW/Basics/Sine.wav']);
    expect(nameKey()).toHaveTextContent(/^Sine$/);
  });

  it('shows Loading until the list is loaded, in its browser too', async () => {
    const { click } = await setup(undefined, [], 'pending');
    expect(nameKey()).toHaveTextContent('Loading...');
    await click(nameKey());
    expect(within(browser()).getByLabelText('Loading')).toBeInTheDocument();
  });

  it('next switches to the next wavetable, also in the next folder', async () => {
    const { click, path, model } = await setup(['ESW', 'Analog', 'ESW/Analog/Saw.wav']);
    await click(next());
    expect(path()).toEqual(['ESW', 'Analog', 'ESW/Analog/Square.wav']);
    expect(screen.getByText('Square')).toBeInTheDocument();
    await click(next());
    expect(path()).toEqual(['ESW', 'Basics', 'ESW/Basics/Sine.wav']);
    expect(screen.getByText('Sine')).toBeInTheDocument();
    expect(model.$waveTableLoading.value).toBe(false);
  });

  it('previous from the first wavetable goes to the last one', async () => {
    const { click, path } = await setup(['ESW', 'Analog', 'ESW/Analog/Saw.wav']);
    await click(previous());
    expect(path()).toEqual(['ESW', 'Basics', 'ESW/Basics/Sine.wav']);
    expect(screen.getByText('Sine')).toBeInTheDocument();
  });

  it('next from a path without the pack goes to the next wavetable', async () => {
    const { click, path } = await setup(['Analog', 'ESW/Analog/Saw.wav']);
    await click(next());
    expect(path()).toEqual(['ESW', 'Analog', 'ESW/Analog/Square.wav']);
  });

  it('with several packs the pack is a column', async () => {
    const options: FileOption[] = [
      ...wavetables,
      { value: 'Other', label: 'Other', children: [{ value: 'Other/Pulse.wav', label: 'Pulse' }] },
    ];
    const { click, path } = await setup(['ESW', 'Basics', 'ESW/Basics/Sine.wav'], options);
    await click(nameKey());
    expect(columns()).toEqual([['ESW', 'Other'], ['Analog', 'Basics'], ['Sine']]);
    expect(row('Sine')).toHaveAttribute('aria-current', 'true');
    await click(row('Other'));
    await click(row('Pulse'));
    expect(path()).toEqual(['Other', 'Other/Pulse.wav']);
    await click(previous());
    expect(path()).toEqual(['ESW', 'Basics', 'ESW/Basics/Sine.wav']);
  });
});
