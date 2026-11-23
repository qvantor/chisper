import React from 'react';
import { isTextInput } from '../../synth/common/modules/keyboard-controller';

// the arrows: a step back or on through the list
const STEPS: Record<string, 1 | -1> = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 };
// those that step from a field of a line too (the search: they move no caret in it)
const LINE_STEPS = new Set(['ArrowUp', 'ArrowDown']);

// the Report confirm of a row: its keys take Space
const inPopover = (target: EventTarget | null) =>
  target instanceof Element && target.closest('.ant-popover') !== null;

interface Keys {
  // Space: Play of the selected preset on or off
  onToggle: () => void;
  // an arrow: the preset after the selected one (1) or before it (-1)
  onStep: (direction: 1 | -1) => void;
}

// the keys of the presets browser while it is open (`on`), wherever the focus is in it: Space (never typed into a
// field) and the arrows (the up and down ones from the search too). Taken before the page (the Space of the track,
// the octave of the keyboard: they skip a key whose default is prevented) and a focused key of the dialog (Space
// doesn't press it); one step a press, not its auto-repeat (each step opens a sound)
export const useBrowserKeys = (on: boolean, { onToggle, onStep }: Keys) => {
  const keyDown = React.useEffectEvent((e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || inPopover(e.target)) return;
    const field = isTextInput(e.target);
    if (e.key === ' ') {
      if (field) return;
      e.preventDefault();
      if (!e.repeat) onToggle();
      return;
    }
    const direction = STEPS[e.key];
    if (!direction) return;
    if (field && !(LINE_STEPS.has(e.key) && e.target instanceof HTMLInputElement)) return;
    e.preventDefault();
    if (!e.repeat) onStep(direction);
  });

  React.useEffect(() => {
    if (!on) return;
    const down = (e: KeyboardEvent) => keyDown(e);
    // the release of a Space that played: a focused key isn't pressed by it
    const up = (e: KeyboardEvent) => {
      if (e.key === ' ' && !isTextInput(e.target) && !inPopover(e.target)) e.preventDefault();
    };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
    };
  }, [on]);
};
