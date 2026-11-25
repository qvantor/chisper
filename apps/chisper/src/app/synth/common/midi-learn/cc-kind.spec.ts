import { CcWatch, ccKind, MAX_VALUES, pairOf, watchCC, watchTakes } from './cc-kind';

// the kind of the values of `cc` (the first the one it was bound with), the other CCs of the input in `others`
const kindOf = (cc: number, values: number[], others: number[] = []) => {
  const watch: CcWatch = watchCC(cc, values[0]);
  values.slice(1).forEach((value) => watchTakes(watch, cc, value));
  others.forEach((other) => watchTakes(watch, other, 64));
  return ccKind(watch);
};
const range = (from: number, to: number) =>
  Array.from({ length: Math.abs(to - from) + 1 }, (_, i) => from + Math.sign(to - from) * i);

describe('ccKind', () => {
  it('takes a knob turned for positions, across 64 or at the ends too', () => {
    expect(kindOf(74, range(40, 52))).toBe('absolute');
    expect(kindOf(74, range(58, 70))).toBe('absolute');
    expect(kindOf(74, range(6, 0))).toBe('absolute');
    // (an encoder of positions pushed on at its top)
    expect(kindOf(74, [...range(115, 127), 127, 127, 127])).toBe('absolute');
    // up and down again
    expect(kindOf(74, [...range(30, 36), ...range(35, 28)])).toBe('absolute');
  });

  it('takes the steps of an encoder in a relative mode, either way', () => {
    // binary offset
    expect(kindOf(20, [65, 65, 65, 66, 65, 63, 63, 63])).toBe('relative');
    // two's complement
    expect(kindOf(20, [1, 1, 1, 2, 1, 127, 127, 127])).toBe('relative');
    // signed bit
    expect(kindOf(20, [1, 1, 65, 65, 65, 1])).toBe('relative');
    // one way only
    expect(kindOf(20, [65, 65, 65, 65, 65, 65])).toBe('relative');
    expect(kindOf(20, [1, 1, 1, 1, 1, 1])).toBe('relative');
  });

  it('takes an encoder turned fast, with no repeats, for positions (a limit of the guess)', () => {
    expect(kindOf(20, [66, 68, 70, 72, 70, 68])).toBe('absolute');
  });

  it('takes 0 and one value, each press released, for a button, whatever the count', () => {
    expect(kindOf(36, [127, 0])).toBe('button');
    expect(kindOf(36, [100, 0, 100, 0, 100])).toBe('button');
    // a toggle: a press on, the next one off
    expect(kindOf(36, [0, 127, 0, 127])).toBe('button');
  });

  it('takes presses of different values, each released, for a pad of the velocity', () => {
    expect(kindOf(36, [90, 0, 40, 0, 127, 0])).toBe('pad');
    expect(kindOf(36, [90, 0, 40])).toBe('pad');
  });

  it('takes the halves of a 14-bit pair by the other half coming with them', () => {
    expect(pairOf(1)).toBe(33);
    expect(pairOf(33)).toBe(1);
    expect(pairOf(74)).toBeNull();
    expect(kindOf(1, range(10, 20), [33, 33, 33])).toBe('msb');
    expect(kindOf(33, [120, 125, 2, 7, 12, 17], [1, 1])).toBe('lsb');
    // once: another control moved meanwhile
    expect(kindOf(1, range(10, 20), [33])).toBe('absolute');
  });

  it('tells a CC of under MIN_VALUES as few, one value again and again (127, 0) as unclear', () => {
    expect(kindOf(74, [64])).toBe('few');
    expect(kindOf(74, [64, 65, 66])).toBe('few');
    expect(kindOf(74, [127, 127, 127, 127, 127, 127])).toBe('unclear');
    expect(kindOf(74, [0, 0, 0, 0, 0, 0])).toBe('unclear');
    // (0 and 1: a knob at its bottom, no button)
    expect(kindOf(74, [1, 0, 1, 0, 1, 0])).toBe('unclear');
  });

  it('keeps MAX_VALUES at most', () => {
    const watch = watchCC(74, 0);
    const taken = Array.from({ length: MAX_VALUES - 1 }, (_, i) => watchTakes(watch, 74, i + 1));
    expect(taken.slice(0, -1).every(Boolean)).toBe(true);
    expect(taken.at(-1)).toBe(false);
    expect(watch.values).toHaveLength(MAX_VALUES);
  });
});
