import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { drawn, svgPath, withElementSize } from '@chisper/ui-kit/test-utils';
import { FILTER_TYPES, MODEL_FILTER_TYPES } from '@chisper/preset-schema';
import { filterModel } from '@chisper/math';
import { VOICE_FILTER_TYPES } from '../../common/wavetable/voice-options';
import { createModulation, createSynthCore } from '../../../../test-utils/models';
import { ModulationContext } from '../../common/modules/modulation';
import { FilterProvider, useFilter } from '../modules';
import { fileRow } from '../../../../test-utils/file-rows';
import { FilterSection } from './filter-section';
import { FILTER_CATEGORIES } from './filter-type-select';

const setup = () => {
  const synthCore = createSynthCore();
  const modulation = createModulation();
  const filter: { current?: ReturnType<typeof useFilter> } = {};
  const Probe = () => {
    filter.current = useFilter();
    return null;
  };
  render(
    <ModulationContext.Provider value={modulation}>
      <FilterProvider initial={{}} synthCore={synthCore}>
        <FilterSection />
        <Probe />
      </FilterProvider>
    </ModulationContext.Provider>
  );
  const [model, actions] = filter.current as ReturnType<typeof useFilter>;
  // a right click on a knob by its label
  const menuOf = (label: string) => {
    fireEvent.contextMenu(screen.getByText(label));
    return screen.getByRole('dialog');
  };
  return { model, actions, modulation, menuOf };
};

// jsdom has no PointerEvent: a mouse event with a pointerId works for React and the document listeners of the
// pointer tracker
const pointer = (type: string, target: EventTarget, clientX: number) => {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY: 0,
    button: 0,
    buttons: 1,
  });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  act(() => {
    target.dispatchEvent(event);
  });
};

const dragRight = (element: HTMLElement, px: number) => {
  pointer('pointerdown', element, 0);
  pointer('pointermove', document, px);
  pointer('pointerup', document, px);
};

describe('FilterSection', () => {
  let restoreSize: () => void;
  beforeEach(() => (restoreSize = withElementSize(300, 100)));
  afterEach(() => restoreSize());

  it('the menu of a knob: its routes switched off and on, its default, its routes cleared', () => {
    const { model, actions, modulation, menuOf } = setup();
    act(() => {
      actions.setNumericValue('cutoff', 1000);
      modulation[1].addRoute('env2', 'filter.cutoff', 0.25);
      modulation[1].addRoute('lfo1', 'filter.cutoff');
      modulation[1].addRoute('env2', 'filter.resonance');
    });
    const menu = menuOf('Cutoff');
    expect(
      within(menu)
        .getAllByTestId('menu-route')
        .map((row) => row.textContent?.slice(0, 5))
    ).toEqual(['ENV 2', 'LFO 1']);
    fireEvent.click(within(menu).getByRole('button', { name: 'LFO 1 on' }));
    expect(modulation[0].$routes.value[1]).toMatchObject({ source: 'lfo1', off: true });

    // its row dragged right: the amount of the route, in the units of the knob
    const amount = within(menu).getByRole('slider', { name: 'ENV 2 amount' });
    expect(amount.getAttribute('aria-valuetext')).toBe('+2.8 oct');
    dragRight(amount, 30);
    expect(modulation[0].$routes.value[0]).toMatchObject({ source: 'env2', amount: 0.55 });
    expect(amount.getAttribute('aria-valuetext')).toBe('+6.1 oct');

    fireEvent.click(within(menu).getByRole('button', { name: /Default/ }));
    expect(model.$filter.value.cutoff).toBe(440);

    fireEvent.click(within(menuOf('Cutoff')).getByRole('button', { name: 'Clear modulation' }));
    expect(modulation[0].$routes.value).toEqual([
      { source: 'env2', target: 'filter.resonance', amount: 0.5 },
    ]);
  });

  it('the default of a knob within the range of the type: the resonance of a bandpass at its lowest', () => {
    const { model, actions, menuOf } = setup();
    act(() => {
      actions.setType('bandpass');
      actions.setNumericValue('resonance', 5);
    });
    fireEvent.click(within(menuOf('Q')).getByRole('button', { name: /Default/ }));
    expect(model.$filter.value.resonance).toBe(0.01);
  });

  it('the default of the Gain of the band of an EQ type: 0 dB, of Comp: 0 %', () => {
    const { model, actions, menuOf } = setup();
    act(() => {
      actions.setType('loweq12');
      actions.setNumericValue('variation', 90);
    });
    fireEvent.click(within(menuOf('Gain')).getByRole('button', { name: /Default/ }));
    expect(model.$filter.value.variation).toBe(50);
    act(() => {
      actions.setType('ladder24');
      actions.setNumericValue('variation', 90);
    });
    fireEvent.click(within(menuOf('Comp')).getByRole('button', { name: /Default/ }));
    expect(model.$filter.value.variation).toBe(0);
  });

  it('offers every type in a browser by what it does, each with the model in its name', async () => {
    const { model } = setup();
    // every type of the presets but the allpass of before (never offered, still played)
    const offered = FILTER_CATEGORIES.flatMap((category) =>
      'children' in category ? category.children.map(({ value }) => value) : []
    );
    expect(offered).toHaveLength(new Set(offered).size);
    expect(new Set(offered)).toEqual(new Set(FILTER_TYPES.filter((type) => type !== 'allpass')));

    // the name of the type opens the browser on its category
    fireEvent.click(screen.getByRole('button', { name: 'Biquad LP' }));
    await screen.findByText('Filter type');
    const categories = ['Low Pass', 'High Pass', 'Band Pass', 'Notch & Peak', 'EQ'];
    expect(categories.map((name) => fileRow(name).textContent)).toEqual([
      'Low Pass9',
      'High Pass5',
      'Band Pass3',
      'Notch & Peak5',
      'EQ8',
    ]);
    expect(fileRow('Low Pass')).toHaveAttribute('aria-expanded', 'true');
    // (the rows of the browser: the name of the type is on its key too)
    const browser = fileRow('Low Pass').parentElement?.parentElement as HTMLElement;
    expect(fileRow('Biquad LP', browser)).toHaveAttribute('aria-current', 'true');
    expect(fileRow('Ladder 24', browser)).toBeTruthy();

    // another category, a type of it
    fireEvent.click(fileRow('EQ'));
    expect(fileRow('Biquad Bell', browser)).toBeTruthy();
    fireEvent.click(fileRow('Low EQ 12', browser));
    expect(model.$filterType.value).toBe('loweq12');
    expect(screen.getByRole('button', { name: 'Low EQ 12' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows the knobs of the type: Gain of a Biquad one, Drive and Comp or Gain of a model one', () => {
    const { actions } = setup();
    // (the labels of the knobs)
    const labels = () => Array.from(document.querySelectorAll('label'), (label) => label.textContent);
    expect(labels()).toEqual(['Cutoff', 'Res', 'Gain']);
    act(() => actions.setType('bandpass'));
    expect(labels()).toEqual(['Cutoff', 'Q', 'Gain']);
    act(() => actions.setType('peaking'));
    expect(labels()).toEqual(['Cutoff', 'Q', 'Gain']);
    act(() => actions.setType('ladder24'));
    expect(labels()).toEqual(['Cutoff', 'Res', 'Drive', 'Comp']);
    // the band of an EQ type: its Gain
    act(() => actions.setType('bandeq12'));
    expect(labels()).toEqual(['Cutoff', 'Res', 'Drive', 'Gain']);
  });

  it('shows the value of each knob with its unit (its menu)', () => {
    const { actions, menuOf } = setup();
    const value = (label: string) => {
      const menu = menuOf(label);
      const text = menu.textContent ?? '';
      fireEvent.keyDown(menu, { key: 'Escape' });
      return text;
    };
    act(() => {
      actions.setNumericValue('cutoff', 2500);
      actions.setNumericValue('resonance', 6);
    });
    expect(value('Cutoff')).toContain('2.50kHz');
    expect(value('Res')).toContain('+6.0dB');
    act(() => {
      actions.setType('ladder24');
      actions.setNumericValue('resonance', 40);
      actions.setNumericValue('drive', 25);
    });
    expect(value('Res')).toContain('40%');
    expect(value('Drive')).toContain('25%');
    act(() => {
      actions.setType('loweq12');
      actions.setNumericValue('variation', 100);
    });
    expect(value('Gain')).toContain('+19.1dB');
  });

  it("greys the knobs the type doesn't use: Res and Comp of Low 6, Res of Low EQ 6", () => {
    const { actions } = setup();
    const disabled = (label: string) => screen.getByText(label).closest('.disabled') !== null;
    act(() => actions.setType('low6'));
    expect([disabled('Cutoff'), disabled('Res'), disabled('Drive'), disabled('Comp')]).toEqual([
      false,
      true,
      false,
      true,
    ]);
    act(() => actions.setType('loweq6'));
    expect([disabled('Res'), disabled('Gain')]).toEqual([true, false]);
    act(() => actions.setType('low12'));
    expect([disabled('Res'), disabled('Comp')]).toEqual([false, false]);
  });

  it('the arrows step through the types, category after category', () => {
    const { model, actions } = setup();
    const step = (name: 'Next' | 'Previous') => fireEvent.click(screen.getByRole('button', { name }));
    act(() => actions.setType('low12'));
    step('Next');
    expect(model.$filterType.value).toBe('low18');
    act(() => actions.setType('low24'));
    step('Next');
    expect(model.$filterType.value).toBe('lowpass');
    step('Next');
    expect(model.$filterType.value).toBe('high6');
    step('Previous');
    step('Previous');
    expect(model.$filterType.value).toBe('low24');
    // around: from the last to the first
    act(() => actions.setType('peaking'));
    step('Next');
    expect(model.$filterType.value).toBe('ladder6');
  });

  it('names the allpass of before, which it never offers; the arrows go from it to the first type', () => {
    const { model, actions } = setup();
    act(() => actions.setType('allpass'));
    expect(screen.getByRole('button', { name: 'Biquad AP' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(model.$filterType.value).toBe('ladder6');
  });

  it('draws the response of a model type on its canvas, where its design is', () => {
    const { actions } = setup();
    act(() => {
      actions.toggleActive();
      actions.setType('ladder12');
      actions.setNumericValue('cutoff', 1000);
      actions.setNumericValue('resonance', 80);
    });
    const [line] = drawn(screen.getByTestId('filter-line')).map(svgPath);
    expect(line).toBeTruthy();
    // the resonance over the pass band: the line rises toward the cutoff
    const design = filterModel.modelDesign('ladder12', { cutoff: 1000, resonance: 0.8, variation: 0 }, 44100);
    expect(filterModel.designGain2(design, 950, 44100)).toBeGreaterThan(
      filterModel.designGain2(design, 100, 44100)
    );
  });
});

describe('the types of the filter', () => {
  it('are one list in the presets, the worklet and the math of the chart', () => {
    expect([...VOICE_FILTER_TYPES]).toEqual([...FILTER_TYPES]);
    expect([...filterModel.MODEL_FILTER_TYPES]).toEqual([...MODEL_FILTER_TYPES]);
  });
});
