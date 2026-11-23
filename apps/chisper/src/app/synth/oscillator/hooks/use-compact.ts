import React from 'react';

// px a strip of values of the oscillator takes at full size: those under the wave (up to 373 px, Wave 256/256), Oct,
// Semi and Fine over it; a narrower one (a phone, two oscillators side by side) has them smaller, and the plate of
// the Warp mode its glyph alone
const COMPACT_WIDTH = 380;

// a ref of the root of the oscillator and whether it is narrower than at full size: kept alone, so a new size
// renders the oscillator only when that flips
export const useCompact = <T extends HTMLElement>() => {
  const ref = React.useRef<T>(null);
  const [compact, setCompact] = React.useState(false);
  React.useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width } = entry.contentRect;
      setCompact(width > 0 && width < COMPACT_WIDTH);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, compact] as const;
};
