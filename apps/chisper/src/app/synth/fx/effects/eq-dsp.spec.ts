import { EQ_PASS, EQ_PEAK, EQ_SHELF, eqDesign, eqGainDb } from '@chisper/math/eq';
import { bandParams, EQ_DEFAULTS, eqCore, renderEq, responseOf } from '../../../../test-utils/eq-render';
import { createEqWasm } from './eq-wasm';
import { levelGain } from './level';

// the Rust core of the EQ (dsp/chain/src/eq.rs) through its facade: what it plays is the curve the screen draws
// (eqDesign, eqGainDb of @chisper/math), a neutral EQ is the input, the slopes, the level, its rest

const RATE = 48000;
const FREQUENCIES = [20, 45, 100, 250, 600, 1000, 1500, 4000, 9000, 15000, 19000];

const sine = (hz: number, frames: number, level = 0.5, rate = RATE) =>
  Float64Array.from({ length: frames }, (_, i) => level * Math.sin((2 * Math.PI * hz * i) / rate));

describe('eq wasm core', () => {
  it.each([44100, RATE, 96000])('plays the curve the screen draws, every band and type, at %d Hz', (rate) => {
    for (const band of [0, 1])
      for (const type of [EQ_SHELF, EQ_PEAK, EQ_PASS])
        for (const [freq, reso, gain] of [
          [60, 80, 12],
          [1000, 30, -18],
          [12000, 60, 24],
        ]) {
          const played = responseOf(bandParams(band, type, freq, reso, gain), rate, FREQUENCIES);
          const drawn = FREQUENCIES.map((hz) =>
            eqGainDb([eqDesign(band, type, freq, reso, gain, rate)], hz, rate)
          );
          played.forEach((db, i) => {
            // (where it is far under, its noise of f32 is: compared over -60 dB)
            if (drawn[i] > -60) expect(db).toBeCloseTo(drawn[i], 2);
          });
        }
  });

  it('plays both bands one after the other, the level after them', () => {
    const params = { t1: EQ_PASS, f1: 150, q1: 50, t2: EQ_PEAK, f2: 3000, q2: 40, g2: 9, level: 0.7 };
    const designs = [eqDesign(0, EQ_PASS, 150, 50, 0, RATE), eqDesign(1, EQ_PEAK, 3000, 40, 9, RATE)];
    const level = 20 * Math.log10(levelGain(0.7));
    const played = responseOf(params, RATE, FREQUENCIES);
    FREQUENCIES.forEach((hz, i) => {
      const drawn = eqGainDb(designs, hz, RATE) + level;
      if (drawn > -60) expect(played[i]).toBeCloseTo(drawn, 2);
    });
  });

  it('a fresh EQ is the input bit for bit: its shelves at 0 dB, the level at 0 dB', () => {
    const input = Float64Array.from({ length: 4096 }, (_, i) =>
      Math.fround(Math.sin(i / 3) * 0.7 + Math.sin(i / 17) * 0.2)
    );
    const { left, right } = renderEq({}, RATE, [input, input]);
    expect(Array.from(left)).toEqual(Array.from(input, Math.fround));
    expect(Array.from(right)).toEqual(Array.from(input, Math.fround));
    // (a peak at 0 dB too)
    expect(Array.from(renderEq({ t1: EQ_PEAK, t2: EQ_PEAK }, RATE, [input, input]).left)).toEqual(
      Array.from(input, Math.fround)
    );
  });

  it('cuts 12 dB an octave far from its corner: a highpass under it, a lowpass over it', () => {
    const [low, lower] = responseOf({ t1: EQ_PASS, f1: 2000, q1: 42 }, RATE, [100, 50]);
    expect(low - lower).toBeCloseTo(12, 0);
    const [high, higher] = responseOf({ t2: EQ_PASS, f2: 200, q2: 42 }, RATE, [4000, 8000]);
    expect(high - higher).toBeGreaterThan(11.5);
    // (cramped to nothing at nyquist: the bilinear transform, as the reference)
    expect(responseOf({ t2: EQ_PASS, f2: 1000, q2: 42 }, RATE, [23900])[0]).toBeLessThan(-80);
  });

  it('a pass takes no gain, a shelf has half of its gain at its frequency', () => {
    const [cut] = responseOf({ t1: EQ_PASS, f1: 500, g1: 18 }, RATE, [1000]);
    const [same] = responseOf({ t1: EQ_PASS, f1: 500, g1: -18 }, RATE, [1000]);
    expect(cut).toBeCloseTo(same, 6);
    expect(responseOf({ t2: EQ_SHELF, f2: 3000, g2: -12 }, RATE, [3000])[0]).toBeCloseTo(-6, 2);
  });

  it('its level: × 4 knob², gliding to a new one', () => {
    const input = sine(1000, RATE / 2);
    [
      [0.25, 0.25],
      [1, 4],
    ].forEach(([knob, gain]) => {
      const { left } = renderEq({ level: knob }, RATE, [input, input]);
      for (let i = 0; i < 1000; i++) expect(left[i]).toBeCloseTo(gain * Math.fround(input[i]), 5);
    });
    const { left } = renderEq({}, RATE, [input, input], [{ at: 4096, params: { level: 1 } }]);
    // (no step: 10 ms to it)
    expect(Math.abs(left[4096] - Math.fround(input[4096]))).toBeLessThan(0.01);
    expect(Math.abs(left[RATE / 2 - 1])).toBeCloseTo(4 * Math.abs(Math.fround(input[RATE / 2 - 1])), 3);
  });

  it('a knob moved glides there, a type changed fades there: no step out', () => {
    const input = sine(300, RATE / 2);
    const params = { t1: EQ_PEAK, f1: 300, q1: 50, g1: 12 };
    const changes = [
      { at: 4096, params: { f1: 3000, g1: -12 } },
      { at: 12288, params: { t1: EQ_PASS } },
    ];
    const moved = renderEq(params, RATE, [input, input], changes).left;
    const still = renderEq(params, RATE, [input, input]).left;
    // at the first sample of each change it is still where it was
    expect(Math.abs(moved[4096] - still[4096])).toBeLessThan(0.01);
    const before = renderEq(params, RATE, [input, input], changes.slice(0, 1)).left;
    expect(Math.abs(moved[12288] - before[12288])).toBeLessThan(0.01);
    // (and it moved: the peak away from the sine, then the highpass far over it)
    const level = (from: number) => Math.max(...Array.from(moved.subarray(from, from + 2000), Math.abs));
    expect(level(10000)).toBeLessThan(0.6);
    expect(level(20000)).toBeLessThan(0.1);
  });

  it('rests in a silence and after a sound once its tail is out, a clear forgets it', () => {
    const input = new Float64Array(RATE);
    input.set(sine(200, 4800), 4800);
    const { idle } = renderEq({ t1: EQ_PEAK, f1: 200, q1: 60, g1: 12 }, RATE, [input, input]);
    expect(idle[0]).toBe(true);
    expect(idle[50]).toBe(false);
    expect(idle[idle.length - 1]).toBe(true);
    const dsp = createEqWasm(eqCore(), RATE, { params: { ...EQ_DEFAULTS, t1: EQ_PEAK, g1: 12 } });
    const block = Float32Array.from(sine(200, 128));
    const out = [new Float32Array(128), new Float32Array(128)];
    dsp.process(block, block, out[0], out[1]);
    expect(dsp.idle).toBe(false);
    dsp.clear();
    expect(dsp.idle).toBe(true);
    dsp.free();
  });
});
