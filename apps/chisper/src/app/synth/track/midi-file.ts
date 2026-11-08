import {
  CLIP_LENGTH_MAX,
  CLIP_NAME_MAX_LENGTH,
  CLIP_NOTES_MAX,
  CLIP_PPQ,
  Clip,
  ClipNote,
  TEMPO_DEFAULT,
  clipNameAllowed,
  clipNameSchema,
  normalizeClip,
  normalizeName,
  tempoOf,
} from '@chisper/preset-schema';
import { DRUM_CHANNEL, DRUMS, GM_PROGRAMS } from './gm-programs';
import { notesEnd, withinPitches, withLength } from './track-edit';
import { playedNotes, playOrder } from './track-events';

// Standard MIDI Files of a clip: the notes of the parts of a file (each track and channel; its ticks rescaled to
// CLIP_PPQ) into a clip, a clip into a file of one track. No DOM: bytes in, bytes out

export class MidiFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MidiFileError';
  }
}

const truncated = () => new MidiFileError('The MIDI file is truncated');

const NOTE_OFF = 0x80;
const NOTE_ON = 0x90;
const PROGRAM_CHANGE = 0xc0;
const CHANNEL_PRESSURE = 0xd0;
const META = 0xff;
const SYSEX = 0xf0;
// a sysex continued (or an escape of any bytes): skipped by its length as a sysex
const SYSEX_ESCAPE = 0xf7;
const META_TEXT = 0x01;
const META_TRACK_NAME = 0x03;
const META_INSTRUMENT_NAME = 0x04;
const META_DEVICE_NAME = 0x09;
const META_CHANNEL_PREFIX = 0x20;
const META_END_OF_TRACK = 0x2f;
const META_TEMPO = 0x51;
const META_TIME_SIGNATURE = 0x58;
// the velocity of the note offs of a file written
const RELEASE_VELOCITY = 64;
// the name of a file and of its track for a clip without a name
const UNNAMED = 'clip';
// the Text of a file written, where it was made: ASCII, as an older reader takes it in Latin-1
const MADE_WITH = 'Made with Chisper wavetable synth - https://chisper.qvantor.org';
// the Device Name of a file written: a file of Chisper, its End of Track the loop to the tick
const DEVICE_NAME = 'Chisper';
// the bytes of a Track Name read: a name longer than CLIP_NAME_MAX_LENGTH is cut anyway
const NAME_BYTES = 256;

// the bytes of a file, read with their bounds checked: past them the file is truncated
class Cursor {
  pos: number;
  private readonly bytes: Uint8Array;
  private readonly end: number;

  constructor(bytes: Uint8Array, pos: number, end: number) {
    this.bytes = bytes;
    this.pos = pos;
    this.end = end;
  }

  more() {
    return this.pos < this.end;
  }

  byte() {
    if (this.pos >= this.end) throw truncated();
    return this.bytes[this.pos++];
  }

  take(count: number) {
    if (this.pos + count > this.end) throw truncated();
    this.pos += count;
    return this.bytes.subarray(this.pos - count, this.pos);
  }

  uint16() {
    return (this.byte() << 8) | this.byte();
  }

  uint32() {
    return this.uint16() * 0x10000 + this.uint16();
  }

  text(count: number) {
    return String.fromCharCode(...this.take(count));
  }

  // a variable-length quantity: 7 bits a byte, the high bit on all but the last, 4 bytes at most
  varint() {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      const byte = this.byte();
      value = value * 0x80 + (byte & 0x7f);
      if (!(byte & 0x80)) return value;
    }
    throw new MidiFileError('The MIDI file has a number longer than 4 bytes');
  }
}

// a note of a track, in the ticks of its file; its channel 0..15
interface FileNote {
  start: number;
  end: number;
  pitch: number;
  velocity: number;
  channel: number;
}

interface Track {
  notes: FileNote[];
  // the Set Tempo events: their tick and microseconds a quarter note
  tempos: { time: number; micros: number }[];
  // the first Track Name and the first Instrument Name that aren't blank (not under a Channel Prefix)
  name?: string;
  instrument?: string;
  // by channel: the first Track Name or Instrument Name under a Channel Prefix of it that isn't blank
  channelNames: Map<number, string>;
  // by channel: its first Program Change
  programs: Map<number, number>;
  // its first Device Name
  device?: string;
  // its End of Track (without one its last event)
  end: number;
}

const isControl = (code: number) => code < 0x20 || (code >= 0x7f && code < 0xa0);

// the text of a meta event: UTF-8 where it is valid, else Latin-1 (older files); its first NAME_BYTES, not cut
// inside a character of UTF-8
const textOf = (data: Uint8Array) => {
  let length = Math.min(data.length, NAME_BYTES);
  while (length > 0 && length < data.length && (data[length] & 0xc0) === 0x80) length--;
  const bytes = data.subarray(0, length);
  let text: string;
  try {
    text = decodeURIComponent(Array.from(bytes, (byte) => `%${byte.toString(16).padStart(2, '0')}`).join(''));
  } catch {
    text = String.fromCharCode(...bytes);
  }
  return Array.from(text, (char) => (isControl(char.charCodeAt(0)) ? ' ' : char)).join('');
};

// the name of a clip from a Track Name: its whitespace collapsed, cut to CLIP_NAME_MAX_LENGTH; none when it is
// empty or one a clip can't be saved under (the profanity filter refuses it): the notes are imported all the same
const clipNameOf = (text: string) => {
  let name = normalizeName(text).slice(0, CLIP_NAME_MAX_LENGTH);
  // not half of a character of two code units
  const last = name.charCodeAt(name.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) name = name.slice(0, -1);
  const parsed = clipNameSchema.safeParse(name);
  return parsed.success && parsed.data && clipNameAllowed(parsed.data) ? parsed.data : undefined;
};

// the events of an MTrk chunk. A note off ends the earliest note on of its channel and pitch still open (FIFO,
// so overlapping notes of a pitch keep their own ends), a note on of velocity 0 is a note off; the notes still
// open end at the end of the track. A Channel Prefix makes the names after it those of its channel, up to the next
// channel message or prefix
const readTrack = (cursor: Cursor): Track => {
  const notes: FileNote[] = [];
  const tempos: Track['tempos'] = [];
  let name: string | undefined;
  let instrument: string | undefined;
  let device: string | undefined;
  const channelNames = new Map<number, string>();
  const programs = new Map<number, number>();
  let prefix: number | null = null;
  // the notes on not off yet by channel and pitch (channel · 128 + pitch), the earliest first
  const open = new Map<number, { start: number; velocity: number }[]>();
  let time = 0;
  // running status: the status of the last channel message, which a data byte goes on with. Meta events and
  // sysex keep it (the standard ends it there, a file that leans on it anyway still reads)
  let status = 0;
  while (cursor.more()) {
    time += cursor.varint();
    const first = cursor.byte();
    if (first === META) {
      const type = cursor.byte();
      const data = cursor.take(cursor.varint());
      if (type === META_END_OF_TRACK) break;
      if (type === META_TEMPO && data.length >= 3) {
        const micros = (data[0] << 16) | (data[1] << 8) | data[2];
        if (micros > 0) tempos.push({ time, micros });
      }
      if (type === META_CHANNEL_PREFIX && data.length >= 1) prefix = data[0] & 0x0f;
      if (type === META_DEVICE_NAME) device ??= textOf(data);
      if (type === META_TRACK_NAME || type === META_INSTRUMENT_NAME) {
        const text = textOf(data);
        if (!text.trim()) continue;
        if (prefix !== null) {
          if (!channelNames.has(prefix)) channelNames.set(prefix, text);
        } else if (type === META_TRACK_NAME) name ??= text;
        else instrument ??= text;
      }
      continue;
    }
    if (first === SYSEX || first === SYSEX_ESCAPE) {
      cursor.take(cursor.varint());
      continue;
    }
    // the system common and real-time messages have no place in a file: their lengths aren't its own
    if (first > SYSEX)
      throw new MidiFileError(`The MIDI file has an event of status 0x${first.toString(16)}`);
    if (first & 0x80) status = first;
    else if (!status) throw new MidiFileError('The MIDI file has a data byte without a status');
    prefix = null;
    const kind = status & 0xf0;
    const channel = status & 0x0f;
    const data1 = (first & 0x80 ? cursor.byte() : first) & 0x7f;
    // program change and channel pressure have one data byte, the others two
    const data2 = kind === PROGRAM_CHANGE || kind === CHANNEL_PRESSURE ? 0 : cursor.byte() & 0x7f;
    if (kind === PROGRAM_CHANGE && !programs.has(channel)) programs.set(channel, data1);
    if (kind !== NOTE_ON && kind !== NOTE_OFF) continue;
    const key = channel * 128 + data1;
    if (kind === NOTE_ON && data2 > 0) {
      const queue = open.get(key);
      if (queue) queue.push({ start: time, velocity: data2 });
      else open.set(key, [{ start: time, velocity: data2 }]);
      continue;
    }
    const on = open.get(key)?.shift();
    if (on) notes.push({ start: on.start, end: time, pitch: data1, velocity: on.velocity, channel });
  }
  for (const [key, queue] of open)
    for (const on of queue)
      notes.push({
        start: on.start,
        end: time,
        pitch: key % 128,
        velocity: on.velocity,
        channel: Math.floor(key / 128),
      });
  return { notes, tempos, name, instrument, channelNames, programs, device, end: time };
};

interface MidiFile {
  division: number;
  tracks: Track[];
}

// the header and the tracks of a file; other chunks are skipped by their length, so is anything after the tracks
// the header counts
const readFile = (bytes: Uint8Array): MidiFile => {
  const cursor = new Cursor(bytes, 0, bytes.length);
  if (bytes.length < 4 || cursor.text(4) !== 'MThd') throw new MidiFileError('Not a MIDI file');
  const size = cursor.uint32();
  if (size < 6) throw new MidiFileError('The header of the MIDI file is too short');
  const header = new Cursor(bytes, cursor.pos, cursor.pos + size);
  cursor.take(size);
  const format = header.uint16();
  const count = header.uint16();
  const division = header.uint16();
  // format 2 is of patterns each of its own, one after another: merged they would play at once
  if (format === 2)
    throw new MidiFileError('MIDI files of format 2 (independent patterns) are not supported');
  if (format > 2) throw new MidiFileError(`Unknown MIDI file format ${format}`);
  if (division & 0x8000)
    throw new MidiFileError(
      'MIDI files timed in SMPTE frames are not supported, only in ticks a quarter note'
    );
  if (division === 0) throw new MidiFileError('The MIDI file has no ticks a quarter note');

  const tracks: Track[] = [];
  while (cursor.more() && tracks.length < count) {
    const id = cursor.text(4);
    const length = cursor.uint32();
    const start = cursor.pos;
    cursor.take(length);
    if (id === 'MTrk') tracks.push(readTrack(new Cursor(bytes, start, start + length)));
  }
  if (tracks.length === 0) throw new MidiFileError('The MIDI file has no track');
  return { division, tracks };
};

// a part of a file: the notes of a channel of a track
export interface MidiPart {
  // the index of its track in the file, its channel 1..16
  track: number;
  channel: number;
  // the name under a Channel Prefix of its channel; in a file of several tracks the Track Name of its track, else its
  // Instrument Name; else its program; else `Channel N`
  name: string;
  // its General MIDI program (its first Program Change; channel 10: Drums), null without one
  program: string | null;
  // on channel 10 (General MIDI drums)
  drums: boolean;
  // its notes in the file, their lowest and highest pitch
  notes: number;
  low: number;
  high: number;
}

// the parts of the tracks: each channel of a track that has notes, by track, then channel
const partsOf = (tracks: readonly Track[]): MidiPart[] =>
  tracks.flatMap((track, index) => {
    const channels = [...new Set(track.notes.map((note) => note.channel))].sort((a, b) => a - b);
    return channels.map((channel): MidiPart => {
      const notes = track.notes.filter((note) => note.channel === channel);
      const drums = channel === DRUM_CHANNEL;
      const gm = track.programs.get(channel);
      const program = drums ? DRUMS : gm === undefined ? null : GM_PROGRAMS[gm];
      // a file of one track (format 0): its names are the song's, not a part's
      const text =
        track.channelNames.get(channel) ?? (tracks.length > 1 ? (track.name ?? track.instrument) : undefined);
      return {
        track: index,
        channel: channel + 1,
        name: (text && normalizeName(text)) || program || `Channel ${channel + 1}`,
        program,
        drums,
        notes: notes.length,
        low: notes.reduce((low, note) => Math.min(low, note.pitch), 127),
        high: notes.reduce((high, note) => Math.max(high, note.pitch), 0),
      };
    });
  });

export interface MidiImport {
  clip: Clip;
  // notes were left out or cut: past CLIP_LENGTH_MAX, or more than CLIP_NOTES_MAX
  truncated: boolean;
  // the tempo of the file (its first Set Tempo), null without one
  tempo: number | null;
  // every part of the file (those chosen or not)
  parts: MidiPart[];
}

export interface MidiImportOptions {
  // the tempo of a file without a Set Tempo (TEMPO_DEFAULT)
  bpm?: number;
  // the parts imported, indexes into `parts` (all of them by default)
  parts?: readonly number[];
}

// a clip from a Standard MIDI File of format 0 or 1 (2 and SMPTE time throw a MidiFileError, so does a file
// truncated). Its notes are those of the parts chosen (each channel of each track; all by default), rounded to the
// ticks of the clip (at least 1 long), those under C0 an octave up;
// its tempo the first Set Tempo in time (of any track). The tracks of the parts chosen and those without notes (the
// conductor track of format 1: the title, the length of the song) give its name, their first Track Name that isn't
// blank, and its length: the end of the bar the last note ends in (a bar at least), or their End of Track where that
// is later (the loop of the file). A file of Chisper (its Device Name) ends its track at the length of the clip: its
// End of Track is the loop to the tick, shorter than a bar or off the bars too (a beat at least). At most
// CLIP_LENGTH_MAX, where the notes are cut
export const parseMidiFile = (
  bytes: Uint8Array | ArrayBuffer,
  options: MidiImportOptions = {}
): MidiImport => {
  const data = ArrayBuffer.isView(bytes)
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new Uint8Array(bytes);
  const { division, tracks } = readFile(data);
  const ticks = (time: number) => Math.round((time * CLIP_PPQ) / division);
  const parts = partsOf(tracks);
  const chosen = options.parts
    ? options.parts.flatMap((index) => (parts[index] ? [parts[index]] : []))
    : parts;
  // by track · 16 + channel 0..15
  const keys = new Set(chosen.map((part) => part.track * 16 + part.channel - 1));
  const chosenTracks = new Set(chosen.map((part) => part.track));
  const counted = tracks.filter((track, index) => track.notes.length === 0 || chosenTracks.has(index));

  // the first in time; of those at one time the first of the file
  let first: Track['tempos'][number] | undefined;
  for (const track of tracks)
    for (const tempo of track.tempos) if (!first || tempo.time < first.time) first = tempo;
  const tempo = first ? tempoOf(60e6 / first.micros) : null;

  // without two of a pitch at once (the clip can't hold them), as the player plays them: a note cut at the start of
  // the next one of its pitch, of the notes of a pitch struck at once the longest (then the loudest). By start, pitch
  const notes = playedNotes(
    tracks.flatMap((track, index) =>
      track.notes
        .filter((note) => keys.has(index * 16 + note.channel))
        .map(({ start, end, pitch, velocity }): ClipNote => {
          const from = ticks(start);
          return [from, Math.max(1, ticks(end) - from), withinPitches(pitch), velocity];
        })
    ),
    Infinity
  ).map(({ start, end, pitch, velocity }): ClipNote => [start, end - start, pitch, velocity]);
  const trackEnd = counted.reduce((last, track) => Math.max(last, ticks(track.end)), 0);
  const written = tracks.some((track) => track.device === DEVICE_NAME);
  const loop = written && trackEnd >= CLIP_PPQ ? trackEnd : Math.max(notesEnd(notes), trackEnd);
  const length = Math.min(CLIP_LENGTH_MAX, loop);

  let cut = notes.some(([start, duration]) => start + duration > length);
  const kept = withLength(notes, length);
  // the first ones by start
  if (kept.length > CLIP_NOTES_MAX) {
    cut = true;
    kept.length = CLIP_NOTES_MAX;
  }

  const text = counted.find((track) => track.name !== undefined)?.name;
  const name = text === undefined ? undefined : clipNameOf(text);
  const bpm = tempo ?? tempoOf(options.bpm ?? TEMPO_DEFAULT);
  return {
    clip: normalizeClip({ bpm, length, notes: kept, ...(name && { name }) }),
    truncated: cut,
    tempo,
    parts,
  };
};

// a variable-length quantity
const varint = (value: number) => {
  const bytes = [value & 0x7f];
  for (let rest = Math.floor(value / 0x80); rest > 0; rest = Math.floor(rest / 0x80))
    bytes.unshift((rest & 0x7f) | 0x80);
  return bytes;
};

// UTF-8 of a text (a lone surrogate as U+FFFD)
const utf8 = (text: string) => Array.from(new TextEncoder().encode(text));

const uint16 = (value: number) => [(value >> 8) & 0xff, value & 0xff];
const uint32 = (value: number) => [...uint16(Math.floor(value / 0x10000)), ...uint16(value)];
const chunk = (id: string, data: readonly number[]) => [...utf8(id), ...uint32(data.length), ...data];

// a Standard MIDI File of a clip: format 0, one track at CLIP_PPQ ticks a quarter note, its name (none without one:
// it would come back as the name of the clip), a Text of where it was made and the Device Name Chisper (an import
// takes its End of Track for the loop by it), its tempo, 4/4, its notes on channel 1 as the player plays them (cut at
// the end of the loop and at the next note of their pitch; the events of a tick in its order: playOrder), the End of
// Track at the length of the clip
export const writeMidiFile = (clip: Clip): Uint8Array<ArrayBuffer> => {
  const { bpm, length } = clip;
  const events = playedNotes(clip.notes, length)
    .flatMap(({ start, end, pitch, velocity }) => [
      { tick: start, on: true, pitch, velocity, pressed: start },
      { tick: end, on: false, pitch, velocity: RELEASE_VELOCITY, pressed: start },
    ])
    .sort(playOrder);

  const track: number[] = [];
  let last = 0;
  const event = (tick: number, ...bytes: number[]) => {
    track.push(...varint(tick - last), ...bytes);
    last = tick;
  };
  const meta = (tick: number, type: number, data: readonly number[]) =>
    event(tick, META, type, ...varint(data.length), ...data);

  const micros = Math.round(60e6 / tempoOf(bpm));
  const name = clip.name?.trim();
  if (name) meta(0, META_TRACK_NAME, utf8(name));
  meta(0, META_TEXT, utf8(MADE_WITH));
  meta(0, META_DEVICE_NAME, utf8(DEVICE_NAME));
  meta(0, META_TEMPO, [(micros >> 16) & 0xff, (micros >> 8) & 0xff, micros & 0xff]);
  // 4/4, the metronome every quarter (24 clocks), 8 32nds a quarter
  meta(0, META_TIME_SIGNATURE, [4, 2, 24, 8]);
  for (const { tick, on, pitch, velocity } of events) event(tick, on ? NOTE_ON : NOTE_OFF, pitch, velocity);
  meta(length, META_END_OF_TRACK, []);

  return new Uint8Array([
    ...chunk('MThd', [...uint16(0), ...uint16(1), ...uint16(CLIP_PPQ)]),
    ...chunk('MTrk', track),
  ]);
};

// the characters a file system may refuse in a name (and the controls)
const UNSAFE = '/\\:*?"<>|';

// the name of the file of a clip: its name (or 'clip') with the characters a file system may refuse as `_`
export const midiFileName = (clip: Clip) => {
  const name = Array.from(clip.name?.trim() || UNNAMED, (char) =>
    isControl(char.charCodeAt(0)) || UNSAFE.includes(char) ? '_' : char
  ).join('');
  return `${name}.mid`;
};
