import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import toast from 'react-hot-toast';
import { FX_TYPES } from '@chisper/preset-schema';
import { MIDI_LEARN_CLASS, MIDI_TARGET_ATTR } from '@chisper/ui-kit';
import { createMidiLearn } from '../../../test-utils/models';
import {
  createMidiAccess,
  createMidiInput,
  provideMidiAccess,
  removeMidiAccess,
} from '../../../test-utils/midi';
import { queryWrapper } from '../../../test-utils/query-client';
import { AppProvider } from '../../app';
import { SynthCoreContext } from '../common/modules/synth-core';
import { TransportContext } from '../common/modules/transport';
import { EnvelopesContext } from '../common/modules/envelopes';
import { LfoContext } from '../common/modules/lfos';
import { ModulationContext } from '../common/modules/modulation';
import { Oscillator1Context, Oscillator2Context } from '../common/modules/oscillator';
import { NoiseContext } from '../common/modules/noise';
import { SubContext } from '../common/modules/sub';
import { SynthContext } from '../common/modules/synth';
import { InputControllerContext } from '../common/modules/input-controller';
import { MidiControllerContext } from '../common/modules/midi-controller';
import { FilterContext } from '../filter/modules/filter';
import { FxContext } from '../fx/modules/fx';
import { CC_INTERVAL, MidiLearnModelContext } from '../common/midi-learn/midi-learn';
import { Oscillator1, Oscillator2, MasterHandle } from '../synth/components';
import { SubSection } from '../sub';
import { NoiseSection } from '../noise';
import { FilterSection } from '../filter';
import { EnvelopeSection, VelocitySection } from '../envelope';
import { LfoSection } from '../lfo';
import { MacrosSection } from '../macros';
import { VoicingSection } from '../voicing';
import { PitchBend } from '../pitch-bend/pitch-bend';
import { FxPanel } from '../fx/components/fx-panel';
import { MidiLearnLayer } from './midi-learn-layer';

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

// the sections of the synth on the models of MIDI Learn (and of a MIDI input when the spec gives one)
const setup = async ({ midi = true } = {}) => {
  if (midi) provideMidiAccess(createMidiAccess([createMidiInput('a')]));
  const modules = createMidiLearn();
  await flush();
  // (each model in the context of its own)
  const contexts = [
    [SynthCoreContext, modules.synthCore],
    [TransportContext, modules.transport],
    [InputControllerContext, modules.inputController],
    [EnvelopesContext, modules.envelopes],
    [LfoContext, modules.lfos],
    [ModulationContext, modules.modulation],
    [Oscillator1Context, modules.osc1],
    [Oscillator2Context, modules.osc2],
    [NoiseContext, modules.noise],
    [SubContext, modules.sub],
    [FilterContext, modules.filter],
    [SynthContext, modules.synth],
    [FxContext, modules.fx],
    [MidiControllerContext, modules.midi],
    [MidiLearnModelContext, modules.learn],
  ] as unknown as [React.Context<unknown>, unknown][];
  const sections = (
    <MidiLearnLayer>
      <Oscillator1 />
      <Oscillator2 />
      <SubSection />
      <NoiseSection />
      <FilterSection />
      <EnvelopeSection />
      <VelocitySection />
      <LfoSection />
      <MacrosSection />
      <VoicingSection />
      <PitchBend />
      <MasterHandle />
      {FX_TYPES.map((type) => (
        <FxPanel key={type} type={type} />
      ))}
    </MidiLearnLayer>
  );
  const ui = contexts.reduceRight<React.ReactNode>(
    (children, [Context, value]) => <Context.Provider value={value}>{children}</Context.Provider>,
    sections
  );
  const { wrapper: Queries } = queryWrapper();
  const result = render(
    <Queries>
      <AppProvider initial={{}}>{ui}</AppProvider>
    </Queries>
  );
  const [learnModel, learnActions] = modules.learn;
  const control = (id: string) => {
    const found = document.querySelector(`[${MIDI_TARGET_ATTR}='${id}']`);
    if (!found) throw new Error(`no control ${id}`);
    return found as HTMLElement;
  };
  const cc = (number: number, value: number) =>
    act(() => {
      modules.midi[0].$cc.next({ cc: number, value });
      jest.advanceTimersByTime(CC_INTERVAL);
    });
  return { ...modules, ...result, learnModel, learnActions, control, cc };
};

beforeEach(() => jest.useFakeTimers({ doNotFake: ['performance', 'setTimeout'] }));
afterEach(() => {
  jest.useRealTimers();
  removeMidiAccess();
});

describe('MidiLearnLayer', () => {
  it('gives every control of the sections an id of a control of the registry, the controls of the registry one', async () => {
    const { learnModel } = await setup();
    const shown = new Set(
      [...document.querySelectorAll(`[${MIDI_TARGET_ATTR}]`)].map((element) =>
        element.getAttribute(MIDI_TARGET_ATTR)
      )
    );
    const ids = [...learnModel.targets.keys()];
    expect([...shown].filter((id) => !id || !learnModel.targets.has(id))).toEqual([]);
    // the sections show ENV 1 and LFO 1, the compressor its one band, the filter (a lowpass) no Drive nor Var
    const stateful = [
      'compressor.below',
      'compressor.xlow',
      'compressor.xhigh',
      'compressor.low',
      'compressor.mid',
      'compressor.high',
      'filter.drive',
      'filter.var',
    ];
    const hidden = (id: string) => /^(env[23]|lfo[234])\./.test(id) || stateful.includes(id);
    expect(ids.filter((id) => !hidden(id) && !shown.has(id))).toEqual([]);
  });

  it('opens the menu of a knob with MIDI Learn: it waits for a CC, Escape ends it', async () => {
    const { learnModel, control } = await setup();
    fireEvent.contextMenu(control('filter.cutoff'));
    fireEvent.click(screen.getByRole('button', { name: 'MIDI Learn' }));
    expect(learnModel.$learning.value).toEqual({ target: 'filter.cutoff', via: 'menu' });
    expect(control('filter.cutoff').hasAttribute('data-midi-waiting')).toBe(true);
    expect(toast).toHaveBeenCalledWith('Move a control on your MIDI device', expect.anything());
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(learnModel.$learning.value).toBeNull();
    expect(control('filter.cutoff').hasAttribute('data-midi-waiting')).toBe(false);
  });

  it('Cancel MIDI Learn of the menu ends the wait and closes the menu (its press is not out of the control)', async () => {
    const { learnModel, control } = await setup();
    fireEvent.contextMenu(control('filter.cutoff'));
    fireEvent.click(screen.getByRole('button', { name: 'MIDI Learn' }));
    fireEvent.contextMenu(control('filter.cutoff'));
    const item = screen.getByRole('button', { name: 'Cancel MIDI Learn' });
    fireEvent.pointerDown(item);
    expect(learnModel.$learning.value?.target).toBe('filter.cutoff');
    fireEvent.mouseDown(item);
    fireEvent.click(item);
    expect(learnModel.$learning.value).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a press out of the control waiting ends the wait', async () => {
    const { learnModel, learnActions, control } = await setup();
    act(() => learnActions.learn('osc1.gain'));
    fireEvent.pointerDown(control('osc1.gain'));
    expect(learnModel.$learning.value?.target).toBe('osc1.gain');
    fireEvent.pointerDown(document.body);
    expect(learnModel.$learning.value).toBeNull();
  });

  it('binds the CC, shows it in the menu, removes it there', async () => {
    const { learnModel, learnActions, control, cc } = await setup();
    act(() => learnActions.learn('filter.cutoff'));
    cc(74, 64);
    expect(control('filter.cutoff').getAttribute('data-midi-cc')).toBe('74');
    fireEvent.contextMenu(control('filter.cutoff'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove MIDI CC 74' }));
    expect(learnModel.$bindings.value[74]).toBeUndefined();
    expect(control('filter.cutoff').hasAttribute('data-midi-cc')).toBe(false);
  });

  it('opens a menu of its own on a right click of a switch or a choice', async () => {
    const { learnModel, control } = await setup();
    const event = fireEvent.contextMenu(control('osc2.on'));
    expect(event).toBe(false);
    const menu = screen.getByRole('menu', { name: 'Osc 2' });
    expect(menu.textContent).toContain('Off');
    fireEvent.click(screen.getByRole('button', { name: 'MIDI Learn' }));
    expect(learnModel.$learning.value?.target).toBe('osc2.on');
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.contextMenu(control('delay.mode'));
    expect(screen.getByRole('menu', { name: 'Delay Mode' }).textContent).toContain('Normal');
  });

  it('leaves the right click of anything else to the browser', async () => {
    await setup();
    expect(fireEvent.contextMenu(document.body)).toBe(true);
  });

  it('disables MIDI Learn without MIDI', async () => {
    const { control } = await setup({ midi: false });
    fireEvent.contextMenu(control('filter.cutoff'));
    const item = screen.getByRole('button', { name: /MIDI Learn/ });
    expect(item).toBeDisabled();
    expect(item.textContent).toContain('No MIDI input');
  });

  it('in the Learn mode outlines the controls, a press chooses one and moves nothing, Escape leaves it', async () => {
    const { learnModel, learnActions, control, filter, osc2 } = await setup();
    act(() => learnActions.setLearnMode(true));
    expect(document.body.classList.contains(MIDI_LEARN_CLASS)).toBe(true);
    const cutoff = filter[0].$filter.value.cutoff;
    fireEvent.pointerDown(control('filter.cutoff'), { button: 0, clientY: 100 });
    fireEvent.pointerMove(document, { clientY: 0 });
    fireEvent.pointerUp(document);
    expect(learnModel.$learning.value).toEqual({ target: 'filter.cutoff', via: 'mode' });
    expect(filter[0].$filter.value.cutoff).toBe(cutoff);

    // a switch: chosen, not switched
    fireEvent.pointerDown(control('osc2.on'), { button: 0 });
    fireEvent.click(control('osc2.on'));
    expect(learnModel.$learning.value?.target).toBe('osc2.on');
    expect(osc2[0].$active.value).toBe(false);

    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(learnModel.$learning.value).toBeNull();
    expect(learnModel.$learnMode.value).toBe(true);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(learnModel.$learnMode.value).toBe(false);
    expect(document.body.classList.contains(MIDI_LEARN_CLASS)).toBe(false);
  });

  it('in the Learn mode a key on a control chooses it and moves nothing (Enter, Space), Tab moves on', async () => {
    const { learnModel, learnActions, control, osc2 } = await setup();
    act(() => learnActions.setLearnMode(true));
    const key = (id: string, name: string) => {
      const down = fireEvent.keyDown(control(id), { key: name });
      fireEvent.keyUp(control(id), { key: name });
      return down;
    };
    expect(key('osc2.on', ' ')).toBe(false);
    expect(learnModel.$learning.value).toEqual({ target: 'osc2.on', via: 'mode' });
    expect(osc2[0].$active.value).toBe(false);
    expect(key('filter.cutoff', 'ArrowUp')).toBe(false);
    expect(learnModel.$learning.value?.target).toBe('osc2.on');
    expect(key('filter.cutoff', 'Enter')).toBe(false);
    expect(learnModel.$learning.value?.target).toBe('filter.cutoff');
    expect(key('filter.cutoff', 'Tab')).toBe(true);
    // a key of QWERTY on a control is a note: its press and its release reach the document
    const reached: string[] = [];
    const listen = (e: KeyboardEvent) => reached.push(`${e.type} ${e.code}`);
    document.addEventListener('keydown', listen);
    document.addEventListener('keyup', listen);
    expect(fireEvent.keyDown(control('filter.cutoff'), { key: 'a', code: 'KeyA' })).toBe(true);
    fireEvent.keyUp(control('osc2.on'), { key: 'a', code: 'KeyA' });
    document.removeEventListener('keydown', listen);
    document.removeEventListener('keyup', listen);
    expect(reached).toEqual(['keydown KeyA', 'keyup KeyA']);
    expect(learnModel.$learning.value?.target).toBe('filter.cutoff');
    // out of the Learn mode the keys are the control's
    act(() => learnActions.setLearnMode(false));
    expect(key('osc2.on', 'ArrowUp')).toBe(true);
  });

  it('the menu of a switch bound tells whether a press of its CC toggles it, and changes it', async () => {
    const { learnModel, learnActions, control, cc } = await setup();
    act(() => learnActions.learn('osc2.on'));
    cc(80, 127);
    fireEvent.contextMenu(control('osc2.on'));
    fireEvent.click(screen.getByRole('button', { name: 'CC 80: toggle on press' }));
    expect(learnModel.$toggles.value.has('osc2.on')).toBe(true);
    fireEvent.contextMenu(control('osc2.on'));
    fireEvent.click(screen.getByRole('button', { name: 'CC 80: on/off by value' }));
    expect(learnModel.$toggles.value.has('osc2.on')).toBe(false);
    // a knob has no such item
    act(() => learnActions.learn('filter.cutoff'));
    cc(74, 64);
    fireEvent.contextMenu(control('filter.cutoff'));
    expect(screen.queryByRole('button', { name: /toggle on press/ })).toBeNull();
  });

  it('shows where the controller is on a knob that waits for it (Pickup)', async () => {
    const { learnActions, filter, cc } = await setup();
    act(() => {
      learnActions.setTakeover('pickup');
      learnActions.learn('filter.cutoff');
    });
    expect(screen.queryAllByTestId('pickup-mark')).toHaveLength(0);
    cc(74, 127);
    expect(filter[0].$filter.value.cutoff).not.toBe(22050);
    expect(screen.getAllByTestId('pickup-mark')).toHaveLength(1);
  });
});
