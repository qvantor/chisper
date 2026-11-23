import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { Handle, HandleProps } from '@chisper/ui-kit';
import { createEnvelopes, createFilter, createModulation, createSynthCore } from '../../../test-utils/models';
import { EnvelopesContext } from '../common/modules/envelopes';
import { ModulationContext } from '../common/modules/modulation';
import { FilterContext } from '../filter/modules';
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

// drags a tab onto the element at the end (jsdom has no layout: elementFromPoint gives it)
const dragTab = (name: string, onto: Element | null) => {
  Object.assign(document, { elementFromPoint: () => onto });
  pointer('pointerdown', tab(name), [0, 0]);
  pointer('pointermove', document, [50, 50]);
  pointer('pointerup', document, [50, 50]);
  Reflect.deleteProperty(document, 'elementFromPoint');
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

  it('has a tab and a knob of each macro, MACRO 1–4, the knob at its level 0..1 in %', () => {
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

  it('a tab selects its macro: the knobs show its routes, its white key tells it (no grip: too narrow)', () => {
    const { envelopes } = setup();
    fireEvent.click(tab('MACRO 2'));
    expect(envelopes[0].$selected.value).toBe('macro2');
    expect(tab('MACRO 2')).toHaveAttribute('aria-pressed', 'true');
    expect(tab('MACRO 2')).toHaveClass('selected');
    expect(within(tab('MACRO 2')).queryByTestId('env-grip')).toBeNull();
    expect(tab('MACRO 1')).toHaveAttribute('aria-pressed', 'false');
  });

  it('the dot of a tab has the number of the routes of its macro', () => {
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

  it('a tab dragged onto a knob assigns its macro at +50% and selects it: bipolar on one centered on 0, the knobs of the LFOs too', () => {
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
