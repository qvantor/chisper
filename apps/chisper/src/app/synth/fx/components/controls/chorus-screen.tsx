import React from 'react';
import { styled } from 'styled-components';
import hexToRgba from 'hex-to-rgba';
import {
  Deactivated,
  onFrame,
  theme,
  Tooltip,
  useCanvas,
  useElementSize,
  ValueTooltip,
} from '@chisper/ui-kit';
import { number } from '@chisper/math';
import { chorus } from '../../effects/chorus';
import {
  ChorusMeterValues,
  chorusTaps,
  TAP_FOLLOW_MS,
  tapChannel,
  tapDelayParam,
  TAPS,
} from '../../effects/chorus-params';
import type { FxMeter } from '../../effects/types';
import {
  channelY,
  cutoffGlow,
  laneY,
  msX,
  plotBottom,
  Size,
  tapBars,
  tapEchoes,
  TICKS,
  xDepth,
  xMs,
} from './chorus-screen-geometry';
import { ScreenCanvas, ScreenGrip, ScreenLayer, ScreenPlot } from './screen-grip';

// css px of the screen (narrower on phones, never wider than the display of the compressor)
export const CHORUS_SCREEN_SIZE: Size = [240, 80];
const MAX_WIDTH = 348;
// the channels: the left one, the right one (their bars, their handles, the glow and the repeats of their taps)
export const CHANNEL_COLORS = [theme.colors.accent, theme.colors.secondAccent];
const channelColor = (tap: number) => CHANNEL_COLORS[tapChannel(tap)];
// the tail of a tap of a channel: from its color to nothing
const TAIL_COLORS = CHANNEL_COLORS.map((color) => [hexToRgba(color, 0.9), hexToRgba(color, 0)]);
// px: the height of a lane and of the bar in it, a tap and its glow, a repeat of it
const LANE = 6;
const DOT_RADIUS = 2.5;
const GLOW = 7;
const ECHO_RADIUS = 1.75;
// the tail a moving tap leaves: where it was this many ms ago, never longer than this many px
const TAIL_MS = 70;
const TAIL_MAX = 28;
// the taps of a chorus at rest (nothing sounds in it): fainter, no glow, where its LFO was then
const REST_ALPHA = 0.35;
// the share of the cutoff it moves by before its glow is drawn again
const GLOW_STEP = 0.003;
// ms a frame steps the taps by at most (the tab was hidden: they are placed, not swept)
const MAX_STEP = 100;
// ms without a word of the meter after which a chorus that sounded is taken to rest (it tells about 30 times a
// second: its processor failed, its context is suspended), until the meter tells again
const STALE_MS = 500;

const { params: defs } = chorus;
type ScreenParam = 'd1' | 'd2' | 'depth';

const Root = styled.div`
  position: relative;
  width: var(--fx-chart-width, ${CHORUS_SCREEN_SIZE[0]}px);
  max-width: ${MAX_WIDTH}px;
  min-width: 96px;
  height: ${CHORUS_SCREEN_SIZE[1]}px;
  overflow: hidden;
  border-radius: 3px;
  background: ${theme.colors.primaryDark};
`;

const Plot = ScreenPlot;

const Layer = styled(ScreenLayer)`
  text {
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.3px;
    fill: ${theme.colors.primaryDarkHighContrast};
    user-select: none;
  }
`;

// what moves: the glow of the filter under everything, the taps over their bars and the handles of them
const Canvas = ScreenCanvas;

// what stands still: the ms, the names of the channels, a lane for each tap with the bar of its travel (fainter
// at its start: the tap is at its end at the top of the LFO)
type Bars = ReturnType<typeof tapBars>;
const Lanes = React.memo(({ bars, size }: { bars: Bars; size: Size }) => {
  const id = React.useId();
  const bottom = plotBottom(size);
  const [first, last] = [msX(TICKS[0], size), msX(Infinity, size)];
  return (
    <>
      <defs>
        {CHANNEL_COLORS.map((color, channel) => (
          <linearGradient key={color} id={`${id}${channel}`}>
            <stop offset='0' stopColor={color} stopOpacity='0.16' />
            <stop offset='1' stopColor={color} stopOpacity='0.5' />
          </linearGradient>
        ))}
      </defs>
      {TICKS.map((ms, i) => (
        <React.Fragment key={ms}>
          <rect
            x={msX(ms, size) - 0.5}
            y='0'
            width='1'
            height={bottom}
            fill={theme.colors.white}
            opacity='0.04'
          />
          <text x={msX(ms, size)} y={bottom + 10} textAnchor='middle'>
            {i === TICKS.length - 1 ? `${ms}ms` : ms}
          </text>
        </React.Fragment>
      ))}
      {CHANNEL_COLORS.map((color, channel) => (
        <text key={color} x='4' y={channelY(channel, size) + 3} style={{ fill: color }} opacity='0.8'>
          {'LR'[channel]}
        </text>
      ))}
      {bars.map(({ from, to, y }, tap) => (
        <React.Fragment key={tap}>
          <rect
            x={first}
            y={y - LANE / 2}
            width={last - first}
            height={LANE}
            rx={LANE / 2}
            fill={theme.colors.white}
            opacity='0.05'
          />
          <rect
            data-testid={`chorus-bar-${tap}`}
            x={from}
            y={y - LANE / 2}
            width={to - from}
            height={LANE}
            rx={LANE / 2}
            fill={`url(#${id}${tapChannel(tap)})`}
          />
        </React.Fragment>
      ))}
    </>
  );
});

interface Props {
  // every param of the chorus
  params: Record<string, number>;
  setParam: (key: string, value: number) => void;
  meter?: FxMeter<ChorusMeterValues>;
  active: boolean;
}

// The taps of the chorus at work (its layout: chorus-screen-geometry.ts): a lane each, in it the bar of where its
// LFO takes it, dragged by its start (the delay of the tap) and by its end (the depth), and the tap itself, a point
// that moves as the LFO of the core has it (glowing, a tail behind it) with the repeats its feedback gives; the left
// channel in one color, the right one in another. The meter tells the LFO and the
// knobs of the taps as they are about 30 times a second (only while this is shown and the effect is on: the worklet
// posts nothing otherwise); between two of them the LFO goes on here at its rate and the taps follow it through
// their pole, as in the core. They are drawn on a canvas every frame while the chorus sounds, once where it came to
// rest (there by the knobs of its taps: the meter says nothing more, they follow a drag): no render, nothing in the
// DOM. A meter that stops telling leaves them at rest too (STALE_MS). Behind them the glow of the filter (cutoffGlow), on a canvas of its own: of
// the cutoff as the core has it while it sounds (the routes move it), of the knob else
export const ChorusScreen = ({ params, setParam, meter, active }: Props) => {
  // (the size is the same array while it doesn't change)
  const [plot, size] = useElementSize<HTMLDivElement>();
  const [width, height] = size;
  const { canvas, begin } = useCanvas(width, height);
  const [held, setHeld] = React.useState<ScreenParam | null>(null);
  const { canvas: glowCanvas, begin: beginGlow } = useCanvas(width, height);
  const { d1, d2, depth, fb, cut } = params;
  const high = params['hpf'] >= 0.5;

  // the values told last and when (ms of the clock of the frames), the taps as drawn last (ms) and when; `placed`:
  // they follow from there (else they are put where the LFO has them: the first values, a chorus that woke)
  const [live] = React.useState(() => ({
    values: null as ChorusMeterValues | null,
    at: 0,
    taps: new Array<number>(TAPS).fill(0),
    targets: new Array<number>(TAPS).fill(0),
    placed: false,
    drawnAt: 0,
    // the cutoff the glow is drawn of (Hz)
    glow: 0,
  }));

  // of the cutoff as the core has it while it sounds, of the knob else
  const glow = React.useCallback(() => {
    const context = beginGlow();
    if (!context || !size[0]) return;
    const { values } = live;
    const hz = values && !values.idle ? values.cut : cut;
    const { x, y, inner, outer, from, to } = cutoffGlow(hz, high, size);
    const light = context.createRadialGradient(x, y, inner, x, y, outer);
    light.addColorStop(0, from);
    light.addColorStop(1, to);
    context.fillStyle = light;
    context.fillRect(0, 0, size[0], size[1]);
    live.glow = hz;
  }, [beginGlow, size, high, cut, live]);
  // (the frames of the taps move it: they read the one of now)
  const glowing = React.useRef(glow);
  React.useEffect(() => {
    glowing.current = glow;
    glow();
  }, [glow]);

  const draw = React.useCallback(
    (time: number) => {
      const context = begin();
      const { values, taps, targets } = live;
      if (!context || !size[0] || !values) return;
      const rest = values.idle;
      // the glow where the cutoff went (a route moves it), drawn again once that shows
      if (!rest && Math.abs(values.cut - live.glow) > GLOW_STEP * live.glow) glowing.current();
      // at rest the LFO as it was told and the knobs as they are (nothing is told of them any more), else the
      // LFO as far on as its rate took it since, the knobs as the core has them
      const since = rest ? 0 : Math.max(time - live.at, 0) / 1000;
      chorusTaps(values.phase + values.rate * since, rest ? { d1, d2, depth } : values, targets);
      const follows = live.placed && !rest;
      const step = Math.min(time - live.drawnAt, MAX_STEP);
      const share = follows ? Math.max(1 - Math.exp(-step / TAP_FOLLOW_MS), 0) : 1;
      live.placed = !rest;
      live.drawnAt = time;

      const level = rest ? REST_ALPHA : 1;
      const perMs = msX(1, size) - msX(0, size);
      for (let tap = 0; tap < TAPS; tap++) {
        const moved = (targets[tap] - taps[tap]) * share;
        taps[tap] += moved;
        const [x, y] = [msX(taps[tap], size), laneY(tap, size)];
        const color = channelColor(tap);
        // its tail: from where it was, fading (ms a ms it moved by in this frame; none: placed, at rest)
        const speed = follows && step > 0 ? moved / step : 0;
        const tail = number.thresholds(speed * TAIL_MS * perMs, -TAIL_MAX, TAIL_MAX);
        if (Math.abs(tail) > 1) {
          const [from, to] = TAIL_COLORS[tapChannel(tap)];
          const fade = context.createLinearGradient(x, 0, x - tail, 0);
          fade.addColorStop(0, from);
          fade.addColorStop(1, to);
          context.strokeStyle = fade;
          context.lineWidth = 2 * DOT_RADIUS;
          context.lineCap = 'round';
          context.beginPath();
          context.moveTo(x, y);
          context.lineTo(x - tail, y);
          context.stroke();
        }
        context.fillStyle = color;
        const echoes = tapEchoes(taps[tap], fb);
        for (let echo = 0, part = fb; echo < echoes; echo++, part *= fb) {
          context.globalAlpha = level * part;
          context.beginPath();
          context.arc(msX((echo + 2) * taps[tap], size), y, ECHO_RADIUS, 0, 2 * Math.PI);
          context.fill();
        }
        // the tap: a white point glowing in the color of its channel while the chorus sounds
        context.globalAlpha = level;
        context.shadowColor = color;
        context.shadowBlur = rest ? 0 : GLOW;
        context.fillStyle = theme.colors.white;
        context.beginPath();
        context.arc(x, y, DOT_RADIUS, 0, 2 * Math.PI);
        context.fill();
        context.shadowBlur = 0;
      }
      context.globalAlpha = 1;
    },
    [begin, size, fb, d1, d2, depth, live]
  );

  // the taps are drawn again as the screen changes (its size, the feedback, at rest the knobs of the taps), the
  // meter is watched once
  const drawing = React.useRef(draw);
  const frames = React.useRef<(() => void) | null>(null);
  React.useEffect(() => {
    drawing.current = draw;
    // (while the frames run the next one draws it)
    if (!frames.current) draw(performance.now());
  }, [draw]);
  React.useEffect(() => {
    if (!meter || !active) return undefined;
    const rest = () => {
      frames.current?.();
      frames.current = null;
    };
    // a frame of a chorus that sounds; one the meter told nothing of for too long: at rest where its LFO came to
    const frame = (time: number) => {
      const { values } = live;
      if (values && time - live.at > STALE_MS) {
        const phase = values.phase + (values.rate * (time - live.at)) / 1000;
        live.values = { ...values, phase, idle: true };
        rest();
        glowing.current();
      }
      drawing.current(time);
    };
    const stop = meter.watch((values) => {
      if (!live.values || live.values.idle) live.placed = false;
      live.values = values;
      live.at = performance.now();
      if (values.idle) {
        rest();
        drawing.current(live.at);
        glowing.current();
      } else frames.current ??= onFrame(frame);
    });
    return () => {
      stop();
      rest();
      live.values = null;
      drawing.current(0);
      glowing.current();
    };
  }, [meter, active, live]);

  // the value at a place across the screen: a delay, the depth of a bar that starts at a delay
  // (each its own: a grip is drawn again only as its own changes)
  const delayAt = React.useCallback((px: number) => xMs(px, size), [size]);
  const depthAt = {
    d1: React.useCallback((px: number) => xDepth(px, d1, size), [d1, size]),
    d2: React.useCallback((px: number) => xDepth(px, d2, size), [d2, size]),
  };
  const bars = React.useMemo(() => tapBars({ d1, d2, depth }, size), [d1, d2, depth, size]);
  const grip = (param: ScreenParam, tap: number, x: number, shape: 'start' | 'end', twin: boolean) => (
    <ScreenGrip
      key={`${shape}${tap}`}
      param={param}
      def={defs[param]}
      value={params[param]}
      x={x}
      y={laneY(tap, size)}
      axis='x'
      shape={shape}
      color={channelColor(tap)}
      valueAt={shape === 'start' ? delayAt : depthAt[tapDelayParam(tap)]}
      setParam={setParam}
      onHold={setHeld}
      disabled={!active}
      twin={twin}
    />
  );

  return (
    <Tooltip
      content={
        held && <ValueTooltip name={defs[held].name}>{defs[held].formatValue?.(params[held])}</ValueTooltip>
      }
    >
      <Root data-testid='chorus-screen'>
        <Plot ref={plot}>
          <Canvas {...glowCanvas} data-testid='chorus-glow' aria-hidden />
          {width > 0 && (
            <Layer aria-hidden>
              <Lanes bars={bars} size={size} />
            </Layer>
          )}
          {/* the start of a bar is the delay of its tap, its end the depth; the keys and the names on the bars of
              the left channel (the depth on its first), the others for a pointer */}
          {width > 0 &&
            bars.map(({ from, to }, tap) => [
              grip(tapDelayParam(tap), tap, from, 'start', tap >= 2),
              grip('depth', tap, to, 'end', tap >= 1),
            ])}
          <Canvas {...canvas} data-testid='chorus-taps' aria-hidden />
        </Plot>
        {!active && <Deactivated data-testid='chorus-screen-deactivated' />}
      </Root>
    </Tooltip>
  );
};
