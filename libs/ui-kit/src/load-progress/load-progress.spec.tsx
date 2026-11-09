import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { drawn } from '../common/test-utils';
import { sizedElements } from '../common/test-utils/element-size';
import { advance, LoadProgress, LoadProgressLook, nextRun, Run } from '.';

// a run of a load at `progress`, nothing shown yet
const run = (progress: number, extra: Partial<Run> = {}): Run => ({
  shown: 0,
  progress,
  start: 0,
  done: false,
  shownAt: null,
  fadeAt: null,
  last: null,
  ...extra,
});

describe('nextRun', () => {
  it('starts a load from nothing, with its start share; nothing without one', () => {
    expect(nextRun(null, 0.3)).toEqual(run(0.3));
    expect(nextRun(null, 0, 0.25)).toEqual(run(0, { start: 0.25 }));
    expect(nextRun(null, null)).toBeNull();
    // (a share out of 0..1 is kept in it)
    expect(nextRun(null, 1.5)?.progress).toBe(1);
  });

  it('goes on with a larger progress from the share shown', () => {
    const going = run(0.3, { shown: 0.3, shownAt: 10, last: 20 });
    expect(nextRun(going, 0.6)).toEqual({ ...going, progress: 0.6 });
  });

  it('starts again from nothing with a smaller progress (another load, a retry) and after a load that ended', () => {
    expect(nextRun(run(0.6, { shown: 0.6, shownAt: 10 }), 0.1)).toEqual(run(0.1));
    expect(nextRun(run(0.9, { shown: 1, done: true, fadeAt: 30 }), 0.95)).toEqual(run(0.95));
  });

  it('ends the load: to the end', () => {
    expect(nextRun(run(0.4, { shown: 0.4 }), null)).toEqual(run(0.4, { shown: 0.4, done: true }));
  });
});

describe('advance', () => {
  // a frame of a run that hasn't faded out
  const frame = (from: Run, time: number) => {
    const step = advance(from, time);
    if (!step) throw new Error('faded out');
    return step;
  };
  // the frames of a screen from `from` to `to` ms
  const frames = (from: Run, to: number, at = 1000) => {
    let step = frame(from, at);
    for (let time = at + 16; time <= to; time += 16) step = frame(step.run, time);
    return step;
  };

  it('grows from nothing toward the progress', () => {
    const first = frame(run(0.8), 1000);
    expect(first.alpha).toBe(1);
    expect(first.run.shown).toBe(0);
    const second = frame(first.run, 1060);
    expect(second.run.shown).toBeGreaterThan(0);
    expect(second.run.shown).toBeLessThan(0.8);
    expect(frames(second.run, 3000, 1076).run.shown).toBeCloseTo(0.8);
  });

  it('creeps in its start share before any progress, fast then slower; the progress fills the rest', () => {
    const start = run(0, { start: 0.25 });
    const at300 = frames(start, 1300).run.shown;
    const at1000 = frames(start, 2000).run.shown;
    expect(at300).toBeGreaterThan(0.05);
    expect(at300).toBeLessThan(0.15);
    expect(at1000).toBeGreaterThan(0.18);
    expect(at1000).toBeLessThan(0.25);
    expect(frames(start, 4000).run.shown).toBeCloseTo(0.25);
    expect(frames({ ...start, progress: 0.5 }, 4000).run.shown).toBeCloseTo(0.625);
  });

  it('runs to the end once loaded, then fades out: nothing after', () => {
    let step = frame(run(0.5, { shown: 0.5, shownAt: 0, last: 1000, done: true }), 1000);
    let time = 1000;
    while (step.run.fadeAt === null) {
      time += 16;
      step = frame(step.run, time);
    }
    expect(step.run.shown).toBe(1);
    // within a few frames at the faster ease
    expect(time - 1000).toBeLessThan(500);
    const { fadeAt } = step.run;
    expect(frame(step.run, fadeAt + 160).alpha).toBeCloseTo(0.5);
    expect(advance(step.run, fadeAt + 320)).toBeNull();
  });
});

describe('LoadProgress', () => {
  let restoreSize: () => void;
  beforeEach(() => {
    jest.useFakeTimers();
    restoreSize = sizedElements(200, 24).restore;
  });
  afterEach(() => {
    restoreSize();
    jest.useRealTimers();
  });

  const frames = (ms: number) => act(() => jest.advanceTimersByTime(ms));
  const setup = (progress: number | null, look: LoadProgressLook = 'fill') => {
    const result = render(<LoadProgress progress={progress} look={look} color='#3498db' />);
    const canvas = result.container.querySelector('canvas');
    const update = (next: number | null) =>
      result.rerender(<LoadProgress progress={next} look={look} color='#3498db' />);
    return { canvas, update };
  };
  // the width of the bar drawn: its first rect from the left
  const barWidth = (canvas: Element | null) =>
    drawn(canvas).find(({ op, rects }) => op === 'fill' && rects[0]?.[0] === 0)?.rects[0][2];

  it('draws nothing and runs no frame while nothing loads', () => {
    const { canvas } = setup(null);
    frames(100);
    expect(drawn(canvas)).toEqual([]);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('draws the bar to the share loaded, a progressbar while it loads', () => {
    const { canvas, update } = setup(0.25);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('25');
    frames(1000);
    expect(barWidth(canvas)).toBeCloseTo(50, 0);

    update(0.75);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('75');
    frames(1000);
    expect(barWidth(canvas)).toBeCloseTo(150, 0);
  });

  it('runs to the end once loaded, fades out and stops its frames', () => {
    const { canvas, update } = setup(0.5);
    frames(500);
    update(null);
    expect(screen.queryByRole('progressbar')).toBeNull();
    frames(400);
    expect(barWidth(canvas)).toBe(200);
    frames(400);
    expect(drawn(canvas)).toEqual([]);
    expect(jest.getTimerCount()).toBe(0);

    // a load after it starts again, from nothing
    update(0.1);
    frames(50);
    expect(barWidth(canvas)).toBeLessThan(20);
    frames(1000);
    expect(barWidth(canvas)).toBeCloseTo(20, 0);
  });

  it('draws a gradient alone to the share loaded', () => {
    const { canvas } = setup(0.5, 'gradient');
    frames(1000);
    const shapes = drawn(canvas);
    expect(shapes).toHaveLength(1);
    expect(shapes[0].op).toBe('fill');
    expect(shapes[0].rects[0][2]).toBeCloseTo(100, 0);
    expect(shapes[0].rects[0][3]).toBe(24);
  });

  it('creeps in its start share as a load starts, the progress fills the rest', () => {
    const result = render(<LoadProgress progress={0} look='gradient' color='#2ecc71' start={0.25} />);
    const canvas = result.container.querySelector('canvas');
    frames(100);
    // (moving: not there at once)
    expect(barWidth(canvas)).toBeLessThan(25);
    frames(3000);
    expect(barWidth(canvas)).toBeCloseTo(50, 0);
    // (the progressbar tells the progress itself)
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0');

    result.rerender(<LoadProgress progress={0.5} look='gradient' color='#2ecc71' start={0.25} />);
    frames(1000);
    expect(barWidth(canvas)).toBeCloseTo(125, 0);
  });

  it('stops its frames when it unmounts', () => {
    const result = render(<LoadProgress progress={0.5} look='fill' color='#3498db' />);
    frames(100);
    result.unmount();
    expect(jest.getTimerCount()).toBe(0);
  });
});
