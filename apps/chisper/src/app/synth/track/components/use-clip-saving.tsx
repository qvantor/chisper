import React from 'react';
import { styled } from 'styled-components';
import toast from 'react-hot-toast';
import { Turnstile } from '@marsidev/react-turnstile';
import { CLIP_NAME_REFUSED, clipHash, clipNameAllowed } from '@chisper/preset-schema';
import { CAPTCHA_TIMEOUT_MS, shareClip, TURNSTILE_SITE_KEY } from '../../../presets/services';
import { useTrack } from '../modules/track';
import { getClipEditToken, setClipEditToken } from '../services/clip-edit-tokens';
import { saveClip, updateClip } from '../services/clips-api';

// save: the clip saved from this browser overwritten, another one saved anew; new: a new link whatever it is
type PersistMode = 'save' | 'new';

// a save of the roll: as `PersistMode` told by a toast; share: saved (unless it is so already), its link copied with
// the preset it plays
export type SaveKind = PersistMode | 'share';

// the clip saved: its id; existed: the same notes were saved before (their link)
interface PersistedClip {
  id: string;
  existed: boolean;
}

// a save waiting for the captcha: the token it gave (null: none)
interface Pending {
  key: number;
  resolve: (token: string | null) => void;
}

// shown only when the visitor has to interact (a managed widget): under the toolbar, right
const Captcha = styled.div`
  position: fixed;
  top: 120px;
  right: 16px;
  z-index: 4;
`;

// the clip of the track saved quietly: a new clip with a Turnstile token of its own (`captcha`, its widget made for it
// and removed once it gave one, where the caller puts it), one of this browser overwritten by its edit token. A save
// gives the clip saved (null: it failed, a toast told why)
export const usePersistClip = () => {
  const [{ $clip, $id, $savedHash }, { setSaved }] = useTrack();
  const [busy, setBusy] = React.useState(false);
  const [pending, setPending] = React.useState<Pending | null>(null);
  const keys = React.useRef(0);

  const persist = React.useCallback(
    async (mode: PersistMode = 'save'): Promise<PersistedClip | null> => {
      // the clip as it is: again once the captcha gave its token (an edit meanwhile is saved)
      const attempt = async (turnstileToken?: string): Promise<PersistedClip | null> => {
        const clip = $clip.value;
        const id = $id.value;
        if (mode === 'save' && id !== null) {
          if (clipHash(clip) === $savedHash.value) return { id, existed: false };
          const editToken = getClipEditToken(id);
          if (editToken) {
            await updateClip(id, clip, editToken);
            setSaved(id, clip);
            return { id, existed: false };
          }
        }
        if (!turnstileToken) {
          const token = await new Promise<string | null>((resolve) =>
            setPending({ key: (keys.current += 1), resolve })
          );
          return token === null ? null : attempt(token);
        }
        const result = await saveClip(clip, turnstileToken);
        if (result.editToken) setClipEditToken(result.id, result.editToken);
        setSaved(result.id, clip);
        return { id: result.id, existed: result.existed };
      };
      // the server would refuse the name: told before the captcha
      if (!clipNameAllowed($clip.value.name)) {
        toast.error(CLIP_NAME_REFUSED);
        return null;
      }
      setBusy(true);
      try {
        return await attempt();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Saving failed');
        return null;
      } finally {
        setBusy(false);
      }
    },
    [$clip, $id, $savedHash, setSaved]
  );

  // the captcha gave no token: the save failed
  const fail = React.useCallback((waiting: Pending, message: string) => {
    setPending(null);
    toast.error(message);
    waiting.resolve(null);
  }, []);

  React.useEffect(() => {
    if (!pending) return undefined;
    const timeout = setTimeout(() => fail(pending, 'The captcha did not answer'), CAPTCHA_TIMEOUT_MS);
    return () => clearTimeout(timeout);
  }, [pending, fail]);

  const captcha = pending && (
    <Turnstile
      key={pending.key}
      siteKey={TURNSTILE_SITE_KEY}
      options={{ appearance: 'interaction-only' }}
      onSuccess={(token) => {
        setPending(null);
        pending.resolve(token);
      }}
      onError={() => fail(pending, 'The captcha failed, try again')}
      onUnsupported={() => fail(pending, 'Captcha is not supported by this browser')}
    />
  );

  return { persist, busy, captcha };
};

// the saves of the roll, told: `presetId` the preset a shared link opens with (null: the sound was changed, or none
// was chosen); the captcha fixed on the page
export const useClipSaving = (presetId: () => string | null) => {
  const { persist, busy, captcha } = usePersistClip();
  const save = React.useCallback(
    async (kind: SaveKind) => {
      const saved = await persist(kind === 'share' ? 'save' : kind);
      if (!saved) return;
      if (kind === 'share') await shareClip(saved.id, presetId());
      else toast.success(saved.existed ? 'The same notes are saved: their link' : 'The clip is saved');
    },
    [persist, presetId]
  );
  return { save, busy, captcha: captcha && <Captcha>{captcha}</Captcha> };
};
