import {
  ccShare,
  choiceIndex,
  isAssignable,
  knobShare,
  knobValue,
  onCC,
  pickupCatches,
  switchOn,
  zoneOf,
} from './cc-value';

describe('isAssignable', () => {
  it('takes the CC of controls, not bank select, data entry, the RPN/NRPN numbers nor the channel mode messages', () => {
    const assignable = Array.from({ length: 128 }, (_, cc) => cc).filter(isAssignable);
    const expected = [
      ...[1, 2, 3, 4, 5],
      ...Array.from({ length: 25 }, (_, k) => 7 + k),
      ...[33, 34, 35, 36, 37],
      ...Array.from({ length: 57 }, (_, k) => 39 + k),
      ...Array.from({ length: 18 }, (_, k) => 102 + k),
    ];
    expect(assignable).toEqual(expected);
    expect(isAssignable(-1)).toBe(false);
    expect(isAssignable(1.5)).toBe(false);
  });
});

describe('knobValue', () => {
  it('puts 0 at min, 127 at max, within the range in between', () => {
    const def = { min: -1, max: 1, precision: 100 };
    expect(knobValue(def, ccShare(0))).toBe(-1);
    expect(knobValue(def, ccShare(127))).toBe(1);
    expect(knobValue(def, ccShare(64))).toBeCloseTo(0.01, 10);
  });

  it('spreads a log knob as its travel: the middle of the CC is the middle in octaves', () => {
    const cutoff = { min: 10, max: 22050, mode: 'log' as const, precision: 1 };
    // 10 · (22050 / 10)^(64 / 127)
    expect(knobValue(cutoff, ccShare(64))).toBe(Math.round(10 * 2205 ** (64 / 127)));
    expect(knobValue(cutoff, ccShare(0))).toBe(10);
    expect(knobValue(cutoff, ccShare(127))).toBe(22050);
  });

  it('spreads a pow knob as its travel (times: short ones get most of it)', () => {
    const time = { min: 0, max: 32, mode: 'pow' as const, precision: 10000 };
    expect(knobValue(time, 0.5)).toBe(2);
    expect(knobValue(time, 0.25)).toBe(0.125);
  });

  it('rounds to its precision: whole frames, octaves, voices', () => {
    const wave = { min: 0, max: 255, precision: 1 };
    expect(Number.isInteger(knobValue(wave, ccShare(33)))).toBe(true);
    expect(knobValue({ min: -3, max: 3, precision: 1 }, ccShare(64))).toBe(0);
    expect(knobValue({ min: 1, max: 8, precision: 1 }, ccShare(127))).toBe(8);
  });

  it('takes a step of a stepped knob as equal shares of the travel', () => {
    const steps = [3, 5, 9, 12];
    expect(knobValue({ min: 0, max: 0, steps }, ccShare(0))).toBe(3);
    expect(knobValue({ min: 0, max: 0, steps }, ccShare(42))).toBe(5);
    expect(knobValue({ min: 0, max: 0, steps }, ccShare(127))).toBe(12);
  });

  it('stops a cyclic knob a step before its end (max is min again)', () => {
    const phase = { min: 0, max: 1, precision: 360, cyclic: true };
    expect(knobValue(phase, 1)).toBe(359 / 360);
    expect(knobValue(phase, 0)).toBe(0);
  });

  it('gives min for an empty range (a table of one frame)', () => {
    expect(knobValue({ min: 0, max: 0, precision: 1 }, 0.7)).toBe(0);
  });
});

describe('knobShare', () => {
  it('is where the value is on the travel', () => {
    const cutoff = { min: 10, max: 22050, mode: 'log' as const, precision: 1 };
    expect(knobShare(cutoff, 10)).toBe(0);
    expect(knobShare(cutoff, 22050)).toBe(1);
    expect(knobShare(cutoff, Math.sqrt(10 * 22050))).toBeCloseTo(0.5, 10);
    expect(knobShare({ min: 0, max: 0, steps: [3, 5, 9] }, 9)).toBe(1);
  });
});

describe('switches and choices', () => {
  it('turns a switch on from 64', () => {
    expect(switchOn(63)).toBe(false);
    expect(switchOn(64)).toBe(true);
    expect(zoneOf(63, 'switch')).toBe(0);
    expect(zoneOf(127, 'switch')).toBe(1);
  });

  it('chooses an option of equal zones', () => {
    expect([0, 31, 32, 63, 64, 95, 96, 127].map((v) => choiceIndex(v, 4))).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
    expect(choiceIndex(127, 3)).toBe(2);
    expect(choiceIndex(127, 30)).toBe(29);
    expect(zoneOf(64, 2)).toBe(1);
  });
});

describe('pickupCatches', () => {
  // a knob of the CC values: the knob at 50 is at 50 of the CC
  const linear = { min: 0, max: 127, precision: 1 };

  it('catches a knob the CC passes or comes within a step of', () => {
    // the knob at 50: from 40 to 60 it passes it
    expect(pickupCatches(linear, 50, 40, 60)).toBe(true);
    expect(pickupCatches(linear, 50, 60, 40)).toBe(true);
    expect(pickupCatches(linear, 50, 40, 45)).toBe(false);
    expect(pickupCatches(linear, 50, 45, 49)).toBe(true);
    expect(pickupCatches(linear, 50, 50, 70)).toBe(true);
  });

  it('without a CC before only a CC within a step catches it', () => {
    expect(pickupCatches(linear, 50, undefined, 80)).toBe(false);
    expect(pickupCatches(linear, 50, undefined, 51)).toBe(true);
    expect(pickupCatches(linear, 50, undefined, 50.5)).toBe(true);
  });

  it('catches a knob where the CC before put it, however far the CC goes (its value rounded is off the CC)', () => {
    const cutoff = { min: 10, max: 22050, mode: 'log' as const, precision: 1 };
    const knob = knobValue(cutoff, ccShare(64));
    expect(onCC(cutoff, knob, 64)).toBe(true);
    expect(pickupCatches(cutoff, knob, 64, 68)).toBe(true);
    expect(pickupCatches(cutoff, knob, 64, 60)).toBe(true);
    expect(pickupCatches(cutoff, knobValue(cutoff, ccShare(30)), 64, 68)).toBe(false);
  });

  it('catches a stepped knob while the CC is on its step', () => {
    // Oct at 0: the CC 53–74 put it there
    const octave = { min: -3, max: 3, precision: 1 };
    expect(pickupCatches(octave, 0, undefined, 56)).toBe(true);
    expect(pickupCatches(octave, 0, 56, 40)).toBe(true);
    expect(pickupCatches(octave, 0, undefined, 40)).toBe(false);
    expect(pickupCatches(octave, 0, 30, 40)).toBe(false);
  });
});
