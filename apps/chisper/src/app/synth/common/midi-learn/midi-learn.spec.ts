import toast from 'react-hot-toast';
import { recordAnalytics } from '../../../../test-utils/analytics';
import { createMidiLearn } from '../../../../test-utils/models';
import { stopModels } from '../../../../test-utils/model-registry';
import { blockStorage } from '../../../../test-utils/storage';
import { rangesOf } from '../../filter/constants';
import { fxFilterIndexOf } from '../../fx/effects/fxfilter-params';
import { ccShare, knobValue } from './cc-value';
import { CC_INTERVAL, TOGGLE_WINDOW } from './midi-learn';
import { CC_IDLE, MAX_VALUES } from './cc-kind';
import type { KnobTarget } from './midi-targets';

const setup = () => {
  const modules = createMidiLearn();
  const [learnModel, learnActions] = modules.learn;
  // a CC as a hand moves a controller: the next one after the interval
  const cc = (number: number, value: number) => {
    modules.midi[0].$cc.next({ cc: number, value });
    jest.advanceTimersByTime(CC_INTERVAL);
  };
  // a CC of a stream (a DAW): the next one comes before the interval
  const stream = (number: number, value: number) => modules.midi[0].$cc.next({ cc: number, value });
  const knob = (id: string) => learnModel.targets.get(id) as KnobTarget;
  // the cutoff a CC value puts the knob of a lowpass at
  const cutoffAt = (value: number) => knobValue(rangesOf('lowpass').cutoff, ccShare(value));
  return { ...modules, learnModel, learnActions, cc, stream, knob, cutoffAt };
};

const stored = () => JSON.parse(localStorage.getItem('midiMap') ?? 'null');

beforeEach(() => jest.useFakeTimers({ doNotFake: ['performance'] }));
afterEach(() => jest.useRealTimers());

describe('midiLearn', () => {
  describe('the map', () => {
    it('starts with the macros on CC 20–23 when the browser has no map', () => {
      const { learnModel, cc, modulation } = setup();
      expect(learnModel.$bindings.value).toEqual({ 20: 'macro1', 21: 'macro2', 22: 'macro3', 23: 'macro4' });
      cc(21, 127);
      expect(modulation[0].$macros.value).toEqual([0, 1, 0, 0]);
      expect(learnModel.mark('macro2')).toEqual({ cc: 21, waiting: false, pickup: null });
    });

    it('reads the map of the browser: a CC that may not be bound, an unknown control or a second CC of one left out', () => {
      localStorage.setItem(
        'midiMap',
        JSON.stringify({
          takeover: 'pickup',
          bindings: {
            74: 'filter.cutoff',
            75: 'filter.cutoff',
            0: 'osc1.gain',
            7: 'gone.knob',
            300: 'master',
          },
        })
      );
      const { learnModel } = setup();
      expect(learnModel.$bindings.value).toEqual({ 74: 'filter.cutoff' });
      expect(learnModel.$takeover.value).toBe('pickup');
    });

    it('starts with the defaults when the map of the browser is not one', () => {
      localStorage.setItem('midiMap', JSON.stringify({ takeover: 'later', bindings: [] }));
      expect(setup().learnModel.$bindings.value[20]).toBe('macro1');
    });

    it('keeps the map in the browser, an empty one too (the defaults never come back)', () => {
      const first = setup();
      first.learnActions.learn('filter.cutoff');
      first.cc(74, 0);
      expect(stored()).toEqual({
        takeover: 'jump',
        bindings: { 20: 'macro1', 21: 'macro2', 22: 'macro3', 23: 'macro4', 74: 'filter.cutoff' },
      });
      first.learnActions.clear();
      first.learnActions.setTakeover('pickup');
      expect(stored()).toEqual({ takeover: 'pickup', bindings: {} });
      expect(setup().learnModel.$bindings.value).toEqual({});
    });

    it('lives until a reload where the browser keeps nothing', () => {
      blockStorage('localStorage');
      const { learnModel, learnActions, cc } = setup();
      expect(learnModel.kept).toBe(false);
      learnActions.learn('osc1.gain');
      cc(7, 127);
      expect(learnModel.$bindings.value[7]).toBe('osc1.gain');
    });
  });

  describe('learn', () => {
    it('binds the next CC to the control waiting and moves it there (Jump)', () => {
      const { learnModel, learnActions, cc, filter, cutoffAt } = setup();
      learnActions.learn('filter.cutoff');
      expect(learnModel.mark('filter.cutoff').waiting).toBe(true);
      expect(toast).toHaveBeenCalledWith('Move a control on your MIDI device', expect.anything());

      cc(74, 64);
      expect(learnModel.$bindings.value[74]).toBe('filter.cutoff');
      expect(learnModel.$learning.value).toBeNull();
      expect(learnModel.mark('filter.cutoff')).toEqual({ cc: 74, waiting: false, pickup: null });
      expect(toast.success).toHaveBeenCalledWith('CC 74 → Filter Cutoff');
      expect(toast.dismiss).toHaveBeenCalledWith('midi-learn');
      expect(filter[0].$filter.value.cutoff).toBe(cutoffAt(64));

      cc(74, 127);
      expect(filter[0].$filter.value.cutoff).toBe(cutoffAt(127));
    });

    it('moves a CC bound to another control to the one waiting', () => {
      const { learnModel, learnActions, cc } = setup();
      learnActions.learn('filter.cutoff');
      cc(74, 10);
      learnActions.learn('filter.resonance');
      cc(74, 20);
      expect(toast.success).toHaveBeenLastCalledWith('CC 74: Filter Cutoff → Filter Res');
      expect(learnModel.$bindings.value[74]).toBe('filter.resonance');
      expect(learnModel.mark('filter.cutoff').cc).toBeNull();
      expect(learnModel.mark('filter.resonance').cc).toBe(74);
    });

    it('replaces the CC of a control bound already', () => {
      const { learnModel, learnActions, cc } = setup();
      learnActions.learn('filter.cutoff');
      cc(74, 10);
      learnActions.learn('filter.cutoff');
      cc(75, 10);
      expect(Object.entries(learnModel.$bindings.value).filter(([, id]) => id === 'filter.cutoff')).toEqual([
        ['75', 'filter.cutoff'],
      ]);
    });

    it('binds no CC that may not be bound (bank select, data entry, the RPN/NRPN numbers)', () => {
      const { learnModel, learnActions, cc } = setup();
      learnActions.learn('osc1.gain');
      [0, 32, 6, 38, 96, 101].forEach((number) => cc(number, 64));
      expect(learnModel.$learning.value?.target).toBe('osc1.gain');
      cc(1, 64);
      expect(learnModel.$bindings.value[1]).toBe('osc1.gain');
    });

    it('another control waiting replaces the first, cancel ends it, another input too', () => {
      const { learnModel, learnActions, midi } = setup();
      learnActions.learn('osc1.gain');
      learnActions.learn('osc2.gain');
      expect(learnModel.mark('osc1.gain').waiting).toBe(false);
      expect(learnModel.mark('osc2.gain').waiting).toBe(true);
      learnActions.cancel();
      expect(learnModel.$learning.value).toBeNull();
      expect(learnModel.mark('osc2.gain').waiting).toBe(false);

      learnActions.learn('osc2.gain');
      midi[1].selectMidiInput('other');
      expect(learnModel.$learning.value).toBeNull();
    });

    it('a control of no id waits for nothing', () => {
      const { learnModel, learnActions } = setup();
      learnActions.learn('nothing.here');
      expect(learnModel.$learning.value).toBeNull();
    });

    it('removes the CC of a control and all of them', () => {
      const { learnModel, learnActions, cc, filter } = setup();
      learnActions.learn('filter.cutoff');
      cc(74, 10);
      learnActions.remove('filter.cutoff');
      expect(learnModel.$bindings.value[74]).toBeUndefined();
      expect(learnModel.mark('filter.cutoff').cc).toBeNull();
      const cutoff = filter[0].$filter.value.cutoff;
      cc(74, 120);
      expect(filter[0].$filter.value.cutoff).toBe(cutoff);
      learnActions.clear();
      expect(learnModel.$bindings.value).toEqual({});
    });

    it('in the Learn mode a control chosen waits, the mode stays after it is bound', () => {
      const { learnModel, learnActions, cc } = setup();
      learnActions.select('osc1.gain');
      expect(learnModel.$learning.value).toBeNull();
      learnActions.setLearnMode(true);
      learnActions.select('osc1.gain');
      expect(learnModel.$learning.value).toEqual({ target: 'osc1.gain', via: 'mode' });
      cc(7, 0);
      expect(learnModel.$learnMode.value).toBe(true);
      learnActions.select('osc2.gain');
      learnActions.setLearnMode(false);
      expect(learnModel.$learning.value).toBeNull();
    });
  });

  describe('a CC bound', () => {
    it('moves its control at most every CC_INTERVAL, the last value after the pause', () => {
      const { learnActions, cc, stream, filter, cutoffAt } = setup();
      learnActions.learn('filter.cutoff');
      cc(74, 0);
      jest.advanceTimersByTime(CC_INTERVAL * 2);
      const changes: number[] = [];
      filter[0].$filter.subscribe(({ cutoff }) => changes.push(cutoff));
      changes.length = 0;

      // 200 a second for 100 ms
      for (let k = 1; k <= 20; k++) {
        stream(74, k * 5);
        jest.advanceTimersByTime(5);
      }
      jest.advanceTimersByTime(CC_INTERVAL);
      expect(changes.length).toBeLessThanOrEqual(Math.ceil(100 / CC_INTERVAL) + 1);
      expect(changes.length).toBeGreaterThan(3);
      expect(changes[changes.length - 1]).toBe(cutoffAt(100));
    });

    it('does nothing for a CC of no control, nor for the same value again', () => {
      const { learnActions, cc, filter } = setup();
      learnActions.learn('filter.cutoff');
      cc(74, 30);
      const changes: unknown[] = [];
      filter[0].$filter.subscribe((value) => changes.push(value));
      changes.length = 0;
      cc(74, 30);
      cc(75, 90);
      cc(119, 90);
      expect(changes).toEqual([]);
    });

    it('takes the same value again once a hand moved the control (a DAW playing its automation)', () => {
      const { learnActions, cc, filter, cutoffAt, osc1, osc2 } = setup();
      learnActions.learn('filter.cutoff');
      cc(74, 100);
      filter[1].setNumericValue('cutoff', 500);
      cc(74, 100);
      expect(filter[0].$filter.value.cutoff).toBe(cutoffAt(100));

      // a switch: the same value puts it back, another of its zone leaves what the hand chose
      learnActions.learn('osc2.on');
      cc(80, 100);
      osc2[1].toggleActive();
      cc(80, 101);
      expect(osc2[0].$active.value).toBe(false);
      cc(80, 101);
      expect(osc2[0].$active.value).toBe(true);

      // a choice
      learnActions.learn('osc1.warpMode');
      cc(81, 127);
      osc1[1].setWarpMode(1);
      cc(81, 127);
      expect(osc1[0].$warpMode.value).toBe(4);
    });

    it('takes a step of a knob of whole values once (Poly)', () => {
      const { learnActions, cc, synth } = setup();
      learnActions.learn('voicing.poly');
      cc(9, 0);
      const counts: number[] = [];
      synth[0].$maxVoices.subscribe((count) => counts.push(count));
      counts.length = 0;
      [1, 2, 3, 4, 5].forEach((value) => cc(9, value));
      expect(counts).toEqual([]);
      cc(9, 127);
      expect(counts).toEqual([12]);
    });

    it('switches a switch at 64 only as the CC crosses it', () => {
      const { learnActions, cc, osc2 } = setup();
      learnActions.learn('osc2.on');
      cc(80, 100);
      expect(osc2[0].$active.value).toBe(true);
      // a hand switches it off: the controller still over 64 leaves it
      osc2[1].toggleActive();
      cc(80, 101);
      expect(osc2[0].$active.value).toBe(false);
      cc(80, 30);
      expect(osc2[0].$active.value).toBe(false);
      cc(80, 90);
      expect(osc2[0].$active.value).toBe(true);
    });

    it('chooses an option of equal zones as the CC enters one', () => {
      const { learnActions, cc, osc1 } = setup();
      learnActions.learn('osc1.warpMode');
      cc(81, 127);
      expect(osc1[0].$warpMode.value).toBe(4);
      cc(81, 0);
      expect(osc1[0].$warpMode.value).toBe(0);
      cc(81, 60);
      expect(osc1[0].$warpMode.value).toBe(2);
    });

    it('leaves the routes of the knob as they are', () => {
      const { learnActions, cc, modulation } = setup();
      modulation[1].addRoute('lfo1', 'filter.cutoff', 0.5);
      const routes = modulation[0].$routes.value;
      learnActions.learn('filter.cutoff');
      cc(74, 100);
      expect(modulation[0].$routes.value).toBe(routes);
    });
  });

  describe('Pickup', () => {
    it('moves a knob only once the CC passes its value, a hand or a preset takes it off the controller', () => {
      const { learnModel, learnActions, cc, filter, cutoffAt } = setup();
      learnActions.setTakeover('pickup');
      // the knob at the middle of its travel
      filter[1].setNumericValue('cutoff', cutoffAt(64));
      learnActions.learn('filter.cutoff');
      cc(74, 10);
      // bound far from the knob: it waits, the controller shows
      expect(filter[0].$filter.value.cutoff).toBe(cutoffAt(64));
      expect(learnModel.mark('filter.cutoff').pickup).toBeCloseTo(10 / 127, 10);
      cc(74, 40);
      expect(filter[0].$filter.value.cutoff).toBe(cutoffAt(64));
      cc(74, 70);
      expect(filter[0].$filter.value.cutoff).toBe(cutoffAt(70));
      expect(learnModel.mark('filter.cutoff').pickup).toBeNull();
      cc(74, 90);
      expect(filter[0].$filter.value.cutoff).toBe(cutoffAt(90));

      // a hand moves it: the CC waits again for the knob, the controller where it was
      filter[1].setNumericValue('cutoff', cutoffAt(30));
      expect(learnModel.mark('filter.cutoff').pickup).toBeCloseTo(90 / 127, 10);
      cc(74, 80);
      expect(filter[0].$filter.value.cutoff).toBe(cutoffAt(30));
      cc(74, 25);
      expect(filter[0].$filter.value.cutoff).toBe(cutoffAt(25));
    });

    it('takes a knob within a step of the controller at once', () => {
      const { learnActions, cc, osc1 } = setup();
      learnActions.setTakeover('pickup');
      osc1[1].setGain(0.5);
      learnActions.learn('osc1.gain');
      cc(7, 64);
      cc(7, 70);
      expect(osc1[0].$gain.value).toBe(0.55);
    });

    it('keeps a knob its CC set in Jump caught when Pickup is chosen', () => {
      const { learnModel, learnActions, cc, filter, cutoffAt } = setup();
      learnActions.learn('filter.cutoff');
      cc(74, 64);
      learnActions.setTakeover('pickup');
      expect(learnModel.mark('filter.cutoff').pickup).toBeNull();
      // a turn of 4 in an interval
      cc(74, 68);
      expect(filter[0].$filter.value.cutoff).toBe(cutoffAt(68));
    });

    it.each([
      [64, 4],
      [50, 4],
      [110, 4],
      [20, -4],
      [80, -4],
    ])('catches a knob a hand put where the controller is (CC %i, a turn of %i)', (at, turn) => {
      const { learnModel, learnActions, cc, filter, cutoffAt } = setup();
      learnActions.setTakeover('pickup');
      // bound far from the knob: it waits
      filter[1].setNumericValue('cutoff', cutoffAt(at < 64 ? 127 : 0));
      learnActions.learn('filter.cutoff');
      cc(74, at);
      expect(learnModel.mark('filter.cutoff').pickup).not.toBeNull();
      filter[1].setNumericValue('cutoff', cutoffAt(at));
      expect(learnModel.mark('filter.cutoff').pickup).toBeNull();
      cc(74, at + turn);
      expect(filter[0].$filter.value.cutoff).toBe(cutoffAt(at + turn));
    });

    it('catches a stepped knob while the controller is on its step (Oct)', () => {
      const { learnModel, learnActions, cc, osc1 } = setup();
      learnActions.setTakeover('pickup');
      learnActions.learn('osc1.oct');
      // Oct at 0: the CC 53–74 put it there
      cc(82, 56);
      expect(learnModel.mark('osc1.oct').pickup).toBeNull();
      cc(82, 40);
      expect(osc1[0].$osc.value.octave).toBe(-1);
    });

    it('takes a knob off the controller when its range changes under the same value (the frames of the table)', () => {
      const { learnModel, learnActions, cc, osc1, knob } = setup();
      const frames = (count: number) => Array.from({ length: count }, () => [0, 1]);
      osc1[1].setWaveTable(frames(256));
      learnActions.learn('osc1.wave');
      // CC 30 of 127 on 256 frames: 60 (Jump, then Pickup: the controller has it)
      cc(30, 30);
      learnActions.setTakeover('pickup');
      expect(osc1[0].$position.value).toBe(60);
      // on 64 frames 60 is near the top: the controller has it no more
      osc1[1].setWaveTable(frames(64));
      expect(osc1[0].$position.value).toBe(60);
      expect(learnModel.mark('osc1.wave').pickup).toBeCloseTo(30 / 127, 10);
      cc(30, 31);
      expect(osc1[0].$position.value).toBe(60);
      // the CC passes it
      cc(30, 125);
      expect(osc1[0].$position.value).toBe(knobValue(knob('osc1.wave').def(), ccShare(125)));
    });

    it('takes a knob of the filter off the controller when the type changes its range (Res of a bandpass)', () => {
      const { learnModel, learnActions, cc, filter } = setup();
      learnActions.learn('filter.resonance');
      cc(71, 40);
      learnActions.setTakeover('pickup');
      expect(learnModel.mark('filter.resonance').pickup).toBeNull();
      filter[1].setType('bandpass');
      expect(learnModel.mark('filter.resonance').pickup).toBeCloseTo(40 / 127, 10);
    });

    it('takes LFO Rate in BPM off the controller when TRIP changes its steps under the same division', () => {
      const { learnModel, learnActions, cc, lfos, knob } = setup();
      const rate = knob('lfo1.rate');
      lfos[1].setBpm('lfo1', true);
      learnActions.learn('lfo1.rate');
      // CC 26 of 127: the step 2 of 12, the division 3 (Jump, then Pickup: the controller has it)
      cc(30, 26);
      learnActions.setTakeover('pickup');
      expect(rate.get()).toBe(3);
      // TRIP: the division 3 is the step 4 of 25, the CC 26 puts the knob on the step 5
      lfos[1].setTrip('lfo1', true);
      expect(rate.get()).toBe(3);
      expect(learnModel.mark('lfo1.rate').pickup).toBeCloseTo(26 / 127, 10);
      cc(30, 27);
      expect(rate.get()).toBe(3);
    });

    it('in Jump shows no controller and moves the knob at once', () => {
      const { learnModel, learnActions, cc, filter, cutoffAt } = setup();
      learnActions.setTakeover('pickup');
      learnActions.learn('filter.cutoff');
      cc(74, 120);
      expect(learnModel.mark('filter.cutoff').pickup).not.toBeNull();
      learnActions.setTakeover('jump');
      expect(learnModel.mark('filter.cutoff').pickup).toBeNull();
      cc(74, 10);
      expect(filter[0].$filter.value.cutoff).toBe(cutoffAt(10));
    });
  });

  describe('a switch on a button', () => {
    it('toggles at each press of a pad whose release came as it was bound, its release does nothing', () => {
      const { learnModel, learnActions, cc, osc2 } = setup();
      learnActions.learn('osc2.on');
      cc(80, 127);
      cc(80, 0);
      expect(osc2[0].$active.value).toBe(true);
      expect(learnModel.$toggles.value.has('osc2.on')).toBe(true);
      expect(stored().toggles).toEqual(['osc2.on']);
      cc(80, 127);
      expect(osc2[0].$active.value).toBe(false);
      cc(80, 0);
      expect(osc2[0].$active.value).toBe(false);
      cc(80, 127);
      expect(osc2[0].$active.value).toBe(true);
    });

    it('sets by value when the release comes later than the window, or a fader moves on', () => {
      const { learnModel, learnActions, cc, osc2 } = setup();
      learnActions.learn('osc2.on');
      cc(80, 127);
      jest.advanceTimersByTime(TOGGLE_WINDOW);
      cc(80, 0);
      expect(osc2[0].$active.value).toBe(false);
      expect(learnModel.$toggles.value.size).toBe(0);
      learnActions.learn('delay.on');
      cc(81, 100);
      cc(81, 99);
      cc(81, 0);
      expect(learnModel.$toggles.value.size).toBe(0);
      expect(stored().toggles).toBeUndefined();
    });

    it('toggles at every value over the half of a pad that sends no release, once its menu says so', () => {
      const { learnModel, learnActions, cc, osc2 } = setup();
      learnActions.learn('osc2.on');
      cc(80, 127);
      cc(80, 127);
      expect(osc2[0].$active.value).toBe(true);
      learnActions.setToggle('osc2.on', true);
      cc(80, 127);
      expect(osc2[0].$active.value).toBe(false);
      cc(80, 127);
      expect(osc2[0].$active.value).toBe(true);
      // (a knob, a switch of no CC: no toggle)
      learnActions.setToggle('filter.cutoff', true);
      learnActions.setToggle('delay.on', true);
      expect([...learnModel.$toggles.value]).toEqual(['osc2.on']);
      learnActions.setToggle('osc2.on', false);
      cc(80, 0);
      expect(osc2[0].$active.value).toBe(false);
    });

    it('keeps the toggles in the map, drops one whose CC is gone, reads a map without them', () => {
      localStorage.setItem(
        'midiMap',
        JSON.stringify({
          takeover: 'jump',
          bindings: { 80: 'osc2.on', 81: 'delay.on', 74: 'filter.cutoff' },
          toggles: ['osc2.on', 'filter.cutoff', 'gone.switch', 'sub.on'],
        })
      );
      const { learnModel, learnActions } = setup();
      expect([...learnModel.$toggles.value]).toEqual(['osc2.on']);
      learnActions.remove('osc2.on');
      expect(learnModel.$toggles.value.size).toBe(0);
      expect(stored().toggles).toBeUndefined();
      localStorage.setItem('midiMap', JSON.stringify({ takeover: 'jump', bindings: { 80: 'osc2.on' } }));
      expect(setup().learnModel.$bindings.value).toEqual({ 80: 'osc2.on' });
    });

    it('sets by value a switch a knob bound, turned down across the half at once', () => {
      const { learnModel, learnActions, cc, osc2 } = setup();
      learnActions.learn('osc2.on');
      cc(80, 64);
      expect(osc2[0].$active.value).toBe(true);
      cc(80, 63);
      expect(learnModel.$toggles.value.size).toBe(0);
      expect(osc2[0].$active.value).toBe(false);
      cc(80, 64);
      expect(osc2[0].$active.value).toBe(true);
    });

    it('binding the switch again sets it by value until its release comes', () => {
      const { learnModel, learnActions, cc } = setup();
      learnActions.learn('osc2.on');
      cc(80, 127);
      cc(80, 0);
      learnActions.learn('osc2.on');
      cc(82, 127);
      expect(learnModel.$toggles.value.size).toBe(0);
    });
  });

  describe('a control the screen disables', () => {
    it('is not moved by its CC (Anchor out of Free, TRIP out of BPM, Warp with its mode Off, Gain of a lowpass)', () => {
      const { learnActions, cc, lfos, osc1, filter, fx } = setup();
      const bind = (id: string, number: number) => {
        learnActions.learn(id);
        cc(number, 0);
      };
      fx[1].setAdded('delay', true);
      lfos[1].setMode('lfo1', 'retrig');
      bind('lfo1.host', 90);
      bind('lfo1.trip', 91);
      bind('osc1.warp', 92);
      bind('filter.gain', 93);
      fx[1].setParam('delay', 'sync', 0);
      bind('delay.trip', 94);
      const before = {
        lfo: lfos[0].$lfos.value.lfo1,
        warp: osc1[0].$warp.value,
        gain: filter[0].$filter.value.gain,
        delay: fx[0].$effects.value.delay.params['trip'],
      };
      [90, 91, 92, 93, 94].forEach((number) => cc(number, 127));
      expect(lfos[0].$lfos.value.lfo1).toBe(before.lfo);
      expect(osc1[0].$warp.value).toBe(before.warp);
      expect(filter[0].$filter.value.gain).toBe(before.gain);
      expect(fx[0].$effects.value.delay.params['trip']).toBe(before.delay);

      // enabled: they move
      lfos[1].setMode('lfo1', 'free');
      lfos[1].setBpm('lfo1', true);
      osc1[1].setWarpMode(1);
      filter[1].setType('lowshelf');
      fx[1].setParam('delay', 'sync', 1);
      [90, 91, 92, 93, 94].forEach((number) => {
        cc(number, 0);
        cc(number, 127);
      });
      expect(lfos[0].$lfos.value.lfo1.host).toBe(true);
      expect(lfos[0].$lfos.value.lfo1.trip).toBe(true);
      expect(osc1[0].$warp.value).toBe(1);
      expect(filter[0].$filter.value.gain).toBe(40);
      expect(fx[0].$effects.value.delay.params['trip']).toBe(1);
    });

    it('is not moved by its CC while its effect is out of the rack or off, nor the Gain of an EQ band that is a pass', () => {
      const { learnActions, cc, fx } = setup();
      const [fxModel, fxActions] = fx;
      const bind = (id: string, number: number) => {
        learnActions.learn(id);
        cc(number, 0);
      };
      const turn = (number: number) => {
        cc(number, 0);
        cc(number, 127);
      };
      const delay = () => fxModel.$effects.value.delay;
      const gain = () => fxModel.$effects.value.eq.params['g1'];
      bind('delay.on', 102);
      bind('delay.fb', 103);
      bind('delay.mix', 104);
      bind('eq.g1', 105);
      const before = { delay: delay(), gain: gain() };
      // out of the rack
      [102, 103, 104].forEach(turn);
      cc(102, 0);
      expect(delay()).toBe(before.delay);
      // in the rack, off: its switch only
      fxActions.setAdded('delay', true);
      fxActions.setOn('delay', false);
      [103, 104].forEach(turn);
      expect(delay().params['fb']).toBe(before.delay.params['fb']);
      expect(delay().mix).toBe(before.delay.mix);
      turn(102);
      expect(delay().on).toBe(true);
      // on: they move
      [103, 104].forEach(turn);
      expect(delay().params['fb']).not.toBe(before.delay.params['fb']);
      expect(delay().mix).not.toBe(before.delay.mix);

      fxActions.setAdded('eq', true);
      fxActions.setParam('eq', 't1', 2);
      turn(105);
      expect(gain()).toBe(before.gain);
      fxActions.setParam('eq', 't1', 0);
      turn(105);
      expect(gain()).not.toBe(before.gain);
    });

    it('is not moved by its CC where the type of the FX Filter reads none (Res and Fat of Low 6, Fat of a notch)', () => {
      const { learnActions, cc, fx } = setup();
      const [fxModel, fxActions] = fx;
      const params = () => fxModel.$effects.value.fxfilter.params;
      const turn = (number: number) => {
        cc(number, 0);
        cc(number, 127);
      };
      fxActions.setAdded('fxfilter', true);
      learnActions.learn('fxfilter.res');
      cc(106, 0);
      learnActions.learn('fxfilter.var');
      cc(107, 0);
      fxActions.setParam('fxfilter', 'type', fxFilterIndexOf('low6'));
      [106, 107].forEach(turn);
      expect(params()['res']).toBe(0);
      expect(params()['var']).toBe(0);
      fxActions.setParam('fxfilter', 'type', fxFilterIndexOf('notch12'));
      [106, 107].forEach(turn);
      expect(params()['res']).not.toBe(0);
      expect(params()['var']).toBe(0);
      fxActions.setParam('fxfilter', 'type', fxFilterIndexOf('low12'));
      turn(107);
      expect(params()['var']).not.toBe(0);
    });

    it('waits for a controller turned while the knob was disabled (Pickup), takes the same value again (Jump)', () => {
      const { learnModel, learnActions, cc, fx, knob } = setup();
      const [fxModel, fxActions] = fx;
      const feedback = () => fxModel.$effects.value.delay.params['fb'];
      const at = (value: number) => knobValue(knob('delay.fb').def(), ccShare(value));
      fxActions.setAdded('delay', true);
      learnActions.learn('delay.fb');
      cc(103, 30);
      learnActions.setTakeover('pickup');
      cc(103, 31);
      expect(feedback()).toBe(at(31));
      // turned while the delay is off: the controller shows, the knob waits for it
      fxActions.setOn('delay', false);
      cc(103, 120);
      expect(feedback()).toBe(at(31));
      expect(learnModel.mark('delay.fb').pickup).toBeCloseTo(120 / 127, 10);
      fxActions.setOn('delay', true);
      cc(103, 121);
      expect(feedback()).toBe(at(31));
      // the CC passes it
      cc(103, 32);
      expect(feedback()).toBe(at(32));
      expect(learnModel.mark('delay.fb').pickup).toBeNull();

      // Jump: the same value again after the delay is on moves it
      learnActions.setTakeover('jump');
      fxActions.setOn('delay', false);
      cc(103, 100);
      fxActions.setOn('delay', true);
      cc(103, 100);
      expect(feedback()).toBe(at(100));
    });
  });

  describe('another tab', () => {
    it('takes the map another tab wrote and writes nothing back', () => {
      const { learnModel } = setup();
      const map = {
        takeover: 'pickup',
        bindings: { 74: 'filter.cutoff', 80: 'osc2.on' },
        toggles: ['osc2.on'],
      };
      localStorage.setItem('midiMap', JSON.stringify(map));
      const write = jest.spyOn(Storage.prototype, 'setItem');
      window.dispatchEvent(new StorageEvent('storage', { key: 'midiMap' }));
      expect(learnModel.$bindings.value).toEqual({ 74: 'filter.cutoff', 80: 'osc2.on' });
      expect(learnModel.$takeover.value).toBe('pickup');
      expect([...learnModel.$toggles.value]).toEqual(['osc2.on']);
      expect(learnModel.mark('filter.cutoff').cc).toBe(74);
      expect(learnModel.mark('macro1').cc).toBeNull();
      expect(write).not.toHaveBeenCalledWith('midiMap', expect.anything());
      write.mockRestore();
      // its map removed: the defaults
      localStorage.removeItem('midiMap');
      window.dispatchEvent(new StorageEvent('storage', { key: 'midiMap' }));
      expect(learnModel.$bindings.value[20]).toBe('macro1');
      // another key: nothing
      window.dispatchEvent(new StorageEvent('storage', { key: 'other' }));
      expect(learnModel.$bindings.value[20]).toBe('macro1');
    });
  });

  describe('marks', () => {
    it('tells the listeners of a control only of its own changes', () => {
      const { learnModel, learnActions, cc } = setup();
      const gain = jest.fn();
      const other = jest.fn();
      const stop = learnModel.subscribe('osc1.gain', gain);
      learnModel.subscribe('osc2.gain', other);
      learnActions.learn('osc1.gain');
      cc(7, 3);
      expect(gain).toHaveBeenCalledTimes(3);
      expect(other).not.toHaveBeenCalled();
      stop();
      learnActions.remove('osc1.gain');
      expect(gain).toHaveBeenCalledTimes(3);
    });
  });

  describe('analytics', () => {
    it('counts a binding and a CC that moves a control, not the map of the browser', () => {
      const analytics = recordAnalytics();
      const { learnActions, cc } = setup();
      expect(analytics.features()).toEqual([]);
      learnActions.learn('osc1.gain');
      cc(7, 3);
      expect(analytics.features()).toEqual(['midi_learn:menu', 'input:cc']);
    });

    describe('what the values of a CC bound are', () => {
      const kinds = (analytics: ReturnType<typeof recordAnalytics>) =>
        analytics.features().filter((key) => key.startsWith('midi_learn:cc_'));

      it('tells them after a pause of the CC (another CC does not keep them on)', () => {
        const analytics = recordAnalytics();
        const { learnActions, cc } = setup();
        learnActions.learn('osc1.gain');
        [40, 41, 42, 43, 44, 45, 46].forEach((value) => cc(7, value));
        cc(30, 10);
        jest.advanceTimersByTime(CC_IDLE - 2 * CC_INTERVAL - 1);
        expect(kinds(analytics)).toEqual([]);
        jest.advanceTimersByTime(1);
        expect(kinds(analytics)).toEqual(['midi_learn:cc_absolute']);
      });

      it('tells them at the next bind', () => {
        const analytics = recordAnalytics();
        const { learnActions, cc } = setup();
        learnActions.learn('osc1.gain');
        [65, 65, 65, 66, 65, 63, 63].forEach((value) => cc(8, value));
        learnActions.learn('osc1.wave');
        cc(9, 127);
        expect(kinds(analytics)).toEqual(['midi_learn:cc_relative']);
        // (a pad pressed and released)
        cc(9, 0);
        jest.advanceTimersByTime(CC_IDLE);
        expect(kinds(analytics)).toEqual(['midi_learn:cc_relative', 'midi_learn:cc_button']);
      });

      it('tells them at MAX_VALUES, without a pause (a stream)', () => {
        const analytics = recordAnalytics();
        const { learnActions, stream } = setup();
        learnActions.learn('osc1.gain');
        Array.from({ length: MAX_VALUES - 1 }, (_, i) => stream(10, i * 5));
        expect(kinds(analytics)).toEqual([]);
        stream(10, 120);
        expect(kinds(analytics)).toEqual(['midi_learn:cc_absolute']);
      });

      it('tells a CC moved once as few', () => {
        const analytics = recordAnalytics();
        const { learnActions, cc } = setup();
        learnActions.learn('osc1.gain');
        cc(7, 40);
        jest.advanceTimersByTime(CC_IDLE);
        expect(kinds(analytics)).toEqual(['midi_learn:cc_few']);
      });

      it('tells an NRPN a control waits through (none of its CCs binds), once a wait', () => {
        const analytics = recordAnalytics();
        const { learnModel, learnActions, stream } = setup();
        learnActions.learn('osc1.gain');
        [99, 98, 6, 38, 99, 98, 6, 38].forEach((number) => stream(number, 1));
        expect(learnModel.$learning.value?.target).toBe('osc1.gain');
        expect(kinds(analytics)).toEqual(['midi_learn:cc_nrpn']);
        // a data entry alone (no number before it) is none
        learnActions.learn('osc1.wave');
        stream(6, 1);
        expect(analytics.features().filter((key) => key === 'midi_learn:cc_nrpn')).toHaveLength(1);
      });

      it('tells nothing once the model is gone', () => {
        const analytics = recordAnalytics();
        const { learnActions, cc } = setup();
        learnActions.learn('osc1.gain');
        cc(7, 40);
        stopModels();
        jest.advanceTimersByTime(CC_IDLE);
        expect(kinds(analytics)).toEqual([]);
      });
    });
  });
});
