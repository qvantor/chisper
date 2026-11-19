import { chainState, slotOf } from '../../../../test-utils/chain-render';
import { expectSameBits } from '../../../../test-utils/parity';
import { seeded, storeWith } from '../../../../test-utils/voice-dsp';
import { wasmCore } from '../../../../test-utils/wasm';
import { lfoTable, LfosState } from '../lfo/lfo-curve';
import type { VoiceEvent, VoiceOptions } from '../wavetable/voice-options';
import { createOscScope, createVoiceSharedWasm } from '../wavetable/wavetable-osc-wasm';
import { createEngineMeters, createNodeEngine, takeEngineMessage } from './engine-messages';
import type { EngineOptions, EngineReport } from './engine-params';
import type { EngineExports, EngineWasm, EngineWasmOptions } from './engine-wasm';

const RATE = 48000;
const BLOCK = 128;

const scope = createOscScope(wasmCore<EngineExports>('engine'));

const FLAT = { attack: 0, hold: 0, decay: 0, sustain: 1, release: 0 };
const sine = Array.from({ length: 2048 }, (_, n) => Math.sin((2 * Math.PI * n) / 2048) / 4);
const saw = Array.from({ length: 2048 }, (_, n) => (n / 1024 - 1) / 4);

// a note of 4 unison voices whose phases are drawn at random
const on = (voice: number, more: Partial<VoiceOptions> = {}): VoiceEvent => ({
  kind: 'on',
  voice,
  options: {
    osc: [{ table: 'saw', unison: 4, phase: 0, phaseRand: 1 }, null],
    start: 0,
    envelopes: [FLAT, FLAT, FLAT],
    envStart: 0,
    routes: [],
    filter: null,
    phrase: voice,
    ...more,
  },
  params: { gain1: 1, frequency: 100, detune1: 20 },
});

const lfos = (): LfosState => ({
  at: 0,
  instantly: true,
  lfos: [0, 1, 2, 3].map(() => ({
    mode: 0,
    delay: 0,
    rise: 0,
    smooth: 0,
    phase: 0,
    anchor: { time: 0, phase: 0, period: 1 },
    table: lfoTable('triangle'),
  })),
});

// the engine of a node made with `options`, on a store and a shared of its own
const nodeEngine = (options: EngineOptions, more: EngineWasmOptions = {}) => {
  const { store } = storeWith({ saw: [saw, sine] }, scope);
  const shared = createVoiceSharedWasm(scope);
  return { ...createNodeEngine(scope, RATE, options, store, shared, more), shared };
};

const render = (engine: EngineWasm, blocks: number) => {
  const left = new Float32Array(blocks * BLOCK);
  const right = new Float32Array(blocks * BLOCK);
  for (let at = 0; at < left.length; at += BLOCK)
    engine.process(at, left.subarray(at, at + BLOCK), right.subarray(at, at + BLOCK));
  return left;
};
const peak = (data: Float32Array) => data.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
const differ = (a: Float32Array, b: Float32Array) => a.some((value, index) => value !== b[index]);

describe('the engine of a node', () => {
  describe('made of its options', () => {
    it('plays the events of a scene from its first block', () => {
      const { engine } = nodeEngine({ events: [on(1)] });
      expect(peak(render(engine, 1))).toBeGreaterThan(0);
      engine.free();
      const silent = nodeEngine({});
      expect(peak(render(silent.engine, 4))).toBe(0);
      silent.engine.free();
    });

    it('a seed: what its notes draw is the same in two renders, another with another seed', () => {
      const rendered = (options: EngineOptions, more?: EngineWasmOptions) => {
        const { engine } = nodeEngine({ events: [on(1)], unlimited: true, ...options }, more);
        const output = render(engine, 8);
        engine.free();
        return output;
      };
      const first = rendered({ seed: 5 });
      expectSameBits('the same seed', 0, 'left', rendered({ seed: 5 }), first);
      expect(differ(rendered({ seed: 6 }), first)).toBe(true);
      // (over the random() of who makes it)
      expectSameBits('a seed over random()', 0, 'left', rendered({ seed: 5 }, { random: seeded(9) }), first);
    });

    it('no seed: the random() of who makes it', () => {
      const rendered = (random: () => number) => {
        const { engine } = nodeEngine({ events: [on(1)], unlimited: true }, { random });
        const output = render(engine, 8);
        engine.free();
        return output;
      };
      const first = rendered(seeded(3));
      expectSameBits('the same random()', 0, 'left', rendered(seeded(3)), first);
      expect(differ(rendered(seeded(4)), first)).toBe(true);
    });

    it('without its limiter: `unlimited` of the options, or `limited: false` of who makes it', () => {
      const latency = (options: EngineOptions, more?: EngineWasmOptions) => {
        const { engine } = nodeEngine(options, more);
        const samples = engine.latency;
        engine.free();
        return samples;
      };
      expect(latency({})).toBeGreaterThan(0);
      expect(latency({ unlimited: true })).toBe(0);
      expect(latency({}, { limited: false })).toBe(0);
      expect(latency({ unlimited: false }, { limited: false })).toBe(0);
    });

    it('the LFOs of its options are those of its voices and of its chain; none: those of its state', () => {
      const { store } = storeWith({ saw: [saw, sine] }, scope);
      const shared = createVoiceSharedWasm(scope);
      const setLfos = jest.spyOn(shared, 'setLfos');
      const state = lfos();
      const made = createNodeEngine(scope, RATE, { lfos: state }, store, shared);
      expect(setLfos).toHaveBeenCalledTimes(1);
      expect(setLfos).toHaveBeenCalledWith(state);
      expect(made.state.lfos).toBe(state);
      made.engine.free();

      const kept = createNodeEngine(
        scope,
        RATE,
        { state: { ...chainState([]), lfos: state } },
        store,
        shared
      );
      expect(setLfos).toHaveBeenCalledTimes(2);
      expect(kept.state.lfos).toBe(state);
      kept.engine.free();

      const none = createNodeEngine(scope, RATE, {}, store, shared);
      expect(setLfos).toHaveBeenCalledTimes(2);
      expect(none.state.lfos).toBeNull();
      none.engine.free();
    });

    it('each voice apart with `tap`', () => {
      const { engine } = nodeEngine({ events: [on(1), on(2)], tap: true });
      render(engine, 1);
      expect(engine.voices.taps(BLOCK).map(({ voice }) => voice)).toEqual([1, 2]);
      engine.free();
    });
  });

  describe('a message', () => {
    const CHORUS = slotOf('chorus');
    const taking = (state = chainState(['chorus'])) => {
      const { engine, shared, state: made } = nodeEngine({ state });
      const reports: EngineReport[] = [];
      const errors: unknown[] = [];
      const post = (report: EngineReport) => reports.push(JSON.parse(JSON.stringify(report)));
      const meters = createEngineMeters(engine.chain, made, post);
      const take = (message: Parameters<typeof takeEngineMessage>[2]) =>
        takeEngineMessage(engine, shared, message, RATE, 0, {
          onError: (error) => errors.push(error),
          post,
          meters,
        });
      return { engine, shared, meters, reports, errors, take };
    };

    it('a retry of a stage is told back: made again', () => {
      const { engine, reports, take } = taking();
      take({ retry: CHORUS });
      expect(reports).toEqual([{ remade: CHORUS }]);
      engine.free();
    });

    it('a retry that could not make its stage: failed again', () => {
      const { engine, reports, take } = taking();
      jest.spyOn(engine.chain, 'retry').mockReturnValue(false);
      take({ retry: CHORUS });
      expect(reports).toEqual([{ failed: [CHORUS] }]);
      engine.free();
    });

    it('a meter watched is posted after a block, about 30 times a second; no more once it is not', () => {
      const { engine, meters, reports, take } = taking();
      render(engine, 1);
      meters.due(RATE, RATE);
      expect(reports).toEqual([]);
      take({ meter: [CHORUS, true] });
      meters.due(BLOCK, RATE);
      expect(reports).toEqual([]);
      meters.due(RATE / 30, RATE);
      expect(reports).toHaveLength(1);
      expect(reports[0].meter?.[0]).toBe(CHORUS);
      take({ meter: [CHORUS, false] });
      meters.due(RATE, RATE);
      expect(reports).toHaveLength(1);
      engine.free();
    });

    it('a node made while a screen watches: its meter on; a retry of its stage: the meter as it is again', () => {
      const { engine, meters, reports, take } = taking(chainState(['chorus'], 1, {}, { meters: [CHORUS] }));
      render(engine, 1);
      meters.due(RATE, RATE);
      // (at rest it is posted once)
      meters.due(RATE, RATE);
      expect(reports.filter((report) => report.meter)).toHaveLength(1);
      take({ retry: CHORUS });
      meters.due(RATE, RATE);
      expect(reports.filter((report) => report.meter)).toHaveLength(2);
      engine.free();
    });

    it('a call of the chain that throws loses only itself: the meter and the retry after it are taken', () => {
      const { engine, meters, reports, errors, take } = taking();
      const thrown = new Error('trap');
      jest.spyOn(engine.chain, 'setMix').mockImplementation(() => {
        throw thrown;
      });
      const apply = jest.spyOn(engine.voices, 'apply');
      take({ events: [on(1)], mix: [CHORUS, 0.5], meter: [CHORUS, true], retry: CHORUS });
      expect(errors).toEqual([thrown]);
      expect(apply).toHaveBeenCalledTimes(1);
      expect(reports).toEqual([{ remade: CHORUS }]);
      render(engine, 1);
      meters.due(RATE, RATE);
      expect(reports.filter((report) => report.meter)).toHaveLength(1);
      engine.free();
    });

    it('a state of the LFOs it can not read loses only itself: its events are applied', () => {
      const { engine, shared, errors, take } = taking();
      const thrown = new Error('lfos');
      jest.spyOn(shared, 'setLfos').mockImplementation(() => {
        throw thrown;
      });
      take({ lfos: lfos(), events: [on(1)] });
      expect(errors).toEqual([thrown]);
      // (through the chorus: its taps are late)
      expect(peak(render(engine, 16))).toBeGreaterThan(0);
      engine.free();
    });
  });
});
