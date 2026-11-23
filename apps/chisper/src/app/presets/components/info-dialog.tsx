import React from 'react';
import { LoadingOutlined } from '@ant-design/icons';
import { AiOutlineSave } from 'react-icons/ai';
import { InfiniteData, QueryClient, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { PresetInfo, PresetListItem, PresetsPage } from '@chisper/preset-schema';
import { Bar, Dialog, DialogIntro, DialogScreen, Key, Spacer } from '../../common/components';
import { usePresets, withInfo } from '../modules/presets';
import { getEditToken, updatePresetInfo } from '../services';
import { draftOf, EMPTY_DRAFT, InfoDraft, InfoFields, infoOfDraft } from './info-fields';

// a preset whose info is edited: a row of a list, or the one opened (its info as it is known)
export type EditedPreset = Pick<PresetListItem, 'id' | 'name'> & PresetInfo;

// the new info of a preset (Edit info, an overwrite) in its rows of the lists of the browser loaded (asked for again,
// the CDN would give them as they were a while); the counts of the categories again where it moved from `before`
// (null: not known)
export const patchListedInfo = (
  queryClient: QueryClient,
  id: string,
  info: PresetInfo,
  before: PresetInfo | null
) => {
  const patch = (items?: PresetListItem[]) => items && withInfo(items, id, info);
  queryClient.setQueriesData<PresetListItem[]>({ queryKey: ['presets', 'top'] }, patch);
  queryClient.setQueriesData<PresetListItem[]>({ queryKey: ['presets', 'ids'] }, patch);
  queryClient.setQueriesData<InfiniteData<PresetsPage>>(
    { queryKey: ['presets', 'list'] },
    (data) =>
      data && {
        ...data,
        pages: data.pages.map((page) => ({ ...page, items: withInfo(page.items, id, info) })),
      }
  );
  if (before?.category !== info.category || before?.subcategory !== info.subcategory)
    queryClient.invalidateQueries({ queryKey: ['presets', 'counts'] });
};

interface Props {
  // the preset whose info is edited (null: closed)
  preset: EditedPreset | null;
  onClose: () => void;
}

// Edit info of a preset saved from this browser: its category, tags and description, its sound and name as they are
// (the dirty state of the synth doesn't see it)
export const InfoDialog = ({ preset, onClose }: Props) => {
  const [, { setInfo }] = usePresets();
  const queryClient = useQueryClient();
  const [draft, setDraft] = React.useState<InfoDraft>(EMPTY_DRAFT);

  React.useEffect(() => {
    if (preset) setDraft(draftOf(preset));
  }, [preset]);

  const info = infoOfDraft(draft);
  const { mutate, isPending } = useMutation({
    mutationFn: ({ id, info }: { id: string; info: PresetInfo }) =>
      updatePresetInfo(id, { editToken: getEditToken(id) ?? '', info }),
    onSuccess: ({ id, info }) => {
      setInfo(id, info);
      patchListedInfo(queryClient, id, info, preset);
      toast.success(`The info of “${preset?.name}” has been saved`);
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Saving failed'),
  });
  const save = () => {
    if (preset && info && !isPending) mutate({ id: preset.id, info });
  };

  return (
    <Dialog title='Edit info' open={preset !== null} onCancel={onClose} width={480} destroyOnHidden>
      <DialogIntro>
        What “{preset?.name}” is and sounds like: its category, tags and description. Its sound and name stay.
      </DialogIntro>
      <DialogScreen>
        <InfoFields draft={draft} onChange={setDraft} />
      </DialogScreen>
      <Bar>
        <Spacer />
        <Key onClick={onClose}>Cancel</Key>
        <Key onClick={save} disabled={!info || isPending}>
          {isPending ? <LoadingOutlined /> : <AiOutlineSave />}
          Save
        </Key>
      </Bar>
    </Dialog>
  );
};
