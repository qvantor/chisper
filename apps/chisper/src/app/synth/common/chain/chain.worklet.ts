import bytes from '@chisper/wasm/chain.wasm';
import { chorusMeterReader } from '../../fx/effects/chorus-params';
import { compressorMeterReader } from '../../fx/effects/compressor-params';
import { meterDue, metered, Metered, watchMeter } from '../../fx/effects/meter-report';
import { lateState } from '../lfo/lfo-curve';
import { instantiateCore } from '../wasm/wasm-core';
import {
  CHAIN_PROCESSOR,
  ChainMessage,
  ChainOptions,
  ChainReport,
  FX_KINDS,
  FxKind,
  LIMITER_STAGE,
  neutralState,
} from './chain-params';
import { prewarmChain } from './chain-prewarm';
import { ChainExports, ChainWasm, createChainWasm } from './chain-wasm';

// The worklet of the chain: one node after the voices, everything in its Rust core (dsp/chain, the wasm in this
// bundle, compiled as the module loads; needs wasm SIMD). A thin wrapper: the messages of the main thread become
// the events and the calls of the core (the seconds of the context its frames), a block is one call, what the core
// tells goes back (the meters of the effects only while a screen watches them, a stage that failed or was made
// again). No window,
// document or React here

// AudioWorkletGlobalScope (no DOM lib types for it)
declare const sampleRate: number;
declare const currentFrame: number;
interface AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare const AudioWorkletProcessor: { prototype: AudioWorkletProcessor; new (): AudioWorkletProcessor };
declare function registerProcessor(
  name: string,
  processor: new (options: AudioWorkletNodeOptions) => AudioWorkletProcessor
): void;

const core = instantiateCore<ChainExports>(new WebAssembly.Module(bytes));

// what a screen draws of a kind, read into the same object every time (nothing is made on the audio thread)
const METERS: Partial<Record<FxKind, (values: Float64Array, idle: boolean) => unknown>> = {
  chorus: chorusMeterReader(),
  compressor: compressorMeterReader(),
};

// (the functions of a block compile lazily, on their first call: not in the first block of the first node)
prewarmChain(core, sampleRate);

interface Meter extends Metered {
  slot: number;
  read: (values: Float64Array, idle: boolean) => unknown;
  readonly idle: boolean;
}

class ChainProcessor extends AudioWorkletProcessor {
  private chain: ChainWasm | null;
  private meters: Meter[];
  // (a node whose input is not connected gets no channel: a block of silence)
  private silence = new Float32Array(128);
  // the frame after the last block: the time of now for a state of the LFOs
  private next = 0;
  private meterReport: ChainReport = {};
  private failedReport: ChainReport = { failed: [] };
  private brokenReport: ChainReport = { broken: true };

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const { state = neutralState() } = (options.processorOptions ?? {}) as Partial<ChainOptions>;
    const chain = createChainWasm(core, sampleRate, state);
    this.chain = chain;
    this.meters = FX_KINDS.flatMap((kind, slot) => {
      const read = METERS[kind];
      if (!read) return [];
      // (a literal: its getter stays one, Object.assign would read it once)
      const meter: Meter = {
        ...metered(state.meters.includes(slot)),
        slot,
        read,
        get idle() {
          return chain.idle(slot);
        },
      };
      return [meter];
    });
    this.port.onmessage = ({ data }: MessageEvent<ChainMessage>) => this.take(data);
  }

  private take(message: ChainMessage) {
    const { chain } = this;
    if (!chain) return;
    // (a time that has passed: the next block)
    const at = message.at === undefined ? 0 : message.at * sampleRate;
    if (message.params) chain.setParams(message.params[0], message.params[1], at);
    if (message.mix) chain.setMix(message.mix[0], message.mix[1], at);
    if (message.active) chain.setActive(message.active[0], message.active[1], at);
    if (message.order) chain.setOrder(message.order, at);
    if (message.masterGain !== undefined) chain.setMasterGain(message.masterGain, at);
    if (message.mute !== undefined) chain.mute(message.mute, at);
    if (message.unmute) chain.unmute(at);
    if (message.clear) chain.clear(at);
    // (its states are for a time ahead of now: one that comes late takes over now)
    if (message.lfos) chain.setLfos(lateState(message.lfos, this.next / sampleRate));
    if (message.routes) chain.setRoutes(message.routes);
    if (message.note !== undefined) chain.setNote(message.note);
    if (message.meter) {
      const [slot, watched] = message.meter;
      const meter = this.meters.find((item) => item.slot === slot);
      if (meter) watchMeter(meter, watched);
    }
    if (message.retry !== undefined) {
      // (told back: the main thread shows the stage ready only once it is)
      if (chain.retry(message.retry)) this.port.postMessage({ remade: message.retry } satisfies ChainReport);
      else this.port.postMessage({ failed: [message.retry] } satisfies ChainReport);
      // (the meter of a unit made again: as it is, at rest too)
      const meter = this.meters.find((item) => item.slot === message.retry);
      if (meter) watchMeter(meter, meter.metering);
    }
    if (message.stop) {
      chain.free();
      this.chain = null;
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const { chain } = this;
    if (!chain) return false;
    const [outL, outR] = outputs[0];
    const frames = outL.length;
    if (this.silence.length !== frames) this.silence = new Float32Array(frames);
    const inL = inputs[0]?.[0] ?? this.silence;
    const inR = inputs[0]?.[1] ?? inL;
    if (!chain.process(inL, inR, outL, outR ?? outL, currentFrame)) {
      // a trap that is in no stage: the core is where it left it (not freed: that could trap again), the node is
      // over, the main thread makes another of its state
      this.chain = null;
      this.port.postMessage(this.brokenReport);
      return false;
    }
    this.next = currentFrame + frames;

    const failed = chain.reports();
    if (failed) {
      const stages = this.failedReport.failed as number[];
      stages.length = 0;
      for (let stage = 0; stage <= LIMITER_STAGE; stage++) if (failed & (1 << stage)) stages.push(stage);
      this.port.postMessage(this.failedReport);
    }
    for (let index = 0; index < this.meters.length; index++) {
      const meter = this.meters[index];
      if (!meterDue(meter, frames, sampleRate)) continue;
      const values = chain.meter(meter.slot);
      // (a unit that failed has no meter: the screen keeps the last one)
      if (values.length === 0) continue;
      this.meterReport.meter = [meter.slot, meter.read(values, meter.idle)];
      this.port.postMessage(this.meterReport);
    }
    return true;
  }
}

registerProcessor(CHAIN_PROCESSOR, ChainProcessor);
