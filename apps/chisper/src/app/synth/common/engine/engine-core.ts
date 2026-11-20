import { UPDATED } from '../../../common/services';
import { instantiateCoreAsync } from '../wasm/wasm-core';
import type { EngineExports } from './engine-wasm';
import { ENGINE_WASM_URL } from './engine-wasm-url';

// The core of the engine on the main thread (a render of the track): the same engine.wasm as the worklet's, served
// as an asset of the bundle named by its bytes (engine-wasm-url.ts; the bytes of the worklet are inside its bundle),
// fetched and compiled at the first render only, one module a page (a load that failed is forgotten: the next render
// loads it again; one that is gone, a page of before a deploy: UPDATED); each render makes an instance of its own,
// dropped with it

// (not `module`: the dev server reads `module.hot` of every module it refreshes)
let compiled: Promise<WebAssembly.Module> | null = null;

const compile = async (url: string) => {
  const response = await fetch(url);
  if (response.status === 404) throw new Error(UPDATED);
  if (!response.ok) throw new Error(`The engine core failed to load (${response.status})`);
  // (streaming only with the type of wasm: a server that gives another one has it compiled from the bytes)
  const streams = response.headers.get('content-type')?.startsWith('application/wasm') ?? false;
  if (streams && typeof WebAssembly.compileStreaming === 'function')
    return WebAssembly.compileStreaming(response);
  return WebAssembly.compile(await response.arrayBuffer());
};

const loadEngineModule = () => {
  compiled ??= compile(ENGINE_WASM_URL).catch((error) => {
    compiled = null;
    throw error;
  });
  return compiled;
};

// an instance of its own of the core
export const loadEngineCore = async () => instantiateCoreAsync<EngineExports>(await loadEngineModule());
