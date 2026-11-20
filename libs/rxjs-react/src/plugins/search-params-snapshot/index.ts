import {
  merge,
  skip,
  Subject,
  Subscription,
  BehaviorSubject,
  map,
  distinctUntilChanged,
  Observable,
} from 'rxjs';
import { Plugin } from '../../types';
import { isSnapshotable } from '../snapshot';

// values are JSON: in the url every model key is a separate search param with a JSON value
type SnapValue = string | number | boolean | null | SnapValue[] | { [key: string]: SnapValue };
type Snap = Record<string, SnapValue>;

interface PluginConfig<M, S> {
  modelToSnap: (model: M) => S;
  applySnap: (snap: Partial<S>, model: M) => void;
  prefix?: string;
}

type ModelForSnap<M, S> = {
  model: Record<string | number, M>;
  modelToSnap: (model: M) => S;
  applySnap: (snap: Partial<S>, model: M) => void;
  subscription: Subscription;
};

const searchToSnapshots = () => {
  const initialSnap = new URLSearchParams(window.location.search);
  const obj: Record<string, Snap> = {};
  initialSnap.forEach((value, key) => {
    const [k, v] = key.split('-');
    if (!k || !v) return;
    try {
      obj[k] = {
        ...obj[k],
        [v]: JSON.parse(value),
      };
    } catch {
      console.error(`can't parse search param ${key}`);
    }
  });
  return obj;
};

const isSnapshotableBS = (value: unknown): value is BehaviorSubject<unknown> =>
  value instanceof BehaviorSubject && isSnapshotable(value);

// the models of a snapshot by their names, and the names of those whose persisted state changed
const createRegistry = () => {
  const modelForSnap = new Map<string, ModelForSnap<any, any>>();
  const $changes = new Subject<string>();
  return {
    modelForSnap,
    $changes,
    getSnapshot: () => {
      const result: Record<string, Snap> = {};
      for (const [name, { model, modelToSnap }] of modelForSnap) result[name] = modelToSnap(model);
      return result;
    },
    // (a model missing from it takes its defaults)
    applySnapshot: (snapshot: Record<string, Snap>) => {
      for (const [name, { model, applySnap }] of modelForSnap) applySnap(snapshot[name] ?? {}, model);
    },
  };
};
type Registry = ReturnType<typeof createRegistry>;

export interface SnapshotScope {
  getSnapshot: () => Record<string, Snap>;
  applySnapshot: (snapshot: Record<string, Snap>) => void;
  $changes: Observable<string>;
}

const scopeOf = ({ getSnapshot, applySnapshot, $changes }: Registry): SnapshotScope => ({
  getSnapshot,
  applySnapshot,
  $changes: $changes.asObservable(),
});

// The snapshot of the models of the page: each under its name (or prefix), the one of the url applied as it inits.
// `scope()` is a snapshot of its own: the models inited in it (init's scope) register there, never in the one of the
// page, and read no url (a copy of the models under the same names leaves those of the page as they are)
export const searchParamsSnapshotPlugin = () => {
  const page = createRegistry();
  const snapshots = searchToSnapshots();
  const scopes = new WeakMap<object, Registry>();
  // (a scope of none of ours: the model is in no snapshot)
  const registryOf = (scope: object | undefined) => (scope === undefined ? page : scopes.get(scope));

  return {
    ...scopeOf(page),
    scope: (): SnapshotScope => {
      const registry = createRegistry();
      const scope = scopeOf(registry);
      scopes.set(scope, registry);
      return scope;
    },
    plugin: <M extends Record<string | number, unknown>, S extends Snap>({
      modelToSnap,
      applySnap,
      prefix,
    }: PluginConfig<M, S>): Plugin<M> => {
      return {
        onInit: (model, { name, scope }) => {
          const registry = registryOf(scope);
          if (!registry) return;
          const snapName = prefix ?? name;
          // emits only when the persisted state changes, not on every snapshotable subject
          const subscription = merge(...Object.values(model).filter(isSnapshotableBS))
            .pipe(
              map(() => JSON.stringify(modelToSnap(model))),
              distinctUntilChanged(),
              skip(1)
            )
            .subscribe(() => registry.$changes.next(snapName));
          registry.modelForSnap.set(snapName, { model, modelToSnap, applySnap, subscription });
          const value = registry === page ? (snapshots[snapName] as S) : undefined;
          if (!value) return;
          applySnap(value, model);
        },
        onStop: (model, { name, scope }) => {
          const registry = registryOf(scope);
          const snapName = prefix ?? name;
          const entry = registry?.modelForSnap.get(snapName);
          if (!registry || entry?.model !== model) return;
          entry.subscription.unsubscribe();
          registry.modelForSnap.delete(snapName);
        },
      };
    },
  };
};
