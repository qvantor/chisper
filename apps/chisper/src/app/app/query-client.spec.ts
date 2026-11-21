import { recordAnalytics } from '../../test-utils/analytics';
import { jsonResponse } from '../../test-utils/query-client';
import { getPreset, listPresets } from '../presets/services/api';
import { createQueryClient } from './query-client';

const fetchMock = jest.fn();
beforeEach(() => {
  fetchMock.mockReset();
  Object.assign(globalThis, { fetch: fetchMock });
});

describe('createQueryClient', () => {
  it('reports a query that names its load once, after its retries; one that names none is not', async () => {
    const { errors, fingerprints } = recordAnalytics();
    const client = createQueryClient({ defaultOptions: { queries: { retry: 2, retryDelay: 0 } } });
    const failing = jest.fn(() => Promise.reject(new TypeError('Failed to fetch')));
    await expect(
      client.fetchQuery({ queryKey: ['list'], queryFn: failing, meta: { load: 'wavetable_list' } })
    ).rejects.toThrow('Failed to fetch');
    expect(failing).toHaveBeenCalledTimes(3);
    await expect(client.fetchQuery({ queryKey: ['other'], queryFn: failing })).rejects.toThrow();
    expect(fingerprints()).toEqual(['load:wavetable_list:TypeError']);
    expect(errors[0].properties).toMatchObject({ source: 'load', what: 'wavetable_list', file: null });
  });

  it('reports an answer of the API with an error of a query once, after its retries', async () => {
    const { errors, fingerprints } = recordAnalytics();
    const client = createQueryClient({ defaultOptions: { queries: { retry: 2, retryDelay: 0 } } });
    fetchMock.mockResolvedValue(jsonResponse(500, {}));
    await expect(
      client.fetchQuery({ queryKey: ['presets'], queryFn: () => listPresets({ sort: 'new', q: 'pad' }) })
    ).rejects.toMatchObject({ status: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fingerprints()).toEqual(['load:api:GET /api/presets:500']);
    expect(errors[0].properties).toMatchObject({ route: '/api/presets', method: 'GET', status: 500 });
  });

  it('reports no answer of the API its request reported already', async () => {
    const { fingerprints } = recordAnalytics();
    const client = createQueryClient({ defaultOptions: { queries: { retry: false } } });
    fetchMock.mockResolvedValue(jsonResponse(404, {}));
    await expect(
      client.fetchQuery({ queryKey: ['preset'], queryFn: () => getPreset('a') })
    ).rejects.toThrow();
    expect(fingerprints()).toEqual(['load:api:GET /api/presets/:id:404']);
  });

  it('reports no load that succeeds', async () => {
    const { errors } = recordAnalytics();
    const client = createQueryClient();
    await client.fetchQuery({
      queryKey: ['list'],
      queryFn: () => Promise.resolve([]),
      meta: { load: 'noise_list' },
    });
    expect(errors).toEqual([]);
  });
});
