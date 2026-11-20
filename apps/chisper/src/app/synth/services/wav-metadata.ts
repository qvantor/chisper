import { typedArray } from '@chisper/math';
import { chunkBytes, type WavChunk } from './wav-writer';

// The chunks of metadata of a WAV (wav-writer.ts puts them between fmt and data, in the order given): its tempo
// (acid), its loop (smpl), its origin (bext of the EBU), the tags of RIFF (LIST/INFO) and of ID3 (id3). Each the body
// of its chunk, little endian as RIFF but ID3 (big endian, as in an MP3)

// the bytes of text whose characters are each one byte already (ASCII, ISO-8859-1)
const bytesOf = (value: string) => Uint8Array.from(value, (char) => char.charCodeAt(0) & 0xff);

const { concat } = typedArray;

// text as ASCII, printable: the marks of a letter dropped (é: e), any other character as ? (one a character, an
// emoji too). bext is ASCII; INFO is read in the code page of the system (Windows): its other bytes are other letters
export const asciiText = (value: string) =>
  value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\x20-\x7e]/gu, '?');

const two = (value: number) => String(value).padStart(2, '0');
// the local date and time: 2026-11-20, 14:05:09
export const localDate = (date: Date) =>
  `${String(date.getFullYear()).padStart(4, '0')}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
const localTime = (date: Date) =>
  `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;

// the flags of acid: one played as it is (not looped, its tempo not followed), one stretched to the tempo
export const ACID_ONE_SHOT = 0x01;
export const ACID_STRETCH = 0x04;

// the tempo of a file (ACID, as FL Studio writes and reads it): its beats in 4/4 at `tempo` BPM, a loop stretched to
// the tempo of a project. A file not a whole number of beats long is a one-shot (a reader that works the tempo out
// of the beats and the length would get it wrong), its tempo still told; no root note (a DAW would transpose by it)
export const acidChunk = ({ tempo, beats }: { tempo: number; beats: number }): WavChunk => {
  const body = new Uint8Array(24);
  const view = new DataView(body.buffer);
  view.setUint32(0, ACID_STRETCH | (Number.isInteger(beats) ? 0 : ACID_ONE_SHOT), true);
  // the root note (not set: middle C), two fields of ACID's own as it writes them
  view.setUint16(4, 60, true);
  view.setUint16(6, 0x8000, true);
  view.setFloat32(8, 0, true);
  view.setUint32(12, Math.max(1, Math.round(beats)), true);
  // the meter: its denominator first
  view.setUint16(16, 4, true);
  view.setUint16(18, 4, true);
  view.setFloat32(20, tempo, true);
  return { id: 'acid', body };
};

// a sampler's chunk: one loop forward over the whole file, for ever (its end the last frame played: inclusive), at
// the pitch of C4 (the file is not tuned to a note)
export const smplChunk = ({ sampleRate, frames }: { sampleRate: number; frames: number }): WavChunk => {
  const body = new Uint8Array(60);
  const view = new DataView(body.buffer);
  // (no manufacturer, no product) the period of a sample in ns, the unity note
  view.setUint32(8, Math.floor(1e9 / sampleRate), true);
  view.setUint32(12, 60, true);
  // (no fraction of the pitch, no SMPTE) one loop, no data of a sampler
  view.setUint32(28, 1, true);
  // the loop: its id, forward, from the first frame to the last, no fraction, for ever
  view.setUint32(48, Math.max(0, frames - 1), true);
  return { id: 'smpl', body };
};

// the fields of a bext (EBU Tech 3285 v2): the description, the originator, its reference, the date, the time
const BEXT = { description: 256, originator: 32, reference: 32, date: 10, time: 8 };
// the loudness not worked out
const LOUDNESS_UNKNOWN = 0x7fff;

// the origin of a file (Broadcast WAV, version 2): a description and who made it when (the local time), no time
// reference, no UMID, no loudness, no coding history. ASCII, each field cut to its size
export const bextChunk = ({
  description,
  originator,
  date,
}: {
  description: string;
  originator: string;
  date: Date;
}): WavChunk => {
  const body = new Uint8Array(602);
  const view = new DataView(body.buffer);
  let at = 0;
  const field = (size: number, value = '') => {
    body.set(bytesOf(asciiText(value).slice(0, size)), at);
    at += size;
  };
  field(BEXT.description, description);
  field(BEXT.originator, originator);
  field(BEXT.reference);
  field(BEXT.date, localDate(date));
  field(BEXT.time, localTime(date));
  // (the time reference: 0) the version
  view.setUint16(346, 2, true);
  // (the UMID: none) the 5 values of the loudness, then 180 bytes reserved
  for (let i = 0; i < 5; i++) view.setInt16(412 + 2 * i, LOUDNESS_UNKNOWN, true);
  return { id: 'bext', body };
};

// the tags of RIFF (LIST/INFO): each its id (INAM, IART, …) and its text, ASCII, ended by a NUL counted in its size,
// a pad byte after an odd one; an empty one left out
export const infoChunk = (entries: readonly (readonly [string, string])[]): WavChunk => ({
  id: 'LIST',
  body: concat([
    bytesOf('INFO'),
    ...entries
      .filter(([, value]) => value)
      .map(([id, value]) => chunkBytes({ id, body: concat([bytesOf(asciiText(value)), Uint8Array.of(0)]) })),
  ]),
});

// the encoding of ID3 text: ISO-8859-1 (0) where every character is one of it, else UTF-16 with its BOM (1)
const LATIN1 = 0;
const UTF16 = 1;
const encodingOf = (value: string) =>
  [...value].every((char) => char.charCodeAt(0) <= 0xff) ? LATIN1 : UTF16;

// text in an encoding of ID3 (`ended`: its terminator after it)
const encoded = (value: string, encoding: number, ended = false) => {
  if (encoding === LATIN1) return concat([bytesOf(value), new Uint8Array(ended ? 1 : 0)]);
  const bytes = new Uint8Array(2 + 2 * value.length + (ended ? 2 : 0));
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0xfeff, true);
  for (let i = 0; i < value.length; i++) view.setUint16(2 + 2 * i, value.charCodeAt(i), true);
  return bytes;
};

// a frame of ID3v2.3: its id, the size of its body (32 bits big endian: not synchsafe in v2.3), no flags
const frame = (id: string, body: Uint8Array) => {
  const bytes = new Uint8Array(10 + body.length);
  bytes.set(bytesOf(id));
  new DataView(bytes.buffer).setUint32(4, body.length);
  bytes.set(body, 10);
  return bytes;
};

interface Id3Tags {
  // text frames: each its id (TIT2, TPE1, …) and its text (an empty one left out)
  text: readonly (readonly [string, string])[];
  // a comment (COMM, in English, no description)
  comment?: string;
  // the webpage of the source of the sound (WOAS)
  url?: string;
  // the front cover (APIC)
  picture?: { mime: string; data: Uint8Array };
}

// the tags of ID3v2.3 in a chunk `id3 ` (in lower case: as Audacity writes it, some readers take no other), no
// padding, no unsynchronisation
export const id3Chunk = ({ text, comment, url, picture }: Id3Tags): WavChunk => {
  const frames = text
    .filter(([, value]) => value)
    .map(([id, value]) => {
      const encoding = encodingOf(value);
      return frame(id, concat([Uint8Array.of(encoding), encoded(value, encoding)]));
    });
  if (comment) {
    const encoding = encodingOf(comment);
    frames.push(
      frame(
        'COMM',
        concat([
          Uint8Array.of(encoding),
          bytesOf('eng'),
          encoded('', encoding, true),
          encoded(comment, encoding),
        ])
      )
    );
  }
  if (url) frames.push(frame('WOAS', bytesOf(url)));
  if (picture)
    frames.push(
      frame(
        'APIC',
        // ISO-8859-1, its MIME type, a front cover, no description
        concat([
          Uint8Array.of(LATIN1),
          encoded(picture.mime, LATIN1, true),
          Uint8Array.of(3, 0),
          picture.data,
        ])
      )
    );
  const body = concat(frames);
  const size = body.length;
  // ID3, version 2.3.0, no flags, the size of the frames synchsafe (7 bits a byte)
  const header = Uint8Array.of(
    0x49,
    0x44,
    0x33,
    3,
    0,
    0,
    (size >> 21) & 0x7f,
    (size >> 14) & 0x7f,
    (size >> 7) & 0x7f,
    size & 0x7f
  );
  return { id: 'id3 ', body: concat([header, body]) };
};
