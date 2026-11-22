import { z } from 'zod';
import type { PresetFilter, PresetListItem } from './schema';

// What a preset is (its category, its subcategory within it), what it sounds like (its tags) and what it does (its
// features): columns of the presets of the server beside their data, never in it (the hash and the sound stay). The
// slugs are stable (the database and the links keep them), the labels may change; a list only grows.

export const PRESET_CATEGORIES = [
  {
    slug: 'bass',
    label: 'Bass',
    subcategories: [
      { slug: 'sub', label: 'Sub' },
      { slug: 'reese', label: 'Reese' },
      { slug: 'growl-wobble', label: 'Growl & Wobble' },
      { slug: 'acid', label: 'Acid' },
      { slug: 'pluck', label: 'Pluck' },
      { slug: 'analog', label: 'Analog' },
    ],
  },
  {
    slug: 'lead',
    label: 'Lead',
    subcategories: [
      { slug: 'supersaw', label: 'Supersaw' },
      { slug: 'sync', label: 'Sync' },
      { slug: 'analog', label: 'Analog' },
      { slug: 'soft', label: 'Soft' },
      { slug: 'chip', label: 'Chip' },
    ],
  },
  {
    slug: 'pad',
    label: 'Pad',
    subcategories: [
      { slug: 'warm', label: 'Warm' },
      { slug: 'strings', label: 'Strings' },
      { slug: 'choir', label: 'Choir' },
      { slug: 'evolving', label: 'Evolving' },
      { slug: 'dark', label: 'Dark' },
      { slug: 'atmosphere', label: 'Atmosphere' },
    ],
  },
  {
    slug: 'keys',
    label: 'Keys',
    subcategories: [
      { slug: 'piano', label: 'Piano' },
      { slug: 'e-piano', label: 'E-Piano' },
      { slug: 'organ', label: 'Organ' },
      { slug: 'clav', label: 'Clav' },
    ],
  },
  {
    slug: 'pluck',
    label: 'Pluck',
    subcategories: [
      { slug: 'pluck', label: 'Pluck' },
      { slug: 'bell-mallet', label: 'Bell & Mallet' },
      { slug: 'string', label: 'String' },
    ],
  },
  {
    slug: 'brass-chord',
    label: 'Brass & Chord',
    subcategories: [
      { slug: 'brass', label: 'Brass' },
      { slug: 'chord', label: 'Chord' },
      { slug: 'stab', label: 'Stab' },
    ],
  },
  { slug: 'drums', label: 'Drums', subcategories: [] },
  {
    slug: 'fx',
    label: 'FX',
    subcategories: [
      { slug: 'game', label: 'Game' },
      { slug: 'ui-alert', label: 'UI & Alert' },
      { slug: 'magic', label: 'Magic' },
      { slug: 'sci-fi', label: 'Sci-Fi' },
      { slug: 'impact', label: 'Impact' },
      { slug: 'transition', label: 'Transition' },
      { slug: 'stinger', label: 'Stinger' },
      { slug: 'ambience', label: 'Ambience' },
    ],
  },
] as const;

export type PresetCategory = (typeof PRESET_CATEGORIES)[number]['slug'];
export const CATEGORY_SLUGS = PRESET_CATEGORIES.map(({ slug }) => slug) as [
  PresetCategory,
  ...PresetCategory[],
];

export const categoryOf = (slug: string) => PRESET_CATEGORIES.find((category) => category.slug === slug);

// a subcategory is one of its category (Pluck of Bass is not Pluck of Pluck)
export const isSubcategoryOf = (category: string, subcategory: string) =>
  categoryOf(category)?.subcategories.some(({ slug }) => slug === subcategory) ?? false;

// none, or one of a category that has it (the info of a preset, a filter)
export const fitsCategory = (category?: string | null, subcategory?: string | null) =>
  subcategory == null || (category != null && isSubcategoryOf(category, subcategory));

export const categoryLabel = (slug: string) => categoryOf(slug)?.label ?? slug;

export const subcategoryLabel = (category: string, subcategory: string) =>
  categoryOf(category)?.subcategories.find(({ slug }) => slug === subcategory)?.label ?? subcategory;

// Category › Subcategory, or the category alone
export const categoryPath = (category: string, subcategory?: string | null) =>
  subcategory
    ? `${categoryLabel(category)} › ${subcategoryLabel(category, subcategory)}`
    : categoryLabel(category);

// the character of a sound, of every category alike (a bass is Dark as a pad is); a preset has PRESET_TAGS_MAX at
// most
export const PRESET_TAGS = [
  { slug: 'dark', label: 'Dark', hint: 'Dull, few highs' },
  { slug: 'bright', label: 'Bright', hint: 'Lots of highs' },
  { slug: 'warm', label: 'Warm', hint: 'A full middle, nothing harsh' },
  { slug: 'clean', label: 'Clean', hint: 'No distortion' },
  { slug: 'dirty', label: 'Dirty', hint: 'Distorted' },
  { slug: 'aggressive', label: 'Aggressive', hint: 'Hard, harsh, pushing' },
  { slug: 'soft', label: 'Soft', hint: 'A smooth attack, no push' },
  { slug: 'wide', label: 'Wide', hint: 'Wide stereo: unison, chorus' },
  { slug: 'evolving', label: 'Evolving', hint: 'Changes while a note sounds: LFOs, envelopes' },
  { slug: 'lo-fi', label: 'Lo-fi', hint: 'Like an old recording: noise, tape, cut highs' },
  { slug: 'analog', label: 'Analog', hint: 'Like an analog synth: detune, drift' },
  { slug: 'digital', label: 'Digital', hint: 'Digital, glassy, FM-like' },
  { slug: 'metallic', label: 'Metallic', hint: 'Inharmonic overtones, as of bells' },
] as const;
export const PRESET_TAGS_MAX = 3;

export type PresetTag = (typeof PRESET_TAGS)[number]['slug'];
export const TAG_SLUGS = PRESET_TAGS.map(({ slug }) => slug) as [PresetTag, ...PresetTag[]];

export const tagOf = (slug: string) => PRESET_TAGS.find((tag) => tag.slug === slug);

export const tagLabel = (slug: string) => tagOf(slug)?.label ?? slug;

// what a preset does, in the order of the icons of a row of the list: its clip and AI of its row (clip_id,
// ai_generated), the others worked out of its data by the server as it is saved (presetFeatures)
export const PRESET_FEATURES = ['clip', 'ai', 'tempo-sync', 'mono', 'glide'] as const;
export type PresetFeature = (typeof PRESET_FEATURES)[number];
export const DATA_FEATURES = ['tempo-sync', 'mono', 'glide'] as const;
export type DataFeature = (typeof DATA_FEATURES)[number];

export const FEATURE_LOOKS: Record<PresetFeature, { label: string; hint: string }> = {
  clip: { label: 'With clip', hint: 'Opens with its clip' },
  ai: { label: 'AI generated', hint: 'Made with AI' },
  'tempo-sync': { label: 'Tempo-sync', hint: 'Follows the tempo: LFOs, envelopes or effects in BPM' },
  mono: { label: 'Mono', hint: 'Plays one note at a time' },
  glide: { label: 'Glide', hint: 'Glides from note to note' },
};

// in the order of PRESET_FEATURES
export const sortFeatures = (features: Iterable<PresetFeature>): PresetFeature[] => {
  const set = new Set(features);
  return PRESET_FEATURES.filter((feature) => set.has(feature));
};

// the presets of the synth (made by its author) and those of its users
export const PRESET_ORIGINS = ['factory', 'community'] as const;
export type PresetOrigin = (typeof PRESET_ORIGINS)[number];

export const PRESET_DESCRIPTION_MAX_LENGTH = 280;

// plain text: an address in it is refused (a link would be spam the list shows). A domain of the list counts in
// lowercase or in capitals, never as a word that begins a sentence after a missing space ("Fat bass.So good"); one
// that is a word too (es, de, to, me…) only before a path or at the end ("slow.to the end", "pad.es perfecto")
const DOMAINS = 'com|net|org|ru|io|ly|co|gg|xyz|info|app|dev|tv|link|site|online|club|biz|uk|fr|cc|sh';
const WORD_DOMAINS = 'me|be|us|de|es|to|so';
const cased = (domains: string) => `${domains}|${domains.toUpperCase()}`;
const SCHEME = /https?:\/\/|www\./i;
const DOMAIN = new RegExp(`\\b[A-Za-z0-9-]+\\.(?:${cased(DOMAINS)})\\b`);
const WORD_DOMAIN = new RegExp(`\\b[A-Za-z0-9-]+\\.(?:${cased(WORD_DOMAINS)})(?:\\/|[^\\p{L}\\p{N}]*$)`, 'u');
export const hasLink = (text: string) => SCHEME.test(text) || DOMAIN.test(text) || WORD_DOMAIN.test(text);

// trimmed, whitespace collapsed: one line of plain text
const normalizeDescription = (text: string) => text.trim().replace(/\s+/g, ' ');

export const DESCRIPTION_LINK_MESSAGE = 'No links in the description, please';

const presetDescriptionSchema = z
  .string()
  .transform(normalizeDescription)
  .pipe(
    z
      .string()
      .max(PRESET_DESCRIPTION_MAX_LENGTH)
      .refine((text) => !hasLink(text), { message: DESCRIPTION_LINK_MESSAGE })
  )
  .transform((text) => (text === '' ? null : text));

// the tags of a preset: once each, in the order of the list
const presetTagsSchema = z
  .array(z.enum(TAG_SLUGS))
  .transform((tags) => TAG_SLUGS.filter((tag) => tags.includes(tag)))
  .pipe(z.array(z.enum(TAG_SLUGS)).max(PRESET_TAGS_MAX));

// what the author tells of a preset, all of it optional: none is a preset of All and of the search only
export const presetInfoSchema = z
  .object({
    category: z.enum(CATEGORY_SLUGS).nullable().default(null),
    subcategory: z.string().max(32).nullable().default(null),
    description: presetDescriptionSchema.nullable().default(null),
    tags: presetTagsSchema.default([]),
  })
  .refine(({ category, subcategory }) => fitsCategory(category, subcategory), {
    message: 'Unknown subcategory',
    path: ['subcategory'],
  });
export type PresetInfo = z.output<typeof presetInfoSchema>;

export const EMPTY_PRESET_INFO: PresetInfo = {
  category: null,
  subcategory: null,
  description: null,
  tags: [],
};

export const isFiltered = ({ category, tags, features, origin, q }: PresetFilter) =>
  category !== undefined || !!tags?.length || !!features?.length || origin !== undefined || !!q;

// the tags a search finds by their label
export const tagsMatching = (q: string): PresetTag[] => {
  const key = q.trim().toLowerCase();
  return key === ''
    ? []
    : PRESET_TAGS.filter(({ label }) => label.toLowerCase().includes(key)).map(({ slug }) => slug);
};

// as the server filters (presetFilter of netlify/functions/presets.mts): a search finds the name, the description or
// a tag; every tag and feature asked for
export const matchesPresetFilter = (item: PresetListItem, filter: PresetFilter) => {
  const { category, subcategory, tags = [], features = [], origin, q } = filter;
  if (category !== undefined && item.category !== category) return false;
  if (subcategory !== undefined && item.subcategory !== subcategory) return false;
  if (!tags.every((tag) => item.tags.includes(tag))) return false;
  if (!features.every((feature) => item.features.includes(feature))) return false;
  if (origin !== undefined && item.factory !== (origin === 'factory')) return false;
  const key = q?.trim().toLowerCase();
  if (!key) return true;
  return (
    item.name.toLowerCase().includes(key) ||
    (item.description?.toLowerCase().includes(key) ?? false) ||
    tagsMatching(key).some((tag) => item.tags.includes(tag))
  );
};

// the query of a filter (listPresetsQuerySchema reads it): the lists as comma separated slugs
export const presetFilterParams = (filter: PresetFilter) => {
  const params = new URLSearchParams();
  if (filter.category) params.set('category', filter.category);
  if (filter.category && filter.subcategory) params.set('subcategory', filter.subcategory);
  if (filter.tags?.length) params.set('tags', filter.tags.join(','));
  if (filter.features?.length) params.set('features', filter.features.join(','));
  if (filter.origin) params.set('origin', filter.origin);
  if (filter.q) params.set('q', filter.q);
  return params;
};
