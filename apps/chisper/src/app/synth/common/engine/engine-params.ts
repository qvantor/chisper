import type { ChainMessage, ChainReport, ChainState } from '../chain/chain-params';
import type { LfosState } from '../lfo/lfo-curve';
import type { BuilderPortMessage } from '../wavetable/wavetable-builder';
import type {
  StatsRequest,
  StoreStatsMessage,
  StoreStoredMessage,
  StoreTableMessage,
  VoiceEvent,
  VoicesReportMessage,
} from '../wavetable/voice-options';
import type { StoreFreedBytesMessage, StoreRefusedMessage } from '../wavetable/wavetable-osc-wasm';

// The engine (dsp/engine, engine.wasm): the whole path of the sound in one worklet node with one core. The voices
// of every note and the store of their tables, their sum straight into the chain (the effects in their slots, the
// master gain, the limiter). What the main thread, the worklet and the specs share of it: no imports but types

// the module and its processor (assets/worklets/engine.js)
export const ENGINE_MODULE = 'engine';
export const ENGINE_PROCESSOR = 'chisper-engine';

// the node of the engine: no input, the output of the limiter. In the perf build a second output: the voices as
// the chain takes them, filled only while a probe listens (`probe`)
export const ENGINE_NODE_OPTIONS: AudioWorkletNodeOptions = {
  numberOfInputs: 0,
  numberOfOutputs: 1,
  outputChannelCount: [2],
};
export const PROBED_NODE_OPTIONS: AudioWorkletNodeOptions = {
  numberOfInputs: 0,
  numberOfOutputs: 2,
  outputChannelCount: [2, 2],
};

export interface EngineOptions {
  // the chain as its knobs have it (the node is made with it: a node made again plays what they say)
  state?: ChainState;
  // the LFOs as they are (the voices and the chain have them at once)
  lfos?: LfosState;
  // the events of a scene, before its first block (a message to an OfflineAudioContext comes in a block no one can
  // tell)
  events?: VoiceEvent[];
  // each voice into a pair of channels of its own, in the order they were made, past the chain (the parity of the
  // browsers; the node has 2 channels a voice)
  tap?: boolean;
  // the node has an input the chain plays in place of the voices (the parity of the browsers, the benches)
  fed?: boolean;
  // the chain without its limiter
  unlimited?: boolean;
  // the seed of what a note draws (the phases of its unison voices, the shares of a random detune, the start of
  // its noise): a render of the node twice alike. None: Math.random
  seed?: number;
}

// a half of the engine that reads the LFOs
export type LfoReader = 'voices' | 'chain';

// what the knobs and the notes tell the node: the events of the voices of a task, what the chain is told, the LFOs
// of both halves
export type EngineKnobsMessage = ChainMessage & {
  events?: VoiceEvent[];
  // the halves a state of the LFOs (`lfos`) is for: the other reads none and takes none (none named: both)
  readers?: LfoReader[];
  // the voices into the second output from now on, or no more (the perf build)
  probe?: boolean;
};

// main thread → the node: the events of the voices of a task (in their order), what the knobs tell the chain (each
// at once), the port of the worker that sends the tables, a request of the counters (the perf build), a version of
// a table posted whole (the parity of the browsers)
export type EngineMessage = EngineKnobsMessage | BuilderPortMessage | StatsRequest | StoreTableMessage;

// a message of the store of the context (its tables, its port, its counters), not of the engine of a node
export const isStoreMessage = (
  message: EngineMessage
): message is BuilderPortMessage | StatsRequest | StoreTableMessage =>
  'port' in message || 'stats' in message || 'table' in message;

// what failed in the core, told for the reports of the main thread (analytics.ts): the message of the first trap
// since the last report (`RuntimeError.message`: unreachable, out of bounds…) with the stages that failed or the
// node broken, alone a voice or a message that trapped; the failure of the warm-up of the module, in the first
// report of its first node
export interface EngineFaultReport {
  trap?: string;
  prewarm?: string;
}

// the node → main thread: the voices that started and ended, what the chain tells, the answers of the store
export type EngineReport = VoicesReportMessage &
  ChainReport &
  EngineFaultReport &
  Partial<StoreStoredMessage & StoreRefusedMessage & StoreFreedBytesMessage & StoreStatsMessage>;
