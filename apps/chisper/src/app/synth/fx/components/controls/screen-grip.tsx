import React from 'react';
import { styled } from 'styled-components';
import cls from 'classnames';
import { number } from '@chisper/math';
import { singlePointerTracker, theme, valueScale } from '@chisper/ui-kit';
import type { FxParamDef } from '../../effects/types';
import { FREQ_LABELS, FREQ_LINES, freqX, Size } from './eq-screen-geometry';

// the lines and the points of a screen, as on the other charts of the synth
export const SCREEN_COLOR = theme.colors.accent;
// the share of its travel a key moves a grip by
const KEY_STEP = 0.02;
const KEY_DIRECTIONS: Record<string, number> = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 };

// a value of a param within its range at its precision
export const withinDef = ({ min, max, precision = 1 }: FxParamDef, value: number) =>
  number.thresholds(number.round(value, precision), min, max);

// the value a key moves a param from `value` to: a step along the travel of its knob (`direction` 1 or -1)
export const keyStep = ({ min, max, mode = 'linear' }: FxParamDef, value: number, direction: number) => {
  const scale = valueScale(mode).domain([min, max]).range([0, 1]);
  return scale.invert(number.thresholds(scale(value) + direction * KEY_STEP, 0, 1));
};

// px of the viewport a px of the screen a grip is on: the screen may be scaled (the mini view of a phone)
export const pointerScale = (grip: HTMLElement) => {
  const plot = grip.parentElement;
  return (plot?.offsetWidth && plot.getBoundingClientRect().width / plot.offsetWidth) || 1;
};

// the layers of a screen: the plot its size is read from, what stands still (an svg), what moves (a canvas)
export const ScreenPlot = styled.div`
  position: absolute;
  inset: 0;
`;
const layer = `
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
`;
export const ScreenLayer = styled.svg`
  ${layer}
`;
export const ScreenCanvas = styled.canvas`
  ${layer}
`;

// a screen of a group of its own (the chorus, the EQ): css px of it (narrower on phones, never wider than the
// display of the compressor), its frame, the layer of its labels
export const FRAME_SIZE = [240, 80] as const;
const FRAME_MAX_WIDTH = 348;
export const ScreenFrame = styled.div`
  position: relative;
  width: var(--fx-chart-width, ${FRAME_SIZE[0]}px);
  max-width: ${FRAME_MAX_WIDTH}px;
  min-width: 96px;
  height: ${FRAME_SIZE[1]}px;
  overflow: hidden;
  border-radius: 3px;
  background: ${theme.colors.primaryDark};
`;
export const ScreenLabels = styled(ScreenLayer)`
  text {
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.3px;
    fill: ${theme.colors.primaryDarkHighContrast};
    user-select: none;
  }
`;

// what is dragged on the screen of an effect, by its shape: `y` a line across it dragged up and down (a grip at
// its right), `x` a point dragged sideways, with `start` or `end` an end of a bar (a slim handle in its color)
const GripRoot = styled.div`
  position: absolute;
  touch-action: none;
  outline: none;

  &::after {
    content: '';
    position: absolute;
    box-sizing: border-box;
    border: 1.5px solid ${SCREEN_COLOR};
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

  /* the ends of a bar: a slim handle each, the hold of a start reaches left of it, of an end right of it (at the
     same place each takes its side) */
  &.x.start,
  &.x.end {
    width: 13px;
    height: 14px;
    margin: -7px 0 0 -11px;
  }

  &.x.end {
    margin-left: -2px;
  }

  &.x.start::after,
  &.x.end::after {
    left: 9.5px;
    top: 1px;
    width: 3px;
    height: 12px;
    border: 0;
    border-radius: 1.5px;
    background: var(--grip-color, ${SCREEN_COLOR});
    transition:
      background 150ms,
      box-shadow 150ms;
  }

  &.x.end::after {
    left: 0.5px;
  }

  &:hover::after,
  &.active::after,
  &:focus-visible::after {
    background: ${SCREEN_COLOR};
  }

  &.x.start:hover::after,
  &.x.end:hover::after,
  &.x.start.active::after,
  &.x.end.active::after,
  &.x.start:focus-visible::after,
  &.x.end:focus-visible::after {
    background: ${theme.colors.white};
    box-shadow: 0 0 6px 1px var(--grip-color, ${SCREEN_COLOR});
  }

  &.disabled {
    cursor: default;
    pointer-events: none;
  }
`;

export interface ScreenGripProps<Param extends string = string> {
  param: Param;
  def: FxParamDef;
  value: number;
  // where it is, css px of the screen
  x: number;
  y: number;
  // the axis it is dragged along
  axis: 'x' | 'y';
  // more of its shape: an end of a bar
  shape?: 'start' | 'end';
  // the color of the handle of an end of a bar (absent: the one of the screens)
  color?: string;
  // the value at a place along its axis, css px of the screen
  valueAt: (px: number) => number;
  setParam: (key: string, value: number) => void;
  // a pointer holds it, or let it go (null)
  onHold: (held: Param | null) => void;
  disabled: boolean;
  // where a value it is set to stops within its range
  limit?: (param: Param, value: number) => number;
  // one more hold of a param another grip gives the keys and the name of: for a pointer only
  twin?: boolean;
}

// a param set on the screen: dragged along its axis it follows the pointer, the arrows move it, a double click
// sets its default
const Grip = (props: ScreenGripProps) => {
  const { param, def, value, x, y, axis, shape, color, valueAt, setParam, onHold, disabled, limit, twin } =
    props;
  const { name, label, min, max, formatValue } = def;
  const [active, setActive] = React.useState(false);
  const [trackPointer] = React.useState(singlePointerTracker);
  const last = React.useRef(value);
  const text = formatValue?.(value);

  const emit = (next: number) => {
    const within = withinDef(def, next);
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
    const scale = pointerScale(e.currentTarget);
    const along = (pointer: { clientX: number; clientY: number }) =>
      axis === 'x' ? pointer.clientX : pointer.clientY;
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
    emitFromNow(keyStep(def, value, direction));
  };

  const place = { left: x, top: y, ...(color && { '--grip-color': color }) } as React.CSSProperties;
  const slider = {
    role: 'slider',
    tabIndex: disabled ? -1 : 0,
    'aria-label': name ?? label,
    'aria-orientation': axis === 'x' ? 'horizontal' : 'vertical',
    'aria-valuemin': min,
    'aria-valuemax': max,
    'aria-valuenow': value,
    'aria-valuetext': typeof text === 'string' ? text : undefined,
    'aria-disabled': disabled || undefined,
    ...(!disabled && { onKeyDown }),
  } as const;
  return (
    <GripRoot
      className={cls(axis, shape, { active, disabled })}
      style={place}
      {...(twin ? { 'aria-hidden': true } : slider)}
      {...(!disabled && { onPointerDown, onDoubleClick: () => emitFromNow(def.default) })}
    />
  );
};
// (memo keeps the param of its props)
export const ScreenGrip = React.memo(Grip) as <Param extends string>(
  props: ScreenGripProps<Param>
) => React.ReactElement;

// what stands still on a screen of a frequency (the EQ, the FX Filter): a line at each frequency and dB of the grid,
// 0 dB brighter, the labels of the decades
export const FreqGrid = React.memo(
  ({ size, dbLines, dbY }: { size: Size; dbLines: number[]; dbY: (db: number, size: Size) => number }) => (
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
      {dbLines.map((db) => (
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
  )
);

// of 100 % a step of the wheel moves the resonance by (a notch: 100)
const WHEEL_STEP = 0.05;

const PointRoot = styled.div`
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
    border: 1.5px solid var(--grip-color, ${SCREEN_COLOR});
    border-radius: 50%;
    background: ${theme.colors.primaryDark};
    transition: background 150ms;
  }

  &:hover::after,
  &.active::after,
  &:focus-visible::after {
    background: var(--grip-color, ${SCREEN_COLOR});
  }

  // (one that moves across alone)
  &.across {
    cursor: ew-resize;
  }

  &.disabled {
    cursor: default;
    pointer-events: none;
  }
`;

// a param a point moves: its key, its range, its value, and along an axis the value at a place (css px of the screen)
export interface PointParam {
  key: string;
  def: FxParamDef;
  value: number;
  at: (px: number) => number;
}

interface PointGripProps {
  // where it is, css px of the screen
  x: number;
  y: number;
  // the params it moves: dragged across, up and down (a double click sets its default), by the wheel (without the
  // last two it moves across alone: a filter of no resonance)
  across: PointParam;
  upDown?: PointParam;
  wheel?: Omit<PointParam, 'at'>;
  // its ring (absent: the one of the screens)
  color?: string;
  label: string;
  valueText: string;
  setParam: (key: string, value: number) => void;
  // a pointer holds it, or lets it go
  onHold: (held: boolean) => void;
  disabled: boolean;
}

// a point of two params set on a screen (a band of the EQ, the FX Filter): dragged, one across and one up and down;
// the arrows move them, a double click sets the one up and down to its default; the wheel over it a third one (the
// resonance). Without the one up and down and the wheel it moves across alone
export const PointGrip = (props: PointGripProps) => {
  const { x, y, across, upDown, wheel, color, label, valueText, setParam, onHold, disabled } = props;
  const ref = React.useRef<HTMLDivElement>(null);
  const [active, setActive] = React.useState(false);
  const [trackPointer] = React.useState(singlePointerTracker);
  const params = [across, upDown, wheel].filter((param) => param !== undefined);
  const defs = Object.fromEntries(params.map(({ key, def }) => [key, def]));
  // the values set last (a move sets only what changed)
  const last = React.useRef<Record<string, number>>({});
  const emit = (key: string, value: number) => {
    const next = withinDef(defs[key], value);
    if (next === last.current[key]) return;
    last.current[key] = next;
    setParam(key, next);
  };
  const now = () => {
    last.current = Object.fromEntries(params.map(({ key, value }) => [key, value]));
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    now();
    const scale = pointerScale(e.currentTarget);
    const [fromX, fromY] = [e.clientX, e.clientY];
    // an axis the pointer hasn't moved along yet keeps its value (a drag up and down sets no frequency: one off the
    // screen, or between the steps of its precision, stays where the knob has it)
    const moved = { across: false, upDown: false };
    const tracked = trackPointer(
      e,
      (move) => {
        const [dx, dy] = [(move.clientX - fromX) / scale, (move.clientY - fromY) / scale];
        moved.across ||= dx !== 0;
        moved.upDown ||= dy !== 0;
        if (moved.across) emit(across.key, across.at(x + dx));
        if (upDown && moved.upDown) emit(upDown.key, upDown.at(y + dy));
      },
      () => {
        setActive(false);
        onHold(false);
      }
    );
    if (!tracked) return;
    setActive(true);
    onHold(true);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const sideways = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    const along = { ArrowUp: 1, ArrowDown: -1 }[e.key];
    const param = sideways ? across : along ? upDown : undefined;
    if (!param) return;
    e.preventDefault();
    now();
    emit(param.key, keyStep(param.def, param.value, sideways ?? along ?? 0));
  };

  // the wheel (not passive: the page doesn't scroll under it). The value it moved to before the rounding goes on from
  // one event to the next (a slow scroll of a trackpad moves it by less than a step of the knob an event: rounded each
  // time it went up alone), forgotten once the knob is set to another value than it set
  const wheeled = React.useRef<{ value: number; set: number | undefined } | null>(null);
  React.useEffect(() => {
    if (wheeled.current?.set !== wheel?.value) wheeled.current = null;
  }, [wheel?.value]);
  const current = React.useRef({ wheel, emit, now });
  current.current = { wheel, emit, now };
  const wheels = wheel !== undefined;
  React.useEffect(() => {
    const node = ref.current;
    if (!node || disabled || !wheels) return undefined;
    const onWheel = (e: WheelEvent) => {
      const { wheel, emit, now } = current.current;
      if (!wheel) return;
      e.preventDefault();
      // (going on, what it set last is the knob, whether it has come back yet or not)
      if (!wheeled.current) now();
      const { min, max } = wheel.def;
      const value = number.thresholds(
        (wheeled.current?.value ?? wheel.value) - e.deltaY * WHEEL_STEP,
        min,
        max
      );
      emit(wheel.key, value);
      wheeled.current = { value, set: last.current[wheel.key] };
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [disabled, wheels]);

  return (
    <PointRoot
      ref={ref}
      className={cls({ active, disabled, across: !upDown })}
      style={{ left: x, top: y, ...(color && { '--grip-color': color }) } as React.CSSProperties}
      role='slider'
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-orientation='horizontal'
      aria-valuemin={across.def.min}
      aria-valuemax={across.def.max}
      aria-valuenow={across.value}
      aria-valuetext={valueText}
      aria-disabled={disabled || undefined}
      title={across.def.name}
      {...(!disabled && {
        onPointerDown,
        onKeyDown,
        ...(upDown && {
          onDoubleClick: () => {
            now();
            emit(upDown.key, upDown.def.default);
          },
        }),
      })}
    />
  );
};
