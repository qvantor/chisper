import { readFileSync } from 'fs';
import { join } from 'path';
import FFT from 'fft.js';
import { FX_MIX_PARAMS, FX_PARAMS } from '@chisper/preset-schema';
import {
  CHORUS_TAPS,
  CLICK_MIDDLE,
  clickInto,
  renderChorus,
  tapsOf,
} from '../../../../test-utils/chorus-render';
import { dB } from '../../../../test-utils/measures';
import type { ChorusDspParams } from './chorus-params';

// The chorus against the Audio Unit (dsp/measurements/chorus.json, scripts/renders/run.mjs --only=chorus): clicks
// and noise through the core, read as the renders are. Its LFO starts where it likes: a train of clicks is rendered
// after a rest (the LFO goes on in it) that puts ours where the measured one is

type Taps = [number, number[], number[]][];
interface Train {
  kParamRate?: number;
  kParamDepth?: number;
  kParamDelay?: number;
  kParamDelay2?: number;
  taps: Taps;
}
interface Measured {
  rate: number;
  delays: [number, number, number[], number[]][];
  fresh: Record<string, number>;
  lfo: Train[];
  feedback: [number, [number, number][]][];
  loops: [number, number][];
  frequencies: number[];
  filter: Record<'low' | 'high', [number, number[]][]>;
  comb: [number, number[]][];
  mix: [number, number, number][];
  level: [number, number, number][];
  mono: { seconds: number; left: number; right: number; sum: number };
}
const MEASURED: Measured = JSON.parse(
  readFileSync(join(__dirname, '../../../../../../../dsp/measurements/chorus.json'), 'utf8')
);
const { rate: RATE } = MEASURED;
const ms = (samples: number) => (samples / RATE) * 1000;

type Params = Partial<ChorusDspParams>;
// the knobs of a render by their names in the measurements
// (the rate of a fresh one as measured: the default of ours is its four digits, a tenth of a ms apart after a
// cycle of the LFO)
const knobs = ({
  kParamRate = MEASURED.fresh['kParamRate'],
  kParamDepth,
  kParamDelay,
  kParamDelay2,
}: Omit<Train, 'taps'>): Params => ({
  rate: kParamRate,
  ...(kParamDepth !== undefined && { depth: kParamDepth }),
  ...(kParamDelay !== undefined && { d1: kParamDelay }),
  ...(kParamDelay2 !== undefined && { d2: kParamDelay2 }),
});

// clicks every `period` s for `seconds` (one with no period) after a quiet tone, which goes on under a train
// (the measured chorus sleeps in a silence), a tail after
const AT = Math.round(0.1 * RATE);
const clicks = (seconds: number, period = 0) => {
  const signal = new Float64Array(AT + Math.round((seconds + 0.2) * RATE));
  const quiet = period ? signal.length : AT - 2000;
  for (let i = 0; i < quiet; i++)
    signal[i] = 1e-3 * Math.sin((2 * Math.PI * 1000 * i) / RATE) * Math.min(1, (quiet - i) / 2000);
  const step = Math.round(period * RATE);
  for (let i = 0; i < (step ? seconds * RATE : 1); i += step || 1) clickInto(signal, AT + i);
  return signal;
};
const CLICK = clicks(1.2);
// where both channels bring out the click of a signal at `at` (ms, in order)
const tapped = (params: Params, floor = 0.1, to = Math.round(0.1 * RATE)) => {
  const { left, right } = renderChorus({ ...CHORUS_TAPS, ...params }, RATE, [CLICK, CLICK]);
  return [left, right].map((channel) => tapsOf(channel, CLICK, AT + CLICK_MIDDLE, to, floor));
};
// the farthest a tap of ours is from the measured one it is nearest to (ms); Infinity where their counts differ
// (taps closer than `apart` ms are one peak in either)
const farthest = (ours: number[], theirs: number[], apart = 0.6) => {
  const merged = (taps: number[]) => taps.filter((tap, i) => i === 0 || tap - taps[i - 1] > apart);
  const close = (taps: number[]) => taps.some((tap, i) => i > 0 && tap - taps[i - 1] <= 2 * apart);
  if (!close(ours) && !close(theirs) && merged(ours).length !== merged(theirs).length) return Infinity;
  return Math.max(...theirs.map((tap) => Math.min(...ours.map((own) => Math.abs(own - tap)))));
};

describe('the chorus against the Audio Unit', () => {
  it('has the defaults of a fresh one', () => {
    const { fresh } = MEASURED;
    const { rate, d1, d2, depth, fb, cut } = FX_PARAMS.chorus;
    expect(fresh['apart']).toBeLessThan(-100);
    expect(Math.abs(rate.default / fresh['kParamRate'] - 1)).toBeLessThan(0.01);
    expect(d1.default).toBe(fresh['kParamDelay']);
    expect(d2.default).toBe(fresh['kParamDelay2']);
    expect(depth.default).toBe(fresh['kParamDepth']);
    expect(fb.default).toBeCloseTo(fresh['kParamFeedback'] / 100, 6);
    expect(cut.default).toBe(fresh['kParamFilt']);
    expect(FX_MIX_PARAMS.chorus.default).toBe(fresh['kParamWet'] / 100);
    expect(FX_PARAMS.chorus.level.default).toBe(fresh['kParamLevelOut']);
  });

  it('has its taps where the delays put them, the knobs held to their ranges', () => {
    for (const [first, second, left, right] of MEASURED.delays) {
      const [l, r] = tapped({ depth: 0, d1: first, d2: second });
      expect(
        farthest(
          l.map(([lag]) => ms(lag)),
          left,
          0.02
        )
      ).toBeLessThan(0.1);
      expect(
        farthest(
          r.map(([lag]) => ms(lag)),
          right,
          0.02
        )
      ).toBeLessThan(0.1);
    }
  });

  it.each(MEASURED.lfo.map((train, index) => [index, JSON.stringify({ ...train, taps: undefined }), train]))(
    'moves its taps as the LFO of train %i does: %s',
    (_index, _name, train) => {
      const { taps, ...rest } = train as Train;
      const period = taps[1][0] - taps[0][0];
      const seconds = taps[taps.length - 1][0] + period;
      const signal = clicks(seconds, period);
      const step = Math.round(period * RATE);
      const params = { ...CHORUS_TAPS, ...knobs(rest) };
      // the farthest tap of the train with the LFO `cycles` further on at its start
      const hz = Math.min(20, params.rate);
      const error = (cycles: number) => {
        const restFrames = hz > 0 ? Math.round((cycles / hz) * RATE) : 0;
        const { left, right } = renderChorus(params, RATE, [signal, signal], { rest: restFrames });
        let worst = 0;
        taps.forEach(([, theirsL, theirsR], k) => {
          const [l, r] = [left, right].map((channel) =>
            tapsOf(channel, signal, AT + CLICK_MIDDLE + k * step, step - 60, 0.12).map(([lag]) => ms(lag))
          );
          worst = Math.max(worst, farthest(l, theirsL), farthest(r, theirsR));
        });
        return worst;
      };
      // the start of the LFO: the best of 24 over a cycle, then closer around it
      let best = 0;
      let least = Infinity;
      for (let width = 1, k = 0; k < (hz > 0 ? 4 : 1); k++, width /= 12) {
        const from = best;
        for (let i = -12; i < 12; i++) {
          const cycles = (((from + (i * width) / 24) % 1) + 1) % 1;
          const worst = error(cycles);
          if (worst < least) [least, best] = [worst, cycles];
        }
      }
      expect(least).toBeLessThan(0.1);
    },
    120000
  );

  // the gain of the tap at `at` ms of [ms, gain] (the loudest peak within a tenth of a ms: not a ripple beside it)
  const loudest = (found: number[][], at: number) =>
    found
      .filter(([place]) => Math.abs(place - at) < 0.1)
      .reduce((best, [, gain]) => (Math.abs(gain) > Math.abs(best) ? gain : best), 0);
  // both taps of a channel at 10 ms
  const BOTH: Params = { depth: 0, d1: 10, d2: 10 };
  const repeats = (params: Params) =>
    tapped(params, 0.03, Math.round(0.056 * RATE))[0].map(([lag, gain]) => [ms(lag), gain]);

  it('feeds each tap back into itself: its repeats a delay apart, the feedback held to its range', () => {
    for (const [percent, theirs] of MEASURED.feedback) {
      const ours = repeats({ ...BOTH, fb: percent / 100 });
      // (the ripples of its interpolation around a tap are not repeats: those as loud as a tenth of a tap); each
      // measured repeat is one of ours
      const taps = theirs.filter(([, gain]) => gain > 0.076).map(([at]) => at);
      const own = ours.map(([at]) => at);
      expect(
        Math.max(...taps.map((at) => Math.min(...own.map((place) => Math.abs(place - at)))))
      ).toBeLessThan(0.1);
      // each repeat against the one before, as loud as measured within 1.5 dB (a pass through its interpolation
      // takes highs off a click, through ours others)
      taps.slice(1, 4).forEach((at, k) => {
        const [mine, measured] = [ours, theirs].map((found) =>
          dB(loudest(found, at) / loudest(found, taps[k]))
        );
        expect(Math.abs(mine - measured)).toBeLessThan(1.5);
      });
    }
    const [none, most, over] = [-50, 95, 100].map((percent) => repeats({ ...BOTH, fb: percent / 100 }));
    // (no repeat of the tap: only it and the ripple beside it)
    expect(none.filter(([at]) => at > 15)).toHaveLength(0);
    expect(over).toEqual(most);
  });

  it('keeps the loops of two taps apart: no repeat at the sum of their delays', () => {
    const theirs = MEASURED.loops.map(([at]) => at);
    const ours = repeats({ ...BOTH, d2: 7, fb: 0.5 });
    expect(
      farthest(
        ours.map(([at]) => at),
        theirs
      )
    ).toBeLessThan(0.1);
    expect(ours.some(([at]) => Math.abs(at - 17.24) < 0.3)).toBe(false);
  });

  // the response of the wet signal to a click: dB at each of the measured frequencies
  const N = 1 << 15;
  const response = (params: Params) => {
    const click = new Float64Array(N + 256);
    click[64] = 0.5;
    const { left } = renderChorus({ ...CHORUS_TAPS, ...params }, RATE, [click, click]);
    const fft = new FFT(N);
    const bins = fft.createComplexArray();
    fft.realTransform(bins, Array.from(left.subarray(0, N)));
    return MEASURED.frequencies.map((hz) => {
      const k = Math.round((hz * N) / RATE);
      return dB(Math.hypot(bins[2 * k], bins[2 * k + 1]) / 0.5);
    });
  };
  // the farthest of ours from the measured gains (dB), where the measured one is over `floor` dB and under `top` Hz.
  // A deliberate difference over TOP: a tap of the Audio Unit loses highs there (1.3 dB at 14 kHz, 3 dB at 17 kHz
  // with its delays at 0: its interpolation), ours keeps them
  const TOP = 12000;
  const off = (ours: number[], theirs: number[], floor = -40, top = TOP) =>
    Math.max(
      ...theirs.map((gain, i) =>
        gain > floor && MEASURED.frequencies[i] < top ? Math.abs(ours[i] - gain) : 0
      )
    );

  it.each(['low', 'high'] as const)('filters the wet signal: a %s pass by its knob', (mode) => {
    for (const [hz, theirs] of MEASURED.filter[mode]) {
      const ours = response({ depth: 0, d1: 0, d2: 0, cut: hz, hpf: mode === 'high' ? 1 : 0 });
      expect([hz, off(ours, theirs) < 1]).toEqual([hz, true]);
    }
  });

  it('combs the wet signal by its feedback', () => {
    for (const [percent, theirs] of MEASURED.comb) {
      const ours = response({ ...BOTH, fb: percent / 100 });
      // (at the top of the feedback its peaks are a few Hz wide: where they are a bin or more, the lows)
      expect([percent, off(ours, theirs, -40, percent > 90 ? 4000 : TOP) < 1]).toEqual([percent, true]);
    }
  });

  it('mixes by its own law, then the level', () => {
    const parts = (params: Params) => {
      const [found] = tapped({ ...BOTH, ...params }, 0.005, Math.round(0.012 * RATE));
      return [
        loudest(
          found.map(([lag, gain]) => [ms(lag), gain]),
          0
        ),
        loudest(
          found.map(([lag, gain]) => [ms(lag), gain]),
          10.12
        ),
      ];
    };
    const [full] = parts({ mix: 0 });
    const [, wettest] = parts({ mix: 1 });
    const [, , measuredWettest] = MEASURED.mix[MEASURED.mix.length - 1];
    for (const [mix, dry, wet] of MEASURED.mix) {
      const [ownDry, ownWet] = parts({ mix });
      expect(Math.abs(ownDry / full - dry)).toBeLessThan(0.01);
      expect(Math.abs(ownWet / wettest - wet / measuredWettest)).toBeLessThan(0.01);
    }
    const [middleDry, middleWet] = parts({ mix: 0.5 });
    const [, measuredDry, measuredWet] = MEASURED.level.find(([knob]) => knob === 0.5) ?? [0, 0, 0];
    for (const [knob, dry, wet] of MEASURED.level) {
      const [ownDry, ownWet] = parts({ mix: 0.5, level: knob });
      expect(Math.abs(dB(ownDry / middleDry) - (dry - measuredDry))).toBeLessThan(0.5);
      expect(Math.abs(dB(ownWet / middleWet) - (wet - measuredWet))).toBeLessThan(0.5);
    }
    // the dry signal at no mix as it came (the wet one of two taps as loud as it: the gains of the filter, which
    // are against the dry click)
    expect(dB(full)).toBeCloseTo(0, 1);
  });

  it('sums to mono as loud as measured', () => {
    const { seconds, left, right, sum } = MEASURED.mono;
    let seed = 1;
    const noise = Float64Array.from({ length: Math.round(seconds * RATE) }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return ((seed >>> 8) / (1 << 24) - 0.5) * 0.5;
    });
    const out = renderChorus({ rate: MEASURED.fresh['kParamRate'] }, RATE, [noise, noise]);
    const power = (of: (i: number) => number) => {
      let total = 0;
      for (let i = Math.round(0.2 * RATE); i < Math.round(13 * RATE); i++) total += of(i) ** 2;
      return total;
    };
    const reference = power((i) => noise[i]);
    const level = (of: (i: number) => number) => dB(Math.sqrt(power(of) / reference));
    const own = {
      left: level((i) => out.left[i]),
      right: level((i) => out.right[i]),
      sum: level((i) => (out.left[i] + out.right[i]) / 2),
    };
    expect(Math.abs(own.left - left)).toBeLessThan(0.5);
    expect(Math.abs(own.right - right)).toBeLessThan(0.5);
    // no deeper a dip in mono than the measured one
    expect(own.sum).toBeGreaterThan(sum - 0.5);
    expect(own.sum).toBeLessThan(sum + 0.5);
  });
});
