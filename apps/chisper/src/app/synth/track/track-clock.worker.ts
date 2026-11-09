// the Web Worker that ticks the track while it plays (track-clock.ts), bundled by esbuild (`npm run worklets`) into
// assets/worklets/track-clock.js: the timers of a hidden page wait a second and more, those of a worker don't. A
// message of a number of ms ticks every as many ms from then on, any other stops it; no window, document or React

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage: (message: number) => void;
};
let timer: ReturnType<typeof setInterval> | null = null;
scope.onmessage = ({ data }) => {
  if (timer !== null) clearInterval(timer);
  timer = null;
  if (typeof data === 'number' && data > 0) timer = setInterval(() => scope.postMessage(0), data);
};
