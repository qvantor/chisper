import React from 'react';
import { Icon } from './header-icons';

// icons of the keys of Export WAV in currentColor (blue on the key chosen): the length as the bars of a waveform, a
// dashed line at the end of the clip; the level as a wave under the ceiling of the limiter

// the bars of the waveform of the clip, one every 2.5 units, as loud as the sound is there
const STEP = 2.5;
const SHAPE = [0.55, 0.85, 0.7, 1, 0.8, 0.95, 0.65, 0.9, 0.75];
const CLIP_BARS = SHAPE.map((_, i) => 2.5 + i * STEP);
const CLIP_END = 24.5;

// the bars at `xs` about `y`, each its half height (none too small to show)
const bars = (xs: number[], y: number, halves: number[]) =>
  xs
    .map((x, i) => [x, halves[i]])
    .filter(([, h]) => h > 0.4)
    .map(([x, h]) => `M${x} ${(y - h).toFixed(2)}V${(y + h).toFixed(2)}`)
    .join('');

// the bars of the clip `half` high at most, scaled by the envelope there
const clipBars = (y: number, half: number, envelope: (x: number) => number = () => 1) =>
  bars(
    CLIP_BARS,
    y,
    CLIP_BARS.map((x, i) => half * SHAPE[i] * envelope(x))
  );

const Bars = ({ d }: { d: string }) => <path d={d} strokeWidth={1.5} />;

const ClipEnd = ({ top, bottom }: { top: number; bottom: number }) => (
  <path d={`M${CLIP_END} ${top}V${bottom}`} strokeWidth={1} strokeDasharray='1.5 1.8' opacity={0.7} />
);

// the clip alone: its end fades out before the end of the clip
const CLIP = clipBars(9, 7, (x) => (x <= 15 ? 1 : (CLIP_END - x) / (CLIP_END - 15)));

export const ClipIcon = () => (
  <Icon width={36} height={18}>
    <Bars d={CLIP} />
    <ClipEnd top={1} bottom={17} />
  </Icon>
);

// the clip, then its tail dying away after its end
const TAIL_LEVELS = [0.6, 0.38, 0.22, 0.12];
const TAIL =
  clipBars(9, 7) +
  bars(
    TAIL_LEVELS.map((_, i) => CLIP_END + 2.5 + i * STEP),
    9,
    TAIL_LEVELS.map((level) => 7 * level)
  );

export const TailIcon = () => (
  <Icon width={36} height={18}>
    <Bars d={TAIL} />
    <ClipEnd top={1} bottom={17} />
  </Icon>
);

// the clip, its end going round into its start
const LOOP = clipBars(11.5, 5);

export const LoopIcon = () => (
  <Icon width={36} height={18}>
    <Bars d={LOOP} />
    <ClipEnd top={6} bottom={17} />
    <path d='M27 11.5H31Q33 11.5 33 9.5V4Q33 2 31 2H5Q3 2 3 4V5.2' strokeWidth={1.2} />
    <path d='M1.4 3.8L3 5.6L4.6 3.8' strokeWidth={1.2} />
  </Icon>
);

// as played: the peaks flattened against the ceiling of the limiter
export const LimitedIcon = () => (
  <Icon width={32} height={16}>
    <path d='M1 2H31M1 14H31' strokeWidth={1} opacity={0.6} />
    <path
      d='M2 8C3 5 3.8 3.5 5 3.5H8C9.2 3.5 10 5 11 8C12 11 12.8 12.5 14 12.5H17C18.2 12.5 19 11 20 8C21 5 21.8 3.5 23 3.5H26C27.2 3.5 28 5 29 8'
      strokeWidth={1.4}
    />
  </Icon>
);

// headroom: the whole wave turned down, room under the ceiling
export const HeadroomIcon = () => (
  <Icon width={32} height={16}>
    <path d='M1 2H31M1 14H31' strokeWidth={1} strokeDasharray='1.5 1.8' opacity={0.6} />
    <path d='M2 8C4.3 4 6.7 4 9 8S13.7 12 16 8S20.7 4 23 8S27.7 12 30 8' strokeWidth={1.4} />
  </Icon>
);
