import { wasmCore } from '../../../../test-utils/wasm';
import { FX_KINDS, neutralState } from '../chain/chain-params';
import { createEngineWasm, EngineExports } from '../engine/engine-wasm';
import type { VoiceEvent, VoicesReportMessage } from './voice-options';
import { prewarmVoices, WarmVoices, WarmVoicesFactory } from './voices-prewarm';
import {
  createOscScope,
  createTableStoreWasm,
  createVoiceScopeWasm,
  TableStoreWasm,
  VoiceSharedWasm,
} from './wavetable-osc-wasm';

const RATE = 48000;

// one instance for the spec file, as the scope of a context
const core = wasmCore<EngineExports>('engine');

// a scope on the core with some of its exports recorded (the arguments of each call), and a store of it as the
// one of a worklet (made before the calls are recorded)
const counted = <K extends keyof EngineExports>(names: K[]) => {
  const calls = Object.fromEntries(names.map((name) => [name, [] as unknown[][]])) as Record<K, unknown[][]>;
  const spied = Object.fromEntries(
    names.map((name) => [
      name,
      (...args: unknown[]) => {
        calls[name].push(args);
        return (core[name] as (...all: unknown[]) => unknown)(...args);
      },
    ])
  );
  const scope = createOscScope({ ...core, ...spied } as EngineExports);
  const store = createTableStoreWasm(scope);
  names.forEach((name) => calls[name].splice(0));
  return { scope, store, calls };
};

// the voices of the warm-up in a scope of voices, what they were told and what they told
const recorded = (scope: ReturnType<typeof createOscScope>) => {
  const made: { store: TableStoreWasm; shared: VoiceSharedWasm }[] = [];
  const log: string[] = [];
  const applied: VoiceEvent[][] = [];
  const frames: number[] = [];
  const told: VoicesReportMessage[] = [];
  const factory: WarmVoicesFactory = (store, shared) => {
    made.push({ store, shared });
    const voices = createVoiceScopeWasm(scope, RATE, store, shared);
    return {
      apply: (events) => {
        log.push('apply');
        applied.push(events);
        voices.apply(events);
      },
      process: (frame, outL, outR) => {
        log.push('process');
        frames.push(frame);
        expect(outL).toHaveLength(128);
        expect(outR).toHaveLength(128);
        voices.process(frame, outL, outR);
      },
      reports: () => {
        log.push('reports');
        const report = voices.reports();
        if (report) told.push(report);
      },
      free: () => {
        log.push('free');
        voices.free();
      },
    };
  };
  return { factory, made, log, applied, frames, told };
};

describe('the warm-up of the voices', () => {
  it('renders a voice alone, one warped and one of PWM swept, then the voices of a scope of its own, and frees what it made', () => {
    const { scope, store, calls } = counted([
      'osc_store_new',
      'osc_store_free',
      'osc_shared_new',
      'osc_shared_free',
      'osc_voice_new',
      'osc_voice_process',
      'osc_voice_free',
      'osc_scope_new',
      'osc_scope_process',
      'osc_scope_fail',
      'osc_scope_free',
    ]);
    const before = store.stats();
    prewarmVoices(scope, store, RATE);
    expect(Object.fromEntries(Object.entries(calls).map(([name, all]) => [name, all.length]))).toEqual({
      osc_store_new: 1,
      osc_store_free: 1,
      osc_shared_new: 1,
      osc_shared_free: 1,
      osc_voice_new: 3,
      osc_voice_process: 22,
      osc_voice_free: 3,
      osc_scope_new: 1,
      osc_scope_process: 6,
      osc_scope_fail: 0,
      osc_scope_free: 1,
    });
    // (the same blocks of 128 frames of each voice alone: the warped one across the frames at the same pitches;
    // then two of PWM, its pitch swept up and down)
    expect(calls.osc_voice_process.map(([, , , frame, frames]) => [frame, frames])).toEqual([
      ...[0, 1].flatMap(() => [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((index) => [index * 128, 128])),
      [0, 128],
      [128, 128],
    ]);
    // (the blocks of the scope of 128 frames, one after another)
    expect(calls.osc_scope_process.map(([, , , frame, frames]) => [frame, frames])).toEqual(
      [0, 1, 2, 3, 4, 5].map((index) => [index * 128, 128])
    );
    // (on a store and a shared of its own: the store of the scope has no table of it)
    const [[warmStore]] = calls.osc_store_free;
    expect(warmStore).not.toBe(store.handle);
    expect(calls.osc_scope_free[0].slice(1)).toEqual([warmStore, calls.osc_shared_free[0][0]]);
    expect(store.stats()).toEqual(before);
    store.free();
  });

  it('runs at the rates of a context', () => {
    const { scope, store, calls } = counted(['osc_scope_fail']);
    [44100, 96000, 192000].forEach((rate) => prewarmVoices(scope, store, rate));
    expect(calls.osc_scope_fail).toHaveLength(0);
    store.free();
  });

  it('gives the kernels of the noise its store built to the store of the scope, before it frees its own', () => {
    const { scope, store, calls } = counted(['osc_store_take_kernels', 'osc_store_free']);
    const order: string[] = [];
    const { osc_store_take_kernels: take, osc_store_free: free } = scope.exports;
    Object.assign(scope.exports, {
      osc_store_take_kernels: (...args: [number, number]) => {
        order.push('take');
        return take(...args);
      },
      osc_store_free: (handle: number) => {
        order.push('free');
        return free(handle);
      },
    });
    prewarmVoices(scope, store, RATE);
    expect(order).toEqual(['take', 'free']);
    expect(calls.osc_store_take_kernels).toEqual([[store.handle, calls.osc_store_free[0][0]]]);
    store.free();
  });

  it('renders the voices in what its factory makes, on its own store and shared: six blocks, their reports read', () => {
    const { scope, store } = counted([]);
    const { factory, made, log, applied, frames, told } = recorded(scope);
    prewarmVoices(scope, store, RATE, factory);
    expect(made).toHaveLength(1);
    expect(made[0].store.handle).not.toBe(store.handle);
    // its events, then a block and its reports six times (the knobs of the blocks 1 and 2 before them), then freed
    expect(log).toEqual([
      'apply',
      ...['process', 'reports'],
      ...['apply', 'process', 'reports'],
      ...['apply', 'process', 'reports'],
      ...['process', 'reports'],
      ...['process', 'reports'],
      ...['process', 'reports'],
      'free',
    ]);
    expect(frames).toEqual([0, 128, 256, 384, 512, 640]);
    // the voice of both oscillators, its noise and its sub, then one for each path of the filters
    const notes = applied[0].flatMap((event) => (event.kind === 'on' ? [event] : []));
    const voices = Array.from({ length: 16 }, (_, voice) => voice);
    expect(notes.map(({ voice }) => voice)).toEqual(voices);
    // (its oscillators warped: a bend and PWM, the knob of the bend routed by ENV 2)
    expect(notes[0].options).toMatchObject({
      osc: [
        { unison: 4, warpMode: 1, warp: 0.5 },
        { unison: 3, warpMode: 4, warp: 0.5 },
      ],
      noise: { sample: 'warm-mono', loop: false },
      sub: { contiguous: true },
    });
    expect(notes[0].options.routes).toContainEqual({
      source: 1,
      param: 'warp1',
      amount: 0.25,
      min: 0,
      max: 1,
    });
    expect(notes.slice(1).map(({ options }) => options.filter?.type)).toEqual([
      'bandpass',
      'low24',
      'low24',
      'ladder12',
      'ladder12',
      'ladder12',
      'ladder12',
      'low24',
      'low24',
      'ladder12',
      'ladder12',
      'ladder12',
      'ladder12',
      'low24',
      'lowpass',
    ]);
    // (a pluck on the cutoff of a pair, four Ladders and one alone: ENV 2 sweeps it six octaves in its attack, a
    // span in pieces, lines that step every sample; the others have no route)
    const sweep = { source: 1, param: 'cutoff', amount: 6, min: 20, max: 20000, scale: 'log' };
    expect(notes.slice(1).map(({ voice, options }) => [voice, options.routes])).toEqual(
      notes.slice(1).map(({ voice }) => [voice, voice >= 8 && voice <= 14 ? [sweep] : []])
    );
    expect(notes.slice(8, 15).map(({ options }) => options.filter?.cutoff)).toEqual(Array(7).fill(200));
    // the automation of its params, its velocity, the bend and the LFOs (a state at once, one that glides)
    const kinds = new Set(applied.flat().map(({ kind }) => kind));
    expect([...kinds].sort()).toEqual(
      ['bend', 'cancel', 'filter', 'knobs', 'on', 'ramp', 'set', 'target', 'velocity'].sort()
    );
    expect(applied[1]).toEqual([expect.objectContaining({ kind: 'filter', voices: [4, 5, 6, 7] })]);
    expect(applied[2].map((event) => [event.kind, 'module' in event ? event.module : null])).toEqual([
      ['knobs', 'noise'],
      ['knobs', 'sub'],
      ['knobs', 'warp'],
      ['filter', null],
    ]);
    // (the knobs of its warp both glide, its PWM goes into Bend -: a new mode on a playing note crossfades)
    expect(applied[2][2]).toEqual({
      kind: 'knobs',
      voices: [0],
      module: 'warp',
      values: { mode1: 1, warp1: 0.75, mode2: 2, warp2: 0.25 },
    });
    // every voice started on time; the first one, stolen in block 4, still fades when the scope is freed
    const started = told.flatMap((report) => report.started ?? []);
    expect(started.map(([voice]) => voice).sort((a, b) => a - b)).toEqual(voices);
    started.forEach(([, frame, start]) => {
      expect(frame).toBe(0);
      expect(start).toBeCloseTo(0);
    });
    expect(told.flatMap((report) => report.ended ?? [])).toEqual([]);
    expect(applied[0]).toContainEqual({
      kind: 'set',
      voice: 0,
      param: 'gate',
      value: -1,
      time: (4 * 128) / RATE,
    });
    store.free();
  });

  it('renders them in an engine: its block, the one a node calls, with every effect on', () => {
    const { scope, store, calls } = counted([
      'engine_new',
      'engine_process',
      'engine_fail',
      'engine_free',
      'osc_scope_process',
      'osc_scope_free',
      'chain_process',
      'chain_free',
    ]);
    const flags: unknown[] = [];
    prewarmVoices(scope, store, RATE, (warmStore, warmShared): WarmVoices => {
      const state = neutralState();
      FX_KINDS.forEach((kind, slot) => {
        state.slots[kind].active = true;
        state.slots[kind].mix = 0.5;
        state.order.push(slot);
      });
      const engine = createEngineWasm(scope, RATE, state, warmStore, warmShared);
      return {
        apply: engine.voices.apply,
        process: (frame, outL, outR) => flags.push(engine.process(frame, outL, outR)),
        reports: () => [engine.voices.reports(), engine.chain.reports()],
        free: engine.free,
      };
    });
    expect(Object.fromEntries(Object.entries(calls).map(([name, all]) => [name, all.length]))).toEqual({
      engine_new: 1,
      engine_process: 6,
      engine_fail: 0,
      engine_free: 1,
      // (the voices and the chain inside the block of the engine: neither is called apart)
      osc_scope_process: 0,
      osc_scope_free: 1,
      chain_process: 0,
      chain_free: 1,
    });
    expect(calls.engine_process.map(([, frame]) => frame)).toEqual([0, 128, 256, 384, 512, 640]);
    // (what there is to read: the voices that started in the first block; no stage failed)
    expect(flags).toHaveLength(6);
    expect(flags[0]).toBe(1);
    flags.forEach((flag) => expect([0, 1]).toContain(flag));
    store.free();
  });

  it('throws what its factory throws: the kernels it built by then go to the store of the scope all the same', () => {
    const { scope, store, calls } = counted(['osc_store_take_kernels', 'osc_store_new', 'osc_voice_process']);
    expect(() =>
      prewarmVoices(scope, store, RATE, () => {
        throw new Error('a trap of the prewarm');
      })
    ).toThrow('a trap of the prewarm');
    // (after the voices alone: the noise of the first has built them)
    expect(calls.osc_voice_process).toHaveLength(22);
    expect(calls.osc_store_take_kernels).toHaveLength(1);
    expect(calls.osc_store_take_kernels[0][0]).toBe(store.handle);
    // (what it made is left where it is; the scope and its store play all the same)
    const voices = recorded(scope);
    prewarmVoices(scope, store, RATE, voices.factory);
    expect(voices.told.flatMap((report) => report.started ?? [])).toHaveLength(16);
    store.free();
  });

  it('throws when the block of its voices does: its kernels still given', () => {
    const { scope, store, calls } = counted(['osc_store_take_kernels']);
    const { factory } = recorded(scope);
    const failing: WarmVoicesFactory = (warmStore, warmShared) => ({
      ...factory(warmStore, warmShared),
      process: () => {
        throw new Error('a block that traps');
      },
    });
    expect(() => prewarmVoices(scope, store, RATE, failing)).toThrow('a block that traps');
    expect(calls.osc_store_take_kernels).toHaveLength(1);
    store.free();
  });
});
