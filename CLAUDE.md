# CLAUDE.md

Guidance for Claude Code in this repository. Details of behavior live in the code and its specs; this file keeps
what is needed to find your way and what is easy to break.

## Project

Chisper is an experimental browser wavetable synth (TypeScript + Web Audio API, React 19). Nx 24 monorepo:

- `apps/chisper` — the synth; `apps/site` — promo pages (Astro, static, en/es/de).
- `libs/math`, `libs/rxjs-react`, `libs/ui-kit`, `libs/preset-schema` — imported as `@chisper/*` (aliases in
  `tsconfig.base.json`).
- `netlify/` — Functions v2 (presets, usage, clips, bucket lists) and their specs; Postgres for presets and clips
  (`db/migrations/`, applied manually, in order; a change of the preset schema has no file there: the presets are
  rewritten by `scripts/presets/rehash.mjs`, a dry run unless `--apply`).
- `dsp/` — the DSP of the audio worklet in Rust → wasm32 (one core, `engine`: the oscillator into the chain).

Deployed to Netlify at chisper.qvantor.org (`waveform.qvantor.org` is an old alias that `netlify.toml` redirects).

## Tooling

- Nx inferred tasks only (`plugins` of `nx.json`: `@nx/webpack`, `@nx/jest`, `@nx/eslint`); `project.json` only
  overrides. Plain webpack config in `apps/chisper/webpack.config.js`.
- TypeScript 6 (`moduleResolution: bundler`, no `baseUrl`), ESLint 9 flat config (`import/order` is an error),
  Prettier 3 (single quotes, JSX single quotes, width 110, `trailingComma: es5`).
- Jest 30 on jsdom 26: computed colors are `rgb(…)` (`cssColor` of `@chisper/ui-kit/test-utils`);
  `window.location` can't be replaced.
- styled-components 6 (`import { styled }`): style props must be transient (`$size`), others reach the DOM.
- antd 6, react-query 5, zod 4: an object default is `.prefault`, not `.default` (that would change preset hashes;
  `preset-hash-goldens.spec.ts` holds them).
- Not upgraded on purpose: TypeScript 7 (no JS API for typescript-eslint/ts-jest/Nx), ESLint 10, Babel 8,
  `@types/node` 26 (Node 24 of `.nvmrc`), webpack-dev-server 6.

## Commands

Dev and build:

- `npm start` — `netlify dev --filter chisper` (functions, :8888) + Nx dev server (:4200, proxies `/.netlify/*`,
  `/api/*` and `/files/*`). Needs `npm run certs` once (mkcert into `.certs/`; `mkcert -install` trusts the CA).
- `npm run client:start` — frontend only (lists of tables/noises and presets fail).
- `npm run build` — production build into `dist/apps/chisper` (wasm, minified worklets, the source maps of the
  bundles to PostHog in Netlify's production and removed everywhere: `scripts/analytics/sourcemaps.mjs`, then the
  site merged in and the lastmods of the sitemap dated against the live site: needs the network).
- `npm run build:perf` — build with the test hook `window.__chisperPerf` into `dist/apps/chisper-perf`.
- `npm run wasm` — the Rust core → `tmp/wasm/` (prod) and `tmp/wasm-perf/` (cargo feature `perf`, used by specs and
  `build:perf`); a `.wasm` there that is no core any more is removed. Flags: `--only=prod|perf`, `--watch`,
  `--sizes`, `--check-sizes`.
- `npm run worklets` — esbuild bundles of the worklet module (`engine`, wasm inlined) and the classic workers into
  `tmp/worklets/` (served as `assets/worklets/`).
- `npx nx dev site` (:4321), `npx nx run site:verify` (build + HTML checks).

Checks:

- `npx nx test <project>` — `chisper`, `math`, `rxjs-react`, `ui-kit`, `preset-schema`, `netlify`. One file:
  `npx nx test rxjs-react rx-model.spec.tsx` (a Jest pattern; `--testFile` is ignored). Run from the root.
- The `chisper` specs load `tmp/wasm-perf/engine.wasm`: run `npm run wasm` after any change in `dsp/` (the bytes are an
  Nx input, so the cache follows).
- `UPDATE_GOLDENS=1 npx nx test chisper <module>-goldens.spec.ts` — re-record golden hashes
  (`dsp/goldens/<module>.json`). A change of sound is always an explicit golden update.
- `npx nx lint <project>`, `npm run typecheck`, `npm run prettier:check` / `prettier:fix`, `npm run knip`,
  `npm run test:scripts` (`node --test` over `scripts/**/*.test.mjs`).
- `npm run dsp:check` — `cargo fmt --check`, `cargo clippy --all-targets -D warnings`, `cargo test`, size budgets.
- `npm run precheck` — everything CI (`.github/workflows/ci.yml`) runs. `nightly.yml` runs fuzzers × 250
  (`FUZZ_SCALE`) and jsmath against Node.

Manual benches and stands (Playwright isn't a dependency: `npx -y -p playwright@1.50.1 node <script>`):

- `scripts/bench-perf/run.mjs [--against=<ref>] [--only=…]` — perf suite (`scripts/bench-perf/README.md`).
  Regressions are judged only in an A/B run with `--against` (sessions differ by ~10%).
- `scripts/bench-osc/run.mjs` — the oscillator vs a native `OscillatorNode` (README in its folder).
- `scripts/wasm-browsers/run.mjs` — bit parity of the wasm core in browsers vs Node (the chain alone on an input, the
  voices apart, the whole node); `app.mjs` — the app in each browser (sound, no glitches, no paints over the LFOs).
- `node scripts/null-test/run.mjs --against=<ref> [--only=…] [--limit=<dB>]` — the scenes of the browser parity
  rendered by the cores of the tree and of `<ref>`, their difference in dB under the signal (a half of the engine
  against the core `<ref>` has it in, `chain.wasm` or `wavetable-osc.wasm` before the engine; a scene of a core
  `<ref>` has not, the chain: against the scene of that name as `<ref>` renders it, ours without the limiter).
- `node scripts/renders/run.mjs` — renders of the reference Audio Unit (macOS, `.env` `RENDERS_*`) into
  `dsp/measurements/*.json`, which the specs compare the engine with. An effect of its rack goes into its state
  (`state.mjs`), a signal of ours through it as a one-shot sample of its noise oscillator; renders of different
  samples never run at once (a block renders one sample after another, never back to one: a host has played the
  sample before it, twice alike) and each is rendered until two in a row agree (now and then one is of another
  state). An effect sleeps in a silence: a signal that reads its LFO keeps a quiet tone under it.
- `scripts/delay-native/run.mjs` — the delay of the native nodes the app played before the chain core, rendered in
  Chromium into `dsp/measurements/delay.json` (the reference `delay-measured.spec.ts` holds the core to).
- `node scripts/noises/process.mjs` / `add.mjs` — noise samples from `assets/noises/manifest.json` into
  `tmp/noises/`. `upload.mjs` writes to the production bucket: dry run unless `--apply`, only when the user asks.

Env vars: `.env.example` (R2 buckets of tables and noises, `DATABASE_URL`, Turnstile, score thresholds, the
analytics: `NX_PUBLIC_ANALYTICS_KEY`, `NX_PUBLIC_RELEASE` from `COMMIT_REF` by `webpack.config.js`, the secrets of the
source maps `POSTHOG_CLI_API_KEY`/`POSTHOG_CLI_PROJECT_ID`). The client gets only `NX_PUBLIC_*` vars (inlined at build
time).

## Rules that are easy to break

- **Deterministic DSP.** A core gives the same bits in every browser and in Node (`scripts/wasm-browsers/run.mjs`),
  so: no `mul_add`, no fast-math, no relaxed-simd, wasm-opt never with fast-math. The hot loops run in f32 lanes
  with their sums in an order of their own (`F32x4`/`U32x4` of `dsp-core/src/simd.rs`: FIRs of `fir.rs`, the
  rational `tanh4`, the lines of the reverb, the fixed-point phases of the oscillators, the filters of two voices,
  the bands and the detectors of the compressor, its `log2`/`exp2` of bits and polynomials: `compressor/src/math.rs`,
  the taps of the chorus); the native variant of a
  lane type does the same operations in the same order (cargo tests compute the bits of the wasm). Math per block
  goes through `dsp/jsmath` (`dsp/clippy.toml` disallows `f64::sin`, `exp`, `powf`, `max`, `min`, `mul_add`…).
  What stays in doubles and why: recursive filters at low frequencies (DC blocker, lowcut; the filter of a voice
  is a state variable filter, which holds a low cutoff in f32), the gain path of the limiter, the delays of the
  reverb lines, the filter of the chorus and the delays of its taps, the bandpass and the times of the delay, the
  bands of the EQ (state variable filters, both channels in lanes of doubles), the phase a voice keeps between spans
  (a whole number of 2^-52 of a cycle). A pass that reorders
  a loop (the chunks of the reverb, the voices filtered in pairs, the segments of the delay, the blocks a silent
  chain skips) gives the bits of the plain order: its cargo test holds it to them. A state in f32 that decays is flushed to 0 when written (`F32x4::flush`: wasm has no
  flush-to-zero); a state in doubles that a channel silent alone leaves to decay while the other plays (the bands of
  the EQ, the bandpass of the delay) under `TINY_F64` at the end of a segment (`F64x2::flush`); a sample in doubles
  that goes out as f32 under `TINY` (`F64x2::flush_under`: the out of the EQ). Nothing is worked out of a denormal: the audio thread of Chromium and Firefox takes them as 0, Node
  and WebKit don't (the mean square of a band of the compressor and its peak held are flushed at every sample; its cargo
  tests run the tail with the CPU flushing them). Any change of the bits is an explicit golden update, checked by the quality specs with their
  tolerances as they are and by `node scripts/null-test/run.mjs --against=<ref>` (the difference from a commit, dB
  under the signal). Goldens specs import `test-utils/js-math.ts` first.
- **`__PERF__`** (`src/globals.d.ts`) gates instrumentation: true only in the `perf` build and in specs. Any script
  that bundles app code with esbuild must `--define` it (an unset `NX_*` env var isn't a dead branch).
- **Worklet modules** must not import `@chisper/ui-kit`, `@chisper/preset-schema` (zod) or anything touching
  `window`/`document`. In hot JS loops don't chain per-sample calls returning doubles through closures or
  polymorphic sites (V8 boxes them): run each stage over the block in typed arrays.
- **Cores never allocate in a block**, only in constructors or when a buffer grows. Every core call restores the
  exported `__stack_pointer` (a trap leaves it moved; `instantiateCore` wraps the exports).
- **Anything that moves every frame draws on a canvas**, never in the DOM (a changing svg `d` or a moved element
  repaints/relayouts the page in Chrome; `scripts/wasm-browsers/app.mjs` checks it).
- **Persisted state**: extend the model's `modelToSnap`/`applySnap` **and** `presetDataSchema` in
  `libs/preset-schema` (unknown keys are stripped silently). `applySnap` must handle falsy values (`!== undefined`)
  and missing keys mean defaults. A new field changes every preset hash: DB presets get it by
  `scripts/presets/rehash.mjs --apply` on production before the deploy, not legacy code, then `netlify api purgeCache`
  after it (the CDN holds the presets of before).
- **Append-only indexes**: `TEMPO_DIVISIONS`, `DISTORTION_MODES` (raise `FX_PARAMS.distortion.mode.max`), `EQ_TYPES`
  (raise `FX_PARAMS.eq.t1/t2.max`; `type_of` of `eq.rs`), the kinds of the chain (`FX_TYPES`, `FX_KINDS`, `units.rs`:
  a new effect goes last), the knob ids of `targets.rs` / `VOICE_MODULES` (a new module goes last;
  `voice-modules.spec` holds them).
- **Analytics** (`common/services/analytics.ts`: PostHog Cloud EU, its slim SDK bundled, through `ANALYTICS_PATH`
  rewritten by `netlify.toml`): `feature_used` only from what a user does (a handler of the UI or an action it calls,
  never a state set by `applySnap`, a preset, an undo or a restore: `analytics-features.spec`); a failure the user
  sees goes through `captureError` (a fingerprint of its own where its cause is of a closed list; a query names its
  load in `meta.load`: `app/query-client.ts` reports it once, after its retries, and so an answer of the API of a
  query: `queryGet` of `presets/services/api.ts`); `session_end` at every hide of the page, what came since the one
  before (a session's numbers are sums); nothing a user writes is sent (names of presets and files, searches, the
  messages of the API), nor where a link came from (`before_send` keeps of the URL its path, `preset` and `clip`, of
  the referrer its domain). Main thread only: a worklet module or a worker never imports it (a node tells what
  failed in its report: `EngineFaultReport`). Off without its key, in the perf build and the specs, out of
  production, on `*.netlify.app` and localhost.
- **Netlify**: function specs live in `netlify/tests/`, never in `netlify/functions/` (every file there is
  deployed). Functions import `libs/preset-schema` by relative path (esbuild doesn't know the tsconfig aliases).
  Netlify doesn't typecheck functions: `npm run typecheck` does. `GET /api/presets/:id` is kept a day (and a minute
  stale) by the CDN under the tags `preset-<id>`/`clip-<id>` (`utils/cdn-cache.ts`): a new write that changes or
  deletes that answer purges its tag (`context.waitUntil(purgeTags(…))`, a scheduled function awaits it); presets
  changed by hand in the DB need `netlify api purgeCache`.

## Specs

- App specs run on `standardized-audio-context-mock`. `test-setup.ts` adds an `AudioWorkletNode` stub (no
  AudioParams), a `Worker` stub (`test-utils/worker-stub.ts`) and a recording 2D canvas context
  (`installCanvasStub`: `drawn(canvas)`, `svgPath`). There's no global MessageChannel: `createSynthCore`
  (test-utils) gives the engine a stub channel; providers rendered without it see the engine `unsupported`.
- Voices are read from the events posted to the engine node: `voiceEvents(audioCtx, wavetables)`
  (`test-utils/voice-events.ts`), `wavetables.flush()` sends a task's events, `end(voice)`/`started(voice, …)`;
  what its chain is told: `chainPosts(chainNode(audioCtx))` (`test-utils/chain-node.ts`, the same node).
  `offline-engine.ts` renders the whole node on the real core (the voices through the chain; `limited: false`:
  without the limiter and its latency).
- antd under test gives every component the id `test-id`: the setup mocks its `useId` (`test-utils/rc-use-id.ts`).
  `ResizeObserver` is stubbed.
- Count `addModule` calls with `workletLoads` (the synth core adds `engine` itself, once).
- Presets specs without the synth pass `immediateSoundSwitch` of test-utils.
- What the app reports: `recordAnalytics()` (`test-utils/analytics.ts`: its events, its errors, `features()`); the
  SDK is mapped to `test-utils/posthog-mock.ts` (`analytics-sdk.spec` loads the real one by its file).
- Server specs: the DB is the fake `sql` tag of `netlify/tests/fake-sql.ts` (records queries, answers by regex).
- DSP specs: `<module>-dsp.spec.ts` (the core through its facade), `<module>-goldens.spec.ts` (golden scenarios and
  fuzzing, `test-utils/fuzz-signals.ts`; `engine-goldens`: the whole node); the crates have `cargo test` (lanes run
  as arrays off wasm).
- New features need good coverage (actions, audio wiring, snapshot round-trip incl. falsy values and defaults,
  schema, non-trivial UI): follow `filter.spec.ts`, `fx.spec.ts`.

## Architecture

### State: `rxModel` (libs/rxjs-react)

All app state and audio logic live in RxJS models, not React state:

```ts
const model = (deps) =>
  rxModel((initial) => ({ $foo: new PrimitiveBS(0), audioNode, ... }))  // BehaviorSubjects + Web Audio nodes
    .actions((model) => ({ setFoo: (v) => model.$foo.next(v) }))
    .subscriptions((model, actions) => [ ...rx subscriptions wiring state to audio... ])
    .plugins(urlSnapshotPlugin({ modelToSnap, applySnap }))
    .destroy((model) => { ... });

export const { ModelProvider: FooProvider, useModel: useFoo } = rxModelReact('fooModel', model);
```

- Builder calls return new immutable factories; `init` runs actions, subscriptions and plugin `onInit`; unmount runs
  `destroy`, unsubscribes and plugin `onStop`.
- `<FooProvider initial={...} {...deps}>` takes deps as other models' `[model, actions]` tuples; `useFoo()` returns
  `[model, actions]`. Components read observables with `useBehaviorSubject($x)` / `useObservable`. Helpers:
  `PrimitiveBS`, `ArrayBS`, `ObjectBS`; observables are `$`-prefixed.
- Provider order is dependency order (`apps/chisper/src/app/synth/index.tsx`): InputController → SynthCore →
  Transport → Envelopes → Lfo → Modulation → Oscillator1/2 → Noise → Sub → MidiController → Filter → Synth → Fx →
  SoundSwitch → Track → KeyboardController → Presets.

### Audio graph (`synth/common/modules`)

- `synth-core.ts` owns the single `AudioContext` and the one worklet node of the sound (`synth/common/engine/`,
  core `dsp/engine`): `[the engine node: voices → fx slots → mute · master gain → limiter] → output → destination`.
  Every note plays in it (the filter is inside each voice) and everything after the notes too: the voices sum
  straight into the input of the chain inside the core, a block is one call of the core and only the output crosses
  to JS. Header analysers tap the output after the limiter and sleep when nothing sounds.
- The engine node (`engine-node.ts` on the main thread, `engine.worklet.ts` a thin wrapper of `engine-wasm.ts`, the
  facade a render on the main thread drives the same way): it loads the module `engine`, makes the node of what its
  clients are (the chain: its state; the wavetable engine: the worker of the store, the bend), tells them its status,
  what the node posts and when it is gone, and sends the LFOs once for the voices and the chain (the LFO model alone
  tells them, `lfos.take`; a half only says that it reads one, `lfos.use`: sent only while one of them does, a state
  only to the halves that do: `readers`). `engine-messages.ts` is a node whoever runs it (the worklet, a render on the
  main thread, the parity in Node): the engine of its options (`createNodeEngine`), what a message tells it
  (`takeEngineMessage`; `stop` and `probe` are the node's), its meters (`createEngineMeters`). `engine_process` tells what there is to read after a block (voices that started or ended,
  stages that failed, bytes the store freed): a block with nothing to tell is one call. A trap is of the half it
  was in (`engine_fail`/`engine_resume`): a voice ends alone, an effect is dropped, a trap of the voices in no voice
  is a block without them (`MAX_SILENCED` such blocks in a row end the node as `broken` does), one of the chain in no stage ends the node (`broken`: both are 'failed', a retry makes a
  node of the state, `MAX_REMAKES` times at most). Options of the processor for the parity and the benches: `tap`
  (each voice apart, before the chain), `fed` (the chain alone on the input of the node), `unlimited`, `events`, `seed` (what a note draws at random:
  two renders alike); in
  the perf build a second output has the voices as the chain takes them while a probe listens (`tapVoices`).
- The chain (`synth/common/chain/`, core `dsp/chain`, a half of the engine): the effects, the master gain and the
  limiter. `chain.ts` (main thread) keeps its whole state and tells the node in messages only, no AudioParam
  (`ChainMessage` of `chain-params.ts`; an event may carry its time `at`, the node is made with the state in
  `processorOptions`); `chain-wasm.ts` is its facade (`takeChainMessage` of `engine-messages.ts`: a message as the
  worklet and a render take it). In the core (`chain.rs`): events queued by frame (one without a time is never
  taken before one with a time sent before it), a slot per effect in the order
  (`Law`: equal power, linear for the distortion and the EQ, inside for the chorus and the compressor; the dry signal late by
  the latency of the effect; gains glide 10 ms; a slot that is off is a wire and its effect forgotten once faded;
  a slot whose effect is late crosses between its input as it is and the late one as it starts and stops; one that
  sounds and leaves the order fades out where it is, the new order waits for it), the mute (with a time: its fade
  ends that long after it, however late the message comes) and the master gain, the limiter (`chain_new` without it for a render at another rate). A silent chain
  skips its slots (`Unit::rest`: the bits of rendering them). A trap inside an effect (its block, a knob, a rest, its sound forgotten: every call of a unit)
  drops that effect alone (`work` in memory before the call, `chain_fail`/`chain_resume` from the `step` the block
  was at, an event that trapped taken again without the unit; the limiter: the master silent) and is told back
  (`status(stage)` 'failed'; `retryStage`: 'loading' until the node tells the unit is made, `remade`, or failed
  again); a trap that is in no stage ends the node (`broken`). What trapped is never freed: a stage, and a node
  after `broken`, is made again `MAX_REMAKES` times at most. The numbers of the ABI the wrapper has of its own (`chain-params.ts`)
  are held to the core by `chain-layout.spec.ts` (`chain_layout`/`chain_key` of the perf build: a new param is
  named in `key_names` of `units.rs` too). Until the module is ready the master is silent (no fallback); a failure
  shows a toast with Retry (`retryAudio`). `unit_*` of the same core is one effect alone (the specs, the benches).
- Latency (`synth/common/latency/`): `latencyHint` is chosen at context creation (a change reloads the page); only
  desktop Chromium honours it. Modes auto/low/normal (localStorage `latencyMode`); auto falls back to normal after
  dropouts (`playbackStats.underrunEvents`).
- Master limiter (core `dsp/limiter`, the last stage of the chain): stereo true-peak brickwall at −0.5 dBTP.
- FX (`synth/fx/`): effects are defined in `FX_REGISTRY` (`fx/effects/`) with params/ranges from `FX_PARAMS` of
  `libs/preset-schema`; a definition gives its params as the core takes them (`core()`: a knob in BPM at the tempo,
  the era of the reverb as the values of its stage; `CHAIN_KEYS` of `chain-params.ts` is their order in the crate).
  `createFxSlot` is what the fx model tells the chain of an effect (params, mix, whether it plays). Default order
  `FX_TYPES` (distortion, chorus, delay, compressor, reverb, eq), `FX_KINDS` of `chain-params.ts` mirrors it (it can't
  import the schema). A new effect type = a registry entry + its preset schema + a `Unit` of `dsp/chain/src/units.rs`
  (no crate, bundle, facade or processor of its own), its kind last (`LIMITER` = `SLOTS` after it; a chain of
  another count of kinds is another ABI: the null test renders the scenes of the chain of a reference with its own
  facades). Reverb (16-line FDN), distortion (4× oversampled in two stages, the hard clip antialiased on top:
  `scripts/distortion-adaa/` holds the measurements and the tables), chorus, compressor, delay and EQ are units of
  the chain core.
- Delay (`dsp/chain/src/delay.rs`, held to renders of the native nodes it replaced: `scripts/delay-native/`,
  `dsp/measurements/delay.json`, `delay-measured.spec.ts`): a line a channel read as a `DelayNode` reads it (linear,
  times in f32), a bandpass in the form of a `BiquadFilterNode` inside the feedback (its coefficients once a block),
  normal or ping-pong, Pan a channel of the echoes late; Time glides through a pole of 100 ms a sample (a tape),
  poles snap as Chromium's `setTargetAtTime` does. Deliberate copy of that graph: what a line feeds back comes a
  quantum late with the gain of then (`LOOP_LATE`: an echo is Time + 128 samples after the one before; of ping-pong
  only left → right), the sound the presets were made with.
- Compressor (`dsp/compressor`, measured: `dsp/measurements/compressor.json`, `compressor-measured.spec.ts`): one
  band (the louder channel at every sample against the threshold, the reduction smoothed in dB) or three (LR4
  crossovers on state variable filters, the mean square of each band held and released, compressed down and up,
  the gains every `SPAN` samples). It mixes inside (`Law::Inside`: the slot passes the effect alone and gives it
  the mix as a param, its routes with the others; the level is of the compressed signal alone) and its meter is
  posted only while watched (`Unit::meter`, `chain.watch`); its knobs keep the laws of the Audio
  Unit (`thresh`, `gain`, `level` are knob positions, `compressor-params.ts` has their laws). Not done: its limiter
  at the top of the ratio.
- Chorus (`dsp/chorus`, measured: `dsp/measurements/chorus.json`, `chorus-measured.spec.ts`): four taps, two a
  channel, each a line of its own fed back into itself, moved by one triangle LFO (the taps of a channel half a cycle
  apart, the channels a quarter) through a pole of 20 ms; a state variable filter of two passes a sample after them,
  outside the feedback; the level of the wet signal alone, the mix inside by its own law (`Law::Inside`). In BPM a
  cycle of the LFO is a division (`chorusDivisions`): the main thread gives the core its Hz. A read of a group of four samples is `Rows::read4_line` (the shares of its samples in f32 from the
  first: not the bits of `read4`), a sample alone its lane of that four: how a block is cut changes no sample.
  Deliberate differences: its level is not of the dry signal, its LFO never stops in a silence, a tap keeps the
  highs the one of the Audio Unit loses over 12 kHz, its phase is not kept in a preset. Its screen
  (`chorus-screen.tsx`) draws the taps and drags their delays and the depth: the core tells its LFO and the knobs of
  the taps as it has them (its meter, posted as the one of the compressor is, only while watched:
  `meter-report.ts` in the worklet, `createFxMeter` on the main thread), between two posts the main thread moves
  the LFO on at its rate (`chorusTaps` of `chorus-params.ts` mirrors `targets` of the core).
- EQ (`dsp/chain/src/eq.rs`, measured: `dsp/measurements/eq.json`, `eq-measured.spec.ts`; the laws found by
  `scripts/eq-fit/fit.mjs`): the one of the Audio Unit, two bands of the Audio EQ Cookbook (band 1 a low shelf, a peak
  or a highpass, band 2 a high shelf, a peak or a lowpass) as state variable filters in lanes of doubles. Its design
  is `eqDesign` of `libs/math/src/filter/eq.ts` too, the same operations (`eq-design.spec` holds them bit for bit
  through `chain_eq_design` of the perf build; the screen draws it). The frequency, resonance and gain are lines of the
  routes (the frequency in octaves: in Hz a jump of the knob took the band under 0 Hz): a band moving is designed every
  32 samples, its coefficients lines between; a band that renders nothing (a shelf or a peak at 0 dB, the gain of a
  pass) is not rendered. Its screen (`eq-screen.tsx`) draws on a canvas (`useLiveDraw`). Deliberate differences: its
  Mix (the reference has none), its knobs glide.
- Without AudioWorklet or wasm SIMD, or when the module of the engine fails, no effect and no sound; until `ready`
  nothing plays. One effect failing in the core leaves the others playing.
- Knob modulation of the effects is in the core (`dsp/chain/src/modulation.rs`; the envelopes and the LFOs of the
  last note, `dsp-core/src/{envelope,lfo}.rs` as the voices run them, worked out once for the chain and only while
  a route moves a knob of an effect that plays): a knob of a unit one value a block, the knobs of the delay, the
  frequencies, resonances and gains of the EQ and the mix of a slot as lines, an offset a sample added to the knob as
  it glides (of a frequency of the EQ in octaves). The fx model sends the routes of the
  effects that play as targets of the core (`chainRoutes`), the note and the LFO states only while a route reads
  them; `fx-modulation.ts` keeps the same sums on the main thread for the marks of the knobs and the charts.

### Oscillators and voices (`synth/common/wavetable`, `dsp/wavetable-osc`)

- No native fallback: without AudioWorklet, Worker, MessageChannel or wasm SIMD the synth doesn't play and says why
  (`OscillatorStatus`).
- `wavetable-engine.ts` (one per context, in the engine node): `$status`, `retry`; a worker (`wavetable.worker.ts` →
  `wavetable-builder.ts`, builds mip levels, `wavetable-mipmap.ts`) and a MessageChannel between the worker and the
  store of the node (the store is the worklet module's: it outlives a node). An error of the worker fails the node. Tables arrive in chunks; each version is
  `sending`/`stored`/`refused`/`failed` in `$tables`; versions only grow.
- `createVoice(options, values)` gives a `VoiceHandle` whose params mimic AudioParam calls; each call is an event
  of the engine node, a task's events go in one message (by a microtask). The node reports `started`/`ended`.
  A trap in a voice (as it renders or as its filter finishes its block; those filtered together all end)
  ends only that voice.
- The core (`dsp/wavetable-osc/src`): `scope.rs` (the voices of a node, filtered in pairs; up to four wide ones,
  `interleaves` of `filter.rs`, two pairs in one loop), `voice.rs`, `source.rs` (oscillators, noise and sub as
  slots of the trait `Source`, summed in that order), `timeline.rs` (AudioParam semantics),
  `envelope.rs`, `lfo.rs`, `modulation.rs` (routes), `filter.rs`, `velocity.rs`, `noise.rs`, `sub.rs`, `store.rs`,
  `shared.rs` (phrases, LFOs, the phase of the last sub for Contiguous), `targets.rs` (knob ids). Options/messages:
  `voice-options.ts`, params: `wavetable-osc-params.ts`.
- The sub (`sub.rs`): one voice, its own loop (the levels read as an oscillator reads them, `render11`/
  `render21_same` of `voice.rs`, kept out of `Voice::process`: `NO_INLINE` of `scripts/wasm.mjs`). Its shapes are
  tables of one frame `sub:<shape>` (`sub-shapes.ts`: measured spectra), the Sine is the sine of the store.
- Behaviour checked against the reference AU measurements (`dsp/measurements/`: unison, blend, spread, phases,
  frames, frame fades, envelopes, aliasing, noise, sub, filter types; `compressor`, `chorus` and `eq` for the
  effects).
  Aliasing −70 dB, spurs −80 dB.
- The filter of a voice (`filter.rs`): the types of a BiquadFilterNode (a TPT SVF, bit for bit as before) and the
  model types of the AU (`dsp-core/src/filter_model.rs`, measured: `filter-types.json`, `filter-types-measured.spec.ts`;
  the resonance by the cutoff: `filter-resonance.json`, `filter-resonance-measured.spec.ts`):
  analog prototypes whose feedback comes late, realized in matched sections (TPT SVF, one-pole, a droop FIR), Drive
  (the curve before them, ADAA1, only while Drive is over 0) and Var (FAT, the knob Comp: a gain of 1 + 4·Res·FAT
  into the sections, none of a one-pole or a notch: the reference's Var changes no bit of its Notch; DB +/- of the
  reference, the knob Gain of an EQ type; labels and units: `filterKnobLooks`). The
  resonance of the types of Normal saturates in the core only (the damping of the first section, and of the second of
  a 24 dB one, by the level of the sample before, worked out again every 4 samples of
  a block, left out under Res 40 % without Drive and FAT: under 0.3 dB there; a ladder clips at its output: measured
  by the `fat` rows, held by the cargo test `saturation`); the chart draws the small signal of the sections, filled to
  0 dB, Drive at a sine of full scale (`driveLevel` of math, its `UT` that of the core). Their design
  is the same code in `libs/math/src/filter/model.ts` (the chart; jsmath: the same bits, so no `Math.hypot`): change
  both (`filter-model.spec` holds them bit for bit, the core's through `osc_model_design` of the perf build). Nearly
  without resonance (Res under 1 %: a damping over `K_CUSP`) the poles of the prototype are real: its two roots on
  the real axis, then the first and the place the second met the root of the delay (`window_poles`, `met_poles` of
  `svf_poles`); with resonance they are its pair at every cutoff, also where its one real root has come nearer at
  the top (`pair_poles`: Halley from a start of its own, Newton from the start of the Taylor goes to the real root
  there; the second sections too). Never a root Newton happened to settle on: the design is continuous along the
  cutoff at every Res, the cargo test `the_design_is_continuous_along_the_cutoff` holds it, a jump there was a click
  a span. Deliberate: a step along Res at 1 %, at the top of the cutoff (the two rules meet at the cusp). A design of a span costs some sines (the poles of the delayed prototype by Halley's steps): the voices of a
  node share the last 4 (`Designs` of `filter.rs`, a pure function of the type and knobs: one LFO on the cutoff of
  all designs once a span). A cutoff that moves alone, a cell a span at most, takes the coefficients between the
  designs at the edges of its cell (`cutoff_cell` of `filter_model.rs`: 16 an octave, kept by the node); a cell the
  design isn't smooth across (`Coefs::near`, Res 100 % mostly) takes designs. The coefficients of a
  span whose knobs moved go to those of its knobs as a line from where the span before left them, never at once (held
  a span each they were a stair of `SEGMENT` samples: a noise over the note under a moving cutoff): a step every
  `REFRESH` samples of a model type (`LaneCoefs::steer`/`advance`, `take_spans` of `filter.rs`), every sample of a
  type of a BiquadFilterNode; the filter is a span behind its knobs. No line: the first span of a note, a cutoff that
  went over `JUMP` times in a span. A saturating section goes along its g, k0, a, l, the products of its saturation
  the same function of them at every refresh as in a design (`sat_products`: a line of the products went under 0 of
  damping where the cutoff and Res jump together, a burst; the cargo test
  `a_jump_of_the_cutoff_and_the_resonance_together_is_no_burst`). A short span at the end of a pass is the end of the
  one before (`span_end`: in its few refreshes, or none, it went the way of a whole span at once). A voice on a line
  next to another, or alone: the same bits (the cargo test
  `the_lines_of_voices_in_the_lanes_are_those_of_each_alone`); `moves the cutoff of … without a noise` of
  `wavetable-osc-dsp.spec.ts` holds the noise. The loops of a voice alone stay functions of their own (`NO_INLINE` of
  `scripts/wasm.mjs`: inlined next to the design of a span they are a third slower); so do those of voices at rest
  (`still_pair`, `still_group`: in the loops of the lines their coefficients went through memory, a chord 3 % slower;
  `scope chord filter …` of the perf suite). The type lists
  (`FILTER_TYPES` of the schema, `VOICE_FILTER_TYPES` of `voice-options.ts`, `MODEL_FILTER_TYPES` of math) only grow,
  a spec holds them alike; Drive and Var are the knobs of `FILTER_EXTRA` (appended to `targets.rs`). Two voices of
  one layout of sections share the lanes, others each alone; a change of type on a note into or out of a model type
  crossfades 10 ms (a filter that never played: no fade).
- The worklet module prewarms its core on load (lazy wasm compilation would hit the first note): the chain alone,
  then the voices in an engine of their own (`voices-prewarm.ts`: the block the node calls is the one compiled).

### Synth, input, transport (`synth/common/modules`, `synth/common/*`)

- `oscillator.ts` — the table (`$waveTable`, morph tables expand to 256 frames), position, pitch (oct/semi/fine),
  unison, phases, gain; sends its table to the engine.
- `noise.ts` (+ `synth/noise/`) — a sample player in every voice; samples from the noise bucket.
- `sub.ts` (+ `synth/sub/`, left of OSC 1) — the sub oscillator in every voice; sends the table of a shape the first
  time it is on.
- `synth.ts` + `synth/voicing/` — voices per note: poly with stealing (a released voice at 0, a held one down at a
  sustain of 0, the quietest released, the oldest held; out of legato the stolen voice takes the new note, its
  phases go on, else it fades out; so does one whose ENV 1 rises in under `MIN_TAKE_ATTACK` at its steepest
  (`attackRise`: the curve counts), in mono too: its amplitude would jump under its filter, a click,
  `steal-clicks.spec.ts`; that note is a new voice, in mono gliding on from where the one before is, its phases,
  filter, LFOs and ENV 2/3 from their starts; under a note that starts its envelopes so the stolen voice fades over
  a share of `KILL_FADE` by the level it has or rises to, `stealFade`: the gate says it, a voice more for 20 ms at
  every note was the cost), legato, portamento (`glide.ts`), mono
  (Poly 1: one voice, a stack of held keys; a note takes it over while it sounds, its core keeps it `RELEASE_LEAD`
  after its release so the takeover never comes late), velocity, pitch bend (one `bend` event for the whole node).
  Playing notes follow most knobs; unison, phases and envelopes apply to new notes.
- `sound-switch.ts` — a preset switch fades the output, waits for voices to end, applies the preset, clears FX tails
  and the limiter, then unmutes; held keys restart on the new preset.
- `envelopes.ts` (ENV 1–3, velocity curve; curves shared via `envelope/envelope-curve.ts`), `lfos.ts` (LFO 1–4,
  shapes as 2048-point tables, `lfo/lfo-curve.ts` shared by main thread, worklets and specs, mirrored in `lfo.rs`),
  `modulation.ts` (routes `<source>:<knob>`, targets in `modulation-targets.ts`, at most 64 routes and 4 per knob).
- `transport.ts` — tempo and beats on the context clock; MIDI Clock can lead it (`transport/midi-clock.ts`).
  Tempo divisions are in `libs/preset-schema/src/tempo.ts`; seconds of divisions are worked out on the main thread.
- `input-controller.ts` — the shared note bus (`$onPress`, `$onRelease`, `$bend`); sources: on-screen piano,
  QWERTY (`keyboard-controller.ts`), MIDI (`midi-controller.ts`), the track, the roll keys. Each source holds its
  own notes.
- Track (`synth/track/`, `modules/track.ts`): one looped clip (`libs/preset-schema/src/clip.ts`, 960 PPQ) played
  into the synth by a worker clock (`track-clock.worker.ts`) 50 ms ahead; piano roll, REC, undo
  (`track-history.ts`), pure edits in `track-edit.ts`, .mid import/export in `midi-file.ts`.

### Rust cores (`dsp/`)

- One cdylib with a C ABI (no wasm-bindgen, no SharedArrayBuffer): `engine`, whose rlibs are `wavetable-osc` (the
  voices and the store, `osc_*`) and `chain` (`chain_*`, `unit_*`; the effects `limiter`, `reverb`, `distortion`,
  `compressor`, `chorus` are its rlibs, the delay, the EQ, the slots and the modulation its modules); `engine_*` is the block
  of both. Shared crates `dsp-core` (biquads, the oversampling chain, true peak, delay blocks, lanes, the envelopes
  and the LFOs), `jsmath`, `wasm-rt` (no_std on wasm32, panic traps, dlmalloc). Toolchain pinned in
  `dsp/rust-toolchain.toml`, `+simd128`, 64 KiB stack, `panic = "abort"`, fat LTO.
- The bundle `engine.worklet.ts` registers the one processor; the facades wrap the halves of the core
  (`wavetable-osc-wasm.ts`, `chain-wasm.ts`, `engine-wasm.ts`; `fx/effects/<effect>-wasm.ts`: an effect as a unit,
  for the specs and the benches). A new bundle is also named in `WASM_MODULES` (`wasm-support.ts`), `CORES` of
  `scripts/wasm.mjs`, the `worklets` script of `package.json`, the scenes of `scripts/wasm-browsers/scenes.mjs`.
  Specs load the perf build of the core with `wasmCore('engine')` (`test-utils/wasm.ts`; the bundle's import of
  `@chisper/wasm/engine.wasm` through `apps/chisper/wasm-babel-plugin.js`).
- NaN/±Inf input is taken as 0 by the effects, the decoded files and the worker.

### Snapshots

`apps/chisper/src/app/app/plugins/snapshot.ts` creates one `searchParamsSnapshotPlugin`; models `osc1`, `osc2`,
`noise`, `sub`, `filter`, `env`, `mod`, `fx`, `lfo` and the synth as `v` expose `{ [modelName]: { key: value } }`.
`getSnapshot()` / `applySnapshot(obj)` are used by presets; legacy URL params `<modelName>-<key>=<json>` are still
applied on init. Short keys and their ranges are in the schema (`libs/preset-schema`); legacy-only keys (e.g. `r` of
an oscillator) are read, never written.

### Presets and server (`apps/chisper/src/app/presets`, `netlify/functions`)

- `libs/preset-schema`: zod schema with ranges and defaults, `normalizePreset` (4 significant digits, sorted keys),
  `presetHash` (sha256 of normalized JSON without the name → dedup), profanity filter.
- API: `presets.mts` (`/api/presets` list/search/save with Turnstile, `/top`, `/:id` GET/PUT with edit token,
  `/report`, `/opened`, `/name-available`), `usage.mts` (listens and stays), `clips.mts` (track clips). Edit tokens
  are returned once, stored as sha256, kept by the client in localStorage. IPs only as salted hashes. Names unique
  case-insensitively.
- Scheduled: `recompute-scores.mts` (every 30 min: score = share of listeners who stayed, with a Bayesian prior),
  `cleanup.mts` (daily).
- Client: the `presets` model (current preset, dirty flag by hash, `?preset=<id>`, applied through the sound
  switch); a start without `?preset=` opens a random popular preset as `auto`; sessionStorage keeps an edited state.
- Loading shows: a preset opening shows its name at once (`$opening`) over a bar (`$loadProgress`: its request,
  then `$progress` of the sound switch — the fade, then the downloads of its tables/noise and their store,
  `load-share.ts`); the table and noise selectors show their own loads. Both draw `LoadProgress` (ui-kit, a canvas).
- A preset may name the clip it opens with (`presets.clip_id`, a checkbox of the Save dialog saves the clip of the
  track first if needed; GET returns the clip). The track opens it (`openPresetClip`) only over no notes or an
  unchanged clip a preset opened, never over a clip of the user or a `?clip=` link; cleanup keeps such clips.
- What a preset is lives in columns of `presets`, never in its data (the hash and the sound stay; no rehash):
  `category`/`subcategory`/`tags` (closed lists of `taxonomy.ts` in `libs/preset-schema`, slugs only grow; a
  subcategory is of its category, 3 tags at most), `description` (plain text, 280, no links, `isProfane`),
  `features` (Mono, Glide, Tempo-sync worked out of the data by `presetFeatures` as a preset is saved; With clip and
  AI of `clip_id`/`ai_generated`; `PRESET_FEATURES` is the order of the icons of a row), `factory` (the presets of
  the synth: cleanup keeps them) and `ai_generated` — the last two set by `scripts/presets/flags.mjs` alone (the API
  can't: new ported presets are saved without a prefix, then `flags.mjs --ai=<ids file> --apply`). Save takes the info
  (an existing sound keeps its own), PUT `/:id/info` changes it alone with the edit token (Edit info: a pencil of a
  row of an own preset); `/top` of a filter fills the Popular of a category with the rest of it by score (an item
  says whether it is `popular`: the browser draws a line, _Others in …_, before the rest); `/counts` the presets of
  each category; `?ids=` a list of the browser. The info of the existing presets: `categorize.mjs` (a sheet to check
  by hand, then `--apply --csv=`). `matchesPresetFilter` filters as the server does (Favorites, Recent and Mine are
  filtered in the browser).
- The clip of a row heard (its Play): the preset opens as a click does, the track holds the clip of the user aside
  (`auditionClip`: not in the url nor the tab; a free track opens it as a preset would) and plays the clip once
  `$switching` of the sound switch is over (`playAudition`); Stop, a click on a row, the list closed, the Stop of the
  track, REC or a MIDI Clock give it back (`endAudition`) with its undo and tempo, the track stopped. The current
  preset isn't opened again: its clip is the one it opened with, fetched alone where the model doesn't have it (a
  reload, a save) (its knobs turned stay). Keys of the open list
  (`use-browser-keys.ts`, before the page's: the Space of the track skips them): the arrows open the next or the one
  before of the selected preset (the one opening, else the current one: the lit row), Space plays or stops its clip;
  without a clip the loop of the track (`play` of the track, as its Space; Space stops what plays). While Play is on
  (`playMode` of the browser) a step plays the clip of the next one, one without a clip the loop of the track.

### Wavetables and noises

- Wavetable files: mono 32-bit float WAV, 2048-sample frames, ≤256 frames, optional `clm ` chunk (a morph mark).
  Read by `synth/services/wav.ts` from the bytes, never with `decodeAudioData` (it resamples).
- Lists come from Netlify functions (`get-wavetables-list.mts`, `get-noises-list.mts`) over R2, kept a day by the CDN
  (`listResponse`; a deploy clears them: the free plan has 125k invocations a month); files are fetched
  from the public bucket domains (`synth/services/buckets.ts`), or through the site where a domain fails or stalls
  (`/files/*` rewrites of `netlify.toml`; `bucketLoader` of `synth/services/fetch.ts`). A load no model waits for
  any more is aborted with its download (`abortable`, `shared-loads.ts`).
- The wavetable editor (`synth/wave-table-editor/`) draws tables or builds them from an audio file
  (`synth/services/audio-file.ts`, decoded at 44.1 kHz).

### Promo pages (`apps/site`)

Astro static pages, one route per language (`src/i18n/locales.ts`, texts in `src/i18n/{en,es,de}.ts`; knob and
section names stay English; the Spanish and German words for each thing are those of `apps/site/GLOSSARY.md`, a new
term goes there first). The root `/` is the synth; the build merges the site into the synth's dist
(`scripts/site/merge.mjs`), then `scripts/site/lastmod.mjs` dates its pages in the sitemap: a page that says what
it says live (title, description, structured data, the text and links of its `<main>`; not scripts, markup or
navigation) keeps the `<lastmod>` of the live sitemap, a new or changed one takes the time of the build (a live
answer it can't read fails the build). Demo clips in `src/data/demos.ts` (mp3 not in git), images and video from
production by `scripts/site/*.mjs`. The only JS: players, the video, the canvas art (`src/art/`, pure math).

The manual (how to use the synth) and Learn (what a synth does, for a reader who may not know Chisper: no internals,
no test numbers): pages and their path per language in `src/manual/pages.ts` (two sections; the sitemap and hreflang
pair them, the synth's `MANUAL_PATH` opens the manual's hub, a folder of a section redirects to its hub in
`netlify.toml`), texts in `src/content/<section>/<lang>/<page>.mdx` (a missing language fails the build; MDX is not
run through Prettier: it breaks a paragraph at a line that starts with a tag), components in
`components/manual/`, pictures in `src/assets/manual/` (`screens.mjs --only=manual`, with `synth-map.json`, the
places of the parts of the synth; `--only=editor --url=…` for a change of the editor not yet on production), presets
besides the clips' in `src/manual/presets.ts` (`check-presets.mjs`). Every fact is the code's: a change of what the
synth shows or does updates the manual in the three languages in the same PR. `tests/manual.test.mjs` checks the
pages as built.

### Libs

- `math`: number, vector, typed-array helpers, FFT utilities, biquads (`@chisper/math/biquad` avoids pulling the
  FFT into bundles).
- `ui-kit`: styled-components widgets (charts, `Handle` knobs, `Fader`, `DragValue`, `SwitchKey(s)`, piano, pitch
  wheel, analysers, ADSR, velocity curve), the control menu (`useControlMenu`), modulation visuals (`AmountDot`,
  `useModMark`, `useLiveDraw` on canvases), `theme`/`GlobalStyle`. antd 6 is themed in `app/index.tsx`.
