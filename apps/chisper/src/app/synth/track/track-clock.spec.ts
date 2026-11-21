import { recordAnalytics } from '../../../test-utils/analytics';
import { createTrackClock, TICK_MS } from './track-clock';

// a worker of the clock: the messages the page posted to it, `tick` answers as it would
const workerStub = () => {
  const worker = {
    posted: [] as unknown[],
    onmessage: null as (() => void) | null,
    onerror: null as ((event: Event) => void) | null,
    postMessage: (message: unknown) => worker.posted.push(message),
    terminate: jest.fn(),
    tick: () => worker.onmessage?.(),
  };
  return worker;
};

afterEach(() => jest.useRealTimers());

describe('createTrackClock', () => {
  it('ticks by its worker while it runs: started with the interval, stopped with 0', () => {
    const worker = workerStub();
    const onTick = jest.fn();
    const createWorker = jest.fn<Worker, [string]>(() => worker as unknown as Worker);
    const clock = createTrackClock(onTick, createWorker);
    expect(createWorker).not.toHaveBeenCalled();
    clock.start();
    expect(createWorker.mock.calls[0][0]).toMatch(/assets\/worklets\/track-clock\.js$/);
    expect(worker.posted).toEqual([TICK_MS]);
    worker.tick();
    expect(onTick).toHaveBeenCalledTimes(1);
    clock.stop();
    expect(worker.posted).toEqual([TICK_MS, 0]);
    clock.start();
    expect(createWorker).toHaveBeenCalledTimes(1);
    clock.destroy();
    expect(worker.terminate).toHaveBeenCalled();
  });

  it('ticks by the timer of the page without a worker, or once its script failed', () => {
    jest.useFakeTimers();
    const onTick = jest.fn();
    const clock = createTrackClock(onTick, null);
    clock.start();
    jest.advanceTimersByTime(TICK_MS * 3);
    expect(onTick).toHaveBeenCalledTimes(3);
    clock.stop();
    jest.advanceTimersByTime(TICK_MS * 3);
    expect(onTick).toHaveBeenCalledTimes(3);

    const worker = workerStub();
    const failing = createTrackClock(onTick, () => worker as unknown as Worker);
    failing.start();
    const { errors } = recordAnalytics();
    worker.onerror?.(
      new ErrorEvent('error', { message: 'Uncaught SyntaxError', filename: 'track-clock.js' })
    );
    jest.advanceTimersByTime(TICK_MS);
    expect(onTick).toHaveBeenCalledTimes(4);
    failing.destroy();
    // (the failure of its script is reported, as a worker's)
    expect(errors.map(({ properties }) => properties)).toEqual([{ source: 'worker', worker: 'track-clock' }]);
    expect(errors[0].error).toMatchObject({ name: 'WorkerError', message: 'Uncaught SyntaxError' });
  });
});
