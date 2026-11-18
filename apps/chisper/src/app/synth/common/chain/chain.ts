import { BehaviorSubject } from 'rxjs';
import { isEqual } from 'lodash';
import { isWorkletSupported, loadWorklet } from '../../fx/effects/load-worklet';
import type { FxStatus } from '../../fx/effects/types';
import { createLfoFeed, LfosState } from '../lfo/lfo-curve';
import {
  CHAIN_MODULE,
  CHAIN_PROCESSOR,
  ChainMessage,
  ChainNote,
  ChainOptions,
  ChainReport,
  ChainRoute,
  ChainState,
  FX_KINDS,
  LFO_SOURCE,
  LIMITER_STAGE,
  neutralState,
} from './chain-params';

// the node of the chain: a mono input is upmixed to both channels
const NODE_OPTIONS: AudioWorkletNodeOptions = {
  numberOfInputs: 1,
  numberOfOutputs: 1,
  outputChannelCount: [2],
  channelCount: 2,
  channelCountMode: 'explicit',
  channelInterpretation: 'speakers',
};

// The chain on the main thread: input → the node of the chain (chain.worklet.ts: the effects in their slots, the
// master gain, the limiter) → output, once its module has loaded. Until the node exists, or when the browser has
// no AudioWorklet or no wasm SIMD or the module failed, the input goes nowhere: the master is silent (no fallback:
// nothing plays unlimited) and `$status` tells why; retry() loads a failed module again.
//
// Everything is told to the node in messages (no AudioParam): the chain keeps the whole state here and makes the
// node with it (processorOptions), so a node made later, or again, plays what the knobs say. A stage that failed
// in the core (a trap inside an effect or the limiter) is told back: `status(stage)` is 'failed' until
// retryStage() makes its unit again ('loading' until the node tells it did, 'failed' again if it could not); the
// others play on. What trapped is never freed (a free could trap again), so
// a stage is made again MAX_REMAKES times at most, and so is a node whose core trapped: it stays failed then
// (the memory of the module is back with the page)
const MAX_REMAKES = 4;

export const createChain = (audioCtx: BaseAudioContext) => {
  const input = audioCtx.createGain();
  const output = audioCtx.createGain();
  const $status = new BehaviorSubject<FxStatus>('loading');
  const state: ChainState = neutralState();
  // the stages that failed in the core (bits), the status of each stage: that of the module unless it failed
  let failed = 0;
  // the failed stages a retry is making again (bits): 'loading' until the node tells what came of it
  let retrying = 0;
  // how many times each stage was made again, and a node after its core trapped; whether the node of now ended so
  const remakes = Array.from({ length: LIMITER_STAGE + 1 }, () => 0);
  let rebuilds = 0;
  let trapped = false;
  const spent = (what: string) =>
    console.error(`${what} failed ${MAX_REMAKES} times and is not made again: reload the page`);
  const statuses = Array.from({ length: LIMITER_STAGE + 1 }, () => new BehaviorSubject<FxStatus>('loading'));
  const refresh = () =>
    statuses.forEach(($stage, stage) => {
      const bit = 1 << stage;
      const own = retrying & bit ? 'loading' : 'failed';
      const next = $status.value === 'ready' && failed & bit ? own : $status.value;
      if ($stage.value !== next) $stage.next(next);
    });
  let destroyed = false;
  let node: AudioWorkletNode | undefined;
  const listeners = new Map<number, (values: unknown) => void>();

  const post = (message: ChainMessage) => node?.port.postMessage(message);
  // the LFOs, only while a route of one moves a knob (a state is a table of 8 KB the audio thread takes in)
  const feed = createLfoFeed((lfos) => post({ lfos }));

  // the processor ends (its core is freed: it keeps its state in the memory of the module until then)
  const stop = (current: AudioWorkletNode | undefined) => {
    current?.port.postMessage({ stop: true } satisfies ChainMessage);
    current?.disconnect();
  };

  const setStatus = (status: FxStatus) => {
    $status.next(status);
    refresh();
  };

  // (a processor that threw still takes messages: stopped, its core is freed)
  const fail = (error: unknown) => {
    if (destroyed) return;
    console.error('The chain worklet failed', error);
    // (its node alone: what else taps the input stays)
    if (node) input.disconnect(node);
    stop(node);
    node = undefined;
    setStatus('failed');
  };

  const take = ({ meter, failed: stages, remade, broken }: ChainReport) => {
    // (the core trapped out of its stages: its node is over, as one whose processor threw)
    if (broken) {
      trapped = true;
      fail(new Error('The chain core trapped'));
      return;
    }
    if (meter) listeners.get(meter[0])?.(meter[1]);
    if (remade !== undefined) {
      failed &= ~(1 << remade);
      retrying &= ~(1 << remade);
      refresh();
    }
    if (stages) {
      stages.forEach((stage) => {
        failed |= 1 << stage;
        retrying &= ~(1 << stage);
      });
      console.error('A stage of the chain failed', stages);
      refresh();
    }
  };

  const load = () => {
    if (!isWorkletSupported(audioCtx, CHAIN_MODULE)) {
      setStatus('unsupported');
      return;
    }
    setStatus('loading');
    loadWorklet(audioCtx, CHAIN_MODULE)
      .then(() => {
        if (destroyed) return;
        failed = 0;
        retrying = 0;
        const processorOptions: ChainOptions = { state: { ...state, lfos: feed.initial() } };
        const current = new AudioWorkletNode(audioCtx, CHAIN_PROCESSOR, {
          ...NODE_OPTIONS,
          processorOptions,
        });
        node = current;
        // the processor threw: it outputs silence from now on, a retry creates a new one; a node dropped
        // earlier (failed, then retried) must not fail the current one
        current.onprocessorerror = (event) => {
          if (node === current) fail(event);
        };
        current.port.onmessage = ({ data }: MessageEvent<ChainReport>) => {
          if (node === current) take(data);
        };
        input.connect(current).connect(output);
        setStatus('ready');
      })
      .catch(fail);
  };
  load();

  const slotOf = (slot: number) => state.slots[FX_KINDS[slot]];

  return {
    input,
    output,
    $status,
    // the status of a stage (a slot by its kind, LIMITER_STAGE)
    status: (stage: number) => statuses[stage],
    // loads a failed module again (nothing to do in any other status)
    retry: () => {
      if ($status.value !== 'failed') return;
      if (trapped) {
        if (rebuilds >= MAX_REMAKES) {
          spent('The chain core');
          return;
        }
        rebuilds += 1;
        trapped = false;
      }
      load();
    },
    // makes the unit of a stage that failed again: the stage is loading until the node tells it is made (ready)
    // or could not be (failed again). Without a node (its core trapped, the module loads again) there is no stage
    // to make: the node to come has them all
    retryStage: (stage: number) => {
      const bit = 1 << stage;
      if (!node || !(failed & bit) || retrying & bit) return;
      if (remakes[stage] >= MAX_REMAKES) {
        spent(`Stage ${stage} of the chain`);
        return;
      }
      remakes[stage] += 1;
      retrying |= bit;
      post({ retry: stage });
      refresh();
    },
    // the params of the effect of a slot, by the keys of the core: those that changed are sent
    setParams: (slot: number, params: Record<string, number>) => {
      const before = slotOf(slot).params;
      const changed: Record<string, number> = {};
      let any = false;
      Object.keys(params).forEach((key) => {
        if (before[key] === params[key]) return;
        changed[key] = params[key];
        any = true;
      });
      if (!any) return;
      slotOf(slot).params = { ...before, ...changed };
      post({ params: [slot, changed] });
    },
    setMix: (slot: number, mix: number) => {
      if (slotOf(slot).mix === mix) return;
      slotOf(slot).mix = mix;
      post({ mix: [slot, mix] });
    },
    // in the chain, on and ready: its effect plays (else its slot passes its input)
    setActive: (slot: number, active: boolean) => {
      if (slotOf(slot).active === active) return;
      slotOf(slot).active = active;
      post({ active: [slot, active] });
    },
    // the slots in the chain, in their order
    setOrder: (order: number[]) => {
      if (isEqual(state.order, order)) return;
      state.order = [...order];
      post({ order });
    },
    setMasterGain: (gain: number) => {
      state.masterGain = gain;
      post({ masterGain: gain });
    },
    // the output (after the effects, before the limiter) fades out in `seconds` from now (the time of the
    // context goes with it: the fade ends then, however late the node takes the message), opens again at once
    mute: (seconds: number) => {
      state.muted = true;
      post({ mute: seconds, at: audioCtx.currentTime });
    },
    unmute: () => {
      state.muted = false;
      post({ unmute: true });
    },
    // the effects forget their tails and the limiter its sound at once (a preset switch, the output muted)
    clear: () => post({ clear: true }),
    // the routes of the knobs of the effects that play (and of the note to the knobs of the LFOs); the LFOs as
    // they are first, once a route reads one
    setRoutes: (routes: ChainRoute[]) => {
      if (isEqual(state.routes, routes)) return;
      const first = state.routes.length === 0 && routes.length > 0;
      state.routes = routes;
      feed.use(routes.some(({ source }) => source >= LFO_SOURCE));
      // (the note of now with the first routes: none was sent while no knob followed it)
      post(first ? { note: state.note, routes } : { routes });
    },
    // the last note: sent while a route follows it
    setNote: (note: ChainNote | null) => {
      state.note = note;
      if (state.routes.length > 0) post({ note });
    },
    setLfos: (lfos: LfosState) => feed.take(lfos),
    // the meter of the effect of a slot: `listener` gets what the worklet posts of it while it is watched
    watch: (slot: number, listener: ((values: unknown) => void) | null) => {
      const watched = listener !== null;
      if (listener) listeners.set(slot, listener);
      else listeners.delete(slot);
      state.meters = state.meters.filter((other) => other !== slot).concat(watched ? [slot] : []);
      post({ meter: [slot, watched] });
    },
    destroy: () => {
      destroyed = true;
      stop(node);
      node = undefined;
      listeners.clear();
      input.disconnect();
      output.disconnect();
      $status.complete();
      statuses.forEach(($stage) => $stage.complete());
    },
  };
};
export type Chain = ReturnType<typeof createChain>;
