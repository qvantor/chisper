import React from 'react';
import { styled } from 'styled-components';
import { Input } from 'antd';
import { text12, theme } from '@chisper/ui-kit';
import {
  categoryOf,
  DESCRIPTION_LINK_MESSAGE,
  EMPTY_PRESET_INFO,
  hasLink,
  PRESET_CATEGORIES,
  PRESET_DESCRIPTION_MAX_LENGTH,
  PRESET_TAGS_MAX,
  PresetCategory,
  PresetInfo,
  PresetTag,
  profaneDescription,
  savedPresetInfoSchema,
  TAG_SLUGS,
} from '@chisper/preset-schema';
import { SCREEN_LINE, ScreenHead } from '../../common/components';
import { ChipRow, RowLabel, SlugChips, TagChips, toggled } from './preset-filters';

const { colors } = theme;

// the info as the fields have it: the description as it is typed
export interface InfoDraft {
  category: PresetCategory | null;
  subcategory: string | null;
  tags: PresetTag[];
  description: string;
}

export const draftOf = (info: PresetInfo): InfoDraft => ({
  category: info.category,
  subcategory: info.subcategory,
  tags: info.tags,
  description: info.description ?? '',
});

export const EMPTY_DRAFT = draftOf(EMPTY_PRESET_INFO);

// the info to send (null: the description has a link or a word refused, or is too long; the fields say so)
export const infoOfDraft = (draft: InfoDraft): PresetInfo | null => {
  const parsed = savedPresetInfoSchema.safeParse(draft);
  return parsed.success ? parsed.data : null;
};

// what is wrong with a description as it is typed (null: nothing)
const descriptionProblem = (text: string) =>
  hasLink(text) ? DESCRIPTION_LINK_MESSAGE : profaneDescription(text);

// the description, the last row of the screen
const Field = styled(ScreenHead)`
  border-top: ${SCREEN_LINE};
  border-bottom: none;
  padding: 2px 3px 2px 0;

  &.error {
    border-top-color: ${colors.red};
  }

  textarea {
    resize: none;
  }
`;

const ErrorText = styled.div`
  ${text12};
  padding: 4px 11px;
  color: ${colors.red};
`;

interface Props {
  draft: InfoDraft;
  onChange: (draft: InfoDraft) => void;
}

// what the author tells of a preset, all of it optional: its category (a click again takes it off), a subcategory
// of it, up to 3 tags, a description of plain text
export const InfoFields = ({ draft, onChange }: Props) => {
  const subcategories = draft.category ? (categoryOf(draft.category)?.subcategories ?? []) : [];
  const problem = React.useMemo(() => descriptionProblem(draft.description), [draft.description]);
  return (
    <>
      <ChipRow className='wrap' role='group' aria-label='Category'>
        <RowLabel>Category</RowLabel>
        <SlugChips
          options={PRESET_CATEGORIES}
          value={draft.category ?? undefined}
          onChange={(category) => onChange({ ...draft, category: category ?? null, subcategory: null })}
        />
      </ChipRow>
      {subcategories.length > 0 && (
        <ChipRow className='wrap' role='group' aria-label='Subcategory'>
          <RowLabel>Type</RowLabel>
          <SlugChips<string>
            options={subcategories}
            value={draft.subcategory ?? undefined}
            onChange={(subcategory) => onChange({ ...draft, subcategory: subcategory ?? null })}
          />
        </ChipRow>
      )}
      <ChipRow className='wrap' role='group' aria-label='Tags'>
        <RowLabel>Tags</RowLabel>
        <TagChips
          tags={draft.tags}
          onToggle={(tag) => onChange({ ...draft, tags: toggled(TAG_SLUGS, draft.tags, tag) })}
          max={PRESET_TAGS_MAX}
        />
      </ChipRow>
      <Field className={problem ? 'error' : undefined}>
        <Input.TextArea
          variant='borderless'
          aria-label='Description'
          placeholder='Description: what it sounds like, how to play it (optional)'
          maxLength={PRESET_DESCRIPTION_MAX_LENGTH}
          showCount
          autoSize={{ minRows: 2, maxRows: 5 }}
          value={draft.description}
          onChange={(e) => onChange({ ...draft, description: e.target.value })}
          status={problem ? 'error' : undefined}
        />
      </Field>
      {problem && <ErrorText>{problem}</ErrorText>}
    </>
  );
};
