import type { EnvelopeParams } from '../envelope/envelope-curve';
import type { LfosState } from '../lfo/lfo-curve';

// The chain (dsp/chain, in engine.wasm): everything after the voices in the node of the engine, the effects in
// their slots, the master gain and the limiter. What the main thread, the worklet and the specs share of it: no
// imports but types, no window or document (a worklet module imports it)

// the kinds of the effects: the slot of each by its index (FX_TYPES of the preset schema, not imported: it would
// bundle zod; a spec holds them equal), then the stage of the limiter
export const FX_KINDS = ['distortion', 'chorus', 'delay', 'compressor', 'reverb', 'eq', 'fxfilter'] as const;
export type FxKind = (typeof FX_KINDS)[number];
export const LIMITER_STAGE = FX_KINDS.length;

// the params of each kind in the order of its crate (dsp/<kind>/src/lib.rs, dsp/chain/src/delay.rs, eq.rs,
// fxfilter.rs): the index of a key is its key in the core
export const CHAIN_KEYS: Record<FxKind, readonly string[]> = {
  distortion: ['mode', 'drive', 'tone', 'level'],
  chorus: ['rate', 'd1', 'd2', 'depth', 'fb', 'cut', 'hpf', 'level', 'mix'],
  delay: ['time', 'fb', 'mode', 'pan', 'freq', 'q'],
  compressor: [
    'multi',
    'thresh',
    'ratio',
    'attack',
    'release',
    'gain',
    'xlow',
    'xhigh',
    'below',
    'low',
    'mid',
    'high',
    'level',
    'mix',
  ],
  reverb: [
    'lowcut',
    'pre',
    'size',
    'decay',
    'damp',
    'bass',
    'depth',
    'sep',
    'er',
    'drive',
    'bandwidth',
    'body',
  ],
  eq: ['t1', 'f1', 'q1', 'g1', 't2', 'f2', 'q2', 'g2', 'level'],
  fxfilter: ['type', 'cutoff', 'res', 'drive', 'var', 'pan', 'level', 'mix'],
};
// the most params a kind has in the core (units.rs)
export const MAX_PARAMS = 16;
// the values of a route, of a note (7, then 8 of each envelope) and of a state of an LFO as the core takes them,
// the levels of a shape of an LFO (modulation.rs; chain-layout.spec holds all of these to the core)
export const ROUTE = 7;
export const ENVELOPES = 3;
export const NOTE = 7 + ENVELOPES * 8;
export const LFO_STATE = 9;
export const LFO_TABLE = 2049;

// the params a chain is made with before it is told its own (a module that prewarms itself, a node made before the
// fx model): the defaults of the knobs, the eras and the tempo resolved
export const NEUTRAL_PARAMS: Record<FxKind, Record<string, number>> = {
  distortion: { mode: 0, drive: 8, tone: 20000, level: 0 },
  chorus: { rate: 0.078, d1: 5, d2: 0, depth: 26, fb: 0.095, cut: 1000, hpf: 0, level: 0.5, mix: 0.5 },
  delay: { time: 0.2, fb: 0.5, mode: 0, pan: 0, freq: 1000, q: 0.01 },
  compressor: {
    multi: 0,
    thresh: 0.5,
    ratio: 4,
    attack: 90,
    release: 90,
    gain: 0,
    xlow: 131,
    xhigh: 2500,
    below: 0,
    low: 0,
    mid: 0,
    high: 0,
    level: 0.5,
    mix: 1,
  },
  reverb: {
    lowcut: 20,
    pre: 0.02,
    size: 0.5,
    decay: 2,
    damp: 6000,
    bass: 1,
    depth: 0.2,
    sep: 1,
    er: 0.5,
    drive: 0,
    bandwidth: 10000,
    body: 1,
  },
  eq: { t1: 0, f1: 210, q1: 60, g1: 0, t2: 0, f2: 2040, q2: 60, g2: 0, level: 0.5 },
  fxfilter: { type: 0, cutoff: 425, res: 0, drive: 0, var: 0, pan: 50, level: 0.5, mix: 1 },
};

// the events of the core (chain.rs)
export const CHAIN_EVENT = {
  params: 0,
  mix: 1,
  active: 2,
  order: 3,
  masterGain: 4,
  mute: 5,
  unmute: 6,
  clear: 7,
  macros: 8,
} as const;

// the targets of the routes in the core (modulation.rs): slot · KEYS + the key of a param of its effect, MIX_KEY the
// mix of the slot; from LFO_TARGET on lfo · LFO_KEYS + a knob of an LFO
export const TARGET_KEYS = 32;
export const MIX_KEY = 31;
export const LFO_TARGET = FX_KINDS.length * TARGET_KEYS;
// the target of a param of the effect of a kind, or of the mix of its slot
export const chainTarget = (kind: FxKind, key: string) =>
  FX_KINDS.indexOf(kind) * TARGET_KEYS + (key === 'mix' ? MIX_KEY : CHAIN_KEYS[kind].indexOf(key));
export const LFO_KEYS = 8;
export const LFO_KNOBS = ['rate', 'delay', 'rise', 'smooth', 'phase'] as const;
// the sources: ENV 1–3, VELO, LFO 1–4, MACRO 1–4 (MOD_SOURCES)
export const LFO_SOURCE = 4;
export const MACRO_SOURCE = 8;
export const MACROS = 4;
// a source is an LFO (the macros come after them), a macro
export const isLfoSource = (source: number) => source >= LFO_SOURCE && source < MACRO_SOURCE;
export const isMacroSource = (source: number) => source >= MACRO_SOURCE && source < MACRO_SOURCE + MACROS;

// the levels of the macros as both halves of the engine take them (macros.rs of dsp-core): MACROS of them within
// 0..1 (null: that macro as it is), from the first block at `at` (seconds of the context) or after it (absent: the
// next block), in the order sent; `instantly`: there at once (a node made again). Each glides to its level in 10 ms
export interface MacrosState {
  levels: readonly (number | null)[];
  at?: number;
  instantly?: boolean;
}
export const ROUTE_SCALES = ['linear', 'log', 'pow'] as const;

// a route as the core takes it: `source` moves the knob `target` by amount × its level (bipolar: amount × (level -
// ½)) in the units and the scale of the knob, within min..max
export interface ChainRoute {
  target: number;
  source: number;
  amount: number;
  min: number;
  max: number;
  scale?: (typeof ROUTE_SCALES)[number];
  bipolar?: boolean;
}

// the last note the knobs follow (FxNote of fx-modulation.ts): its envelopes, the seconds of the context they
// started at and were released at (null: held), the levels they start their attacks from, its velocity
export interface ChainNote {
  envelopes: EnvelopeParams[];
  start: number;
  release: number | null;
  from?: number[];
  velo?: number;
}

// a slot as the chain has it: the params of its effect by the keys of the core, its mix, whether it plays (in the
// chain, on and ready)
export interface ChainSlot {
  params: Record<string, number>;
  mix: number;
  active: boolean;
}

// the whole of a chain, what a node is made with (processorOptions: its params go only there in a render, a
// message would come at an unpredictable block)
export interface ChainState {
  slots: Record<FxKind, ChainSlot>;
  // the kinds in the chain, in their order
  order: number[];
  masterGain: number;
  muted: boolean;
  routes: ChainRoute[];
  note: ChainNote | null;
  lfos: LfosState | null;
  // the kinds whose meter is watched
  meters: number[];
}

export const neutralState = (): ChainState => ({
  slots: Object.fromEntries(
    FX_KINDS.map((kind) => [kind, { params: { ...NEUTRAL_PARAMS[kind] }, mix: 1, active: false }])
  ) as Record<FxKind, ChainSlot>,
  order: [],
  masterGain: 1,
  muted: false,
  routes: [],
  note: null,
  lfos: null,
  meters: [],
});

// main thread → worklet, its fields taken in this order. `at`: the seconds of the context its events take effect
// from (absent: the next block); the routes are taken at once, the note at its start, the LFOs at their own time
export interface ChainMessage {
  at?: number;
  // [kind, the params that changed]
  params?: [number, Record<string, number>];
  mix?: [number, number];
  active?: [number, boolean];
  order?: number[];
  masterGain?: number;
  // seconds of the fade
  mute?: number;
  unmute?: true;
  // everything forgotten: the tails of the effects, the limiter (a preset switch)
  clear?: true;
  routes?: ChainRoute[];
  note?: ChainNote | null;
  lfos?: LfosState;
  macros?: MacrosState;
  // [kind, watched]
  meter?: [number, boolean];
  // the unit of a stage that failed made again (a kind, LIMITER_STAGE)
  retry?: number;
  stop?: true;
}

// worklet → main thread: the meter of a kind (about 30 times a second while it is watched), the stages that
// failed (a trap inside an effect: its slot passes its input; inside the limiter: the master is silent), the
// core itself failed (a trap that is in no stage: its node is silent from then on, a new one is made of the state)
export interface ChainReport {
  meter?: [number, unknown];
  failed?: number[];
  // the stage a retry made again (one it could not make is in `failed` once more)
  remade?: number;
  broken?: true;
}
