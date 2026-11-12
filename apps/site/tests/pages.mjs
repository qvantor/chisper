// The pages the site builds, as a crawler finds them: the landing and the manual, each in every language at a path
// of its own (written here, not imported from src: a changed path breaks links from outside, the tests say so)
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

export const ROOT = join(import.meta.dirname, '../../..');
export const DIST = join(ROOT, 'dist/apps/site');
export const SITE = 'https://chisper.qvantor.org';

export const PAGES = {
  en: { path: '/wavetable-synth/', ogLocale: 'en_US' },
  es: { path: '/es/sintetizador-wavetable/', ogLocale: 'es_ES' },
  de: { path: '/de/wavetable-synthesizer/', ogLocale: 'de_DE' },
};
export const LANGS = Object.keys(PAGES);

// the pages of the manual in the order of its nav, their path in each language
export const MANUAL = {
  'getting-started': {
    en: '/manual/getting-started/',
    es: '/es/manual/primeros-pasos/',
    de: '/de/anleitung/erste-schritte/',
  },
  modulation: {
    en: '/manual/modulation-envelopes-lfo/',
    es: '/es/manual/modulacion-envolventes-lfo/',
    de: '/de/anleitung/modulation-huellkurven-lfo/',
  },
  wavetables: { en: '/manual/wavetables/', es: '/es/manual/wavetables/', de: '/de/anleitung/wavetables/' },
  midi: {
    en: '/manual/midi-keyboard-setup/',
    es: '/es/manual/teclado-midi/',
    de: '/de/anleitung/midi-keyboard/',
  },
};
export const MANUAL_PAGES = Object.keys(MANUAL);

// the document of a built page (read once: the tests only look at it)
const documents = new Map();
export const pageAt = (path) => {
  if (!documents.has(path)) {
    const file = join(DIST, path, 'index.html');
    assert.ok(existsSync(file), `${file} built`);
    documents.set(path, new JSDOM(readFileSync(file, 'utf8')).window.document);
  }
  return documents.get(path);
};

export const attr = (document, selector, name) => document.querySelector(selector)?.getAttribute(name);
export const hrefs = (elements) => [...elements].map((element) => element.getAttribute('href'));
