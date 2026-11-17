// The promo pages (apps/site, built into dist/apps/site) into the folder of the synth (dist/apps/chisper), which
// Netlify publishes: after `nx build` (webpack empties the folder first) and `nx build site` (`npm run build`).
// The root, /assets/ and favicon.ico are the synth's, the pages and /_astro/ of the site; a file of the site the
// synth has with other contents fails the build rather than replacing it (the same bytes: merged before; a sitemap
// that differs by its <lastmod>s alone: merged and dated by lastmod.mjs before, which dates it again).
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { isMain } from './main.mjs';

const ROOT = join(import.meta.dirname, '../..');
const SITE = join(ROOT, 'dist/apps/site');
const SYNTH = join(ROOT, 'dist/apps/chisper');

// every file under a folder, relative to it
export const filesOf = (dir) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)));

const isSitemap = (file) => /^sitemap.*\.xml$/.test(basename(file));

// the contents of a file as merge compares them: a sitemap without its <lastmod>s
const contentsOf = (root, file) => {
  const bytes = readFileSync(join(root, file));
  return isSitemap(file)
    ? Buffer.from(bytes.toString('utf8').replace(/<lastmod>[^<]*<\/lastmod>/g, ''))
    : bytes;
};

export const merge = (site = SITE, synth = SYNTH) => {
  if (!existsSync(join(synth, 'index.html'))) throw new Error(`no build of the synth in ${synth}`);
  const files = filesOf(site);
  const taken = files.filter(
    (file) => existsSync(join(synth, file)) && !contentsOf(synth, file).equals(contentsOf(site, file))
  );
  if (taken.length) throw new Error(`files of the site the synth has too: ${taken.join(', ')}`);
  for (const file of files) {
    mkdirSync(dirname(join(synth, file)), { recursive: true });
    copyFileSync(join(site, file), join(synth, file));
  }
  return files.length;
};

if (isMain(import.meta)) {
  const count = merge();
  console.log(`site: ${count} files into ${relative(ROOT, SYNTH)}`);
}
