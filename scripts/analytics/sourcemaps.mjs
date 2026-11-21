// The source maps of the build of the synth (dist/apps/chisper: webpack's, with no link to them in the bundles,
// and esbuild's of the worklets and the workers), after `nx build`, before the site joins the folder (`npm run
// build`). In production (Netlify's CONTEXT) they go to PostHog, so the stacks of the errors the app reports unfold
// (common/services/analytics.ts): posthog-cli injects a chunk id into each bundle (the files deployed must be those
// injected), uploads the maps under the release (apps/chisper/release.cjs) and deletes them, in one command.
// Without its keys production fails: a release whose errors wouldn't unfold; a CLI that fails (PostHog or its
// download down) is told and the deploy goes on, its maps removed. Anywhere else (a preview, a local build), and in
// a production without the analytics (no NX_PUBLIC_ANALYTICS_KEY: no error is reported), the maps are only removed:
// they are never deployed. The worklet of the engine is left as it is: it reports no stack (its
// traps are told by its node), its bytes are those of every build.
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { isMain } from '../site/main.mjs';
import { filesOf } from '../site/merge.mjs';
import { releaseOf } from '../../apps/chisper/release.cjs';

const ROOT = join(import.meta.dirname, '../..');
const DIST = join(ROOT, 'dist/apps/chisper');

// a version of the CLI at least two weeks old, pinned (npx fetches it in the build of production alone)
export const CLI = '@posthog/cli@0.19.0';
export const HOST = 'https://eu.posthog.com';
export const RELEASE_NAME = 'chisper';
const KEYS = ['POSTHOG_CLI_API_KEY', 'POSTHOG_CLI_PROJECT_ID'];
const EXCLUDED = '**/engine.js';

// every source map under a folder
export const mapsOf = (dir) =>
  filesOf(dir)
    .filter((file) => file.endsWith('.map'))
    .map((file) => join(dir, file));

const removeMaps = (dir) => {
  const maps = mapsOf(dir);
  maps.forEach((file) => rmSync(file));
  return maps.length;
};

const npx = (args, env) => execFileSync('npx', args, { stdio: 'inherit', env });

// what was done: 'uploaded' (production), 'failed' (its CLI did), 'removed' (anywhere else); `run` runs the CLI
// (the specs record it)
export const sourcemaps = ({ env = process.env, dist = DIST, run = npx, log = console.log } = {}) => {
  const unused =
    env.CONTEXT !== 'production'
      ? (env.CONTEXT ?? 'a local build')
      : !env.NX_PUBLIC_ANALYTICS_KEY && 'production without NX_PUBLIC_ANALYTICS_KEY: no analytics';
  if (unused) {
    log(`source maps: ${removeMaps(dist)} removed (${unused}: none is uploaded)`);
    return 'removed';
  }
  const missing = KEYS.filter((key) => !env[key]);
  if (missing.length)
    throw new Error(`the source maps of production need ${missing.join(' and ')} (the variables of Netlify)`);
  const release = releaseOf(env);
  if (!release) throw new Error('the source maps of production need COMMIT_REF (the release)');
  try {
    run(
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
        EXCLUDED,
        '--release-name',
        RELEASE_NAME,
        '--release-version',
        release,
        '--delete-after',
      ],
      env
    );
  } catch (error) {
    log(`source maps: not uploaded for ${release} (${error.message}), ${removeMaps(dist)} removed`);
    return 'failed';
  }
  // (the map of the worklet of the engine, any other the CLI left)
  log(`source maps: uploaded for ${release}, ${removeMaps(dist)} more removed (${relative(ROOT, dist)})`);
  return 'uploaded';
};

if (isMain(import.meta)) sourcemaps();
