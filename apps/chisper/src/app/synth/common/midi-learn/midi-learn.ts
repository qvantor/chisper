import {
  BehaviorSubject,
  combineLatest,
  distinctUntilChanged,
  EMPTY,
  filter,
  fromEvent,
  map,
  merge,
  skip,
  Subject,
  Subscription,
  switchMap,
  throttleTime,
} from 'rxjs';
import toast from 'react-hot-toast';
import type { MidiMark } from '@chisper/ui-kit';
import { PrimitiveBS, rxModel, rxModelReact } from '@chisper/rxjs-react';
import { MACRO_CC, MACROS } from '@chisper/preset-schema';
import { canStore, readStored, writeStored } from '../../../common/services';
import { featureUsed } from '../../../common/services/analytics';
import type { MidiCC, MidiControllerModule } from '../modules/midi-controller';
import {
  ccShare,
  isAssignable,
  knobShare,
  knobValue,
  onCC,
  pickupCatches,
  switchOn,
  zoneOf,
} from './cc-value';
import { CC_IDLE, ccKind, CcWatch, isDataEntry, isNrpnNumber, watchCC, watchTakes } from './cc-kind';
import { createMidiTargets, KnobTarget, MidiTarget, MidiTargetsDeps } from './midi-targets';

// ms: a control takes a CC at most this often, the first value at once, the last one after the pause (a stream of
// a DAW, 200 a second, moves a knob as often as a mouse dragging it)
export const CC_INTERVAL = 16;

// ms: a 0 that comes this soon after the CC that bound a switch is the release of a button (a pad in its momentary
// mode): each press of it toggles the switch, its release does nothing. A knob or a fader turned down moves a step at
// a time (64 → 63): it sets the switch by value
export const TOGGLE_WINDOW = 1000;

// how a knob takes the CC bound to it: at once (jump), or once the CC passes its value (pickup: soft takeover, a
// knob a preset or a hand moved since waits for the controller)
export type Takeover = 'jump' | 'pickup';
const TAKEOVERS: readonly Takeover[] = ['jump', 'pickup'];

// a control waiting for the CC to bind (its menu, or a press in the Learn mode)
export interface Learning {
  target: string;
  via: 'menu' | 'mode';
}

// what a control shows of MIDI Learn (MidiMark of the kit): its CC, whether it waits for one, and in Pickup where the
// controller is while it waits for it (a share of the travel; null: it follows the controller, or the CC never came)
const NO_MARK: MidiMark = { cc: null, waiting: false, pickup: null };
const sameMark = (a: MidiMark, b: MidiMark) =>
  a.cc === b.cc && a.waiting === b.waiting && a.pickup === b.pickup;

// the map of the browser (localStorage): a CC to the id of its control (a CC on whatever channel and input the Midi
// panel listens to), the takeover, the switches a press of their CC toggles (none: not written). Not of a preset: the
// presets and their hashes never have it
const MAP_KEY = 'midiMap';
type Bindings = Readonly<Record<number, string>>;
type Toggles = ReadonlySet<string>;
interface StoredMap {
  takeover: Takeover;
  bindings: Record<string, string>;
  toggles?: string[];
}
const isStoredMap = (value: unknown): value is StoredMap => {
  const { takeover, bindings, toggles } = (value ?? {}) as Partial<Record<keyof StoredMap, unknown>>;
  return (
    TAKEOVERS.includes(takeover as Takeover) &&
    typeof bindings === 'object' &&
    bindings !== null &&
    !Array.isArray(bindings) &&
    Object.values(bindings).every((id) => typeof id === 'string') &&
    (toggles === undefined || (Array.isArray(toggles) && toggles.every((id) => typeof id === 'string')))
  );
};
// a map as it is written (the same map: the same text)
const storedMap = (bindings: Bindings, takeover: Takeover, toggles: Toggles): StoredMap => ({
  takeover,
  bindings,
  ...(toggles.size > 0 && { toggles: [...toggles].sort() }),
});
// a map never stored: the macros on their CC (MACRO_CC of the schema, its MSB: 7 bits)
const DEFAULT_MAP: StoredMap = {
  takeover: 'jump',
  bindings: Object.fromEntries(MACROS.map((id) => [MACRO_CC[id].msb, id])),
};

// the bindings of a stored map that hold: a CC that may be bound, a control there is (a renamed or removed one is
// left out), one CC a control
const bindingsOf = (stored: Record<string, string>, known: (id: string) => boolean): Bindings => {
  const seen = new Set<string>();
  return Object.fromEntries(
    Object.entries(stored).flatMap(([key, id]) => {
      const cc = Number(key);
      if (!isAssignable(cc) || !known(id) || seen.has(id)) return [];
      seen.add(id);
      return [[cc, id]];
    })
  );
};

// the toggles of the switches bound
const togglesOf = (
  toggles: readonly string[] | Iterable<string> = [],
  bindings: Bindings,
  isSwitch: (id: string) => boolean
): Toggles => {
  const bound = new Set(Object.values(bindings));
  return new Set([...toggles].filter((id) => bound.has(id) && isSwitch(id)));
};
const sameSet = (a: Toggles, b: Toggles) => a.size === b.size && [...a].every((id) => b.has(id));

// a bound control as its CC moves it: the values of its CC (taken at most every CC_INTERVAL: `throttled`), the zone
// of a switch or a choice (it changes only when the CC enters another one or comes with the same value again), the
// value it set and its share of the travel then (a value that isn't that, or the same value at another share, its
// range changed since: the frames of the table, TRIP, the tempo, is another's: the same CC again puts it back; Pickup
// waits), whether the controller has it (Pickup) and the last CC it took
interface Live {
  values: Subject<number>;
  throttled: Subscription;
  zone?: number;
  set?: number;
  share?: number;
  caught: boolean;
  prev?: number;
}

interface Dependencies extends MidiTargetsDeps {
  midiController: MidiControllerModule;
}

const WAIT_TOAST = 'midi-learn';

// MIDI Learn: a CC of the input moves the control bound to it as a hand on it does (its action, where a mouse would
// put it), at most every CC_INTERVAL; a control waiting (`learn`) takes the next CC that may be bound (one bound to
// another control moves to it, another CC of it is replaced). The bindings of the browser, the Learn mode of the
// Midi panel (a press on a control chooses it, it doesn't move), Jump or Pickup
export const midiLearn = (deps: Dependencies) =>
  rxModel(() => {
    const targets = createMidiTargets(deps);
    const kept = canStore('localStorage');
    const map = readStored('localStorage', MAP_KEY, DEFAULT_MAP, isStoredMap);
    const known = (id: string) => targets.has(id);
    const isSwitch = (id: string) => targets.get(id)?.kind === 'switch';
    const $bindings = new BehaviorSubject<Bindings>(bindingsOf(map.bindings, known));
    const $takeover = new PrimitiveBS<Takeover>(map.takeover);
    const $toggles = new BehaviorSubject<Toggles>(togglesOf(map.toggles, $bindings.value, isSwitch));
    // what the names of the controls are of (a macro as typed, a knob of the filter by its type)
    const $names = merge(deps.modulation[0].$macroNames, deps.filter[0].$filterType);
    const $learning = new BehaviorSubject<Learning | null>(null);
    const $learnMode = new PrimitiveBS<boolean>(false);
    // the CC of each control
    const ccOf = new Map<string, number>();
    const lives = new Map<string, Live>();
    // the marks of the controls and who listens to each
    const marks = new Map<string, MidiMark>();
    const listeners = new Map<string, Set<() => void>>();
    const mark = (target: string) => marks.get(target) ?? NO_MARK;
    const setMark = (target: string, change: Partial<MidiMark>) => {
      const last = mark(target);
      const next = { ...last, ...change };
      if (sameMark(last, next)) return;
      if (sameMark(next, NO_MARK)) marks.delete(target);
      else marks.set(target, next);
      listeners.get(target)?.forEach((listener) => listener());
    };
    const subscribe = (target: string, listener: () => void) => {
      let set = listeners.get(target);
      if (!set) listeners.set(target, (set = new Set()));
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(target);
      };
    };
    return {
      targets,
      kept,
      known,
      isSwitch,
      $bindings,
      $takeover,
      $toggles,
      $names,
      $learning,
      $learnMode,
      ccOf,
      lives,
      mark,
      setMark,
      subscribe,
    };
  })
    .actions(({ targets, isSwitch, $bindings, $takeover, $toggles, $learning, $learnMode }) => {
      const unbind = (keep: (cc: number, id: string) => boolean) => {
        const bindings = Object.fromEntries(
          Object.entries($bindings.value).filter(([cc, id]) => keep(Number(cc), id))
        );
        if (Object.keys(bindings).length === Object.keys($bindings.value).length) return;
        $bindings.next(bindings);
        const toggles = togglesOf($toggles.value, bindings, isSwitch);
        if (!sameSet(toggles, $toggles.value)) $toggles.next(toggles);
      };
      // the control waits for the next CC (another one waiting no more); unknown: nothing
      const learn = (target: string, via: Learning['via'] = 'menu') => {
        if (!targets.has(target)) return;
        $learning.next({ target, via });
      };
      return {
        learn,
        // a control chosen in the Learn mode waits for the next CC
        select: (target: string) => {
          if ($learnMode.value) learn(target, 'mode');
        },
        cancel: () => {
          if ($learning.value) $learning.next(null);
        },
        // the CC of a control, none after
        remove: (target: string) => unbind((_, id) => id !== target),
        clear: () => unbind(() => false),
        // the Learn mode: a press on a control chooses it (select); off, the control chosen waits no more
        setLearnMode: (on: boolean) => {
          if (on === $learnMode.value) return;
          if (!on && $learning.value?.via === 'mode') $learning.next(null);
          $learnMode.next(on);
        },
        setTakeover: (takeover: Takeover) => {
          if (takeover !== $takeover.value) $takeover.next(takeover);
        },
        // a press of the CC of a switch bound toggles it (a button, a pad), or its value sets it (a fader, a DAW)
        setToggle: (target: string, on: boolean) => {
          if (!isSwitch(target) || !Object.values($bindings.value).includes(target)) return;
          if (on === $toggles.value.has(target)) return;
          const toggles = new Set($toggles.value);
          if (on) toggles.add(target);
          else toggles.delete(target);
          $toggles.next(toggles);
        },
      };
    })
    .subscriptions(
      (
        { targets, known, isSwitch, $bindings, $takeover, $toggles, $learning, ccOf, lives, setMark },
        { cancel }
      ) => {
        const {
          midiController: [{ $cc, $selectedInputId }],
          synthCore: [{ clock }],
        } = deps;
        // a control whose CC is gone (or another one bound): nothing of it is kept
        const forget = (id: string) => {
          lives.get(id)?.throttled.unsubscribe();
          lives.delete(id);
          setMark(id, { pickup: null });
        };
        // the control set by its own CC: what it emits meanwhile is not another's change (Pickup)
        let applying: string | null = null;
        // the control that shows it waits
        let waiting: string | null = null;
        // a switch just bound: a release of its CC within TOGGLE_WINDOW makes it a toggle
        let bound: { cc: number; id: string; at: number } | null = null;
        // the map of another tab taken: not written back
        let fromStorage = false;
        // the values of the CC bound last until their kind is told (analytics: what controllers send), and the
        // pause that ends them
        let watch: { values: CcWatch; idle: Subscription } | null = null;
        const tellKind = () => {
          if (!watch) return;
          watch.idle.unsubscribe();
          featureUsed('midi_learn', `cc_${ccKind(watch.values)}`);
          watch = null;
        };
        const idle = () => clock.scheduler.schedule(tellKind, CC_IDLE);
        const watchCCs = (cc: number, value: number) => {
          if (!watch) return;
          const more = watchTakes(watch.values, cc, value);
          if (!more) tellKind();
          else if (cc === watch.values.cc) {
            watch.idle.unsubscribe();
            watch.idle = idle();
          }
        };
        // a control waiting: the number of an NRPN came (none of its CCs binds), its data entry after it is told
        // once a wait
        let nrpn: 'none' | 'number' | 'told' = 'none';
        const watchNrpn = (cc: number) => {
          if (nrpn === 'told') return;
          if (isNrpnNumber(cc)) nrpn = 'number';
          else if (nrpn === 'number' && isDataEntry(cc)) {
            nrpn = 'told';
            featureUsed('midi_learn', 'cc_nrpn');
          }
        };

        // where the controller is while a knob waits for it (Pickup)
        const showPickup = (target: KnobTarget, live: Live) =>
          setMark(target.id, {
            pickup: !live.caught && live.prev !== undefined ? ccShare(live.prev) : null,
          });

        // the knob is where its CC set it, at the same share of its travel (its range may change under the same value)
        const holds = (target: KnobTarget, live: Live) =>
          live.set !== undefined &&
          target.get() === live.set &&
          knobShare(target.def(), live.set) === live.share;

        const applyKnob = (target: KnobTarget, live: Live, value: number) => {
          // the same value again while the knob holds what it set: nothing; a knob another moved since takes it again
          // (a DAW playing its automation, the snapshot of a controller)
          if (value === live.prev && holds(target, live)) return;
          const def = target.def();
          // a knob whose range changed under it since its CC set it (no change of it told it): the controller has it no
          // more
          if (live.caught && live.set !== undefined && !holds(target, live)) {
            live.caught = false;
            live.set = undefined;
          }
          if ($takeover.value === 'pickup' && !live.caught) {
            live.caught = pickupCatches(def, target.get(), live.prev, value);
            live.prev = value;
            showPickup(target, live);
            if (!live.caught) return;
          }
          live.prev = value;
          const next = knobValue(def, ccShare(value));
          if (next !== target.get()) {
            applying = target.id;
            try {
              target.set(next);
            } finally {
              applying = null;
            }
            featureUsed('input', 'cc');
          }
          live.set = target.get();
          live.share = knobShare(def, live.set);
        };

        // a switch or a choice: a CC that enters another zone of it (a switch at 64, a choice in equal zones), or the
        // same value again (a DAW playing its automation, the snapshot of a controller: it goes back where the CC has
        // it); another value of the same zone leaves what a hand chose. A switch that toggles: a press flips it (the
        // CC from under the half to over it, or the same value over it again: a pad that sends no release), a release
        // does nothing
        const applyZone = (target: Exclude<MidiTarget, KnobTarget>, live: Live, value: number) => {
          if (target.kind === 'switch' && $toggles.value.has(target.id)) {
            const press =
              switchOn(value) && (live.prev === undefined || !switchOn(live.prev) || value === live.prev);
            live.prev = value;
            live.zone = undefined;
            if (!press) return;
            target.set(!target.get());
            featureUsed('input', 'cc');
            return;
          }
          const zone = zoneOf(value, target.kind === 'switch' ? 'switch' : target.options.length);
          const again = value === live.prev;
          live.prev = value;
          if (zone === live.zone && !again) return;
          live.zone = zone;
          const now = target.kind === 'switch' ? Number(target.get()) : target.get();
          if (zone === now) return;
          if (target.kind === 'switch') target.set(zone === 1);
          else target.set(zone);
          featureUsed('input', 'cc');
        };

        // a knob the screen shows disabled: the controller moves on without it. Its CC is no more where it set the knob:
        // in Pickup the knob waits for the controller again (unless it is where the CC is: onCC), else its next CC
        // would jump it; the same value again moves it (Jump). The CC passes it from there
        const restKnob = (target: KnobTarget, live: Live, value: number) => {
          if (value === live.prev) return;
          live.prev = value;
          live.set = undefined;
          if ($takeover.value !== 'pickup') return;
          live.caught = onCC(target.def(), target.get(), value);
          showPickup(target, live);
        };

        const apply = (target: MidiTarget, live: Live, value: number) => {
          // (a control the screen shows disabled: no hand moves it)
          if (target.enabled?.() === false) {
            if (target.kind === 'knob') restKnob(target, live, value);
            return;
          }
          if (target.kind === 'knob') applyKnob(target, live, value);
          else applyZone(target, live, value);
        };

        // a control as its CC moves it: a value of its CC at most every CC_INTERVAL, the first at once, the last one
        // after the pause (the same value again too: applyKnob, applyZone)
        const liveOf = (target: MidiTarget) => {
          const found = lives.get(target.id);
          if (found) return found;
          const values = new Subject<number>();
          const live: Live = { values, throttled: Subscription.EMPTY, caught: false };
          live.throttled = values
            .pipe(throttleTime(CC_INTERVAL, clock.scheduler, { leading: true, trailing: true }))
            .subscribe((value) => apply(target, live, value));
          lives.set(target.id, live);
          return live;
        };
        const take = (target: MidiTarget, value: number) => liveOf(target).values.next(value);

        // the CC bound to the control waiting: it leaves the control it had, the control its CC before; the value
        // the CC came with is taken (Jump: the control moves to it)
        const bind = (cc: number, value: number, { target: id, via }: Learning) => {
          const target = targets.get(id);
          if (!target) return;
          const before = $bindings.value[cc];
          const bindings: Bindings = {
            ...Object.fromEntries(
              Object.entries($bindings.value).filter(([key, other]) => Number(key) !== cc && other !== id)
            ),
            [cc]: id,
          };
          $bindings.next(bindings);
          // (a switch bound by a press sets by value until its release comes)
          const toggles = togglesOf(
            [...$toggles.value].filter((other) => other !== id),
            bindings,
            isSwitch
          );
          if (!sameSet(toggles, $toggles.value)) $toggles.next(toggles);
          bound = target.kind === 'switch' && switchOn(value) ? { cc, id, at: clock.scheduler.now() } : null;
          $learning.next(null);
          featureUsed('midi_learn', via);
          tellKind();
          watch = { values: watchCC(cc, value), idle: idle() };
          const name = target.name();
          const from = before && before !== id ? targets.get(before)?.name() : undefined;
          toast.success(from ? `CC ${cc}: ${from} → ${name}` : `CC ${cc} → ${name}`);
          take(target, value);
        };

        return [
          $cc.subscribe(({ cc, value }: MidiCC) => {
            watchCCs(cc, value);
            const learning = $learning.value;
            if (learning) {
              if (isAssignable(cc)) bind(cc, value, learning);
              else watchNrpn(cc);
              return;
            }
            const target = targets.get($bindings.value[cc]);
            // the release of the button that bound a switch (its next value, a 0): it toggles from now on
            const release = bound;
            if (release?.cc === cc) bound = null;
            if (
              target &&
              release?.cc === cc &&
              release.id === target.id &&
              value === 0 &&
              clock.scheduler.now() - release.at <= TOGGLE_WINDOW
            ) {
              $toggles.next(new Set([...$toggles.value, target.id]));
              liveOf(target).prev = value;
              return;
            }
            if (target) take(target, value);
          }),
          // the CC of each control, their marks; a control that lost its CC (or took another) starts over
          $bindings.subscribe((bindings) => {
            const before = new Map(ccOf);
            ccOf.clear();
            Object.entries(bindings).forEach(([cc, id]) => ccOf.set(id, Number(cc)));
            before.forEach((cc, id) => {
              if (ccOf.get(id) === cc) return;
              forget(id);
              if (!ccOf.has(id)) setMark(id, { cc: null });
            });
            ccOf.forEach((cc, id) => setMark(id, { cc }));
          }),
          // the control waiting shows it, a toast tells to move a control
          $learning.pipe(distinctUntilChanged()).subscribe((learning) => {
            nrpn = 'none';
            if (waiting && waiting !== learning?.target) setMark(waiting, { waiting: false });
            waiting = learning?.target ?? null;
            if (learning) {
              setMark(learning.target, { waiting: true });
              toast('Move a control on your MIDI device', { id: WAIT_TOAST, duration: Infinity });
            } else toast.dismiss(WAIT_TOAST);
          }),
          // another input, or none: no control waits
          $selectedInputId.pipe(distinctUntilChanged(), skip(1)).subscribe(cancel),
          // Pickup: a knob another moved (a hand, a preset, Init) waits for the controller again, unless it is where
          // the last CC puts it (onCC); one its CC set stays caught (from Jump too: the controller has it). In Jump
          // nothing listens to the knobs
          combineLatest([$takeover, $bindings])
            .pipe(
              switchMap(([takeover, bindings]) => {
                const bound = Object.values(bindings)
                  .map((id) => targets.get(id))
                  .filter((target): target is KnobTarget => target?.kind === 'knob');
                if (takeover === 'jump') {
                  bound.forEach((target) => {
                    const live = lives.get(target.id);
                    if (live) live.caught = false;
                    setMark(target.id, { pickup: null });
                  });
                  return EMPTY;
                }
                return merge(...bound.map((target) => target.changes.pipe(map(() => target))));
              })
            )
            .subscribe((target) => {
              if (applying === target.id) return;
              const live = liveOf(target);
              const knob = target.get();
              live.caught =
                holds(target, live) || (live.prev !== undefined && onCC(target.def(), knob, live.prev));
              if (!live.caught) live.set = undefined;
              showPickup(target, live);
            }),
          // the map kept by the browser (where it keeps nothing it lives until a reload)
          combineLatest([$bindings, $takeover, $toggles])
            .pipe(
              skip(1),
              filter(() => !fromStorage)
            )
            .subscribe(([bindings, takeover, toggles]) =>
              writeStored('localStorage', MAP_KEY, storedMap(bindings, takeover, toggles))
            ),
          // the map another tab wrote: this one takes it (else its next write would put back its own)
          fromEvent<StorageEvent>(window, 'storage')
            .pipe(filter(({ key }) => key === MAP_KEY || key === null))
            .subscribe(() => {
              const map = readStored('localStorage', MAP_KEY, DEFAULT_MAP, isStoredMap);
              const bindings = bindingsOf(map.bindings, known);
              const toggles = togglesOf(map.toggles, bindings, isSwitch);
              fromStorage = true;
              try {
                if (JSON.stringify(bindings) !== JSON.stringify($bindings.value)) $bindings.next(bindings);
                if (map.takeover !== $takeover.value) $takeover.next(map.takeover);
                if (!sameSet(toggles, $toggles.value)) $toggles.next(toggles);
              } finally {
                fromStorage = false;
              }
            }),
          // (the kind of a CC not told yet is not: the page is gone)
          new Subscription(() => watch?.idle.unsubscribe()),
        ];
      }
    )
    .destroy(({ lives, $learning }) => {
      lives.forEach((live) => live.throttled.unsubscribe());
      lives.clear();
      if ($learning.value) toast.dismiss(WAIT_TOAST);
    });

export const {
  ModelProvider: MidiLearnProvider,
  useModel: useMidiLearn,
  Context: MidiLearnModelContext,
} = rxModelReact('midiLearn', midiLearn);

export type MidiLearnModule = ReturnType<typeof useMidiLearn>;
