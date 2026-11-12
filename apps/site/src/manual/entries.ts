// The texts of the manual in a language: the entry of each page (a page without its text fails the build), the
// pages as the nav, the footer and the links to the manual name them
import { getCollection, type CollectionEntry } from 'astro:content';
import type { Lang } from '../i18n/locales';
import { MANUAL_PAGES, manualPath, type ManualPage } from './pages';

export const manualEntries = async (lang: Lang) => {
  const entries = await getCollection('manual', (entry) => entry.id.startsWith(`${lang}/`));
  return Object.fromEntries(
    MANUAL_PAGES.map((page) => {
      const entry = entries.find((candidate) => candidate.id === `${lang}/${page}`);
      if (!entry)
        throw new Error(
          `No text of the manual page ${page} in ${lang}: src/content/manual/${lang}/${page}.mdx`
        );
      return [page, entry];
    })
  ) as Record<ManualPage, CollectionEntry<'manual'>>;
};

// the pages in the order of the nav: the path and the name of each
export const manualNav = async (lang: Lang) => {
  const entries = await manualEntries(lang);
  return MANUAL_PAGES.map((id) => ({ id, href: manualPath(id, lang), name: entries[id].data.nav }));
};
