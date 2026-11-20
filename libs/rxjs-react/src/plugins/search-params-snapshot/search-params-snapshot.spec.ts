import { rxModel } from '../../services';
import { PrimitiveBS } from '../../observables';
import { searchParamsSnapshotPlugin } from './';

const createModel = (plugin: ReturnType<typeof searchParamsSnapshotPlugin>['plugin']) =>
  rxModel(() => ({ $value: new PrimitiveBS<number>(1), $flag: new PrimitiveBS<boolean>(true) })).plugins(
    plugin({
      modelToSnap: ({ $value, $flag }) => ({ v: $value.value, f: $flag.value }),
      applySnap: (snap, { $value, $flag }) => {
        snap.v !== undefined && $value.next(snap.v);
        snap.f !== undefined && $flag.next(snap.f);
      },
    })
  );

describe('searchParamsSnapshotPlugin', () => {
  it('returns and applies snapshot at runtime', () => {
    const { plugin, getSnapshot, applySnapshot } = searchParamsSnapshotPlugin();
    const [model] = createModel(plugin).init('model', undefined);
    expect(getSnapshot()).toEqual({ model: { v: 1, f: true } });
    applySnapshot({ model: { v: 0, f: false } });
    expect(model.$value.value).toBe(0);
    expect(model.$flag.value).toBe(false);
    expect(getSnapshot()).toEqual({ model: { v: 0, f: false } });
  });

  it('emits changes only after init and stops after model stop', () => {
    const { plugin, $changes, getSnapshot } = searchParamsSnapshotPlugin();
    const changes: string[] = [];
    $changes.subscribe((name) => changes.push(name));
    const [model, , { stop }] = createModel(plugin).init('model', undefined);
    expect(changes).toEqual([]);
    model.$value.next(5);
    expect(changes).toEqual(['model']);
    stop();
    model.$value.next(6);
    expect(changes).toEqual(['model']);
    expect(getSnapshot()).toEqual({});
  });

  describe('scope', () => {
    afterEach(() => window.history.replaceState(null, '', '/'));

    it('keeps the models inited in it apart from those of the page, under the same names', () => {
      const { plugin, getSnapshot, applySnapshot, scope } = searchParamsSnapshotPlugin();
      const own = scope();
      const [page] = createModel(plugin).init('model', undefined);
      const [copy, , { stop }] = createModel(plugin).init('model', undefined, own);
      own.applySnapshot({ model: { v: 7, f: false } });
      expect(copy.$value.value).toBe(7);
      expect(page.$value.value).toBe(1);
      expect(own.getSnapshot()).toEqual({ model: { v: 7, f: false } });
      expect(getSnapshot()).toEqual({ model: { v: 1, f: true } });
      applySnapshot({ model: { v: 3 } });
      expect(copy.$value.value).toBe(7);
      stop();
      expect(own.getSnapshot()).toEqual({});
      expect(getSnapshot()).toEqual({ model: { v: 3, f: true } });
    });

    it('reads no url and tells its own changes', () => {
      window.history.replaceState(null, '', '/?model-v=9');
      const { plugin, $changes, scope } = searchParamsSnapshotPlugin();
      const own = scope();
      const [page] = createModel(plugin).init('model', undefined);
      const pageChanges: string[] = [];
      const ownChanges: string[] = [];
      $changes.subscribe((name) => pageChanges.push(name));
      own.$changes.subscribe((name) => ownChanges.push(name));
      const [copy] = createModel(plugin).init('model', undefined, own);
      expect(page.$value.value).toBe(9);
      expect(copy.$value.value).toBe(1);
      copy.$value.next(2);
      expect(ownChanges).toEqual(['model']);
      expect(pageChanges).toEqual([]);
    });

    it('registers a model of a scope it did not make nowhere', () => {
      const { plugin, getSnapshot } = searchParamsSnapshotPlugin();
      const other = searchParamsSnapshotPlugin().scope();
      const [, , { stop }] = createModel(plugin).init('model', undefined, other);
      expect(getSnapshot()).toEqual({});
      expect(other.getSnapshot()).toEqual({});
      stop();
    });
  });
});
