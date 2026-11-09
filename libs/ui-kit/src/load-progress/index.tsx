import React from 'react';
import { styled } from 'styled-components';
import hexToRgba from 'hex-to-rgba';
import { useCanvas, useElementSize } from '../common/hooks';
import { onFrame } from '../common/utils/frame-ticker';
import { MIN_FRAME_MS } from '../common/utils/use-live-draw';

// fill: a bar with a sheen sweeping it and a leading edge (over a light key); gradient: a gradient alone, up to the
// share (over a dark select)
export type LoadProgressLook = 'fill' | 'gradient';

// ms: the share shown follows its goal (an exponential ease), faster to the end once loaded
const EASE_MS = 180;
const FINISH_MS = 70;
// ms: the start share of a load creeps in, fast then slower (it moves before the first bytes come)
const START_MS = 500;
// ms: it fades out once it reached the end
const FADE_MS = 320;
// the share counted as the end
const END = 0.995;

// a load being shown: the share drawn, the progress of the load (0..1) and the share it starts with (it creeps in,
// the progress fills the rest), whether the load ended (it runs to the end and fades), the times (ms, of the frames)
// it showed, it started to fade and of its last frame
export interface Run {
  shown: number;
  progress: number;
  start: number;
  done: boolean;
  shownAt: number | null;
  fadeAt: number | null;
  last: number | null;
}

const clamp = (share: number) => Math.min(1, Math.max(0, share));

// the run after a new progress: a load starts from nothing (from none, a load that ended, a progress under the one
// before: another load, a retry); a progress of the load goes on; none ends the load
export const nextRun = (run: Run | null, progress: number | null, start = 0): Run | null => {
  if (progress === null) return run && { ...run, done: true };
  const share = clamp(progress);
  if (!run || run.done || share < run.progress)
    return {
      shown: 0,
      progress: share,
      start: clamp(start),
      done: false,
      shownAt: null,
      fadeAt: null,
      last: null,
    };
  return { ...run, progress: share };
};

// the share a run goes to `age` ms after it showed: its start crept in by then and its progress over the rest; the
// end once loaded
const goal = (run: Run, age: number) =>
  run.done ? 1 : run.start * (1 - Math.exp(-age / START_MS)) + (1 - run.start) * run.progress;

// the run at a frame and its alpha (null: it has faded out, nothing to draw)
export const advance = (run: Run, time: number): { run: Run; alpha: number } | null => {
  const shownAt = run.shownAt ?? time;
  const dt = run.last === null ? 0 : time - run.last;
  const ease = 1 - Math.exp(-dt / (run.done ? FINISH_MS : EASE_MS));
  const eased = run.shown + (goal(run, time - shownAt) - run.shown) * ease;
  const shown = run.done && eased >= END ? 1 : eased;
  const fadeAt = run.fadeAt ?? (run.done && shown >= END ? time : null);
  const fade = fadeAt === null ? 1 : 1 - (time - fadeAt) / FADE_MS;
  if (fade <= 0) return null;
  return { run: { ...run, shown, shownAt, fadeAt, last: time }, alpha: Math.min(1, fade) };
};

// a drawing of the share loaded on a context of width × height css px at the time of a frame (ms)
interface Frame {
  context: CanvasRenderingContext2D;
  width: number;
  height: number;
  share: number;
  time: number;
  color: string;
  motion: boolean;
}
type Draw = (frame: Frame) => void;

// ms of a sweep of the sheen over the bar, the width of its band (css px, at least)
const SHEEN_MS = 1400;
const SHEEN_BAND = 32;
// css px of the leading edge
const EDGE = 2;

const drawFill: Draw = ({ context, width, height, share, time, color, motion }) => {
  const x = width * share;
  if (x <= 0) return;
  const body = context.createLinearGradient(0, 0, x, 0);
  body.addColorStop(0, hexToRgba(color, 0.08));
  body.addColorStop(1, hexToRgba(color, 0.3));
  context.fillStyle = body;
  context.fillRect(0, 0, x, height);
  if (motion) {
    const band = Math.max(SHEEN_BAND, width * 0.3);
    const at = ((time % SHEEN_MS) / SHEEN_MS) * (x + band) - band;
    const sheen = context.createLinearGradient(at, 0, at + band, 0);
    sheen.addColorStop(0, 'rgba(255, 255, 255, 0)');
    sheen.addColorStop(0.5, 'rgba(255, 255, 255, 0.55)');
    sheen.addColorStop(1, 'rgba(255, 255, 255, 0)');
    context.save();
    context.beginPath();
    context.rect(0, 0, x, height);
    context.clip();
    context.fillStyle = sheen;
    context.fillRect(at, 0, band, height);
    context.restore();
  }
  if (share < 1) {
    context.fillStyle = hexToRgba(color, 0.9);
    context.fillRect(Math.max(0, x - EDGE), 0, Math.min(EDGE, x), height);
  }
};

const drawGradient: Draw = ({ context, width, height, share, color }) => {
  const x = width * share;
  if (x <= 0) return;
  const body = context.createLinearGradient(0, 0, x, 0);
  body.addColorStop(0, hexToRgba(color, 0.04));
  body.addColorStop(1, hexToRgba(color, 0.32));
  context.fillStyle = body;
  context.fillRect(0, 0, x, height);
};

const DRAW: Record<LoadProgressLook, Draw> = { fill: drawFill, gradient: drawGradient };

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

// (a span: it goes in buttons)
const Root = styled.span`
  position: absolute;
  inset: 0;
  overflow: hidden;
  border-radius: inherit;
  pointer-events: none;
`;

const Canvas = styled.canvas`
  display: block;
  width: 100%;
  height: 100%;
`;

interface Props {
  // the share loaded, 0..1 (null: nothing loading)
  progress: number | null;
  look: LoadProgressLook;
  color: string;
  // the share a load creeps in to at once, the progress fills the rest (a slow line: it moves before its bytes)
  start?: number;
}

// the progress of a load on the background of its parent (positioned; the content goes over it): drawn on a canvas
// while it loads and as it runs to the end and fades out after, on the frames of the screen (at most every
// MIN_FRAME_MS); then nothing, no frame. Without motion (prefers-reduced-motion) no sheen
export const LoadProgress = ({ progress, look, color, start = 0 }: Props) => {
  const [rootRef, [width, height]] = useElementSize<HTMLSpanElement>();
  const { canvas, begin } = useCanvas(width, height);
  const run = React.useRef<Run | null>(null);
  const stop = React.useRef<(() => void) | null>(null);
  // what a frame draws with: the latest of them, the loop isn't started again for them
  const scene = React.useRef({ begin, width, height, look, color });
  React.useLayoutEffect(() => {
    scene.current = { begin, width, height, look, color };
  }, [begin, width, height, look, color]);

  React.useEffect(() => {
    run.current = nextRun(run.current, progress, start);
    if (!run.current || stop.current) return;
    const motion = !reducedMotion();
    let drawnAt = -Infinity;
    stop.current = onFrame((time) => {
      if (!run.current || time - drawnAt < MIN_FRAME_MS) return;
      drawnAt = time;
      const step = advance(run.current, time);
      const { begin: clear, width: w, height: h, look: drawn, color: c } = scene.current;
      const context = clear();
      if (!step) {
        run.current = null;
        stop.current?.();
        stop.current = null;
        return;
      }
      run.current = step.run;
      if (!context) return;
      context.globalAlpha = step.alpha;
      DRAW[drawn]({ context, width: w, height: h, share: step.run.shown, time, color: c, motion });
      context.globalAlpha = 1;
    });
  }, [progress, start]);

  React.useEffect(
    () => () => {
      stop.current?.();
      stop.current = null;
    },
    []
  );

  const loading = progress !== null;
  return (
    <Root
      ref={rootRef}
      role={loading ? 'progressbar' : undefined}
      aria-label={loading ? 'Loading' : undefined}
      aria-valuemin={loading ? 0 : undefined}
      aria-valuemax={loading ? 100 : undefined}
      aria-valuenow={loading ? Math.round(clamp(progress) * 100) : undefined}
      aria-hidden={loading ? undefined : true}
    >
      <Canvas {...canvas} />
    </Root>
  );
};
