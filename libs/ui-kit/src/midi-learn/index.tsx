import React from 'react';
import { css } from 'styled-components';
import hexToRgba from 'hex-to-rgba';
import { theme } from '../common/constants';

// MIDI Learn as the controls take part in it: a control a CC may move has its id (`midiTarget`, on its box as
// MIDI_TARGET_ATTR), shows the CC bound to it in the Learn mode (a class of the body), its outline pulses while it
// waits for a CC, a knob in Pickup shows where the controller is while it waits for it; its menu (a right click, a
// long press) has the items of MIDI Learn. Without a provider (the specs of the kit) nothing of it

// what a control shows: the CC bound to it, whether it waits for one, and where the controller is while the knob
// waits for it (Pickup: a share of its travel; null: none)
export interface MidiMark {
  cc: number | null;
  waiting: boolean;
  pickup: number | null;
}

// an item of the menu of a control: MIDI Learn, Cancel MIDI Learn, Remove MIDI CC 74 (`detail` right of its label:
// why it is disabled)
export interface MidiMenuItem {
  id: string;
  label: string;
  detail?: string;
  disabled?: boolean;
  onSelect: () => void;
}

export interface MidiLearnApi {
  // the mark of a control (the same object while it doesn't change) and its listeners
  mark: (target: string) => MidiMark;
  subscribe: (target: string, listener: () => void) => () => void;
  // the items of the menu of a control
  menuItems: (target: string) => MidiMenuItem[];
}

export const MidiLearnContext = React.createContext<MidiLearnApi | null>(null);

// the attribute of a control a CC may move, the class of the body in the Learn mode
export const MIDI_TARGET_ATTR = 'data-midi-target';
export const MIDI_LEARN_CLASS = 'midi-learn';
// the attribute of a box that clips what is out of it (overflow: hidden: a plate of keys, a strip of values): the
// outline and the CC of a control in it, or of it, are drawn inside its box
export const MIDI_INSET_ATTR = 'data-midi-inset';
// (an attribute of data: the attributes of a box have none of their own)
export const midiInset = { [MIDI_INSET_ATTR]: '' } as React.HTMLAttributes<HTMLDivElement>;

const unsubscribed = () => undefined;
const noSubscription = () => unsubscribed;
const noMark = () => null;

// the mark of a control (null: none of MIDI Learn: no provider, no id); it renders only on a change of its own
export const useMidiMark = (target: string | undefined): MidiMark | null => {
  const api = React.useContext(MidiLearnContext);
  const subscribe = React.useMemo(
    () => (api && target ? (listener: () => void) => api.subscribe(target, listener) : noSubscription),
    [api, target]
  );
  const get = React.useMemo(() => (api && target ? () => api.mark(target) : noMark), [api, target]);
  return React.useSyncExternalStore(subscribe, get, get);
};

// the attributes of the box of a control a CC may move: its id, its CC, whether it waits
export const midiAttrs = (target: string | undefined, mark: MidiMark | null) =>
  target && mark
    ? {
        [MIDI_TARGET_ATTR]: target,
        ...(mark.cc !== null && { 'data-midi-cc': mark.cc }),
        ...(mark.waiting && { 'data-midi-waiting': '' }),
      }
    : {};

// the attributes of a control (useMidiMark, midiAttrs)
export const useMidiAttrs = (target: string | undefined) => midiAttrs(target, useMidiMark(target));

const LEARN_COLOR = theme.colors.secondAccent;

// the look of the controls in MIDI Learn (GlobalStyle): in the Learn mode an outline around each, the CC bound to it
// over its corner; the outline of the one waiting pulses. In a box that clips (MIDI_INSET_ATTR) both inside its box
const INSET = `:is([${MIDI_INSET_ATTR}] [${MIDI_TARGET_ATTR}], [${MIDI_INSET_ATTR}][${MIDI_TARGET_ATTR}])`;
export const midiLearnStyle = css`
  @keyframes midi-learn-wait {
    from {
      outline-color: ${LEARN_COLOR};
    }
    to {
      outline-color: ${hexToRgba(LEARN_COLOR, 0.2)};
    }
  }

  body.${MIDI_LEARN_CLASS} [${MIDI_TARGET_ATTR}] {
    position: relative;
    outline: 1px dashed ${hexToRgba(LEARN_COLOR, 0.8)};
    outline-offset: 2px;
    cursor: pointer;
  }

  body.${MIDI_LEARN_CLASS} [${MIDI_TARGET_ATTR}][data-midi-cc]::after {
    content: 'CC ' attr(data-midi-cc);
    position: absolute;
    top: -8px;
    right: -6px;
    z-index: 4;
    padding: 0 3px;
    border-radius: 3px;
    background: ${LEARN_COLOR};
    color: ${theme.colors.white};
    font-size: 9px;
    font-weight: 700;
    line-height: 13px;
    white-space: nowrap;
    pointer-events: none;
  }

  /* (after the outline of the Learn mode, as specific: it wins) */
  body [${MIDI_TARGET_ATTR}][data-midi-waiting] {
    outline: 2px solid ${LEARN_COLOR};
    outline-offset: 2px;
    animation: midi-learn-wait 700ms ease-in-out infinite alternate;
  }

  body.${MIDI_LEARN_CLASS} ${INSET} {
    outline-offset: -1px;
  }

  body.${MIDI_LEARN_CLASS} ${INSET}[data-midi-cc]::after {
    top: 1px;
    right: 1px;
  }

  body ${INSET}[data-midi-waiting] {
    outline-offset: -2px;
  }
`;
