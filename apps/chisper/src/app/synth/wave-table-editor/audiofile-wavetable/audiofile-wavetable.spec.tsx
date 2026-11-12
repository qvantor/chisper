import React from 'react';
import toast from 'react-hot-toast';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { createOscillator } from '../../../../test-utils/models';
import { ascii, chunk, data, fmt, riff } from '../../../../test-utils/wav-file';
import { OscillatorContext } from '../../oscillator/hooks';
import AudiofileTab from './index';

const WAVE = 2048;

// a WAV of mono 32 bit floats, with a clm mark or not
const wav = (samples: ArrayLike<number>, { mark, sampleRate }: { mark?: string; sampleRate?: number } = {}) =>
  riff(fmt({ sampleRate }), ...(mark ? [chunk('clm ', ascii(mark))] : []), data(Array.from(samples)));
// waves of their index over 4, each one constant
const waves = (count: number) =>
  Float32Array.from({ length: count * WAVE }, (_, i) => Math.floor(i / WAVE) / 4);
// (jsdom's File has no arrayBuffer)
const fileOf = (name: string, bytes: ArrayBuffer, type = '') =>
  Object.assign(new File([bytes], name, { type }), { arrayBuffer: () => Promise.resolve(bytes) });

const decodeAudioData = jest.fn((_buffer: ArrayBuffer) =>
  Promise.reject(new Error('Unable to decode audio data'))
);
beforeEach(() => {
  jest.mocked(toast.success).mockClear();
  jest.mocked(toast.error).mockClear();
  Object.assign(globalThis, { OfflineAudioContext: jest.fn(() => ({ decodeAudioData })) });
});
afterAll(() => {
  Reflect.deleteProperty(globalThis, 'OfflineAudioContext');
});

const setup = () => {
  const oscillator = createOscillator();
  const onWavetable = jest.fn();
  render(
    <OscillatorContext.Provider value={oscillator}>
      <AudiofileTab onWavetable={onWavetable} />
    </OscillatorContext.Provider>
  );
  const [model] = oscillator;
  const table = () => model.$waveTable.value.map(($wave) => $wave.value);
  return { model, table, onWavetable, user: userEvent.setup() };
};

const choose = async (user: ReturnType<typeof userEvent.setup>, file: File) => {
  await user.click(screen.getByRole('button', { name: 'Choose a file' }));
  await user.upload(screen.getByLabelText('Audio or wavetable file'), file);
};

describe('the Audio file tab of the wavetable editor', () => {
  it('offers a file by a click, not only by a drop', () => {
    setup();

    expect(screen.getByText('Drop an audio file or a WAV wavetable here')).toBeInTheDocument();
    expect(screen.getByText('Audio up to 12 seconds, a wavetable of up to 256 waves')).toBeInTheDocument();
    const input = screen.getByLabelText('Audio or wavetable file');
    expect(input).toHaveAttribute('type', 'file');
    expect(input.getAttribute('accept')).toContain('audio/*');
    expect(input.getAttribute('accept')).toContain('.wav');
  });

  it('plays a WAV wavetable as it is, its morph by its mark, and shows its waves', async () => {
    const { table, model, onWavetable, user } = setup();

    await choose(user, fileOf('Growl.wav', wav(waves(3), { mark: '<!>2048 10000000 wavetable' })));

    await waitFor(() => expect(onWavetable).toHaveBeenCalled());
    expect(table()).toEqual([0, 1, 2].map((i) => new Array(WAVE).fill(i / 4)));
    expect(model.$morph.value).toBe(true);
    expect(toast.success).toHaveBeenCalledWith('Growl.wav: a wavetable of 3 waves');
  });

  it('takes a WAV of whole 2048-sample waves without a mark as a table of its own waves', async () => {
    const { table, model, user } = setup();

    await choose(user, fileOf('single-cycle.wav', wav(waves(1), { sampleRate: 48000 }), 'audio/wav'));

    await waitFor(() => expect(table()).toEqual([new Array(WAVE).fill(0)]));
    expect(model.$morph.value).toBe(false);
    expect(toast.success).toHaveBeenCalledWith('single-cycle.wav: a wavetable of 1 wave');
  });

  it('cuts an audio file into waves, and goes back to the drop screen for another one', async () => {
    const { onWavetable, user } = setup();

    await choose(user, fileOf('voice.wav', wav(new Float32Array(44100).fill(0.5))));

    expect(await screen.findByText('W Count')).toBeInTheDocument();
    expect(onWavetable).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Another file' }));
    expect(screen.getByRole('button', { name: 'Choose a file' })).toBeInTheDocument();
  });

  it('tells why a file is not taken: too long, not audio, not decodable', async () => {
    const { user, onWavetable } = setup();

    await choose(user, fileOf('long.wav', wav(new Float32Array(8000 * 13), { sampleRate: 8000 })));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('long.wav is longer than 12 seconds'));

    await choose(user, fileOf('broken.mp3', ascii('ID3 broken').buffer as ArrayBuffer, 'audio/mpeg'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("broken.mp3 can't be read as audio"));

    expect(onWavetable).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Choose a file' })).toBeInTheDocument();
  });
});
