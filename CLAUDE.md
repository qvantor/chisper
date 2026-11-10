# CLAUDE.md

Guidance for Claude Code in this repository. Details of behavior live in the code and its specs; this file keeps
what is needed to find your way and what is easy to break.

## Project

Chisper is an experimental browser wavetable synth (TypeScript + Web Audio API, React 19). Nx 24 monorepo:

- `apps/chisper` — the synth; `apps/site` — promo pages (Astro, static, en/es/de).
- `libs/math`, `libs/rxjs-react`, `libs/ui-kit`, `libs/preset-schema` — imported as `@chisper/*` (aliases in
  `tsconfig.base.json`).
- `netlify/` — Functions v2 (presets, usage, clips, bucket lists) and their specs; Postgres for presets and clips
  (`db/migrations/`, applied manually, in order).
- `dsp/` — the DSP of the audio worklets in Rust → wasm32.

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
- `npm run build` — production build into `dist/apps/chisper` (wasm, minified worklets, then the site merged in).
- `npm run build:perf` — build with the test hook `window.__chisperPerf` into `dist/apps/chisper-perf`.
- `npm run wasm` — Rust cores → `tmp/wasm/` (prod) and `tmp/wasm-perf/` (cargo feature `perf`, used by specs and
  `build:perf`). Flags: `--only=prod|perf`, `--watch`, `--sizes`, `--check-sizes`.
- `npm run worklets` — esbuild bundles of the worklet modules (wasm inlined) and the classic workers into
  `tmp/worklets/` (served as `assets/worklets/`).
- `npx nx dev site` (:4321), `npx nx run site:verify` (build + HTML checks).

Checks:

- `npx nx test <project>` — `chisper`, `math`, `rxjs-react`, `ui-kit`, `preset-schema`, `netlify`. One file:
  `npx nx test rxjs-react rx-model.spec.tsx` (a Jest pattern; `--testFile` is ignored). Run from the root.
- The `chisper` specs load `tmp/wasm-perf/*.wasm`: run `npm run wasm` after any change in `dsp/` (the bytes are an
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
- `scripts/wasm-browsers/run.mjs` — bit parity of the wasm cores in browsers vs Node; `app.mjs` — the app in each
  browser (sound, no glitches, no paints over the LFOs).
- `node scripts/renders/run.mjs` — renders of the reference Audio Unit (macOS, `.env` `RENDERS_*`) into
  `dsp/measurements/*.json`, which the specs compare the engine with.
- `node scripts/noises/process.mjs` / `add.mjs` — noise samples from `assets/noises/manifest.json` into
  `tmp/noises/`. `upload.mjs` writes to the production bucket: dry run unless `--apply`, only when the user asks.

Env vars: `.env.example` (R2 buckets of tables and noises, `DATABASE_URL`, Turnstile, score thresholds). The client
gets only `NX_PUBLIC_*` vars (inlined at build time).

## Rules that are easy to break

- **Bit-exact DSP.** The Rust cores were ported bit for bit from TS and compute every value in a fixed order: no
  `mul_add`, no fast-math, no relaxed-simd, SIMD only over independent lanes, sums in their order, `as f32` where
  the TS wrote to a Float32Array, Math only through `dsp/jsmath` (V8's fdlibm; `dsp/clippy.toml` disallows
  `f64::sin`, `exp`, `powf`, `max`, `min`, `mul_add`…). Goldens specs import `test-utils/js-math.ts` first.
  wasm-opt never with fast-math.
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
  and missing keys mean defaults. A new field changes every preset hash: DB presets get it by a migration after
  deploy, not legacy code.
- **Append-only indexes**: `TEMPO_DIVISIONS`, `DISTORTION_MODES` (raise `FX_PARAMS.distortion.mode.max`), the knob
  ids of `targets.rs` / `VOICE_MODULES` (a new module goes last; `voice-modules.spec` holds them).
- **Netlify**: function specs live in `netlify/tests/`, never in `netlify/functions/` (every file there is
  deployed). Functions import `libs/preset-schema` by relative path (esbuild doesn't know the tsconfig aliases).
  Netlify doesn't typecheck functions: `npm run typecheck` does.

## Specs

- App specs run on `standardized-audio-context-mock`. `test-setup.ts` adds an `AudioWorkletNode` stub (no
  AudioParams), a `Worker` stub (`test-utils/worker-stub.ts`) and a recording 2D canvas context
  (`installCanvasStub`: `drawn(canvas)`, `svgPath`). There's no global MessageChannel: `createSynthCore`
  (test-utils) gives the engine a stub channel; providers rendered without it see the engine `unsupported`.
- Voices are read from the events posted to the voices node: `voiceEvents(audioCtx, wavetables)`
  (`test-utils/voice-events.ts`), `wavetables.flush()` sends a task's events, `end(voice)`/`started(voice, …)`;
  `offline-engine.ts` renders the voices on the real core.
- antd under test gives every component the id `test-id`: the setup mocks its `useId` (`test-utils/rc-use-id.ts`).
  `ResizeObserver` is stubbed.
- Count `addModule` calls with `workletLoads` (the synth core adds limiter and wavetable-osc itself).
- Presets specs without the synth pass `immediateSoundSwitch` of test-utils.
- Server specs: the DB is the fake `sql` tag of `netlify/tests/fake-sql.ts` (records queries, answers by regex).
- DSP specs: `<module>-dsp.spec.ts` (the core through its facade), `<module>-goldens.spec.ts` (golden scenarios and
  fuzzing, `test-utils/fuzz-signals.ts`); the crates have `cargo test` (lanes run as arrays off wasm).
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
  Transport → Envelopes → Lfo → Modulation → Oscillator1/2 → Noise → MidiController → Filter → Synth → Fx →
  SoundSwitch → Track → KeyboardController → Presets.

### Audio graph (`synth/common/modules`)

- `synth-core.ts` owns the single `AudioContext` and the wavetable engine:
  `voices node → preGain → fxIn → [fx chain] → fxOut → masterGain → masterLimiter → destination`. Every note plays
  in the one voices node (the filter is inside each voice). Header analysers tap the output after the limiter and
  sleep when nothing sounds.
- Latency (`synth/common/latency/`): `latencyHint` is chosen at context creation (a change reloads the page); only
  desktop Chromium honours it. Modes auto/low/normal (localStorage `latencyMode`); auto falls back to normal after
  dropouts (`playbackStats.underrunEvents`).
- Master limiter (`synth/common/limiter/`, core `dsp/limiter`): stereo true-peak brickwall at −0.5 dBTP. Until it
  is ready the master is silent (no fallback); a failure shows a toast with Retry (`retryAudio`).
- FX (`synth/fx/`): effects are defined in `FX_REGISTRY` (`fx/effects/`) with params/ranges from `FX_PARAMS` of
  `libs/preset-schema`; a new effect type = a registry entry + its preset schema. `createFxSlot` wraps each (mix
  crossfade, bypass, dry delay for cores with latency). Default order `FX_TYPES` (distortion, delay, reverb).
  Delay is native nodes; reverb (16-line FDN) and distortion (4×/8× oversampled) are wasm worklets.
- Worklet effects build on `createWorkletFx` (`fx/effects/worklet-fx.ts`: loading, `$status`, `retry`, `stop` on
  destroy) and register with `registerStereoProcessor` (`stereo-processor.ts`). Without AudioWorklet or when a
  module fails, the app works without that effect; until `ready` a slot passes only the dry signal.
- Knob modulation of native params (delay, slot gains) goes through the fx-mod worklet (`fx-mod.ts`, its lines add
  offsets to the params); distortion and reverb modulate inside their worklets (`fx-modulation.ts`).

### Oscillators and voices (`synth/common/wavetable`, `dsp/wavetable-osc`)

- No native fallback: without AudioWorklet, Worker, MessageChannel or wasm SIMD the synth doesn't play and says why
  (`OscillatorStatus`).
- `wavetable-engine.ts` (one per context): `$status`, `retry`; a store node, the voices node (`VOICES_PROCESSOR`,
  `voices-processor.ts`), a worker (`wavetable.worker.ts` → `wavetable-builder.ts`, builds mip levels,
  `wavetable-mipmap.ts`) and a MessageChannel between worker and store. Tables arrive in chunks; each version is
  `sending`/`stored`/`refused`/`failed` in `$tables`; versions only grow.
- `createVoice(options, values)` gives a `VoiceHandle` whose params mimic AudioParam calls; each call is an event
  of the voices node, a task's events go in one message (by a microtask). The node reports `started`/`ended`.
  A trap in a voice ends only that voice.
- The core (`dsp/wavetable-osc/src`): `scope.rs` (the voices of a node), `voice.rs`, `source.rs` (oscillators and
  noise as slots of the trait `Source`), `timeline.rs` (AudioParam semantics), `envelope.rs`, `lfo.rs`,
  `modulation.rs` (routes), `filter.rs`, `velocity.rs`, `noise.rs`, `store.rs`, `shared.rs` (phrases, LFOs),
  `targets.rs` (knob ids). Options/messages: `voice-options.ts`, params: `wavetable-osc-params.ts`.
- Behaviour checked against the reference AU measurements (`dsp/measurements/`: unison, blend, spread, phases,
  frames, frame fades, envelopes, aliasing, noise). Aliasing −70 dB, spurs −80 dB.
- Worklet modules prewarm their core on load (lazy wasm compilation would hit the first note).

### Synth, input, transport (`synth/common/modules`, `synth/common/*`)

- `oscillator.ts` — the table (`$waveTable`, morph tables expand to 256 frames), position, pitch (oct/semi/fine),
  unison, phases, gain; sends its table to the engine.
- `noise.ts` (+ `synth/noise/`) — a sample player in every voice; samples from the noise bucket.
- `synth.ts` + `synth/voicing/` — voices per note: poly with stealing (quietest released first; out of legato the
  stolen voice takes the new note, its phases go on, else it fades out), legato, portamento (`glide.ts`), mono
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

- One cdylib per worklet bundle with a C ABI (no wasm-bindgen, no SharedArrayBuffer): `limiter`, `reverb`,
  `distortion`, `wavetable-osc`; shared crates `dsp-core` (biquads, oversampler, true peak, delay blocks, `F64x2`
  lanes), `jsmath`, `wasm-rt` (no_std on wasm32, panic traps, dlmalloc). Toolchain pinned in
  `dsp/rust-toolchain.toml`, `+simd128`, 64 KiB stack, `panic = "abort"`, fat LTO.
- A bundle `<name>.worklet.ts` registers its processors (names in `common/processors.ts`); its facade
  `<name>-wasm.ts` wraps the core. Effect cores expose `fx_new`, `fx_buffers`, `fx_process`, `fx_clear`, `fx_free`,
  `fx_command`. Specs import the wasm bytes via `@chisper/wasm/<name>.wasm` (`apps/chisper/wasm-babel-plugin.js`).
- NaN/±Inf input is taken as 0 by the effects, the decoded files and the worker.

### Snapshots

`apps/chisper/src/app/app/plugins/snapshot.ts` creates one `searchParamsSnapshotPlugin`; models `osc1`, `osc2`,
`noise`, `filter`, `env`, `mod`, `fx`, `lfo` and the synth as `v` expose `{ [modelName]: { key: value } }`.
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
section names stay English). The root `/` is the synth; the build merges the site into the synth's dist
(`scripts/site/merge.mjs`). Demo clips in `src/data/demos.ts` (mp3 not in git), images and video from production by
`scripts/site/*.mjs`. The only JS: players, the video, the canvas art (`src/art/`, pure math).

### Libs

- `math`: number, vector, typed-array helpers, FFT utilities, biquads (`@chisper/math/biquad` avoids pulling the
  FFT into bundles).
- `ui-kit`: styled-components widgets (charts, `Handle` knobs, `Fader`, `DragValue`, `SwitchKey(s)`, piano, pitch
  wheel, analysers, ADSR, velocity curve), the control menu (`useControlMenu`), modulation visuals (`AmountDot`,
  `useModMark`, `useLiveDraw` on canvases), `theme`/`GlobalStyle`. antd 6 is themed in `app/index.tsx`.
