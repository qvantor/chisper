import { APP_DESCRIPTION } from './json-ld';
import { manualJsonLd } from './manual-json-ld';

type Node = Record<string, unknown> & { '@type': string };

const graph = () =>
  manualJsonLd({
    lang: 'es',
    path: '/es/manual/teclado-midi/',
    headline: 'Teclado MIDI, Chromebook, iPad',
    description: 'Cómo conectar un teclado MIDI',
    updated: new Date('2026-11-12'),
    image: '/_astro/midi.webp',
    screenshot: '/_astro/synth.webp',
    crumbs: [
      { name: 'Chisper', path: '/es/sintetizador-wavetable/' },
      { name: 'Manual', path: '/es/manual/primeros-pasos/' },
      { name: 'MIDI y dispositivos', path: '/es/manual/teclado-midi/' },
    ],
  })['@graph'] as unknown as Node[];

const nodeOf = (type: string) => graph().find((node) => node['@type'] === type);

describe('manualJsonLd', () => {
  it('describes the synth as every page of the site does', () => {
    expect(nodeOf('WebApplication')).toMatchObject({
      '@id': 'https://chisper.qvantor.org/#app',
      description: APP_DESCRIPTION,
      screenshot: 'https://chisper.qvantor.org/_astro/synth.webp',
    });
  });

  it('makes the page an article of its language about the synth', () => {
    expect(nodeOf('TechArticle')).toEqual({
      '@type': 'TechArticle',
      '@id': 'https://chisper.qvantor.org/es/manual/teclado-midi/#article',
      url: 'https://chisper.qvantor.org/es/manual/teclado-midi/',
      mainEntityOfPage: 'https://chisper.qvantor.org/es/manual/teclado-midi/',
      headline: 'Teclado MIDI, Chromebook, iPad',
      description: 'Cómo conectar un teclado MIDI',
      inLanguage: 'es',
      dateModified: '2026-11-12',
      image: 'https://chisper.qvantor.org/_astro/midi.webp',
      author: { '@type': 'Person', name: 'Qvantor', url: 'https://github.com/qvantor' },
      publisher: { '@type': 'Person', name: 'Qvantor', url: 'https://github.com/qvantor' },
      about: { '@id': 'https://chisper.qvantor.org/#app' },
    });
  });

  it('places it in the site with absolute URLs', () => {
    expect(nodeOf('BreadcrumbList')?.itemListElement).toEqual([
      {
        '@type': 'ListItem',
        position: 1,
        name: 'Chisper',
        item: 'https://chisper.qvantor.org/es/sintetizador-wavetable/',
      },
      {
        '@type': 'ListItem',
        position: 2,
        name: 'Manual',
        item: 'https://chisper.qvantor.org/es/manual/primeros-pasos/',
      },
      {
        '@type': 'ListItem',
        position: 3,
        name: 'MIDI y dispositivos',
        item: 'https://chisper.qvantor.org/es/manual/teclado-midi/',
      },
    ]);
  });
});
