import { readFileSync } from 'fs';
import { join } from 'path';
import {
  bytesText,
  bytesView,
  id3Frames,
  id3Text,
  id3TextFrame,
  nulText,
  riffChunks,
} from '../../../../test-utils/wav-chunks';
import { ACID_ONE_SHOT, ACID_STRETCH } from '../../services/wav-metadata';
import { createWavWriter } from '../../services/wav-writer';
import { coverPng } from './cover';
import { wavComment, wavTagChunks, WavFacts, WavTags } from './wav-tags';

const DATE = new Date(2026, 10, 20, 14, 5, 9);
const PRESET_URL = 'https://chisper.qvantor.org/?preset=3f1c';
const SYNTH_URL = 'https://chisper.qvantor.org/';
const TAGS: WavTags = {
  title: 'Warm Pad - Riff',
  preset: { name: 'Warm Pad', url: PRESET_URL },
  synthUrl: SYNTH_URL,
  date: DATE,
};
// a bar at 97.5 BPM, as long as the clip
const FACTS: WavFacts = { bpm: 97.5, beats: 4, span: 'loop', sampleRate: 48000, frames: 118154 };

const byId = (tags: WavTags, facts: Partial<WavFacts> = {}) =>
  new Map(wavTagChunks(tags, { ...FACTS, ...facts }).map(({ id, body }) => [id, body]));

describe('wavTagChunks', () => {
  it('a file as long as the clip: its origin, its loop, its tempo, the tags of RIFF and of ID3, in that order', () => {
    for (const span of ['clip', 'loop'] as const)
      expect(wavTagChunks(TAGS, { ...FACTS, span }).map(({ id }) => id)).toEqual([
        'bext',
        'smpl',
        'acid',
        'LIST',
        'id3 ',
      ]);
    // a tail is no loop
    expect(wavTagChunks(TAGS, { ...FACTS, span: 'tail', beats: 7 }).map(({ id }) => id)).toEqual([
      'bext',
      'acid',
      'LIST',
      'id3 ',
    ]);
  });

  it('the loop over the whole file, the tempo and the beats of the file', () => {
    const chunks = byId(TAGS);
    const smpl = bytesView(chunks.get('smpl') as Uint8Array);
    expect(smpl.getUint32(28, true)).toBe(1);
    expect(smpl.getUint32(44, true)).toBe(0);
    expect(smpl.getUint32(48, true)).toBe(FACTS.frames - 1);
    const acid = bytesView(chunks.get('acid') as Uint8Array);
    expect(acid.getUint32(0, true)).toBe(ACID_STRETCH);
    expect(acid.getUint32(12, true)).toBe(4);
    expect(acid.getFloat32(20, true)).toBe(97.5);
    // a clip off the beats: a one-shot of its tempo
    const off = bytesView(byId(TAGS, { beats: 4.25 }).get('acid') as Uint8Array);
    expect(off.getUint32(0, true)).toBe(ACID_STRETCH | ACID_ONE_SHOT);
    expect(off.getFloat32(20, true)).toBe(97.5);
  });

  it('the comment: the preset and its link, else the link of the synth', () => {
    expect(wavComment(TAGS)).toBe(`Made with Chisper, preset Warm Pad: ${PRESET_URL}`);
    expect(wavComment({ preset: null, synthUrl: SYNTH_URL })).toBe(`Made with Chisper: ${SYNTH_URL}`);
  });

  it('bext: the title, the tempo and the comment, by Chisper, at the time of the export', () => {
    const bext = byId(TAGS).get('bext') as Uint8Array;
    expect(nulText(bext, 0, 256)).toBe(
      `Warm Pad - Riff, 97.5 BPM. Made with Chisper, preset Warm Pad: ${PRESET_URL}`
    );
    expect(bytesText(bext, 256, 7)).toBe('Chisper');
    expect(bytesText(bext, 320, 18)).toBe('2026-11-2014:05:09');
  });

  it('INFO: the title, Chisper as the artist and the software, the comment, the date', () => {
    const info = byId({ ...TAGS, title: 'Café - Riff' }).get('LIST') as Uint8Array;
    const entries = riffChunks(info, 4).map(({ id, body }) => [id, nulText(body)]);
    expect(Object.fromEntries(entries)).toEqual({
      INAM: 'Cafe - Riff',
      IART: 'Chisper',
      ICMT: `Made with Chisper, preset Warm Pad: ${PRESET_URL}`,
      ISFT: 'Chisper',
      ICRD: '2026-11-20',
    });
  });

  it('ID3: the title in any letters, Chisper, the tempo rounded, the year, the comment, the link, the knob', () => {
    const frames = id3Frames(byId({ ...TAGS, title: 'Тёплый пэд - Riff' }).get('id3 ') as Uint8Array);
    expect([...frames.keys()]).toEqual(['TIT2', 'TPE1', 'TSSE', 'TBPM', 'TYER', 'COMM', 'WOAS', 'APIC']);
    expect(id3TextFrame(frames.get('TIT2'))).toBe('Тёплый пэд - Riff');
    expect(id3TextFrame(frames.get('TPE1'))).toBe('Chisper');
    expect(id3TextFrame(frames.get('TSSE'))).toBe('Chisper');
    expect(id3TextFrame(frames.get('TBPM'))).toBe('98');
    expect(id3TextFrame(frames.get('TYER'))).toBe('2026');
    const comm = frames.get('COMM') as Uint8Array;
    expect(id3Text(comm[0], comm.subarray(5))).toBe(`Made with Chisper, preset Warm Pad: ${PRESET_URL}`);
    expect(bytesText(frames.get('WOAS') as Uint8Array)).toBe(PRESET_URL);
    const apic = frames.get('APIC') as Uint8Array;
    expect(bytesText(apic, 1, 9)).toBe('image/png');
    expect(apic[11]).toBe(3);
    expect(apic.subarray(13)).toEqual(coverPng());
  });

  it('no preset as saved: no link of a preset, the comment the link of the synth', () => {
    const chunks = byId({ ...TAGS, preset: null });
    const frames = id3Frames(chunks.get('id3 ') as Uint8Array);
    expect(frames.has('WOAS')).toBe(false);
    const comm = frames.get('COMM') as Uint8Array;
    expect(id3Text(comm[0], comm.subarray(5))).toBe(`Made with Chisper: ${SYNTH_URL}`);
    expect(bytesText(chunks.get('LIST') as Uint8Array)).toContain(`Made with Chisper: ${SYNTH_URL}\0`);
  });

  it('the chunks of a file read back as the writer puts them (each body whole, its pad after it)', () => {
    const chunks = wavTagChunks(TAGS, FACTS);
    const [header] = createWavWriter({ sampleRate: FACTS.sampleRate, format: 'pcm24' }).finish(0, chunks);
    // (between fmt and data)
    expect(riffChunks(header).map(({ id, body }) => [id, body])).toEqual([
      ['fmt ', expect.anything()],
      ...chunks.map(({ id, body }) => [id, body]),
      ['data', new Uint8Array(0)],
    ]);
  });
});

describe('the cover', () => {
  it('is the knob of the favicon: its PNG of 64×64', () => {
    const ico = readFileSync(join(__dirname, '../../../../favicon.ico'));
    const entries = Array.from({ length: ico.readUInt16LE(4) }, (_, i) => 6 + 16 * i);
    const largest = entries.find((entry) => ico[entry] === 64) as number;
    const png = ico.subarray(
      ico.readUInt32LE(largest + 12),
      ico.readUInt32LE(largest + 12) + ico.readUInt32LE(largest + 8)
    );
    expect(coverPng()).toEqual(new Uint8Array(png));
    expect(bytesText(coverPng(), 1, 3)).toBe('PNG');
    // (its width and height, in IHDR)
    expect([bytesView(coverPng()).getUint32(16), bytesView(coverPng()).getUint32(20)]).toEqual([64, 64]);
  });
});
