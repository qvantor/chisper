// The articles of the site beside the landing, in two sections: the manual (how to use Chisper) and Learn (what a
// synth does, for a reader who may not know Chisper yet). A page has an id, the same in every language (its text is
// src/content/<section>/<lang>/<id>.mdx), a path of its own in each language (written for the searches of that
// language, as the landing), and its place in the nav of its section (also the order of prev/next). The landing and
// the pages are the groups of versions the head and the sitemap link to each other.
import { DEFAULT_LANG, LANGS, LOCALES, absolute, type Lang } from '../i18n/locales.ts';

export const MANUAL_PAGES = ['getting-started', 'modulation', 'wavetables', 'midi'] as const;
export const LEARN_PAGES = ['wavetable-synthesis'] as const;
export type ManualPage = (typeof MANUAL_PAGES)[number];
export type LearnPage = (typeof LEARN_PAGES)[number];
export type SitePage = ManualPage | LearnPage;

export const SECTIONS = ['manual', 'learn'] as const;
export type Section = (typeof SECTIONS)[number];

export const SECTION_PAGES: Record<Section, readonly SitePage[]> = {
  manual: MANUAL_PAGES,
  learn: LEARN_PAGES,
};

const SECTION_OF = Object.fromEntries(
  SECTIONS.flatMap((section) => SECTION_PAGES[section].map((page) => [page, section]))
) as Record<SitePage, Section>;

export const sectionOf = (page: SitePage) => SECTION_OF[page];

// a page of a section by its id (the id of a text file), if there is one
export const isSitePage = (section: Section, id: string): id is SitePage =>
  (SECTION_PAGES[section] as readonly string[]).includes(id);

// the folder of each section in each language
export const SECTION_BASE: Record<Section, Record<Lang, string>> = {
  manual: { en: '/manual/', es: '/es/manual/', de: '/de/anleitung/' },
  learn: { en: '/learn/', es: '/es/aprende/', de: '/de/lernen/' },
};

// the slug of each page in each language (a language missing is a type error)
export const SLUGS: Record<SitePage, Record<Lang, string>> = {
  'getting-started': { en: 'getting-started', es: 'primeros-pasos', de: 'erste-schritte' },
  modulation: {
    en: 'modulation-envelopes-lfo',
    es: 'modulacion-envolventes-lfo',
    de: 'modulation-huellkurven-lfo',
  },
  wavetables: { en: 'wavetables', es: 'wavetables', de: 'wavetables' },
  midi: { en: 'midi-keyboard-setup', es: 'teclado-midi', de: 'midi-keyboard' },
  'wavetable-synthesis': {
    en: 'what-is-wavetable-synthesis',
    es: 'que-es-la-sintesis-wavetable',
    de: 'was-ist-wavetable-synthese',
  },
};

// the hub of each section, the page its name links to (breadcrumbs, header, footer, the synth): the folder of a
// section has no page of its own, it opens its hub (netlify.toml)
export const HUBS: Record<Section, SitePage> = { manual: 'getting-started', learn: 'wavetable-synthesis' };

export const pagePath = (page: SitePage, lang: Lang) =>
  `${SECTION_BASE[sectionOf(page)][lang]}${SLUGS[page][lang]}/`;

const byLang = (path: (lang: Lang) => string) =>
  Object.fromEntries(LANGS.map((lang) => [lang, path(lang)])) as Record<Lang, string>;

// the path of a page in every language
export const pagePaths = (page: SitePage) => byLang((lang) => pagePath(page, lang));
export const LANDING_PATHS = byLang((lang) => LOCALES[lang].path);

// the pages before and after one in the nav of its section
export const neighbours = (page: SitePage) => {
  const pages = SECTION_PAGES[sectionOf(page)];
  const index = pages.indexOf(page);
  return { prev: pages[index - 1], next: pages[index + 1] };
};

// the versions of every page of the site, each a path per language: the landing, then the pages of the sections
export const PAGE_GROUPS: Record<Lang, string>[] = [
  LANDING_PATHS,
  ...SECTIONS.flatMap((section) => SECTION_PAGES[section].map(pagePaths)),
];

// the group of an absolute URL of the site (its versions as absolute URLs), if it is a page of one
export const alternatesOf = (url: string): Record<Lang, string> | undefined => {
  const group = PAGE_GROUPS.find((paths) => LANGS.some((lang) => absolute(paths[lang]) === url));
  return group && byLang((lang) => absolute(group[lang]));
};

// the language of a path of the site: its prefix (/es/, /de/), else the default
export const langOf = (pathname: string): Lang =>
  LANGS.find((lang) => lang !== DEFAULT_LANG && pathname.startsWith(`/${lang}/`)) ?? DEFAULT_LANG;
