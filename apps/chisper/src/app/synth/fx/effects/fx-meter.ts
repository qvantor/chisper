import type { FxMeter } from './types';

// The meter of an effect on the main thread: its values come only while someone watches (`onWatch` is told when
// the first watcher comes and when the last one leaves), `emit` gives them to every watcher
export const createFxMeter = <Values>(onWatch: (watched: boolean) => void) => {
  const listeners = new Set<(values: Values) => void>();
  const meter: FxMeter<Values> = {
    watch: (listener) => {
      listeners.add(listener);
      if (listeners.size === 1) onWatch(true);
      return () => {
        // (once: a watcher that leaves twice, or after the effect is destroyed, tells nothing)
        if (!listeners.delete(listener)) return;
        if (listeners.size === 0) onWatch(false);
      };
    },
  };
  return {
    meter,
    emit: (values: Values) => listeners.forEach((listener) => listener(values)),
    // the effect is destroyed: no one is told any more, its values stop coming
    clear: () => {
      const watched = listeners.size > 0;
      listeners.clear();
      if (watched) onWatch(false);
    },
  };
};
