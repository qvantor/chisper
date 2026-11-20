import { acidChunk, bextChunk, id3Chunk, infoChunk, localDate, smplChunk } from '../../services/wav-metadata';
import type { WavChunk } from '../../services/wav-writer';
import { coverPng } from './cover';
import type { ClipSpan } from './render-clip';

// who made the file: the artist and the software of its tags, the originator of its bext
const CHISPER = 'Chisper';

// what the tags of an exported file tell
export interface WavTags {
  // the preset and the clip it plays (wavTitle)
  title: string;
  // the preset whose sound it is and its link; none where the sound is no preset as saved (Init, or changed since)
  preset: { name: string; url: string } | null;
  // the link of the synth (where it has no preset)
  synthUrl: string;
  // when it was made (its local time)
  date: Date;
}

// what the file is: at `bpm`, `beats` long (whole for a tail: render-clip.ts), what of the clip it holds, its rate,
// its frames
export interface WavFacts {
  bpm: number;
  beats: number;
  span: ClipSpan;
  sampleRate: number;
  frames: number;
}

// the tempo as a name of a file and its description tell it: 97.5 BPM
export const bpmLabel = (bpm: number) => `${Number(bpm.toFixed(2))} BPM`;

// the comment of a file: made with Chisper, the preset and its link, else the link of the synth
export const wavComment = ({ preset, synthUrl }: Pick<WavTags, 'preset' | 'synthUrl'>) =>
  preset ? `Made with Chisper, preset ${preset.name}: ${preset.url}` : `Made with Chisper: ${synthUrl}`;

// The chunks of metadata of an exported file, in the order of its header: its origin (bext: the title, the tempo and
// the comment), the loop of a file as long as the clip (smpl: a tail is not one), its tempo and beats (acid), the
// tags of RIFF (ASCII) and of ID3 (any text; the knob as its cover, the link of the preset as its source)
export const wavTagChunks = (
  tags: WavTags,
  { bpm, beats, span, sampleRate, frames }: WavFacts
): WavChunk[] => {
  const { title, preset, date } = tags;
  const comment = wavComment(tags);
  return [
    bextChunk({
      description: `${title}, ${bpmLabel(bpm)}. ${comment}`,
      originator: CHISPER,
      date,
    }),
    ...(span === 'tail' ? [] : [smplChunk({ sampleRate, frames })]),
    acidChunk({ tempo: bpm, beats }),
    infoChunk([
      ['INAM', title],
      ['IART', CHISPER],
      ['ICMT', comment],
      ['ISFT', CHISPER],
      ['ICRD', localDate(date)],
    ]),
    id3Chunk({
      text: [
        ['TIT2', title],
        ['TPE1', CHISPER],
        ['TSSE', CHISPER],
        ['TBPM', String(Math.round(bpm))],
        ['TYER', String(date.getFullYear())],
      ],
      comment,
      url: preset?.url,
      picture: { mime: 'image/png', data: coverPng() },
    }),
  ];
};
