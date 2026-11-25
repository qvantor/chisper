import { number } from '@chisper/math';
import { valueScale } from '@chisper/ui-kit';
import type { ModScale } from '../modulation/modulation-targets';
import { CHANNEL_MODE } from '../modules/midi-controller';

// the value of a Control Change: 0..127
export const CC_MAX = 127;
// the half of the values of a CC: a switch is on from it, off under it
const CC_HALF = 64;
// the CC a knob may be bound to: none of bank select (0, 32), data entry (6, 38), the increments and the numbers of
// the registered and non-registered parameters (96–101); the channel mode messages (120–127) never reach MIDI Learn
const RESERVED = new Set([0, 6, 32, 38, 96, 97, 98, 99, 100, 101]);
export const isAssignable = (cc: number) =>
  Number.isInteger(cc) && cc >= 0 && cc < CHANNEL_MODE && !RESERVED.has(cc);

// a knob as a CC moves it: its range in its scale (as a knob of the screen spreads it over its travel), rounded to
// 1 / precision; a stepped one (divisions) of its steps, as many equal shares of the travel; a cyclic one (a phase:
// max is min again) stops a step before max. The fields of a knob of the kit: a range of one is a KnobDef
export interface KnobDef {
  min: number;
  max: number;
  mode?: ModScale;
  precision?: number;
  steps?: readonly number[];
  cyclic?: boolean;
}

const scaleOf = (mode: ModScale, min: number, max: number) =>
  valueScale(mode).domain([min, max]).range([0, 1]).clamp(true);

// the share of the travel of a CC value: 0 the bottom, 127 the top
export const ccShare = (value: number) => value / CC_MAX;

// the value of a knob at a share of its travel (0..1): where a mouse would put it
export const knobValue = (
  { min, max, mode = 'linear', precision = 1000, steps, cyclic }: KnobDef,
  share: number
) => {
  if (steps) return steps[Math.round(share * (steps.length - 1))];
  const top = cyclic ? max - 1 / precision : max;
  if (!(max > min)) return min;
  const raw = scaleOf(mode, min, top).invert(number.thresholds(share, 0, 1));
  return number.thresholds(number.round(raw, precision), min, top);
};

// the share of the travel of a knob at its value (0..1)
export const knobShare = (
  { min, max, mode = 'linear', precision = 1000, steps, cyclic }: KnobDef,
  value: number
) => {
  if (steps) {
    const index = steps.indexOf(value);
    return steps.length > 1 && index >= 0 ? index / (steps.length - 1) : 0;
  }
  const top = cyclic ? max - 1 / precision : max;
  return max > min ? scaleOf(mode, min, top)(value) : 0;
};

// a switch: on from the half of the values
export const switchOn = (value: number) => value >= CC_HALF;

// an option of `count` as equal zones of the values
export const choiceIndex = (value: number, count: number) =>
  Math.min(count - 1, Math.floor((value * count) / (CC_MAX + 1)));

// the zone of a CC value for a switch or a choice: a switch or a choice changes only when a CC enters another one
export const zoneOf = (value: number, count: number | 'switch') =>
  count === 'switch' ? Number(switchOn(value)) : choiceIndex(value, count);

// the knob is where the CC value `cc` puts it: the controller has it (its value rounded to its precision is a little
// off the CC, a step of a stepped knob is a zone of CC values)
export const onCC = (def: KnobDef, knob: number, cc: number) => knobValue(def, ccShare(cc)) === knob;

// soft takeover: a knob of `def` at `knob` is caught by a CC going from `prev` (none: the first CC since) to `value`
// once the CC passes it or comes within a step of it, or once either of them puts it where it is (onCC)
export const pickupCatches = (def: KnobDef, knob: number, prev: number | undefined, value: number) => {
  const at = knobShare(def, knob) * CC_MAX;
  return (
    Math.abs(value - at) <= 1 ||
    onCC(def, knob, value) ||
    (prev !== undefined && ((prev - at) * (value - at) <= 0 || onCC(def, knob, prev)))
  );
};
