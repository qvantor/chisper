import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { Handle, HandleProps } from '@chisper/ui-kit';
import { cssColor } from '@chisper/ui-kit/test-utils';
import { createEnvelopes, createFilter, createModulation, createSynthCore } from '../../../test-utils/models';
import { EnvelopesContext } from '../common/modules/envelopes';
import { ModulationContext } from '../common/modules/modulation';
import { FilterContext } from '../filter/modules';
import { SOURCE_COLORS } from '../envelope/envelope-colors';
import { applySnapshot } from '../../app';
import { MacrosSection } from '.';

// the knobs are inspected by their props
jest.mock('@chisper/ui-kit', () => ({
  ...jest.requireActual('@chisper/ui-kit'),
  Handle: jest.fn(() => null),
}));

// jsdom has no PointerEvent: a mouse event with the pointer type name and a pointerId works for React and the
// document listeners of the drag
const pointer = (type: string, target: EventTarget, [clientX, clientY]: [number, number]) => {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
    button: 0,
    buttons: 1,
  });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  act(() => {
    target.dispatchEvent(event);
  });
};

const tab = (name: string) => screen.getByRole('button', { name });

// drags a plate onto the element at the end (jsdom has no layout: elementFromPoint gives it): the label it showed
const dragTab = (name: string, onto: Element | null) => {
  Object.assign(document, { elementFromPoint: () => onto });
  pointer('pointerdown', tab(name), [0, 0]);
  pointer('pointermove', document, [50, 50]);
  const label = screen.queryByTestId('mod-drag-label')?.textContent;
  pointer('pointerup', document, [50, 50]);
  Reflect.deleteProperty(document, 'elementFromPoint');
  return label;
};

const setup = () => {
  const synthCore = createSynthCore();
  const envelopes = createEnvelopes();
  const modulation = createModulation();
  const filter = createFilter(synthCore);
  render(
    <EnvelopesContext.Provider value={envelopes}>
      <ModulationContext.Provider value={modulation}>
        <FilterContext.Provider value={filter}>
          <MacrosSection />
          <div data-mod-target='osc1.wave' data-testid='wave' />
          <div data-mod-target='filter.gain' data-testid='gain' />
          <div data-mod-target='lfo2.rate' data-testid='rate' />
        </FilterContext.Provider>
      </ModulationContext.Provider>
    </EnvelopesContext.Provider>
  );
  const knob = (name: string) =>
    (Handle as jest.Mock).mock.calls
      .map(([props]) => props as HandleProps)
      .filter((props) => props.name === name)
      .at(-1) as HandleProps;
  return { envelopes, modulation, knob };
};

describe('MacrosSection', () => {
  afterEach(() => (Handle as jest.Mock).mockClear());

  it('has a knob and a plate of each macro, MACRO 1–4, the knob at its level 0..1 in %', () => {
    const { modulation, knob } = setup();
    expect(['MACRO 1', 'MACRO 2', 'MACRO 3', 'MACRO 4'].map((name) => tab(name).textContent)).toEqual([
      '1MACRO 1',
      '2MACRO 2',
      '3MACRO 3',
      '4MACRO 4',
    ]);
    expect(knob('MACRO 3')).toMatchObject({ value: 0, min: 0, max: 1, defaultValue: 0 });
    expect(knob('MACRO 3').formatValue?.(0.25)).toBe('25%');
    act(() => modulation[1].setMacro('macro3', 0.75));
    expect(knob('MACRO 3').value).toBe(0.75);
  });

  it('a knob turned sets the level of its macro', () => {
    const { modulation, knob } = setup();
    act(() => knob('MACRO 2').onChange?.(0.4));
    expect(modulation[0].$macros.value).toEqual([0, 0.4, 0, 0]);
  });

  it('a plate is of the color of its macro, its grip and its hint tell it is dragged', () => {
    setup();
    (['macro1', 'macro2', 'macro3', 'macro4'] as const).forEach((id, index) => {
      const plate = tab(`MACRO ${index + 1}`);
      expect(plate).toHaveStyle({ backgroundColor: cssColor(SOURCE_COLORS[id]) });
      expect(within(plate).getByTestId('macro-grip')).toBeInTheDocument();
      expect(plate).toHaveAttribute('title', 'Drag onto a knob');
    });
  });

  it('a plate selects its macro: the knobs show its routes, its ring tells it', () => {
    const { envelopes } = setup();
    fireEvent.click(tab('MACRO 2'));
    expect(envelopes[0].$selected.value).toBe('macro2');
    expect(tab('MACRO 2')).toHaveAttribute('aria-pressed', 'true');
    expect(tab('MACRO 2')).toHaveClass('selected');
    expect(tab('MACRO 1')).toHaveAttribute('aria-pressed', 'false');
    expect(tab('MACRO 1')).not.toHaveClass('selected');
  });

  it('the badge of a plate has the number of the routes of its macro (none: empty)', () => {
    const { modulation } = setup();
    const count = (name: string) => within(tab(name)).getByTestId('route-count');
    expect(count('MACRO 4')).toBeEmptyDOMElement();
    act(() => {
      modulation[1].addRoute('macro4', 'osc1.wave');
      modulation[1].addRoute('macro4', 'lfo1.rate');
    });
    expect(count('MACRO 4')).toHaveTextContent('2');
    expect(count('MACRO 1')).toBeEmptyDOMElement();
  });

  it('a macro with routes has a field of its name under it, empty MACRO n in grey; without routes its line is kept empty', () => {
    const { modulation } = setup();
    const field = (name: string) => screen.queryByRole('textbox', { name });
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    // (the line of the name is there: the knob doesn't move once it shows)
    expect(screen.getAllByTestId('macro-name-space')).toHaveLength(4);
    act(() => modulation[1].addRoute('macro3', 'osc1.wave'));
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    expect(screen.getAllByTestId('macro-name-space')).toHaveLength(3);
    expect(field('MACRO 3 name')).toHaveValue('');
    expect(field('MACRO 3 name')).toHaveAttribute('placeholder', 'MACRO 3');
    expect(field('MACRO 3 name')).toHaveAttribute('maxLength', '20');
    act(() => modulation[1].setOff('macro3', 'osc1.wave', true));
    expect(field('MACRO 3 name')).toBeInTheDocument();
  });

  it('a name typed is the name of its macro; Enter leaves the field; the last route removed hides it, kept', () => {
    const { modulation } = setup();
    act(() => modulation[1].addRoute('macro2', 'filter.gain'));
    const field = () => screen.getByRole('textbox', { name: 'MACRO 2 name' });
    fireEvent.change(field(), { target: { value: 'Wobble ' } });
    expect(modulation[0].$macroNames.value).toEqual(['', 'Wobble ', '', '']);
    expect(field()).toHaveValue('Wobble ');
    field().focus();
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(field()).not.toHaveFocus();
    act(() => modulation[1].removeRoute('macro2', 'filter.gain'));
    expect(screen.queryByRole('textbox', { name: 'MACRO 2 name' })).not.toBeInTheDocument();
    act(() => modulation[1].addRoute('macro2', 'osc1.wave'));
    expect(field()).toHaveValue('Wobble ');
  });

  it('a plate dragged shows the name of its macro (none: MACRO n)', () => {
    const { modulation } = setup();
    expect(dragTab('MACRO 2', null)).toBe('MACRO 2');
    act(() => {
      modulation[1].addRoute('macro2', 'osc1.wave');
      modulation[1].setMacroName('macro2', ' Wobble ');
    });
    expect(dragTab('MACRO 2', null)).toBe('Wobble');
  });

  it('a name of a preset shows in its field', () => {
    setup();
    act(() => applySnapshot({ mod: { 'macro1:osc1.wave': 0.5 }, mac: { n1: 'Air' } }));
    expect(screen.getByRole('textbox', { name: 'MACRO 1 name' })).toHaveValue('Air');
  });

  it('a plate dragged onto a knob assigns its macro at +50% and selects it: bipolar on one centered on 0, the knobs of the LFOs too', () => {
    const { modulation, envelopes } = setup();
    dragTab('MACRO 1', screen.getByTestId('wave'));
    dragTab('MACRO 1', screen.getByTestId('gain'));
    dragTab('MACRO 3', screen.getByTestId('rate'));
    expect(modulation[0].$routes.value).toEqual([
      { source: 'macro1', target: 'osc1.wave', amount: 0.5 },
      { source: 'macro1', target: 'filter.gain', amount: 0.5, bipolar: true },
      { source: 'macro3', target: 'lfo2.rate', amount: 0.5 },
    ]);
    expect(envelopes[0].$selected.value).toBe('macro3');
  });
});
