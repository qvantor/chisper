import { createHash } from 'crypto';
import { presetHash } from './hash';
import { normalizePreset } from './normalize';
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
    wm: 1,
    wa: 0.4,
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
    wm: 4,
    wa: 0.75,
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
    o: ['reverb', 'compressor', 'chorus', 'distortion', 'eq'],
    distortion: { a: true, on: false, mix: 0.6, mode: 1, drive: 4, tone: 8000, level: -6 },
    eq: {
      a: true,
      on: true,
      mix: 0.9,
      t1: 2,
      f1: 85.5,
      q1: 42,
      g1: 0,
      t2: 1,
      f2: 6300,
      q2: 77.5,
      g2: -4.5,
      level: 0.6,
    },
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
  // a model type of the filter with its Drive and Var
  'a model filter': { filter: { a: true, t: 'ladder24', cut: 880, res: 35.5, dr: 20, v: 0 } },
  // a type of a newer client: the default type (the hash of the preset with it)
  'an unknown filter type': { filter: { a: true, t: 'comb', cut: 880 } },
  'its default type': { filter: { a: true, t: 'lowpass', cut: 880 } },
  // the macros at 0: no section (the hash of the preset without macros)
  'the macros at 0': { mac: { m1: 0, m3: 0 } },
  'no macros': { mac: {} },
  // the levels of the macros and routes of them
  macros: {
    mac: { m1: 0.5, m2: 0, m4: 1 },
    mod: { 'macro1:osc1.wave': 0.5, 'macro4:delay.time': { a: -0.25, bi: true }, 'macro2:lfo1.rate': 0.75 },
  },
};

const PRESET_HASHES: Record<string, string> = {
  empty: '56098bad4ed00d103148f0b994718df212a551ba44ee2ea2872320d3e3ff2d32',
  full: 'd9572894cc934253a823ddba3dca6dabbbf9d8f9d192b9033e631fd3cb429de7',
  legacy: '234daf0f7f1a6811bf3e25dbf28241dcc2fb358a8d822a3c6908bf706b144425',
  partial: '9c889065db141472d4dd9490d97d2aa8bf58b9de2047ad8565e3c0acec2b6ea2',
  'fx order without a type': 'b451078b0b175bd604fa796002ec86b74184e82add5510d2eccaf4b1c45b55ae',
  'a model filter': '4680d5329eb726f28013693650a1237bfc17057882dd86fe52b312495c25b621',
  'an unknown filter type': '135400b36dfaa916b964fb5e0886c59b9dd6ccd1f567f80cf5a8358bd07a6b81',
  'its default type': '135400b36dfaa916b964fb5e0886c59b9dd6ccd1f567f80cf5a8358bd07a6b81',
  'the macros at 0': '56098bad4ed00d103148f0b994718df212a551ba44ee2ea2872320d3e3ff2d32',
  'no macros': '56098bad4ed00d103148f0b994718df212a551ba44ee2ea2872320d3e3ff2d32',
  macros: '0ae91c703e91fa0bfdbd0517469bf8e6d23982af9d6a315383b9b957d6efb559',
};

// not presets: the schema rejects them
const INVALID: Record<string, unknown> = {
  null: null,
  'a fractional unison': { osc1: { u: 1.5 } },
  'a warp mode past the last': { osc1: { wm: 5 } },
  'a fractional warp mode': { osc1: { wm: 1.5 } },
  'a warp knob past 1': { osc2: { wa: 1.5 } },
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
  'a filter drive past 100': { filter: { dr: 101 } },
  'a negative filter variation': { filter: { v: -1 } },
  'an LFO on the knob of an LFO': { mod: { 'lfo1:lfo2.rate': 0.5 } },
  'a macro past 1': { mac: { m2: 1.5 } },
  'a negative macro': { mac: { m1: -0.1 } },
  'a macro that is no number': { mac: { m3: 'half' } },
  'a fifth macro': { mod: { 'macro5:osc1.wave': 0.5 } },
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
  'an EQ type that is none': { fx: { eq: { t1: 3 } } },
};

// the url snapshot of the fx: never fails, invalid values fall back to the defaults
const FX_SNAPS: Record<string, unknown> = {
  null: null,
  garbage: { o: 'reverb', delay: { time: 'abc', fb: 5, div: 3.6 }, reverb: { era: 1.6, a: 'yes' }, x: 1 },
  full: FULL.fx,
};

const FX_SNAP_HASHES: Record<string, string> = {
  null: '86be5d469158d242c547b4be48ad0bf3c5af162ed3a5ad75292cf36d1a03942a',
  garbage: 'a475dacb3581f11e3a5b5d9b3d89165c1fd887cf41402d7a5ab51ea442316fe6',
  full: 'fefe4741f3993e95cf7747c0aa2f4fb9d0efbd20b1b3b851841dc51d2fbfe291',
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

  it('the macros at 0 leave out their section: the presets of before keep their hashes', () => {
    expect(PRESET_HASHES['the macros at 0']).toBe(PRESET_HASHES['empty']);
    expect(normalizePreset({ mac: { m1: 0 } })).not.toHaveProperty('mac.m1');
    expect(normalizePreset(PRESETS['macros']).mac).toEqual({ m1: 0.5, m4: 1 });
  });

  it('a filter type of a newer client is the default one', () => {
    expect(PRESET_HASHES['an unknown filter type']).toBe(PRESET_HASHES['its default type']);
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
