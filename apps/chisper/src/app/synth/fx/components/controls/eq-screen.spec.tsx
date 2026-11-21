import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { FX_PARAMS } from '@chisper/preset-schema';
import { mapValues } from 'lodash';
import { EQ_PASS, EQ_PEAK } from '@chisper/math/eq';
import { drawn, withElementSize } from '@chisper/ui-kit/test-utils';
import { EQ_BANDS } from '../../effects/eq-params';
import { BAND_COLORS, EqScreen, EQ_SCREEN_SIZE as SIZE } from './eq-screen';
import { bandKnobs, bandPoint, dbY, freqX, POINTS, xFreq } from './eq-screen-geometry';

const params: Record<string, number> = mapValues(FX_PARAMS.eq, (param) => param.default);
const RATE = 48000;

type Props = React.ComponentProps<typeof EqScreen>;
const setup = (props: Partial<Props> = {}) => {
  const setParam = jest.fn();
  const all = (more: Partial<Props>) => ({
    params,
    setParam,
    sampleRate: RATE,
    modulations: {},
    active: true,
    ...props,
    ...more,
  });
  const result = render(<EqScreen {...all({})} />);
  const rerender = (more: Partial<Props>) => result.rerender(<EqScreen {...all(more)} />);
  return { ...result, rerender, setParam };
};

const root = () => screen.getByTestId('eq-screen');
const canvasOf = () => screen.getByTestId('eq-curves') as HTMLCanvasElement;
const grip = (band: number) => within(root()).getByRole('slider', { name: `Band ${band}` });
// jsdom has no PointerEvent: a mouse event with a pointerId
const pointer = (type: string, target: EventTarget, at: { clientX?: number; clientY?: number } = {}) => {
  const event = new MouseEvent(type, { bubbles: true, button: 0, buttons: 1, ...at });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  act(() => {
    target.dispatchEvent(event);
  });
};
// the curves (strokes of a point each) and the points of the bands (arcs)
const strokes = () =>
  drawn(canvasOf()).filter(({ op, points }) => op === 'stroke' && points.length === POINTS);
const dots = () =>
  drawn(canvasOf())
    .filter(({ arcs }) => arcs.length)
    .map(({ arcs: [arc] }) => [arc.x, arc.y]);

describe('EqScreen', () => {
  let restoreSize: () => void;
  beforeAll(() => {
    restoreSize = withElementSize(...SIZE);
  });
  afterAll(() => restoreSize());

  it('is as large as the screens of the chorus and the compressor', () => {
    setup();
    expect(SIZE).toEqual([240, 80]);
    expect(root()).toHaveStyle({ 'max-width': '348px', height: '80px' });
    ['100', '1k', '10k'].forEach((text) => expect(within(root()).getByText(text)).toBeInTheDocument());
  });

  it('draws the curve of each band and of both on a canvas, flat at 0 dB when fresh, a point a band', () => {
    setup();
    // each band, then both (filled to 0 dB, then its line)
    expect(strokes()).toHaveLength(3);
    strokes().forEach(({ points }) => points.forEach(([, y]) => expect(y).toBeCloseTo(dbY(0, SIZE), 6)));
    expect(dots()).toEqual(EQ_BANDS.map((keys) => bandPoint(bandKnobs(params, keys), SIZE)));
  });

  it('a band moved: its curve and the sum where the core has them, no render of the DOM', () => {
    const { rerender, container } = setup();
    const before = container.querySelector('svg')?.innerHTML;
    rerender({ params: { ...params, t1: EQ_PEAK, f1: 1000, q1: 50, g1: 12 } });
    const [band1, , sum] = strokes();
    // the peak at its frequency: 12 dB over 0 dB
    const at = band1.points.reduce((best, point) => (point[1] < best[1] ? point : best));
    expect(xFreq(at[0], SIZE)).toBeCloseTo(1000, -2);
    expect(at[1]).toBeCloseTo(dbY(12, SIZE), 0);
    expect(sum.points).toEqual(band1.points);
    expect(container.querySelector('svg')?.innerHTML).toBe(before);
    // (each band in its color)
    expect(BAND_COLORS).toHaveLength(2);
  });

  it('a point dragged sets the frequency across and the gain up and down, of a pass its resonance', () => {
    const { setParam, rerender } = setup({ params: { ...params, t1: EQ_PEAK, f1: 1000, g1: 0 } });
    const [x, y] = [freqX(1000, SIZE), dbY(0, SIZE)];
    pointer('pointerdown', grip(1), { clientX: 100, clientY: 100 });
    pointer('pointermove', document, {
      clientX: 100 + (freqX(2000, SIZE) - x),
      clientY: 100 + (dbY(6, SIZE) - y),
    });
    pointer('pointerup', document);
    expect(setParam).toHaveBeenCalledWith('f1', 2000);
    expect(setParam).toHaveBeenCalledWith('g1', 6);
    setParam.mockClear();
    rerender({ params: { ...params, t2: EQ_PASS, f2: 5000, q2: 50 } });
    const [, from] = bandPoint({ type: EQ_PASS, freq: 5000, reso: 50, gain: 0 }, SIZE);
    pointer('pointerdown', grip(2), { clientX: 100, clientY: 100 });
    pointer('pointermove', document, { clientX: 100, clientY: 100 - (from - dbY(20, SIZE)) });
    pointer('pointerup', document);
    // (+20 dB at its frequency: a Q of 10, 85.1 %)
    expect(setParam).toHaveBeenCalledWith('q2', 85.1);
    expect(setParam).not.toHaveBeenCalledWith('g2', expect.anything());
  });

  it('the wheel over a point its resonance, the keys move it, a double click its gain to 0 dB', () => {
    const { setParam } = setup({ params: { ...params, t1: EQ_PEAK, g1: 9, q1: 50 } });
    act(() => {
      grip(1).dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
    });
    expect(setParam).toHaveBeenLastCalledWith('q1', 55);
    fireEvent.keyDown(grip(1), { key: 'ArrowUp' });
    expect(setParam).toHaveBeenLastCalledWith('g1', expect.closeTo(9.96, 1));
    fireEvent.keyDown(grip(1), { key: 'ArrowRight' });
    expect(setParam.mock.lastCall?.[0]).toBe('f1');
    expect(setParam.mock.lastCall?.[1]).toBeGreaterThan(params['f1']);
    fireEvent.doubleClick(grip(1));
    expect(setParam).toHaveBeenLastCalledWith('g1', 0);
    expect(grip(1)).toHaveAttribute('aria-valuetext', '210Hz, +9.0dB');
  });

  it('the wheel scrolled slowly (a trackpad) moves the resonance both ways, from where the knob is set', () => {
    const { setParam, rerender } = setup({ params: { ...params, q1: 60 } });
    const wheel = (deltaY: number, times: number) => {
      for (let i = 0; i < times; i++)
        act(() => {
          grip(1).dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }));
        });
    };
    // (a pixel a step is 0.05 %: the knob has steps of 0.1 %, each rounded went up alone)
    wheel(1, 10);
    expect(setParam).toHaveBeenLastCalledWith('q1', 59.5);
    wheel(-1, 20);
    expect(setParam).toHaveBeenLastCalledWith('q1', 60.5);
    // its value set elsewhere: the wheel goes on from it
    rerender({ params: { ...params, q1: 30 } });
    wheel(1, 2);
    expect(setParam).toHaveBeenLastCalledWith('q1', 29.9);
    // and stops at the ends
    rerender({ params: { ...params, q1: 100 } });
    setParam.mockClear();
    wheel(-1, 4);
    expect(setParam).not.toHaveBeenCalled();
    wheel(1, 2);
    expect(setParam).toHaveBeenLastCalledWith('q1', 99.9);
  });

  describe('routes', () => {
    let level = 0;
    let now = 1000;
    const route = (id: string) => ({ id, color: 'red', amount: 0.5, level: () => level, live: true });
    // a frame of the screen, its clock with it
    const frame = () =>
      act(() => {
        now += 16;
        level = (level + 0.1) % 1;
        jest.advanceTimersByTime(16);
      });
    beforeEach(() => {
      jest.useFakeTimers();
      jest.spyOn(performance, 'now').mockImplementation(() => now);
    });
    afterEach(() => {
      jest.useRealTimers();
      jest.restoreAllMocks();
    });

    // the drawings of the curves in 5 frames (each clears the canvas first)
    const drawingsIn5Frames = () => {
      const context = canvasOf().getContext('2d');
      if (!context) throw new Error('no context');
      const clear = jest.spyOn(context, 'clearRect');
      clear.mockClear();
      for (let i = 0; i < 5; i++) frame();
      return clear.mock.calls.length;
    };

    it('a route on the gain of a peak draws it frame after frame, on the gain of a pass none', () => {
      const { rerender } = setup({
        params: { ...params, t1: EQ_PEAK, g1: 6 },
        modulations: { g1: [route('lfo1')] },
      });
      expect(drawingsIn5Frames()).toBe(5);
      // (its point where the route takes it)
      expect(strokes()).toHaveLength(3);
      rerender({ params: { ...params, t1: EQ_PASS, g1: 6 } });
      expect(drawingsIn5Frames()).toBe(0);
      expect(strokes()).toHaveLength(3);
      // its frequency still moves its point
      rerender({ params: { ...params, t1: EQ_PASS, g1: 6 }, modulations: { f1: [route('lfo1')] } });
      expect(drawingsIn5Frames()).toBe(5);
    });
  });

  it('bypassed: shown dimmed, its points take no drag', () => {
    const { setParam } = setup({ active: false });
    expect(screen.getByTestId('eq-screen-deactivated')).toBeInTheDocument();
    expect(grip(1)).toHaveAttribute('aria-disabled', 'true');
    pointer('pointerdown', grip(1), { clientX: 0, clientY: 0 });
    expect(setParam).not.toHaveBeenCalled();
  });
});
