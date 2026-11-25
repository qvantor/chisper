import React from 'react';
import hexToRgba from 'hex-to-rgba';
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
  freqX,
  POINTS,
  Size,
  xFreq,
} from './eq-screen-geometry';
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
export const EQ_SCREEN_SIZE: Size = FRAME_SIZE;
// the bands: their curves, their points and the rings of their grips
export const BAND_COLORS = [theme.colors.secondAccent, theme.colors.thirdAccent];
const BAND_LINE_COLORS = BAND_COLORS.map((color) => hexToRgba(color, 0.5));
const SUM_FILL = hexToRgba(SCREEN_COLOR, 0.15);
// px: the point of a band where its routes take it, the line of a band, of both
const DOT_RADIUS = 2.5;
const BAND_LINE = 1;
const LINE = 1.5;

const { params: defs } = eq;

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
  // the knob up and down
  const upDown = eqTypeOf(knobs.type) === EQ_PASS ? 'reso' : 'gain';
  const [x, y] = bandPoint(knobs, size);
  const param = (knob: 'freq' | 'reso' | 'gain') => ({
    key: keys[knob],
    def: defs[keys[knob]],
    value: knobs[knob],
  });
  const { formatValue: formatFreq } = defs[keys.freq];
  const { formatValue: formatUpDown } = defs[keys[upDown]];
  return (
    <PointGrip
      x={x}
      y={y}
      across={{ ...param('freq'), at: (px) => xFreq(px, size) }}
      upDown={{ ...param(upDown), at: (px) => bandUpDown(knobs.type, px, size) }}
      wheel={param('reso')}
      color={BAND_COLORS[band]}
      label={`Band ${band + 1}`}
      valueText={`${formatFreq?.(knobs.freq)}, ${formatUpDown?.(knobs[upDown])}`}
      setParam={setParam}
      onHold={(held) => onHold(held ? band : null)}
      disabled={disabled}
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
              <FreqGrid size={size} dbLines={DB_LINES} dbY={dbY} />
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
