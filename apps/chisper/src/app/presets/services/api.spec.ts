import { recordAnalytics } from '../../../test-utils/analytics';
import {
  ApiRequestError,
  getPreset,
  getPresetCounts,
  getPresetsByIds,
  getTopPresets,
  isNameAvailable,
  listPresets,
  markPresetOpened,
  queryTopPresets,
  reportPreset,
  savePreset,
  sendUsage,
  updatePreset,
  updatePresetInfo,
} from './api';

const response = (status: number, body?: unknown) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: body === undefined ? () => Promise.reject(new Error('no body')) : () => Promise.resolve(body),
  }) as Response;

const fetchMock = jest.fn();

beforeEach(() => {
  fetchMock.mockReset();
  Object.assign(globalThis, { fetch: fetchMock });
});

describe('api', () => {
  it('GETs without a JSON header and returns the body', async () => {
    fetchMock.mockResolvedValue(response(200, { id: 'a b' }));
    await expect(getPreset('a b')).resolves.toEqual({ id: 'a b' });
    expect(fetchMock).toHaveBeenCalledWith('/api/presets/a%20b', { headers: undefined });
  });

  it('sends JSON with a Content-Type header', async () => {
    fetchMock.mockResolvedValue(response(201, { id: '1', editToken: 't' }));
    const body = { name: 'Bass', data: {}, turnstileToken: 'x' } as never;
    await savePreset(body);
    expect(fetchMock).toHaveBeenCalledWith('/api/presets', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
  });

  it('PUTs updates to the preset url', async () => {
    fetchMock.mockResolvedValue(response(200, { id: '1' }));
    await updatePreset('1', { editToken: 't' } as never);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/presets/1',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ editToken: 't' }) })
    );
  });

  it('POSTs the edit token of an opened preset', async () => {
    fetchMock.mockResolvedValue(response(204));
    await expect(markPresetOpened('a b', { editToken: 't' })).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith('/api/presets/a%20b/opened', {
      method: 'POST',
      body: JSON.stringify({ editToken: 't' }),
      headers: { 'Content-Type': 'application/json' },
    });
  });

  it('returns undefined on 204', async () => {
    fetchMock.mockResolvedValue(response(204));
    await expect(reportPreset('1')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith('/api/presets/1/report', { method: 'POST', headers: undefined });
  });

  it('throws ApiRequestError with the server message', async () => {
    fetchMock.mockResolvedValue(response(429, { error: 'Too many requests' }));
    const error = await getTopPresets().catch((e) => e);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 429, message: 'Too many requests' });
  });

  it('reports an answer with an error: its route without the id, its method and status (not its message)', async () => {
    const { errors, fingerprints } = recordAnalytics();
    fetchMock.mockResolvedValue(response(409, { error: 'This sound is already saved as “Mine”' }));
    await updatePreset('abc', { editToken: 't' } as never).catch(() => undefined);
    fetchMock.mockResolvedValue(response(200, { id: '1' }));
    await getPreset('abc');
    expect(fingerprints()).toEqual(['load:api:PUT /api/presets/:id:409']);
    expect(JSON.stringify(errors)).not.toContain('Mine');
  });

  it('leaves an answer with an error of a query (it retries) to the query cache: the request on the error', async () => {
    const { errors } = recordAnalytics();
    fetchMock.mockResolvedValue(response(500));
    const list = await listPresets({ sort: 'new', q: 'my pad' }).catch((e) => e);
    const name = await isNameAvailable('Mine').catch((e) => e);
    expect(errors).toEqual([]);
    expect(list).toMatchObject({
      status: 500,
      unreported: { path: '/api/presets?q=my+pad&sort=new', method: 'GET' },
    });
    expect(name).toMatchObject({
      status: 500,
      unreported: { path: '/api/presets/name-available?name=Mine', method: 'GET' },
    });
    const reported = await getPreset('abc').catch((e) => e);
    expect(reported).toMatchObject({ status: 500, unreported: null });
    expect(errors).toHaveLength(1);
  });

  it('throws a fallback message when the error body is not JSON', async () => {
    fetchMock.mockResolvedValue(response(500));
    await expect(getTopPresets()).rejects.toMatchObject({
      status: 500,
      message: 'Something went wrong, try again',
    });
  });

  it('builds query params for name availability', async () => {
    fetchMock.mockResolvedValue(response(200, { available: true }));
    await isNameAvailable('My bass & lead');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/presets/name-available?name=My+bass+%26+lead');
  });

  it('adds q, the filter and cursor to the list query only when set', async () => {
    fetchMock.mockResolvedValue(response(200, { items: [], nextCursor: null }));
    await listPresets({ sort: 'popular' });
    await listPresets({ sort: 'new', q: 'pad', cursor: 'c1' });
    await listPresets({
      sort: 'name',
      category: 'fx',
      subcategory: 'game',
      tags: ['dark'],
      features: ['clip'],
    });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/presets?sort=popular');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/presets?q=pad&sort=new&cursor=c1');
    expect(fetchMock.mock.calls[2][0]).toBe(
      '/api/presets?category=fx&subcategory=game&tags=dark&features=clip&sort=name'
    );
  });

  it('asks the popular presets of a filter', async () => {
    fetchMock.mockResolvedValue(response(200, []));
    await getTopPresets();
    await queryTopPresets({ category: 'pad', origin: 'community' });
    await queryTopPresets({ tags: ['dark', 'warm'] });
    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/presets/top',
      '/api/presets/top?category=pad&origin=community',
      '/api/presets/top?tags=dark%2Cwarm',
    ]);
  });

  it('asks the presets of a list of ids 100 at a time, in its order', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `id${i}`);
    fetchMock.mockImplementation((path: string) => {
      const asked = new URLSearchParams(path.split('?')[1]).get('ids')?.split(',') ?? [];
      return Promise.resolve(response(200, { items: asked.map((id) => ({ id })), nextCursor: null }));
    });
    const items = await getPresetsByIds(ids);
    expect(items.map(({ id }) => id)).toEqual(ids);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await getPresetsByIds([])).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('asks the counts and PUTs the info of a preset', async () => {
    fetchMock.mockResolvedValue(response(200, { total: 0, categories: {} }));
    await getPresetCounts();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/presets/counts');
    const body = { editToken: 't', info: { category: 'pad' as const } };
    fetchMock.mockResolvedValue(response(200, { id: 'a b', info: body.info }));
    await updatePresetInfo('a b', body);
    expect(fetchMock).toHaveBeenLastCalledWith('/api/presets/a%20b/info', {
      method: 'PUT',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
  });

  it('POSTs a listen or a stay with its captcha token and keepalive', async () => {
    fetchMock.mockResolvedValue(response(204));
    const body = { presetId: 'p', event: 'stay' as const, turnstileToken: 'captcha-token' };
    await sendUsage(body);
    expect(fetchMock).toHaveBeenCalledWith('/api/usage', {
      method: 'POST',
      body: JSON.stringify(body),
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
    });
  });
});
