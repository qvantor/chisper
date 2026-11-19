import { BehaviorSubject } from 'rxjs';
import { isEqual } from 'lodash';
import type { FxStatus } from '../../fx/effects/types';
import { EngineNode, MAX_REMAKES, spent } from '../engine/engine-node';
import {
  ChainMessage,
  ChainNote,
  ChainReport,
  ChainRoute,
  ChainState,
  FX_KINDS,
  LFO_SOURCE,
  LIMITER_STAGE,
  neutralState,
} from './chain-params';

// The chain on the main thread: what the knobs tell the half of the engine node after the voices (engine.worklet.ts:
// the effects in their slots, the master gain, the limiter) → output. Until the node exists, or when the browser
// has no AudioWorklet or no wasm SIMD or the module failed, the master is silent (no fallback: nothing plays
// unlimited) and `$status` tells why; retry() loads a failed module again.
//
// Everything is told to the node in messages (no AudioParam): the chain keeps the whole state here and the node is
// made with it (its options), so a node made later, or again, plays what the knobs say. A stage that failed in the
// core (a trap inside an effect or the limiter) is told back: `status(stage)` is 'failed' until retryStage() makes
// its unit again ('loading' until the node tells it did, 'failed' again if it could not); the others play on. What
// trapped is never freed (a free could trap again), so a stage is made again MAX_REMAKES times at most, as a node
// whose core trapped is (engine-node.ts)

// `host`: the node it plays in (the one of the synth core: the voices play in it too, and it is the core's to
// destroy)
export const createChain = (audioCtx: BaseAudioContext, host: EngineNode) => {
  const { output } = host;
  const $status = new BehaviorSubject<FxStatus>('loading');
  const state: ChainState = neutralState();
  // the stages that failed in the core (bits), the status of each stage: that of the module unless it failed
  let failed = 0;
  // the failed stages a retry is making again (bits): 'loading' until the node tells what came of it
  let retrying = 0;
  // how many times each stage was made again
  const remakes = Array.from({ length: LIMITER_STAGE + 1 }, () => 0);
  const statuses = Array.from({ length: LIMITER_STAGE + 1 }, () => new BehaviorSubject<FxStatus>('loading'));
  const refresh = () =>
    statuses.forEach(($stage, stage) => {
      const bit = 1 << stage;
      const own = retrying & bit ? 'loading' : 'failed';
      const next = $status.value === 'ready' && failed & bit ? own : $status.value;
      if ($stage.value !== next) $stage.next(next);
    });
  // whether the node is there (it has the stages)
  let live = false;
  const listeners = new Map<number, (values: unknown) => void>();

  const post: (message: ChainMessage) => void = host.post;

  const take = ({ meter, failed: stages, remade }: ChainReport) => {
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

  host.attach({
    options: () => ({ state }),
    // (a new node has every stage)
    start: () => {
      failed = 0;
      retrying = 0;
      live = true;
    },
    stop: () => {
      live = false;
    },
    status: (status) => {
      $status.next(status);
      refresh();
    },
    report: take,
  });

  const slotOf = (slot: number) => state.slots[FX_KINDS[slot]];

  return {
    output,
    $status,
    // the status of a stage (a slot by its kind, LIMITER_STAGE)
    status: (stage: number) => statuses[stage],
    // loads a failed module again (nothing to do in any other status)
    retry: host.retry,
    // makes the unit of a stage that failed again: the stage is loading until the node tells it is made (ready)
    // or could not be (failed again). Without a node (its core trapped, the module loads again) there is no stage
    // to make: the node to come has them all
    retryStage: (stage: number) => {
      const bit = 1 << stage;
      if (!live || !(failed & bit) || retrying & bit) return;
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
      host.lfos.use(
        'chain',
        routes.some(({ source }) => source >= LFO_SOURCE)
      );
      // (the note of now with the first routes: none was sent while no knob followed it)
      post(first ? { note: state.note, routes } : { routes });
    },
    // the last note: sent while a route follows it
    setNote: (note: ChainNote | null) => {
      state.note = note;
      if (state.routes.length > 0) post({ note });
    },
    // the meter of the effect of a slot: `listener` gets what the worklet posts of it while it is watched
    watch: (slot: number, listener: ((values: unknown) => void) | null) => {
      const watched = listener !== null;
      if (listener) listeners.set(slot, listener);
      else listeners.delete(slot);
      state.meters = state.meters.filter((other) => other !== slot).concat(watched ? [slot] : []);
      post({ meter: [slot, watched] });
    },
    destroy: () => {
      listeners.clear();
      $status.complete();
      statuses.forEach(($stage) => $stage.complete());
    },
  };
};
export type Chain = ReturnType<typeof createChain>;
