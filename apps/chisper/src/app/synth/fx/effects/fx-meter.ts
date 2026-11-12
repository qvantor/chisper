import type { FxMeter } from './types';

// The meter of a worklet effect on the main thread: its worklet posts `{ meter: values }` only while someone
// watches (`post` tells it when the first watcher comes and when the last one leaves; a node made while it is
// watched starts with its meter on: `watched`)
export const createFxMeter = <Values>(post: (message: { meter: boolean }) => void) => {
  const listeners = new Set<(values: Values) => void>();
  const meter: FxMeter<Values> = {
    watch: (listener) => {
      listeners.add(listener);
      if (listeners.size === 1) post({ meter: true });
      return () => {
        // (once: a watcher that leaves twice, or after the effect is destroyed, tells the worklet nothing)
        if (!listeners.delete(listener)) return;
        if (listeners.size === 0) post({ meter: false });
      };
    },
  };
  return {
    meter,
    watched: () => listeners.size > 0,
    // a message of the worklet: its meter to the watchers, anything else is not for them
    take: (data: unknown) => {
      const { meter: values } = (data ?? {}) as { meter?: Values };
      if (values) listeners.forEach((listener) => listener(values));
    },
    // the effect is destroyed: no one is told any more
    clear: () => listeners.clear(),
  };
};
