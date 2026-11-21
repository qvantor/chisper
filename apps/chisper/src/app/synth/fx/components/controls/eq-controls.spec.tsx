import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { FX_PARAMS } from '@chisper/preset-schema';
import { mapValues } from 'lodash';
import { EQ_PASS, EQ_PEAK } from '@chisper/math/eq';
import { drawn, withElementSize } from '@chisper/ui-kit/test-utils';
import { Handle, HandleProps } from '@chisper/ui-kit';
import { createLiveRoutes } from '../../../../../test-utils/live-routes';
import { EqControls } from './eq-controls';
import { EQ_SCREEN_SIZE } from './eq-screen';
import { dbY, POINTS } from './eq-screen-geometry';
import { typeCurve } from './eq-type-icons';

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

const params = mapValues(FX_PARAMS.eq, (param) => param.default);

// the screen draws once it knows its size
let restoreSize: () => void;
beforeAll(() => {
  restoreSize = withElementSize(...EQ_SCREEN_SIZE);
});
afterAll(() => restoreSize());

const setup = (props: Partial<React.ComponentProps<typeof EqControls>> = {}) => {
  const setParam = jest.fn();
  const user = userEvent.setup();
  const result = render(<EqControls params={params} setParam={setParam} on sampleRate={48000} {...props} />);
  const rerender = (changes: Partial<typeof params>, on = true) =>
    result.rerender(
      <EqControls params={{ ...params, ...changes }} setParam={setParam} on={on} sampleRate={48000} />
    );
  return { ...result, rerender, setParam, user };
};
// the curve of both bands on the canvas of the screen (the third line: the bands first)
const sumLine = () =>
  drawn(screen.getByTestId('eq-curves')).filter(
    ({ op, points }) => op === 'stroke' && points.length === POINTS
  )[2];

describe('EqControls', () => {
  it('puts band 1, the curve, band 2, then the level and the out group', () => {
    render(
      <EqControls
        params={params}
        setParam={jest.fn()}
        on
        sampleRate={48000}
        out={<div role='group' aria-label='Out' />}
      />
    );
    expect(screen.getAllByRole('group').map((group) => group.getAttribute('aria-label'))).toEqual([
      'Band 1',
      'Curve',
      'Band 2',
      'Post',
      'Out',
    ]);
    expect(within(screen.getByRole('group', { name: 'Curve' })).getByTestId('eq-screen')).toBeInTheDocument();
  });

  it('a band: its type, frequency, resonance and gain; the knobs set them', async () => {
    const { user, setParam } = setup();
    const band = screen.getByRole('group', { name: 'Band 2' });
    expect(within(band).getByRole('button', { name: 'High shelf' })).toBeInTheDocument();
    expect(band.textContent).toMatch(/Freq.*Q.*Gain/);
    await user.click(
      within(screen.getByRole('group', { name: 'Band 1' })).getByRole('button', { name: 'Next' })
    );
    expect(setParam).toHaveBeenLastCalledWith('t1', EQ_PEAK);
    (
      [
        ['Band 1 frequency', 'f1'],
        ['Band 1 resonance', 'q1'],
        ['Band 1 gain', 'g1'],
        ['Band 2 frequency', 'f2'],
        ['Band 2 resonance', 'q2'],
        ['Band 2 gain', 'g2'],
        ['Output level', 'level'],
      ] as const
    ).forEach(([name, key]) => {
      const { min, max, default: fresh } = FX_PARAMS.eq[key];
      expect(knob(name)).toMatchObject({ value: fresh, min, max, defaultValue: fresh, disabled: false });
      knob(name).onChange?.(min);
      expect(setParam).toHaveBeenLastCalledWith(key, min);
    });
    expect(knob('Band 1 frequency').mode).toBe('log');
  });

  it('the type of each band by its side, with the curve of it as its icon', () => {
    const { rerender } = setup();
    const icons = (group: string) =>
      within(screen.getByRole('group', { name: group }))
        .getAllByTestId(/^eq-type-/)
        .map((icon) => icon.dataset['testid']);
    expect(icons('Band 1')).toEqual(['eq-type-1-shelf']);
    expect(icons('Band 2')).toEqual(['eq-type-2-shelf']);
    rerender({ t1: EQ_PASS, t2: EQ_PEAK });
    expect(within(screen.getByRole('group', { name: 'Band 1' })).getByRole('button', { name: 'Low cut' }));
    expect(icons('Band 1')).toEqual(['eq-type-1-pass']);
    expect(icons('Band 2')).toEqual(['eq-type-2-peak']);
    // (a low shelf rises to the left, a high one to the right; a low cut falls to the left)
    const [lowShelf, highShelf, lowCut] = [typeCurve(0, 0), typeCurve(1, 0), typeCurve(0, 2)];
    expect(lowShelf[0][1]).toBeLessThan(lowShelf[lowShelf.length - 1][1]);
    expect(highShelf[0][1]).toBeGreaterThan(highShelf[highShelf.length - 1][1]);
    expect(lowCut[0][1]).toBeGreaterThan(lowCut[lowCut.length - 1][1]);
  });

  it('a pass takes no gain: its knob is off, the others of the band on', () => {
    const { rerender } = setup();
    expect(knob('Band 1 gain').disabled).toBe(false);
    rerender({ t1: EQ_PASS });
    expect(knob('Band 1 gain').disabled).toBe(true);
    expect(knob('Band 1 frequency').disabled).toBe(false);
    expect(knob('Band 2 gain').disabled).toBe(false);
  });

  it('bypassed: every control off, the screen dimmed', () => {
    setup({ on: false });
    ['Band 1 frequency', 'Band 2 resonance', 'Output level'].forEach((name) =>
      expect(knob(name).disabled).toBe(true)
    );
    screen.getAllByRole('group').forEach((group) => expect(group).toHaveClass('disabled'));
    expect(screen.getByTestId('eq-screen-deactivated')).toBeInTheDocument();
  });

  it('the curve follows where the routes of a gain move it while they sound', () => {
    const curve = (g1: number, Wrapper?: React.JSXElementConstructor<React.PropsWithChildren>) => {
      const { unmount } = render(
        <EqControls
          params={{ ...params, t1: EQ_PEAK, f1: 1000, g1 }}
          setParam={jest.fn()}
          on
          sampleRate={48000}
        />,
        { wrapper: Wrapper }
      );
      const { points } = sumLine();
      unmount();
      return points;
    };
    const { Wrapper, route, play } = createLiveRoutes();
    route('eq.g1', 0.25);
    expect(curve(0, Wrapper)).toEqual(curve(0));
    // half of +25% of 48 dB from 0
    play(0.5);
    expect(curve(0, Wrapper)).toEqual(curve(6));
    const top = Math.min(...curve(0, Wrapper).map(([, y]) => y));
    expect(top).toBeCloseTo(dbY(6, EQ_SCREEN_SIZE), 0);
  });
});
