// the core of the engine of the perf build (its counters): engine-wasm-url.ts in its place (webpack.config.js)
export const ENGINE_WASM_URL = new URL('../../../../../../../tmp/wasm-perf/engine.wasm', import.meta.url)
  .href;
