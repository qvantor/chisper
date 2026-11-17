import { SYNTH_URL, absolute, type Lang } from '../i18n/locales';
import { AUTHOR, appNode } from './json-ld';

export type Crumb = { name: string; path: string };

interface Article {
  lang: Lang;
  // the path of the page
  path: string;
  headline: string;
  description: string;
  updated: Date;
  // the paths of the picture of the page and of the screenshot of the synth
  image: string;
  screenshot: string;
  // from the site down to the page
  crumbs: Crumb[];
  // a page of the manual is a technical article about the synth; a page of Learn an article that mentions it
  kind?: 'TechArticle' | 'Article';
}

// the structured data of a page of the manual or of Learn: the synth, the page as an article of its language (about
// the synth, or mentioning it), and where it is in the site
export const manualJsonLd = ({
  lang,
  path,
  headline,
  description,
  updated,
  image,
  screenshot,
  crumbs,
  kind = 'TechArticle',
}: Article) => {
  const url = absolute(path);
  return {
    '@context': 'https://schema.org',
    '@graph': [
      appNode(screenshot),
      {
        '@type': kind,
        '@id': `${url}#article`,
        url,
        mainEntityOfPage: url,
        headline,
        description,
        inLanguage: lang,
        dateModified: updated.toISOString().slice(0, 10),
        image: absolute(image),
        author: AUTHOR,
        publisher: AUTHOR,
        [kind === 'TechArticle' ? 'about' : 'mentions']: { '@id': `${SYNTH_URL}#app` },
      },
      {
        '@type': 'BreadcrumbList',
        '@id': `${url}#breadcrumbs`,
        itemListElement: crumbs.map((crumb, index) => ({
          '@type': 'ListItem',
          position: index + 1,
          name: crumb.name,
          item: absolute(crumb.path),
        })),
      },
    ],
  };
};
