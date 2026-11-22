import {
  EMPTY_PRESET_INFO,
  Preset,
  presetDataSchema,
  PresetListItem,
  TopPresetItem,
} from '@chisper/preset-schema';

// a saved preset with the default sound
export const fakePreset = async (id: string): Promise<Preset> => ({
  id,
  name: `Preset ${id}`,
  data: presetDataSchema.parse({}),
  createdAt: '2026-01-01T00:00:00Z',
  clip: null,
  info: EMPTY_PRESET_INFO,
  factory: false,
  features: [],
});

// a row of a list of presets: no info, nothing it does, of a user
export const listItem = (id: string, name: string, item: Partial<PresetListItem> = {}): PresetListItem => ({
  id,
  name,
  uniqueUsers: 0,
  ...EMPTY_PRESET_INFO,
  features: [],
  factory: false,
  ...item,
});

// a row of the Popular of a filter: popular (featured or over the threshold) unless said
export const topItem = (
  id: string,
  name: string,
  popular = true,
  item: Partial<PresetListItem> = {}
): TopPresetItem => ({ ...listItem(id, name, item), popular });
