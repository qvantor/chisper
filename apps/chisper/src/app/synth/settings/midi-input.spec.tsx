import { act, fireEvent, render, screen } from '@testing-library/react';
import { BehaviorSubject } from 'rxjs';
import { MidiInput } from './midi-input';
import { MIN_LIT_MS } from './use-lights';

const mockMidiInputs = new BehaviorSubject<MIDIInput[]>([]);
const mockSelectedInputId = new BehaviorSubject<string | null>(null);
const mockSelectedChannel = new BehaviorSubject<number | null>(null);
const mockSelectMidiInput = jest.fn();
const mockSelectMidiChannel = jest.fn();
const mockMidiAccess = new BehaviorSubject<unknown>({});
const mockClockSync = new BehaviorSubject(true);
const mockSetClockSync = jest.fn();
const mockHeldChannels = new BehaviorSubject(0);
const mockSource = new BehaviorSubject<'internal' | 'midi'>('internal');
const mockTempo = new BehaviorSubject(120);

jest.mock('../common/modules', () => ({
  useMidiController: () => [
    {
      $midiInputs: mockMidiInputs,
      $selectedInputId: mockSelectedInputId,
      $selectedChannel: mockSelectedChannel,
      $midiAccess: mockMidiAccess,
      $clockSync: mockClockSync,
      $heldChannels: mockHeldChannels,
    },
    {
      selectMidiInput: mockSelectMidiInput,
      selectMidiChannel: mockSelectMidiChannel,
      setClockSync: mockSetClockSync,
    },
  ],
  useTransport: () => [{ $source: mockSource, $tempo: mockTempo }, {}],
}));

const input = (id: string, name: string, manufacturer = '') => ({ id, name, manufacturer }) as MIDIInput;

const open = async () => {
  render(<MidiInput />);
  fireEvent.click(screen.getByRole('button', { name: 'Midi' }));
  expect(await screen.findByText('MIDI')).toBeInTheDocument();
};

const checked = (group: string) =>
  screen
    .getByRole('radiogroup', { name: group })
    .querySelector<HTMLElement>('[aria-checked="true"]')
    ?.getAttribute('aria-label') ?? null;

beforeEach(() => {
  mockMidiInputs.next([]);
  mockSelectedInputId.next(null);
  mockSelectedChannel.next(null);
  mockMidiAccess.next({});
  mockClockSync.next(true);
  mockHeldChannels.next(0);
  mockSource.next('internal');
  mockTempo.next(120);
});

describe('MidiInput', () => {
  it('is a labeled key, lit while the popover is open', async () => {
    render(<MidiInput />);
    const button = screen.getByRole('button', { name: 'Midi' });
    expect(button.classList.contains('active')).toBe(false);

    fireEvent.click(button);
    expect(await screen.findByText('MIDI')).toBeInTheDocument();
    expect(button.classList.contains('active')).toBe(true);
  });

  it('shows the indicator while an input is selected', () => {
    render(<MidiInput />);
    expect(screen.queryByTestId('panel-button-indicator')).not.toBeInTheDocument();

    act(() => mockSelectedInputId.next('keys'));
    expect(screen.getByTestId('panel-button-indicator')).toBeInTheDocument();
  });

  describe('the inputs', () => {
    it('lists the inputs by their names and makers, the one listened to checked', async () => {
      mockMidiInputs.next([input('iac', 'IAC Driver Bus 1', 'Apple Inc.'), input('keys', 'KeyStep 37')]);
      mockSelectedInputId.next('iac');
      await open();
      const rows = screen.getAllByRole('radio').filter((row) => row.closest('[aria-label="MIDI input"]'));
      expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual([
        'IAC Driver Bus 1, Apple Inc.',
        'KeyStep 37',
      ]);
      expect(screen.getByText('Apple Inc.')).toBeInTheDocument();
      expect(rows.map((row) => row.getAttribute('aria-checked'))).toEqual(['true', 'false']);

      act(() => mockSelectedInputId.next('keys'));
      expect(rows.map((row) => row.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    });

    it('listens to another input on a click, not again to the one it listens to', async () => {
      mockMidiInputs.next([input('iac', 'IAC Driver Bus 1'), input('keys', 'KeyStep 37')]);
      mockSelectedInputId.next('iac');
      await open();
      fireEvent.click(screen.getByRole('radio', { name: 'IAC Driver Bus 1' }));
      expect(mockSelectMidiInput).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('radio', { name: 'KeyStep 37' }));
      expect(mockSelectMidiInput).toHaveBeenCalledWith('keys');
    });

    it('names an input without a name Unknown', async () => {
      mockMidiInputs.next([input('a', '')]);
      await open();
      expect(screen.getByRole('radio', { name: 'Unknown' })).toBeInTheDocument();
    });

    it('says how to get one while none is connected', async () => {
      await open();
      expect(screen.getByText(/No MIDI device connected/)).toBeInTheDocument();
      expect(screen.queryByRole('radiogroup', { name: 'MIDI input' })).not.toBeInTheDocument();

      act(() => mockMidiInputs.next([input('keys', 'KeyStep 37')]));
      expect(screen.getByRole('radio', { name: 'KeyStep 37' })).toBeInTheDocument();
    });
  });

  describe('the channel', () => {
    it('has a key for all the channels and for each of the 16, all by default', async () => {
      await open();
      const keys = screen.getByRole('radiogroup', { name: 'MIDI channel' }).children;
      expect(Array.from(keys, (key) => key.getAttribute('aria-label'))).toEqual([
        'All channels',
        ...Array.from({ length: 16 }, (_, i) => `Channel ${i + 1}`),
      ]);
      expect(Array.from(keys, (key) => key.textContent)).toEqual([
        'All',
        ...Array.from({ length: 16 }, (_, i) => String(i + 1)),
      ]);
      expect(checked('MIDI channel')).toBe('All channels');
    });

    it('checks the selected channel, 0 is Channel 1', async () => {
      mockSelectedChannel.next(0);
      await open();
      expect(checked('MIDI channel')).toBe('Channel 1');

      act(() => mockSelectedChannel.next(9));
      expect(checked('MIDI channel')).toBe('Channel 10');
    });

    it('selects a channel by its index, All channels as null', async () => {
      mockSelectedChannel.next(3);
      await open();

      fireEvent.click(screen.getByRole('radio', { name: 'Channel 1' }));
      expect(mockSelectMidiChannel).toHaveBeenLastCalledWith(0);

      fireEvent.click(screen.getByRole('radio', { name: 'All channels' }));
      expect(mockSelectMidiChannel).toHaveBeenLastCalledWith(null);
      expect(mockSelectMidiChannel).toHaveBeenCalledTimes(2);
    });
  });

  describe('the MIDI Clock', () => {
    it('lights its lamp while the tempo may follow it', async () => {
      await open();
      const lamp = screen.getByRole('button', { name: 'Sync to MIDI Clock' });
      expect(lamp).toHaveAttribute('aria-pressed', 'true');

      act(() => mockClockSync.next(false));
      expect(lamp).toHaveAttribute('aria-pressed', 'false');
    });

    it('switches it by its lamp or its name, once a press', async () => {
      await open();
      fireEvent.click(screen.getByRole('button', { name: 'Sync to MIDI Clock' }));
      expect(mockSetClockSync).toHaveBeenLastCalledWith(false);

      act(() => mockClockSync.next(false));
      // the name: the lamp's row
      fireEvent.click(screen.getByText('Sync to MIDI Clock'));
      expect(mockSetClockSync).toHaveBeenLastCalledWith(true);
      expect(mockSetClockSync).toHaveBeenCalledTimes(2);
    });

    it('says whether a clock leads the tempo, at what tempo (whole)', async () => {
      await open();
      expect(screen.getByText('Waiting for a clock')).toBeInTheDocument();

      act(() => {
        mockTempo.next(123.6);
        mockSource.next('midi');
      });
      expect(screen.getByText('124 BPM').classList.contains('leads')).toBe(true);

      act(() => mockTempo.next(97.2));
      expect(screen.getByText('97 BPM')).toBeInTheDocument();

      act(() => mockClockSync.next(false));
      expect(screen.getByText('Off').classList.contains('leads')).toBe(false);
    });
  });

  describe('without WebMIDI', () => {
    it('says so: no inputs, no channels, no clock, no lamp', async () => {
      mockMidiAccess.next(null);
      await open();
      expect(screen.getByText(/MIDI isn't available/)).toBeInTheDocument();
      expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
      expect(screen.queryByText('Sync to MIDI Clock')).not.toBeInTheDocument();
      expect(screen.queryByText('IN')).not.toBeInTheDocument();

      act(() => mockMidiAccess.next({}));
      expect(screen.getByRole('radiogroup', { name: 'MIDI channel' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Sync to MIDI Clock' })).toBeInTheDocument();
      expect(screen.getByText('IN')).toBeInTheDocument();
    });
  });

  describe('the notes of the input', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    const lamp = () => screen.getByText('IN').lastElementChild as HTMLElement;
    const signals = () =>
      Array.from(document.querySelectorAll('.signal'), (key) => key.getAttribute('aria-label'));

    it('light the lamp of the header and a dot on the key of their channel while they are held', async () => {
      mockSelectedChannel.next(2);
      await open();
      expect(lamp().classList.contains('on')).toBe(false);
      expect(signals()).toEqual([]);

      // a channel not listened to shows too: the one the keyboard sends on
      act(() => mockHeldChannels.next(0b1));
      expect(lamp().classList.contains('on')).toBe(true);
      expect(signals()).toEqual(['Channel 1']);

      // held: they stay lit
      act(() => mockHeldChannels.next(0b101));
      act(() => jest.advanceTimersByTime(5000));
      expect(lamp().classList.contains('on')).toBe(true);
      expect(signals()).toEqual(['Channel 1', 'Channel 3']);

      // released: channel 1 goes out at once, the lamp stays lit by channel 3
      act(() => mockHeldChannels.next(0b100));
      expect(signals()).toEqual(['Channel 3']);
      expect(lamp().classList.contains('on')).toBe(true);

      act(() => mockHeldChannels.next(0));
      expect(signals()).toEqual([]);
      expect(lamp().classList.contains('on')).toBe(false);
    });

    it('keep a note shorter than MIN_LIT_MS lit that long (a drum pad shows)', async () => {
      await open();
      act(() => mockHeldChannels.next(0b10000));
      act(() => jest.advanceTimersByTime(10));
      act(() => mockHeldChannels.next(0));
      expect(signals()).toEqual(['Channel 5']);
      expect(lamp().classList.contains('on')).toBe(true);

      // pressed again meanwhile: lit on
      act(() => jest.advanceTimersByTime(MIN_LIT_MS - 20));
      act(() => mockHeldChannels.next(0b10000));
      act(() => jest.advanceTimersByTime(30));
      expect(signals()).toEqual(['Channel 5']);

      act(() => mockHeldChannels.next(0));
      act(() => jest.advanceTimersByTime(MIN_LIT_MS - 31));
      expect(signals()).toEqual(['Channel 5']);
      act(() => jest.advanceTimersByTime(1));
      expect(signals()).toEqual([]);
      expect(lamp().classList.contains('on')).toBe(false);
    });

    it('light at once what is held as it opens', async () => {
      mockHeldChannels.next(0b1000);
      await open();
      expect(signals()).toEqual(['Channel 4']);
      expect(lamp().classList.contains('on')).toBe(true);
    });

    it('listen to nothing once it is closed', async () => {
      await open();
      act(() => mockHeldChannels.next(0b1));
      fireEvent.click(screen.getByRole('button', { name: 'Midi' }));
      act(() => jest.runAllTimers());
      expect(mockHeldChannels.observed).toBe(false);
    });
  });
});
