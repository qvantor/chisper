import { bytesText, bytesView, riffChunks } from '../../../test-utils/wav-chunks';
import { concat } from '../../../test-utils/wav-file';
import { seeded } from '../common/engine/seeded';
import { parseWavChannels } from './wav';
import { createWavWriter, WavChunk, WavFormat, wavBytes } from './wav-writer';

const RATE = 48000;

const ramp = (n: number, scale = 1) => Float32Array.from({ length: n }, (_, i) => (scale * (i - n / 2)) / n);

const fileOf = (
  format: WavFormat,
  left: Float32Array,
  right: Float32Array,
  keep?: number,
  chunks?: WavChunk[]
) => {
  const writer = createWavWriter({ sampleRate: RATE, format, random: seeded(1) });
  // (in blocks of 128, the last one shorter)
  for (let at = 0; at < left.length; at += 128)
    writer.write(left.subarray(at, at + 128), right.subarray(at, at + 128));
  return concat(...writer.finish(keep, chunks));
};

const CHUNKS: WavChunk[] = [
  { id: 'odd ', body: Uint8Array.of(1, 2, 3) },
  { id: 'even', body: Uint8Array.of(4, 5, 6, 7) },
];

describe('createWavWriter', () => {
  it.each<[WavFormat, number, number, number]>([
    ['pcm24', 1, 24, 44],
    ['pcm16', 1, 16, 44],
    ['float32', 3, 32, 58],
  ])('writes the header of %s: format %i, %i bits, the data after %i bytes', (format, code, bits, data) => {
    const bytes = fileOf(format, ramp(300), ramp(300));
    const header = bytesView(bytes);
    expect(bytesText(bytes, 0, 4)).toBe('RIFF');
    expect(header.getUint32(4, true)).toBe(bytes.length - 8);
    expect(bytesText(bytes, 8, 4)).toBe('WAVE');
    expect(bytesText(bytes, 12, 4)).toBe('fmt ');
    expect(header.getUint16(20, true)).toBe(code);
    expect(header.getUint16(22, true)).toBe(2);
    expect(header.getUint32(24, true)).toBe(RATE);
    expect(header.getUint32(28, true)).toBe((RATE * 2 * bits) / 8);
    expect(header.getUint16(32, true)).toBe((2 * bits) / 8);
    expect(header.getUint16(34, true)).toBe(bits);
    expect(bytesText(bytes, data - 8, 4)).toBe('data');
    expect(header.getUint32(data - 4, true)).toBe((300 * 2 * bits) / 8);
    expect(bytes.length).toBe(data + (300 * 2 * bits) / 8);
    if (format === 'float32') {
      expect(bytesText(bytes, 38, 4)).toBe('fact');
      expect(header.getUint32(46, true)).toBe(300);
    }
  });

  it('a float file reads back as written, NaN and the infinities as 0', () => {
    const left = ramp(1000, 3);
    const right = ramp(1000, -0.5);
    left[10] = NaN;
    right[20] = Infinity;
    left[30] = -Infinity;
    const { channels, sampleRate } = parseWavChannels(fileOf('float32', left, right).buffer);
    expect(sampleRate).toBe(RATE);
    const expected = left.map((x) => (Number.isFinite(x) ? x : 0));
    expect(channels[0]).toEqual(expected);
    expect(channels[1]).toEqual(right.map((x) => (Number.isFinite(x) ? x : 0)));
  });

  it('24 bits: the nearest step, clipped to ±1', () => {
    const left = Float32Array.from([0, 0.5, -0.5, 1, -1, 2, -2, NaN, 1e-7]);
    const { channels } = parseWavChannels(fileOf('pcm24', left, left).buffer);
    expect(channels[0]).toEqual(
      Float32Array.from([0, 0.5, -0.5, 8388607 / 8388608, -1, 8388607 / 8388608, -1, 0, 1 / 8388608])
    );
  });

  it('16 bits: dithered within ±1 step of the nearest one, clipped to ±1', () => {
    const left = ramp(4000, 2.4);
    const bytes = fileOf('pcm16', left, left);
    const data = bytesView(bytes);
    let steps = 0;
    for (let i = 0; i < left.length; i++) {
      const value = data.getInt16(44 + i * 4, true);
      const nearest = Math.round(Math.max(-1, Math.min(1, left[i])) * 32768);
      expect(Math.abs(value - Math.max(-32768, Math.min(32767, nearest)))).toBeLessThanOrEqual(1);
      expect(value).toBeGreaterThanOrEqual(-32768);
      expect(value).toBeLessThanOrEqual(32767);
      if (value !== nearest) steps += 1;
    }
    // (a dither: off the nearest step now and then)
    expect(steps).toBeGreaterThan(100);
    // the same seed, the same file
    expect(fileOf('pcm16', left, left)).toEqual(bytes);
  });

  it('keeps the frames asked for: the parts cut, the header of the frames kept', () => {
    const left = ramp(1000);
    const whole = fileOf('pcm24', left, left);
    const cut = fileOf('pcm24', left, left, 300);
    expect(cut.length).toBe(44 + 300 * 6);
    expect(bytesView(cut).getUint32(40, true)).toBe(300 * 6);
    expect(cut.subarray(44)).toEqual(whole.subarray(44, 44 + 300 * 6));
    expect(fileOf('pcm24', left, left, 5000).length).toBe(whole.length);
    expect(fileOf('pcm24', left, left, 0).length).toBe(44);
  });

  it.each<WavFormat>(['pcm24', 'pcm16', 'float32'])(
    'tells the size of a file of %s before it is made, with chunks or without',
    (format) => {
      for (const frames of [0, 300, 1000]) {
        expect(wavBytes(format, frames)).toBe(fileOf(format, ramp(frames), ramp(frames)).length);
        expect(wavBytes(format, frames, CHUNKS)).toBe(
          fileOf(format, ramp(frames), ramp(frames), undefined, CHUNKS).length
        );
      }
    }
  );

  it.each<[WavFormat, string[]]>([
    ['pcm24', ['fmt ', 'odd ', 'even', 'data']],
    ['float32', ['fmt ', 'fact', 'odd ', 'even', 'data']],
  ])(
    'puts the chunks of %s in their order between fmt and data: an odd one padded, its size its own',
    (format, ids) => {
      const left = ramp(300);
      const right = ramp(300, -1);
      const plain = fileOf(format, left, right);
      const bytes = fileOf(format, left, right, 200, CHUNKS);
      const chunks = riffChunks(bytes);
      expect(chunks.map(({ id }) => id)).toEqual(ids);
      const [odd, even] = chunks.filter(({ id }) => id === 'odd ' || id === 'even');
      expect(odd.size).toBe(3);
      expect(bytes.subarray(odd.at, odd.at + 3)).toEqual(Uint8Array.of(1, 2, 3));
      // (the pad byte, then the next chunk)
      expect(bytes[odd.at + 3]).toBe(0);
      expect(even.at).toBe(odd.at + 4 + 8);
      expect(bytes.subarray(even.at, even.at + 4)).toEqual(Uint8Array.of(4, 5, 6, 7));
      // the RIFF counts the pad byte, the data is the frames kept
      expect(bytesView(bytes).getUint32(4, true)).toBe(bytes.length - 8);
      const data = chunks[chunks.length - 1];
      const frameBytes = bytesView(plain).getUint16(32, true);
      expect(data.size).toBe(200 * frameBytes);
      expect(bytes.length).toBe(data.at + data.size);
      const plainData = plain.length - 300 * frameBytes;
      expect(bytes.subarray(data.at)).toEqual(plain.subarray(plainData, plainData + data.size));
      if (format === 'float32') expect(bytesView(bytes).getUint32(chunks[1].at, true)).toBe(200);
      // read back as written
      expect(parseWavChannels(bytes.buffer).channels).toEqual(
        parseWavChannels(fileOf(format, left, right, 200).buffer).channels
      );
    }
  );
});
