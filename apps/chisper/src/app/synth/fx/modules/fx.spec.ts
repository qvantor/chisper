import { mapValues } from 'lodash';
import { divisionIndex, FX_MIX_PARAM, FX_PARAMS, FX_TYPES, FxType } from '@chisper/preset-schema';
import { applySnapshot, getSnapshot } from '../../../app';
import {
  chainNode,
  chainNodes,
  chainPosts,
  chainReports,
  flushChain as flush,
} from '../../../../test-utils/chain-node';
import { createFx, createSynthCore } from '../../../../test-utils/models';
import { withoutAudioWorklet } from '../../../../test-utils/no-audio-worklet';
import { workletLoads } from '../../../../test-utils/worklet-loads';
import {
  CHAIN_KEYS,
  ChainMessage,
  LFO_KEYS,
  LFO_KNOBS,
  LFO_TARGET,
  MIX_KEY,
  NEUTRAL_PARAMS,
  TARGET_KEYS,
} from '../../common/chain/chain-params';
import { LFO_STATE_INTERVAL } from '../../common/lfo/lfo-curve';
import { MOD_TARGETS } from '../../common/modulation/modulation-targets';
import type { ModRoute } from '../../common/modules/modulation';
import { DELAY_PRESETS } from '../effects/delay-presets';
import { REVERB_PRESETS } from '../effects/reverb-presets';
import { findFxPreset, FxStatus } from '../effects';
import { chainNote, chainRoutes, getChain } from './fx';

// the slot of each effect in the chain
const SLOT = Object.fromEntries(FX_TYPES.map((type, index) => [type, index])) as Record<FxType, number>;
const ALL = (status: FxStatus) => Object.fromEntries(FX_TYPES.map((type) => [type, status]));

// the fx model on the chain of a synth core: what it tells the chain (`told`: the calls of its methods, whether a
// node exists or not)
const setup = (synthCore = createSynthCore()) => {
  const { audioCtx, chain } = synthCore[0];
  const told = {
    setParams: jest.spyOn(chain, 'setParams'),
    setMix: jest.spyOn(chain, 'setMix'),
    setActive: jest.spyOn(chain, 'setActive'),
    setOrder: jest.spyOn(chain, 'setOrder'),
    setRoutes: jest.spyOn(chain, 'setRoutes'),
    setNote: jest.spyOn(chain, 'setNote'),
    clear: jest.spyOn(chain, 'clear'),
  };
  const { fx, transport, modulation, lfos, $fxNote } = createFx(synthCore);
  const [model, actions] = fx;
  // whether the effect plays, as the chain was last told
  const active = (type: FxType) =>
    told.setActive.mock.calls.filter(([slot]) => slot === SLOT[type]).pop()?.[1] ?? false;
  return {
    model,
    actions,
    synthCore: synthCore[0],
    audioCtx,
    chain,
    told,
    active,
    transport,
    modulation,
    lfos,
    $fxNote,
  };
};

// the model once the node of the chain exists: what the node is posted from here on (`posts`: every message,
// `posted`: the values of one of its fields)
const ready = async () => {
  const context = setup();
  await flush();
  const node = chainNode(context.audioCtx);
  node.port.postMessage.mockClear();
  const posts = () => chainPosts(node);
  const posted = <K extends keyof ChainMessage>(field: K) =>
    posts().flatMap((message) => (field in message ? [message[field]] : []));
  return { ...context, node, posts, posted, forget: () => node.port.postMessage.mockClear() };
};

const REVERB_DEFAULTS = mapValues(FX_PARAMS.reverb, (param) => param.default);
// the delay in MS, its division in BPM the default one
const MS = { sync: 0, div: FX_PARAMS.delay.div.default, trip: 0, dot: 0 };
const DISTORTION_DEFAULTS = mapValues(FX_PARAMS.distortion, (param) => param.default);
const COMPRESSOR_DEFAULTS = mapValues(FX_PARAMS.compressor, (param) => param.default);
const CHORUS_DEFAULTS = mapValues(FX_PARAMS.chorus, (param) => param.default);
const defaultReverb = () => ({ mix: FX_MIX_PARAM.default, params: REVERB_DEFAULTS });

describe('fx', () => {
  afterEach(() => jest.restoreAllMocks());

  it('starts with no effect in the chain: the node is made with the defaults of the knobs, nothing playing', async () => {
    const { model, audioCtx, told } = setup();
    expect(model.$effects.value.delay.added).toBe(false);
    await flush();
    const node = chainNode(audioCtx);
    const { state } = node.options.processorOptions;
    expect(state.order).toEqual([]);
    expect(state.slots).toEqual({
      distortion: { params: NEUTRAL_PARAMS.distortion, mix: 1, active: false },
      chorus: { params: NEUTRAL_PARAMS.chorus, mix: 0.5, active: false },
      delay: { params: NEUTRAL_PARAMS.delay, mix: 0.3, active: false },
      compressor: { params: NEUTRAL_PARAMS.compressor, mix: 1, active: false },
      reverb: { params: NEUTRAL_PARAMS.reverb, mix: 0.3, active: false },
    });
    expect(state.routes).toEqual([]);
    expect(state.note).toBeNull();
    // ready: nothing to tell it
    expect(chainPosts(node)).toEqual([]);
    expect(told.setOrder.mock.calls.every(([order]) => order.length === 0)).toBe(true);
  });

  it('setAdded puts the slot of the effect in the chain and takes it out', async () => {
    const { actions, posted } = await ready();
    actions.setAdded('delay', true);
    expect(posted('order')).toEqual([[SLOT.delay]]);
    expect(posted('active')).toEqual([[SLOT.delay, true]]);

    actions.setAdded('delay', false);
    expect(posted('order')).toEqual([[SLOT.delay], []]);
    expect(posted('active')).toEqual([
      [SLOT.delay, true],
      [SLOT.delay, false],
    ]);
  });

  it('does not tell the order again on param changes', async () => {
    const { actions, told, posted } = await ready();
    actions.setAdded('delay', true);
    const calls = told.setOrder.mock.calls.length;
    actions.setParam('delay', 'time', 0.5);
    actions.setMix('delay', 0.5);
    actions.setOn('delay', false);
    expect(told.setOrder).toHaveBeenCalledTimes(calls);
    expect(posted('order')).toEqual([[SLOT.delay]]);
  });

  it('gives the slot its mix, falsy included; bypass changes whether it plays, not its mix', async () => {
    const { model, actions, posted, forget } = await ready();
    actions.setAdded('delay', true);
    forget();
    [0.25, 0.5, 0, 1].forEach((mix) => actions.setMix('delay', mix));
    expect(posted('mix')).toEqual([0.25, 0.5, 0, 1].map((mix) => [SLOT.delay, mix]));
    expect(posted('active')).toEqual([]);

    actions.setOn('delay', false);
    expect(model.$effects.value.delay.on).toBe(false);
    actions.setOn('delay', true);
    expect(posted('active')).toEqual([
      [SLOT.delay, false],
      [SLOT.delay, true],
    ]);
    expect(posted('mix')).toHaveLength(4);
  });

  it('an effect plays while it is in the chain, on and ready', async () => {
    const { actions, active, audioCtx } = setup();
    // loading
    actions.setAdded('delay', true);
    expect(active('delay')).toBe(false);
    await flush();
    expect(active('delay')).toBe(true);
    // (the node was made before the chain was ready: it is told)
    expect(chainPosts(chainNode(audioCtx))).toEqual([{ active: [SLOT.delay, true] }]);

    actions.setOn('delay', false);
    expect(active('delay')).toBe(false);
    actions.setAdded('delay', false);
    actions.setOn('delay', true);
    expect(active('delay')).toBe(false);
    actions.setAdded('delay', true);
    expect(active('delay')).toBe(true);
    actions.setAdded('delay', false);
    expect(active('delay')).toBe(false);
    FX_TYPES.filter((type) => type !== 'delay').forEach((type) => expect(active(type)).toBe(false));
  });

  it('gives the chain the knobs of an effect, in the chain or not: added later it plays them', async () => {
    const { actions, posts } = await ready();
    actions.setParam('delay', 'time', 0.5);
    actions.setParam('reverb', 'decay', 5);
    actions.setParam('delay', 'fb', 0);
    expect(posts()).toEqual([
      { params: [SLOT.delay, { time: 0.5 }] },
      { params: [SLOT.reverb, { decay: 5 }] },
      { params: [SLOT.delay, { fb: 0 }] },
    ]);
  });

  it('the delay in BPM follows the tempo of the transport', async () => {
    const { actions, posted, transport } = await ready();
    actions.setParam('delay', 'sync', 1);
    actions.setParam('delay', 'div', divisionIndex('1/4'));
    expect(posted('params').pop()).toEqual([SLOT.delay, { time: 0.5 }]);
    transport[1].setBpm(60);
    expect(posted('params').pop()).toEqual([SLOT.delay, { time: 1 }]);
  });

  it('a tempo no knob follows tells the chain nothing', async () => {
    const { posts, transport } = await ready();
    transport[1].setBpm(60);
    transport[1].setBpm(140);
    expect(posts()).toEqual([]);
  });

  it('BPM of the delay takes the division nearest to Time at the tempo, MS the seconds of its division', async () => {
    const { model, actions, posted } = await ready();
    const params = () => model.$effects.value.delay.params;
    const time = () => posted('params').pop();
    actions.setParam('delay', 'time', 0.4);
    // 0.8 quarters at 120: 1/4
    actions.setParam('delay', 'sync', 1);
    expect(params()).toMatchObject({ sync: 1, div: divisionIndex('1/4'), time: 0.4 });
    expect(time()).toEqual([SLOT.delay, { time: 0.5 }]);
    // on again: nothing changes
    actions.setParam('delay', 'sync', 1);
    expect(params()['div']).toBe(divisionIndex('1/4'));
    actions.setParam('delay', 'div', divisionIndex('1/16'));
    actions.setParam('delay', 'sync', 0);
    expect(params()).toMatchObject({ sync: 0, div: divisionIndex('1/16'), time: 0.125 });
    expect(time()).toEqual([SLOT.delay, { time: 0.125 }]);
    // a bar is 2 s at 120: Time within its range (1 s)
    actions.setParam('delay', 'sync', 1);
    actions.setParam('delay', 'div', divisionIndex('1 bar'));
    actions.setParam('delay', 'sync', 0);
    expect(params()).toMatchObject({ sync: 0, time: FX_PARAMS.delay.time.max });
    expect(time()).toEqual([SLOT.delay, { time: FX_PARAMS.delay.time.max }]);
  });

  it('TRIP or DOT of the delay switched off takes the straight division of a triplet or a dotted one', async () => {
    const { model, actions, posted } = await ready();
    const params = () => model.$effects.value.delay.params;
    actions.setParam('delay', 'sync', 1);
    actions.setParam('delay', 'trip', 1);
    actions.setParam('delay', 'div', divisionIndex('1/8T'));
    actions.setParam('delay', 'trip', 0);
    expect(params()).toMatchObject({ trip: 0, div: divisionIndex('1/8') });
    expect(posted('params').pop()).toEqual([SLOT.delay, { time: 0.25 }]);
    // on again: the straight one stays
    actions.setParam('delay', 'trip', 1);
    expect(params()['div']).toBe(divisionIndex('1/8'));
    actions.setParam('delay', 'dot', 1);
    actions.setParam('delay', 'div', divisionIndex('1/4D'));
    actions.setParam('delay', 'dot', 0);
    expect(params()).toMatchObject({ dot: 0, div: divisionIndex('1/4') });
    // a preset sets its params as they are
    actions.applyPreset('delay', DELAY_PRESETS[0].id);
    expect(params()).toEqual(DELAY_PRESETS[0].params);
  });

  it('gives the meters the longest gap between two echoes of the delay while it sounds', async () => {
    const { model, actions, transport } = await ready();
    const gaps: number[] = [];
    model.$echoGap.subscribe((gap) => gaps.push(gap));
    actions.setAdded('delay', true);
    actions.setParam('delay', 'sync', 1);
    actions.setParam('delay', 'div', divisionIndex('1 bar'));
    transport[1].setBpm(60);
    actions.setOn('delay', false);
    // Time and its pan (50 ms): 0.2 s, 1/8 at 120, a bar at 120 and at 60
    expect(gaps).toEqual([0, 0.25, 0.3, 2.05, 4.05, 0]);
  });

  it('the gap of the echoes: none until the delay is ready, up to where a route may move Time', async () => {
    const { model, actions, modulation } = setup();
    const gaps: number[] = [];
    model.$echoGap.subscribe((gap) => gaps.push(gap));
    actions.setAdded('delay', true);
    expect(gaps).toEqual([0]);
    await flush();
    expect(gaps).toEqual([0, 0.25]);
    // a route to Time: up to the top of the knob
    modulation[1].addRoute('env2', 'delay.time', 0.5);
    expect(gaps).toEqual([0, 0.25, 1.05]);
    // one switched off moves nothing
    modulation[1].setOff('env2', 'delay.time', true);
    expect(gaps).toEqual([0, 0.25, 1.05, 0.25]);
  });

  it('tells the chain only the values that changed', async () => {
    const { actions, posts, forget } = await ready();
    actions.setAdded('delay', true);
    forget();

    actions.setParam('delay', 'time', 0.5);
    expect(posts()).toEqual([{ params: [SLOT.delay, { time: 0.5 }] }]);
    actions.setMix('delay', 0.5);
    expect(posts()).toEqual([{ params: [SLOT.delay, { time: 0.5 }] }, { mix: [SLOT.delay, 0.5] }]);
    // the same values again: nothing
    actions.setParam('delay', 'time', 0.5);
    actions.setMix('delay', 0.5);
    actions.setOn('delay', true);
    actions.setAdded('delay', true);
    expect(posts()).toHaveLength(2);
  });

  describe('applyPreset', () => {
    const preset = (id: string) => {
      const found = DELAY_PRESETS.find((item) => item.id === id);
      if (!found) throw new Error(`no preset ${id}`);
      return found;
    };

    it('sets mix and every param in one change, keeps added and on', () => {
      const { model, actions } = setup();
      actions.setAdded('delay', true);
      actions.setOn('delay', false);
      const states: unknown[] = [];
      const subscription = model.$effects.subscribe(({ delay }) => states.push(delay));

      actions.applyPreset('delay', 'dub');
      expect(states).toHaveLength(2);
      expect(model.$effects.value.delay).toEqual({
        added: true,
        on: false,
        mix: preset('dub').mix,
        params: preset('dub').params,
      });
      expect(findFxPreset('delay', model.$effects.value.delay)).toBe(preset('dub'));
      subscription.unsubscribe();
    });

    it('gives the chain the knobs and the mix of the preset', async () => {
      const { actions, told, posted } = await ready();
      actions.setAdded('delay', true);
      actions.applyPreset('delay', 'tape-echo');
      const { params, mix } = preset('tape-echo');
      expect(told.setParams).toHaveBeenLastCalledWith(
        SLOT.delay,
        expect.objectContaining({ time: params.time, fb: params.fb, freq: params.freq, q: params.q })
      );
      expect(told.setMix).toHaveBeenLastCalledWith(SLOT.delay, mix);
      // one message of its knobs that differ from the defaults
      expect(posted('params')).toHaveLength(1);
      expect(posted('params')[0]?.[1]).toMatchObject({ time: params.time, fb: params.fb });
      expect(posted('mix')).toEqual(mix === FX_MIX_PARAM.default ? [] : [[SLOT.delay, mix]]);
    });

    it('does not share the params object with the preset', () => {
      const { model, actions } = setup();
      actions.applyPreset('delay', 'slapback');
      actions.setParam('delay', 'time', 0.5);
      expect(preset('slapback').params.time).toBe(0.09);
      expect(model.$effects.value.delay.params).not.toBe(preset('slapback').params);
    });

    it('ignores an unknown id', () => {
      const { model, actions } = setup();
      const before = model.$effects.value;
      actions.applyPreset('delay', 'unknown');
      expect(model.$effects.value).toBe(before);
    });

    it('survives a snapshot round-trip, incl. zero feedback and pan', () => {
      const { model, actions } = setup();
      actions.setAdded('delay', true);
      actions.applyPreset('delay', 'stereo-widener');
      const snapshot = getSnapshot();
      expect(snapshot['fx']).toMatchObject({ delay: { fb: 0, mix: 0.35, pan: 0.018 } });

      actions.applyPreset('delay', 'dub');
      applySnapshot(snapshot);
      expect(findFxPreset('delay', model.$effects.value.delay)).toBe(preset('stereo-widener'));
    });

    it('a fresh effect matches the default preset', () => {
      const { model } = setup();
      expect(findFxPreset('delay', model.$effects.value.delay)?.id).toBe('default');
    });
  });

  it('clear has the chain forget every tail at once, and changes nothing else', async () => {
    const { actions, told, posts } = await ready();
    actions.setAdded('reverb', true);
    const snapshot = getSnapshot();
    const before = posts().length;
    actions.clear();
    expect(told.clear).toHaveBeenCalledTimes(1);
    expect(posts().slice(before)).toEqual([{ clear: true }]);
    expect(getSnapshot()).toEqual(snapshot);
  });

  it('$chain emits the added effects only when the chain changes', () => {
    const { model, actions } = setup();
    const chains: string[][] = [];
    const subscription = model.$chain.subscribe((chain) => chains.push(chain));

    actions.setAdded('delay', true);
    actions.setParam('delay', 'fb', 0.1);
    actions.setMix('delay', 0.6);
    actions.setAdded('delay', false);

    expect(chains).toEqual([[], ['delay'], []]);
    subscription.unsubscribe();
  });

  it('getChain keeps the order and only the added effects', () => {
    const { model, actions } = setup();
    actions.setAdded('delay', true);
    expect(getChain(['delay'], model.$effects.value, model.$status.value)).toEqual(['delay']);
    expect(getChain([], model.$effects.value, model.$status.value)).toEqual([]);
  });

  it('getChain keeps loading and ready effects, leaves out unsupported and failed ones', () => {
    const { model, actions } = setup();
    actions.setAdded('delay', true);
    actions.setAdded('reverb', true);
    const chain = (reverb: FxStatus) =>
      getChain(['reverb', 'delay'], model.$effects.value, {
        distortion: 'ready',
        chorus: 'ready',
        delay: 'ready',
        compressor: 'ready',
        reverb,
      });
    expect(chain('loading')).toEqual(['reverb', 'delay']);
    expect(chain('ready')).toEqual(['reverb', 'delay']);
    expect(chain('unsupported')).toEqual(['delay']);
    expect(chain('failed')).toEqual(['delay']);
  });

  it('move reorders the effects', () => {
    const { model, actions } = setup();
    actions.move(0, 0);
    expect(model.$order.value).toEqual(['distortion', 'chorus', 'delay', 'compressor', 'reverb']);
    actions.move(4, 0);
    expect(model.$order.value).toEqual(['reverb', 'distortion', 'chorus', 'delay', 'compressor']);
    actions.move(1, 2);
    expect(model.$order.value).toEqual(['reverb', 'chorus', 'distortion', 'delay', 'compressor']);
  });

  it('a move of effects that are not in the chain tells it nothing', async () => {
    const { actions, posts } = await ready();
    actions.setAdded('delay', true);
    const before = posts().length;
    actions.move(4, 0);
    actions.move(1, 3);
    expect(posts()).toHaveLength(before);
  });

  it('the slots are those of the effects by their kinds, whatever their order', async () => {
    const { model, actions, posted } = await ready();
    expect(Object.keys(model.slots)).toEqual([...FX_TYPES]);
    actions.move(4, 0);
    actions.setAdded('reverb', true);
    actions.setParam('reverb', 'size', 0);
    expect(posted('order')).toEqual([[SLOT.reverb]]);
    expect(posted('params')).toEqual([[SLOT.reverb, { size: 0 }]]);
  });

  describe('distortion', () => {
    it('is first in the chain by default', async () => {
      const { model, actions, posted } = await ready();
      expect(model.$order.value).toEqual(['distortion', 'chorus', 'delay', 'compressor', 'reverb']);
      FX_TYPES.forEach((type) => actions.setAdded(type, true));
      expect(posted('order').pop()).toEqual([0, 1, 2, 3, 4]);
      expect(posted('active')).toEqual(FX_TYPES.map((_, slot) => [slot, true]));
    });

    it('gives the chain the changed params, plays once the chain is ready', async () => {
      const { actions, told, active } = setup();
      actions.setAdded('distortion', true);
      told.setParams.mockClear();
      actions.setParam('distortion', 'drive', 9);
      expect(told.setParams.mock.calls).toEqual([[SLOT.distortion, { ...DISTORTION_DEFAULTS, drive: 9 }]]);
      expect(active('distortion')).toBe(false);
      await flush();
      expect(active('distortion')).toBe(true);
    });

    it('a fresh distortion matches the default preset, its presets are found back', () => {
      const { model, actions } = setup();
      expect(findFxPreset('distortion', model.$effects.value.distortion)?.id).toBe('default');
      actions.applyPreset('distortion', 'crunch');
      expect(findFxPreset('distortion', model.$effects.value.distortion)?.id).toBe('crunch');
    });
  });

  describe('compressor', () => {
    it('is after the delay and before the reverb by default', async () => {
      const { actions, posted } = await ready();
      (['reverb', 'compressor', 'delay'] as const).forEach((type) => actions.setAdded(type, true));
      expect(posted('order').pop()).toEqual([SLOT.delay, SLOT.compressor, SLOT.reverb]);
    });

    it('its mix is the one of its slot, as of any effect (the core mixes it inside)', async () => {
      const { actions, posts, forget } = await ready();
      actions.setAdded('compressor', true);
      forget();
      actions.setMix('compressor', 0.25);
      actions.setMix('compressor', 0);
      expect(posts()).toEqual([{ mix: [SLOT.compressor, 0.25] }, { mix: [SLOT.compressor, 0] }]);
    });

    it('gives the chain the changed params, falsy ones included', async () => {
      const { actions, posted } = await ready();
      actions.setAdded('compressor', true);
      actions.setParam('compressor', 'multi', 1);
      actions.setParam('compressor', 'thresh', 0);
      actions.setParam('compressor', 'below', 0.5);
      expect(posted('params')).toEqual([
        [SLOT.compressor, { multi: 1 }],
        [SLOT.compressor, { thresh: 0 }],
        [SLOT.compressor, { below: 0.5 }],
      ]);
    });

    it('a fresh compressor matches the default preset, its presets are found back', () => {
      const { model, actions } = setup();
      expect(findFxPreset('compressor', model.$effects.value.compressor)?.id).toBe('default');
      actions.applyPreset('compressor', 'ott');
      expect(findFxPreset('compressor', model.$effects.value.compressor)?.id).toBe('ott');
      expect(model.$effects.value.compressor.params['multi']).toBe(1);
      actions.setParam('compressor', 'high', 1);
      expect(findFxPreset('compressor', model.$effects.value.compressor)).toBeUndefined();
    });

    it('its meter is the one of its slot (the chorus has its own), the other effects have none', () => {
      const { model } = setup();
      expect(model.slots.compressor.meter?.watch).toEqual(expect.any(Function));
      expect(model.slots.chorus.meter?.watch).toEqual(expect.any(Function));
      expect(model.slots.chorus.meter).not.toBe(model.slots.compressor.meter);
      expect(model.slots.delay.meter).toBeUndefined();
      expect(model.slots.distortion.meter).toBeUndefined();
      expect(model.slots.reverb.meter).toBeUndefined();
    });

    it('a watcher of its meter gets what the worklet posts of its slot', async () => {
      const { model, node, posted } = await ready();
      const listener = jest.fn();
      const unwatch = model.slots.compressor.meter?.watch(listener);
      expect(posted('meter')).toEqual([[SLOT.compressor, true]]);
      chainReports(node, { meter: [SLOT.compressor, { reduction: [1, 2, 3] }] });
      chainReports(node, { meter: [SLOT.chorus, { lfo: 0.5 }] });
      expect(listener.mock.calls).toEqual([[{ reduction: [1, 2, 3] }]]);
      unwatch?.();
      expect(posted('meter')).toEqual([
        [SLOT.compressor, true],
        [SLOT.compressor, false],
      ]);
    });

    it('round-trips its snapshot, falsy values included, missing keys are defaults', () => {
      const { model, actions } = setup();
      actions.setAdded('compressor', true);
      actions.setOn('compressor', false);
      actions.setMix('compressor', 0);
      actions.setParam('compressor', 'multi', 1);
      ['thresh', 'gain', 'below', 'level'].forEach((key) => actions.setParam('compressor', key, 0));
      actions.setParam('compressor', 'low', -6);
      const snapshot = getSnapshot();
      expect(snapshot['fx']).toMatchObject({
        compressor: { a: true, on: false, mix: 0, multi: 1, thresh: 0, gain: 0, below: 0, level: 0, low: -6 },
      });

      actions.applyPreset('compressor', 'glue');
      actions.setOn('compressor', true);
      applySnapshot(snapshot);
      expect(model.$effects.value.compressor).toEqual({
        added: true,
        on: false,
        mix: 0,
        params: { ...COMPRESSOR_DEFAULTS, multi: 1, thresh: 0, gain: 0, below: 0, level: 0, low: -6 },
      });

      applySnapshot({ fx: { compressor: { a: true, ratio: 12 } } });
      expect(model.$effects.value.compressor).toEqual({
        added: true,
        on: true,
        mix: 1,
        params: { ...COMPRESSOR_DEFAULTS, ratio: 12 },
      });
    });
  });

  describe('chorus', () => {
    it('is after the distortion and before the delay by default', async () => {
      const { actions, posted } = await ready();
      (['delay', 'chorus', 'distortion'] as const).forEach((type) => actions.setAdded(type, true));
      expect(posted('order').pop()).toEqual([SLOT.distortion, SLOT.chorus, SLOT.delay]);
    });

    it('gives the chain the changed params, falsy ones included', async () => {
      const { actions, posted } = await ready();
      actions.setAdded('chorus', true);
      actions.setParam('chorus', 'depth', 0);
      actions.setParam('chorus', 'hpf', 1);
      actions.setParam('chorus', 'fb', 0);
      actions.setMix('chorus', 0);
      expect(posted('params')).toEqual([
        [SLOT.chorus, { depth: 0 }],
        [SLOT.chorus, { hpf: 1 }],
        [SLOT.chorus, { fb: 0 }],
      ]);
      expect(posted('mix')).toEqual([[SLOT.chorus, 0]]);
    });

    it('BPM takes the division nearest to a cycle of Rate at the tempo, HZ the rate of its division', () => {
      const { model, actions } = setup();
      const params = () => model.$effects.value.chorus.params;
      // a cycle of 2 s at 120: a bar
      actions.setParam('chorus', 'rate', 0.5);
      actions.setParam('chorus', 'sync', 1);
      expect(params()).toMatchObject({ sync: 1, div: divisionIndex('1 bar'), rate: 0.5 });
      // on again: nothing changes
      actions.setParam('chorus', 'sync', 1);
      expect(params()['div']).toBe(divisionIndex('1 bar'));
      actions.setParam('chorus', 'div', divisionIndex('1/4'));
      actions.setParam('chorus', 'sync', 0);
      expect(params()).toMatchObject({ sync: 0, div: divisionIndex('1/4'), rate: 2 });
      // TRIP: the triplets among its steps; off again, a triplet is its straight division
      actions.setParam('chorus', 'sync', 1);
      actions.setParam('chorus', 'trip', 1);
      actions.setParam('chorus', 'div', divisionIndex('1/4T'));
      actions.setParam('chorus', 'trip', 0);
      expect(params()).toMatchObject({ trip: 0, div: divisionIndex('1/4') });
      // an LFO that stands: the longest division; 1/32 is 16 Hz at 120, at 300 the top of Rate
      actions.setParam('chorus', 'sync', 0);
      actions.setParam('chorus', 'rate', 0);
      actions.setParam('chorus', 'sync', 1);
      expect(params()['div']).toBe(divisionIndex('8 bar'));
    });

    it('in BPM its rate follows the tempo of the transport', async () => {
      const { actions, posted, transport } = await ready();
      actions.setAdded('chorus', true);
      actions.setParam('chorus', 'sync', 1);
      actions.setParam('chorus', 'div', divisionIndex('1/4'));
      expect(posted('params').pop()).toEqual([SLOT.chorus, { rate: 2 }]);
      transport[1].setBpm(90);
      expect(posted('params').pop()).toEqual([SLOT.chorus, { rate: 1.5 }]);
    });

    it('a fresh chorus matches the default preset, its presets are found back', () => {
      const { model, actions } = setup();
      expect(findFxPreset('chorus', model.$effects.value.chorus)?.id).toBe('default');
      actions.applyPreset('chorus', 'tempo-sweep');
      expect(findFxPreset('chorus', model.$effects.value.chorus)?.id).toBe('tempo-sweep');
      expect(model.$effects.value.chorus.params['sync']).toBe(1);
      actions.setParam('chorus', 'fb', 0.5);
      expect(findFxPreset('chorus', model.$effects.value.chorus)).toBeUndefined();
    });

    it('round-trips its snapshot, falsy values included, missing keys are defaults', () => {
      const { model, actions } = setup();
      actions.setAdded('chorus', true);
      actions.setOn('chorus', false);
      actions.setMix('chorus', 0);
      ['rate', 'd1', 'depth', 'fb', 'level'].forEach((key) => actions.setParam('chorus', key, 0));
      actions.setParam('chorus', 'hpf', 1);
      actions.setParam('chorus', 'd2', 7);
      const snapshot = getSnapshot();
      expect(snapshot['fx']).toMatchObject({
        chorus: { a: true, on: false, mix: 0, rate: 0, d1: 0, depth: 0, fb: 0, level: 0, hpf: 1, d2: 7 },
      });

      actions.applyPreset('chorus', 'tempo-sweep');
      actions.setOn('chorus', true);
      applySnapshot(snapshot);
      expect(model.$effects.value.chorus).toEqual({
        added: true,
        on: false,
        mix: 0,
        params: { ...CHORUS_DEFAULTS, rate: 0, d1: 0, depth: 0, fb: 0, level: 0, hpf: 1, d2: 7 },
      });

      applySnapshot({ fx: { chorus: { a: true, sync: 1, div: divisionIndex('1/8') } } });
      expect(model.$effects.value.chorus).toEqual({
        added: true,
        on: true,
        mix: 0.5,
        params: { ...CHORUS_DEFAULTS, sync: 1, div: divisionIndex('1/8') },
      });
    });
  });

  describe('two effects', () => {
    it('tells the chain the added effects in their order', async () => {
      const { actions, posted } = await ready();
      actions.setAdded('delay', true);
      actions.setAdded('reverb', true);
      actions.move(4, 0);
      actions.setAdded('delay', false);
      expect(posted('order')).toEqual([
        [SLOT.delay],
        [SLOT.delay, SLOT.reverb],
        [SLOT.reverb, SLOT.delay],
        [SLOT.reverb],
      ]);
    });

    it('changes only the effect it is called for', async () => {
      const { model, actions, posts } = await ready();
      const delayBefore = model.$effects.value.delay;
      actions.setAdded('reverb', true);
      actions.setParam('reverb', 'decay', 5);
      actions.setMix('reverb', 0.6);
      expect(model.$effects.value.delay).toBe(delayBefore);
      expect(model.$effects.value.reverb).toMatchObject({ added: true, mix: 0.6, params: { decay: 5 } });
      expect(posts()).toEqual([
        { order: [SLOT.reverb] },
        { active: [SLOT.reverb, true] },
        { params: [SLOT.reverb, { decay: 5 }] },
        { mix: [SLOT.reverb, 0.6] },
      ]);
    });

    it('applies a reverb preset and finds it back', () => {
      const { model, actions } = setup();
      actions.applyPreset('reverb', 'cathedral');
      const cathedral = REVERB_PRESETS.find(({ id }) => id === 'cathedral');
      expect(model.$effects.value.reverb).toMatchObject({ mix: cathedral?.mix, params: cathedral?.params });
      expect(findFxPreset('reverb', model.$effects.value.reverb)).toBe(cathedral);
      expect(findFxPreset('reverb', defaultReverb())?.id).toBe('default');
    });
  });

  describe('status', () => {
    // the module of the engine (the chain is in it) fails to load on the first try. The synth core loads it as it
    // is made: the worklet of its context fails from the start (test-setup puts the one of the mock back after the
    // test)
    const failing = () => {
      const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      let failed = false;
      const addModule = jest.fn((url: string) => {
        if (failed || !url.endsWith('/engine.js')) return Promise.resolve();
        failed = true;
        return Promise.reject(new Error('404'));
      });
      Object.defineProperty(AudioContext.prototype, 'audioWorklet', {
        configurable: true,
        get: () => ({ addModule }),
      });
      return { ...setup(), addModule, error };
    };

    it('every effect has the status of the chain: ready once its one module has loaded', async () => {
      const { model, audioCtx } = setup();
      expect(model.$status.value).toEqual(ALL('loading'));
      await flush();
      expect(model.$status.value).toEqual(ALL('ready'));
      const addModule = audioCtx.audioWorklet.addModule as jest.Mock;
      expect(workletLoads(addModule, 'engine')).toBe(1);
      // one node for all of them
      expect(chainNodes(audioCtx)).toHaveLength(1);
      FX_TYPES.forEach((type) => expect(workletLoads(addModule, type)).toBe(0));
    });

    it('a loading reverb is already in the chain, it plays once the node exists', async () => {
      const { model, actions, audioCtx, told, active } = setup();
      actions.setMix('reverb', 1);
      actions.setAdded('reverb', true);
      expect(model.$status.value.reverb).toBe('loading');
      expect(told.setOrder).toHaveBeenLastCalledWith([SLOT.reverb]);
      expect(active('reverb')).toBe(false);
      const orders = told.setOrder.mock.calls.length;

      await flush();
      expect(model.$status.value.reverb).toBe('ready');
      expect(active('reverb')).toBe(true);
      // it was in the chain already: the node was made with it
      expect(told.setOrder).toHaveBeenCalledTimes(orders);
      expect(chainNode(audioCtx).options.processorOptions.state).toMatchObject({
        order: [SLOT.reverb],
        slots: { reverb: { mix: 1 } },
      });
      expect(chainPosts(chainNode(audioCtx))).toEqual([{ active: [SLOT.reverb, true] }]);
    });

    it('a bypassed reverb stays bypassed once ready', async () => {
      const { model, actions, audioCtx, active } = setup();
      actions.setOn('reverb', false);
      actions.setAdded('reverb', true);
      await flush();
      expect(model.$status.value.reverb).toBe('ready');
      expect(active('reverb')).toBe(false);
      expect(chainPosts(chainNode(audioCtx))).toEqual([]);
    });

    it('without AudioWorklet the model starts, every effect is unsupported', () => {
      withoutAudioWorklet();
      const { model, actions, told } = setup();
      expect(model.$status.value).toEqual(ALL('unsupported'));
      expect(() => {
        actions.setParam('delay', 'time', 0.5);
        actions.setMix('delay', 0.5);
        actions.clear();
      }).not.toThrow();
      expect(told.setParams).toHaveBeenLastCalledWith(SLOT.delay, expect.objectContaining({ time: 0.5 }));
    });

    it('an unsupported effect can not be added, removing it still works', () => {
      withoutAudioWorklet();
      const { model, actions } = setup();
      const before = model.$effects.value;
      actions.setAdded('reverb', true);
      actions.setAdded('delay', true);
      expect(model.$effects.value).toBe(before);
      applySnapshot({ fx: { reverb: { a: true } } });
      actions.setAdded('reverb', false);
      expect(model.$effects.value.reverb.added).toBe(false);
    });

    it('an unsupported effect added by a snapshot stays out of the chain, the snapshot keeps it', () => {
      withoutAudioWorklet();
      const { model, told, active } = setup();
      applySnapshot({
        fx: { o: ['reverb', 'delay'], reverb: { a: true, decay: 5, mix: 1 }, delay: { a: true } },
      });
      expect(model.$effects.value.reverb).toMatchObject({ added: true, mix: 1, params: { decay: 5 } });
      expect(told.setOrder.mock.calls.every(([order]) => order.length === 0)).toBe(true);
      expect(active('reverb')).toBe(false);
      expect(active('delay')).toBe(false);
      expect(getSnapshot()['fx']).toMatchObject({ reverb: { a: true, decay: 5 }, delay: { a: true } });
    });

    it('a failed load reports every effect as failed and drops the added ones out of the chain', async () => {
      const { model, actions, told, active, error } = failing();
      actions.setAdded('reverb', true);
      expect(told.setOrder).toHaveBeenLastCalledWith([SLOT.reverb]);
      await flush();
      expect(model.$status.value).toEqual(ALL('failed'));
      expect(error).toHaveBeenCalled();
      expect(model.$effects.value.reverb.added).toBe(true);
      expect(told.setOrder).toHaveBeenLastCalledWith([]);
      expect(active('reverb')).toBe(false);
    });

    it('adding a failed effect loads the chain again and puts it in the chain', async () => {
      const { model, actions, audioCtx, told, active, addModule } = failing();
      await flush();
      expect(model.$status.value.reverb).toBe('failed');
      expect(workletLoads(addModule, 'engine')).toBe(1);

      actions.setAdded('reverb', true);
      expect(workletLoads(addModule, 'engine')).toBe(2);
      expect(model.$status.value.reverb).toBe('loading');
      expect(model.$effects.value.reverb.added).toBe(true);
      expect(told.setOrder).toHaveBeenLastCalledWith([SLOT.reverb]);
      await flush();
      expect(model.$status.value).toEqual(ALL('ready'));
      expect(told.setOrder).toHaveBeenLastCalledWith([SLOT.reverb]);
      expect(active('reverb')).toBe(true);
      expect(chainNode(audioCtx).options.processorOptions.state.order).toEqual([SLOT.reverb]);
    });

    it('a retry that fails again leaves the effect added but out of the chain', async () => {
      const { model, actions, told, addModule } = failing();
      await flush();
      addModule.mockRejectedValueOnce(new Error('offline'));
      actions.setAdded('reverb', true);
      await flush();
      expect(model.$status.value.reverb).toBe('failed');
      expect(model.$effects.value.reverb.added).toBe(true);
      expect(told.setOrder).toHaveBeenLastCalledWith([]);
    });

    it('removing a failed effect does not retry', async () => {
      const { model, actions, addModule } = failing();
      await flush();
      actions.setAdded('reverb', false);
      expect(workletLoads(addModule, 'engine')).toBe(1);
      expect(model.$status.value.reverb).toBe('failed');
    });

    it('retry loads a failed chain again without adding the effect, does nothing once it is ready', async () => {
      const { model, actions, told, addModule } = failing();
      await flush();
      actions.retry('reverb');
      expect(workletLoads(addModule, 'engine')).toBe(2);
      expect(model.$status.value.reverb).toBe('loading');
      await flush();
      expect(model.$status.value.reverb).toBe('ready');
      expect(model.$effects.value.reverb.added).toBe(false);
      expect(told.setOrder.mock.calls.every(([order]) => order.length === 0)).toBe(true);
      actions.retry('reverb');
      expect(workletLoads(addModule, 'engine')).toBe(2);
    });

    it('a failed effect does not play, a retry has it play once ready', async () => {
      const { model, actions, active } = failing();
      actions.setMix('reverb', 1);
      actions.setAdded('reverb', true);
      await flush();
      expect(model.$status.value.reverb).toBe('failed');
      expect(active('reverb')).toBe(false);

      actions.retry('reverb');
      await flush();
      expect(model.$status.value.reverb).toBe('ready');
      expect(model.$effects.value.reverb.added).toBe(true);
      expect(active('reverb')).toBe(true);
    });

    it('a processor error fails every effect, a retry makes the node again with the chain as it is', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { model, actions, audioCtx, node, told, active } = await ready();
      actions.setAdded('reverb', true);
      actions.setParam('reverb', 'decay', 5);
      expect(active('reverb')).toBe(true);

      node.onprocessorerror?.call(node, new ErrorEvent('processorerror'));
      expect(model.$status.value).toEqual(ALL('failed'));
      expect(active('reverb')).toBe(false);
      expect(told.setOrder).toHaveBeenLastCalledWith([]);

      actions.retry('reverb');
      await flush();
      expect(model.$status.value).toEqual(ALL('ready'));
      expect(active('reverb')).toBe(true);
      const next = chainNode(audioCtx);
      expect(next).not.toBe(node);
      expect(next.options.processorOptions.state).toMatchObject({
        order: [SLOT.reverb],
        slots: { reverb: { params: { decay: 5 } } },
      });
      expect(chainPosts(next)).toEqual([{ active: [SLOT.reverb, true] }]);
    });

    it('an effect that fails in the core is failed alone: out of the chain, the others play on', async () => {
      const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { model, actions, node, posts, forget, active } = await ready();
      actions.setAdded('delay', true);
      actions.setAdded('reverb', true);
      forget();
      chainReports(node, { failed: [SLOT.reverb] });
      expect(error).toHaveBeenCalled();
      expect(model.$status.value).toEqual({ ...ALL('ready'), reverb: 'failed' });
      expect(model.$effects.value.reverb.added).toBe(true);
      expect(posts()).toEqual([{ order: [SLOT.delay] }, { active: [SLOT.reverb, false] }]);
      expect(active('delay')).toBe(true);
    });

    it('a retry of an effect that failed in the core has it made again, back in the chain', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { model, actions, audioCtx, node, posts, forget } = await ready();
      actions.setAdded('delay', true);
      actions.setAdded('reverb', true);
      chainReports(node, { failed: [SLOT.reverb] });
      forget();
      // (the retry of another effect is not for it)
      actions.retry('delay');
      expect(posts()).toEqual([]);

      actions.retry('reverb');
      // (in the order as one that loads, it plays once the node tells its unit is made)
      expect(model.$status.value).toEqual({ ...ALL('ready'), reverb: 'loading' });
      expect(posts()).toEqual([{ retry: SLOT.reverb }, { order: [SLOT.delay, SLOT.reverb] }]);
      chainReports(node, { remade: SLOT.reverb });
      expect(model.$status.value).toEqual(ALL('ready'));
      expect(posts()).toEqual([
        { retry: SLOT.reverb },
        { order: [SLOT.delay, SLOT.reverb] },
        { active: [SLOT.reverb, true] },
      ]);
      // the module had loaded: nothing is added again
      expect(workletLoads(audioCtx.audioWorklet.addModule as jest.Mock, 'engine')).toBe(1);
      expect(chainNodes(audioCtx)).toHaveLength(1);
    });

    it('adding an effect that failed in the core has it made again', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const { model, actions, node, posted } = await ready();
      chainReports(node, { failed: [SLOT.chorus] });
      expect(model.$status.value.chorus).toBe('failed');
      actions.setAdded('chorus', true);
      expect(posted('retry')).toEqual([SLOT.chorus]);
      chainReports(node, { remade: SLOT.chorus });
      expect(model.$status.value.chorus).toBe('ready');
      expect(posted('order')).toEqual([[SLOT.chorus]]);
      expect(posted('active')).toEqual([[SLOT.chorus, true]]);
    });

    it('an unsupported effect added by a snapshot never plays', () => {
      withoutAudioWorklet();
      const { model, told } = setup();
      applySnapshot({ fx: { reverb: { a: true, mix: 1 } } });
      expect(model.$effects.value.reverb).toMatchObject({ added: true, mix: 1 });
      expect(told.setActive.mock.calls.some(([, active]) => active)).toBe(false);
    });
  });

  describe('snapshot', () => {
    it('exposes the persisted state', () => {
      const { actions } = setup();
      actions.setAdded('delay', true);
      actions.setMix('delay', 0.5);
      actions.setParam('delay', 'fb', 0.2);
      expect(getSnapshot()['fx']).toEqual({
        o: ['distortion', 'chorus', 'delay', 'compressor', 'reverb'],
        distortion: { a: false, on: true, mix: 1, ...DISTORTION_DEFAULTS },
        chorus: { a: false, on: true, mix: 0.5, ...CHORUS_DEFAULTS },
        compressor: { a: false, on: true, mix: 1, ...COMPRESSOR_DEFAULTS },
        delay: {
          a: true,
          on: true,
          mix: 0.5,
          mode: 0,
          pan: 0,
          time: 0.2,
          ...MS,
          fb: 0.2,
          freq: 1000,
          q: 0.01,
        },
        reverb: { a: false, on: true, mix: 0.3, ...REVERB_DEFAULTS },
      });
    });

    it('a snapshot applied reaches the chain: the order, the knobs, the mixes, what plays', async () => {
      const { posts } = await ready();
      applySnapshot({
        fx: {
          o: ['reverb', 'delay'],
          reverb: { a: true, decay: 5, mix: 0, era: 0 },
          delay: { a: true, on: false, fb: 0 },
        },
      });
      const messages = posts();
      expect(messages).toHaveLength(5);
      expect(messages).toEqual(
        expect.arrayContaining([
          { order: [SLOT.reverb, SLOT.delay] },
          { params: [SLOT.reverb, { decay: 5, bandwidth: expect.any(Number), body: 0 }] },
          { mix: [SLOT.reverb, 0] },
          { active: [SLOT.reverb, true] },
          { params: [SLOT.delay, { fb: 0 }] },
        ])
      );
      // the snapshot before it gone: the chain is as it started
      applySnapshot({});
      // (the order first, then the effects: the two in their default order for a moment)
      expect(posts().slice(5)).toHaveLength(6);
      expect(posts().slice(5)).toEqual(
        expect.arrayContaining([
          { order: [SLOT.delay, SLOT.reverb] },
          { order: [] },
          { active: [SLOT.reverb, false] },
          { params: [SLOT.reverb, { decay: 2, bandwidth: 10000, body: 1 }] },
          { mix: [SLOT.reverb, 0.3] },
          { params: [SLOT.delay, { fb: 0.5 }] },
        ])
      );
    });

    it('round-trips the reverb, falsy values included, missing keys are defaults', () => {
      const { model, actions } = setup();
      actions.move(4, 0);
      actions.setAdded('reverb', true);
      actions.setOn('reverb', false);
      actions.setMix('reverb', 0);
      ['pre', 'size', 'depth', 'sep', 'er', 'era'].forEach((key) => actions.setParam('reverb', key, 0));
      actions.setParam('reverb', 'decay', 12);
      const snapshot = getSnapshot();
      expect(snapshot['fx']).toMatchObject({
        o: ['reverb', 'distortion', 'chorus', 'delay', 'compressor'],
        reverb: { a: true, on: false, mix: 0 },
      });

      actions.applyPreset('reverb', 'plate');
      actions.setOn('reverb', true);
      actions.move(1, 0);
      applySnapshot(snapshot);
      expect(model.$order.value).toEqual(['reverb', 'distortion', 'chorus', 'delay', 'compressor']);
      expect(model.$effects.value.reverb).toEqual({
        added: true,
        on: false,
        mix: 0,
        params: { ...REVERB_DEFAULTS, pre: 0, size: 0, depth: 0, sep: 0, er: 0, era: 0, decay: 12 },
      });

      applySnapshot({ fx: { reverb: { a: true, decay: 0.5 } } });
      expect(model.$effects.value.reverb).toEqual({
        added: true,
        on: true,
        mix: 0.3,
        params: { ...REVERB_DEFAULTS, decay: 0.5 },
      });
    });

    it('applies falsy values and restores defaults for missing keys', () => {
      const { model, actions } = setup();
      actions.setAdded('delay', true);
      actions.setParam('delay', 'time', 0.5);
      actions.setParam('delay', 'mode', 1);
      actions.setParam('delay', 'pan', 0.02);
      actions.setParam('delay', 'freq', 5000);

      applySnapshot({ fx: { delay: { a: true, on: false, mix: 0, fb: 0, mode: 0, pan: 0 } } });
      expect(model.$effects.value.delay).toEqual({
        added: true,
        on: false,
        mix: 0,
        params: { mode: 0, pan: 0, time: 0.2, ...MS, fb: 0, freq: 1000, q: 0.01 },
      });

      applySnapshot({});
      expect(model.$effects.value.delay.added).toBe(false);
    });

    it('ignores wrong types and clamps numbers out of range (legacy url params)', () => {
      const { model } = setup();
      applySnapshot({
        fx: { delay: { a: 'yes', on: 1, mix: 'x', fb: 1.5, time: -1, mode: 3, pan: -2, freq: 'x', q: 5 } },
      });
      expect(model.$effects.value.delay).toEqual({
        added: false,
        on: true,
        mix: 0.3,
        params: { mode: 1, pan: -0.05, time: 0.01, ...MS, fb: 0.9, freq: 1000, q: 3 },
      });

      applySnapshot({ fx: { delay: { mix: Infinity, time: '1' } } });
      expect(model.$effects.value.delay).toMatchObject({ mix: 0.3, params: { time: 0.2 } });
    });

    it('rounds int params so the preset schema accepts them', () => {
      const { model } = setup();
      applySnapshot({ fx: { delay: { mode: 0.6 } } });
      expect(model.$effects.value.delay.params['mode']).toBe(1);
      applySnapshot({ fx: { delay: { mode: 0.4 } } });
      expect(model.$effects.value.delay.params['mode']).toBe(0);
    });

    it('uses the defaults when the effect value is not an object', () => {
      const { model, actions } = setup();
      actions.setAdded('delay', true);
      applySnapshot({ fx: { delay: 'on' } });
      expect(model.$effects.value.delay).toEqual({
        added: false,
        on: true,
        mix: 0.3,
        params: { mode: 0, pan: 0, time: 0.2, ...MS, fb: 0.5, freq: 1000, q: 0.01 },
      });
    });

    it('drops unknown and duplicate effects from the order, a missing one takes its default place', () => {
      const { model } = setup();
      applySnapshot({ fx: { o: ['phaser', 'reverb', 'delay', 'delay'] } });
      expect(model.$order.value).toEqual(['distortion', 'chorus', 'compressor', 'reverb', 'delay']);
      // a snapshot from before the distortion, the chorus and the compressor: the first two in front of the
      // delay, the other of the reverb
      applySnapshot({ fx: { o: ['delay', 'reverb'] } });
      expect(model.$order.value).toEqual(['distortion', 'chorus', 'delay', 'compressor', 'reverb']);
      applySnapshot({ fx: { o: ['delay'] } });
      expect(model.$order.value).toEqual(['distortion', 'chorus', 'delay', 'compressor', 'reverb']);
      applySnapshot({ fx: { o: [] } });
      expect(model.$order.value).toEqual([...FX_TYPES]);
    });

    it('round-trips the distortion, falsy values included, missing keys are defaults', () => {
      const { model, actions } = setup();
      actions.setAdded('distortion', true);
      actions.setOn('distortion', false);
      actions.setMix('distortion', 0);
      actions.setParam('distortion', 'mode', 1);
      actions.setParam('distortion', 'mode', 0);
      actions.setParam('distortion', 'drive', 0);
      actions.setParam('distortion', 'level', 0);
      actions.setParam('distortion', 'tone', 500);
      const snapshot = getSnapshot();
      expect(snapshot['fx']).toMatchObject({
        distortion: { a: true, on: false, mix: 0, mode: 0, drive: 0, tone: 500, level: 0 },
      });

      actions.applyPreset('distortion', 'fuzz');
      actions.setOn('distortion', true);
      applySnapshot(snapshot);
      expect(model.$effects.value.distortion).toEqual({
        added: true,
        on: false,
        mix: 0,
        params: { mode: 0, drive: 0, tone: 500, level: 0 },
      });

      // all wet by default, unlike the delay and the reverb
      applySnapshot({ fx: { distortion: { a: true, drive: 9 } } });
      expect(model.$effects.value.distortion).toEqual({
        added: true,
        on: true,
        mix: 1,
        params: { ...DISTORTION_DEFAULTS, drive: 9 },
      });
      expect(model.$effects.value.delay.mix).toBe(0.3);
    });
  });

  describe('modulation', () => {
    const ENV = { attack: 0.1, hold: 0, decay: 0.1, sustain: 0.5, release: 0.2 };
    const FLAT = { attack: 0, hold: 0, decay: 0, sustain: 1, release: 0 };
    const note = (start: number) => ({ envelopes: [FLAT, ENV, FLAT], start, release: null });
    // the sources of the routes (MOD_SOURCES): ENV 1–3, VELO, LFO 1–4
    const [ENV2, ENV3, VELO, LFO2] = [1, 2, 3, 5];
    const target = (type: FxType, param: string) =>
      SLOT[type] * TARGET_KEYS + CHAIN_KEYS[type].indexOf(param);
    const lfoTarget = (lfo: number, knob: (typeof LFO_KNOBS)[number]) =>
      LFO_TARGET + (lfo - 1) * LFO_KEYS + LFO_KNOBS.indexOf(knob);

    it('the targets of the core: a slot every 32, its params by their keys, its mix the last; the LFOs after', () => {
      expect([TARGET_KEYS, MIX_KEY, LFO_TARGET]).toEqual([32, 31, 160]);
      expect(target('distortion', 'drive')).toBe(1);
      expect(target('chorus', 'rate')).toBe(32);
      expect(target('delay', 'time')).toBe(64);
      expect(target('compressor', 'thresh')).toBe(97);
      expect(target('reverb', 'size')).toBe(130);
      expect(lfoTarget(1, 'rate')).toBe(160);
      expect(lfoTarget(2, 'rate')).toBe(168);
      expect(lfoTarget(4, 'phase')).toBe(188);
    });

    it('gives the chain the routes of an LFO without a note, with those of the note to the knobs of the LFOs', async () => {
      const { actions, modulation, told } = await ready();
      actions.setAdded('reverb', true);
      modulation[1].addRoute('lfo2', 'reverb.size', 0.5);
      modulation[1].addRoute('env2', 'lfo2.rate', 0.25);
      expect(told.setRoutes).toHaveBeenLastCalledWith([
        { target: 130, source: LFO2, amount: 0.5, min: 0, max: 1 },
        {
          target: 168,
          source: ENV2,
          amount: expect.closeTo(0.25 * Math.log2(3200), 9),
          min: 1 / 32,
          max: 100,
          scale: 'log',
        },
      ]);
      // no route of an LFO any more: its knobs move nothing the chain plays
      modulation[1].removeRoute('lfo2', 'reverb.size');
      modulation[1].addRoute('env2', 'reverb.size', 0.5);
      expect(told.setRoutes).toHaveBeenLastCalledWith([
        { target: 130, source: ENV2, amount: 0.5, min: 0, max: 1 },
      ]);
    });

    it('bounds the routes to Time of the delay in BPM by its divisions at the tempo', async () => {
      const { actions, modulation, $fxNote, told, transport } = await ready();
      actions.setAdded('delay', true);
      $fxNote.next(note(1));
      modulation[1].addRoute('env2', 'delay.time', 0.5);
      const time = { target: 64, source: ENV2, amount: 0.5 * 0.99 };
      expect(told.setRoutes).toHaveBeenLastCalledWith([{ ...time, min: 0.01, max: 1 }]);
      actions.setParam('delay', 'sync', 1);
      // 1/64 … 1 bar at 120, at 60
      expect(told.setRoutes).toHaveBeenLastCalledWith([{ ...time, min: 0.03125, max: 2 }]);
      transport[1].setBpm(60);
      expect(told.setRoutes).toHaveBeenLastCalledWith([{ ...time, min: 0.0625, max: 4 }]);
    });

    it('bounds the routes to Rate of the chorus in BPM by its divisions at the tempo', async () => {
      const { actions, modulation, $fxNote, told, transport } = await ready();
      actions.setAdded('chorus', true);
      $fxNote.next(note(1));
      modulation[1].addRoute('env2', 'chorus.rate', 0.5);
      // a route of a knob of a pow scale: a share of its travel
      const rate = { target: 32, source: ENV2, scale: 'pow' };
      expect(told.setRoutes).toHaveBeenLastCalledWith([{ ...rate, amount: 0.5, min: 0, max: 20 }]);
      actions.setParam('chorus', 'sync', 1);
      // 8 bar … 1/32 a cycle at 120, at 60
      expect(told.setRoutes).toHaveBeenLastCalledWith([
        { ...rate, amount: expect.closeTo(0.5 * (20 / 16) ** 0.25, 9), min: 1 / 16, max: 16 },
      ]);
      transport[1].setBpm(60);
      expect(told.setRoutes).toHaveBeenLastCalledWith([
        { ...rate, amount: expect.closeTo(0.5 * (20 / 8) ** 0.25, 9), min: 1 / 32, max: 8 },
      ]);
    });

    it('bounds the routes to the knobs of an LFO in BPM by its divisions at the tempo', async () => {
      const { actions, modulation, lfos, told } = await ready();
      actions.setAdded('reverb', true);
      modulation[1].addRoute('lfo2', 'reverb.size', 0.5);
      modulation[1].addRoute('env2', 'lfo2.rate', 0.25);
      lfos[1].setBpm('lfo2', true);
      expect(told.setRoutes).toHaveBeenLastCalledWith([
        { target: 130, source: LFO2, amount: 0.5, min: 0, max: 1 },
        // 32 bar to 1/128 at 120 (1/256 is shorter than 10 ms there)
        expect.objectContaining({ target: 168, min: 1 / 64, max: 64, scale: 'log' }),
      ]);
    });

    it('leaves out a route switched off', async () => {
      const { actions, modulation, $fxNote, told } = await ready();
      actions.setAdded('reverb', true);
      modulation[1].addRoute('lfo2', 'reverb.size', 0.5);
      modulation[1].addRoute('env2', 'lfo2.rate', 0.25);
      modulation[1].setOff('env2', 'lfo2.rate', true);
      expect(told.setRoutes).toHaveBeenLastCalledWith([
        { target: 130, source: LFO2, amount: 0.5, min: 0, max: 1 },
      ]);
      modulation[1].setOff('lfo2', 'reverb.size', true);
      expect(told.setRoutes).toHaveBeenLastCalledWith([]);
      // with a note too: no route on, nothing computed
      $fxNote.next(note(1));
      modulation[1].addRoute('env3', 'reverb.decay', 0.5);
      modulation[1].setOff('env3', 'reverb.decay', true);
      expect(told.setRoutes).toHaveBeenLastCalledWith([]);
    });

    it('the node gets the LFOs only while a route of an effect that plays reads one', async () => {
      const { actions, modulation, lfos, posts, posted, forget } = await ready();
      const change = async (mode: 'free' | 'retrig') => {
        lfos[1].setMode('lfo3', mode);
        await new Promise((resolve) => setTimeout(resolve, LFO_STATE_INTERVAL * 1000 + 5));
      };
      modulation[1].addRoute('lfo2', 'reverb.size', 0.5);
      await change('free');
      // the reverb is not in the chain
      expect(posted('lfos')).toEqual([]);

      actions.setAdded('reverb', true);
      // as they are, before the route that reads one
      expect(posted('lfos')).toEqual([expect.objectContaining({ at: 0, instantly: true })]);
      expect(posted('lfos')[0]?.lfos[2].mode).toBe(1);
      expect(posted('lfos')[0]?.lfos.every(({ table }) => table instanceof Float32Array)).toBe(true);
      await change('retrig');
      // every state after it once (the LFO model tells the node, the fx only that it reads), gliding as it is
      expect(posted('lfos')).toHaveLength(2);
      expect(posted('lfos')[1]?.lfos[2].mode).toBe(0);
      expect(posted('lfos')[1]?.instantly).toBeUndefined();
      expect(posts().flatMap((message) => ('readers' in message ? [message.readers] : []))).toEqual([
        ['chain'],
        ['chain'],
      ]);

      actions.setOn('reverb', false);
      forget();
      await change('free');
      expect(posted('lfos')).toEqual([]);
    });

    it('gives the chain the routes of an effect in the chain, on and ready, and the last note', async () => {
      const { actions, modulation, $fxNote, posts, posted } = await ready();
      modulation[1].addRoute('env2', 'delay.time', 0.5);
      modulation[1].addRoute('env3', 'distortion.drive', 0.25);
      $fxNote.next(note(1));
      // not added: nothing computed
      expect(posts()).toEqual([]);

      actions.setAdded('delay', true);
      const routes = [{ target: 64, source: ENV2, amount: 0.5 * (1 - 0.01), min: 0.01, max: 1 }];
      // the note of now with the first routes
      expect(posts()).toContainEqual({ note: note(1), routes });
      // bypassed: nothing computed
      actions.setOn('delay', false);
      expect(posted('routes')).toEqual([routes, []]);
      expect(posted('note')).toEqual([note(1)]);
    });

    it('an effect that is loading has no routes yet', async () => {
      const { actions, modulation, told } = setup();
      actions.setAdded('delay', true);
      modulation[1].addRoute('env2', 'delay.fb', 0.5);
      expect(told.setRoutes.mock.calls.every(([routes]) => routes.length === 0)).toBe(true);
      await flush();
      expect(told.setRoutes).toHaveBeenLastCalledWith([
        { target: 65, source: ENV2, amount: expect.closeTo(0.45, 9), min: 0, max: 0.9 },
      ]);
    });

    it('a log knob moves in octaves, a route of amount 0 is left out', async () => {
      const { actions, modulation, $fxNote, told } = await ready();
      actions.setAdded('reverb', true);
      $fxNote.next(note(1));
      modulation[1].addRoute('env2', 'reverb.decay', 0.5);
      modulation[1].addRoute('env3', 'reverb.size', 0.5);
      modulation[1].setAmount('env3', 'reverb.size', 0);
      expect(told.setRoutes).toHaveBeenLastCalledWith([
        {
          target: target('reverb', 'decay'),
          source: ENV2,
          amount: expect.closeTo(0.5 * Math.log2(200), 9),
          min: 0.1,
          max: 20,
          scale: 'log',
        },
      ]);
    });

    it('a route to the mix of an effect moves the mix of its slot, a bipolar one says so', async () => {
      const { actions, modulation, told } = await ready();
      actions.setAdded('reverb', true);
      actions.setAdded('chorus', true);
      modulation[1].addRoute('lfo2', 'reverb.mix', 0.5, true);
      modulation[1].addRoute('env3', 'chorus.mix', -0.25);
      expect(told.setRoutes).toHaveBeenLastCalledWith([
        // (the mix of the chorus is not the param `mix` of its core)
        { target: 63, source: ENV3, amount: -0.25, min: 0, max: 1 },
        { target: 159, source: LFO2, amount: 0.5, min: 0, max: 1, bipolar: true },
      ]);
    });

    it('a new note starts the envelopes again, the same one (a note of a legato phrase) sends nothing', async () => {
      const { actions, modulation, $fxNote, told, posted } = await ready();
      actions.setAdded('delay', true);
      modulation[1].addRoute('env2', 'delay.fb', 0.5);
      $fxNote.next(note(1));
      const calls = told.setNote.mock.calls.length;
      $fxNote.next(note(1));
      expect(told.setNote).toHaveBeenCalledTimes(calls);
      $fxNote.next(note(2));
      expect(told.setNote).toHaveBeenCalledTimes(calls + 1);
      expect(told.setNote.mock.lastCall?.[0]?.start).toBe(2);
      $fxNote.next({ ...note(2), release: 3 });
      expect(told.setNote.mock.lastCall?.[0]?.release).toBe(3);
      // (the first routes came before any note)
      expect(posted('note')).toEqual([null, note(1), note(2), { ...note(2), release: 3 }]);
      // a preset switch pauses it
      $fxNote.next(null);
      expect(posted('note').pop()).toBeNull();
    });

    it('the node gets no note while no route of an effect that plays follows it', async () => {
      const { modulation, $fxNote, told, posts } = await ready();
      modulation[1].addRoute('env2', 'delay.fb', 0.5);
      $fxNote.next(note(1));
      $fxNote.next({ ...note(1), release: 2 });
      expect(told.setNote).toHaveBeenLastCalledWith({ ...note(1), release: 2 });
      expect(posts()).toEqual([]);
    });

    it('a note at another velocity (of a legato phrase) sends nothing while no route reads VELO', async () => {
      const { actions, modulation, $fxNote, told } = await ready();
      actions.setAdded('delay', true);
      modulation[1].addRoute('env2', 'delay.fb', 0.5);
      $fxNote.next({ ...note(1), velo: 0.3, velocity: 0.3 });
      // no velocity is followed: the note has none
      expect(told.setNote).toHaveBeenLastCalledWith(note(1));
      const calls = told.setNote.mock.calls.length;
      $fxNote.next({ ...note(1), velo: 0.9, velocity: 0.9 });
      expect(told.setNote).toHaveBeenCalledTimes(calls);

      // a route of VELO to an effect that doesn't play reads nothing
      modulation[1].addRoute('velo', 'reverb.mix', 0.5);
      expect(told.setNote).toHaveBeenCalledTimes(calls);
      // it plays: the note with its velocity (the level of VELO, not the share of 127 the chart shows)
      actions.setAdded('reverb', true);
      expect(told.setNote).toHaveBeenCalledTimes(calls + 1);
      expect(told.setNote).toHaveBeenLastCalledWith({ ...note(1), velo: 0.9 });
      $fxNote.next({ ...note(1), velo: 0.2, velocity: 0.2 });
      expect(told.setNote).toHaveBeenLastCalledWith({ ...note(1), velo: 0.2 });
      expect(told.setRoutes.mock.lastCall?.[0]).toContainEqual({
        target: 159,
        source: VELO,
        amount: 0.5,
        min: 0,
        max: 1,
      });
    });

    describe('chainRoutes', () => {
      const effects = () => setup().model.$effects.value;
      const playing = (...types: FxType[]) =>
        Object.fromEntries(FX_TYPES.map((type) => [type, types.includes(type)])) as Record<FxType, boolean>;
      const fxTargets = Object.keys(MOD_TARGETS).filter((id) => MOD_TARGETS[id].kind === 'fx');
      const lfoKnobs = Object.keys(MOD_TARGETS).filter((id) => MOD_TARGETS[id].kind === 'lfo');

      it('none without routes, or with routes to the voices alone', () => {
        expect(chainRoutes([], effects(), playing(...FX_TYPES), {}, 120)).toEqual([]);
        const routes: ModRoute[] = [
          { source: 'env1', target: 'filter.cutoff', amount: 0.5 },
          { source: 'lfo1', target: 'osc1.wave', amount: 0.5 },
          { source: 'env2', target: 'lfo1.rate', amount: 0.5 },
        ];
        expect(chainRoutes(routes, effects(), playing(...FX_TYPES), {}, 120)).toEqual([]);
      });

      it('every knob of every effect has a target of its own in the core', () => {
        const routes = fxTargets.map((id): ModRoute => ({ source: 'env1', target: id, amount: 0.5 }));
        const targets = chainRoutes(routes, effects(), playing(...FX_TYPES), {}, 120).map(
          (route) => route.target
        );
        expect(targets).toHaveLength(fxTargets.length);
        expect(new Set(targets).size).toBe(targets.length);
        expect(targets).toEqual(
          fxTargets.map((id) => {
            const [type, param] = id.split('.') as [FxType, string];
            const key = param === 'mix' ? MIX_KEY : CHAIN_KEYS[type].indexOf(param);
            expect(key).toBeGreaterThanOrEqual(0);
            return SLOT[type] * TARGET_KEYS + key;
          })
        );
        targets.forEach((id) => expect(id).toBeLessThan(LFO_TARGET));
        // a mix for each
        expect(targets.filter((id) => id % TARGET_KEYS === MIX_KEY)).toEqual([31, 63, 95, 127, 159]);
      });

      it('every knob of every LFO has a target after those of the slots, 8 an LFO', () => {
        const routes: ModRoute[] = [
          { source: 'lfo1', target: 'delay.fb', amount: 0.1 },
          ...lfoKnobs.map((id): ModRoute => ({ source: 'env1', target: id, amount: 0.5 })),
        ];
        const [own, ...knobs] = chainRoutes(routes, effects(), playing('delay'), {}, 120);
        expect(own.target).toBe(65);
        expect(lfoKnobs).toHaveLength(4 * LFO_KNOBS.length);
        expect(knobs.map((route) => route.target)).toEqual(
          [0, 1, 2, 3].flatMap((lfo) => LFO_KNOBS.map((_, knob) => 160 + lfo * 8 + knob))
        );
        expect(lfoKnobs[LFO_KNOBS.length * 2 + 3]).toBe('lfo3.smooth');
        expect(knobs[LFO_KNOBS.length * 2 + 3].target).toBe(179);
      });

      it('an effect that does not play contributes no route', () => {
        const routes: ModRoute[] = [
          { source: 'env2', target: 'delay.time', amount: 0.5 },
          { source: 'env3', target: 'reverb.size', amount: 0.5 },
        ];
        const all = effects();
        expect(chainRoutes(routes, all, playing(), {}, 120)).toEqual([]);
        expect(chainRoutes(routes, all, playing('reverb'), {}, 120)).toEqual([
          { target: 130, source: ENV3, amount: 0.5, min: 0, max: 1 },
        ]);
        expect(
          chainRoutes(routes, all, playing('delay', 'reverb'), {}, 120).map((route) => route.target)
        ).toEqual([64, 130]);
      });

      it('the routes to the knobs of the LFOs come only with a route of an LFO to an effect that plays', () => {
        const knob: ModRoute = { source: 'env2', target: 'lfo2.rate', amount: 0.25 };
        const lfo: ModRoute = { source: 'lfo2', target: 'reverb.size', amount: 0.5 };
        const env: ModRoute = { source: 'env1', target: 'reverb.size', amount: 0.5 };
        const targets = (routes: ModRoute[], ...types: FxType[]) =>
          chainRoutes(routes, effects(), playing(...types), {}, 120).map((route) => route.target);
        expect(targets([knob, lfo], 'reverb')).toEqual([130, 168]);
        // an envelope reads no LFO
        expect(targets([knob, env], 'reverb')).toEqual([130]);
        // the LFO moves a knob of an effect that doesn't play
        expect(targets([knob, lfo], 'delay')).toEqual([]);
        // switched off or of amount 0: left out
        expect(targets([{ ...knob, off: true }, lfo], 'reverb')).toEqual([130]);
        expect(targets([{ ...knob, amount: 0 }, lfo], 'reverb')).toEqual([130]);
        expect(targets([knob, { ...lfo, off: true }], 'reverb')).toEqual([]);
      });

      it('the bounds: of the knob, of Time and Rate in BPM at the tempo, of an LFO in BPM its ranges', () => {
        const routes: ModRoute[] = [
          { source: 'lfo1', target: 'delay.time', amount: 0.5 },
          { source: 'env1', target: 'chorus.rate', amount: 0.5 },
          { source: 'env1', target: 'lfo1.rate', amount: 0.5 },
        ];
        const all = effects();
        const bounds = (...args: Parameters<typeof chainRoutes>) =>
          chainRoutes(...args).map(({ min, max }) => [min, max]);
        expect(bounds(routes, all, playing('chorus', 'delay'), {}, 120)).toEqual([
          [0, 20],
          [0.01, 1],
          [1 / 32, 100],
        ]);
        const synced = {
          ...all,
          delay: { ...all.delay, params: { ...all.delay.params, sync: 1 } },
          chorus: { ...all.chorus, params: { ...all.chorus.params, sync: 1 } },
        };
        expect(bounds(routes, synced, playing('chorus', 'delay'), { 'lfo1.rate': [0.5, 8] }, 60)).toEqual([
          [1 / 32, 8],
          [0.0625, 4],
          [0.5, 8],
        ]);
      });
    });

    describe('chainNote', () => {
      const velo = [{ target: 159, source: VELO, amount: 0.5, min: 0, max: 1 }];
      const env = [{ target: 65, source: ENV2, amount: 0.5, min: 0, max: 0.9 }];

      it('no note: none', () => {
        expect(chainNote(null, velo)).toBeNull();
      });

      it('the envelopes and their times, the levels they start from only when it has them', () => {
        expect(chainNote({ ...note(1), velo: 0.5, velocity: 0.5 }, env)).toEqual(note(1));
        expect(chainNote({ ...note(1), release: 2, from: [0, 0.4, 0] }, [])).toEqual({
          ...note(1),
          release: 2,
          from: [0, 0.4, 0],
        });
        expect(chainNote(note(1), env)).not.toHaveProperty('from');
      });

      it('its velocity only while a route reads VELO, a level of 0 included; never the share of 127', () => {
        expect(chainNote({ ...note(1), velo: 0.7, velocity: 0.6 }, velo)).toEqual({ ...note(1), velo: 0.7 });
        expect(chainNote({ ...note(1), velo: 0, velocity: 0 }, [...env, ...velo])).toEqual({
          ...note(1),
          velo: 0,
        });
        expect(chainNote({ ...note(1), velo: 0.7 }, env)).not.toHaveProperty('velo');
        // a note without one (the track before its first velocity)
        expect(chainNote(note(1), velo)).not.toHaveProperty('velo');
      });
    });
  });
});
