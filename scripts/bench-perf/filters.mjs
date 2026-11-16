// CPU of every filter type of a voice (Node, wasm core): 32 cheap voices (one oscillator, unison 1) so the filter
// dominates, each case minus the same voices without the filter. Knobs at rest in several positions, and LFO 1 on the
// cutoff (slow, fast; of every voice by its own amount: no design shared by the voices, as ENV 2 or the velocity
// would move it) and on the resonance, Drive and Var (fast; shared, and of every voice by its own amount: a design
// a span of each voice where the type is designed by the knob); the cutoff knob turned (a new cutoff to every voice
// every 4 blocks, 300 Hz to 5 kHz and back: it glides). `node scripts/bench-perf/filters.mjs [--types=a,b] [--json=out]`
import fs from 'node:fs';
import { frame, lfoStateOf, loadDsp, timeCalls } from './dsp.mjs';
import { median, parseArgs } from './util.mjs';

const BLOCK = 128;
const RATE = 48000;
const VOICES = 32;
const SAMPLES = 7;
const args = parseArgs(process.argv.slice(2));

const dsp = await loadDsp(undefined, 'filters');
const core = dsp.wasm['wavetable-osc'];
if (!core || !dsp.createVoiceScopeWasm) throw new Error('no wavetable-osc core: npm run wasm');
// the types of a BiquadFilterNode, then the model ones from the first ladder (VOICE_FILTER_TYPES)
const MODEL = dsp.VOICE_FILTER_TYPES.slice(dsp.VOICE_FILTER_TYPES.indexOf('ladder6'));
const types = args.types?.split(',') ?? dsp.VOICE_FILTER_TYPES;
const oscScope = dsp.createOscScope(core);
const store = dsp.createTableStoreWasm(oscScope);
store.set('a', 1, dsp.buildLevels(Array.from({ length: 16 }, (_, k) => frame(k))));
store.listen?.(() => undefined);

const BASE = {
  frequency: 220,
  gate: 1,
  position1: 0.5,
  position2: 0.5,
  detune1: 0,
  detune2: 0,
  spread1: 0,
  spread2: 0,
  gain1: 0.05,
  gain2: 0,
  blend1: 0.5,
  blend2: 0.5,
};
const outL = new Float32Array(BLOCK);
const outR = new Float32Array(BLOCK);

// `own`: the route of each voice by an amount of its own
const make =
  (filter, routes, period, own = false, turned = false) =>
  () => {
    const voices = dsp.createVoiceScopeWasm(oscScope, RATE, store, dsp.createVoiceSharedWasm(oscScope));
    voices.apply([{ kind: 'lfos', ...lfoStateOf(dsp, period) }]);
    const options = {
      osc: [{ table: 'a', unison: 1, phase: 0, phaseRand: 1 }, null],
      start: 0,
      envelopes: [0, 1, 2].map(() => ({ attack: 0, hold: 0, decay: 0, sustain: 1, release: 0 })),
      envStart: 0,
      phrase: 0,
      routes,
      filter,
    };
    const routesOf = (voice) =>
      own ? routes.map((r) => ({ ...r, amount: r.amount * (1 + voice * 0.003) })) : routes;
    voices.apply(
      Array.from({ length: VOICES }, (_, voice) => ({
        kind: 'on',
        voice,
        options: { ...options, routes: routesOf(voice) },
        params: { ...BASE, frequency: 110 * 2 ** (voice / 12) },
      }))
    );
    let block = 0;
    return () => {
      if (turned && block % 4 === 0) {
        const t = (block / 4) % 64;
        const cutoff = 300 * 2 ** ((4 * (t < 32 ? t : 64 - t)) / 32);
        const all = Array.from({ length: VOICES }, (_, voice) => voice);
        voices.apply([{ kind: 'filter', voices: all, filter: { ...filter, cutoff } }]);
      }
      voices.process(block * BLOCK, outL, outR);
      voices.reports();
      block++;
    };
  };
// ns per sample per voice
const time = (call, ms) => timeCalls(call, ms) / BLOCK / VOICES;
const measure = (create) => {
  const call = create();
  time(call, 150);
  const s = [];
  for (let i = 0; i < SAMPLES; i++) s.push(time(call, 120));
  return median(s);
};

const cutRoute = [
  { source: 4, param: 'cutoff', amount: 2, min: 20, max: 20000, scale: 'log', bipolar: true },
];
const resRoute = (model) => [
  {
    source: 4,
    param: 'resonance',
    bipolar: true,
    ...(model ? { amount: 40, min: 0, max: 100 } : { amount: 12, min: -12, max: 24 }),
  },
];

// the other knobs: Drive and Var (model types), Gain (EQ types, and the biquad ones)
const knobRoute = (param, amount, min, max) => ({ source: 4, param, amount, min, max, bipolar: true });
const extraRoutes = (model) =>
  model
    ? [knobRoute('drive', 40, 0, 100), knobRoute('variation', 40, 0, 100), knobRoute('gain', 12, -24, 24)]
    : [knobRoute('gain', 12, -24, 24)];

const scenarios = (type) => {
  const model = MODEL.includes(type);
  const f = (cutoff, resonance, drive = 0, variation = 0) => ({
    type,
    cutoff,
    resonance,
    gain: model ? 0 : 6,
    ...(model && { drive, variation }),
  });
  const lo = model ? 10 : 1;
  const hi = model ? 85 : 18;
  const mid = model ? 50 : 8;
  const list = [
    ['rest 300Hz res lo', make(f(300, lo), [], 1)],
    ['rest 1.2k res mid', make(f(1200, mid), [], 1)],
    ['rest 8k res hi', make(f(8000, hi), [], 1)],
    ['rest 120Hz res hi', make(f(120, hi), [], 1)],
    ['lfo cut slow 0.5Hz', make(f(1200, mid), cutRoute, 2)],
    ['lfo cut fast 8Hz', make(f(1200, mid), cutRoute, 0.125)],
    ['lfo cut own 8Hz', make(f(1200, mid), cutRoute, 0.125, true)],
    ['knob cutoff turned', make(f(1200, mid), [], 1, false, true)],
    ['lfo res fast 8Hz', make(f(1200, mid), resRoute(model), 0.125)],
    ['lfo res own 8Hz', make(f(1200, mid), resRoute(model), 0.125, true)],
  ];
  list.push(['lfo gain/drive/var 8Hz', make(f(1200, mid, 40, 40), extraRoutes(model), 0.125)]);
  list.push([
    'lfo ALL knobs 8Hz',
    make(f(1200, mid, 40, 40), [...cutRoute, ...resRoute(model), ...extraRoutes(model)], 0.125, true),
  ]);
  if (model) {
    list.push(['rest drive0 fat0', make(f(1200, 60), [], 1)]);
    list.push(['rest drive100 fat100', make(f(1200, 60, 100, 100), [], 1)]);
    list.push(['rest drive60 fat60', make(f(1200, 60, 60, 60), [], 1)]);
    list.push(['lfo cut fast drive60 fat60', make(f(1200, 60, 60, 60), cutRoute, 0.125)]);
    list.push(['lfo drive own 8Hz', make(f(1200, mid, 40), [knobRoute('drive', 40, 0, 100)], 0.125, true)]);
    list.push([
      'lfo var own 8Hz',
      make(f(1200, mid, 0, 40), [knobRoute('variation', 40, 0, 100)], 0.125, true),
    ]);
  }
  return list;
};

const base = { rest: measure(make(null, [], 1)), lfo: measure(make(null, cutRoute, 0.125)) };
console.error(
  `base (no filter): ${base.rest.toFixed(1)} ns/sample/voice, with lfo route ${base.lfo.toFixed(1)}`
);
const rows = [];
for (const type of types) {
  const row = { type };
  for (const [name, create] of scenarios(type)) {
    row[name] = measure(create) - (name.startsWith('lfo') ? base.lfo : base.rest);
  }
  rows.push(row);
  console.error(type);
}
if (args.json) fs.writeFileSync(args.json, JSON.stringify({ base, rows }, null, 1));
const cols = [...new Set(rows.flatMap((r) => Object.keys(r).filter((k) => k !== 'type')))];
const worst = (r) => Math.max(...cols.map((c) => r[c] ?? 0));
rows.sort((a, b) => worst(b) - worst(a));
console.log(['type', ...cols].join(' | '));
for (const r of rows)
  console.log([r.type, ...cols.map((c) => (r[c] == null ? '-' : r[c].toFixed(1)))].join(' | '));
