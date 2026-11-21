// the params, the options and the laws of the EQ (its Rust core: dsp/chain/src/eq.rs, eq-wasm.ts; its design:
// eq of @chisper/math), no signal processing here

// the EQ params (FX_PARAMS.eq; the mix is of its slot): of each band its type (an index into EQ_TYPES), frequency
// (Hz), resonance (%) and gain (dB), then the level (the knob, 0..1)
export interface EqDspParams {
  t1: number;
  f1: number;
  q1: number;
  g1: number;
  t2: number;
  f2: number;
  q2: number;
  g2: number;
  level: number;
}

export interface EqOptions {
  params: EqDspParams;
}

// the keys of each band: type, frequency, resonance, gain
export const EQ_BANDS = [
  { type: 't1', freq: 'f1', reso: 'q1', gain: 'g1' },
  { type: 't2', freq: 'f2', reso: 'q2', gain: 'g2' },
] as const;
export type EqBandKeys = (typeof EQ_BANDS)[number];

// the types of a band (EQ_SHELF, EQ_PEAK, EQ_PASS of @chisper/math), a param is an index into them: new types are
// appended only, the indexes are saved in presets. The labels by band: band 1 is the low one, band 2 the high one
export const EQ_TYPES = [
  { id: 'shelf', labels: ['Low shelf', 'High shelf'] },
  { id: 'peak', labels: ['Peak', 'Peak'] },
  { id: 'pass', labels: ['Low cut', 'High cut'] },
] as const;
// the options of the switch of the type of band `band` (0, 1)
export const eqTypeOptions = (band: number) =>
  EQ_TYPES.map(({ id, labels }) => ({ id, label: labels[band] }));
