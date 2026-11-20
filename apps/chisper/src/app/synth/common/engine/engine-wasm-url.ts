// the core of the engine a render of the track runs on the main thread (engine-core.ts): an asset of the bundle
// named by its bytes (webpack), so that a page of before asks for its own and never a core of a later deploy (its
// numbers would not be those of the code of the page); the perf build has the core of its own (engine-wasm-url.perf.ts)
export const ENGINE_WASM_URL = new URL('@chisper/wasm/engine.wasm', import.meta.url).href;
