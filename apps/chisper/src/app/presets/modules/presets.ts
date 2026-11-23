import {
  BehaviorSubject,
  combineLatest,
  debounceTime,
  defer,
  distinctUntilChanged,
  filter,
  fromEvent,
  map,
  merge,
  Subscription,
  take,
} from 'rxjs';
import toast from 'react-hot-toast';
import { PrimitiveBS, rxModel, rxModelReact } from '@chisper/rxjs-react';
import type { LoadShare } from '@chisper/ui-kit';
import {
  normalizePreset,
  presetDataSchema,
  presetHash,
  Preset,
  PresetClip,
  PresetData,
  PresetInfo,
  presetInfoSchema,
  PresetListItem,
} from '@chisper/preset-schema';
import { applySnapshot, getSnapshot, $snapshotChanges } from '../../app';
import { readStored, writeStored } from '../../common/services';
import { captureLoadError, featureUsed } from '../../common/services/analytics';
import type { SoundSwitchModule } from '../../synth/common/modules/sound-switch';
import type { TrackModule } from '../../synth/track/modules/track';
import {
  clearUrlPresetId,
  editTokenIds,
  getEditToken,
  getPreset,
  getTopPresets,
  getUrlPresetId,
  markPresetOpened,
  setEditToken,
  setUrlPresetId,
} from '../services';

export interface CurrentPreset {
  id: string;
  name: string;
  // opened on start without a choice of the user, its listens and stays are not counted (see usePresetUsageTracker);
  // not in the url: after a reload it would open from the link as chosen
  auto?: boolean;
  // the clip it opens with (missing: none)
  clipId?: string;
}

// a preset as the server gives it saved (or opened, by the id of its clip): the clip it opens with (null or missing:
// none), its info, the edit token of a new one
interface SavedPreset {
  id: string;
  name: string;
  clipId?: string | null;
  info?: PresetInfo;
  editToken?: string;
}

// the presets this browser keeps a list of: marked with a star (Favorites), opened last (Recent)
const FAVORITES_KEY = 'presetFavorites';
const RECENT_KEY = 'presetRecent';
const FAVORITES_MAX = 200;
export const RECENT_MAX = 50;
const isIds = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((id) => typeof id === 'string');
// (none stored or unreadable: `initial`)
const readIds = (key: string, initial: string[] = []) => readStored('localStorage', key, initial, isIds);
// a list of ids with `id` first, once, cut at `max`
const toFront = (ids: string[], id: string, max = Infinity) =>
  [id, ...ids.filter((other) => other !== id)].slice(0, max);

// `ids` in the order of `shown`, those new to it first (a list on the screen whose rows don't move); `shown` itself
// when it has the same ids
export const keepOrder = (shown: string[], ids: string[]) => {
  const kept = shown.filter((id) => ids.includes(id));
  const added = ids.filter((id) => !shown.includes(id));
  return added.length === 0 && kept.length === shown.length ? shown : [...added, ...kept];
};

// the rows of a list with the info of `id` (the same list without it)
export const withInfo = <T extends PresetListItem>(items: T[], id: string, info: PresetInfo): T[] =>
  items.some((item) => item.id === id)
    ? items.map((item) => (item.id === id ? { ...item, ...info } : item))
    : items;

// the index a step goes to from `index` in a list of `length` (-1: not in it, on from the first, back from the
// last), around its ends (◀ ▶) or stopped at them (the arrows of the browser)
export const stepIndex = (length: number, index: number, direction: 1 | -1, wrap: boolean) => {
  if (index === -1) return direction === 1 ? 0 : length - 1;
  return wrap ? (index + direction + length) % length : Math.min(Math.max(index + direction, 0), length - 1);
};

// the current preset of one the server gave (its other fields left out)
const currentOf = ({ id, name, clipId }: SavedPreset, auto = false): CurrentPreset => ({
  id,
  name,
  ...(auto && { auto }),
  ...(clipId && { clipId }),
});

// a preset being opened while it isn't the current one yet: its id (null: Init), its name (null: not known yet, a
// link) and whether its request is still on
export interface OpeningPreset {
  id: string | null;
  name: string | null;
  requested: boolean;
}

// the name of the sound without a preset
export const INIT_NAME = 'Init';

// the progress of a preset opening (0..1): REQUEST_SHARE while its request is on (a click shows at once; on start
// the request of the popular presets too, before one is picked), then SWITCH_FROM + the rest of the switch (the
// fade, then the tables and the noise of the sound: sound-switch.ts); failed once one ended without its sound
const REQUEST_SHARE = 0.1;
const SWITCH_FROM = 0.15;
const loadProgress = (
  opening: OpeningPreset | null,
  popularRequest: boolean,
  switching: number | null,
  failed: boolean
): LoadShare => {
  if (opening?.requested || popularRequest) return REQUEST_SHARE;
  if (switching !== null) return SWITCH_FROM + (1 - SWITCH_FROM) * switching;
  if (opening) return SWITCH_FROM;
  return failed ? 'failed' : null;
};

// the id the url keeps: of a chosen preset, none of Init or an auto one
export const chosenId = (current: CurrentPreset | null) => (current && !current.auto ? current.id : null);

// null: params out of the schema
const hashOf = (data: Record<string, unknown>) => {
  try {
    return presetHash(data);
  } catch {
    return null;
  }
};
const currentHash = () => hashOf(getSnapshot());

// Init is the default sound: every missing key of a preset is its default
const INIT_HASH = presetHash({});
const isInit = () => currentHash() === INIT_HASH;
const isDirty = (loadedHash: string | null, hash = currentHash()) =>
  loadedHash !== null && hash !== loadedHash;

// the state of the tab (sessionStorage): what a reload would lose, the url keeps only the id of a chosen preset
const TAB_STATE_KEY = 'presetState';

interface TabState {
  current: CurrentPreset | null;
  loadedHash: string | null;
  data: PresetData;
  // the info of the current preset (missing: not known)
  info?: PresetInfo;
}

const isCurrentPreset = (value: unknown): value is CurrentPreset => {
  const { id, name, auto, clipId } = (value ?? {}) as Partial<Record<keyof CurrentPreset, unknown>>;
  return (
    typeof id === 'string' &&
    typeof name === 'string' &&
    (auto === undefined || auto === true) &&
    (clipId === undefined || typeof clipId === 'string')
  );
};

// params out of the schema drop the state, those of another version of the app get its defaults (`restore`)
const isTabState = (value: unknown): value is TabState => {
  const { current, loadedHash, data, info } = (value ?? {}) as Partial<Record<keyof TabState, unknown>>;
  return (
    (current === null || isCurrentPreset(current)) &&
    (loadedHash === null || typeof loadedHash === 'string') &&
    (info === undefined || presetInfoSchema.safeParse(info).success) &&
    presetDataSchema.safeParse(data).success
  );
};

interface Dependencies {
  // a preset switch silences the synth until the next preset can play
  soundSwitch: SoundSwitchModule;
  // the track opens the clip of a preset with its sound (or plays it, heard from the list)
  track: TrackModule;
}

export const presets = ({
  soundSwitch: [{ $progress: $switchProgress, $switching }, { switchSound }],
  track: [
    { $auditioning: $trackAuditioning },
    { openPresetClip, auditionClip, playAudition, holdAudition, endAudition },
  ],
}: Dependencies) =>
  rxModel(() => {
    const $current = new BehaviorSubject<CurrentPreset | null>(null);
    // what the author tells of the current preset (its category, description, tags; null: Init, or not known): the
    // Save dialog starts from it
    const $currentInfo = new BehaviorSubject<PresetInfo | null>(null);
    // the presets of this browser's lists (ids, the last added first); Mine: those saved from it (their edit tokens)
    const $favorites = new BehaviorSubject<string[]>(readIds(FAVORITES_KEY));
    const $recent = new BehaviorSubject<string[]>(readIds(RECENT_KEY));
    const $mine = new BehaviorSubject<string[]>(editTokenIds());
    // the preset whose clip is heard from the list (its Play: null, none), from the click to Stop
    const $auditioning = new BehaviorSubject<string | null>(null);
    const $loadedHash = new BehaviorSubject<string | null>(null);
    const $dirty = new PrimitiveBS<boolean>(false); // params were changed after the preset was loaded
    const $list = new BehaviorSubject<PresetListItem[]>([]); // list for ◀ ▶ (popular or the last search)
    // popular presets, loaded once on start for ◀ ▶ and the Popular tab; null until loaded
    const $top = new BehaviorSubject<PresetListItem[] | null>(null);
    const $topLoading = new PrimitiveBS<boolean>(false);
    // the preset being opened (null: none), whether the last opening ended without its sound (its request failed,
    // the preset was refused, the start stayed in Init) and the progress of the opening, until its sound is loaded
    // (null: none)
    const $opening = new BehaviorSubject<OpeningPreset | null>(null);
    const $openingFailed = new PrimitiveBS<boolean>(false);
    const $loadProgress = new BehaviorSubject<LoadShare>(null);
    // on start the popular presets are requested, none picked yet (it shows in the progress only: the name stays);
    // over once an opening starts: the start opens nothing after it
    const $popularRequest = new PrimitiveBS<boolean>(false);
    return {
      $current,
      $currentInfo,
      $favorites,
      $recent,
      $mine,
      $auditioning,
      $loadedHash,
      $dirty,
      $list,
      $top,
      $topLoading,
      $opening,
      $openingFailed,
      $loadProgress,
      $popularRequest,
    };
  })
    .actions((model) => {
      const {
        $current,
        $currentInfo,
        $favorites,
        $recent,
        $mine,
        $auditioning,
        $loadedHash,
        $dirty,
        $list,
        $top,
        $topLoading,
        $opening,
        $openingFailed,
        $popularRequest,
      } = model;
      // the current preset (null: Init) with the hash of its params, clean and in the url unless auto; its info
      // (missing: not known)
      const setCurrent = (current: CurrentPreset | null, hash: string | null, info?: PresetInfo) => {
        $current.next(current);
        $currentInfo.next(current && info ? info : null);
        $loadedHash.next(hash);
        $dirty.next(false);
        const id = chosenId(current);
        if (id !== null) setUrlPresetId(id);
        else clearUrlPresetId();
      };

      // a list of this browser changed as it is stored now (another tab may have changed it since: its ids stay;
      // the storage unreadable, as this one has it), kept
      const changeIds = (
        $ids: BehaviorSubject<string[]>,
        key: string,
        change: (ids: string[]) => string[]
      ) => {
        const ids = change(readIds(key, $ids.value));
        $ids.next(ids);
        writeStored('localStorage', key, ids);
      };
      // a preset opened by the user (not on start by itself) or saved is the first of Recent
      const addRecent = (id: string) => changeIds($recent, RECENT_KEY, (ids) => toFront(ids, id, RECENT_MAX));

      // opening own preset (saved from this browser) keeps it from the cleanup; the server counts days, so once
      // a session is enough, a failed request is sent again on the next opening
      const opened = new Set<string>();
      const markOpened = (id: string) => {
        const editToken = getEditToken(id);
        if (!editToken || opened.has(id)) return;
        opened.add(id);
        markPresetOpened(id, { editToken }).catch(() => opened.delete(id));
      };

      // the state the tab had before a reload, edits included
      const restore = ({ current, loadedHash, data, info }: TabState) => {
        applySnapshot(normalizePreset(data));
        setCurrent(current, loadedHash, info);
        $dirty.next(isDirty(loadedHash));
        if (current && !current.auto) markOpened(current.id);
      };

      const loadFailed = (e: unknown, message?: string) =>
        toast.error(message ?? (e instanceof Error ? e.message : 'Preset loading failed'));

      // the opening started last owns $opening: one started before it (a slower request, a preset applied after
      // a later click) changes nothing
      let lastOpening = 0;
      const startOpening = (opening: OpeningPreset) => {
        $opening.next(opening);
        $openingFailed.next(false);
        $popularRequest.next(false);
        return ++lastOpening;
      };
      const setOpening = (token: number, opening: OpeningPreset | null) => {
        if (token === lastOpening) $opening.next(opening);
      };
      // it ended without its sound: the progress fades where it is
      const failOpening = (token: number) => {
        if (token !== lastOpening) return;
        $openingFailed.next(true);
        $opening.next(null);
      };

      // the clip of a preset heard from the list: the request of the last Play (a Play after it, Stop end it), the
      // start of its notes once the sound plays
      let auditionRequest = 0;
      let auditionStart: Subscription | undefined;
      const cancelAudition = () => {
        auditionRequest++;
        auditionStart?.unsubscribe();
        if ($auditioning.value !== null) $auditioning.next(null);
      };
      // no clip to hear after all (its preset failed, has none any more, the track can't now): the track as it was
      const failAudition = (request: number) => {
        if (request === 0 || request !== auditionRequest) return;
        cancelAudition();
        endAudition();
      };
      // the notes start once the switch of the sound is over (not in its fade): the clip from its start, in a loop
      const startAudition = (request: number) => {
        auditionStart?.unsubscribe();
        auditionStart = $switching
          .pipe(
            filter((switching) => !switching),
            take(1)
          )
          .subscribe(() => {
            if (request === auditionRequest) playAudition();
          });
      };

      // the clip of a preset heard, once its sound plays (none, or the track can't now: the track as it was)
      const hearPresetClip = (clip: PresetClip | null, request: number) => {
        if (clip && auditionClip(clip)) startAudition(request);
        else failAudition(request);
      };
      // the preset opened last and the clip it opened with (null: none, or not known: a reload, a save)
      let openedWith: { id: string; clip: PresetClip | null } | null = null;
      // the clip of the current preset heard as it sounds: the one it opened with, else its request for the clip alone
      const hearClip = async (id: string, request: number) => {
        try {
          const clip = openedWith?.id === id ? openedWith.clip : (await getPreset(id)).clip;
          if (request === auditionRequest) hearPresetClip(clip, request);
        } catch (e) {
          if (request === auditionRequest) loadFailed(e);
          failAudition(request);
        }
      };

      // in silence, once the sound of the preset before has faded out (a preset chosen meanwhile replaces it), its
      // clip with it (the track keeps a clip of the user; one heard from the list, `audition`, takes the place of
      // the clip of the track while it is heard); one that throws as it is applied doesn't become the current one.
      // Its opening (`token`) ends with it. Data the schema refuses throws at once; that and a throw as it is applied
      // are reported (its id is public), whoever opened it
      const applyPreset = (preset: Preset, token: number, { auto = false, audition = 0 } = {}) => {
        let data: PresetData;
        try {
          data = normalizePreset(preset.data);
        } catch (e) {
          captureLoadError(e, 'preset', preset.id);
          throw e;
        }
        const { clip } = preset;
        setOpening(token, { id: preset.id, name: preset.name, requested: false });
        switchSound(() => {
          try {
            applySnapshot(data);
          } catch (e) {
            captureLoadError(e, 'preset', preset.id);
            loadFailed(e);
            failOpening(token);
            failAudition(audition);
            return;
          }
          if (audition && audition === auditionRequest) hearPresetClip(clip, audition);
          else if (clip) openPresetClip(clip);
          setCurrent(currentOf({ ...preset, clipId: clip?.id }, auto), presetHash(data), preset.info);
          openedWith = { id: preset.id, clip };
          if (!auto) addRecent(preset.id);
          setOpening(token, null);
          markOpened(preset.id);
        });
      };

      // its name in the list of ◀ ▶ is shown while it loads (none: a link); a failed request shows the current one
      // again. Its clip heard (the request of a Play: `audition`)
      let lastRequest = 0;
      const loadById = async (
        id: string,
        { errorMessage, audition = 0 }: { errorMessage?: string; audition?: number } = {}
      ) => {
        const request = ++lastRequest;
        const name = $list.value.find((item) => item.id === id)?.name ?? null;
        const token = startOpening({ id, name, requested: true });
        try {
          const preset = await getPreset(id);
          // fast ◀ ▶ clicks: only the last requested preset is applied
          if (request === lastRequest) applyPreset(preset, token, { audition });
          else failAudition(audition);
        } catch (e) {
          loadFailed(e, errorMessage);
          failOpening(token);
          failAudition(audition);
        }
      };

      // parallel calls share one request; on failure $top stays null and the next call retries
      let topRequest: Promise<PresetListItem[] | null> | null = null;
      const loadTop = ({ silent = false } = {}) => {
        if (!topRequest) {
          $topLoading.next(true);
          topRequest = getTopPresets()
            .then((list) => {
              $top.next(list);
              return list;
            })
            .catch((e) => {
              if (!silent) toast.error(e instanceof Error ? e.message : 'Presets loading failed');
              return null;
            })
            .finally(() => {
              topRequest = null;
              $topLoading.next(false);
            });
        }
        return topRequest;
      };

      const step = async (direction: 1 | -1) => {
        // without a list (Init, a preset from the link) ◀ ▶ walk the popular presets
        if ($list.value.length === 0) {
          // clicks while loading are dropped
          if (topRequest) return;
          const top = $top.value ?? (await loadTop());
          if (top) $list.next(top);
        }
        const list = $list.value;
        if (list.length === 0) return;
        // (a step taken: ◀ ▶ opened a preset of the list)
        featureUsed('preset', 'open');
        // not in the list: ▶ starts from the first (most popular), ◀ from the last
        const index = list.findIndex(({ id }) => id === $current.value?.id);
        await loadById(list[stepIndex(list.length, index, direction, true)].id);
      };

      return {
        restore,
        loadById,
        loadTop,
        // start without a link: a random popular preset, unless something was loaded, saved or changed meanwhile;
        // random, not the first: none of them is opened for every visitor; fails silently, the synth stays in Init.
        // Its request shows in the progress, its name once it is picked
        openPopular: async () => {
          const start = lastRequest;
          const untouched = () => lastRequest === start && !$current.value && isInit();
          $popularRequest.next(true);
          const top = await loadTop({ silent: true });
          if (!top?.length || !untouched()) {
            $popularRequest.next(false);
            return;
          }
          const picked = top[Math.floor(Math.random() * top.length)];
          const token = startOpening({ id: picked.id, name: picked.name, requested: true });
          const preset = await getPreset(picked.id).catch(() => null);
          // (data the schema refuses throws before anything changed: it stays in Init too)
          try {
            if (preset && untouched()) return applyPreset(preset, token, { auto: true });
          } catch (e) {
            console.error('The popular preset could not be applied', e);
          }
          failOpening(token);
        },
        // the next or the one before of the list (◀ ▶): opened by the user
        next: () => step(1),
        prev: () => step(-1),
        setList: (list: PresetListItem[]) => $list.next(list),
        // the saved preset becomes current, current params are its params; a new one is of Mine (its edit token kept)
        setSaved: (preset: SavedPreset) => {
          featureUsed('preset', 'save');
          if (preset.editToken) {
            setEditToken(preset.id, preset.editToken);
            $mine.next(toFront($mine.value, preset.id));
          }
          setCurrent(currentOf(preset), currentHash(), preset.info);
          openedWith = null;
          addRecent(preset.id);
        },
        // Edit info of an own preset: the current one and the popular presets know it (the lists of the browser
        // its queries: InfoDialog)
        setInfo: (id: string, info: PresetInfo) => {
          if ($current.value?.id === id) $currentInfo.next(info);
          if ($top.value) $top.next(withInfo($top.value, id, info));
        },
        // a star of a row: in Favorites (the last first) or out of it
        toggleFavorite: (id: string) =>
          changeIds($favorites, FAVORITES_KEY, (favorites) => {
            if (favorites.includes(id)) return favorites.filter((other) => other !== id);
            featureUsed('preset', 'favorites');
            return toFront(favorites, id, FAVORITES_MAX);
          }),
        // Play of a row: its preset opens and its clip is heard (once its sound plays, from the start, in a loop) in
        // place of the clip of the track, until Stop; a Play of another row takes its place. The track stops at once.
        // The current preset (none opening after it) isn't opened again: its clip is heard with the sound as it is
        // (its knobs turned since stay)
        audition: (id: string) => {
          featureUsed('preset', 'audition');
          cancelAudition();
          const request = auditionRequest;
          $auditioning.next(id);
          holdAudition();
          if ($current.value?.id === id && $opening.value === null) return hearClip(id, request);
          return loadById(id, { audition: request });
        },
        // Stop (a row clicked, the list closed): the clip of the track is back, the track stopped; the preset stays.
        // None heard: nothing
        stopAudition: () => {
          if ($auditioning.value === null) return;
          cancelAudition();
          endAudition();
        },
        // back to Init: the default sound without a preset
        reset: () => {
          lastRequest++; // a preset still loading is not applied over Init
          const token = startOpening({ id: null, name: INIT_NAME, requested: false });
          switchSound(() => {
            try {
              applySnapshot(normalizePreset({}));
              setCurrent(null, null);
            } finally {
              setOpening(token, null);
            }
          });
        },
      };
    })
    .subscriptions((model, { restore, loadById, loadTop, openPopular }) => {
      const { $current, $currentInfo, $loadedHash, $dirty, $favorites, $recent } = model;
      // a clean preset opens from the url by itself, a start without one opens a popular preset instead of Init
      const saveTabState = (data = getSnapshot(), hash = hashOf(data)) => {
        const current = $current.value;
        const kept = current ? current.auto || hash !== $loadedHash.value : hash !== INIT_HASH;
        const info = $currentInfo.value;
        const state = { current, loadedHash: $loadedHash.value, data, ...(info && { info }) };
        writeStored('sessionStorage', TAB_STATE_KEY, kept ? state : null);
      };
      return [
        defer(() => {
          const urlId = getUrlPresetId();
          const saved = readStored('sessionStorage', TAB_STATE_KEY, null, isTabState);
          // after a reload the tab keeps its state, unless it was given a link to another preset
          if (saved && chosenId(saved.current) === urlId) {
            restore(saved);
            return loadTop({ silent: true });
          }
          // with a link only its preset opens, the popular list loads meanwhile for ◀ ▶
          return urlId
            ? Promise.all([
                loadTop({ silent: true }),
                loadById(urlId, { errorMessage: 'Preset from the link was not found' }),
              ])
            : openPopular();
        }).subscribe(),
        merge($snapshotChanges, $current, $currentInfo)
          .pipe(debounceTime(200))
          .subscribe(() => {
            const data = getSnapshot();
            const hash = hashOf(data);
            $dirty.next(isDirty($loadedHash.value, hash));
            saveTabState(data, hash);
          }),
        // a reload within the debounce, while a knob is dragged
        fromEvent(window, 'pagehide').subscribe(() => saveTabState()),
        // another tab changed a list of this browser (null: the storage cleared): this one shows it
        fromEvent<StorageEvent>(window, 'storage').subscribe(({ key }) => {
          if (key === null || key === FAVORITES_KEY) $favorites.next(readIds(FAVORITES_KEY));
          if (key === null || key === RECENT_KEY) $recent.next(readIds(RECENT_KEY));
        }),
      ];
    })
    // the progress of an opening follows its request, then the switch of the sound
    .subscriptions(({ $opening, $popularRequest, $openingFailed, $loadProgress }) =>
      combineLatest([$opening, $popularRequest, $switchProgress, $openingFailed])
        .pipe(
          map(([opening, popularRequest, switching, failed]) =>
            loadProgress(opening, popularRequest, switching, failed)
          ),
          distinctUntilChanged()
        )
        .subscribe($loadProgress)
    )
    // the track ended the clip heard (its Stop, REC, a MIDI Clock): no Play of a row is on
    .subscriptions(({ $auditioning }) =>
      $trackAuditioning
        .pipe(filter((auditioning) => !auditioning && $auditioning.value !== null))
        .subscribe(() => $auditioning.next(null))
    );

export const {
  ModelProvider: PresetsProvider,
  useModel: usePresets,
  // (null outside the provider: the roll of a spec)
  Context: PresetsContext,
} = rxModelReact('presets', presets);
