import { LANGS } from '../i18n/locales';
import {
  MANUAL_BASE,
  MANUAL_PAGES,
  PAGE_GROUPS,
  SLUGS,
  alternatesOf,
  langOf,
  manualPath,
  manualPaths,
  neighbours,
} from './pages';

describe('the pages of the manual', () => {
  it('have a path of their own in every language, under the folder of the language', () => {
    expect(manualPath('getting-started', 'en')).toBe('/manual/getting-started/');
    expect(manualPath('modulation', 'es')).toBe('/es/manual/modulacion-envolventes-lfo/');
    expect(manualPath('midi', 'de')).toBe('/de/anleitung/midi-keyboard/');
    const paths = MANUAL_PAGES.flatMap((page) => LANGS.map((lang) => manualPath(page, lang)));
    expect(new Set(paths).size).toBe(paths.length);
    for (const page of MANUAL_PAGES)
      for (const lang of LANGS) {
        expect(manualPath(page, lang).startsWith(MANUAL_BASE[lang])).toBe(true);
        expect(SLUGS[page][lang]).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      }
  });

  it('go in the order of the nav, each between the one before and after it', () => {
    expect(neighbours('getting-started')).toEqual({ prev: undefined, next: 'modulation' });
    expect(neighbours('wavetables')).toEqual({ prev: 'modulation', next: 'midi' });
    expect(neighbours('midi')).toEqual({ prev: 'wavetables', next: undefined });
  });

  it('are grouped with their translations, as the landing is', () => {
    expect(PAGE_GROUPS).toHaveLength(1 + MANUAL_PAGES.length);
    expect(PAGE_GROUPS[0]).toEqual({
      en: '/wavetable-synth/',
      es: '/es/sintetizador-wavetable/',
      de: '/de/wavetable-synthesizer/',
    });
    expect(alternatesOf('https://chisper.qvantor.org/es/manual/teclado-midi/')).toEqual({
      en: 'https://chisper.qvantor.org/manual/midi-keyboard-setup/',
      es: 'https://chisper.qvantor.org/es/manual/teclado-midi/',
      de: 'https://chisper.qvantor.org/de/anleitung/midi-keyboard/',
    });
    expect(alternatesOf('https://chisper.qvantor.org/de/wavetable-synthesizer/')?.en).toBe(
      'https://chisper.qvantor.org/wavetable-synth/'
    );
    // the synth and anything else is no group
    expect(alternatesOf('https://chisper.qvantor.org/')).toBeUndefined();
    expect(manualPaths('wavetables')).toEqual({
      en: '/manual/wavetables/',
      es: '/es/manual/wavetables/',
      de: '/de/anleitung/wavetables/',
    });
  });

  it('know the language of a path by its prefix', () => {
    expect(langOf('/manual/wavetables/')).toBe('en');
    expect(langOf('/es/manual/wavetables/')).toBe('es');
    expect(langOf('/de/anleitung/wavetables/')).toBe('de');
    expect(langOf('/design/')).toBe('en');
  });
});
