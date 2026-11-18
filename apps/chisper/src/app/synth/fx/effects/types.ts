import type { HandleProps } from '@chisper/ui-kit';
import type { ParamRange } from '@chisper/preset-schema';

export type FxParamDef = Pick<HandleProps, 'name' | 'mode' | 'precision' | 'formatValue' | 'fillFrom'> &
  ParamRange & {
    label: string;
    // a switch instead of a knob, the value is the index of the option
    options?: { id: string; label: string }[];
    // a vertical fader instead of a knob
    control?: 'fader';
  };

// the status of an effect, that of the chain it plays in (common/chain/chain.ts). loading: the module of the chain
// is being added; unsupported: no AudioWorklet or no wasm SIMD in this browser or context (old Safari, http on a
// LAN IP); failed: the module or the node failed, or the effect itself did inside the core (the others play on),
// retry() loads or makes it again
export type FxStatus = 'loading' | 'ready' | 'unsupported' | 'failed';

// a loading effect is already in the chain (its slot passes its input until the node exists), an unavailable one
// is not
export const isFxUsable = (status: FxStatus) => status === 'loading' || status === 'ready';

// watch(listener): the values of the effect (CompressorMeterValues of compressor-params.ts, ChorusMeterValues of
// chorus-params.ts) about 30 times a second until the function it returns is called
export interface FxMeter<Values = unknown> {
  watch: (listener: (values: Values) => void) => () => void;
}

// a built-in preset of the effect: sets mix and every param, added/on/order are not touched
export interface FxPreset<K extends string = string> {
  id: string;
  name: string;
  mix: number;
  params: Record<K, number>;
}

export interface FxDefinition<K extends string = string> {
  label: string;
  // param keys are the preset snapshot keys of the effect
  params: Record<K, FxParamDef>;
  presets: FxPreset<K>[];
  // the params a change of `key` to `value` by the user sets at a tempo (BPM), those of others with it (the delay
  // in BPM: Time to a division and back); absent: only it. A preset and a snapshot set their params as they are
  paramChange?: (
    params: Record<string, number>,
    key: string,
    value: number,
    bpm: number
  ) => Record<string, number>;
  // the bounds of the routes to its knobs at a tempo, by param (Time of the delay in BPM: within its divisions);
  // absent or none for a param: the range of its knob
  bounds?: (params: Record<string, number>, bpm: number) => Partial<Record<string, [number, number]>>;
  // its params as the core of the chain takes them (CHAIN_KEYS of its kind) at a tempo (BPM) and a rate: a knob in
  // BPM as what its division is there, an era as the values of its stage. The mix is of its slot
  core: (params: Record<K, number>, bpm: number, sampleRate: number) => Record<string, number>;
  // it tells a meter while a screen watches it (FxSlot.meter)
  metered?: boolean;
}
