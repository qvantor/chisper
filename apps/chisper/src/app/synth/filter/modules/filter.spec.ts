import { FilterType } from '@chisper/preset-schema';
import { applySnapshot, getSnapshot } from '../../../app';
import { createFilter } from '../../../../test-utils/models';
import { defaultFilterRanges, rangesOf } from '../constants';

const setup = () => {
  const [model, actions] = createFilter();
  // the values the voices get
  const played: unknown[] = [];
  model.$voiceFilter.subscribe((value) => played.push(value));
  return { model, actions, played };
};

describe('filter', () => {
  it('is off by default: the voices play no filter', () => {
    const { model, played } = setup();
    expect(model.$active.value).toBe(false);
    expect(model.voiceFilter()).toBeNull();
    expect(played).toEqual([null]);
  });

  it('gives the voices its knobs while it is on, once per change', () => {
    const { model, actions, played } = setup();
    actions.toggleActive();
    actions.setNumericValue('cutoff', 1000);
    actions.setNumericValue('cutoff', 1000);
    actions.setNumericValue('resonance', 5);
    const on = { type: 'lowpass', cutoff: 1000, resonance: 5, gain: 1, drive: 0, variation: 0 };
    expect(model.voiceFilter()).toEqual(on);
    actions.toggleActive();
    expect(played).toEqual([
      null,
      { type: 'lowpass', cutoff: 440, resonance: 0, gain: 1, drive: 0, variation: 0 },
      { ...on, resonance: 0 },
      on,
      null,
    ]);
  });

  it('has no node of its own: it is in the voices', () => {
    const { model } = setup();
    expect(model).not.toHaveProperty('filterNode');
    expect(model.sampleRate).toBe(44100);
  });

  it('setType changes the type of the voices and merges the type ranges', () => {
    const { model, actions } = setup();

    actions.setType('highshelf');

    expect(model.$filterType.value).toBe('highshelf');
    expect(model.$ranges.value.gain).toEqual({ ...defaultFilterRanges.gain, min: -40, max: 40 });
    expect(model.$ranges.value.resonance.disabled).toBe(true);
    expect(model.$ranges.value.cutoff).toEqual(defaultFilterRanges.cutoff);
    // the defaults are not mutated by the merge
    expect(defaultFilterRanges.gain).toEqual({ min: 0, max: 1, precision: 100 });
  });

  it('works the ranges of each type out once: the same ones, frozen, on every read', () => {
    expect(rangesOf('ladder24')).toBe(rangesOf('ladder24'));
    expect(rangesOf('lowshelf').gain).toEqual({ ...defaultFilterRanges.gain, min: -40, max: 40 });
    expect(Object.isFrozen(rangesOf('lowshelf'))).toBe(true);
    expect(Object.isFrozen(rangesOf('lowshelf').gain)).toBe(true);
    expect(Object.isFrozen(defaultFilterRanges.gain)).toBe(false);
  });

  it('clamps the values to the ranges of the new type', () => {
    const { model, actions } = setup();
    actions.setNumericValue('resonance', 0);

    actions.setType('bandpass');
    expect(model.$filter.value.resonance).toBe(0.01);

    actions.setNumericValue('resonance', 15);
    actions.setType('peaking');
    expect(model.$filter.value.resonance).toBe(10);
  });

  it('setFilterValues replaces all values', () => {
    const { model, actions } = setup();
    actions.setFilterValues({ cutoff: 200, resonance: 1, gain: 0.5, drive: 10, variation: 20 });
    expect(model.$filter.value).toEqual({ cutoff: 200, resonance: 1, gain: 0.5, drive: 10, variation: 20 });
  });

  describe('a model type', () => {
    it('has Res, Drive and Var in %, no Gain; a type of a BiquadFilterNode no Drive and no Var', () => {
      const { model, actions } = setup();
      expect(model.$ranges.value.drive.disabled).toBe(true);
      expect(model.$ranges.value.variation.disabled).toBe(true);
      actions.setType('ladder12');
      const ranges = model.$ranges.value;
      expect(ranges.resonance).toMatchObject({ min: 0, max: 100 });
      expect(ranges.resonance.disabled).toBeFalsy();
      expect(ranges.gain.disabled).toBe(true);
      expect(ranges.drive).toMatchObject({ min: 0, max: 100 });
      expect(ranges.variation).toMatchObject({ min: 0, max: 100 });
      expect(ranges.drive.disabled).toBeFalsy();
    });

    it('gives the voices its type, Res, Drive and Var', () => {
      const { model, actions } = setup();
      actions.toggleActive();
      actions.setType('low24');
      actions.setNumericValue('resonance', 40);
      actions.setNumericValue('drive', 25);
      actions.setNumericValue('variation', 60);
      expect(model.voiceFilter()).toEqual({
        type: 'low24',
        cutoff: 440,
        resonance: 40,
        gain: 1,
        drive: 25,
        variation: 60,
      });
    });

    it('keeps where the knob of Res is between the two kinds of types', () => {
      const { model, actions } = setup();
      actions.setNumericValue('resonance', 5);
      // 5 dB of 0..20: a quarter
      actions.setType('ladder24');
      expect(model.$filter.value.resonance).toBeCloseTo(25);
      actions.setType('low12');
      expect(model.$filter.value.resonance).toBeCloseTo(25);
      // the Q of bandpass on its log knob: from a quarter of it
      actions.setType('bandpass');
      expect(model.$filter.value.resonance).toBeCloseTo(0.01 * Math.pow(1000 / 0.01, 0.25));
      actions.setType('notch24');
      expect(model.$filter.value.resonance).toBeCloseTo(25);
      // a type without Res keeps the value
      actions.setType('lowshelf');
      expect(model.$filter.value.resonance).toBeCloseTo(25);
    });

    it("disables the knobs a type doesn't use: Res of a one-pole, Comp of Low 6 and High 6", () => {
      const { model, actions } = setup();
      const knobs = (type: FilterType) => {
        actions.setType(type);
        const { resonance, drive, variation } = model.$ranges.value;
        return [!resonance.disabled, !drive.disabled, !variation.disabled];
      };
      expect(knobs('low6')).toEqual([false, true, false]);
      expect(knobs('high6')).toEqual([false, true, false]);
      expect(knobs('loweq6')).toEqual([false, true, true]);
      expect(knobs('higheq6')).toEqual([false, true, true]);
      (['ladder6', 'low12', 'high18', 'loweq12', 'bandeq12'] as const).forEach((type) =>
        expect(knobs(type)).toEqual([true, true, true])
      );
    });

    it('keeps the values and where the knob of Res is through a type that disables them', () => {
      const { model, actions } = setup();
      actions.setType('low12');
      actions.setNumericValue('resonance', 50);
      actions.setNumericValue('variation', 70);
      actions.setType('low6');
      expect(model.$filter.value).toMatchObject({ resonance: 50, variation: 70 });
      // half of the % to half of the dB and back
      actions.setType('lowpass');
      expect(model.$filter.value.resonance).toBeCloseTo(10);
      actions.setType('high6');
      actions.setType('ladder24');
      expect(model.$filter.value.resonance).toBeCloseTo(50);
      expect(model.$filter.value.variation).toBe(70);
    });

    it('keeps where the knob of Res is through a type without it into one of the other kind', () => {
      const { model, actions } = setup();
      actions.setType('loweq12');
      actions.setNumericValue('resonance', 30);
      // the shelves keep the % of the EQ type: a Bell takes 0.3 of its Q, a Ladder 30 % again
      actions.setType('lowshelf');
      actions.setType('highshelf');
      actions.setType('peaking');
      expect(model.$filter.value.resonance).toBeCloseTo(3);
      actions.setType('lowshelf');
      actions.setType('ladder6');
      expect(model.$filter.value.resonance).toBeCloseTo(30);
      actions.setNumericValue('resonance', 60);
      actions.setType('lowshelf');
      actions.setType('lowpass');
      expect(model.$filter.value.resonance).toBeCloseTo(12);
    });

    it('gives the voices a change of type once, its knobs with it', () => {
      const { actions, played } = setup();
      actions.toggleActive();
      actions.setNumericValue('resonance', 10);
      const before = played.length;
      // half of the dB of a Biquad LP: half of the % of a ladder, never 50 dB of the lowpass
      actions.setType('ladder24');
      expect(played.slice(before)).toEqual([
        { type: 'ladder24', cutoff: 440, resonance: 50, gain: 1, drive: 0, variation: 0 },
      ]);
      actions.setType('lowpass');
      expect(played.slice(before + 1)).toEqual([
        { type: 'lowpass', cutoff: 440, resonance: 10, gain: 1, drive: 0, variation: 0 },
      ]);
      // a type of the same kind: once too
      actions.setType('bandpass');
      expect(played.slice(before + 2)).toEqual([
        { type: 'bandpass', cutoff: 440, resonance: 10, gain: 1, drive: 0, variation: 0 },
      ]);
    });

    it('never leaves the voices cut off when a change of type or a snapshot throws on the way', () => {
      const { model, actions, played } = setup();
      actions.toggleActive();
      const next = jest.spyOn(model.$filterType, 'next').mockImplementationOnce(() => {
        throw new Error('on the way');
      });
      expect(() => actions.setType('ladder24')).toThrow('on the way');
      expect(model.$changingType.value).toBe(false);
      actions.setNumericValue('cutoff', 900);
      expect(played.at(-1)).toMatchObject({ cutoff: 900 });

      next.mockImplementationOnce(() => {
        throw new Error('on the way');
      });
      expect(() => applySnapshot({ filter: { a: true, t: 'ladder24', cut: 700 } })).toThrow('on the way');
      expect(model.$changingType.value).toBe(false);
      actions.setNumericValue('cutoff', 1200);
      expect(played.at(-1)).toMatchObject({ cutoff: 1200 });
      next.mockRestore();
    });

    it('starts the Gain of the band of an EQ type at 0 dB and Comp back at 0: another knob', () => {
      const { model, actions } = setup();
      actions.setType('ladder24');
      actions.setNumericValue('variation', 30);
      actions.setType('loweq12');
      expect(model.$filter.value.variation).toBe(50);
      actions.setNumericValue('variation', 70);
      // through a type that doesn't use it, and between EQ types: kept
      actions.setType('lowpass');
      actions.setType('low6');
      actions.setType('bandeq12');
      expect(model.$filter.value.variation).toBe(70);
      actions.setType('higheq6');
      expect(model.$filter.value.variation).toBe(70);
      actions.setType('low12');
      expect(model.$filter.value.variation).toBe(0);
    });

    it('takes what Var is from the type of a snapshot', () => {
      const { model, actions } = setup();
      applySnapshot({ filter: { a: true, t: 'loweq12', v: 80 } });
      actions.setType('bandeq12');
      expect(model.$filter.value.variation).toBe(80);
      applySnapshot({ filter: { a: true, t: 'low12', v: 80 } });
      actions.setType('loweq12');
      expect(model.$filter.value.variation).toBe(50);
    });

    it('keeps Drive and Var through a type of a BiquadFilterNode', () => {
      const { model, actions } = setup();
      actions.setType('band12');
      actions.setNumericValue('drive', 30);
      actions.setNumericValue('variation', 80);
      actions.setType('lowpass');
      actions.setType('band24');
      expect(model.$filter.value).toMatchObject({ drive: 30, variation: 80 });
    });
  });

  describe('snapshot', () => {
    it('exposes the persisted state', () => {
      const { actions } = setup();
      actions.toggleActive();
      actions.setType('highpass');
      actions.setNumericValue('cutoff', 1200);
      expect(getSnapshot()['filter']).toEqual({
        a: true,
        t: 'highpass',
        cut: 1200,
        gain: 1,
        res: 0,
        dr: 0,
        v: 0,
      });
    });

    it('applies values before the type so they are clamped by the type ranges', () => {
      const { model } = setup();
      applySnapshot({ filter: { a: true, t: 'bandpass', cut: 800, res: 0, gain: 0 } });

      expect(model.$active.value).toBe(true);
      expect(model.$filterType.value).toBe('bandpass');
      expect(model.$filter.value).toEqual({ cutoff: 800, resonance: 0.01, gain: 0, drive: 0, variation: 0 });
    });

    it('applies falsy values and restores defaults for missing keys', () => {
      const { model, actions } = setup();
      actions.toggleActive();
      actions.setType('highpass');
      actions.setNumericValue('cutoff', 5000);

      applySnapshot({ filter: { a: false } });

      expect(model.$active.value).toBe(false);
      expect(model.$filter.value).toEqual({ cutoff: 440, resonance: 0, gain: 1, drive: 0, variation: 0 });
      // the type is kept when it is not in the snapshot
      expect(model.$filterType.value).toBe('highpass');
    });

    it('gives the voices a snapshot once, its knobs with its type', () => {
      const { actions, played } = setup();
      actions.toggleActive();
      const before = played.length;
      // (never 60 dB of the Biquad LP that played before it)
      applySnapshot({ filter: { a: true, t: 'ladder24', cut: 900, res: 60 } });
      expect(played.slice(before)).toEqual([
        { type: 'ladder24', cutoff: 900, resonance: 60, gain: 1, drive: 0, variation: 0 },
      ]);
    });

    it('takes the units of Res from the type of a snapshot, of a shelf those of a Biquad LP', () => {
      const { model, actions } = setup();
      applySnapshot({ filter: { a: true, t: 'lowshelf', res: 5 } });
      actions.setType('ladder24');
      expect(model.$filter.value.resonance).toBeCloseTo(25);
      applySnapshot({ filter: { a: true, t: 'ladder12', res: 40 } });
      actions.setType('lowshelf');
      actions.setType('lowpass');
      expect(model.$filter.value.resonance).toBeCloseTo(8);
    });

    it('keeps the units of Res of a model type through a shelf in a snapshot', () => {
      const { model, actions } = setup();
      actions.setType('ladder12');
      actions.setNumericValue('resonance', 80);
      actions.setType('lowshelf');
      const shelf = getSnapshot()['filter'];
      expect(shelf).toMatchObject({ t: 'lowshelf', res: 80, rt: 'ladder12' });
      expect(shelf).not.toHaveProperty('vk');
      // (another state before it: a reload) 80 % of a Ladder: 16 dB of a Biquad LP, 80 % of a Ladder again
      applySnapshot({ filter: { a: true, t: 'bandpass', res: 3 } });
      applySnapshot({ filter: shelf });
      actions.setType('lowpass');
      expect(model.$filter.value.resonance).toBeCloseTo(16);
      applySnapshot({ filter: shelf });
      actions.setType('ladder24');
      expect(model.$filter.value.resonance).toBeCloseTo(80);
      // and of a Q through a shelf: its share into a model type
      actions.setType('bandpass');
      actions.setNumericValue('resonance', 100);
      actions.setType('highshelf');
      const q = getSnapshot()['filter'];
      expect(q).toMatchObject({ t: 'highshelf', rt: 'bandpass' });
      applySnapshot({ filter: shelf });
      applySnapshot({ filter: q });
      actions.setType('ladder12');
      expect(model.$filter.value.resonance).toBeCloseTo(80);
    });

    it('keeps the Gain of the band of an EQ type through a type without Var in a snapshot', () => {
      const { model, actions } = setup();
      actions.setType('loweq12');
      actions.setNumericValue('variation', 70);
      actions.setType('lowpass');
      const biquad = getSnapshot()['filter'];
      expect(biquad).toMatchObject({ t: 'lowpass', v: 70, vk: 'eq' });
      expect(biquad).not.toHaveProperty('rt');
      applySnapshot({ filter: { a: true, t: 'ladder12', v: 20 } });
      applySnapshot({ filter: biquad });
      actions.setType('bandeq12');
      expect(model.$filter.value.variation).toBe(70);
      // into Comp: its default, not 70 % of Comp
      applySnapshot({ filter: biquad });
      actions.setType('low12');
      expect(model.$filter.value.variation).toBe(0);
    });

    it('has the units of Res and Var only where they are not those it takes without them', () => {
      const { actions } = setup();
      const snapshot = () => getSnapshot()['filter'] as Record<string, unknown>;
      // dB of a Biquad LP through a shelf, Comp through a Biquad LP and a one-pole
      actions.setType('lowshelf');
      expect(Object.keys(snapshot())).toEqual(['a', 't', 'cut', 'gain', 'res', 'dr', 'v']);
      actions.setType('ladder12');
      actions.setType('lowpass');
      actions.setType('low6');
      expect(snapshot()).not.toHaveProperty('vk');
      // types that use them: theirs
      actions.setType('loweq12');
      expect(snapshot()).not.toHaveProperty('rt');
      expect(snapshot()).not.toHaveProperty('vk');
    });

    it('takes the units of a url snapshot only of a type that uses them', () => {
      const { model, actions } = setup();
      // (a shelf, a type of a newer client, another kind of Var: those of a Biquad LP and Comp)
      applySnapshot({ filter: { a: true, t: 'lowshelf', res: 5, rt: 'highshelf' } });
      actions.setType('ladder24');
      expect(model.$filter.value.resonance).toBeCloseTo(25);
      applySnapshot({ filter: { a: true, t: 'lowshelf', res: 5, rt: 'comb' as never } });
      actions.setType('ladder24');
      expect(model.$filter.value.resonance).toBeCloseTo(25);
      applySnapshot({ filter: { a: true, t: 'lowpass', v: 70, vk: 'gain' as never } });
      actions.setType('loweq12');
      expect(model.$filter.value.variation).toBe(50);
    });

    it('starts the Gain of the band of an EQ type of a snapshot without Var at 0 dB, a falsy one kept', () => {
      const { model } = setup();
      applySnapshot({ filter: { a: true, t: 'loweq12' } });
      expect(model.$filter.value.variation).toBe(50);
      applySnapshot({ filter: { a: true, t: 'loweq12', v: 0 } });
      expect(model.$filter.value.variation).toBe(0);
      // Comp: 0 %
      applySnapshot({ filter: { a: true, t: 'ladder12' } });
      expect(model.$filter.value.variation).toBe(0);
    });

    it('keeps its type for one it does not know (a url snapshot of a newer client)', () => {
      const { model, actions } = setup();
      actions.setType('band24');
      applySnapshot({ filter: { a: true, t: 'comb' as never, cut: 700 } });
      expect(model.$filterType.value).toBe('band24');
      expect(model.$filter.value.cutoff).toBe(700);
    });

    it('round-trips a model type with its Drive and Var, falsy ones too', () => {
      const { model, actions } = setup();
      actions.toggleActive();
      actions.setType('higheq12');
      actions.setNumericValue('resonance', 70);
      actions.setNumericValue('drive', 45);
      actions.setNumericValue('variation', 0);
      const snapshot = getSnapshot()['filter'];
      expect(snapshot).toMatchObject({ t: 'higheq12', res: 70, dr: 45, v: 0 });
      actions.setNumericValue('drive', 90);
      actions.setNumericValue('variation', 50);
      applySnapshot({ filter: snapshot });
      expect(model.$filterType.value).toBe('higheq12');
      expect(model.$filter.value).toMatchObject({ resonance: 70, drive: 45, variation: 0 });
      // the knobs not in a snapshot: their defaults
      applySnapshot({ filter: { a: true, t: 'ladder12', cut: 900, res: 20 } });
      expect(model.$filter.value).toMatchObject({ cutoff: 900, resonance: 20, drive: 0, variation: 0 });
    });
  });
});
