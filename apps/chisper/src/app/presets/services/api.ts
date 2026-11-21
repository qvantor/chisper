import type {
  ApiError,
  NameAvailableResponse,
  Preset,
  PresetListItem,
  PresetOpenedRequest,
  PresetSort,
  PresetsPage,
  SavePresetRequest,
  SavePresetResponse,
  UpdatePresetRequest,
  UpdatePresetResponse,
  UsageRequest,
} from '@chisper/preset-schema';
import { captureApiError } from '../../common/services/analytics';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    // the request of an answer not reported yet (a query's: the query cache reports its last, app/query-client.ts)
    readonly unreported: { path: string; method: string } | null = null
  ) {
    super(message);
  }
}

// JSON in and out, the message of an error as an ApiRequestError; an answer with an error reported (`report`) or
// left on the error for the query cache
const send = async <T>(path: string, init: RequestInit | undefined, report: boolean): Promise<T> => {
  const response = await fetch(path, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  if (!response.ok) {
    const method = init?.method ?? 'GET';
    if (report) captureApiError(path, method, response.status);
    const body: Partial<ApiError> = await response.json().catch(() => ({}));
    const message = body.error ?? 'Something went wrong, try again';
    throw new ApiRequestError(response.status, message, report ? null : { path, method });
  }
  return response.status === 204 ? (undefined as T) : response.json();
};

// a request of our API (clips use it too): an answer with an error is reported
export const request = <T>(path: string, init?: RequestInit) => send<T>(path, init, true);

// a GET of a query of react-query: it retries, so the query cache reports its last failure, once
// (app/query-client.ts)
const queryGet = <T>(path: string) => send<T>(path, undefined, false);

export const getPreset = (id: string) => request<Preset>(`/api/presets/${encodeURIComponent(id)}`);

export const isNameAvailable = (name: string) =>
  queryGet<NameAvailableResponse>(`/api/presets/name-available?${new URLSearchParams({ name })}`);

export const getTopPresets = () => request<PresetListItem[]>('/api/presets/top');

export const listPresets = ({
  q,
  sort,
  cursor,
}: {
  q?: string;
  sort: PresetSort;
  cursor?: string | null;
}) => {
  const params = new URLSearchParams({ sort });
  if (q) params.set('q', q);
  if (cursor) params.set('cursor', cursor);
  return queryGet<PresetsPage>(`/api/presets?${params}`);
};

export const savePreset = (body: SavePresetRequest) =>
  request<SavePresetResponse>('/api/presets', { method: 'POST', body: JSON.stringify(body) });

export const updatePreset = (id: string, body: UpdatePresetRequest) =>
  request<UpdatePresetResponse>(`/api/presets/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });

// the author opened own preset: it is kept from the cleanup
export const markPresetOpened = (id: string, body: PresetOpenedRequest) =>
  request<void>(`/api/presets/${encodeURIComponent(id)}/opened`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

export const reportPreset = (id: string) =>
  request<void>(`/api/presets/${encodeURIComponent(id)}/report`, { method: 'POST' });

// a listen or a stay of a preset; keepalive: the page may be closed right after it
export const sendUsage = (body: UsageRequest) =>
  request<void>('/api/usage', { method: 'POST', body: JSON.stringify(body), keepalive: true });
