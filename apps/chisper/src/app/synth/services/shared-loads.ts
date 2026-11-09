import type { ReportProgress } from './fetch';

// the share of a load done last reported (null: none yet) and the callers that follow it
interface Progress {
  share: number | null;
  listeners: Set<ReportProgress>;
}

interface Shared<T> {
  promise: Promise<T>;
  controller: AbortController;
  // the callers waiting for it (one without a signal waits to its end)
  waiting: number;
  settled: boolean;
  progress: Progress;
}

// loads by their ids for the session, shared by their callers (both oscillators on one table): a failed one is
// dropped, so the next call loads it again; a caller whose signal aborts gets its reason at once, and a load every
// caller gave up (a newer path, the model stopped) is aborted, its download too, and dropped: on a slow line the
// loads no one waits for any more would share it with the one played. A caller with `onProgress` follows the share
// of the load done (the last one at once: it may join a load under way) until it settles or the caller leaves
export const sharedLoads = <T>(
  load: (id: string, signal: AbortSignal, onProgress: ReportProgress) => Promise<T>
) => {
  const loads = new Map<string, Shared<T>>();
  const drop = (id: string, shared: Shared<T>) => {
    if (loads.get(id) === shared) loads.delete(id);
  };
  const start = (id: string) => {
    const controller = new AbortController();
    const progress: Progress = { share: null, listeners: new Set() };
    const report = (share: number) => {
      progress.share = share;
      progress.listeners.forEach((listener) => listener(share));
    };
    const created: Shared<T> = {
      promise: load(id, controller.signal, report),
      controller,
      waiting: 0,
      settled: false,
      progress,
    };
    const settle = () => {
      created.settled = true;
      progress.listeners.clear();
    };
    created.promise.then(settle, () => {
      settle();
      drop(id, created);
    });
    loads.set(id, created);
    return created;
  };
  return (id: string, signal?: AbortSignal, onProgress?: ReportProgress): Promise<T> => {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const waited = loads.get(id) ?? start(id);
    if (waited.settled) return waited.promise;
    waited.waiting++;
    // (its own function: the same one given twice is two callers)
    const listener: ReportProgress | null = onProgress ? (share) => onProgress(share) : null;
    if (listener) {
      waited.progress.listeners.add(listener);
      if (waited.progress.share !== null) listener(waited.progress.share);
    }
    if (!signal) return waited.promise;
    return new Promise<T>((resolve, reject) => {
      const leave = () => {
        if (listener) waited.progress.listeners.delete(listener);
        reject(signal.reason);
        if (--waited.waiting > 0 || waited.settled) return;
        drop(id, waited);
        waited.controller.abort(signal.reason);
      };
      signal.addEventListener('abort', leave, { once: true });
      waited.promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', leave));
    });
  };
};
