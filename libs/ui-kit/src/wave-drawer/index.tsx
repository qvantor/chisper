import React from 'react';
import { number, vector2d } from '@chisper/math';
import { LineChart, YAxis, Line } from '../line-chart';
import { theme } from '../common/constants';
import { PointerInteractive } from './components';

const DOMAIN_Y = vector2d.fromValues(1, -1);

interface Props {
  wave: number[];
  // a column of the grid (0..2^rate − 1) set to a level (−1..1)
  onChange?: (value: [number, number]) => void;
  rate?: number;
  precisionY?: number;
}

// a wave drawn on a grid of 2^rate columns and precisionY rows a half: a mouse, a finger or a pen (no scroll or
// zoom of the page under it while it draws)
export const WaveDrawer = ({ rate = 4, precisionY = 10, wave, onChange }: Props) => {
  const domainX = React.useMemo(() => vector2d.fromValues(0, wave.length - 1), [wave.length]);
  const columns = React.useMemo<[number, number]>(() => [0, number.powerOfTwo(rate)], [rate]);

  return (
    <LineChart domainX={domainX} domainY={DOMAIN_Y} style={onChange ? { touchAction: 'none' } : undefined}>
      <YAxis ticks={precisionY * 2} />
      {onChange && <PointerInteractive precisionY={precisionY} customDomainX={columns} onDraw={onChange} />}
      <Line data={wave} style={{ fill: theme.colors.accent, fillOpacity: 0.2 }} />
    </LineChart>
  );
};
