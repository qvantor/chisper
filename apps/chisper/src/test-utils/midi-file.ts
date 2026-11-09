import { CLIP_PPQ, ClipNote } from '@chisper/preset-schema';

// a Standard MIDI File of format 1 at CLIP_PPQ ticks a quarter: a track of each part (its name, its notes on its
// channel 1..16), the tempo in the first one. Names in ASCII

export interface SongPart {
  name: string;
  channel?: number;
  notes: ClipNote[];
}

// the bytes of a file: a variable-length quantity, ASCII, big-endian integers, a chunk
export const vlq = (value: number) => {
  const bytes = [value & 0x7f];
  for (let rest = value >> 7; rest > 0; rest >>= 7) bytes.unshift((rest & 0x7f) | 0x80);
  return bytes;
};
export const ascii = (text: string) => Array.from(text, (char) => char.charCodeAt(0));
export const u16 = (value: number) => [(value >> 8) & 0xff, value & 0xff];
export const u32 = (value: number) => [...u16(value >>> 16), ...u16(value & 0xffff)];
export const chunk = (id: string, data: number[]) => [...ascii(id), ...u32(data.length), ...data];

export const songFile = (parts: SongPart[], bpm = 120) => {
  const micros = Math.round(60e6 / bpm);
  const tracks = parts.map(({ name, channel = 1, notes }, index) => {
    // [tick, status, pitch, velocity]: the offs of a tick before its ons
    const events = notes
      .flatMap(([start, duration, pitch, velocity]) => [
        [start, 0x90 | (channel - 1), pitch, velocity],
        [start + duration, 0x80 | (channel - 1), pitch, 64],
      ])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let last = 0;
    return chunk('MTrk', [
      ...(index === 0 ? [0, 0xff, 0x51, 3, (micros >> 16) & 0xff, (micros >> 8) & 0xff, micros & 0xff] : []),
      ...[0, 0xff, 0x03, ...vlq(name.length), ...ascii(name)],
      ...events.flatMap(([tick, ...bytes]) => {
        const delta = tick - last;
        last = tick;
        return [...vlq(delta), ...bytes];
      }),
      ...[0, 0xff, 0x2f, 0],
    ]);
  });
  return new Uint8Array([
    ...chunk('MThd', [...u16(1), ...u16(parts.length), ...u16(CLIP_PPQ)]),
    ...tracks.flat(),
  ]);
};
