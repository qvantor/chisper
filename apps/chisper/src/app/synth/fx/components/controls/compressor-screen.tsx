import React from 'react';
import { styled } from 'styled-components';
import cls from 'classnames';
import hexToRgba from 'hex-to-rgba';
import { number, Vector2D } from '@chisper/math';
import {
  Deactivated,
  singlePointerTracker,
  theme,
  Tooltip,
  useCanvas,
  useElementSize,
  ValueTooltip,
  valueScale,
} from '@chisper/ui-kit';
import { compressor } from '../../effects/compressor';
import type { FxMeter, FxMeterValues } from '../../effects/types';
import {
  bandBars,
  bandZones,
  gainX,
  heldCrossover,
  LEVEL_FLOOR,
  METER_RANGE,
  levelY,
  Rect,
  Size,
  singleMarks,
  transferCurve,
  unityLine,
  xGain,
  yFreq,
} from './compressor-screen-geometry';

// css px of the screen between the windows of the bands (one band: as wide as the display it is in)
export const SCREEN_SIZE: Size = [150, 80];
// the lines and the points, as on the other charts of the synth
const COLOR = theme.colors.accent;
// the bars of what the compressor does: down a reduction, up a boost; the alpha where a bar starts and at its
// tip, the px of the bright edge there
const bar = (color: string) => ({ color, start: hexToRgba(color, 0.08), end: hexToRgba(color, 0.6) });
const REDUCTION = bar(theme.colors.secondAccent);
const BOOST = bar(theme.colors.accent);
const BAR_EDGE = 1.5;
const DOT_RADIUS = 2.5;
// the share of its travel a key moves a point by
const KEY_STEP = 0.02;
const KEY_DIRECTIONS: Record<string, number> = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 };

const { params: defs } = compressor;
// the params of the bands: the crossovers, the gains (the low band first, as the rows of the screen from its
// bottom)
export type BandParam = 'xlow' | 'xhigh' | 'low' | 'mid' | 'high';
const BAND_GAINS = ['low', 'mid', 'high'] as const satisfies BandParam[];

// a param of the bands as it is shown and as it is set, here and in the windows at the sides: the crossovers never
// cross (the core takes a high one under the low one as the low one: that is the value shown)
export const bandValue = (param: BandParam, params: Record<string, number>) =>
  param === 'xhigh' ? Math.max(params['xhigh'], params['xlow']) : params[param];
export const bandLimit = (xlow: number, xhigh: number) => (param: BandParam, value: number) =>
  param === 'xlow' || param === 'xhigh' ? heldCrossover(param, value, xlow, xhigh) : value;

const Root = styled.div`
  position: relative;
  flex: 1 1 0;
  min-width: 0;
  height: ${SCREEN_SIZE[1]}px;
  overflow: hidden;
`;

// the size of the screen is read from it
const Plot = styled.div`
  position: absolute;
  inset: 0;
`;

const Layer = styled.svg`
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
`;

// what moves: under the lines and the points of the three bands (its bars), over the curve of one band (its dot
// is on the curve, not behind it)
const Canvas = styled.canvas`
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;

  &.front {
    z-index: 1;
  }
`;

// what is dragged on the screen: a crossover up and down all along its line (a grip at its right, where the bars
// of the reductions never reach), the gain of a band sideways by the point at the end of its line
const GripRoot = styled.div`
  position: absolute;
  touch-action: none;
  outline: none;

  &::after {
    content: '';
    position: absolute;
    box-sizing: border-box;
    border: 1.5px solid ${COLOR};
    background: ${theme.colors.primaryDark};
    transition: background 150ms;
  }

  &.y {
    left: 0;
    right: 0;
    height: 12px;
    margin-top: -6px;
    cursor: ns-resize;
  }

  &.y::after {
    right: 3px;
    top: 3px;
    width: 10px;
    height: 6px;
    border-radius: 2px;
  }

  &.x {
    width: 20px;
    height: 20px;
    margin: -10px 0 0 -10px;
    cursor: ew-resize;
  }

  &.x::after {
    left: 6px;
    top: 6px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }

  &:hover::after,
  &.active::after,
  &:focus-visible::after {
    background: ${COLOR};
  }

  &.disabled {
    cursor: default;
    pointer-events: none;
  }
`;

interface GripProps {
  param: BandParam;
  value: number;
  // where it is, css px of the screen
  x: number;
  y: number;
  // the axis it is dragged along: a crossover up the frequencies, a gain across
  axis: 'x' | 'y';
  size: Size;
  setParam: (key: string, value: number) => void;
  // a pointer holds it, or let it go (null)
  onHold: (held: BandParam | null) => void;
  disabled: boolean;
  // where a value it is set to stops within its range (a crossover at the other one)
  limit?: (param: BandParam, value: number) => number;
}

// a param set on the screen: dragged along its axis it follows the pointer, the arrows move it, a double click
// sets its default
const Grip = React.memo((props: GripProps) => {
  const { param, value, x, y, axis, size, setParam, onHold, disabled, limit } = props;
  const def = defs[param];
  const { name, label, min, max, precision = 1, mode = 'linear', formatValue } = def;
  const [active, setActive] = React.useState(false);
  const [trackPointer] = React.useState(singlePointerTracker);
  const last = React.useRef(value);
  const text = formatValue?.(value);

  const emit = (next: number) => {
    const within = number.thresholds(number.round(next, precision), min, max);
    const rounded = limit ? limit(param, within) : within;
    if (rounded === last.current) return;
    last.current = rounded;
    setParam(param, rounded);
  };
  // a change from the value it has now (a key, a double click)
  const emitFromNow = (next: number) => {
    last.current = value;
    emit(next);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    last.current = value;
    // the px of the pointer are those of the viewport: the screen may be scaled (the mini view of a phone)
    const plot = e.currentTarget.parentElement;
    const scale = (plot?.offsetWidth && plot.getBoundingClientRect().width / plot.offsetWidth) || 1;
    const along = (pointer: { clientX: number; clientY: number }) =>
      axis === 'x' ? pointer.clientX : pointer.clientY;
    const valueAt = (px: number) => (axis === 'y' ? yFreq(px, size) : xGain(px, size));
    const from = along(e);
    const place = axis === 'x' ? x : y;
    const tracked = trackPointer(
      e,
      (move) => emit(valueAt(place + (along(move) - from) / scale)),
      () => {
        setActive(false);
        onHold(null);
      }
    );
    if (!tracked) return;
    setActive(true);
    onHold(param);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const direction = KEY_DIRECTIONS[e.key];
    if (!direction) return;
    e.preventDefault();
    const scale = valueScale(mode).domain([min, max]).range([0, 1]);
    emitFromNow(scale.invert(number.thresholds(scale(value) + direction * KEY_STEP, 0, 1)));
  };

  return (
    <GripRoot
      className={cls(axis, { active, disabled })}
      style={{ left: x, top: y }}
      role='slider'
      tabIndex={disabled ? -1 : 0}
      aria-label={name ?? label}
      aria-orientation={axis === 'x' ? 'horizontal' : 'vertical'}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={typeof text === 'string' ? text : undefined}
      aria-disabled={disabled || undefined}
      {...(!disabled && {
        onPointerDown,
        onKeyDown,
        onDoubleClick: () => emitFromNow(def.default),
      })}
    />
  );
});

const path = (points: Vector2D[]) => points.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join('');

// one band: the dry diagonal, the curve of the threshold and the ratio over its area, a line at the threshold
const CurveLayer = React.memo(({ thresh, ratio, size }: { thresh: number; ratio: number; size: Size }) => {
  const curve = transferCurve(thresh, ratio, size);
  const [first] = curve;
  const end = curve[curve.length - 1];
  const bottom = levelY(LEVEL_FLOOR, size);
  // the curve has its knee only while the threshold is on the plot
  const knee = curve.length === 3 ? curve[1][0] : null;
  return (
    <>
      {knee !== null && (
        <path
          data-testid='compressor-threshold'
          d={path([
            [knee, 0],
            [knee, size[1]],
          ])}
          stroke={theme.colors.primaryDarkMediumContrast}
          strokeWidth='1'
        />
      )}
      <path
        d={path(unityLine(size))}
        stroke={theme.colors.primaryHighContrast}
        strokeWidth='1'
        opacity='0.5'
      />
      <path d={`${path(curve)}L${end[0]},${bottom}L${first[0]},${bottom}Z`} fill={COLOR} opacity='0.15' />
      <path
        data-testid='compressor-curve'
        d={path(curve)}
        stroke={COLOR}
        strokeWidth='1.5'
        strokeLinejoin='round'
        fill='none'
      />
    </>
  );
});

// three bands: the line of 0 dB down the middle and fainter ones half way to the ends of the range, the crossovers
// between the rows; in each row its gain as a line from 0 dB to its point (as the arc of a knob filled from its
// middle)
interface BandsLayerProps {
  zones: ReturnType<typeof bandZones>;
  low: number;
  mid: number;
  high: number;
  size: Size;
}

const BandsLayer = React.memo(({ zones, size, ...gains }: BandsLayerProps) => {
  const [width, height] = size;
  const middle = gainX(0, size);
  const down = (x: number) =>
    path([
      [x, 0],
      [x, height],
    ]);
  return (
    <>
      {[-METER_RANGE / 2, METER_RANGE / 2].map((db) => (
        <path
          key={db}
          d={down(gainX(db, size))}
          stroke={theme.colors.primaryDarkMediumContrast}
          strokeWidth='1'
          strokeDasharray='1 3'
        />
      ))}
      <path d={down(middle)} stroke={theme.colors.primaryDarkMediumContrast} strokeWidth='1' />
      {zones.slice(1).map((zone, i) => (
        <path
          key={i}
          d={path([
            [0, zone.bottom],
            [width, zone.bottom],
          ])}
          stroke={theme.colors.primaryDarkHighContrast}
          strokeWidth='1'
          opacity='0.6'
        />
      ))}
      {zones.map((zone, band) => (
        <path
          key={band}
          data-testid={`compressor-gain-${BAND_GAINS[band]}`}
          d={path([
            [middle, zone.center],
            [gainX(gains[BAND_GAINS[band]], size), zone.center],
          ])}
          stroke={COLOR}
          strokeWidth='2'
          strokeLinecap='round'
        />
      ))}
    </>
  );
});

// a bar from `from` to its tip: faint where it starts, a bright edge at the tip
const drawBar = (
  context: CanvasRenderingContext2D,
  { color, start, end }: typeof REDUCTION,
  { x, y, width, height }: Rect,
  from: number
) => {
  const tip = from > x ? x : x + width;
  const fade = context.createLinearGradient(from, 0, tip, 0);
  fade.addColorStop(0, start);
  fade.addColorStop(1, end);
  context.fillStyle = fade;
  context.fillRect(x, y, width, height);
  const edge = Math.min(BAR_EDGE, width);
  context.fillStyle = color;
  context.fillRect(from > x ? x : tip - edge, y, edge, height);
};

interface Props {
  // every param of the compressor
  params: Record<string, number>;
  setParam: (key: string, value: number) => void;
  meter?: FxMeter;
  // three bands, else one
  multi: boolean;
  active: boolean;
}

// The compressor at work (its layout: compressor-screen-geometry.ts); in three bands the crossovers and the gains
// are dragged here as well as in the windows at its sides. What moves is drawn on a canvas as the values of the
// meter come (about 30 times a second, only while this is shown and the effect is on: the worklet posts nothing
// otherwise), no render, nothing in the DOM
export const CompressorScreen = ({ params, setParam, meter, multi, active }: Props) => {
  // (the size is the same array while it doesn't change)
  const [plot, size] = useElementSize<HTMLDivElement>();
  const [width, height] = size;
  const { canvas, begin } = useCanvas(width, height);
  const [held, setHeld] = React.useState<BandParam | null>(null);
  const { xlow, xhigh } = params;
  const zones = React.useMemo(() => bandZones(xlow, xhigh, size), [xlow, xhigh, size]);
  const limit = React.useMemo(() => bandLimit(xlow, xhigh), [xlow, xhigh]);

  const draw = React.useCallback(
    (values: FxMeterValues | null) => {
      const context = begin();
      if (!context || !size[0]) return;
      if (multi) {
        const bars = bandBars(values, zones, size);
        bars.gains.forEach((rect) => drawBar(context, rect.gain > 0 ? BOOST : REDUCTION, rect, bars.middle));
        return;
      }
      const marks = singleMarks(values, size);
      drawBar(context, REDUCTION, marks.reduction, size[0]);
      if (!marks.dot) return;
      context.fillStyle = theme.colors.white;
      context.beginPath();
      context.arc(marks.dot[0], marks.dot[1], DOT_RADIUS, 0, 2 * Math.PI);
      context.fill();
    },
    [begin, size, multi, zones]
  );

  // the values shown last are drawn again as the screen changes (a crossover dragged, its size), the meter is
  // watched once
  const last = React.useRef<FxMeterValues | null>(null);
  const drawing = React.useRef(draw);
  React.useEffect(() => {
    drawing.current = draw;
    draw(last.current);
  }, [draw]);
  React.useEffect(() => {
    if (!meter || !active) return undefined;
    const stop = meter.watch((values) => {
      last.current = values;
      drawing.current(values);
    });
    return () => {
      stop();
      last.current = null;
      drawing.current(null);
    };
  }, [meter, active]);

  const grip = (key: BandParam, x: number, y: number, axis: 'x' | 'y') => (
    <Grip
      key={key}
      param={key}
      value={bandValue(key, params)}
      x={x}
      y={y}
      axis={axis}
      size={size}
      setParam={setParam}
      onHold={setHeld}
      disabled={!active}
      limit={limit}
    />
  );

  return (
    <Tooltip
      content={
        held && (
          <ValueTooltip name={defs[held].name}>
            {defs[held].formatValue?.(bandValue(held, params))}
          </ValueTooltip>
        )
      }
    >
      <Root data-testid='compressor-screen'>
        <Plot ref={plot}>
          <Canvas {...canvas} className={cls({ front: !multi })} aria-hidden />
          {width > 0 && (
            <>
              <Layer aria-hidden>
                {multi ? (
                  <BandsLayer
                    zones={zones}
                    low={params['low']}
                    mid={params['mid']}
                    high={params['high']}
                    size={size}
                  />
                ) : (
                  <CurveLayer thresh={params['thresh']} ratio={params['ratio']} size={size} />
                )}
              </Layer>
              {/* a crossover on the line over its band, the gain of a band at the end of its line */}
              {multi && grip('xlow', 0, zones[0].top, 'y')}
              {multi && grip('xhigh', 0, zones[1].top, 'y')}
              {multi &&
                BAND_GAINS.map((key, band) => grip(key, gainX(params[key], size), zones[band].center, 'x'))}
            </>
          )}
        </Plot>
        {!active && <Deactivated data-testid='compressor-screen-deactivated' />}
      </Root>
    </Tooltip>
  );
};
