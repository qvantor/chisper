import React from 'react';
import { styled } from 'styled-components';
import hexToRgba from 'hex-to-rgba';
import { Tooltip } from 'antd';
import { keepFocus, text10, theme } from '@chisper/ui-kit';
import {
  categoryOf,
  FEATURE_LOOKS,
  PRESET_CATEGORIES,
  PRESET_FEATURES,
  PRESET_ORIGINS,
  PRESET_TAGS,
  PresetCategory,
  PresetCounts,
  PresetFeature,
  PresetFilter,
  PresetOrigin,
  PresetTag,
  TAG_SLUGS,
} from '@chisper/preset-schema';
import { SCREEN_LINE } from '../../common/components';
import { FEATURE_ICONS } from './feature-icons';

const { colors } = theme;

// a value of a list on the screen (a category, a tag): outlined, lit in the blue of the synth while chosen
const Chip = styled.button.attrs({ type: 'button', onMouseDown: keepFocus })`
  ${text10};
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 8px;
  border: 1px solid ${colors.primaryDarkMediumContrast};
  border-radius: 11px;
  background: transparent;
  color: ${colors.primaryDarkHighContrast};
  font-weight: 600;
  letter-spacing: 0.5px;
  white-space: nowrap;
  cursor: pointer;
  transition:
    color 120ms,
    border-color 120ms,
    background 120ms;

  svg {
    width: 12px;
    height: 12px;
  }

  &:hover:not(:disabled) {
    color: ${colors.white};
  }

  &[aria-pressed='true'] {
    border-color: ${colors.secondAccent};
    background: ${hexToRgba(colors.secondAccent, 0.16)};
    color: ${colors.secondAccent};
  }

  &:disabled {
    opacity: 0.4;
    cursor: default;
  }

  &:focus-visible {
    outline: 1px solid ${colors.secondAccent};
  }
`;

// how many presets a chip has
const Count = styled.span`
  font-weight: 400;
  font-variant-numeric: tabular-nums;
  opacity: 0.75;
`;

// chips in a row of the screen, scrolled sideways where they don't fit (a phone)
export const ChipRow = styled.div`
  flex: none;
  display: flex;
  gap: 4px;
  padding: 5px 6px;
  overflow-x: auto;
  scrollbar-width: none;

  &.wrap {
    flex-wrap: wrap;
    overflow: visible;
  }

  & + & {
    padding-top: 0;
  }
`;

export const RowLabel = styled.span`
  ${text10};
  flex: none;
  align-self: center;
  width: 64px;
  color: ${hexToRgba(colors.primaryDarkHighContrast, 0.8)};
  font-weight: 600;
  letter-spacing: 1px;
  text-transform: uppercase;
`;

const Rows = styled.div`
  flex: none;
  display: flex;
  flex-direction: column;
  border-bottom: ${SCREEN_LINE};
`;

// a list with `value` in it once (or out of it), in the order of `all`: the same choices are one query
export const toggled = <T,>(all: readonly T[], list: readonly T[], value: T) =>
  all.filter((item) => (item === value) !== list.includes(item));

// chips of a list of which one at most is chosen (a click again takes it off), how many presets each has when known
export const SlugChips = <S extends string>({
  options,
  value,
  onChange,
  count,
}: {
  options: readonly { slug: S; label: string }[];
  value: S | undefined;
  onChange: (slug: S | undefined) => void;
  count?: (slug: S) => number;
}) => (
  <>
    {options.map(({ slug, label }) => (
      <Chip
        key={slug}
        aria-pressed={value === slug}
        onClick={() => onChange(value === slug ? undefined : slug)}
      >
        {count ? (
          <>
            {label} <Count>{count(slug)}</Count>
          </>
        ) : (
          label
        )}
      </Chip>
    ))}
  </>
);

// the filter of the lists as the browser has it (the search apart)
export interface FilterChoice extends Omit<PresetFilter, 'q'> {
  tags: PresetTag[];
  features: PresetFeature[];
}

// a choice of the filter and its use (none: a choice taken off)
export type FilterChange = (patch: Partial<FilterChoice>, used?: 'category' | 'tag' | 'filter') => void;

interface CategoryBarProps {
  // null: not known yet (every category shown, no counts)
  counts: PresetCounts | null;
  filter: FilterChoice;
  onChange: FilterChange;
}

// the categories with their presets (none: hidden), the subcategories of the one chosen under them
export const CategoryBar = ({ counts, filter: { category, subcategory }, onChange }: CategoryBarProps) => {
  const onCategory = (category: PresetCategory | undefined) =>
    onChange({ category, subcategory: undefined }, category && 'category');
  const onSubcategory = (subcategory: string | undefined) =>
    onChange({ subcategory }, subcategory ? 'category' : undefined);
  const shown = PRESET_CATEGORIES.filter(
    ({ slug }) => counts === null || (counts.categories[slug]?.count ?? 0) > 0 || slug === category
  );
  const chosen = category ? categoryOf(category) : undefined;
  const subCounts = (category && counts?.categories[category]?.subcategories) || {};
  const subcategories =
    chosen?.subcategories.filter(
      ({ slug }) => counts === null || (subCounts[slug] ?? 0) > 0 || slug === subcategory
    ) ?? [];
  return (
    <Rows>
      <ChipRow role='group' aria-label='Categories'>
        <Chip aria-pressed={category === undefined} onClick={() => onCategory(undefined)}>
          All {counts && <Count>{counts.total}</Count>}
        </Chip>
        <SlugChips
          options={shown}
          value={category}
          onChange={onCategory}
          count={counts ? (slug) => counts.categories[slug]?.count ?? 0 : undefined}
        />
      </ChipRow>
      {chosen && subcategories.length > 0 && (
        <ChipRow role='group' aria-label='Subcategories'>
          <Chip aria-pressed={subcategory === undefined} onClick={() => onSubcategory(undefined)}>
            All {chosen.label}
          </Chip>
          <SlugChips<string>
            options={subcategories}
            value={subcategory}
            onChange={onSubcategory}
            count={counts ? (slug) => subCounts[slug] ?? 0 : undefined}
          />
        </ChipRow>
      )}
    </Rows>
  );
};

// the tags of a list, each with what it means: chosen ones lit; `max` chosen, the others off
export const TagChips = ({
  tags,
  onToggle,
  max,
}: {
  tags: readonly PresetTag[];
  onToggle: (tag: PresetTag) => void;
  max?: number;
}) => (
  <>
    {PRESET_TAGS.map(({ slug, label, hint }) => {
      const on = tags.includes(slug);
      return (
        <Tooltip key={slug} title={hint}>
          <Chip
            aria-pressed={on}
            disabled={!on && max !== undefined && tags.length >= max}
            onClick={() => onToggle(slug)}
          >
            {label}
          </Chip>
        </Tooltip>
      );
    })}
  </>
);

const ORIGIN_LOOKS: Record<PresetOrigin, { label: string; hint: string }> = {
  factory: { label: 'Factory', hint: 'The presets of Chisper' },
  community: { label: 'Community', hint: 'The presets of its users' },
};

// the filters of the lists under the search: the tags, what the presets do, whose they are
export const FilterPanel = ({ filter, onChange }: { filter: FilterChoice; onChange: FilterChange }) => {
  const onTag = (tag: PresetTag) =>
    onChange({ tags: toggled(TAG_SLUGS, filter.tags, tag) }, filter.tags.includes(tag) ? undefined : 'tag');
  const onFeature = (feature: PresetFeature) =>
    onChange(
      { features: toggled(PRESET_FEATURES, filter.features, feature) },
      filter.features.includes(feature) ? undefined : 'filter'
    );
  const onOrigin = (origin: PresetOrigin | undefined) => onChange({ origin }, origin && 'filter');
  return (
    <Rows>
      <ChipRow className='wrap' role='group' aria-label='Tags'>
        <RowLabel>Tags</RowLabel>
        <TagChips tags={filter.tags} onToggle={onTag} />
      </ChipRow>
      <ChipRow className='wrap' role='group' aria-label='Features'>
        <RowLabel>Does</RowLabel>
        {PRESET_FEATURES.map((feature) => {
          const { label, hint } = FEATURE_LOOKS[feature];
          const FeatureIcon = FEATURE_ICONS[feature];
          return (
            <Tooltip key={feature} title={hint}>
              <Chip aria-pressed={filter.features.includes(feature)} onClick={() => onFeature(feature)}>
                <FeatureIcon />
                {label}
              </Chip>
            </Tooltip>
          );
        })}
      </ChipRow>
      <ChipRow className='wrap' role='group' aria-label='Origin'>
        <RowLabel>By</RowLabel>
        <Chip aria-pressed={filter.origin === undefined} onClick={() => onOrigin(undefined)}>
          Anyone
        </Chip>
        {PRESET_ORIGINS.map((origin) => (
          <Tooltip key={origin} title={ORIGIN_LOOKS[origin].hint}>
            <Chip aria-pressed={filter.origin === origin} onClick={() => onOrigin(origin)}>
              {ORIGIN_LOOKS[origin].label}
            </Chip>
          </Tooltip>
        ))}
      </ChipRow>
    </Rows>
  );
};
