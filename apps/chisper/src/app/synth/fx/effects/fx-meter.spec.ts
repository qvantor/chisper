import { createFxMeter } from './fx-meter';

describe('createFxMeter', () => {
  it('asks the worklet for the meter when the first watcher comes, stops it when the last one leaves', () => {
    const post = jest.fn();
    const meters = createFxMeter<number>(post);
    expect(meters.watched()).toBe(false);
    const first = meters.meter.watch(jest.fn());
    const second = meters.meter.watch(jest.fn());
    expect(post.mock.calls).toEqual([[{ meter: true }]]);
    expect(meters.watched()).toBe(true);
    first();
    first();
    expect(post).toHaveBeenCalledTimes(1);
    second();
    expect(post.mock.calls).toEqual([[{ meter: true }], [{ meter: false }]]);
    expect(meters.watched()).toBe(false);
  });

  it('gives a meter of the worklet to every watcher, nothing of another message', () => {
    const meters = createFxMeter<{ level: number }>(jest.fn());
    const [first, second] = [jest.fn(), jest.fn()];
    meters.meter.watch(first);
    const stop = meters.meter.watch(second);
    meters.take({ meter: { level: 1 } });
    meters.take({ other: 1 });
    meters.take(null);
    stop();
    meters.take({ meter: { level: 2 } });
    expect(first.mock.calls).toEqual([[{ level: 1 }], [{ level: 2 }]]);
    expect(second.mock.calls).toEqual([[{ level: 1 }]]);
  });

  it('cleared (its effect destroyed): no watcher is told, one that leaves then tells the worklet nothing', () => {
    const post = jest.fn();
    const meters = createFxMeter<number>(post);
    const watcher = jest.fn();
    const stop = meters.meter.watch(watcher);
    meters.clear();
    meters.take({ meter: 1 });
    stop();
    expect(watcher).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
  });
});
