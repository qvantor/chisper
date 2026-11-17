import { wasmCore } from '../../../../test-utils/wasm';
import {
  CHAIN_EVENT,
  CHAIN_KEYS,
  ENVELOPES,
  FX_KINDS,
  LFO_KEYS,
  LFO_KNOBS,
  LFO_SOURCE,
  LFO_STATE,
  LFO_TABLE,
  LFO_TARGET,
  LIMITER_STAGE,
  MAX_PARAMS,
  MIX_KEY,
  NOTE,
  ROUTE,
  TARGET_KEYS,
} from './chain-params';
import type { ChainExports } from './chain-wasm';

// What the wrapper of the chain has in numbers of its own (chain-params.ts: the sizes of what it writes into the
// core, the targets of the routes, the events, the keys of the params of each kind in the order of its crate)
// against what the core says of itself (chain_layout and chain_key of the perf build): a param or a value added
// on one side alone would move the others to the keys next to them, and no golden of a crate would tell

const core = wasmCore<ChainExports>('chain');
const command = (count: number) => [
  ...new Float64Array(core.memory.buffer, core.unit_command() >>> 0, count),
];

// the values of chain_layout before those of the kinds, in its order
const SIZES = [
  'slots',
  'maxParams',
  'maxMeter',
  'route',
  'note',
  'lfoState',
  'lfoTable',
  'envelopes',
  'lfoSource',
  'lfos',
  'targetKeys',
  'mixKey',
  'lfoTarget',
  'lfoKeys',
  'limiterStage',
  ...['params', 'mix', 'active', 'order', 'masterGain', 'mute', 'unmute', 'clear'].map(
    (event) => `event.${event}`
  ),
  ...['rate', 'delay', 'rise', 'smooth', 'phase'].map((knob) => `knob.${knob}`),
];
// then of each kind: its kind, how many params it has, the key of its mix (-1: its slot mixes)
const KIND = 3;

const layout = () => {
  const values = command(core.chain_layout?.() ?? 0);
  return {
    sizes: Object.fromEntries(SIZES.map((name, index) => [name, values[index]])),
    kinds: values.slice(SIZES.length),
  };
};

const keyOf = (kind: number, key: number) =>
  String.fromCharCode(...command(core.chain_key?.(kind, key) ?? 0));

describe('the layout of the chain core', () => {
  it('has the sizes, the targets and the events the wrapper writes it by', () => {
    expect(layout().sizes).toEqual({
      slots: FX_KINDS.length,
      maxParams: MAX_PARAMS,
      maxMeter: expect.any(Number),
      route: ROUTE,
      note: NOTE,
      lfoState: LFO_STATE,
      lfoTable: LFO_TABLE,
      envelopes: ENVELOPES,
      lfoSource: LFO_SOURCE,
      lfos: 4,
      targetKeys: TARGET_KEYS,
      mixKey: MIX_KEY,
      lfoTarget: LFO_TARGET,
      lfoKeys: LFO_KEYS,
      limiterStage: LIMITER_STAGE,
      ...Object.fromEntries(Object.entries(CHAIN_EVENT).map(([event, kind]) => [`event.${event}`, kind])),
      ...Object.fromEntries(LFO_KNOBS.map((knob, index) => [`knob.${knob}`, index])),
    });
    expect(Object.keys(CHAIN_EVENT)).toHaveLength(8);
    expect(LFO_KNOBS).toHaveLength(5);
  });

  it('has the kinds in the order of the slots, each with as many params and its mix at the same key', () => {
    const { kinds } = layout();
    expect(kinds).toHaveLength(FX_KINDS.length * KIND);
    expect(kinds).toEqual(
      FX_KINDS.flatMap((kind, slot) => [slot, CHAIN_KEYS[kind].length, CHAIN_KEYS[kind].indexOf('mix')])
    );
    FX_KINDS.forEach((kind) => expect(CHAIN_KEYS[kind].length).toBeLessThanOrEqual(MAX_PARAMS));
  });

  it.each(FX_KINDS.map((kind, slot) => [kind, slot] as const))(
    'has the params of the %s under the keys of the wrapper',
    (kind, slot) => {
      expect(CHAIN_KEYS[kind].map((_, key) => keyOf(slot, key))).toEqual(CHAIN_KEYS[kind]);
      // (no param after the last one)
      expect(core.chain_key?.(slot, CHAIN_KEYS[kind].length)).toBe(0);
    }
  );
});
