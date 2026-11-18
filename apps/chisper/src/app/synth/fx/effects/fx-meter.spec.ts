import { createFxMeter } from './fx-meter';

describe('createFxMeter', () => {
  it('tells when the first watcher comes and when the last one leaves', () => {
    const onWatch = jest.fn();
    const meters = createFxMeter<number>(onWatch);
    const first = meters.meter.watch(jest.fn());
    const second = meters.meter.watch(jest.fn());
    expect(onWatch.mock.calls).toEqual([[true]]);
    first();
    first();
    expect(onWatch).toHaveBeenCalledTimes(1);
    second();
    expect(onWatch.mock.calls).toEqual([[true], [false]]);
  });

  it('gives its values to every watcher', () => {
    const meters = createFxMeter<{ level: number }>(jest.fn());
    const [first, second] = [jest.fn(), jest.fn()];
    meters.meter.watch(first);
    const stop = meters.meter.watch(second);
    meters.emit({ level: 1 });
    stop();
    meters.emit({ level: 2 });
    expect(first.mock.calls).toEqual([[{ level: 1 }], [{ level: 2 }]]);
    expect(second.mock.calls).toEqual([[{ level: 1 }]]);
  });

  it('cleared (its effect destroyed): no watcher is told, its values stop, one that leaves then tells nothing', () => {
    const onWatch = jest.fn();
    const meters = createFxMeter<number>(onWatch);
    const watcher = jest.fn();
    const stop = meters.meter.watch(watcher);
    meters.clear();
    expect(onWatch.mock.calls).toEqual([[true], [false]]);
    meters.emit(1);
    stop();
    expect(watcher).not.toHaveBeenCalled();
    expect(onWatch).toHaveBeenCalledTimes(2);
  });

  it('cleared while no one watches: nothing is told', () => {
    const onWatch = jest.fn();
    const meters = createFxMeter<number>(onWatch);
    meters.clear();
    expect(onWatch).not.toHaveBeenCalled();
    meters.meter.watch(jest.fn())();
    meters.clear();
    expect(onWatch.mock.calls).toEqual([[true], [false]]);
  });
});
