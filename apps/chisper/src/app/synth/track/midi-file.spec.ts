import {
  CLIP_BAR,
  CLIP_LENGTH_MAX,
  CLIP_NOTES_MAX,
  CLIP_PITCH_MIN,
  CLIP_PPQ,
  Clip,
  ClipNote,
  TEMPO_DEFAULT,
  normalizeClip,
} from '@chisper/preset-schema';
import { ascii, chunk, u16, vlq } from '../../../test-utils/midi-file';
import { MidiFileError, midiFileName, parseMidiFile, writeMidiFile } from './midi-file';

// files byte by byte: an event is [delta, ...its bytes]

const header = (format: number, tracks: number, division: number) =>
  chunk('MThd', [...u16(format), ...u16(tracks), ...u16(division)]);
const events = (list: number[][]) => list.flatMap(([delta, ...bytes]) => [...vlq(delta), ...bytes]);
// a track of the events, its End of Track `end` ticks after the last one
const track = (list: number[][], end = 0) => chunk('MTrk', [...events(list), ...vlq(end), 0xff, 0x2f, 0x00]);
const file = (...parts: number[][]) => new Uint8Array(parts.flat());

const on = (delta: number, pitch: number, velocity = 100, channel = 0) => [
  delta,
  0x90 | channel,
  pitch,
  velocity,
];
const off = (delta: number, pitch: number, channel = 0) => [delta, 0x80 | channel, pitch, 64];
const meta = (delta: number, type: number, data: number[]) => [
  delta,
  0xff,
  type,
  ...vlq(data.length),
  ...data,
];
const tempo = (delta: number, micros: number) =>
  meta(delta, 0x51, [(micros >> 16) & 0xff, (micros >> 8) & 0xff, micros & 0xff]);
const trackName = (delta: number, bytes: number[] | string) =>
  meta(delta, 0x03, typeof bytes === 'string' ? ascii(bytes) : bytes);
const instrumentName = (delta: number, text: string) => meta(delta, 0x04, ascii(text));
const channelPrefix = (delta: number, channel: number) => meta(delta, 0x20, [channel]);
const program = (delta: number, number: number, channel = 0) => [delta, 0xc0 | channel, number];
// a part without a name or a program
const part = (track: number, channel: number, notes: number, low: number, high = low) => ({
  track,
  channel,
  name: `Channel ${channel}`,
  program: null,
  drums: false,
  notes,
  low,
  high,
});
// the one part of a file written
const writtenPart = expect.objectContaining({ track: 0, channel: 1 });

// the Text and the Device Name of every file written
const MADE_WITH = 'Made with Chisper wavetable synth - https://chisper.qvantor.org';
const madeWith = [...meta(0, 0x01, ascii(MADE_WITH)), ...meta(0, 0x09, ascii('Chisper'))];

// a file of format 0 at CLIP_PPQ of these events
const single = (list: number[][], end = 0) => file(header(0, 1, CLIP_PPQ), track(list, end));

const notesOf = (bytes: Uint8Array) => parseMidiFile(bytes).clip.notes;

describe('parseMidiFile', () => {
  it('reads a file of format 0: its notes, tempo and name', () => {
    expect(
      parseMidiFile(
        single([trackName(0, 'Bass'), tempo(0, 468750), on(0, 60), off(960, 60), on(0, 62, 90), off(480, 62)])
      )
    ).toEqual({
      clip: {
        bpm: 128,
        length: CLIP_BAR,
        notes: [
          [0, 960, 60, 100],
          [960, 480, 62, 90],
        ],
        name: 'Bass',
      },
      truncated: false,
      tempo: 128,
      // a file of one track: its name is the song's, not a part's
      parts: [part(0, 1, 2, 60, 62)],
    });
  });

  it.each([96, 480, 960, 384])('merges the parts of format 1 at %i ticks a quarter, rescaled', (ppq) => {
    const bytes = file(
      header(1, 3, ppq),
      track([trackName(0, 'Song'), tempo(0, 600000)]),
      track([on(0, 60), off(ppq, 60), on(0, 64, 90), off(ppq / 2, 64)]),
      track([on(ppq, 48, 80, 1), off(2 * ppq, 48, 1), on(ppq / 4, 72, 70, 2), off(ppq / 8, 72, 2)])
    );
    expect(parseMidiFile(bytes)).toEqual({
      clip: {
        bpm: 100,
        length: CLIP_BAR,
        notes: [
          [0, 960, 60, 100],
          [960, 1920, 48, 80],
          [960, 480, 64, 90],
          [3120, 120, 72, 70],
        ],
        name: 'Song',
      },
      truncated: false,
      tempo: 100,
      parts: [part(1, 1, 2, 60, 64), part(2, 2, 1, 48), part(2, 3, 1, 72)],
    });
  });

  it('rounds the ticks of another division to whole ones, a note at least 1 long', () => {
    // 100 ticks a quarter: a tick of the file is 9.6 of the clip
    const bytes = file(
      header(0, 1, 100),
      track([on(1, 60), off(0, 60), on(0, 62), off(1, 62), on(49, 64), off(50, 64)])
    );
    expect(notesOf(bytes)).toEqual([
      [10, 1, 60, 100],
      [10, 9, 62, 100],
      [490, 480, 64, 100],
    ]);
  });

  it('takes an ArrayBuffer and a view into a larger buffer', () => {
    const bytes = single([on(0, 60), off(960, 60)]);
    const larger = new Uint8Array(bytes.length + 7);
    larger.set(bytes, 5);
    expect(notesOf(new Uint8Array(bytes.buffer))).toEqual([[0, 960, 60, 100]]);
    expect(parseMidiFile(bytes.buffer).clip.notes).toEqual([[0, 960, 60, 100]]);
    expect(parseMidiFile(larger.subarray(5, 5 + bytes.length)).clip.notes).toEqual([[0, 960, 60, 100]]);
  });

  it('goes on with running status, takes a note on of velocity 0 as a note off', () => {
    const bytes = single([
      [0, 0x90, 60, 100],
      [0, 64, 90],
      [0, 67, 80],
      [480, 60, 0],
      [0, 64, 0],
      [480, 67, 0],
      // running status of a controller, then of a program change (one data byte)
      [0, 0xb0, 7, 100],
      [0, 10, 64],
      [0, 0xc0, 5],
      [0, 6],
      [0, 0x80, 72, 0],
      [0, 0x90, 72, 50],
      [240, 72, 0],
    ]);
    expect(notesOf(bytes)).toEqual([
      [0, 480, 60, 100],
      [0, 480, 64, 90],
      [0, 960, 67, 80],
      [960, 240, 72, 50],
    ]);
  });

  it('takes the notes under C0 an octave up (as many as it takes)', () => {
    const bytes = single([on(0, 0), on(0, 5), on(0, 24), off(480, 0), off(0, 5), off(0, 24)]);
    expect(notesOf(bytes).map(([, , pitch]) => pitch)).toEqual([12, 17, 24]);
  });

  it('merges the channels, a note off ends only a note of its channel', () => {
    const bytes = single(
      [on(0, 60, 100, 0), on(0, 64, 90, 9), on(0, 67, 80, 15), off(480, 60, 9), off(0, 64, 9)],
      480
    );
    expect(notesOf(bytes)).toEqual([
      [0, 960, 60, 100],
      [0, 480, 64, 90],
      [0, 960, 67, 80],
    ]);
  });

  describe('the tempo', () => {
    it('is the first Set Tempo in time, of any track', () => {
      const bytes = file(
        header(1, 2, CLIP_PPQ),
        track([tempo(960, 666667), tempo(960, 400000)]),
        track([tempo(0, 428571), on(0, 60), off(960, 60)])
      );
      expect(parseMidiFile(bytes)).toMatchObject({ clip: { bpm: 140 }, tempo: 140 });
    });

    it('of two at one time is that of the first track', () => {
      const bytes = file(header(1, 2, CLIP_PPQ), track([tempo(0, 500000)]), track([tempo(0, 1000000)]));
      expect(parseMidiFile(bytes).tempo).toBe(120);
    });

    it('goes on the grid of the field within its range', () => {
      expect(parseMidiFile(single([tempo(0, 500001)])).tempo).toBe(120);
      expect(parseMidiFile(single([tempo(0, 0xffffff)])).tempo).toBe(20);
      expect(parseMidiFile(single([tempo(0, 100000)])).tempo).toBe(300);
    });

    it('without a Set Tempo is the one given, or the default; `tempo` null', () => {
      const bytes = single([on(0, 60), off(960, 60)]);
      expect(parseMidiFile(bytes)).toMatchObject({ clip: { bpm: TEMPO_DEFAULT }, tempo: null });
      expect(parseMidiFile(bytes, { bpm: 97.333 })).toMatchObject({ clip: { bpm: 97.33 }, tempo: null });
      // a Set Tempo of 0 microseconds is none
      expect(parseMidiFile(single([tempo(0, 0)]), { bpm: 90 })).toMatchObject({
        clip: { bpm: 90 },
        tempo: null,
      });
    });
  });

  describe('the length', () => {
    it('is the end of the bar the last note ends in, a bar at least', () => {
      expect(parseMidiFile(single([on(0, 60), off(2 * CLIP_BAR + 1, 60)])).clip.length).toBe(3 * CLIP_BAR);
      expect(parseMidiFile(single([on(0, 60), off(2 * CLIP_BAR, 60)])).clip.length).toBe(2 * CLIP_BAR);
      expect(parseMidiFile(single([on(0, 60), off(1, 60)])).clip.length).toBe(CLIP_BAR);
      expect(parseMidiFile(single([])).clip).toEqual({ bpm: TEMPO_DEFAULT, length: CLIP_BAR, notes: [] });
    });

    it('is the End of Track where that is later', () => {
      expect(parseMidiFile(single([on(0, 60), off(960, 60)], 6 * CLIP_BAR - 960)).clip.length).toBe(
        6 * CLIP_BAR
      );
      expect(parseMidiFile(single([], 5 * CLIP_BAR + 960)).clip.length).toBe(5 * CLIP_BAR + 960);
      // within the bar of the last note it changes nothing
      expect(parseMidiFile(single([on(0, 60), off(960, 60)], 960)).clip.length).toBe(CLIP_BAR);
    });

    it('of a file of Chisper (its Device Name) is its End of Track to the tick, a beat at least', () => {
      const chisper = meta(0, 0x09, ascii('Chisper'));
      expect(parseMidiFile(single([chisper, on(0, 60), off(960, 60)], 960)).clip.length).toBe(2 * CLIP_PPQ);
      expect(
        parseMidiFile(single([chisper, on(0, 60), off(960, 60)], 2 * CLIP_BAR + CLIP_PPQ - 960)).clip.length
      ).toBe(2 * CLIP_BAR + CLIP_PPQ);
      expect(parseMidiFile(single([chisper, on(0, 60), off(960, 60)], 1)).clip.length).toBe(960 + 1);
      // under a beat: the end of the bar
      expect(parseMidiFile(single([chisper, on(0, 60), off(100, 60)], 100)).clip.length).toBe(CLIP_BAR);
      // of another device: the end of the bar
      const other = meta(0, 0x09, ascii('Other'));
      expect(parseMidiFile(single([other, on(0, 60), off(960, 60)], 960)).clip.length).toBe(CLIP_BAR);
    });

    it('is at most 32 bars: notes after them left out, those across them cut', () => {
      const bytes = single([
        on(0, 60),
        off(960, 60),
        on(CLIP_LENGTH_MAX - 960 - 960, 62),
        off(1920, 62),
        on(0, 64),
        off(960, 64),
      ]);
      expect(parseMidiFile(bytes)).toEqual({
        clip: {
          bpm: TEMPO_DEFAULT,
          length: CLIP_LENGTH_MAX,
          notes: [
            [0, 960, 60, 100],
            [CLIP_LENGTH_MAX - 960, 960, 62, 100],
          ],
        },
        truncated: true,
        tempo: null,
        parts: [part(0, 1, 3, 60, 64)],
      });
    });

    it('cut by a long End of Track alone truncates no note', () => {
      expect(parseMidiFile(single([on(0, 60), off(960, 60)], 40 * CLIP_BAR))).toMatchObject({
        clip: { length: CLIP_LENGTH_MAX, notes: [[0, 960, 60, 100]] },
        truncated: false,
      });
    });

    it('takes a note ending at 32 bars whole', () => {
      expect(parseMidiFile(single([on(0, 60), off(CLIP_LENGTH_MAX, 60)]))).toMatchObject({
        clip: { length: CLIP_LENGTH_MAX, notes: [[0, CLIP_LENGTH_MAX, 60, 100]] },
        truncated: false,
      });
    });
  });

  it('keeps the first CLIP_NOTES_MAX notes by start', () => {
    const list = Array.from({ length: CLIP_NOTES_MAX + 52 }, (_, i) => [
      on(i ? 10 : 0, 60 + (i % 2)),
      off(10, 60 + (i % 2)),
    ]).flat();
    const { clip, truncated } = parseMidiFile(single(list));
    expect(truncated).toBe(true);
    expect(clip.notes).toHaveLength(CLIP_NOTES_MAX);
    expect(clip.notes[CLIP_NOTES_MAX - 1]).toEqual([(CLIP_NOTES_MAX - 1) * 20, 10, 61, 100]);
  });

  describe('pairs notes', () => {
    it('by their channel and pitch, the earliest first; a note of a pitch on cuts the one before', () => {
      // the first off ends the first on, the second the second: the first is cut where the second starts
      expect(notesOf(single([on(0, 60, 100), on(480, 60, 90), off(480, 60), off(480, 60)]))).toEqual([
        [0, 480, 60, 100],
        [480, 960, 60, 90],
      ]);
    });

    it('of a pitch on two channels at once: cut at the next one, the longest of those struck together stays', () => {
      expect(
        notesOf(single([on(0, 60, 100, 0), on(240, 60, 90, 1), off(240, 60, 0), off(480, 60, 1)]))
      ).toEqual([
        [0, 240, 60, 100],
        [240, 720, 60, 90],
      ]);
      expect(
        notesOf(single([on(0, 60, 100, 0), on(0, 60, 90, 1), off(480, 60, 0), off(480, 60, 1)]))
      ).toEqual([[0, 960, 60, 90]]);
    });

    it('ignores a note off without a note on', () => {
      expect(notesOf(single([off(0, 60), on(0, 62), off(480, 60), off(480, 62)]))).toEqual([
        [0, 960, 62, 100],
      ]);
    });

    it('ends the notes still open at the End of Track, at least a tick after their start', () => {
      expect(notesOf(single([on(0, 60), on(480, 64), on(960, 67)], 0))).toEqual([
        [0, 1440, 60, 100],
        [480, 960, 64, 100],
        [1440, 1, 67, 100],
      ]);
      expect(notesOf(single([on(0, 60)], 1920))).toEqual([[0, 1920, 60, 100]]);
    });

    it('ends them at the last event of a track without an End of Track', () => {
      const bytes = file(
        header(0, 1, CLIP_PPQ),
        chunk('MTrk', events([on(0, 60), on(0, 62), off(480, 62), [480, 0xb0, 1, 0]]))
      );
      expect(notesOf(bytes)).toEqual([
        [0, 960, 60, 100],
        [0, 480, 62, 100],
      ]);
    });

    it('of each track apart', () => {
      const bytes = file(
        header(1, 2, CLIP_PPQ),
        track([on(0, 60), off(960, 60)]),
        track([off(480, 60), on(0, 62), off(480, 62)])
      );
      expect(notesOf(bytes)).toEqual([
        [0, 960, 60, 100],
        [480, 480, 62, 100],
      ]);
    });
  });

  it('skips sysex, other meta events, other channel messages and unknown chunks', () => {
    const bytes = file(
      header(1, 2, CLIP_PPQ),
      chunk('XFIH', [1, 2, 3, 4, 5]),
      track([
        meta(0, 0x00, [0, 1]),
        meta(0, 0x01, ascii('a text')),
        meta(0, 0x02, ascii('(c)')),
        meta(0, 0x06, ascii('Marker')),
        meta(0, 0x20, [0]),
        meta(0, 0x54, [0x60, 0, 0, 0, 0]),
        meta(0, 0x58, [4, 2, 24, 8]),
        meta(0, 0x59, [0xfd, 0]),
        meta(0, 0x7f, [0, 0, 0x41, 1, 2, 3]),
        [0, 0xf0, ...vlq(5), 0x7e, 0x7f, 0x09, 0x01, 0xf7],
        [0, 0xf7, ...vlq(3), 0xf0, 0x43, 0x10],
        [0, 0xa0, 60, 30],
        [0, 0xb0, 64, 127],
        [0, 0xc0, 3],
        [0, 0xd0, 40],
        [0, 0xe0, 0, 0x40],
        on(0, 60),
        off(960, 60),
      ]),
      chunk('XYZW', ascii('anything at all')),
      track([[0, 0xd5, 10], [0, 0xc5, 1], on(0, 62, 90, 5), [480, 0xe5, 0x7f, 0x7f], off(0, 62, 5)])
    );
    expect(parseMidiFile(bytes)).toEqual({
      clip: {
        bpm: TEMPO_DEFAULT,
        length: CLIP_BAR,
        notes: [
          [0, 960, 60, 100],
          [0, 480, 62, 90],
        ],
      },
      truncated: false,
      tempo: null,
      parts: [
        { ...part(0, 1, 1, 60), name: 'Honky-tonk Piano', program: 'Honky-tonk Piano' },
        { ...part(1, 6, 1, 62), name: 'Bright Acoustic Piano', program: 'Bright Acoustic Piano' },
      ],
    });
  });

  it('skips anything after the tracks the header counts', () => {
    const bytes = file(header(0, 1, CLIP_PPQ), track([on(0, 60), off(960, 60)]), [0, 0, 0]);
    expect(notesOf(bytes)).toEqual([[0, 960, 60, 100]]);
  });

  describe('the name', () => {
    it('is the first Track Name that is not blank, whitespace collapsed, cut to 40 characters', () => {
      const bytes = file(
        header(1, 2, CLIP_PPQ),
        track([trackName(0, '   ')]),
        track([trackName(0, '  Lead \t  synth\n'), trackName(0, 'Other')])
      );
      expect(parseMidiFile(bytes).clip.name).toBe('Lead synth');
      expect(parseMidiFile(single([trackName(0, `  ${'x'.repeat(39)} yz`)])).clip.name).toBe('x'.repeat(39));
      expect(parseMidiFile(single([trackName(0, 'a'.repeat(300))])).clip.name).toBe('a'.repeat(40));
    });

    it('reads UTF-8, else Latin-1; control characters as spaces', () => {
      expect(parseMidiFile(single([trackName(0, [0x43, 0x61, 0x66, 0xc3, 0xa9])])).clip.name).toBe('Café');
      expect(parseMidiFile(single([trackName(0, [0x43, 0x61, 0x66, 0xe9])])).clip.name).toBe('Café');
      expect(parseMidiFile(single([trackName(0, [0x41, 0x00, 0x42, 0x07])])).clip.name).toBe('A B');
    });

    it('is left out when it is empty or profane, the notes read all the same', () => {
      expect(parseMidiFile(single([trackName(0, ''), on(0, 60), off(960, 60)])).clip).not.toHaveProperty(
        'name'
      );
      expect(parseMidiFile(single([trackName(0, 'fuck'), on(0, 60), off(960, 60)])).clip).toEqual({
        bpm: TEMPO_DEFAULT,
        length: CLIP_BAR,
        notes: [[0, 960, 60, 100]],
      });
    });
  });

  describe('the parts', () => {
    // a song of format 1: a conductor track (its title, tempo and length), a lead and a bass on channel 1 as a DAW
    // writes them, drums on channel 10
    const song = (title = 'Song') =>
      file(
        header(1, 4, CLIP_PPQ),
        track([...(title ? [trackName(0, title)] : []), tempo(0, 500000)], 6 * CLIP_BAR),
        track([trackName(0, 'Lead'), program(0, 81), on(0, 72), off(960, 72), on(0, 76, 90), off(960, 76)]),
        track([trackName(0, '  Bass\tline '), on(0, 36, 80), off(1920, 36)], 3 * CLIP_BAR),
        track([trackName(0, 'Kit'), on(0, 36, 110, 9), off(240, 36, 9), on(0, 42, 70, 9), off(240, 42, 9)])
      );

    it('are the channels of the tracks with notes, named by their tracks in a file of several', () => {
      expect(parseMidiFile(song()).parts).toEqual([
        { ...part(1, 1, 2, 72, 76), name: 'Lead', program: 'Lead 2 (sawtooth)' },
        { ...part(2, 1, 1, 36), name: 'Bass line' },
        { ...part(3, 10, 2, 36, 42), name: 'Kit', program: 'Drums', drums: true },
      ]);
    });

    it('of a file of one track are named by their programs: channel 10 Drums, Channel N without one', () => {
      const bytes = single([
        trackName(0, 'Song'),
        program(0, 33, 0),
        program(0, 0, 9),
        on(0, 40, 100, 0),
        on(0, 36, 100, 9),
        on(0, 64, 100, 2),
        program(0, 81, 0),
        off(960, 40, 0),
        off(0, 36, 9),
        off(0, 64, 2),
      ]);
      expect(parseMidiFile(bytes)).toMatchObject({
        clip: { name: 'Song' },
        parts: [
          { channel: 1, name: 'Electric Bass (finger)', program: 'Electric Bass (finger)', drums: false },
          { channel: 3, name: 'Channel 3', program: null, drums: false },
          { channel: 10, name: 'Drums', program: 'Drums', drums: true },
        ],
      });
    });

    it('take the Instrument Name of a track without a Track Name, a name under a Channel Prefix first', () => {
      const bytes = file(
        header(1, 2, CLIP_PPQ),
        track([instrumentName(0, 'Strings'), on(0, 60), off(960, 60)]),
        track([
          trackName(0, 'Keys'),
          channelPrefix(0, 1),
          instrumentName(0, ' '),
          trackName(0, 'Left hand'),
          on(0, 48, 100, 1),
          off(960, 48, 1),
          on(0, 72, 100, 2),
          off(960, 72, 2),
        ])
      );
      expect(parseMidiFile(bytes).parts.map(({ name }) => name)).toEqual(['Strings', 'Left hand', 'Keys']);
    });

    it('a Channel Prefix names a channel of a file of one track up to the next channel message', () => {
      const bytes = single([
        channelPrefix(0, 1),
        instrumentName(0, 'Piano'),
        on(0, 60, 100, 1),
        trackName(0, 'Song'),
        on(0, 64, 100, 0),
        off(960, 60, 1),
        off(0, 64, 0),
      ]);
      expect(parseMidiFile(bytes)).toMatchObject({
        clip: { name: 'Song' },
        parts: [
          { channel: 1, name: 'Channel 1' },
          { channel: 2, name: 'Piano' },
        ],
      });
    });

    it('chosen give the notes of the clip; the title and length of a conductor track stay', () => {
      const bass = parseMidiFile(song(), { parts: [1] });
      expect(bass).toMatchObject({
        clip: { bpm: 120, length: 6 * CLIP_BAR, notes: [[0, 1920, 36, 80]], name: 'Song' },
        tempo: 120,
        truncated: false,
      });
      // every part is listed all the same
      expect(bass.parts).toHaveLength(3);
      expect(parseMidiFile(song(), { parts: [0, 2] }).clip.notes).toEqual([
        [0, 240, 36, 110],
        [0, 960, 72, 100],
        [240, 240, 42, 70],
        [960, 960, 76, 90],
      ]);
      // indexes past the parts choose nothing
      expect(parseMidiFile(song(), { parts: [5] }).clip).toEqual({
        bpm: 120,
        length: 6 * CLIP_BAR,
        notes: [],
        name: 'Song',
      });
    });

    it('chosen without a conductor title name the clip by their tracks, their End of Track its length', () => {
      expect(parseMidiFile(song(''), { parts: [1] }).clip).toMatchObject({
        name: 'Bass line',
        length: 6 * CLIP_BAR,
      });
      expect(parseMidiFile(song(''), { parts: [0] }).clip).toMatchObject({
        name: 'Lead',
        length: 6 * CLIP_BAR,
      });
      // without a conductor track: the lead alone ends with its notes, the End of Track of the bass doesn't count
      const bytes = file(
        header(1, 2, CLIP_PPQ),
        track([trackName(0, 'Lead'), on(0, 72), off(960, 72)]),
        track([trackName(0, 'Bass'), on(0, 36), off(960, 36)], 5 * CLIP_BAR)
      );
      expect(parseMidiFile(bytes, { parts: [0] }).clip).toEqual({
        bpm: TEMPO_DEFAULT,
        length: CLIP_BAR,
        notes: [[0, 960, 72, 100]],
        name: 'Lead',
      });
      expect(parseMidiFile(bytes, { parts: [1] }).clip).toMatchObject({
        name: 'Bass',
        length: 5 * CLIP_BAR + 960,
      });
    });

    it('of a file of one track chosen keep its name and End of Track', () => {
      const bytes = single(
        [trackName(0, 'Song'), on(0, 60, 100, 0), on(0, 36, 100, 1), off(960, 60, 0), off(0, 36, 1)],
        7 * CLIP_BAR
      );
      expect(parseMidiFile(bytes, { parts: [1] }).clip).toEqual({
        bpm: TEMPO_DEFAULT,
        length: 7 * CLIP_BAR + 960,
        notes: [[0, 960, 36, 100]],
        name: 'Song',
      });
    });
  });

  describe('throws a MidiFileError', () => {
    const valid = file(
      header(0, 1, CLIP_PPQ),
      track([trackName(0, 'Bass'), tempo(0, 500000), on(0, 60), off(960, 60)])
    );

    it.each([
      ['for another file', file(ascii('RIFF'), [0, 0, 0, 0]), /Not a MIDI file/],
      ['for an empty file', file([]), /Not a MIDI file/],
      ['for SMPTE time', file(header(0, 1, 0xe728), track([])), /SMPTE/],
      ['for format 2', file(header(2, 1, CLIP_PPQ), track([])), /format 2/],
      ['for an unknown format', file(header(3, 1, CLIP_PPQ), track([])), /format 3/],
      ['for a division of 0', file(header(0, 1, 0), track([])), /ticks a quarter/],
      ['for a short header', file(chunk('MThd', [0, 0, 0, 1])), /too short/],
      ['for no track', file(header(0, 1, CLIP_PPQ)), /no track/],
      ['for a data byte without a status', single([[0, 60, 100]]), /without a status/],
      ['for a system message', single([[0, 0xf2, 0, 0]]), /status 0xf2/],
      [
        'for a number of 5 bytes',
        file(header(0, 1, CLIP_PPQ), chunk('MTrk', [0x80, 0x80, 0x80, 0x80, 0x00])),
        /4 bytes/,
      ],
      [
        'for an event past the end of its chunk',
        file(header(0, 1, CLIP_PPQ), chunk('MTrk', [0, 0x90, 60])),
        /truncated/,
      ],
    ])('%s', (_, bytes, message) => {
      expect(() => parseMidiFile(bytes)).toThrow(MidiFileError);
      expect(() => parseMidiFile(bytes)).toThrow(message);
    });

    it('for a file cut anywhere after its header', () => {
      expect(notesOf(valid)).toEqual([[0, 960, 60, 100]]);
      for (let size = 15; size < valid.length; size++)
        expect(() => parseMidiFile(valid.subarray(0, size))).toThrow(/truncated/);
      for (let size = 4; size < 14; size++)
        expect(() => parseMidiFile(valid.subarray(0, size))).toThrow(/truncated/);
    });
  });
});

describe('writeMidiFile', () => {
  const clip: Clip = {
    bpm: 128.12,
    length: 4 * CLIP_BAR,
    notes: [
      [0, 960, 60, 100],
      [0, 480, 64, 90],
      [480, 480, 64, 80],
      [960, 2880, 67, 127],
      [3840, 120, CLIP_PITCH_MIN, 1],
      [CLIP_BAR * 3 + 960, 1920, 127, 64],
    ],
    name: 'Bass line',
  };

  it('writes format 0, one track at 960 ticks, its name, where it was made, tempo, 4/4, the offs of a tick before its ons', () => {
    const bytes = writeMidiFile({
      bpm: 120,
      length: CLIP_BAR,
      notes: [
        [0, 960, 60, 100],
        [960, 960, 62, 90],
      ],
      name: 'Bass',
    });
    expect(bytes).toEqual(
      file(
        header(0, 1, 960),
        chunk('MTrk', [
          ...[0x00, 0xff, 0x03, 0x04, ...ascii('Bass')],
          ...madeWith,
          ...[0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20],
          ...[0x00, 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08],
          ...[0x00, 0x90, 60, 100],
          ...[0x87, 0x40, 0x80, 60, 64],
          ...[0x00, 0x90, 62, 90],
          ...[0x87, 0x40, 0x80, 62, 64],
          ...[0x8f, 0x00, 0xff, 0x2f, 0x00],
        ])
      )
    );
  });

  it('round trips through parseMidiFile', () => {
    expect(parseMidiFile(writeMidiFile(clip))).toEqual({
      clip: normalizeClip(clip),
      truncated: false,
      tempo: 128.12,
      parts: [writtenPart],
    });
  });

  it.each([20, 33.33, 97.5, 120, 174.99, 299.99, 300])('round trips the tempo %s', (bpm) => {
    expect(parseMidiFile(writeMidiFile({ ...clip, bpm })).clip.bpm).toBe(bpm);
  });

  it.each([
    ['a beat', CLIP_PPQ, [[0, 480, 60, 100]]],
    ['3 beats', 3 * CLIP_PPQ, [[0, 960, 60, 100]]],
    ['2 bars and a beat, a note in the 3rd bar', 2 * CLIP_BAR + CLIP_PPQ, [[2 * CLIP_BAR, 960, 60, 100]]],
    ['a bar and 7 steps of 1/16T', CLIP_BAR + 7 * (CLIP_PPQ / 6), [[0, 960, 60, 100]]],
  ] as [string, number, ClipNote[]][])('round trips a loop of %s', (_, length, notes) => {
    const loop: Clip = { bpm: 120, length, notes };
    expect(parseMidiFile(writeMidiFile(loop)).clip).toEqual(loop);
  });

  it('round trips the loop after its last note and 32 bars of notes', () => {
    const sparse: Clip = { bpm: 90, length: 8 * CLIP_BAR, notes: [[0, 240, 36, 100]], name: 'Kick' };
    expect(parseMidiFile(writeMidiFile(sparse)).clip).toEqual(sparse);
    const full: Clip = {
      bpm: 140,
      length: CLIP_LENGTH_MAX,
      notes: Array.from({ length: CLIP_NOTES_MAX }, (_, i): ClipNote => [
        i * 60,
        60,
        36 + (i % 48),
        1 + (i % 127),
      ]),
      name: 'Full',
    };
    expect(parseMidiFile(writeMidiFile(full))).toEqual({
      clip: normalizeClip(full),
      truncated: false,
      tempo: 140,
      parts: [writtenPart],
    });
  });

  it('writes no name for a clip without one: it comes back without one', () => {
    const { name, ...unnamed } = clip;
    expect(name).toBe('Bass line');
    expect(parseMidiFile(writeMidiFile(unnamed)).clip).not.toHaveProperty('name');
    // where it was made first, then the tempo
    const bytes = Array.from(writeMidiFile(unnamed).subarray(22));
    expect(bytes.slice(0, madeWith.length)).toEqual(madeWith);
    expect(bytes.slice(madeWith.length, madeWith.length + 4)).toEqual([0x00, 0xff, 0x51, 0x03]);
  });

  it('writes where it was made, which an import does not read as the name', () => {
    const { name, ...unnamed } = clip;
    expect(name).toBe('Bass line');
    const bytes = writeMidiFile(unnamed);
    expect(MADE_WITH.length).toBe(63);
    expect(Array.from(bytes.subarray(22, 22 + madeWith.length))).toEqual(madeWith);
    expect(parseMidiFile(bytes)).toEqual({
      clip: normalizeClip(unnamed),
      truncated: false,
      tempo: 128.12,
      parts: [part(0, 1, 6, CLIP_PITCH_MIN, 127)],
    });
  });

  it('writes the name in UTF-8', () => {
    expect(parseMidiFile(writeMidiFile({ ...clip, name: 'Café 🎹 bass' })).clip.name).toBe('Café 🎹 bass');
  });

  it('cuts a note at the end of the loop, leaves out one after it', () => {
    const notes = notesOf(
      writeMidiFile({
        bpm: 120,
        length: CLIP_BAR,
        notes: [
          [3000, 2000, 60, 100],
          [CLIP_BAR, 100, 62, 100],
        ],
      })
    );
    expect(notes).toEqual([[3000, 840, 60, 100]]);
  });

  it('cuts a note at the start of the next one of its pitch, the off before the on', () => {
    const bytes = writeMidiFile({
      bpm: 120,
      length: CLIP_BAR,
      notes: [
        [0, 960, 60, 100],
        [480, 960, 60, 90],
      ],
    });
    expect(notesOf(bytes)).toEqual([
      [0, 480, 60, 100],
      [480, 960, 60, 90],
    ]);
    // after where it was made, the tempo and the time signature
    const track = Array.from(bytes.subarray(22 + madeWith.length + 7 + 8));
    expect(track).toEqual([
      ...[0x00, 0x90, 60, 100],
      ...[0x83, 0x60, 0x80, 60, 64],
      ...[0x00, 0x90, 60, 90],
      ...[0x87, 0x40, 0x80, 60, 64],
      ...[0x92, 0x60, 0xff, 0x2f, 0x00],
    ]);
  });

  it('writes the notes of a tick as the player plays them: the ons from the highest pitch down, the offs as pressed', () => {
    const bytes = writeMidiFile({
      bpm: 120,
      length: CLIP_BAR,
      notes: [
        [0, 960, 48, 100],
        [0, 960, 64, 100],
        [0, 480, 79, 100],
        [480, 480, 76, 100],
      ],
    });
    // after where it was made, the tempo and the time signature
    const track = Array.from(bytes.subarray(22 + madeWith.length + 7 + 8));
    expect(track).toEqual([
      ...events([
        on(0, 79),
        on(0, 64),
        on(0, 48),
        off(480, 79),
        on(0, 76),
        off(480, 64),
        off(0, 48),
        off(0, 76),
      ]),
      ...[...vlq(CLIP_BAR - 960), 0xff, 0x2f, 0x00],
    ]);
  });

  it('writes the note the player plays of a pitch struck twice at once through the end of the loop', () => {
    const notes: ClipNote[] = [
      [0, 2 * CLIP_BAR, 60, 127],
      [0, 3 * CLIP_BAR, 60, 10],
    ];
    // the longest, though both are cut to the loop
    expect(notesOf(writeMidiFile({ bpm: 120, length: CLIP_BAR, notes }))).toEqual([[0, CLIP_BAR, 60, 10]]);
  });
});

describe('midiFileName', () => {
  it('is the name of the clip with .mid, or clip.mid', () => {
    expect(midiFileName({ bpm: 120, length: CLIP_BAR, notes: [], name: 'Bass line' })).toBe('Bass line.mid');
    expect(midiFileName({ bpm: 120, length: CLIP_BAR, notes: [] })).toBe('clip.mid');
    expect(midiFileName({ bpm: 120, length: CLIP_BAR, notes: [], name: '' })).toBe('clip.mid');
  });

  it('replaces the characters a file system may refuse with _', () => {
    expect(
      midiFileName({ bpm: 120, length: CLIP_BAR, notes: [], name: 'a/b\\c:d*e?f"g<h>i|j\u0007k\u007fl' })
    ).toBe('a_b_c_d_e_f_g_h_i_j_k_l.mid');
  });
});
