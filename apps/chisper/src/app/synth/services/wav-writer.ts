import { number } from '@chisper/math';

// the formats of a file: 24-bit PCM, 16-bit PCM (dithered), 32-bit float
export type WavFormat = 'pcm24' | 'pcm16' | 'float32';

const PCM = 1;
const FLOAT = 3;
const CHANNELS = 2;
const BYTES: Record<WavFormat, number> = { pcm24: 3, pcm16: 2, float32: 4 };
// the fmt chunk: a float has a cbSize of its own in it and a fact chunk after it
const FMT_BYTES: Record<WavFormat, number> = { pcm24: 16, pcm16: 16, float32: 18 };
const FACT_BYTES: Record<WavFormat, number> = { pcm24: 0, pcm16: 0, float32: 12 };

// a chunk of the header of its own (metadata: wav-metadata.ts), its body as it is (the pad byte of an odd one is the
// writer's)
export interface WavChunk {
  id: string;
  body: Uint8Array;
}

// the bytes of a chunk in a file: its head, its body and the pad byte of an odd one (counted in the size of the RIFF,
// not in its own)
const chunkLength = ({ body }: WavChunk) => 8 + body.length + (body.length % 2);
const chunksBytes = (chunks: readonly WavChunk[]) =>
  chunks.reduce((sum, chunk) => sum + chunkLength(chunk), 0);

// a chunk as it is in a file: its id, the size of its body, the body, the pad byte of an odd one
export const chunkBytes = (chunk: WavChunk) => {
  const bytes = new Uint8Array(chunkLength(chunk));
  bytes.set(Uint8Array.from(chunk.id, (char) => char.charCodeAt(0)));
  new DataView(bytes.buffer).setUint32(4, chunk.body.length, true);
  bytes.set(chunk.body, 8);
  return bytes;
};

// RIFF, the head of fmt, its body, fact, the chunks, the head of data
const headerBytes = (format: WavFormat, chunks: readonly WavChunk[]) =>
  12 + 8 + FMT_BYTES[format] + FACT_BYTES[format] + chunksBytes(chunks) + 8;

// the bytes of a file of `frames` frames with `chunks` (its size before it is made: Export WAV shows it)
export const wavBytes = (format: WavFormat, frames: number, chunks: readonly WavChunk[] = []) =>
  headerBytes(format, chunks) + frames * CHANNELS * BYTES[format];

export interface WavWriterOptions {
  sampleRate: number;
  format: WavFormat;
  // the noise of the dither of 16 bits (a seed: the same file twice)
  random?: () => number;
}

// NaN and the infinities as 0
const finite = (x: number) => (Number.isFinite(x) ? x : 0);
const { thresholds: clamp } = number;

// The samples of a stereo WAV (RIFF/WAVE), block by block: each block encoded at once into a part of its own (no
// buffer of the whole file), the header made last (finish: the frames kept, an end cut, the chunks of metadata
// between fmt and data). PCM clipped to ±1, 16 bits with a TPDF dither of ±1 LSB, a float as it is; NaN and the
// infinities as 0
export const createWavWriter = ({ sampleRate, format, random = Math.random }: WavWriterOptions) => {
  const bytes = BYTES[format];
  const frameBytes = CHANNELS * bytes;
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let frames = 0;

  const encode = (view: DataView, at: number, sample: number) => {
    const x = finite(sample);
    if (format === 'float32') view.setFloat32(at, x, true);
    else if (format === 'pcm16') {
      const dither = random() - random();
      view.setInt16(at, clamp(Math.round(clamp(x, -1, 1) * 32768 + dither), -32768, 32767), true);
    } else {
      const value = clamp(Math.round(clamp(x, -1, 1) * 8388608), -8388608, 8388607);
      view.setUint8(at, value & 0xff);
      view.setUint8(at + 1, (value >> 8) & 0xff);
      view.setUint8(at + 2, (value >> 16) & 0xff);
    }
  };

  const header = (kept: number, chunks: readonly WavChunk[]) => {
    const data = kept * frameBytes;
    const float = format === 'float32';
    const fmt = FMT_BYTES[format];
    const size = headerBytes(format, chunks);
    const head = new Uint8Array(size);
    const view = new DataView(head.buffer);
    const text = (at: number, value: string) =>
      [...value].forEach((char, i) => view.setUint8(at + i, char.charCodeAt(0)));
    text(0, 'RIFF');
    view.setUint32(4, size - 8 + data, true);
    text(8, 'WAVE');
    text(12, 'fmt ');
    view.setUint32(16, fmt, true);
    view.setUint16(20, float ? FLOAT : PCM, true);
    view.setUint16(22, CHANNELS, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * frameBytes, true);
    view.setUint16(32, frameBytes, true);
    view.setUint16(34, bytes * 8, true);
    let at = 36;
    if (float) {
      view.setUint16(at, 0, true);
      at += 2;
      text(at, 'fact');
      view.setUint32(at + 4, 4, true);
      view.setUint32(at + 8, kept, true);
      at += 12;
    }
    for (const chunk of chunks) {
      const bytes = chunkBytes(chunk);
      head.set(bytes, at);
      at += bytes.length;
    }
    text(at, 'data');
    view.setUint32(at + 4, data, true);
    return head;
  };

  return {
    // a block of both channels (the length of the left one)
    write: (left: Float32Array, right: Float32Array) => {
      const n = left.length;
      const part = new Uint8Array(n * frameBytes);
      const view = new DataView(part.buffer);
      for (let i = 0; i < n; i++) {
        encode(view, i * frameBytes, left[i]);
        encode(view, i * frameBytes + bytes, right[i]);
      }
      parts.push(part);
      frames += n;
    },
    // the bytes of the file, the header first (`chunks` in it, in their order, before the data): the first `keep`
    // frames written (all by default)
    finish: (keep = frames, chunks: readonly WavChunk[] = []): Uint8Array<ArrayBuffer>[] => {
      const kept = Math.max(0, Math.min(frames, Math.floor(keep)));
      const out = [header(kept, chunks)];
      let left = kept * frameBytes;
      for (const part of parts) {
        if (left <= 0) break;
        out.push(part.length <= left ? part : part.subarray(0, left));
        left -= part.length;
      }
      return out;
    },
  };
};
