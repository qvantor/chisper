// what the values of a CC bound by MIDI Learn are (analytics: how many controllers send what MIDI Learn takes, a
// position of 0..127): the value it was bound with and those after it, MAX_VALUES at most, or those before a pause
// of CC_IDLE or the next bind. A guess of a few values, never what moves a control:
// - absolute: positions, what MIDI Learn takes
// - relative: steps of an endless encoder in a relative mode, around 64 (binary offset) or the ends (two's
//   complement, signed bit): the same value again and again, never 0 nor 64 (one turned fast steps by more: a
//   window of no repeats is taken for positions)
// - button: 0 and one value, each press released (a button, a pad of a fixed value; its toggle mode too)
// - pad: presses of different values, each released (a pad that sends its velocity)
// - msb, lsb: a half of a 14-bit pair, its other half came with it (the MSB is a CC of 7 bits; the LSB runs over
//   its travel 128 times a turn)
// - few: under MIN_VALUES (a CC that moved once)
// - unclear: none of them (one value again and again: 127 of an encoder at its top, a pad never released)
// A narrow range of positions is none of them: a few values of a controller that stops short are those of a hand
// that turned it part of its way. And `nrpn`: a control waited through an NRPN (none of its CCs is one MIDI Learn
// binds: isAssignable), its number (CC 99, 98) and a data entry (6, 38) after it
export type CcKind = 'absolute' | 'relative' | 'button' | 'pad' | 'msb' | 'lsb' | 'few' | 'unclear' | 'nrpn';

// the values of a CC a kind is told of at most, at least (but of a button or a pad), ms of a pause that ends them
export const MAX_VALUES = 24;
export const MIN_VALUES = 6;
export const CC_IDLE = 1500;
// the most an encoder in a relative mode steps by (its acceleration)
const RELATIVE_STEP = 16;

// the CCs of an NRPN: its number, then its data entry
export const isNrpnNumber = (cc: number) => cc === 98 || cc === 99;
export const isDataEntry = (cc: number) => cc === 6 || cc === 38;

// the other half of a 14-bit pair of `cc` (an MSB 0–31, its LSB 32 more), none over them
export const pairOf = (cc: number) => (cc < 32 ? cc + 32 : cc < 64 ? cc - 32 : null);

// the values of the CC bound, the CCs of the other half of its pair that came meanwhile
export interface CcWatch {
  cc: number;
  values: number[];
  pair: number;
}

export const watchCC = (cc: number, value: number): CcWatch => ({ cc, values: [value], pair: 0 });

// a CC of the input while `watch` is on: false once it has its MAX_VALUES
export const watchTakes = (watch: CcWatch, cc: number, value: number) => {
  if (cc === watch.cc) watch.values.push(value);
  else if (cc === pairOf(watch.cc)) watch.pair += 1;
  return watch.values.length < MAX_VALUES;
};

// a value of a relative mode: a step up or down around 64 or the ends
const isStep = (value: number) =>
  Math.abs(value - 64) <= RELATIVE_STEP || value <= RELATIVE_STEP || value >= 128 - RELATIVE_STEP;

export const ccKind = ({ cc, values, pair }: CcWatch): CcKind => {
  if (pair >= 2) return cc < 32 ? 'msb' : 'lsb';
  const distinct = new Set(values);
  const pressed = new Set(values.filter((value) => value > 0));
  // every press followed by a release (0), but the last
  const released = values.every((value, i) => value === 0 || i === values.length - 1 || values[i + 1] === 0);
  if (distinct.has(0) && pressed.size > 0 && released) {
    // (0 and 1: a knob at its bottom)
    if (pressed.size === 1 && !pressed.has(1)) return 'button';
    if (pressed.size > 1) return 'pad';
  }
  if (values.length < MIN_VALUES) return 'few';
  const repeats = values.filter((value, i) => i > 0 && value === values[i - 1]).length;
  if (
    !distinct.has(0) &&
    !distinct.has(64) &&
    values.every(isStep) &&
    repeats * 2 >= values.length - 1 &&
    !(distinct.size === 1 && distinct.has(127))
  )
    return 'relative';
  return distinct.size >= 3 ? 'absolute' : 'unclear';
};
