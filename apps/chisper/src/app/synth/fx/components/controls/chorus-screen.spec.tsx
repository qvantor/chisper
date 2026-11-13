import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { FX_PARAMS } from '@chisper/preset-schema';
import { mapValues } from 'lodash';
import { theme } from '@chisper/ui-kit';
import { cssColor, drawn, withElementSize } from '@chisper/ui-kit/test-utils';
import { ChorusMeterValues, chorusTaps, depthMs } from '../../effects/chorus-params';
import { createMeterStub } from '../../../../../test-utils/fx-meter-stub';
import { CHANNEL_COLORS, ChorusScreen, CHORUS_SCREEN_SIZE as SIZE } from './chorus-screen';
import { cutoffGlow, laneY, msX, tapBars, xMs } from './chorus-screen-geometry';

// (no feedback: the taps alone on the canvas)
const params: Record<string, number> = { ...mapValues(FX_PARAMS.chorus, (param) => param.default), fb: 0 };
// the knobs of its taps
const { d1, d2, depth } = params;
const KNOBS = { d1, d2, depth };
const VALUES: ChorusMeterValues = { phase: 0.1, rate: 1, d1: 5, d2: 0, depth: 26, cut: 1000, idle: false };

const createMeter = () => createMeterStub<ChorusMeterValues>();
// the taps (ms) as points on their lanes
const tapPoints = (taps: readonly number[], size: readonly [number, number]) =>
  taps.map((ms, tap) => [msX(ms, size), laneY(tap, size)]);

type Props = React.ComponentProps<typeof ChorusScreen>;
const setup = (props: Partial<Props> = {}) => {
  const setParam = jest.fn();
  const all = (more: Partial<Props>) => ({ params, setParam, active: true, ...props, ...more });
  const result = render(<ChorusScreen {...all({})} />);
  const rerender = (more: Partial<Props>) => result.rerender(<ChorusScreen {...all(more)} />);
  return { ...result, rerender, setParam };
};

const root = () => screen.getByTestId('chorus-screen');
const canvasOf = () => screen.getByTestId('chorus-taps') as HTMLCanvasElement;
const glowOf = () => screen.getByTestId('chorus-glow') as HTMLCanvasElement;
// the circles of the glow drawn since, with their colors
const glows = () => {
  const context = glowOf().getContext('2d') as CanvasRenderingContext2D;
  const stops: [number, string][] = [];
  const made = jest
    .spyOn(context, 'createRadialGradient')
    .mockImplementation(
      () => ({ addColorStop: (at: number, color: string) => stops.push([at, color]) }) as CanvasGradient
    );
  return { made, stops };
};
const circles = ({ x, y, inner, outer }: ReturnType<typeof cutoffGlow>) => [x, y, inner, x, y, outer];
// the taps on the canvas (not their tails, which are lines), and the tails
const dots = () =>
  drawn(canvasOf())
    .filter(({ op }) => op === 'fill')
    .map(({ arcs: [arc] }) => [arc.x, arc.y]);
const tails = () => drawn(canvasOf()).filter(({ op }) => op === 'stroke');
// the bar of a tap: where it starts, where it ends, its middle down the screen
const bar = (tap: number) => {
  const rect = screen.getByTestId(`chorus-bar-${tap}`);
  const [x, y, width, height] = ['x', 'y', 'width', 'height'].map((name) => Number(rect.getAttribute(name)));
  return { from: x, to: x + width, y: y + height / 2 };
};
const grips = () =>
  within(root())
    .queryAllByRole('slider')
    .map((grip) => grip.getAttribute('aria-label'));
const grip = (name: string) => within(root()).getByRole('slider', { name });
// the holds of the right channel, for a pointer only: the starts of its bars, then their ends
const twins = (shape: 'start' | 'end') =>
  Array.from(root().querySelectorAll<HTMLElement>(`[aria-hidden].${shape}`));
// jsdom has no PointerEvent: a mouse event with a pointerId
const pointer = (type: string, target: EventTarget, at: { clientX?: number; clientY?: number } = {}) => {
  const event = new MouseEvent(type, { bubbles: true, button: 0, buttons: 1, ...at });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  act(() => {
    target.dispatchEvent(event);
  });
};
// a frame of the screen (the timers are fake: its clock moves with them)
const frame = (ms = 16) =>
  act(() => {
    jest.advanceTimersByTime(ms);
  });
// px of a ms across the plot
const PX = (msX(10, SIZE) - msX(0, SIZE)) / 10;

describe('ChorusScreen', () => {
  let restoreSize: () => void;
  beforeAll(() => {
    restoreSize = withElementSize(...SIZE);
  });
  afterAll(() => restoreSize());
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('is no wider than the display of the compressor', () => {
    setup();
    expect(SIZE).toEqual([240, 80]);
    expect(root()).toHaveStyle({ 'max-width': '348px', height: '80px' });
  });

  it('a bar in the lane of each tap: from its delay, as long as the depth', () => {
    const { rerender } = setup({ params: { ...params, d1: 12, d2: 3, depth: 13 } });
    const shown = () =>
      [0, 1, 2, 3].map(bar).map(({ from, to, y }) => [from, to, y].map((px) => Math.round(px * 1e6) / 1e6));
    const expected = (values: { d1: number; d2: number; depth: number }) =>
      tapBars(values, SIZE).map(({ from, to, y }) => [from, to, y].map((px) => Math.round(px * 1e6) / 1e6));
    expect(shown()).toEqual(expected({ d1: 12, d2: 3, depth: 13 }));
    expect(bar(0).from).toBeCloseTo(msX(3, SIZE), 6);
    expect(bar(0).to).toBeCloseTo(msX(3 + depthMs(13), SIZE), 6);
    expect(bar(0).y).toBeCloseTo(laneY(0, SIZE), 6);
    // each channel in its color: the bars of the left one are not filled as those of the right one
    const fills = [0, 1, 2, 3].map((tap) => screen.getByTestId(`chorus-bar-${tap}`).getAttribute('fill'));
    expect(fills[0]).toBe(fills[1]);
    expect(fills[2]).toBe(fills[3]);
    expect(fills[0]).not.toBe(fills[2]);
    rerender({ params: { ...params, d1: 20, d2: 0, depth: 0 } });
    expect(shown()).toEqual(expected({ d1: 20, d2: 0, depth: 0 }));
    // the ms along its bottom, the channels at its left
    ['0', '20', '40', '60', '80ms', 'L', 'R'].forEach((text) =>
      expect(within(root()).getByText(text)).toBeInTheDocument()
    );
  });

  it('watches the meter while shown and on, leaves it when bypassed or unmounted, not as a param changes', () => {
    const { meter, stop } = createMeter();
    const { rerender, unmount } = setup({ meter });
    expect(meter.watch).toHaveBeenCalledTimes(1);
    rerender({ params: { ...params, d1: 9, fb: 0.5 } });
    expect(meter.watch).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    rerender({ active: false });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('chorus-screen-deactivated')).toBeInTheDocument();
    rerender({ active: true });
    expect(meter.watch).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('chorus-screen-deactivated')).toBeNull();
    unmount();
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it('bypassed from the start it watches nothing, without a meter it draws no taps', () => {
    const { meter } = createMeter();
    setup({ meter, active: false });
    expect(meter.watch).not.toHaveBeenCalled();
    expect(drawn(canvasOf())).toHaveLength(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('a chorus at rest: its taps drawn once where its LFO was by the knobs, fainter, no frames and no render', () => {
    const { meter, send } = createMeter();
    const { container } = setup({ meter });
    const before = container.innerHTML;
    expect(drawn(canvasOf())).toHaveLength(0);
    const rest = { ...VALUES, d1: 9, d2: 3, depth: 13, idle: true };
    send(rest);
    // (the knobs, not what the meter told of them: it tells nothing more until a sound)
    expect(chorusTaps(0.1, KNOBS)).not.toEqual(chorusTaps(0.1, rest));
    expect(dots()).toEqual(tapPoints(chorusTaps(0.1, KNOBS), SIZE));
    drawn(canvasOf()).forEach((dot) => {
      expect(dot.alpha).toBe(0.35);
      expect(cssColor(dot.style)).toBe(cssColor(theme.colors.white));
    });
    expect(jest.getTimerCount()).toBe(0);
    frame(500);
    expect(dots()).toEqual(tapPoints(chorusTaps(0.1, KNOBS), SIZE));
    expect(tails()).toHaveLength(0);
    expect(container.innerHTML).toBe(before);
  });

  it('at rest its taps follow the knobs dragged: each stays in its bar, no frames', () => {
    const { meter, send } = createMeter();
    const { rerender } = setup({ meter });
    send({ ...VALUES, idle: true });
    const moved = { ...params, d1: 18, d2: 9, depth: 6 };
    rerender({ params: moved });
    expect(dots()).toEqual(tapPoints(chorusTaps(0.1, moved), SIZE));
    dots().forEach(([x], tap) => {
      expect(x).toBeGreaterThanOrEqual(bar(tap).from);
      expect(x).toBeLessThanOrEqual(bar(tap).to);
    });
    drawn(canvasOf()).forEach((dot) => expect(dot.alpha).toBe(0.35));
    expect(jest.getTimerCount()).toBe(0);
    // while it sounds they are where the core has them, whatever the knobs
    send(VALUES);
    frame();
    rerender({ params: { ...moved, d2: 20 } });
    frame();
    expect(xMs(dots()[0][0], SIZE)).toBeLessThan(depthMs(26));
  });

  it('a meter that tells nothing more: the frames stop, the taps rest where the LFO came to, then wake', () => {
    const { meter, send } = createMeter();
    setup({ meter });
    const { made } = glows();
    const told = performance.now();
    send({ ...VALUES, cut: 250 });
    // (under the wait: they go on)
    for (let i = 0; i < 25; i++) frame();
    expect(jest.getTimerCount()).toBe(1);
    drawn(canvasOf()).forEach((dot) => expect(dot.alpha).toBe(1));
    for (let i = 0; i < 10; i++) frame();
    expect(jest.getTimerCount()).toBe(0);
    const stale = (performance.now() - told) / 1000;
    const rested = dots();
    expect(rested).toHaveLength(4);
    // where its LFO was when the wait ran out (a frame after 500 ms), by the knobs
    chorusTaps(0.1 + 0.51, KNOBS).forEach((ms, tap) => {
      expect(Math.abs(xMs(rested[tap][0], SIZE) - ms)).toBeLessThan(3);
    });
    expect(stale).toBeGreaterThan(0.5);
    drawn(canvasOf()).forEach((dot) => expect(dot.alpha).toBe(0.35));
    expect(tails()).toHaveLength(0);
    // the glow of the knob again
    expect(made).toHaveBeenLastCalledWith(...circles(cutoffGlow(params['cut'], false, SIZE)));
    frame(1000);
    expect(dots()).toEqual(rested);
    // the meter tells again: placed where its LFO is, not swept there
    send({ ...VALUES, phase: 0.5, rate: 0 });
    expect(jest.getTimerCount()).toBe(1);
    frame();
    expect(dots()).toEqual(tapPoints(chorusTaps(0.5, VALUES), SIZE));
    drawn(canvasOf()).forEach((dot) => expect(dot.alpha).toBe(1));
  });

  it('a chorus that sounds: every frame its taps where its LFO went on to at its rate, through their pole', () => {
    const { meter, send } = createMeter();
    const { container } = setup({ meter });
    const before = container.innerHTML;
    const told = performance.now();
    send(VALUES);
    // the first frame places them
    frame();
    const elapsed = () => (performance.now() - told) / 1000;
    const first = dots();
    expect(first).toHaveLength(4);
    tapPoints(chorusTaps(0.1 + elapsed(), VALUES), SIZE).forEach(([x, y], tap) => {
      expect(first[tap][0]).toBeCloseTo(x, 0);
      expect(first[tap][1]).toBe(y);
    });
    drawn(canvasOf()).forEach((dot) => expect(dot.alpha).toBe(1));
    // (placed: no tail yet)
    expect(tails()).toHaveLength(0);
    // then they follow: the first tap goes down its bar (125 ms a second), about its pole of 20 ms behind
    for (let i = 0; i < 12; i++) frame();
    const [target] = chorusTaps(0.1 + elapsed(), VALUES);
    const tap = xMs(dots()[0][0], SIZE);
    expect(tap).toBeLessThan(xMs(first[0][0], SIZE) - 15);
    expect(tap - target).toBeGreaterThan(1.5);
    expect(tap - target).toBeLessThan(4.5);
    // each leaves a tail from where it is back to where it was, the first tap to its right, never long
    expect(tails()).toHaveLength(4);
    const [[[headX, headY], [tailX, tailY]]] = tails().map(({ points }) => points);
    expect([headX, headY]).toEqual(dots()[0]);
    expect(tailY).toBe(headY);
    expect(tailX).toBeGreaterThan(headX + 5);
    expect(tailX).toBeLessThanOrEqual(headX + 28);
    expect(tails()[0].lineCap).toBe('round');
    // the next values take over: another rate, the taps go on from where they are
    send({ ...VALUES, phase: 0.5, rate: 0 });
    for (let i = 0; i < 20; i++) frame();
    tapPoints(chorusTaps(0.5, VALUES), SIZE).forEach(([x], i) => expect(dots()[i][0]).toBeCloseTo(x, 0));
    // (they stand: no tails)
    expect(tails()).toHaveLength(0);
    expect(container.innerHTML).toBe(before);
    // at rest: the frames stop
    send({ ...VALUES, phase: 0.5, idle: true });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('a chorus that wakes has its taps where its LFO is, not swept there', () => {
    const { meter, send } = createMeter();
    setup({ meter });
    send({ ...VALUES, phase: 0, idle: true });
    send({ ...VALUES, phase: 0.5, rate: 0 });
    frame();
    expect(dots()).toEqual(tapPoints(chorusTaps(0.5, VALUES), SIZE));
  });

  it('the feedback: the repeats of a tap after it, each fainter; drawn again as the knob moves', () => {
    const { meter, send } = createMeter();
    // no depth: the first taps have no delay (no repeat shows), the second 20 ms
    const knobs = { ...params, d1: 20, d2: 0, depth: 0 };
    const { rerender } = setup({ meter, params: { ...knobs, fb: 0.5 } });
    send({ ...VALUES, idle: true });
    const shapes = drawn(canvasOf());
    // L first, then L second with its repeats before it, R the same
    expect(shapes).toHaveLength(2 * (1 + 4));
    const [, ...second] = shapes.slice(0, 5);
    expect(second.map(({ arcs: [arc] }) => arc.x)).toEqual([40, 60, 80, 20].map((ms) => msX(ms, SIZE)));
    expect(second.map(({ alpha }) => alpha)).toEqual([0.5, 0.25, 0.125, 1].map((share) => 0.35 * share));
    // in the color of its channel: the left one, the right one
    expect(cssColor(second[0].style)).toBe(cssColor(theme.colors.accent));
    expect(cssColor(shapes[6].style)).toBe(cssColor(theme.colors.secondAccent));
    expect(cssColor(second[3].style)).toBe(cssColor(theme.colors.white));
    second.forEach(({ arcs: [arc] }) => expect(arc.y).toBe(laneY(1, SIZE)));
    rerender({ params: { ...knobs, fb: 0 } });
    expect(drawn(canvasOf())).toHaveLength(4);
    // left: nothing of it stays
    rerender({ params: { ...knobs, fb: 0 }, active: false });
    expect(drawn(canvasOf())).toHaveLength(0);
  });

  describe('the glow of the filter behind the taps', () => {
    it('a circle of light of the cutoff of the knob over the whole screen, drawn again as it or the type changes', () => {
      const { rerender, container } = setup();
      expect(drawn(glowOf()).map(({ rects: [rect] }) => rect)).toEqual([[0, 0, ...SIZE]]);
      // under everything else
      expect(root().querySelector('canvas')).toBe(glowOf());
      const { made, stops } = glows();
      const before = container.innerHTML;
      rerender({ params: { ...params, cut: 4000 } });
      const low = cutoffGlow(4000, false, SIZE);
      expect(made).toHaveBeenLastCalledWith(...circles(low));
      expect(stops).toEqual([
        [0, low.from],
        [1, low.to],
      ]);
      expect(drawn(glowOf())).toHaveLength(1);
      rerender({ params: { ...params, cut: 4000, hpf: 1 } });
      expect(made).toHaveBeenLastCalledWith(...circles(cutoffGlow(4000, true, SIZE)));
      // (a canvas: nothing of the page changed)
      expect(container.innerHTML).toBe(before);
      // another knob leaves it
      rerender({ params: { ...params, cut: 4000, hpf: 1, d1: 9 } });
      expect(made).toHaveBeenCalledTimes(2);
    });

    it('follows the cutoff of the core while it sounds (a route moves it), the knob again at rest', () => {
      const { meter, send } = createMeter();
      setup({ meter });
      const { made } = glows();
      send({ ...VALUES, cut: 250 });
      frame();
      expect(made).toHaveBeenCalledTimes(1);
      expect(made).toHaveBeenLastCalledWith(...circles(cutoffGlow(250, false, SIZE)));
      // the same cutoff: not drawn again, frame after frame
      send({ ...VALUES, cut: 250.2 });
      frame(100);
      expect(made).toHaveBeenCalledTimes(1);
      send({ ...VALUES, cut: 8000 });
      frame();
      expect(made).toHaveBeenLastCalledWith(...circles(cutoffGlow(8000, false, SIZE)));
      send({ ...VALUES, cut: 8000, idle: true });
      expect(made).toHaveBeenLastCalledWith(...circles(cutoffGlow(params['cut'], false, SIZE)));
      expect(made).toHaveBeenCalledTimes(3);
    });

    it('left (bypassed), it is of the knob', () => {
      const { meter, send } = createMeter();
      const { rerender } = setup({ meter });
      send({ ...VALUES, cut: 250 });
      frame();
      const { made } = glows();
      rerender({ active: false });
      expect(made).toHaveBeenLastCalledWith(...circles(cutoffGlow(params['cut'], false, SIZE)));
    });
  });

  describe('dragged', () => {
    it('the keys and the names on the bars of the left channel, the bars of the right one held as well', () => {
      setup();
      expect(grips()).toEqual(['Delay of the first taps', 'LFO depth', 'Delay of the second taps']);
      expect(grip('Delay of the second taps')).toHaveAttribute('aria-valuenow', '5');
      expect(grip('Delay of the second taps')).toHaveAttribute('aria-valuetext', '5.0ms');
      expect(grip('LFO depth')).toHaveAttribute('aria-valuetext', '63ms');
      expect(twins('start')).toHaveLength(2);
      expect(twins('end')).toHaveLength(3);
      // the handles of a channel in its color
      const colors = [...root().querySelectorAll<HTMLElement>('.start')].map((handle) =>
        handle.style.getPropertyValue('--grip-color')
      );
      expect(colors).toEqual([CHANNEL_COLORS[0], CHANNEL_COLORS[0], CHANNEL_COLORS[1], CHANNEL_COLORS[1]]);
    });

    it('the start of a bar is the delay of its tap: it follows the pointer in ms, within its range', () => {
      const { setParam } = setup();
      pointer('pointerdown', grip('Delay of the second taps'), { clientX: 100 });
      pointer('pointermove', document, { clientX: 100 + 10 * PX });
      expect(setParam).toHaveBeenLastCalledWith('d1', 15);
      pointer('pointermove', document, { clientX: 2000 });
      expect(setParam).toHaveBeenLastCalledWith('d1', 20);
      pointer('pointermove', document, { clientX: -2000 });
      expect(setParam).toHaveBeenLastCalledWith('d1', 0);
      pointer('pointerup', document);
      // the bar of the same tap of the right channel
      pointer('pointerdown', twins('start')[0], { clientX: 50 });
      pointer('pointermove', document, { clientX: 50 + 4 * PX });
      expect(setParam).toHaveBeenLastCalledWith('d2', 4);
      pointer('pointerup', document);
    });

    it('the end of a bar is the depth: where it is dragged to from the delay of its tap', () => {
      const { setParam } = setup({ params: { ...params, d1: 10, depth: 13 } });
      // 31.25 ms of travel: 12.5 ms less is 18.75 of them
      pointer('pointerdown', grip('LFO depth'), { clientX: 100 });
      pointer('pointermove', document, { clientX: 100 - 12.5 * PX });
      expect(setParam).toHaveBeenLastCalledWith('depth', 7.8);
      pointer('pointermove', document, { clientX: -2000 });
      expect(setParam).toHaveBeenLastCalledWith('depth', 0);
      pointer('pointerup', document);
      // the end of the bar of a second tap (from Delay 1): to the right end of the plot is 72.5 ms of travel
      pointer('pointerdown', twins('end')[0], { clientX: 100 });
      pointer('pointermove', document, { clientX: 2000 });
      expect(setParam).toHaveBeenLastCalledWith('depth', 26);
      pointer('pointerup', document);
    });

    it('a hold shows the full name of what it changes before the value', () => {
      const { rerender } = setup();
      const tooltip = () => document.getElementById('tooltip')?.textContent ?? '';
      pointer('pointerdown', grip('Delay of the first taps'), { clientX: 0 });
      expect(tooltip()).toBe('Delay of the first taps0.0ms');
      rerender({ params: { ...params, d2: 12 } });
      expect(tooltip()).toBe('Delay of the first taps12ms');
      pointer('pointerup', document);
      expect(tooltip()).toBe('');
    });

    it('the arrows move it by a step of its travel, a double click sets its default', () => {
      const { setParam } = setup({ params: { ...params, d1: 10, depth: 13 } });
      fireEvent.keyDown(grip('Delay of the second taps'), { key: 'ArrowRight' });
      expect(setParam).toHaveBeenLastCalledWith('d1', 10.4);
      fireEvent.keyDown(grip('LFO depth'), { key: 'ArrowLeft' });
      expect(setParam).toHaveBeenLastCalledWith('depth', 12.48);
      setParam.mockClear();
      fireEvent.keyDown(grip('LFO depth'), { key: 'a' });
      expect(setParam).not.toHaveBeenCalled();
      fireEvent.doubleClick(grip('Delay of the second taps'));
      expect(setParam).toHaveBeenLastCalledWith('d1', FX_PARAMS.chorus.d1.default);
      fireEvent.doubleClick(twins('end')[2]);
      expect(setParam).toHaveBeenLastCalledWith('depth', FX_PARAMS.chorus.depth.default);
    });

    it('bypassed nothing of it is dragged', () => {
      const { setParam } = setup({ active: false });
      const depth = grip('LFO depth');
      expect(depth).toHaveAttribute('aria-disabled', 'true');
      expect(depth).toHaveAttribute('tabindex', '-1');
      pointer('pointerdown', depth, { clientX: 100 });
      pointer('pointermove', document, { clientX: 0 });
      fireEvent.keyDown(depth, { key: 'ArrowLeft' });
      fireEvent.doubleClick(twins('start')[0]);
      expect(setParam).not.toHaveBeenCalled();
    });
  });
});
