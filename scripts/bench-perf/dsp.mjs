// the fast layer of the suite (`--only=dsp`, about 20 s, no browser): the signal processing of the app in Node,
// ns per sample, each divided by the ns of a fixed multiply-add of the same run (the speed of the machine out);
// 7 samples a case. With a reference (--against) its code is bundled too and the samples of both alternate in
// one process (A B B A …), the regressions compare them (report.mjs). V8, not JSC: it catches regressions of the
// algorithms (a hot loop that boxes doubles), not of the engines
import fs from 'node:fs';
import path from 'node:path';
import { appDir, hasOscWarp, loadApp, median, root } from './util.mjs';

const BLOCK = 128;
const RATE = 48000;
const SAMPLES = 7;
// the warp cases of the oscillators: the modes (`warpMode` of the options: its index in WARP_MODES), the knobs of the
// static ones, the speeds of the LFO 1 that moves the knob (Hz: a slow sweep, a vibrato, a tremolo, the top of the knob)
const WARP_BENCH_MODES = [
  ['bend+', 1],
  ['bend-', 2],
  ['bend+/-', 3],
  ['pwm', 4],
];
const WARP_BENCH_KNOBS = [0.2, 0.5, 0.9];
const WARP_BENCH_HZ = [0.5, 8, 32, 100];

// the paths of the modules below are from the folder of the app of each tree (appDir)
const ENTRY = "export { buildLevels } from './src/app/synth/common/wavetable/wavetable-mipmap';\n";

// the TS cores of a tree that has them (before stage 5 of the plan: an A/B run against main of that time)
const TS_CORES = [
  {
    module: 'src/app/synth/common/wavetable/wavetable-osc-dsp',
    create: 'createVoiceDsp, createVoiceShared, createTableStore',
  },
  { module: 'src/app/synth/fx/effects/reverb-dsp', create: 'createReverbDsp' },
  { module: 'src/app/synth/fx/effects/distortion-dsp', create: 'createDistortionDsp' },
  { module: 'src/app/synth/common/limiter/limiter-dsp', create: 'createLimiterDsp' },
];

// the Rust cores (dsp/, `npm run wasm`: tmp/wasm, as in production) of the tree that has them: its facade and
// the bytes of the core. An effect is a module of its own in a tree before the chain core, a unit of chain.wasm
// (`within`) from it on; the chain and the oscillator are engine.wasm (`WHOLE`) in a tree that has it: their cases
// keep their names, an A/B run pairs them
const WHOLE = 'engine';
const WASM_CORES = [
  {
    core: 'engine',
    facade: 'src/app/synth/common/engine/engine-wasm',
    create: 'createEngineWasm',
  },
  {
    core: 'chain',
    facade: 'src/app/synth/common/chain/chain-wasm',
    create: 'createChainWasm',
  },
  {
    core: 'delay',
    within: 'chain',
    facade: 'src/app/synth/fx/effects/delay-wasm',
    create: 'createDelayWasm',
  },
  {
    core: 'limiter',
    within: 'chain',
    facade: 'src/app/synth/common/limiter/limiter-wasm',
    create: 'createLimiterWasm',
  },
  {
    core: 'reverb',
    within: 'chain',
    facade: 'src/app/synth/fx/effects/reverb-wasm',
    create: 'createReverbWasm',
  },
  {
    core: 'distortion',
    within: 'chain',
    facade: 'src/app/synth/fx/effects/distortion-wasm',
    create: 'createDistortionWasm',
  },
  {
    core: 'compressor',
    within: 'chain',
    facade: 'src/app/synth/fx/effects/compressor-wasm',
    create: 'createCompressorWasm',
  },
  {
    core: 'chorus',
    within: 'chain',
    facade: 'src/app/synth/fx/effects/chorus-wasm',
    create: 'createChorusWasm',
  },
  {
    core: 'eq',
    within: 'chain',
    facade: 'src/app/synth/fx/effects/eq-wasm',
    create: 'createEqWasm',
  },
  {
    core: 'fxfilter',
    within: 'chain',
    facade: 'src/app/synth/fx/effects/fxfilter-wasm',
    create: 'createFxFilterWasm',
  },
  {
    core: 'wavetable-osc',
    facade: 'src/app/synth/common/wavetable/wavetable-osc-wasm',
    create: 'createOscScope, createTableStoreWasm, createVoiceSharedWasm, createVoiceWasm',
    // (a tree of the engine node: its scope too; the params of a block in their order: a tree whose oscillators
    // have the blend of their unison as a param has blend1)
    optional: ['createVoiceScopeWasm', 'VOICE_PARAM_ORDER'],
  },
];

const WASM_CORE = 'src/app/synth/common/wasm/wasm-core';
// the levels of a sample of the noise (a tree that has it)
const NOISE_LEVELS = 'src/app/synth/common/wavetable/noise-levels';
// the tables of the shapes of the LFOs (a tree that has them)
const LFO_CURVE = 'src/app/synth/common/lfo/lfo-curve';
const SUB_SHAPES = 'src/app/synth/common/wavetable/sub-shapes';
const VOICE_OPTIONS = 'src/app/synth/common/wavetable/voice-options';

// as in production: the counters of the perf build out. A tree with wasm cores bundles their facades too and
// instantiates them (one instance per core, as one AudioWorkletGlobalScope)
export const loadDsp = async (source = root, name) => {
  const app = path.join(source, appDir(source));
  const built = (name) => name && fs.existsSync(path.join(source, `tmp/wasm/${name}.wasm`));
  // (the file of each: the module it is a unit of in a tree that has that one, else its own; a file of its own
  // left in tmp/wasm by a build of before is not of this tree)
  const cores = WASM_CORES.filter(({ facade }) => fs.existsSync(path.join(app, `${facade}.ts`)))
    .map((entry) => ({ ...entry, file: [WHOLE, entry.within, entry.core].find(built) }))
    .filter(({ file }) => file);
  const exports = (module, name) => {
    const file = path.join(app, `${module}.ts`);
    return fs.existsSync(file) && new RegExp(`export const ${name}\\b`).test(fs.readFileSync(file, 'utf8'));
  };
  const ts = TS_CORES.filter(({ module }) => fs.existsSync(path.join(app, `${module}.ts`)));
  // (instantiated by its instantiateCore, as the worklets do: a tree that guards the calls of its cores pays for it)
  const instantiate = cores.length > 0 && fs.existsSync(path.join(app, `${WASM_CORE}.ts`));
  const contents = `${ENTRY}${[
    ...ts.map(({ module, create }) => [module, create]),
    ...cores.map(({ facade, create, optional = [] }) => {
      const code = fs.readFileSync(path.join(app, `${facade}.ts`), 'utf8');
      const present = optional.filter((name) => new RegExp(`export const ${name}\\b`).test(code));
      return [facade, [create, ...present].join(', ')];
    }),
    ...(instantiate ? [[WASM_CORE, 'instantiateCore']] : []),
    ...(fs.existsSync(path.join(app, `${LFO_CURVE}.ts`)) ? [[LFO_CURVE, 'lfoTable']] : []),
    ...(fs.existsSync(path.join(app, `${NOISE_LEVELS}.ts`)) ? [[NOISE_LEVELS, 'buildNoiseLevels']] : []),
    ...(fs.existsSync(path.join(app, `${SUB_SHAPES}.ts`)) ? [[SUB_SHAPES, 'subShapeFrame']] : []),
    // (the types of the filter of a voice: a tree before them has none)
    ...(exports(VOICE_OPTIONS, 'VOICE_FILTER_TYPES') ? [[VOICE_OPTIONS, 'VOICE_FILTER_TYPES']] : []),
  ]
    .map(([module, create]) => `export { ${create} } from './${module}';\n`)
    .join('')}`;
  const dsp = await loadApp({ source, resolveDir: app, contents, name });
  // (one instance per file, as one AudioWorkletGlobalScope)
  const instances = new Map();
  const instance = (file) => {
    if (!instances.has(file)) {
      const module = new WebAssembly.Module(fs.readFileSync(path.join(source, `tmp/wasm/${file}.wasm`)));
      instances.set(
        file,
        instantiate ? dsp.instantiateCore(module) : new WebAssembly.Instance(module).exports
      );
    }
    return instances.get(file);
  };
  const wasm = Object.fromEntries(cores.map(({ core, file }) => [core, instance(file)]));
  // (the warp of the oscillators: a tree whose options of an oscillator have it)
  const warp = hasOscWarp(source);
  return { ...dsp, wasm, modelFilters: dsp.VOICE_FILTER_TYPES?.includes('ladder24') ?? false, warp };
};

// a table of 256 frames of 2048 samples as the store takes it (its layout is not read) and a chunk of it (1 MB)
const TABLE_256 = { frames: 256, harmonics: [1], lengths: [8], offsets: [0], length: 16670976 };
const CHUNK = new Float32Array(262144);

// the LFOs of a shared or a node: sines of `period` seconds, retrig, at once with their tables (the lfoTable of the
// app of `dsp`)
export const lfoStateOf = (dsp, period) => ({
  at: 0,
  instantly: true,
  lfos: [0, 1, 2, 3].map(() => ({
    mode: 0,
    delay: 0,
    rise: 0,
    smooth: 0,
    phase: 0,
    anchor: { time: 0, phase: 0, period },
    table: dsp.lfoTable('sine'),
  })),
});

// ns per call over `ms` at least
export const timeCalls = (call, ms) => {
  let calls = 0;
  const start = process.hrtime.bigint();
  let elapsed = 0;
  while (elapsed < ms * 1e6) {
    for (let i = 0; i < 16; i++) call();
    calls += 16;
    elapsed = Number(process.hrtime.bigint() - start);
  }
  return elapsed / calls;
};

// the samples of each side: a warm-up of each (the JIT), then SAMPLES each, the sides alternating A B B A …
// (`sample` takes one: ns per call over 0.2 s, or what a call returns)
const alternate = (sides, sample, warm) => {
  sides.forEach(warm);
  const samples = sides.map(() => []);
  for (let i = 0; i < SAMPLES; i++) {
    const order = sides.map((_, side) => side);
    if (i % 2) order.reverse();
    order.forEach((side) => samples[side].push(sample(sides[side])));
  }
  return samples;
};
const measure = (calls) =>
  alternate(
    calls,
    (call) => timeCalls(call, 200),
    (call) => timeCalls(call, 300)
  );

// the speed of the machine: ns of one multiply-add of a typed array
const calibrate = () => {
  const a = Float64Array.from({ length: 4096 }, (_, i) => Math.sin(i));
  const b = Float64Array.from({ length: 4096 }, (_, i) => Math.cos(i));
  let sink = 0;
  const [samples] = measure([
    () => {
      let sum = 0;
      for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
      sink += sum;
    },
  ]);
  return { ns: median(samples) / a.length, sink };
};

// a frame of a band-limited saw with its harmonics shifted by `k` (the frames of a table differ)
export const frame = (k, size = 2048) =>
  Float32Array.from({ length: size }, (_, n) => {
    let sum = 0;
    for (let h = 1; h <= 64; h++) sum += Math.sin((2 * Math.PI * h * n) / size + k * h * 0.01) / h;
    return sum;
  });

const noise = (length, amplitude) => {
  let seed = 1;
  return Float32Array.from({ length }, () => {
    seed = (seed * 16807) % 2147483647;
    return amplitude * ((seed / 2147483647) * 2 - 1);
  });
};

const BASE = {
  frequency: 220,
  gate: 1,
  position1: 0.5,
  position2: 0.5,
  detune1: 0,
  detune2: -1200,
  spread1: 20,
  spread2: 20,
  gain1: 0.5,
  gain2: 0.5,
  blend1: 0.5,
  blend2: 0.5,
};
const REVERB = {
  lowcut: 20,
  pre: 0.02,
  size: 0.5,
  decay: 3,
  damp: 6000,
  bass: 1,
  depth: 0.2,
  sep: 1,
  er: 0.5,
  drive: 0,
  bandwidth: RATE / 2,
  body: 0,
};
const constant = (values) =>
  Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Float32Array.of(value)]));

// the cases of a bundle of the code: a call (one block: ns per sample = ns per call / BLOCK), or for the build a
// sample of its own (ms of a build of 256 frames)
const createCases = (dsp) => {
  const outL = new Float32Array(BLOCK);
  const outR = new Float32Array(BLOCK);
  // the voices: a table of 16 frames `a` in the store of each core (a held voice costs the same on any count) and
  // one of 256 `b` (as a table with a morph mark plays: a moving position changes frame more often than a fade
  // lasts, the voices fade almost all the time)
  const store = dsp.createTableStore?.();
  const frames = Array.from({ length: 256 }, (_, k) => frame(k));
  const levels = dsp.buildLevels(frames.slice(0, 16));
  const levels256 = dsp.buildLevels(frames);
  store?.set('a', 1, levels);
  store?.set('b', 1, levels256);
  const oscScope = dsp.wasm['wavetable-osc'] && dsp.createOscScope(dsp.wasm['wavetable-osc']);
  const wasmStore = oscScope && dsp.createTableStoreWasm(oscScope);
  wasmStore?.set('a', 1, levels);
  wasmStore?.set('b', 1, levels256);
  // (as the worklet: its processor of the engine listens for the memory the store frees, read after every block)
  wasmStore?.listen?.(() => undefined);
  const createShared = { ts: () => dsp.createVoiceShared(), wasm: () => dsp.createVoiceSharedWasm(oscScope) };
  const createVoice = {
    ts: (options, shared = createShared.ts()) =>
      dsp.createVoiceDsp(RATE, options, store, Math.random, shared),
    wasm: (options, shared = createShared.wasm()) =>
      dsp.createVoiceWasm(oscScope, RATE, options, wasmStore, Math.random, shared),
  };
  // (a unison shape: a tree before it plays the unison plain; a velocity: a tree before it plays at the amp 1)
  // (`warp`: the warp of the oscillators, { warpMode, warp })
  const voiceOf = (core, unisonShape, velocity, warp) => (oscs, params, table) => () => {
    const options = {
      osc: oscs.map((unison) =>
        unison
          ? {
              table: table ?? 'a',
              unison,
              phase: 0,
              phaseRand: 1,
              ...(unisonShape && { unisonShape }),
              ...warp,
            }
          : null
      ),
      start: 0,
      // ENV 1 at full level, no route, no filter: the oscillators as they play
      envelopes: [0, 1, 2].map(() => ({ attack: 0, hold: 0, decay: 0, sustain: 1, release: 0 })),
      envStart: 0,
      phrase: 0,
      routes: [],
      filter: null,
      ...(velocity && { velocity }),
    };
    const voiceDsp = createVoice[core](options);
    let frameAt = 0;
    return () => {
      voiceDsp.process(frameAt, typeof params === 'function' ? params(frameAt) : params, outL, outR);
      frameAt += BLOCK;
    };
  };
  // a voice with a noise (a tree before it: none) on a stereo sample of 2 s at 44.1 kHz (`sample` 'm': a mono one,
  // as the white noise a noise starts with), looped from its start, at `cents` (0: a step of 0.92 at 48 kHz, read
  // from the pair of a tree that has it; 400: 1.16, the pair of a tree that reads it up to a step of 1.24, else the
  // bank; 700: 1.38, a kernel of the bank below the nyquist; 1900: 2.76, a kernel of the bank on loop level 1)
  const noisy = Boolean(dsp.buildNoiseLevels && wasmStore);
  if (noisy) {
    let seed = 1;
    const channel = () =>
      Float32Array.from({ length: 2 * 44100 }, () => {
        seed = (seed * 16807) % 2147483647;
        return seed / 2147483647 - 0.5;
      });
    wasmStore.set('n', 1, dsp.buildNoiseLevels([channel(), channel()], 44100));
    wasmStore.set('m', 1, dsp.buildNoiseLevels([channel()], 44100));
  }
  // a voice of the oscillators with another source (`source`: { noise } or { sub }), its params those of a block or a
  // function of its frame
  const voiceWith = (source) => (oscs, params) => () => {
    const voiceDsp = createVoice.wasm({
      osc: oscs.map((unison) => (unison ? { table: 'a', unison, phase: 0, phaseRand: 1 } : null)),
      ...source,
      start: 0,
      envelopes: [0, 1, 2].map(() => ({ attack: 0, hold: 0, decay: 0, sustain: 1, release: 0 })),
      envStart: 0,
      phrase: 0,
      routes: [],
      filter: null,
    });
    let frameAt = 0;
    return () => {
      voiceDsp.process(frameAt, typeof params === 'function' ? params(frameAt) : params, outL, outR);
      frameAt += BLOCK;
    };
  };
  const noiseVoiceOf = (cents, sample = 'n') =>
    voiceWith({
      noise: { sample, loop: true, keytrack: false, start: 0, rand: 0, level: 0.5, pan: 0.2, cents },
    });
  // a voice with a sub (a tree before it: none) on the sine of the store (`table` null) or a shape, in the centre at a
  // still level (its steady loop into the centre of the bus)
  const subbed = Boolean(dsp.subShapeFrame && wasmStore);
  if (subbed) wasmStore.set('sub:saw', 1, dsp.buildLevels([dsp.subShapeFrame('saw')]));
  const subVoiceOf = (table) =>
    voiceWith({ sub: { table, phase: 0, contiguous: false, level: 0.8, pan: 0, cents: -1200 } });
  // a chord of 12 notes × 2 × u8 struck again every ATTACK blocks, about the time its 192 unison voices take to go
  // onto their mix tables under the budget: the direct path, the builds, the note on (the peak of a block is
  // there); one shared a core, its pool of mix tables as in a scope
  const ATTACK = 40;
  const chord = [48, 50, 52, 55, 57, 60, 62, 64, 67, 69, 71, 72].map((note) =>
    constant({ ...BASE, frequency: 440 * 2 ** ((note - 69) / 12), spread1: 25, spread2: 35 })
  );
  const chordOf = (core) => () => {
    const shared = createShared[core]();
    const options = {
      osc: [0, 1].map(() => ({ table: 'a', unison: 8, phase: 0, phaseRand: 1 })),
      start: 0,
      envelopes: [0, 1, 2].map(() => ({ attack: 0.01, hold: 0.1, decay: 0.3, sustain: 0.8, release: 0.3 })),
      envStart: 0,
      phrase: 0,
      routes: [],
      filter: null,
    };
    let voices = [];
    let block = 0;
    return () => {
      if (block % ATTACK === 0) {
        voices.forEach((voice) => voice.end?.());
        voices = chord.map(() => createVoice[core](options, shared));
      }
      voices.forEach((voice, i) => voice.process(block * BLOCK, chord[i], outL, outR));
      block++;
    };
  };
  // the same chord as the voices of one node (scope.rs): their note ons as events, their params from their
  // timelines, their sum; struck again, a node of its own (the voices before end at once, as above)
  const scopeOptions = {
    osc: [0, 1].map(() => ({ table: 'a', unison: 8, phase: 0, phaseRand: 1 })),
    start: 0,
    envelopes: [0, 1, 2].map(() => ({ attack: 0.01, hold: 0.1, decay: 0.3, sustain: 0.8, release: 0.3 })),
    envStart: 0,
    phrase: 0,
    routes: [],
    filter: null,
  };
  const scopeNotes = (voices, options = scopeOptions) =>
    voices.apply(
      chord.map((params, voice) => ({
        kind: 'on',
        voice,
        options,
        params: Object.fromEntries(Object.entries(params).map(([k, [v]]) => [k, v])),
      }))
    );
  // (`warp`: both oscillators warped, { warpMode, warp })
  const scopeChordOf = (warp) => () => {
    const shared = createShared.wasm();
    const options = warp
      ? { ...scopeOptions, osc: scopeOptions.osc.map((osc) => ({ ...osc, ...warp })) }
      : scopeOptions;
    let voices = null;
    let block = 0;
    return () => {
      if (block % ATTACK === 0) {
        voices?.free();
        voices = dsp.createVoiceScopeWasm(oscScope, RATE, wasmStore, shared);
        scopeNotes(voices, options);
      }
      voices.process(block * BLOCK, outL, outR);
      voices.reports();
      block++;
    };
  };
  // the chord struck once and the pitch bend of the node: up a semitone and back over BENDING blocks (an event
  // every 2: what the throttle of the app lets through from a wheel, 5 ms), then at rest until the next BEND. Every
  // voice plays directly while it moves, then builds its mixes again under the budget
  const BEND = 60;
  const BENDING = 20;
  const scopeChordBend = () => {
    const voices = dsp.createVoiceScopeWasm(oscScope, RATE, wasmStore, createShared.wasm());
    scopeNotes(voices);
    let block = 0;
    return () => {
      const at = block % BEND;
      if (at < BENDING && at % 2 === 0) voices.setBend(50 * (1 - Math.cos((2 * Math.PI * at) / BENDING)));
      voices.process(block * BLOCK, outL, outR);
      voices.reports();
      block++;
    };
  };
  const held = constant(BASE);
  // the frequency a sample gliding up and down an octave over 2 s (the params of each block of the cycle made once)
  const glideBlocks = Array.from({ length: Math.round((2 * RATE) / BLOCK) }, (_, k) => ({
    ...held,
    frequency: Float32Array.from(
      { length: BLOCK },
      (_, i) => 220 * 2 ** (0.5 - 0.5 * Math.cos((2 * Math.PI * (k * BLOCK + i)) / (2 * RATE)))
    ),
  }));
  const gliding = (frameAt) => glideBlocks[(frameAt / BLOCK) % glideBlocks.length];
  // the LFOs of a shared or a node: sines of `period` seconds, retrig, at once with their tables (a tree before
  // them: none)
  const lfoState = (period) => lfoStateOf(dsp, period);
  // a u8 voice LFO 1 moves a param of (a sine of 0.5 s on its position: the direct path, a frame at a time; on its
  // gain: the gain per sample, the voice on its mix tables; a vibrato of 5 Hz on its Fine: the pitch moves all
  // along, at 220 Hz over the flat of a level, `crossfade` over the middle of a crossfade)
  const lfoVoiceOf =
    (param, amount, route = { min: 0, max: 1 }, period = 0.5, values = held, osc = {}) =>
    () => {
      const flat = { attack: 0, hold: 0, decay: 0, sustain: 1, release: 0 };
      const shared = createShared.wasm();
      shared.setLfos(lfoState(period));
      const voiceDsp = createVoice.wasm(
        {
          osc: [{ table: 'a', unison: 8, phase: 0, phaseRand: 1, ...osc }, null],
          start: 0,
          envelopes: [flat, flat, flat],
          envStart: 0,
          phrase: 0,
          routes: [{ source: 4, param, amount, ...route }],
          filter: null,
        },
        shared
      );
      let frameAt = 0;
      return () => {
        voiceDsp.process(frameAt, values, outL, outR);
        frameAt += BLOCK;
      };
    };
  // the middle of the crossfade of a level into the next (x 1.9 of the levels of the table, 64 harmonics: base 128)
  const crossfade = constant({ ...BASE, frequency: (RATE / 2 / 128) * 2 ** ((1.9 - 1) / 3) });
  // the chord of `scope chord attack` with a lowpass LFO 1 moves around its cutoff (bipolar, ±1 octave, 4 Hz),
  // the coefficients of every voice worked out again every 32 samples
  // (`filtered` false: the same chord and route without the filter, `routed` false: the filter at rest; the share of
  // the filter in a voice is between them and `scope chord attack`)
  // (`filter`: another one than the lowpass, a model type of a tree that has them)
  const scopeChordLfoOf =
    (filtered, routed, filter = { type: 'lowpass', cutoff: 1200, resonance: 3, gain: 0 }) =>
    () => {
      const shared = createShared.wasm();
      let voices = null;
      let block = 0;
      const options = {
        ...scopeOptions,
        filter: filtered ? filter : null,
        routes: routed
          ? [{ source: 4, param: 'cutoff', amount: 2, min: 20, max: 20000, scale: 'log', bipolar: true }]
          : [],
      };
      return () => {
        if (block % ATTACK === 0) {
          voices?.free();
          voices = dsp.createVoiceScopeWasm(oscScope, RATE, wasmStore, shared);
          shared.setLfos(lfoState(0.25));
          voices.apply(
            chord.map((params, voice) => ({
              kind: 'on',
              voice,
              options,
              params: Object.fromEntries(Object.entries(params).map(([k, [v]]) => [k, v])),
            }))
          );
        }
        voices.process(block * BLOCK, outL, outR);
        voices.reports();
        block++;
      };
    };
  const modelFilters = !!oscScope && dsp.modelFilters;
  const LOW12 = { type: 'low12', cutoff: 1200, resonance: 30, gain: 0, drive: 0, variation: 0 };
  const LADDER24 = { type: 'ladder24', cutoff: 1200, resonance: 60, gain: 0, drive: 40, variation: 50 };
  // a voice whose routes move all the time: ENV 2 and 3 (a decay of 0.2 s, started again every 64 blocks by the
  // gate held at its other value) on the gain, the cutoff and the resonance of the filter, worked out at the points
  // of every 32 samples (the hot loop of the routes; u1: the oscillator costs little next to them). No velocity: a
  // tree before it has none
  const AGAIN = 64;
  const heldAgain = constant({ ...BASE, gate: 1.5 });
  const flat = { attack: 0, hold: 0, decay: 0, sustain: 1, release: 0 };
  // a call of a voice: a block, the gate at its other value every AGAIN blocks
  const retriggered = (voiceDsp) => {
    let block = 0;
    return () => {
      voiceDsp.process(block * BLOCK, Math.floor(block / AGAIN) % 2 ? heldAgain : held, outL, outR);
      block++;
    };
  };
  // (`model`: Low 12 instead of the lowpass, its Res in % moved as much, a tree that has the model types: the
  // design of a voice its own at every span, none of another to share)
  const routedOf =
    (core, model = false) =>
    () => {
      const decay = { attack: 0, hold: 0, decay: 0.2, sustain: 0, release: 0 };
      const voiceDsp = createVoice[core]({
        osc: [{ table: 'a', unison: 1, phase: 0, phaseRand: 0 }, null],
        start: 0,
        envelopes: [flat, decay, decay],
        envStart: 0,
        phrase: 0,
        // (in the fields of every tree: `env` and `log` before the LFOs, `source` and `scale` since)
        routes: [
          { env: 1, source: 1, param: 'gain1', amount: -0.5, min: 0, max: 1 },
          { env: 1, source: 1, param: 'cutoff', amount: 4, min: 20, max: 20000, log: true, scale: 'log' },
          model
            ? { env: 2, source: 2, param: 'resonance', amount: 33, min: 0, max: 100 }
            : { env: 2, source: 2, param: 'resonance', amount: 12, min: -12, max: 24 },
        ],
        filter: model
          ? { ...LOW12, cutoff: 400, resonance: 10 }
          : { type: 'lowpass', cutoff: 400, resonance: 3, gain: 0 },
      });
      return retriggered(voiceDsp);
    };
  // a kick of u8: ENV 2 from 36 semitones over the note down to it in 80 ms (bounds wider than those of Semi: the
  // pitch moves all along), the envelopes started again every AGAIN blocks (as `voice u1 routed`): the direct path
  // while the pitch moves, then its mix tables again; its cost over `voice u8 held` (a tree before the pitch as a
  // target: none)
  const pitchEnv = () => {
    const kick = { attack: 0, hold: 0, decay: 0.08, sustain: 0, release: 0 };
    const voiceDsp = createVoice.wasm({
      osc: [{ table: 'a', unison: 8, phase: 0, phaseRand: 1 }, null],
      start: 0,
      envelopes: [flat, kick, flat],
      envStart: 0,
      phrase: 0,
      routes: [{ source: 1, param: 'pitch1', amount: 3600, min: -12000, max: 12000 }],
      filter: null,
    });
    return retriggered(voiceDsp);
  };
  // whether the tree's routes move the pitch of an oscillator (Semi and Fine as targets of its facade; another one
  // leaves such a route out, its voice has no modulation): a block of a voice a route takes an octave up against
  // one without
  const pitchRoutes =
    !!oscScope &&
    (() => {
      const blockOf = (routes) => {
        createVoice
          .wasm({
            osc: [{ table: 'a', unison: 1, phase: 0, phaseRand: 0 }, null],
            start: 0,
            envelopes: [flat, flat, flat],
            envStart: 0,
            phrase: 0,
            routes,
            filter: null,
          })
          .process(0, held, outL, outR);
        return outL.slice();
      };
      const up = blockOf([{ source: 1, param: 'pitch1', amount: 1200, min: -12000, max: 12000 }]);
      return blockOf([]).some((sample, i) => sample !== up[i]);
    })();
  // a position that moves in every block: the direct path. Its blocks over a period of the LFO (2 s) are worked
  // out once, not in the call: making them there (Float32Array.from, 128 sines) cost 34 ns/sample, more than the
  // core itself
  const moving = { ...held };
  const PERIOD = (2 * RATE) / BLOCK;
  const positions = Array.from({ length: PERIOD }, (_, block) =>
    Float32Array.from(
      { length: BLOCK },
      (_, i) => 0.5 + 0.5 * Math.sin(2 * Math.PI * (((block * BLOCK) / RATE) * 0.5 + i / RATE / 2))
    )
  );
  const movingPosition = (frameAt) => {
    moving.position1 = positions[(frameAt / BLOCK) % PERIOD];
    return moving;
  };
  // the effects over noise, block by block
  const effect = (create, source) => () => {
    const process = create();
    let at = 0;
    const inL = new Float32Array(BLOCK);
    const inR = new Float32Array(BLOCK);
    return () => {
      inL.set(source.subarray(at, at + BLOCK));
      inR.set(source.subarray(at, at + BLOCK));
      process(inL, inR, outL, outR);
      at = (at + BLOCK) % (source.length - BLOCK);
    };
  };
  // a chain with `kinds` playing (the knobs of the heavy patch), `moved`: by the LFOs
  const DELAY = { time: 0.2, fb: 0.5, mode: 0, pan: 0, freq: 1000, q: 0.01 };
  // the slots by kind (a tree before the EQ or the filter reads the first ones: their slots are never in its order),
  // the effects of the cases of every effect (the same in a tree before them: their own cases compare them)
  const SLOT_KINDS = ['distortion', 'chorus', 'delay', 'compressor', 'reverb', 'eq', 'fxfilter'];
  const CHAIN_KINDS = SLOT_KINDS.slice(0, 5);
  // the EQ of the cases: a peak of band 1 and a high shelf of band 2 (both bands render)
  const EQ = { t1: 1, f1: 400, q1: 50, g1: 6, t2: 0, f2: 6000, q2: 60, g2: -4, level: 0.5 };
  // the filter of the cases: MG Low 24 driven, resonant (its saturating sections, the curve of Drive), all wet; its
  // keys in the order of the core
  const FXFILTER = { type: 3, cutoff: 1200, res: 50, drive: 30, var: 0, pan: 50, level: 0.5, mix: 1 };
  // a filter of FXFILTER but `params` alone
  const fxfilterOf =
    (params = {}) =>
    () =>
      dsp.createFxFilterWasm(dsp.wasm.fxfilter, RATE, { params: { ...FXFILTER, ...params } }).process;
  // the state of a chain of `kinds` in this order, `moved`: its knobs by LFOs (of `period` seconds)
  const chainStateOf = (kinds, moved = false, period = 0.31) => {
    const neutral = {
      distortion: { mode: 0, drive: 8, tone: 20000, level: 0 },
      chorus: { rate: 0.078, d1: 5, d2: 0, depth: 26, fb: 0.095, cut: 1000, hpf: 0, level: 0.5, mix: 0.5 },
      delay: DELAY,
      compressor: {
        ...{ multi: 0, thresh: 0.6, ratio: 4, attack: 90, release: 90, gain: 0, xlow: 131, xhigh: 2500 },
        ...{ below: 0, low: 0, mid: 0, high: 0, level: 0.5, mix: 1 },
      },
      reverb: { ...REVERB, decay: 3 },
      eq: EQ,
      fxfilter: FXFILTER,
    };
    const mixes = { distortion: 1, chorus: 0.5, delay: 0.3, compressor: 1, reverb: 0.3, eq: 1, fxfilter: 1 };
    const target = (kind, key) =>
      SLOT_KINDS.indexOf(kind) * 32 + (key === 'mix' ? 31 : Object.keys(neutral[kind]).indexOf(key));
    const lfo = {
      mode: 1,
      delay: 0,
      rise: 0,
      smooth: 0,
      phase: 0,
      anchor: { time: 0, phase: 0, period },
    };
    // `moved` as a list: the routes of its rows [effect, knob, source, amount, min, max, scale] and no more
    const listed = Array.isArray(moved)
      ? moved.map(([kind, key, source, amount, min, max, scale]) => ({
          target: target(kind, key),
          source,
          amount,
          min,
          max,
          ...(scale && { scale }),
        }))
      : [];
    return {
      slots: Object.fromEntries(
        SLOT_KINDS.map((kind) => [
          kind,
          { params: neutral[kind], mix: mixes[kind], active: kinds.includes(kind) },
        ])
      ),
      order: kinds.map((kind) => SLOT_KINDS.indexOf(kind)),
      masterGain: 1,
      muted: false,
      routes:
        moved === true
          ? [
              { target: target('distortion', 'level'), source: 4, amount: -6, min: -24, max: 12 },
              { target: target('compressor', 'thresh'), source: 5, amount: 0.3, min: 0, max: 1 },
              { target: target('delay', 'time'), source: 6, amount: 0.01, min: 0.01, max: 1 },
              { target: target('reverb', 'mix'), source: 7, amount: 0.4, min: 0, max: 1 },
              // (the lines of the EQ: its bands designed every 32 samples)
              ...(kinds.includes('eq')
                ? [
                    {
                      target: target('eq', 'f1'),
                      source: 4,
                      amount: 1.5,
                      min: 21.53,
                      max: 20000,
                      scale: 'log',
                    },
                    { target: target('eq', 'g2'), source: 5, amount: 12, min: -24, max: 24 },
                  ]
                : []),
            ]
          : listed,
      note: null,
      lfos: moved ? { at: 0, instantly: true, lfos: [lfo, lfo, lfo, lfo] } : null,
      meters: [],
    };
  };
  // the routes of the cases of one effect with LFOs: [effect, knob, source (4, 5: LFO 1, 2), amount, min, max,
  // scale]; the knobs that are lines of the core (the delay, the EQ) and those it takes a value a block
  const OWN_ROUTES = {
    distortion: [
      ['distortion', 'drive', 4, 4, 0, 12],
      ['distortion', 'level', 5, -6, -24, 12],
    ],
    chorus: [
      ['chorus', 'depth', 4, 10, 0, 26],
      ['chorus', 'd1', 5, 8, 0, 20],
    ],
    delay: [
      ['delay', 'time', 4, 0.01, 0.01, 1],
      ['delay', 'fb', 5, 0.3, 0, 0.9],
    ],
    compressor: [
      ['compressor', 'thresh', 4, 0.3, 0, 1],
      ['compressor', 'ratio', 5, 10, 1, 30],
    ],
    reverb: [
      ['reverb', 'decay', 4, 2, 0.1, 20],
      ['reverb', 'size', 5, 0.3, 0, 1],
    ],
    eq: [
      ['eq', 'f1', 4, 1.5, 21.53, 20000, 'log'],
      ['eq', 'g2', 5, 12, -24, 24],
    ],
    // (the cutoff swept by an LFO: the designs of its cells; the resonance by another: a design a span)
    fxfilter: [
      ['fxfilter', 'cutoff', 4, 1.5, 8.176, 22050, 'log'],
      ['fxfilter', 'res', 5, 30, 0, 100],
    ],
  };
  const chainOf =
    (kinds, source, moved = false, limited = true, period) =>
    () => {
      const chain = dsp.createChainWasm(dsp.wasm.chain, RATE, chainStateOf(kinds, moved, period), {
        limited,
      });
      let at = 0;
      let frame = 0;
      const inL = new Float32Array(BLOCK);
      const inR = new Float32Array(BLOCK);
      return () => {
        inL.set(source.subarray(at, at + BLOCK));
        inR.set(source.subarray(at, at + BLOCK));
        chain.process(inL, inR, outL, outR, frame);
        at = (at + BLOCK) % (source.length - BLOCK);
        frame += BLOCK;
      };
    };
  // the whole node of a tree that has it in one core: the chord of `scope chord attack` struck every ATTACK blocks
  // (its voices made again, the chain kept: its tails sound on) through a chain. `engine …`: one block of the core,
  // the voices summed into the input of the chain inside it (what the node of the worklet runs); `two calls …`: the
  // voices into JS, then into the chain (the two nodes of a tree before the engine, without what the graph cost
  // between them)
  const engineOf = (kinds, whole) => () => {
    const shared = createShared.wasm();
    const { exports } = oscScope;
    const chain = dsp.createChainWasm(dsp.wasm.chain, RATE, chainStateOf(kinds));
    const at = exports.chain_buffers(chain.handle, BLOCK);
    const [midL, midR] = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    let [viewL, viewR] = [new Float32Array(0), new Float32Array(0)];
    let voices = null;
    let engine = 0;
    let block = 0;
    return () => {
      if (block % ATTACK === 0) {
        if (engine) exports.engine_free(engine);
        voices?.free();
        voices = dsp.createVoiceScopeWasm(oscScope, RATE, wasmStore, shared);
        scopeNotes(voices);
        engine = whole ? exports.engine_new(voices.handle, wasmStore.handle, shared.handle, chain.handle) : 0;
      }
      if (whole) {
        const flags = exports.engine_process(engine, block * BLOCK);
        // (the views of the facade: made again when the memory grew)
        if (viewL.buffer !== exports.memory.buffer) {
          viewL = new Float32Array(exports.memory.buffer, at + 8 * BLOCK, BLOCK);
          viewR = new Float32Array(exports.memory.buffer, at + 12 * BLOCK, BLOCK);
        }
        outL.set(viewL);
        outR.set(viewR);
        if (flags & 1) voices.reports();
      } else {
        voices.process(block * BLOCK, midL, midR);
        voices.reports();
        chain.process(midL, midR, outL, outR, block * BLOCK);
        chain.reports();
      }
      block++;
    };
  };
  const input = noise(RATE, 0.5);
  const hits = input.map((value, i) => (i % (RATE / 5) < RATE / 20 ? value : 0));
  // (a threshold the noise is over)
  const COMPRESSOR = {
    multi: 0,
    thresh: 0.6,
    ratio: 4,
    attack: 90,
    release: 90,
    gain: 0,
    xlow: 131,
    xhigh: 2500,
    below: 0,
    low: 0,
    mid: 0,
    high: 0,
    level: 0.5,
    mix: 1,
  };
  // a fresh chorus
  const CHORUS = { rate: 0.078, d1: 5, d2: 0, depth: 26, fb: 0.095, cut: 1000, hpf: 0, level: 0.5, mix: 0.5 };
  const distortionParams = (mode) => ({ params: { mode, drive: 8, tone: 20000, level: 0 } });
  return {
    ...withTs(
      {
        'voice u1 held': [[1, null], held],
        'voice u8 held': [[8, null], held],
        'voice 2 × u8 held': [[8, 8], held],
        'voice u8 moving position': [[8, null], movingPosition],
        'voice u8 moving position, 256 frames': [[8, null], movingPosition, 'b'],
      },
      oscScope && voiceOf('wasm'),
      store && voiceOf('ts')
    ),
    // its cost over `voice u8 held`: the noise of a note
    ...withTs({ 'voice u8 + noise': [[8, null], held] }, noisy && noiseVoiceOf(0), null),
    ...withTs({ 'voice u8 + noise up 4': [[8, null], held] }, noisy && noiseVoiceOf(400), null),
    ...withTs({ 'voice u8 + noise up 7': [[8, null], held] }, noisy && noiseVoiceOf(700), null),
    ...withTs({ 'voice u8 + noise up 19': [[8, null], held] }, noisy && noiseVoiceOf(1900), null),
    ...withTs({ 'voice u8 + noise, mono': [[8, null], held] }, noisy && noiseVoiceOf(0, 'm'), null),
    // its cost over `voice u8 held` (the sine of the store, a shape) and over `voice u8 glide` (the pitch at its points)
    ...withTs({ 'voice u8 + sub': [[8, null], held] }, subbed && subVoiceOf(null), null),
    ...withTs({ 'voice u8 + sub saw': [[8, null], held] }, subbed && subVoiceOf('sub:saw'), null),
    ...withTs({ 'voice u8 glide': [[8, null], gliding] }, subbed && voiceOf('wasm'), null),
    ...withTs({ 'voice u8 + sub glide': [[8, null], gliding] }, subbed && subVoiceOf('sub:saw'), null),
    // blend, width (the channels of the oscillator and their pan), a stack and a position spread (a frame per
    // voice); its cost over `voice u8 held` (the blend a param of the oscillator, of a tree before it in the shape)
    ...withTs(
      { 'voice u8 shaped unison': [[8, null], constant({ ...BASE, blend1: 0.75 })] },
      oscScope &&
        voiceOf('wasm', { blend: 0.75, width: 0.5, stack: '12+7x2', detune: 'linear', positionSpread: 0.3 }),
      null
    ),
    // a note of QWERTY or the piano (velocity 100) at Amp 1: the amp of its velocity 0.787; its cost over `voice u1
    // held`
    ...withTs(
      { 'voice u1 velocity': [[1, null], held] },
      oscScope && voiceOf('wasm', undefined, { level: 0.787, amp: 0.787 }),
      null
    ),
    ...withTs({ 'voice u8 pitch env': [] }, pitchRoutes && (() => pitchEnv), null),
    ...withTs(
      { 'voice u1 routed': [] },
      oscScope && (() => routedOf('wasm')),
      store && (() => routedOf('ts'))
    ),
    ...(modelFilters && { 'voice u1 routed low12': routedOf('wasm', true) }),
    ...withTs(
      { 'voice chord attack': [] },
      oscScope && (() => chordOf('wasm')),
      store && (() => chordOf('ts'))
    ),
    ...(dsp.createVoiceScopeWasm && { 'scope chord attack': scopeChordOf() }),
    // the warp of the oscillators (warp.rs: a pass of the phases of a span through its map, the loops read them; a
    // tree before it: none): Bend + at 0.6 (no levels up), PWM at 0.5 (its slope 2: three levels up), Bend - at 0.8
    // and Bend +/- at 0.9 (their levels by the slope of each sample; still: a warped mix of each voice), Bend + and PWM
    // moved by LFO 1 (its param a line in each segment, the voice directly), the chord with both oscillators bent
    ...(oscScope &&
      dsp.warp && {
        'voice u8 warp bend': voiceOf('wasm', undefined, undefined, { warpMode: 1, warp: 0.6 })(
          [8, null],
          held
        ),
        'voice u8 warp pwm': voiceOf('wasm', undefined, undefined, { warpMode: 4, warp: 0.5 })(
          [8, null],
          held
        ),
        'voice u8 warp bend-': voiceOf('wasm', undefined, undefined, { warpMode: 2, warp: 0.8 })(
          [8, null],
          held
        ),
        'voice u8 warp bend+-': voiceOf('wasm', undefined, undefined, { warpMode: 3, warp: 0.9 })(
          [8, null],
          held
        ),
        // every mode at a low, a middle and a high knob (PWM reads its levels up by the slope, a bend of a < 0 by each
        // sample)
        ...Object.fromEntries(
          WARP_BENCH_MODES.flatMap(([label, warpMode]) =>
            WARP_BENCH_KNOBS.map((warp) => [
              `voice u8 warp ${label} k${warp}`,
              voiceOf('wasm', undefined, undefined, { warpMode, warp })([8, null], held),
            ])
          )
        ),
        ...(dsp.createVoiceScopeWasm && {
          'scope chord warp bend': scopeChordOf({ warpMode: 1, warp: 0.6 }),
          ...Object.fromEntries(
            WARP_BENCH_MODES.filter(([, warpMode]) => warpMode > 1).map(([label, warpMode]) => [
              `scope chord warp ${label}`,
              scopeChordOf({ warpMode, warp: 0.6 }),
            ])
          ),
        }),
      }),
    // (a tree before the pitch bend: none)
    ...(oscScope?.exports.osc_scope_bend && { 'scope chord bend': scopeChordBend }),
    // (a tree before the LFOs: none; before the pitch as a target: no vibrato)
    ...(oscScope?.exports.osc_shared_lfos &&
      dsp.lfoTable && {
        'voice u8 lfo wave': lfoVoiceOf('position1', 1),
        ...(dsp.warp && {
          'voice u8 warp lfo': lfoVoiceOf('warp1', 0.4, { min: 0, max: 1, bipolar: true }, 0.5, held, {
            warpMode: 1,
            warp: 0.5,
          }),
          'voice u8 warp pwm lfo': lfoVoiceOf('warp1', 0.4, { min: 0, max: 1, bipolar: true }, 0.5, held, {
            warpMode: 4,
            warp: 0.5,
          }),
          // every mode under the LFO at four speeds, the knob 0.1 … 0.9 (a sine of 1 / Hz seconds)
          ...Object.fromEntries(
            WARP_BENCH_MODES.flatMap(([label, warpMode]) =>
              WARP_BENCH_HZ.map((hz) => [
                `voice u8 warp ${label} lfo ${hz} Hz`,
                lfoVoiceOf('warp1', 0.4, { min: 0, max: 1, bipolar: true }, 1 / hz, held, {
                  warpMode,
                  warp: 0.5,
                }),
              ])
            )
          ),
        }),
        'voice u8 lfo gain': lfoVoiceOf('gain1', -0.5),
        // (the centre voices apart from the others, each group × its gain per sample: on their mix tables)
        ...(dsp.VOICE_PARAM_ORDER?.includes('blend1') && {
          'voice u8 lfo blend': lfoVoiceOf('blend1', 1, { min: 0, max: 1, bipolar: true }),
        }),
        ...(pitchRoutes && {
          'voice u8 lfo fine': lfoVoiceOf('fine1', 100, { min: -100, max: 100, bipolar: true }, 0.2),
          'voice u8 lfo fine, crossfade': lfoVoiceOf(
            'fine1',
            100,
            { min: -100, max: 100, bipolar: true },
            0.2,
            crossfade
          ),
        }),
        'scope chord lfo cutoff': scopeChordLfoOf(true, true),
        'scope chord lfo cutoff, no filter': scopeChordLfoOf(false, true),
        'scope chord filter': scopeChordLfoOf(true, false),
        // the model types of the filter (a tree that has them): Low 12 next to the lowpass it replaces, Low 24, Ladder
        // 24 with Drive and FAT; at rest and under the LFO (their design every 32 samples). Low 12 at Res 60: its
        // resonance saturates, four voices in one loop at rest (`interleaves` of filter.rs)
        ...(modelFilters && {
          'scope chord filter low12': scopeChordLfoOf(true, false, LOW12),
          'scope chord filter low12 res 60': scopeChordLfoOf(true, false, { ...LOW12, resonance: 60 }),
          'scope chord lfo cutoff low12': scopeChordLfoOf(true, true, LOW12),
          'scope chord filter low24': scopeChordLfoOf(true, false, { ...LOW12, type: 'low24' }),
          'scope chord filter ladder24 drive fat': scopeChordLfoOf(true, false, LADDER24),
          'scope chord lfo cutoff ladder24 drive fat': scopeChordLfoOf(true, true, LADDER24),
        }),
      }),
    'build 256 frames': {
      build: () => {
        const start = process.hrtime.bigint();
        dsp.buildLevels(frames);
        return Number(process.hrtime.bigint() - start) / 1e6;
      },
    },
    // the store takes a table of 256 frames no buffer of its pool holds (a store of its own): its begin and its
    // first chunk, on the audio thread (a tree that zeroes the whole table in begin: 0.75 ms on memory the
    // allocator had, 4.2 on new memory; the first sample of a side is the new memory)
    ...(oscScope && {
      'store begin 64 MiB, a miss of the pool': {
        build: () => {
          const tables = dsp.createTableStoreWasm(oscScope);
          const start = process.hrtime.bigint();
          const slot = tables.begin('b', 1, TABLE_256);
          tables.write(slot, 0, CHUNK);
          const ms = Number(process.hrtime.bigint() - start) / 1e6;
          tables.commit(slot);
          tables.free();
          return ms;
        },
      },
    }),
    ...withTs(
      { reverb: [input] },
      dsp.wasm.reverb &&
        ((source) =>
          effect(() => dsp.createReverbWasm(dsp.wasm.reverb, RATE, { params: REVERB }).process, source)),
      dsp.createReverbDsp &&
        ((source) => effect(() => dsp.createReverbDsp(RATE, { params: REVERB }).process, source))
    ),
    // no modulation: the delays of the lines at rest; the 70s era: its tube and its bandwidth
    ...withTs(
      {
        'reverb depth 0': [{ ...REVERB, depth: 0 }],
        'reverb 70s': [{ ...REVERB, drive: 0.15, bandwidth: 6500, body: 2 }],
      },
      dsp.wasm.reverb &&
        ((params) => effect(() => dsp.createReverbWasm(dsp.wasm.reverb, RATE, { params }).process, input)),
      null
    ),
    ...withTs(
      { 'distortion soft': [0], 'distortion hard': [1] },
      dsp.wasm.distortion &&
        ((mode) =>
          effect(
            () => dsp.createDistortionWasm(dsp.wasm.distortion, RATE, distortionParams(mode)).process,
            input
          )),
      dsp.createDistortionDsp &&
        ((mode) => effect(() => dsp.createDistortionDsp(RATE, distortionParams(mode)).process, input))
    ),
    // a fresh chorus (a slow, deep LFO), then a fast one with a high feedback
    ...withTs(
      { chorus: [{}], 'chorus fast': [{ rate: 6, depth: 2, fb: 0.8, cut: 8000 }] },
      dsp.wasm.chorus &&
        ((params) =>
          effect(
            () => dsp.createChorusWasm(dsp.wasm.chorus, RATE, { params: { ...CHORUS, ...params } }).process,
            input
          )),
      null
    ),
    // one band, then three (compressed down; down and up): over the noise, so they compress all the time; then
    // hits of the noise after silences (50 ms every 200 ms): the gains of every sample of a hit, the bands lifted
    // to the ceiling between them
    ...withTs(
      {
        compressor: [{}],
        'compressor multiband': [{ multi: 1 }],
        'compressor multiband up': [{ multi: 1, below: 1 }],
        'compressor multiband hits': [{ multi: 1, below: 1 }, hits],
      },
      dsp.wasm.compressor &&
        ((params, source = input) =>
          effect(
            () =>
              dsp.createCompressorWasm(dsp.wasm.compressor, RATE, { params: { ...COMPRESSOR, ...params } })
                .process,
            source
          )),
      null
    ),
    ...withTs(
      {
        // silence: the limiter skips its blocks once it has let go
        'limiter silent': [new Float32Array(RATE)],
        // under the bound of its true peaks: the samples alone
        'limiter quiet': [noise(RATE, 0.05)],
        // over it, under the ceiling: the 4× interpolation of both sides
        'limiter loud': [noise(RATE, 0.4)],
        'limiter limiting': [noise(RATE, 2)],
      },
      dsp.wasm.limiter &&
        ((source) => effect(() => dsp.createLimiterWasm(dsp.wasm.limiter, RATE).process, source)),
      dsp.createLimiterDsp && ((source) => effect(() => dsp.createLimiterDsp(RATE).process, source))
    ),
    // the EQ alone: both bands (a peak and a shelf), at rest (its shelves at 0 dB: nothing rendered); in a chain,
    // its bands moved by LFOs (designed every 32 samples, their coefficients lines)
    ...(dsp.wasm.eq && {
      eq: effect(() => dsp.createEqWasm(dsp.wasm.eq, RATE, { params: EQ }).process, input),
      'eq neutral': effect(
        () =>
          dsp.createEqWasm(dsp.wasm.eq, RATE, {
            params: { ...EQ, t1: 0, f1: 210, q1: 60, g1: 0, f2: 2040, g2: 0 },
          }).process,
        input
      ),
    }),
    ...(dsp.wasm.eq &&
      dsp.wasm.chain && {
        'chain eq': chainOf(['eq'], input),
        'chain eq, lfos': chainOf(['eq'], input, true),
      }),
    // the filter alone: MG Low 24 driven and resonant (FXFILTER), Low 12 of the plain sections, the channels apart
    // (Pan), at rest; in a chain its cutoff alone under an LFO (`fx fxfilter, cutoff lfo`: the cells of its designs)
    // and with its resonance (`fx fxfilter, lfos`: a design a span)
    ...(dsp.wasm.fxfilter && {
      'fxfilter ladder24 drive': effect(fxfilterOf(), input),
      'fxfilter low12': effect(fxfilterOf({ type: 5, res: 20, drive: 0 }), input),
      'fxfilter low12 pan': effect(fxfilterOf({ type: 5, res: 20, drive: 0, pan: 25 }), input),
      'fxfilter at rest': effect(fxfilterOf(), new Float32Array(RATE)),
    }),
    ...(dsp.wasm.fxfilter &&
      dsp.wasm.chain && {
        'fx fxfilter, cutoff lfo': chainOf(['fxfilter'], input, [OWN_ROUTES.fxfilter[0]], false),
        'fx fxfilter pan, cutoff lfo': chainOf(
          ['fxfilter'],
          input,
          [OWN_ROUTES.fxfilter[0], ['fxfilter', 'pan', 5, 30, 0, 100]],
          false
        ),
      }),
    // the delay of the chain core alone: its echoes held (a copy and a pass of lanes), then its Time on the way;
    // a sound from an odd sample (the first sample of every block the second of a pair of its bandpass)
    ...(dsp.wasm.delay && {
      delay: effect(() => dsp.createDelayWasm(dsp.wasm.delay, RATE, DELAY).process, input),
      'delay from an odd sample': effect(
        () => dsp.createDelayWasm(dsp.wasm.delay, RATE, DELAY).process,
        input.map((value, i) => (i === 0 ? 0 : value))
      ),
      'delay ping-pong, a channel late': effect(
        () => dsp.createDelayWasm(dsp.wasm.delay, RATE, { ...DELAY, mode: 1, pan: 0.01 }).process,
        input
      ),
    }),
    // the whole chain of a tree that has it in one core (what the node of the worklet runs a block): the heavy
    // patch of the browser cases (S5: distortion, delay, reverb), every effect, the same with the knobs moved by
    // LFOs (the level of the distortion and the threshold of the compressor a block, the time of the delay and the
    // mix of the reverb a sample), a chain at rest
    ...(dsp.wasm.chain && {
      'chain S5': chainOf(['distortion', 'delay', 'reverb'], input),
      'chain every effect': chainOf(CHAIN_KINDS, input),
      'chain every effect, lfos': chainOf(CHAIN_KINDS, input, true),
      'chain no effect': chainOf([], input),
      'chain at rest': chainOf(CHAIN_KINDS, new Float32Array(RATE)),
      // each effect alone in the chain, without its limiter (what it costs follows the level it is given): at rest,
      // with two routes on its own knobs (`OWN_ROUTES`) and with one on its mix (a line a sample of its slot): the
      // cost of one against the others, and what LFOs add to it
      'fx none': chainOf([], input, false, false),
      ...Object.fromEntries(
        // (a kind after those of the chain of every tree: where the tree has its core)
        SLOT_KINDS.filter((kind) => CHAIN_KINDS.includes(kind) || dsp.wasm[kind]).flatMap((kind) => [
          [`fx ${kind}`, chainOf([kind], input, false, false)],
          [`fx ${kind}, lfos`, chainOf([kind], input, OWN_ROUTES[kind], false)],
          [`fx ${kind}, lfo mix`, chainOf([kind], input, [[kind, 'mix', 4, 0.4, 0, 1]], false)],
        ])
      ),
      // the delay under one LFO on its Time (10 ms), slow (0.2 Hz) and fast (20 Hz): its reads between two samples
      // and the pole of its routes, whatever the rate
      'fx delay, slow lfo on time': chainOf(
        ['delay'],
        input,
        [['delay', 'time', 4, 0.01, 0.01, 1]],
        false,
        5
      ),
      'fx delay, fast lfo on time': chainOf(
        ['delay'],
        input,
        [['delay', 'time', 4, 0.01, 0.01, 1]],
        false,
        0.05
      ),
    }),
    ...(dsp.createEngineWasm &&
      oscScope && {
        'engine chord S5': engineOf(['distortion', 'delay', 'reverb'], true),
        'two calls chord S5': engineOf(['distortion', 'delay', 'reverb'], false),
        'engine chord, no effect': engineOf([], true),
        'two calls chord, no effect': engineOf([], false),
      }),
  };
};

// the cases of a module: with its wasm core they run it (an A/B run against a tree without it compares the cores),
// with its TS core too as '<case> (ts)' (a tree of the port, before stage 5), with the TS core alone that one
const withTs = (sources, wasm, ts) =>
  Object.fromEntries(
    Object.entries(sources).flatMap(([name, args]) => [
      ...(wasm ? [[name, wasm(...args)]] : []),
      ...(ts ? [[wasm ? `${name} (ts)` : name, ts(...args)]] : []),
    ])
  );

// `reference`: the worktree of the reference of an A/B run (reference.mjs), its samples alternate with ours;
// `names`: the cases whose name has one of them alone (--dsp=reverb,chord)
export const runDspBenchmarks = async ({ reference = null, names = null } = {}) => {
  const current = createCases(await loadDsp(undefined, 'dsp'));
  let other = null;
  let referenceError = null;
  if (reference) {
    try {
      other = createCases(await loadDsp(reference.dir, `dsp-${reference.short}`));
    } catch (error) {
      referenceError = error.message;
    }
  }
  const calibration = calibrate();
  const cases = {};
  for (const [name, kase] of Object.entries(current)) {
    if (names && !names.some((part) => name.includes(part))) continue;
    const theirs = other?.[name];
    const build = 'build' in kase;
    const sides = [kase, theirs].filter(Boolean);
    let samples;
    try {
      samples = build
        ? alternate(
            sides.map(({ build: run }) => run),
            (run) => run(),
            (run) => run()
          )
        : measure(sides.map((create) => create()));
    } catch (error) {
      // an API the reference doesn't have: ours alone
      if (sides.length < 2) throw error;
      samples = build
        ? alternate(
            [kase.build],
            (run) => run(),
            (run) => run()
          )
        : measure([kase()]);
      samples.push(null);
      referenceError ??= `${name}: ${error.message}`;
    }
    // ns per sample divided by the ns of a multiply-add; the build: its ns
    const unit = build ? 'ms' : 'ns/sample';
    const ns = (sample) => (build ? sample * 1e6 : sample / BLOCK);
    const side = (values) =>
      values && {
        value: median(values.map((sample) => (build ? sample : sample / BLOCK))),
        normalized: median(values.map((sample) => ns(sample) / calibration.ns)),
        samples: values.map((sample) => ns(sample) / calibration.ns),
      };
    cases[name] = { unit, ...side(samples[0]), ...(samples[1] && { reference: side(samples[1]) }) };
  }
  return {
    node: process.versions.node,
    calibration: calibration.ns,
    cases,
    ...(reference && { reference: { sha: reference.short, error: referenceError } }),
  };
};
