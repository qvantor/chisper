import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { loadApp } from '../bench-perf/util.mjs';
import { plan, startedAs } from './rehash.mjs';

const { rehashPresets } = await loadApp({
  contents: `export { rehashPresets } from './netlify/utils/rehash';`,
  name: 'rehash-test',
});

test('a preset of the schema of now is left alone, one of before is rewritten', () => {
  const fresh = plan([{ id: 'a', hash: 'stale', data: {} }], rehashPresets);
  assert.equal(fresh.changes.length, 1);
  assert.equal(fresh.blocked, false);
  const [{ hash, data }] = fresh.changes;
  assert.equal(data.fx.compressor.a, false);
  assert.equal(data.fx.chorus.a, false);
  assert.deepEqual(data.fx.o, ['distortion', 'chorus', 'delay', 'compressor', 'reverb']);
  const again = plan([{ id: 'a', hash, data }], rehashPresets);
  assert.equal(again.changes.length, 0);
  assert.match(again.lines[0], /^1 presets, 0 to rewrite, 0 the schema rejects$/);
});

test('rejected presets are listed, presets of one sound block the run', () => {
  const { lines, blocked, changes } = plan(
    [
      { id: 'a', hash: 'x', data: {} },
      { id: 'b', hash: 'y', data: {} },
      { id: 'bad', hash: 'z', data: { osc1: { u: 99 } } },
    ],
    rehashPresets
  );
  assert.equal(blocked, true);
  assert.equal(changes.length, 2);
  assert.ok(lines.some((line) => line.startsWith('  rejected bad:')));
  assert.ok(lines.includes('  the same sound: a, b'));
});

test('the script knows it was started from a path with a space and through a link', () => {
  const folder = mkdtempSync(join(tmpdir(), 'rehash main '));
  try {
    const script = join(folder, 'rehash.mjs');
    writeFileSync(script, '');
    const link = join(folder, 'link.mjs');
    symlinkSync(script, link);
    const url = pathToFileURL(realpathSync(script)).href;
    assert.match(url, /%20/);
    assert.equal(startedAs(url, script), true);
    assert.equal(startedAs(url, link), true);
    assert.equal(startedAs(url, join(folder, 'other.mjs')), false);
    assert.equal(startedAs(url, undefined), false);
    writeFileSync(join(folder, 'other.mjs'), '');
    assert.equal(startedAs(url, join(folder, 'other.mjs')), false);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
