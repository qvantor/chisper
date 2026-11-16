import {
  designGain2,
  DRIVE_UT,
  driveGain,
  driveLevel,
  MODEL_FILTER_TYPES,
  modelDesign,
  modelKnobsOf,
} from './model';

// the curve of Drive as the core has it
const curve = (u: number) => {
  const v = Math.min(Math.max(u, -DRIVE_UT), DRIVE_UT);
  return v - (v * v * v) / (3 * DRIVE_UT * DRIVE_UT);
};

// the fundamental of a sine of `amplitude` through the gain and the curve, by its sampled cycle, over the amplitude
const sampledLevel = (drive: number, amplitude: number) => {
  const n = 1 << 16;
  const gain = driveGain(drive);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = Math.sin((2 * Math.PI * (i + 0.5)) / n);
    sum += curve(gain * amplitude * s) * s;
  }
  return (2 * sum) / n / amplitude;
};

describe('driveLevel', () => {
  it('is 1 without Drive (the core leaves the curve out)', () => {
    expect(driveLevel(0)).toBe(1);
    expect(driveLevel(-0.5)).toBe(1);
  });

  it.each([
    [0.05, 1],
    [0.3, 1],
    [0.5, 0.2],
    [0.5, 1],
    [1, 1],
    [1, 0.05],
  ])('is the fundamental of a sine through the curve: Drive %f, amplitude %f', (drive, amplitude) => {
    expect(driveLevel(drive, amplitude)).toBeCloseTo(sampledLevel(drive, amplitude), 6);
  });

  it('is continuous where the sine reaches the flat top', () => {
    // the drive whose gain brings a sine of 1 to UT
    const knee = Math.pow(DRIVE_UT, 1 / 4) - 1;
    expect(driveLevel(knee - 1e-9)).toBeCloseTo(driveLevel(knee + 1e-9), 6);
    expect(driveLevel(knee)).toBeCloseTo(0.75 * DRIVE_UT, 6);
  });

  it('rises with Drive, ever less, towards the square of the flat top', () => {
    let before = 1;
    for (let drive = 0.05; drive <= 1; drive += 0.05) {
      const level = driveLevel(drive);
      expect(level).toBeGreaterThan(before);
      before = level;
    }
    const top = (4 / Math.PI) * ((2 * DRIVE_UT) / 3);
    expect(driveLevel(1)).toBeLessThan(top);
    expect(driveLevel(1, 100)).toBeCloseTo(top / 100, 4);
  });

  it('is the gain itself for a quiet sine', () => {
    expect(20 * Math.log10(driveLevel(1, 1e-4))).toBeCloseTo(20 * Math.log10(16), 3);
  });
});

describe('modelKnobsOf', () => {
  it('the one-poles have no resonance, Low 6 and High 6 no Comp', () => {
    const without = (knob: 'resonance' | 'variation') =>
      MODEL_FILTER_TYPES.filter((type) => !modelKnobsOf(type)[knob]);
    expect(without('resonance')).toEqual(['low6', 'high6', 'loweq6', 'higheq6']);
    expect(without('variation')).toEqual(['low6', 'high6']);
  });
});

describe('modelDesign', () => {
  // every 1/48 octave, every 10 Hz over 8 kHz up to the top (0.46 fs): the one-pole of High 6 turned unstable in
  // windows of some 100 Hz over 0.39 fs (its feedback so late its pole is no longer real)
  it('has stable sections at every cutoff up to the top', () => {
    const bad: string[] = [];
    for (const sampleRate of [44100, 48000]) {
      const top = 0.46 * sampleRate;
      const cutoffs: number[] = [];
      for (let i = 0; Math.pow(2, i / 48) < 8000; i++) cutoffs.push(Math.pow(2, i / 48));
      for (let f = 8000; f < top; f += 10) cutoffs.push(f);
      cutoffs.push(top);
      for (const type of MODEL_FILTER_TYPES)
        for (const [resonance, variation] of [
          [0, 0],
          [0.5, 1],
          [1, 0],
        ])
          for (const cutoff of cutoffs) {
            const design = modelDesign(type, { cutoff, resonance, variation }, sampleRate);
            const stable =
              design.svf.every((s) => s.g > 0 && s.k > 0 && s.mix.every(Number.isFinite)) &&
              (!design.pole || (design.pole.g > 0 && design.pole.mix.every(Number.isFinite))) &&
              Number.isFinite(designGain2(design, 0.25 * sampleRate, sampleRate));
            if (!stable) bad.push(`${type} ${sampleRate} ${cutoff} Hz ${resonance} ${variation}`);
          }
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });
});
