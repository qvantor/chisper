import { bytesView, id3Frames, id3TextFrame, riffChunks } from '../../../../test-utils/wav-chunks';
import { parseWavChannels } from '../../services/wav';
import { exportWav } from './export-wav';
import { renderClip, RenderClipOptions } from './render-clip';
import type { WavTags } from './wav-tags';

jest.mock('../../common/engine/engine-core', () => ({ loadEngineCore: jest.fn(() => Promise.resolve({})) }));
jest.mock('./render-clip', () => ({ renderClip: jest.fn() }));
const renderMock = renderClip as jest.MockedFunction<typeof renderClip>;

const RATE = 48000;
const TAGS: WavTags = {
  title: 'Pad - Riff',
  preset: { name: 'Pad', url: 'https://chisper.qvantor.org/?preset=1' },
  synthUrl: 'https://chisper.qvantor.org/',
  date: new Date(2026, 10, 20, 14, 5, 9),
};
const SOUND = { bpm: 120 } as RenderClipOptions['sound'];
const CLIP = { notes: [], length: 4 * 960 };

// a render that writes `written` frames of a ramp in blocks of 128, the file `frames` of them, `beats` long
const renders = (written: number, frames: number, beats: number) =>
  renderMock.mockImplementation(async ({ write }) => {
    for (let at = 0; at < written; at += 128) {
      const n = Math.min(128, written - at);
      const block = Float32Array.from({ length: n }, (_, i) => (at + i) / written - 0.5);
      write(block, block);
    }
    return { frames, beats, gain: 1 };
  });

// (jsdom's Blob has no arrayBuffer)
const bytesOf = (blob: Blob) =>
  new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });

afterEach(() => renderMock.mockReset());

describe('exportWav', () => {
  it('a seamless loop: its tags between fmt and data, its loop over the frames kept, its tempo and beats', async () => {
    renders(5000, 4800, 4);
    const blob = await exportWav(SOUND, CLIP, {
      format: 'pcm24',
      sampleRate: RATE,
      span: 'loop',
      seed: 1,
      tags: TAGS,
    });
    expect(blob.type).toBe('audio/wav');
    const bytes = await bytesOf(blob);
    const chunks = riffChunks(bytes);
    expect(chunks.map(({ id }) => id)).toEqual(['fmt ', 'bext', 'smpl', 'acid', 'LIST', 'id3 ', 'data']);
    const byId = new Map(chunks.map(({ id, body }) => [id, body]));
    expect(bytesView(byId.get('smpl') as Uint8Array).getUint32(48, true)).toBe(4799);
    const acid = bytesView(byId.get('acid') as Uint8Array);
    expect(acid.getUint32(12, true)).toBe(4);
    expect(acid.getFloat32(20, true)).toBe(120);
    expect(id3TextFrame(id3Frames(byId.get('id3 ') as Uint8Array).get('TIT2'))).toBe('Pad - Riff');
    expect(byId.get('data')?.length).toBe(4800 * 6);
    expect(parseWavChannels(bytes.buffer).channels[0].length).toBe(4800);
  });

  it('a tail: no loop, its beats', async () => {
    renders(6000, 6000, 3);
    const blob = await exportWav(SOUND, CLIP, {
      format: 'float32',
      sampleRate: RATE,
      span: 'tail',
      tags: TAGS,
    });
    const chunks = riffChunks(await bytesOf(blob));
    expect(chunks.map(({ id }) => id)).toEqual(['fmt ', 'fact', 'bext', 'acid', 'LIST', 'id3 ', 'data']);
    expect(bytesView(chunks[3].body).getUint32(12, true)).toBe(3);
  });

  it('without tags: the samples alone, the header of 44 bytes', async () => {
    renders(1000, 1000, 4);
    const bytes = await bytesOf(
      await exportWav(SOUND, CLIP, { format: 'pcm16', sampleRate: RATE, span: 'clip' })
    );
    expect(riffChunks(bytes).map(({ id }) => id)).toEqual(['fmt ', 'data']);
    expect(bytes.length).toBe(44 + 1000 * 4);
  });
});
