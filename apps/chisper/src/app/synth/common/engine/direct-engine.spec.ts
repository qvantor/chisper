import { inProcessBuilder } from '../../../../test-utils/in-process-builder';
import { wasmCore } from '../../../../test-utils/wasm';
import { createChain } from '../chain/chain';
import { FX_KINDS, LIMITER_STAGE } from '../chain/chain-params';
import { createRenderClock } from '../clock/render-clock';
import type { VoiceOptions } from '../wavetable/voice-options';
import { createWavetableEngine } from '../wavetable/wavetable-engine';
import { createDirectEngine, DirectEngineOptions } from './direct-engine';
import type { EngineClient } from './engine-host';
import type { EngineReport } from './engine-params';
import type { EngineExports } from './engine-wasm';

const RATE = 48000;
const BLOCK = 128;

const NOTE: VoiceOptions = {
  osc: [{ table: 'osc1', unison: 1, phase: 0, phaseRand: 0 }, null],
  start: 0,
  envelopes: [{ attack: 0, hold: 0, decay: 0, sustain: 1, release: 0.01 }],
  envStart: 0,
  phrase: 1,
  routes: [],
  filter: null,
};
const SAW = Array.from({ length: 2048 }, (_, i) => i / 1024 - 1);

// (the engine is ready a microtask after it is made)
const settle = () => new Promise((resolve) => setTimeout(resolve));

const setup = (options: DirectEngineOptions = {}) => {
  const builder = inProcessBuilder();
  const engine = createDirectEngine(wasmCore<EngineExports>('engine'), RATE, options);
  const time = createRenderClock(RATE);
  const chain = createChain(time.clock, engine);
  const wavetables = createWavetableEngine(engine, builder.dependencies);
  const reports: EngineReport[] = [];
  engine.attach({ report: (report) => reports.push(report) });
  const left = new Float32Array(BLOCK);
  const right = new Float32Array(BLOCK);
  // `blocks` blocks of the engine, its output
  const render = (blocks: number) => {
    const out = [new Float32Array(blocks * BLOCK), new Float32Array(blocks * BLOCK)];
    for (let block = 0; block < blocks; block++) {
      wavetables.flush();
      if (!engine.render(left, right)) return null;
      out[0].set(left, block * BLOCK);
      out[1].set(right, block * BLOCK);
      time.advance(BLOCK);
    }
    return out;
  };
  return { builder, engine, chain, wavetables, reports, render };
};

const peak = (samples: Float32Array) => samples.reduce((most, x) => Math.max(most, Math.abs(x)), 0);

describe('createDirectEngine', () => {
  afterEach(() => jest.restoreAllMocks());

  it('is ready a microtask after it is made: its clients started, told', async () => {
    const engine = createDirectEngine(wasmCore<EngineExports>('engine'), RATE);
    const told: unknown[] = [];
    const client: EngineClient = {
      status: (status) => told.push(status),
      start: () => told.push('start'),
      options: () => ({ seed: 1 }),
    };
    engine.attach(client);
    expect(engine.$status.value).toBe('loading');
    expect(engine.render(new Float32Array(BLOCK), new Float32Array(BLOCK))).toBe(false);
    await settle();
    expect(told).toEqual(['loading', 'start', 'ready']);
    expect(engine.wasm).not.toBeNull();
    engine.destroy();
  });

  it('renders block by block from frame 0: silence without a voice, the frames counted', async () => {
    const { engine, render } = setup();
    await settle();
    const out = render(4);
    expect(out?.[0].every((x) => x === 0)).toBe(true);
    expect(engine.frame).toBe(4 * BLOCK);
    engine.destroy();
  });

  it('stores a table of the builder through its port, in chunks, as the store of the worklet does', async () => {
    const { builder, wavetables, engine } = setup();
    await settle();
    expect(wavetables.$status.value).toBe('ready');
    wavetables.setTable('osc1', [SAW]);
    builder.flush();
    expect(wavetables.$tables.value).toEqual({ osc1: 'stored' });
    // (the store asked for chunks)
    expect(builder.workers[0].messages.map((message) => Object.keys(message)[0])).toContain('port');
    engine.destroy();
  });

  it('plays a voice of the table: its start and its end told to the clients right after their blocks', async () => {
    const { builder, wavetables, engine, reports, render } = setup({ seed: 3 });
    await settle();
    wavetables.setTable('osc1', [SAW]);
    builder.flush();
    const voice = wavetables.createVoice(NOTE, { frequency: 440, gain1: 0.5 });
    const started = jest.fn();
    const ended = jest.fn();
    if (voice) {
      voice.onStarted = started;
      voice.onEnded = ended;
      voice.params.gate.setValueAtTime(0, 0.05);
    }
    const out = render(10);
    expect(started).toHaveBeenCalledTimes(1);
    expect(started.mock.calls[0][0]).toBe(0);
    expect(peak(out?.[0] ?? new Float32Array())).toBeGreaterThan(0.05);
    expect(ended).not.toHaveBeenCalled();
    render(40);
    expect(ended).toHaveBeenCalledTimes(1);
    expect(reports.some((report) => report.ended?.includes(1))).toBe(true);
    engine.destroy();
  });

  it('a seed renders the same samples twice', async () => {
    const renderOnce = async () => {
      const { builder, wavetables, engine, render } = setup({ seed: 7 });
      await settle();
      wavetables.setTable('osc1', [SAW]);
      builder.flush();
      wavetables.createVoice(
        { ...NOTE, osc: [{ table: 'osc1', unison: 4, phase: 0, phaseRand: 1 }, null] },
        {
          frequency: 220,
          gain1: 0.5,
        }
      );
      const out = render(20);
      engine.destroy();
      return out;
    };
    const [first, second] = [await renderOnce(), await renderOnce()];
    expect(first?.[0]).toEqual(second?.[0]);
  });

  it('a stage of the chain that traps is dropped alone: failed, the others play', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { engine, chain, render } = setup();
    await settle();
    const reverb = FX_KINDS.indexOf('reverb');
    chain.setActive(reverb, true);
    chain.setOrder([reverb]);
    engine.wasm?.chain.trap(reverb);
    render(2);
    expect(chain.status(reverb).value).toBe('failed');
    expect(chain.status(LIMITER_STAGE).value).toBe('ready');
    expect(engine.$status.value).toBe('ready');
    expect(error).toHaveBeenCalled();
    engine.destroy();
  });

  it('a trap of the core in no stage ends it: failed, nothing more rendered', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { engine, render } = setup();
    await settle();
    engine.wasm?.chain.trap(LIMITER_STAGE + 1);
    expect(render(1)).toBeNull();
    expect(engine.$status.value).toBe('failed');
    expect(engine.wasm).toBeNull();
    expect(error).toHaveBeenCalledWith('The engine of the render failed', expect.any(Error));
  });

  it('the limiter delays its output; a chain that plays nothing is idle', async () => {
    const { engine } = setup();
    expect(engine.latency).toBe(0);
    expect(engine.idle()).toBe(true);
    await settle();
    expect(engine.latency).toBeGreaterThan(0);
    expect(engine.idle()).toBe(true);
    engine.destroy();
  });

  it('destroyed: its engine freed, nothing rendered, its worker ended', async () => {
    const { engine, builder, wavetables, render } = setup();
    await settle();
    wavetables.destroy();
    engine.destroy();
    expect(engine.wasm).toBeNull();
    expect(render(1)).toBeNull();
    expect(builder.workers[0].terminated).toBe(true);
  });
});
