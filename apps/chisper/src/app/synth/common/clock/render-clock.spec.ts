import { interval, Subject, throttleTime } from 'rxjs';
import { createRenderClock } from './render-clock';
import { after } from './synth-clock';

const RATE = 48000;

describe('createRenderClock', () => {
  it('tells the time of the frames rendered', () => {
    const render = createRenderClock(RATE);
    expect(render.clock.currentTime).toBe(0);
    expect(render.clock.sampleRate).toBe(RATE);
    render.advance(RATE / 2);
    expect(render.frame).toBe(RATE / 2);
    expect(render.clock.currentTime).toBe(0.5);
    expect(render.clock.now()).toBe(500);
    expect(render.clock.contextTimeAt(750)).toBe(0.75);
  });

  it('runs a timer once its time has come, never on its own', () => {
    const render = createRenderClock(RATE);
    const fn = jest.fn();
    after(render.clock, 0.01, fn);
    render.runDue();
    expect(fn).not.toHaveBeenCalled();
    render.advance(479);
    render.runDue();
    expect(fn).not.toHaveBeenCalled();
    render.advance(1);
    expect(fn).not.toHaveBeenCalled();
    render.runDue();
    expect(fn).toHaveBeenCalledTimes(1);
    render.advance(RATE);
    render.runDue();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(render.pending).toBe(0);
  });

  it('cancels a timer', () => {
    const render = createRenderClock(RATE);
    const fn = jest.fn();
    const cancel = after(render.clock, 0.01, fn);
    cancel();
    expect(render.pending).toBe(0);
    render.advance(RATE);
    render.runDue();
    expect(fn).not.toHaveBeenCalled();
  });

  it('runs the tasks due in the order of their times, then of their scheduling', () => {
    const render = createRenderClock(RATE);
    const order: string[] = [];
    after(render.clock, 0.02, () => order.push('late'));
    after(render.clock, 0.01, () => order.push('first'));
    after(render.clock, 0.01, () => order.push('second'));
    after(render.clock, 0, () => order.push('now'));
    render.advance(RATE);
    render.runDue();
    expect(order).toEqual(['now', 'first', 'second', 'late']);
  });

  it('runs a task a task due schedules for now in the same pass', () => {
    const render = createRenderClock(RATE);
    const order: string[] = [];
    after(render.clock, 0.01, () => {
      order.push('outer');
      after(render.clock, 0, () => order.push('inner'));
    });
    render.advance(RATE);
    render.runDue();
    expect(order).toEqual(['outer', 'inner']);
  });

  it('throttles on its own time: the leading value at once, the trailing one when its time comes', () => {
    const render = createRenderClock(RATE);
    const $values = new Subject<number>();
    const seen: [number, number][] = [];
    const subscription = $values
      .pipe(throttleTime(100, render.clock.scheduler, { leading: true, trailing: true }))
      .subscribe((value) => seen.push([value, render.clock.currentTime]));
    $values.next(1);
    $values.next(2);
    $values.next(3);
    expect(seen).toEqual([[1, 0]]);
    render.advance(RATE * 0.05);
    render.runDue();
    expect(seen).toEqual([[1, 0]]);
    render.advance(RATE * 0.05);
    render.runDue();
    expect(seen).toEqual([
      [1, 0],
      [3, 0.1],
    ]);
    // (the trailing value opens a throttle of its own)
    render.advance(RATE * 0.1);
    render.runDue();
    expect(render.pending).toBe(0);
    $values.next(4);
    expect(seen.at(-1)).toEqual([4, 0.2]);
    subscription.unsubscribe();
  });

  it('runs a period of rxjs on its time and stops it', () => {
    const render = createRenderClock(RATE);
    const ticks: number[] = [];
    const subscription = interval(10, render.clock.scheduler).subscribe((tick) => ticks.push(tick));
    render.advance(RATE * 0.035);
    render.runDue();
    // (a period from where it ran, as the timers of the page)
    expect(ticks).toEqual([0]);
    render.advance(RATE * 0.009);
    render.runDue();
    expect(ticks).toEqual([0]);
    render.advance(RATE * 0.001);
    render.runDue();
    expect(ticks).toEqual([0, 1]);
    subscription.unsubscribe();
    expect(render.pending).toBe(0);
  });
});
