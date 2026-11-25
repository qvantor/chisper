import { z } from 'zod';
import type { ClipResponse } from './clip';
import { isProfane, profaneDescription } from './profanity';
import {
  CATEGORY_SLUGS,
  fitsCategory,
  PRESET_FEATURES,
  PRESET_ORIGINS,
  type PresetCategory,
  type PresetFeature,
  type PresetInfo,
  presetInfoSchema,
  type PresetTag,
  TAG_SLUGS,
} from './taxonomy';
import {
  DIVISION_MAX,
  DIVISION_OFF,
  divisionIndex,
  divisionWithin,
  ENVELOPE_TIME_DIVISIONS,
  nearestDivision,
  quartersOf,
  rateDivisions,
  TEMPO_DEFAULT,
  TIME_DIVISIONS,
} from './tempo';

export const DEFAULT_WAVETABLE_PATH = [
  'ESW Core Tables',
  'Basics',
  'ESW Core Tables/Basics/Basic Shapes.wav',
];

// the types of the filter of a voice, an index of the core (only appended): the responses of a BiquadFilterNode,
// then those of the Audio Unit of the renders (dsp/measurements/filter-types.json): its Normal ones (MG Low 6–24 as
// Ladder, Low and High 6–24, Band, Peak and Notch 12 and 24, the number their slope in dB an octave) and its EQ ones
export const WEB_FILTER_TYPES = [
  'lowpass',
  'highpass',
  'bandpass',
  'lowshelf',
  'highshelf',
  'peaking',
  'notch',
  'allpass',
] as const;
export const MODEL_FILTER_TYPES = [
  'ladder6',
  'ladder12',
  'ladder18',
  'ladder24',
  'low6',
  'low12',
  'low18',
  'low24',
  'high6',
  'high12',
  'high18',
  'high24',
  'band12',
  'band24',
  'peak12',
  'peak24',
  'notch12',
  'notch24',
  'loweq6',
  'loweq12',
  'bandeq12',
  'higheq6',
  'higheq12',
] as const;
export const FILTER_TYPES = [...WEB_FILTER_TYPES, ...MODEL_FILTER_TYPES] as const;
export type FilterType = (typeof FILTER_TYPES)[number];
// a type of a BiquadFilterNode: its Res is in dB (lowpass, highpass) or a Q, its Gain in dB; the model ones have Res,
// Drive and Var in % (0..100) and no Gain
export type WebFilterType = (typeof WEB_FILTER_TYPES)[number];
export const isWebFilterType = (type: string): type is WebFilterType =>
  (WEB_FILTER_TYPES as readonly string[]).includes(type);
export const isFilterType = (type: unknown): type is FilterType =>
  (FILTER_TYPES as readonly unknown[]).includes(type);

// effects of the fx rack, the order is the default chain order
export const FX_TYPES = ['distortion', 'chorus', 'delay', 'compressor', 'reverb', 'eq'] as const;
export type FxType = (typeof FX_TYPES)[number];

// known types only, no duplicates (presets from a newer client may contain effect types this one doesn't
// know); a missing type (saved before it existed) takes its default place: before the first effect that
// comes after it in FX_TYPES, at the end if none does
export const normalizeFxOrder = (order: readonly unknown[]): FxType[] => {
  const known = order.filter(
    (type, i): type is FxType => FX_TYPES.includes(type as FxType) && order.indexOf(type) === i
  );
  return FX_TYPES.reduce<FxType[]>((result, type, index) => {
    if (result.includes(type)) return result;
    const next = result.findIndex((item) => FX_TYPES.indexOf(item) > index);
    return next === -1 ? [...result, type] : [...result.slice(0, next), type, ...result.slice(next)];
  }, known);
};

export interface ParamRange {
  min: number;
  max: number;
  default: number;
  int?: boolean;
}

// numeric fx params: knob ranges in the app, validation and defaults of presets
// the dry/wet mix of an effect (0: dry, 1: wet); delay and reverb are mixed into the dry sound
export const FX_MIX_PARAM: ParamRange = { min: 0, max: 1, default: 0.3 };
// the mix of each effect, the default is the one of a freshly added effect: the distortion, the compressor and the
// EQ replace the dry sound, the chorus is half of it (its own law: wet sin²(π mix / 2), dry 1 - wet²; the delay
// mixes by the same one: the dry sound nearly whole under a half of the knob)
export const FX_MIX_PARAMS: Record<FxType, ParamRange> = {
  distortion: { ...FX_MIX_PARAM, default: 1 },
  chorus: { ...FX_MIX_PARAM, default: 0.5 },
  delay: FX_MIX_PARAM,
  compressor: { ...FX_MIX_PARAM, default: 1 },
  reverb: FX_MIX_PARAM,
  eq: { ...FX_MIX_PARAM, default: 1 },
};
export const FX_PARAMS = {
  // waveshaper, 4× oversampled
  distortion: {
    // the curve, an index into DISTORTION_MODES of the app (0: soft clip, 1: hard clip); new modes are
    // appended, so the saved indexes keep their meaning
    mode: { min: 0, max: 1, default: 0, int: true },
    // dB of gain into the curve; a makeup gain takes back the loudness it adds to a note. Up to 12: more
    // folds back audibly on high notes (4× oversampling)
    drive: { min: 0, max: 12, default: 8 },
    // lowpass after the curve, 20 kHz is open
    tone: { min: 500, max: 20000, default: 20000 },
    // dB of the output on top of the makeup gain (0: a note is about as loud as the dry one)
    level: { min: -24, max: 12, default: 0 },
  },
  // four taps (two a channel) moved by an LFO; the knobs, their ranges and defaults as measured on the Audio Unit
  // (dsp/measurements/chorus.json)
  chorus: {
    // Hz of the LFO (the knob: 20 × its travel⁴)
    rate: { min: 0, max: 20, default: 0.078 },
    // BPM (1): a cycle of the LFO is `div`, an index into TEMPO_DIVISIONS (1/32 … 8 bar, with `trip` and `dot`
    // (1) their triplets and dotted ones) at the tempo of the synth
    sync: { min: 0, max: 1, default: 0, int: true },
    div: { min: 0, max: DIVISION_MAX, default: divisionIndex('8 bar'), int: true },
    trip: { min: 0, max: 1, default: 0, int: true },
    dot: { min: 0, max: 1, default: 0, int: true },
    // ms of the second tap of each channel and of the first one
    d1: { min: 0, max: 20, default: 5 },
    d2: { min: 0, max: 20, default: 0 },
    // how far the LFO moves the taps: 62.5 ms at the top
    depth: { min: 0, max: 26, default: 26 },
    // of each tap into itself
    fb: { min: 0, max: 0.95, default: 0.095 },
    // Hz of the filter of the wet signal: a low pass, or (hpf 1) a high pass
    cut: { min: 20, max: 20000, default: 1000 },
    hpf: { min: 0, max: 1, default: 0, int: true },
    // the output knob of the wet signal: × 4 knob² (0 dB at the middle, +12 dB at the top)
    level: { min: 0, max: 1, default: 0.5 },
  },
  delay: {
    // seconds of the echoes (MS)
    time: { min: 0.01, max: 1, default: 0.2 },
    // BPM (1): the time is `div`, an index into TEMPO_DIVISIONS (1/64 … 1 bar, with `trip` and `dot` (1) their
    // triplets and dotted ones) at the tempo of the synth, 4 s at most
    sync: { min: 0, max: 1, default: 0, int: true },
    div: { min: 0, max: DIVISION_MAX, default: divisionIndex('1/8'), int: true },
    trip: { min: 0, max: 1, default: 0, int: true },
    dot: { min: 0, max: 1, default: 0, int: true },
    fb: { min: 0, max: 0.9, default: 0.5 },
    // 0: normal, 1: ping-pong
    mode: { min: 0, max: 1, default: 0, int: true },
    // stereo pan by delay (Haas effect, up to 50ms), < 0 delays the right channel (echoes on the left), > 0 the left one
    pan: { min: -0.05, max: 0.05, default: 0 },
    // bandpass in the feedback loop
    freq: { min: 50, max: 17000, default: 1000 },
    q: { min: 0.01, max: 3, default: 0.01 },
  },
  // one band, or three bands compressed down and up; the knobs and their laws as measured on the Audio Unit
  // (dsp/measurements/compressor.json), every key kept in both modes
  compressor: {
    // 0: one band, 1: three bands (the attack does nothing there, the threshold moves those of the bands)
    multi: { min: 0, max: 1, default: 0, int: true },
    // the threshold knob: 60 log10(1 - knob) dB, -120 dB at the top; in three bands the thresholds of the bands,
    // those of its middle (-33.8, -30.2, -35.5 dB) with its square
    thresh: { min: 0, max: 1, default: 0.5 },
    ratio: { min: 1, max: 30, default: 4 },
    // ms
    attack: { min: 0.1, max: 1000, default: 90 },
    release: { min: 0.1, max: 1000, default: 90 },
    // the makeup gain knob: × 1 … × 32 (30 dB)
    gain: { min: 0, max: 1, default: 0 },
    // the crossovers of the three bands, Hz (the high one never under the low one)
    xlow: { min: 20, max: 5000, default: 131 },
    xhigh: { min: 300, max: 16000, default: 2500 },
    // the ratio under the thresholds of the three bands (upward compression): dB added per dB under
    below: { min: 0, max: 1, default: 0 },
    // dB of each band
    low: { min: -24, max: 24, default: 0 },
    mid: { min: -24, max: 24, default: 0 },
    high: { min: -24, max: 24, default: 0 },
    // the output knob of the wet signal: × 4 knob² (0 dB at the middle, +12 dB at the top)
    level: { min: 0, max: 1, default: 0.5 },
  },
  // algorithmic reverb
  reverb: {
    // input highpass, 20 Hz is effectively off
    lowcut: { min: 20, max: 1000, default: 20 },
    // seconds before the early reflections and the tail
    pre: { min: 0, max: 0.3, default: 0.02 },
    // room size: lengths of the reflections and the feedback lines
    size: { min: 0, max: 1, default: 0.5 },
    // RT60 in seconds of the mid frequencies
    decay: { min: 0.1, max: 20, default: 2 },
    // the high frequencies decay faster above this frequency
    damp: { min: 500, max: 20000, default: 6000 },
    // decay multiplier of the low frequencies (below 300 Hz)
    bass: { min: 0.25, max: 4, default: 1 },
    // modulation depth of the feedback lines (chorus of the tail)
    depth: { min: 0, max: 1, default: 0.2 },
    // stereo separation: 0 mono, 1 natural, 2 extra wide
    sep: { min: 0, max: 2, default: 1 },
    // level of the early reflections against the tail (the wet level is the common mix)
    er: { min: 0, max: 1, default: 0.5 },
    // vintage color of the input stage: 0 now (clean), 1 80s, 2 70s (tube drive, narrower bandwidth, more body)
    era: { min: 0, max: 2, default: 1, int: true },
  },
  // two bands of the Audio EQ Cookbook, the knobs and their laws as measured on the Audio Unit
  // (dsp/measurements/eq.json); the defaults are its own: shelves at 0 dB (the sound as it is)
  eq: {
    // the type of band 1, an index into EQ_TYPES of the app (0: low shelf, 1: peak, 2: highpass); new types are
    // appended only
    t1: { min: 0, max: 2, default: 0, int: true },
    // Hz (the lowest of the reference: 21.53)
    f1: { min: 21.53, max: 20000, default: 210 },
    // the resonance, %: a Q of 0.4 + 1.7416 x³ of a shelf, of 0.1 + 18.9 x⁴ of a peak and a pass
    q1: { min: 0, max: 100, default: 60 },
    // dB (none on a pass)
    g1: { min: -24, max: 24, default: 0 },
    // band 2: 0 high shelf, 1 peak, 2 lowpass
    t2: { min: 0, max: 2, default: 0, int: true },
    f2: { min: 21.53, max: 20000, default: 2040 },
    q2: { min: 0, max: 100, default: 60 },
    g2: { min: -24, max: 24, default: 0 },
    // the output knob: × 4 knob² (0 dB at the middle, +12 dB at the top)
    level: { min: 0, max: 1, default: 0.5 },
  },
};

const range = (min: number, max: number) => z.number().finite().min(min).max(max);
const intRange = (min: number, max: number) => range(min, max).int();
const paramRange = ({ min, max, default: value, int }: ParamRange) =>
  (int ? intRange(min, max) : range(min, max)).default(value);
// legacy url params skip presetDataSchema: wrong types fall back to the default, numbers are clamped
// (and rounded for int params, the strict schema rejects fractions)
const lenientParamRange = ({ min, max, default: value, int }: ParamRange) =>
  z
    .number()
    .finite()
    .transform((num) => {
      const clamped = Math.min(max, Math.max(min, num));
      return int ? Math.round(clamped) : clamped;
    })
    .catch(value);
const mapParams = <K extends string, T>(params: Record<K, ParamRange>, toSchema: (param: ParamRange) => T) =>
  (Object.keys(params) as K[]).reduce(
    (acc, key) => ({ ...acc, [key]: toSchema(params[key]) }),
    {} as Record<K, T>
  );
const toObject = (value: unknown) =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};

// Phase rand of the presets saved before it was a share of the period: `r`, a start delay of 0..2 ms
export const LEGACY_RAND_PHASE_MAX = 0.002;
const legacyPhaseRand = (r: number) => Math.min(1, Math.max(0, r) / LEGACY_RAND_PHASE_MAX);

// the Phase of a new preset: half a period (180°); a legacy one (saved before Phase) keeps the phase it
// played from, the start of the wave
export const DEFAULT_PHASE = 0.5;
const LEGACY_PHASE = 0;

// a legacy `r` without `pr` becomes its pr (read only: it is not in the output), its ph is LEGACY_PHASE; the
// url snapshot of an oscillator skips the schema and calls it too
export const withLegacyPhase = <T extends { ph?: unknown; pr?: unknown }>(osc: T): T => {
  const { r } = osc as { r?: unknown };
  return osc.pr === undefined && typeof r === 'number'
    ? { ...osc, ph: osc.ph === undefined ? LEGACY_PHASE : osc.ph, pr: legacyPhaseRand(r) }
    : osc;
};

// the most Semi (semitones) and Fine (cents) move an oscillator by, down and up (their routes a share of the
// whole range)
export const SEMI_MAX = 24;
export const FINE_MAX = 100;

// the modes of the Warp of an oscillator, by their index in a preset (the mode of the core, warp.rs): a new one goes
// last. The bends map the phase each half by a Möbius map (Bend + squeezes the middle of the frame, Bend - its ends,
// Bend +/- one or the other of its knob, as it is at the middle), PWM squeezes the frame to the left, its first
// sample held over the rest (dsp/measurements/warp.json)
export const WARP_MODES = ['off', 'bend+', 'bend-', 'bend+-', 'pwm'] as const;
export type WarpMode = (typeof WARP_MODES)[number];

const oscillatorSchema = (active: boolean) =>
  z
    .preprocess(
      (value) =>
        typeof value === 'object' && value !== null && !Array.isArray(value) ? withLegacyPhase(value) : value,
      z
        .object({
          a: z.boolean().default(active),
          p: z.array(z.string().min(1).max(256)).min(1).max(5).default(DEFAULT_WAVETABLE_PATH),
          // the Wave knob: the position in frames, between two of them a morph
          w: range(0, 1023).default(0),
          // the pitch of the oscillator over the note: octaves, semitones and cents (1200·o + 100·s + f); d is the
          // unison detune (its spread)
          o: intRange(-3, 3).default(0),
          s: intRange(-SEMI_MAX, SEMI_MAX).default(0),
          f: intRange(-FINE_MAX, FINE_MAX).default(0),
          d: range(0, 100).default(5),
          u: intRange(1, 8).default(2),
          // the blend of the unison: the level of its centre voices against the others (0 the centre, the others
          // 27 dB under it; 1 the others, the centre under them), the curves of the reference AU; 0.75 as its init
          // patch (a preset saved before the blend gets it)
          b: range(0, 1).default(0.75),
          // the start phase of every unison voice and the most of its random shift (0: all in phase, 1: any
          // phase): shares of a period
          ph: range(0, 1).default(DEFAULT_PHASE),
          pr: range(0, 1).default(1),
          r: range(0, LEGACY_RAND_PHASE_MAX).optional(),
          g: range(0, 1).default(0.5),
          // the Warp: its mode (an index of WARP_MODES, Off first) and its knob
          wm: intRange(0, WARP_MODES.length - 1).default(0),
          wa: range(0, 1).default(0),
        })
        .transform((osc) => {
          const result: Omit<typeof osc, 'r'> & { r?: number } = { ...osc };
          delete result.r;
          return result as Omit<typeof osc, 'r'>;
        })
    )
    .prefault({});

// the sample a noise starts with: its folder (a category) and its key in the bucket of the samples
// (scripts/noises, netlify/functions/get-noises-list); it has to stay in the bucket
export const DEFAULT_NOISE_PATH = ['Analog', 'Analog/White.wav'];
// the most Pitch (semitones) moves the noise by, down and up
export const NOISE_PITCH_MAX = 48;

// the noise oscillator (off by default): its sample, looped or once, Pitch Track, the start of a note (a share of
// the sample) and Rand (a random share × its square is added), Pitch (semitones) and Fine (cents) over the pitch of
// the sample (with Pitch Track at C5), the pan (-1..1) and the level (its square the amplitude: 0.25 is -24 dB,
// as the init patch of the renders)
const noiseSchema = z
  .object({
    a: z.boolean().default(false),
    p: z.array(z.string().min(1).max(256)).min(1).max(5).default(DEFAULT_NOISE_PATH),
    lp: z.boolean().default(true),
    kt: z.boolean().default(false),
    st: range(0, 1).default(0),
    rd: range(0, 1).default(0),
    s: intRange(-NOISE_PITCH_MAX, NOISE_PITCH_MAX).default(0),
    f: intRange(-FINE_MAX, FINE_MAX).default(0),
    pn: range(-1, 1).default(0),
    g: range(0, 1).default(0.25),
  })
  .prefault({});

// the shapes of the sub (its tables: sub-shapes.ts of the app), by name in the presets, in the order of their keys
export const SUB_SHAPES = ['sine', 'round-rect', 'triangle', 'saw', 'square', 'pulse'] as const;
export type SubShape = (typeof SUB_SHAPES)[number];
// the octaves the sub moves by, down and up, and the most Coarse (semitones, not whole) moves it by
export const SUB_OCTAVE_MAX = 4;
export const SUB_COARSE_MAX = 64;

// the sub oscillator (off by default): its shape, Octave and Coarse (semitones) over the note, the share of a cycle a
// note starts at (Phase; Contiguous: at the phase of the note before), the pan (-1..1) and the level (its square the
// amplitude: 0.75 is -5 dB, as the init patch of the renders)
const subSchema = z
  .object({
    a: z.boolean().default(false),
    sh: z.enum(SUB_SHAPES).default('sine'),
    o: intRange(-SUB_OCTAVE_MAX, SUB_OCTAVE_MAX).default(0),
    c: range(-SUB_COARSE_MAX, SUB_COARSE_MAX).default(0),
    ph: range(0, 1).default(0),
    ct: z.boolean().default(false),
    pn: range(-1, 1).default(0),
    g: range(0, 1).default(0.75),
  })
  .prefault({});

// the filter of a voice: its type, cutoff (Hz), resonance, gain (the types of a BiquadFilterNode), Drive and Var (%:
// the gain into it and its variation, Comp or the Gain of an EQ type). Of a type that doesn't use them, the units its
// Res and Var are in, of the last type that used them: `rt` the type of Res (not there: a Biquad LP), `vk` 'eq' for
// the Gain of an EQ type (not there: Comp); only in the presets that need them, the others keep their hashes
const filterKnobsSchema = z.object({
  a: z.boolean().default(false),
  t: z.enum(FILTER_TYPES).default('lowpass'),
  cut: range(10, 22050).default(440),
  res: range(0, 1000).default(0),
  gain: range(-40, 40).default(1),
  dr: range(0, 100).default(0),
  v: range(0, 100).default(0),
  rt: z.enum(FILTER_TYPES).optional(),
  vk: z.literal('eq').optional(),
});

// a filter to save: a type or units this version doesn't know are refused (it would be saved as another sound, under
// the hash of that one)
const savedFilterSchema = filterKnobsSchema.prefault({});

// a filter to open, one of a newer client maybe. A type this one doesn't know: the default type at its cutoff (its
// other knobs are in the units of that type: a Res in % would be one in dB); units it doesn't know: as if not there
const openedFilter = (filter: unknown) => {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return filter;
  const { t, rt, vk, ...knobs } = filter as Record<string, unknown>;
  if (t !== undefined && !isFilterType(t)) return { a: knobs['a'], cut: knobs['cut'] };
  return { ...knobs, t, ...(isFilterType(rt) && { rt }), ...(vk === 'eq' && { vk }) };
};
const filterSchema = z.preprocess(openedFilter, filterKnobsSchema).prefault({});

// the envelopes ENV 1–3; ENV 1 is the volume of a note, all three modulate the knobs they are assigned to
export const ENVELOPES = ['env1', 'env2', 'env3'] as const;
export type EnvelopeId = (typeof ENVELOPES)[number];
// the key of each one in the preset: env: { e1, e2, e3 }
export const ENVELOPE_KEYS: Record<EnvelopeId, string> = { env1: 'e1', env2: 'e2', env3: 'e3' };
export type EnvelopeStage = 'attack' | 'hold' | 'decay' | 'sustain' | 'release';
// seconds of a stage at most (the time knobs are nonlinear, short times get most of their travel)
export const ENVELOPE_TIME_MAX = 32;
// a fresh envelope: ENV 1 a short click-free note, ENV 2 and 3 a decay to 0 (a pluck on the knob it moves)
export const ENVELOPE_DEFAULTS: Record<EnvelopeId, Record<EnvelopeStage, number>> = {
  env1: { attack: 0.005, hold: 0.1, decay: 0, sustain: 1, release: 0.005 },
  env2: { attack: 0.005, hold: 0, decay: 0.5, sustain: 0, release: 0.3 },
  env3: { attack: 0.005, hold: 0, decay: 0.5, sustain: 0, release: 0.3 },
};

// the stages an envelope curves: k of curveShape of the app, (1 - e^(-k·x)) / (1 - e^(-k)) over the share x of
// the stage (0 a line, k > 0 moves fast at first, then slowly, k < 0 the other way round)
export type EnvelopeCurveStage = 'attack' | 'decay' | 'release';
// the curves of a fresh envelope (an Audio Unit rendered offline, dsp/measurements/envelopes.json): a
// linear attack (its curve at 50%), the decay and the release at 66.6% (k 3.49: the exp fits its levels within
// 0.001)
export const ENVELOPE_CURVES: Record<EnvelopeCurveStage, number> = { attack: 0, decay: 3.49, release: 3.49 };
// |k| at most: at 10 the middle of a stage is within 0.7% of its end, more barely shows
export const ENVELOPE_CURVE_MAX = 10;
// k on the grid of the points of the chart (steps of 0.01, CurveHandles of ui-kit) within ±ENVELOPE_CURVE_MAX: a
// k near 0 is a line (1 - e^(-k) of a |k| below ~1e-16 is 0, the shape 0/0: a NaN envelope silences the voices
// and stays in the loop of the native delay), e^(-k) of a k below -709 is Infinity
export const envelopeCurve = (k: number) =>
  Math.round(Math.min(ENVELOPE_CURVE_MAX, Math.max(-ENVELOPE_CURVE_MAX, k)) * 100) / 100;

const curveRange = (k: number) =>
  range(-ENVELOPE_CURVE_MAX, ENVELOPE_CURVE_MAX).default(k).transform(envelopeCurve);

// the stages of an envelope with a time
export type EnvelopeTimeStage = 'attack' | 'hold' | 'decay' | 'release';
export const ENVELOPE_TIME_STAGES: readonly EnvelopeTimeStage[] = ['attack', 'hold', 'decay', 'release'];
// in BPM (`bpm`) the times are divisions (`divs`: indexes into TEMPO_DIVISIONS, Off and 1/512 … 32 bar) at the tempo
// of the synth, the seconds those of MS; a fresh envelope has the divisions nearest to its seconds at 120 (MS: a
// preset saved before the tempo plays as it did)
export const ENVELOPE_DIVISIONS = ENVELOPES.reduce(
  (all, id) => ({
    ...all,
    [id]: ENVELOPE_TIME_STAGES.reduce(
      (divs, stage) => ({
        ...divs,
        [stage]: nearestDivision(
          quartersOf(ENVELOPE_DEFAULTS[id][stage], TEMPO_DEFAULT),
          ENVELOPE_TIME_DIVISIONS
        ),
      }),
      {} as Record<EnvelopeTimeStage, number>
    ),
  }),
  {} as Record<EnvelopeId, Record<EnvelopeTimeStage, number>>
);

const envelopeDivision = (division: number) =>
  intRange(0, DIVISION_MAX)
    .default(division)
    .transform((index) => divisionWithin(index, ENVELOPE_TIME_DIVISIONS));

const envelopeSchema = (id: EnvelopeId) => {
  const { attack, hold, decay, sustain, release } = ENVELOPE_DEFAULTS[id];
  const divs = ENVELOPE_DIVISIONS[id];
  return z
    .object({
      attack: range(0, ENVELOPE_TIME_MAX).default(attack),
      hold: range(0, ENVELOPE_TIME_MAX).default(hold),
      decay: range(0, ENVELOPE_TIME_MAX).default(decay),
      sustain: range(0, 1).default(sustain),
      release: range(0, ENVELOPE_TIME_MAX).default(release),
      curves: z
        .object({
          attack: curveRange(ENVELOPE_CURVES.attack),
          decay: curveRange(ENVELOPE_CURVES.decay),
          release: curveRange(ENVELOPE_CURVES.release),
        })
        .prefault({}),
      bpm: z.boolean().default(false),
      divs: z
        .object({
          attack: envelopeDivision(divs.attack),
          hold: envelopeDivision(divs.hold),
          decay: envelopeDivision(divs.decay),
          release: envelopeDivision(divs.release),
        })
        .prefault({}),
    })
    .prefault({});
};

// the velocity of a note (MIDI 1..127; the computer keyboard and the piano play 100): VELO, a source of the
// routes, is curveShape of its share of 127 by k (0 a line), Amp the share of the volume of the note it takes
// (1 - Amp + Amp · VELO: at 0 none, at 1 a velocity of 64 on a line is 6 dB below 127). A fresh preset: a line,
// Amp 1 (the presets saved before it have Amp 0: the database got it)
export type VelocityKnob = 'amp' | 'k';
export const VELOCITY_DEFAULTS: Record<VelocityKnob, number> = { amp: 1, k: 0 };

const velocitySchema = z
  .object({
    amp: range(0, 1).default(VELOCITY_DEFAULTS.amp),
    k: curveRange(VELOCITY_DEFAULTS.k),
  })
  .prefault({});

const envSchema = z
  .object({
    e1: envelopeSchema('env1'),
    e2: envelopeSchema('env2'),
    e3: envelopeSchema('env3'),
    vel: velocitySchema,
  })
  .prefault({});

// the LFOs LFO 1–4: sources of the routes after the velocity, each a cycle of its shape repeated every `rate`
// seconds (its period), per note: from the end of its Delay (retrig) or on a clock of its own all notes share
// (free); its knobs are targets of the envelopes (lfo1.rate…), not of the LFOs
export const LFOS = ['lfo1', 'lfo2', 'lfo3', 'lfo4'] as const;
export type LfoId = (typeof LFOS)[number];
// the key of each one in the preset: lfo: { l1, l2, l3, l4 }
export const LFO_KEYS: Record<LfoId, string> = { lfo1: 'l1', lfo2: 'l2', lfo3: 'l3', lfo4: 'l4' };
// the shapes a cycle of an LFO takes (levels 0..1, the left point is the level at its start), or points of its own
export const LFO_SHAPES = ['sine', 'triangle', 'saw-up', 'saw-down', 'square'] as const;
export type LfoShape = (typeof LFO_SHAPES)[number];
// retrig: its phase starts with every note (at the end of its Delay), free: one phase of every note
export const LFO_MODES = ['retrig', 'free'] as const;
export type LfoMode = (typeof LFO_MODES)[number];
// seconds of the period: 10 ms (100 Hz) to 32 s; the knob goes by the frequency, right faster
export const LFO_RATE_MIN = 0.01;
export const LFO_RATE_MAX = 32;
// seconds of the lag of Smooth at most
export const LFO_SMOOTH_MAX = 0.5;
// the points of a shape of its own at most
export const LFO_POINTS_MAX = 64;
export type LfoKnob = 'rate' | 'delay' | 'rise' | 'smooth' | 'phase';
// the tempo of an LFO: in BPM Rate, Delay and Rise are divisions (indexes into TEMPO_DIVISIONS: div, delayDiv,
// riseDiv) at the tempo of the synth, their seconds (rate, delay, rise) are those of HZ; TRIP and DOT add the
// triplets and the dotted ones to the steps of Rate; HOST: a free one on the grid of the beats of the transport (in
// HZ: its phase from the position of the transport where it moves, a MIDI Start)
export type LfoSync = {
  bpm: boolean;
  div: number;
  trip: boolean;
  dot: boolean;
  host: boolean;
  delayDiv: number;
  riseDiv: number;
};
export const LFO_DEFAULTS: Record<LfoKnob, number> & { shape: LfoShape; mode: LfoMode } & LfoSync = {
  rate: 0.5,
  delay: 0,
  rise: 0,
  smooth: 0,
  phase: 0,
  shape: 'sine',
  mode: 'retrig',
  // HZ: a preset saved before the tempo plays as it did
  bpm: false,
  div: divisionIndex('1/4'),
  trip: false,
  dot: false,
  host: true,
  delayDiv: DIVISION_OFF,
  riseDiv: DIVISION_OFF,
};

// a point of a shape of its own: x (the share of the cycle), y (the level), k (the curve of the segment to the
// next point: curveShape of the app, as the stages of the envelopes)
export type LfoPoint = [number, number, number];
// the points start at 0 and go up (two at the same x: a step); the last segment goes to the first point over the
// end of the cycle
const startsAtZeroAscending = (points: LfoPoint[]) =>
  points[0][0] === 0 && points.every((point, i) => i === 0 || point[0] >= points[i - 1][0]);

const lfoSchema = z
  .object({
    rate: range(LFO_RATE_MIN, LFO_RATE_MAX).default(LFO_DEFAULTS.rate),
    delay: range(0, ENVELOPE_TIME_MAX).default(LFO_DEFAULTS.delay),
    rise: range(0, ENVELOPE_TIME_MAX).default(LFO_DEFAULTS.rise),
    smooth: range(0, LFO_SMOOTH_MAX).default(LFO_DEFAULTS.smooth),
    phase: range(0, 1).default(LFO_DEFAULTS.phase),
    shape: z.enum(LFO_SHAPES).default(LFO_DEFAULTS.shape),
    mode: z.enum(LFO_MODES).default(LFO_DEFAULTS.mode),
    // a shape of its own (before shape; drawn and edited on the chart of the LFO section)
    points: z
      .array(
        z.tuple([
          range(0, 1),
          range(0, 1),
          range(-ENVELOPE_CURVE_MAX, ENVELOPE_CURVE_MAX).transform(envelopeCurve),
        ])
      )
      .min(2)
      .max(LFO_POINTS_MAX)
      .refine(startsAtZeroAscending)
      .optional(),
    bpm: z.boolean().default(LFO_DEFAULTS.bpm),
    div: intRange(0, DIVISION_MAX).default(LFO_DEFAULTS.div),
    trip: z.boolean().default(LFO_DEFAULTS.trip),
    dot: z.boolean().default(LFO_DEFAULTS.dot),
    host: z.boolean().default(LFO_DEFAULTS.host),
    delayDiv: intRange(0, DIVISION_MAX).default(LFO_DEFAULTS.delayDiv),
    riseDiv: intRange(0, DIVISION_MAX).default(LFO_DEFAULTS.riseDiv),
  })
  // each division one of the steps of its knob (Rate by TRIP and DOT; no Off)
  .transform((lfo) => ({
    ...lfo,
    div: divisionWithin(lfo.div, rateDivisions(lfo.trip, lfo.dot)),
    delayDiv: divisionWithin(lfo.delayDiv, TIME_DIVISIONS),
    riseDiv: divisionWithin(lfo.riseDiv, TIME_DIVISIONS),
  }))
  .prefault({});

const lfoSectionSchema = z
  .object({ l1: lfoSchema, l2: lfoSchema, l3: lfoSchema, l4: lfoSchema })
  .prefault({});

// trimmed, whitespace collapsed (the names of presets, clips and macros)
export const normalizeName = (name: string) => name.trim().replace(/\s+/g, ' ');
// a name normalized and cut to `max`, not after half of a character of two code units (an emoji)
export const cutName = (text: string, max: number) => {
  const name = normalizeName(text).slice(0, max);
  const last = name.charCodeAt(name.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? name.slice(0, -1) : name;
};

// the macros MACRO 1–4: sources of the routes after the LFOs, a knob each with a level 0..1 (the same for every
// voice and the effects, with a note or without one), and a name a user gives one that has routes. In the preset:
// mac: { m1, m2, m3, m4, n1, n2, n3, n4 }, the levels and the names; a level of 0, an empty name and the name of a
// macro without routes left out, the section too when nothing is left (the presets of before keep their hashes)
export const MACROS = ['macro1', 'macro2', 'macro3', 'macro4'] as const;
export type MacroId = (typeof MACROS)[number];
export const MACRO_KEYS: Record<MacroId, string> = { macro1: 'm1', macro2: 'm2', macro3: 'm3', macro4: 'm4' };
export const MACRO_NAME_KEYS = {
  macro1: 'n1',
  macro2: 'n2',
  macro3: 'n3',
  macro4: 'n4',
} as const satisfies Record<MacroId, string>;
// the longest name of a macro (a line under its knob)
export const MACRO_NAME_MAX_LENGTH = 20;
export const isMacro = (source: string): source is MacroId => (MACROS as readonly string[]).includes(source);
// the MIDI CC of each macro, kept for a MIDI input, the files of the track and the automation of a clip (nothing reads
// them yet): CC 20–23 (none of the General MIDI ones), 14 bits as a pair with the LSB 52–55 (msb + 32)
export const MACRO_CC: Record<MacroId, { msb: number; lsb: number }> = {
  macro1: { msb: 20, lsb: 52 },
  macro2: { msb: 21, lsb: 53 },
  macro3: { msb: 22, lsb: 54 },
  macro4: { msb: 23, lsb: 55 },
};
const macroLevel = range(0, 1).optional();
// trimmed, whitespace collapsed (empty: none)
const macroName = z.string().transform(normalizeName).pipe(z.string().max(MACRO_NAME_MAX_LENGTH)).optional();
const macSchema = z
  .object({
    m1: macroLevel,
    m2: macroLevel,
    m3: macroLevel,
    m4: macroLevel,
    n1: macroName,
    n2: macroName,
    n3: macroName,
    n4: macroName,
  })
  .optional()
  .transform((mac) => {
    const set = Object.entries(mac ?? {}).filter(
      ([, value]) => value !== undefined && value !== 0 && value !== ''
    );
    return set.length > 0 ? (Object.fromEntries(set) as NonNullable<typeof mac>) : undefined;
  })
  // (an optional key of the preset: none is no key)
  .optional();

// the modulation: a route moves a knob (a target of the app: osc1.wave, filter.cutoff, delay.time…) by its
// source × amount, a share of the range of the knob in its scale (-1..1, a log knob in octaves: +0.5 on
// Cutoff is about +5.5 octaves). Saved as { 'env2:osc1.wave': 0.5 }: one route per source and knob; a bipolar one
// (around the knob, amount × (level - ½)) as { 'lfo1:filter.gain': { a: 0.5, bi: true } }, one switched off (kept,
// moving nothing) with off: { a: 0.5, off: true }. The sources: the envelopes, the velocity (VELO), the LFOs, then
// the macros (only appended to); an index into MOD_SOURCES is the index of the source in the voice and the chain.
// The knobs of the LFOs take no LFO
export type ModSource = EnvelopeId | 'velo' | LfoId | MacroId;
export const MOD_SOURCES: readonly ModSource[] = [...ENVELOPES, 'velo', ...LFOS, ...MACROS];
export const isLfo = (source: string): source is LfoId => (LFOS as readonly string[]).includes(source);
// the target of a route moves a knob of an LFO (lfo2.rate): no LFO goes there
export const isLfoKnob = (target: string) => /^lfo[1-4]\./.test(target);
// the most routes of a preset (once there are as many, a dragged ENV tab adds none) and of the sources on one
// knob (a full one takes none)
export const MOD_ROUTES_MAX = 64;
export const MOD_KNOB_SOURCES_MAX = 4;
const modKeySchema = z.string().regex(/^(env[1-3]|velo|lfo[1-4]|macro[1-4]):[a-z][a-z0-9]*\.[a-z][a-z0-9]*$/);
// an object has a flag: a route without one is its amount
const modValueSchema = z.union([
  range(-1, 1),
  z
    .object({ a: range(-1, 1), bi: z.literal(true).optional(), off: z.literal(true).optional() })
    .refine(({ bi, off }) => bi || off),
]);
export type ModValue = z.infer<typeof modValueSchema>;
const knobSources = (routes: Record<string, unknown>) =>
  Object.keys(routes).reduce<Record<string, number>>((counts, key) => {
    const target = key.slice(key.indexOf(':') + 1);
    counts[target] = (counts[target] ?? 0) + 1;
    return counts;
  }, {});
const lfoOnLfo = (key: string) =>
  isLfo(key.slice(0, key.indexOf(':'))) && isLfoKnob(key.slice(key.indexOf(':') + 1));
const modSchema = z
  .record(modKeySchema, modValueSchema)
  .refine((routes) => Object.keys(routes).length <= MOD_ROUTES_MAX)
  .refine((routes) => Object.values(knobSources(routes)).every((count) => count <= MOD_KNOB_SOURCES_MAX))
  .refine((routes) => !Object.keys(routes).some(lfoOnLfo))
  .prefault({});

// semitones the pitch bend moves the notes by at most, down and up (each 0..PITCH_BEND_MAX)
export const PITCH_BEND_MAX = 24;
export const PITCH_BEND_DEFAULT = 2;

const voicingSchema = z
  .object({
    leg: z.boolean().default(false),
    port: range(0, 400).default(0),
    max: intRange(1, 12).default(8),
    // the range of the pitch bend: semitones down and up
    bd: intRange(0, PITCH_BEND_MAX).default(PITCH_BEND_DEFAULT),
    bu: intRange(0, PITCH_BEND_MAX).default(PITCH_BEND_DEFAULT),
  })
  .prefault({});

// one shape for presets and url snapshots, only the validation of a value differs
const fxEffectShape = <K extends string, P, F>(
  params: Record<K, ParamRange>,
  mix: ParamRange,
  param: (range: ParamRange) => P,
  flag: (value: boolean) => F
) => ({
  a: flag(false), // in the chain
  on: flag(true), // not bypassed
  mix: param(mix),
  ...mapParams(params, param),
});

const fxSchema = z
  .object({
    o: z
      .array(z.string().max(64))
      .max(32)
      .transform(normalizeFxOrder)
      .prefault([...FX_TYPES]),
    distortion: z
      .object(
        fxEffectShape(FX_PARAMS.distortion, FX_MIX_PARAMS.distortion, paramRange, (value) =>
          z.boolean().default(value)
        )
      )
      .prefault({}),
    chorus: z
      .object(
        fxEffectShape(FX_PARAMS.chorus, FX_MIX_PARAMS.chorus, paramRange, (value) =>
          z.boolean().default(value)
        )
      )
      .prefault({}),
    delay: z
      .object(
        fxEffectShape(FX_PARAMS.delay, FX_MIX_PARAMS.delay, paramRange, (value) => z.boolean().default(value))
      )
      .prefault({}),
    compressor: z
      .object(
        fxEffectShape(FX_PARAMS.compressor, FX_MIX_PARAMS.compressor, paramRange, (value) =>
          z.boolean().default(value)
        )
      )
      .prefault({}),
    reverb: z
      .object(
        fxEffectShape(FX_PARAMS.reverb, FX_MIX_PARAMS.reverb, paramRange, (value) =>
          z.boolean().default(value)
        )
      )
      .prefault({}),
    eq: z
      .object(
        fxEffectShape(FX_PARAMS.eq, FX_MIX_PARAMS.eq, paramRange, (value) => z.boolean().default(value))
      )
      .prefault({}),
  })
  .prefault({});

const lenientFxEffect = <K extends string>(params: Record<K, ParamRange>, mix: ParamRange) =>
  z.preprocess(
    toObject,
    z.object(fxEffectShape(params, mix, lenientParamRange, (value) => z.boolean().catch(value)))
  );

// fx snapshot of the url: never fails, invalid values fall back to the defaults (see lenientParamRange)
export const fxSnapSchema = z.preprocess(
  toObject,
  z.object({
    o: z.array(z.unknown()).catch([]).transform(normalizeFxOrder),
    distortion: lenientFxEffect(FX_PARAMS.distortion, FX_MIX_PARAMS.distortion),
    chorus: lenientFxEffect(FX_PARAMS.chorus, FX_MIX_PARAMS.chorus),
    delay: lenientFxEffect(FX_PARAMS.delay, FX_MIX_PARAMS.delay),
    compressor: lenientFxEffect(FX_PARAMS.compressor, FX_MIX_PARAMS.compressor),
    reverb: lenientFxEffect(FX_PARAMS.reverb, FX_MIX_PARAMS.reverb),
    eq: lenientFxEffect(FX_PARAMS.eq, FX_MIX_PARAMS.eq),
  })
);

// keys match snapshot plugin model names (voicing is saved with the `v` prefix). The name of a macro without routes
// (one switched off is one) is left out: the synth keeps it, hidden, for a route again
const presetData = <F extends z.ZodType>(filter: F) =>
  z
    .object({
      osc1: oscillatorSchema(true),
      osc2: oscillatorSchema(false),
      noise: noiseSchema,
      sub: subSchema,
      filter,
      env: envSchema,
      lfo: lfoSectionSchema,
      mod: modSchema,
      mac: macSchema,
      v: voicingSchema,
      fx: fxSchema,
    })
    .overwrite((data) => {
      const { mac, mod } = data;
      const unrouted = MACROS.filter(
        (id) =>
          mac?.[MACRO_NAME_KEYS[id]] !== undefined &&
          !Object.keys(mod).some((key) => key.startsWith(`${id}:`))
      );
      if (!mac || unrouted.length === 0) return data;
      const named = { ...mac };
      unrouted.forEach((id) => delete named[MACRO_NAME_KEYS[id]]);
      return { ...data, mac: Object.keys(named).length > 0 ? named : undefined };
    });

// a preset to open (of the server, of a tab, of a newer client maybe)
export const presetDataSchema = presetData(filterSchema);
// a preset to save: as one to open, its filter one this version knows (savedFilterSchema)
const savedPresetDataSchema = presetData(savedFilterSchema);

export type PresetData = z.infer<typeof presetDataSchema>;

// the state of an empty preset (Init): the default of every knob
export const PRESET_DEFAULTS: PresetData = presetDataSchema.parse({});
// the knobs of an oscillator in it: those of osc 1 and osc 2 alike (only `a` differs)
export const OSC_DEFAULTS: Omit<PresetData['osc1'], 'a'> = PRESET_DEFAULTS.osc1;
// the knobs of the noise in it
export const NOISE_DEFAULTS: PresetData['noise'] = PRESET_DEFAULTS.noise;
// the knobs of the sub in it
export const SUB_DEFAULTS: PresetData['sub'] = PRESET_DEFAULTS.sub;

// a name of a macro of the preset the profanity filter refuses (one that opens shows it under its knob; the names
// are the only text of `mac`)
export const profaneMacroName = ({ mac }: Pick<PresetData, 'mac'>) =>
  Object.values(mac ?? {}).some((value) => typeof value === 'string' && isProfane(value));

export const PRESET_NAME_MAX_LENGTH = 40;

// trimmed, whitespace collapsed; names are unique case-insensitively (see nameKey)
export const presetNameSchema = z
  .string()
  .transform(normalizeName)
  .pipe(z.string().min(1).max(PRESET_NAME_MAX_LENGTH));

export const nameKey = (name: string) => normalizeName(name).toLowerCase();

export const presetIdSchema = z.string().uuid();

// the id of a saved clip of the track (here, not in ./clip: that module imports this one)
export const clipIdSchema = z.string().uuid();

// the clip a preset opens with; null: none. Missing in an update: the clip stays as it is
const presetClipIdSchema = clipIdSchema.nullable().optional();

// a Cloudflare Turnstile response, single use
export const turnstileTokenSchema = z.string().min(1).max(4096);

// an info as it is saved: a description it can be saved with, checked as a name is, its word refused told (the issue
// on the description: the server tells it, the fields show it as it is typed)
export const savedPresetInfoSchema = presetInfoSchema.refine(
  ({ description }) => description === null || !isProfane(description),
  {
    error: ({ input }) => profaneDescription((input as PresetInfo).description ?? '') ?? undefined,
    path: ['description'],
  }
);

export const savePresetRequestSchema = z.object({
  name: presetNameSchema,
  data: savedPresetDataSchema,
  turnstileToken: turnstileTokenSchema,
  clipId: presetClipIdSchema,
  // its category, description and tags (none: an empty info)
  info: savedPresetInfoSchema.optional(),
});
export type SavePresetRequest = z.input<typeof savePresetRequestSchema>;

// the secret of the author (SavePresetResponse.editToken, SaveClipResponse.editToken)
export const editTokenSchema = z.string().min(20).max(128);

export const updatePresetRequestSchema = z.object({
  name: presetNameSchema,
  data: savedPresetDataSchema,
  editToken: editTokenSchema,
  clipId: presetClipIdSchema,
  // missing: the info stays as it is
  info: savedPresetInfoSchema.optional(),
});
export type UpdatePresetRequest = z.input<typeof updatePresetRequestSchema>;

// Edit info: the category, description and tags of a preset alone (its sound, name and hash stay)
export const updatePresetInfoRequestSchema = z.object({
  editToken: editTokenSchema,
  info: savedPresetInfoSchema,
});
export type UpdatePresetInfoRequest = z.input<typeof updatePresetInfoRequestSchema>;

// the author opened the preset, it is kept from the cleanup
export const presetOpenedRequestSchema = z.object({
  editToken: editTokenSchema,
});
export type PresetOpenedRequest = z.input<typeof presetOpenedRequestSchema>;

// a listen and a stay: a preset played this many seconds without switching to another one
export const USAGE_LISTEN_SECONDS = 10;
export const USAGE_STAY_SECONDS = 60;

// a listen: USAGE_LISTEN_SECONDS reached on a chosen preset; a stay: USAGE_STAY_SECONDS; each is sent once a preset
// is opened (see usePresetUsageTracker) with a captcha of its own, the score is the share of listeners who stayed
export const usageRequestSchema = z.object({
  presetId: presetIdSchema,
  event: z.enum(['listen', 'stay']),
  turnstileToken: turnstileTokenSchema,
});
export type UsageRequest = z.input<typeof usageRequestSchema>;

export const PRESET_SORTS = ['new', 'name', 'popular'] as const;
export type PresetSort = (typeof PRESET_SORTS)[number];

// a list of a query: comma separated, empty items dropped
const csv = <T extends z.ZodType<unknown, string>>(item: T, max: number) =>
  z
    .string()
    .max(4096)
    .transform((value) => value.split(',').filter((part) => part !== ''))
    .pipe(z.array(item).max(max));

// the ids a list of this browser asks for at once (Favorites, Recent, Mine)
export const PRESET_IDS_MAX = 100;

// the filter of GET /api/presets and /top (presetFilterParams of ./taxonomy writes it)
export const presetFilterQuerySchema = z
  .object({
    q: z.string().trim().max(PRESET_NAME_MAX_LENGTH).optional(),
    category: z.enum(CATEGORY_SLUGS).optional(),
    subcategory: z.string().max(32).optional(),
    tags: csv(z.enum(TAG_SLUGS), TAG_SLUGS.length).optional(),
    features: csv(z.enum(PRESET_FEATURES), PRESET_FEATURES.length).optional(),
    origin: z.enum(PRESET_ORIGINS).optional(),
  })
  .refine(({ category, subcategory }) => fitsCategory(category, subcategory));
// a filter of the lists: of the server (GET /api/presets, /top) or of a list of this browser (matchesPresetFilter)
export type PresetFilter = z.output<typeof presetFilterQuerySchema>;

export const listPresetsQuerySchema = z.intersection(
  presetFilterQuerySchema,
  z.object({
    sort: z.enum(PRESET_SORTS).default('new'),
    cursor: z.string().max(512).optional(),
    // these presets alone, in this order (a list of this browser), one page
    ids: csv(presetIdSchema, PRESET_IDS_MAX).optional(),
  })
);

// API responses
export interface PresetListItem {
  id: string;
  name: string;
  uniqueUsers: number;
  category: PresetCategory | null;
  subcategory: string | null;
  description: string | null;
  tags: PresetTag[];
  // in the order of PRESET_FEATURES
  features: PresetFeature[];
  // a preset of the synth (its author's)
  factory: boolean;
}

// an item of the Popular (GET /api/presets/top): featured or over the threshold of the popular presets (true), the
// rest of a filter after them (false)
export interface TopPresetItem extends PresetListItem {
  popular: boolean;
}

// the presets of each category and subcategory (not hidden)
export interface PresetCounts {
  total: number;
  categories: Partial<Record<PresetCategory, { count: number; subcategories: Record<string, number> }>>;
}

// the clip a preset opens with: a saved clip (its name in it)
export type PresetClip = Omit<ClipResponse, 'createdAt'>;

export interface Preset {
  id: string;
  name: string;
  data: PresetData;
  createdAt: string;
  // the clip it opens with, chosen by its author; null: none
  clip: PresetClip | null;
  info: PresetInfo;
  factory: boolean;
  features: PresetFeature[];
}

export interface PresetsPage {
  items: PresetListItem[];
  nextCursor: string | null;
}

export interface SavePresetResponse {
  id: string;
  name: string;
  existed: boolean;
  // secret for editing the preset later, only returned when the preset was created
  editToken?: string;
  // the clip the preset opens with (of the one saved before when it existed); null: none
  clipId: string | null;
  // its info (of the one saved before when it existed: it stays)
  info: PresetInfo;
}

export interface NameAvailableResponse {
  available: boolean;
}

export interface UpdatePresetResponse {
  id: string;
  name: string;
  // the clip the preset opens with now; null: none
  clipId: string | null;
  info: PresetInfo;
}

export interface UpdatePresetInfoResponse {
  id: string;
  info: PresetInfo;
}

export interface ApiError {
  error: string;
}
