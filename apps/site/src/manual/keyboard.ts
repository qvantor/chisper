// The notes of the computer keyboard in the synth: a copy of `keyboardToNotes` of
// apps/chisper/src/app/synth/common/modules/keyboard-controller.ts (tests/manual.test.mjs holds them equal). A key
// is its physical place (KeyboardEvent.code): the same places play on AZERTY or QWERTZ; the legends are QWERTY's,
// QWERTZ's on the German pages and a Spanish keyboard's on the Spanish ones (the readers' keyboards: Y where
// QWERTY has Z, Ñ where it has the semicolon).
import type { Lang } from '../i18n/locales.ts';

type Note = [octave: number, name: string];

const KEY_NOTES: Record<string, Note> = {
  KeyZ: [0, 'C'],
  KeyS: [0, 'C#'],
  KeyX: [0, 'D'],
  KeyD: [0, 'D#'],
  KeyC: [0, 'E'],
  KeyV: [0, 'F'],
  KeyG: [0, 'F#'],
  KeyB: [0, 'G'],
  KeyH: [0, 'G#'],
  KeyN: [0, 'A'],
  KeyJ: [0, 'A#'],
  KeyM: [0, 'B'],

  Comma: [1, 'C'],
  KeyL: [1, 'C#'],
  Period: [1, 'D'],
  Semicolon: [1, 'D#'],
  Slash: [1, 'E'],

  KeyQ: [1, 'C'],
  Digit2: [1, 'C#'],
  KeyW: [1, 'D'],
  Digit3: [1, 'D#'],
  KeyE: [1, 'E'],
  KeyR: [1, 'F'],
  Digit5: [1, 'F#'],
  KeyT: [1, 'G'],
  Digit6: [1, 'G#'],
  KeyY: [1, 'A'],
  Digit7: [1, 'A#'],
  KeyU: [1, 'B'],

  KeyI: [2, 'C'],
  Digit9: [2, 'C#'],
  KeyO: [2, 'D'],
  Digit0: [2, 'D#'],
  KeyP: [2, 'E'],
  BracketLeft: [2, 'F'],
  Equal: [2, 'F#'],
  BracketRight: [2, 'G'],
};

// the octave of the bottom row by default (Z = C3)
const DEFAULT_OCTAVE = 3;

// the four rows of letters and digits, each with the QWERTY legend of its keys
export const ROWS: [code: string, legend: string][][] = [
  [
    ['Digit1', '1'],
    ['Digit2', '2'],
    ['Digit3', '3'],
    ['Digit4', '4'],
    ['Digit5', '5'],
    ['Digit6', '6'],
    ['Digit7', '7'],
    ['Digit8', '8'],
    ['Digit9', '9'],
    ['Digit0', '0'],
    ['Minus', '-'],
    ['Equal', '='],
  ],
  [
    ['KeyQ', 'Q'],
    ['KeyW', 'W'],
    ['KeyE', 'E'],
    ['KeyR', 'R'],
    ['KeyT', 'T'],
    ['KeyY', 'Y'],
    ['KeyU', 'U'],
    ['KeyI', 'I'],
    ['KeyO', 'O'],
    ['KeyP', 'P'],
    ['BracketLeft', '['],
    ['BracketRight', ']'],
  ],
  [
    ['KeyA', 'A'],
    ['KeyS', 'S'],
    ['KeyD', 'D'],
    ['KeyF', 'F'],
    ['KeyG', 'G'],
    ['KeyH', 'H'],
    ['KeyJ', 'J'],
    ['KeyK', 'K'],
    ['KeyL', 'L'],
    ['Semicolon', ';'],
    ['Quote', "'"],
  ],
  [
    ['KeyZ', 'Z'],
    ['KeyX', 'X'],
    ['KeyC', 'C'],
    ['KeyV', 'V'],
    ['KeyB', 'B'],
    ['KeyN', 'N'],
    ['KeyM', 'M'],
    ['Comma', ','],
    ['Period', '.'],
    ['Slash', '/'],
  ],
];

// the legends of a German keyboard where they differ from QWERTY's
const QWERTZ: Record<string, string> = {
  Minus: 'ß',
  Equal: '´',
  KeyY: 'Z',
  BracketLeft: 'Ü',
  BracketRight: '+',
  Semicolon: 'Ö',
  Quote: 'Ä',
  KeyZ: 'Y',
  Slash: '-',
};

// the legends of a Spanish keyboard (Spain's: the pages say «ordenador») where they differ from QWERTY's; a Latin
// American one has ´ on BracketLeft and ¿ on Equal, which the text of the page says
const SPANISH: Record<string, string> = {
  Minus: "'",
  Equal: '¡',
  BracketLeft: '`',
  BracketRight: '+',
  Semicolon: 'Ñ',
  Quote: '´',
  Slash: '-',
};

const LEGENDS: Partial<Record<Lang, Record<string, string>>> = { de: QWERTZ, es: SPANISH };

// the legend of a key on the keyboards of the readers of a language
export const legendOf = (code: string, legend: string, lang: Lang) => LEGENDS[lang]?.[code] ?? legend;

// the note a key plays at the default octave (`C#4`), if it plays one
export const noteOf = (code: string) => {
  const note = KEY_NOTES[code];
  return note && `${note[1]}${DEFAULT_OCTAVE + note[0]}`;
};
