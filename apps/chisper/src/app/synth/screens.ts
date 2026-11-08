// the screens of the synth: its sounds (osc), the effects (fx); on a phone the clip of the track too (the desktop
// shows it right of the keys, its roll over the synth)
export type SynthScreen = 'osc' | 'fx' | 'clip';

export const SYNTH_SCREENS: { id: SynthScreen; label: string }[] = [
  { id: 'osc', label: 'OSC' },
  { id: 'fx', label: 'FX' },
];

export const CLIP_SCREEN: { id: SynthScreen; label: string } = { id: 'clip', label: 'CLIP' };

export const MOBILE_SCREENS: { id: SynthScreen; label: string }[] = [...SYNTH_SCREENS, CLIP_SCREEN];

// the desktop has no screen of the clip: the sounds (a phone turned into a desktop on it)
export const desktopScreen = (screen: SynthScreen): SynthScreen => (screen === 'clip' ? 'osc' : screen);
