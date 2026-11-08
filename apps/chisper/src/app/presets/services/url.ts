import toast from 'react-hot-toast';

const PRESET_PARAM = 'preset';
// the clip of the track (synth/track): its own param beside the preset's
const CLIP_PARAM = 'clip';

const param = (name: string) => new URLSearchParams(window.location.search).get(name);

export const getUrlPresetId = () => param(PRESET_PARAM);
export const getUrlClipId = () => param(CLIP_PARAM);

// the url of the page with a preset and a clip (null: none), no other params (legacy snapshot ones)
const pageUrl = (preset: string | null, clip: string | null) => {
  const url = new URL(window.location.pathname, window.location.origin);
  if (preset !== null) url.searchParams.set(PRESET_PARAM, preset);
  if (clip !== null) url.searchParams.set(CLIP_PARAM, clip);
  return url.toString();
};

export const presetUrl = (id: string) => pageUrl(id, null);

// a link to a clip, with the preset it plays (null: none)
export const clipUrl = (id: string, preset: string | null) => pageUrl(preset, id);

// replaces legacy snapshot search params too, the preset and the clip ids are the only state in url now
export const setUrlPresetId = (id: string) =>
  window.history.replaceState(null, '', pageUrl(id, getUrlClipId()));

// Init: no preset and no legacy snapshot params (the clip stays)
export const clearUrlPresetId = () => window.history.replaceState(null, '', pageUrl(null, getUrlClipId()));

// the clip of the track in the url (null: none), the preset stays
export const setUrlClipId = (id: string | null) =>
  window.history.replaceState(null, '', pageUrl(getUrlPresetId(), id));

const copyLink = (url: string) =>
  navigator.clipboard
    .writeText(url)
    .then(() => toast.success('Link copied to the clipboard'))
    .catch(() => toast.error('Could not copy the link'));

export const sharePreset = (id: string) => copyLink(presetUrl(id));

export const shareClip = (id: string, preset: string | null) => copyLink(clipUrl(id, preset));
