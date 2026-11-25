import React from 'react';
import {
  CONTROL_MENU_ATTR,
  MenuPanel,
  MIDI_LEARN_CLASS,
  MIDI_TARGET_ATTR,
  MidiLearnApi,
  MidiLearnContext,
  MidiMenuActions,
  MidiMenuItem,
} from '@chisper/ui-kit';
import { useBehaviorSubject } from '@chisper/rxjs-react';
import { useMidiController } from '../common/modules';
import { MidiLearnModule, useMidiLearn } from '../common/midi-learn/midi-learn';
import { ChoiceTarget, SwitchTarget, targetText } from '../common/midi-learn/midi-targets';

// the control of MIDI Learn an event is on (its id), none: no control a CC moves
const targetOf = (event: Event) => {
  const element = event.target instanceof Element ? event.target.closest(`[${MIDI_TARGET_ATTR}]`) : null;
  const id = element?.getAttribute(MIDI_TARGET_ATTR);
  return element && id ? { element, id } : null;
};

// an event in a menu of a control (a portal: out of the box of its control)
const inMenu = (event: Event) =>
  event.target instanceof Element && event.target.closest(`[${CONTROL_MENU_ATTR}]`) !== null;

// the keys that act on a control (a knob steps, a key switches, a button is pressed); the others pass it: the notes
// of QWERTY play, a note held is let go
const CONTROL_KEYS = new Set([
  'Enter',
  ' ',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End',
]);

// the items of the menu of a control: MIDI Learn (Cancel MIDI Learn while it waits; without access to MIDI disabled),
// Remove MIDI CC n once it has one; a switch bound: whether a press of its CC toggles it (a button) or its value sets
// it (a fader, a DAW)
const menuItemsOf = (
  [{ $learning, $toggles, ccOf, isSwitch }, { learn, cancel, remove, setToggle }]: MidiLearnModule,
  access: () => boolean,
  target: string
): MidiMenuItem[] => {
  const cc = ccOf.get(target);
  const waiting = $learning.value?.target === target;
  const toggles = $toggles.value.has(target);
  return [
    waiting
      ? { id: 'cancel', label: 'Cancel MIDI Learn', onSelect: cancel }
      : {
          id: 'learn',
          label: 'MIDI Learn',
          disabled: !access(),
          ...(!access() && { detail: 'No MIDI input' }),
          onSelect: () => learn(target),
        },
    ...(cc === undefined
      ? []
      : [{ id: 'remove', label: `Remove MIDI CC ${cc}`, onSelect: () => remove(target) }]),
    ...(cc === undefined || !isSwitch(target)
      ? []
      : [
          {
            id: 'toggle',
            label: toggles ? `CC ${cc}: on/off by value` : `CC ${cc}: toggle on press`,
            onSelect: () => setToggle(target, !toggles),
          },
        ]),
  ];
};

// the menu of a switch or a choice (a knob has its own: the control menu of the kit), under the control
const SwitchMenu = ({
  module,
  access,
  control,
  anchor,
  onClose,
}: {
  module: MidiLearnModule;
  access: () => boolean;
  control: SwitchTarget | ChoiceTarget;
  anchor: DOMRect;
  onClose: () => void;
}) => (
  <MenuPanel anchor={anchor} onClose={onClose} name={control.name()} value={targetText(control)} role='menu'>
    <MidiMenuActions items={menuItemsOf(module, access, control.id)} onClose={onClose} />
  </MenuPanel>
);

// MIDI Learn on the screen: the controls of the kit take their marks and the items of their menus from the model; a
// right click on a switch or a choice (no menu of its own) opens its menu; a control waiting for a CC stops on Escape
// or a press out of it; in the Learn mode the controls are outlined (a class of the body), a press on one chooses it
// and moves nothing (the press stops before it, in the capture phase), Escape leaves the mode. The listeners of the
// document are there only while they are needed
export const MidiLearnLayer = ({ children }: React.PropsWithChildren) => {
  // (the model and its actions stay; the pair of them is new at every render)
  const [model, actions] = useMidiLearn();
  const { $learning, $learnMode, targets } = model;
  const { cancel, select, setLearnMode } = actions;
  const [{ $midiAccess }] = useMidiController();
  const learning = useBehaviorSubject($learning);
  const learnMode = useBehaviorSubject($learnMode);
  const [menu, setMenu] = React.useState<{ control: SwitchTarget | ChoiceTarget; anchor: DOMRect } | null>(
    null
  );
  const closeMenu = React.useCallback(() => setMenu(null), []);
  const access = React.useCallback(() => $midiAccess.value !== null, [$midiAccess]);

  const api = React.useMemo<MidiLearnApi>(
    () => ({
      mark: model.mark,
      subscribe: model.subscribe,
      menuItems: (target) => menuItemsOf([model, actions], access, target),
    }),
    [model, actions, access]
  );

  // the menu of a switch: a right click no menu took (the control menu of a knob prevents the default)
  React.useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      const found = targetOf(e);
      const control = found && targets.get(found.id);
      if (!found || !control || control.kind === 'knob') return;
      e.preventDefault();
      setMenu({ control, anchor: found.element.getBoundingClientRect() });
    };
    document.addEventListener('contextmenu', onContextMenu);
    return () => document.removeEventListener('contextmenu', onContextMenu);
  }, [targets]);

  // the outline of the controls in the Learn mode
  React.useEffect(() => {
    document.body.classList.toggle(MIDI_LEARN_CLASS, learnMode);
    return () => document.body.classList.remove(MIDI_LEARN_CLASS);
  }, [learnMode]);

  // Escape: no control waits, then no Learn mode
  React.useEffect(() => {
    if (!learning && !learnMode) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if ($learning.value) cancel();
      else setLearnMode(false);
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [learning, learnMode, $learning, cancel, setLearnMode]);

  // a control waiting from its menu: a press out of it ends the wait, not one in its menu (Cancel MIDI Learn: ended
  // at its press, the item was another one at its click)
  React.useEffect(() => {
    if (!learning || learning.via !== 'menu') return;
    const onPointerDown = (e: PointerEvent) => {
      if (!inMenu(e) && targetOf(e)?.id !== learning.target) cancel();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [learning, cancel]);

  // the Learn mode: a press on a control chooses it, nothing of the control gets it (a knob doesn't turn, a key
  // doesn't switch, its menu doesn't open), nor a key that acts on it (Enter or Space chooses it; the others, Tab and
  // Escape among them, as always); a press elsewhere is as always (the tabs of the LFOs, a scroll)
  React.useEffect(() => {
    if (!learnMode) return;
    const onPress = (e: Event) => {
      const found = targetOf(e);
      if (!found) return;
      e.stopPropagation();
      e.preventDefault();
      // (the main button, a finger)
      if (e.type === 'pointerdown' && !((e as PointerEvent).button > 0)) select(found.id);
    };
    const onKey = (e: KeyboardEvent) => {
      const found = targetOf(e);
      if (!found || !CONTROL_KEYS.has(e.key)) return;
      e.stopPropagation();
      e.preventDefault();
      if (e.type === 'keydown' && !e.repeat && (e.key === 'Enter' || e.key === ' ')) select(found.id);
    };
    const types = ['pointerdown', 'mousedown', 'click', 'dblclick', 'contextmenu'];
    const keys = ['keydown', 'keyup'] as const;
    types.forEach((type) => document.addEventListener(type, onPress, true));
    keys.forEach((type) => document.addEventListener(type, onKey, true));
    return () => {
      types.forEach((type) => document.removeEventListener(type, onPress, true));
      keys.forEach((type) => document.removeEventListener(type, onKey, true));
    };
  }, [learnMode, select]);

  return (
    <MidiLearnContext.Provider value={api}>
      {children}
      {menu && (
        <SwitchMenu
          module={[model, actions]}
          access={access}
          control={menu.control}
          anchor={menu.anchor}
          onClose={closeMenu}
        />
      )}
    </MidiLearnContext.Provider>
  );
};
