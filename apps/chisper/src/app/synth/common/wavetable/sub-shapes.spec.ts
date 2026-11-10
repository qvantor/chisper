import { readFileSync } from 'fs';
import { join } from 'path';
import { wave } from '@chisper/math';
import { SUB_SHAPES } from '@chisper/preset-schema';
import { apart, renderedShape, turns } from '../../../../test-utils/measures';
import { PULSE_WIDTH, SUB_FRAME, subShapeFrame, subSpectrum, subTable } from './sub-shapes';

// the shapes of the renders (scripts/renders/run.mjs --only=sub): their harmonics at C2 [amplitude, phase against
// n × that of the first], a cycle of each at C1 from a note on at Phase 0
const MEASURED: { shapes: Record<string, [number, number][]>; cycles: Record<string, number[]> } = JSON.parse(
  readFileSync(join(__dirname, '../../../../../../../dsp/measurements/sub.json'), 'utf8')
);
const SINE = MEASURED.shapes['sine'][0][0];

// the harmonic n of a frame: its amplitude and its phase against n × that of the first (degrees)
const harmonics = (frame: Float32Array) => {
  const [real, imag] = wave.realWithImag(frame);
  const phase = (n: number) => Math.atan2(real[n], imag[n]) / (2 * Math.PI);
  return (n: number): [number, number] => [
    Math.hypot(real[n], imag[n]),
    turns(phase(n) - n * phase(1)) * 360,
  ];
};

describe('the shapes of the sub', () => {
  it('are tables of their own but the sine (the sine of the store)', () => {
    expect(SUB_SHAPES.map(subTable)).toEqual([
      null,
      'sub:round-rect',
      'sub:triangle',
      'sub:saw',
      'sub:square',
      'sub:pulse',
    ]);
  });

  // (the ideal shapes over -50 dB: the renders have the even harmonics of a square at -56 dB; the measured ones as
  // far as they are kept)
  it.each(SUB_SHAPES.map((shape) => [shape]))(
    'plays %s with the harmonics of the renders (against their sine) within 0.1 dB and 2°',
    (shape) => {
      const of = harmonics(subShapeFrame(shape));
      const measured = MEASURED.shapes[renderedShape(shape)];
      const floor = shape === 'triangle' || shape === 'round-rect' ? -64 : -50;
      const off = measured.flatMap(([amplitude, phase], j) => {
        const level = 20 * Math.log10(amplitude / SINE);
        if (level < floor) return [];
        const [ours, ourPhase] = of(j + 1);
        const db = 20 * Math.log10(ours) - level;
        const degrees = apart(ourPhase / 360, phase / 360) * 360;
        // (the treble of the renders a little under 1/n: 0.26 dB at harmonic 40 of a saw)
        return Math.abs(db) > 0.1 + (0.2 * j) / 40 || degrees > 2 + (2 * j) / 40
          ? [{ harmonic: j + 1, db, degrees }]
          : [];
      });
      expect(off).toEqual([]);
    }
  );

  it('keeps the harmonics of saw, square and pulse up to the nyquist of the frame, the DC of the pulse dropped', () => {
    const [real, imag] = subSpectrum('saw');
    expect(Math.hypot(real[SUB_FRAME / 2 - 1], imag[SUB_FRAME / 2 - 1])).toBeCloseTo(0.72769 / 1023, 8);
    const square = subSpectrum('square');
    expect(square[1][1022]).toBe(0);
    expect(Math.abs(square[1][1021])).toBeCloseTo(0.86577 / 1021, 8);
    const pulse = subShapeFrame('pulse');
    expect(pulse.reduce((sum, value) => sum + value, 0) / SUB_FRAME).toBeCloseTo(0, 6);
    // low for its width, high after it (Gibbs aside)
    const low = pulse[Math.round((PULSE_WIDTH / 2) * SUB_FRAME)];
    const high = pulse[Math.round(((1 + PULSE_WIDTH) / 2) * SUB_FRAME)];
    expect(low).toBeLessThan(0);
    expect(high - low).toBeCloseTo((2 * 0.17387) / SINE, 2);
  });

  it.each(SUB_SHAPES.map((shape) => [shape]))('draws %s as the cycle of the renders', (shape) => {
    // (the renders at C1: 735 harmonics, a few samples after the start of the block; their DC (the pulse) dropped)
    const frame = subShapeFrame(shape);
    const cycle = MEASURED.cycles[renderedShape(shape)];
    const mean = cycle.reduce((sum, value) => sum + value, 0) / cycle.length;
    const measured = cycle.map((value) => value - mean);
    const power = Math.sqrt(measured.reduce((sum, value) => sum + value * value, 0) / measured.length);
    // the error of our cycle (against the renders' scale of the sine) at a delay of `shift` (turns)
    const error = (shift: number) =>
      Math.sqrt(
        measured.reduce((sum, value, k) => {
          const ours = frame[Math.round(turns(k / 128 - shift) * SUB_FRAME) % SUB_FRAME] * SINE;
          return sum + (ours - value) ** 2;
        }, 0) / measured.length
      );
    const shifts = Array.from({ length: 41 }, (_, i) => (i - 20) / 2048);
    const best = Math.min(...shifts.map(error));
    // (0.04% for the sine, 0.1–0.5% for the rounded rect, the triangle and the square; the saw and the pulse 0.9 and 1.6%:
    // the ripple at their jumps of 735 harmonics against ours of 1023)
    expect(best / power).toBeLessThan(0.02);
  });
});
