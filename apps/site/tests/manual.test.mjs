// The pages of the manual as built (`nx run site:verify` builds them first): what a crawler without JS gets from
// each page in each language, the links between them, their structured data and the facts they show that the synth
// holds too (the notes of its computer keyboard).
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { JSDOM } from 'jsdom';
import {
  DIST,
  LANGS,
  MANUAL,
  MANUAL_PAGES,
  PAGES,
  ROOT,
  SITE,
  attr,
  hrefs,
  pageAt as pageOf,
} from './pages.mjs';

const graphOf = (document) => {
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  assert.equal(scripts.length, 1);
  return JSON.parse(scripts[0].textContent)['@graph'];
};

// the names of the synth a page keeps in English in every language (knobs, sections, keys)
const GLOSSARY = {
  'getting-started': ['Wave', 'Detune', 'Cutoff', 'Osc 1', 'Save', 'Share', 'Keys'],
  modulation: ['ENV 2', 'LFO 1', 'VELO', 'Cutoff', 'Uni', 'Bi', 'Pump', 'Retrig', 'Free', 'BPM', 'Amp'],
  wavetables: ['Wave', 'W Count', 'Size', 'Grid X', 'Audio file', 'Choose a file'],
  midi: ['Midi', 'Channel', 'Sync to MIDI Clock', 'Auto', 'Low', 'Normal', 'EXT'],
};

// the synth's page (/) describes the app every page refers to
const synthApp = JSON.parse(
  new JSDOM(readFileSync(join(ROOT, 'apps/chisper/src/index.html'), 'utf8')).window.document.querySelector(
    'script[type="application/ld+json"]'
  ).textContent
);

// a link of a page leads to a page or a file of the build, or into the synth
const leadsSomewhere = (href) => {
  if (href === '/' || href.startsWith('/?')) return true;
  const path = decodeURIComponent(new URL(href, SITE).pathname);
  const file = join(DIST, path);
  return existsSync(file) && (!statSync(file).isDirectory() || existsSync(join(file, 'index.html')));
};

describe('every page of the manual', () => {
  for (const [index, page] of MANUAL_PAGES.entries()) {
    for (const lang of LANGS) {
      describe(`${page} (${lang})`, () => {
        const path = MANUAL[page][lang];
        const document = pageOf(path);
        const url = `${SITE}${path}`;

        it('has its language, a title and a description of its search, its canonical', () => {
          assert.equal(document.documentElement.lang, lang);
          assert.ok(document.title.length >= 20 && document.title.length <= 70, document.title);
          const description = attr(document, 'meta[name="description"]', 'content');
          assert.ok(description.length >= 80 && description.length <= 160, description);
          assert.equal(attr(document, 'link[rel="canonical"]', 'href'), url);
          assert.equal(attr(document, 'meta[property="og:url"]', 'content'), url);
          assert.equal(attr(document, 'meta[property="og:type"]', 'content'), 'article');
          assert.equal(attr(document, 'meta[property="og:title"]', 'content'), document.title);
          assert.ok(existsSync(join(DIST, `og/${lang}.png`)));
        });

        it('links its translations and x-default (English), as do its language links', () => {
          const links = [...document.querySelectorAll('link[rel="alternate"][hreflang]')].map((link) => [
            link.getAttribute('hreflang'),
            link.getAttribute('href'),
          ]);
          assert.deepEqual(links, [
            ...LANGS.map((other) => [other, `${SITE}${MANUAL[page][other]}`]),
            ['x-default', `${SITE}${MANUAL[page].en}`],
          ]);
          assert.deepEqual(
            hrefs(document.querySelectorAll('footer a[hreflang]')),
            LANGS.map((other) => MANUAL[page][other])
          );
        });

        it('has one H1, its sections under H2s, and answers first: a paragraph before them', () => {
          assert.equal(document.querySelectorAll('h1').length, 1);
          const prose = document.querySelector('.prose');
          assert.ok(prose.querySelectorAll('h2').length >= 4);
          const first = prose.firstElementChild;
          assert.equal(first.tagName, 'P');
          assert.ok(first.textContent.length > 150, first.textContent);
          assert.ok(!document.body.textContent.includes('**'));
        });

        it('shows where it is: breadcrumbs, the pages of the manual (this one marked), the ones before and after', () => {
          const crumbs = document.querySelector('nav.crumbs');
          const hub = MANUAL['getting-started'][lang];
          assert.deepEqual(hrefs(crumbs.querySelectorAll('a')), [
            PAGES[lang].path,
            ...(page === 'getting-started' ? [] : [hub]),
          ]);
          assert.equal(crumbs.querySelector('[aria-current="page"]').textContent.trim().length > 3, true);
          const nav = document.querySelector('nav.side');
          assert.deepEqual(
            hrefs(nav.querySelectorAll('.pages > li > a')),
            MANUAL_PAGES.map((other) => MANUAL[other][lang])
          );
          assert.equal(attr(nav, '[aria-current="page"]', 'href'), path);
          // the headings of this page under its name, each leading to its H2
          const sections = hrefs(nav.querySelectorAll('.sections a'));
          assert.equal(sections.length, document.querySelectorAll('.prose h2').length);
          for (const href of sections) assert.ok(document.getElementById(href.slice(1)), href);
          const prev = MANUAL_PAGES[index - 1];
          const next = MANUAL_PAGES[index + 1];
          assert.equal(attr(document, '.pager a[rel="prev"]', 'href'), prev && MANUAL[prev][lang]);
          assert.equal(attr(document, '.pager a[rel="next"]', 'href'), next && MANUAL[next][lang]);
        });

        it('has structured data: the synth, the article in its language, its breadcrumbs', () => {
          const graph = graphOf(document);
          const app = graph.find((node) => node['@type'] === 'WebApplication');
          assert.equal(app['@id'], `${SITE}/#app`);
          assert.equal(app.description, synthApp.description);
          const article = graph.find((node) => node['@type'] === 'TechArticle');
          assert.equal(article.url, url);
          assert.equal(article.headline, document.querySelector('h1').textContent.trim());
          assert.equal(article.description, attr(document, 'meta[name="description"]', 'content'));
          assert.equal(article.inLanguage, lang);
          assert.match(article.dateModified, /^\d{4}-\d{2}-\d{2}$/);
          assert.deepEqual(article.about, { '@id': `${SITE}/#app` });
          assert.equal(article.author.name, 'Qvantor');
          assert.ok(existsSync(join(DIST, new URL(article.image).pathname)), article.image);
          const crumbs = graph.find((node) => node['@type'] === 'BreadcrumbList').itemListElement;
          assert.deepEqual(
            crumbs.map((crumb) => crumb.position),
            crumbs.map((_, i) => i + 1)
          );
          assert.equal(crumbs[0].item, `${SITE}${PAGES[lang].path}`);
          assert.equal(crumbs.at(-1).item, page === 'getting-started' ? `${SITE}${MANUAL[page][lang]}` : url);
        });

        it('leads back to the landing of its language from the logos, to the manual from the header', () => {
          assert.deepEqual(hrefs(document.querySelectorAll('header a.logo, footer a.logo')), [
            PAGES[lang].path,
            PAGES[lang].path,
          ]);
          assert.equal(attr(document, 'header a.manual', 'href'), MANUAL['getting-started'][lang]);
        });

        it('opens presets of the site in the synth', () => {
          const presets = hrefs(document.querySelectorAll('a.open-preset'));
          assert.ok(presets.length >= 2);
          for (const href of presets) assert.match(href, /^\/\?preset=[0-9a-f-]{36}$/);
        });

        it('links only pages and files the build has, or the synth', () => {
          const links = hrefs(document.querySelectorAll('a[href^="/"], link[href^="/"]'));
          const sources = [...document.querySelectorAll('[src^="/"]')].map((element) =>
            element.getAttribute('src')
          );
          for (const href of [...links, ...sources].filter((href) => href !== '/favicon.ico'))
            assert.ok(leadsSomewhere(href), href);
          // a page of the manual links others of its language only (but for its translations)
          const own = hrefs(document.querySelectorAll('a[href^="/"]:not([hreflang])'));
          for (const href of own.filter((href) => href.includes('/manual/') || href.includes('/anleitung/')))
            assert.ok(
              MANUAL_PAGES.some((other) => MANUAL[other][lang] === href.split('#')[0]),
              `${href} in ${lang}`
            );
        });

        it('has pictures of a known size, each with a text alternative', () => {
          for (const image of document.querySelectorAll('img')) {
            assert.ok(Number(image.getAttribute('width')) > 0);
            assert.ok(Number(image.getAttribute('height')) > 0);
            assert.ok(image.getAttribute('alt').length > 20, image.getAttribute('alt'));
          }
        });

        it('keeps the names of the synth in English', () => {
          const text = document.querySelector('.prose').textContent;
          for (const name of GLOSSARY[page]) assert.ok(text.includes(name), name);
        });
      });
    }
  }
});

describe('the parts of a page of the manual', () => {
  it('numbers the parts of the synth on its screenshot as its legend does', () => {
    for (const lang of LANGS) {
      const map = pageOf(MANUAL['getting-started'][lang]).querySelector('figure.map');
      const marks = [...map.querySelectorAll('.part .mark')].map((mark) => Number(mark.textContent));
      assert.deepEqual(
        marks,
        marks.map((_, i) => i + 1)
      );
      assert.equal(marks.length, map.querySelectorAll('.legend ol > li').length, lang);
      assert.ok(map.querySelector('img').getAttribute('alt').length > 40);
    }
  });

  it('shows the notes of the computer keyboard as the synth plays them (octave 3)', () => {
    const source = readFileSync(
      join(ROOT, 'apps/chisper/src/app/synth/common/modules/keyboard-controller.ts'),
      'utf8'
    );
    const mapping = source.slice(
      source.indexOf('keyboardToNotes'),
      source.indexOf('};', source.indexOf('keyboardToNotes'))
    );
    const notes = [...mapping.matchAll(/(\w+): \[(\d), '([A-G]#?)'\]/g)].map(([, code, octave, name]) => [
      code,
      `${name}${3 + Number(octave)}`,
    ]);
    assert.ok(notes.length > 30);
    for (const path of [MANUAL['getting-started'].en, MANUAL.midi.de]) {
      const keyboard = pageOf(path).querySelector('.keyboard');
      const shown = [...keyboard.querySelectorAll('[data-code]')]
        .filter((key) => key.querySelector('.note'))
        .map((key) => [key.dataset.code, key.querySelector('.note').textContent.trim()]);
      assert.deepEqual(
        Object.fromEntries(shown),
        Object.fromEntries(notes.filter(([code]) => shown.some(([key]) => key === code)))
      );
      // every key of the synth is on the drawing (the shared C of the comma and Q both)
      assert.deepEqual(new Set(shown.map(([code]) => code)), new Set(notes.map(([code]) => code)));
    }
  });

  it('labels the keys as the keyboards of its readers do: QWERTZ on the German pages, Ñ on the Spanish', () => {
    const legend = (path, code) =>
      pageOf(path).querySelector(`.keyboard [data-code="${code}"] .legend`).textContent.trim();
    assert.deepEqual(
      [legend(MANUAL['getting-started'].en, 'KeyZ'), legend(MANUAL['getting-started'].en, 'KeyY')],
      ['Z', 'Y']
    );
    assert.deepEqual(
      [legend(MANUAL['getting-started'].de, 'KeyZ'), legend(MANUAL['getting-started'].de, 'KeyY')],
      ['Y', 'Z']
    );
    assert.equal(legend(MANUAL.midi.de, 'BracketRight'), '+');
    assert.deepEqual(
      ['KeyZ', 'Semicolon', 'BracketLeft', 'BracketRight', 'Slash'].map((code) =>
        legend(MANUAL['getting-started'].es, code)
      ),
      ['Z', 'Ñ', '`', '+', '-']
    );
  });

  it('gives every exercise a section of its own in the contents of the page', () => {
    for (const path of Object.values(MANUAL).flatMap((paths) => Object.values(paths))) {
      for (const exercise of pageOf(path).querySelectorAll('.try')) {
        let before = exercise.previousElementSibling;
        while (before && (before.matches('.try') || !before.matches('h2, h3')))
          before = before.previousElementSibling;
        assert.equal(before?.tagName, 'H2', `${path}: ${exercise.querySelector('h3').textContent}`);
      }
    }
  });

  it('tells how a DAW plays the synth and leads its tempo: a virtual MIDI port, MIDI Clock', () => {
    for (const lang of LANGS) {
      const text = pageOf(MANUAL.midi[lang]).querySelector('.prose').textContent;
      for (const phrase of [
        'DAW',
        'IAC',
        'loopMIDI',
        'Sync to MIDI Clock',
        'EXT',
        'Song Position',
        'Send master sync',
      ])
        assert.ok(text.includes(phrase), `${phrase} (${lang})`);
    }
  });

  it('has the browsers of the synth in a table: Web MIDI and the choice of latency for each', () => {
    const table = pageOf(MANUAL.midi.en).querySelector('.compat table');
    const rows = [...table.querySelectorAll('tbody tr')].map((row) =>
      [...row.children].map((cell) => cell.textContent.trim())
    );
    assert.deepEqual(
      rows.find(([browser]) => browser === 'Safari 16.4+'),
      ['Safari 16.4+', 'macOS', 'No', 'No']
    );
    assert.deepEqual(
      rows.find(([, system]) => system === 'ChromeOS'),
      ['Chrome', 'ChromeOS', 'Yes', 'Yes']
    );
    assert.deepEqual(rows.at(-1), ['Any', 'iOS, iPadOS 16.4+', 'No', 'No']);
  });
});

describe('the section of the manual', () => {
  it('has no page at its folder: the hub of each language is its Getting started (netlify.toml)', () => {
    const redirects = readFileSync(join(ROOT, 'netlify.toml'), 'utf8');
    for (const lang of LANGS) {
      const folder = MANUAL['getting-started'][lang].replace(/[^/]+\/$/, '');
      assert.ok(!existsSync(join(DIST, folder, 'index.html')), folder);
      assert.match(
        redirects,
        new RegExp(`from = "${folder}"\\s+to = "${MANUAL['getting-started'][lang]}"\\s+status = 301`),
        folder
      );
    }
  });
});
