// The <lastmod> of every page of the sitemap, after merge.mjs (the last step of `npm run build`): the time a deploy
// changed what the page says. Each page as built is compared with the page live (on the site of its <loc>): alike,
// it keeps the lastmod of the live sitemap; new, changed, or live without a lastmod, it takes the time of this build.
// Google trusts a lastmod that moves only with its page (it comes back to such a page soon after the sitemap says
// so) and ignores one that moves on every deploy, so pages are compared by what a reader and a crawler take from
// them (`significant`), not by their bytes: the names of the scripts of the synth change with every build of it.
// A live answer it can't read fails the build rather than date a page by a guess (the deploy before stays live).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { isMain } from './main.mjs';

const SYNTH = join(import.meta.dirname, '../../dist/apps/chisper');
const TIMEOUT = 30_000;

const collapse = (text) => text.replace(/\s+/g, ' ').trim();

// the text of a node, a space between its text nodes: the same with or without the whitespace a minifier takes from
// between two tags
const textOf = (node) =>
  node.nodeType === node.TEXT_NODE
    ? collapse(node.data)
    : [...node.childNodes].map(textOf).filter(Boolean).join(' ');

// what a page says: its title, description, robots, canonical and alternates, structured data, and the text, links
// and texts of the images of its <main> (the body without one); not its scripts, styles, other attributes,
// whitespace or navigation (the header and footer around <main>, a <nav> in it), which a new page of the site
// changes on every other page
export const significant = (html) => {
  const { document } = new JSDOM(html).window;
  const all = (selector) => [...document.querySelectorAll(selector)];
  const values = (selector, name) => all(selector).map((element) => element.getAttribute(name));
  const structured = all('script[type="application/ld+json"]').map((script) => {
    try {
      return JSON.stringify(JSON.parse(script.textContent));
    } catch {
      return collapse(script.textContent);
    }
  });
  for (const element of all('script, style, template')) element.remove();
  const content = document.querySelector('main') ?? document.body;
  for (const element of content?.querySelectorAll('nav') ?? []) element.remove();
  const within = (selector, name) =>
    [...(content?.querySelectorAll(selector) ?? [])].map((element) => element.getAttribute(name));
  return JSON.stringify({
    title: collapse(document.title),
    description: values('meta[name="description"]', 'content'),
    robots: values('meta[name="robots"]', 'content'),
    canonical: values('link[rel="canonical"]', 'href'),
    alternates: all('link[rel="alternate"][hreflang]').map(
      (link) => `${link.getAttribute('hreflang')} ${link.getAttribute('href')}`
    ),
    structured,
    text: content ? textOf(content) : '',
    links: within('a[href]', 'href'),
    images: within('img[alt]', 'alt'),
  });
};

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const LOC = /<loc>\s*([^<]*?)\s*<\/loc>/;
const LASTMOD = /<lastmod>\s*([^<]*?)\s*<\/lastmod>/;
const URL_ENTRY = /<url>([\s\S]*?)<\/url>/g;

const locOf = (entry) => entry.match(LOC)[1].replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => ENTITIES[name]);

// the sitemaps of an index
const sitemapsOf = (index) =>
  [...index.matchAll(/<sitemap>([\s\S]*?)<\/sitemap>/g)].map(([, entry]) => locOf(entry));

// the pages of a sitemap with their lastmods
const pagesOf = (sitemap) =>
  [...sitemap.matchAll(URL_ENTRY)].map(([, entry]) => ({
    loc: locOf(entry),
    lastmod: entry.match(LASTMOD)?.[1],
  }));

// a sitemap with the lastmods of its pages (by loc), each right after its <loc>, as the schema orders them
const withLastmods = (sitemap, lastmods) =>
  sitemap.replace(URL_ENTRY, (_, entry) => {
    const time = lastmods.get(locOf(entry));
    return `<url>${entry.replace(LASTMOD, '').replace(LOC, (loc) => `${loc}<lastmod>${time}</lastmod>`)}</url>`;
  });

// an answer of no page there yet
const isNone = (status) => status === 404 || status === 410 || (status >= 300 && status < 400);

// the body of a live URL; null where there is none yet (404, 410, a redirect); any other answer, or none, is asked
// again, then fails
export const fetchLive = async (url, { fetch = globalThis.fetch, attempts = 3, pause = 2000 } = {}) => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT) });
      if (response.status === 200) return await response.text();
      if (isNone(response.status)) return null;
      throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      if (attempt >= attempts) throw new Error(`${url}: ${error.message}`);
      await sleep(pause * attempt);
    }
  }
};

// the lastmods of the live sitemap (by loc), none before its first deploy
const liveLastmods = async (indexUrl, options) => {
  const index = await fetchLive(indexUrl, options);
  const sitemaps = await Promise.all(sitemapsOf(index ?? '').map((url) => fetchLive(url, options)));
  return new Map(
    sitemaps.flatMap((sitemap) => pagesOf(sitemap ?? '')).map((page) => [page.loc, page.lastmod])
  );
};

// the local file of a URL of the sitemap: a folder's index.html (`trailingSlash: 'always'` of the site, / the synth)
const fileOf = (dir, url) => {
  const { pathname } = new URL(url);
  const file = join(dir, decodeURIComponent(pathname), pathname.endsWith('/') ? 'index.html' : '');
  if (!existsSync(file)) throw new Error(`the sitemap names ${url}, not in ${dir}`);
  return file;
};

// dates the pages of the sitemaps of `dir`, the files written only once every page is compared; each page with its
// lastmod and why it took the time of this build (new, changed, undated), if it did
export const stamp = async (dir = SYNTH, { now = new Date(), ...options } = {}) => {
  const time = now.toISOString().replace(/\.\d+Z$/, 'Z');
  const sitemaps = sitemapsOf(readFileSync(join(dir, 'sitemap-index.xml'), 'utf8')).map((url) => {
    const file = fileOf(dir, url);
    return { url, file, xml: readFileSync(file, 'utf8') };
  });
  if (!sitemaps.length) throw new Error(`no sitemap in ${dir}/sitemap-index.xml`);
  const live = await liveLastmods(new URL('/sitemap-index.xml', sitemaps[0].url).href, options);
  const pages = await Promise.all(
    sitemaps
      .flatMap(({ xml }) => pagesOf(xml))
      .map(async ({ loc }) => {
        const built = significant(readFileSync(fileOf(dir, loc), 'utf8'));
        const html = await fetchLive(loc, options);
        const why =
          html === null ? 'new' : significant(html) !== built ? 'changed' : live.get(loc) ? null : 'undated';
        return { loc, lastmod: why ? time : live.get(loc), why };
      })
  );
  const lastmods = new Map(pages.map((page) => [page.loc, page.lastmod]));
  for (const { file, xml } of sitemaps) writeFileSync(file, withLastmods(xml, lastmods));
  return pages;
};

if (isMain(import.meta)) {
  const pages = await stamp();
  const dated = pages.filter((page) => page.why);
  console.log(`lastmod: ${dated.length} of ${pages.length} pages take the time of this build`);
  for (const { loc, why } of dated) console.log(`  ${why}: ${loc}`);
}
