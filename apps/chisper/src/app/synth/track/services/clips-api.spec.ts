import type { Clip } from '@chisper/preset-schema';
import { ApiRequestError } from '../../../presets/services/api';
import { fetchClip, saveClip, updateClip } from './clips-api';

const response = (status: number, body?: unknown) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: body === undefined ? () => Promise.reject(new Error('no body')) : () => Promise.resolve(body),
  }) as Response;

const fetchMock = jest.fn();

const clip: Clip = { bpm: 120, length: 3840, notes: [[0, 960, 60, 100]], name: 'Loop' };

beforeEach(() => {
  fetchMock.mockReset();
  Object.assign(globalThis, { fetch: fetchMock });
});

describe('clips api', () => {
  it('GETs a clip by its id without a JSON header', async () => {
    const body = { id: 'a b', clip, createdAt: '2026-01-01T00:00:00Z' };
    fetchMock.mockResolvedValue(response(200, body));
    await expect(fetchClip('a b')).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith('/api/clips/a%20b', { headers: undefined });
  });

  it('POSTs a new clip with its captcha token', async () => {
    fetchMock.mockResolvedValue(response(201, { id: '1', existed: false, editToken: 't' }));
    await expect(saveClip(clip, 'captcha')).resolves.toEqual({ id: '1', existed: false, editToken: 't' });
    expect(fetchMock).toHaveBeenCalledWith('/api/clips', {
      method: 'POST',
      body: JSON.stringify({ clip, turnstileToken: 'captcha' }),
      headers: { 'Content-Type': 'application/json' },
    });
  });

  it('returns a clip saved before without a token', async () => {
    fetchMock.mockResolvedValue(response(200, { id: '2', existed: true }));
    await expect(saveClip(clip, 'captcha')).resolves.toEqual({ id: '2', existed: true });
  });

  it('PUTs an update with the edit token to the clip url', async () => {
    fetchMock.mockResolvedValue(response(200, { id: 'a b' }));
    await expect(updateClip('a b', clip, 'token')).resolves.toEqual({ id: 'a b' });
    expect(fetchMock).toHaveBeenCalledWith('/api/clips/a%20b', {
      method: 'PUT',
      body: JSON.stringify({ clip, editToken: 'token' }),
      headers: { 'Content-Type': 'application/json' },
    });
  });

  it('throws ApiRequestError with the server message', async () => {
    fetchMock.mockResolvedValue(response(429, { error: 'Too many clips saved, try again later' }));
    const error = await saveClip(clip, 'captcha').catch((e) => e);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 429, message: 'Too many clips saved, try again later' });
  });

  it('throws a fallback message when the error body is not JSON', async () => {
    fetchMock.mockResolvedValue(response(502));
    await expect(fetchClip('1')).rejects.toMatchObject({
      status: 502,
      message: 'Something went wrong, try again',
    });
  });
});
