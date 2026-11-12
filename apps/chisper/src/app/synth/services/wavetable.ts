import { WAVETABLES_ORIGIN, WAVETABLES_PROXY } from './buckets';
import { bucketLoader, ReportProgress } from './fetch';
import { sharedLoads } from './shared-loads';
import { parseWav, Wav } from './wav';

// the samples of a wave of a table file without a mark (clm) of its size
export const WAVE_SIZE = 2048;

// the frames of a table file and its morph mark (a table with one plays expanded to 256 frames)
export interface Wavetable {
  frames: number[][];
  morph: boolean;
}

// (`signal`: the caller gives it up; `onProgress`: the share of it downloaded; sharedLoads)
export type LoadWavetable = (
  id: string,
  signal?: AbortSignal,
  onProgress?: ReportProgress
) => Promise<Wavetable>;

// the leaf of a wavetable path (the value of a file in its select) is its key in the bucket
export const wavetableId = (path: (string | number)[]) =>
  path.length > 0 ? String(path[path.length - 1]) : '';

const loadFile = bucketLoader(WAVETABLES_ORIGIN, WAVETABLES_PROXY);

// the table of the samples of a table file: one cycle every WAVE_SIZE samples (or the size of its mark), whatever
// its sample rate, a rest shorter than a wave left out (and the waves past `limit`); its morph by its mark
export const wavetableOf = (
  { samples, mark }: Pick<Wav, 'samples' | 'mark'>,
  limit = Infinity
): Wavetable => {
  const size = mark?.frameSize || WAVE_SIZE;
  const frames = [];
  for (let i = 0; i < limit && (i + 1) * size <= samples.length; i++)
    frames.push([...samples.subarray(i * size, (i + 1) * size)]);
  return { frames, morph: mark?.morph ?? false };
};

// the file from the domain of the bucket (else through the site), its waves read from the file: decodeAudioData
// would resample them to the context rate (44.1 → 48 kHz: 1.09 cycles a wave)
const fetchWavetable = (id: string, signal: AbortSignal, onProgress: ReportProgress) =>
  loadFile(
    id,
    (bytes): Wavetable => {
      const table = wavetableOf(parseWav(bytes));
      if (table.frames.length === 0) throw new Error(`${id} is shorter than one wave`);
      return table;
    },
    signal,
    onProgress
  );

// shared by both oscillators for the whole session
export const loadWavetable: LoadWavetable = sharedLoads(fetchWavetable);
