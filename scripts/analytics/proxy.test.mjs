// The proxy of the analytics (netlify.toml) is where the client sends (ANALYTICS_PATH of analytics.ts)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const ROOT = join(import.meta.dirname, '../..');
const toml = readFileSync(join(ROOT, 'netlify.toml'), 'utf8');
const client = readFileSync(join(ROOT, 'apps/chisper/src/app/common/services/analytics.ts'), 'utf8');
const path = client.match(/export const ANALYTICS_PATH = '([^']+)'/)?.[1];

// the redirects of netlify.toml in their order: from, to, status, force
const redirects = [...toml.matchAll(/\[\[redirects\]\]\n((?:[ \t]+\w+ = .+\n?)+)/g)].map(([, body]) =>
  Object.fromEntries(
    [...body.matchAll(/(\w+) = (.+)/g)].map(([, key, value]) => [key, value.replace(/^"|"$/g, '')])
  )
);

describe('the proxy of the analytics', () => {
  it('has a path of the client with no word a filter list blocks', () => {
    assert.match(path ?? '', /^\/[a-z]+$/);
    assert.doesNotMatch(path, /analytic|track|telemetry|posthog|ingest|ph|stat|metric|event|log/);
  });

  it('rewrites the assets, then everything else of the path to PostHog EU (200, forced)', () => {
    const own = redirects.filter(({ from }) => from.startsWith(`${path}/`));
    assert.deepEqual(own, [
      {
        from: `${path}/static/*`,
        to: 'https://eu-assets.i.posthog.com/static/:splat',
        status: '200',
        force: 'true',
      },
      {
        from: `${path}/array/*`,
        to: 'https://eu-assets.i.posthog.com/array/:splat',
        status: '200',
        force: 'true',
      },
      { from: `${path}/*`, to: 'https://eu.i.posthog.com/:splat', status: '200', force: 'true' },
    ]);
  });

  it('comes before any rule that would take the path (a /* of the site)', () => {
    const first = redirects.findIndex(({ from }) => from.startsWith(`${path}/`));
    const takers = redirects.findIndex(
      ({ from }) => from === '/*' || from === `${path}` || from === '/:path*'
    );
    assert.ok(takers === -1 || takers > first);
  });
});
