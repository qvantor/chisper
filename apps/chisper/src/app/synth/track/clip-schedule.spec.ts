import { CLIP_BAR, CLIP_PPQ, ClipNote } from '@chisper/preset-schema';
import { clipKeys } from './clip-schedule';

const key = (tick: number, on: boolean, pitch: number, velocity: number) => ({ tick, on, pitch, velocity });

describe('clipKeys', () => {
  it('presses and releases each note at its ticks, one pass', () => {
    const notes: ClipNote[] = [
      [0, CLIP_PPQ, 60, 100],
      [CLIP_PPQ, CLIP_PPQ / 2, 64, 80],
    ];
    expect(clipKeys(notes, CLIP_BAR)).toEqual([
      key(0, true, 60, 100),
      key(CLIP_PPQ, false, 60, 100),
      key(CLIP_PPQ, true, 64, 80),
      key(1.5 * CLIP_PPQ, false, 64, 80),
    ]);
  });

  it('plays the loop again in each pass, its ticks over the passes', () => {
    const notes: ClipNote[] = [[CLIP_PPQ, CLIP_PPQ, 60, 100]];
    expect(clipKeys(notes, CLIP_BAR, 2)).toEqual([
      key(CLIP_PPQ, true, 60, 100),
      key(2 * CLIP_PPQ, false, 60, 100),
      key(CLIP_BAR + CLIP_PPQ, true, 60, 100),
      key(CLIP_BAR + 2 * CLIP_PPQ, false, 60, 100),
    ]);
  });

  it('releases a note through the end of the loop there: the last pass at its end, without the ons after it', () => {
    const notes: ClipNote[] = [
      [0, CLIP_PPQ, 62, 90],
      [3 * CLIP_PPQ, 4 * CLIP_PPQ, 60, 100],
    ];
    expect(clipKeys(notes, CLIP_BAR, 2)).toEqual([
      key(0, true, 62, 90),
      key(CLIP_PPQ, false, 62, 90),
      key(3 * CLIP_PPQ, true, 60, 100),
      key(CLIP_BAR, false, 60, 100),
      key(CLIP_BAR, true, 62, 90),
      key(CLIP_BAR + CLIP_PPQ, false, 62, 90),
      key(CLIP_BAR + 3 * CLIP_PPQ, true, 60, 100),
      key(2 * CLIP_BAR, false, 60, 100),
    ]);
  });

  it('a note longer than the loop and a note past its end: released at the end, left out', () => {
    const notes: ClipNote[] = [
      [0, 3 * CLIP_BAR, 60, 100],
      [CLIP_BAR + CLIP_PPQ, CLIP_PPQ, 72, 100],
    ];
    expect(clipKeys(notes, CLIP_BAR)).toEqual([key(0, true, 60, 100), key(CLIP_BAR, false, 60, 100)]);
  });

  it('a note of a pitch held starts it over: released at its start (a voice of a pitch at a time)', () => {
    const notes: ClipNote[] = [
      [0, 2 * CLIP_PPQ, 60, 100],
      [CLIP_PPQ, CLIP_PPQ, 60, 70],
    ];
    expect(clipKeys(notes, CLIP_BAR)).toEqual([
      key(0, true, 60, 100),
      key(CLIP_PPQ, false, 60, 100),
      key(CLIP_PPQ, true, 60, 70),
      key(2 * CLIP_PPQ, false, 60, 70),
    ]);
  });

  it('a chord: the ons from the highest pitch down, the offs in the order they were pressed', () => {
    const notes: ClipNote[] = [
      [0, CLIP_PPQ, 60, 100],
      [0, CLIP_PPQ, 67, 100],
      [0, CLIP_PPQ, 64, 100],
    ];
    expect(clipKeys(notes, CLIP_BAR).map(({ on, pitch }) => [on, pitch])).toEqual([
      [true, 67],
      [true, 64],
      [true, 60],
      [false, 67],
      [false, 64],
      [false, 60],
    ]);
  });

  it('no notes, no keys', () => {
    expect(clipKeys([], CLIP_BAR, 2)).toEqual([]);
  });
});
