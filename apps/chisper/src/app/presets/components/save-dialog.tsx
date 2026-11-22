import React from 'react';
import { styled } from 'styled-components';
import { Checkbox, Input, Tooltip } from 'antd';
import { LoadingOutlined } from '@ant-design/icons';
import { AiOutlineSave } from 'react-icons/ai';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Turnstile, TurnstileInstance } from '@marsidev/react-turnstile';
import toast from 'react-hot-toast';
import { distinctUntilChanged, map } from 'rxjs';
import { text12, textBold12, theme } from '@chisper/ui-kit';
import { useBehaviorSubject, useObservable } from '@chisper/rxjs-react';
import {
  categoryPath,
  Clip,
  guessPresetInfo,
  nameKey,
  normalizePreset,
  PRESET_DEFAULTS,
  PRESET_NAME_MAX_LENGTH,
  PresetData,
  PresetInfo,
  presetNameSchema,
  SavePresetRequest,
  tagLabel,
  UpdatePresetRequest,
} from '@chisper/preset-schema';
import { getSnapshot } from '../../app';
import {
  Bar,
  Dialog,
  DialogIntro,
  DialogScreen,
  Key,
  ScreenHead,
  screenCheckStyle,
  Spacer,
  TipWrap,
} from '../../common/components';
import { useTrack } from '../../synth/track/modules/track';
import { usePersistClip } from '../../synth/track/components/use-clip-saving';
import { CurrentPreset, usePresets } from '../modules/presets';
import { useDebounced } from '../hooks/use-debounced';
import {
  ApiRequestError,
  getEditToken,
  isNameAvailable,
  presetUrl,
  savePreset,
  sharePreset,
  TURNSTILE_SITE_KEY,
  updatePreset,
} from '../services';
import { patchListedInfo } from './info-dialog';
import { draftOf, EMPTY_DRAFT, InfoDraft, InfoFields, infoOfDraft } from './info-fields';

const NAME_CHECK_DEBOUNCE_MS = 300;

// https://developers.cloudflare.com/turnstile/troubleshooting/client-side-errors/error-codes/
const captchaErrorMessage = (code: string) => {
  if (code.startsWith('110200'))
    return `Captcha is not allowed on ${window.location.hostname}, add it to the widget hostnames in Cloudflare.`;
  if (code.startsWith('1101') || code.startsWith('400020'))
    return 'Captcha site key is invalid, check NX_PUBLIC_TURNSTILE_SITE_KEY.';
  return `Captcha check failed (error ${code}).`;
};

const { colors } = theme;

// the field of the name (or the link) on the screen, as All over the parts of a .mid; red under a taken name
const Field = styled(ScreenHead)`
  gap: 2px;
  padding: 2px 3px 2px 0;

  &.error {
    border-bottom-color: ${colors.red};
  }
`;

// the clip of the track: its box on the line of its name, what Save does to it under it
const ClipRow = styled.div`
  ${screenCheckStyle};
  margin: 3px;
`;

const ClipName = styled.span`
  ${textBold12};
  line-height: 16px;
  color: ${colors.white};
  overflow-wrap: anywhere;
`;

const Details = styled.div`
  ${text12};
  line-height: 16px;
  color: ${colors.primaryDarkHighContrast};
`;

// a note without the clip row (the preset loses its clip): under the field
const Note = styled(Details)`
  padding: 6px 11px;
`;

const ErrorText = styled.div`
  ${text12};
  padding: 0 2px;
  color: ${colors.red};
`;

interface SavedResult {
  id: string;
  message: string;
}

// the clip of the track as the dialog names it; null: no notes (a preset isn't saved with it)
const clipLabel = ({ notes, name }: Clip) =>
  notes.length === 0 ? null : name ? `“${name}”` : 'the clip of the track';

// the sound of the synth as a preset (params out of the schema: the defaults, the guess goes by the name alone)
const soundOf = (): PresetData => {
  try {
    return normalizePreset(getSnapshot());
  } catch {
    return PRESET_DEFAULTS;
  }
};

// the category the dialog offers for a name and the sound (the user may take it off)
const guessedCategory = (name: string, data: PresetData) => guessPresetInfo(name, data).category;

// an info in a line: its category (and subcategory), its tags
const infoSummary = ({ category, subcategory, tags }: PresetInfo) => {
  const parts = [...(category ? [categoryPath(category, subcategory)] : []), ...tags.map(tagLabel)];
  return parts.length ? parts.join(' · ') : 'none';
};

interface Props {
  open: boolean;
  onClose: () => void;
}

export const SaveDialog = ({ open, onClose }: Props) => {
  const [{ $current, $currentInfo }, { setSaved }] = usePresets();
  const [{ $clip, $id: $clipId, $dirty: $clipDirty }] = useTrack();
  // (the dialog stays mounted while closed: not rendered again by every edit of the notes)
  const $clipLabel = React.useMemo(() => $clip.pipe(map(clipLabel), distinctUntilChanged()), [$clip]);
  const label = useObservable($clipLabel, clipLabel($clip.value));
  const clipId = useBehaviorSubject($clipId);
  const clipDirty = useBehaviorSubject($clipDirty);
  const clipSaving = usePersistClip();
  const [name, setName] = React.useState('');
  const [token, setToken] = React.useState<string | null>(null);
  const [captchaError, setCaptchaError] = React.useState<string | null>(null);
  const [saved, setSavedResult] = React.useState<SavedResult | null>(null);
  // the current preset was created from this browser, so it can be overwritten
  const [editable, setEditable] = React.useState<(CurrentPreset & { editToken: string }) | null>(null);
  // the preset is saved with the clip of the track: it opens with it
  const [withClip, setWithClip] = React.useState(false);
  // its category, tags and description: of the current preset when they are known (an overwrite keeps them; the
  // description only of a preset of this browser: another's is the words of its author), else none but a category
  // guessed by its name and sound until one is chosen
  const [draft, setDraft] = React.useState<InfoDraft>(EMPTY_DRAFT);
  // (refs: the guess of the open runs with the info known in the same render)
  const infoKnown = React.useRef(false);
  const categoryChosen = React.useRef(false);
  const sound = React.useRef<PresetData>(PRESET_DEFAULTS);
  const turnstile = React.useRef<TurnstileInstance | undefined>(undefined);
  const queryClient = useQueryClient();

  React.useEffect(() => {
    if (!open) return;
    const current = $current.value;
    const editToken = current && getEditToken(current.id);
    const known = $currentInfo.value;
    setName(current?.name ?? '');
    setSavedResult(null);
    setCaptchaError(null);
    setEditable(current && editToken ? { ...current, editToken } : null);
    // as the preset was: with a clip when it has one
    setWithClip(current?.clipId !== undefined);
    sound.current = soundOf();
    infoKnown.current = known !== null;
    // (a category of the preset stays; none known or none at all: guessed)
    const start = known ? { ...draftOf(known), ...(editToken ? {} : { description: '' }) } : EMPTY_DRAFT;
    categoryChosen.current = start.category !== null;
    setDraft(
      start.category ? start : { ...start, category: guessedCategory(current?.name ?? '', sound.current) }
    );
  }, [open, $current, $currentInfo]);

  // the guess follows the name until a category is chosen
  React.useEffect(() => {
    if (!open || categoryChosen.current) return;
    const category = guessedCategory(name, sound.current);
    setDraft((draft) => (draft.category === category ? draft : { ...draft, category, subcategory: null }));
  }, [open, name]);

  const changeDraft = (next: InfoDraft) => {
    if (next.category !== draft.category || next.subcategory !== draft.subcategory)
      categoryChosen.current = true;
    setDraft(next);
  };
  // null: the description isn't one to send (a link): no save
  const info = infoOfDraft(draft);

  const attach = withClip && label !== null;

  // names are unique, check while typing so the captcha isn't spent on a taken name
  const validName = presetNameSchema.safeParse(name).success;
  const key = nameKey(name);
  const debouncedKey = useDebounced(key, NAME_CHECK_DEBOUNCE_MS);
  const isOwnName = editable !== null && key === nameKey(editable.name);
  const nameCheck = useQuery({
    queryKey: ['presets', 'name-available', debouncedKey],
    queryFn: () => isNameAvailable(debouncedKey),
    enabled: open && !saved && validName && !isOwnName && debouncedKey === key,
    staleTime: 10 * 1000,
  });
  const nameTaken = !isOwnName && debouncedKey === key && nameCheck.data?.available === false;

  const onSaveError = (e: unknown) => {
    toast.error(e instanceof Error ? e.message : 'Saving failed');
    if (e instanceof ApiRequestError && e.status === 409)
      queryClient.invalidateQueries({ queryKey: ['presets', 'name-available'] });
  };

  const { mutate, isPending } = useMutation({
    // the body alone: the mutation function of react-query 5 gets its context too
    mutationFn: (body: SavePresetRequest) => savePreset(body),
    onSuccess: (result, body) => {
      // the sound saved before keeps its clip and its info
      const clipKept = body.clipId && result.clipId !== body.clipId ? ' Its clip is unchanged.' : '';
      setSavedResult({
        id: result.id,
        message: result.existed
          ? `This sound is already saved as “${result.name}”.${clipKept} Its category and tags stay as they were: ${infoSummary(result.info)}.`
          : `“${result.name}” has been saved.`,
      });
      setSaved(result);
    },
    onError: onSaveError,
    // the token is single use
    onSettled: () => {
      setToken(null);
      setCaptchaError(null);
      turnstile.current?.reset();
    },
  });

  // `before`: the info it had (null: not known), the counts of the categories again where it moved
  const overwriteMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdatePresetRequest; before: PresetInfo | null }) =>
      updatePreset(id, body),
    onSuccess: (result, { before }) => {
      setSavedResult({ id: result.id, message: `“${result.name}” has been updated.` });
      setSaved(result);
      // its rows in the lists of the browser: an Edit info of one starts from what it has now
      patchListedInfo(queryClient, result.id, result.info, before);
    },
    onError: onSaveError,
  });

  const busy = isPending || overwriteMutation.isPending || clipSaving.busy;
  const canSave = validName && !nameTaken && !isOwnName && token !== null && info !== null;
  const canOverwrite = validName && !nameTaken && editable !== null && info !== null;
  // the preset sent with the clip it opens with (null: none): the clip of the track, saved first unless it is so
  // already; its save failed (a toast told why): the preset isn't sent
  const withClipId = async (send: (presetClipId: string | null) => void) => {
    if (!attach) return send(null);
    const saved = await clipSaving.persist();
    if (saved) send(saved.id);
  };
  const save = () => {
    if (!canSave || busy) return;
    withClipId((presetClipId) =>
      mutate({
        name,
        data: getSnapshot(),
        turnstileToken: token,
        clipId: presetClipId,
        info: info ?? undefined,
      })
    );
  };
  // (an info not known, not changed: the one of the preset stays)
  const overwrite = () => {
    if (!canOverwrite || busy) return;
    const { id, editToken } = editable;
    const sent =
      infoKnown.current || categoryChosen.current || draft.tags.length > 0 || draft.description.trim()
        ? info
        : undefined;
    const before = $currentInfo.value;
    withClipId((presetClipId) =>
      overwriteMutation.mutate({
        id,
        body: { name, data: getSnapshot(), editToken, clipId: presetClipId, info: sent },
        before,
      })
    );
  };
  // the preset (of this browser) opens with a clip: what Save does to it
  const hadClip = editable?.clipId !== undefined;

  // the key of a save: its icon on the main one (Save), a spinner in its place while it saves
  const saveIcon = (main: boolean, loading: boolean) =>
    loading ? <LoadingOutlined /> : main ? <AiOutlineSave /> : null;
  const newMain = !editable;
  const newLoading = isPending || (!editable && clipSaving.busy);

  return (
    <Dialog title='Save preset' open={open} onCancel={onClose} width={520} destroyOnHidden>
      {saved ? (
        <>
          <DialogIntro>{saved.message}</DialogIntro>
          <DialogScreen>
            <Field>
              <Input variant='borderless' value={presetUrl(saved.id)} readOnly aria-label='Preset link' />
              <Key onClick={() => sharePreset(saved.id)}>Copy link</Key>
            </Field>
          </DialogScreen>
          <Bar>
            <Spacer />
            <Key onClick={onClose}>Done</Key>
          </Bar>
        </>
      ) : (
        <>
          <DialogIntro>
            {editable
              ? `Save overwrites “${editable.name}”, its links will play the updated sound. Save as new keeps it unchanged.`
              : 'A new preset will be created. You can overwrite it later from this browser.'}
          </DialogIntro>
          <DialogScreen>
            <Field className={nameTaken ? 'error' : undefined}>
              <Input
                variant='borderless'
                autoFocus
                placeholder='Preset name'
                maxLength={PRESET_NAME_MAX_LENGTH}
                showCount
                value={name}
                onChange={(e) => setName(e.target.value)}
                onPressEnter={editable ? overwrite : save}
                status={nameTaken ? 'error' : undefined}
              />
            </Field>
            {label !== null && (
              <ClipRow>
                <Checkbox checked={withClip} onChange={(e) => setWithClip(e.target.checked)}>
                  <ClipName>Default clip: {label}</ClipName>
                </Checkbox>
                {attach && (clipId === null || clipDirty) && (
                  <Details>The clip is saved too, the preset opens with it.</Details>
                )}
                {hadClip && !attach && <Details>Save leaves the preset without a clip.</Details>}
                {hadClip && attach && clipId !== editable?.clipId && (
                  <Details>Save replaces the clip the preset opens with.</Details>
                )}
              </ClipRow>
            )}
            {label === null && hadClip && <Note>Save leaves the preset without a clip.</Note>}
            <InfoFields draft={draft} onChange={changeDraft} />
          </DialogScreen>
          {nameTaken && <ErrorText>Name is already taken</ErrorText>}
          {captchaError && <ErrorText>{captchaError}</ErrorText>}
          {clipSaving.captcha}
          <Turnstile
            ref={turnstile}
            siteKey={TURNSTILE_SITE_KEY}
            // shown only when the visitor has to interact (managed widget), invisible widgets never show up
            options={{ appearance: 'interaction-only' }}
            onSuccess={(value) => {
              setCaptchaError(null);
              setToken(value);
            }}
            onExpire={() => setToken(null)}
            onError={(code) => {
              setToken(null);
              setCaptchaError(captchaErrorMessage(String(code)));
            }}
            onUnsupported={() => setCaptchaError('Captcha is not supported by this browser.')}
          />
          <Bar>
            <Spacer />
            <Key onClick={onClose}>Cancel</Key>
            {captchaError ? (
              <Key
                onClick={() => {
                  setCaptchaError(null);
                  turnstile.current?.reset();
                }}
              >
                Retry
              </Key>
            ) : (
              <Tooltip title={isOwnName ? 'Choose a new name' : undefined}>
                <TipWrap>
                  <Key onClick={save} disabled={!canSave || overwriteMutation.isPending}>
                    {saveIcon(newMain, newLoading)}
                    {token ? (editable ? 'Save as new' : 'Save') : 'Checking...'}
                  </Key>
                </TipWrap>
              </Tooltip>
            )}
            {editable && (
              <Key onClick={overwrite} disabled={!canOverwrite || isPending}>
                {saveIcon(true, overwriteMutation.isPending || clipSaving.busy)}
                Save
              </Key>
            )}
          </Bar>
        </>
      )}
    </Dialog>
  );
};
