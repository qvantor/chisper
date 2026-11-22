import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bareName, FACTORY_IP_PREFIX, idsOf, plan } from './flags.mjs';

const FACTORY = `${FACTORY_IP_PREFIX}aaaa`;
const row = (id, name, rest = {}) => ({
  id,
  name,
  ipHash: 'user',
  factory: false,
  aiGenerated: false,
  category: null,
  ...rest,
});

test('a name loses "[AI] " and then "FX ", an FX taken for one; others stay', () => {
  assert.deepEqual(bareName('[AI] Warm Pad'), { name: 'Warm Pad', fx: false });
  assert.deepEqual(bareName('[AI] FX Coin Grab'), { name: 'Coin Grab', fx: true });
  assert.deepEqual(bareName('[AI]  FX  Laser'), { name: 'Laser', fx: true });
  assert.deepEqual(bareName('[AI] FX Reverse Swell'), { name: 'Reverse Riser', fx: true });
  assert.deepEqual(bareName('FX Thing'), { name: 'FX Thing', fx: false });
  assert.deepEqual(bareName('Dotted Echo Pluck'), { name: 'Dotted Echo Pluck', fx: false });
});

test('the presets of the author are factory, their "[AI]" ones AI generated with bare names, FX ones of FX', () => {
  const { changes, lines, blocked } = plan([
    row('a', '[AI] FX Coin Grab', { ipHash: FACTORY }),
    row('b', '[AI] Warm Pad', { ipHash: FACTORY }),
    row('c', 'Dotted Echo Pluck', { ipHash: FACTORY }),
    row('d', '[AI] Warm Padjfjfjy'),
    row('e', 'My Bass'),
  ]);
  assert.equal(blocked, false);
  assert.deepEqual(
    changes.map(({ id, name, factory, aiGenerated, category }) => [id, name, factory, aiGenerated, category]),
    [
      ['a', 'Coin Grab', true, true, 'fx'],
      ['b', 'Warm Pad', true, true, null],
      ['c', 'Dotted Echo Pluck', true, false, null],
    ]
  );
  assert.equal(lines[0], '5 presets: 3 factory, 2 AI generated, 2 renamed, 3 to write');
  assert.ok(lines.includes('  [AI] FX Coin Grab → Coin Grab'));
});

test('an "[AI]" preset of a user, a copy of one of the author\'s, stays as it is', () => {
  const { changes, lines } = plan([
    row('a', '[AI] FX Coin Grab', { ipHash: FACTORY }),
    row('b', '[AI] FX Coin Grab 2'),
    row('c', '[AI] Warm Pad no rev'),
  ]);
  assert.deepEqual(
    changes.map(({ id }) => id),
    ['a']
  );
  assert.equal(lines[0], '3 presets: 1 factory, 1 AI generated, 1 renamed, 1 to write');
});

test('a category of its own stays', () => {
  const { changes } = plan([row('a', '[AI] FX Boom', { ipHash: FACTORY, category: 'drums' })]);
  assert.equal(changes[0].category, 'drums');
});

test('a second run writes nothing', () => {
  const first = plan([row('a', '[AI] FX Boom', { ipHash: FACTORY }), row('b', 'Mine')]);
  const written = [
    { ...row('a', 'Boom', { ipHash: FACTORY }), factory: true, aiGenerated: true, category: 'fx' },
    row('b', 'Mine'),
  ];
  assert.equal(first.changes.length, 1);
  assert.deepEqual(plan(written).changes, []);
});

test('the ids of --ai are AI generated, whatever their names; an unknown one is told', () => {
  const { changes, lines } = plan([row('a', 'Restless Bass', { ipHash: FACTORY }), row('B', 'Other')], {
    aiIds: ['a', 'b', 'zzz'],
  });
  assert.deepEqual(
    changes.map(({ id, name, aiGenerated }) => [id, name, aiGenerated]),
    [
      ['a', 'Restless Bass', true],
      ['B', 'Other', true],
    ]
  );
  assert.ok(lines.includes('  no preset zzz of --ai'));
  assert.deepEqual(idsOf(['x', 'y']), ['x', 'y']);
  assert.deepEqual(idsOf({ x: 'token', y: 'token' }), ['x', 'y']);
});

test('a name two presets would have stops the run, in any case', () => {
  const { blocked, lines } = plan([
    row('a', '[AI] Bright Keys', { ipHash: FACTORY }),
    row('b', 'bright keys'),
  ]);
  assert.equal(blocked, true);
  assert.ok(lines.includes('  one name: [AI] Bright Keys → Bright Keys, bright keys'));
});

test('the FX Reverse Swell is renamed apart from the pad of that name', () => {
  const { blocked, changes } = plan([
    row('a', '[AI] FX Reverse Swell', { ipHash: FACTORY }),
    row('b', '[AI] Reverse Swell', { ipHash: FACTORY }),
  ]);
  assert.equal(blocked, false);
  assert.deepEqual(
    changes.map(({ name }) => name),
    ['Reverse Riser', 'Reverse Swell']
  );
});

test('the run stops without one ip hash of the author', () => {
  assert.equal(plan([row('a', 'A')]).blocked, true);
  const two = plan([row('a', 'A', { ipHash: FACTORY }), row('b', 'B', { ipHash: `${FACTORY}b` })]);
  assert.equal(two.blocked, true);
  assert.match(two.lines[0], /^2 ip hashes start with 389e880d/);
});
