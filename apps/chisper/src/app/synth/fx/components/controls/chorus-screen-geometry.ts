import { number } from '@chisper/math';
import {
  ChorusDspParams,
  depthMs,
  MAX_TAP_MS,
  tapChannel,
  tapDelayParam,
  TAPS,
} from '../../effects/chorus-params';

// The screen of the chorus in css px, [width, height]: the delay of a tap across it (ms, 0 at the left, the
// longest a tap gets at the right), a lane for each tap down it (L first, L second, R first, R second: the taps
// of chorusTaps), the ms along its bottom. In a lane the bar of where its LFO takes the tap: from its delay, as
// long as the depth
export type Size = readonly [number, number];

// px left of the plot (the names of the channels) and right of it, under it (the ms), over the first lane and
// under the last one; the share of a step of the lanes between the channels, over it
const LEFT = 16;
const RIGHT = 8;
export const AXIS = 14;
const PAD = 8;
const CHANNEL_GAP = 0.3;
// the ms told along the bottom
export const TICKS = [0, 20, 40, 60, 80];
// the repeats of a tap shown at most, none fainter than this share, none of a tap this near to no delay (ms: they
// would all be on it)
const ECHOES = 4;
const ECHO_FLOOR = 0.04;
const ECHO_NEAR = 0.5;

const span = ([width]: Size) => Math.max(width - LEFT - RIGHT, 0);
export const msX = (ms: number, size: Size) =>
  LEFT + (number.thresholds(ms, 0, MAX_TAP_MS) / MAX_TAP_MS) * span(size);
export const xMs = (x: number, size: Size) =>
  span(size) > 0 ? number.thresholds((x - LEFT) / span(size), 0, 1) * MAX_TAP_MS : 0;

// the bottom of the plot (the ms are under it)
export const plotBottom = ([, height]: Size) => height - AXIS;
export const laneY = (tap: number, size: Size) => {
  const step = (plotBottom(size) - 2 * PAD) / (TAPS - 1 + CHANNEL_GAP);
  return PAD + step * (tap + tapChannel(tap) * CHANNEL_GAP);
};
// the middle of a channel (0 L, 1 R): its name is there
export const channelY = (channel: number, size: Size) =>
  (laneY(2 * channel, size) + laneY(2 * channel + 1, size)) / 2;

// the bar of each tap: from its delay to where the top of the LFO has it
export const tapBars = (params: Pick<ChorusDspParams, 'd1' | 'd2' | 'depth'>, size: Size) =>
  Array.from({ length: TAPS }, (_, tap) => {
    const delay = params[tapDelayParam(tap)];
    return { from: msX(delay, size), to: msX(delay + depthMs(params.depth), size), y: laneY(tap, size) };
  });

// a depth of the end of a bar at `x`, its tap delayed by `delay` ms (under no depth: the range of the knob stops
// it)
export const xDepth = (x: number, delay: number, size: Size) => (xMs(x, size) - delay) / depthMs(1);

// What a tap feeds back into itself comes again after its delay, each time × the feedback: how many repeats of a
// tap `ms` long the screen has room for (the first at 2 × ms with the feedback as its share of the tap, the next a
// delay on, × the feedback again)
export const tapEchoes = (ms: number, feedback: number) => {
  if (ms < ECHO_NEAR) return 0;
  let count = 0;
  for (let share = feedback; count < ECHOES && (count + 2) * ms <= MAX_TAP_MS && share >= ECHO_FLOOR;) {
    count++;
    share *= feedback;
  }
  return count;
};

// The glow behind the taps tells the filter: a circle of light from the middle of the screen, from violet at the
// bottom of the cutoff to cyan at its top (a decade a third of the way). A low pass: brighter and wider the more
// it lets through. A high pass (`high`): the middle is dark, the more the higher it cuts, the light at the edges.
// The circles of a radial gradient and its colors at them
const GLOW_DECADES = 3;
const GLOW_FLOOR = 20;
export const cutoffGlow = (cut: number, high: boolean, [width, height]: Size) => {
  const open = number.thresholds(Math.log10(Math.max(cut, GLOW_FLOOR) / GLOW_FLOOR) / GLOW_DECADES, 0, 1);
  const hue = Math.round(270 - 90 * open);
  // the share of the sound that passes
  const passed = high ? 1 - open : open;
  const color = (alpha: number) => `hsla(${hue}, 85%, 60%, ${Math.round(alpha * 1000) / 1000})`;
  const light = 0.2 + 0.3 * passed;
  return {
    x: width / 2,
    y: height / 2,
    inner: high ? width * (0.04 + 0.36 * open) : 0,
    outer: high ? width * 0.62 : width * (0.22 + 0.45 * open),
    from: color(high ? 0 : light),
    to: color(high ? light : 0),
  };
};
