import { createHash } from 'crypto';
import { presetHash } from './hash';
import { fxSnapSchema, PRESET_DEFAULTS } from './schema';

// The hashes of the presets are their identity in the database (dedup by hash): a change of a library under the
// schema (zod, @noble/hashes) or of the schema itself must not change them silently. Recorded on zod 3 and
// @noble/hashes 1; a change of the sound of a preset is an explicit update of these values.

const FULL = {
  name: 'Not a part of the hash',
  osc1: {
    a: true,
    p: ['A', 'B', 'A/B/c.wav'],
    w: 3.5,
    o: -1,
    s: 7,
    f: -12,
    d: 12.5,
    u: 4,
    b: 0.3,
    ph: 0.25,
    pr: 0.5,
    g: 0.7,
  },
  osc2: {
    a: true,
    p: ['Basic', 'saw.wav'],
    w: 255,
    o: 1,
    s: -24,
    f: 100,
    d: 0,
    u: 8,
    b: 1,
    ph: 0,
    pr: 0,
    g: 0.5,
  },
  noise: {
    a: true,
    p: ['Textures', 'Textures/Rain.wav'],
    lp: false,
    kt: true,
    st: 0.125,
    rd: 0.5,
    s: -12,
    f: 37,
    pn: -0.25,
    g: 0.7071,
  },
  sub: { a: true, sh: 'pulse', o: -2, c: 3.25, ph: 0.375, ct: true, pn: 0.5, g: 0.6 },
  filter: { a: true, t: 'bandpass', cut: 1234.5678, res: 2, gain: -3 },
  env: {
    e1: {
      attack: 0.01,
      hold: 0,
      decay: 1.5,
      sustain: 0.8,
      release: 0.4,
      curves: { attack: -2.5, decay: 0, release: 7 },
      bpm: true,
      divs: { attack: 43, hold: 0, decay: 20, release: 9 },
    },
    e2: { attack: 0.005, hold: 0.2, decay: 32, sustain: 0, release: 0, curves: { decay: 1e-17 } },
    e3: { attack: 2, hold: 0, decay: 0.5, sustain: 0.25, release: 0.3 },
    vel: { amp: 0.4, k: -3 },
  },
  lfo: {
    l1: {
      rate: 0.25,
      delay: 0.1,
      rise: 0.5,
      smooth: 0.01,
      phase: 0.75,
      bpm: true,
      div: 20,
      trip: true,
      dot: false,
      host: false,
      delayDiv: 5,
      riseDiv: 6,
    },
    l2: {
      points: [
        [0, 0, 0],
        [0.25, 1, 3],
        [0.25, 0.5, -2],
        [1, 0, 0],
      ],
    },
    l3: { rate: 4, phase: 0.1 },
  },
  mod: {
    'env2:osc1.wave': 0.5,
    'velo:filter.cutoff': -0.25,
    'lfo1:filter.gain': { a: 0.5, bi: true },
    'lfo2:osc2.pitch': { a: -0.3, off: true },
    'env3:delay.time': { a: 0.2, bi: true, off: true },
    'env1:lfo1.rate': 0.1,
  },
  v: { leg: true, port: 0.12, max: 1, bd: 12, bu: 0 },
  fx: {
    o: ['reverb', 'compressor', 'chorus', 'distortion'],
    distortion: { a: true, on: false, mix: 0.6, mode: 1, drive: 4, tone: 8000, level: -6 },
    chorus: {
      a: true,
      on: true,
      mix: 0.4,
      rate: 1.25,
      sync: 1,
      div: 20,
      trip: 1,
      dot: 0,
      d1: 8.5,
      d2: 3,
      depth: 4.2,
      fb: 0.3,
      cut: 5200,
      hpf: 1,
      level: 0.55,
    },
    compressor: {
      a: true,
      on: true,
      mix: 0.8,
      multi: 1,
      thresh: 0.62,
      ratio: 8,
      attack: 12.5,
      release: 240,
      gain: 0.1,
      xlow: 110,
      xhigh: 3200,
      below: 0.4,
      low: 3,
      mid: -2,
      high: 4.5,
      level: 0.45,
    },
    delay: {
      a: true,
      on: true,
      mix: 0.5,
      time: 0.25,
      sync: 1,
      div: 37,
      trip: 0,
      dot: 1,
      fb: 0.3,
      mode: 1,
      pan: -0.01,
      freq: 800,
      q: 2,
    },
    reverb: {
      a: true,
      on: true,
      mix: 0.3,
      lowcut: 80,
      pre: 0.01,
      size: 0.4,
      decay: 1.5,
      damp: 5000,
      bass: 1.2,
      depth: 0.2,
      sep: 1,
      er: 0.5,
      era: 2,
    },
  },
};

const PRESETS: Record<string, unknown> = {
  // Init
  empty: {},
  full: FULL,
  // saved before Phase and Phase rand: a start delay r of 0..2 ms, the old adsr, no Semi, Fine, blend, LFOs
  legacy: {
    osc1: { a: true, p: ['A', 'B', 'A/B/c.wav'], w: 2, o: 0, d: 10, u: 3, r: 0.001, g: 0.6 },
    osc2: { r: 0.0015, ph: 0.3 },
    adsr: { attack: 0.5 },
    filter: { a: false, t: 'lowpass', cut: 440, res: 0, gain: 1 },
    mod: { 'env2:osc1.wave': 1 },
  },
  // nested sections given in part: their defaults fill the rest
  partial: {
    osc2: { a: true },
    noise: { a: true, g: 0.5 },
    sub: { a: true, o: -1 },
    env: { e2: { decay: 1 } },
    lfo: { l4: { shape: 'triangle' } },
    fx: { o: ['delay'], delay: { a: true } },
  },
  // an order saved before the distortion: it goes to its default place
  'fx order without a type': { fx: { o: ['reverb', 'delay'], reverb: { a: true } } },
};

const PRESET_HASHES: Record<string, string> = {
  empty: '1cfc87b42c2e08558d86fbe7d0c8712509b7e934cdfed698d737f299feb5dd34',
  full: '560754f60bdfb96327ad59296f2e67790e6b55b0ef69ed683f059c4adc6f6a3d',
  legacy: '126ab49b241583ff05929c9bcc0de420466c2f53080446c66ea12b2c765f4a57',
  partial: '6b6460905aa4beaaf5bd62336440f3a74c5b59729562deee5a251f3eafb21dca',
  'fx order without a type': 'eb468b78ec6395fca38418d40d586ee2cc96402efb9d13848dd60ee18edd342e',
};

// not presets: the schema rejects them
const INVALID: Record<string, unknown> = {
  null: null,
  'a fractional unison': { osc1: { u: 1.5 } },
  'an infinite position': { osc1: { w: Infinity } },
  'no wavetable path': { osc1: { p: [] } },
  'a noise pitch past 48 semitones': { noise: { s: 49 } },
  'a fractional noise pitch': { noise: { s: 0.5 } },
  'a noise pan past the right': { noise: { pn: 1.5 } },
  'no noise path': { noise: { p: [] } },
  'an unknown sub shape': { sub: { sh: 'ramp' } },
  'a sub octave past 4': { sub: { o: 5 } },
  'a fractional sub octave': { sub: { o: -0.5 } },
  'a sub coarse past 64 semitones': { sub: { c: -64.5 } },
  'a sub phase past a cycle': { sub: { ph: 1.25 } },
  'an unknown filter type': { filter: { t: 'comb' } },
  'an LFO on the knob of an LFO': { mod: { 'lfo1:lfo2.rate': 0.5 } },
  'a route object without a flag': { mod: { 'env1:osc1.wave': { a: 0.5 } } },
  'five sources on a knob': {
    mod: {
      'env1:osc1.wave': 0.1,
      'env2:osc1.wave': 0.1,
      'env3:osc1.wave': 0.1,
      'velo:osc1.wave': 0.1,
      'lfo1:osc1.wave': 0.1,
    },
  },
  'LFO points that start past 0': {
    lfo: {
      l1: {
        points: [
          [0.1, 0, 0],
          [1, 1, 0],
        ],
      },
    },
  },
  'an fx order that is not a list': { fx: { o: 'reverb' } },
};

// the url snapshot of the fx: never fails, invalid values fall back to the defaults
const FX_SNAPS: Record<string, unknown> = {
  null: null,
  garbage: { o: 'reverb', delay: { time: 'abc', fb: 5, div: 3.6 }, reverb: { era: 1.6, a: 'yes' }, x: 1 },
  full: FULL.fx,
};

const FX_SNAP_HASHES: Record<string, string> = {
  null: '3efdcdea164f4693316d0c640c2febe1b3028a40495ef1b43f18e98719fdd4c6',
  garbage: '96f796247c27ac9bf0505cf74b680bf6b3112a171274aff504f203986bcd79f4',
  full: '41d735751f9421ce37de6a17d58d983d27217a4c3ab6b61834ebc210571df060',
};

// key order aside: the values of the output
const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable((value as Record<string, unknown>)[key])])
    );
  return value;
};
const hashOf = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');

describe('the hashes of presets', () => {
  it.each(Object.keys(PRESETS))('%s', (name) => {
    expect(presetHash(PRESETS[name])).toBe(PRESET_HASHES[name]);
  });

  it('Init is the defaults of every knob', () => {
    expect(hashOf(PRESET_DEFAULTS)).toBe(PRESET_HASHES['empty']);
  });

  it.each(Object.keys(INVALID))('rejects %s', (name) => {
    expect(() => presetHash(INVALID[name])).toThrow();
  });
});

describe('the url snapshot of the fx', () => {
  it.each(Object.keys(FX_SNAPS))('%s', (name) => {
    expect(hashOf(fxSnapSchema.parse(FX_SNAPS[name]))).toBe(FX_SNAP_HASHES[name]);
  });
});
