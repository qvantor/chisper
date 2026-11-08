import type { ClipNote } from '@chisper/preset-schema';

// the notes of a clip as the track plays them and their events over the loop. Ticks: CLIP_PPQ a beat of the
// transport, the loop [0, length) from beat 0 on (or from an origin: the pass REC ran the loop on from)

// ticks: a float noise of the positions of the player
const EPSILON = 1e-6;

// a note as it plays: from its start to its end within the loop
export interface PlayedNote {
  start: number;
  end: number;
  pitch: number;
  velocity: number;
}

// a note on or off of the track at `tick` (ticks from beat 0 of the transport, over the loops)
export interface TrackEvent {
  tick: number;
  on: boolean;
  pitch: number;
  velocity: number;
}

// the notes of a clip as they play: one past the end of the loop released there, one the next note of its pitch
// starts over released at its start (a voice of a pitch at a time); of two of a pitch starting together the longest
// plays (then the loudest). In the order of their start
export const playedNotes = (notes: readonly ClipNote[], length: number): PlayedNote[] => {
  const sorted = notes
    .filter(([start]) => start < length)
    .slice()
    .sort((a, b) => a[0] - b[0] || a[2] - b[2] || b[1] - a[1] || b[3] - a[3]);
  const played: PlayedNote[] = [];
  // the last note of each pitch so far
  const last = new Map<number, PlayedNote>();
  for (const [start, duration, pitch, velocity] of sorted) {
    const before = last.get(pitch);
    if (before?.start === start) continue;
    if (before && before.end > start) before.end = start;
    const note = { start, end: Math.min(start + duration, length), pitch, velocity };
    played.push(note);
    last.set(pitch, note);
  }
  return played;
};

// an event and the tick of the note on of its note (that of an on is its own)
interface PressedEvent {
  tick: number;
  on: boolean;
  pitch: number;
  pressed: number;
}

// the order the notes of a tick are played in: the offs before the ons (a note that ends where the next of its pitch
// starts); the ons from the highest pitch down (Poly 1 plays the last note pressed: the lowest of a chord, as a DAW
// sends one: FL Studio); the offs in the order their notes were pressed, then as the ons (the key on top of the
// stack of mono is released last: its voice goes back to no key released with it)
export const playOrder = (x: PressedEvent, y: PressedEvent) =>
  x.tick - y.tick || Number(x.on) - Number(y.on) || x.pressed - y.pressed || y.pitch - x.pitch;

// the events of the notes in [from, to) (ticks over the loops, the first loop from `origin`), in the order they are
// played (playOrder)
export const loopEvents = (
  played: readonly PlayedNote[],
  length: number,
  from: number,
  to: number,
  origin = 0
): TrackEvent[] => {
  if (to <= from || played.length === 0) return [];
  const events: (TrackEvent & PressedEvent)[] = [];
  const a = from - origin;
  const b = to - origin;
  // (a note through the end of a loop ends at the start of the next one: from the loop before; none before the
  // origin)
  const first = Math.max(0, Math.floor(a / length) - 1);
  const last = Math.floor((b - 1e-9) / length);
  for (let loop = first; loop <= last; loop += 1) {
    const base = loop * length;
    for (const { start, end, pitch, velocity } of played) {
      const on = base + start;
      const off = base + end;
      const pressed = on + origin;
      if (on >= a && on < b) events.push({ tick: pressed, on: true, pitch, velocity, pressed });
      if (off >= a && off < b) events.push({ tick: off + origin, on: false, pitch, velocity, pressed });
    }
  }
  return events.sort(playOrder).map(({ tick, on, pitch, velocity }) => ({ tick, on, pitch, velocity }));
};

// the position in the loop (ticks) at `tick` over the loops (a tick before beat 0: the loop before it)
export const loopTick = (tick: number, length: number) => ((tick % length) + length) % length;

// the start of the pass (a loop from `origin`; ticks over the loops) the notes sent up to `next` are in: at its end
// the player is at the start of the next one (by a hair of float either side), the pass it came from; at the origin
// itself, the pass starting there
export const passStart = (next: number, origin: number, length: number) => {
  const into = next - origin;
  const position = loopTick(into, length);
  return next - (position < EPSILON && into > EPSILON ? length : position);
};

// the pitches that sound at `position` of the loop (ticks)
export const soundingAt = (played: readonly PlayedNote[], position: number) =>
  played.filter(({ start, end }) => start <= position && position < end).map(({ pitch }) => pitch);
