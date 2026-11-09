import { act, fireEvent, render, screen } from '@testing-library/react';
import toast from 'react-hot-toast';
import { BehaviorSubject } from 'rxjs';
import { blockStorage } from '../../../test-utils/storage';
import { setChromium } from '../../../test-utils/user-agent';
import { readLatencyMode, reloadPage, switchToNormalLatency } from '../common/latency/latency';
import { SettingsButton } from './settings-button';

const mockDropouts = new BehaviorSubject<number | null>(null);
const mockDropoutWarning = new BehaviorSubject(false);
const mockDismissDropoutWarning = jest.fn(() => mockDropoutWarning.next(false));

jest.mock('../common/modules', () => ({
  useSynthCore: () => [
    { $dropouts: mockDropouts, $dropoutWarning: mockDropoutWarning },
    { dismissDropoutWarning: mockDismissDropoutWarning },
  ],
}));

jest.mock('../common/latency/latency', () => ({
  ...jest.requireActual('../common/latency/latency'),
  reloadPage: jest.fn(),
  switchToNormalLatency: jest.fn(),
}));

const open = async () => {
  render(<SettingsButton />);
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  expect(await screen.findByText('Latency')).toBeInTheDocument();
};

beforeEach(() => {
  mockDropouts.next(null);
  mockDropoutWarning.next(false);
});

describe('SettingsButton', () => {
  it('is a labeled key, lit while the popover is open', async () => {
    await open();
    expect(screen.getByRole('button', { name: 'Settings' }).classList.contains('active')).toBe(true);
  });

  // the tempo is set on the strip of the roll, its MIDI Clock in the Midi popover
  it('has no tempo and no MIDI Clock', async () => {
    await open();
    expect(screen.queryByText('Tempo')).not.toBeInTheDocument();
    expect(screen.queryByText('Sync to MIDI Clock')).not.toBeInTheDocument();
  });

  it('has no latency to choose in a browser that sets its own', async () => {
    await open();
    expect(screen.getByText('This browser sets the latency itself.')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'Latency' })).not.toBeInTheDocument();
  });

  it('has none to choose where site data is blocked: the choice would not be kept over the reload', async () => {
    setChromium();
    blockStorage('localStorage');
    await open();
    expect(screen.getByText(/site data is blocked/)).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'Latency' })).not.toBeInTheDocument();
  });

  it('chooses the latency in Chromium on its keys: auto by default, a choice reloads the page', async () => {
    setChromium();
    await open();
    const keys = screen.getByRole('radiogroup', { name: 'Latency' }).children;
    expect(Array.from(keys, (key) => key.getAttribute('aria-label') ?? key.textContent)).toEqual([
      'Auto (Low)',
      'Low',
      'Normal',
    ]);
    // Auto over the latency it picked
    expect(keys[0]).toHaveTextContent('AutoLow');
    expect(screen.getByRole('radio', { name: 'Auto (Low)' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/Switches to Normal if the sound crackles/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try low again' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'Normal' }));
    expect(readLatencyMode()).toBe('normal');
    expect(reloadPage).toHaveBeenCalledTimes(1);
  });

  it('reloads nothing on the key of the latency chosen', async () => {
    setChromium();
    localStorage.setItem('latencyMode', JSON.stringify('normal'));
    await open();
    expect(screen.getByRole('radio', { name: 'Normal' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('radio', { name: 'Normal' }));
    expect(reloadPage).not.toHaveBeenCalled();
  });

  it('shows what auto learnt', async () => {
    setChromium();
    localStorage.setItem('latencyAuto', JSON.stringify('normal'));
    await open();
    expect(screen.getByRole('radio', { name: 'Auto (Normal)' })).toBeInTheDocument();
    expect(screen.getByText(/Low crackled on this computer/)).toBeInTheDocument();
    // its key, the one chosen, would change nothing
    fireEvent.click(screen.getByRole('button', { name: 'Try low again' }));
    expect(localStorage.getItem('latencyAuto')).toBeNull();
    expect(reloadPage).toHaveBeenCalledTimes(1);
  });

  it('says what low risks where the browser counts dropouts', async () => {
    setChromium();
    localStorage.setItem('latencyMode', JSON.stringify('low'));
    await open();
    expect(screen.getByText(/Faster response, may crackle/)).toBeInTheDocument();
    // what auto would pick is shown only while it is chosen
    expect(screen.getByRole('radio', { name: 'Auto' })).toHaveTextContent(/^Auto$/);
  });

  it('says auto is normal where Chromium counts no dropouts, nothing learnt to forget', async () => {
    setChromium({ countsDropouts: false });
    localStorage.setItem('latencyAuto', JSON.stringify('normal'));
    await open();
    expect(screen.getByRole('radio', { name: 'Auto (Normal)' })).toBeInTheDocument();
    expect(screen.getByText(/Always Normal in this browser\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try low again' })).not.toBeInTheDocument();
  });

  it('asks to watch for a crackle at a low chosen there by hand', async () => {
    setChromium({ countsDropouts: false });
    localStorage.setItem('latencyMode', JSON.stringify('low'));
    await open();
    expect(screen.getByText(/If the sound crackles, choose Normal\./)).toBeInTheDocument();
  });

  it('shows the dropouts counted at low', async () => {
    setChromium();
    await open();
    expect(screen.queryByText(/Dropouts since/)).not.toBeInTheDocument();
    act(() => mockDropouts.next(0));
    const count = screen.getByText(/Dropouts since the page opened/);
    expect(count.lastElementChild).toHaveTextContent(/^0$/);
    expect(count.lastElementChild?.classList.contains('some')).toBe(false);

    // red once there is one
    act(() => mockDropouts.next(2));
    expect(count.lastElementChild).toHaveTextContent(/^2$/);
    expect(count.lastElementChild?.classList.contains('some')).toBe(true);
  });

  // the toast the warning shows (react-hot-toast is mocked: its content rendered by the spec)
  const warn = () => {
    render(<SettingsButton />);
    act(() => mockDropoutWarning.next(true));
    const [[content, options]] = jest.mocked(toast).mock.calls;
    expect(options).toEqual({ id: 'latency-dropouts', duration: Infinity });
    render(content as React.JSX.Element);
  };

  it('offers normal latency once there were too many dropouts', () => {
    warn();
    expect(
      screen.getByText(/The sound crackles\. Switch to Normal for a steady sound\?/)
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Normal' }));
    expect(switchToNormalLatency).toHaveBeenCalledTimes(1);
    expect(mockDismissDropoutWarning).toHaveBeenCalledTimes(1);
    expect(toast.dismiss).toHaveBeenCalledWith('latency-dropouts');
  });

  it('Not now leaves the latency and does not warn again', () => {
    warn();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(switchToNormalLatency).not.toHaveBeenCalled();
    expect(mockDropoutWarning.value).toBe(false);
    expect(toast).toHaveBeenCalledTimes(1);
  });
});
