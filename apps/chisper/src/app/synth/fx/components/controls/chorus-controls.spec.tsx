import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { switchKeyTip as tip } from '@chisper/ui-kit/test-utils';
import { divisionIndex, FX_PARAMS, TEMPO_DIVISIONS } from '@chisper/preset-schema';
import { Handle, HandleProps } from '@chisper/ui-kit';
import { mapValues } from 'lodash';
import { ChorusControls } from './chorus-controls';

// the knobs render as ever, their props are recorded
jest.mock('@chisper/ui-kit', () => {
  const actual = jest.requireActual('@chisper/ui-kit');
  return { ...actual, Handle: jest.fn((props) => actual.Handle(props)) };
});
const knob = (label: string) =>
  (Handle as unknown as jest.Mock).mock.calls
    .map(([props]) => props as HandleProps)
    .filter((props) => props.label === label)
    .at(-1) as HandleProps;

const params: Record<string, number> = mapValues(FX_PARAMS.chorus, (param) => param.default);

const setup = (props: Partial<React.ComponentProps<typeof ChorusControls>> = {}) => {
  const setParam = jest.fn();
  const user = userEvent.setup();
  const result = render(
    <ChorusControls params={params} setParam={setParam} on sampleRate={48000} {...props} />
  );
  const show = (next: Partial<React.ComponentProps<typeof ChorusControls>>) =>
    result.rerender(<ChorusControls params={params} setParam={setParam} on sampleRate={48000} {...next} />);
  return { ...result, setParam, user, show };
};

describe('ChorusControls', () => {
  afterEach(() => jest.useRealTimers());

  it('splits the controls into the LFO, the taps and the post groups, left to right, the Out group last', () => {
    setup({ out: <div role='group' aria-label='Out' /> });
    const groups = screen.getAllByRole('group');
    expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual([
      'LFO',
      'Tempo',
      'Taps',
      'Post',
      'Filter type',
      'Out',
    ]);
    const [lfo, tempo, taps, post, filter] = groups;
    // the keys of the tempo in the LFO group beside Rate, between it and Depth
    expect(lfo).toContainElement(tempo);
    expect(tempo).toHaveClass('stack');
    expect(within(lfo).getByText('Rate').compareDocumentPosition(tempo)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    expect(tempo.compareDocumentPosition(within(lfo).getByText('Depth'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    const order = (group: HTMLElement, labels: string[]) => {
      const text = group.textContent ?? '';
      const places = labels.map((label) => text.indexOf(label));
      expect(places.every((index) => index >= 0)).toBe(true);
      expect([...places].sort((a, b) => a - b)).toEqual(places);
    };
    order(taps, ['Delay 1', 'Delay 2', 'Feedback']);
    order(post, ['Cutoff', 'Level']);
    // the type of the filter beside its cutoff
    expect(post).toContainElement(filter);
    // its key alone is all of its plate (as BPM of an envelope)
    expect(filter).toHaveClass('stack');
    expect(within(filter).getAllByRole('button')).toHaveLength(1);
  });

  it('the screen of the taps is first in their group: it watches the meter of the chorus while it is on', () => {
    const watch = jest.fn(() => jest.fn());
    const { show } = setup({ meter: { watch } });
    const taps = screen.getByRole('group', { name: 'Taps' });
    const tapsScreen = within(taps).getByTestId('chorus-screen');
    expect(tapsScreen.compareDocumentPosition(within(taps).getByText('Delay 1'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    expect(watch).toHaveBeenCalledTimes(1);
    show({ meter: { watch }, on: false });
    expect(watch.mock.results[0].value).toHaveBeenCalledTimes(1);
    expect(within(taps).getByTestId('chorus-screen-deactivated')).toBeInTheDocument();
  });

  it('every knob shows its param and sets it, with its range and its default', () => {
    const { setParam } = setup();
    const knobs: [string, string][] = [
      ['Rate', 'rate'],
      ['Depth', 'depth'],
      ['Delay 1', 'd1'],
      ['Delay 2', 'd2'],
      ['Feedback', 'fb'],
      ['Cutoff', 'cut'],
      ['Level', 'level'],
    ];
    knobs.forEach(([label, key]) => {
      const { min, max, default: fresh } = FX_PARAMS.chorus[key as keyof typeof FX_PARAMS.chorus];
      expect(knob(label)).toMatchObject({ value: fresh, min, max, defaultValue: fresh, disabled: false });
      knob(label).onChange?.(min);
      expect(setParam).toHaveBeenLastCalledWith(key, min);
    });
    expect(knob('Rate').mode).toBe('pow');
    expect(knob('Cutoff').mode).toBe('log');
    expect(knob('Level').fillFrom).toBe(0.5);
  });

  it('switches the filter between a low pass and a high pass beside its cutoff', async () => {
    const { user, setParam, show } = setup();
    const key = () => screen.getByRole('button', { name: 'High pass' });
    expect(key()).toHaveAttribute('aria-pressed', 'false');
    // its icon: the response of a high pass
    expect(key().textContent).toBe('');
    expect(key().querySelectorAll('svg path')).toHaveLength(1);
    await user.click(key());
    expect(setParam).toHaveBeenLastCalledWith('hpf', 1);
    show({ params: { ...params, hpf: 1 } });
    expect(key()).toHaveAttribute('aria-pressed', 'true');
    await user.click(key());
    expect(setParam).toHaveBeenLastCalledWith('hpf', 0);
  });

  it('switches BPM beside Rate, TRIP and DOT only in BPM', async () => {
    const { user, setParam, show } = setup();
    const key = (name: string) => screen.getByRole('button', { name });
    expect(key('Tempo sync')).toHaveAttribute('aria-pressed', 'false');
    expect(key('Triplets')).toBeDisabled();
    await user.click(key('Tempo sync'));
    expect(setParam).toHaveBeenLastCalledWith('sync', 1);
    show({ params: { ...params, sync: 1 } });
    await user.click(key('Triplets'));
    expect(setParam).toHaveBeenLastCalledWith('trip', 1);
    await user.click(key('Dotted'));
    expect(setParam).toHaveBeenLastCalledWith('dot', 1);
    show({ params: { ...params, sync: 1, dot: 1 } });
    await user.click(key('Dotted'));
    expect(setParam).toHaveBeenLastCalledWith('dot', 0);
  });

  it('hovered, a key tells what it does, a dimmed one why: BPM off, or the chorus', () => {
    jest.useFakeTimers();
    const { show } = setup();
    expect(tip('Tempo sync')).toBe('Tempo syncRate in note values');
    expect(tip('Triplets')).toBe('TripletsRate in triplets: ⅔ as longTurn on BPM to use it');
    expect(tip('High pass')).toBe('High passThe filter cuts the lows of the wet signal, not its highs');
    show({ on: false });
    expect(tip('Dotted')).toBe('DottedRate in dotted notes: 1.5× as longTurn on the chorus');
    expect(tip('High pass')).toBe(
      'High passThe filter cuts the lows of the wet signal, not its highsTurn on the chorus'
    );
  });

  it('shows Rate as its division in BPM: 8 bar … 1/32 a cycle, faster to the right', () => {
    const { show, setParam } = setup();
    expect(knob('Rate').value).toBe(0.078);
    expect(knob('Rate').step).toBeUndefined();
    show({ params: { ...params, sync: 1, div: divisionIndex('1/4') } });
    const rate = knob('Rate');
    expect(rate.value).toBe(divisionIndex('1/4'));
    expect(rate.formatValue?.(rate.value ?? 0)).toBe('1/4');
    const steps = rate.step as number[];
    expect(steps.map((step) => TEMPO_DIVISIONS[step].id)).toEqual([
      '8 bar',
      '4 bar',
      '2 bar',
      '1 bar',
      '1/2',
      '1/4',
      '1/8',
      '1/16',
      '1/32',
    ]);
    expect(rate.defaultValue).toBe(FX_PARAMS.chorus.div.default);
    rate.onChange?.(divisionIndex('1/8'));
    expect(setParam).toHaveBeenLastCalledWith('div', divisionIndex('1/8'));
    // TRIP and DOT: their steps among them; a division that is not a step shows as its straight one
    show({ params: { ...params, sync: 1, trip: 1, div: divisionIndex('1/4T') } });
    expect(knob('Rate').formatValue?.(knob('Rate').value ?? 0)).toBe('1/4T');
    show({ params: { ...params, sync: 1, div: divisionIndex('1/4T') } });
    expect(knob('Rate').value).toBe(divisionIndex('1/4'));
  });

  it('bypassed, every knob and key is dimmed', () => {
    setup({ on: false });
    ['Rate', 'Depth', 'Delay 1', 'Delay 2', 'Feedback', 'Cutoff', 'Level'].forEach((label) =>
      expect(knob(label).disabled).toBe(true)
    );
    ['LFO', 'Taps', 'Post'].forEach((name) =>
      expect(screen.getByRole('group', { name })).toHaveClass('disabled')
    );
    ['Tempo', 'Filter type'].forEach((name) =>
      expect(screen.getByRole('group', { name })).toHaveAttribute('aria-disabled', 'true')
    );
  });
});
