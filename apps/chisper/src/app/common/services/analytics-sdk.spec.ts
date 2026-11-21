import type { CaptureResult } from 'posthog-js/dist/module.slim.no-external';
import { ANALYTICS_CONFIG, ANALYTICS_PATH, beforeSend } from './analytics';

// The real SDK of PostHog (not the recorder jest.config.ts maps its modules to: its bundles by their file names)
// as analytics.ts configures it: what it sends, where, what it keeps in the browser
type PostHogModule = typeof import('posthog-js/dist/module.slim.no-external');
type ExtensionsModule = typeof import('posthog-js/dist/extension-bundles');

const requests: { url: string; body: unknown }[] = [];
// what before_send let go
const sent: CaptureResult[] = [];
const fetchStub = jest.fn((url: string, init?: RequestInit) => {
  requests.push({ url, body: init?.body });
  return Promise.resolve({ status: 200, text: () => Promise.resolve('{}'), json: () => Promise.resolve({}) });
});

const start = () => {
  const { PostHog } = require('posthog-js/dist/module.slim.no-external.js') as PostHogModule;
  const { ErrorTrackingExtensions } = require('posthog-js/dist/extension-bundles.js') as ExtensionsModule;
  // (an instance of its own each: a name makes one)
  const instance = new PostHog().init(
    'phc_spec',
    {
      ...ANALYTICS_CONFIG,
      __extensionClasses: { ...ErrorTrackingExtensions },
      before_send: (result) => {
        const kept = beforeSend(result);
        if (kept) sent.push(JSON.parse(JSON.stringify(kept)));
        return kept;
      },
    },
    `spec${++instances}`
  );
  if (!instance) throw new Error('the SDK did not start');
  return instance;
};
let instances = 0;

beforeEach(() => {
  requests.length = 0;
  sent.length = 0;
  Object.assign(globalThis, { fetch: fetchStub });
  Object.defineProperty(navigator, 'doNotTrack', { value: '1', configurable: true });
  Object.defineProperty(navigator, 'globalPrivacyControl', { value: true, configurable: true });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'fetch');
  Reflect.deleteProperty(navigator, 'doNotTrack');
  Reflect.deleteProperty(navigator, 'globalPrivacyControl');
});

describe('the SDK of PostHog as analytics.ts sets it', () => {
  it('sends with Do Not Track and Global Privacy Control on, through the path of the proxy alone', async () => {
    const posthog = start();
    posthog.capture('feature_used', { feature: 'noise', value: null }, { send_instantly: true });
    await new Promise((resolve) => setTimeout(resolve));
    expect(requests.length).toBeGreaterThan(0);
    for (const { url } of requests) {
      expect(new URL(url, window.location.href).pathname.startsWith(`${ANALYTICS_PATH}/`)).toBe(true);
      expect(url).not.toMatch(/posthog\.com/);
    }
  });

  it('asks for no flags, no config, no script: the only requests are the events', async () => {
    const posthog = start();
    posthog.capture('feature_used', { feature: 'sub', value: null }, { send_instantly: true });
    await new Promise((resolve) => setTimeout(resolve));
    expect(requests.map(({ url }) => new URL(url, window.location.href).pathname)).not.toContainEqual(
      expect.stringMatching(/flags|decide|config|static|array/)
    );
    expect(document.querySelectorAll('script')).toHaveLength(0);
  });

  it('keeps nothing in the browser: no cookie, no storage', async () => {
    const posthog = start();
    posthog.capture('feature_used', { feature: 'fx', value: 'reverb' }, { send_instantly: true });
    await new Promise((resolve) => setTimeout(resolve));
    expect(document.cookie).toBe('');
    expect(Object.keys(localStorage)).toEqual([]);
    expect(Object.keys(sessionStorage)).toEqual([]);
  });

  it('sends none of its own events: a pageview is dropped by before_send', async () => {
    const posthog = start();
    posthog.capture('$pageview', {}, { send_instantly: true });
    await new Promise((resolve) => setTimeout(resolve));
    expect(requests).toEqual([]);
  });

  it('an exception as the SDK builds it: one of our origin goes, a value thrown or a frame of an extension not', () => {
    const posthog = start();
    const ours = new Error('ours');
    ours.stack = `Error: ours\n    at load (${window.location.origin}/main.1.js:1:200)\n    at run (${window.location.origin}/main.1.js:1:90)`;
    const theirs = new Error('theirs');
    theirs.stack = 'Error: theirs\n    at inject (chrome-extension://abcdef/content.js:1:20)';
    posthog.captureException(ours, { source: 'load' });
    posthog.captureException('a string thrown', { source: 'rejection' });
    posthog.captureException(theirs, { source: 'window' });
    expect(sent.map(({ event, properties }) => [event, properties['source']])).toEqual([
      ['$exception', 'load'],
    ]);
    const [entry] = sent[0].properties['$exception_list'];
    expect(entry.value).toBe('ours');
    expect(entry.stacktrace.frames.map(({ filename }: { filename: string }) => filename)).toContain(
      `${window.location.origin}/main.1.js`
    );
  });

  it('sends nothing of where the user came from: no click id, no campaign, no search, no referrer but its domain', async () => {
    window.history.replaceState(null, '', '/?preset=abc&fbclid=FB123&gclid=G456&utm_source=news');
    Object.defineProperty(document, 'referrer', {
      value: 'https://www.google.com/search?q=my+secret+query',
      configurable: true,
    });
    try {
      const posthog = start();
      posthog.capture('feature_used', { feature: 'noise', value: null }, { send_instantly: true });
      posthog.captureException(
        Object.assign(new Error('x'), { stack: `Error: x\n    at f (${window.location.origin}/m.js:1:1)` })
      );
      expect(sent).toHaveLength(2);
      const text = JSON.stringify(sent);
      for (const leak of ['FB123', 'G456', 'news', 'secret', 'search?q']) expect(text).not.toContain(leak);
      expect(sent[0].properties['$current_url']).toBe(`${window.location.origin}/?preset=abc`);
    } finally {
      Reflect.deleteProperty(document, 'referrer');
    }
  });
});
