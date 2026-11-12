// The pages of the manual: an id each, the same in every language (its text is src/content/manual/<lang>/<id>.mdx),
// a path of its own in each language (written for the searches of that language, as the landing), in the order of
// the nav (and of prev/next). The landing and the manual pages are the groups of versions the head and the sitemap
// link to each other.
import { DEFAULT_LANG, LANGS, LOCALES, absolute, type Lang } from '../i18n/locales.ts';

export const MANUAL_PAGES = ['getting-started', 'modulation', 'wavetables', 'midi'] as const;
export type ManualPage = (typeof MANUAL_PAGES)[number];

export const isManualPage = (id: string): id is ManualPage =>
  (MANUAL_PAGES as readonly string[]).includes(id);

// the folder of the manual in each language
export const MANUAL_BASE: Record<Lang, string> = { en: '/manual/', es: '/es/manual/', de: '/de/anleitung/' };

// the slug of each page in each language (a language missing is a type error)
export const SLUGS: Record<ManualPage, Record<Lang, string>> = {
  'getting-started': { en: 'getting-started', es: 'primeros-pasos', de: 'erste-schritte' },
  modulation: {
    en: 'modulation-envelopes-lfo',
    es: 'modulacion-envolventes-lfo',
    de: 'modulation-huellkurven-lfo',
  },
  wavetables: { en: 'wavetables', es: 'wavetables', de: 'wavetables' },
  midi: { en: 'midi-keyboard-setup', es: 'teclado-midi', de: 'midi-keyboard' },
};

// the hub of the manual, the page its name links to (breadcrumbs, header, footer, the synth)
export const MANUAL_HUB: ManualPage = 'getting-started';

export const manualPath = (page: ManualPage, lang: Lang) => `${MANUAL_BASE[lang]}${SLUGS[page][lang]}/`;

const byLang = (path: (lang: Lang) => string) =>
  Object.fromEntries(LANGS.map((lang) => [lang, path(lang)])) as Record<Lang, string>;

// the path of a page in every language
export const manualPaths = (page: ManualPage) => byLang((lang) => manualPath(page, lang));
export const LANDING_PATHS = byLang((lang) => LOCALES[lang].path);

// the pages before and after one in the nav
export const neighbours = (page: ManualPage) => {
  const index = MANUAL_PAGES.indexOf(page);
  return { prev: MANUAL_PAGES[index - 1], next: MANUAL_PAGES[index + 1] };
};

// the versions of every page of the site, each a path per language: the landing, then the pages of the manual
export const PAGE_GROUPS: Record<Lang, string>[] = [LANDING_PATHS, ...MANUAL_PAGES.map(manualPaths)];

// the group of an absolute URL of the site (its versions as absolute URLs), if it is a page of one
export const alternatesOf = (url: string): Record<Lang, string> | undefined => {
  const group = PAGE_GROUPS.find((paths) => LANGS.some((lang) => absolute(paths[lang]) === url));
  return group && byLang((lang) => absolute(group[lang]));
};

// the language of a path of the site: its prefix (/es/, /de/), else the default
export const langOf = (pathname: string): Lang =>
  LANGS.find((lang) => lang !== DEFAULT_LANG && pathname.startsWith(`/${lang}/`)) ?? DEFAULT_LANG;
