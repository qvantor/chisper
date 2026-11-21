import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { CLI, HOST, mapsOf, RELEASE_NAME, sourcemaps } from './sourcemaps.mjs';

const write = (root, file) => {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), file);
};

describe('sourcemaps', () => {
  let dist;
  let runs;
  const run = (args, env) => runs.push({ args, env });
  const maps = () =>
    mapsOf(dist)
      .map((file) => relative(dist, file))
      .sort();

  beforeEach(() => {
    dist = mkdtempSync(join(tmpdir(), 'sourcemaps-'));
    runs = [];
    for (const file of [
      'main.1.js',
      'main.1.js.map',
      'assets/worklets/engine.js',
      'assets/worklets/engine.js.map',
    ])
      write(dist, file);
  });

  afterEach(() => rmSync(dist, { recursive: true, force: true }));

  for (const CONTEXT of ['deploy-preview', 'branch-deploy', undefined])
    it(`${CONTEXT ?? 'a local build'}: removes the maps, uploads nothing (even with the keys)`, () => {
      const env = {
        CONTEXT,
        POSTHOG_CLI_API_KEY: 'key',
        POSTHOG_CLI_PROJECT_ID: '1',
        COMMIT_REF: 'abcdef123',
      };
      assert.equal(sourcemaps({ env, dist, run, log: () => undefined }), 'removed');
      assert.deepEqual(runs, []);
      assert.deepEqual(maps(), []);
    });

  it('production without the analytics (no NX_PUBLIC_ANALYTICS_KEY): removes the maps, needs no keys', () => {
    const env = { CONTEXT: 'production', COMMIT_REF: 'abcdef123' };
    assert.equal(sourcemaps({ env, dist, run, log: () => undefined }), 'removed');
    assert.deepEqual(runs, []);
    assert.deepEqual(maps(), []);
  });

  it('production without the keys fails the build', () => {
    for (const env of [
      { CONTEXT: 'production', NX_PUBLIC_ANALYTICS_KEY: 'phc_key', COMMIT_REF: 'abcdef123' },
      {
        CONTEXT: 'production',
        NX_PUBLIC_ANALYTICS_KEY: 'phc_key',
        COMMIT_REF: 'abcdef123',
        POSTHOG_CLI_API_KEY: 'key',
      },
      {
        CONTEXT: 'production',
        NX_PUBLIC_ANALYTICS_KEY: 'phc_key',
        COMMIT_REF: 'abcdef123',
        POSTHOG_CLI_PROJECT_ID: '1',
      },
      {
        CONTEXT: 'production',
        NX_PUBLIC_ANALYTICS_KEY: 'phc_key',
        POSTHOG_CLI_API_KEY: 'key',
        POSTHOG_CLI_PROJECT_ID: '1',
      },
    ])
      assert.throws(() => sourcemaps({ env, dist, run, log: () => undefined }), /need/);
    assert.deepEqual(runs, []);
  });

  it('production injects the chunk ids and uploads the maps under the release in one command, removes them all', () => {
    const env = {
      CONTEXT: 'production',
      NX_PUBLIC_ANALYTICS_KEY: 'phc_key',
      POSTHOG_CLI_API_KEY: 'key',
      POSTHOG_CLI_PROJECT_ID: '1',
      COMMIT_REF: 'abcdef123',
    };
    assert.equal(sourcemaps({ env, dist, run, log: () => undefined }), 'uploaded');
    assert.deepEqual(
      runs.map(({ args }) => args),
      [
        [
          '-y',
          CLI,
          '--host',
          HOST,
          'sourcemap',
          'process',
          '--directory',
          dist,
          '--exclude',
          '**/engine.js',
          '--release-name',
          RELEASE_NAME,
          '--release-version',
          'abcdef1',
          '--delete-after',
        ],
      ]
    );
    assert.equal(runs[0].env.POSTHOG_CLI_API_KEY, 'key');
    assert.equal(runs[0].env.POSTHOG_CLI_PROJECT_ID, '1');
    // (the CLI of the spec deletes nothing: the worklet's and every other left are removed)
    assert.deepEqual(maps(), []);
  });

  it('the release of the bundles: NX_PUBLIC_RELEASE where it is set, not empty', () => {
    const release = (NX_PUBLIC_RELEASE) => {
      runs = [];
      const env = {
        CONTEXT: 'production',
        NX_PUBLIC_ANALYTICS_KEY: 'phc_key',
        POSTHOG_CLI_API_KEY: 'key',
        POSTHOG_CLI_PROJECT_ID: '1',
        COMMIT_REF: 'abcdef123',
        NX_PUBLIC_RELEASE,
      };
      sourcemaps({ env, dist, run, log: () => undefined });
      return runs[0].args[runs[0].args.indexOf('--release-version') + 1];
    };
    assert.equal(release('v42'), 'v42');
    assert.equal(release(''), 'abcdef1');
  });

  it('production with a CLI that fails (PostHog down): told, the maps removed, the deploy goes on', () => {
    const env = {
      CONTEXT: 'production',
      NX_PUBLIC_ANALYTICS_KEY: 'phc_key',
      POSTHOG_CLI_API_KEY: 'key',
      POSTHOG_CLI_PROJECT_ID: '1',
      COMMIT_REF: 'abcdef123',
    };
    const logs = [];
    const failing = () => {
      throw new Error('Command failed: npx');
    };
    assert.equal(sourcemaps({ env, dist, run: failing, log: (line) => logs.push(line) }), 'failed');
    assert.deepEqual(maps(), []);
    assert.match(logs[0], /not uploaded for abcdef1/);
  });
});
