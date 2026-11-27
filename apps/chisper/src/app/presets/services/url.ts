import toast from 'react-hot-toast';

const PRESET_PARAM = 'preset';
// the clip of the track (synth/track): its own param beside the preset's
const CLIP_PARAM = 'clip';

const param = (name: string) => new URLSearchParams(window.location.search).get(name);

export const getUrlPresetId = () => param(PRESET_PARAM);
export const getUrlClipId = () => param(CLIP_PARAM);

// the url of a page (this one) with a preset and a clip (null: none), no other params (legacy snapshot ones,
// those a link brought); repeated slashes of the path as one (a path `//` is no url relative to the origin)
const pageUrl = (preset: string | null, clip: string | null, page: URL | Location = window.location) => {
  const url = new URL(page.pathname.replace(/\/{2,}/g, '/'), page.origin);
  if (preset !== null) url.searchParams.set(PRESET_PARAM, preset);
  if (clip !== null) url.searchParams.set(CLIP_PARAM, clip);
  return url.toString();
};

// `href` with its preset and its clip alone (throws where it is no url)
export const publicUrl = (href: string) => {
  const page = new URL(href);
  return pageUrl(page.searchParams.get(PRESET_PARAM), page.searchParams.get(CLIP_PARAM), page);
};

export const presetUrl = (id: string) => pageUrl(id, null);

// the url of the synth alone
export const synthUrl = () => pageUrl(null, null);

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
