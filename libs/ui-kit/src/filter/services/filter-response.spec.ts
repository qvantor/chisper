import { filterModel } from '@chisper/math';
import { DB_RANGE, frequencyResponseDb, frequencyX, responseBuffers, responseInto } from './index';

const sampleRate = 48000;
const db = (
  type: BiquadFilterType,
  props: Partial<{ cutoff: number; resonance: number; gain: number }>,
  f: number
) => frequencyResponseDb(type, { cutoff: 1000, resonance: 0, gain: 0, ...props }, f, sampleRate);

// the points of the chart as [frequency, dB]
const getChartData = (type: BiquadFilterType, props: Parameters<typeof responseInto>[1], rate: number) => {
  const buffers = responseBuffers();
  const count = responseInto(type, props, rate, buffers);
  return Array.from({ length: count }, (_, i): [number, number] => [buffers.freqs[i], buffers.dbs[i]]);
};

describe('filter frequency response', () => {
  it('lowpass: flat below cutoff, Q (dB) at cutoff, -12 dB/oct above', () => {
    expect(db('lowpass', {}, 20)).toBeCloseTo(0, 1);
    expect(db('lowpass', {}, 1000)).toBeCloseTo(0, 0);
    expect(db('lowpass', { resonance: 20 }, 1000)).toBeCloseTo(20, 0);
    expect(db('lowpass', {}, 10000)).toBeLessThan(-38);
    expect(db('lowpass', { cutoff: 30000 }, 15000)).toBeCloseTo(0, 5);
  });

  it('highpass: mirrors lowpass', () => {
    expect(db('highpass', {}, 15000)).toBeCloseTo(0, 0);
    expect(db('highpass', { resonance: 12 }, 1000)).toBeCloseTo(12, 0);
    expect(db('highpass', {}, 100)).toBeLessThan(-38);
  });

  it('bandpass: 0 dB at cutoff, attenuated around it', () => {
    expect(db('bandpass', { resonance: 5 }, 1000)).toBeCloseTo(0, 5);
    expect(db('bandpass', { resonance: 5 }, 100)).toBeLessThan(-30);
    expect(db('bandpass', { resonance: 5 }, 10000)).toBeLessThan(-30);
  });

  it('notch: deep cut at cutoff, flat away from it', () => {
    expect(db('notch', { resonance: 10 }, 1000)).toBe(-DB_RANGE);
    expect(db('notch', { resonance: 10 }, 100)).toBeCloseTo(0, 1);
    const data = getChartData('notch', { cutoff: 1234, resonance: 10, gain: 0 }, sampleRate);
    expect(data).toContainEqual([1234, -DB_RANGE]);
  });

  it('peaking: gain at cutoff, flat gain when Q is 0', () => {
    expect(db('peaking', { gain: 12, resonance: 1 }, 1000)).toBeCloseTo(12, 5);
    expect(db('peaking', { gain: 12, resonance: 1 }, 20)).toBeCloseTo(0, 1);
    expect(db('peaking', { gain: 12, resonance: 0 }, 50)).toBeCloseTo(12, 5);
  });

  it('shelves: gain on their side, half gain at cutoff', () => {
    expect(db('lowshelf', { gain: 12 }, 20)).toBeCloseTo(12, 1);
    expect(db('lowshelf', { gain: 12 }, 1000)).toBeCloseTo(6, 5);
    expect(db('lowshelf', { gain: 12 }, 18000)).toBeCloseTo(0, 1);
    expect(db('highshelf', { gain: -12 }, 18000)).toBeCloseTo(-12, 0);
    expect(db('highshelf', { gain: -12 }, 1000)).toBeCloseTo(-6, 5);
    expect(db('highshelf', { gain: -12 }, 20)).toBeCloseTo(0, 1);
  });

  it('chart data stops at nyquist', () => {
    const data = getChartData('lowpass', { cutoff: 1000, resonance: 0, gain: 0 }, 24000);
    expect(data[data.length - 1][0]).toBeCloseTo(12000, 5);
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] > 2000) expect(data[i][1]).toBeLessThanOrEqual(data[i - 1][1]);
    }
    expect(getChartData('lowpass', { cutoff: 1000, resonance: 0, gain: 0 }, 48000).pop()?.[0]).toBeCloseTo(
      20000,
      5
    );
  });

  it('chart data is sorted and finite for every type', () => {
    const types: BiquadFilterType[] = [
      'lowpass',
      'highpass',
      'bandpass',
      'lowshelf',
      'highshelf',
      'peaking',
      'notch',
      'allpass',
    ];
    types.forEach((type) =>
      [0, 0.001, 10].forEach((resonance) =>
        [10, 440, 22050].forEach((cutoff) => {
          const data = getChartData(type, { cutoff, resonance, gain: 1 }, sampleRate);
          data.forEach(([f, value], i) => {
            expect(Number.isFinite(value)).toBe(true);
            if (i > 0) expect(f).toBeGreaterThanOrEqual(data[i - 1][0]);
          });
        })
      )
    );
  });

  describe('Drive of a model type', () => {
    const knobs = { cutoff: 2000, resonance: 30, gain: 0, variation: 40 };
    const model = (drive: number, f: number) =>
      frequencyResponseDb('low12', { ...knobs, drive }, f, sampleRate);
    // the design alone
    const design = (f: number) =>
      10 *
      Math.log10(
        filterModel.designGain2(
          filterModel.modelDesign('low12', { cutoff: 2000, resonance: 0.3, variation: 0.4 }, sampleRate),
          f,
          sampleRate
        )
      );

    it('is not drawn at 0', () => {
      [100, 2000, 16000].forEach((f) => expect(model(0, f)).toBeCloseTo(design(f), 10));
    });

    it('raises it by the level of a sine of full scale, the average of two samples over it', () => {
      [0.25, 0.5, 1].forEach((drive) => {
        const level = 20 * Math.log10(filterModel.driveLevel(drive));
        [100, 2000, 16000].forEach((f) => {
          const average = 10 * Math.log10(0.5 * (1 + Math.cos((2 * Math.PI * f) / sampleRate)));
          expect(model(drive * 100, f)).toBeCloseTo(design(f) + level + average, 8);
        });
      });
      // at 100 %: about +12 dB in the pass band, rising with it
      expect(model(100, 100) - model(0, 100)).toBeCloseTo(12.4, 1);
      expect(model(50, 100)).toBeLessThan(model(100, 100));
    });

    it("doesn't move a type of a BiquadFilterNode (it has none)", () => {
      const props = { cutoff: 1000, resonance: 6, gain: 0 };
      [100, 1000, 10000].forEach((f) =>
        expect(frequencyResponseDb('lowpass', { ...props, drive: 80 }, f, sampleRate)).toBe(
          frequencyResponseDb('lowpass', props, f, sampleRate)
        )
      );
    });
  });

  it('frequencyX: the decades of the chart, its last point at the right edge', () => {
    expect(frequencyX(10, 48000)).toBe(0);
    expect(frequencyX(20000, 48000)).toBeCloseTo(1, 12);
    expect(frequencyX(1000, 48000)).toBeCloseTo(2 / Math.log10(2000), 12);
    expect(frequencyX(12000, 24000)).toBeCloseTo(1, 12);
  });
});
