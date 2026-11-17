import { readFileSync } from 'fs';
import { join } from 'path';
import type { UnitExports } from '../app/synth/common/wasm/stereo-core';
import type { DelayDspParams } from '../app/synth/fx/effects/delay-params';
import { createDelayWasm } from '../app/synth/fx/effects/delay-wasm';
import { FxChange, renderStereo } from './fx-render';
import { wasmCore } from './wasm';

// the delay as its specs render it, and the scenes of the native nodes it is held to
// (dsp/measurements/delay.json, scripts/delay-native)

let core: UnitExports | undefined;
// one instance for a spec file
export const delayCore = () => (core ??= wasmCore<UnitExports>('chain'));

export const DELAY_DEFAULTS: DelayDspParams = { time: 0.2, fb: 0.5, mode: 0, pan: 0, freq: 1000, q: 0.01 };

export const renderDelay = (
  params: Partial<DelayDspParams>,
  input: [ArrayLike<number>, ArrayLike<number>],
  changes: FxChange<DelayDspParams>[] = [],
  rate = 44100
) => renderStereo(createDelayWasm(delayCore(), rate, { ...DELAY_DEFAULTS, ...params }), input, changes);

// the inputs of scripts/delay-native/scenes.mjs, the same bits (whole numbers)
export const clicks = (frames: number): [Float32Array, Float32Array] => {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  left[0] = 1;
  right[3] = -0.5;
  let seed = 12345;
  const next = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 8) / 0x1000000 - 0.5;
  };
  for (let i = 16; i < 272; i++) {
    left[i] = next() * 0.5;
    right[i] = next() * 0.25;
  }
  return [left, right];
};

export const train = (frames: number): [Float32Array, Float32Array] => {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i += 441) {
    left[i] = 0.5;
    if (i + 100 < frames) right[i + 100] = -0.5;
  }
  return [left, right];
};

export interface DelayScene {
  name: string;
  rate: number;
  frames: number;
  kind: 'clicks' | 'train';
  params: DelayDspParams;
  changes: { frame: number; params: Partial<DelayDspParams> }[];
  left: string;
  right: string;
}

const floats = (text: string) => {
  const bytes = Buffer.from(text, 'base64');
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
};

export const delayScenes = () => {
  const file = join(__dirname, '../../../../dsp/measurements/delay.json');
  const { scenes } = JSON.parse(readFileSync(file, 'utf8')) as { scenes: DelayScene[] };
  return scenes.map((scene) => ({ ...scene, left: floats(scene.left), right: floats(scene.right) }));
};

export const DELAY_INPUTS = { clicks, train };
