import { truePeak } from './true-peak';

describe('truePeak', () => {
  it('finds the peak between the samples: a sine at a quarter of the rate, its samples at 0.71 of it', () => {
    const x = Float32Array.from({ length: 4096 }, (_, i) => Math.sin((Math.PI / 2) * i + Math.PI / 4));
    expect(Math.max(...Array.from(x, Math.abs))).toBeCloseTo(Math.SQRT1_2, 5);
    expect(truePeak(x, 64, 4032)).toBeCloseTo(1, 2);
  });

  it('a constant as it is when read on into its start (a loop); its ends ring after silence', () => {
    const x = new Float32Array(256).fill(0.5);
    expect(truePeak(x, 0, x.length, true)).toBeCloseTo(0.5, 12);
    expect(truePeak(x)).toBeGreaterThan(0.52);
  });

  it('the samples of a range alone', () => {
    const x = new Float32Array(512);
    x[400] = 0.9;
    expect(truePeak(x, 0, 300)).toBe(0);
    expect(truePeak(x, 300, 512)).toBeCloseTo(0.9, 6);
  });
});
