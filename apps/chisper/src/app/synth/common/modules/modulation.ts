import { Subject } from 'rxjs';
import { ArrayBS, rxModel, rxModelReact } from '@chisper/rxjs-react';
import {
  cutName,
  isLfo,
  isLfoKnob,
  MACRO_KEYS,
  MACRO_NAME_KEYS,
  MACRO_NAME_MAX_LENGTH,
  MacroId,
  MACROS,
  MOD_KNOB_SOURCES_MAX,
  MOD_ROUTES_MAX,
  MOD_SOURCES,
  ModSource,
  ModValue,
} from '@chisper/preset-schema';
import { urlSnapshotPlugin } from '../../../app';
import { featureUsed } from '../../../common/services/analytics';
import { bipolarByDefault, isModTarget } from '../modulation/modulation-targets';

// a source (ENV 1–3, VELO, LFO 1–4, MACRO 1–4) moves a knob (a target of modulation-targets.ts) by amount × its level: amount
// is a share of the range of the knob in its scale, -1..1; a bipolar route moves it around its value, amount ×
// (level - ½); one switched off (the menu of the knob) is kept with its amount and moves nothing
export interface ModRoute {
  source: ModSource;
  target: string;
  amount: number;
  bipolar?: boolean;
  off?: boolean;
}

// a route of `source` reads it (its dot shows the note): not one switched off (it still counts in the limits)
export const readsSource = (routes: ModRoute[], source: ModSource) =>
  routes.some((route) => route.source === source && !route.off);

// a route dropped on a knob: half its range, audible at once
export const DEFAULT_AMOUNT = 0.5;

// no route can be added (MOD_ROUTES_MAX): the knobs take no tab
export const routesFull = (routes: ModRoute[]) => routes.length >= MOD_ROUTES_MAX;
// the knob takes no other source (MOD_KNOB_SOURCES_MAX)
export const knobFull = (routes: ModRoute[], target: string) =>
  routes.filter((route) => route.target === target).length >= MOD_KNOB_SOURCES_MAX;
// a source can move the knob: a knob of the app, no LFO on a knob of an LFO
export const takesSource = (source: ModSource, target: string) =>
  isModTarget(target) && !(isLfo(source) && isLfoKnob(target));
// the first routes within the limits: of all of them and of each knob
const withinLimits = (routes: ModRoute[]) =>
  routes.reduce<ModRoute[]>(
    (kept, route) => (routesFull(kept) || knobFull(kept, route.target) ? kept : [...kept, route]),
    []
  );

// the step of the knob of a macro (a knob rounds to 1 / precision)
export const MACRO_PRECISION = 100;

const clampAmount = (amount: number) => Math.min(1, Math.max(-1, amount));
const clampLevel = (level: number) => Math.min(1, Math.max(0, level));

// who moved a macro: a hand on its knob, a CC of a MIDI input (MIDI Learn), the automation of the track (a recording
// takes what a player did, not what the track plays itself). 'track' and the time `at` wait for the automation of
// the track (MACRO_CC of the schema)
export type MacroSource = 'hand' | 'midi' | 'track';
// the levels of the macros the engine is told (null: that macro as it is) from `at` (seconds of the context; none:
// the next block), and who moved them (none: a preset)
export interface MacroMove {
  levels: (number | null)[];
  at?: number;
  source?: MacroSource;
}
// a level of the snapshot: within 0..1, anything else 0 (a missing key too)
const levelOf = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? clampLevel(value) : 0;
// a name of the snapshot: trimmed, whitespace collapsed, within its length; anything else none (a missing key too)
const nameOf = (value: unknown) => (typeof value === 'string' ? cutName(value, MACRO_NAME_MAX_LENGTH) : '');
const routeKey = ({ source, target }: Pick<ModRoute, 'source' | 'target'>) => `${source}:${target}`;
const isSource = (value: string): value is ModSource => (MOD_SOURCES as readonly string[]).includes(value);
// a route of the snapshot: a uni one is its amount, a bipolar one { a, bi: true }, one switched off has off: true
const routeValue = ({ amount, bipolar, off }: ModRoute): ModValue =>
  bipolar || off ? { a: amount, ...(bipolar && { bi: true }), ...(off && { off: true }) } : amount;
const fromValue = (value: unknown): Pick<ModRoute, 'amount' | 'bipolar' | 'off'> | null => {
  if (typeof value === 'number') return { amount: clampAmount(value) };
  if (typeof value !== 'object' || value === null) return null;
  const { a, bi, off } = value as { a?: unknown; bi?: unknown; off?: unknown };
  if (typeof a !== 'number') return null;
  return {
    amount: clampAmount(a),
    ...(bi === true && { bipolar: true }),
    ...(off === true && { off: true }),
  };
};

// the routes of the modulation, one per source and knob; saved as { 'env2:osc1.wave': 0.5 }, a bipolar one as
// { 'lfo1:filter.gain': { a: 0.5, bi: true } }, one switched off as { a: 0.5, off: true } (snapshot mod). The levels
// of the macros MACRO 1–4 (0..1, in the order of MACROS), saved as { m1: 0.5 } without the levels of 0 (snapshot
// mac); every move of them goes to the engine with its time ($macroMoves: the synth tells the node, the routes stay).
// The names of the macros as typed (in the order of MACROS, none: ''), saved as { n1: 'Bright' } only of a macro
// that has routes (one that lost its last keeps its name in the tab, a route added again shows it)
export const modulation = () =>
  rxModel(() => {
    const $routes = new ArrayBS<ModRoute[]>([]);
    const $macros = new ArrayBS<number[]>(MACROS.map(() => 0));
    const $macroNames = new ArrayBS<string[]>(MACROS.map(() => ''));
    const $macroMoves = new Subject<MacroMove>();
    return { $routes, $macros, $macroNames, $macroMoves };
  })
    .actions(({ $routes, $macros, $macroNames, $macroMoves }) => {
      const find = (source: ModSource, target: string) =>
        $routes.value.find((route) => route.source === source && route.target === target);
      const update = (source: ModSource, target: string, change: (route: ModRoute) => ModRoute) =>
        $routes.next(
          $routes.value.map((route) =>
            route.source === source && route.target === target ? change(route) : route
          )
        );
      // a flag of a route: set, or left out of it
      const setFlag = (flag: 'bipolar' | 'off') => (source: ModSource, target: string, value: boolean) => {
        const route = find(source, target);
        if (!route || !!route[flag] === value) return;
        update(source, target, ({ [flag]: _, ...rest }) => (value ? { ...rest, [flag]: value } : rest));
      };
      return {
        // a source already on the knob keeps its amount, none is added past the limits; an LFO and a macro bipolar
        // by default on a knob centered on 0 (around its value), an envelope and VELO uni (up from it: at rest the
        // knob is its value)
        addRoute: (
          source: ModSource,
          target: string,
          amount = DEFAULT_AMOUNT,
          bipolar = bipolarByDefault(source, target)
        ) => {
          if (find(source, target) || !takesSource(source, target)) return;
          if (routesFull($routes.value) || knobFull($routes.value, target)) return;
          const route: ModRoute = { source, target, amount: clampAmount(amount) };
          featureUsed('route', source);
          $routes.next([...$routes.value, bipolar ? { ...route, bipolar } : route]);
        },
        setAmount: (source: ModSource, target: string, amount: number) => {
          if (!find(source, target)) return;
          update(source, target, (route) => ({ ...route, amount: clampAmount(amount) }));
        },
        // uni (up from the knob) or bipolar (around it)
        setPolarity: setFlag('bipolar'),
        // switched off a route keeps its amount and polarity, moving nothing
        setOff: setFlag('off'),
        removeRoute: (source: ModSource, target: string) =>
          $routes.next($routes.value.filter((route) => route.source !== source || route.target !== target)),
        // every route of a knob at once
        removeRoutes: (target: string) => {
          if (!$routes.value.some((route) => route.target === target)) return;
          $routes.next($routes.value.filter((route) => route.target !== target));
        },
        // the level of a macro (within 0..1; not a number: nothing) from `at` on (seconds of the context; none: the
        // next block), moved by `source` (the knob of the macro: a hand). The engine glides to it, the routes stay
        setMacro: (id: MacroId, level: number, at?: number, source: MacroSource = 'hand') => {
          const index = MACROS.indexOf(id);
          if (index < 0 || !Number.isFinite(level)) return;
          const value = clampLevel(level);
          if (source === 'hand') featureUsed('macro', id);
          if ($macros.value[index] !== value)
            $macros.next($macros.value.map((other, k) => (k === index ? value : other)));
          $macroMoves.next({ levels: MACROS.map((_, k) => (k === index ? value : null)), at, source });
        },
        // the name of a macro as typed (its field under it; the snapshot keeps it trimmed)
        setMacroName: (id: MacroId, name: string) => {
          const index = MACROS.indexOf(id);
          if (index < 0 || $macroNames.value[index] === name) return;
          featureUsed('macro_name', id);
          $macroNames.next($macroNames.value.map((other, k) => (k === index ? name : other)));
        },
      };
    })
    .plugins([
      urlSnapshotPlugin({
        modelToSnap: ({ $routes }) =>
          Object.fromEntries($routes.value.map((route) => [routeKey(route), routeValue(route)])) as Record<
            string,
            ModValue
          >,
        // a missing key is no route; an unknown source or knob (a newer preset), an LFO on a knob of an LFO and a
        // value that is neither an amount nor an object with one are left out, the routes past the limits too (an
        // edited url: the state stays one a preset can save)
        applySnap: (snap, { $routes }) =>
          $routes.next(
            withinLimits(
              Object.entries(snap).flatMap(([key, value]): ModRoute[] => {
                const [source, target] = key.split(':');
                const route = fromValue(value);
                if (!route || !isSource(source) || !target || !takesSource(source, target)) return [];
                return [{ source, target, ...route }];
              })
            )
          ),
      }),
      // mac: { m1: 0.5, n1: 'Bright' }, a level of 0 left out (the presets without macros keep their hashes), a name
      // only of a macro with routes and not empty; a missing key is 0, no name
      urlSnapshotPlugin({
        prefix: 'mac',
        modelToSnap: ({ $macros, $macroNames, $routes }) =>
          Object.fromEntries(
            MACROS.flatMap((id, k) => {
              const level = $macros.value[k];
              // (cut as the schema takes it: a name longer would make the whole state one no preset can save)
              const name = cutName($macroNames.value[k], MACRO_NAME_MAX_LENGTH);
              const routed = $routes.value.some((route) => route.source === id);
              return [
                ...(level !== 0 ? [[MACRO_KEYS[id], level]] : []),
                ...(name && routed ? [[MACRO_NAME_KEYS[id], name]] : []),
              ];
            })
          ) as Record<string, number | string>,
        applySnap: (snap, { $macros, $macroNames, $macroMoves }) => {
          const levels = MACROS.map((id) => levelOf(snap[MACRO_KEYS[id]]));
          $macros.next(levels);
          $macroNames.next(MACROS.map((id) => nameOf(snap[MACRO_NAME_KEYS[id]])));
          $macroMoves.next({ levels: [...levels] });
        },
      }),
    ]);

export const {
  ModelProvider: ModulationProvider,
  useModel: useModulation,
  Context: ModulationContext,
} = rxModelReact('mod', modulation);

export type ModulationModule = ReturnType<typeof useModulation>;
