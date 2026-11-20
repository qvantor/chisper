import { createChain } from '../../common/chain/chain';
import { createRenderClock } from '../../common/clock/render-clock';
import { createDirectEngine, DirectEngineOptions } from '../../common/engine/direct-engine';
import type { EngineExports } from '../../common/engine/engine-wasm';
import { createWavetableEngine, WavetableEngineDependencies } from '../../common/wavetable/wavetable-engine';

export interface RenderCoreOptions extends DirectEngineOptions {
  // an instance of the core of its own (engine-core.ts: loadEngineCore)
  exports: EngineExports;
  // the rate the core renders at
  sampleRate: number;
  // the builder of its tables (a worker of its own, a channel to its store)
  wavetables?: WavetableEngineDependencies;
  // the master gain (the Master of the page: over 1 it drives the limiter; by default 1)
  masterGain?: number;
}

// The core of a render of the track, in place of the synth core for a copy of the models of the sound: the clock
// the render moves (render-clock.ts), the engine it calls block by block (direct-engine.ts) with the chain and the
// voices of the models as its clients. No context, no output, no analysers: the master as given, never muted
export const createRenderCore = ({
  exports,
  sampleRate,
  wavetables: dependencies,
  masterGain = 1,
  ...options
}: RenderCoreOptions) => {
  const time = createRenderClock(sampleRate);
  const engine = createDirectEngine(exports, sampleRate, options);
  const chain = createChain(time.clock, engine);
  chain.setMasterGain(masterGain);
  const wavetables = createWavetableEngine(engine, dependencies);
  return {
    // (the core of the models: SoundCore)
    clock: time.clock,
    chain,
    wavetables,
    time,
    engine,
    destroy: () => {
      chain.destroy();
      wavetables.destroy();
      engine.destroy();
    },
  };
};
export type RenderCore = ReturnType<typeof createRenderCore>;
