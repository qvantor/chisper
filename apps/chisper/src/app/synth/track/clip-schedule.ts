import type { ClipNote } from '@chisper/preset-schema';
import { keysOf, loopEvents, playedNotes, TrackEvent } from './track-events';

// (a hair past the end of the last pass: the offs there are of its notes)
const EPSILON = 1e-6;

// The keys of `passes` passes of the loop of a clip from its start, as the track plays them (playedNotes, the order
// of loopEvents, keysOf): a note through the end of the loop released there, the ons of the pass after the last one
// left out, a key still held at the end released there
export const clipKeys = (notes: readonly ClipNote[], length: number, passes = 1): TrackEvent[] => {
  const end = passes * length;
  const events = loopEvents(playedNotes(notes, length), length, 0, end + EPSILON).filter(
    ({ tick, on }) => tick < end || !on
  );
  const held = new Set<number>();
  const keys = events.flatMap((event) => keysOf(event, held));
  held.forEach((pitch) => keys.push({ tick: end, on: false, pitch, velocity: 0 }));
  return keys;
};
