import { MAX_FRAMES } from '../common/wavetable/wavetable-mipmap';
import { finiteSamples, parseWav, Wav } from './wav';
import { WAVE_SIZE, Wavetable, wavetableOf } from './wavetable';

// a compressed file doesn't tell its rate before it is decoded: most are 44.1 kHz, and a fixed rate gives
// the same samples on any device
const DECODE_RATE = 44100;

export type AudioFile =
  // its first channel, cut into waves in the editor
  | { kind: 'audio'; sampleRate: number; samples: Float32Array }
  // a wavetable of MAX_FRAMES waves at most, and the waves of its file (more: the rest left out)
  | { kind: 'wavetable'; wavetable: Wavetable; frames: number };

// a WAV is a wavetable when its mark (clm) says so, or when it is whole waves of WAVE_SIZE samples, MAX_FRAMES at
// most (the tables of other synths and of wavetable packs): its waves as they are, as a table of the bucket
const asWavetable = (wav: Wav): AudioFile | undefined => {
  const { length } = wav.samples;
  if (!wav.mark && (length % WAVE_SIZE !== 0 || length > MAX_FRAMES * WAVE_SIZE)) return undefined;
  const wavetable = wavetableOf(wav, MAX_FRAMES);
  if (wavetable.frames.length === 0) return undefined;
  return { kind: 'wavetable', wavetable, frames: Math.floor(length / (wav.mark?.frameSize || WAVE_SIZE)) };
};

// a file dropped or chosen in the editor: a WAV wavetable, or the samples of an audio file at its own rate, not at
// the rate of the audio context (decodeAudioData there stretches a 44.1 kHz wavetable to 1.09 cycles in a
// 2048-sample wave at 48 kHz): a WAV as stored, other formats decoded at DECODE_RATE; a sample that is not finite
// as 0. Fails when the browser can't decode it
export const readAudioFile = async (buffer: ArrayBuffer): Promise<AudioFile> => {
  let wav: Wav;
  try {
    wav = parseWav(buffer);
  } catch {
    // not a WAV, or one the parser doesn't read
    const audioBuffer = await new OfflineAudioContext(1, 1, DECODE_RATE).decodeAudioData(buffer);
    return {
      kind: 'audio',
      sampleRate: audioBuffer.sampleRate,
      samples: finiteSamples(audioBuffer.getChannelData(0)),
    };
  }
  return asWavetable(wav) ?? { kind: 'audio', sampleRate: wav.sampleRate, samples: wav.samples };
};
