import { act } from '@testing-library/react';
import type { FxMeter } from '../app/synth/fx/effects/types';

// a meter of an effect the spec feeds: `send` gives its watchers values, `stop` counts the watchers that left
export const createMeterStub = <Values>() => {
  const listeners = new Set<(values: Values) => void>();
  const stop = jest.fn();
  const meter: FxMeter<Values> = {
    watch: jest.fn((listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        stop();
      };
    }),
  };
  const send = (values: Values) => act(() => listeners.forEach((listener) => listener(values)));
  return { meter, send, stop, listeners };
};
