import posthog from 'posthog-js/dist/module.slim.no-external';
import type { CaptureResult } from 'posthog-js/dist/module.slim.no-external';
import { recordAnalytics } from '../../../test-utils/analytics';
import { setVisibility } from '../../../test-utils/visibility';
import {
  ANALYTICS_PATH,
  AnalyticsEnv,
  analyticsEnabled,
  apiRoute,
  beforeSend,
  captureApiError,
  captureEngineFailure,
  captureError,
  captureLoadError,
  captureWorkerError,
  countBucket,
  featureUsed,
  initAnalytics,
  MAX_ERRORS,
  MAX_EVENTS,
  MAX_MESSAGE,
  rootErrorHandlers,
  sessionEntry,
  setEngineStatus,
  siteLanguage,
  track,
  trackOnce,
  USE_GAP_MS,
} from './analytics';

const ON: AnalyticsEnv = { key: 'phc_key', perf: false, production: true, host: 'chisper.qvantor.org' };
const START = { lang: 'en', entry: 'random' };

// posthog.capture as the SDK calls it: through before_send (what it would send, null: dropped)
const sent = () => {
  const { before_send: send } = jest.mocked(posthog.init).mock.calls[0][1] as {
    before_send: typeof beforeSend;
  };
  return jest
    .mocked(posthog.capture)
    .mock.calls.map(([event, properties]) =>
      send({ uuid: '1', event, properties: { ...properties } } as CaptureResult)
    );
};

// an $exception as the SDK builds it: frames in `file` (none: no stack), its message, its fingerprint
const exception = (
  value: string,
  { file = `${window.location.origin}/main.1.js`, fingerprint, synthetic = false } = {} as {
    file?: string | null;
    fingerprint?: string;
    synthetic?: boolean;
  }
) =>
  ({
    uuid: '1',
    event: '$exception',
    properties: {
      $exception_list: [
        {
          type: 'Error',
          value,
          mechanism: { handled: true, synthetic },
          ...(file !== null && {
            stacktrace: { type: 'raw', frames: [{ filename: file, lineno: 1, colno: 2 }] },
          }),
        },
      ],
      ...(fingerprint && { $exception_fingerprint: fingerprint }),
    },
  }) as unknown as CaptureResult;

const now = jest.spyOn(performance, 'now');
beforeEach(() => now.mockReturnValue(1234));

describe('analytics', () => {
  describe('initAnalytics', () => {
    it.each<[string, Partial<AnalyticsEnv>]>([
      ['without a key', { key: '' }],
      ['in the perf build', { perf: true }],
      ['out of production (dev, specs)', { production: false }],
      ['on a preview of Netlify', { host: 'deploy-preview-61--waveformaudio.netlify.app' }],
      ['on localhost', { host: 'localhost' }],
      ['on 127.0.0.1', { host: '127.0.0.1' }],
    ])('sends nothing %s', (_, env) => {
      initAnalytics(START, { ...ON, ...env });
      track('feature_used', { feature: 'noise', value: null });
      featureUsed('noise');
      captureError(new Error('lost'), { source: 'load' });
      window.dispatchEvent(new Event('pagehide'));
      expect(analyticsEnabled({ ...ON, ...env })).toBe(false);
      expect(posthog.init).not.toHaveBeenCalled();
      expect(posthog.capture).not.toHaveBeenCalled();
      expect(posthog.captureException).not.toHaveBeenCalled();
    });

    it('sends nothing by default in the specs (__PERF__, no production)', () => {
      initAnalytics(START);
      expect(posthog.init).not.toHaveBeenCalled();
    });

    it('starts the SDK through the proxy: in memory, no person, nothing captured by itself, then session_start', () => {
      initAnalytics(START, ON);
      expect(posthog.init).toHaveBeenCalledTimes(1);
      const [key, config] = jest.mocked(posthog.init).mock.calls[0];
      expect(key).toBe('phc_key');
      expect(config).toMatchObject({
        api_host: ANALYTICS_PATH,
        ui_host: 'https://eu.posthog.com',
        persistence: 'memory',
        person_profiles: 'never',
        autocapture: false,
        capture_pageview: false,
        capture_pageleave: false,
        rageclick: false,
        capture_dead_clicks: false,
        capture_heatmaps: false,
        capture_performance: false,
        capture_exceptions: false,
        disable_session_recording: true,
        disable_surveys: true,
        disable_product_tours: true,
        advanced_disable_flags: true,
        disable_external_dependency_loading: true,
        before_send: beforeSend,
      });
      // (Do Not Track and Global Privacy Control are not honoured: the data is anonymous)
      expect(config).not.toHaveProperty('respect_dnt');
      expect(config).not.toHaveProperty('opt_out_capturing_by_default');
      expect(posthog.capture).toHaveBeenCalledWith('session_start', START, undefined);
    });

    it('starts once', () => {
      initAnalytics(START, ON);
      initAnalytics(START, ON);
      expect(posthog.init).toHaveBeenCalledTimes(1);
    });

    it('sends with Do Not Track and Global Privacy Control on', () => {
      Object.defineProperty(navigator, 'doNotTrack', { value: '1', configurable: true });
      Object.defineProperty(navigator, 'globalPrivacyControl', { value: true, configurable: true });
      try {
        initAnalytics(START, ON);
        featureUsed('noise');
        expect(posthog.capture).toHaveBeenCalledTimes(2);
      } finally {
        Reflect.deleteProperty(navigator, 'doNotTrack');
        Reflect.deleteProperty(navigator, 'globalPrivacyControl');
      }
    });

    it('a failure of the SDK or of its transport throws nothing', () => {
      jest.mocked(posthog.init).mockImplementationOnce(() => {
        throw new Error('no storage');
      });
      expect(() => initAnalytics(START, ON)).not.toThrow();
      initAnalytics(START, ON);
      jest.mocked(posthog.capture).mockImplementation(() => {
        throw new Error('offline');
      });
      jest.mocked(posthog.captureException).mockImplementation(() => {
        throw new Error('offline');
      });
      expect(() => track('midi_export', { notes: '1-9' })).not.toThrow();
      expect(() => captureError(new Error('x'), { source: 'load' })).not.toThrow();
      jest.mocked(posthog.capture).mockReset();
      jest.mocked(posthog.captureException).mockReset();
    });

    it('catches the errors and the rejections of the window, with their source', () => {
      initAnalytics(START, ON);
      const error = new Error('thrown');
      window.dispatchEvent(new ErrorEvent('error', { error, message: 'thrown' }));
      const reason = new Error('rejected');
      window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason }));
      expect(jest.mocked(posthog.captureException).mock.calls).toEqual([
        [error, { source: 'window' }],
        [reason, { source: 'rejection' }],
      ]);
    });

    describe('session_end', () => {
      const ends = () =>
        jest
          .mocked(posthog.capture)
          .mock.calls.filter(([event]) => event === 'session_end')
          .map(([, properties]) => properties);
      const hide = () => {
        setVisibility('hidden');
        document.dispatchEvent(new Event('visibilitychange'));
      };
      const show = () => {
        setVisibility('visible');
        document.dispatchEvent(new Event('visibilitychange'));
      };

      it('at the hide of the page, by beacon: its length, the uses of each feature, the errors', () => {
        initAnalytics(START, ON);
        featureUsed('noise');
        now.mockReturnValue(1234 + USE_GAP_MS);
        featureUsed('noise');
        featureUsed('fx', 'reverb');
        expect(beforeSend(exception('a'))).not.toBeNull();
        expect(beforeSend(exception('b', { file: null }))).toBeNull();
        now.mockReturnValue(61_000);
        hide();
        // (the pagehide of the same hide)
        window.dispatchEvent(new Event('pagehide'));
        const calls = jest.mocked(posthog.capture).mock.calls.filter(([event]) => event === 'session_end');
        expect(calls).toEqual([
          [
            'session_end',
            { seconds: 61, uses: { noise: 2, 'fx:reverb': 1 }, errors: 1, dropped: 0 },
            { transport: 'sendBeacon', send_instantly: true },
          ],
        ]);
      });

      it('again at every hide: what came since the one before (the uses that grew), its sums the session', () => {
        initAnalytics(START, ON);
        featureUsed('noise');
        featureUsed('fx', 'reverb');
        now.mockReturnValue(10_000);
        hide();
        hide();
        show();
        featureUsed('noise');
        featureUsed('lfo');
        expect(beforeSend(exception('a'))).not.toBeNull();
        now.mockReturnValue(25_300);
        window.dispatchEvent(new Event('pagehide'));
        show();
        now.mockReturnValue(30_000);
        hide();
        expect(ends()).toEqual([
          { seconds: 10, uses: { noise: 1, 'fx:reverb': 1 }, errors: 0, dropped: 0 },
          { seconds: 15.3, uses: { noise: 1, lfo: 1 }, errors: 1, dropped: 0 },
          { seconds: 4.7, uses: {}, errors: 0, dropped: 0 },
        ]);
      });

      it('again after a page comes back from the bfcache', () => {
        initAnalytics(START, ON);
        window.dispatchEvent(new Event('pagehide'));
        window.dispatchEvent(new Event('pageshow'));
        featureUsed('sub');
        window.dispatchEvent(new Event('pagehide'));
        expect(ends().map((end) => end?.['uses'])).toEqual([{}, { sub: 1 }]);
      });
    });
  });

  describe('beforeSend', () => {
    it('gives every event the time of the session, the release and the status of the engine', () => {
      initAnalytics(START, ON);
      now.mockReturnValue(12_345);
      setEngineStatus('ready', () => ({}));
      featureUsed('sub');
      const [, , used] = sent();
      expect(used?.event).toBe('feature_used');
      expect(used?.properties).toEqual({
        feature: 'sub',
        value: null,
        t: 12.3,
        release: null,
        engine: 'ready',
      });
    });

    it('anonymous: the URL its path and the public preset and clip, no referrer but its domain, no campaign', () => {
      const result = beforeSend({
        uuid: '1',
        event: 'feature_used',
        properties: {
          $current_url: 'https://chisper.qvantor.org/?preset=p1&fbclid=FB123&utm_source=news&clip=c1',
          $session_entry_url: 'https://chisper.qvantor.org/es/?gclid=G456',
          $referrer: 'https://www.google.com/search?q=my+secret+query',
          $referring_domain: 'www.google.com',
          $session_entry_referrer: 'https://www.google.com/search?q=my+secret+query',
          ph_keyword: 'my secret query',
          $session_entry_ph_keyword: 'my secret query',
          $search_engine: 'google',
          utm_source: 'news',
          $session_entry_utm_source: 'news',
          gclid: 'G456',
          fbclid: 'FB123',
          feature: 'noise',
        },
        $set: { $referrer: 'https://www.google.com/search?q=my+secret+query' },
        $set_once: { $initial_referrer: 'x' },
      } as unknown as CaptureResult);
      expect(result?.properties).toEqual({
        $current_url: 'https://chisper.qvantor.org/?preset=p1&clip=c1',
        $session_entry_url: 'https://chisper.qvantor.org/es/',
        $referring_domain: 'www.google.com',
        feature: 'noise',
        t: expect.any(Number),
        release: null,
        engine: 'loading',
      });
      expect(result).not.toHaveProperty('$set');
      expect(result).not.toHaveProperty('$set_once');
    });

    it('the URL of a path of repeated slashes with one', () => {
      const result = beforeSend({
        uuid: '1',
        event: 'feature_used',
        properties: { $current_url: 'https://chisper.qvantor.org//?preset=p1&fbclid=X' },
      } as unknown as CaptureResult);
      expect(result?.properties['$current_url']).toBe('https://chisper.qvantor.org/?preset=p1');
    });

    it('drops every event of the SDK of its own', () => {
      for (const event of ['$pageview', '$pageleave', '$autocapture', '$web_vitals', '$set', '$identify'])
        expect(beforeSend({ uuid: '1', event, properties: {} } as CaptureResult)).toBeNull();
      expect(beforeSend(null)).toBeNull();
    });

    it('drops an exception with no frame of ours: an extension, "Script error.", a stack the SDK made up', () => {
      expect(
        beforeSend(exception('of an extension', { file: 'chrome-extension://abc/content.js' }))
      ).toBeNull();
      expect(beforeSend(exception('Script error.', { file: null }))).toBeNull();
      expect(beforeSend(exception('a string thrown', { synthetic: true }))).toBeNull();
      expect(beforeSend(exception('ours'))).not.toBeNull();
    });

    it('cuts the message of an exception', () => {
      const result = beforeSend(exception('x'.repeat(5000)));
      const [entry] = result?.properties['$exception_list'] as { value: string }[];
      expect(entry.value).toHaveLength(MAX_MESSAGE);
    });

    it('one error at most 3 times a session, the others counted; 20 errors at most, apart from the events', () => {
      initAnalytics(START, ON);
      // the budget of the events spent
      for (let i = 0; i < MAX_EVENTS + 5; i++) featureUsed('fx', `${i}`);
      const results = Array.from({ length: 5 }, () => beforeSend(exception('same')));
      expect(results.map((result) => result !== null)).toEqual([true, true, true, false, false]);
      // (a fingerprint of its own groups them)
      const engine = Array.from({ length: 4 }, (_, i) =>
        beforeSend(exception(`message ${i}`, { fingerprint: 'engine:broken:engine' }))
      );
      expect(engine.map((result) => result !== null)).toEqual([true, true, true, false]);
      const others = Array.from({ length: 30 }, (_, i) => beforeSend(exception(`other ${i}`)));
      expect(others.filter((result) => result !== null)).toHaveLength(MAX_ERRORS - 6);
      window.dispatchEvent(new Event('pagehide'));
      const [end] = jest.mocked(posthog.capture).mock.calls.filter(([event]) => event === 'session_end');
      expect(end[1]).toMatchObject({ errors: 39, dropped: 39 - MAX_ERRORS });
    });
  });

  describe('track', () => {
    it('60 events a session at most; the denominators and the files whatever the budget', () => {
      const { events } = recordAnalytics();
      for (let i = 0; i < MAX_EVENTS + 10; i++) featureUsed('lfo', `${i}`);
      track('session_start', {});
      setEngineStatus('ready', () => ({}));
      track('wav_export', {});
      track('midi_export', {});
      track('midi_import', {});
      track('session_end', {}, true);
      expect(events.filter(({ event }) => event === 'feature_used')).toHaveLength(MAX_EVENTS);
      expect(events.slice(MAX_EVENTS).map(({ event }) => event)).toEqual([
        'session_start',
        'engine_status',
        'wav_export',
        'midi_export',
        'midi_import',
        'session_end',
      ]);
    });

    it('trackOnce: once a session by its key', () => {
      const { named } = recordAnalytics();
      trackOnce('bucket:noises', 'bucket_fallback', { bucket: 'noises' });
      trackOnce('bucket:noises', 'bucket_fallback', { bucket: 'noises' });
      trackOnce('bucket:wavetables', 'bucket_fallback', { bucket: 'wavetables' });
      expect(named('bucket_fallback')).toEqual([{ bucket: 'noises' }, { bucket: 'wavetables' }]);
    });
  });

  describe('featureUsed', () => {
    it('the first use of a feature (of each value) in the session is an event', () => {
      const { features } = recordAnalytics();
      featureUsed('noise');
      featureUsed('noise');
      featureUsed('fx', 'reverb');
      featureUsed('fx', 'delay');
      featureUsed('fx', 'reverb');
      expect(features()).toEqual(['noise', 'fx:reverb', 'fx:delay']);
    });
  });

  describe('setEngineStatus', () => {
    it('engine_status once: the first status after loading, what it found', () => {
      const { named } = recordAnalytics();
      setEngineStatus('loading', () => ({ reason: 'never asked' }));
      now.mockReturnValue(812.4);
      setEngineStatus('unsupported', () => ({ reason: 'wasm-simd' }));
      setEngineStatus('ready', () => ({ reason: null }));
      expect(named('engine_status')).toEqual([{ status: 'unsupported', ms: 812, reason: 'wasm-simd' }]);
    });
  });

  describe('errors', () => {
    it('an error with a stack goes as it is; a value thrown, with the stack of where it is reported', () => {
      const { errors } = recordAnalytics();
      const error = new Error('with a stack');
      captureError(error, { source: 'load', what: 'noise', skipped: undefined });
      captureError('a string', { source: 'engine' });
      captureError('a string', { source: 'rejection' });
      expect(errors[0]).toEqual({ error, properties: { source: 'load', what: 'noise' } });
      expect(errors[1].error).toBeInstanceOf(Error);
      expect((errors[1].error as Error).message).toBe('a string');
      expect(errors[2].error).toBe('a string');
    });

    it('a failure of the engine: of closed lists, its fingerprint', () => {
      const { errors } = recordAnalytics();
      captureEngineFailure('stage', 'reverb', { trap: 'unreachable' });
      expect(errors[0].error).toMatchObject({
        name: 'EngineFailure',
        message: 'The engine failed: stage in reverb',
      });
      expect(errors[0].properties).toEqual({
        source: 'engine',
        reason: 'stage',
        stage: 'reverb',
        trap: 'unreachable',
        $exception_fingerprint: 'engine:stage:reverb',
      });
    });

    it('a worker: its message, its file and line as the frame of the stack', () => {
      const { errors } = recordAnalytics();
      captureWorkerError(
        new ErrorEvent('error', {
          message: 'Uncaught TypeError: x is null',
          filename: 'https://chisper.qvantor.org/assets/worklets/wavetable-worker.js',
          lineno: 1,
          colno: 345,
        }),
        'wavetable-worker'
      );
      captureWorkerError(new Event('error'), 'track-clock');
      expect(errors.map(({ properties }) => properties)).toEqual([
        { source: 'worker', worker: 'wavetable-worker' },
        { source: 'worker', worker: 'track-clock' },
      ]);
      expect((errors[0].error as Error).stack).toBe(
        'WorkerError: Uncaught TypeError: x is null\n    at https://chisper.qvantor.org/assets/worklets/wavetable-worker.js:1:345'
      );
      expect((errors[1].error as Error).message).toBe('The worker track-clock failed');
    });

    it('a load: an abort is none', () => {
      const { errors } = recordAnalytics();
      captureLoadError(new DOMException('gone', 'AbortError'), 'wavetable', 'a.wav');
      captureLoadError(new TypeError('Failed to fetch'), 'wavetable', 'a.wav');
      expect(errors.map(({ properties }) => properties)).toEqual([
        {
          source: 'load',
          what: 'wavetable',
          file: 'a.wav',
          $exception_fingerprint: 'load:wavetable:TypeError',
        },
      ]);
    });

    it('an answer of the API: its route without an id or a query, never its message', () => {
      const { errors } = recordAnalytics();
      captureApiError('/api/presets/abc123/opened', 'POST', 500);
      expect(errors[0].error).toMatchObject({
        name: 'ApiError',
        message: 'POST /api/presets/:id/opened answered 500',
      });
      expect(errors[0].properties).toEqual({
        source: 'load',
        what: 'api',
        route: '/api/presets/:id/opened',
        method: 'POST',
        status: 500,
        $exception_fingerprint: 'load:api:POST /api/presets/:id/opened:500',
      });
      expect(apiRoute('/api/presets?sort=top&q=my%20secret')).toBe('/api/presets');
      expect(apiRoute('/api/presets/top?category=fx')).toBe('/api/presets/top');
      expect(apiRoute('/api/presets/counts')).toBe('/api/presets/counts');
      expect(apiRoute('/api/presets/abc/info')).toBe('/api/presets/:id/info');
      expect(apiRoute('/api/presets/name-available?name=Mine')).toBe('/api/presets/name-available');
      expect(apiRoute('/api/clips/xyz')).toBe('/api/clips/:id');
      expect(apiRoute('/api/usage')).toBe('/api/usage');
    });

    it('the handlers of the root of React: the error with its component stack, still logged', () => {
      const { errors } = recordAnalytics();
      const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const error = new Error('render');
      rootErrorHandlers.onUncaughtError(error, { componentStack: '\n    at Knob' });
      rootErrorHandlers.onCaughtError(error, { componentStack: '\n    at Knob' });
      rootErrorHandlers.onRecoverableError(error, {});
      expect(errors.map(({ properties }) => properties)).toEqual([
        { source: 'react', react: 'uncaught', componentStack: '\n    at Knob' },
        { source: 'react', react: 'caught', componentStack: '\n    at Knob' },
        { source: 'react', react: 'recoverable', componentStack: null },
      ]);
      expect(log).toHaveBeenCalledTimes(3);
    });
  });

  it('countBucket: a count as its decade', () => {
    expect([0, 1, 9, 10, 99, 100, 999, 1000, 5000].map(countBucket)).toEqual([
      '0',
      '1-9',
      '1-9',
      '10-99',
      '10-99',
      '100-999',
      '100-999',
      '1000+',
      '1000+',
    ]);
  });

  it('siteLanguage: the language of the page of the site the user came from', () => {
    const origin = 'https://chisper.qvantor.org';
    expect(siteLanguage(`${origin}/es/sintetizador-wavetable/`, origin)).toBe('es');
    expect(siteLanguage(`${origin}/de/anleitung/erste-schritte/`, origin)).toBe('de');
    expect(siteLanguage(`${origin}/manual/getting-started/`, origin)).toBe('en');
    expect(siteLanguage('https://www.google.com/', origin)).toBeNull();
    expect(siteLanguage('', origin)).toBeNull();
    // (the synth itself: a link of its own opened from it)
    expect(siteLanguage(`${origin}/?preset=p1`, origin)).toBeNull();
    expect(siteLanguage(`${origin}/`, origin)).toBeNull();
  });

  it('sessionEntry: a link of a preset, of a clip, or a random preset', () => {
    expect(sessionEntry('p1', null)).toEqual({ entry: 'preset', preset: 'p1', clip: null });
    expect(sessionEntry('p1', 'c1')).toEqual({ entry: 'preset', preset: 'p1', clip: 'c1' });
    expect(sessionEntry(null, 'c1')).toEqual({ entry: 'clip', preset: null, clip: 'c1' });
    expect(sessionEntry(null, null)).toEqual({ entry: 'random', preset: null, clip: null });
  });
});
