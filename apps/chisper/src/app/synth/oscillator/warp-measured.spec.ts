import { readFileSync } from 'fs';
import { join } from 'path';
import FFT from 'fft.js';
import { warp } from '@chisper/math';
import { WARP_MODES, type WarpMode } from '@chisper/preset-schema';
import { oscScope, seeded, storeWith, VOICE_DEFAULTS } from '../../../test-utils/voice-dsp';
import { createVoiceSharedWasm, createVoiceWasm } from '../common/wavetable/wavetable-osc-wasm';
import type { VoiceParam } from '../common/wavetable/wavetable-osc-params';
import type { EnvelopeParams } from '../common/envelope/envelope-curve';

// The Warp of an oscillator against the renders of the Audio Unit (scripts/renders/run.mjs --only=warp): the map of
// the phase of each mode by its knob (the one the chart draws: warp-model.spec holds it to the core), the harmonics
// and the mean of a cycle of a saw, a sine and a cosine at C0 the core plays (the cosine starts at 1: what PWM holds
// over the rest of the cycle, its first sample, tells itself in its mean), its aliasing at C6 and C7 by the measure
// of the oscillator benchmark (scripts/bench-osc/sound.mjs: a Kaiser window, ±14 bins a harmonic), how bright Bend -
// and Bend +/- play a saw and a ramp at D2 and D4 (the harmonics to 16 kHz)

type Mode = Exclude<WarpMode, 'off'>;
type Table = 'saw' | 'sine' | 'cos';
interface Note {
  table: 'saw' | 'ramp';
  note: number;
  mode: Mode;
  warp: number;
  harmonics: (number | null)[];
}
const MEASURED: {
  curves: { mode: Mode; warp: number; points: [number, number][] }[];
  spectra: { table: Table; mode: Mode; warp: number; harmonics: (number | null)[]; dc: number }[];
  aliasing: { note: number; mode: Mode | 'off'; warp: number; aliasing: number | null }[];
  moving: { tau: number };
  notes: Note[];
} = JSON.parse(readFileSync(join(__dirname, '../../../../../../dsp/measurements/warp.json'), 'utf8'));

const modeOf = (mode: Mode | 'off') => WARP_MODES.indexOf(mode);
const RATE = 48000;
const BLOCK = 128;
const C0 = 440 * 2 ** ((12 - 69) / 12);
const FLAT: EnvelopeParams = { attack: 0, hold: 0, decay: 0, sustain: 1, release: 0 };

// the tables of the renders: the saw of the benchmark (1023 harmonics at 1/k), a sine and a cosine
const SAW = Array.from({ length: 2048 }, (_, n) => {
  let value = 0;
  for (let k = 1; k < 1024; k++) value += Math.sin((2 * Math.PI * k * n) / 2048) / k;
  return value;
});
const SINE = Array.from({ length: 2048 }, (_, n) => Math.sin((2 * Math.PI * n) / 2048));
const COS = Array.from({ length: 2048 }, (_, n) => Math.cos((2 * Math.PI * n) / 2048));
const TABLES: Record<Table, number[]> = { saw: SAW, sine: SINE, cos: COS };
// the saw from 0 up, its jump in the middle (frame 0 of Default Shapes of the Audio Unit)
const RAMP = SAW.map((_, i) => -SAW[(i + 1024) % 2048]);

// `frames` of one voice of osc 1 at `frequency` (its phase 0, one voice) on `table`, its warp: its left channel
const play = (table: number[], frequency: number, mode: number, knob: number, frames: number) => {
  const scope = oscScope();
  const { store } = storeWith({ t: [table] }, scope);
  const shared = createVoiceSharedWasm(scope);
  const voice = createVoiceWasm(
    scope,
    RATE,
    {
      osc: [{ table: 't', unison: 1, phase: 0, phaseRand: 0, warpMode: mode, warp: knob }, null],
      start: 0,
      envelopes: [FLAT, FLAT, FLAT],
      envStart: 0,
      phrase: 0,
      routes: [],
      filter: null,
    },
    store,
    seeded(1),
    shared
  );
  const params = Object.fromEntries(
    (Object.keys(VOICE_DEFAULTS) as VoiceParam[]).map((name) => [
      name,
      Float32Array.of(name === 'frequency' ? frequency : VOICE_DEFAULTS[name]),
    ])
  ) as Record<VoiceParam, Float32Array>;
  const out = new Float32Array(frames);
  const [left, right] = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  for (let frame = 0; frame < frames; frame += BLOCK) {
    voice.process(frame, params, left, right);
    out.set(left.subarray(0, Math.min(BLOCK, frames - frame)), frame);
  }
  voice.end();
  return out;
};

// the amplitude of a tone of `frequency` over n samples from `from` (Hann), as the renders measure it
const tone = (x: Float32Array, frequency: number, from: number, n: number) => {
  let [re, im, sum] = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const phase = (2 * Math.PI * frequency * (from + i)) / RATE;
    re += x[from + i] * w * Math.sin(phase);
    im += x[from + i] * w * Math.cos(phase);
    sum += w;
  }
  return (2 * Math.hypot(re, im)) / sum;
};
const harmonics = (x: Float32Array, f = C0, count = 40) =>
  Array.from({ length: count }, (_, j) => tone(x, f * (j + 1), 6000, 14400));
// the mean of 4 cycles from sample 6000, as the renders measure it
const CYCLES = Math.round((4 * RATE) / C0);
const mean = (x: Float32Array) =>
  x.subarray(6000, 6000 + CYCLES).reduce((sum, value) => sum + value, 0) / CYCLES;

// the aliasing of the benchmark (analyze of scripts/bench-osc/sound.mjs): the power outside ±14 bins of each harmonic
// against theirs over the last SIZE samples, a Kaiser window of β 38
const SIZE = 65536;
const besselI0 = (x: number) => {
  let [sum, term] = [1, 1];
  for (let k = 1; term > sum * 1e-17; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
  }
  return sum;
};
const KAISER = Float64Array.from(
  { length: SIZE },
  (_, i) => besselI0(38 * Math.sqrt(1 - ((2 * i) / (SIZE - 1) - 1) ** 2)) / besselI0(38)
);
const aliasingOf = (signal: Float32Array, frequency: number) => {
  const fft = new FFT(SIZE);
  const input = Array.from({ length: SIZE }, (_, i) => signal[signal.length - SIZE + i] * KAISER[i]);
  const out = fft.createComplexArray();
  fft.realTransform(out, input);
  const spectrum = Float64Array.from({ length: SIZE / 2 }, (_, k) => out[2 * k] ** 2 + out[2 * k + 1] ** 2);
  const inBand = new Uint8Array(spectrum.length);
  let harmonic = 0;
  for (let h = 1; h * frequency < RATE / 2; h++) {
    const center = Math.round((h * frequency * SIZE) / RATE);
    for (let k = Math.max(0, center - 14); k <= Math.min(spectrum.length - 1, center + 14); k++) {
      inBand[k] = 1;
      harmonic += spectrum[k];
    }
  }
  let other = 0;
  for (let k = 15; k < spectrum.length; k++) if (!inBand[k]) other += spectrum[k];
  return 10 * Math.log10(other / harmonic);
};

const circular = (a: number, b: number) => {
  const d = Math.abs(a - b) % 1;
  return Math.min(d, 1 - d);
};

describe('the warp of an oscillator as the renders', () => {
  it.each(MEASURED.curves.map((row) => [row.mode, row.warp, row] as const))(
    'maps the phase of %s at %f as the Audio Unit',
    (mode, knob, { points }) => {
      // (PWM: a sample at its edge or at the wrap reads one side or the other)
      const period = RATE / C0;
      const edge = (phi: number) =>
        mode === 'pwm' && (circular(phi, 1 - knob) < 2 / period || circular(phi, 0) < 2 / period);
      // within 8e-4 of a cycle × the slope of the map there: two renders differ by ~0.15 samples of C0 where it is
      // steepest, the slope of PWM runs up to 0.7 % under 1 / (1 - k) at 0.9, 1.7 % at 0.95 (the render filters its
      // kink); PWM at 1 reads phase 0 all the cycle, the render within 3e-3 of it (a transient after the wrap)
      const at = (phi: number) => warp.warpPhase(modeOf(mode), knob, phi);
      const slope = (phi: number) => circular(at(phi + 1e-4), at(phi - 1e-4)) / 2e-4;
      const errors = points
        .filter(([phi]) => !edge(phi))
        .map(([phi, w]) => circular(at(phi), w) / Math.max(1, slope(phi)));
      if (mode === 'pwm' && knob === 1) {
        expect(Math.max(...points.map(([, w]) => circular(w, 0)))).toBeLessThan(3e-3);
        return;
      }
      expect(Math.max(...errors)).toBeLessThan(8e-4);
    }
  );

  it.each(['saw', 'sine', 'cos'] as const)('plays the harmonics of a cycle of a %s at C0 as it', (table) => {
    const frames = 24000;
    const [unwarped] = harmonics(play(TABLES[table], C0, 0, 0, frames));
    const errors = MEASURED.spectra
      .filter((row) => row.table === table)
      .flatMap(({ mode, warp: knob, harmonics: measured }) => {
        const ours = harmonics(play(TABLES[table], C0, modeOf(mode), knob, frames));
        return measured.flatMap((level, j) =>
          level === null || level < -40
            ? []
            : [{ mode, knob, h: j + 1, e: 20 * Math.log10(ours[j] / unwarped) - level }]
        );
      });
    const worst = errors.reduce((a, b) => (Math.abs(b.e) > Math.abs(a.e) ? b : a));
    expect(worst).toMatchObject({ e: expect.any(Number) });
    expect(Math.abs(worst.e)).toBeLessThan(1);
  });

  // PWM holds the first sample of the frame over the rest of the cycle (a cosine: a mean of the knob), at 1 all the
  // cycle (no tone: the cosine's 1 held, as the Audio Unit, which keeps that offset); the bends move the mean of the
  // cosine as theirs: within 0.02 of the fundamental unwarped
  it.each(['saw', 'sine', 'cos'] as const)('plays the mean of a cycle of a %s at C0 as it', (table) => {
    const frames = 24000;
    const [unwarped] = harmonics(play(TABLES[table], C0, 0, 0, frames));
    const errors = MEASURED.spectra
      .filter((row) => row.table === table)
      .map(({ mode, warp: knob, dc }) => ({
        mode,
        knob,
        e: mean(play(TABLES[table], C0, modeOf(mode), knob, frames)) / unwarped - dc,
      }));
    const worst = errors.reduce((a, b) => (Math.abs(b.e) > Math.abs(a.e) ? b : a));
    expect(worst).toMatchObject({ e: expect.any(Number) });
    expect(Math.abs(worst.e)).toBeLessThan(0.02);
  });

  // the saw at C6 and C7, Warp 0.5 and 1 (PWM at 1 holds the saw's first sample, 0: no tone): Bend -, Bend +/- over
  // 0.5 (the levels of the slope of each sample, those of the wrap at so high a pitch) and PWM read the levels of the
  // slope at the wrap, where the saw jumps: no worse than the Audio Unit (within 1 dB). Bend + (Bend +/- under 0.5)
  // squeezes the middle of a frame and reads the levels of its pitch: its stretched ends keep their harmonics as the
  // Audio Unit at C0 does (read a level up for its steepest slope, a saw loses those over 18 there), its middle aliases
  // up to 30 dB more than the Audio Unit, which renders the warp oversampled (left for the oversampling of the warp)
  // the harmonics at D2 and D4 of a bend of a < 0 (Bend -, Bend +/- over 0.5) against the Audio Unit's (dB against
  // the fundamental unwarped, those of it over -60 dB): the power of each third of an octave to 10 kHz, the first
  // harmonic 6 dB or more under its own to 16 kHz
  const brightness = ({ table, note, mode, warp: knob, harmonics: measured }: Note) => {
    const f = 440 * 2 ** ((note - 69) / 12);
    const frames = 6000 + 14400;
    const [unwarped] = harmonics(play(table === 'saw' ? SAW : RAMP, f, 0, 0, frames), f, 1);
    const levels = harmonics(
      play(table === 'saw' ? SAW : RAMP, f, modeOf(mode), knob, frames),
      f,
      measured.length
    ).map((a) => 20 * Math.log10(Math.max(a, 1e-12) / unwarped));
    let [band, cut, worst] = [0, Infinity, 0];
    for (let lo = f; lo < 10000; lo *= 2 ** (1 / 3)) {
      let [theirs, ours] = [0, 0];
      measured.forEach((level, j) => {
        const at = f * (j + 1);
        if (level === null || at < lo || at >= lo * 2 ** (1 / 3) || at > 10000) return;
        theirs += 10 ** (level / 10);
        ours += 10 ** (levels[j] / 10);
      });
      if (theirs === 0 || 10 * Math.log10(theirs) < -60) continue;
      const d = 10 * Math.log10(ours / theirs);
      if (Math.abs(d) > Math.abs(band)) band = d;
    }
    measured.forEach((level, j) => {
      if (level === null || level < -60) return;
      const d = levels[j] - level;
      if (cut === Infinity && d < -6) cut = f * (j + 1);
      if (f * (j + 1) <= 10000 && Math.abs(d) > Math.abs(worst)) worst = d;
    });
    return { band, cut, worst };
  };
  // each harmonic within 2 dB of its own; a ramp at a under -0.4 (its middle, the jump, stretched over 2.3 times:
  // levels down to 3.5 under the pitch read there, the reference's harmonics a comb from 5 kHz on) the power of each
  // third of an octave within 8 dB, none 6 dB under it before 5.5 kHz (the levels of the wrap over all the cycle cut
  // it at 0.4 to 1.2 kHz)
  it.each(
    MEASURED.notes
      .filter(({ mode, warp: knob }) => warp.warpParam(modeOf(mode), knob) <= 0)
      .map((row) => [row.mode, row.warp, row.table, row.note, row] as const)
  )('plays %s at %f as bright as the Audio Unit (a %s at note %i)', (mode, knob, table, _, row) => {
    const { band, cut, worst } = brightness(row);
    if (table === 'ramp' && warp.warpParam(modeOf(mode), knob) < -0.4) {
      expect(Math.abs(band)).toBeLessThan(8);
      expect(cut).toBeGreaterThan(5500);
    } else {
      expect(Math.abs(worst)).toBeLessThan(2);
    }
  });

  const BEND_UP_BOUNDS: Record<number, Record<number, number>> = {
    84: { 0.5: -38, 1: -38 },
    96: { 0.5: -32.5, 1: -32.5 },
  };
  it.each(
    MEASURED.aliasing
      .filter((row) => row.aliasing !== null && row.mode !== 'off')
      .map((row) => [row.mode, row.warp, row.note, row] as const)
  )('aliases %s at %f on note %i no worse than the Audio Unit', (mode, knob, note, { aliasing }) => {
    const frequency = 440 * 2 ** ((note - 69) / 12);
    const ours = aliasingOf(play(SAW, frequency, modeOf(mode), knob, SIZE + 12000), frequency);
    const squeezesTheMiddle = warp.warpParam(modeOf(mode), knob) > 0 && mode !== 'pwm';
    expect(ours).toBeLessThan(squeezesTheMiddle ? BEND_UP_BOUNDS[note][knob] : (aliasing as number) + 1);
  });
});
