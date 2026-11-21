import React from 'react';
import { styled } from 'styled-components';
import cls from 'classnames';
import hexToRgba from 'hex-to-rgba';
import {
  Deactivated,
  HandleModulation,
  liveKnob,
  singlePointerTracker,
  theme,
  Tooltip,
  useCanvas,
  useElementSize,
  useLiveDraw,
  ValueTooltip,
} from '@chisper/ui-kit';
import { number } from '@chisper/math';
import { EQ_PASS, eqTypeOf } from '@chisper/math/eq';
import { eq } from '../../effects/eq';
import { EQ_BANDS, EqBandKeys } from '../../effects/eq-params';
import { EqParam } from '../../effects/eq-presets';
import {
  bandCurve,
  bandDesign,
  bandKnobs,
  BandKnobs,
  bandPoint,
  bandUpDown,
  curvePoints,
  DB_LINES,
  dbY,
  FREQ_LABELS,
  FREQ_LINES,
  freqX,
  POINTS,
  Size,
  xFreq,
} from './eq-screen-geometry';
import {
  FRAME_SIZE,
  keyStep,
  pointerScale,
  SCREEN_COLOR,
  ScreenCanvas,
  ScreenFrame,
  ScreenLabels,
  ScreenPlot,
  withinDef,
} from './screen-grip';

// css px of the screen
export const EQ_SCREEN_SIZE: Size = FRAME_SIZE;
// the bands: their curves, their points and the rings of their grips
export const BAND_COLORS = [theme.colors.secondAccent, theme.colors.thirdAccent];
const BAND_LINE_COLORS = BAND_COLORS.map((color) => hexToRgba(color, 0.5));
const SUM_FILL = hexToRgba(SCREEN_COLOR, 0.15);
// px: the point of a band where its routes take it, the line of a band, of both
const DOT_RADIUS = 2.5;
const BAND_LINE = 1;
const LINE = 1.5;
// of 100 % a step of the wheel moves the resonance by (a notch: 100)
const WHEEL_STEP = 0.05;

const { params: defs } = eq;

// what stands still: a line at each frequency and dB of the grid, 0 dB brighter, the labels of the decades
const Grid = React.memo(({ size }: { size: Size }) => (
  <>
    {FREQ_LINES.map((hz) => (
      <rect
        key={hz}
        x={freqX(hz, size) - 0.5}
        y='0'
        width='1'
        height={size[1]}
        fill={theme.colors.white}
        opacity='0.04'
      />
    ))}
    {DB_LINES.map((db) => (
      <rect
        key={db}
        x='0'
        y={dbY(db, size) - 0.5}
        width={size[0]}
        height='1'
        fill={theme.colors.white}
        opacity={db === 0 ? 0.12 : 0.04}
      />
    ))}
    {FREQ_LABELS.map(([hz, label]) => (
      <text key={hz} x={freqX(hz, size) + 2} y={size[1] - 3}>
        {label}
      </text>
    ))}
  </>
));

// the knobs of the bands a frame draws: frequency, resonance, gain of each (the types switch, no route moves them);
// the gain of a pass draws nothing: no travel, its routes draw no frame
const liveKnobs = (
  params: Record<string, number>,
  modulations: Partial<Record<EqParam, HandleModulation[]>>
) =>
  EQ_BANDS.flatMap(({ type, freq, reso, gain }) => {
    const pass = eqTypeOf(params[type]) === EQ_PASS;
    return [freq, reso, gain].map((key) =>
      liveKnob(params[key], pass && key === gain ? undefined : defs[key], modulations[key])
    );
  });

// the curves of the bands, the curve of both (filled to 0 dB) and the point of each, where the routes take them
const useCurves = (
  params: Record<string, number>,
  sampleRate: number,
  size: Size,
  modulations: Partial<Record<EqParam, HandleModulation[]>>,
  active: boolean
) => {
  const [width, height] = size;
  const { canvas, begin } = useCanvas(width, height);
  const [bands, sum] = React.useMemo(
    () => [[new Float64Array(POINTS), new Float64Array(POINTS)], new Float64Array(POINTS)],
    []
  );
  // the x of each point of a curve
  const xs = React.useMemo(
    () => Float64Array.from(curvePoints(sampleRate).hz, (hz) => freqX(hz, size)),
    [sampleRate, size]
  );
  const { t1, t2 } = params;
  const draw = React.useCallback(
    (values: number[]) => {
      const context = begin();
      if (!context || !width) return;
      const knobs: BandKnobs[] = [
        { type: t1, freq: values[0], reso: values[1], gain: values[2] },
        { type: t2, freq: values[3], reso: values[4], gain: values[5] },
      ];
      sum.fill(0);
      knobs.forEach((band, index) => {
        bandCurve(bandDesign(index, band, sampleRate), sampleRate, bands[index]);
        for (let i = 0; i < POINTS; i++) sum[i] += bands[index][i];
      });
      const zero = dbY(0, size);
      const path = (curve: Float64Array) => {
        context.beginPath();
        for (let i = 0; i < POINTS; i++) context.lineTo(xs[i], dbY(curve[i], size));
      };
      // each band, faint
      context.lineWidth = BAND_LINE;
      bands.forEach((curve, index) => {
        context.strokeStyle = BAND_LINE_COLORS[index];
        path(curve);
        context.stroke();
      });
      // both, filled to 0 dB
      path(sum);
      context.lineTo(xs[POINTS - 1], zero);
      context.lineTo(xs[0], zero);
      context.closePath();
      context.fillStyle = SUM_FILL;
      context.fill();
      context.lineWidth = LINE;
      context.strokeStyle = SCREEN_COLOR;
      path(sum);
      context.stroke();
      // the point of each band
      knobs.forEach((band, index) => {
        const [x, y] = bandPoint(band, size);
        context.fillStyle = BAND_COLORS[index];
        context.beginPath();
        context.arc(x, y, DOT_RADIUS, 0, 2 * Math.PI);
        context.fill();
      });
    },
    [begin, width, size, xs, bands, sum, t1, t2, sampleRate]
  );
  useLiveDraw(liveKnobs(params, modulations), draw, active);
  return canvas;
};

const GripRoot = styled.div`
  position: absolute;
  width: 16px;
  height: 16px;
  margin: -8px 0 0 -8px;
  touch-action: none;
  outline: none;
  cursor: move;

  &::after {
    content: '';
    position: absolute;
    inset: 3px;
    box-sizing: border-box;
    border: 1.5px solid var(--band-color);
    border-radius: 50%;
    background: ${theme.colors.primaryDark};
    transition: background 150ms;
  }

  &:hover::after,
  &.active::after,
  &:focus-visible::after {
    background: var(--band-color);
  }

  &.disabled {
    cursor: default;
    pointer-events: none;
  }
`;

interface GripProps extends BandKnobs {
  band: number;
  keys: EqBandKeys;
  size: Size;
  setParam: (key: string, value: number) => void;
  // a pointer holds it, or let it go (null)
  onHold: (band: number | null) => void;
  disabled: boolean;
}

// the point of a band set on the screen: dragged, its frequency across and its gain up and down (of a pass its
// resonance: the point is on its curve); the wheel over it its resonance; the arrows move it, a double click sets
// its gain (of a pass its resonance) to the default
const EqGrip = React.memo(({ band, keys, size, setParam, onHold, disabled, ...knobs }: GripProps) => {
  const ref = React.useRef<HTMLDivElement>(null);
  const [active, setActive] = React.useState(false);
  const [trackPointer] = React.useState(singlePointerTracker);
  // the knob up and down
  const upDown = eqTypeOf(knobs.type) === EQ_PASS ? 'reso' : 'gain';
  const [x, y] = bandPoint(knobs, size);
  // the values set last (a move sets only what changed)
  const last = React.useRef<Partial<Record<EqParam, number>>>({});
  const emit = (key: EqParam, value: number) => {
    const next = withinDef(defs[key], value);
    if (next === last.current[key]) return;
    last.current[key] = next;
    setParam(key, next);
  };
  const now = () => {
    last.current = { [keys.freq]: knobs.freq, [keys.reso]: knobs.reso, [keys.gain]: knobs.gain };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    now();
    const scale = pointerScale(e.currentTarget);
    const [fromX, fromY] = [e.clientX, e.clientY];
    const tracked = trackPointer(
      e,
      (move) => {
        emit(keys.freq, xFreq(x + (move.clientX - fromX) / scale, size));
        emit(keys[upDown], bandUpDown(knobs.type, y + (move.clientY - fromY) / scale, size));
      },
      () => {
        setActive(false);
        onHold(null);
      }
    );
    if (!tracked) return;
    setActive(true);
    onHold(band);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const across = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    const along = { ArrowUp: 1, ArrowDown: -1 }[e.key];
    if (!across && !along) return;
    e.preventDefault();
    now();
    const knob = across ? 'freq' : upDown;
    emit(keys[knob], keyStep(defs[keys[knob]], knobs[knob], across ?? along ?? 0));
  };

  // the wheel: the resonance (not passive: the page doesn't scroll under it). The value it moved to before the
  // rounding goes on from one event to the next (a slow scroll of a trackpad moves it by less than a step of the knob
  // an event: rounded each time it went up alone), forgotten once the knob is set to another value than it set
  const wheeled = React.useRef<{ value: number; set: number | undefined } | null>(null);
  React.useEffect(() => {
    if (wheeled.current?.set !== knobs.reso) wheeled.current = null;
  }, [knobs.reso]);
  const resonance = React.useRef({ knobs, keys, emit, now });
  resonance.current = { knobs, keys, emit, now };
  React.useEffect(() => {
    const node = ref.current;
    if (!node || disabled) return undefined;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { knobs, keys, emit, now } = resonance.current;
      // (going on, what it set last is the knob, whether it has come back yet or not)
      if (!wheeled.current) now();
      const { min, max } = defs[keys.reso];
      const value = number.thresholds(
        (wheeled.current?.value ?? knobs.reso) - e.deltaY * WHEEL_STEP,
        min,
        max
      );
      emit(keys.reso, value);
      wheeled.current = { value, set: last.current[keys.reso] };
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [disabled]);

  const { name: freqName, formatValue: formatFreq } = defs[keys.freq];
  const { formatValue: formatUpDown, default: upDownDefault } = defs[keys[upDown]];
  return (
    <GripRoot
      ref={ref}
      className={cls({ active, disabled })}
      style={{ left: x, top: y, '--band-color': BAND_COLORS[band] } as React.CSSProperties}
      role='slider'
      tabIndex={disabled ? -1 : 0}
      aria-label={`Band ${band + 1}`}
      aria-orientation='horizontal'
      aria-valuemin={defs[keys.freq].min}
      aria-valuemax={defs[keys.freq].max}
      aria-valuenow={knobs.freq}
      aria-valuetext={`${formatFreq?.(knobs.freq)}, ${formatUpDown?.(knobs[upDown])}`}
      aria-disabled={disabled || undefined}
      title={freqName}
      {...(!disabled && {
        onPointerDown,
        onKeyDown,
        onDoubleClick: () => {
          now();
          emit(keys[upDown], upDownDefault);
        },
      })}
    />
  );
});

interface Props {
  // every param of the EQ
  params: Record<string, number>;
  setParam: (key: string, value: number) => void;
  sampleRate: number;
  // the routes of the knobs of the bands
  modulations: Partial<Record<EqParam, HandleModulation[]>>;
  active: boolean;
}

// The response of the EQ (its layout: eq-screen-geometry.ts): the curve of each band (in its color) and of both
// (filled to 0 dB) as the core plays them, the point of each band where its routes take it: on a canvas, drawn again
// in every frame the routes move a knob in (useLiveDraw), nothing in the DOM moves. Over them a grip a band at its
// knobs: dragged, the wheel, the keys
export const EqScreen = ({ params, setParam, sampleRate, modulations, active }: Props) => {
  // (the size is the same array while it doesn't change)
  const [plot, size] = useElementSize<HTMLDivElement>();
  const [held, setHeld] = React.useState<number | null>(null);
  const canvas = useCurves(params, sampleRate, size, modulations, active);
  const knobs = EQ_BANDS.map((keys) => bandKnobs(params, keys));
  const tooltip = held !== null && (
    <ValueTooltip name={`Band ${held + 1}`}>
      {[
        defs[EQ_BANDS[held].freq].formatValue?.(knobs[held].freq),
        eqTypeOf(knobs[held].type) === EQ_PASS
          ? null
          : defs[EQ_BANDS[held].gain].formatValue?.(knobs[held].gain),
        `Q ${defs[EQ_BANDS[held].reso].formatValue?.(knobs[held].reso)}`,
      ]
        .filter(Boolean)
        .join(' · ')}
    </ValueTooltip>
  );
  return (
    <Tooltip content={tooltip}>
      <ScreenFrame data-testid='eq-screen'>
        <ScreenPlot ref={plot}>
          {size[0] > 0 && (
            <ScreenLabels aria-hidden>
              <Grid size={size} />
            </ScreenLabels>
          )}
          <ScreenCanvas {...canvas} data-testid='eq-curves' aria-hidden />
          {size[0] > 0 &&
            EQ_BANDS.map((keys, band) => (
              <EqGrip
                key={band}
                band={band}
                keys={keys}
                {...knobs[band]}
                size={size}
                setParam={setParam}
                onHold={setHeld}
                disabled={!active}
              />
            ))}
        </ScreenPlot>
        {!active && <Deactivated data-testid='eq-screen-deactivated' />}
      </ScreenFrame>
    </Tooltip>
  );
};
