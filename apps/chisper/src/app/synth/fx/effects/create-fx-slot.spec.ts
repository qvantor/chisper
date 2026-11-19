import { BehaviorSubject } from 'rxjs';
import { mapValues, omit } from 'lodash';
import { divisionIndex, FX_TYPES, FxType, TEMPO_DEFAULT } from '@chisper/preset-schema';
import { chainNode, chainPosts, chainReports, flushChain as flush } from '../../../../test-utils/chain-node';
import { Chain, createChain } from '../../common/chain/chain';
import { CHAIN_KEYS, FX_KINDS, NEUTRAL_PARAMS } from '../../common/chain/chain-params';
import { createEngineNode } from '../../common/engine/engine-node';
import { createFxSlot } from './create-fx-slot';
import { DELAY_LINE_MAX } from './delay-params';
import { REVERB_ERAS } from './reverb-era';
import { FxDefinition, FxStatus } from './types';
import { FX_REGISTRY } from './index';

const RATE = 48000;
const slotOf = (type: FxType) => FX_KINDS.indexOf(type);
const defaults = (type: FxType) => mapValues(FX_REGISTRY[type].params, (param) => param.default);

// a chain that records what a slot tells it
const fakeChain = () => {
  const $status = new BehaviorSubject<FxStatus>('loading');
  const chain = {
    status: jest.fn(() => $status),
    retry: jest.fn(),
    retryStage: jest.fn(),
    setParams: jest.fn(),
    setMix: jest.fn(),
    setActive: jest.fn(),
    watch: jest.fn(),
  };
  return { chain, $status, asChain: chain as unknown as Chain };
};

// an effect of two knobs whose core takes one doubled, the tempo and the rate with them
const definition = (metered?: boolean): FxDefinition => ({
  label: 'Test',
  params: {
    a: { label: 'A', min: 0, max: 10, default: 1 },
    b: { label: 'B', min: 0, max: 10, default: 2 },
  },
  presets: [],
  core: jest.fn(({ a, b }, bpm, sampleRate) => ({ a, double: b * 2, bpm, sampleRate })),
  metered,
});

const setup = (type: FxType) => {
  const { chain, $status, asChain } = fakeChain();
  const slot = createFxSlot(asChain, slotOf(type), FX_REGISTRY[type], RATE);
  const sent = () => chain.setParams.mock.lastCall?.[1] as Record<string, number>;
  return { chain, $status, slot, sent };
};

describe('createFxSlot', () => {
  it('tells the chain the defaults of its knobs as the core takes them, at the default tempo', () => {
    const { chain, asChain } = fakeChain();
    const test = definition();
    createFxSlot(asChain, 3, test, RATE);
    expect(test.core).toHaveBeenCalledWith({ a: 1, b: 2 }, TEMPO_DEFAULT, RATE);
    expect(chain.setParams.mock.calls).toEqual([
      [3, { a: 1, double: 4, bpm: TEMPO_DEFAULT, sampleRate: RATE }],
    ]);
    // its mix and whether it plays are the fx model's to tell
    expect(chain.setMix).not.toHaveBeenCalled();
    expect(chain.setActive).not.toHaveBeenCalled();
  });

  it('setParams merges the knobs it is given into the others, falsy values included', () => {
    const { chain, asChain } = fakeChain();
    const slot = createFxSlot(asChain, 1, definition(), 44100);
    slot.setParams({ b: 0 });
    expect(chain.setParams).toHaveBeenLastCalledWith(1, {
      a: 1,
      double: 0,
      bpm: TEMPO_DEFAULT,
      sampleRate: 44100,
    });
    slot.setParams({ a: 7 });
    expect(chain.setParams).toHaveBeenLastCalledWith(1, {
      a: 7,
      double: 0,
      bpm: TEMPO_DEFAULT,
      sampleRate: 44100,
    });
    slot.setParams({ a: 0, b: 5 });
    expect(chain.setParams).toHaveBeenLastCalledWith(1, {
      a: 0,
      double: 10,
      bpm: TEMPO_DEFAULT,
      sampleRate: 44100,
    });
    expect(chain.setParams).toHaveBeenCalledTimes(4);
  });

  it('setTempo gives the core its params again at the new tempo, the knobs as they are', () => {
    const { chain, asChain } = fakeChain();
    const slot = createFxSlot(asChain, 0, definition(), RATE);
    slot.setParams({ a: 3 });
    slot.setTempo(90);
    expect(chain.setParams).toHaveBeenLastCalledWith(0, { a: 3, double: 4, bpm: 90, sampleRate: RATE });
    // a knob turned later is at that tempo too
    slot.setParams({ b: 1 });
    expect(chain.setParams).toHaveBeenLastCalledWith(0, { a: 3, double: 2, bpm: 90, sampleRate: RATE });
  });

  it('setMix and setActive are those of its slot in the chain', () => {
    const { chain, asChain } = fakeChain();
    const slot = createFxSlot(asChain, 2, definition(), RATE);
    slot.setMix(0);
    slot.setMix(0.4);
    slot.setActive(true);
    slot.setActive(false);
    expect(chain.setMix.mock.calls).toEqual([
      [2, 0],
      [2, 0.4],
    ]);
    expect(chain.setActive.mock.calls).toEqual([
      [2, true],
      [2, false],
    ]);
    // (not params of the effect)
    expect(chain.setParams).toHaveBeenCalledTimes(1);
  });

  it('its status is the one of its stage of the chain', () => {
    const { chain, $status, asChain } = fakeChain();
    const slot = createFxSlot(asChain, 4, definition(), RATE);
    expect(chain.status).toHaveBeenCalledWith(4);
    expect(slot.$status).toBe($status);
    $status.next('failed');
    expect(slot.$status.value).toBe('failed');
  });

  it('retry loads the module of the chain again and makes its effect again (each only if it failed)', () => {
    const { chain, asChain } = fakeChain();
    const slot = createFxSlot(asChain, 4, definition(), RATE);
    slot.retry();
    expect(chain.retry).toHaveBeenCalledTimes(1);
    expect(chain.retryStage.mock.calls).toEqual([[4]]);
  });

  describe('the meter', () => {
    it('an effect that tells none has none: the chain is never asked', () => {
      const { chain, asChain } = fakeChain();
      const slot = createFxSlot(asChain, 0, definition(), RATE);
      expect(slot.meter).toBeUndefined();
      expect(() => slot.destroy()).not.toThrow();
      expect(chain.watch).not.toHaveBeenCalled();
    });

    it('the first watcher has the chain watch its slot, the last one to leave stops it', () => {
      const { chain, asChain } = fakeChain();
      const slot = createFxSlot(asChain, 3, definition(true), RATE);
      expect(chain.watch).not.toHaveBeenCalled();
      const unwatch = slot.meter?.watch(jest.fn());
      expect(chain.watch.mock.calls).toEqual([[3, expect.any(Function)]]);
      const unwatchOther = slot.meter?.watch(jest.fn());
      expect(chain.watch).toHaveBeenCalledTimes(1);
      unwatch?.();
      expect(chain.watch).toHaveBeenCalledTimes(1);
      unwatchOther?.();
      expect(chain.watch.mock.calls[1]).toEqual([3, null]);
      // (once: a watcher that leaves twice tells nothing)
      unwatch?.();
      unwatchOther?.();
      expect(chain.watch).toHaveBeenCalledTimes(2);
    });

    it('gives every watcher what the chain tells of its slot', () => {
      const { chain, asChain } = fakeChain();
      const slot = createFxSlot(asChain, 3, definition(true), RATE);
      const [first, second] = [jest.fn(), jest.fn()];
      const unwatch = slot.meter?.watch(first);
      slot.meter?.watch(second);
      const tell = chain.watch.mock.calls[0][1] as (values: unknown) => void;
      tell({ reduction: [0, 1, 2] });
      expect(first.mock.calls).toEqual([[{ reduction: [0, 1, 2] }]]);
      expect(second.mock.calls).toEqual([[{ reduction: [0, 1, 2] }]]);
      unwatch?.();
      tell({ reduction: [3] });
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenLastCalledWith({ reduction: [3] });
    });

    it('destroy forgets the watchers and has the chain stop watching: one that leaves after it tells nothing', () => {
      const { chain, asChain } = fakeChain();
      const slot = createFxSlot(asChain, 1, definition(true), RATE);
      const listener = jest.fn();
      const unwatch = slot.meter?.watch(listener);
      const tell = chain.watch.mock.calls[0][1] as (values: unknown) => void;
      slot.destroy();
      expect(chain.watch.mock.calls[1]).toEqual([1, null]);
      tell({ lfo: 0.5 });
      expect(listener).not.toHaveBeenCalled();
      unwatch?.();
      expect(chain.watch).toHaveBeenCalledTimes(2);
    });

    it('the compressor and the chorus tell a meter, the other effects none', () => {
      const meters = FX_TYPES.filter((type) => setup(type).slot.meter !== undefined);
      expect(meters).toEqual(['chorus', 'compressor']);
    });
  });

  describe('the effects of the registry', () => {
    it.each(FX_TYPES)('%s: its core gets the keys of its kind, a number each', (type) => {
      const { chain, sent } = setup(type);
      expect(chain.setParams).toHaveBeenCalledWith(slotOf(type), expect.any(Object));
      // (a core that mixes inside has its mix from its slot, not as a knob)
      const keys = CHAIN_KEYS[type].filter((key) => key !== 'mix');
      expect(Object.keys(sent()).sort()).toEqual([...keys].sort());
      Object.values(sent()).forEach((value) => expect(Number.isFinite(value)).toBe(true));
    });

    it.each(FX_TYPES)('%s: its defaults are the params a chain starts with', (type) => {
      const { sent } = setup(type);
      expect(NEUTRAL_PARAMS[type]).toMatchObject(sent());
    });

    it('the distortion and the compressor: their knobs as they are', () => {
      const distortion = setup('distortion');
      distortion.slot.setParams({ mode: 2, drive: 0, level: -6 });
      expect(distortion.sent()).toEqual({ ...defaults('distortion'), mode: 2, drive: 0, level: -6 });

      const compressor = setup('compressor');
      compressor.slot.setParams({ multi: 1, thresh: 0, below: 0.5 });
      compressor.slot.setTempo(60);
      expect(compressor.sent()).toEqual({ ...defaults('compressor'), multi: 1, thresh: 0, below: 0.5 });
    });

    it('the delay: Time as the seconds of its echoes, in BPM those of its division at the tempo', () => {
      const { slot, sent } = setup('delay');
      slot.setParams({ time: 0.4, fb: 0, pan: -0.02, mode: 1 });
      expect(sent()).toEqual({ time: 0.4, fb: 0, mode: 1, pan: -0.02, freq: 1000, q: 0.01 });
      // in MS the tempo changes nothing
      slot.setTempo(60);
      expect(sent()['time']).toBe(0.4);

      slot.setTempo(120);
      slot.setParams({ sync: 1, div: divisionIndex('1/4') });
      expect(sent()['time']).toBe(0.5);
      // the switches of BPM are not knobs of the core
      expect(Object.keys(sent()).sort()).toEqual([...CHAIN_KEYS.delay].sort());
      slot.setTempo(60);
      expect(sent()['time']).toBe(1);
      slot.setTempo(150);
      expect(sent()['time']).toBeCloseTo(0.4, 12);
      // a division longer than a line plays as long as the line
      slot.setParams({ div: divisionIndex('1 bar') });
      slot.setTempo(30);
      expect(sent()['time']).toBe(DELAY_LINE_MAX);
      // back in MS: the knob again
      slot.setParams({ sync: 0 });
      expect(sent()['time']).toBe(0.4);
    });

    it('the delay: a triplet or a dotted division only with its switch, else the straight one', () => {
      const { slot, sent } = setup('delay');
      slot.setParams({ sync: 1, trip: 1, div: divisionIndex('1/8T') });
      expect(sent()['time']).toBeCloseTo(1 / 6, 12);
      slot.setParams({ trip: 0 });
      expect(sent()['time']).toBe(0.25);
      slot.setParams({ dot: 1, div: divisionIndex('1/4D') });
      expect(sent()['time']).toBe(0.75);
    });

    it('the chorus: Rate as the Hz of its LFO, in BPM a cycle a division at the tempo', () => {
      const { slot, sent } = setup('chorus');
      slot.setParams({ rate: 0.5, depth: 0, fb: 0, hpf: 1 });
      expect(sent()).toEqual({ rate: 0.5, d1: 5, d2: 0, depth: 0, fb: 0, cut: 1000, hpf: 1, level: 0.5 });
      slot.setTempo(60);
      expect(sent()['rate']).toBe(0.5);

      slot.setTempo(120);
      slot.setParams({ sync: 1, div: divisionIndex('1/4') });
      expect(sent()['rate']).toBe(2);
      slot.setTempo(60);
      expect(sent()['rate']).toBe(1);
      slot.setParams({ div: divisionIndex('1 bar') });
      expect(sent()['rate']).toBe(0.25);
      // 1/32 at 300 would be 40 Hz: the top of Rate
      slot.setParams({ div: divisionIndex('1/32') });
      slot.setTempo(300);
      expect(sent()['rate']).toBe(FX_REGISTRY.chorus.params['rate'].max);
      slot.setParams({ sync: 0 });
      expect(sent()['rate']).toBe(0.5);
    });

    it('the reverb: its era as the drive, the bandwidth and the body of its input stage', () => {
      const { slot, sent } = setup('reverb');
      const knobs = omit(defaults('reverb'), 'era');
      REVERB_ERAS.forEach(({ drive, bandwidth, body }, era) => {
        slot.setParams({ era });
        // Now has the full band: up to half the rate
        expect(sent()).toEqual({ ...knobs, drive, bandwidth: bandwidth ?? RATE / 2, body });
      });
      expect(REVERB_ERAS[0].bandwidth).toBeNull();
      slot.setParams({ era: 0, size: 0, er: 0 });
      expect(sent()).toMatchObject({ size: 0, er: 0, drive: 0, bandwidth: 24000, body: 0 });
      expect(sent()).not.toHaveProperty('era');
    });

    it('the reverb: the full band is the one of the rate of its context', () => {
      const { chain, asChain } = fakeChain();
      const slot = createFxSlot(asChain, slotOf('reverb'), FX_REGISTRY.reverb, 44100);
      slot.setParams({ era: 0 });
      expect(chain.setParams.mock.lastCall?.[1]['bandwidth']).toBe(22050);
      // an era out of the list is the nearest one
      slot.setParams({ era: 9 });
      expect(chain.setParams.mock.lastCall?.[1]['bandwidth']).toBe(
        REVERB_ERAS[REVERB_ERAS.length - 1].bandwidth
      );
    });
  });

  describe('on the chain', () => {
    const onChain = async () => {
      const audioCtx = new AudioContext();
      const chain = createChain(audioCtx, createEngineNode(audioCtx));
      const slots = Object.fromEntries(
        FX_TYPES.map((type) => [
          type,
          createFxSlot(chain, slotOf(type), FX_REGISTRY[type], audioCtx.sampleRate),
        ])
      ) as Record<FxType, ReturnType<typeof createFxSlot>>;
      const before = FX_TYPES.map((type) => slots[type].$status.value);
      await flush();
      const node = chainNode(audioCtx);
      return { audioCtx, chain, slots, node, before, posts: () => chainPosts(node) };
    };

    it('the slots take the status of the chain: loading, then ready', async () => {
      const { slots, before } = await onChain();
      expect(before).toEqual(FX_TYPES.map(() => 'loading'));
      expect(FX_TYPES.map((type) => slots[type].$status.value)).toEqual(FX_TYPES.map(() => 'ready'));
    });

    it('a slot made after the node tells it nothing: the defaults are what the chain starts with', async () => {
      const { audioCtx, chain, node, posts } = await onChain();
      expect(node.options.processorOptions.state.slots).toEqual(
        mapValues(NEUTRAL_PARAMS, (params) => ({ params, mix: 1, active: false }))
      );
      FX_TYPES.forEach((type) => createFxSlot(chain, slotOf(type), FX_REGISTRY[type], audioCtx.sampleRate));
      expect(posts()).toEqual([]);
    });

    it('a knob reaches the node as the param of its slot that changed', async () => {
      const { slots, posts } = await onChain();
      slots.delay.setParams({ time: 0.5 });
      slots.delay.setParams({ time: 0.5, fb: 0 });
      slots.reverb.setParams({ decay: 5 });
      slots.reverb.setParams({ decay: 5 });
      slots.distortion.setMix(0.5);
      slots.compressor.setActive(true);
      expect(posts()).toEqual([
        { params: [slotOf('delay'), { time: 0.5 }] },
        { params: [slotOf('delay'), { fb: 0 }] },
        { params: [slotOf('reverb'), { decay: 5 }] },
        { mix: [slotOf('distortion'), 0.5] },
        { active: [slotOf('compressor'), true] },
      ]);
    });

    it('the tempo reaches the node only as the knob in BPM it moves', async () => {
      const { slots, posts } = await onChain();
      FX_TYPES.forEach((type) => slots[type].setTempo(60));
      expect(posts()).toEqual([]);
      slots.delay.setParams({ sync: 1, div: divisionIndex('1/4') });
      slots.chorus.setParams({ sync: 1, div: divisionIndex('1 bar') });
      FX_TYPES.forEach((type) => slots[type].setTempo(120));
      expect(posts()).toEqual([
        { params: [slotOf('delay'), { time: 1 }] },
        { params: [slotOf('chorus'), { rate: 0.25 }] },
        { params: [slotOf('chorus'), { rate: 0.5 }] },
        { params: [slotOf('delay'), { time: 0.5 }] },
      ]);
    });

    it('an era of the reverb reaches the node as the values of its stage that changed', async () => {
      const { audioCtx, slots, posts } = await onChain();
      slots.reverb.setParams({ era: 0 });
      slots.reverb.setParams({ era: 2 });
      expect(posts()).toEqual([
        { params: [slotOf('reverb'), { bandwidth: audioCtx.sampleRate / 2, body: 0 }] },
        { params: [slotOf('reverb'), { drive: 0.15, bandwidth: 6500, body: 2 }] },
      ]);
    });

    it('an effect that failed in the core is failed alone, its retry has it made again', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { slots, node, posts } = await onChain();
      chainReports(node, { failed: [slotOf('reverb')] });
      expect(slots.reverb.$status.value).toBe('failed');
      expect(slots.delay.$status.value).toBe('ready');
      slots.delay.retry();
      expect(posts()).toEqual([]);
      slots.reverb.retry();
      expect(posts()).toEqual([{ retry: slotOf('reverb') }]);
      // (ready once the node tells its unit is made)
      expect(slots.reverb.$status.value).toBe('loading');
      chainReports(node, { remade: slotOf('reverb') });
      expect(slots.reverb.$status.value).toBe('ready');
      jest.restoreAllMocks();
    });

    it('the retry of a slot loads a failed module of the chain again', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const audioCtx = new AudioContext();
      const addModule = audioCtx.audioWorklet.addModule as jest.Mock;
      addModule.mockRejectedValueOnce(new Error('404'));
      const slot = createFxSlot(
        createChain(audioCtx, createEngineNode(audioCtx)),
        slotOf('delay'),
        FX_REGISTRY.delay,
        audioCtx.sampleRate
      );
      await flush();
      expect(slot.$status.value).toBe('failed');
      slot.retry();
      expect(slot.$status.value).toBe('loading');
      expect(addModule).toHaveBeenCalledTimes(2);
      await flush();
      expect(slot.$status.value).toBe('ready');
      jest.restoreAllMocks();
    });

    it('a watched meter is the one the worklet posts of its slot, while it is watched', async () => {
      const { slots, node, posts } = await onChain();
      const [compressor, chorus] = [jest.fn(), jest.fn()];
      const unwatch = slots.compressor.meter?.watch(compressor);
      slots.chorus.meter?.watch(chorus);
      expect(posts()).toEqual([{ meter: [slotOf('compressor'), true] }, { meter: [slotOf('chorus'), true] }]);
      chainReports(node, { meter: [slotOf('compressor'), { reduction: [1] }] });
      chainReports(node, { meter: [slotOf('chorus'), { lfo: 0.25 }] });
      expect(compressor.mock.calls).toEqual([[{ reduction: [1] }]]);
      expect(chorus.mock.calls).toEqual([[{ lfo: 0.25 }]]);

      unwatch?.();
      expect(posts()[2]).toEqual({ meter: [slotOf('compressor'), false] });
      chainReports(node, { meter: [slotOf('compressor'), { reduction: [2] }] });
      expect(compressor).toHaveBeenCalledTimes(1);
    });
  });
});
