import { readFileSync } from 'fs';
import { join } from 'path';
import FFT from 'fft.js';
import { chainState, makeChain, renderChain, slotOf } from '../../../../test-utils/chain-render';
import { tapsOf } from '../../../../test-utils/chorus-render';
import {
  AUDIO_UNIT_DELAY,
  AudioUnitDelay,
  delayOfAudioUnit,
  freeSeconds,
  readDelays,
  renderDelay,
  syncBeats,
} from '../../../../test-utils/delay-render';
import { dB } from '../../../../test-utils/measures';
import { CHAIN_KEYS, LFO_SOURCE, TARGET_KEYS } from '../../common/chain/chain-params';
import { FREE as FREE_LFO, lfoTable } from '../../common/lfo/lfo-curve';
import type { DelayDspParams } from './delay-params';

// The delay against the one of the Audio Unit (dsp/measurements/delay.json, scripts/renders/run.mjs --only=delay):
// the click of its renders through the core at the knobs its laws give (delayOfAudioUnit), read as the renders are.
// Deliberate differences, measured and not ours: its channels have a time and an offset each (Time is both of ours:
// the right channel of `apart` and `uneven`, whose feedback it turns down by the ratio of the times), its mode 2
// (the sum of both channels through one line after the other), its level (kParamLevelOut, 4v² over the whole
// output), a free time over 0.4 (no echo up to 0.5, then half a second), an echo between two samples with
// kParamHQ 0 (ours is whole samples, as its default), its shortest echo of 6 samples (ours: 129), a route on Time
// (ours in seconds, its a share of the travel of the knob: `law` of `lfo`, 25 samples off a line at the middle of 4 %)

type Tap = [lag: number, gain: number];
interface Measured {
  rate: number;
  impulse: { click: number[]; lags: number[]; echoes: number[][] };
  fresh: Record<string, number>;
  free: [knob: number, left: number | null, right: number | null][];
  tempos: [bpm: number | null, lag: number][];
  sync: [knob: number, lag: number | null][];
  feedback: [percent: number, repeats: Tap[]][];
  mix: [knob: number, dry: number, wet: number][];
  frequencies: number[];
  filter: [freq: number, width: number, gains: number[]][];
  modes: { input: 'left' | 'right'; mode: number; left: Tap[]; right: Tap[] }[];
  lfo: { amount: number; base: number; period: number; law: [share: number, lag: number][]; start: number };
  lfoDivisions: { division: string; hz: number; tau: number }[];
  lfoRows: [division: number, sample: number, delay: number][];
}
const MEASURED: Measured = JSON.parse(
  readFileSync(join(__dirname, '../../../../../../../dsp/measurements/delay.json'), 'utf8')
);
const { rate: RATE, impulse } = MEASURED;
// the echo of the free time 0.1 (4364 samples), and whether a lag is a repeat of it: Time and a sample apart
const ECHO = impulse.lags[0];
const repeats = ([lag]: Tap) => Math.abs((lag - ECHO) % (ECHO + 1)) < 1.5;

// the click of the renders (its peak 32 samples in) at AT, `seconds` of silence after it
const AT = 512;
const PEAK = 32;
const clicked = (seconds: number) => {
  const signal = new Float32Array(AT + Math.round(seconds * RATE));
  impulse.click.forEach((value, i) => (signal[AT - PEAK + i] = 0.5 * value));
  return signal;
};
const silence = (signal: Float32Array) => new Float32Array(signal.length);
// where a channel brings the click out, as the renders are read: [lag, gain], the click itself left out
const taps = (wet: Float32Array, dry: Float32Array, floor = 0.03, to = dry.length - AT - 64): Tap[] =>
  tapsOf(wet, dry, AT, to, floor).filter(([lag]) => Math.abs(lag) > 4);
const echoesOf = (
  knobs: AudioUnitDelay,
  { seconds = 1, floor = 0.03, input = 'both' as 'both' | 'left' | 'right', bpm = 120 } = {}
) => {
  const dry = clicked(seconds);
  const params = delayOfAudioUnit(knobs, RATE, bpm);
  const out = renderDelay(
    params,
    [input === 'right' ? silence(dry) : dry, input === 'left' ? silence(dry) : dry],
    [],
    RATE
  );
  return { left: taps(out.left, dry, floor), right: taps(out.right, dry, floor), out, dry };
};
const FREE = { kParamBeatSync: 0, kParamFeedback: 0 };
const WIDE = { kParamFreq: 1000, kParamBW: 8.25 };

describe('delay, measured', () => {
  it('a fresh delay of the Audio Unit is its defaults: the ones the laws start from', () => {
    expect(MEASURED.fresh['apart']).toBeLessThan(-100);
    expect(MEASURED.fresh['kParamWet']).toBe(AUDIO_UNIT_DELAY.kParamWet);
    expect(MEASURED.fresh['kParamFeedback']).toBe(AUDIO_UNIT_DELAY.kParamFeedback);
    expect(MEASURED.fresh['kParamBW']).toBe(AUDIO_UNIT_DELAY.kParamBW);
    expect(MEASURED.fresh['kParamFreq']).toBeCloseTo(AUDIO_UNIT_DELAY.kParamFreq, 2);
  });

  it('a free time: the echo at the sample of the measured one', () => {
    MEASURED.free
      // (its shortest echoes are under the shortest of ours, a time over 0.4 has none or half a second)
      .filter(([knob]) => knob >= 0.005 && knob <= 0.4)
      .forEach(([knob, left, right]) => {
        const found = echoesOf({ ...FREE, kParamTimeL: knob }, { seconds: knob + 0.05 });
        // (the same sample: a whole one)
        expect([knob, Math.abs(found.left[0][0] - (left ?? NaN)) < 0.02]).toEqual([knob, true]);
        expect([knob, found.right[0][0]]).toEqual([knob, expect.closeTo(right ?? NaN, 1)]);
      });
    // the law in samples: max(8, ceil((knob - 1 ms) · rate)) - 2
    MEASURED.free
      .filter(([knob]) => knob <= 0.4)
      .forEach(([knob, left]) =>
        expect([knob, Math.round((left ?? NaN) - 0.14)]).toEqual([
          knob,
          Math.max(8, Math.ceil(Math.fround((knob - 0.001) * RATE))) - 2,
        ])
      );
    expect(Math.round(freeSeconds(0.1, RATE) * RATE)).toBe(ECHO);
  });

  it('a time in sync: a division by the knob at the tempo of the host, its echo within 2 samples', () => {
    MEASURED.tempos.forEach(([bpm, lag]) => {
      const found = echoesOf({ kParamFeedback: 0 }, { seconds: 1.2, bpm: bpm ?? 120 });
      expect(Math.abs(found.left[0][0] - lag)).toBeLessThan(0.02);
    });
    const beat = (60 / 240) * RATE;
    MEASURED.sync
      .filter(([, lag]) => lag !== null)
      .forEach(([knob, lag]) =>
        expect([knob, Math.round((lag ?? NaN) - 0.14)]).toEqual([knob, Math.ceil(syncBeats(knob) * beat) - 2])
      );
  });

  it('the feedback: the repeats come a sample late each, by the gains measured', () => {
    MEASURED.feedback
      .filter(([percent]) => percent > 0)
      .forEach(([percent, measured]) => {
        // (the repeats of a click, its ripples beside them left out)
        const main = measured.filter(repeats);
        const found = echoesOf(
          { ...FREE, ...WIDE, kParamTimeL: 0.1, kParamFeedback: percent },
          { seconds: main[main.length - 1][0] / RATE + 0.05 }
        ).left.filter(repeats);
        main.forEach(([lag, gain], n) => {
          expect([percent, n, found[n][0]]).toEqual([percent, n, expect.closeTo(lag, 1)]);
          expect(Math.abs(found[n][1] - gain)).toBeLessThan(0.012);
        });
      });
  });

  it('the click and its echoes sample by sample: the bandpass of a fresh delay inside the feedback', () => {
    const { out } = echoesOf(
      { kParamBeatSync: 0, kParamTimeL: 0.1 },
      { seconds: impulse.lags[2] / RATE + 0.05 }
    );
    impulse.lags.forEach((lag, n) => {
      let [signal, difference] = [0, 0];
      impulse.echoes[n].forEach((value, i) => {
        const ours = out.left[AT - PEAK + lag + i] / 0.5;
        signal += value ** 2;
        difference += (ours - value) ** 2;
      });
      // (within 2 % of each echo: a sample apart they would be as far as the echo is loud)
      expect(10 * Math.log10(difference / signal)).toBeLessThan(-35);
    });
  });

  it('the mix of the slot: the dry and the wet gain of the knob', () => {
    const dry = clicked(0.15);
    const params = delayOfAudioUnit({ ...FREE, ...WIDE, kParamTimeL: 0.1 }, RATE);
    const run = (mix: number) => {
      const chain = makeChain(chainState(['delay'], mix, { delay: { params: { ...params } } }), RATE);
      const { left } = renderChain(chain, [dry, dry]);
      const found = tapsOf(left, dry, AT, Math.round(0.12 * RATE), 0.002);
      const gain = (lag: number) => found.find(([k]) => Math.abs(k - lag) < 1.5)?.[1] ?? 0;
      return [gain(0), gain(ECHO)];
    };
    const [, all] = run(1);
    MEASURED.mix.forEach(([knob, dryGain, wetGain]) => {
      const [ourDry, ourWet] = run(knob);
      expect(Math.abs(ourDry - dryGain)).toBeLessThan(0.005);
      expect(Math.abs(ourWet / all - wetGain)).toBeLessThan(0.005);
    });
  });

  it('the bandpass by Freq and BW: the response of an echo', () => {
    const N = 1 << 15;
    const fft = new FFT(N);
    const transform = (x: Float32Array, from: number) => {
      const bins = fft.createComplexArray();
      fft.realTransform(
        bins,
        Array.from({ length: N }, (_, i) => x[from + i] ?? 0)
      );
      return bins;
    };
    const dry = clicked(1);
    const base = transform(dry, AT - 64);
    MEASURED.filter.forEach(([freq, width, gains]) => {
      const params = delayOfAudioUnit({ ...FREE, kParamTimeL: 0.1, kParamFreq: freq, kParamBW: width }, RATE);
      // (its knob holds within 40 Hz..18 kHz)
      const within = { ...params, freq: Math.min(Math.max(freq, 40), 18000) } as DelayDspParams;
      const { left } = renderDelay(within, [dry, dry], [], RATE);
      const bins = transform(left, AT - 64 + ECHO);
      MEASURED.frequencies.forEach((hz, i) => {
        if (gains[i] < -40 || hz > 16000) return;
        const k = Math.round((hz * N) / RATE);
        const ours = dB(Math.hypot(bins[2 * k], bins[2 * k + 1]) / Math.hypot(base[2 * k], base[2 * k + 1]));
        expect([freq, width, hz, Math.abs(ours - gains[i]) < 0.5]).toEqual([freq, width, hz, true]);
      });
    });
  });

  it('normal and ping-pong: where a click of one channel comes out', () => {
    MEASURED.modes
      .filter(({ mode }) => mode < 2)
      .forEach(({ input, mode, left, right }) => {
        // (both of its times are our Time: the left one; in normal its right channel keeps the right one)
        const time = mode === 0 && input === 'right' ? 0.08 : 0.05;
        const found = echoesOf(
          {
            ...FREE,
            kParamFeedback: 50,
            kParamFreq: 1000,
            kParamBW: 2,
            kParamTimeL: time,
            kParamMode: mode,
          },
          { seconds: 0.4, input }
        );
        const first = (list: Tap[]) => list[0];
        if (mode === 0) {
          const [measured, ours, other] =
            input === 'left' ? [left, found.left, found.right] : [right, found.right, found.left];
          expect(other).toEqual([]);
          expect(Math.abs(first(ours)[0] - first(measured)[0])).toBeLessThan(0.05);
          expect(Math.abs(first(ours)[1] - first(measured)[1])).toBeLessThan(0.005);
          return;
        }
        // ping-pong: half of the click out of the left channel, out of the right one as it is a time later
        // (its right time: ours the same one again)
        expect(Math.abs(first(found.left)[0] - first(left)[0])).toBeLessThan(0.05);
        expect(Math.abs(first(found.left)[1] - first(left)[1])).toBeLessThan(0.005);
        expect(Math.abs(first(found.right)[1] - first(right)[1])).toBeLessThan(0.005);
        expect(first(right)[1]).toBeCloseTo(first(left)[1], 3);
        expect(first(found.right)[0] - first(found.left)[0]).toBeCloseTo(Math.round(0.049 * RATE - 1.5), 1);
        // the feedback once a round: its second echo of the left channel by the gain measured
        expect(Math.abs(found.left[1][1] - left[1][1])).toBeLessThan(0.005);
      });
  });

  it('an LFO on Time: the echoes read where those of the Audio Unit are, its time through the same one-pole', () => {
    const { lfo, lfoDivisions, lfoRows } = MEASURED;
    const share = lfo.amount / 100;
    const [low, high] = [lfo.law[0][1], lfo.law.find(([u]) => u === share)?.[1] ?? NaN];
    // its sine (from sample 0 here), the delay all wet, no feedback, the filter wide
    const frames = Math.round(2.2 * RATE);
    const sine = Float32Array.from(
      { length: frames },
      (_, n) => 0.25 * Math.sin((2 * Math.PI * n) / lfo.period) * Math.min(1, n / 2000)
    );
    const params = delayOfAudioUnit({ ...FREE, ...WIDE, kParamTimeL: lfo.base }, RATE);
    const time = slotOf('delay') * TARGET_KEYS + CHAIN_KEYS.delay.indexOf('time');
    lfoDivisions.forEach(({ division, hz }, index) => {
      // LFO 1 a triangle from its start (ours in seconds: the time of the Audio Unit's 4 % of its travel there)
      const lfos = [0, 1, 2, 3].map(() => ({
        mode: FREE_LFO,
        delay: 0,
        rise: 0,
        smooth: 0,
        phase: 0,
        anchor: { time: lfo.start / RATE, phase: 0, period: 1 / hz },
        table: lfoTable('triangle'),
      }));
      const state = chainState(
        ['delay'],
        1,
        { delay: { params: { ...params } } },
        {
          routes: [{ target: time, source: LFO_SOURCE, amount: (high - low) / RATE, min: 0.01, max: 1 }],
          lfos: { at: 0, instantly: true, lfos },
        }
      );
      const { left } = renderChain(makeChain(state, RATE), [sine, sine]);
      const rows = lfoRows.filter(([of]) => of === index);
      const mean = rows.reduce((sum, [, , d]) => sum + d, 0) / rows.length;
      const ours = readDelays(left, sine, lfo.period, mean, [Math.round(RATE), Math.round(2 * RATE)]);
      // (within 0.7 ms all along a cycle: the rest is its law, a curve; without the pole 3 to 11 ms off, 4 % to
      // three times deeper at 4 to 16 Hz)
      const off = Math.max(...rows.map(([, n, d]) => Math.abs(ours[n] - d)));
      expect([division, off < 30]).toEqual([division, true]);
      const swing = (values: number[]) => Math.max(...values) - Math.min(...values);
      const depth = swing(rows.map(([, n]) => ours[n])) / swing(rows.map(([, , d]) => d));
      expect([division, Math.abs(depth - 1) < 0.01]).toEqual([division, true]);
    });
  });
});
