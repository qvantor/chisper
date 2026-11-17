import type { LfosState } from '../lfo/lfo-curve';
import { UnitExports } from '../wasm/stereo-core';
import { createView } from '../wasm/wasm-core';
import {
  CHAIN_EVENT,
  CHAIN_KEYS,
  ChainNote,
  ChainRoute,
  ChainState,
  ENVELOPES,
  FX_KINDS,
  LFO_STATE,
  LFO_TABLE,
  MAX_PARAMS,
  NOTE,
  ROUTE,
  ROUTE_SCALES,
} from './chain-params';

// The chain core (dsp/chain, chain.wasm) as a worklet and a render on the main thread drive it: the events of
// the knobs with their frame, the routes, the note and the LFOs, a block at a frame, what failed. A trap inside
// an effect is caught here: the stack pointer back, the effect dropped by the core, the block finished without it

export interface ChainExports extends UnitExports {
  chain_new: (sampleRate: number, limited: number) => number;
  chain_free: (chain: number) => void;
  chain_buffers: (chain: number, frames: number) => number;
  chain_process: (chain: number, frame: number) => void;
  chain_fail: (chain: number) => number;
  chain_resume: (chain: number) => void;
  chain_reports: (chain: number) => number;
  chain_retry: (chain: number, stage: number) => number;
  chain_event: (chain: number, at: number) => void;
  chain_scratch: (chain: number, length: number) => number;
  chain_routes: (chain: number, count: number) => void;
  chain_note: (chain: number, present: number) => void;
  chain_lfo_table: (chain: number, lfo: number) => void;
  chain_lfos: (chain: number, at: number, instantly: number) => void;
  chain_meter: (chain: number, kind: number) => number;
  chain_idle: (chain: number, kind: number) => number;
  chain_latency: (chain: number) => number;
  // (the perf build: the specs)
  chain_trap?: (chain: number, stage: number, call: number) => void;
  chain_layout?: () => number;
  chain_key?: (kind: number, key: number) => number;
}

const STAGES = FX_KINDS.length + 1;
// the calls of a unit a trap of the specs is in (chain.rs: IN_PROCESS…): its block, a knob, a rest, its sound
// forgotten, as a retry makes it
export const TRAP_IN = { process: 0, set: 1, rest: 2, forget: 3, make: 5 };

export interface ChainWasmOptions {
  // without its limiter (a render at another rate runs one apart)
  limited?: boolean;
}

export const createChainWasm = (
  exports: ChainExports,
  sampleRate: number,
  state: ChainState,
  { limited = true }: ChainWasmOptions = {}
) => {
  const doubles = createView(exports, Float64Array);
  // (a static of the core: it never moves)
  const commandAt = exports.unit_command();
  const command = () => doubles(commandAt, FX_KINDS.length * MAX_PARAMS);

  const options = command();
  options.fill(0);
  FX_KINDS.forEach((kind, slot) =>
    CHAIN_KEYS[kind].forEach((key, index) => {
      options[slot * MAX_PARAMS + index] = state.slots[kind].params[key] ?? 0;
    })
  );
  const handle = exports.chain_new(sampleRate, limited ? 1 : 0);

  // an event of the core from frame `at` on: its kind, a, b, then the values
  const event = (kind: number, a: number, b: number, at: number) => {
    const buffer = command();
    buffer[0] = kind;
    buffer[1] = a;
    buffer[2] = b;
    exports.chain_event(handle, at);
  };
  // the values of an event, from VALUES of the buffer on: all 0
  const VALUES = 3;
  const values = () => command().fill(0, VALUES, VALUES + MAX_PARAMS);
  const scratchView = createView(exports, Float64Array);
  const scratch = (length: number) => scratchView(exports.chain_scratch(handle, length), length);

  const [viewInL, viewInR, viewOutL, viewOutR] = [0, 1, 2, 3].map(() => createView(exports));
  let freed = false;

  const chain = {
    // the params of a slot that changed (by the keys of its kind: others are ignored)
    setParams: (slot: number, params: Record<string, number>, at = 0) => {
      const keys = CHAIN_KEYS[FX_KINDS[slot]];
      let present = 0;
      const buffer = values();
      for (let index = 0; index < keys.length; index++) {
        const value = params[keys[index]];
        if (value === undefined) continue;
        present |= 1 << index;
        buffer[VALUES + index] = value;
      }
      if (present) event(CHAIN_EVENT.params, slot, present, at);
    },
    setMix: (slot: number, mix: number, at = 0) => event(CHAIN_EVENT.mix, slot, mix, at),
    setActive: (slot: number, active: boolean, at = 0) => event(CHAIN_EVENT.active, slot, active ? 1 : 0, at),
    // the slots in the chain, in their order
    setOrder: (order: number[], at = 0) => {
      const buffer = values();
      for (let place = 0; place < order.length; place++) buffer[VALUES + place] = order[place];
      event(CHAIN_EVENT.order, order.length, 0, at);
    },
    setMasterGain: (gain: number, at = 0) => event(CHAIN_EVENT.masterGain, gain, 0, at),
    // the output fades out in `seconds`, opens again at once (with a frame: the fade ends `seconds` after it,
    // however late the event is taken)
    mute: (seconds: number, at = 0) => event(CHAIN_EVENT.mute, seconds, 0, at),
    unmute: (at = 0) => event(CHAIN_EVENT.unmute, 0, 0, at),
    // the tails of the effects and the limiter forgotten, the gains of the slots where their knobs have them
    clear: (at = 0) => event(CHAIN_EVENT.clear, 0, 0, at),
    // the routes of the knobs, at once
    setRoutes: (routes: ChainRoute[]) => {
      const buffer = scratch(Math.max(1, routes.length * ROUTE));
      routes.forEach(({ target, source, amount, min, max, scale = 'linear', bipolar }, index) =>
        buffer.set(
          [target, source, amount, min, max, Math.max(0, ROUTE_SCALES.indexOf(scale)), bipolar ? 1 : 0],
          index * ROUTE
        )
      );
      exports.chain_routes(handle, routes.length);
    },
    // the last note (null: none), taken at its start
    setNote: (note: ChainNote | null) => {
      const buffer = scratch(NOTE);
      if (!note) {
        exports.chain_note(handle, 0);
        return;
      }
      buffer.fill(0);
      buffer[0] = note.start;
      buffer[1] = note.release ?? NaN;
      buffer[2] = note.velo ?? 0;
      buffer[3] = note.from ? 1 : 0;
      for (let envelope = 0; envelope < ENVELOPES; envelope++) {
        const params = note.envelopes[envelope];
        buffer[4 + envelope] = note.from?.[envelope] ?? 0;
        if (!params) continue;
        const { attack, hold, decay, sustain, release, curves } = params;
        buffer.set(
          [
            attack,
            hold,
            decay,
            sustain,
            release,
            curves?.attack ?? 0,
            curves?.decay ?? 0,
            curves?.release ?? 0,
          ],
          7 + envelope * 8
        );
      }
      exports.chain_note(handle, 1);
    },
    // the LFOs from the time of a state on
    setLfos: ({ at, instantly, lfos }: LfosState) => {
      lfos.forEach(({ table }, lfo) => {
        if (!table) return;
        scratch(LFO_TABLE).set(table.subarray(0, LFO_TABLE));
        exports.chain_lfo_table(handle, lfo);
      });
      const buffer = scratch(lfos.length * LFO_STATE);
      lfos.forEach(({ mode, delay, rise, smooth, phase, anchor, table }, lfo) =>
        buffer.set(
          [mode, delay, rise, smooth, phase, anchor.time, anchor.phase, anchor.period, table ? 1 : 0],
          lfo * LFO_STATE
        )
      );
      exports.chain_lfos(handle, at, instantly ? 1 : 0);
    },
    // a block at `frame` of the context: the inputs into the memory of the core, the block rendered, the outputs
    // out of it. A stage that traps is dropped and the block finished without it (reports() tells which); a trap
    // that is in no stage leaves the block silent: false (the core is where the trap left it, not to be used)
    process: (
      inL: Float32Array,
      inR: Float32Array,
      outL: Float32Array,
      outR: Float32Array,
      frame: number
    ) => {
      const frames = outL.length;
      const bytes = 4 * frames;
      // (guarded here, not by instantiateCore: no closure per block)
      const stack = exports.__stack_pointer.value;
      let at = 0;
      try {
        at = exports.chain_buffers(handle, frames);
        viewInL(at, frames).set(inL);
        viewInR(at + bytes, frames).set(inR);
        exports.chain_process(handle, frame);
      } catch {
        let done = false;
        for (let stage = 0; stage < STAGES && !done; stage++) {
          exports.__stack_pointer.value = stack;
          if (at === 0 || !exports.chain_fail(handle)) break;
          try {
            exports.chain_resume(handle);
            done = true;
          } catch {
            // the next stage trapped too
          }
        }
        if (!done) {
          exports.__stack_pointer.value = stack;
          outL.fill(0);
          outR.fill(0);
          return false;
        }
      }
      // (a view is made again if the memory grew)
      outL.set(viewOutL(at + 2 * bytes, frames));
      outR.set(viewOutR(at + 3 * bytes, frames));
      return true;
    },
    // the stages that failed since the last call: the bit of each (a slot, then the limiter)
    reports: () => exports.chain_reports(handle),
    // the unit of a stage that failed made again: whether the stage has one now (not when making it trapped)
    retry: (stage: number) => {
      try {
        return exports.chain_retry(handle, stage) !== 0;
      } catch {
        return false;
      }
    },
    // the meter of the effect of a slot: its values in the command buffer, how many (they hold until the next
    // call of the core)
    meter: (slot: number) => {
      const count = exports.chain_meter(handle, slot);
      return command().subarray(0, count);
    },
    // the effect of a slot has nothing to play
    idle: (slot: number) => exports.chain_idle(handle, slot) !== 0,
    // the samples the limiter delays the sound by
    latency: exports.chain_latency(handle),
    // the stage traps from now on, in a call of its unit (TRAP_IN: its block unless told; the specs: the perf
    // build)
    trap: (stage: number, call: number = TRAP_IN.process) => exports.chain_trap?.(handle, stage, call),
    free: () => {
      if (freed) return;
      freed = true;
      exports.chain_free(handle);
    },
  };

  // the rest of the state: what the knobs, the routes and the LFOs are when it is made
  chain.setOrder(state.order);
  FX_KINDS.forEach((kind, slot) => {
    chain.setMix(slot, state.slots[kind].mix);
    chain.setActive(slot, state.slots[kind].active);
  });
  chain.setMasterGain(state.masterGain);
  if (state.muted) chain.mute(0);
  // (the gains of the slots at their knobs at once: a new chain has no sound to fade from)
  chain.clear();
  if (state.lfos) chain.setLfos(state.lfos);
  if (state.routes.length > 0) chain.setRoutes(state.routes);
  if (state.note) chain.setNote(state.note);
  return chain;
};
export type ChainWasm = ReturnType<typeof createChainWasm>;
