import React from 'react';
import { FilterType } from '@chisper/preset-schema';
import { FileSelect } from '../../../common/components';
import { FILTER_TYPE_NAMES, filterTypeBrowser } from '../filter-types';

// the options of the browser: a folder a category, a file a type (the path of one it doesn't offer: itself alone)
const { options, pathOf } = filterTypeBrowser<FilterType>();
export const FILTER_CATEGORIES = options;

interface Props {
  type: FilterType;
  setType: (type: FilterType) => void;
}

// the type of the filter: its name between ◀ ▶ (through every type, category after category), a click opens the
// browser of the types by category
export const FilterTypeSelect = ({ type, setType }: Props) => (
  <FileSelect
    options={options}
    value={pathOf(type)}
    setValue={(path) => setType(path[path.length - 1] as FilterType)}
    label={FILTER_TYPE_NAMES[type]}
    title='Filter type'
    status='success'
    midiTarget='filter.type'
  />
);
