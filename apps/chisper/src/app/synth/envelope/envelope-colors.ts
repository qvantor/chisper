import { isMacro, MACROS, ModSource, normalizeName } from '@chisper/preset-schema';

// the color of each source of the modulation: its tab, and the arcs and the amount dots of the knobs it
// modulates. The envelopes green, blue and violet, the velocity gold, the LFOs rust, plum, cyan and pink: any two of
// them at least 18 apart in OKLab (×100) and 32° in hue, 9.7 for protanopia and deuteranopia, lightness 0.49..0.68
// (OKLCH; a few darker, a few lighter), dark enough for the white count in the dot of a tab (3:1 at least). The
// macros take dark tones, red, olive, navy and plum (twelve hues 32° apart don't fit in a circle): lightness
// 0.32..0.40, at least 16 apart from the others and 13 from one another
export const SOURCE_COLORS: Record<ModSource, string> = {
  env1: '#107350',
  env2: '#1663c7',
  env3: '#9c7ffc',
  velo: '#b69020',
  lfo1: '#b73611',
  lfo2: '#8e3690',
  lfo3: '#23a2bd',
  lfo4: '#eb608e',
  macro1: '#643a3a',
  macro2: '#273a04',
  macro3: '#162779',
  macro4: '#580451',
};

export const SOURCE_LABELS: Record<ModSource, string> = {
  env1: 'ENV 1',
  env2: 'ENV 2',
  env3: 'ENV 3',
  velo: 'VELO',
  lfo1: 'LFO 1',
  lfo2: 'LFO 2',
  lfo3: 'LFO 3',
  lfo4: 'LFO 4',
  macro1: 'MACRO 1',
  macro2: 'MACRO 2',
  macro3: 'MACRO 3',
  macro4: 'MACRO 4',
};

// the label of a source: the name a macro was given (its names in the order of MACROS), else its own (MACRO 1)
export const sourceLabel = (source: ModSource, macroNames: readonly string[]) =>
  (isMacro(source) && normalizeName(macroNames[MACROS.indexOf(source)] ?? '')) || SOURCE_LABELS[source];
