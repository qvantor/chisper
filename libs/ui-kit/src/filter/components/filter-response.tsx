import React from 'react';
import { styled } from 'styled-components';
import { Vector2D } from '@chisper/math';
import { theme } from '../../common/constants';
import { Deactivated } from '../../common/styles';
import { liveKnob } from '../../common/utils';
import { HandleModulation } from '../../handle';
import { LineChart, useLineChartContext } from '../../line-chart';
import { DB_RANGE, frequencyX } from '../services';
import { FilterNumerics, FilterProps, FilterRange } from '../types';
import { FilterLineChart } from './filter-linechart';

const Root = styled.div`
  position: relative;
  display: flex;
  border-radius: 3px;
`;

const Chart = styled(LineChart)`
  flex: 1 1;
  border-radius: 3px;
`;

// the line runs edge to edge, 1px vertically keeps the stroke from being cut at the top/bottom
const CHART_PADDING: Vector2D = [0, 1];
const DOMAIN_Y: [number, number] = [DB_RANGE, -DB_RANGE];

// the lines of the grid: the decades, the dB over and under the middle; 0 dB (the level of the input) brighter
const GRID_FREQS = [100, 1000, 10000];
const GRID_DBS = [DB_RANGE / 2, -DB_RANGE / 2];
const GRID_STYLE = { stroke: theme.colors.primaryDarkMediumContrast };
const ZERO_STYLE = { stroke: theme.colors.primaryDarkHighContrast };

// the grid under the response (svg: it moves only with the size of the chart, not with the knobs); x of the chart is
// a share of its width
const FilterGrid = ({ sampleRate }: { sampleRate: number }) => {
  const { scaleX, scaleY } = useLineChartContext();
  const [w, h] = [scaleX(1), scaleY.range()[1]];
  return (
    <g data-testid='filter-grid'>
      {GRID_FREQS.map((freq) => {
        const x = scaleX(frequencyX(freq, sampleRate));
        return <line key={freq} style={GRID_STYLE} x1={x} x2={x} y1={0} y2={h} />;
      })}
      {GRID_DBS.map((db) => (
        <line key={db} style={GRID_STYLE} x1={0} x2={w} y1={scaleY(db)} y2={scaleY(db)} />
      ))}
      <line data-testid='filter-zero-db' style={ZERO_STYLE} x1={0} x2={w} y1={scaleY(0)} y2={scaleY(0)} />
    </g>
  );
};

type Props = Partial<Pick<FilterProps, 'gain' | 'drive' | 'variation'>> &
  Omit<FilterProps, 'gain' | 'drive' | 'variation'> & {
    type: string;
    sampleRate: number;
    active?: boolean;
    className?: string;
    // the knobs of the params (their travel) and their routes: the chart follows where the routes move them
    ranges?: Partial<Record<FilterNumerics, FilterRange>>;
    modulations?: Partial<Record<FilterNumerics, HandleModulation[]>>;
  };

// the frequency response of the filter at these params (of a BiquadFilterNode or of a model type: Drive as a loud
// sound comes out of it) over its grid, the middle 0 dB
export const FilterResponse = ({
  type,
  cutoff,
  resonance,
  gain = 0,
  drive = 0,
  variation = 0,
  sampleRate,
  active = true,
  className,
  ranges,
  modulations,
}: Props) => {
  const knobs = [
    liveKnob(cutoff, ranges?.cutoff, modulations?.cutoff),
    liveKnob(resonance, ranges?.resonance, modulations?.resonance),
    liveKnob(gain, ranges?.gain, modulations?.gain),
    liveKnob(variation, ranges?.variation, modulations?.variation),
    liveKnob(drive, ranges?.drive, modulations?.drive),
  ];
  return (
    <Root className={className} data-testid='filter-response'>
      {!active && <Deactivated data-testid='filter-response-deactivated' />}
      <Chart
        domainY={DOMAIN_Y}
        padding={CHART_PADDING}
        overlay={<FilterLineChart type={type} sampleRate={sampleRate} knobs={knobs} active={active} />}
      >
        <FilterGrid sampleRate={sampleRate} />
      </Chart>
    </Root>
  );
};
