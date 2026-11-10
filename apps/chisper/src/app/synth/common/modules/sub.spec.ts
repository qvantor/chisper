import { applySnapshot, getSnapshot } from '../../../app';
import { createSub, createSynthCore, stopModels } from '../../../../test-utils/models';
import { subShapeFrame } from '../wavetable/sub-shapes';

// a sub on a synth core whose wavetable oscillator records the tables sent to it
const createSpied = () => {
  const synthCore = createSynthCore();
  const { wavetables } = synthCore[0];
  const setTable = jest.spyOn(wavetables, 'setTable');
  const removeTable = jest.spyOn(wavetables, 'removeTable');
  const [model, actions] = createSub(synthCore);
  return { model, actions, setTable, removeTable, wavetables };
};

describe('sub', () => {
  afterEach(() => stopModels());

  it('starts off: a sine at the note from its phase 0, not contiguous, at 75% in the centre', () => {
    const [model] = createSub();
    expect(model.$active.value).toBe(false);
    expect(model.$sub.value).toEqual({
      shape: 'sine',
      octave: 0,
      coarse: 0,
      phase: 0,
      contiguous: false,
      pan: 0,
      level: 0.75,
    });
    expect(model.ranges).toEqual({
      octave: [-4, 4],
      coarse: [-64, 64],
      phase: [0, 1],
      pan: [-1, 1],
      level: [0, 1],
    });
    expect(model.voiceSub()).toBeNull();
  });

  describe('its shapes', () => {
    it('sends the table of a shape the first time it is on, once; the sine needs none', () => {
      const { actions, setTable } = createSpied();
      actions.setShape('saw');
      expect(setTable).not.toHaveBeenCalled();
      actions.toggleActive();
      expect(setTable.mock.calls).toEqual([['sub:saw', [subShapeFrame('saw')]]]);
      actions.setShape('sine');
      actions.setShape('pulse');
      actions.setShape('saw');
      actions.toggleActive();
      actions.toggleActive();
      actions.setShape('round-rect');
      expect(setTable.mock.calls.map(([table]) => table)).toEqual(['sub:saw', 'sub:pulse', 'sub:round-rect']);
    });

    it('plays its shape once its table is answered (the sine at once), and removes its tables with the model', () => {
      const { model, actions, wavetables, removeTable } = createSpied();
      expect(model.shapePlayed()).toBe(true);
      actions.setShape('square');
      // (off: not sent yet)
      expect(model.shapePlayed()).toBe(false);
      actions.toggleActive();
      wavetables.$tables.next({ 'sub:square': 'sending' });
      expect(model.shapePlayed()).toBe(false);
      wavetables.$tables.next({ 'sub:square': 'stored' });
      expect(model.shapePlayed()).toBe(true);
      // refused: no waiting for it (the sub is silent)
      wavetables.$tables.next({ 'sub:square': 'refused' });
      expect(model.shapePlayed()).toBe(true);
      actions.setShape('triangle');
      stopModels();
      expect(removeTable.mock.calls).toEqual([['sub:square'], ['sub:triangle']]);
    });

    it('tells where the table of its shape is (none for the sine or one not sent)', () => {
      const { model, actions, wavetables } = createSpied();
      const seen: unknown[] = [];
      model.$shapeState.subscribe((state) => seen.push(state));
      actions.setShape('saw');
      actions.toggleActive();
      wavetables.$tables.next({ 'sub:saw': 'sending' });
      wavetables.$tables.next({ 'sub:saw': 'stored' });
      wavetables.$tables.next({ 'sub:saw': 'refused' });
      wavetables.$tables.next({ 'sub:saw': 'failed' });
      actions.setShape('sine');
      // (the same state: not told again)
      actions.setSubValue('level', 0.5);
      expect(seen).toEqual([null, 'sending', 'stored', 'refused', 'failed', null]);
    });

    it('gives notes no sub while the table of its shape is refused or failed, still not waited for', () => {
      const { model, actions, wavetables } = createSpied();
      actions.setShape('saw');
      actions.toggleActive();
      expect(model.voiceSub()).toMatchObject({ table: 'sub:saw' });
      (['refused', 'failed'] as const).forEach((state) => {
        wavetables.$tables.next({ 'sub:saw': state });
        expect(model.voiceSub()).toBeNull();
        expect(model.shapePlayed()).toBe(true);
      });
      wavetables.$tables.next({ 'sub:saw': 'stored' });
      expect(model.voiceSub()).toMatchObject({ table: 'sub:saw' });
      // (another shape: its own state)
      wavetables.$tables.next({ 'sub:saw': 'failed' });
      actions.setShape('sine');
      expect(model.voiceSub()).toMatchObject({ table: null });
    });

    it('sends the table of its shape again on Retry (nothing for the sine)', () => {
      const { actions, wavetables } = createSpied();
      const retryTable = jest.spyOn(wavetables, 'retryTable');
      actions.retryShape();
      expect(retryTable).not.toHaveBeenCalled();
      actions.setShape('pulse');
      actions.retryShape();
      expect(retryTable.mock.calls).toEqual([['sub:pulse']]);
    });

    it('sends a refused or failed table again when its shape is chosen or switched on again, or a preset applied', () => {
      const { actions, wavetables, setTable } = createSpied();
      const retryTable = jest.spyOn(wavetables, 'retryTable');
      actions.setShape('saw');
      actions.toggleActive();
      expect(retryTable).not.toHaveBeenCalled();
      wavetables.$tables.next({ 'sub:saw': 'failed' });
      actions.setShape('square');
      actions.setShape('saw');
      expect(retryTable.mock.calls).toEqual([['sub:saw']]);
      actions.toggleActive();
      actions.toggleActive();
      applySnapshot({ sub: { a: true, sh: 'saw' } });
      expect(retryTable.mock.calls).toEqual([['sub:saw'], ['sub:saw'], ['sub:saw']]);
      // (the table built once)
      expect(setTable.mock.calls.map(([table]) => table)).toEqual(['sub:saw', 'sub:square']);
    });
  });

  describe('the sub of a note', () => {
    it('is its table, its phase, Contiguous and its knobs, the pitch in cents (1200 · Octave + 100 · Coarse)', () => {
      const [model, actions] = createSub();
      actions.toggleActive();
      expect(model.voiceSub()).toEqual({
        table: null,
        phase: 0,
        contiguous: false,
        level: 0.75,
        pan: 0,
        cents: 0,
      });
      actions.setShape('triangle');
      actions.setSubValue('octave', -2);
      actions.setSubValue('coarse', 3.5);
      actions.setSubValue('phase', 0.25);
      actions.setContiguous(true);
      actions.setSubValue('pan', -0.4);
      actions.setSubValue('level', 0.5);
      expect(model.voiceSub()).toEqual({
        table: 'sub:triangle',
        phase: 0.25,
        contiguous: true,
        level: 0.5,
        pan: -0.4,
        cents: -2050,
      });
      expect(model.$params.value).toEqual({ level: 0.5, pan: -0.4, cents: -2050 });
    });

    it('changes what playing notes follow only on a change of the level, the pan or the pitch', () => {
      const [model, actions] = createSub();
      const seen: unknown[] = [];
      model.$params.subscribe((params) => seen.push(params));
      actions.setShape('saw');
      actions.setSubValue('phase', 0.5);
      actions.setContiguous(true);
      actions.setSubValue('octave', 1);
      expect(seen).toEqual([
        { level: 0.75, pan: 0, cents: 0 },
        { level: 0.75, pan: 0, cents: 1200 },
      ]);
      // (the same cents: an octave less, 12 semitones more)
      actions.setSubValue('octave', 0);
      actions.setSubValue('coarse', 12);
      expect(seen.at(-1)).toEqual({ level: 0.75, pan: 0, cents: 1200 });
      expect(seen).toHaveLength(4);
      actions.setSubValue('level', 0);
      expect(seen.at(-1)).toEqual({ level: 0, pan: 0, cents: 1200 });
    });
  });

  describe('snapshot', () => {
    it('exposes the persisted state', () => {
      const [, actions] = createSub();
      actions.toggleActive();
      actions.setShape('pulse');
      actions.setSubValue('octave', -3);
      actions.setSubValue('coarse', 7.25);
      actions.setSubValue('phase', 0.5);
      actions.setContiguous(true);
      actions.setSubValue('pan', 0.5);
      actions.setSubValue('level', 0.6);
      expect(getSnapshot()['sub']).toEqual({
        a: true,
        sh: 'pulse',
        o: -3,
        c: 7.25,
        ph: 0.5,
        ct: true,
        pn: 0.5,
        g: 0.6,
      });
    });

    it('applies falsy values', () => {
      const [model, actions] = createSub();
      actions.toggleActive();
      actions.setContiguous(true);
      actions.setSubValue('octave', 2);
      actions.setSubValue('phase', 0.5);
      applySnapshot({ sub: { a: false, sh: 'sine', o: 0, c: 0, ph: 0, ct: false, pn: 0, g: 0 } });
      expect(model.$active.value).toBe(false);
      expect(model.$sub.value).toEqual({
        shape: 'sine',
        octave: 0,
        coarse: 0,
        phase: 0,
        contiguous: false,
        pan: 0,
        level: 0,
      });
    });

    it('restores the defaults for missing keys, the sub off', () => {
      const [model, actions] = createSub();
      actions.toggleActive();
      actions.setShape('saw');
      actions.setSubValue('level', 1);
      actions.setContiguous(true);
      applySnapshot({});
      expect(model.$active.value).toBe(false);
      expect(model.$sub.value).toMatchObject({ shape: 'sine', level: 0.75, contiguous: false });
    });

    it('sends the table of the shape it applies on, only that one', () => {
      const { setTable } = createSpied();
      applySnapshot({ sub: { a: true, sh: 'square' } });
      applySnapshot({ sub: { a: false, sh: 'saw' } });
      applySnapshot({ sub: { a: true, sh: 'square' } });
      expect(setTable.mock.calls.map(([table]) => table)).toEqual(['sub:square']);
    });

    it('round-trips its state', () => {
      const [model, actions] = createSub();
      actions.toggleActive();
      actions.setShape('round-rect');
      actions.setSubValue('coarse', -0.5);
      actions.setSubValue('pan', -1);
      const snapshot = getSnapshot();
      applySnapshot({});
      applySnapshot(snapshot);
      expect(getSnapshot()['sub']).toEqual(snapshot['sub']);
      expect(model.$active.value).toBe(true);
    });
  });
});
