import React from 'react';
import hexToRgba from 'hex-to-rgba';
import { number } from '@chisper/math';
import {
  Deactivated,
  HandleModulation,
  liveKnob,
  theme,
  Tooltip,
  useCanvas,
  useElementSize,
  useLiveDraw,
  ValueTooltip,
} from '@chisper/ui-kit';
import { fxfilter } from '../../effects/fxfilter';
import { FxFilterParam } from '../../effects/fxfilter-presets';
import { fxFilterPanOctaves } from '../../effects/fxfilter-params';
import { curvePoints, freqX, freqXOpen, POINTS, Size, xFreqOpen } from './eq-screen-geometry';
import { DB_LINES, dbY, filterCurve, FilterKnobs, resY, yRes } from './fxfilter-screen-geometry';
import {
  FRAME_SIZE,
  FreqGrid,
  PointGrip,
  SCREEN_COLOR,
  ScreenCanvas,
  ScreenFrame,
  ScreenLabels,
  ScreenPlot,
} from './screen-grip';

// css px of the screen
export const FX_FILTER_SCREEN_SIZE: Size = FRAME_SIZE;
// the channels apart (Pan): the left one, the right one
const CHANNEL_COLORS = [theme.colors.secondAccent, theme.colors.thirdAccent];
const FILL = hexToRgba(SCREEN_COLOR, 0.15);
// px: the point of the cutoff where its routes take it, the line of the response
const DOT_RADIUS = 2.5;
const LINE = 1.5;

const { params: defs } = fxfilter;

// the knobs the screen draws, in this order: those the routes move (the type switches, no route moves it)
const LIVE: FxFilterParam[] = ['cutoff', 'res', 'drive', 'var', 'pan', 'level'];

// the response of the filter (filled to the bottom), of each channel apart in its color while Pan moves their
// cutoffs, and the point of the cutoff, where the routes take the knobs
const useCurves = (
  params: Record<string, number>,
  sampleRate: number,
  size: Size,
  modulations: Partial<Record<FxFilterParam, HandleModulation[]>>,
  active: boolean
) => {
  const [width, height] = size;
  const { canvas, begin } = useCanvas(width, height);
  const curves = React.useMemo(() => [new Float64Array(POINTS), new Float64Array(POINTS)], []);
  // the x of each point of a curve
  const xs = React.useMemo(
    () => Float64Array.from(curvePoints(sampleRate).hz, (hz) => freqX(hz, size)),
    [sampleRate, size]
  );
  const { type } = params;
  const draw = React.useCallback(
    (values: number[]) => {
      const context = begin();
      if (!context || !width) return;
      const [cutoff, res, drive, fat, pan, level] = values;
      const knobs: FilterKnobs = { type, res, drive, fat, level };
      const octaves = fxFilterPanOctaves(pan);
      const channels = octaves === 0 ? 1 : 2;
      // (the cutoff of a channel held to the range of the knob, as the core holds it: `hz` of fxfilter.rs)
      const { min, max } = defs.cutoff;
      for (let channel = 0; channel < channels; channel++) {
        const hz = number.thresholds(cutoff * 2 ** (channel ? -octaves : octaves), min, max);
        filterCurve(knobs, hz, sampleRate, curves[channel]);
      }
      const path = (curve: Float64Array) => {
        context.beginPath();
        for (let i = 0; i < POINTS; i++) context.lineTo(xs[i], dbY(curve[i], size));
      };
      // (the first one filled to the bottom)
      path(curves[0]);
      context.lineTo(xs[POINTS - 1], height);
      context.lineTo(xs[0], height);
      context.closePath();
      context.fillStyle = FILL;
      context.fill();
      context.lineWidth = LINE;
      for (let channel = 0; channel < channels; channel++) {
        context.strokeStyle = channels === 1 ? SCREEN_COLOR : CHANNEL_COLORS[channel];
        path(curves[channel]);
        context.stroke();
      }
      // the point of the cutoff and the resonance, where the routes take them
      context.fillStyle = SCREEN_COLOR;
      context.beginPath();
      context.arc(freqX(cutoff, size), resY(res, size), DOT_RADIUS, 0, 2 * Math.PI);
      context.fill();
    },
    [begin, width, height, size, xs, curves, type, sampleRate]
  );
  useLiveDraw(
    LIVE.map((key) => liveKnob(params[key], defs[key], modulations[key])),
    draw,
    active
  );
  return canvas;
};

// what the grip and the tooltip say of the knobs (the resonance of a type that reads one)
const knobsText = (cutoff: number, res: number, resonance: boolean, separator: string) =>
  `${defs.cutoff.formatValue?.(cutoff)}${resonance ? `${separator}Res ${defs.res.formatValue?.(res)}` : ''}`;

interface GripProps {
  cutoff: number;
  res: number;
  // whether the type reads the resonance (a one-pole doesn't: the grip moves across alone, as its knob is off)
  resonance: boolean;
  size: Size;
  setParam: (key: string, value: number) => void;
  // a pointer holds it, or lets it go
  onHold: (held: boolean) => void;
  disabled: boolean;
}

// the grip of the filter at its knobs: dragged, the cutoff across and the resonance up and down; the wheel over it
// the resonance; the arrows move it, a double click sets the resonance to its default. The knob of the cutoff goes
// past the edges of the screen (8.176 Hz..22.05 kHz), where the grip stays: dragged, it goes on from where the knob
// is, not from the edge
const FilterGrip = React.memo(({ cutoff, res, resonance, size, setParam, onHold, disabled }: GripProps) => {
  const x = freqX(cutoff, size);
  const beyond = freqXOpen(cutoff, size) - x;
  const resParam = { key: 'res', def: defs.res, value: res };
  return (
    <PointGrip
      x={x}
      y={resY(res, size)}
      across={{ key: 'cutoff', def: defs.cutoff, value: cutoff, at: (px) => xFreqOpen(px + beyond, size) }}
      {...(resonance && { upDown: { ...resParam, at: (px: number) => yRes(px, size) }, wheel: resParam })}
      label='Cutoff and resonance'
      valueText={knobsText(cutoff, res, resonance, ', ')}
      setParam={setParam}
      onHold={onHold}
      disabled={disabled}
    />
  );
});

interface Props {
  // every param of the filter
  params: Record<string, number>;
  setParam: (key: string, value: number) => void;
  sampleRate: number;
  // the routes of its knobs
  modulations: Partial<Record<FxFilterParam, HandleModulation[]>>;
  // whether its type reads the resonance (off: the grip moves the cutoff alone)
  resonance: boolean;
  active: boolean;
}

// The response of the FX Filter (its layout: fxfilter-screen-geometry.ts) as the core plays it, of each channel apart
// while Pan moves them, and the point of its cutoff and resonance where the routes take them: on a canvas, drawn again
// in every frame the routes move a knob in (useLiveDraw), nothing in the DOM moves. Over it a grip at its knobs:
// dragged, the wheel, the keys
export const FxFilterScreen = ({ params, setParam, sampleRate, modulations, resonance, active }: Props) => {
  // (the size is the same array while it doesn't change)
  const [plot, size] = useElementSize<HTMLDivElement>();
  const [held, setHeld] = React.useState(false);
  const canvas = useCurves(params, sampleRate, size, modulations, active);
  const { cutoff, res } = params;
  const tooltip = held && (
    <ValueTooltip name='Filter'>{knobsText(cutoff, res, resonance, ' · ')}</ValueTooltip>
  );
  return (
    <Tooltip content={tooltip}>
      <ScreenFrame data-testid='fxfilter-screen'>
        <ScreenPlot ref={plot}>
          {size[0] > 0 && (
            <ScreenLabels aria-hidden>
              <FreqGrid size={size} dbLines={DB_LINES} dbY={dbY} />
            </ScreenLabels>
          )}
          <ScreenCanvas {...canvas} data-testid='fxfilter-curve' aria-hidden />
          {size[0] > 0 && (
            <FilterGrip
              cutoff={cutoff}
              res={res}
              resonance={resonance}
              size={size}
              setParam={setParam}
              onHold={setHeld}
              disabled={!active}
            />
          )}
        </ScreenPlot>
        {!active && <Deactivated data-testid='fxfilter-screen-deactivated' />}
      </ScreenFrame>
    </Tooltip>
  );
};
