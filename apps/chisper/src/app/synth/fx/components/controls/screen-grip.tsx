import React from 'react';
import { styled } from 'styled-components';
import cls from 'classnames';
import { number } from '@chisper/math';
import { singlePointerTracker, theme, valueScale } from '@chisper/ui-kit';
import type { FxParamDef } from '../../effects/types';

// the lines and the points of a screen, as on the other charts of the synth
export const SCREEN_COLOR = theme.colors.accent;
// the share of its travel a key moves a grip by
const KEY_STEP = 0.02;
const KEY_DIRECTIONS: Record<string, number> = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 };

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
