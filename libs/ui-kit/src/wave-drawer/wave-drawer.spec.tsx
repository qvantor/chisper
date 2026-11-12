import React from 'react';
import { act, render } from '@testing-library/react';
import { sizedElements } from '../common/test-utils/element-size';
import { WaveDrawer } from './index';

// jsdom has no PointerEvent: a mouse event with the pointer's id and type
const pointer = (
  type: string,
  target: EventTarget,
  [clientX, clientY]: [number, number],
  { pointerType = 'touch', button = 0, pointerId = 1 } = {}
) => {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY, button });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  act(() => {
    target.dispatchEvent(event);
  });
};

// a chart of 200 × 100 at the corner of the page, its padding 5 × 2: 16 columns (rate 4) of 11.875 px from x = 5,
// the levels 1..−1 over 96 px from y = 2
const column = (index: number) => 5 + 11.875 * index + 5.9375;
const level = (value: number) => 2 + 48 * (1 - value);

let sized: ReturnType<typeof sizedElements>;
beforeEach(() => {
  sized = sizedElements(200, 100);
  jest
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockReturnValue({ x: 0, y: 0, left: 0, top: 0, width: 200, height: 100 } as DOMRect);
});
afterEach(() => {
  sized.restore();
  jest.restoreAllMocks();
});

const setup = (onChange?: jest.Mock) => {
  const { container } = render(<WaveDrawer wave={new Array(2048).fill(0)} onChange={onChange} rate={4} />);
  return container.firstChild as HTMLElement;
};

describe('WaveDrawer', () => {
  it('draws with a finger: the column under the press, then every other one it moves over, until let go', () => {
    const onChange = jest.fn();
    const chart = setup(onChange);

    pointer('pointerdown', chart, [column(3), level(0.5)]);
    pointer('pointermove', chart, [column(3), level(0.5)]);
    pointer('pointermove', chart, [column(4), level(-0.2)]);
    pointer('pointerup', chart, [column(4), level(-0.2)]);
    pointer('pointermove', chart, [column(6), level(0)]);

    expect(onChange.mock.calls).toEqual([[[3, 0.5]], [[4, -0.2]]]);
  });

  it('keeps drawing outside the chart, at its edges', () => {
    const onChange = jest.fn();
    const chart = setup(onChange);

    pointer('pointerdown', chart, [column(15), level(0.8)], { pointerType: 'pen' });
    pointer('pointermove', chart, [400, -50], { pointerType: 'pen' });
    pointer('pointermove', chart, [-40, 300], { pointerType: 'pen' });

    expect(onChange.mock.calls).toEqual([[[15, 0.8]], [[15, 1]], [[0, -1]]]);
  });

  it('draws with a mouse only while its button is down, the left one', () => {
    const onChange = jest.fn();
    const chart = setup(onChange);
    const mouse = { pointerType: 'mouse' };

    pointer('pointermove', chart, [column(2), level(0.3)], mouse);
    pointer('pointerdown', chart, [column(2), level(0.3)], { ...mouse, button: 2 });
    expect(onChange).not.toHaveBeenCalled();

    pointer('pointerdown', chart, [column(2), level(0.3)], mouse);
    pointer('pointercancel', chart, [column(2), level(0.3)], mouse);
    pointer('pointermove', chart, [column(5), level(0.3)], mouse);
    expect(onChange.mock.calls).toEqual([[[2, 0.3]]]);
  });

  it('ignores a second finger while one draws', () => {
    const onChange = jest.fn();
    const chart = setup(onChange);

    pointer('pointerdown', chart, [column(1), level(0)]);
    pointer('pointerdown', chart, [column(9), level(0.5)], { pointerId: 2 });
    pointer('pointermove', chart, [column(10), level(0.5)], { pointerId: 2 });

    expect(onChange.mock.calls).toEqual([[[1, 0]]]);
  });

  it('keeps the page from scrolling under a finger where it draws, not where it only shows', () => {
    expect(setup(jest.fn()).style.touchAction).toBe('none');
    expect(setup().style.touchAction).not.toBe('none');
  });
});
