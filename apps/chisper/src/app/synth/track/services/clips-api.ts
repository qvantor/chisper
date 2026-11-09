import type {
  Clip,
  ClipResponse,
  SaveClipRequest,
  SaveClipResponse,
  UpdateClipRequest,
  UpdateClipResponse,
} from '@chisper/preset-schema';
import { request } from '../../../presets/services/api';

// clips of the track: opened by their links only, the server keeps no list of them

export const fetchClip = (id: string) => request<ClipResponse>(`/api/clips/${encodeURIComponent(id)}`);

// the same notes saved before come back as that clip (`existed`), without an edit token
export const saveClip = (clip: Clip, turnstileToken: string) =>
  request<SaveClipResponse>('/api/clips', {
    method: 'POST',
    body: JSON.stringify({ clip, turnstileToken } satisfies SaveClipRequest),
  });

export const updateClip = (id: string, clip: Clip, editToken: string) =>
  request<UpdateClipResponse>(`/api/clips/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify({ clip, editToken } satisfies UpdateClipRequest),
  });
