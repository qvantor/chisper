import React from 'react';
import { styled } from 'styled-components';
import toast from 'react-hot-toast';
import { Turnstile } from '@marsidev/react-turnstile';
import { CLIP_NAME_REFUSED, clipHash, clipNameAllowed } from '@chisper/preset-schema';
import { CAPTCHA_TIMEOUT_MS, shareClip, TURNSTILE_SITE_KEY } from '../../../presets/services';
import { useTrack } from '../modules/track';
import { getClipEditToken, setClipEditToken } from '../services/clip-edit-tokens';
import { saveClip, updateClip } from '../services/clips-api';

// save: the clip saved from this browser overwritten, another one saved anew; new: a new link whatever it is;
// share: saved (unless it is so already), its link copied with the preset it plays
export type SaveKind = 'save' | 'new' | 'share';

// shown only when the visitor has to interact (a managed widget): under the toolbar, right
const Captcha = styled.div`
  position: fixed;
  top: 120px;
  right: 16px;
  z-index: 4;
`;

// the saves of the clip of the track: a new clip with a Turnstile token of its own (its widget made for it, removed
// once it gave one), one of this browser overwritten by its edit token; `presetId` the preset the link opens with
// (null: the sound was changed, or none was chosen)
export const useClipSaving = (presetId: () => string | null) => {
  const [{ $clip, $id, $savedHash }, { setSaved }] = useTrack();
  const [busy, setBusy] = React.useState(false);
  const [pending, setPending] = React.useState<{ kind: SaveKind; key: number } | null>(null);
  const keys = React.useRef(0);

  const run = React.useCallback(
    async (kind: SaveKind, turnstileToken?: string) => {
      const clip = $clip.value;
      // the server would refuse the name: told before the captcha
      if (!clipNameAllowed(clip.name)) {
        toast.error(CLIP_NAME_REFUSED);
        return;
      }
      const id = $id.value;
      const editToken = id === null ? null : getClipEditToken(id);
      // saved under `saved`: its link copied (share), else told
      const done = (saved: string, message = 'The clip is saved') =>
        kind === 'share' ? shareClip(saved, presetId()) : toast.success(message);
      setBusy(true);
      try {
        const clean = id !== null && clipHash(clip) === $savedHash.value;
        if (kind !== 'new' && clean) {
          await done(id);
          return;
        }
        if (kind !== 'new' && id !== null && editToken) {
          await updateClip(id, clip, editToken);
          setSaved(id, clip);
          await done(id);
          return;
        }
        if (!turnstileToken) {
          setPending({ kind, key: (keys.current += 1) });
          return;
        }
        const result = await saveClip(clip, turnstileToken);
        if (result.editToken) setClipEditToken(result.id, result.editToken);
        setSaved(result.id, clip);
        await done(result.id, result.existed ? 'The same notes are saved: their link' : undefined);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Saving failed');
      } finally {
        setBusy(false);
      }
    },
    [$clip, $id, $savedHash, setSaved, presetId]
  );

  React.useEffect(() => {
    if (!pending) return undefined;
    const timeout = setTimeout(() => {
      setPending(null);
      toast.error('The captcha did not answer');
    }, CAPTCHA_TIMEOUT_MS);
    return () => clearTimeout(timeout);
  }, [pending]);

  const captcha = pending && (
    <Captcha>
      <Turnstile
        key={pending.key}
        siteKey={TURNSTILE_SITE_KEY}
        options={{ appearance: 'interaction-only' }}
        onSuccess={(token) => {
          setPending(null);
          run(pending.kind, token);
        }}
        onError={() => {
          setPending(null);
          toast.error('The captcha failed, try again');
        }}
        onUnsupported={() => {
          setPending(null);
          toast.error('Captcha is not supported by this browser');
        }}
      />
    </Captcha>
  );

  return { save: run, busy: busy || pending !== null, captcha };
};
