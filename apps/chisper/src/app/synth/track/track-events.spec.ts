import { ClipNote } from '@chisper/preset-schema';
import { loopEvents, loopTick, passStart, playedNotes, soundingAt, withoutEnded } from './track-events';

const events = (notes: ClipNote[], length: number, from: number, to: number, origin?: number) =>
  loopEvents(playedNotes(notes, length), length, from, to, origin).map(
    ({ tick, on, pitch }) => `${on ? 'on' : 'off'} ${pitch} @${tick}`
  );

describe('playedNotes', () => {
  it('releases a note past the end of the loop at its end, leaves out one after it', () => {
    expect(
      playedNotes(
        [
          [100, 1000, 60, 90],
          [960, 10, 62, 90],
        ],
        960
      )
    ).toEqual([{ start: 100, end: 960, pitch: 60, velocity: 90 }]);
  });

  it('releases a note where the next one of its pitch starts; of two at once the longest, then the loudest', () => {
    expect(
      playedNotes(
        [
          [0, 500, 60, 90],
          [200, 100, 60, 80],
          [200, 300, 60, 70],
          [400, 100, 61, 50],
          [400, 100, 61, 60],
        ],
        960
      )
    ).toEqual([
      { start: 0, end: 200, pitch: 60, velocity: 90 },
      { start: 200, end: 500, pitch: 60, velocity: 70 },
      { start: 400, end: 500, pitch: 61, velocity: 60 },
    ]);
  });
});

describe('loopEvents', () => {
  const notes: ClipNote[] = [
    [0, 480, 60, 100],
    [480, 960, 62, 100],
  ];

  it('gives the events of a window, the offs of a tick before its ons', () => {
    expect(events(notes, 960, 0, 960)).toEqual(['on 60 @0', 'off 60 @480', 'on 62 @480']);
  });

  it('counts the loops from an origin: none before it, the ticks over the loops', () => {
    // a note through the end of the loop: its off at the start of the next one, none before the origin
    expect(events(notes, 960, 1000, 1960, 1000)).toEqual(['on 60 @1000', 'off 60 @1480', 'on 62 @1480']);
    expect(events(notes, 960, 1900, 2000, 1000)).toEqual(['off 62 @1960', 'on 60 @1960']);
  });

  it('plays the loop again: the off of a note through its end at the start of the next loop', () => {
    expect(events(notes, 960, 900, 1500)).toEqual([
      'off 62 @960',
      'on 60 @960',
      'off 60 @1440',
      'on 62 @1440',
    ]);
    // a window from the start of the next loop on
    expect(events(notes, 960, 960, 970)).toEqual(['off 62 @960', 'on 60 @960']);
  });

  it('plays the ons of a tick from the highest pitch down, its offs in the order their notes were pressed', () => {
    // a chord and a melody over it: the last one pressed (the top of the stack of mono) is released last
    const chord: ClipNote[] = [
      [0, 960, 48, 100],
      [0, 960, 64, 100],
      [0, 480, 79, 100],
      [480, 480, 76, 100],
    ];
    expect(events(chord, 1920, 0, 1920)).toEqual([
      'on 79 @0',
      'on 64 @0',
      'on 48 @0',
      'off 79 @480',
      'on 76 @480',
      'off 64 @960',
      'off 48 @960',
      'off 76 @960',
    ]);
    // through the end of the loop: the offs of the loop before (in the order they were pressed) before the ons of
    // the next one
    expect(events(chord, 960, 900, 1000)).toEqual([
      'off 64 @960',
      'off 48 @960',
      'off 76 @960',
      'on 79 @960',
      'on 64 @960',
      'on 48 @960',
    ]);
    // from an origin
    expect(events(chord, 960, 1000, 1500, 1000)).toEqual([
      'on 79 @1000',
      'on 64 @1000',
      'on 48 @1000',
      'off 79 @1480',
      'on 76 @1480',
    ]);
  });

  it('gives nothing for an empty window or no notes', () => {
    expect(events(notes, 960, 10, 10)).toEqual([]);
    expect(events([], 960, 0, 5000)).toEqual([]);
  });

  it('covers windows of many loops', () => {
    expect(events([[0, 10, 60, 100]], 960, 0, 2000)).toEqual([
      'on 60 @0',
      'off 60 @10',
      'on 60 @960',
      'off 60 @970',
      'on 60 @1920',
      'off 60 @1930',
    ]);
  });
});

describe('withoutEnded', () => {
  // the events of [from, to) but the notes ended by `now` (ticks)
  const kept = (notes: ClipNote[], from: number, to: number, now: number) =>
    withoutEnded(loopEvents(playedNotes(notes, 960), 960, from, to), (tick) => tick <= now).map(
      ({ tick, on, pitch }) => `${on ? 'on' : 'off'} ${pitch} @${tick}`
    );

  it('leaves out the on of a note that ended, keeps its off and the on of one that sounds', () => {
    const notes: ClipNote[] = [
      [0, 100, 60, 100],
      [100, 100, 62, 100],
      [150, 300, 64, 100],
    ];
    // 62 ended; 64 sounds (its off past them)
    expect(kept(notes, 50, 300, 250)).toEqual(['off 60 @100', 'on 64 @150', 'off 62 @200']);
    expect(kept(notes, 50, 460, 250)).toEqual(['off 60 @100', 'on 64 @150', 'off 62 @200', 'off 64 @450']);
    // 64 ended too
    expect(kept(notes, 50, 460, 460)).toEqual(['off 60 @100', 'off 62 @200', 'off 64 @450']);
  });

  it('of two notes of a pitch one after the other leaves out the one that ended', () => {
    const notes: ClipNote[] = [
      [0, 100, 60, 100],
      [100, 400, 60, 90],
    ];
    expect(kept(notes, 0, 200, 150)).toEqual(['off 60 @100', 'on 60 @100']);
    expect(kept(notes, 0, 200, 50)).toEqual(['on 60 @0', 'off 60 @100', 'on 60 @100']);
  });

  it('keeps all of them when none ended', () => {
    const notes: ClipNote[] = [
      [0, 100, 60, 100],
      [100, 100, 62, 100],
    ];
    const events = loopEvents(playedNotes(notes, 960), 960, 0, 960);
    expect(withoutEnded(events, (tick) => tick < 0)).toEqual(events);
  });
});

describe('loopTick, passStart and soundingAt', () => {
  it('is the position in the loop, the loop before beat 0 too', () => {
    expect(loopTick(2000, 960)).toBe(80);
    expect(loopTick(-80, 960)).toBe(880);
  });

  it('gives the start of the pass the notes sent up to a tick are in: at its end the pass it came from', () => {
    // at the origin: the pass starting there
    expect(passStart(960, 960, 960)).toBe(960);
    expect(passStart(1200, 960, 960)).toBe(960);
    // at the end of the pass, by a hair of float either side: that pass, not the next one
    expect(passStart(1920, 960, 960)).toBe(960);
    expect(passStart(1920 - 1e-9, 960, 960)).toBeCloseTo(960, 6);
    expect(passStart(1920 + 1e-9, 960, 960)).toBeCloseTo(960, 6);
    // past it: the next one
    expect(passStart(1921, 960, 960)).toBe(1920);
  });

  it('gives the pitches that sound at a position', () => {
    const played = playedNotes(
      [
        [0, 480, 60, 100],
        [0, 960, 64, 100],
      ],
      960
    );
    expect(soundingAt(played, 100)).toEqual([60, 64]);
    expect(soundingAt(played, 480)).toEqual([64]);
  });
});
