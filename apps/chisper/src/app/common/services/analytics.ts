import posthog from 'posthog-js/dist/module.slim.no-external';
import type { CaptureResult, PostHogConfig } from 'posthog-js/dist/module.slim.no-external';
import { ErrorTrackingExtensions } from 'posthog-js/dist/extension-bundles';
import type { RootOptions } from 'react-dom/client';
import { number } from '@chisper/math';
import { publicUrl } from '../../presets/services/url';

// Anonymous analytics and error reports of the synth: PostHog Cloud EU, its SDK bundled (the slim one, nothing it
// loads at run time), its requests through the site (ANALYTICS_PATH, rewritten to PostHog by netlify.toml: no
// domain a blocker knows). A session is a load of the page: the id the SDK draws, kept in memory (no cookie, no
// storage, no IP: the project discards it), never a person. Nothing a user writes is sent (names of presets and
// files, searches), only the ids of the public presets and clips of the URL. On the main thread only: a worklet
// module or a worker never imports this.
//
// Off (every call does nothing) without a key, in the perf build, out of production, on the previews of Netlify
// (*.netlify.app changes the encoding of a proxied request) and on localhost. Nothing waits for a report: the
// failures of the SDK and of the network are swallowed.
//
// `feature_used` comes from what a user does (a handler of the UI, an action it calls), never from a state set by
// a preset, an undo or a restore: the first use of a feature in the session is an event, the others are counted
// for `session_end` (at every hide of the page: what came since the one before, a session's numbers are the sums
// of its reports). A failure the user sees goes through captureError.

// the path of the proxy (netlify.toml): no word a filter list blocks (analytics, tracking, ph, ingest…)
export const ANALYTICS_PATH = '/stave';
const UI_HOST = 'https://eu.posthog.com';

// events of a session at most (feature_used, the exports…): what is over them is dropped
export const MAX_EVENTS = 60;
// exceptions of a session at most, and of one error (its fingerprint): a budget of their own
export const MAX_ERRORS = 20;
export const MAX_REPEATS = 3;
// the length of a message sent, at most
export const MAX_MESSAGE = 1000;
// two calls of a feature this close are one use of it (a drag, a held key)
export const USE_GAP_MS = 1000;

// the features counted: names (and values) are stable, never renamed (the dashboards read them)
export type Feature =
  | 'osc2'
  | 'wavetable'
  | 'wavetable_editor'
  | 'noise'
  | 'sub'
  | 'unison'
  | 'filter'
  | 'fx'
  | 'env'
  | 'lfo'
  | 'route'
  | 'voicing'
  | 'track'
  | 'preset'
  | 'input'
  | 'midi_clock'
  | 'latency'
  | 'export';

const EVENTS = [
  'session_start',
  'engine_status',
  'feature_used',
  'wav_export',
  'midi_export',
  'midi_import',
  'bucket_fallback',
  'session_end',
] as const;
export type AnalyticsEvent = (typeof EVENTS)[number];
const EXCEPTION = '$exception';
// what the SDK may send: ours alone
const SENT: readonly string[] = [...EVENTS, EXCEPTION];
// sent whatever the budget: the denominators, and the files (a user's pace, the metrics the budget is for)
const ALWAYS: readonly AnalyticsEvent[] = [
  'session_start',
  'engine_status',
  'session_end',
  'wav_export',
  'midi_export',
  'midi_import',
];

type Value = string | number | boolean | null;
export type AnalyticsProps = Record<string, Value | Record<string, number>>;

export type ErrorSource = 'window' | 'rejection' | 'react' | 'worker' | 'engine' | 'load';
export interface ErrorContext {
  source: ErrorSource;
  // what groups the error in Error Tracking and in the limits of a session (none: its type and message)
  fingerprint?: string;
  [key: string]: Value | undefined;
}

// what sends: PostHog, a recorder of the specs (test-utils/analytics.ts), none
export interface AnalyticsClient {
  capture: (event: AnalyticsEvent, properties: AnalyticsProps, beacon: boolean) => void;
  captureException: (error: unknown, properties: Record<string, Value>) => void;
}

const fresh = () => ({
  client: null as AnalyticsClient | null,
  // events sent under MAX_EVENTS
  events: 0,
  // the status of the engine of now, on every event
  engine: 'loading',
  engineTold: false,
  // the uses of each feature (`feature` or `feature:value`), the time of its last call
  features: new Map<string, { uses: number; last: number }>(),
  // what is told once a session (a key of its own)
  once: new Set<string>(),
  // the exceptions of the session (not those of no frame of ours) of each error, sent, over the limits
  repeats: new Map<string, number>(),
  sentErrors: 0,
  dropped: 0,
  // what the reports of the session (session_end) have told: its seconds, the errors, the uses of each feature
  told: { seconds: 0, errors: 0, dropped: 0, uses: new Map<string, number>() },
  // this hide of the page told already (a visibilitychange and a pagehide of one hide are one report)
  reported: false,
  // the listeners of the window of the session (initAnalytics), gone with it
  listeners: new AbortController(),
});
let session = fresh();

// seconds since the page started to load, to a tenth
const seconds = () => number.round(performance.now() / 1000, 10);

// the message of what was thrown, at most MAX_MESSAGE long
export const errorMessage = (error: unknown) => {
  const { message } = (error ?? {}) as { message?: unknown };
  return (typeof message === 'string' ? message : String(error)).slice(0, MAX_MESSAGE);
};

// a recorder of the specs, or none (resetAnalytics)
export const attachAnalytics = (client: AnalyticsClient) => {
  session.client = client;
};
export const resetAnalytics = () => {
  session.listeners.abort();
  session = fresh();
};

export const track = (event: AnalyticsEvent, properties: AnalyticsProps = {}, beacon = false) => {
  const { client } = session;
  if (!client) return;
  if (!ALWAYS.includes(event)) {
    if (session.events >= MAX_EVENTS) return;
    session.events += 1;
  }
  try {
    client.capture(event, properties, beacon);
  } catch {
    // (nothing waits for a report)
  }
};

// an event of `key` once a session
export const trackOnce = (key: string, event: AnalyticsEvent, properties: AnalyticsProps = {}) => {
  if (!session.client || session.once.has(key)) return;
  session.once.add(key);
  track(event, properties);
};

// the key of a feature with a value (counted apart, in the uses of session_end)
export const featureKey = (feature: string, value?: string | null) =>
  value === undefined || value === null ? feature : `${feature}:${value}`;

// a user used `feature` (with `value`: a type, an effect, a source): its first use is an event
export const featureUsed = (feature: Feature, value?: string) => {
  if (!session.client) return;
  const key = featureKey(feature, value);
  const now = performance.now();
  const use = session.features.get(key);
  if (use) {
    if (now - use.last >= USE_GAP_MS) use.uses += 1;
    use.last = now;
    return;
  }
  session.features.set(key, { uses: 1, last: now });
  track('feature_used', { feature, value: value ?? null });
};

const named = (name: string, message: string) => Object.assign(new Error(message), { name });

// an error with a stack of its own (not one the SDK would make up where it is called: a frame of ours always)
const hasStack = (error: unknown): error is Error =>
  error instanceof Error && typeof error.stack === 'string' && error.stack.includes('\n');

// `error` (an Error, or a value thrown: the window's and the rejections' are sent as they are, the others with
// the stack of where they are reported)
export const captureError = (error: unknown, { source, fingerprint, ...rest }: ErrorContext) => {
  const { client } = session;
  if (!client) return;
  const own = source === 'window' || source === 'rejection' || hasStack(error);
  const sent = own ? error : named(error instanceof Error ? error.name : 'Error', errorMessage(error));
  const properties: Record<string, Value> = { source };
  Object.entries(rest).forEach(([key, value]) => {
    if (value !== undefined) properties[key] = value;
  });
  if (fingerprint) properties['$exception_fingerprint'] = fingerprint;
  try {
    client.captureException(sent, properties);
  } catch {
    // (nothing waits for a report)
  }
};

// a failure of the engine: `reason` and `stage` of closed lists (one issue each in Error Tracking)
export const captureEngineFailure = (
  reason: string,
  stage: string,
  properties: Record<string, Value | undefined> = {}
) =>
  captureError(named('EngineFailure', `The engine failed: ${reason} in ${stage}`), {
    source: 'engine',
    reason,
    stage,
    fingerprint: `engine:${reason}:${stage}`,
    ...properties,
  });

// a load that failed: a table, a noise, a preset (`what`), its file of the bucket (public, not a user's). One
// aborted (no one waits for it) isn't one
export const captureLoadError = (error: unknown, what: string, file: string | null = null) => {
  if ((error as { name?: unknown } | null)?.name === 'AbortError') return;
  const name = error instanceof Error ? error.name : 'Error';
  captureError(error, { source: 'load', what, file, fingerprint: `load:${what}:${name}` });
};

// the route of a path of the API: no query (a search), no id (`/api/presets/:id/opened`)
const API_WORDS = ['top', 'counts', 'name-available'];
export const apiRoute = (path: string) =>
  path
    .split('?')[0]
    .split('/')
    .map((part, index) => (index === 3 && !API_WORDS.includes(part) ? ':id' : part))
    .join('/');

// an answer of the API with an error: its status, the route and the method (not its message: it may name a preset)
export const captureApiError = (path: string, method: string, status: number) => {
  const route = apiRoute(path);
  captureError(named('ApiError', `${method} ${route} answered ${status}`), {
    source: 'load',
    what: 'api',
    route,
    method,
    status,
    fingerprint: `load:api:${method} ${route}:${status}`,
  });
};

// an error of a worker's script: its message, its place as a frame (the source maps unfold it)
export const captureWorkerError = (event: Event | undefined, worker: string) => {
  if (!session.client) return;
  const { message, filename, lineno, colno } = (event ?? {}) as Partial<ErrorEvent>;
  const error = named('WorkerError', message || `The worker ${worker} failed`);
  if (filename)
    error.stack = `WorkerError: ${error.message}\n    at ${filename}:${lineno ?? 0}:${colno ?? 0}`;
  captureError(error, { source: 'worker', worker });
};

// the status of the engine (the oscillators': loading, ready, unsupported, failed) from now on; the first after
// loading is an event, with what `details` tells of it
export const setEngineStatus = (status: string, details: () => AnalyticsProps) => {
  session.engine = status;
  if (status === 'loading' || session.engineTold || !session.client) return;
  session.engineTold = true;
  track('engine_status', { status, ms: Math.round(performance.now()), ...details() });
};

// a count as its decade (0, 1-9, 10-99…): how many notes, never which
export const countBucket = (count: number) => {
  if (count <= 0) return '0';
  const decade = 10 ** Math.min(3, Math.floor(Math.log10(count)));
  return decade === 1000 ? '1000+' : `${decade}-${decade * 10 - 1}`;
};

// how the session began: a link of a preset, of a clip, or a random popular preset
export const sessionEntry = (preset: string | null, clip: string | null): AnalyticsProps => ({
  entry: preset !== null ? 'preset' : clip !== null ? 'clip' : 'random',
  preset,
  clip,
});

// session_end at every hide of the page (the last moment that is sure: a page hidden may be discarded with no
// pagehide, one back from the bfcache hides again): what came since the report before, its seconds, the uses of
// each feature that grew, the errors. A session's numbers are the sums of its reports (the time of now is `t`)
const reportSession = () => {
  if (session.reported || !session.client) return;
  session.reported = true;
  const { told } = session;
  const uses: Record<string, number> = {};
  session.features.forEach((use, key) => {
    const grown = use.uses - (told.uses.get(key) ?? 0);
    if (grown > 0) uses[key] = grown;
    told.uses.set(key, use.uses);
  });
  const now = seconds();
  const errors = session.sentErrors + session.dropped;
  const { dropped } = session;
  track(
    'session_end',
    {
      seconds: number.round(now - told.seconds, 10),
      uses,
      errors: errors - told.errors,
      dropped: dropped - told.dropped,
    },
    true
  );
  Object.assign(told, { seconds: now, errors, dropped });
};

// the language of the page of the site the user came from (en, es, de: a referrer of this origin, the promo pages;
// none: null, the synth itself at the root too)
export const siteLanguage = (referrer: string, origin = window.location.origin) => {
  if (!referrer.startsWith(`${origin}/`)) return null;
  const [, first] = new URL(referrer).pathname.split('/');
  if (!first) return null;
  return first === 'es' || first === 'de' ? first : 'en';
};

// the URL of the page as it may be sent: its path, the public preset and clip of a link (no click id, no campaign,
// nothing else a link brought)
const pageUrl = (url: string) => {
  try {
    return publicUrl(url);
  } catch {
    return null;
  }
};
// what the SDK adds of where the user came from: a referrer (its domain is kept: $referring_domain), the words of
// a search, campaigns and click ids, as they are and as the session entered
const DROPPED = /referrer|keyword|search_engine|utm_|clid|campaign/;
const URLS = ['$current_url', '$session_entry_url', '$initial_current_url'];

const anonymize = (result: CaptureResult) => {
  const { properties } = result;
  Object.keys(properties).forEach((key) => {
    if (DROPPED.test(key)) delete properties[key];
  });
  URLS.forEach((key) => {
    if (typeof properties[key] === 'string') properties[key] = pageUrl(properties[key]);
  });
  delete result.$set;
  delete result.$set_once;
};

interface ExceptionFrame {
  filename?: string;
}
interface ExceptionEntry {
  type?: string;
  value?: string;
  mechanism?: { synthetic?: boolean };
  stacktrace?: { frames?: ExceptionFrame[] };
}

// (a stack the SDK made up for a value thrown is where it was reported, not where it was thrown)
const ownFrame = (entry: ExceptionEntry) =>
  !entry.mechanism?.synthetic &&
  (entry.stacktrace?.frames?.some(
    ({ filename }) => typeof filename === 'string' && filename.startsWith(window.location.origin)
  ) ??
    false);

// an exception that may go: one with a frame of our code (not an extension's, not "Script error."), its message
// cut, under the limits of the session
const admitException = (properties: Record<string, unknown>) => {
  const list = properties['$exception_list'] as ExceptionEntry[] | undefined;
  if (!Array.isArray(list) || !list.some(ownFrame)) return false;
  list.forEach((entry) => {
    if (typeof entry.value === 'string') entry.value = entry.value.slice(0, MAX_MESSAGE);
  });
  const [{ type, value }] = list;
  const key = String(properties['$exception_fingerprint'] ?? `${type}:${value}`);
  const repeats = (session.repeats.get(key) ?? 0) + 1;
  session.repeats.set(key, repeats);
  if (repeats > MAX_REPEATS || session.sentErrors >= MAX_ERRORS) {
    session.dropped += 1;
    return false;
  }
  session.sentErrors += 1;
  return true;
};

// every event the SDK would send: ours alone (none of its own), anonymous, each with the time in the session, the
// release and the status of the engine; an exception only as admitException lets it
export const beforeSend = (result: CaptureResult | null): CaptureResult | null => {
  if (!result || !SENT.includes(result.event)) return null;
  anonymize(result);
  const { properties } = result;
  properties['t'] = seconds();
  properties['release'] = process.env['NX_PUBLIC_RELEASE'] || null;
  properties['engine'] = session.engine;
  if (result.event === EXCEPTION && !admitException(properties)) return null;
  return result;
};

export const ANALYTICS_CONFIG: Partial<PostHogConfig> = {
  api_host: ANALYTICS_PATH,
  ui_host: UI_HOST,
  persistence: 'memory',
  person_profiles: 'never',
  autocapture: false,
  capture_pageview: false,
  capture_pageleave: false,
  rageclick: false,
  capture_dead_clicks: false,
  capture_heatmaps: false,
  capture_performance: false,
  // (the errors of the window are ours to catch: their source told)
  capture_exceptions: false,
  disable_session_recording: true,
  disable_surveys: true,
  disable_product_tours: true,
  advanced_disable_flags: true,
  disable_external_dependency_loading: true,
  // (no campaign, click ids masked: before_send drops what is left of them, and of the referrer all but its domain)
  save_campaign_params: false,
  mask_personal_data_properties: true,
  before_send: beforeSend,
  __extensionClasses: { ...ErrorTrackingExtensions },
};

const posthogClient: AnalyticsClient = {
  capture: (event, properties, beacon) =>
    posthog.capture(
      event,
      properties,
      beacon ? { transport: 'sendBeacon', send_instantly: true } : undefined
    ),
  captureException: (error, properties) => posthog.captureException(error, properties),
};

export interface AnalyticsEnv {
  key: string;
  perf: boolean;
  production: boolean;
  host: string;
}
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

export const analyticsEnabled = ({ key, perf, production, host }: AnalyticsEnv) =>
  key !== '' && !perf && production && !host.endsWith('.netlify.app') && !LOCAL_HOSTS.includes(host);

// at the start of the page, before React (its errors are a session's too): `start`, what session_start tells
export const initAnalytics = (
  start: AnalyticsProps,
  env: AnalyticsEnv = {
    key: process.env['NX_PUBLIC_ANALYTICS_KEY'] ?? '',
    perf: __PERF__,
    production: process.env['NODE_ENV'] === 'production',
    host: window.location.hostname,
  }
) => {
  if (session.client || !analyticsEnabled(env)) return;
  try {
    posthog.init(env.key, ANALYTICS_CONFIG);
  } catch {
    return;
  }
  attachAnalytics(posthogClient);
  const { signal } = session.listeners;
  window.addEventListener(
    'error',
    (event) => captureError(event.error ?? event.message, { source: 'window' }),
    {
      signal,
    }
  );
  window.addEventListener(
    'unhandledrejection',
    (event) => captureError(event.reason, { source: 'rejection' }),
    {
      signal,
    }
  );
  // (a pagehide: where no visibilitychange comes as the page goes; pageshow: back from the bfcache)
  document.addEventListener(
    'visibilitychange',
    () => {
      if (document.visibilityState === 'hidden') reportSession();
      else session.reported = false;
    },
    { signal }
  );
  window.addEventListener('pagehide', reportSession, { signal });
  window.addEventListener(
    'pageshow',
    () => {
      session.reported = false;
    },
    { signal }
  );
  track('session_start', start);
};

type ErrorInfo = { componentStack?: string | null };
const reactError = (kind: string) => (error: unknown, info: ErrorInfo) => {
  // (React logs none once a handler is given)
  console.error(error, info.componentStack ?? '');
  captureError(error, {
    source: 'react',
    react: kind,
    componentStack: info.componentStack?.slice(0, MAX_MESSAGE) ?? null,
  });
};

// the errors of the root of React (createRoot of main.tsx): a render that threw, one an error boundary caught, one
// React recovered from
export const rootErrorHandlers = {
  onUncaughtError: reactError('uncaught'),
  onCaughtError: reactError('caught'),
  onRecoverableError: reactError('recoverable'),
} satisfies Pick<RootOptions, 'onUncaughtError' | 'onCaughtError' | 'onRecoverableError'>;
