import { mapValues } from 'lodash';
import { TEMPO_DEFAULT } from '@chisper/preset-schema';
import type { Chain } from '../../common/chain/chain';
import { createFxMeter } from './fx-meter';
import { FxDefinition, FxMeter } from './types';

export type FxSlot = ReturnType<typeof createFxSlot>;

// The slot of an effect in the chain (common/chain: one worklet node with one core for every effect, the master
// gain and the limiter). In the core a slot is: its input → the effect → mixed with the input (late by the latency
// of the effect, so the mix doesn't comb filter) by the law of its kind (equal power: a reverb adds up like an
// unrelated sound; the echoes of the delay by the law measured of them, the wet gain sin²(π mix / 2) and the dry
// one 1 - wet²; linear: a distortion is the dry signal reshaped, in time with it; inside: a chorus and a
// compressor mix the dry signal themselves, their wet one is out of phase with it), its gains gliding. A slot that
// doesn't play (out of the chain, bypassed, not ready) passes its input and its effect is forgotten once it has
// faded out: a stale tail never comes back.
//
// Here it is what the fx model tells the chain of it: the knobs of the effect as its core takes them (`definition`
// .core: a knob in BPM at the tempo of the synth, an era as the values of its stage), its mix, whether it plays;
// its status is that of the chain, 'failed' when the effect itself failed in the core
export const createFxSlot = (chain: Chain, slot: number, definition: FxDefinition, sampleRate: number) => {
  let values: Record<string, number> = mapValues(definition.params, (param) => param.default);
  // the tempo of the synth (BPM)
  let bpm = TEMPO_DEFAULT;
  const send = () => chain.setParams(slot, definition.core(values, bpm, sampleRate));
  send();

  // what the effect shows of its work while a screen watches it (absent: nothing)
  const meters = definition.metered
    ? createFxMeter<unknown>((watched) => chain.watch(slot, watched ? emit : null))
    : undefined;
  const emit = (values: unknown) => meters?.emit(values);
  const meter: FxMeter | undefined = meters?.meter;

  return {
    $status: chain.status(slot),
    // loads the module of the chain again if it failed, makes the effect again if it did
    retry: () => {
      chain.retry();
      chain.retryStage(slot);
    },
    // the knobs of the effect (those that changed reach the core)
    setParams: (params: Record<string, number>) => {
      values = { ...values, ...params };
      send();
    },
    setMix: (value: number) => chain.setMix(slot, value),
    // in the chain, on and ready: its effect plays
    setActive: (active: boolean) => chain.setActive(slot, active),
    // the tempo of the synth: a knob in BPM follows it
    setTempo: (next: number) => {
      bpm = next;
      send();
    },
    meter,
    destroy: () => meters?.clear(),
  };
};
