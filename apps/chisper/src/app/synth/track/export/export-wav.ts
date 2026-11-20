import { loadEngineCore } from '../../common/engine/engine-core';
import { seeded } from '../../common/engine/seeded';
import { createWavWriter, WavFormat } from '../../services/wav-writer';
import { ClipLevel, ClipSpan, renderClip, RenderClipOptions } from './render-clip';
import { wavTagChunks, WavTags } from './wav-tags';

export interface WavExportOptions {
  format: WavFormat;
  sampleRate: number;
  // what the file holds of the clip: alone, with its tail or as a seamless loop (ClipSpan)
  span: ClipSpan;
  // how loud: as played, or with headroom (ClipLevel; by default as played)
  level?: ClipLevel;
  // one seed, the same file (none: a new one each time, the phases at random as the synth plays them)
  seed?: number;
  // what its tags tell (wav-tags.ts; none: a file of the samples alone, the same bytes on any day)
  tags?: WavTags;
  signal?: AbortSignal;
  onProgress?: (share: number) => void;
}

// The file of a clip played by the sound of the page: the core loaded at the first export (engine-core.ts), an
// instance of its own rendering it (render-clip.ts), each block written as it comes (wav-writer.ts), the silence
// at the end cut, its tags in the header; the dither of 16 bits drawn from the seed too
export const exportWav = async (
  sound: RenderClipOptions['sound'],
  clip: RenderClipOptions['clip'],
  {
    format,
    sampleRate,
    span,
    level,
    seed = Math.floor(Math.random() * 2 ** 31),
    tags,
    signal,
    onProgress,
  }: WavExportOptions
) => {
  const core = await loadEngineCore();
  signal?.throwIfAborted();
  const writer = createWavWriter({ sampleRate, format, random: seeded(seed ^ 0x5eed) });
  const { frames, beats } = await renderClip({
    exports: core,
    sound,
    clip,
    sampleRate,
    span,
    level,
    seed,
    signal,
    onProgress,
    write: writer.write,
  });
  const chunks = tags ? wavTagChunks(tags, { bpm: sound.bpm, beats, span, sampleRate, frames }) : [];
  return new Blob(writer.finish(frames, chunks), { type: 'audio/wav' });
};
