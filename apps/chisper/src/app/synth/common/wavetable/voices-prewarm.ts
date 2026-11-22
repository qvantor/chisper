import { lfoTable, LfosState, RETRIG } from '../lfo/lfo-curve';
import type {
  VoiceEvent,
  VoiceFilterOptions,
  VoiceOptions,
  VoiceOscOptions,
  VoiceWarpKnobs,
} from './voice-options';
import { noiseLevels } from './noise-layout';
import { createLevels, levelBase } from './wavetable-levels';
import { VOICE_PARAMETERS, VoiceParam } from './wavetable-osc-params';
import {
  createTableStoreWasm,
  createVoiceScopeWasm,
  createVoiceSharedWasm,
  createVoiceWasm,
  OscScope,
  TableStoreWasm,
  VoiceSharedWasm,
} from './wavetable-osc-wasm';

// what renders the voices of the warm-up in a node: the scope of the voices alone, or the engine they play in (its
// block is another function of the core: the one the node calls is the one to compile)
export interface WarmVoices {
  apply: (events: VoiceEvent[]) => void;
  process: (frame: number, outL: Float32Array, outR: Float32Array) => unknown;
  reports: () => unknown;
  free: () => void;
}
export type WarmVoicesFactory = (store: TableStoreWasm, shared: VoiceSharedWasm) => WarmVoices;

// the functions of a block compile lazily, on their first call: while the module loads, a voice of both
// oscillators (a table of 2 frames and the placeholder sine) on a store and a shared of its own renders a moving
// position (the direct path, the fades from a frame into the other at three pitches, the filter, a route of an
// envelope (on the blends too: their centre voices apart), of the velocity and of an LFO, its amp, the routes of the
// knobs of the LFO: a new Phase glides, a new shape crossfades), then a steady one (the mix builds, the pairs), and
// is freed with them (the first block of the first note 0.014 ms instead of 0.93 in Node, the module 2 ms longer:
// before the first note); then the same through the warp of both oscillators (`WARM_WARPED`: a bend and PWM, their
// knobs still: the pass of the phases of each, the loops that read them, of one level and of two, the fades of the
// frames, the mix); then PWM alone under a knob that moves as its pitch sweeps (`WARM_CUT`: its levels cut); then
// the same voice in a scope of voices, its params from events (a step, a target and
// ramps: the curves of the timelines), its velocity gliding to another one, bent (the pitch bend of the node,
// gliding), stolen at its end. Its noise: a stereo loop of silence of two levels and the pair under Pitch Track, its
// pitch moved by ENV 2 (the steps at the points, a change of kernel and of level crossfading), then in the scope a
// mono one-shot an octave down (the pair), its knobs changed (up: into the bank, crossfading). Its sub: frame 0 of
// the table of the oscillators, panned, its Coarse moved by ENV 2 (its levels read alone and blended, of one length
// and of two), then in the scope in the centre (its steady loop), Contiguous, its knobs changed (the level glides).
// In the scope its oscillators warped (the bend, PWM on the sine), the knob of the bend moved by ENV 2 (a route),
// then their knobs changed (both glide: the passes of a moving knob; PWM into Bend -: a new mode on a note
// crossfades).
// After it in the scope, voices of a sine whose filters take each path of a node (`WARM_FILTERS`)
const WARM_ENVELOPE = { attack: 0.001, hold: 0, decay: 0.01, sustain: 0.5, release: 0.01 };
const WARM_OSC: VoiceOscOptions = { table: 'warm', unison: 4, phase: 0.5, phaseRand: 1 };
const WARM_SINE: VoiceOscOptions = { table: '', unison: 3, phase: 0, phaseRand: 0 };
const WARM_VOICE: VoiceOptions = {
  osc: [WARM_OSC, WARM_SINE],
  noise: {
    sample: 'warm-noise',
    loop: true,
    keytrack: true,
    start: 0.9,
    rand: 0.5,
    level: 0.5,
    pan: 0.3,
    cents: 1500,
  },
  sub: { table: 'warm', phase: 0.25, contiguous: false, level: 0.5, pan: 0.3, cents: -1200 },
  start: 0,
  envelopes: [WARM_ENVELOPE, WARM_ENVELOPE, WARM_ENVELOPE],
  envStart: 0,
  phrase: -1,
  routes: [
    { source: 1, param: 'gain1', amount: -0.5, min: 0, max: 1 },
    { source: 3, param: 'gain2', amount: 0.25, min: 0, max: 1 },
    // (LFO 1 on a gain: the voice stays on its mix tables)
    { source: 4, param: 'gain1', amount: 0.25, min: 0, max: 1 },
    // (ENV 2 on the blends: they move, the centre voices apart from the others, of an even unison and an odd one)
    { source: 1, param: 'blend1', amount: 0.5, min: 0, max: 1 },
    { source: 1, param: 'blend2', amount: -0.25, min: 0, max: 1 },
    { source: 1, param: 'lfo1.rate', amount: 0.5, min: 1 / 32, max: 100, scale: 'log' },
    { source: 1, param: 'lfo1.smooth', amount: 0.25, min: 0, max: 1, scale: 'pow' },
    { source: 1, param: 'lfo1.phase', amount: 0.25, min: 0, max: 1 },
    { source: 1, param: 'noise.pitch', amount: 600, min: -4800, max: 4800 },
    { source: 3, param: 'noise.level', amount: 0.25, min: 0, max: 1 },
    { source: 1, param: 'sub.crs', amount: 700, min: -6400, max: 6400 },
  ],
  filter: { type: 'lowpass', cutoff: 4000, resonance: 3, gain: 0, drive: 0, variation: 0 },
  velocity: { level: 0.5, amp: 0.75 },
};
// the modes of the warp (warp.rs, by their index in WARP_MODES of the presets)
const BEND_UP = 1;
const BEND_DOWN = 2;
const PWM = 4;
// the warp of the oscillators of the warm-up (in the scope): a bend whose levels stay (Bend +: its mixes play) and
// PWM, at knobs that warp; then their knobs changed: both move through their one-pole (the edge of PWM a line), PWM
// into Bend - (its levels sample by sample as its knob moves)
const WARP_OF = [
  { warpMode: BEND_UP, warp: 0.5 },
  { warpMode: PWM, warp: 0.5 },
];
const WARM_WARP_KNOBS: VoiceWarpKnobs = { mode1: BEND_UP, warp1: 0.75, mode2: BEND_DOWN, warp2: 0.25 };
// a voice of both oscillators of the table of 2 frames, nothing else: Bend + and Bend - at a still knob (the levels
// of Bend - sample by sample, as its frames fade too; once still, block 8, its warped mix built and read)
const WARM_WARPED: VoiceOptions = {
  ...WARM_VOICE,
  osc: [
    { warpMode: BEND_UP, warp: 0.5 },
    { warpMode: BEND_DOWN, warp: 0.6 },
  ].map((warp) => ({ table: 'warm', unison: 1, phase: 0, phaseRand: 0, ...warp })),
  noise: null,
  sub: null,
  routes: [],
  filter: null,
};
// a voice of PWM alone whose knob ENV 2 moves while its pitch sweeps four octaves a block: the levels of the warp
// jump over more than one in a segment, cut where they leave a crossfade (`render_cuts_warped` of voice.rs; the
// knob alone, through its one-pole, moves them a quarter of a level a segment at most)
const WARM_CUT: VoiceOptions = {
  ...WARM_WARPED,
  osc: [{ table: 'warm', unison: 1, phase: 0, phaseRand: 0, warpMode: PWM, warp: 0.5 }, null],
  routes: [{ source: 1, param: 'warp1', amount: 0.4, min: 0, max: 1 }],
};
// LFO 1 a square of 50 ms in its Delay for a block (a flat block), its Rise and Smooth; then another Phase (it
// glides: the bases of its knobs per sample) and another shape (a crossfade)
const warmLfos = (at: number, phase: number, shape: 'square' | 'triangle', instantly = false): LfosState => ({
  at,
  instantly,
  lfos: [0, 1, 2, 3].map((lfo) => ({
    mode: RETRIG,
    delay: lfo === 0 ? 0.003 : 0,
    rise: 0.005,
    smooth: 0.002,
    phase,
    anchor: { time: 0, phase: 0, period: 0.05 },
    ...(lfo === 0 && { table: lfoTable(shape) }),
  })),
});
// the filters of the voices after it, by the paths of a node: a Biquad (a pair of them with it in the lanes of one),
// two of a model type of one layout with Drive (a pair), four wide ones (a Ladder that saturates: two pairs in one
// loop, `interleaves` of filter.rs) and a Biquad after them. Their cutoff then glides by less than a cell a span (the
// designs of its cells) and the last Ladder changes its type (the crossfade, the other three in one loop)
const WARM_LADDER: VoiceFilterOptions = {
  type: 'ladder12',
  cutoff: 1500,
  resonance: 80,
  gain: 0,
  drive: 0,
  variation: 0,
};
const WARM_DRIVEN: VoiceFilterOptions = {
  type: 'low24',
  cutoff: 1500,
  resonance: 40,
  gain: 0,
  drive: 30,
  variation: 50,
};
// (the voices of the Ladders)
const WARM_LADDERS = [4, 5, 6, 7];
const WARM_FILTERS: VoiceFilterOptions[] = [
  { type: 'bandpass', cutoff: 2000, resonance: 2, gain: 0, drive: 0, variation: 0 },
  WARM_DRIVEN,
  WARM_DRIVEN,
  ...WARM_LADDERS.map(() => WARM_LADDER),
  { type: 'lowpass', cutoff: 4000, resonance: 3, gain: 0, drive: 0, variation: 0 },
];
const WARM_NOISE = WARM_VOICE.noise as NonNullable<VoiceOptions['noise']>;
const WARM_SUB = WARM_VOICE.sub as NonNullable<VoiceOptions['sub']>;
// (the kernels of the noise the warm store built go to `store`: built as the module loads, not with its first
// sample on the audio thread)
export const prewarmVoices = (
  scope: OscScope,
  store: TableStoreWasm,
  sampleRate: number,
  createVoices: WarmVoicesFactory = (warmStore, warmShared) =>
    createVoiceScopeWasm(scope, sampleRate, warmStore, warmShared)
) => {
  const warmStore = createTableStoreWasm(scope);
  const warmShared = createVoiceSharedWasm(scope);
  try {
    // two frames of silence of 32 harmonics, on levels of 1024 samples, of 512 from level 6: by the pitch a fade
    // between them reads one level (x = 1 + 3·log2(base·f / nyquist) below 0), two of one length (0.9) or of two
    // lengths (5.9), and the steady blocks at 5.9 build a mix of both (the short one upsampled: `add_to_mix`);
    // two only in the top LEVEL_BAND of a third of an octave (`level_x` of the core), below it a level alone
    warmStore.set('warm', 1, createLevels(2, 32));
    // (samples of silence: level 0, a one-shot level 1, a loop level 1, the pair)
    warmStore.set('warm-noise', 1, noiseLevels([256, 128, 128, 640, 512], 2, 44100, undefined, true));
    warmStore.set('warm-mono', 1, noiseLevels([256, 128, 128, 640, 512], 1, 44100, undefined, true));
    const pitches = [-1, 0.9, 5.9].map((x) => (sampleRate / 2 / levelBase(32)) * 2 ** ((x - 1) / 3));
    warmShared.setLfos(warmLfos(0, 0, 'square', true));
    const voice = createVoiceWasm(scope, sampleRate, WARM_VOICE, warmStore, Math.random, warmShared);
    const [outL, outR] = [new Float32Array(128), new Float32Array(128)];
    const params = Object.fromEntries(
      VOICE_PARAMETERS.map(({ name, defaultValue }) => [name, Float32Array.of(defaultValue)])
    ) as Record<VoiceParam, Float32Array>;
    params.spread1 = Float32Array.of(20);
    params.spread2 = Float32Array.of(10);
    // up and down across the frames at each pitch, a block apart (a fade lasts up to 5 ms), then still
    const up = Float32Array.from({ length: 128 }, (_, i) => i / 128);
    const down = up.map((value) => 1 - value);
    const position = (block: number) => (block < 6 ? (block % 4 < 2 ? up : down) : Float32Array.of(0.5));
    for (let block = 0; block < 10; block++) {
      if (block === 3) warmShared.setLfos(warmLfos((4 * 128) / sampleRate, 0.5, 'triangle'));
      params.frequency = Float32Array.of(pitches[Math.min(2, block >> 1)]);
      params.position1 = position(block);
      voice.process(block * 128, params, outL, outR);
    }
    voice.end();
    // (the same through the warp, the positions of both oscillators)
    const warped = createVoiceWasm(scope, sampleRate, WARM_WARPED, warmStore, Math.random, warmShared);
    for (let block = 0; block < 10; block++) {
      params.frequency = Float32Array.of(pitches[Math.min(2, block >> 1)]);
      params.position1 = params.position2 = position(block);
      warped.process(block * 128, params, outL, outR);
    }
    warped.end();
    // (PWM: up from the pitch of x = -1 four octaves, then down)
    const cut = createVoiceWasm(scope, sampleRate, WARM_CUT, warmStore, Math.random, warmShared);
    const sweep = Float32Array.from({ length: 128 }, (_, i) => pitches[0] * 2 ** ((4 * i) / 128));
    for (let block = 0; block < 2; block++) {
      params.frequency = block === 0 ? sweep : sweep.slice().reverse();
      cut.process(block * 128, params, outL, outR);
    }
    cut.end();
    const voices = createVoices(warmStore, warmShared);
    const at = (block: number) => (block * 128) / sampleRate;
    warmShared.setLfos(warmLfos(0, 0, 'square', true));
    warmShared.setLfos(warmLfos(at(2), 0.5, 'triangle'));
    const events: VoiceEvent[] = [
      {
        kind: 'on',
        voice: 0,
        options: {
          ...WARM_VOICE,
          osc: [WARM_OSC, WARM_SINE].map((osc, index) => ({ ...osc, ...WARP_OF[index] })),
          noise: { ...WARM_NOISE, sample: 'warm-mono', loop: false, keytrack: false, cents: -1200 },
          sub: { ...WARM_SUB, pan: 0, contiguous: true },
          routes: [...WARM_VOICE.routes, { source: 1, param: 'warp1', amount: 0.25, min: 0, max: 1 }],
        },
        params: { spread1: 20, spread2: 10 },
      },
      ...WARM_FILTERS.map((filter, index): VoiceEvent => ({
        kind: 'on',
        voice: index + 1,
        options: {
          ...WARM_VOICE,
          osc: [{ ...WARM_OSC, unison: 1 }, null],
          noise: null,
          sub: null,
          routes: [],
          filter,
        },
        params: {},
      })),
      { kind: 'set', voice: 0, param: 'frequency', value: 220, time: at(1) },
      { kind: 'ramp', voice: 0, param: 'frequency', value: 330, time: at(3) },
      { kind: 'cancel', voice: 0, param: 'position1', time: at(1) },
      { kind: 'target', voice: 0, param: 'position1', value: 0.5, time: at(1), constant: 0.0033 },
      { kind: 'set', voice: 0, param: 'position1', value: 0.5, time: at(3) },
      { kind: 'velocity', voices: [0], velocity: { level: 1, amp: 1 } },
      { kind: 'bend', cents: 200 },
      { kind: 'set', voice: 0, param: 'gate', value: -1, time: at(4) },
    ];
    voices.apply(events);
    for (let block = 0; block < 6; block++) {
      if (block === 1)
        voices.apply([{ kind: 'filter', voices: WARM_LADDERS, filter: { ...WARM_LADDER, cutoff: 1400 } }]);
      // (its noise from the pair into the bank; its warp: both knobs glide, PWM into Bend -, crossfading)
      if (block === 2)
        voices.apply([
          { kind: 'knobs', voices: [0], module: 'noise', values: { level: 0.7, pan: -0.2, cents: 300 } },
          { kind: 'knobs', voices: [0], module: 'sub', values: { level: 0.7, pan: 0, cents: 0 } },
          { kind: 'knobs', voices: [0], module: 'warp', values: WARM_WARP_KNOBS },
          {
            kind: 'filter',
            voices: WARM_LADDERS.slice(-1),
            filter: { type: 'low18', cutoff: 900, resonance: 60, gain: 0, drive: 0, variation: 20 },
          },
        ]);
      voices.process(block * 128, outL, outR);
      voices.reports();
    }
    voices.free();
  } finally {
    // (also those of a prewarm that failed after them)
    store.takeKernels(warmStore);
  }
  warmStore.free();
  warmShared.free();
};
