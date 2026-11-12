import { purgeCache } from '@netlify/functions';
import {
  BROWSER_REVALIDATE,
  cachedHeaders,
  LIST_CDN_CACHE,
  PRESET_CDN_CACHE,
  PURGE_TIMEOUT_MS,
  purgeTags,
} from './cdn-cache';

jest.mock('@netlify/functions', () => ({ purgeCache: jest.fn() }));

const purgeCacheMock = purgeCache as jest.Mock;

beforeEach(() => {
  purgeCacheMock.mockReset().mockResolvedValue(undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('cachedHeaders', () => {
  it('keeps the answer in the CDN by its policy, the browser asks the CDN every time', () => {
    expect(cachedHeaders(PRESET_CDN_CACHE, ['preset-1', 'clip-2'])).toEqual({
      'Cache-Control': BROWSER_REVALIDATE,
      'Netlify-CDN-Cache-Control': PRESET_CDN_CACHE,
      'Netlify-Cache-Tag': 'preset-1,clip-2',
    });
  });

  it('sends no tag header without tags', () => {
    expect(cachedHeaders(LIST_CDN_CACHE)).toEqual({
      'Cache-Control': BROWSER_REVALIDATE,
      'Netlify-CDN-Cache-Control': LIST_CDN_CACHE,
    });
  });
});

describe('purgeTags', () => {
  it('purges the tags', async () => {
    await purgeTags(['preset-1', 'clip-2']);
    expect(purgeCacheMock).toHaveBeenCalledTimes(1);
    expect(purgeCacheMock).toHaveBeenCalledWith({ tags: ['preset-1', 'clip-2'] });
    expect(console.error).not.toHaveBeenCalled();
  });

  it('sends no request without tags', async () => {
    await purgeTags([]);
    expect(purgeCacheMock).not.toHaveBeenCalled();
  });

  it('logs a failed purge, never throws', async () => {
    const error = new Error('Cache purge API call returned an unexpected status code: 429');
    purgeCacheMock.mockRejectedValue(error);
    await expect(purgeTags(['preset-1'])).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith('Cache purge failed', ['preset-1'], error);
  });

  it('stops waiting for a hung purge after its timeout, logging it', async () => {
    jest.useFakeTimers();
    purgeCacheMock.mockReturnValue(new Promise(() => undefined));
    let settled = false;
    const purge = purgeTags(['preset-1']).then(() => (settled = true));

    await jest.advanceTimersByTimeAsync(PURGE_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await purge;
    expect(settled).toBe(true);
    expect(console.error).toHaveBeenCalledWith(
      'Cache purge failed',
      ['preset-1'],
      new Error('Cache purge timed out')
    );
  });

  it('leaves no timer behind a purge that answered', async () => {
    jest.useFakeTimers();
    await purgeTags(['preset-1']);
    expect(jest.getTimerCount()).toBe(0);
  });
});
