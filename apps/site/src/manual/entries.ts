// The texts of a section in a language: the entry of each page (a page without its text fails the build), the
// pages as the nav, the footer and the links to the section name them
import { getCollection, type CollectionEntry } from 'astro:content';
import type { Lang } from '../i18n/locales';
import { SECTION_PAGES, pagePath, type Section, type SitePage } from './pages';

export const sectionEntries = async (section: Section, lang: Lang) => {
  const entries = (await getCollection(section)).filter((entry) => entry.id.startsWith(`${lang}/`));
  return Object.fromEntries(
    SECTION_PAGES[section].map((page) => {
      const entry = entries.find((candidate) => candidate.id === `${lang}/${page}`);
      if (!entry)
        throw new Error(`No text of the page ${page} in ${lang}: src/content/${section}/${lang}/${page}.mdx`);
      return [page, entry];
    })
  ) as Record<SitePage, CollectionEntry<'manual' | 'learn'>>;
};

// the pages of a section in the order of the nav: the path and the name of each
export const sectionNav = async (section: Section, lang: Lang) => {
  const entries = await sectionEntries(section, lang);
  return SECTION_PAGES[section].map((id) => ({
    id,
    href: pagePath(id, lang),
    name: entries[id].data.nav,
  }));
};
