import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { FX_PARAMS } from '@chisper/preset-schema';
import { mapValues } from 'lodash';
import { drawn, withElementSize } from '@chisper/ui-kit/test-utils';
import { Handle, HandleProps } from '@chisper/ui-kit';
import { createLiveRoutes } from '../../../../../test-utils/live-routes';
import { fileRow } from '../../../../../test-utils/file-rows';
import { fxFilterIndexOf } from '../../effects/fxfilter-params';
import { FxFilterControls } from './fxfilter-controls';
import { FX_FILTER_SCREEN_SIZE as SIZE } from './fxfilter-screen';
import { freqX, freqXOpen, POINTS, xFreqOpen } from './eq-screen-geometry';
import { resY } from './fxfilter-screen-geometry';

// the knobs render as ever, their props are recorded
jest.mock('@chisper/ui-kit', () => {
  const actual = jest.requireActual('@chisper/ui-kit');
  return { ...actual, Handle: jest.fn((props) => actual.Handle(props)) };
});
// the props of the knob of that name as it rendered last
const knob = (name: string) =>
  (Handle as unknown as jest.Mock).mock.calls
    .map(([props]) => props as HandleProps)
    .filter((props) => props.name === name)
    .at(-1) as HandleProps;

const params: Record<string, number> = mapValues(FX_PARAMS.fxfilter, (param) => param.default);
const RATE = 48000;

// the screen draws once it knows its size
let restoreSize: () => void;
beforeAll(() => {
  restoreSize = withElementSize(...SIZE);
});
afterAll(() => restoreSize());

const setup = (props: Partial<React.ComponentProps<typeof FxFilterControls>> = {}) => {
  const setParam = jest.fn();
  const user = userEvent.setup();
  const result = render(
    <FxFilterControls params={params} setParam={setParam} on sampleRate={RATE} {...props} />
  );
  const rerender = (changes: Record<string, number>, on = true) =>
    result.rerender(
      <FxFilterControls params={{ ...params, ...changes }} setParam={setParam} on={on} sampleRate={RATE} />
    );
  return { ...result, rerender, setParam, user };
};
const plate = () => screen.getByRole('group', { name: 'Filter type' });
const key = (name: string) => within(plate()).getByRole('button', { name });
const lit = () =>
  within(within(plate()).getByRole('group', { name: 'Category' }))
    .getAllByRole('button')
    .filter((button) => button.getAttribute('aria-pressed') === 'true')
    .map((button) => button.getAttribute('aria-label'));
const grip = () =>
  within(screen.getByTestId('fxfilter-screen')).getByRole('slider', { name: 'Cutoff and resonance' });
// jsdom has no PointerEvent: a mouse event with a pointerId
const pointer = (type: string, target: EventTarget, at: { clientX?: number; clientY?: number } = {}) => {
  const event = new MouseEvent(type, { bubbles: true, button: 0, buttons: 1, ...at });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  act(() => {
    target.dispatchEvent(event);
  });
};
// the curves on the canvas of the screen (a stroke of a point each)
const curves = () =>
  drawn(screen.getByTestId('fxfilter-curve')).filter(
    ({ op, points }) => op === 'stroke' && points.length === POINTS
  );

describe('FxFilterControls', () => {
  it('puts the filter (its type on a plate left of its screen), its knobs, then the level and the out group', () => {
    setup({ out: <div role='group' aria-label='Out' /> });
    expect(screen.getAllByRole('group').map((group) => group.getAttribute('aria-label'))).toEqual([
      'Filter',
      'Filter type',
      'Category',
      'Knobs',
      'Post',
      'Out',
    ]);
    const filter = screen.getByRole('group', { name: 'Filter' });
    const screenFrame = within(filter).getByTestId('fxfilter-screen');
    // (the plate first: left of the screen, beside it in the row of the group)
    expect(plate().compareDocumentPosition(screenFrame) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(plate().contains(screenFrame)).toBe(false);
    // (the name of the type: the text of its key)
    const names = within(plate())
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label') ?? button.textContent);
    expect(names).toEqual([
      'Low Pass',
      'High Pass',
      'Band Pass',
      'Notch & Peak',
      'Previous',
      'Ladder 6',
      'Next',
    ]);
    expect(lit()).toEqual(['Low Pass']);
  });

  it('its knobs set their params', () => {
    const { setParam } = setup();
    (
      [
        ['Cutoff', 'cutoff'],
        ['Resonance', 'res'],
        ['Drive', 'drive'],
        ['Fat (the gain into the filter by the resonance)', 'var'],
        ['Cutoff of left against right', 'pan'],
        ['Output level', 'level'],
      ] as const
    ).forEach(([name, key]) => {
      const { min, max, default: fresh } = FX_PARAMS.fxfilter[key];
      expect(knob(name)).toMatchObject({ value: fresh, min, max, defaultValue: fresh });
      knob(name).onChange?.(max);
      expect(setParam).toHaveBeenLastCalledWith(key, max);
    });
    expect(knob('Cutoff').mode).toBe('log');
  });

  it('◀ ▶ step through the types of its category, around', async () => {
    const { user, setParam, rerender } = setup();
    await user.click(key('Next'));
    expect(setParam).toHaveBeenLastCalledWith('type', fxFilterIndexOf('ladder12'));
    await user.click(key('Previous'));
    expect(setParam).toHaveBeenLastCalledWith('type', fxFilterIndexOf('low24'));
    rerender({ type: fxFilterIndexOf('band24') });
    await user.click(key('Next'));
    expect(setParam).toHaveBeenLastCalledWith('type', fxFilterIndexOf('band12'));
    rerender({ type: fxFilterIndexOf('peak24') });
    await user.click(key('Next'));
    expect(setParam).toHaveBeenLastCalledWith('type', fxFilterIndexOf('notch12'));
  });

  it('the key of a category lit is that of the type; pressed, the type of the slope of the type now, else its first', async () => {
    const { user, setParam, rerender } = setup({ params: { ...params, type: fxFilterIndexOf('ladder12') } });
    expect(lit()).toEqual(['Low Pass']);
    await user.click(key('High Pass'));
    expect(setParam).toHaveBeenLastCalledWith('type', fxFilterIndexOf('high12'));
    rerender({ type: fxFilterIndexOf('high24') });
    expect(lit()).toEqual(['High Pass']);
    await user.click(key('Notch & Peak'));
    expect(setParam).toHaveBeenLastCalledWith('type', fxFilterIndexOf('notch24'));
    rerender({ type: fxFilterIndexOf('high6') });
    await user.click(key('Band Pass'));
    expect(setParam).toHaveBeenLastCalledWith('type', fxFilterIndexOf('band12'));
    // (the lit one does nothing)
    setParam.mockClear();
    await user.click(key('High Pass'));
    expect(setParam).not.toHaveBeenCalled();
  });

  it('a category is gone back to on the type chosen in it last', async () => {
    const { user, setParam, rerender } = setup({ params: { ...params, type: fxFilterIndexOf('low18') } });
    await user.click(key('High Pass'));
    expect(setParam).toHaveBeenLastCalledWith('type', fxFilterIndexOf('high18'));
    rerender({ type: fxFilterIndexOf('high18') });
    await user.click(key('Low Pass'));
    expect(setParam).toHaveBeenLastCalledWith('type', fxFilterIndexOf('low18'));
    // (a type set otherwise, a preset: the last one of its category too)
    rerender({ type: fxFilterIndexOf('band24') });
    rerender({ type: fxFilterIndexOf('ladder6') });
    await user.click(key('Band Pass'));
    expect(setParam).toHaveBeenLastCalledWith('type', fxFilterIndexOf('band24'));
  });

  it('a click on the name opens the browser of all the types by category; one chosen is set', async () => {
    const { user, setParam } = setup();
    await user.click(key('Ladder 6'));
    const browser = (await screen.findByText('Filter type')).closest('.ant-popover') as HTMLElement;
    expect(fileRow('Ladder 6', browser)).toHaveAttribute('aria-current', 'true');
    ['Low Pass', 'High Pass', 'Band Pass', 'Notch & Peak'].forEach((name) =>
      expect(fileRow(name, browser)).toBeInTheDocument()
    );
    await user.click(fileRow('Notch & Peak', browser));
    await user.click(fileRow('Peak 24', browser));
    expect(setParam).toHaveBeenLastCalledWith('type', fxFilterIndexOf('peak24'));
    await waitFor(() => expect(screen.queryByText('Filter type')).not.toBeInTheDocument());
  });

  it('a knob its type reads not is off: the resonance of a one-pole, Fat of a notch', () => {
    const { rerender } = setup();
    expect(knob('Resonance').disabled).toBe(false);
    rerender({ type: fxFilterIndexOf('low6') });
    expect(knob('Resonance').disabled).toBe(true);
    expect(knob('Fat (the gain into the filter by the resonance)').disabled).toBe(true);
    rerender({ type: fxFilterIndexOf('notch12') });
    expect(knob('Resonance').disabled).toBe(false);
    expect(knob('Fat (the gain into the filter by the resonance)').disabled).toBe(true);
    expect(knob('Drive').disabled).toBe(false);
  });

  it('bypassed: every control off, the screen dimmed, the plate of the type faded and off', () => {
    setup({ on: false });
    ['Cutoff', 'Drive', 'Output level'].forEach((name) => expect(knob(name).disabled).toBe(true));
    expect(screen.getByTestId('fxfilter-screen-deactivated')).toBeInTheDocument();
    expect(plate()).toHaveClass('disabled');
    // (faded once, as a whole: its keys not again)
    expect(getComputedStyle(plate()).opacity).toBe('0.5');
    expect(getComputedStyle(within(plate()).getByRole('group', { name: 'Category' })).opacity).toBe('1');
    within(plate())
      .getAllByRole('button')
      .forEach((button) => expect(button).toBeDisabled());
  });

  it('its grip dragged sets the cutoff across and the resonance up and down; the wheel the resonance', () => {
    const { setParam } = setup({ params: { ...params, cutoff: 1000, res: 20 } });
    const [x, y] = [freqX(1000, SIZE), resY(20, SIZE)];
    pointer('pointerdown', grip(), { clientX: 100, clientY: 100 });
    pointer('pointermove', document, {
      clientX: 100 + (freqX(4000, SIZE) - x),
      clientY: 100 + (resY(60, SIZE) - y),
    });
    pointer('pointerup', document);
    expect(setParam).toHaveBeenCalledWith('cutoff', 4000);
    expect(setParam).toHaveBeenCalledWith('res', 60);
    act(() => {
      grip().dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
    });
    expect(setParam).toHaveBeenLastCalledWith('res', 25);
    fireEvent.doubleClick(grip());
    expect(setParam).toHaveBeenLastCalledWith('res', 0);
    expect(grip()).toHaveAttribute('aria-valuetext', '1.0kHz, Res 20%');
  });

  it('its grip dragged up and down leaves the cutoff past the edges of the screen; across, it goes on from there', () => {
    // (the ends of the knob, 22.05 kHz and 8.176 Hz: the grip is drawn at 20 kHz and 20 Hz)
    (
      [
        ['low24', 22050],
        ['high12', 8.176],
      ] as const
    ).forEach(([type, cutoff]) => {
      const { setParam, unmount } = setup({
        params: { ...params, type: fxFilterIndexOf(type), cutoff, res: 20 },
      });
      pointer('pointerdown', grip(), { clientX: 100, clientY: 100 });
      pointer('pointermove', document, { clientX: 100, clientY: 100 + (resY(60, SIZE) - resY(20, SIZE)) });
      pointer('pointerup', document);
      expect(setParam).toHaveBeenCalledWith('res', 60);
      expect(setParam).not.toHaveBeenCalledWith('cutoff', expect.anything());
      unmount();
    });
    // (a pixel to the left of 22.05 kHz, not of the edge of the screen)
    const { setParam } = setup({ params: { ...params, cutoff: 22050 } });
    pointer('pointerdown', grip(), { clientX: 100, clientY: 100 });
    pointer('pointermove', document, { clientX: 99, clientY: 100 });
    pointer('pointerup', document);
    const cutoff = Math.round(xFreqOpen(freqXOpen(22050, SIZE) - 1, SIZE));
    expect(cutoff).toBeGreaterThan(20000);
    expect(setParam).toHaveBeenCalledWith('cutoff', cutoff);
    expect(setParam).not.toHaveBeenCalledWith('res', expect.anything());
  });

  it('of a type that reads no resonance its grip moves the cutoff alone, as the knob of the resonance is off', () => {
    const { setParam, rerender } = setup({
      params: { ...params, type: fxFilterIndexOf('low6'), cutoff: 1000, res: 20 },
    });
    expect(grip()).toHaveClass('across');
    expect(grip()).toHaveAttribute('aria-valuetext', '1.0kHz');
    pointer('pointerdown', grip(), { clientX: 100, clientY: 100 });
    pointer('pointermove', document, {
      clientX: 100 + (freqX(4000, SIZE) - freqX(1000, SIZE)),
      clientY: 100 + (resY(60, SIZE) - resY(20, SIZE)),
    });
    pointer('pointerup', document);
    expect(setParam).toHaveBeenCalledWith('cutoff', 4000);
    const wheel = () =>
      act(() => {
        grip().dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
      });
    wheel();
    fireEvent.keyDown(grip(), { key: 'ArrowUp' });
    fireEvent.doubleClick(grip());
    expect(setParam).not.toHaveBeenCalledWith('res', expect.anything());
    // (a type of a resonance: all of it again)
    rerender({ type: fxFilterIndexOf('low12'), cutoff: 1000, res: 20 });
    expect(grip()).not.toHaveClass('across');
    expect(grip()).toHaveAttribute('aria-valuetext', '1.0kHz, Res 20%');
    wheel();
    expect(setParam).toHaveBeenLastCalledWith('res', 25);
  });

  it('draws one curve in the middle, a curve of each channel while Pan moves them apart', () => {
    const { rerender } = setup({
      params: { ...params, type: fxFilterIndexOf('low12'), cutoff: 2000, res: 50 },
    });
    expect(curves()).toHaveLength(1);
    rerender({ type: fxFilterIndexOf('low12'), cutoff: 2000, res: 50, pan: 20 });
    const [left, right] = curves();
    expect([left, right].every(Boolean)).toBe(true);
    // (the left cutoff up: the left curve over the right one at 4 kHz)
    const at = (points: [number, number][], hz: number) =>
      points.reduce((nearest, point) =>
        Math.abs(point[0] - freqX(hz, SIZE)) < Math.abs(nearest[0] - freqX(hz, SIZE)) ? point : nearest
      )[1];
    expect(at(left.points, 4000)).toBeLessThan(at(right.points, 4000));
  });

  it('draws the cutoff of a channel held to the range of the knob, as the core plays it', () => {
    // (Pan 100: the cutoff of the left channel 32 semitones under 20 Hz, 3.1 Hz, the core plays it at 8.176 Hz)
    const { rerender } = setup({
      params: { ...params, type: fxFilterIndexOf('low24'), cutoff: 20, pan: 100 },
    });
    const [left] = curves();
    rerender({ type: fxFilterIndexOf('low24'), cutoff: 8.176 });
    const [alone] = curves();
    expect(curves()).toHaveLength(1);
    expect(left.points).toEqual(alone.points);
  });

  it('the curve follows where the routes of the cutoff move it while they sound', () => {
    const line = (cutoff: number, Wrapper?: React.JSXElementConstructor<React.PropsWithChildren>) => {
      const { unmount } = render(
        <FxFilterControls
          params={{ ...params, type: fxFilterIndexOf('low24'), cutoff }}
          setParam={jest.fn()}
          on
          sampleRate={RATE}
        />,
        { wrapper: Wrapper }
      );
      const [{ points }] = curves();
      unmount();
      return points;
    };
    const { Wrapper, route, play } = createLiveRoutes();
    route('fxfilter.cutoff', 0.25);
    expect(line(1000, Wrapper)).toEqual(line(1000));
    // (half of +25 % of the travel of the knob: up)
    play(0.5);
    expect(line(1000, Wrapper)).not.toEqual(line(1000));
  });
});
