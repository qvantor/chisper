import React from 'react';
import { affine, useLineChartContext, useLiveLine } from '../../line-chart';
import { theme } from '../../common/constants';
import { LiveKnob, useLiveDraw } from '../../common/utils';
import { responseBuffers, responseInto } from '../services';

interface Props {
  type: string;
  sampleRate: number;
  // cutoff, resonance, gain, variation and drive
  knobs: LiveKnob[];
  active: boolean;
}

// the line and the area between it and 0 dB (a boost over the middle of the chart, a cut under it)
const LINE = { stroke: theme.colors.accent, width: 1, fill: 'area', fillOpacity: 0.2 } as const;

// the response line on a canvas over the chart (its overlay), drawn at the knobs (also where their routes move
// them, every frame: useLiveDraw), filled to 0 dB; the line spans the whole width, also when the grid ends below
// MAX_FREQ (nyquist at low sample rates)
export const FilterLineChart = ({ type, sampleRate, knobs, active }: Props) => {
  const { width, padding, scaleY } = useLineChartContext();
  const [canvas, drawLine] = useLiveLine(LINE, 'filter-line');
  const buffers = React.useMemo(responseBuffers, []);
  const scales = React.useMemo(
    () => ({ x: { k: width - padding[0] * 2, b: 0 }, y: affine(scaleY), zeroDb: scaleY(0) }),
    [width, padding, scaleY]
  );
  const draw = React.useCallback(
    ([cutoff, resonance, gain, variation, drive]: number[]) => {
      const count = responseInto(type, { cutoff, resonance, gain, variation, drive }, sampleRate, buffers);
      drawLine(count, buffers.xs, buffers.dbs, scales.x, scales.y, scales.zeroDb);
    },
    [type, sampleRate, buffers, scales, drawLine]
  );
  useLiveDraw(knobs, draw, active);
  return canvas;
};
