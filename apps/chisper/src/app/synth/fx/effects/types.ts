import type { BehaviorSubject } from 'rxjs';
import type { HandleProps } from '@chisper/ui-kit';
import type { ParamRange } from '@chisper/preset-schema';
import type { LfosState } from '../../common/lfo/lfo-curve';
import type { FxMod } from './fx-mod';
import type { FxModulation } from './fx-modulation';

export type FxParamDef = Pick<HandleProps, 'name' | 'mode' | 'precision' | 'formatValue' | 'fillFrom'> &
  ParamRange & {
    label: string;
    // a switch instead of a knob, the value is the index of the option
    options?: { id: string; label: string }[];
    // a vertical fader instead of a knob
    control?: 'fader';
  };

// loading: the worklet module is being added; unsupported: no AudioWorklet in this browser or context
// (old Safari, http on a LAN IP); failed: the module or the node failed, retry() loads it again
export type FxStatus = 'loading' | 'ready' | 'unsupported' | 'failed';

// a loading effect is already in the chain (it passes the dry signal until its node exists), an unavailable
// one is not
export const isFxUsable = (status: FxStatus) => status === 'loading' || status === 'ready';

// the effect itself (the wet signal), mix and bypass are added around it by createFxSlot
export interface FxCore {
  input: AudioNode;
  output: AudioNode;
  setParam: (key: string, value: number) => void;
  // removed from the chain or bypassed: internal loops must die out, so a stale tail doesn't come back
  setActive: (active: boolean) => void;
  // the tail is forgotten at once, its loops and lines start empty (a preset switch, the output muted);
  // absent: it has none
  clear?: () => void;
  // its knobs follow the envelopes and the LFOs of the last note (fx-modulation.ts); null: they are at their own
  // values
  setModulation: (mod: FxModulation | null) => void;
  // the LFOs from the time of a state on (absent: it runs none)
  setLfos?: (state: LfosState) => void;
  // the tempo of the synth, BPM (absent: it takes none)
  setTempo?: (bpm: number) => void;
  destroy: () => void;
  // effects loaded asynchronously (audio worklets, see createWorkletFx), absent: always ready
  $status?: BehaviorSubject<FxStatus>;
  // loads a failed effect again
  retry?: () => void;
  // seconds the output lags the input (linear phase oversampling), createFxSlot delays the dry signal as
  // much, so the mix doesn't comb filter; absent: no latency
  latency?: number;
  // the wet signal is the dry one reshaped, in time with it (a distortion): they add up like one sound, so
  // the mix is linear, an equal-power crossfade would be up to 3 dB louder in between; absent: equal power
  // (echoes and reverb add up like unrelated sounds)
  linearMix?: boolean;
  // the core mixes the dry signal itself (its param `mix`, moved by its own routes): its wet signal is out of
  // phase with the dry one of the slot (the crossovers of a compressor: a mix outside would notch at them), so the
  // slot passes only the core while it is on
  mixInside?: boolean;
  // what it shows of its work, while someone watches (absent: nothing)
  meter?: FxMeter;
}

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
  // (the knobs of native nodes follow their routes by the lines of `fxMod`)
  create: (audioCtx: BaseAudioContext, fxMod?: FxMod) => FxCore;
}
