import { DEMOS, type Slug } from '../data/demos';
import { MANUAL_PRESETS, type ManualPresetSlug } from './presets';

// a preset the manual opens: of a clip of the landing or of its own list
export type PresetKey = Slug | ManualPresetSlug;

const PRESETS = [...DEMOS, ...MANUAL_PRESETS];

export const PRESET_KEYS = PRESETS.map((preset) => preset.slug);

export const presetOf = (key: PresetKey) => {
  const preset = PRESETS.find((entry) => entry.slug === key);
  if (!preset) throw new Error(`No preset ${key} (data/demos.ts, manual/presets.ts)`);
  return preset;
};
