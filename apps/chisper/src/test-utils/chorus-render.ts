import { FX_MIX_PARAMS, FX_PARAMS } from '@chisper/preset-schema';
import { mapValues, pick } from 'lodash';
import type { ChorusDspParams } from '../app/synth/fx/effects/chorus-params';
import { CHORUS_KEYS, ChorusExports, createChorusWasm } from '../app/synth/fx/effects/chorus-wasm';
import { FxChange, renderStereo } from './fx-render';
import { wasmCore } from './wasm';

// the Rust core of the chorus (dsp/chorus) as the specs render it: through its facade, block by block

export const CHORUS_DEFAULTS: ChorusDspParams = pick(
  { ...mapValues(FX_PARAMS.chorus, (param) => param.default), mix: FX_MIX_PARAMS.chorus.default },
  CHORUS_KEYS
);
// the taps alone: all of the wet signal, the filter open, no feedback
export const CHORUS_TAPS: ChorusDspParams = { ...CHORUS_DEFAULTS, mix: 1, cut: 20000, fb: 0 };

const BLOCK = 128;
let core: ChorusExports | undefined;
// one instance of the core for a spec file (a scope)
export const chorusCore = () => (core ??= wasmCore<ChorusExports>('chorus'));

export type ChorusChange = FxChange<ChorusDspParams>;

interface Options {
  changes?: ChorusChange[];
  // frames of silence before the input (the chorus at rest: only its LFO goes on)
  rest?: number;
}

// both channels through a chorus of `params` at `rate`, in blocks of 128: the outputs, whether it was idle after
// each block
export const renderChorus = (
  params: Partial<ChorusDspParams>,
  sampleRate: number,
  channels: [ArrayLike<number>, ArrayLike<number>],
  { changes = [], rest = 0 }: Options = {}
) => {
  const dsp = createChorusWasm(chorusCore(), sampleRate, { params: { ...CHORUS_DEFAULTS, ...params } });
  for (let left = rest; left > 0; left -= BLOCK) {
    const n = Math.min(BLOCK, left);
    dsp.process(new Float32Array(n), new Float32Array(n), new Float32Array(n), new Float32Array(n));
  }
  return renderStereo(dsp, channels, changes);
};

// the laws of the core, as measured: the shares of the dry and the wet signal by the mix, what a tap is late by
// with its knob at 0 (ms)
export const mixGains = (mix: number): [dry: number, wet: number] => {
  const wet = Math.sin((Math.PI / 2) * Math.min(Math.max(mix, 0), 1)) ** 2;
  return [1 - wet * wet, wet];
};
export const TAP_LATENCY_MS = (5.25 / 44100) * 1000;

// a click with no highs to ring in a filter (a sinc under a Hann window, 33 samples, its peak `level` at their
// middle) from `at`
export const CLICK_MIDDLE = 16;
export const clickInto = (signal: Float64Array, at: number, level = 0.5) => {
  for (let i = 0; i <= 2 * CLICK_MIDDLE; i++) {
    const x = 0.9 * Math.PI * (i - CLICK_MIDDLE);
    const window = 0.5 - 0.5 * Math.cos((Math.PI * (i + 1)) / (CLICK_MIDDLE + 1));
    signal[at + i] += level * window * (x === 0 ? 1 : Math.sin(x) / x);
  }
};

// where the click of `dry` at `at` (its middle) comes out of `wet`: their correlation over the lags [-8, to), its
// peaks above `floor` of the dry one (parabolic): [lag in samples, gain]
export const tapsOf = (
  wet: ArrayLike<number>,
  dry: ArrayLike<number>,
  at: number,
  to: number,
  floor: number
): [number, number][] => {
  const W = 24;
  let auto = 0;
  for (let i = -W; i <= W; i++) auto += dry[at + i] ** 2;
  const lags = Float64Array.from({ length: to + 8 }, (_, k) => {
    let sum = 0;
    for (let i = -W; i <= W; i++) sum += dry[at + i] * (wet[at + k - 8 + i] ?? 0);
    return sum / auto;
  });
  const found: [number, number][] = [];
  for (let k = 1; k < lags.length - 1; k++) {
    const [a, b, c] = [Math.abs(lags[k - 1]), Math.abs(lags[k]), Math.abs(lags[k + 1])];
    if (b <= floor || b < a || b <= c) continue;
    const shift = (a - c) / (2 * (a - 2 * b + c));
    found.push([k - 8 + shift, lags[k] - 0.25 * (lags[k - 1] - lags[k + 1]) * shift]);
  }
  return found;
};

// the taps of tapsOf with the ripples beside each left out: of the peaks within `apart` samples the loudest
export const mainTaps = (taps: [number, number][], apart = 24): [number, number][] =>
  taps.reduce<[number, number][]>((kept, tap) => {
    const last = kept[kept.length - 1];
    if (!last || tap[0] - last[0] > apart) return [...kept, tap];
    if (Math.abs(tap[1]) > Math.abs(last[1])) kept[kept.length - 1] = tap;
    return kept;
  }, []);
