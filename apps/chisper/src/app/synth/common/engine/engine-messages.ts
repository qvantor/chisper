import { chorusMeterReader } from '../../fx/effects/chorus-params';
import { compressorMeterReader } from '../../fx/effects/compressor-params';
import { meterDue, metered, Metered, watchMeter } from '../../fx/effects/meter-report';
import {
  ChainMessage,
  ChainReport,
  ChainState,
  FX_KINDS,
  FxKind,
  LIMITER_STAGE,
  neutralState,
} from '../chain/chain-params';
import type { ChainWasm } from '../chain/chain-wasm';
import { lateState } from '../lfo/lfo-curve';
import type { OscScope, TableStoreWasm, VoiceSharedWasm } from '../wavetable/wavetable-osc-wasm';
import type { EngineKnobsMessage, EngineOptions, EngineReport } from './engine-params';
import { createEngineWasm, ENGINE_BROKEN, ENGINE_FLAGS, EngineWasm, EngineWasmOptions } from './engine-wasm';
import { seeded } from './seeded';

// What a node of the engine is, whoever runs it (the worklet, a render on the main thread, the parity of the
// browsers in Node): the engine of its options, what a message tells it, what a block leaves to read, the meters
// of its effects. No window, document or React here (the worklet module imports it)

// The engine of a node made with `options` (its processorOptions): the chain of its state, the LFOs of the voices
// and the chain as they are at once, what its notes draw at random (`seed`: two renders alike; else `random` of
// the caller), without the limiter (`unlimited`, or the caller's `limited: false`), each voice kept apart (`tap`),
// the events of a scene before its first block. `state`: the one the engine was made of (its meters)
export const createNodeEngine = (
  scope: OscScope,
  sampleRate: number,
  options: EngineOptions,
  store: TableStoreWasm,
  shared: VoiceSharedWasm,
  { limited = true, random, onError }: EngineWasmOptions = {}
) => {
  const { state: knobs = neutralState(), lfos = knobs.lfos, events, tap, unlimited = false, seed } = options;
  const state: ChainState = { ...knobs, lfos: lfos ?? null };
  const engine = createEngineWasm(scope, sampleRate, state, store, shared, {
    limited: limited && !unlimited,
    random: seed === undefined ? random : seeded(seed),
    onError,
  });
  // (the LFOs of the voices as those of the chain: a node made again has them at once)
  if (lfos) shared.setLfos(lfos);
  if (tap) engine.voices.tap(true);
  if (events) engine.voices.apply(events);
  return { engine, state };
};

// what a screen draws of a kind, read into the same object every time (nothing is made on the audio thread)
const METER_READERS: Partial<Record<FxKind, () => (values: Float64Array, idle: boolean) => unknown>> = {
  chorus: chorusMeterReader,
  compressor: compressorMeterReader,
};

interface Meter extends Metered {
  slot: number;
  read: (values: Float64Array, idle: boolean) => unknown;
  readonly idle: boolean;
}

// The meters of the effects of a chain, posted only while a screen watches them (`state.meters`: those watched as
// the node is made): `watch` a slot or no more, `remade` after a retry of its stage (the meter of a unit made
// again: as it is, at rest too), `due` after a block of `frames` posts those whose time has come (one report
// kept, its values read into the same object: whoever keeps a report copies it, as a port does)
export const createEngineMeters = (
  chain: ChainWasm,
  state: ChainState,
  post: (report: ChainReport) => void
) => {
  const meters = FX_KINDS.flatMap((kind, slot) => {
    const reader = METER_READERS[kind];
    if (!reader) return [];
    // (a literal: its getter stays one, Object.assign would read it once)
    const meter: Meter = {
      ...metered(state.meters.includes(slot)),
      slot,
      read: reader(),
      get idle() {
        return chain.idle(slot);
      },
    };
    return [meter];
  });
  const report: ChainReport = {};
  const of = (slot: number) => meters.find((meter) => meter.slot === slot);
  return {
    watch: (slot: number, watched: boolean) => {
      const meter = of(slot);
      if (meter) watchMeter(meter, watched);
    },
    remade: (slot: number) => {
      const meter = of(slot);
      if (meter) watchMeter(meter, meter.metering);
    },
    due: (frames: number, sampleRate: number) => {
      for (let index = 0; index < meters.length; index++) {
        const meter = meters[index];
        if (!meterDue(meter, frames, sampleRate)) continue;
        const values = chain.meter(meter.slot);
        // (a unit that failed has no meter: the screen keeps the last one)
        if (values.length === 0) continue;
        report.meter = [meter.slot, meter.read(values, meter.idle)];
        post(report);
      }
    },
  };
};
export type EngineMeters = ReturnType<typeof createEngineMeters>;

// what a message of the main thread tells the chain of the engine, as the worklet and a render on the main thread
// take it: the events of the knobs at their time (seconds of the context, the frames of the core; none, or one
// that has passed: the next block), the routes and the note at once
const takeChainMessage = (chain: ChainWasm, message: ChainMessage, sampleRate: number) => {
  const at = message.at === undefined ? 0 : message.at * sampleRate;
  if (message.params) chain.setParams(message.params[0], message.params[1], at);
  if (message.mix) chain.setMix(message.mix[0], message.mix[1], at);
  if (message.active) chain.setActive(message.active[0], message.active[1], at);
  if (message.order) chain.setOrder(message.order, at);
  if (message.masterGain !== undefined) chain.setMasterGain(message.masterGain, at);
  if (message.mute !== undefined) chain.mute(message.mute, at);
  if (message.unmute) chain.unmute(at);
  if (message.clear) chain.clear(at);
  if (message.routes) chain.setRoutes(message.routes);
  if (message.note !== undefined) chain.setNote(message.note);
};

// what a message of the main thread tells the engine of a node, as the worklet and a render on the main thread
// take it: a state of the LFOs to the halves that read them (it is for a time ahead of now: one that comes late,
// after `next`, the frame of the next block, takes over then), the events of the voices, what the chain is told,
// a meter watched or no more, a stage to make again (told back with `post`: made, or failed again). Each part
// loses only itself: a state or events it can't read, a call of the chain that throws (`onError`; a call of the
// core that traps loses its own events: apply), the parts after it are taken. Not here: `stop` and `probe`, which
// are of the node and not of its engine (who runs it frees the engine, has the second output or not)
export interface EngineTake {
  onError: (error: unknown) => void;
  post: (report: EngineReport) => void;
  meters?: EngineMeters;
}
export type EngineRun = EngineWasmOptions & Omit<EngineTake, 'meters'>;

export const takeEngineMessage = (
  engine: EngineWasm,
  shared: VoiceSharedWasm,
  message: EngineKnobsMessage,
  sampleRate: number,
  next: number,
  { onError, post, meters }: EngineTake
) => {
  const { chain, voices } = engine;
  try {
    if (message.lfos) {
      const lfos = lateState(message.lfos, next / sampleRate);
      const { readers } = message;
      if (!readers || readers.includes('voices')) shared.setLfos(lfos);
      if (!readers || readers.includes('chain')) chain.setLfos(lfos);
    }
  } catch (error) {
    onError(error);
  }
  try {
    if (message.events) voices.apply(message.events);
  } catch (error) {
    onError(error);
  }
  try {
    takeChainMessage(chain, message, sampleRate);
  } catch (error) {
    onError(error);
  }
  if (message.meter) meters?.watch(message.meter[0], message.meter[1]);
  if (message.retry !== undefined) {
    // (told back: the main thread shows the stage ready only once it is)
    if (chain.retry(message.retry)) post({ remade: message.retry });
    else post({ failed: [message.retry] });
    meters?.remade(message.retry);
  }
};

// what a block left to read (the flags of process(), not ENGINE_BROKEN), told the main thread: the voices that
// started and ended, the stages that failed (one report kept: nothing is made on the audio thread), the bytes the
// store freed (to its listener)
const createEngineTeller = (store: TableStoreWasm, post: (report: EngineReport) => void) => {
  const stages: number[] = [];
  const failedReport: ChainReport = { failed: stages };
  return (engine: EngineWasm, flags: number) => {
    if (flags & ENGINE_FLAGS.voices) {
      const report = engine.voices.reports();
      if (report) post(report);
    }
    if (flags & ENGINE_FLAGS.stages) {
      const bits = engine.chain.reports();
      stages.length = 0;
      for (let stage = 0; stage <= LIMITER_STAGE; stage++) if (bits & (1 << stage)) stages.push(stage);
      if (stages.length > 0) post(failedReport);
    }
    if (flags & ENGINE_FLAGS.freed) store.drain();
  };
};

// The engine of a node as whoever runs it keeps it: made of the options, told the messages of the main thread
// (`take`; `next`: the frame of the next block), read after each block (`after`). It is there until the node is
// stopped or its core trapped in no stage; `post`: what the node tells the main thread
export const createEngineRunner = (
  scope: OscScope,
  sampleRate: number,
  options: EngineOptions,
  store: TableStoreWasm,
  shared: VoiceSharedWasm,
  { post, ...run }: EngineRun
) => {
  const { engine, state } = createNodeEngine(scope, sampleRate, options, store, shared, run);
  const meters = createEngineMeters(engine.chain, state, post);
  const tell = createEngineTeller(store, post);
  const taking: EngineTake = { onError: run.onError, post, meters };
  const brokenReport: ChainReport = { broken: true };
  let live: EngineWasm | null = engine;
  return {
    // the engine (none: the node is over)
    get engine() {
      return live;
    },
    take: (message: EngineKnobsMessage, next: number) => {
      if (!live) return;
      if (message.stop) {
        // (stopped before it frees: a free that throws leaves no voices half freed to render)
        live = null;
        try {
          engine.free();
        } catch (error) {
          run.onError(error);
        }
        return;
      }
      takeEngineMessage(live, shared, message, sampleRate, next, taking);
    },
    // after a block of `frames` and the `flags` of its process(): what it left to read told, the meters that are
    // due. False: the core trapped in no stage (not freed: that could trap again), the node is over and the main
    // thread, told so, makes another of its state
    after: (flags: number, frames: number) => {
      if (!live) return false;
      if (flags === ENGINE_BROKEN) {
        live = null;
        post(brokenReport);
        return false;
      }
      if (flags !== 0) tell(live, flags);
      meters.due(frames, sampleRate);
      return true;
    },
  };
};
