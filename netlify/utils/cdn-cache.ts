import { purgeCache } from '@netlify/functions';

// answers kept by the CDN in its shared (durable) cache a day, a deploy clears them; the browser asks the CDN every
// time. The free plan has 125k invocations a month: the lists of tables and noises (asked by every start of the synth)
// and the presets (every start opens one) run the function about once a day for the whole site, not once a visit.
// A list changes only with an upload: a week stale it is still answered while the CDN asks the function again
export const LIST_CDN_CACHE = 'public, durable, s-maxage=86400, stale-while-revalidate=604800';
// a preset changes with its writes, which purge it: a minute stale at most, so one deleted, hidden or not purged (a
// failed purge, the hand of the DB) is answered a day and a minute, never the week of a list
export const PRESET_CDN_CACHE = 'public, durable, s-maxage=86400, stale-while-revalidate=60';
export const BROWSER_REVALIDATE = 'public, max-age=0, must-revalidate';

// a cached answer that may change before its day is over carries the tags of what it is made of; the write that
// changes it purges them (`purgeTags`)
export const presetTag = (id: string) => `preset-${id}`;
export const clipTag = (id: string) => `clip-${id}`;

export const cachedHeaders = (cdnCache: string, tags: string[] = []) => ({
  'Cache-Control': BROWSER_REVALIDATE,
  'Netlify-CDN-Cache-Control': cdnCache,
  ...(tags.length > 0 ? { 'Netlify-Cache-Tag': tags.join(',') } : {}),
});

// the purge API can hang: the function stops waiting for it then (`purgeCache` takes no abort signal)
export const PURGE_TIMEOUT_MS = 5000;

// after the write is committed. A handler passes it to `context.waitUntil` (its answer doesn't wait, the runtime keeps
// the function until the purge is over), a scheduled function awaits it. Never throws: a failed or timed out purge is
// logged and the cache keeps the old answer for the day and the stale time of its policy. No tags, no request: a purge
// without tags is one of the whole site (the lists of tables and noises with it, which save the invocations of the
// free plan). Skipped by `netlify dev`; the purge spreads over the CDN within seconds
export const purgeTags = async (tags: string[]) => {
  if (tags.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      purgeCache({ tags }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Cache purge timed out')), PURGE_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    console.error('Cache purge failed', tags, error);
  } finally {
    clearTimeout(timer);
  }
};
