import {
  type ApiError,
  type NameAvailableResponse,
  type Preset,
  type PresetCounts,
  type PresetFilter,
  presetFilterParams,
  PRESET_IDS_MAX,
  type PresetListItem,
  type PresetOpenedRequest,
  type PresetSort,
  type PresetsPage,
  type SavePresetRequest,
  type SavePresetResponse,
  type TopPresetItem,
  type UpdatePresetInfoRequest,
  type UpdatePresetInfoResponse,
  type UpdatePresetRequest,
  type UpdatePresetResponse,
  type UsageRequest,
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

// the popular presets of a filter (those of it, the popular ones first, each saying whether it is), as a query of
// the browser
export const queryTopPresets = (filter: PresetFilter) =>
  queryGet<TopPresetItem[]>(`/api/presets/top?${presetFilterParams(filter)}`);

export const listPresets = ({
  sort,
  cursor,
  ...filter
}: PresetFilter & {
  sort: PresetSort;
  cursor?: string | null;
}) => {
  const params = presetFilterParams(filter);
  params.set('sort', sort);
  if (cursor) params.set('cursor', cursor);
  return queryGet<PresetsPage>(`/api/presets?${params}`);
};

// the presets of a list of this browser (Favorites, Recent, Mine) still there, in its order, PRESET_IDS_MAX a request
export const getPresetsByIds = async (ids: readonly string[]) => {
  const chunks = Array.from({ length: Math.ceil(ids.length / PRESET_IDS_MAX) }, (_, i) =>
    ids.slice(i * PRESET_IDS_MAX, (i + 1) * PRESET_IDS_MAX)
  );
  const pages = await Promise.all(
    chunks.map((chunk) =>
      queryGet<PresetsPage>(`/api/presets?${new URLSearchParams({ ids: chunk.join(',') })}`)
    )
  );
  return pages.flatMap(({ items }) => items);
};

// the presets of each category and subcategory
export const getPresetCounts = () => queryGet<PresetCounts>('/api/presets/counts');

// Edit info: the category, description and tags of an own preset
export const updatePresetInfo = (id: string, body: UpdatePresetInfoRequest) =>
  request<UpdatePresetInfoResponse>(`/api/presets/${encodeURIComponent(id)}/info`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });

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
