import {
  bytesText,
  bytesView,
  id3Frames,
  id3Text,
  id3TextFrame,
  nulText,
} from '../../../test-utils/wav-chunks';
import {
  ACID_ONE_SHOT,
  ACID_STRETCH,
  acidChunk,
  asciiText,
  bextChunk,
  id3Chunk,
  infoChunk,
  localDate,
  smplChunk,
} from './wav-metadata';

const view = bytesView;
const text = bytesText;
const field = nulText;
const textFrame = id3TextFrame;

// 20 November 2026, 14:05:09 local time
const DATE = new Date(2026, 10, 20, 14, 5, 9);

describe('asciiText', () => {
  it('keeps ASCII, drops the marks of a letter, any other character a ?', () => {
    expect(asciiText('Warm Pad - Riff 1/2')).toBe('Warm Pad - Riff 1/2');
    expect(asciiText('Café Señor Ünder')).toBe('Cafe Senor Under');
    expect(asciiText('Пэд 🎹\tx')).toBe('??? ??x');
  });
});

describe('acidChunk', () => {
  it('a loop of whole beats: stretched, its beats, 4/4 (the denominator first), the tempo, no root note', () => {
    const { id, body } = acidChunk({ tempo: 97.5, beats: 16 });
    const data = view(body);
    expect(id).toBe('acid');
    expect(body.length).toBe(24);
    expect(data.getUint32(0, true)).toBe(ACID_STRETCH);
    expect(data.getUint16(4, true)).toBe(60);
    expect(data.getUint16(6, true)).toBe(0x8000);
    expect(data.getFloat32(8, true)).toBe(0);
    expect(data.getUint32(12, true)).toBe(16);
    expect(data.getUint16(16, true)).toBe(4);
    expect(data.getUint16(18, true)).toBe(4);
    expect(data.getFloat32(20, true)).toBe(97.5);
  });

  it('a length off the beats: a one-shot, its beats rounded (one at least), the tempo exact', () => {
    const data = view(acidChunk({ tempo: 120, beats: 4.25 }).body);
    expect(data.getUint32(0, true)).toBe(ACID_STRETCH | ACID_ONE_SHOT);
    expect(data.getUint32(12, true)).toBe(4);
    expect(data.getFloat32(20, true)).toBe(120);
    expect(view(acidChunk({ tempo: 120, beats: 0.25 }).body).getUint32(12, true)).toBe(1);
  });
});

describe('smplChunk', () => {
  it.each([
    [44100, 22675],
    [48000, 20833],
  ])('one loop forward over the whole file at %i Hz (a sample %i ns), its end the last frame', (rate, ns) => {
    const { id, body } = smplChunk({ sampleRate: rate, frames: 88200 });
    const data = view(body);
    expect(id).toBe('smpl');
    expect(body.length).toBe(60);
    const words = Array.from({ length: 15 }, (_, i) => data.getUint32(4 * i, true));
    // manufacturer, product, period, unity note, fraction, SMPTE format and offset, loops, sampler data
    expect(words.slice(0, 9)).toEqual([0, 0, ns, 60, 0, 0, 0, 1, 0]);
    // the loop: id, forward, start, end (inclusive), fraction, for ever
    expect(words.slice(9)).toEqual([0, 0, 0, 88199, 0, 0]);
  });
});

describe('bextChunk', () => {
  it('version 2: the description, the originator, the local date and time, no loudness', () => {
    const { id, body } = bextChunk({ description: 'Café - Riff', originator: 'Chisper', date: DATE });
    const data = view(body);
    expect(id).toBe('bext');
    expect(body.length).toBe(602);
    expect(field(body, 0, 256)).toBe('Cafe - Riff');
    expect(field(body, 256, 32)).toBe('Chisper');
    expect(field(body, 288, 32)).toBe('');
    expect(text(body, 320, 10)).toBe('2026-11-20');
    expect(text(body, 330, 8)).toBe('14:05:09');
    expect(data.getUint32(338, true)).toBe(0);
    expect(data.getUint32(342, true)).toBe(0);
    expect(data.getUint16(346, true)).toBe(2);
    expect(body.subarray(348, 412).every((byte) => byte === 0)).toBe(true);
    expect(Array.from({ length: 5 }, (_, i) => data.getInt16(412 + 2 * i, true))).toEqual(
      Array(5).fill(0x7fff)
    );
    expect(body.subarray(422).every((byte) => byte === 0)).toBe(true);
  });

  it('cuts a field to its size', () => {
    const body = bextChunk({ description: 'x'.repeat(300), originator: 'y'.repeat(40), date: DATE }).body;
    expect(text(body, 0, 256)).toBe('x'.repeat(256));
    expect(text(body, 256, 32)).toBe('y'.repeat(32));
    expect(field(body, 288, 32)).toBe('');
  });
});

describe('infoChunk', () => {
  it('a LIST of INFO: each tag ASCII ended by a NUL counted in its size, an odd one padded, an empty one left out', () => {
    const { id, body } = infoChunk([
      ['INAM', 'Pad'],
      ['IART', ''],
      ['ICMT', 'Señor'],
    ]);
    expect(id).toBe('LIST');
    expect(text(body, 0, 4)).toBe('INFO');
    expect(text(body, 4, 4)).toBe('INAM');
    expect(view(body).getUint32(8, true)).toBe(4);
    expect(text(body, 12, 4)).toBe('Pad\0');
    expect(text(body, 16, 4)).toBe('ICMT');
    expect(view(body).getUint32(20, true)).toBe(6);
    expect(text(body, 24, 6)).toBe('Senor\0');
    expect(body.length).toBe(30);
    expect(text(infoChunk([['INAM', 'Pads']]).body, 12)).toBe('Pads\0\0');
  });
});

describe('id3Chunk', () => {
  const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0xff, 0xe0, 0);

  it('ID3v2.3 in a chunk `id3 `: text frames, a comment, a link, a front cover', () => {
    const { id, body } = id3Chunk({
      text: [
        ['TIT2', 'Café'],
        ['TPE1', 'Chisper'],
        ['TBPM', ''],
      ],
      comment: 'Made with Chisper',
      url: 'https://chisper.qvantor.org/?preset=1',
      picture: { mime: 'image/png', data: PNG },
    });
    expect(id).toBe('id3 ');
    expect([...body.subarray(0, 6)]).toEqual([0x49, 0x44, 0x33, 3, 0, 0]);
    const frames = id3Frames(body);
    // (an empty one left out)
    expect([...frames.keys()]).toEqual(['TIT2', 'TPE1', 'COMM', 'WOAS', 'APIC']);
    // ISO-8859-1 where it is enough
    expect(frames.get('TIT2')?.[0]).toBe(0);
    expect(textFrame(frames.get('TIT2'))).toBe('Café');
    expect(textFrame(frames.get('TPE1'))).toBe('Chisper');
    // the encoding, English, no description, the text
    const comm = frames.get('COMM') as Uint8Array;
    expect(text(comm)).toBe('\0eng\0Made with Chisper');
    expect(text(frames.get('WOAS') as Uint8Array)).toBe('https://chisper.qvantor.org/?preset=1');
    // ISO-8859-1, the MIME type, a front cover, no description, the bytes
    const apic = frames.get('APIC') as Uint8Array;
    expect(text(apic, 0, 11)).toBe('\0image/png\0');
    expect([apic[11], apic[12]]).toEqual([3, 0]);
    expect(apic.subarray(13)).toEqual(PNG);
  });

  it('text out of ISO-8859-1 in UTF-16 with its BOM, a comment and its empty description too', () => {
    const { body } = id3Chunk({ text: [['TIT2', 'Тёплый пэд 🎹']], comment: 'пэд' });
    const frames = id3Frames(body);
    const title = frames.get('TIT2');
    expect(title?.[0]).toBe(1);
    expect(textFrame(title)).toBe('Тёплый пэд 🎹');
    const comm = frames.get('COMM') as Uint8Array;
    expect(comm[0]).toBe(1);
    expect(text(comm, 1, 3)).toBe('eng');
    // the description: its BOM, its terminator
    expect([...comm.subarray(4, 8)]).toEqual([0xff, 0xfe, 0, 0]);
    expect(id3Text(1, comm.subarray(8))).toBe('пэд');
  });

  it('a tag over 127 bytes: its size synchsafe, 7 bits a byte; a frame its size in 32 bits', () => {
    const data = new Uint8Array(70000).fill(0xff);
    const { body } = id3Chunk({ text: [], picture: { mime: 'image/png', data } });
    expect(body.subarray(6, 10).every((byte) => byte < 0x80)).toBe(true);
    expect(id3Frames(body).get('APIC')?.length).toBe(13 + 70000);
  });
});

describe('localDate', () => {
  it('the local date of a time, its year in 4 digits', () => {
    expect(localDate(DATE)).toBe('2026-11-20');
    expect(localDate(new Date(2027, 0, 5, 23, 59))).toBe('2027-01-05');
  });
});
