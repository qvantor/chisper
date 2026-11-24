import { filterModel } from '@chisper/math';
import { fxFilterResponse, renderFxFilter } from '../../../../test-utils/fxfilter-render';
import { FX_FILTER_TYPES, fxFilterIndexOf, fxFilterTypeOf } from './fxfilter-params';

// the Rust core of the FX Filter through its facade (dsp/chain/src/fxfilter.rs; its cargo tests hold the rest): it
// plays the design the screen draws (filterModel.fxFilterDesign: the filter of a voice with the droop of the
// reference), its keys reach it, a change of type and a sweep make no click, silence rests it

const RATE = 48000;
const N = 1 << 15;

// the response (dB) of the core at `frequencies`: a quiet impulse through it, the DFT of what came out
const responseOf = (params: Parameters<typeof renderFxFilter>[0], frequencies: number[], rate = RATE) =>
  fxFilterResponse(params, rate, frequencies, { amplitude: 0.001, n: N });

const FREQUENCIES = [40, 120, 400, 900, 2000, 4500, 9000, 15000];

describe('fxfilter core', () => {
  it('keeps the types of the core in its order: those of Normal of the voice, MG Low 6 for one it has not', () => {
    expect(FX_FILTER_TYPES).toEqual(filterModel.MODEL_FILTER_TYPES.slice(0, 18));
    expect(fxFilterTypeOf(18)).toBe('ladder6');
    expect(fxFilterTypeOf(3.2)).toBe('ladder24');
  });

  it.each([
    ['ladder24', 1500, 30, 0],
    ['low12', 800, 0, 20],
    ['high18', 300, 20, 0],
    ['band24', 2000, 10, 50],
    ['notch12', 1000, 0, 0],
    ['peak24', 3000, 30, 0],
    ['low6', 5000, 0, 0],
  ] as const)('plays the design the screen draws: %s at %d Hz, Res %d, Fat %d', (type, cutoff, res, fat) => {
    const ours = responseOf({ type: fxFilterIndexOf(type), cutoff, res, var: fat }, FREQUENCIES);
    const design = filterModel.fxFilterDesign(
      type,
      { cutoff, resonance: res / 100, variation: fat / 100 },
      RATE
    );
    FREQUENCIES.forEach((hz, i) => {
      const expected = 10 * Math.log10(filterModel.designGain2(design, hz, RATE));
      if (expected > -60) expect([hz, Math.abs(ours[i] - expected) < 0.1]).toEqual([hz, true]);
    });
  });

  it('droops its highs more than the filter of a voice: by its sections, a ladder by its own', () => {
    const gap = (type: (typeof FX_FILTER_TYPES)[number], hz: number) => {
      const knobs = { cutoff: 100, resonance: 0, variation: 0 };
      const voice = filterModel.modelDesign(type, knobs, RATE);
      const fx = filterModel.fxFilterDesign(type, knobs, RATE);
      return (
        10 * Math.log10(filterModel.designGain2(fx, hz, RATE) / filterModel.designGain2(voice, hz, RATE))
      );
    };
    // (-2.2 dB at 14.4 kHz of a high pass of 6 dB of the measurements, -4.3 of one of 24: fxfilter.json)
    expect(gap('high6', 14422)).toBeGreaterThan(-2.4);
    expect(gap('high6', 14422)).toBeLessThan(-1.4);
    expect(gap('high24', 14422) / gap('high6', 14422)).toBeGreaterThan(1.6);
    expect(gap('high6', 1000)).toBeGreaterThan(-0.02);
    expect([filterModel.fxFilterDroop('low12'), filterModel.fxFilterDroop('low24')]).toEqual([18, 36]);
    expect([filterModel.fxFilterDroop('low18'), filterModel.fxFilterDroop('ladder24')]).toEqual([36, 32]);
  });

  it('crossfades a change of type, a sweep of its cutoff by the knob makes no click', () => {
    const frames = 32 * 128;
    const sine = Float64Array.from(
      { length: frames },
      (_, i) => 0.5 * Math.sin((2 * Math.PI * 220 * i) / RATE)
    );
    const { left } = renderFxFilter(
      { type: fxFilterIndexOf('low24'), cutoff: 300, res: 40 },
      RATE,
      [sine, sine],
      [
        { at: 8 * 128, params: { type: fxFilterIndexOf('high12') } },
        { at: 16 * 128, params: { cutoff: 8000 } },
        { at: 24 * 128, params: { cutoff: 60, res: 80 } },
      ]
    );
    let steepest = 0;
    for (let i = 1; i < frames; i++) steepest = Math.max(steepest, Math.abs(left[i] - left[i - 1]));
    // (the sine itself steps by 0.0145 at most)
    expect(steepest).toBeLessThan(0.03);
  });

  it('rests after its tail in silence: idle, silent', () => {
    const frames = 300 * 128;
    const noise = Float64Array.from({ length: frames }, (_, i) => (i < 4096 ? Math.sin(i * i) * 0.3 : 0));
    const { left, idle } = renderFxFilter(
      { type: fxFilterIndexOf('ladder12'), cutoff: 1000, res: 60 },
      RATE,
      [noise, noise]
    );
    const rested = idle.findIndex((isIdle, block) => isIdle && block > 32);
    expect(rested).toBeGreaterThan(32);
    expect(left.subarray((rested + 1) * 128).every((x) => x === 0)).toBe(true);
  });
});
