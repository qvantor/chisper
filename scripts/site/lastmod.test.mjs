import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fetchLive, significant, stamp } from './lastmod.mjs';

const SITE = 'https://chisper.example';
const NOW = new Date('2026-11-17T18:30:12.345Z');
const TIME = '2026-11-17T18:30:12Z';
const BEFORE = '2026-11-02T09:00:00Z';

const page = ({
  title = 'Wavetables',
  head = '<meta name="description" content="Tables of the synth">',
  body = '<main><h1>Wavetables</h1><p>A table is a row of frames.</p><a href="/learn/">Learn</a></main>',
} = {}) => `<!doctype html><html><head><title>${title}</title>${head}</head><body>${body}</body></html>`;

const index = (...sitemaps) =>
  `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${sitemaps
    .map((loc) => `<sitemap><loc>${loc}</loc></sitemap>`)
    .join('')}</sitemapindex>`;

const sitemap = (...urls) =>
  `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">${urls
    .map(
      ({ loc, lastmod, links = '' }) =>
        `<url><loc>${loc}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}${links}</url>`
    )
    .join('')}</urlset>`;

const response = (status, body = null) => new Response(body, { status });

// a live site: the answers by URL, 404 where none; each request recorded
const liveSite = (answers) => {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, init });
    const answer = answers[url];
    if (answer instanceof Error) throw answer;
    if (typeof answer === 'function') return answer();
    return answer ?? response(404);
  };
  return { fetch, requests };
};

describe('significant', () => {
  const same = (a, b) => assert.equal(significant(a), significant(b));
  const differs = (a, b) => assert.notEqual(significant(a), significant(b));

  it('leaves out scripts, styles, attributes and whitespace', () => {
    same(
      page(),
      page({
        head: '<meta name="description" content="Tables of the synth"><script src="/main.1a2b.js"></script><style>p{color:red}</style><link rel="preload" href="/_astro/a.woff2">',
        body: '<main class="x" data-astro-cid-1>\n  <h1>Wavetables</h1>\n  <p>A table is a   row of frames.</p>\n  <a class="y" href="/learn/">Learn</a></main><script>boot()</script><template><p>later</p></template>',
      })
    );
  });

  it('takes the structured data by what it says, not how it is written', () => {
    same(
      page({
        head: '<script type="application/ld+json">{"@type":"WebApplication","name":"Chisper"}</script>',
      }),
      page({
        head: '<script type="application/ld+json">\n  { "@type": "WebApplication",\n    "name": "Chisper" }\n</script>',
      })
    );
    differs(
      page({
        head: '<script type="application/ld+json">{"@type":"WebApplication","name":"Chisper"}</script>',
      }),
      page({
        head: '<script type="application/ld+json">{"@type":"WebApplication","name":"Chisper 2"}</script>',
      })
    );
  });

  it('sees the title, the description, robots, canonical and alternates', () => {
    differs(page(), page({ title: 'Wavetables of Chisper' }));
    differs(page(), page({ head: '<meta name="description" content="The tables">' }));
    differs(
      page(),
      page({
        head: '<meta name="description" content="Tables of the synth"><meta name="robots" content="noindex">',
      })
    );
    differs(
      page({ head: `<link rel="canonical" href="${SITE}/a/">` }),
      page({ head: `<link rel="canonical" href="${SITE}/b/">` })
    );
    differs(
      page({ head: `<link rel="alternate" hreflang="es" href="${SITE}/es/a/">` }),
      page({ head: `<link rel="alternate" hreflang="es" href="${SITE}/es/b/">` })
    );
  });

  it('sees the text, the links and the texts of the images', () => {
    differs(
      page(),
      page({
        body: '<main><h1>Wavetables</h1><p>A table is a row of waves.</p><a href="/learn/">Learn</a></main>',
      })
    );
    differs(
      page(),
      page({
        body: '<main><h1>Wavetables</h1><p>A table is a row of frames.</p><a href="/learn/what/">Learn</a></main>',
      })
    );
    differs(
      page({ body: '<img src="/a.webp" alt="The oscillator">' }),
      page({ body: '<img src="/a.webp" alt="The filter">' })
    );
  });

  it('leaves out the header, the footer and the navigation of a page with a main', () => {
    const main =
      '<main><nav><a href="/manual/">Manual</a></nav><h1>Wavetables</h1><p>A table is a row of frames.</p><a href="/learn/">Learn</a><nav class="pager"><a href="/b/">Next</a></nav></main>';
    same(
      page({
        body: `<header><a href="/"><img src="/logo.svg" alt="Chisper"></a></header>${main}<footer>Manual</footer>`,
      }),
      page({
        body: main
          .replace(
            '<a href="/manual/">Manual</a>',
            '<a href="/manual/">Manual</a><a href="/learn/">Learn</a>'
          )
          .replace('/b/">Next', '/c/">Next'),
      })
    );
    differs(page({ body: '<header>A</header><p>Text</p>' }), page({ body: '<header>B</header><p>Text</p>' }));
  });

  it('leaves out where an image comes from', () => {
    same(
      page({ body: '<img src="/_astro/osc.D1hoy.webp" alt="The oscillator">' }),
      page({ body: '<img src="/_astro/osc.Z9xq2.webp" alt="The oscillator">' })
    );
  });
});

describe('fetchLive', () => {
  it('reads a page and asks without following redirects', async () => {
    const { fetch, requests } = liveSite({ [`${SITE}/a/`]: response(200, 'page') });
    assert.equal(await fetchLive(`${SITE}/a/`, { fetch }), 'page');
    assert.equal(requests[0].init.redirect, 'manual');
  });

  it('takes 404, 410 and a redirect for no page', async () => {
    const { fetch } = liveSite({ [`${SITE}/b/`]: response(410), [`${SITE}/c/`]: response(301) });
    for (const path of ['/a/', '/b/', '/c/'])
      assert.equal(await fetchLive(`${SITE}${path}`, { fetch }), null);
  });

  it('asks again after an error, then fails with the URL', async () => {
    let calls = 0;
    const flaky = liveSite({ [`${SITE}/a/`]: () => (++calls < 3 ? response(503) : response(200, 'page')) });
    assert.equal(await fetchLive(`${SITE}/a/`, { fetch: flaky.fetch, pause: 0 }), 'page');
    const down = liveSite({ [`${SITE}/a/`]: new TypeError('fetch failed') });
    await assert.rejects(
      fetchLive(`${SITE}/a/`, { fetch: down.fetch, pause: 0 }),
      /chisper\.example\/a\/: fetch failed/
    );
    assert.equal(down.requests.length, 3);
  });
});

describe('stamp', () => {
  let dir;

  const write = (file, text) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  };

  const links = `<xhtml:link rel="alternate" hreflang="en" href="${SITE}/a/"/><xhtml:link rel="alternate" hreflang="es" href="${SITE}/es/a/"/>`;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'site-lastmod-'));
    write('sitemap-index.xml', index(`${SITE}/sitemap-0.xml`));
    write('sitemap-0.xml', sitemap({ loc: `${SITE}/` }, { loc: `${SITE}/a/`, links }, { loc: `${SITE}/b/` }));
    write(
      'index.html',
      page({ title: 'Chisper', body: '<main><p>The synth</p></main><script src="/main.2.js"></script>' })
    );
    write('a/index.html', page());
    write('b/index.html', page({ title: 'B' }));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const lastmodsOf = () =>
    Object.fromEntries(
      [
        ...readFileSync(join(dir, 'sitemap-0.xml'), 'utf8').matchAll(
          /<loc>([^<]*)<\/loc>(?:<lastmod>([^<]*)<\/lastmod>)?/g
        ),
      ].map(([, loc, lastmod]) => [loc, lastmod])
    );

  const live = (answers) =>
    liveSite({
      [`${SITE}/sitemap-index.xml`]: response(200, index(`${SITE}/sitemap-0.xml`)),
      [`${SITE}/sitemap-0.xml`]: response(
        200,
        sitemap(
          { loc: `${SITE}/`, lastmod: BEFORE },
          { loc: `${SITE}/a/`, lastmod: BEFORE, links },
          { loc: `${SITE}/b/` }
        )
      ),
      [`${SITE}/`]: response(
        200,
        page({ title: 'Chisper', body: '<main><p>The synth</p></main><script src="/main.1.js"></script>' })
      ),
      [`${SITE}/a/`]: response(200, page()),
      [`${SITE}/b/`]: response(200, page({ title: 'B' })),
      ...answers,
    });

  it('keeps the lastmod of a page alike, dates a changed or undated one by this build', async () => {
    const { fetch } = live({ [`${SITE}/a/`]: response(200, page({ title: 'Old wavetables' })) });
    const pages = await stamp(dir, { fetch, now: NOW, pause: 0 });
    assert.deepEqual(pages, [
      { loc: `${SITE}/`, lastmod: BEFORE, why: null },
      { loc: `${SITE}/a/`, lastmod: TIME, why: 'changed' },
      { loc: `${SITE}/b/`, lastmod: TIME, why: 'undated' },
    ]);
    assert.deepEqual(lastmodsOf(), { [`${SITE}/`]: BEFORE, [`${SITE}/a/`]: TIME, [`${SITE}/b/`]: TIME });
  });

  it('dates a page not live yet by this build', async () => {
    const { fetch } = live({ [`${SITE}/b/`]: undefined });
    const pages = await stamp(dir, { fetch, now: NOW, pause: 0 });
    assert.deepEqual(pages[2], { loc: `${SITE}/b/`, lastmod: TIME, why: 'new' });
  });

  it('dates every page by this build before the first deploy of the sitemap', async () => {
    const { fetch } = live({ [`${SITE}/sitemap-index.xml`]: response(404) });
    const pages = await stamp(dir, { fetch, now: NOW, pause: 0 });
    assert.deepEqual(
      pages.map((p) => [p.lastmod, p.why]),
      [
        [TIME, 'undated'],
        [TIME, 'undated'],
        [TIME, 'undated'],
      ]
    );
  });

  it('puts the lastmod right after the loc, before the alternates, replacing one there', async () => {
    write(
      'sitemap-0.xml',
      sitemap({ loc: `${SITE}/` }, { loc: `${SITE}/a/`, lastmod: '2020-01-01', links }, { loc: `${SITE}/b/` })
    );
    const { fetch } = live({});
    await stamp(dir, { fetch, now: NOW, pause: 0 });
    assert.equal(
      readFileSync(join(dir, 'sitemap-0.xml'), 'utf8'),
      sitemap(
        { loc: `${SITE}/`, lastmod: BEFORE },
        { loc: `${SITE}/a/`, lastmod: BEFORE, links },
        { loc: `${SITE}/b/`, lastmod: TIME }
      )
    );
  });

  it('writes nothing when the live site does not answer', async () => {
    const before = readFileSync(join(dir, 'sitemap-0.xml'), 'utf8');
    const { fetch } = live({ [`${SITE}/b/`]: response(500) });
    await assert.rejects(stamp(dir, { fetch, now: NOW, pause: 0 }), /chisper\.example\/b\/: HTTP 500/);
    assert.equal(readFileSync(join(dir, 'sitemap-0.xml'), 'utf8'), before);
  });

  it('fails on a page of the sitemap not built', async () => {
    rmSync(join(dir, 'b'), { recursive: true });
    const { fetch } = live({});
    await assert.rejects(
      stamp(dir, { fetch, now: NOW, pause: 0 }),
      /names https:\/\/chisper\.example\/b\/, not in/
    );
  });
});
