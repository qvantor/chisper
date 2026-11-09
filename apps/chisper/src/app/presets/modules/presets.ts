import {
  BehaviorSubject,
  combineLatest,
  debounceTime,
  defer,
  distinctUntilChanged,
  fromEvent,
  map,
  merge,
} from 'rxjs';
import toast from 'react-hot-toast';
import { PrimitiveBS, rxModel, rxModelReact } from '@chisper/rxjs-react';
import {
  normalizePreset,
  presetDataSchema,
  presetHash,
  Preset,
  PresetData,
  PresetListItem,
} from '@chisper/preset-schema';
import { applySnapshot, getSnapshot, $snapshotChanges } from '../../app';
import { readStored, writeStored } from '../../common/services';
import type { SoundSwitchModule } from '../../synth/common/modules/sound-switch';
import type { TrackModule } from '../../synth/track/modules/track';
import {
  clearUrlPresetId,
  getEditToken,
  getPreset,
  getTopPresets,
  getUrlPresetId,
  markPresetOpened,
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
// none)
interface SavedPreset {
  id: string;
  name: string;
  clipId?: string | null;
}

// the current preset of one the server gave (its other fields left out)
const currentOf = ({ id, name, clipId }: SavedPreset, auto = false): CurrentPreset => ({
  id,
  name,
  ...(auto && { auto }),
  ...(clipId && { clipId }),
});

// a preset being opened while it isn't the current one yet: its name (null: not known yet, a link) and whether its
// request is still on
export interface OpeningPreset {
  name: string | null;
  requested: boolean;
}

// the name of the sound without a preset
export const INIT_NAME = 'Init';

// the progress of a preset opening (0..1): REQUEST_SHARE while its request is on (a click shows at once; on start
// the request of the popular presets too, before one is picked), then SWITCH_FROM + the rest of the switch (the
// fade, then the tables and the noise of the sound: sound-switch.ts)
const REQUEST_SHARE = 0.1;
const SWITCH_FROM = 0.15;
const loadProgress = (opening: OpeningPreset | null, popularRequest: boolean, switching: number | null) => {
  if (opening?.requested || popularRequest) return REQUEST_SHARE;
  if (switching !== null) return SWITCH_FROM + (1 - SWITCH_FROM) * switching;
  return opening ? SWITCH_FROM : null;
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
  const { current, loadedHash, data } = (value ?? {}) as Partial<Record<keyof TabState, unknown>>;
  return (
    (current === null || isCurrentPreset(current)) &&
    (loadedHash === null || typeof loadedHash === 'string') &&
    presetDataSchema.safeParse(data).success
  );
};

interface Dependencies {
  // a preset switch silences the synth until the next preset can play
  soundSwitch: SoundSwitchModule;
  // the track opens the clip of a preset with its sound
  track: TrackModule;
}

export const presets = ({
  soundSwitch: [{ $progress: $switchProgress }, { switchSound }],
  track: [, { openPresetClip }],
}: Dependencies) =>
  rxModel(() => {
    const $current = new BehaviorSubject<CurrentPreset | null>(null);
    const $loadedHash = new BehaviorSubject<string | null>(null);
    const $dirty = new PrimitiveBS<boolean>(false); // params were changed after the preset was loaded
    const $list = new BehaviorSubject<PresetListItem[]>([]); // list for ◀ ▶ (popular or the last search)
    // popular presets, loaded once on start for ◀ ▶ and the Popular tab; null until loaded
    const $top = new BehaviorSubject<PresetListItem[] | null>(null);
    const $topLoading = new PrimitiveBS<boolean>(false);
    // the preset being opened (null: none) and the progress of the opening, until its sound is loaded (null: none)
    const $opening = new BehaviorSubject<OpeningPreset | null>(null);
    const $loadProgress = new BehaviorSubject<number | null>(null);
    // on start the popular presets are requested, none picked yet (it shows in the progress only: the name stays)
    const $popularRequest = new PrimitiveBS<boolean>(false);
    return {
      $current,
      $loadedHash,
      $dirty,
      $list,
      $top,
      $topLoading,
      $opening,
      $loadProgress,
      $popularRequest,
    };
  })
    .actions((model) => {
      const { $current, $loadedHash, $dirty, $list, $top, $topLoading, $opening, $popularRequest } = model;
      // the current preset (null: Init) with the hash of its params, clean and in the url unless auto
      const setCurrent = (current: CurrentPreset | null, hash: string | null) => {
        $current.next(current);
        $loadedHash.next(hash);
        $dirty.next(false);
        const id = chosenId(current);
        if (id !== null) setUrlPresetId(id);
        else clearUrlPresetId();
      };

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
      const restore = ({ current, loadedHash, data }: TabState) => {
        applySnapshot(normalizePreset(data));
        setCurrent(current, loadedHash);
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
        return ++lastOpening;
      };
      const setOpening = (token: number, opening: OpeningPreset | null) => {
        if (token === lastOpening) $opening.next(opening);
      };

      // in silence, once the sound of the preset before has faded out (a preset chosen meanwhile replaces it), its
      // clip with it (the track keeps a clip of the user); one that throws as it is applied doesn't become the
      // current one. Its opening (`token`) ends with it
      const applyPreset = (preset: Preset, token: number, auto = false) => {
        const data = normalizePreset(preset.data);
        const { clip } = preset;
        setOpening(token, { name: preset.name, requested: false });
        switchSound(() => {
          try {
            applySnapshot(data);
          } catch (e) {
            loadFailed(e);
            setOpening(token, null);
            return;
          }
          if (clip) openPresetClip(clip);
          setCurrent(currentOf({ ...preset, clipId: clip?.id }, auto), presetHash(data));
          setOpening(token, null);
          markOpened(preset.id);
        });
      };

      // its name in the list of ◀ ▶ is shown while it loads (none: a link); a failed request shows the current one
      // again
      let lastRequest = 0;
      const loadById = async (id: string, { errorMessage }: { errorMessage?: string } = {}) => {
        const request = ++lastRequest;
        const name = $list.value.find((item) => item.id === id)?.name ?? null;
        const token = startOpening({ name, requested: true });
        try {
          const preset = await getPreset(id);
          // fast ◀ ▶ clicks: only the last requested preset is applied
          if (request === lastRequest) applyPreset(preset, token);
        } catch (e) {
          loadFailed(e, errorMessage);
          setOpening(token, null);
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
        const index = list.findIndex(({ id }) => id === $current.value?.id);
        // not in the list: ▶ starts from the first (most popular), ◀ from the last
        const next =
          index === -1
            ? direction === 1
              ? 0
              : list.length - 1
            : (index + direction + list.length) % list.length;
        await loadById(list[next].id);
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
          $popularRequest.next(false);
          if (!top?.length || !untouched()) return;
          const picked = top[Math.floor(Math.random() * top.length)];
          const token = startOpening({ name: picked.name, requested: true });
          const preset = await getPreset(picked.id).catch(() => null);
          // (data the schema refuses throws before anything changed: it stays in Init too)
          try {
            if (preset && untouched()) return applyPreset(preset, token, true);
          } catch (e) {
            console.error('The popular preset could not be applied', e);
          }
          setOpening(token, null);
        },
        next: () => step(1),
        prev: () => step(-1),
        setList: (list: PresetListItem[]) => $list.next(list),
        // the saved preset becomes current, current params are its params
        setSaved: (preset: SavedPreset) => setCurrent(currentOf(preset), currentHash()),
        // back to Init: the default sound without a preset
        reset: () => {
          lastRequest++; // a preset still loading is not applied over Init
          const token = startOpening({ name: INIT_NAME, requested: false });
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
    .subscriptions(({ $current, $loadedHash, $dirty }, { restore, loadById, loadTop, openPopular }) => {
      // a clean preset opens from the url by itself, a start without one opens a popular preset instead of Init
      const saveTabState = (data = getSnapshot(), hash = hashOf(data)) => {
        const current = $current.value;
        const kept = current ? current.auto || hash !== $loadedHash.value : hash !== INIT_HASH;
        writeStored(
          'sessionStorage',
          TAB_STATE_KEY,
          kept ? { current, loadedHash: $loadedHash.value, data } : null
        );
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
        merge($snapshotChanges, $current)
          .pipe(debounceTime(200))
          .subscribe(() => {
            const data = getSnapshot();
            const hash = hashOf(data);
            $dirty.next(isDirty($loadedHash.value, hash));
            saveTabState(data, hash);
          }),
        // a reload within the debounce, while a knob is dragged
        fromEvent(window, 'pagehide').subscribe(() => saveTabState()),
      ];
    })
    // the progress of an opening follows its request, then the switch of the sound
    .subscriptions(({ $opening, $popularRequest, $loadProgress }) =>
      combineLatest([$opening, $popularRequest, $switchProgress])
        .pipe(
          map(([opening, popularRequest, switching]) => loadProgress(opening, popularRequest, switching)),
          distinctUntilChanged()
        )
        .subscribe($loadProgress)
    );

export const { ModelProvider: PresetsProvider, useModel: usePresets } = rxModelReact('presets', presets);
