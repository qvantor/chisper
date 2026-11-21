import { isWasmSimdSupported, WASM_MODULES } from '../../common/wasm/wasm-support';

// worklet modules are bundled by esbuild (`npm run worklets`) and served next to the app assets
export const WORKLETS_PATH = 'assets/worklets/';

// the url of the bundle `name` (a worklet module, a worker)
export const workletUrl = (name: string) => new URL(`${WORKLETS_PATH}${name}.js`, document.baseURI).href;

// AudioWorklet exists only in secure contexts (https, localhost) and not in old Safari; the module `name` with its
// wasm core (WASM_MODULES) needs wasm SIMD too (Safari 16.4+)
export const isWorkletSupported = (audioCtx: BaseAudioContext, name?: string) =>
  Boolean(audioCtx.audioWorklet) &&
  typeof AudioWorkletNode !== 'undefined' &&
  (name === undefined || !WASM_MODULES.includes(name) || isWasmSimdSupported());

// why the engine can't play in this browser (null: it can): no AudioWorklet (or not a secure context), no wasm
// SIMD, no Worker or no MessageChannel (the tables are built in a worker and sent over a channel)
export const unsupportedReason = (audioCtx: BaseAudioContext) => {
  if (!isWorkletSupported(audioCtx)) return 'audio-worklet';
  if (!isWasmSimdSupported()) return 'wasm-simd';
  if (typeof Worker === 'undefined') return 'worker';
  if (typeof MessageChannel === 'undefined') return 'message-channel';
  return null;
};

const loaded = new WeakMap<BaseAudioContext, Map<string, Promise<void>>>();

// adds the module `name` to the context once (assets/worklets/<name>.js), every effect awaits the same promise. Never throws: no audioWorklet rejects too. A failed load is
// forgotten, so the next call adds the module again
export const loadWorklet = (audioCtx: BaseAudioContext, name: string) => {
  const modules = loaded.get(audioCtx) ?? new Map<string, Promise<void>>();
  loaded.set(audioCtx, modules);
  const cached = modules.get(name);
  if (cached) return cached;
  const promise = new Promise<void>((resolve) => resolve(audioCtx.audioWorklet.addModule(workletUrl(name))));
  modules.set(name, promise);
  // attached first, so it runs before the callers learn about the failure and retry
  promise.catch(() => modules.delete(name));
  return promise;
};
