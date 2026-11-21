import { EQ_PASS, EQ_PEAK, EQ_SHELF, eqDesign, eqGain2At, eqGainDb, eqQ, eqResoOfQ, eqTypeOf } from './eq';

const RATE = 48000;
const dbOf = (band: number, type: number, freq: number, reso: number, gain: number, f: number, rate = RATE) =>
  eqGainDb([eqDesign(band, type, freq, reso, gain, rate)], f, rate);

// the cookbook (R. Bristow-Johnson) of a band with the laws of the reference: its gain (dB) at f
const cookbookDb = (band: number, type: number, freq: number, reso: number, gain: number, f: number) => {
  const x = reso / 100;
  const q = type === EQ_SHELF ? 0.4 + 1.7416 * x ** 3 : 0.1 + 18.9 * x ** 4;
  const w0 = (2 * Math.PI * freq) / RATE;
  const [c, s] = [Math.cos(w0), Math.sin(w0)];
  const al = s / (2 * q);
  const A = 10 ** (gain / 40);
  const sq = 2 * Math.sqrt(A) * al;
  const kind =
    type === EQ_PASS ? (band === 0 ? 'hp' : 'lp') : type === EQ_PEAK ? 'peak' : band === 0 ? 'ls' : 'hs';
  const coefs = {
    hp: [(1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al],
    lp: [(1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al],
    peak: [1 + al * A, -2 * c, 1 - al * A, 1 + al / A, -2 * c, 1 - al / A],
    ls: [
      A * (A + 1 - (A - 1) * c + sq),
      2 * A * (A - 1 - (A + 1) * c),
      A * (A + 1 - (A - 1) * c - sq),
      A + 1 + (A - 1) * c + sq,
      -2 * (A - 1 + (A + 1) * c),
      A + 1 + (A - 1) * c - sq,
    ],
    hs: [
      A * (A + 1 + (A - 1) * c + sq),
      -2 * A * (A - 1 + (A + 1) * c),
      A * (A + 1 + (A - 1) * c - sq),
      A + 1 - (A - 1) * c + sq,
      2 * (A - 1 - (A + 1) * c),
      A + 1 - (A - 1) * c - sq,
    ],
  }[kind];
  const [b0, b1, b2, a0, a1, a2] = coefs;
  const w = (2 * Math.PI * f) / RATE;
  const part = (x0: number, x1: number, x2: number) =>
    Math.hypot(x0 + x1 * Math.cos(w) + x2 * Math.cos(2 * w), x1 * Math.sin(w) + x2 * Math.sin(2 * w));
  return 20 * Math.log10(part(b0, b1, b2) / part(a0, a1, a2));
};

describe('eq', () => {
  it('has the response of the cookbook in every band, type and knob', () => {
    for (const band of [0, 1])
      for (const type of [EQ_SHELF, EQ_PEAK, EQ_PASS])
        for (const [freq, reso, gain] of [
          [21.53, 0, -24],
          [150, 60, 12],
          [1000, 50, -6],
          [9000, 100, 24],
          [20000, 30, 3],
        ])
          for (const f of [20, 100, 900, 1000, 5000, 16000, 23000]) {
            const g = type === EQ_PASS ? 0 : gain;
            expect(dbOf(band, type, freq, reso, gain, f)).toBeCloseTo(
              cookbookDb(band, type, freq, reso, g, f),
              6
            );
          }
  });

  it('peaks at its gain, a shelf has half of it at its frequency, a pass its Q', () => {
    expect(dbOf(0, EQ_PEAK, 1000, 50, 12, 1000)).toBeCloseTo(12, 9);
    expect(dbOf(1, EQ_PEAK, 300, 100, -24, 300)).toBeCloseTo(-24, 9);
    expect(dbOf(0, EQ_SHELF, 1000, 50, -12, 1000)).toBeCloseTo(-6, 9);
    expect(dbOf(1, EQ_SHELF, 4000, 0, 18, 4000)).toBeCloseTo(9, 9);
    expect(dbOf(0, EQ_SHELF, 200, 60, 12, 20)).toBeCloseTo(12, 1);
    expect(dbOf(1, EQ_SHELF, 2000, 60, 12, 20)).toBeCloseTo(0, 1);
    // (a pass: |H| = Q at its frequency, Q of 0.1 at 0 %, 1.28125 at 50 %)
    expect(dbOf(0, EQ_PASS, 1000, 0, 0, 1000)).toBeCloseTo(-20, 9);
    expect(dbOf(1, EQ_PASS, 1000, 50, 0, 1000)).toBeCloseTo(20 * Math.log10(0.1 + 18.9 / 16), 9);
    // (12 dB an octave: a highpass far under it, a lowpass far over it; cramped to nothing at nyquist)
    expect(dbOf(0, EQ_PASS, 4000, 30, 0, 100) - dbOf(0, EQ_PASS, 4000, 30, 0, 50)).toBeCloseTo(12, 1);
    expect(dbOf(1, EQ_PASS, 1000, 30, 0, 23999)).toBeLessThan(-100);
  });

  it('the Q of a peak and a pass at a resonance and back', () => {
    expect(eqQ(0)).toBeCloseTo(0.1, 12);
    expect(eqQ(100)).toBeCloseTo(19, 12);
    expect([eqQ(-10), eqQ(150)]).toEqual([eqQ(0), eqQ(100)]);
    [0, 12.5, 50, 99, 100].forEach((reso) => expect(eqResoOfQ(eqQ(reso))).toBeCloseTo(reso, 6));
    expect([eqResoOfQ(0.01), eqResoOfQ(40)]).toEqual([0, 100]);
  });

  it('is the input at 0 dB of a shelf or a peak', () => {
    for (const band of [0, 1])
      for (const type of [EQ_SHELF, EQ_PEAK]) {
        const [, , m0, m1, m2] = eqDesign(band, type, 700, 80, 0, RATE);
        expect([m0, m1, m2]).toEqual([1, 0, 0]);
      }
  });

  it('stops its knobs at their ends, a pass takes no gain', () => {
    expect(eqDesign(0, EQ_PEAK, 5, 50, 12, RATE)).toEqual(eqDesign(0, EQ_PEAK, 20, 50, 12, RATE));
    expect(eqDesign(0, EQ_PEAK, 25000, 50, 12, RATE)).toEqual(eqDesign(0, EQ_PEAK, 20000, 50, 12, RATE));
    expect(eqDesign(1, EQ_SHELF, 1000, 150, 40, RATE)).toEqual(eqDesign(1, EQ_SHELF, 1000, 100, 24, RATE));
    expect(eqDesign(1, EQ_PEAK, 1000, -10, -40, RATE)).toEqual(eqDesign(1, EQ_PEAK, 1000, 0, -24, RATE));
    expect(eqDesign(0, EQ_PASS, 1000, 50, 12, RATE)).toEqual(eqDesign(0, EQ_PASS, 1000, 50, -24, RATE));
    // (under nyquist at a low rate)
    expect(eqDesign(1, EQ_PEAK, 20000, 50, 12, 22050)[0]).toBeLessThan(1000);
    expect([eqTypeOf(0), eqTypeOf(1), eqTypeOf(2), eqTypeOf(5), eqTypeOf(-1)]).toEqual([0, 1, 2, 2, 0]);
  });

  it('multiplies the gains of its bands', () => {
    const a = eqDesign(0, EQ_SHELF, 200, 60, 6, RATE);
    const b = eqDesign(1, EQ_PEAK, 3000, 40, -9, RATE);
    const theta = (2 * Math.PI * 1500) / RATE;
    const both = eqGainDb([a, b], 1500, RATE);
    const apart =
      10 * Math.log10(eqGain2At(a, Math.cos(theta), Math.sin(theta))) +
      10 * Math.log10(eqGain2At(b, Math.cos(theta), Math.sin(theta)));
    expect(both).toBeCloseTo(apart, 9);
    expect(eqGainDb([], 1500, RATE)).toBe(0);
  });
});
