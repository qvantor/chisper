import React from 'react';
import { ModeOption, ModePlate } from '@chisper/ui-kit';
import { useBehaviorSubject } from '@chisper/rxjs-react';
import { WARP_MODES, WarpMode as WarpModeId } from '@chisper/preset-schema';
import { useOscillatorContext } from '../hooks';
import { WarpModeIcon } from './warp-mode-icons';

interface WarpLook {
  label: string;
  // what it does to the frame
  hint: string;
  // the knobs its glyph draws it at: the first bold, a second faint (Bend +/-: both ways)
  knobs: [number, number?];
}

// the modes of the Warp as the plate and its menu show them (WARP_MODES, by index). PWM at 0.375 reaches the top of
// its glyph on a step (40 of 64): its edge straight up and down
const WARP_LOOKS: Record<WarpModeId, WarpLook> = {
  off: { label: 'Off', hint: 'The frame as it is', knobs: [0] },
  'bend+': {
    label: 'Bend +',
    hint: 'Squeezes the middle of the frame, stretches its start and its end',
    knobs: [0.85],
  },
  'bend-': {
    label: 'Bend -',
    hint: 'Squeezes the start and the end of the frame, stretches its middle',
    knobs: [0.85],
  },
  'bend+-': {
    label: 'Bend +/-',
    hint: 'The frame as it is at 50%: Bend + under it, Bend - over it',
    knobs: [0.05, 0.95],
  },
  pwm: { label: 'PWM', hint: 'Squeezes the frame to the left, as a pulse narrows', knobs: [0.375] },
};

// the labels of the modes by index (a CC of MIDI Learn chooses among them)
export const WARP_MODE_LABELS = WARP_MODES.map((id) => WARP_LOOKS[id].label);

const OPTIONS: ModeOption<number>[] = WARP_MODES.map((id, index) => {
  const { knobs, ...look } = WARP_LOOKS[id];
  return { id: index, ...look, icon: <WarpModeIcon mode={index} knobs={knobs} />, off: id === 'off' };
});

interface Props {
  // a narrow oscillator: the glyph alone
  compact: boolean;
  // the prefix of the ids of the oscillator (osc1.warpMode)
  target: 'osc1' | 'osc2';
}

// the mode of the Warp on a plate right of its knob: its glyph and its name, a press lists the modes; it renders on
// the mode
export const WarpMode = ({ compact, target }: Props) => {
  const [{ $warpMode }, { setWarpMode }] = useOscillatorContext();
  const mode = useBehaviorSubject($warpMode);
  return (
    <ModePlate
      name='Warp mode'
      hint='How the Warp knob reshapes the frame'
      options={OPTIONS}
      value={mode}
      onChange={setWarpMode}
      compact={compact}
      midiTarget={`${target}.warpMode`}
    />
  );
};
