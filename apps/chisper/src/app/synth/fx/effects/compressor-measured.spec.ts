import { readFileSync } from 'fs';
import { join } from 'path';
import FFT from 'fft.js';
import { gainAt, quadrature, renderCompressor } from '../../../../test-utils/compressor-render';
import { dB, toneOf } from '../../../../test-utils/measures';
import type { CompressorDspParams } from './compressor-params';

// The compressor against the Audio Unit (dsp/measurements/compressor.json, scripts/renders/run.mjs
// --only=compressor): the same signals at the level of its output through the core, the same readings. A level of
// the measurements is one of a sample: × `output` at the output, where our effects work

type Trace = [number, number][];
interface Measured {
  rate: number;
  output: number;
  single: {
    threshold: [number, number, number][];
    ratio: [number, number][];
    attack: [number, Trace][];
    release: [number, Trace][];
    fresh: { held: number; attack: Trace; release: Trace };
    makeup: [number, number][];
    level: [number, number][];
    mix: [number, number][];
    link: Record<'both' | 'quarter' | 'left', number>;
    highpass: [number, number, number][];
  };
  multi: {
    levels: number[];
    curves: Record<'low' | 'mid' | 'high', { hz: number; gains: Record<string, number[]> }>;
    mono: Record<string, number[]>;
    falls: Record<'mid' | 'high', [number, Trace][]>;
    rise: [number, Trace][];
    onset: Record<string, Record<string, { samples: number[]; trace: Trace }>>;
    gaps: [number, Trace][];
    frequencies: number[];
    crossover: Record<string, [number, number][]>;
  };
}
const MEASURED: Measured = JSON.parse(
  readFileSync(join(__dirname, '../../../../../../../dsp/measurements/compressor.json'), 'utf8')
);
const { rate: RATE, output: OUTPUT, single, multi } = MEASURED;

type Params = Partial<CompressorDspParams>;
const MULTI: Params = { multi: 1 };
// the knobs of the curves of the bands, by their names in the measurements
const KNOBS: Record<string, Params> = {
  fresh: MULTI,
  'thresh 0.7': { ...MULTI, thresh: 0.7 },
  'ratio 20': { ...MULTI, ratio: 20 },
  'below 0.5': { ...MULTI, below: 0.5 },
  'below 1': { ...MULTI, below: 1 },
  'below 1, thresh 0.7': { ...MULTI, below: 1, thresh: 0.7 },
};

// the step of the one band measures: 1 kHz, -40 dB 0.4 s, -9 dB 1.2 s, -40 dB 1.6 s
const STEP = quadrature(
  RATE,
  1000,
  [
    [-40, 0.4],
    [-9, 1.2],
    [-40, 1.6],
  ],
  { scale: OUTPUT }
);
const stepped = (params: Params) => {
  const out = renderCompressor(params, RATE, STEP);
  return (seconds: number) => gainAt(out, STEP, Math.round(seconds * RATE));
};
// the peak is read: the attack 1 ms, the release 1 s
const PEAK: Params = { thresh: 0.7, attack: 1, release: 1000 };

// ms after a step down from which the level of both channels is the gain again: the highpass (12 Hz, a time
// constant of 13 ms) still holds what it took off the loud part, 0.4 of the quiet level right after the step (in
// the renders too: there it reads another way at each instant)
const SETTLED = 30;

// the largest difference (dB) between gains and those measured
const worst = (pairs: [number, number][]) =>
  Math.max(...pairs.map(([ours, theirs]) => Math.abs(ours - theirs)));

describe('compressor against the measurements', () => {
  describe('one band', () => {
    it('the threshold by its knob: the gain of a level held, within 0.2 dB', () => {
      const pairs = single.threshold.flatMap(([knob, loud, quiet]): [number, number][] => {
        const gain = stepped({ thresh: knob, attack: 1, release: 1000 });
        return [
          [gain(1.5), loud],
          [gain(0.35), quiet],
        ];
      });
      expect(worst(pairs)).toBeLessThan(0.2);
    });

    it('the ratio: the gain over the threshold, within 0.2 dB', () => {
      const pairs = single.ratio.map(([ratio, gain]): [number, number] => [
        stepped({ ...PEAK, ratio })(1.5),
        gain,
      ]);
      expect(worst(pairs)).toBeLessThan(0.2);
    });

    it.each(single.attack)(
      'the attack at %d ms: the gain after a step up, within 0.5 dB',
      (attack, trace) => {
        const gain = stepped({ ...PEAK, attack });
        // (from half a millisecond: the first samples of a step are its click)
        const pairs = trace
          .filter(([ms]) => ms >= 0.5)
          .map(([ms, measured]): [number, number] => [gain(0.4 + ms / 1000), measured]);
        expect(worst(pairs)).toBeLessThan(0.5);
      }
    );

    it.each(single.release)(
      'the release at %d ms: the gain after a step down, within 0.5 dB',
      (release, trace) => {
        const gain = stepped({ ...PEAK, release });
        const pairs = trace
          .filter(([ms]) => ms === 0 || ms >= SETTLED)
          .map(([ms, measured]): [number, number] => [gain(ms === 0 ? 1.59 : 1.6 + ms / 1000), measured]);
        expect(worst(pairs)).toBeLessThan(0.5);
      }
    );

    it('a fresh one (attack and release of 90 ms): held, rising and falling, within 0.5 dB', () => {
      const gain = stepped({ thresh: 0.7 });
      expect(Math.abs(gain(1.5) - single.fresh.held)).toBeLessThan(0.2);
      const rising = single.fresh.attack
        .filter(([ms]) => ms >= 0.5)
        .map(([ms, measured]): [number, number] => [gain(0.4 + ms / 1000), measured]);
      const falling = single.fresh.release
        .filter(([ms]) => ms >= SETTLED)
        .map(([ms, measured]): [number, number] => [gain(1.6 + ms / 1000), measured]);
      expect(worst(rising)).toBeLessThan(0.5);
      expect(worst(falling)).toBeLessThan(0.5);
    });

    it('the makeup gain, the level and the mix by their knobs, within 0.1 dB', () => {
      const makeup = single.makeup.map(([knob, gain]): [number, number] => [
        stepped({ thresh: 0, gain: knob })(0.35),
        gain,
      ]);
      const level = single.level.map(([knob, gain]): [number, number] => [
        stepped({ thresh: 0, level: knob })(0.35),
        gain,
      ]);
      const mix = single.mix.map(([value, gain]): [number, number] => [
        stepped({ ...PEAK, mix: value })(1.5),
        gain,
      ]);
      expect(worst(makeup)).toBeLessThan(0.1);
      expect(worst(level)).toBeLessThan(0.1);
      expect(worst(mix)).toBeLessThan(0.1);
    });

    it('the channels are linked by the louder one: a quiet or a silent right channel changes nothing', () => {
      const frames = Math.round(1.5 * RATE);
      const sine = (amplitude: number) =>
        Float64Array.from(
          { length: frames },
          (_, i) => amplitude * Math.sin((2 * Math.PI * 1000 * i) / RATE)
        );
      const peak = OUTPUT * 10 ** (-9 / 20);
      (['both', 'quarter', 'left'] as const).forEach((name) => {
        const right = { both: 1, quarter: 0.25, left: 0 }[name];
        const input: [Float64Array, Float64Array] = [sine(peak), sine(peak * right)];
        const out = renderCompressor(PEAK, RATE, input);
        const read = (x: ArrayLike<number>) => toneOf(x, 1000, RATE, Math.round(0.8 * RATE), 8192).amplitude;
        expect(Math.abs(dB(read(out.left) / read(input[0])) - single.link[name])).toBeLessThan(0.2);
      });
    });

    it('the highpass at the input: its gain within 0.1 dB, its phase within 1 degree', () => {
      single.highpass.forEach(([hz, gain, degrees]) => {
        const frames = 3 * RATE;
        const sine = Float64Array.from(
          { length: frames },
          (_, i) => 0.05 * Math.sin((2 * Math.PI * hz * i) / RATE)
        );
        const out = renderCompressor({ thresh: 0 }, RATE, [sine, sine]);
        const read = (x: ArrayLike<number>) => toneOf(x, hz, RATE, Math.round(0.8 * RATE), 2 * RATE);
        const [a, b] = [read(sine), read(out.left)];
        expect(Math.abs(dB(b.amplitude / a.amplitude) - gain)).toBeLessThan(0.1);
        expect(Math.abs(((b.phase - a.phase - degrees + 540) % 360) - 180)).toBeLessThan(1);
      });
    });
  });

  describe('three bands', () => {
    // the levels of a band held 0.6 s each (after 1.2 s at the lowest): the gain at the end of each
    const ladder = (hz: number, mono = false) =>
      quadrature(RATE, hz, [[-72, 1.2], ...multi.levels.map((level): [number, number] => [level, 0.6])], {
        mono,
        scale: OUTPUT,
      });
    const endOf = (k: number) => Math.round((1.2 + (k + 0.95) * 0.6) * RATE);

    describe.each(['low', 'mid', 'high'] as const)('the %s band', (band) => {
      const { hz, gains } = multi.curves[band];
      const input = ladder(hz);
      it.each(Object.keys(gains))('%s: its gain by level, within 0.5 dB', (knobs) => {
        const out = renderCompressor(KNOBS[knobs], RATE, input);
        const pairs = gains[knobs].map((measured, k): [number, number] => [
          gainAt(out, input, endOf(k)),
          measured,
        ]);
        expect(worst(pairs)).toBeLessThan(0.5);
      });
    });

    it.each(Object.keys(multi.mono))(
      'a mono sine, %s: the mean square of both channels, within 0.5 dB',
      (knobs) => {
        const input = ladder(220, true);
        const out = renderCompressor(KNOBS[knobs], RATE, input);
        const read = (x: ArrayLike<number>, k: number) =>
          toneOf(x, 220, RATE, Math.round((1.2 + (k + 0.6) * 0.6) * RATE), Math.round(0.2 * RATE)).amplitude;
        const pairs = multi.mono[knobs].map((measured, k): [number, number] => [
          dB(read(out.left, k) / read(input[0], k)),
          measured,
        ]);
        expect(worst(pairs)).toBeLessThan(0.5);
      }
    );

    // a step down from 0 to -40 dB after 0.8 s (and 0.4 s at -40 dB before)
    const fall = (hz: number) =>
      quadrature(
        RATE,
        hz,
        [
          [-40, 0.4],
          [0, 0.8],
          [-40, 3.2],
        ],
        { scale: OUTPUT }
      );
    describe.each([
      ['mid', 1000],
      ['high', 8000],
    ] as const)('the release of the %s band', (band, hz) => {
      const input = fall(hz);
      it.each(multi.falls[band])('at %d ms: the gain after a step down, within 1 dB', (release, trace) => {
        const out = renderCompressor({ ...MULTI, release }, RATE, input);
        // (from 50 ms: the bands ring after the step, the level of both channels is not the gain then)
        const pairs = trace
          .filter(([ms]) => ms === 0 || ms >= 50)
          .map(([ms, measured]): [number, number] => [
            gainAt(out, input, Math.round((ms === 0 ? 1.19 : 1.2 + ms / 1000) * RATE)),
            measured,
          ]);
        expect(worst(pairs)).toBeLessThan(1);
      });
    });

    it.each(multi.rise)(
      'the Attack knob at %d ms does nothing: the gain after a step up, within 0.5 dB',
      (attack, trace) => {
        const input = fall(1000);
        const out = renderCompressor({ ...MULTI, attack }, RATE, input);
        const pairs = trace
          .filter(([ms]) => ms >= 5)
          .map(([ms, measured]): [number, number] => [
            gainAt(out, input, Math.round((0.4 + ms / 1000) * RATE)),
            measured,
          ]);
        expect(worst(pairs)).toBeLessThan(0.5);
      }
    );

    // a hit after a quiet tone, the bands lifted to the ceiling of their gain before it: their gains fall at
    // every sample of it, not along a line from those of before (which lifted its first samples by 10 dB and more)
    describe.each([
      ['0 dB', 0],
      ['-40 dB', -40],
    ] as const)('a hit at %s after a second at -72 dB', (name, hit) => {
      const AT = 1;
      const input = quadrature(
        RATE,
        1000,
        [
          [-72, AT],
          [hit, 0.3],
        ],
        { scale: OUTPUT }
      );
      it.each([0.75, 1])(
        'Below %d: its first samples within 2.5 dB, its gain within 2 dB, 0.5 dB from 5 ms',
        (below) => {
          const { samples, trace } = multi.onset[name][`below ${below}`];
          const out = renderCompressor({ ...MULTI, below }, RATE, input);
          const gain = (frame: number) => gainAt(out, input, AT * RATE + frame);
          // (the frame of the measurement: the seconds from the start of the sample, rounded)
          const gainAfter = (ms: number) => gainAt(out, input, Math.round((AT + ms / 1000) * RATE));
          // (from the 12th sample: the bands ring with the click of the step before, each reads another way there)
          const first = samples.map((measured, k): [number, number] => [gain(k), measured]).slice(12);
          expect(worst(first)).toBeLessThan(2.5);
          // the click itself is never over the one measured
          expect(Math.max(...samples.slice(0, 12).map((_, k) => gain(k)))).toBeLessThan(Math.max(...samples));
          const pairs = (from: number, to: number) =>
            trace
              .filter(([ms]) => ms >= from && ms < to)
              .map(([ms, measured]): [number, number] => [gainAfter(ms), measured]);
          expect(worst(pairs(1, 5))).toBeLessThan(2);
          expect(worst(pairs(5, Infinity))).toBeLessThan(0.5);
        }
      );
    });

    it.each(multi.gaps)(
      'a hit after %d s of silence (Below 1): its gain within 1 dB, 0.5 dB from 5 ms',
      (gap, trace) => {
        const input = quadrature(
          RATE,
          1000,
          [
            [0, 0.3],
            [-Infinity, gap],
            [0, 0.3],
          ],
          { scale: OUTPUT }
        );
        const out = renderCompressor({ ...MULTI, below: 1 }, RATE, input);
        const pairs = (from: number, to: number) =>
          trace
            .filter(([ms]) => ms >= from && ms < to)
            .map(([ms, measured]): [number, number] => [
              gainAt(out, input, Math.round((0.3 + gap + ms / 1000) * RATE)),
              measured,
            ]);
        expect(worst(pairs(1, 5))).toBeLessThan(1);
        expect(worst(pairs(5, Infinity))).toBeLessThan(0.5);
      }
    );

    // the response to an impulse with no compression (the ratio 1): [dB, degrees] at the frequencies measured
    const N = 1 << 16;
    const AT = 64;
    const response = (params: Params) => {
      const click = new Float64Array(N + 1000);
      click[AT] = 0.1;
      const out = renderCompressor({ ...MULTI, ratio: 1, ...params }, RATE, [click, click]);
      const fft = new FFT(N);
      const bins = fft.createComplexArray() as number[];
      fft.realTransform(bins, Array.from(out.left.subarray(0, N)));
      return multi.frequencies.map((hz) => {
        const k = Math.round((hz * N) / RATE);
        const turn = (2 * Math.PI * k * AT) / N;
        const [re, im] = [bins[2 * k] / 0.1, bins[2 * k + 1] / 0.1];
        return [
          dB(Math.hypot(re, im)),
          (Math.atan2(im * Math.cos(turn) + re * Math.sin(turn), re * Math.cos(turn) - im * Math.sin(turn)) *
            180) /
            Math.PI,
        ];
      });
    };
    const QUIET = -24;
    const BANDS: Record<string, Params> = {
      all: {},
      low: { mid: QUIET, high: QUIET },
      mid: { low: QUIET, high: QUIET },
      high: { low: QUIET, mid: QUIET },
      'mix 0.5': { mix: 0.5 },
      'mid + 12 dB, mix 0.5': { mid: 12, mix: 0.5 },
      'low 500 Hz, high 5000 Hz, mid alone': { xlow: 500, xhigh: 5000, low: QUIET, high: QUIET },
    };
    it.each(Object.keys(BANDS))(
      'the crossovers, %s: the level within 0.5 dB, the phase within 8 degrees',
      (name) => {
        const ours = response(BANDS[name]);
        const theirs = multi.crossover[name];
        const levels = ours.map(([level], k): [number, number] => [level, theirs[k][0]]);
        const turns = ours.map(([, degrees], k) => Math.abs(((degrees - theirs[k][1] + 540) % 360) - 180));
        expect(worst(levels)).toBeLessThan(0.5);
        expect(Math.max(...turns)).toBeLessThan(8);
      }
    );

    it('all bands with no compression: the level within 0.2 dB of the input from 40 Hz (an allpass)', () => {
      const ours = response({});
      const half = response({ mix: 0.5 });
      multi.frequencies.forEach((hz, k) => {
        if (hz < 40) return;
        expect(Math.abs(ours[k][0] - multi.crossover['all'][k][0])).toBeLessThan(0.2);
        expect(Math.abs(half[k][0] - multi.crossover['mix 0.5'][k][0])).toBeLessThan(0.2);
      });
    });
  });
});
