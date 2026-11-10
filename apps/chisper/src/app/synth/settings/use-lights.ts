import React from 'react';
import { Observable } from 'rxjs';

// a light stays on at least this long: a note shorter than it (a drum pad) shows too
export const MIN_LIT_MS = 90;

// lights the element of each bit of `$mask` (`count` bits; adds `className`) while the bit is set: on at once, off
// once it is clear, no sooner than MIN_LIT_MS after it came on; on the DOM alone, no render of React for a note.
// `target` stable (useCallback)
export const useLights = (
  $mask: Observable<number>,
  count: number,
  target: (bit: number) => Element | null | undefined,
  className: string
) =>
  React.useEffect(() => {
    const litAt: number[] = [];
    const timers: (number | undefined)[] = [];
    const put = (bit: number, on: boolean) => target(bit)?.classList.toggle(className, on);
    let previous = 0;
    const subscription = $mask.subscribe((mask) => {
      for (let bit = 0; bit < count; bit++) {
        const on = ((mask >> bit) & 1) === 1;
        if (on === (((previous >> bit) & 1) === 1)) continue;
        window.clearTimeout(timers[bit]);
        if (on) {
          litAt[bit] = performance.now();
          put(bit, true);
          continue;
        }
        const wait = litAt[bit] + MIN_LIT_MS - performance.now();
        if (wait <= 0) put(bit, false);
        else timers[bit] = window.setTimeout(() => put(bit, false), wait);
      }
      previous = mask;
    });
    return () => {
      subscription.unsubscribe();
      for (let bit = 0; bit < count; bit++) {
        window.clearTimeout(timers[bit]);
        put(bit, false);
      }
    };
  }, [$mask, count, target, className]);
