import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { FX_PARAMS } from '@chisper/preset-schema';
import { mapValues } from 'lodash';
import { theme } from '@chisper/ui-kit';
import { cssColor, drawn, svgPath, withElementSize } from '@chisper/ui-kit/test-utils';
import type { CompressorMeterValues } from '../../effects/compressor-params';
import { createMeterStub } from '../../../../../test-utils/fx-meter-stub';
import { CompressorControls } from './compressor-controls';
import { SCREEN_SIZE } from './compressor-screen';
import {
  bandBars,
  bandZones,
  freqY,
  gainX,
  METER_RANGE,
  singleMarks,
  transferCurve,
  yFreq,
} from './compressor-screen-geometry';

const params = mapValues(FX_PARAMS.compressor, (param) => param.default);
const [WIDTH, HEIGHT] = SCREEN_SIZE;

const createMeter = () => createMeterStub<CompressorMeterValues>();

const setup = (props: Partial<React.ComponentProps<typeof CompressorControls>> = {}) => {
  const setParam = jest.fn();
  const user = userEvent.setup();
  const result = render(
    <CompressorControls params={params} setParam={setParam} on sampleRate={48000} {...props} />
  );
  const rerender = (changes: Partial<typeof params>, more: typeof props = {}) =>
    result.rerender(
      <CompressorControls
        setParam={setParam}
        on
        sampleRate={48000}
        {...props}
        {...more}
        params={{ ...params, ...changes }}
      />
    );
  return { ...result, rerender, setParam, user };
};

// the labels of the knobs shown, and of those that take a change (a disabled one has the class on its root)
const knobs = () => Array.from(document.querySelectorAll('label'), (label) => label.textContent);
const enabled = () =>
  Array.from(document.querySelectorAll('label'))
    .filter((label) => !label.closest('.disabled'))
    .map((label) => label.textContent);
// what is dragged on the screen, by name
const onScreen = () => within(screen.getByTestId('compressor-screen'));
const grips = () =>
  onScreen()
    .queryAllByRole('slider')
    .map((grip) => grip.getAttribute('aria-label'));
const grip = (name: string) => onScreen().getByRole('slider', { name });
// the windows of the values of the bands at the sides of the screen: what each shows
const windows = () => [
  ...within(screen.getByRole('group', { name: 'Crossovers' })).getAllByText(/Hz$/),
  ...within(screen.getByRole('group', { name: 'Band gains' })).getAllByText(/dB$/),
];
const shown = () => windows().map((value) => value.parentElement?.textContent);
const canvasOf = () => screen.getByTestId('compressor-screen').querySelector('canvas') as HTMLCanvasElement;
const pathOf = (testId: string) => screen.getByTestId(testId).getAttribute('d');
// jsdom has no PointerEvent: a mouse event with a pointerId
const pointer = (type: string, target: EventTarget, at: { clientX?: number; clientY?: number } = {}) => {
  const event = new MouseEvent(type, { bubbles: true, button: 0, buttons: 1, ...at });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  act(() => {
    target.dispatchEvent(event);
  });
};

describe('CompressorControls', () => {
  let restoreSize: () => void;
  beforeAll(() => {
    restoreSize = withElementSize(WIDTH, HEIGHT);
  });
  afterAll(() => restoreSize());

  it('puts the mode first, then the screen, the dynamics, the level; the out group last', () => {
    const { rerender } = setup({ out: <div role='group' aria-label='Out' /> });
    const groups = () => screen.getAllByRole('group').map((group) => group.getAttribute('aria-label'));
    expect(groups()).toEqual(['Mode', 'Curve', 'Dynamics', 'Post', 'Out']);
    expect(
      within(screen.getByRole('group', { name: 'Curve' })).getByTestId('compressor-screen')
    ).toBeInTheDocument();
    const dynamics = screen.getByRole('group', { name: 'Dynamics' });
    ['Thresh', 'Ratio', 'Attack', 'Release', 'Gain'].forEach((label) =>
      expect(within(dynamics).getByText(label)).toBeInTheDocument()
    );
    expect(within(screen.getByRole('group', { name: 'Post' })).getByText('Level')).toBeInTheDocument();
    // three bands: the screen with the windows of the crossovers and of the gains at its sides
    rerender({ multi: 1 });
    expect(groups()).toEqual(['Mode', 'Bands', 'Crossovers', 'Band gains', 'Dynamics', 'Post', 'Out']);
    expect(
      within(screen.getByRole('group', { name: 'Bands' })).getByTestId('compressor-screen')
    ).toBeInTheDocument();
  });

  it('switches the mode: Single by default, the next one is Multiband (multi 1), then Single again', async () => {
    const { setParam, user, rerender } = setup();
    const mode = screen.getByRole('group', { name: 'Mode' });
    expect(within(mode).getByRole('button', { name: 'Single' })).toBeInTheDocument();
    await user.click(within(mode).getByRole('button', { name: 'Next' }));
    expect(setParam).toHaveBeenLastCalledWith('multi', 1);
    rerender({ multi: 1 });
    expect(within(mode).getByRole('button', { name: 'Multiband' })).toBeInTheDocument();
    await user.click(within(mode).getByRole('button', { name: 'Next' }));
    expect(setParam).toHaveBeenLastCalledWith('multi', 0);
  });

  it('one band: the attack and the curve, nothing of the bands; three: the upward ratio in its place, the bands', () => {
    const { rerender } = setup();
    expect(knobs()).toEqual(['Thresh', 'Ratio', 'Attack', 'Release', 'Gain', 'Level']);
    expect(enabled()).toEqual(knobs());
    expect(grips()).toEqual([]);
    expect(screen.getByTestId('compressor-curve')).toBeInTheDocument();
    rerender({ multi: 1 });
    expect(knobs()).toEqual(['Thresh', 'Ratio', 'Below', 'Release', 'Gain', 'Level']);
    expect(enabled()).toEqual(knobs());
    expect(grips()).toEqual([
      'Low crossover',
      'High crossover',
      'Low band gain',
      'Mid band gain',
      'High band gain',
    ]);
    expect(screen.queryByTestId('compressor-curve')).not.toBeInTheDocument();
  });

  it('the threshold knob held tells the threshold of one band, the thresholds of the three bands', () => {
    const { rerender } = setup();
    const tooltip = () => document.getElementById('tooltip')?.textContent ?? '';
    // jsdom has no PointerEvent: a mouse event with a pointerId
    const pointer = (type: string, target: EventTarget) => {
      const event = new MouseEvent(type, { bubbles: true, button: 0 });
      Object.defineProperty(event, 'pointerId', { value: 1 });
      act(() => {
        target.dispatchEvent(event);
      });
    };
    pointer('pointerdown', screen.getByText('Thresh'));
    expect(tooltip()).toBe('Threshold-16.7dB');
    pointer('pointerup', document);
    rerender({ multi: 1 });
    pointer('pointerdown', screen.getByText('Thresh'));
    expect(tooltip()).toBe('Threshold-32.4 / -28.8 / -34.1dB');
    pointer('pointerup', document);
    rerender({ multi: 1, thresh: 0 });
    pointer('pointerdown', screen.getByText('Thresh'));
    expect(tooltip()).toBe('Threshold+1.4 / +1.4 / +1.4dB');
    pointer('pointerup', document);
    rerender({ multi: 0, thresh: 0 });
    pointer('pointerdown', screen.getByText('Thresh'));
    expect(tooltip()).toBe('Threshold+1.4dB');
    pointer('pointerup', document);
  });

  it('bypassed: every knob, key and point is disabled, the screen is covered and the meter not watched', () => {
    const { meter } = createMeter();
    const { setParam } = setup({ on: false, meter, params: { ...params, multi: 1, low: 6 } });
    expect(enabled()).toEqual([]);
    ['Mode', 'Bands', 'Dynamics', 'Post'].forEach((name) =>
      expect(screen.getByRole('group', { name })).toHaveClass('disabled')
    );
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    onScreen()
      .getAllByRole('slider')
      .forEach((point) => {
        expect(point).toHaveAttribute('aria-disabled', 'true');
        expect(point).toHaveAttribute('tabindex', '-1');
      });
    const low = grip('Low band gain');
    pointer('pointerdown', low, { clientY: 0 });
    pointer('pointermove', document, { clientY: 10 });
    pointer('pointerup', document);
    fireEvent.keyDown(low, { key: 'ArrowUp' });
    fireEvent.doubleClick(low);
    expect(setParam).not.toHaveBeenCalled();
    expect(screen.getByTestId('compressor-screen-deactivated')).toBeInTheDocument();
    expect(meter.watch).not.toHaveBeenCalled();
  });

  describe('the windows of the bands', () => {
    const sliders = (group: string) =>
      within(screen.getByRole('group', { name: group }))
        .queryAllByRole('slider')
        .map((slider) => slider.getAttribute('aria-label'));
    const valueOf = (group: string, name: string) =>
      within(screen.getByRole('group', { name: group })).getByRole('slider', { name });
    afterEach(() => jest.useRealTimers());

    it('three bands: the crossovers left of the screen, the gains right of it, the high band at the top', () => {
      const { rerender } = setup({ params: { ...params, multi: 1, xhigh: 16000, low: -6 } });
      expect(shown()).toEqual(['High16.0kHz', 'Low131Hz', 'H0.0dB', 'M0.0dB', 'L-6.0dB']);
      expect(sliders('Crossovers')).toEqual(['High crossover', 'Low crossover']);
      expect(sliders('Band gains')).toEqual(['High band gain', 'Mid band gain', 'Low band gain']);
      const [crossovers, display, gains] = [
        screen.getByRole('group', { name: 'Crossovers' }),
        screen.getByTestId('compressor-screen'),
        screen.getByRole('group', { name: 'Band gains' }),
      ];
      expect(crossovers.compareDocumentPosition(display)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      expect(display.compareDocumentPosition(gains)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      expect(gains).not.toHaveClass('off');
      // bypassed: only shown
      rerender({ multi: 1 }, { on: false });
      expect(shown()).toHaveLength(5);
      expect(sliders('Crossovers')).toEqual([]);
      expect(sliders('Band gains')).toEqual([]);
      expect(screen.getByRole('group', { name: 'Band gains' })).toHaveClass('off');
    });

    it('one band has none: they would change nothing, the screen is all of the display', () => {
      const { rerender } = setup();
      expect(screen.queryByRole('group', { name: 'Crossovers' })).not.toBeInTheDocument();
      expect(screen.queryByRole('group', { name: 'Band gains' })).not.toBeInTheDocument();
      const display = screen.getByTestId('compressor-screen').parentElement as HTMLElement;
      expect(display.children).toHaveLength(1);
      rerender({ multi: 1 });
      expect(display.children).toHaveLength(3);
    });

    it('a value hovered a while tells what it changes in a tooltip', () => {
      jest.useFakeTimers();
      setup({ params: { ...params, multi: 1 } });
      const tips: [string, string, string][] = [
        ['Crossovers', 'Low crossover', 'Where the low band ends and the mid band starts'],
        ['Crossovers', 'High crossover', 'Where the mid band ends and the high band starts'],
        ['Band gains', 'Low band gain', 'The level of the low band after its compression'],
        ['Band gains', 'Mid band gain', 'The level of the mid band after its compression'],
        ['Band gains', 'High band gain', 'The level of the high band after its compression'],
      ];
      tips.forEach(([group, name, hint]) => {
        const slider = valueOf(group, name);
        fireEvent.mouseEnter(slider);
        act(() => {
          jest.advanceTimersByTime(1200);
        });
        const texts = screen.getAllByRole('tooltip').map((tip) => tip.textContent);
        expect(texts).toContain(`${name}${hint}`);
        fireEvent.mouseLeave(slider);
      });
    });

    it('a value dragged changes its param: a crossover over its log range, a gain in tenths of a dB', () => {
      const { setParam } = setup({ params: { ...params, multi: 1 } });
      const drag = (group: string, name: string, by: number) => {
        const slider = valueOf(group, name);
        pointer('pointerdown', slider, { clientX: 100, clientY: 100 });
        pointer('pointermove', document, { clientX: 100 + by, clientY: 100 });
        pointer('pointerup', document);
      };
      // a tenth of the travel: a tenth of the octaves of the range
      const { min, max } = FX_PARAMS.compressor.xlow;
      drag('Crossovers', 'Low crossover', 20);
      expect(setParam).toHaveBeenLastCalledWith('xlow', Math.round(params.xlow * (max / min) ** 0.1));
      drag('Band gains', 'High band gain', -50);
      expect(setParam).toHaveBeenLastCalledWith('high', -12);
    });
  });

  describe('its screen', () => {
    it('one band: the curve of the threshold and the ratio, a line at the threshold while it is on the plot', () => {
      const { rerender } = setup();
      expect(pathOf('compressor-curve')).toBe(
        svgPath({ points: transferCurve(params.thresh, params.ratio, SCREEN_SIZE) })
      );
      expect(screen.getByTestId('compressor-threshold')).toBeInTheDocument();
      rerender({ thresh: 0.8, ratio: 12 });
      expect(pathOf('compressor-curve')).toBe(svgPath({ points: transferCurve(0.8, 12, SCREEN_SIZE) }));
      // the knob at 0: the threshold is over full scale, nothing is compressed
      rerender({ thresh: 0 });
      expect(screen.queryByTestId('compressor-threshold')).not.toBeInTheDocument();
    });

    it('three bands: the points on the crossovers between the rows and on the lines of the gains across them', () => {
      const { rerender } = setup({ params: { ...params, multi: 1, low: 6, high: -12 } });
      const zones = bandZones(params.xlow, params.xhigh, SCREEN_SIZE);
      expect(grip('Low crossover')).toHaveStyle({ top: `${freqY(params.xlow, SCREEN_SIZE)}px` });
      expect(grip('High crossover')).toHaveStyle({ top: `${freqY(params.xhigh, SCREEN_SIZE)}px` });
      const gains = { low: 6, mid: 0, high: -12 };
      (['low', 'mid', 'high'] as const).forEach((key, band) => {
        const x = gainX(gains[key], SCREEN_SIZE);
        expect(grip(`${key[0].toUpperCase()}${key.slice(1)} band gain`)).toHaveStyle({
          left: `${x}px`,
          top: `${zones[band].center}px`,
        });
        expect(pathOf(`compressor-gain-${key}`)).toBe(
          svgPath({
            points: [
              [WIDTH / 2, zones[band].center],
              [x, zones[band].center],
            ],
          })
        );
      });
      expect(grip('Low crossover')).toHaveAttribute('aria-valuetext', '131Hz');
      expect(grip('Low crossover')).toHaveAttribute('aria-orientation', 'vertical');
      expect(grip('Low band gain')).toHaveAttribute('aria-valuenow', '6');
      expect(grip('Low band gain')).toHaveAttribute('aria-orientation', 'horizontal');
      // a high crossover under the low one is at the low one, as the core takes it
      rerender({ multi: 1, xlow: 3000, xhigh: 300 });
      expect(grip('High crossover')).toHaveStyle({ top: `${freqY(3000, SCREEN_SIZE)}px` });
    });

    it('a crossover dragged up and down follows the pointer in whole Hz, within its range', () => {
      const { setParam } = setup({ params: { ...params, multi: 1 } });
      const from = freqY(params.xlow, SCREEN_SIZE);
      pointer('pointerdown', grip('Low crossover'), { clientY: 300 });
      pointer('pointermove', document, { clientY: 281 });
      expect(setParam).toHaveBeenLastCalledWith('xlow', Math.round(yFreq(from - 19, SCREEN_SIZE)));
      // up to the high crossover, not over it
      pointer('pointermove', document, { clientY: -1000 });
      expect(setParam).toHaveBeenLastCalledWith('xlow', params.xhigh);
      pointer('pointermove', document, { clientY: 1000 });
      expect(setParam).toHaveBeenLastCalledWith('xlow', FX_PARAMS.compressor.xlow.min);
      pointer('pointerup', document);
      setParam.mockClear();
      pointer('pointermove', document, { clientY: 400 });
      expect(setParam).not.toHaveBeenCalled();
    });

    it('the crossovers never cross: the high one stops at the low one, on the screen and in its window', () => {
      const { setParam } = setup({ params: { ...params, multi: 1, xlow: 1000, xhigh: 1200 } });
      pointer('pointerdown', grip('High crossover'), { clientY: 0 });
      pointer('pointermove', document, { clientY: 1000 });
      expect(setParam).toHaveBeenLastCalledWith('xhigh', 1000);
      // (held there: the same value is not set again)
      pointer('pointermove', document, { clientY: 2000 });
      expect(setParam).toHaveBeenCalledTimes(1);
      pointer('pointerup', document);
      const high = within(screen.getByRole('group', { name: 'Crossovers' })).getByRole('slider', {
        name: 'High crossover',
      });
      pointer('pointerdown', high, { clientX: 500, clientY: 100 });
      pointer('pointermove', document, { clientX: -500, clientY: 100 });
      pointer('pointerup', document);
      expect(setParam).toHaveBeenLastCalledWith('xhigh', 1000);
      fireEvent.keyDown(high, { key: 'PageDown' });
      expect(setParam).toHaveBeenLastCalledWith('xhigh', 1000);
      // the low one up to the high one: by a key, by its default over it
      fireEvent.keyDown(grip('Low crossover'), { key: 'ArrowUp' });
      expect(setParam).toHaveBeenLastCalledWith('xlow', 1117);
      fireEvent.keyDown(grip('Low crossover'), { key: 'ArrowUp' });
      expect(setParam).toHaveBeenLastCalledWith('xlow', 1117);
    });

    it('a default over the other crossover stops at it', () => {
      const { setParam } = setup({ params: { ...params, multi: 1, xlow: 20, xhigh: 100 } });
      fireEvent.doubleClick(grip('Low crossover'));
      expect(setParam).toHaveBeenLastCalledWith('xlow', 100);
    });

    it('crossed crossovers of a preset: the high one is shown and dragged where the core takes it, at the low one', () => {
      const { setParam } = setup({ params: { ...params, multi: 1, xlow: 3000, xhigh: 300 } });
      expect(shown().slice(0, 2)).toEqual(['High3.0kHz', 'Low3.0kHz']);
      expect(grip('High crossover')).toHaveAttribute('aria-valuenow', '3000');
      expect(grip('High crossover')).toHaveAttribute('aria-valuetext', '3.0kHz');
      const from = freqY(3000, SCREEN_SIZE);
      pointer('pointerdown', grip('High crossover'), { clientY: 300 });
      pointer('pointermove', document, { clientY: 290 });
      expect(setParam).toHaveBeenLastCalledWith('xhigh', Math.round(yFreq(from - 10, SCREEN_SIZE)));
      pointer('pointerup', document);
      // the low one goes down from where it is, never up
      setParam.mockClear();
      fireEvent.keyDown(grip('Low crossover'), { key: 'ArrowUp' });
      expect(setParam).not.toHaveBeenCalled();
      fireEvent.keyDown(grip('Low crossover'), { key: 'ArrowDown' });
      expect(setParam).toHaveBeenLastCalledWith('xlow', expect.any(Number));
      expect(setParam.mock.calls.at(-1)?.[1]).toBeLessThan(3000);
    });

    it('the gain of a band dragged sideways follows the pointer in tenths of a dB, within its range', () => {
      const { setParam } = setup({ params: { ...params, multi: 1 } });
      pointer('pointerdown', grip('Mid band gain'), { clientX: 200 });
      pointer('pointermove', document, { clientX: 210 });
      // 10 px of the 70 px of 24 dB
      expect(setParam).toHaveBeenLastCalledWith('mid', 3.4);
      pointer('pointermove', document, { clientX: -500 });
      expect(setParam).toHaveBeenLastCalledWith('mid', -METER_RANGE);
      pointer('pointerup', document);
      expect(setParam).toHaveBeenCalledTimes(2);
    });

    it('a point held shows the full name of what it changes before the value', () => {
      const { rerender } = setup({ params: { ...params, multi: 1 } });
      const tooltip = () => document.getElementById('tooltip')?.textContent ?? '';
      pointer('pointerdown', grip('Low crossover'), { clientX: 0 });
      expect(tooltip()).toBe('Low crossover131Hz');
      rerender({ multi: 1, xlow: 1500 });
      expect(tooltip()).toBe('Low crossover1.5kHz');
      pointer('pointerup', document);
      expect(tooltip()).toBe('');
      pointer('pointerdown', grip('High band gain'), { clientY: 0 });
      expect(tooltip()).toBe('High band gain0.0dB');
      pointer('pointerup', document);
    });

    it('the arrows move a point by a step of its travel, a double click sets its default', () => {
      const { setParam } = setup({ params: { ...params, multi: 1, low: 6, xhigh: 1000 } });
      fireEvent.keyDown(grip('Low band gain'), { key: 'ArrowUp' });
      expect(setParam).toHaveBeenLastCalledWith('low', 7);
      fireEvent.keyDown(grip('Low band gain'), { key: 'ArrowDown' });
      expect(setParam).toHaveBeenLastCalledWith('low', 5);
      const { min, max } = FX_PARAMS.compressor.xhigh;
      const step = (max / min) ** 0.02;
      fireEvent.keyDown(grip('High crossover'), { key: 'ArrowRight' });
      expect(setParam).toHaveBeenLastCalledWith('xhigh', Math.round(1000 * step));
      fireEvent.keyDown(grip('High crossover'), { key: 'ArrowLeft' });
      expect(setParam).toHaveBeenLastCalledWith('xhigh', Math.round(1000 / step));
      setParam.mockClear();
      fireEvent.keyDown(grip('High crossover'), { key: 'a' });
      expect(setParam).not.toHaveBeenCalled();
      fireEvent.doubleClick(grip('Low band gain'));
      expect(setParam).toHaveBeenLastCalledWith('low', 0);
      fireEvent.doubleClick(grip('High crossover'));
      expect(setParam).toHaveBeenLastCalledWith('xhigh', FX_PARAMS.compressor.xhigh.default);
    });

    it('watches the meter while shown and on, leaves it when bypassed or unmounted, not as a param changes', () => {
      const { meter, stop } = createMeter();
      const { rerender, unmount } = setup({ meter });
      expect(meter.watch).toHaveBeenCalledTimes(1);
      rerender({ multi: 1, xlow: 500, thresh: 0.2 });
      expect(meter.watch).toHaveBeenCalledTimes(1);
      expect(stop).not.toHaveBeenCalled();
      rerender({}, { on: false });
      expect(stop).toHaveBeenCalledTimes(1);
      rerender({}, { on: true });
      expect(meter.watch).toHaveBeenCalledTimes(2);
      unmount();
      expect(stop).toHaveBeenCalledTimes(2);
    });

    it('draws on its canvas as values come, without a render: the dot and the reduction of one band', () => {
      const { meter, send } = createMeter();
      const { container } = setup({ meter });
      const before = container.innerHTML;
      // the bar of the reduction and its edge (empty) before any value, no dot
      expect(drawn(canvasOf())).toHaveLength(2);
      const values: CompressorMeterValues = { gains: [-12, -12, -12], input: 0.5 };
      send(values);
      const marks = singleMarks(values, SCREEN_SIZE);
      const [reduction, edge, dot] = drawn(canvasOf());
      expect(drawn(canvasOf())).toHaveLength(3);
      expect(reduction.rects[0]).toEqual([WIDTH / 2, 0, WIDTH / 2, marks.reduction.height]);
      // its bright edge at its tip, the left end
      expect(edge.rects[0]).toEqual([WIDTH / 2, 0, 1.5, marks.reduction.height]);
      expect(cssColor(edge.style)).toBe(cssColor(theme.colors.secondAccent));
      expect(dot.arcs[0]).toMatchObject({ x: marks.dot?.[0], y: marks.dot?.[1] });
      // the dot is over the curve, not behind it
      expect(canvasOf()).toHaveClass('front');
      expect(container.innerHTML).toBe(before);
    });

    it('three bands: a bar in each, down a reduction, up a boost; drawn again where a crossover moves them', () => {
      const { meter, send } = createMeter();
      const { rerender, container } = setup({ meter, params: { ...params, multi: 1 } });
      const values: CompressorMeterValues = { gains: [6, -6, 24], input: 1 };
      const before = container.innerHTML;
      send(values);
      expect(container.innerHTML).toBe(before);
      // of each bar its body, then its edge
      const shapes = (part: 0 | 1) => drawn(canvasOf()).filter((_, i) => i % 2 === part);
      const rects = () => shapes(0).map(({ rects: [rect] }) => rect);
      const expected = (xlow: number) =>
        bandBars(values, bandZones(xlow, params.xhigh, SCREEN_SIZE), SCREEN_SIZE).gains.map(
          ({ x, y, width, height }) => [x, y, width, height]
        );
      expect(drawn(canvasOf())).toHaveLength(6);
      // the bars are under the lines and the points of the bands
      expect(canvasOf()).not.toHaveClass('front');
      expect(rects()).toEqual(expected(params.xlow));
      // a bright edge at the tip of each: right of a boost, left of a reduction
      const [boost, reduction, most] = shapes(1);
      const [[boostX, , boostWidth], [reductionX], [mostX, , mostWidth]] = expected(params.xlow);
      expect(boost.rects[0].slice(0, 3)).toEqual([boostX + boostWidth - 1.5, boost.rects[0][1], 1.5]);
      expect(reduction.rects[0].slice(0, 3)).toEqual([reductionX, reduction.rects[0][1], 1.5]);
      expect(most.rects[0][0]).toBe(mostX + mostWidth - 1.5);
      expect(cssColor(boost.style)).toBe(cssColor(theme.colors.accent));
      expect(cssColor(reduction.style)).toBe(cssColor(theme.colors.secondAccent));
      // the bars of the values shown last, in the new bands
      rerender({ multi: 1, xlow: 600 });
      expect(rects()).toEqual(expected(600));
      // bypassed: empty again
      rerender({ multi: 1 }, { on: false });
      rects().forEach(([, , width]) => expect(width).toBe(0));
    });
  });
});
