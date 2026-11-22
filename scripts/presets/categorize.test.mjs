import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadSchema, parseCsv, planApply, sheetOf, toCsv } from './categorize.mjs';

const schema = await loadSchema('categorize-test');

const row = (id, name, rest = {}) => ({
  id,
  name,
  factory: false,
  category: null,
  subcategory: null,
  description: null,
  tags: [],
  features: [],
  data: {},
  ...rest,
});

test('the sheet guesses what is missing, keeps what a preset has', () => {
  const sheet = sheetOf(
    [
      row('a', 'Coin Grab', { factory: true, category: 'fx' }),
      row('b', 'Dark Warm Pad'),
      row('c', 'Thing', { data: { v: { max: 1 }, osc1: { o: -2 } } }),
      row('d', 'Mine', { category: 'lead', subcategory: 'soft', tags: ['soft'] }),
      row('e', 'Thing two'),
    ],
    schema
  );
  assert.deepEqual(sheet, [
    {
      id: 'a',
      name: 'Coin Grab',
      factory: 'yes',
      category: 'fx',
      subcategory: 'game',
      tags: '',
      reason: 'its own category; name: game',
    },
    {
      id: 'b',
      name: 'Dark Warm Pad',
      factory: '',
      category: 'pad',
      subcategory: 'dark',
      tags: 'dark warm',
      reason: 'name: pad; name: dark; name: dark warm',
    },
    {
      id: 'c',
      name: 'Thing',
      factory: '',
      category: 'bass',
      subcategory: '',
      tags: '',
      reason: 'sound: bass',
    },
    {
      id: 'd',
      name: 'Mine',
      factory: '',
      category: 'lead',
      subcategory: 'soft',
      tags: 'soft',
      reason: 'its own category',
    },
    { id: 'e', name: 'Thing two', factory: '', category: '', subcategory: '', tags: '', reason: '' },
  ]);
});

test('a sheet goes to CSV and back, quotes and commas kept', () => {
  const rows = [
    {
      id: 'a',
      name: 'Pad, "the" one',
      factory: 'yes',
      category: 'pad',
      subcategory: '',
      tags: 'dark',
      reason: 'x',
    },
    { id: 'b', name: 'Line\nbreak', factory: '', category: '', subcategory: '', tags: '', reason: '' },
  ];
  const csv = toCsv(rows);
  assert.match(csv, /^id,name,factory,category,subcategory,tags,reason\n/);
  assert.match(csv, /"Pad, ""the"" one"/);
  assert.deepEqual(parseCsv(csv), rows);
  assert.deepEqual(parseCsv('id,category\r\nx,fx\r\n\r\n'), [{ id: 'x', category: 'fx' }]);
});

test('the checked sheet is written with the features of every preset, its description kept', () => {
  const rows = [
    row('a', 'Coin Grab', { description: 'Coins' }),
    row('b', 'Mono Bass', { data: { v: { max: 1 } } }),
    row('c', 'Done', { category: 'pad', tags: ['warm'] }),
  ];
  const sheet = [
    { id: 'a', category: 'fx', subcategory: 'game', tags: 'bright, digital' },
    { id: 'c', category: 'pad', subcategory: '', tags: 'warm' },
  ];
  const { changes, lines, blocked } = planApply(rows, sheet, schema);
  assert.equal(blocked, false);
  assert.deepEqual(changes, [
    {
      id: 'a',
      category: 'fx',
      subcategory: 'game',
      description: 'Coins',
      tags: ['bright', 'digital'],
      features: [],
    },
    { id: 'b', category: null, subcategory: null, tags: [], features: ['mono'] },
  ]);
  assert.equal(lines[0], '3 presets, 2 of the sheet, 2 to write, 2 of a category');
});

test('a sheet the schema refuses, or of a preset that is gone, stops the run', () => {
  const rows = [row('a', 'A'), row('b', 'B')];
  const sheet = [
    { id: 'a', category: 'pad', subcategory: 'sub', tags: '' },
    { id: 'b', category: 'pad', subcategory: '', tags: 'dark warm soft wide' },
    { id: 'zzz', category: 'pad', subcategory: '', tags: '' },
  ];
  const { blocked, lines } = planApply(rows, sheet, schema);
  assert.equal(blocked, true);
  assert.ok(lines.includes('  no preset zzz of the sheet'));
  assert.ok(lines.some((line) => line.startsWith('  A (a): Unknown subcategory')));
  assert.ok(lines.some((line) => line.startsWith('  B (b):')));
});
