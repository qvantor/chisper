import { sharedLoads } from './shared-loads';

// loads that stay pending until the test settles them, in the order they started, each with the signal it got and
// the function it reports its progress to
const createLoads = () => {
  const started: {
    signal: AbortSignal;
    report: (share: number) => void;
    resolve: (value: string) => void;
    reject: (error: unknown) => void;
  }[] = [];
  const start = jest.fn(
    (_id: string, signal: AbortSignal, report: (share: number) => void) =>
      new Promise<string>((resolve, reject) => started.push({ signal, report, resolve, reject }))
  );
  return { load: sharedLoads(start), start, started };
};

describe('sharedLoads', () => {
  it('loads an id once for every caller, while it loads and after', async () => {
    const { load, start, started } = createLoads();
    const first = load('a', new AbortController().signal);
    const second = load('a');
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith('a', expect.any(AbortSignal), expect.any(Function));

    started[0].resolve('table');
    await expect(first).resolves.toBe('table');
    await expect(second).resolves.toBe('table');
    await expect(load('a', new AbortController().signal)).resolves.toBe('table');
    load('b');
    expect(start.mock.calls.map(([id]) => id)).toEqual(['a', 'b']);
  });

  it('drops a failed load: the next call loads it again', async () => {
    const { load, start, started } = createLoads();
    const failed = load('a');
    started[0].reject(new Error('404'));
    await expect(failed).rejects.toThrow('404');

    const again = load('a');
    expect(start).toHaveBeenCalledTimes(2);
    started[1].resolve('table');
    await expect(again).resolves.toBe('table');
  });

  it('gives a caller that aborts its reason at once, the load goes on for the others', async () => {
    const { load, started } = createLoads();
    const gone = new AbortController();
    const reason = new Error('a newer path');
    const left = load('a', gone.signal);
    const kept = load('a', new AbortController().signal);

    gone.abort(reason);
    await expect(left).rejects.toBe(reason);
    expect(started[0].signal.aborted).toBe(false);

    started[0].resolve('table');
    await expect(kept).resolves.toBe('table');
  });

  it('aborts a load every caller gave up, with the reason of the last, and loads it again on the next call', async () => {
    const { load, start, started } = createLoads();
    const callers = [new AbortController(), new AbortController()];
    const loads = callers.map(({ signal }) => load('a', signal));
    loads.forEach((loading) => loading.catch(() => undefined));

    callers[0].abort();
    expect(started[0].signal.aborted).toBe(false);
    const reason = new Error('stopped');
    callers[1].abort(reason);
    expect(started[0].signal.aborted).toBe(true);
    expect(started[0].signal.reason).toBe(reason);

    const again = load('a');
    expect(start).toHaveBeenCalledTimes(2);
    // the aborted load ends: the new one stays
    started[0].reject(reason);
    await Promise.resolve();
    load('a');
    expect(start).toHaveBeenCalledTimes(2);
    started[1].resolve('table');
    await expect(again).resolves.toBe('table');
  });

  it('keeps a load a caller without a signal waits for', async () => {
    const { load, started } = createLoads();
    const caller = new AbortController();
    load('a', caller.signal).catch(() => undefined);
    const kept = load('a');

    caller.abort();
    expect(started[0].signal.aborted).toBe(false);
    started[0].resolve('table');
    await expect(kept).resolves.toBe('table');
  });

  it('aborts nothing once the load settled', async () => {
    const { load, started } = createLoads();
    const caller = new AbortController();
    const loaded = load('a', caller.signal);
    started[0].resolve('table');
    await expect(loaded).resolves.toBe('table');

    caller.abort();
    expect(started[0].signal.aborted).toBe(false);
    await expect(load('a')).resolves.toBe('table');
  });

  it('starts nothing for a signal aborted before', async () => {
    const { load, start } = createLoads();
    const reason = new Error('gone');
    await expect(load('a', AbortSignal.abort(reason))).rejects.toBe(reason);
    expect(start).not.toHaveBeenCalled();
  });

  describe('the progress of a load', () => {
    it('goes to every caller that follows it, the last share at once to one that joins it', async () => {
      const { load, started } = createLoads();
      const first = jest.fn();
      const second = jest.fn();
      const loaded = load('a', new AbortController().signal, first);
      // (a caller without it waits all the same)
      load('a');
      started[0].report(0);
      started[0].report(0.25);
      load('a', undefined, second);
      started[0].report(0.5);

      expect(first.mock.calls).toEqual([[0], [0.25], [0.5]]);
      expect(second.mock.calls).toEqual([[0.25], [0.5]]);

      started[0].resolve('table');
      await loaded;
      started[0].report(1);
      expect(first).toHaveBeenCalledTimes(3);
    });

    it('stops for a caller that left, goes on for the others', () => {
      const { load, started } = createLoads();
      const gone = new AbortController();
      const left = jest.fn();
      const kept = jest.fn();
      load('a', gone.signal, left).catch(() => undefined);
      load('a', new AbortController().signal, kept);
      started[0].report(0.1);

      gone.abort();
      started[0].report(0.2);
      expect(left.mock.calls).toEqual([[0.1]]);
      expect(kept.mock.calls).toEqual([[0.1], [0.2]]);
    });

    it('gives nothing to a caller of a load done: it is played at once', async () => {
      const { load, started } = createLoads();
      const loaded = load('a');
      started[0].report(1);
      started[0].resolve('table');
      await loaded;

      const progress = jest.fn();
      await expect(load('a', undefined, progress)).resolves.toBe('table');
      expect(progress).not.toHaveBeenCalled();
    });

    it('starts from nothing for a load started again after a failure', async () => {
      const { load, started } = createLoads();
      const failed = load('a');
      started[0].report(0.5);
      started[0].reject(new Error('404'));
      await expect(failed).rejects.toThrow('404');

      const progress = jest.fn();
      load('a', undefined, progress);
      expect(progress).not.toHaveBeenCalled();
      started[1].report(0);
      expect(progress.mock.calls).toEqual([[0]]);
    });
  });
});
