import React from 'react';
import { eqDesign, eqGainDb } from '@chisper/math/eq';
import { EQ_TYPES } from '../../effects/eq-params';
import { GUIDES, ModeIcon } from './mode-icon';

// The response of each type of a band across the frame (20 Hz at the left, 20 kHz at the right), the guides at
// ±12 dB: the curve the core plays at a frequency of its side (band 1 the lows, band 2 the highs), +12 dB, its
// resonance flat. A cut runs out at the bottom of the frame
const [TOP, BOTTOM] = GUIDES;
const LEFT = 4;
const RIGHT = 52;
const RATE = 48000;
const DB = 12;
// of each band by type: the frequency, the resonance (%)
const SHOWN = [
  [
    [250, 60],
    [700, 50],
    [300, 42],
  ],
  [
    [2500, 60],
    [2500, 50],
    [2000, 42],
  ],
];

export const typeCurve = (band: number, type: number): [number, number][] => {
  const [freq, reso] = SHOWN[band][type];
  const design = eqDesign(band, type, freq, reso, DB, RATE);
  return Array.from({ length: RIGHT - LEFT + 1 }, (_, i) => {
    const hz = 20 * 1000 ** (i / (RIGHT - LEFT));
    const db = eqGainDb([design], hz, RATE);
    const y = Math.min(23, (TOP + BOTTOM) / 2 - (db * (BOTTOM - TOP)) / (2 * DB));
    return [LEFT + i, Number(y.toFixed(2))];
  });
};

const TypeIcon = ({ band, type }: { band: number; type: number }) => (
  <ModeIcon testId={`eq-type-${band + 1}-${EQ_TYPES[type].id}`}>
    <polyline
      points={typeCurve(band, type)
        .map(([x, y]) => `${x},${y}`)
        .join(' ')}
      fill='none'
      stroke='currentColor'
      strokeWidth='1.5'
      strokeLinecap='round'
      strokeLinejoin='round'
    />
  </ModeIcon>
);

// the icons of the switch of the type of each band, by option id (EQ_TYPES)
export const EQ_TYPE_ICONS: Record<string, React.ReactNode>[] = [0, 1].map((band) =>
  Object.fromEntries(EQ_TYPES.map(({ id }, type) => [id, <TypeIcon key={id} band={band} type={type} />]))
);
