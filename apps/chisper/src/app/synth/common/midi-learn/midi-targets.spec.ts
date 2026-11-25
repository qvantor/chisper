import { FX_TYPES, LFO_DEFAULTS } from '@chisper/preset-schema';
import { createMidiLearn } from '../../../../test-utils/models';
import { MOD_TARGETS } from '../modulation/modulation-targets';
import { FX_REGISTRY } from '../../fx/effects';
import { defaultFilterRanges, rangesOf } from '../../filter/constants';
import { FILTER_TYPE_ORDER } from '../../filter/filter-types';
import { dbToGain } from '../../synth/components/master-handle';
import { knobValue } from './cc-value';
import { ChoiceTarget, KnobTarget, MidiTarget, SwitchTarget, targetText } from './midi-targets';

const setup = () => {
  const modules = createMidiLearn();
  const { targets } = modules.learn[0];
  const target = <T extends MidiTarget>(id: string) => {
    const found = targets.get(id);
    if (!found) throw new Error(`no target ${id}`);
    return found as T;
  };
  return { ...modules, targets, target };
};

describe('midi targets', () => {
  it('has every target of the routes, with ids of its own for the other controls', () => {
    const { targets } = setup();
    Object.keys(MOD_TARGETS).forEach((id) => expect(targets.has(id)).toBe(true));
    [
      'osc1.on',
      'osc2.oct',
      'osc1.unison',
      'osc2.warpMode',
      'sub.shape',
      'noise.loop',
      'filter.type',
      'filter.on',
      'env1.attack',
      'env3.sustain',
      'env2.bpm',
      'vel.amp',
      'voicing.poly',
      'voicing.legato',
      'voicing.portamento',
      'bend.up',
      'bend.down',
      'lfo4.shape',
      'lfo1.bpm',
      'macro1',
      'macro4',
      'master',
      ...FX_TYPES.map((type) => `${type}.on`),
      'delay.mode',
      'delay.sync',
      'reverb.era',
      'eq.t1',
      'chorus.hpf',
      'compressor.multi',
    ].forEach((id) => expect(targets.has(id)).toBe(true));
    // the division of a time in BPM is its knob
    expect(targets.has('delay.div')).toBe(false);
  });

  it('names each control by its section and its label', () => {
    const { target, modulation, filter } = setup();
    expect(target('filter.cutoff').name()).toBe('Filter Cutoff');
    // (as the type labels its knob)
    expect(target('filter.var').name()).toBe('Filter Comp');
    filter[1].setType('bandpass');
    expect(target('filter.resonance').name()).toBe('Filter Q');
    expect(target('osc2.wave').name()).toBe('Osc 2 Wave');
    expect(target('reverb.mix').name()).toBe('Reverb Mix');
    expect(target('lfo3.rate').name()).toBe('LFO 3 Rate');
    expect(target('env2.release').name()).toBe('ENV 2 Release');
    expect(target('macro2').name()).toBe('MACRO 2');
    modulation[1].setMacroName('macro2', 'Bright');
    expect(target('macro2').name()).toBe('Bright');
  });

  it('sets every knob to the ends of its travel through its model', () => {
    const { targets } = setup();
    // (the crossovers of the compressor stop at each other: below)
    const held = ['compressor.xlow', 'compressor.xhigh'];
    targets.forEach((target) => {
      if (target.kind !== 'knob' || held.includes(target.id)) return;
      const def = target.def();
      [0, 1].forEach((share) => {
        const value = knobValue(def, share);
        target.set(value);
        expect([target.id, target.get()]).toEqual([target.id, expect.closeTo(value, 6)]);
      });
    });
  });

  it('switches every switch on and off', () => {
    const { targets } = setup();
    targets.forEach((target) => {
      if (target.kind !== 'switch') return;
      [true, false, true].forEach((on) => {
        target.set(on);
        expect([target.id, target.get()]).toEqual([target.id, on]);
      });
      expect(targetText(target)).toBe('On');
    });
  });

  it('chooses every option of every choice', () => {
    const { targets } = setup();
    targets.forEach((target) => {
      if (target.kind !== 'choice') return;
      target.options.forEach((label, index) => {
        target.set(index);
        expect([target.id, target.get(), targetText(target)]).toEqual([target.id, index, label]);
      });
    });
  });

  it('takes the ranges of the type of the filter, a knob it does not use in its default range', () => {
    const { target, filter } = setup();
    const res = target<KnobTarget>('filter.resonance');
    const gain = target<KnobTarget>('filter.gain');
    filter[1].setType('bandpass');
    expect(res.def()).toEqual(expect.objectContaining({ min: 0.01, max: 1000, mode: 'log' }));
    filter[1].setType('lowpass');
    expect(rangesOf('lowpass').gain.disabled).toBe(true);
    expect(gain.def()).toEqual(expect.objectContaining({ min: defaultFilterRanges.gain.min }));
    expect(gain.def().max).toBe(defaultFilterRanges.gain.max);
    const type = target<ChoiceTarget>('filter.type');
    expect(type.options).toHaveLength(FILTER_TYPE_ORDER.length);
    type.set(FILTER_TYPE_ORDER.indexOf('high12'));
    expect(filter[0].$filterType.value).toBe('high12');
  });

  it('takes the frames of the table on Wave', () => {
    const { target, osc1 } = setup();
    osc1[1].setWaveTable([
      [0, 1],
      [1, 0],
      [0, -1],
      [-1, 0],
    ]);
    expect(target<KnobTarget>('osc1.wave').def()).toEqual(
      expect.objectContaining({ min: 0, max: 3, precision: 1 })
    );
    target<KnobTarget>('osc1.wave').set(2);
    expect(osc1[0].$position.value).toBe(2);
  });

  it('moves a knob of the routes in the scale of its knob (Rate of an LFO in octaves)', () => {
    const { target } = setup();
    Object.entries(MOD_TARGETS).forEach(([id, mod]) => {
      if (!('scale' in mod)) return;
      expect([id, target<KnobTarget>(id).def().mode ?? 'linear']).toEqual([id, mod.scale]);
    });
    expect(target<KnobTarget>('lfo1.rate').def().mode).toBe('log');
  });

  it('sets Rate of an LFO by its frequency, in BPM its divisions', () => {
    const { target, lfos } = setup();
    const rate = target<KnobTarget>('lfo1.rate');
    rate.set(4);
    expect(lfos[0].$lfos.value.lfo1.rate).toBeCloseTo(0.25, 10);
    expect(rate.get()).toBeCloseTo(4, 10);
    lfos[1].setBpm('lfo1', true);
    const { steps } = rate.def();
    expect(steps?.length).toBeGreaterThan(4);
    rate.set(steps?.[0] ?? -1);
    expect(lfos[0].$lfos.value.lfo1.div).toBe(steps?.[0]);
    expect(LFO_DEFAULTS.bpm).toBe(false);
  });

  it('sets a time of an envelope in BPM by its divisions', () => {
    const { target, envelopes } = setup();
    const attack = target<KnobTarget>('env2.attack');
    expect(attack.def().mode).toBe('pow');
    envelopes[1].setEnvelopeBpm('env2', true);
    const { steps } = attack.def();
    attack.set(steps?.[3] ?? -1);
    expect(envelopes[0].$envelopes.value.env2.divs.attack).toBe(steps?.[3]);
  });

  it('sets Time of the delay in BPM by its divisions', () => {
    const { target, fx } = setup();
    const time = target<KnobTarget>('delay.time');
    target<SwitchTarget>('delay.sync').set(true);
    const steps = FX_REGISTRY.delay.tempo?.stepsOf(fx[0].$effects.value.delay.params) ?? [];
    expect(time.def().steps).toBe(steps);
    time.set(steps[2]);
    expect(fx[0].$effects.value.delay.params['div']).toBe(steps[2]);
    expect(time.get()).toBe(steps[2]);
  });

  it('keeps the crossovers of the compressor from crossing', () => {
    const { target, fx } = setup();
    target<KnobTarget>('compressor.xlow').set(1000);
    target<KnobTarget>('compressor.xhigh').set(200);
    const { xlow, xhigh } = fx[0].$effects.value.compressor.params;
    expect(xhigh).toBeGreaterThanOrEqual(xlow);
  });

  it('sets Master in dB', () => {
    const { target, synthCore } = setup();
    const master = target<KnobTarget>('master');
    expect(master.def()).toEqual(expect.objectContaining({ min: -40, max: 12 }));
    master.set(-6);
    expect(synthCore[0].$masterGain.value).toBeCloseTo(dbToGain(-6), 10);
    expect(master.get()).toBeCloseTo(-6, 10);
  });

  it('moves a macro as a CC of a MIDI input', () => {
    const { target, modulation } = setup();
    const moves: unknown[] = [];
    modulation[0].$macroMoves.subscribe((move) => moves.push(move));
    target<KnobTarget>('macro3').set(0.4);
    expect(modulation[0].$macros.value[2]).toBe(0.4);
    expect(moves).toEqual([expect.objectContaining({ source: 'midi' })]);
  });
});
