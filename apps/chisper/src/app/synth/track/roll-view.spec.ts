import { CLIP_BAR, CLIP_PITCH_MIN, CLIP_PPQ, ClipNote } from '@chisper/preset-schema';
import {
  clampTop,
  endInView,
  headAt,
  inPitches,
  fitLoop,
  loopEndAt,
  fitView,
  followView,
  noteToAdd,
  laneVelocity,
  laneY,
  clampView,
  overviewHit,
  overviewResize,
  overviewTickAt,
  overviewWindow,
  RollView,
  SCALE_MAX,
  scrollView,
  stemNotes,
  stemSpan,
  tickX,
  visibleTicks,
  xTick,
  zoomAt,
  zoomRows,
} from './roll-view';

// 4 bars across 1000 px: a bar of 250 px
const view: RollView = { tick0: 0, scale: 1000 / (4 * CLIP_BAR), top: 80, row: 14, width: 1000, height: 420 };

describe('roll view', () => {
  it('fits the loop, or a span of it, across 96% of the width, the notes in the middle of the height', () => {
    const notes: ClipNote[] = [[0, CLIP_PPQ, 48, 100]];
    expect(fitView(notes, 4 * CLIP_BAR, 1000, 420).scale).toBeCloseTo(960 / (4 * CLIP_BAR), 9);
    const bar = fitView(notes, 4 * CLIP_BAR, 1000, 420, 18, CLIP_BAR);
    expect(bar.scale).toBeCloseTo(960 / CLIP_BAR, 9);
    expect(bar.row).toBe(18);
    // 24 rows: 48 in the middle
    expect(bar.top).toBe(48 + 12);
  });

  it('fits the loop and a bar after it across the whole width, from the start', () => {
    const notes: ClipNote[] = [[0, CLIP_PPQ, 48, 100]];
    const fitted = fitLoop(notes, 4 * CLIP_BAR, 1000, 420);
    expect(fitted.tick0).toBe(0);
    // the end of the loop a bar from the right edge
    expect(xTick(fitted, 1000)).toBeCloseTo(5 * CLIP_BAR, 6);
    expect(fitted.top).toBe(48 + 15);
  });

  it('keeps the end of the loop dragged on the screen, on the steps, a beat at least', () => {
    const SIXTEENTH = CLIP_PPQ / 4;
    expect(loopEndAt(view, 2 * CLIP_BAR + 200, SIXTEENTH)).toBe(2 * CLIP_BAR + SIXTEENTH);
    // past the right edge: at it
    expect(loopEndAt(view, 10 * CLIP_BAR, SIXTEENTH)).toBe(4 * CLIP_BAR);
    // an edge between steps: the last step before it
    const between = { ...view, scale: 1000 / (4 * CLIP_BAR - 100) };
    expect(loopEndAt(between, 5 * CLIP_BAR, SIXTEENTH)).toBe(4 * CLIP_BAR - SIXTEENTH);
    // an edge at a step in floats: that step
    const fitted = fitLoop([], 4 * CLIP_BAR, 1000, 420);
    expect(loopEndAt(fitted, 6 * CLIP_BAR, CLIP_BAR)).toBe(5 * CLIP_BAR);
    // past the left edge of a view scrolled: at it
    const scrolled = { ...view, tick0: 2 * CLIP_BAR };
    expect(loopEndAt(scrolled, 0, CLIP_BAR)).toBe(2 * CLIP_BAR);
    expect(loopEndAt(view, -100, SIXTEENTH)).toBe(CLIP_PPQ);
    expect(endInView(view, 4 * CLIP_BAR)).toBe(true);
    expect(endInView(view, 4 * CLIP_BAR + 10)).toBe(false);
    expect(endInView(scrolled, 2 * CLIP_BAR - 10)).toBe(false);
  });

  it('zooms across around a point: the tick under it stays, within the scales', () => {
    const zoomed = zoomAt(view, 2, 300);
    expect(zoomed.scale).toBeCloseTo(view.scale * 2, 9);
    expect(xTick(zoomed, 300)).toBeCloseTo(xTick(view, 300), 6);
    expect(zoomAt(view, 1e6).scale).toBe(SCALE_MAX);
    // never before the start of the loop
    expect(zoomAt(view, 0.5, 0).tick0).toBe(0);
  });

  it('makes the rows taller or lower, the top row within the pitches', () => {
    expect(zoomRows(view, 2).row).toBe(28);
    expect(zoomRows(view, 100).row).toBe(32);
    // the rows under it end at C0
    expect(zoomRows({ ...view, top: 5 }, 0.5).top).toBe(CLIP_PITCH_MIN + Math.ceil(420 / 7) - 1);
    expect(clampTop(200, view)).toBe(127);
    // C0 whole at the bottom: 30 rows of 14 px in 425
    expect(clampTop(0, { height: 425, row: 14 })).toBe(CLIP_PITCH_MIN + 29);
    expect([11, 12, 127, 128].map(inPitches)).toEqual([false, true, true, false]);
  });

  it('scrolls across and over the rows, from the start of the loop on', () => {
    expect(scrollView(view, CLIP_BAR, 2)).toMatchObject({ tick0: CLIP_BAR, top: 78 });
    expect(scrollView(view, -CLIP_BAR).tick0).toBe(0);
  });

  it('follows the playhead: pages once it leaves a view it was in, to its bar', () => {
    const near = { ...view, scale: view.scale * 2 };
    const end = visibleTicks(near);
    expect(end).toBeCloseTo(2 * CLIP_BAR, 6);
    // within: stays
    expect(followView(near, CLIP_BAR, CLIP_BAR + 10)).toBeNull();
    // past its end: to the bar it is in
    expect(followView(near, end - 10, end + 5)).toBe(2 * CLIP_BAR);
    // round the loop to its start
    expect(followView({ ...near, tick0: 2 * CLIP_BAR }, 4 * CLIP_BAR - 5, 3)).toBe(0);
    // a view scrolled away from it: left alone
    expect(followView({ ...near, tick0: 8 * CLIP_BAR }, CLIP_BAR, 3 * CLIP_BAR)).toBeNull();
    // as the following starts: a view without it goes to it, one with it stays
    expect(followView({ ...near, tick0: 8 * CLIP_BAR }, null, 3 * CLIP_BAR)).toBe(3 * CLIP_BAR);
    expect(followView(near, null, 3 * CLIP_BAR)).toBe(3 * CLIP_BAR);
    expect(followView(near, null, CLIP_BAR)).toBeNull();
    // past the middle of a bar wider than the view: to the playhead itself
    const narrow = { ...view, scale: (4 * view.scale) / 0.5, tick0: 0 };
    const half = visibleTicks(narrow);
    expect(followView(narrow, half - 1, CLIP_BAR - 10)).toBe(CLIP_BAR - 10);
  });

  it('keeps a view within the bars of the roll: no narrower than all of them, scrolled up to their end', () => {
    // 4 bars across 1000 px (96%): no zoom out past it, no scroll past their end
    const bars = 4 * CLIP_BAR;
    const fitted = clampView({ ...view, tick0: 1000, scale: 0.01 }, bars);
    expect(fitted.tick0).toBe(0);
    expect(fitted.scale).toBeCloseTo(960 / bars, 9);
    const near = { ...view, scale: (2 * 960) / bars };
    expect(clampView({ ...near, tick0: 1e6 }, bars).tick0).toBeCloseTo(bars / 0.96 - 1000 / near.scale, 6);
    expect(clampView({ ...near, tick0: -5 }, bars).tick0).toBe(0);
    // within it: the same view, more bars too
    expect(clampView(fitted, bars)).toBe(fitted);
    expect(clampView(fitted, 2 * bars)).toBe(fitted);
  });

  it('shows the window of the view on the overview of the bars; its edges dragged zoom, the other edge stays', () => {
    const bars = 4 * CLIP_BAR;
    const extent = bars / 0.96;
    // all the bars across: all of the overview
    const fitted = clampView({ ...view, scale: 0.01 }, bars);
    expect(overviewWindow(fitted, bars, 400)).toEqual([0, 400]);
    expect(overviewHit(fitted, bars, 400, 397)).toBe('end');
    expect(overviewHit(fitted, bars, 400, 3)).toBe('start');
    expect(overviewHit(fitted, bars, 400, 200)).toBe('inside');
    expect(overviewTickAt(bars, 400, 200)).toBeCloseTo(extent / 2, 6);
    // the end to the middle: twice as wide, from the start
    const half = overviewResize(fitted, bars, 400, 200, 'end');
    expect(half.tick0).toBe(0);
    expect(half.scale).toBeCloseTo(2 * fitted.scale, 9);
    expect(overviewHit(half, bars, 400, 300)).toBe('outside');
    // the start to a quarter: the end stays
    const quarter = overviewResize(half, bars, 400, 100, 'start');
    expect(quarter.tick0).toBeCloseTo(extent / 4, 6);
    expect(quarter.tick0 + visibleTicks(quarter)).toBeCloseTo(extent / 2, 6);
    // not past the edge before it, not narrower than the most zoom
    const least = overviewResize(half, bars, 400, 300, 'start');
    expect(least.scale).toBe(SCALE_MAX);
    expect(least.tick0 + visibleTicks(least)).toBeCloseTo(extent / 2, 6);
  });

  it('places the note a press would add: on the grid, in the bars and the pitches', () => {
    const tick = CLIP_PPQ + 100.4;
    expect(noteToAdd(tick, 60, CLIP_PPQ, true, CLIP_BAR, 240)).toEqual([CLIP_PPQ, 240, 60]);
    expect(noteToAdd(tick, 60, CLIP_PPQ, false, CLIP_BAR, 240)?.[0]).toBe(CLIP_PPQ + 100);
    // within the bars
    expect(noteToAdd(CLIP_BAR - 10, 60, CLIP_PPQ, true, CLIP_BAR, CLIP_PPQ * 2)).toEqual([
      CLIP_BAR - CLIP_PPQ,
      CLIP_PPQ,
      60,
    ]);
    expect(noteToAdd(CLIP_BAR, 60, CLIP_PPQ, true, CLIP_BAR, 240)).toBeNull();
    expect(noteToAdd(-1, 60, CLIP_PPQ, true, CLIP_BAR, 240)).toBeNull();
    expect(noteToAdd(tick, CLIP_PITCH_MIN - 1, CLIP_PPQ, true, CLIP_BAR, 240)).toBeNull();
  });

  it('maps the velocities over the height of their lane and back, within it', () => {
    expect(laneY(64, 127)).toBe(4);
    expect(laneY(64, 0)).toBe(60);
    [1, 40, 100, 127].forEach((velocity) => expect(laneVelocity(64, laneY(64, velocity))).toBe(velocity));
    // past the lane: its edges
    expect(laneVelocity(64, -2000)).toBe(127);
    expect(laneVelocity(64, 2000)).toBe(1);
  });

  it('finds the notes of the stem nearest a point: all of a chord, those on its pixel', () => {
    // a bar 250 px
    const notes: ClipNote[] = [
      [0, CLIP_PPQ, 60, 100],
      [CLIP_BAR, CLIP_PPQ, 62, 100],
      [CLIP_BAR, CLIP_PPQ, 65, 80],
      // a tick on: on the pixel of the chord
      [CLIP_BAR + 1, CLIP_PPQ, 69, 60],
      [CLIP_BAR + 40, CLIP_PPQ, 72, 60],
    ];
    const x = tickX(view, CLIP_BAR);
    expect(stemNotes(notes, view, x - 3)).toEqual([1, 2, 3]);
    expect(stemNotes(notes, view, 2)).toEqual([0]);
    // on the heads (10 px across from the stem): the nearer stem of two
    expect(stemNotes(notes, view, tickX(view, CLIP_BAR + 40) + 2)).toEqual([4]);
    expect(stemNotes(notes, view, tickX(view, CLIP_BAR + 40) + 9)).toEqual([4]);
    // beside the head of the first note
    expect(stemNotes(notes, view, 15)).toEqual([0]);
    expect(stemNotes(notes, view, 17)).toEqual([]);
    expect(stemNotes(notes, view, x + 20)).toEqual([]);
    // among some notes only: a note of the chord, the stem beside on the heads
    expect(stemNotes(notes, view, x - 3, new Set([2]))).toEqual([2]);
    expect(stemNotes(notes, view, tickX(view, CLIP_BAR + 40) + 2, new Set([1]))).toEqual([1]);
    expect(stemNotes(notes, view, 2, new Set([1]))).toEqual([]);
    // the head nearest a point of the lane: of the chord, the one at 80 by 70
    expect(headAt(notes, [1, 2, 3], 64, laneY(64, 70))).toBe(2);
    expect(headAt(notes, [1, 2, 3], 64, laneY(64, 127))).toBe(1);
    // the span of a stem and its heads, wider by a reach
    const [from, to] = stemSpan(notes, view, [1, 2, 3], 12);
    expect(from).toBeCloseTo(x - 12, 9);
    expect(to).toBeCloseTo(tickX(view, CLIP_BAR + 1) + 10 + 12, 9);
  });
});
