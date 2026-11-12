// The screenshots of the promo page (apps/site/src/assets), from the production site, so they show what a visitor
// gets: the synth on the preset of the first clip and its wavetable editor; the parts each feature shows, on the
// presets of its clips, upright (each fits the height of the text beside it): both oscillators one over the
// other, the unison with Detune held, the filter, Osc 2 over the envelopes and the LFO, the effects of a phone
// (their order and the first two); the keys of a phone, its whole screen. And the pictures of the manual
// (apps/site/src/assets/manual): the whole synth with the places of its parts (synth-map.json, the numbers of
// InterfaceMap.astro), the dialogs and popovers its pages explain, the wavetable editor. Run it when the interface
// changes (a part of it with --only):
//   npx -y -p playwright@1.50.1 node scripts/site/screens.mjs [--url=https://chisper.qvantor.org]
//     [--only=landing|manual|editor]
import fs from 'fs';
import path from 'path';
import { loadPlaywright, parseArgs, root } from '../bench-common.mjs';
import { SITE, openPreset, presetOf } from './common.mjs';

const args = parseArgs(process.argv.slice(2));
const URL_BASE = args.url ?? SITE;
const OUT = path.join(root, 'apps/site/src/assets');
const MANUAL = path.join(OUT, 'manual');
const ONLY = args.only ? String(args.only).split(',') : ['landing', 'manual', 'editor'];
const VIEWPORT = { width: 1440, height: 900 };
// the sections of the synth screen in their order: Osc 1, Osc 2, Filter, ENV, LFO
const SECTION = '[class*="section__Root"]';
const OSC1 = 0;
const OSC2 = 1;
const FILTER = 2;
const ENV = 3;
const LFO = 4;
// a phone, its whole screen (the browser's bars of the iPhone 13 of Playwright left out)
const phoneOf = (devices) => ({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 } });
// the color of the synth's panel, between pictures put together
const PANEL = '#ecf0f1';
// the first row of the app is its header
const HEADER = 80;

// a page of the synth on the preset of a clip (closed once shot: a synth plays on in a page left open)
const open = async (browser, slug, options = { viewport: VIEWPORT, deviceScaleFactor: 2 }) => {
  const page = await browser.newPage(options);
  await openPreset(page, URL_BASE, presetOf(slug));
  return page;
};

const file = (name) => path.join(OUT, `${name}.png`);

// pictures (PNG buffers of one scale) one over the other on the synth's panel, as one PNG
const stack = async (browser, pictures, scale, gap = 12) => {
  const page = await browser.newPage({ deviceScaleFactor: scale, viewport: { width: 800, height: 800 } });
  const images = pictures
    .map((png) => `<img src="data:image/png;base64,${png.toString('base64')}" style="display:block">`)
    .join('');
  await page.setContent(
    `<body style="margin:0;background:${PANEL}"><div id="stack" style="display:inline-flex;flex-direction:column;gap:${gap}px">${images}</div></body>`
  );
  // each image at its CSS size: its pixels over the scale
  await page.evaluate((ratio) => {
    for (const image of document.images) image.style.width = `${image.naturalWidth / ratio}px`;
  }, scale);
  const shot = await page.locator('#stack').screenshot();
  await page.close();
  return shot;
};

const landing = async (browser, devices) => {
  const synth = await open(browser, 'biting-brass-keys', { viewport: VIEWPORT, deviceScaleFactor: 1.5 });
  await synth.screenshot({ path: file('synth') });
  await openEditor(synth);
  await synth.screenshot({ path: file('editor'), clip: EDITOR_CLIP });
  await synth.close();

  // both oscillators, one over the other
  const osc = await open(browser, 'ufo-drone');
  const oscillators = [
    await osc.locator(SECTION).nth(OSC1).screenshot(),
    await osc.locator(SECTION).nth(OSC2).screenshot(),
  ];
  await osc.close();
  fs.writeFileSync(file('osc'), await stack(browser, oscillators, 2));

  // Detune held: the unison voices (8 of a saw) over the wave, not the tooltip of its value
  const unison = await open(browser, 'biting-brass-keys');
  await unison.addStyleTag({ content: '[class*="ooltip"] { visibility: hidden !important; }' });
  const section = unison.locator(SECTION).nth(OSC1);
  const label = await section.getByText('Detune', { exact: true }).boundingBox();
  await unison.mouse.move(label.x + label.width / 2, label.y - 24);
  await unison.mouse.down();
  await unison.waitForTimeout(600);
  await section.screenshot({ path: file('unison') });
  await unison.mouse.up();
  await unison.close();

  const filter = await open(browser, 'acid-bass');
  await filter
    .locator(SECTION)
    .nth(FILTER)
    .screenshot({ path: file('filter') });
  await filter.close();

  // the sources and where they go: Osc 2 (the route of LFO 1 on its gain), the envelopes, LFO 1 (its shape, the
  // route of ENV 2 on its rate), one over the other
  const sources = await open(browser, 'helicopter');
  const panels = [];
  for (const index of [OSC2, ENV, LFO]) panels.push(await sources.locator(SECTION).nth(index).screenshot());
  await sources.close();
  fs.writeFileSync(file('modulation'), await stack(browser, panels, 2));

  // the effects of a phone: their order, the distortion and the delay
  const fx = await open(browser, 'warehouse-lead', phoneOf(devices));
  await fx.getByRole('button', { name: 'Synth' }).click();
  await fx.getByText('FX', { exact: true }).first().click();
  await fx.waitForTimeout(1500);
  const screen = await fx.locator('[class*="fx-screen__Root"]').boundingBox();
  const reverb = await fx.getByText('Reverb', { exact: true }).nth(1).boundingBox();
  await fx.screenshot({
    path: file('fx'),
    clip: { x: screen.x, y: screen.y, width: screen.width, height: reverb.y - 14 - screen.y },
  });
  await fx.close();

  const phone = await open(browser, 'theremin', phoneOf(devices));
  await phone.getByRole('button', { name: 'Keys' }).click();
  await phone.waitForTimeout(1000);
  await phone.screenshot({ path: file('phone') });
  await phone.close();
};

const manualFile = (name) => path.join(MANUAL, `${name}.png`);

// the parts of the desktop screen the map numbers: the header's and the bottom row's by their elements, the sections
// by their titles (a section in a section, the shapes of an LFO, left out)
const MAP_ELEMENTS = {
  logo: '[class*="header__Logo"]',
  spectrum: '[class*="synth__HeaderEq"]',
  screens: '[class*="synth__HeaderRight"] > [class*="tape-switch__Root"]',
  presets: '[class*="preset-section__Section"]',
  master: '[class*="synth__HeaderRight"] > [class*="header__HeaderSection"]',
  wheel: '[class*="desktop-piano__PitchSection"]',
  keys: '[class*="desktop-piano__Keys"]',
  clip: '[class*="synth__ClipSection"]',
};
const MAP_SECTIONS = {
  Sub: 'sub',
  'Osc 1': 'osc1',
  'Osc 2': 'osc2',
  Noise: 'noise',
  Filter: 'filter',
  'ENV 1': 'env',
  'LFO 1': 'lfo',
  VELO: 'velo',
  Voicing: 'voicing',
};

// the box (x, y, width, height in CSS pixels) of every part of the map
const measureMap = (page) =>
  page.evaluate(
    ({ elements, sections, section }) => {
      const box = (element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return [x, y, width, height].map(Math.round);
      };
      const parts = {};
      for (const [id, selector] of Object.entries(elements)) {
        const element = document.querySelector(selector);
        if (element) parts[id] = box(element);
      }
      // the octave keys right of the wheel: the second section of the pitch
      const pitch = document.querySelectorAll(elements.wheel);
      if (pitch[1]) {
        const [wx, wy, ww, wh] = box(pitch[0]);
        const [ox, , ow] = box(pitch[1]);
        parts.wheel = [wx, wy, ox + ow - wx, wh];
      }
      for (const root of document.querySelectorAll(section)) {
        if (root.parentElement?.closest(section)) continue;
        const lines = root.innerText.split('\n').slice(0, 3);
        const title = Object.keys(sections).find((name) => lines.includes(name));
        if (title) parts[sections[title]] = box(root);
      }
      return { width: window.innerWidth, height: window.innerHeight, parts };
    },
    { elements: MAP_ELEMENTS, sections: MAP_SECTIONS, section: SECTION }
  );

// the box around elements (CSS pixels), a margin around it, within the page
const around = async (page, locators, margin = 12) => {
  const boxes = await Promise.all(locators.map((locator) => locator.boundingBox()));
  const { width, height } = page.viewportSize();
  const x = Math.max(0, Math.min(...boxes.map((box) => box.x)) - margin);
  const y = Math.max(0, Math.min(...boxes.map((box) => box.y)) - margin);
  const right = Math.min(width, Math.max(...boxes.map((box) => box.x + box.width)) + margin);
  const bottom = Math.min(height, Math.max(...boxes.map((box) => box.y + box.height)) + margin);
  return { x, y, width: right - x, height: bottom - y };
};

// the section of the tabs of the sources (Envelopes, LFOs)
const sectionWith = (page, has) => page.locator(SECTION).filter({ has }).first();
const sourcesSection = (page, tablist) => sectionWith(page, page.getByRole('tablist', { name: tablist }));
const section = (page, title) => sectionWith(page, page.getByText(title, { exact: true }));

// the open popover of antd (the menus of the header)
const popover = (page) => page.locator('.ant-popover:not(.ant-popover-hidden)').last();
const dialog = (page, title) => page.getByRole('dialog').filter({ hasText: title }).last();

// the knob above a label in a section
const knobOf = async (page, area, label) => {
  const box = await area.getByText(label, { exact: true }).boundingBox();
  return { x: box.x + box.width / 2, y: box.y - 24 };
};

// a MIDI keyboard plugged in: a stand-in of Web MIDI in the page (the machine that shoots has none, and headless
// Chrome grants no access)
const midiKeyboard = () => {
  const input = Object.assign(new EventTarget(), {
    id: 'keyboard',
    name: 'MIDI Keyboard',
    manufacturer: 'USB',
    type: 'input',
    state: 'connected',
    connection: 'open',
    onmidimessage: null,
    open: async () => input,
    close: async () => input,
  });
  const access = Object.assign(new EventTarget(), {
    inputs: new Map([[input.id, input]]),
    outputs: new Map(),
    sysexEnabled: false,
    onstatechange: null,
  });
  navigator.requestMIDIAccess = async () => access;
};

// the synth on the preset of the first clip in the installed Chrome (else in Playwright's Chromium)
const headerPage = async (fallback) => {
  const { chromium } = loadPlaywright();
  const chrome = await chromium.launch({ channel: 'chrome' }).catch(() => undefined);
  if (!chrome)
    console.warn('no Chrome installed: the popovers of the header from the Chromium of Playwright');
  const context = await (chrome ?? fallback).newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 });
  await context.addInitScript(midiKeyboard);
  const page = await context.newPage();
  await openPreset(page, URL_BASE, presetOf('biting-brass-keys'));
  return { page, close: () => (chrome ? chrome.close() : context.close()) };
};

// the wavetable editor open on the first oscillator, below the header (the dots of the routes of the knobs under it
// show through its modal: their z-index)
const EDITOR_CLIP = { x: 0, y: HEADER, width: VIEWPORT.width, height: VIEWPORT.height - HEADER };
const openEditor = async (page) => {
  await page.addStyleTag({ content: '[class*="amount-dot__Root"] { visibility: hidden; }' });
  await page.locator('.anticon-edit').first().click();
  await page.waitForTimeout(1500);
};

const manual = async (browser, devices) => {
  fs.mkdirSync(MANUAL, { recursive: true });

  // the whole synth (1.5× its CSS pixels: sharp at the width of the text, retina screens too) and its parts
  const synth = await open(browser, 'biting-brass-keys', { viewport: VIEWPORT, deviceScaleFactor: 1.5 });
  const map = await measureMap(synth);
  const missing = [...Object.keys(MAP_ELEMENTS), ...Object.values(MAP_SECTIONS)].filter(
    (id) => !map.parts[id]
  );
  if (missing.length) throw new Error(`parts of the synth not found: ${missing.join(', ')}`);
  await synth.screenshot({ path: manualFile('synth-map') });
  fs.writeFileSync(path.join(MANUAL, 'synth-map.json'), `${JSON.stringify(map, null, 2)}\n`);

  // the presets: the dialog of the name
  await synth.locator('[class*="preset-section__Section"]').getByText('Biting Brass Keys').click();
  await dialog(synth, 'Presets').waitFor();
  await synth.waitForTimeout(1500);
  await dialog(synth, 'Presets').screenshot({ path: manualFile('presets') });
  await synth.keyboard.press('Escape');
  await synth.waitForTimeout(500);

  await synth.close();

  // the popovers of the header as current Chrome shows them (the latency it lets choose, its count of dropouts;
  // the Chromium of Playwright is older): the settings, MIDI with a keyboard plugged in
  const { page: header, close } = await headerPage(browser);
  await header.getByRole('button', { name: 'Midi' }).click();
  await header.waitForTimeout(800);
  await popover(header).screenshot({ path: manualFile('midi') });
  // (a click on the spectrum closes it)
  await header.mouse.click(400, 40);
  await header.getByRole('button', { name: 'Settings' }).click();
  await header.waitForTimeout(800);
  await popover(header).screenshot({ path: manualFile('settings') });
  await close();

  // a pluck: ENV 2 on the Cutoff; the envelopes on ENV 2, the menu of the knob, LFO 1 dragged onto the Resonance
  const pluck = await open(browser, 'zesty-drive-bass');
  const env = sourcesSection(pluck, 'Envelopes');
  await pluck.getByRole('tab', { name: 'ENV 2', exact: true }).click();
  await pluck.waitForTimeout(600);
  await env.screenshot({ path: manualFile('envelopes') });
  const filter = section(pluck, 'Filter');
  const cutoff = await knobOf(pluck, filter, 'Cutoff');
  await pluck.mouse.click(cutoff.x, cutoff.y, { button: 'right' });
  const menu = pluck.locator('[role="dialog"]').last();
  await menu.waitFor();
  await pluck.waitForTimeout(500);
  // the knobs of the filter (their dots above them) over the menu
  const knobs = await around(pluck, [
    menu,
    filter.getByText('Cutoff', { exact: true }),
    filter.getByText('Gain', { exact: true }),
  ]);
  await pluck.screenshot({
    path: manualFile('knob-menu'),
    clip: { ...knobs, y: knobs.y - 90, height: knobs.height + 90 },
  });
  await pluck.keyboard.press('Escape');
  await pluck.waitForTimeout(300);
  const lfo = sourcesSection(pluck, 'LFOs');
  const tab = await pluck.getByRole('tab', { name: 'LFO 1', exact: true }).boundingBox();
  const res = await knobOf(pluck, filter, 'Res');
  await pluck.mouse.move(tab.x + tab.width / 2, tab.y + tab.height / 2);
  await pluck.mouse.down();
  await pluck.mouse.move(res.x, res.y, { steps: 12 });
  await pluck.waitForTimeout(400);
  await pluck.screenshot({ path: manualFile('modulation-drag'), clip: await around(pluck, [filter, lfo]) });
  await pluck.close();

  // a shape of points: the LFO of the helicopter
  const rotor = await open(browser, 'helicopter');
  await sourcesSection(rotor, 'LFOs').screenshot({ path: manualFile('lfo') });
  await rotor.close();

  // a wavetable: the oscillator on its frame, the browser of the library
  const drone = await open(browser, 'ufo-drone');
  const osc = section(drone, 'Osc 1');
  await osc.screenshot({ path: manualFile('oscillator') });
  await osc.locator('button[aria-haspopup="true"]').first().click();
  await popover(drone).waitFor();
  await drone.waitForTimeout(1500);
  await popover(drone).screenshot({ path: manualFile('wavetable-browser') });
  await drone.close();

  // the editor of that table: drawing a frame
  const table = await open(browser, 'ufo-drone', { viewport: VIEWPORT, deviceScaleFactor: 1.5 });
  await openEditor(table);
  await table.screenshot({ path: manualFile('editor-draw'), clip: EDITOR_CLIP });
  await table.close();

  // a phone: its keys
  const phone = await open(browser, 'theremin', phoneOf(devices));
  await phone.getByRole('button', { name: 'Keys' }).click();
  await phone.waitForTimeout(1000);
  await phone.screenshot({ path: manualFile('phone-keys') });
  await phone.close();
};

// the screen of a file in the wavetable editor: an audio file cut into waves (the synth with no
// preset, from any server of the app: a local build of a change of the editor not yet on production)
const editor = async (browser) => {
  fs.mkdirSync(MANUAL, { recursive: true });
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1.5 });
  await page.goto(URL_BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);
  await page.addStyleTag({ content: '#sleek-button { display: none !important; }' });
  await openEditor(page);
  await page.getByRole('tab', { name: 'Audio file' }).click();
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Bass sound' }).click();
  await page.getByText('W Count', { exact: true }).waitFor();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: manualFile('editor-audio'), clip: EDITOR_CLIP });
  await page.close();
};

const main = async () => {
  const { chromium, devices } = loadPlaywright();
  const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
  if (ONLY.includes('landing')) await landing(browser, devices);
  if (ONLY.includes('manual')) await manual(browser, devices);
  if (ONLY.includes('editor')) await editor(browser);
  await browser.close();
};

await main();
