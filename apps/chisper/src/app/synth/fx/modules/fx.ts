import { distinctUntilChanged, map, combineLatest, shareReplay } from 'rxjs';
import { isEqual, mapValues } from 'lodash';
import {
  FX_MIX_PARAMS,
  FX_PARAMS,
  FX_TYPES,
  FxType,
  fxSnapSchema,
  MOD_SOURCES,
} from '@chisper/preset-schema';
import { ArrayBS, ObjectBS, rxModel, rxModelReact } from '@chisper/rxjs-react';
import { SynthCoreModule } from '../../common/modules/synth-core';
import type { SynthModule } from '../../common/modules/synth';
import type { ModRoute, ModulationModule } from '../../common/modules/modulation';
import type { LfoModule, LfoRanges } from '../../common/modules/lfos';
import type { TransportModule } from '../../common/modules/transport';
import { fxRoute, lfoKnobRoutes, MOD_TARGETS } from '../../common/modulation/modulation-targets';
import { urlSnapshotPlugin } from '../../../app';
import {
  CHAIN_KEYS,
  ChainNote,
  ChainRoute,
  LFO_KEYS,
  LFO_TARGET,
  MIX_KEY,
  TARGET_KEYS,
} from '../../common/chain/chain-params';
import { createFxSlot, FX_REGISTRY, FxSlot, FxStatus, isFxUsable } from '../effects';
import { FxNote, FxRoute, isLfoSource, lfoKnobOf } from '../effects/fx-modulation';
import { delayTime } from '../effects/delay';

// the source VELO (MOD_SOURCES)
const VELO = MOD_SOURCES.indexOf('velo');

interface Dependencies {
  synthCore: SynthCoreModule;
  // the tempo (the delay in BPM)
  transport: TransportModule;
  // the envelopes of the last note, the LFOs and the routes the fx knobs follow
  synth: SynthModule;
  lfo: LfoModule;
  modulation: ModulationModule;
}

interface FxState {
  added: boolean; // in the chain and in the rack (left lamp)
  on: boolean; // not bypassed (rack switch)
  mix: number;
  params: Record<string, number>;
}

type FxSnap = { a: boolean; on: boolean; mix: number } & Record<string, number | boolean>;

const defaultFxState = (type: FxType): FxState => ({
  added: false,
  on: true,
  mix: FX_MIX_PARAMS[type].default,
  params: mapValues(FX_REGISTRY[type].params, (param) => param.default),
});

const defaultEffects = () =>
  Object.fromEntries(FX_TYPES.map((type) => [type, defaultFxState(type)])) as Record<FxType, FxState>;

// the bounds of the routes to the knobs of an effect at a tempo, by param: Time of the delay and Rate of the chorus
// in BPM within their divisions (the others: the ranges of their knobs)
const fxBounds = (type: FxType, params: Record<string, number>, bpm: number) =>
  FX_REGISTRY[type].bounds?.(params, bpm) ?? {};

// the routes to the knobs of an effect, in the units of its params (within `bounds`); an amount of 0 and a route
// switched off are left out
const fxRoutes = (
  routes: ModRoute[],
  type: FxType,
  bounds: Partial<Record<string, [number, number]>> = {}
): FxRoute[] =>
  routes.flatMap((route) => {
    const definition = MOD_TARGETS[route.target];
    if (definition?.kind !== 'fx' || definition.fx !== type || route.amount === 0 || route.off) return [];
    return [fxRoute(definition.param, route, definition.scale, definition.range, bounds[definition.param])];
  });

// a route as the core of the chain takes it: its knob as a target there (a param of the effect of a slot by its
// key, the mix of the slot, a knob of an LFO); none for a knob the core has not
const chainRoute = ({ param, ...route }: FxRoute, type?: FxType): ChainRoute[] => {
  const knob = lfoKnobOf(param);
  if (knob) return [{ ...route, target: LFO_TARGET + knob.lfo * LFO_KEYS + knob.knob }];
  if (!type) return [];
  const key = param === 'mix' ? MIX_KEY : CHAIN_KEYS[type].indexOf(param);
  return key < 0 ? [] : [{ ...route, target: FX_TYPES.indexOf(type) * TARGET_KEYS + key }];
};

// what the chain follows: the routes to the knobs of the effects that play (`active`: in the chain, on and ready:
// a source is computed only for an effect that sounds), in the units of their knobs at the tempo; with a route of
// an LFO those of the note to the knobs of the LFOs too (within `lfoRanges` in BPM). None: nothing is computed
export const chainRoutes = (
  routes: ModRoute[],
  effects: Record<FxType, FxState>,
  active: Record<FxType, boolean>,
  lfoRanges: LfoRanges,
  bpm: number
): ChainRoute[] => {
  const own = FX_TYPES.flatMap((type) =>
    active[type]
      ? fxRoutes(routes, type, fxBounds(type, effects[type].params, bpm)).flatMap((route) =>
          chainRoute(route, type)
        )
      : []
  );
  return own.some(({ source }) => isLfoSource(source))
    ? [...own, ...lfoKnobRoutes(routes, lfoRanges).flatMap((route) => chainRoute(route))]
    : own;
};

// the note the chain follows, without its velocity unless a route reads VELO: a note of a legato phrase at another
// velocity changes nothing for the others
export const chainNote = (note: FxNote | null, routes: ChainRoute[]): ChainNote | null => {
  if (!note) return null;
  const { envelopes, start, release, from, velo } = note;
  return {
    envelopes,
    start,
    release,
    ...(from && { from }),
    ...(routes.some(({ source }) => source === VELO) && velo !== undefined && { velo }),
  };
};

// the added effects in the chain order; an unavailable one (unsupported or failed) stays added in the state,
// so a preset keeps it, but is left out of the chain
export const getChain = (
  order: FxType[],
  effects: Record<FxType, FxState>,
  status: Record<FxType, FxStatus>
) => order.filter((type) => effects[type].added && isFxUsable(status[type]));

export const fx = ({
  synthCore: [{ audioCtx, chain }],
  synth: [{ $fxNote }],
  transport: [{ $tempo }],
  lfo: [{ $state: $lfoState, $changes: $lfoChanges, $ranges: $lfoRanges }],
  modulation: [{ $routes }],
}: Dependencies) =>
  rxModel(() => {
    const $order = new ArrayBS<FxType[]>([...FX_TYPES]);
    const $effects = new ObjectBS<Record<FxType, FxState>>(defaultEffects());
    // the slot of each effect in the chain of the synth core (one node for all of them)
    const slots = Object.fromEntries(
      FX_TYPES.map((type, index) => [
        type,
        createFxSlot(chain, index, FX_REGISTRY[type], audioCtx.sampleRate),
      ])
    ) as Record<FxType, FxSlot>;
    // mirrors the slot statuses (see the subscriptions)
    const $status = new ObjectBS<Record<FxType, FxStatus>>(
      mapValues(slots, (slot) => slot.$status.value) as Record<FxType, FxStatus>
    );
    const $chain = combineLatest([$order, $effects, $status]).pipe(
      map(([order, effects, status]) => getChain(order, effects, status)),
      distinctUntilChanged<FxType[]>(isEqual),
      shareReplay({ bufferSize: 1, refCount: true })
    );
    // seconds between two echoes of the delay at most while it sounds (in the chain, on and ready: Time, in BPM
    // its division at the tempo, the top of the bounds of its routes, and its pan), 0 without it: the meters of the
    // output don't sleep between them
    const $echoGap = combineLatest([$effects, $status, $tempo, $routes]).pipe(
      map(([effects, status, bpm, routes]) => {
        const { added, on, params } = effects.delay;
        if (!added || !on || status.delay !== 'ready') return 0;
        const routed = fxRoutes(routes, 'delay', fxBounds('delay', params, bpm)).find(
          ({ param }) => param === 'time'
        );
        return Math.max(delayTime(params, bpm), routed?.max ?? 0) + FX_PARAMS.delay.pan.max;
      }),
      distinctUntilChanged(),
      shareReplay({ bufferSize: 1, refCount: true })
    );
    return { $order, $effects, $status, $chain, $echoGap, slots };
  })
    .actions(({ $order, $effects, $status, slots }) => {
      const update = (type: FxType, value: Partial<FxState>) =>
        $effects.next({ ...$effects.value, [type]: { ...$effects.value[type], ...value } });
      return {
        // an unsupported effect can't be added, a failed one loads again and is added (in the chain while it
        // loads, left out again if it fails); removing works whatever the status
        setAdded: (type: FxType, added: boolean) => {
          if (added && $status.value[type] === 'unsupported') return;
          if (added && $status.value[type] === 'failed') slots[type].retry();
          update(type, { added });
        },
        // loads a failed effect again, added or not (nothing to do in any other status)
        retry: (type: FxType) => slots[type].retry(),
        setOn: (type: FxType, on: boolean) => update(type, { on }),
        setMix: (type: FxType, mix: number) => update(type, { mix }),
        // a change of the user: with the params it sets at the tempo (the delay in BPM: paramChange)
        setParam: (type: FxType, key: string, value: number) => {
          const { params } = $effects.value[type];
          const change = FX_REGISTRY[type].paramChange?.(params, key, value, $tempo.value) ?? {
            [key]: value,
          };
          update(type, { params: { ...params, ...change } });
        },
        // unknown id: nothing changes
        applyPreset: (type: FxType, id: string) => {
          const preset = FX_REGISTRY[type].presets.find((item) => item.id === id);
          if (preset) update(type, { mix: preset.mix, params: { ...preset.params } });
        },
        move: (from: number, to: number) => {
          const order = [...$order.value];
          const [type] = order.splice(from, 1);
          order.splice(to, 0, type);
          $order.next(order);
        },
        // every effect forgets its tail at once, in the chain or not, and the limiter the sound before (a preset
        // switch: the output is muted, a tail would play on with the params of the next preset)
        clear: () => chain.clear(),
      };
    })
    .subscriptions(({ $effects, $status, $chain, slots }) => {
      // the LFOs as they are (the chain takes them once a route reads one), then every state
      const lfoState = $lfoState.value;
      if (lfoState) chain.setLfos({ ...lfoState, instantly: true });
      // the effects that play: in the chain, on and ready
      const $active = combineLatest([$effects, $status]).pipe(
        map(
          ([effects, status]) =>
            mapValues(
              effects,
              ({ added, on }, type) => added && on && status[type as FxType] === 'ready'
            ) as Record<FxType, boolean>
        ),
        distinctUntilChanged<Record<FxType, boolean>>(isEqual)
      );
      // the knobs follow the envelopes and the LFOs of the last note: the routes of the effects that play
      const $chainRoutes = combineLatest([$routes, $effects, $active, $lfoRanges, $tempo]).pipe(
        map(([routes, effects, active, ranges, bpm]) => chainRoutes(routes, effects, active, ranges, bpm)),
        distinctUntilChanged<ChainRoute[]>(isEqual),
        shareReplay({ bufferSize: 1, refCount: true })
      );
      return [
        // the tempo of the synth: an effect in BPM follows it
        $tempo.subscribe((bpm) => FX_TYPES.forEach((type) => slots[type].setTempo(bpm))),
        $lfoChanges.subscribe((state) => chain.setLfos(state)),
        $chainRoutes.subscribe((routes) => chain.setRoutes(routes)),
        combineLatest([$fxNote, $chainRoutes])
          .pipe(
            map(([note, routes]) => chainNote(note, routes)),
            distinctUntilChanged<ChainNote | null>(isEqual)
          )
          .subscribe((note) => chain.setNote(note)),
        ...FX_TYPES.map((type) =>
          slots[type].$status.subscribe((status) => {
            if ($status.value[type] !== status) $status.next({ ...$status.value, [type]: status });
          })
        ),
        // the added effects in their order
        $chain.subscribe((types) => chain.setOrder(types.map((type) => FX_TYPES.indexOf(type)))),
        // update() replaces only the changed effect's object, so the other slots are not touched, and only the
        // changed values reach the core (a knob drag sets one param per tick). An effect that is not ready
        // (loading, failed, unsupported) has no wet signal: its slot passes its input like a bypassed one
        ...FX_TYPES.map((type) =>
          combineLatest([
            $effects.pipe(
              map((effects) => effects[type]),
              distinctUntilChanged()
            ),
            $status.pipe(
              map((status) => status[type] === 'ready'),
              distinctUntilChanged()
            ),
          ]).subscribe(([{ added, mix, on, params }, ready]) => {
            slots[type].setParams(params);
            slots[type].setMix(mix);
            slots[type].setActive(added && on && ready);
          })
        ),
      ];
    })
    .plugins(
      urlSnapshotPlugin({
        modelToSnap: ({ $order, $effects }) => ({
          o: $order.value,
          ...mapValues($effects.value, ({ added, on, mix, params }): FxSnap => ({
            a: added,
            on,
            mix,
            ...params,
          })),
        }),
        applySnap: (snap, { $order, $effects }) => {
          const { o, ...effects } = fxSnapSchema.parse(snap);
          $order.next(o);
          $effects.next(
            mapValues(effects, ({ a, on, mix, ...params }): FxState => ({ added: a, on, mix, params }))
          );
        },
      })
    )
    .destroy(({ slots }) => FX_TYPES.forEach((type) => slots[type].destroy()));

export const { ModelProvider: FxProvider, useModel: useFx, Context: FxContext } = rxModelReact('fx', fx);

export type FxModule = ReturnType<typeof useFx>;
