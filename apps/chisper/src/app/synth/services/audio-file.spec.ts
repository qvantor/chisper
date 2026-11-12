import { ascii, chunk, data, fmt, PCM, riff, wavetableFile } from '../../../test-utils/wav-file';
import { readAudioFile } from './audio-file';

const WAVE = 2048;
// waves of a ramp each, the value of a wave its index (exact in float32)
const waves = (count: number, size = WAVE) =>
  Float32Array.from(
    { length: count * size },
    (_, i) => Math.floor(i / size) / 1024 + (i % size) / (size * 4)
  );
const framesOf = (samples: Float32Array, size = WAVE) =>
  Array.from({ length: samples.length / size }, (_, i) => [...samples.subarray(i * size, (i + 1) * size)]);
// a WAV of mono 32 bit floats without a mark
const plainWav = (samples: ArrayLike<number>, sampleRate = 44100) =>
  riff(fmt({ sampleRate }), data(Array.from(samples)));
// a WAV with a mark of its own wave size and morph flag
const markedWav = (samples: ArrayLike<number>, mark: string) =>
  riff(fmt(), chunk('clm ', ascii(mark)), data(Array.from(samples)));

const decoded = Float32Array.from([0.5, -0.5, 0.25]);
const decodeAudioData = jest.fn((_buffer: ArrayBuffer) =>
  Promise.resolve({ sampleRate: 44100, getChannelData: () => decoded })
);
const OfflineAudioContextMock = jest.fn((_channels: number, _length: number, _sampleRate: number) => ({
  decodeAudioData,
}));

beforeEach(() => {
  decodeAudioData.mockClear();
  OfflineAudioContextMock.mockClear();
  Object.assign(globalThis, { OfflineAudioContext: OfflineAudioContextMock });
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, 'OfflineAudioContext');
});

describe('readAudioFile', () => {
  // decodeAudioData on the live context resampled a 44.1 kHz wavetable to 48 kHz: 1.09 cycles a wave
  it('reads a WAV as stored, at its own rate, without decoding it', async () => {
    const samples = Float32Array.from([0, 0.25, -0.5, 1, -1, 0.125]);

    expect(await readAudioFile(wavetableFile(samples, 44100))).toEqual({
      kind: 'audio',
      sampleRate: 44100,
      samples,
    });
    expect(await readAudioFile(wavetableFile(samples, 48000))).toEqual({
      kind: 'audio',
      sampleRate: 48000,
      samples,
    });
    expect(OfflineAudioContextMock).not.toHaveBeenCalled();
  });

  it('takes the first channel of a stereo WAV', async () => {
    const file = riff(
      fmt({ format: PCM, bits: 16, channels: 2 }),
      data([0x4000, -0x8000, -0x4000, 0], { format: PCM, bits: 16 })
    );

    expect(await readAudioFile(file)).toEqual({
      kind: 'audio',
      sampleRate: 44100,
      samples: Float32Array.from([0.5, -0.5]),
    });
  });

  it('decodes other formats at 44.1 kHz, whatever the rate of the audio context', async () => {
    const file = ascii('OggS vorbis').buffer;

    expect(await readAudioFile(file)).toEqual({ kind: 'audio', sampleRate: 44100, samples: decoded });
    expect(OfflineAudioContextMock).toHaveBeenCalledWith(1, 1, 44100);
    expect(decodeAudioData).toHaveBeenCalledWith(file);
  });

  it('decodes a WAV the parser does not read', async () => {
    // 4 bit ADPCM
    const file = riff(fmt({ format: 2, bits: 4 }), data([1, 2, 3, 4]));

    expect(await readAudioFile(file)).toEqual({ kind: 'audio', sampleRate: 44100, samples: decoded });
    expect(decodeAudioData).toHaveBeenCalledWith(file);
  });

  it('decodes the samples that are not finite as 0', async () => {
    decodeAudioData.mockResolvedValueOnce({
      sampleRate: 44100,
      getChannelData: () => Float32Array.from([0.5, NaN, Infinity, -Infinity, -0.5]),
    });

    expect(await readAudioFile(ascii('OggS vorbis').buffer)).toMatchObject({
      samples: Float32Array.from([0.5, 0, 0, 0, -0.5]),
    });
  });

  it('fails when the file cannot be decoded', async () => {
    decodeAudioData.mockRejectedValueOnce(new Error('Unable to decode audio data'));

    await expect(readAudioFile(ascii('text').buffer)).rejects.toThrow('Unable to decode audio data');
  });
});

describe('readAudioFile of a WAV wavetable', () => {
  it('takes the waves of a table with a mark as they are, its morph by the mark', async () => {
    const samples = waves(3);

    expect(await readAudioFile(wavetableFile(samples))).toEqual({
      kind: 'wavetable',
      wavetable: { frames: framesOf(samples), morph: true },
      frames: 3,
    });
    expect(await readAudioFile(markedWav(samples, '<!>2048 00000000 table'))).toMatchObject({
      wavetable: { morph: false },
    });
  });

  it('cuts the waves at the size of the mark, a rest shorter than a wave left out', async () => {
    const samples = waves(5, 1024);

    expect(await readAudioFile(markedWav([...samples, 0.5, 0.5], '<!>1024 10000000'))).toEqual({
      kind: 'wavetable',
      wavetable: { frames: framesOf(samples, 1024), morph: true },
      frames: 5,
    });
  });

  // the tables of other synths and of wavetable packs often have no mark
  it('takes a WAV of whole 2048-sample waves without a mark as a table of its own frames', async () => {
    const samples = waves(4);

    expect(await readAudioFile(plainWav(samples, 48000))).toEqual({
      kind: 'wavetable',
      wavetable: { frames: framesOf(samples), morph: false },
      frames: 4,
    });
    expect(await readAudioFile(plainWav(waves(1)))).toMatchObject({ kind: 'wavetable', frames: 1 });
  });

  it('takes a WAV without a mark that is no whole number of waves, or longer than 256, as audio', async () => {
    expect(await readAudioFile(plainWav(new Float32Array(WAVE * 3 + 1)))).toMatchObject({ kind: 'audio' });
    expect(await readAudioFile(plainWav(new Float32Array(WAVE * 257)))).toMatchObject({ kind: 'audio' });
    expect(await readAudioFile(plainWav(new Float32Array(0)))).toMatchObject({ kind: 'audio' });
  });

  it('keeps the first 256 waves of a longer table with a mark and tells how many it had', async () => {
    const file = await readAudioFile(markedWav(waves(300, 16), '<!>16 00000000'));

    expect(file).toMatchObject({ kind: 'wavetable', frames: 300 });
    expect(file.kind === 'wavetable' && file.wavetable.frames).toHaveLength(256);
  });

  it('takes a table with a mark shorter than one wave as audio', async () => {
    expect(await readAudioFile(wavetableFile(new Float32Array(100)))).toMatchObject({ kind: 'audio' });
  });
});
