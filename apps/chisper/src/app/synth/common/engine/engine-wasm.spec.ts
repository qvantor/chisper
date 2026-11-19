import { chainState, slotOf } from '../../../../test-utils/chain-render';
import { expectSameBits } from '../../../../test-utils/parity';
import { seeded, storeWith } from '../../../../test-utils/voice-dsp';
import { wasmCore } from '../../../../test-utils/wasm';
import { ChainState, LIMITER_STAGE } from '../chain/chain-params';
import { createChainWasm } from '../chain/chain-wasm';
import type { VoiceEvent, VoiceFilterOptions, VoiceOptions, VoiceRoute } from '../wavetable/voice-options';
import { buildLevels } from '../wavetable/wavetable-mipmap';
import type { VoiceParam } from '../wavetable/wavetable-osc-params';
import {
  createOscScope,
  createVoiceScopeWasm,
  createVoiceSharedWasm,
  OscScope,
} from '../wavetable/wavetable-osc-wasm';
import {
  createEngineWasm,
  ENGINE_BROKEN,
  ENGINE_FLAGS,
  EngineExports,
  EngineWasmOptions,
  MAX_SILENCED,
} from './engine-wasm';

const RATE = 48000;
const BLOCK = 128;

// an instance of the core, as the scope of a context
const instance = () => createOscScope(wasmCore<EngineExports>('engine'));
// one for the engines of the spec file; `apart`: for what an engine is held to (the voices and the chain driven
// apart, an engine without what traps). Each in a memory of its own: no render can lean on what the other left in
// it (the command buffers, the blocks of the shared), and their stores and shareds have had the same calls
const scope = instance();
const apart = instance();
const exports = scope.exports as EngineExports;

const FLAT = { attack: 0, hold: 0, decay: 0, sustain: 1, release: 0 };
const SLOW = { attack: 0.004, hold: 0, decay: 0.01, sustain: 0.5, release: 0.01 };
const LOWPASS: VoiceFilterOptions = { type: 'lowpass', cutoff: 2000, resonance: 2, gain: 0 };

const sine = Array.from({ length: 2048 }, (_, n) => Math.sin((2 * Math.PI * n) / 2048));
const saw = Array.from({ length: 2048 }, (_, n) => n / 1024 - 1);
const TABLES = { saw: [saw.map((x) => x / 4), sine.map((x) => x / 4)], sine: [sine.map((x) => x / 4)] };

const peak = (data: Float32Array) => data.reduce((max, value) => Math.max(max, Math.abs(value)), 0);

const on = (
  voice: number,
  table: string,
  more: Partial<VoiceOptions> = {},
  params: Partial<Record<VoiceParam, number>> = {}
): VoiceEvent => ({
  kind: 'on',
  voice,
  options: {
    osc: [{ table, unison: 1, phase: 0.25, phaseRand: 0 }, null],
    start: 0,
    envelopes: [FLAT, FLAT, FLAT],
    envStart: more.start ?? 0,
    routes: [],
    filter: null,
    phrase: voice,
    ...more,
  },
  params: { gain1: 1, frequency: 100, ...params },
});
const gate = (voice: number, frame: number): VoiceEvent => ({
  kind: 'set',
  voice,
  param: 'gate',
  value: 0,
  time: frame / RATE,
});

// a store with the tables, a shared and an engine on them in `where`; what its voices and stages threw
const engineOf = (
  state: ChainState = chainState([]),
  options: EngineWasmOptions = {},
  where: OscScope = scope
) => {
  const errors: unknown[] = [];
  const { store } = storeWith(TABLES, where);
  const shared = createVoiceSharedWasm(where);
  const engine = createEngineWasm(where, RATE, state, store, shared, {
    random: seeded(7),
    onError: (error) => errors.push(error),
    ...options,
  });
  return { engine, store, shared, errors };
};

interface Rendered {
  left: Float32Array;
  right: Float32Array;
  flags: number[];
}
// `blocks` blocks of an engine from `frame` on (`before` each: its frame), what each told
const render = (
  engine: { process: (frame: number, outL: Float32Array, outR: Float32Array) => number },
  blocks: number,
  frame = 0,
  before: (frame: number) => void = () => undefined
): Rendered => {
  const left = new Float32Array(blocks * BLOCK);
  const right = new Float32Array(blocks * BLOCK);
  const flags: number[] = [];
  for (let index = 0; index < blocks; index++) {
    const from = index * BLOCK;
    before(frame + from);
    flags.push(
      engine.process(frame + from, left.subarray(from, from + BLOCK), right.subarray(from, from + BLOCK))
    );
  }
  return { left, right, flags };
};

// the same sound by the two halves driven apart: the voices of a scope into their sum, their sum through a chain
const halvesOf = (state: ChainState, limited = true) => {
  const { store } = storeWith(TABLES, apart);
  const shared = createVoiceSharedWasm(apart);
  const voices = createVoiceScopeWasm(apart, RATE, store, shared, seeded(7));
  const chain = createChainWasm(apart.exports as EngineExports, RATE, state, { limited });
  let sum = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  return {
    voices,
    chain,
    // (the voices that started and ended are read as the worklet of the halves did: after every block)
    process: (frame: number, outL: Float32Array, outR: Float32Array) => {
      if (sum[0].length !== outL.length) sum = [new Float32Array(outL.length), new Float32Array(outL.length)];
      voices.process(frame, sum[0], sum[1]);
      expect(chain.process(sum[0], sum[1], outL, outR, frame)).toBe(true);
      return 0;
    },
    sum: () => sum,
  };
};

// the notes of a scene: unison with random phases, a filter, a note that starts inside a block and one that ends
// inside another, both oscillators
const scene = (): VoiceEvent[] => [
  on(
    1,
    'saw',
    { osc: [{ table: 'saw', unison: 4, phase: 0.5, phaseRand: 1 }, null], start: (3 * BLOCK) / RATE },
    {
      frequency: 110,
      spread1: 20,
      position1: 0.3,
    }
  ),
  on(2, 'sine', { filter: LOWPASS, envelopes: [SLOW, SLOW, FLAT], start: 700 / RATE }, { frequency: 330 }),
  on(
    3,
    'saw',
    {
      osc: [
        { table: 'saw', unison: 2, phase: 0, phaseRand: 1 },
        { table: 'sine', unison: 1, phase: 0, phaseRand: 0 },
      ],
      filter: { ...LOWPASS, cutoff: 900 },
      start: (10 * BLOCK) / RATE,
    },
    { frequency: 220, gain2: 0.5 }
  ),
  gate(1, 2500),
  gate(2, 30 * BLOCK),
  gate(3, 3333),
];
const effects = () =>
  chainState(['distortion', 'chorus', 'delay'], 0.5, {
    distortion: { params: { drive: 6 } },
    delay: { params: { time: 0.02, fb: 0.5 } },
  });

describe('engine wasm', () => {
  describe('a block', () => {
    it.each([
      ['with its limiter', true],
      ['without it', false],
    ])('has the bits of the voices rendered apart and their sum given to a chain, %s', (_, limited) => {
      const { engine } = engineOf(effects(), { limited });
      const halves = halvesOf(effects(), limited);
      engine.voices.apply(scene());
      halves.voices.apply(scene());
      // (a knob of the chain at a frame inside a block, on both)
      const at = 20 * BLOCK + 40;
      engine.chain.setMasterGain(0.5, at);
      halves.chain.setMasterGain(0.5, at);
      // (the blocks before the first note and after the last: the chain on silence, its tails)
      const blocks = 80;
      const whole = render(engine, blocks);
      const expected = render(halves, blocks);
      expect(peak(whole.left.subarray(8 * BLOCK, 20 * BLOCK))).toBeGreaterThan(0.05);
      expect(peak(whole.left.subarray(40 * BLOCK, 50 * BLOCK))).toBeGreaterThan(1e-4);
      for (let index = 0; index < blocks; index++) {
        const [from, to] = [index * BLOCK, (index + 1) * BLOCK];
        expectSameBits(
          'the engine',
          index,
          'left',
          expected.left.subarray(from, to),
          whole.left.subarray(from, to)
        );
        expectSameBits(
          'the engine',
          index,
          'right',
          expected.right.subarray(from, to),
          whole.right.subarray(from, to)
        );
      }
      engine.free();
    });

    it('renders blocks of another length: 128, 256, then 128 again', () => {
      const { engine } = engineOf(effects());
      const halves = halvesOf(effects());
      engine.voices.apply(scene());
      halves.voices.apply(scene());
      render(engine, 8);
      render(halves, 8);
      let frame = 8 * BLOCK;
      [256, 256, 128, 128, 256, 64, 128].forEach((frames, index) => {
        const out = [0, 1, 2, 3].map(() => new Float32Array(frames));
        expect(engine.process(frame, out[0], out[1])).not.toBe(ENGINE_BROKEN);
        halves.process(frame, out[2], out[3]);
        expect(peak(out[0])).toBeGreaterThan(0.01);
        expectSameBits(`a block of ${frames}`, index, 'left', out[2], out[0]);
        expectSameBits(`a block of ${frames}`, index, 'right', out[3], out[1]);
        frame += frames;
      });
      engine.free();
    });

    it('gives the sum of its voices as its chain took them', () => {
      const { engine } = engineOf(effects());
      const halves = halvesOf(effects());
      engine.voices.apply(scene());
      halves.voices.apply(scene());
      const [inL, inR] = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
      // (none before its first block)
      engine.voicesInto(inL.fill(1), inR.fill(1));
      expect(peak(inL)).toBe(1);
      for (let index = 0; index < 20; index++) {
        const frame = index * BLOCK;
        const out = [0, 1, 2, 3].map(() => new Float32Array(BLOCK));
        engine.process(frame, out[0], out[1]);
        halves.process(frame, out[2], out[3]);
        engine.voicesInto(inL, inR);
        expectSameBits('the voices', index, 'left', halves.sum()[0], inL);
        expectSameBits('the voices', index, 'right', halves.sum()[1], inR);
        // (not the output: the effects are after them)
        if (index === 12) {
          expect(peak(inL)).toBeGreaterThan(0.05);
          expect(inL).not.toEqual(out[0]);
        }
      }
      // (into a shorter block: its first samples)
      const short = new Float32Array(32);
      engine.voicesInto(short, new Float32Array(32));
      expect(short).toEqual(inL.subarray(0, 32));
      engine.free();
    });

    it('delays the sound by the latency of its limiter, by none without it', () => {
      const limited = engineOf();
      const unlimited = engineOf(chainState([]), { limited: false });
      expect(limited.engine.latency).toBeGreaterThan(0);
      expect(limited.engine.latency).toBe(limited.engine.chain.latency);
      expect(unlimited.engine.latency).toBe(0);
      const events = [on(1, 'sine')];
      limited.engine.voices.apply(events);
      unlimited.engine.voices.apply(events);
      const late = render(limited.engine, 10).left;
      const plain = render(unlimited.engine, 10).left;
      expect(peak(plain)).toBeCloseTo(0.25, 4);
      const { latency } = limited.engine;
      expect(late.subarray(latency)).toEqual(plain.subarray(0, plain.length - latency));
      limited.engine.free();
      unlimited.engine.free();
    });
  });

  describe('the flags of a block', () => {
    it('tell nothing while nothing starts, ends or fails', () => {
      const { engine } = engineOf(effects());
      expect(render(engine, 10).flags).toEqual(Array.from({ length: 10 }, () => 0));
      engine.voices.apply([on(1, 'sine')]);
      expect(render(engine, 1, 10 * BLOCK).flags).toEqual([ENGINE_FLAGS.voices]);
      // (late for its start of 0: told at the frame of its block)
      expect(engine.voices.reports()).toEqual({ started: [[1, 10 * BLOCK, expect.closeTo(0)]] });
      // (a voice that plays on has nothing to tell)
      expect(render(engine, 10, 11 * BLOCK).flags).toEqual(Array.from({ length: 10 }, () => 0));
      engine.free();
    });

    it('tell the voices that started and ended, from the block they did in until they are read', () => {
      const { engine } = engineOf();
      engine.voices.apply([on(1, 'sine', { start: 200 / RATE }), gate(1, 600)]);
      expect(render(engine, 2).flags).toEqual([0, ENGINE_FLAGS.voices]);
      expect(engine.voices.reports()).toEqual({ started: [[1, 200, 200]] });
      // (read: nothing more of it; then its end, in the block of frame 600)
      expect(render(engine, 3, 2 * BLOCK).flags).toEqual([0, 0, ENGINE_FLAGS.voices]);
      // (not read: the flag stays up)
      expect(render(engine, 3, 5 * BLOCK).flags).toEqual(
        Array.from({ length: 3 }, () => ENGINE_FLAGS.voices)
      );
      expect(engine.voices.reports()).toEqual({ ended: [1] });
      expect(render(engine, 2, 8 * BLOCK).flags).toEqual([0, 0]);
      // a start and an end no one read in between: one report
      engine.voices.apply([on(2, 'sine', { start: (10 * BLOCK + 8) / RATE }), gate(2, 10 * BLOCK + 40)]);
      expect(render(engine, 1, 10 * BLOCK).flags).toEqual([ENGINE_FLAGS.voices]);
      expect(engine.voices.reports()).toEqual({ started: [[2, 10 * BLOCK + 8, 10 * BLOCK + 8]], ended: [2] });
      engine.free();
    });

    it('tell a note on that trapped, though no block had its voice', () => {
      const { engine, errors } = engineOf();
      // more routes than the command buffer holds: the core reads past it
      const routes: VoiceRoute[] = Array.from({ length: 1000 }, () => ({
        source: 1,
        param: 'gain1',
        amount: 1,
        min: 0,
        max: 1,
      }));
      engine.voices.apply([on(1, 'sine', { routes })]);
      expect(errors).toHaveLength(1);
      const { left, flags } = render(engine, 1);
      expect(flags).toEqual([ENGINE_FLAGS.voices]);
      expect(peak(left)).toBe(0);
      expect(engine.voices.reports()).toEqual({ ended: [1] });
      expect(render(engine, 1, BLOCK).flags).toEqual([0]);
      engine.free();
    });

    it('tell the bytes the store freed in the block', () => {
      const { engine, store } = engineOf(chainState([]), { limited: false });
      const freed: number[] = [];
      store.listen((bytes) => freed.push(bytes));
      const before = store.stats();
      engine.voices.apply([on(1, 'saw')]);
      render(engine, 1);
      engine.voices.reports();
      // a version more of its table: the voice crossfades into it within 10 ms, then the one it held goes
      store.set('saw', 2, buildLevels([sine]));
      expect(store.stats().versions - before.versions).toBe(1);
      expect(freed).toEqual([]);
      const { flags } = render(engine, 9, BLOCK);
      // (from the block it went in until the store is drained: who reads the flag drains it)
      const went = flags.indexOf(ENGINE_FLAGS.freed);
      expect(went).toBeGreaterThan(0);
      expect(flags).toEqual(flags.map((_, index) => (index < went ? 0 : ENGINE_FLAGS.freed)));
      expect(freed).toEqual([]);
      store.drain();
      expect(freed).toEqual([4 * buildLevels(TABLES.saw).data.length]);
      expect(store.stats().versions).toBe(before.versions);
      expect(render(engine, 2, 10 * BLOCK).flags).toEqual([0, 0]);
      engine.free();
    });
  });

  describe('a trap', () => {
    it('of a voice ends it alone: it is told ended, the others play on through the chain', () => {
      const state = () => chainState([], 1, {}, { masterGain: 0.5 });
      const others = [
        on(2, 'sine', {}, { frequency: 150 }),
        on(3, 'saw', { filter: LOWPASS }, { frequency: 80 }),
      ];
      const { engine, errors } = engineOf(state(), { limited: false });
      // (the trap of the specs is past the render of a voice, where it finishes its block: its filter, its volume;
      // the voice after it has no filter: none finishes with it)
      engine.voices.apply([on(1, 'saw', { filter: LOWPASS }), ...others]);
      // the same engine without the voice that traps, in the other instance
      const twin = engineOf(state(), { limited: false }, apart);
      twin.engine.voices.apply(others);
      const expected = render(twin.engine, 20);
      const first = render(engine, 10);
      expect(first.left).not.toEqual(expected.left.subarray(0, 10 * BLOCK));
      expect(engine.voices.reports()).toEqual({
        started: [1, 2, 3].map((voice) => [voice, 0, expect.closeTo(0)]),
      });
      engine.voices.trap(1);
      const rest = render(engine, 10, 10 * BLOCK);
      expect(errors).toEqual([expect.any(WebAssembly.RuntimeError)]);
      // (its end, from the block of the trap on until it is read)
      expect(rest.flags).toEqual(Array.from({ length: 10 }, () => ENGINE_FLAGS.voices));
      expect(engine.voices.reports()).toEqual({ ended: [1] });
      expect(engine.voices.stats().voices).toBe(2);
      // from the block of the trap on: the bits of the others alone
      expect(peak(rest.left)).toBeGreaterThan(0.1);
      for (let index = 0; index < 10; index++) {
        const [from, to] = [index * BLOCK, (index + 1) * BLOCK];
        const twinFrom = 10 * BLOCK + from;
        expectSameBits(
          'the others',
          index,
          'left',
          expected.left.subarray(twinFrom, twinFrom + BLOCK),
          rest.left.subarray(from, to)
        );
        expectSameBits(
          'the others',
          index,
          'right',
          expected.right.subarray(twinFrom, twinFrom + BLOCK),
          rest.right.subarray(from, to)
        );
      }
      expect(render(engine, 2, 20 * BLOCK).flags).toEqual([0, 0]);
      engine.free();
      twin.engine.free();
    });

    it('of an effect drops it: its stage is told failed, the voices and the other effects play on', () => {
      const chorus = slotOf('chorus');
      const { engine, errors } = engineOf(chainState(['chorus', 'distortion']));
      engine.voices.apply([on(1, 'saw'), on(2, 'sine', {}, { frequency: 150 })]);
      render(engine, 20);
      engine.voices.reports();
      engine.chain.trap(chorus);
      const failed = render(engine, 60, 20 * BLOCK);
      expect(errors).toEqual([expect.any(WebAssembly.RuntimeError)]);
      expect(failed.flags[0]).toBe(ENGINE_FLAGS.stages);
      expect(engine.chain.reports()).toBe(1 << chorus);
      // (told once)
      expect(engine.chain.reports()).toBe(0);
      expect(render(engine, 1, 80 * BLOCK).flags).toEqual([0]);
      expect(engine.voices.stats().voices).toBe(2);
      // the voices through the distortion alone (once what the chorus left in it has died away)
      const twin = engineOf(chainState(['distortion']), {}, apart);
      twin.engine.voices.apply([on(1, 'saw'), on(2, 'sine', {}, { frequency: 150 })]);
      const alone = render(twin.engine, 80).left;
      expect(peak(failed.left.subarray(40 * BLOCK))).toBeGreaterThan(0.1);
      const difference = failed.left.subarray(40 * BLOCK).map((value, i) => value - alone[60 * BLOCK + i]);
      expect(peak(difference)).toBeLessThan(1e-3);
      // made again on a retry
      engine.chain.trap(-1);
      expect(engine.chain.retry(chorus)).toBe(true);
      expect(render(engine, 2, 81 * BLOCK).flags).toEqual([0, 0]);
      engine.free();
      twin.engine.free();
    });

    it('of its limiter leaves the output silent and tells its stage, the voices play on', () => {
      const { engine } = engineOf();
      engine.voices.apply([on(1, 'sine')]);
      expect(peak(render(engine, 10).left)).toBeGreaterThan(0.1);
      engine.voices.reports();
      engine.chain.trap(LIMITER_STAGE);
      const { left, flags } = render(engine, 10, 10 * BLOCK);
      expect(flags[0]).toBe(ENGINE_FLAGS.stages);
      expect(engine.chain.reports()).toBe(1 << LIMITER_STAGE);
      expect(peak(left)).toBe(0);
      expect(engine.voices.stats().voices).toBe(1);
      engine.chain.trap(-1);
      expect(engine.chain.retry(LIMITER_STAGE)).toBe(true);
      expect(peak(render(engine, 10, 20 * BLOCK).left)).toBeGreaterThan(0.1);
      engine.free();
    });

    it('of the chain that is in no stage breaks the engine: its block is silent', () => {
      const { engine, errors } = engineOf(chainState(['distortion']));
      engine.voices.apply([on(1, 'sine')]);
      expect(peak(render(engine, 10).left)).toBeGreaterThan(0.1);
      engine.chain.trap(LIMITER_STAGE + 1);
      const stack = exports.__stack_pointer.value;
      const [outL, outR] = [new Float32Array(BLOCK).fill(1), new Float32Array(BLOCK).fill(1)];
      expect(engine.process(10 * BLOCK, outL, outR)).toBe(ENGINE_BROKEN);
      expect(peak(outL)).toBe(0);
      expect(peak(outR)).toBe(0);
      expect(errors).toEqual([expect.any(WebAssembly.RuntimeError)]);
      // (the stack pointer back where the block found it: the instance plays on for the others)
      expect(exports.__stack_pointer.value).toBe(stack);
      const next = engineOf();
      next.engine.voices.apply([on(1, 'sine')]);
      expect(peak(render(next.engine, 10).left)).toBeGreaterThan(0.1);
      next.engine.free();
    });

    it('of a block of a length it has not reserved breaks it: nothing of it was rendered', () => {
      const { engine } = engineOf();
      engine.voices.apply([on(1, 'sine')]);
      const reserve = exports.chain_buffers;
      const failing = { ...exports, chain_buffers: jest.fn(reserve) };
      const { store } = storeWith(TABLES, scope);
      const broken = createEngineWasm(
        { ...scope, exports: failing },
        RATE,
        chainState([]),
        store,
        createVoiceSharedWasm(scope)
      );
      failing.chain_buffers.mockImplementationOnce(() => {
        throw new Error('no memory for the block');
      });
      const [outL, outR] = [new Float32Array(BLOCK).fill(1), new Float32Array(BLOCK).fill(1)];
      expect(broken.process(0, outL, outR)).toBe(ENGINE_BROKEN);
      expect(peak(outL)).toBe(0);
      expect(peak(outR)).toBe(0);
      // (the next block reserves it again)
      expect(broken.process(BLOCK, outL, outR)).toBe(0);
      expect(failing.chain_buffers).toHaveBeenCalledTimes(2);
      broken.free();
      engine.free();
    });
  });

  describe('a trap of the voices that is in none of them', () => {
    // (the perf build has no such trap: the core is told to by its exports; the cargo tests of the crate hold
    // what engine_fail and engine_resume do then)
    const SILENCED = 2;
    const trapping = () => {
      let traps = false;
      const stubbed: EngineExports = {
        ...exports,
        engine_process: (engine, frame) => {
          if (traps) throw new Error('a trap in no voice');
          return exports.engine_process(engine, frame);
        },
        engine_fail: () => SILENCED,
        engine_resume: () => 0,
      };
      const errors: unknown[] = [];
      const { store } = storeWith(TABLES, scope);
      const engine = createEngineWasm(
        { ...scope, exports: stubbed },
        RATE,
        chainState([]),
        store,
        createVoiceSharedWasm(scope),
        { onError: (error) => errors.push(error) }
      );
      return { engine, errors, trap: (on: boolean) => (traps = on) };
    };

    it('is a block without them, now and then: the engine plays on', () => {
      const { engine, errors, trap } = trapping();
      trap(true);
      expect(render(engine, MAX_SILENCED - 1).flags).toEqual(
        Array.from({ length: MAX_SILENCED - 1 }, () => 0)
      );
      expect(errors).toHaveLength(MAX_SILENCED - 1);
      // a block with its voices: the count of those without starts again
      trap(false);
      expect(render(engine, 1, 7 * BLOCK).flags).toEqual([0]);
      trap(true);
      expect(render(engine, MAX_SILENCED - 1, 8 * BLOCK).flags.every((flags) => flags === 0)).toBe(true);
      trap(false);
      engine.free();
    });

    it('in every block breaks the engine: a node silent for good is over', () => {
      const { engine, trap } = trapping();
      trap(true);
      const { flags, left } = render(engine, MAX_SILENCED);
      expect(flags.slice(0, -1).every((told) => told === 0)).toBe(true);
      expect(flags.at(-1)).toBe(ENGINE_BROKEN);
      expect(peak(left.subarray((MAX_SILENCED - 1) * BLOCK))).toBe(0);
    });
  });

  describe('its end', () => {
    it('frees its chain though the end of its voices threw: what it threw is thrown on', () => {
      const freed = jest.fn(exports.chain_free);
      const failing: EngineExports = {
        ...exports,
        osc_scope_free: (...args) => {
          exports.osc_scope_free(...args);
          throw new Error('the end of a voice trapped');
        },
        chain_free: freed,
      };
      const { store } = storeWith(TABLES, scope);
      const engine = createEngineWasm(
        { ...scope, exports: failing },
        RATE,
        effects(),
        store,
        createVoiceSharedWasm(scope)
      );
      expect(() => engine.free()).toThrow('the end of a voice trapped');
      expect(freed).toHaveBeenCalledTimes(1);
      // (freed all the same: not again)
      engine.free();
      expect(freed).toHaveBeenCalledTimes(1);
    });

    it('ends its voices (their versions back to the store) and frees its chain, once', () => {
      const calls = { engine_free: 0, osc_scope_free: 0, chain_free: 0 };
      const names = Object.keys(calls) as (keyof typeof calls)[];
      const counted = {
        ...exports,
        ...Object.fromEntries(
          names.map((name) => [
            name,
            (...args: number[]) => {
              calls[name] += 1;
              return (exports[name] as (...all: number[]) => void)(...args);
            },
          ])
        ),
      } as EngineExports;
      const { store } = storeWith(TABLES, scope);
      const shared = createVoiceSharedWasm(scope);
      const engine = createEngineWasm({ ...scope, exports: counted }, RATE, effects(), store, shared);
      engine.voices.apply([on(1, 'saw'), on(2, 'sine')]);
      render(engine, 4);
      store.set('saw', 2, buildLevels([sine]));
      const held = store.stats().versions;
      engine.free();
      // (version 1 of the table was held by a voice alone)
      expect(store.stats().versions).toBe(held - 1);
      expect(calls).toEqual({ engine_free: 1, osc_scope_free: 1, chain_free: 1 });
      engine.free();
      expect(calls).toEqual({ engine_free: 1, osc_scope_free: 1, chain_free: 1 });
      // the store and the shared are its owner's: another engine plays on them
      const next = createEngineWasm(scope, RATE, chainState([]), store, shared, { limited: false });
      next.voices.apply([on(1, 'sine')]);
      expect(peak(render(next, 2).left)).toBeCloseTo(0.25, 4);
      next.free();
    });
  });
});
