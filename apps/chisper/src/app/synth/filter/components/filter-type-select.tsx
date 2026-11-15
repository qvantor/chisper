import React from 'react';
import { FilterType } from '@chisper/preset-schema';
import { FileOption, FileSelect } from '../../../common/components';

// the name of every type, each a model of its own in its name: Ladder (the warm MG Low of the reference), Low, High,
// Band, Peak and Notch, the EQ ones and the Biquad ones (the types of a BiquadFilterNode the presets of before have;
// the allpass of before is never offered, still played: its name)
const NAMES: Record<FilterType, string> = {
  ladder6: 'Ladder 6',
  ladder12: 'Ladder 12',
  ladder18: 'Ladder 18',
  ladder24: 'Ladder 24',
  low6: 'Low 6',
  low12: 'Low 12',
  low18: 'Low 18',
  low24: 'Low 24',
  high6: 'High 6',
  high12: 'High 12',
  high18: 'High 18',
  high24: 'High 24',
  band12: 'Band 12',
  band24: 'Band 24',
  notch12: 'Notch 12',
  notch24: 'Notch 24',
  peak12: 'Peak 12',
  peak24: 'Peak 24',
  loweq6: 'Low EQ 6',
  loweq12: 'Low EQ 12',
  bandeq12: 'Band EQ 12',
  higheq6: 'High EQ 6',
  higheq12: 'High EQ 12',
  lowpass: 'Biquad LP',
  highpass: 'Biquad HP',
  bandpass: 'Biquad BP',
  notch: 'Biquad Notch',
  lowshelf: 'Biquad Low Shelf',
  highshelf: 'Biquad High Shelf',
  peaking: 'Biquad Bell',
  allpass: 'Biquad AP',
};

// the types by what they do to the sound; the order is that of ◀ ▶
const CATEGORIES: { value: string; label: string; types: FilterType[] }[] = [
  {
    value: 'low-pass',
    label: 'Low Pass',
    types: ['ladder6', 'ladder12', 'ladder18', 'ladder24', 'low6', 'low12', 'low18', 'low24', 'lowpass'],
  },
  { value: 'high-pass', label: 'High Pass', types: ['high6', 'high12', 'high18', 'high24', 'highpass'] },
  { value: 'band-pass', label: 'Band Pass', types: ['band12', 'band24', 'bandpass'] },
  { value: 'notch-peak', label: 'Notch & Peak', types: ['notch12', 'notch24', 'peak12', 'peak24', 'notch'] },
  {
    value: 'eq',
    label: 'EQ',
    types: ['loweq6', 'loweq12', 'bandeq12', 'higheq6', 'higheq12', 'lowshelf', 'highshelf', 'peaking'],
  },
];

// the options of the browser: a folder a category, a file a type
export const FILTER_CATEGORIES: FileOption[] = CATEGORIES.map(({ value, label, types }) => ({
  value,
  label,
  children: types.map((type) => ({ value: type, label: NAMES[type] })),
}));

// the path of a type in the browser: its category and itself (one it doesn't offer: itself alone)
const PATHS = new Map(
  CATEGORIES.flatMap(({ value, types }) => types.map((type): [FilterType, string[]] => [type, [value, type]]))
);
const pathOf = (type: FilterType) => PATHS.get(type) ?? [type];

interface Props {
  type: FilterType;
  setType: (type: FilterType) => void;
}

// the type of the filter: its name between ◀ ▶ (through every type, category after category), a click opens the
// browser of the types by category
export const FilterTypeSelect = ({ type, setType }: Props) => (
  <FileSelect
    options={FILTER_CATEGORIES}
    value={pathOf(type)}
    setValue={(path) => setType(path[path.length - 1] as FilterType)}
    label={NAMES[type]}
    title='Filter type'
    status='success'
  />
);
