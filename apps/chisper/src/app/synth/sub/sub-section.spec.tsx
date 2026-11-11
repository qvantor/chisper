import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { Handle, HandleProps } from '@chisper/ui-kit';
import { createModulation, createSynthCore } from '../../../test-utils/models';
import { ModulationContext } from '../common/modules/modulation';
import { SynthCoreContext } from '../common/modules/synth-core';
import { SubProvider, useSub } from '../common/modules';
import type { TableState } from '../common/wavetable/wavetable-engine';
import { formatCoarse, SubSection } from '.';

// the knobs are counted by their renders
jest.mock('@chisper/ui-kit', () => {
  const actual = jest.requireActual('@chisper/ui-kit');
  return { ...actual, Handle: jest.fn(actual.Handle) };
});

const setup = () => {
  const synthCore = createSynthCore();
  const modulation = createModulation();
  const sub: { current?: ReturnType<typeof useSub> } = {};
  const Probe = () => {
    sub.current = useSub();
    return null;
  };
  render(
    <SynthCoreContext.Provider value={synthCore}>
      <ModulationContext.Provider value={modulation}>
        <SubProvider initial={{}} synthCore={synthCore}>
          <SubSection />
          <Probe />
        </SubProvider>
      </ModulationContext.Provider>
    </SynthCoreContext.Provider>
  );
  const [model, actions] = sub.current as ReturnType<typeof useSub>;
  const menuOf = (label: string) => {
    fireEvent.contextMenu(screen.getByText(label));
    return screen.getByRole('dialog');
  };
  return { model, actions, modulation, synthCore, menuOf };
};

const SHAPES = ['Sine', 'Rounded Rect', 'Triangle', 'Saw', 'Square', 'Pulse'];

// jsdom has no PointerEvent: a mouse event with the pointer type name and a pointerId works for React and the
// document listeners of the pointer tracker
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

// presses a value and drags it by dx, dy (screen coordinates: y grows down)
const drag = (target: Element, [dx, dy]: [number, number]) => {
  pointer('pointerdown', target, [100, 100]);
  pointer('pointermove', document, [100 + dx, 100 + dy]);
  pointer('pointerup', document, [100 + dx, 100 + dy]);
};

describe('SubSection', () => {
  it('is switched on and off by its header, off by default', () => {
    const { model } = setup();
    const header = screen.getByRole('button', { name: /Sub/ });
    expect(header).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(header);
    expect(model.$active.value).toBe(true);
    expect(header).toHaveAttribute('aria-pressed', 'true');
  });

  it('chooses its shape by its keys, one lit at a time', () => {
    const { model } = setup();
    const keys = SHAPES.map((name) => screen.getByRole('button', { name }));
    const lit = () => keys.map((key) => key.getAttribute('aria-pressed') === 'true');
    expect(lit()).toEqual([true, false, false, false, false, false]);
    fireEvent.click(keys[3]);
    expect(model.$sub.value.shape).toBe('saw');
    expect(lit()).toEqual([false, false, false, true, false, false]);
    // (a lit key pressed again stays lit)
    fireEvent.click(keys[3]);
    expect(model.$sub.value.shape).toBe('saw');
    fireEvent.click(keys[1]);
    expect(model.$sub.value.shape).toBe('round-rect');
  });

  it('switches Contiguous by its key', () => {
    const { model } = setup();
    const key = screen.getByRole('button', { name: 'Contiguous' });
    expect(key).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(key);
    expect(model.$sub.value.contiguous).toBe(true);
    expect(key).toHaveAttribute('aria-pressed', 'true');
  });

  it('has Oct in a bar of its own, under it Crs over the shapes, Phase and Contiguous under them, Pan and Gain under it', () => {
    setup();
    const shapes = screen.getByRole('group', { name: 'Shape' });
    const [octave, crs, phase, pan, gain] = ['Oct', 'Crs', 'Phase', 'Pan', 'Gain'].map((label) =>
      screen.getByText(label)
    );
    const contiguous = screen.getByRole('button', { name: 'Contiguous' });
    // the bar of Oct, the block and the knobs, as the select, the window and the knobs of the noise; no overview
    const block = shapes.parentElement?.parentElement as HTMLElement;
    const layout = block.parentElement as HTMLElement;
    const [bar, , knobs] = Array.from(layout.children);
    expect(layout.children).toHaveLength(3);
    expect(layout.children[1]).toBe(block);
    expect(layout.querySelector('canvas')).toBeNull();
    expect(bar).toContainElement(octave);
    [crs, phase, contiguous].forEach((element) => expect(block).toContainElement(element));
    [pan, gain].forEach((label) => expect(knobs).toContainElement(label));
    expect(Handle).not.toHaveBeenCalledWith(expect.objectContaining({ label: 'Crs' }), undefined);
    // in this order: Oct, Crs, the shapes, Phase, Contiguous; Pan over Gain
    const elements = Array.from(layout.querySelectorAll('*'));
    const order = [octave, crs, shapes, phase, contiguous, pan, gain].map((element) =>
      elements.indexOf(element)
    );
    expect(order).not.toContain(-1);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(shapes.classList.contains('column')).toBe(true);
    expect(
      within(shapes)
        .getAllByRole('button')
        .map((key) => key.getAttribute('aria-label'))
    ).toEqual(SHAPES);
    // Oct steps by its arrows, as the Oct of an oscillator
    expect(screen.getByRole('slider', { name: 'Oct' }).querySelector('svg')).not.toBeNull();
  });

  it('has Oct and Crs dragged up or right by whole octaves and semitones (10 px each), Crs to a hundredth', () => {
    const { model } = setup();
    const field = (name: string) => screen.getByRole('slider', { name });
    drag(field('Crs'), [0, -70]);
    drag(field('Oct'), [-10, 0]);
    expect(model.$sub.value).toMatchObject({ octave: -1, coarse: 7 });
    drag(field('Crs'), [3, 0]);
    expect(model.$sub.value.coarse).toBe(7.3);
    expect(field('Crs').getAttribute('aria-valuetext')).toBe('+7.3');
    // within ±64 semitones
    drag(field('Crs'), [0, 2000]);
    expect(model.$sub.value.coarse).toBe(-64);
  });

  it('Crs takes the routes of Crs as Semi those of Pitch: the line of its range, the dot, the bar of a route', () => {
    const { modulation, menuOf } = setup();
    const field = (name: string) => screen.getByRole('slider', { name });
    expect(field('Crs').getAttribute('data-mod-target')).toBe('sub.crs');
    expect(field('Oct').hasAttribute('data-mod-target')).toBe(false);
    expect(field('Crs').querySelector('[data-testid="mod-track"]')).not.toBeNull();
    expect(field('Oct').querySelector('[data-testid="mod-track"]')).toBeNull();
    act(() => modulation[1].addRoute('env1', 'sub.crs', 0.25, true));
    // the dot of the selected tab (ENV 1 without the envelopes model) in the cell of Crs
    expect(field('Crs')).toContainElement(screen.getByRole('slider', { name: 'ENV 1' }));
    // Crs 0 at 25% (bipolar) of 128 semitones: from -16 to +16 of -64…+64
    const [bar] = screen.getAllByTestId('mod-bar');
    expect([bar.style.left, bar.style.width]).toEqual(['37.5%', '25%']);
    expect(
      within(menuOf('Crs'))
        .getAllByTestId('menu-route')
        .map((row) => row.textContent?.slice(0, 5))
    ).toEqual(['ENV 1']);
  });

  it('stripes its shapes while it is off, as an oscillator its wave; a shape is still chosen through them', () => {
    const { model, actions } = setup();
    const shapes = screen.getByRole('group', { name: 'Shape' });
    const off = screen.getByTestId('sub-off');
    expect(shapes.parentElement).toContainElement(off);
    expect(getComputedStyle(off).pointerEvents).toBe('none');
    fireEvent.click(screen.getByRole('button', { name: 'Saw' }));
    expect(model.$sub.value.shape).toBe('saw');
    act(() => actions.toggleActive());
    expect(screen.queryByTestId('sub-off')).toBeNull();
    act(() => actions.toggleActive());
    expect(screen.getByTestId('sub-off')).toBeInTheDocument();
  });

  it('shows Oct, Crs and Phase, and the knobs of the sub', () => {
    const { actions } = setup();
    act(() => {
      actions.setSubValue('octave', -2);
      actions.setSubValue('phase', 0.25);
      actions.setSubValue('coarse', 7.5);
    });
    expect(screen.getByText('-2')).toBeInTheDocument();
    expect(screen.getByText('+7.5')).toBeInTheDocument();
    expect(screen.getByText('90°')).toBeInTheDocument();
    ['Pan', 'Gain'].forEach((label) => expect(screen.getByText(label)).toBeInTheDocument());
    expect(formatCoarse(7.5)).toBe('+7.5');
    expect(formatCoarse(-0.256)).toBe('-0.26');
    expect(formatCoarse(0)).toBe('0');
  });

  it('routes the knobs and Crs (their menus show the routes) and restores their defaults', () => {
    const { model, actions, modulation, menuOf } = setup();
    act(() => {
      actions.setSubValue('level', 0.2);
      modulation[1].addRoute('env2', 'sub.level', 0.5);
      modulation[1].addRoute('lfo1', 'sub.crs');
      modulation[1].addRoute('lfo2', 'sub.pan');
    });
    expect(
      within(menuOf('Gain'))
        .getAllByTestId('menu-route')
        .map((row) => row.textContent?.slice(0, 5))
    ).toEqual(['ENV 2']);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Default/ }));
    expect(model.$sub.value.level).toBe(0.75);
    act(() => actions.setSubValue('coarse', 12));
    fireEvent.click(within(menuOf('Crs')).getByRole('button', { name: /Default/ }));
    expect(model.$sub.value.coarse).toBe(0);
    // an LFO on a centered knob: bipolar
    expect(modulation[0].$routes.value).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'lfo1', target: 'sub.crs', bipolar: true }),
        expect.objectContaining({ source: 'lfo2', target: 'sub.pan', bipolar: true }),
      ])
    );
  });

  it('renders a knob alone on a step of it, the keys and the values without the knobs', () => {
    const { actions } = setup();
    // the labels of the knobs a change renders
    const rendered = (change: () => void) => {
      const before = (Handle as jest.Mock).mock.calls.length;
      act(change);
      return (Handle as jest.Mock).mock.calls.slice(before).map(([props]) => (props as HandleProps).label);
    };
    expect(rendered(() => actions.setSubValue('pan', 0.5))).toEqual(['Pan']);
    expect(rendered(() => actions.setSubValue('level', 0.5))).toEqual(['Gain']);
    expect(rendered(() => actions.setSubValue('coarse', 5))).toEqual([]);
    expect(rendered(() => actions.setSubValue('octave', 1))).toEqual([]);
    expect(rendered(() => actions.setSubValue('phase', 0.5))).toEqual([]);
    expect(rendered(() => actions.setShape('pulse'))).toEqual([]);
    expect(rendered(() => actions.setContiguous(true))).toEqual([]);
  });

  it('tells over its shapes why its shape does not play while it is on, Retry sends it again', () => {
    const { actions, synthCore } = setup();
    const { wavetables } = synthCore[0];
    const retryTable = jest.spyOn(wavetables, 'retryTable');
    const tables = (state: TableState) => act(() => wavetables.$tables.next({ 'sub:saw': state }));
    act(() => actions.setShape('saw'));
    tables('refused');
    // (off)
    expect(screen.queryByRole('alert')).toBeNull();
    act(() => actions.toggleActive());
    tables('refused');
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Not enough memory for the shape');
    // over the shapes, not Crs and Phase
    expect(alert.parentElement).toBe(screen.getByRole('group', { name: 'Shape' }).parentElement);
    retryTable.mockClear();
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(retryTable.mock.calls).toEqual([['sub:saw']]);
    tables('failed');
    expect(screen.getByRole('alert')).toHaveTextContent('The shape failed to build');
    tables('sending');
    expect(screen.queryByRole('alert')).toBeNull();
    tables('stored');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('lets another shape be chosen under the warning, which goes with it', () => {
    const { model, actions, synthCore } = setup();
    const { wavetables } = synthCore[0];
    act(() => {
      actions.toggleActive();
      actions.setShape('saw');
    });
    act(() => wavetables.$tables.next({ 'sub:saw': 'failed' }));
    // the pointer passes through it to the keys, not through Retry
    const alert = screen.getByRole('alert');
    expect(getComputedStyle(alert).pointerEvents).toBe('none');
    expect(getComputedStyle(within(alert).getByRole('button', { name: 'Retry' })).pointerEvents).toBe('auto');
    fireEvent.click(screen.getByRole('button', { name: 'Sine' }));
    expect(model.$sub.value.shape).toBe('sine');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('tells why it can not play while the oscillators can not, Retry loads them again', () => {
    const { actions, synthCore } = setup();
    const [{ wavetables }, synthActions] = synthCore;
    const retryAudio = jest.spyOn(synthActions, 'retryAudio').mockImplementation(() => undefined);
    act(() => wavetables.$status.next('failed'));
    expect(screen.queryByRole('alert')).toBeNull();
    act(() => actions.toggleActive());
    expect(screen.getByRole('alert')).toHaveTextContent("Sub can't play: Failed to load");
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retryAudio).toHaveBeenCalled();
  });
});
