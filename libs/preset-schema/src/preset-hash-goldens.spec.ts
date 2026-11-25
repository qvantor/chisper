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
    o: ['reverb', 'compressor', 'chorus', 'distortion', 'fxfilter', 'eq'],
    distortion: { a: true, on: false, mix: 0.6, mode: 1, drive: 4, tone: 8000, level: -6 },
    fxfilter: {
      a: true,
      on: true,
      mix: 0.75,
      type: 3,
      cutoff: 1200,
      res: 0,
      drive: 35.5,
      var: 20,
      pan: 0,
      level: 0.6,
    },
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
  // empty names: no section (the hash of the preset without macros)
  'empty macro names': { mac: { n1: '', n3: '   ' } },
  // the name of a macro without routes: no section
  'a macro name without routes': { mac: { n2: 'Wobble' } },
  // the names of macros, a level of one, routes of them
  'macro names': {
    mac: { m2: 0.25, n1: '  Bright ', n2: 'Wobble  Depth' },
    mod: { 'macro1:filter.cutoff': 0.5, 'macro2:lfo1.rate': 0.75 },
  },
};

const PRESET_HASHES: Record<string, string> = {
  empty: '5f67da7da31e155c0fd485b0c34929b9dfc6720ef7b69b49f688766eb1ecbc6c',
  full: 'ca37216ea7680de06c437e1db8a2863e0b174f99291af878a3acc420abc33843',
  legacy: '616e74bf59216cb0f2e6e1e6b6bd487fde74cffd169c119a26e44ea844179786',
  partial: '2e58f3fcd6a99b0d6f65ef5f78f66b395086dbef3b9276717191ceb7edd9e190',
  'fx order without a type': '0bee72f914e7d97fe627abb399ca4a3b6dd452d980f837fd2bcf691a849296ec',
  'a model filter': 'b6b70241b2164986ee5a527543f0decba7cb2163caece5fed2d0865ddacef090',
  'an unknown filter type': '26fb0fcb2736d950f3c41fa81b6b04ebae2bccde33fb8493d3733f14fa976684',
  'its default type': '26fb0fcb2736d950f3c41fa81b6b04ebae2bccde33fb8493d3733f14fa976684',
  'the macros at 0': '5f67da7da31e155c0fd485b0c34929b9dfc6720ef7b69b49f688766eb1ecbc6c',
  'no macros': '5f67da7da31e155c0fd485b0c34929b9dfc6720ef7b69b49f688766eb1ecbc6c',
  macros: 'f9c67129a96c3b57b834800b544f67b0eb5e93e5b5349bb0ca8f37cafa1201f7',
  'empty macro names': '5f67da7da31e155c0fd485b0c34929b9dfc6720ef7b69b49f688766eb1ecbc6c',
  'a macro name without routes': '5f67da7da31e155c0fd485b0c34929b9dfc6720ef7b69b49f688766eb1ecbc6c',
  'macro names': '446bab0c0b9e68f70dcefb6ec3d02d83a04d02c77d986e5e5181a7d782266a3e',
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
  'a macro name past 20 characters': { mac: { n2: 'x'.repeat(21) } },
  'a macro name that is no text': { mac: { n4: 4 } },
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
  'a filter type that is none': { fx: { fxfilter: { type: 18 } } },
  'a fractional filter type': { fx: { fxfilter: { type: 2.5 } } },
};

// the url snapshot of the fx: never fails, invalid values fall back to the defaults
const FX_SNAPS: Record<string, unknown> = {
  null: null,
  garbage: {
    o: 'reverb',
    delay: { time: 'abc', fb: 5, div: 3.6 },
    reverb: { era: 1.6, a: 'yes' },
    fxfilter: { type: 30, pan: -4 },
    x: 1,
  },
  full: FULL.fx,
};

const FX_SNAP_HASHES: Record<string, string> = {
  null: 'c5d8471fe660b6845e0ff952f9931453f25b128aa438b9bd7d9a72f31a130882',
  garbage: 'f1aefc542f2e063d20a835d5889eb54cfd06735d459e9b7f22a8fd3fb89a11d0',
  full: 'beb90eb4dde534f0a62bf24677424186dafa7f105fbd7f3170951d741b9750c3',
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

  it('empty names of the macros and those without routes leave out their section; a name is trimmed, its whitespace collapsed', () => {
    expect(PRESET_HASHES['empty macro names']).toBe(PRESET_HASHES['empty']);
    expect(PRESET_HASHES['a macro name without routes']).toBe(PRESET_HASHES['empty']);
    expect(normalizePreset(PRESETS['macro names']).mac).toEqual({
      m2: 0.25,
      n1: 'Bright',
      n2: 'Wobble Depth',
    });
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
