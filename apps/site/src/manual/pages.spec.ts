import { LANGS } from '../i18n/locales';
import {
  HUBS,
  MANUAL_PAGES,
  PAGE_GROUPS,
  SECTIONS,
  SECTION_BASE,
  SECTION_PAGES,
  SLUGS,
  alternatesOf,
  isSitePage,
  langOf,
  neighbours,
  pagePath,
  pagePaths,
  sectionOf,
} from './pages';

const PAGES = SECTIONS.flatMap((section) => SECTION_PAGES[section]);

describe('the pages of the manual and of Learn', () => {
  it('have a path of their own in every language, under the folder of their section', () => {
    expect(pagePath('getting-started', 'en')).toBe('/manual/getting-started/');
    expect(pagePath('modulation', 'es')).toBe('/es/manual/modulacion-envolventes-lfo/');
    expect(pagePath('midi', 'de')).toBe('/de/anleitung/midi-keyboard/');
    expect(pagePath('wavetable-synthesis', 'en')).toBe('/learn/what-is-wavetable-synthesis/');
    expect(pagePath('wavetable-synthesis', 'es')).toBe('/es/aprende/que-es-la-sintesis-wavetable/');
    expect(pagePath('wavetable-synthesis', 'de')).toBe('/de/lernen/was-ist-wavetable-synthese/');
    const paths = PAGES.flatMap((page) => LANGS.map((lang) => pagePath(page, lang)));
    expect(new Set(paths).size).toBe(paths.length);
    for (const page of PAGES)
      for (const lang of LANGS) {
        expect(pagePath(page, lang).startsWith(SECTION_BASE[sectionOf(page)][lang])).toBe(true);
        expect(SLUGS[page][lang]).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      }
  });

  it('belong to one section each, with the hub of a section in it', () => {
    expect(PAGES).toHaveLength(new Set(PAGES).size);
    for (const section of SECTIONS) {
      expect(SECTION_PAGES[section].every((page) => sectionOf(page) === section)).toBe(true);
      expect(SECTION_PAGES[section]).toContain(HUBS[section]);
      expect(isSitePage(section, HUBS[section])).toBe(true);
    }
    expect(isSitePage('manual', 'wavetable-synthesis')).toBe(false);
    expect(isSitePage('learn', 'midi')).toBe(false);
    expect(isSitePage('learn', 'nothing')).toBe(false);
    // the folders of the sections are apart in every language
    for (const lang of LANGS) expect(SECTION_BASE.manual[lang]).not.toBe(SECTION_BASE.learn[lang]);
  });

  it('go in the order of the nav of their section, each between the one before and after it', () => {
    expect(neighbours('getting-started')).toEqual({ prev: undefined, next: 'modulation' });
    expect(neighbours('wavetables')).toEqual({ prev: 'modulation', next: 'midi' });
    expect(neighbours('midi')).toEqual({ prev: 'wavetables', next: undefined });
    // a page of Learn has none of the manual beside it
    expect(neighbours('wavetable-synthesis')).toEqual({ prev: undefined, next: undefined });
  });

  it('are grouped with their translations, as the landing is', () => {
    expect(PAGE_GROUPS).toHaveLength(1 + MANUAL_PAGES.length + SECTION_PAGES.learn.length);
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
    expect(alternatesOf('https://chisper.qvantor.org/de/lernen/was-ist-wavetable-synthese/')).toEqual({
      en: 'https://chisper.qvantor.org/learn/what-is-wavetable-synthesis/',
      es: 'https://chisper.qvantor.org/es/aprende/que-es-la-sintesis-wavetable/',
      de: 'https://chisper.qvantor.org/de/lernen/was-ist-wavetable-synthese/',
    });
    expect(alternatesOf('https://chisper.qvantor.org/de/wavetable-synthesizer/')?.en).toBe(
      'https://chisper.qvantor.org/wavetable-synth/'
    );
    // the synth and anything else is no group
    expect(alternatesOf('https://chisper.qvantor.org/')).toBeUndefined();
    expect(pagePaths('wavetables')).toEqual({
      en: '/manual/wavetables/',
      es: '/es/manual/wavetables/',
      de: '/de/anleitung/wavetables/',
    });
  });

  it('know the language of a path by its prefix', () => {
    expect(langOf('/manual/wavetables/')).toBe('en');
    expect(langOf('/es/manual/wavetables/')).toBe('es');
    expect(langOf('/de/anleitung/wavetables/')).toBe('de');
    expect(langOf('/learn/what-is-wavetable-synthesis/')).toBe('en');
    expect(langOf('/es/aprende/que-es-la-sintesis-wavetable/')).toBe('es');
    expect(langOf('/de/lernen/was-ist-wavetable-synthese/')).toBe('de');
    expect(langOf('/design/')).toBe('en');
  });
});
