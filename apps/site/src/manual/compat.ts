// where the synth plays and what each browser lets it do: a MIDI keyboard (Web MIDI), a choice of latency (the
// latencyHint of desktop Chromium: apps/chisper/src/app/synth/common/latency/latency.ts). Every browser needs
// AudioWorklet and WebAssembly SIMD (Safari from 16.4)
type Compat = {
  // browser names stay as they are; `any`: every browser of the system
  browser: string;
  system: string;
  midi: boolean;
  latency: boolean;
};

export const COMPAT: Compat[] = [
  { browser: 'Chrome, Edge, Opera', system: 'Windows, macOS, Linux', midi: true, latency: true },
  { browser: 'Chrome', system: 'ChromeOS', midi: true, latency: true },
  { browser: 'Firefox', system: 'Windows, macOS, Linux', midi: true, latency: false },
  { browser: 'Safari 16.4+', system: 'macOS', midi: false, latency: false },
  { browser: 'Chrome', system: 'Android', midi: true, latency: false },
  { browser: 'any', system: 'iOS, iPadOS 16.4+', midi: false, latency: false },
];
