import React from 'react';
import { Vector2D, vector2d, number } from '@chisper/math';
import { scaleLinear } from 'd3-scale';
import { theme } from '../../common/constants';
import { useLineChartContext, XAxis } from '../../line-chart';

interface Props {
  precisionY: number;
  customDomainX: [number, number];
  // a column set to a level: on a press and on every move to another column or level while pressed
  onDraw: (point: Vector2D) => void;
}

const same = (a: Vector2D | null, b: Vector2D | null) => a === b || (!!a && !!b && vector2d.isEqual(a, b));

// the column and the level under the pointer (a mouse, a finger or a pen; the level snapped to 1/precisionY within
// −1..1), the column under a mouse marked; a press draws, and keeps drawing as it moves, outside the chart too (the
// pointer captured), until it is let go
export const PointerInteractive = ({ precisionY, customDomainX, onDraw }: Props) => {
  // the padding by its numbers: the chart gives a new array every render, and a render follows every point drawn
  const {
    ref,
    scaleY,
    padding: [paddingX, paddingY],
    width,
  } = useLineChartContext();
  const [point, setPoint] = React.useState<Vector2D | null>(null);
  const customScaleX = React.useMemo(
    () => scaleLinear([0, width - paddingX * 2]).domain(customDomainX),
    [customDomainX, width, paddingX]
  );
  const tickWidth = customScaleX(1) - customScaleX(0);
  // the listeners call the latest one
  const draw = React.useRef(onDraw);
  draw.current = onDraw;

  React.useEffect(() => {
    const element = ref.current;
    if (!element) return;
    // the pointer that draws, the point it drew last
    let drawing: number | null = null;
    let drawn: Vector2D | null = null;
    const pointOf = (e: PointerEvent): Vector2D => {
      const { x: xOffset, y: yOffset } = element.getBoundingClientRect();
      const x = number.thresholds(
        Math.round(customScaleX.invert(e.clientX - tickWidth / 2 - xOffset - paddingX)),
        customDomainX[0],
        customDomainX[1] - 1
      );
      const y = Math.round(scaleY.invert(e.clientY - yOffset - paddingY) * precisionY) / precisionY;
      return vector2d.fromValues(x, number.thresholds(y, -1, 1));
    };
    const show = (next: Vector2D | null) => setPoint((previous) => (same(previous, next) ? previous : next));
    const drawAt = (next: Vector2D) => {
      if (same(drawn, next)) return;
      drawn = next;
      draw.current(next);
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || drawing !== null) return;
      drawing = e.pointerId;
      element.setPointerCapture?.(e.pointerId);
      const next = pointOf(e);
      show(next);
      drawAt(next);
    };
    const onMove = (e: PointerEvent) => {
      if (drawing !== null && e.pointerId !== drawing) return;
      const next = pointOf(e);
      if (drawing !== null || e.pointerType === 'mouse') show(next);
      if (drawing !== null) drawAt(next);
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== drawing) return;
      drawing = null;
      drawn = null;
      if (element.hasPointerCapture?.(e.pointerId)) element.releasePointerCapture(e.pointerId);
      // a finger or a pen leaves no pointer over the chart
      if (e.pointerType !== 'mouse') show(null);
    };
    const onLeave = () => {
      if (drawing === null) show(null);
    };
    element.addEventListener('pointerdown', onDown);
    element.addEventListener('pointermove', onMove);
    element.addEventListener('pointerup', onUp);
    element.addEventListener('pointercancel', onUp);
    element.addEventListener('pointerleave', onLeave);
    return () => {
      element.removeEventListener('pointerdown', onDown);
      element.removeEventListener('pointermove', onMove);
      element.removeEventListener('pointerup', onUp);
      element.removeEventListener('pointercancel', onUp);
      element.removeEventListener('pointerleave', onLeave);
    };
  }, [ref, scaleY, precisionY, paddingX, paddingY, customScaleX, customDomainX, tickWidth]);

  return (
    <g>
      <XAxis ticks={customDomainX[1]} customScaleX={customScaleX} />
      {point && (
        <rect
          width={tickWidth}
          height={1}
          fill={theme.colors.secondAccent}
          transform={`translate(${customScaleX(point[0])},${scaleY(point[1]) - 0.5})`}
        />
      )}
    </g>
  );
};
