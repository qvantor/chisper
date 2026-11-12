// The presets of the site the manual opens besides the ones of the clips of the landing (data/demos.ts): each where
// what a text explains can be heard. Its name is the one the site shows, less the prefix of the featured presets
// ([AI]); scripts/site/check-presets.mjs checks them against the site
export const MANUAL_PRESETS = [
  { slug: 'supersaw-lead', presetId: '8823127b-0f34-4b9d-b231-23eb194d9ee6', name: 'Supersaw Lead' },
  {
    slug: 'pumping-house-chords',
    presetId: 'cdd4101e-d7b8-45f3-8ba4-b1700c00fd34',
    name: 'Pumping House Chords',
  },
  { slug: 'dubstep-wobble', presetId: '5148c5de-4c54-464d-8da0-82ba3d1a3f6e', name: 'Dubstep Wobble' },
] as const;

export type ManualPresetSlug = (typeof MANUAL_PRESETS)[number]['slug'];
