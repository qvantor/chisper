import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { SynthScreen } from '../screens';
import { MobileHeader } from './mobile-header';

// the preset, the settings and the master read the other models: not what these specs are about
jest.mock('../../presets', () => ({
  PresetSection: ({ className }: { className?: string }) => <div className={className} />,
}));
jest.mock('../settings', () => ({ MidiInput: () => null, SettingsButton: () => null }));
jest.mock('../synth/components', () => ({ MasterHandle: () => null }));

const setup = (portrait: boolean, screenId: SynthScreen = 'osc') => {
  const onScreenChange = jest.fn();
  render(
    <MobileHeader
      portrait={portrait}
      mode='keys'
      onModeChange={jest.fn()}
      screen={screenId}
      onScreenChange={onScreenChange}
    />
  );
  const key = (label: string) => screen.getByRole('button', { name: label });
  // the labels of the keys of the switch a key is in
  const switchOf = (label: string) =>
    [...(key(label).parentElement?.querySelectorAll('button') ?? [])].map((button) => button.textContent);
  const pressed = () =>
    ['OSC', 'FX', 'CLIP'].filter((label) => key(label).getAttribute('aria-pressed') === 'true');
  return { onScreenChange, key, switchOf, pressed };
};

describe('MobileHeader', () => {
  it('in landscape OSC, FX and CLIP are one switch', () => {
    const { switchOf, pressed } = setup(false);
    expect(switchOf('CLIP')).toEqual(['OSC', 'FX', 'CLIP']);
    expect(pressed()).toEqual(['OSC']);
  });

  it('in portrait CLIP is a key of its own, OSC and FX the switch under the logo', () => {
    const { switchOf, pressed } = setup(true);
    expect(switchOf('OSC')).toEqual(['OSC', 'FX']);
    expect(switchOf('CLIP')).toEqual(['CLIP']);
    expect(pressed()).toEqual(['OSC']);
  });

  it('in portrait the screens switch across both: CLIP lit releases OSC and FX', () => {
    const { onScreenChange, key, pressed } = setup(true, 'clip');
    expect(pressed()).toEqual(['CLIP']);
    fireEvent.click(key('FX'));
    expect(onScreenChange).toHaveBeenLastCalledWith('fx');
    fireEvent.click(key('OSC'));
    expect(onScreenChange).toHaveBeenLastCalledWith('osc');
  });

  it('in portrait CLIP opens the clip', () => {
    const { onScreenChange, key } = setup(true, 'fx');
    fireEvent.click(key('CLIP'));
    expect(onScreenChange).toHaveBeenCalledWith('clip');
  });
});
