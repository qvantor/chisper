import { workletUrl } from '../fx/effects/load-worklet';

// the name of the bundle of the clock worker (`npm run worklets`)
export const TRACK_CLOCK_WORKER = 'track-clock';
// ms between two ticks of the track: it sends its notes TRACK_LEAD ahead, every tick those up to then
export const TICK_MS = 10;

export interface TrackClock {
  start: () => void;
  stop: () => void;
  destroy: () => void;
}

export type CreateTrackClock = (onTick: () => void) => TrackClock;

// ticks of a worker (track-clock.worker.ts): its timers aren't throttled in a hidden page; without a worker (or one
// whose script failed) the timer of the page
export const createTrackClock = (
  onTick: () => void,
  createWorker: ((url: string) => Worker) | null = typeof Worker === 'undefined'
    ? null
    : (url) => new Worker(url)
): TrackClock => {
  let worker: Worker | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  const startTimer = () => {
    if (timer === null) timer = setInterval(onTick, TICK_MS);
  };
  const stopTimer = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const ensureWorker = () => {
    if (worker || !createWorker) return worker;
    try {
      worker = createWorker(workletUrl(TRACK_CLOCK_WORKER));
      worker.onmessage = () => onTick();
      // its script failed: the timer of the page from then on
      worker.onerror = () => {
        worker?.terminate();
        worker = null;
        createWorker = null;
        if (running) startTimer();
      };
    } catch {
      worker = null;
      createWorker = null;
    }
    return worker;
  };
  return {
    start: () => {
      running = true;
      const ticker = ensureWorker();
      if (ticker) ticker.postMessage(TICK_MS);
      else startTimer();
    },
    stop: () => {
      running = false;
      worker?.postMessage(0);
      stopTimer();
    },
    destroy: () => {
      running = false;
      stopTimer();
      worker?.terminate();
      worker = null;
    },
  };
};
