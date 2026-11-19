import {
  designGain2,
  DRIVE_UT,
  driveGain,
  driveLevel,
  MODEL_FILTER_TYPES,
  ModelDesign,
  modelDesign,
  ModelFilterType,
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
  it('the one-poles have no resonance, Low 6, High 6 and the notches no Comp', () => {
    const without = (knob: 'resonance' | 'variation') =>
      MODEL_FILTER_TYPES.filter((type) => !modelKnobsOf(type)[knob]);
    expect(without('resonance')).toEqual(['low6', 'high6', 'loweq6', 'higheq6']);
    expect(without('variation')).toEqual(['low6', 'high6', 'notch12', 'notch24']);
  });
});

describe('Comp', () => {
  // (Comp of the reference's Notch 12 and 24 changes no bit of it at any Res and Drive; the resonance takes nothing off
  // the pass band of a notch)
  it("doesn't change the level of Notch 12 and 24", () => {
    for (const type of ['notch12', 'notch24'] as const)
      for (const resonance of [0.4, 1]) {
        const plain = modelDesign(type, { cutoff: 1000, resonance, variation: 0 }, 48000);
        for (const variation of [0.2, 0.8, 1]) {
          const design = modelDesign(type, { cutoff: 1000, resonance, variation }, 48000);
          expect(design).toEqual(plain);
          expect(design.fat).toBe(1);
          for (const f of [100, 1000, 5000])
            expect(designGain2(design, f, 48000)).toBe(designGain2(plain, f, 48000));
        }
      }
  });

  it('raises the other types of Normal by 1 + 4 Res Comp', () => {
    for (const type of ['low12', 'band24', 'ladder24'] as const) {
      const plain = modelDesign(type, { cutoff: 1000, resonance: 0.4, variation: 0 }, 48000);
      const design = modelDesign(type, { cutoff: 1000, resonance: 0.4, variation: 0.8 }, 48000);
      expect(design.fat).toBeCloseTo(1 + 4 * 0.4 * 0.8, 12);
      expect(designGain2(design, 100, 48000) / designGain2(plain, 100, 48000)).toBeCloseTo(
        design.fat ** 2,
        9
      );
    }
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

  // The largest steps of a type along its cutoff from `from` to the top by steps of 0.005 %: of a section (g and k
  // by their ratio, a tap by the largest of them) and of the chart; a step to a cutoff of `skip` is left out
  const CHART = [1000, 5000, 12000, 18000];
  const stepsAlong = (
    type: ModelFilterType,
    resonance: number,
    from: number,
    skip?: (cutoff: number) => boolean
  ): [number, number] => {
    const rate = 48000;
    const gains = (design: ModelDesign) => CHART.map((f) => Math.sqrt(designGain2(design, f, rate)));
    let before = modelDesign(type, { cutoff: from * rate, resonance, variation: 0 }, rate);
    let drawn = gains(before);
    let [most, chart] = [0, 0];
    for (let cutoff = from * rate * 1.00005; cutoff < 0.46 * rate; cutoff *= 1.00005) {
      const design = modelDesign(type, { cutoff, resonance, variation: 0 }, rate);
      const draws = gains(design);
      if (!skip?.(cutoff)) {
        design.svf.forEach((section, i) => {
          const taps = Math.max(1, ...section.mix.map(Math.abs));
          most = Math.max(
            most,
            Math.abs(section.g / before.svf[i].g - 1),
            Math.abs(section.k / before.svf[i].k - 1),
            ...section.mix.map((tap, j) => Math.abs(tap - before.svf[i].mix[j]) / taps)
          );
        });
        chart = Math.max(chart, ...draws.map((gain, i) => Math.abs(gain - drawn[i])));
      }
      [before, drawn] = [design, draws];
    }
    return [most, chart];
  };

  // nearly without resonance (Res 0 and 0.1 %: the poles of the prototype are real), the cutoff up to the top by
  // steps of 0.005 %: no section moves by over 0.1 % a step, the chart by over 0.001 (a pole that went from one
  // root of the prototype to another moved a section by 5 % to some hundred times at 0.22 to 0.31 fs: the chart
  // jumped there and the voices clicked; filter_model.rs of the core has the same test)
  it('is continuous along the cutoff where the poles of its prototype are real', () => {
    const jumps: string[] = [];
    const types = MODEL_FILTER_TYPES.filter(
      (type) => /^(low|high|band|notch)(12|18|24)$/.test(type) || /eq12$/.test(type)
    );
    for (const type of types)
      for (const resonance of [0, 0.001]) {
        const [most, chart] = stepsAlong(type, resonance, 0.05);
        if (most > 1e-3 || chart > 1e-3) jumps.push(`${type} Res ${resonance}: ${most}, ${chart}`);
      }
    expect(jumps).toEqual([]);
  });

  // with some resonance (a damping under the cusp: Res over 1 %, the second section of a Peak 24 at any) the one
  // real root of the prototype comes nearer than its pair at the top of the cutoff: the poles are the pair there
  // too. Steps of 0.005 % of the cutoff: no section moves by over 0.1 % a step (a Peak 1 %), the chart by over
  // 0.001 (the poles went to the real root: a section moved by 80 % to ten times at 0.26 to 0.45 fs)
  it('is continuous along the cutoff where the real root of its prototype passes the pair', () => {
    const jumps: string[] = [];
    const cases: [ModelFilterType, number][] = [
      ['low12', 0.012],
      ['low12', 0.02],
      ['low18', 0.02],
      ['low24', 0.03],
      ['low24', 0.1],
      ['notch12', 0.02],
      ['notch24', 0.05],
      ['peak12', 0.03],
      ['peak24', 0.02],
      ['peak24', 0.5],
    ];
    // (the numerator of a Peak is another one from a cutoff of fs/π)
    const zeros = 48000 / Math.PI;
    for (const [type, resonance] of cases) {
      const peak = type.startsWith('peak');
      const [most, chart] = stepsAlong(
        type,
        resonance,
        0.15,
        (cutoff) => peak && cutoff >= zeros && cutoff / 1.00005 < zeros
      );
      if (most > (peak ? 1e-2 : 1e-3) || chart > 1e-3)
        jumps.push(`${type} Res ${resonance}: ${most}, ${chart}`);
    }
    expect(jumps).toEqual([]);
  });
});
