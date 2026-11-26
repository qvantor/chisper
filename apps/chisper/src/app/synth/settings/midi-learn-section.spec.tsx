import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { createMidiLearn } from '../../../test-utils/models';
import { blockStorage } from '../../../test-utils/storage';
import { MidiLearnModelContext } from '../common/midi-learn/midi-learn';
import { MidiControllerContext } from '../common/modules/midi-controller';
import { TransportContext } from '../common/modules/transport';
import { MidiLearnGroup } from './midi-learn-section';
import { MidiInput } from './midi-input';

const setup = ({ access = true } = {}) => {
  const modules = createMidiLearn();
  render(
    <MidiLearnModelContext.Provider value={modules.learn}>
      <MidiLearnGroup access={access} />
    </MidiLearnModelContext.Provider>
  );
  return { ...modules, model: modules.learn[0], actions: modules.learn[1] };
};

const rows = () =>
  within(screen.getByRole('list', { name: 'MIDI bindings' }))
    .getAllByRole('listitem')
    .map((item) => item.textContent);

describe('MidiLearnGroup', () => {
  it('lists the bindings by CC with the names of their controls', () => {
    const { actions, midi } = setup();
    act(() => {
      actions.learn('filter.cutoff');
      midi[0].$cc.next({ cc: 74, value: 0 });
    });
    expect(rows()).toEqual([
      'CC 20MACRO 1',
      'CC 21MACRO 2',
      'CC 22MACRO 3',
      'CC 23MACRO 4',
      'CC 74Filter Cutoff',
    ]);
  });

  it('names a binding again when its name changes (a macro renamed)', () => {
    const { modulation } = setup();
    act(() => modulation[1].setMacroName('macro1', 'Wobble'));
    expect(rows()[0]).toBe('CC 20Wobble');
  });

  it('removes one binding and all of them', () => {
    const { model } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Remove CC 21 of MACRO 2' }));
    expect(model.$bindings.value[21]).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(model.$bindings.value).toEqual({});
    expect(screen.queryByRole('list', { name: 'MIDI bindings' })).toBeNull();
    expect(screen.getByText(/Right-click a control for MIDI Learn/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clear all' })).toBeDisabled();
  });

  it('switches the Learn mode and the takeover', () => {
    const { model } = setup();
    expect(screen.getByText('Off')).toBeTruthy();
    fireEvent.click(screen.getByText('MIDI Learn'));
    expect(model.$learnMode.value).toBe(true);
    expect(screen.getByText('Press a control')).toBeTruthy();
    act(() => model.$learning.next({ target: 'osc1.gain', via: 'mode' }));
    expect(screen.getByText('Move a control')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /^Pickup/ }));
    expect(model.$takeover.value).toBe('pickup');
  });

  it('can not switch the Learn mode on without MIDI', () => {
    const { model } = setup({ access: false });
    expect(screen.getByText('No MIDI input')).toBeTruthy();
    fireEvent.click(screen.getByText('MIDI Learn'));
    expect(model.$learnMode.value).toBe(false);
  });

  it('tells that the map is not kept where the browser keeps nothing', () => {
    blockStorage('localStorage');
    setup();
    expect(screen.getByText(/Not kept/)).toBeTruthy();
  });

  it('names the key of the Midi panel Learn and lights it while the Learn mode is on', () => {
    const { learn, midi, transport } = createMidiLearn();
    render(
      <MidiControllerContext.Provider value={midi}>
        <TransportContext.Provider value={transport}>
          <MidiLearnModelContext.Provider value={learn}>
            <MidiInput />
          </MidiLearnModelContext.Provider>
        </TransportContext.Provider>
      </MidiControllerContext.Provider>
    );
    expect(screen.getByRole('button', { name: /Midi/ })).toBeTruthy();
    act(() => learn[1].setLearnMode(true));
    expect(screen.getByRole('button', { name: /Learn/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Midi/ })).toBeNull();
  });

  it('is nothing without the model of MIDI Learn', () => {
    const { container } = render(<MidiLearnGroup access />);
    expect(container.innerHTML).toBe('');
  });
});
