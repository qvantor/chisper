import React from 'react';
import { warp } from '@chisper/math';

// the glyphs of the modes of the Warp: the map of the phase in a square, the phase of the cycle left to right, the
// phase it reads the frame at bottom to top, over the diagonal the map of Off is; each at a knob that shows it
const SIDE = 16;
const LEFT = 6;
const BOTTOM = 18;
const STEPS = 64;
// the phase the glyph ends at: the last of the cycle (at 1 the map is back at the start of the frame)
const END = 1 - 2 ** -32;

const LINE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

const point = (phi: number, read: number): [number, number] => [
  Number((LEFT + phi * SIDE).toFixed(2)),
  Number((BOTTOM - read * SIDE).toFixed(2)),
];

// the points of the map of `mode` at `knob` across the glyph; where it wraps (PWM at the end of its ramp) it goes up
// to the top and straight down
export const warpGlyphPoints = (mode: number, knob: number) => {
  const points: [number, number][] = [];
  let last = -1;
  for (let i = 0; i <= STEPS; i++) {
    const phi = i / STEPS;
    const read = warp.warpPhase(mode, knob, i === STEPS ? END : phi);
    if (read < last - 0.5) points.push(point(phi, 1));
    points.push(point(phi, read));
    last = read;
  }
  return points;
};

const curve = (mode: number, knob: number) =>
  warpGlyphPoints(mode, knob)
    .map(([x, y]) => `${x},${y}`)
    .join(' ');

// the glyph of `mode` (its index in WARP_MODES) at its knobs: the first bold, a second faint
export const WarpModeIcon = ({ mode, knobs: [bold, faint] }: { mode: number; knobs: [number, number?] }) => (
  <svg viewBox='0 0 28 20' aria-hidden focusable='false' data-testid={`warp-mode-${mode}`}>
    <line x1={LEFT} y1={BOTTOM} x2={LEFT + SIDE} y2={BOTTOM - SIDE} stroke='currentColor' opacity={0.25} />
    {faint !== undefined && (
      <polyline points={curve(mode, faint)} {...LINE} strokeWidth={1.2} opacity={0.45} />
    )}
    <polyline points={curve(mode, bold)} {...LINE} strokeWidth={1.6} />
  </svg>
);
