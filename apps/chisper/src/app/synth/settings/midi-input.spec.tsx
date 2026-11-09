import { act, fireEvent, render, screen } from '@testing-library/react';
import { BehaviorSubject } from 'rxjs';
import { MidiInput } from './midi-input';

const mockMidiInputs = new BehaviorSubject<MIDIInput[]>([]);
const mockSelectedInputId = new BehaviorSubject<string | null>(null);
const mockSelectedChannel = new BehaviorSubject<number | null>(null);
const mockSelectMidiChannel = jest.fn();
const mockMidiAccess = new BehaviorSubject<unknown>({});
const mockClockSync = new BehaviorSubject(true);
const mockSetClockSync = jest.fn();

jest.mock('../common/modules', () => ({
  useMidiController: () => [
    {
      $midiInputs: mockMidiInputs,
      $selectedInputId: mockSelectedInputId,
      $selectedChannel: mockSelectedChannel,
      $midiAccess: mockMidiAccess,
      $clockSync: mockClockSync,
    },
    { selectMidiInput: jest.fn(), selectMidiChannel: mockSelectMidiChannel, setClockSync: mockSetClockSync },
  ],
}));

const openChannelSelect = async () => {
  render(<MidiInput />);
  fireEvent.click(screen.getByRole('button', { name: 'Midi' }));
  expect(await screen.findByText('Midi channel')).toBeInTheDocument();
  // the source select has no inputs, so the only other combobox is the channel one
  return screen.getAllByRole('combobox')[1] as HTMLSelectElement;
};

const open = async () => {
  render(<MidiInput />);
  fireEvent.click(screen.getByRole('button', { name: 'Midi' }));
  expect(await screen.findByText('Midi source')).toBeInTheDocument();
};

beforeEach(() => {
  mockSelectedInputId.next(null);
  mockSelectedChannel.next(null);
  mockMidiAccess.next({});
  mockClockSync.next(true);
});

describe('MidiInput', () => {
  it('is a labeled key, lit while the popover is open', async () => {
    render(<MidiInput />);
    const button = screen.getByRole('button', { name: 'Midi' });
    expect(button.classList.contains('active')).toBe(false);

    fireEvent.click(button);
    expect(await screen.findByText('Midi source')).toBeInTheDocument();
    expect(button.classList.contains('active')).toBe(true);
  });

  it('shows the indicator while an input is selected', () => {
    render(<MidiInput />);
    expect(screen.queryByTestId('panel-button-indicator')).not.toBeInTheDocument();

    act(() => mockSelectedInputId.next('keys'));
    expect(screen.getByTestId('panel-button-indicator')).toBeInTheDocument();
  });

  it('listens to all channels by default, any of the 16 can be chosen', async () => {
    const select = await openChannelSelect();
    expect(select.value).toBe('all');
    expect(screen.getByDisplayValue('All channels')).toBe(select);
    expect(Array.from(select.options, (option) => option.text)).toEqual([
      'All channels',
      ...Array.from({ length: 16 }, (_, i) => `Channel ${i + 1}`),
    ]);
  });

  it('shows the selected channel, 0 is Channel 1', async () => {
    mockSelectedChannel.next(0);
    const select = await openChannelSelect();
    expect(screen.getByDisplayValue('Channel 1')).toBe(select);

    act(() => mockSelectedChannel.next(9));
    expect(screen.getByDisplayValue('Channel 10')).toBe(select);
  });

  it('selects a channel by its index, All channels as null', async () => {
    mockSelectedChannel.next(3);
    const select = await openChannelSelect();

    fireEvent.change(select, { target: { value: '0' } });
    expect(mockSelectMidiChannel).toHaveBeenLastCalledWith(0);

    fireEvent.change(select, { target: { value: 'all' } });
    expect(mockSelectMidiChannel).toHaveBeenLastCalledWith(null);
    expect(mockSelectMidiChannel).toHaveBeenCalledTimes(2);
  });

  it('lights the lamp of the MIDI Clock while the tempo follows it', async () => {
    await open();
    const lamp = screen.getByRole('button', { name: 'Sync to MIDI Clock' });
    expect(lamp).toHaveAttribute('aria-pressed', 'true');

    act(() => mockClockSync.next(false));
    expect(lamp).toHaveAttribute('aria-pressed', 'false');
  });

  it('switches the MIDI Clock by its lamp or its name, once a press', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Sync to MIDI Clock' }));
    expect(mockSetClockSync).toHaveBeenLastCalledWith(false);

    act(() => mockClockSync.next(false));
    // the name: the lamp's row
    fireEvent.click(screen.getByText('Sync to MIDI Clock'));
    expect(mockSetClockSync).toHaveBeenLastCalledWith(true);
    expect(mockSetClockSync).toHaveBeenCalledTimes(2);
  });

  it('has no MIDI Clock to follow without WebMIDI', async () => {
    mockMidiAccess.next(null);
    await open();
    expect(screen.queryByText('Sync to MIDI Clock')).not.toBeInTheDocument();

    act(() => mockMidiAccess.next({}));
    expect(screen.getByRole('button', { name: 'Sync to MIDI Clock' })).toBeInTheDocument();
  });
});
