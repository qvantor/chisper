import { readFileSync } from 'fs';
import { join } from 'path';
import FFT from 'fft.js';
import { SUB_SHAPES, SubShape } from '@chisper/preset-schema';
import { apart, frequencyOf, renderedShape, semitones, turns } from '../../../../test-utils/measures';
import { BLOCK, oscScope, VOICE_DEFAULTS } from '../../../../test-utils/voice-dsp';
import type { EnvelopeParams } from '../envelope/envelope-curve';
import { subShapeFrame, subTable } from './sub-shapes';
import type { VoiceEvent, VoiceOptions, VoiceRoute, VoiceSubOptions } from './voice-options';
import { buildLevels } from './wavetable-mipmap';
import { HELD_AGAIN_GATE, RELEASE_GATE, VoiceParam } from './wavetable-osc-params';
import {
  createTableStoreWasm,
  createVoiceScopeWasm,
  createVoiceSharedWasm,
  createVoiceWasm,
  TableStoreWasm,
} from './wavetable-osc-wasm';

// the sub of a voice in the Rust core (sub.rs): one cycle of a shape at the pitch of the note, panned, at a level,
// against the renders of the sub oscillator of the Audio Unit (scripts/renders/run.mjs --only=sub)
type Harmonics = [number, number][];
const MEASURED: {
  shapes: Record<string, Harmonics>;
  oscillator: number;
  level: [number, number][];
  pan: [number, number, number][];
  octave: [number, number][];
  coarse: [number, number][];
  pitch: [number, number, number][];
  bend: number;
  porta: { sub: [number, number][]; osc: [number, number][] };
  phase: [number, number[]][];
  start: [number, number][];
  contiguous: Record<string, [number, number, number, number, number][]>;
  mono: [boolean, boolean, number, number][];
} = JSON.parse(readFileSync(join(__dirname, '../../../../../../../dsp/measurements/sub.json'), 'utf8'));

const scope = oscScope();
const RATE = 48000;
// the release of the renders: 32 s · 0.1⁵
const RELEASE = 0.00032;
const FLAT: EnvelopeParams = { attack: 0, hold: 0, decay: 0, sustain: 1, release: RELEASE };
const SUB: VoiceSubOptions = { table: null, phase: 0, contiguous: false, level: 1, pan: 0, cents: 0 };
const hz = (note: number) => 440 * 2 ** ((note - 69) / 12);
const C5 = hz(72);

// a store with the tables of every shape (and a sine of amplitude 1 for an oscillator)
const SINE_FRAME = Float32Array.from({ length: 2048 }, (_, i) => Math.sin((2 * Math.PI * i) / 2048));
const LEVELS = new Map([
  ...SUB_SHAPES.flatMap((shape) => {
    const table = subTable(shape);
    return table ? [[table, buildLevels([subShapeFrame(shape)])] as const] : [];
  }),
  ['sine', buildLevels([SINE_FRAME])] as const,
]);
const storeOf = () => {
  const store = createTableStoreWasm(scope);
  LEVELS.forEach((levels, table) => expect(store.set(table, 1, levels)).toBe(true));
  return store;
};
const freeStore = (store: TableStoreWasm) => {
  LEVELS.forEach((_, table) => store.remove(table));
  store.free();
};

interface Play {
  sub?: Partial<VoiceSubOptions> | null;
  shape?: SubShape;
  osc?: boolean;
  rate?: number;
  seconds?: number;
  // (a function: of the frame of each sample)
  frequency?: number | ((frame: number) => number);
  bend?: number;
  routes?: VoiceRoute[];
  before?: (frame: number, voice: ReturnType<typeof createVoiceWasm>) => void;
}

// a note of the sub alone (or of osc 1 alone on a sine at gain 1), its output (left, right)
const play = ({
  sub = {},
  shape = 'sine',
  osc = false,
  rate = RATE,
  seconds = 0.5,
  frequency = C5,
  bend = 0,
  routes = [],
  before,
}: Play) => {
  const store = storeOf();
  const shared = createVoiceSharedWasm(scope);
  const options: VoiceOptions = {
    osc: [osc ? { table: 'sine', unison: 1, phase: 0, phaseRand: 0 } : null, null],
    sub: sub && { ...SUB, table: subTable(shape), ...sub },
    start: 0,
    envelopes: [FLAT, FLAT, FLAT],
    envStart: 0,
    phrase: 1,
    routes,
    filter: null,
  };
  const voice = createVoiceWasm(scope, rate, options, store, () => 0.5, shared);
  const n = Math.ceil((seconds * rate) / BLOCK) * BLOCK;
  const [left, right] = [new Float32Array(n), new Float32Array(n)];
  const params = Object.fromEntries(
    Object.entries({ ...VOICE_DEFAULTS, gain1: 1 }).map(([name, value]) => [name, Float32Array.of(value)])
  ) as Record<VoiceParam, Float32Array>;
  const [outL, outR] = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  for (let frame = 0; frame < n; frame += BLOCK) {
    params.frequency =
      typeof frequency === 'number'
        ? Float32Array.of(frequency)
        : Float32Array.from({ length: BLOCK }, (_, i) => frequency(frame + i));
    before?.(frame, voice);
    voice.process(frame, params, outL, outR, Float32Array.of(bend));
    left.set(outL, frame);
    right.set(outR, frame);
  }
  voice.end();
  freeStore(store);
  shared.free();
  return [left, right];
};

// the amplitude and the phase (degrees, of a sine from sample 0) of a tone of `f` in x over n samples from `from`
// (Hann), as the renders read them
const toneOf = (x: Float32Array, f: number, from: number, n: number, rate = RATE) => {
  let [re, im, sum] = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const phase = (2 * Math.PI * f * (from + i)) / rate;
    re += x[from + i] * w * Math.sin(phase);
    im += x[from + i] * w * Math.cos(phase);
    sum += w;
  }
  return { amplitude: (2 * Math.hypot(re, im)) / sum, phase: (Math.atan2(im, re) * 180) / Math.PI };
};
// the phase (turns of a sine) at sample `at` of a tone of `f`: read over 0.1 s from 10 ms after it (or up to 10 ms
// before it), as the renders read it
const phaseAt = (x: Float32Array, f: number, at: number, before = false) =>
  turns(toneOf(x, f, before ? at - 5280 : at + 480, 4800).phase / 360 + (f * at) / RATE);
const dB = (value: number) => 20 * Math.log10(value);
// the amplitude of C5 in x over 0.1..0.3 s
const amplitudeOf = (x: Float32Array) => toneOf(x, C5, 4800, 9600).amplitude;

// the renders read a sine some samples after the start of its block, the same at every pitch: the phase it starts
// at (c) and that delay (samples) from `start` (least squares of phase = c - f · delay / RATE)
const onsetOf = () => {
  const points = MEASURED.start.map(([note, phase]) => [hz(note), phase]);
  const n = points.length;
  const [sf, sp] = [points.reduce((s, [f]) => s + f, 0), points.reduce((s, [, p]) => s + p, 0)];
  const sff = points.reduce((s, [f]) => s + f * f, 0);
  const sfp = points.reduce((s, [f, p]) => s + f * p, 0);
  const slope = (n * sfp - sf * sp) / (n * sff - sf * sf);
  return { phase: (sp - slope * sf) / n, delay: -slope * RATE };
};
const ONSET = onsetOf();
// a phase the renders read at the start of a block, at the sample the sub of the Audio Unit is at then
const measuredPhase = (phase: number, f: number) => turns(phase + (f * ONSET.delay) / RATE);

describe('the sub of a voice', () => {
  describe('shapes', () => {
    // the harmonics 1..40 at C2 against the fundamental of the sine: [amplitude, phase against n × the first]
    const harmonicsOf = (shape: SubShape) => {
      const [left] = play({ shape, frequency: hz(36), seconds: 1.4 });
      const parts = Array.from({ length: 40 }, (_, j) => toneOf(left, hz(36) * (j + 1), 14400, RATE));
      return parts.map(({ amplitude, phase }, j): [number, number] => [
        amplitude,
        turns((phase - (j + 1) * parts[0].phase) / 360 + 0.5) * 360 - 180,
      ]);
    };
    const sine = harmonicsOf('sine')[0][0];
    const measuredSine = MEASURED.shapes['sine'][0][0];

    // (the renders roll their treble off a little: a saw 0.25 dB under 1/n at harmonic 40, 2.6 kHz)
    it.each(SUB_SHAPES.map((shape) => [shape]))(
      'plays %s as the renders: its harmonics within 0.3 dB and 5° (those over -50 dB)',
      (shape) => {
        const ours = harmonicsOf(shape);
        const measured = MEASURED.shapes[renderedShape(shape)];
        const floor = dB(measured[0][0] / measuredSine) - 50;
        const off = measured.flatMap(([amplitude, phase], j) => {
          const level = dB(amplitude / measuredSine);
          if (level < floor) return [];
          const db = dB(ours[j][0] / sine) - level;
          const degrees = apart(ours[j][1] / 360, phase / 360) * 360;
          return Math.abs(db) > 0.3 || degrees > 5 ? [{ harmonic: j + 1, db, degrees }] : [];
        });
        expect(off).toEqual([]);
      }
    );

    it('starts every shape going down from where a note starts (the sine of the store half a cycle on)', () => {
      SUB_SHAPES.forEach((shape) => {
        const [left] = play({ shape, frequency: hz(24), seconds: 0.05 });
        // (the sine, the triangle and the rounded rect from 0, the others from their bottom)
        expect({ shape, down: left[40] < left[0] || left[0] < -0.3 }).toEqual({ shape, down: true });
      });
    });
  });

  describe('level and pan', () => {
    it('is SUB_SCALE · its level² against an oscillator at gain 1 on a sine of amplitude 1 (the renders)', () => {
      const [sub] = play({});
      const [osc] = play({ sub: null, osc: true });
      expect(amplitudeOf(sub) / amplitudeOf(osc)).toBeCloseTo(MEASURED.oscillator, 3);
      MEASURED.level.forEach(([level, measured]) => {
        const [left] = play({ sub: { level } });
        const ratio = amplitudeOf(left) / amplitudeOf(sub);
        expect(dB(ratio)).toBeCloseTo(measured, 1);
      });
    });

    it('pans as the renders, each side against the centre', () => {
      const centre = play({}).map((x) => amplitudeOf(x));
      MEASURED.pan.forEach(([knob, l, r]) => {
        const [left, right] = play({ sub: { pan: 2 * knob - 1 } }).map(
          (x, side) => amplitudeOf(x) / centre[side]
        );
        expect({ knob, left, right }).toEqual({
          knob,
          left: expect.closeTo(l, 2),
          right: expect.closeTo(r, 2),
        });
      });
    });
  });

  describe('pitch', () => {
    it('takes Octave and Coarse as the renders: an octave a step, Coarse 128 semitones over its range', () => {
      MEASURED.octave.forEach(([octave, st]) => {
        const [left] = play({ sub: { cents: 1200 * octave }, seconds: 0.4 });
        expect(semitones(frequencyOf(left, RATE), C5)).toBeCloseTo(st, 2);
      });
      // (the top of Coarse is past the nyquist for the zero crossings of the renders)
      MEASURED.coarse
        .filter(([knob]) => knob < 1)
        .forEach(([knob, st]) => {
          const [left] = play({ sub: { cents: 100 * 128 * (knob - 0.5) }, seconds: 0.4 });
          expect(semitones(frequencyOf(left, RATE), C5)).toBeCloseTo(st, 2);
        });
      MEASURED.pitch.forEach(([octave, coarse, st]) => {
        const cents = 1200 * Math.round(8 * octave - 4) + 100 * 128 * (coarse - 0.5);
        const [left] = play({ sub: { cents }, seconds: 0.4 });
        expect(semitones(frequencyOf(left, RATE), C5)).toBeCloseTo(st, 2);
      });
    });

    it('follows the bend (the renders: 2 semitones at Bend Up 2)', () => {
      const [left] = play({ bend: 100 * MEASURED.bend, seconds: 0.4 });
      expect(semitones(frequencyOf(left, RATE), C5)).toBeCloseTo(MEASURED.bend, 3);
    });

    it('follows the frequency of the note as the oscillators do (the renders: the portamento of both)', () => {
      MEASURED.porta.sub.forEach(([t, st], k) => expect(st).toBeCloseTo(MEASURED.porta.osc[k][1], 0));
      // an octave up over 0.2 s from 0.1 s
      const frequency = (frame: number) => hz(60) * 2 ** Math.min(1, Math.max(0, (frame / RATE - 0.1) / 0.2));
      // (at Phase 0.5 the sine goes up from 0 as the one of the oscillator: their crossings at the same samples)
      const [sub] = play({ sub: { phase: 0.5 }, frequency, seconds: 0.4 });
      const [osc] = play({ sub: null, osc: true, frequency, seconds: 0.4 });
      for (let at = 0.12; at < 0.35; at += 0.02) {
        const from = Math.round(at * RATE);
        expect(frequencyOf(sub, RATE, from, from + 960)).toBeCloseTo(
          frequencyOf(osc, RATE, from, from + 960),
          0
        );
      }
    });

    it('moves by a route of Coarse in cents, within its bounds (ENV 2 here, held at 1)', () => {
      const route = (amount: number, max = 6400): VoiceRoute => ({
        source: 1,
        param: 'sub.crs',
        amount,
        min: -6400,
        max,
      });
      const pitch = (routes: VoiceRoute[]) =>
        semitones(frequencyOf(play({ routes, seconds: 0.4 })[0], RATE), C5);
      expect(pitch([route(1200)])).toBeCloseTo(12, 2);
      expect(pitch([route(-700)])).toBeCloseTo(-7, 2);
      expect(pitch([route(1200, 500)])).toBeCloseTo(5, 2);
    });
  });

  describe('phase', () => {
    it('starts at Phase, the renders a few samples into their block', () => {
      expect(ONSET.phase).toBeCloseTo(0.5, 2);
      expect(ONSET.delay).toBeGreaterThan(0);
      expect(ONSET.delay).toBeLessThan(8);
      MEASURED.phase.forEach(([phase, starts]) => {
        const [left] = play({ sub: { phase }, seconds: 0.2 });
        const ours = phaseAt(left, C5, 0);
        expect(apart(ours, turns(0.5 + phase))).toBeLessThan(0.002);
        starts.forEach((start) => expect(apart(ours, measuredPhase(start, C5))).toBeLessThan(0.005));
      });
    });

    // the notes of a scenario of the renders in a scope of voices at the starts of their blocks of 64 (as the host
    // sends them), ENV 1 open, its release that of the renders: the phase each starts at and has at its end
    const scenario = (notes: [number, number, number][], sub: Partial<VoiceSubOptions>, mono = false) => {
      const store = storeOf();
      const shared = createVoiceSharedWasm(scope);
      const node = createVoiceScopeWasm(scope, RATE, store, shared, () => 0.5);
      const onset = (t: number) => Math.floor((t * RATE) / 64) * 64;
      const seconds = Math.max(...notes.map(([, , off]) => off)) + 0.2;
      const n = Math.ceil((seconds * RATE) / BLOCK) * BLOCK;
      const left = new Float32Array(n);
      const voice = (id: number, note: number, on: number, off: number): VoiceEvent[] => [
        {
          kind: 'on',
          voice: id,
          options: {
            osc: [null, null],
            sub: { ...SUB, ...sub },
            start: onset(on) / RATE,
            envelopes: [FLAT, FLAT, FLAT],
            envStart: onset(on) / RATE,
            phrase: id + 1,
            routes: [],
            filter: null,
          },
          params: { frequency: hz(note) },
        },
        {
          kind: 'set',
          voice: id,
          param: 'gate',
          value: RELEASE_GATE + (onset(off) - onset(on)) / RATE,
          time: onset(off) / RATE,
        },
      ];
      // mono: one voice, the next notes take it over (their frequency, the gate held at its other value)
      const [[note, on], ...rest] = notes;
      const events: VoiceEvent[] = mono
        ? [
            ...voice(0, note, on, notes[notes.length - 1][2]),
            ...rest.flatMap(([next, at]): VoiceEvent[] => [
              { kind: 'set', voice: 0, param: 'frequency', value: hz(next), time: onset(at) / RATE },
              { kind: 'set', voice: 0, param: 'gate', value: HELD_AGAIN_GATE, time: onset(at) / RATE },
            ]),
          ]
        : notes.flatMap(([pitch, from, to], id) => voice(id, pitch, from, to));
      node.apply(events);
      const [outL, outR] = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
      for (let frame = 0; frame < n; frame += BLOCK) {
        node.process(frame, outL, outR);
        left.set(outL, frame);
        node.reports();
      }
      node.free();
      freeStore(store);
      shared.free();
      return { left, onset };
    };

    it.each(Object.keys(MEASURED.contiguous))(
      'goes on with Contiguous from the phase of the note started last as the renders: %s',
      (name) => {
        const measured = MEASURED.contiguous[name];
        const { left, onset } = scenario(
          measured.map(([note, on, off]) => [note, on, off]),
          { phase: 0.25, contiguous: true }
        );
        const off = measured.flatMap(([note, on, to, start, end]) => {
          const f = hz(note);
          const starts = apart(phaseAt(left, f, onset(on)), measuredPhase(start, f));
          const ends = apart(phaseAt(left, f, onset(to), true), measuredPhase(end, f));
          return starts > 0.03 || ends > 0.03 ? [{ note, on, starts, ends }] : [];
        });
        expect(off).toEqual([]);
      }
    );

    it('goes on through a mono note, Contiguous or not (the renders: no start again)', () => {
      MEASURED.mono.forEach(([, contiguous, before, after]) => {
        expect(apart(measuredPhase(before, C5), measuredPhase(after, hz(79)))).toBeLessThan(0.002);
        const { left, onset } = scenario(
          [
            [72, 0.1, 0.65],
            [79, 0.6, 1.3],
          ],
          { phase: 0.25, contiguous },
          true
        );
        expect(apart(phaseAt(left, C5, onset(0.6), true), phaseAt(left, hz(79), onset(0.6)))).toBeLessThan(
          0.01
        );
      });
    });
  });

  describe('band limit', () => {
    const SIZE = 65536;
    // a pitch on the bins of SIZE samples whose frequency is a float32 (the core takes it in f32)
    const noteBin = (note: number, rate: number) => {
      const near = Math.round((hz(note) * SIZE) / rate);
      for (let d = 0; ; d++) {
        const bin = [near - d, near + d].find((k) => Math.fround((k * rate) / SIZE) === (k * rate) / SIZE);
        if (bin) return bin;
      }
    };
    // all that is not a harmonic against the harmonics, the worst spur against the fundamental (dB)
    const analysis = (signal: Float32Array, bin: number) => {
      const fft = new FFT(SIZE);
      const out = fft.createComplexArray();
      fft.realTransform(out, Array.from(signal.subarray(signal.length - SIZE)));
      let [harmonics, other, worst] = [0, 0, 0];
      const fundamental = out[2 * bin] ** 2 + out[2 * bin + 1] ** 2;
      for (let k = 1; k < SIZE / 2; k++) {
        const power = out[2 * k] ** 2 + out[2 * k + 1] ** 2;
        if (k % bin === 0) harmonics += power;
        else {
          other += power;
          worst = Math.max(worst, power);
        }
      }
      return { aliasing: 10 * Math.log10(other / harmonics), spur: 10 * Math.log10(worst / fundamental) };
    };

    describe.each([44100, 48000])('at %i Hz', (rate) => {
      it.each(
        (['saw', 'square'] as const).flatMap((shape) =>
          [36, 48, 60, 72, 84, 96, 108].map((note) => [shape, note] as const)
        )
      )('keeps the aliasing of a %s at note %i under -70 dB, its spurs under -80 dB', (shape, note) => {
        const bin = noteBin(note, rate);
        const [left] = play({
          shape,
          rate,
          frequency: (bin * rate) / SIZE,
          seconds: (SIZE + 4096) / rate,
        });
        const { aliasing, spur } = analysis(left, bin);
        expect(aliasing).toBeLessThan(-70);
        expect(spur).toBeLessThan(-80);
      });
    });
  });

  describe('knobs', () => {
    it('glides to new knobs in 10 ms, the cents at once', () => {
      const [left, right] = play({
        seconds: 0.2,
        before: (frame, voice) => {
          if (frame === 4096) voice.setKnobs('sub', { level: 0.5, pan: -1, cents: 1200 });
        },
      });
      // an octave up at once
      expect(semitones(frequencyOf(left, RATE, 4800 + 1024), C5)).toBeCloseTo(12, 2);
      // the pan and the level there 10 ms later: hard left at a quarter of the gain
      expect(Math.max(...right.subarray(4096 + 480 + 128).map(Math.abs))).toBeLessThan(1e-6);
      const peak = Math.max(...left.subarray(4096 + 480 + 128).map(Math.abs));
      expect(peak / Math.max(...left.subarray(0, 4096).map(Math.abs))).toBeCloseTo(
        0.25 * 2 * (1 - 0.17213),
        2
      );
    });

    it('draws nothing: a voice with a sub draws as one without', () => {
      const draws = (sub: boolean) => {
        let count = 0;
        const store = storeOf();
        const shared = createVoiceSharedWasm(scope);
        const voice = createVoiceWasm(
          scope,
          RATE,
          {
            osc: [{ table: 'sine', unison: 3, phase: 0, phaseRand: 1 }, null],
            ...(sub && { sub: SUB }),
            start: 0,
            envelopes: [FLAT],
            envStart: 0,
            phrase: 1,
            routes: [],
            filter: null,
          },
          store,
          () => {
            count++;
            return 0.5;
          },
          shared
        );
        voice.end();
        freeStore(store);
        shared.free();
        return count;
      };
      expect(draws(true)).toBe(draws(false));
    });
  });
});
