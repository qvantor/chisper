import {
  COMPRESSOR_DEFAULTS,
  gainAt,
  quadrature,
  renderCompressor,
} from '../../../../test-utils/compressor-render';
import { dB, toneOf } from '../../../../test-utils/measures';
import {
  bandThresholdsDb,
  CompressorDspParams,
  levelGain,
  makeupGain,
  thresholdDb,
} from './compressor-params';

// the Rust core of the compressor (dsp/compressor) through its facade: what each knob does (the measurements of
// the Audio Unit are held by compressor-measured.spec.ts)

const RATE = 48000;
type Params = Partial<CompressorDspParams>;
// the peak of a level held is read: the attack 1 ms, the release 1 s
const PEAK: Params = { attack: 1, release: 1000 };
const held = (level: number, seconds = 1, hz = 1000) =>
  quadrature(RATE, hz, [
    [-60, 0.2],
    [level, seconds],
  ]);
// the gain (dB) at the end of a level held
const gainOf = (params: Params, level: number, hz = 1000) => {
  const input = held(level, 1, hz);
  return gainAt(renderCompressor(params, RATE, input), input, input[0].length - 1);
};
const sine = (hz: number, amplitude: number, seconds: number) =>
  Float64Array.from(
    { length: Math.round(seconds * RATE) },
    (_, i) => amplitude * Math.sin((2 * Math.PI * hz * i) / RATE)
  );
const rms = (x: ArrayLike<number>, from = 0, to = x.length) => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += x[i] * x[i];
  return Math.sqrt(sum / (to - from));
};

describe('compressor core: one band', () => {
  it('passes a level under the threshold as it is, takes a share of what is over it off', () => {
    const threshold = thresholdDb(0.5);
    expect(threshold).toBeCloseTo(-16.66, 1);
    expect(gainOf(PEAK, threshold - 6)).toBeCloseTo(0, 2);
    // ratio 4: three quarters of the dB over the threshold
    expect(gainOf(PEAK, threshold + 8)).toBeCloseTo(-6, 0);
    expect(gainOf(PEAK, threshold + 16)).toBeCloseTo(-12, 0);
    expect(gainOf({ ...PEAK, ratio: 2 }, threshold + 16)).toBeCloseTo(-8, 0);
    expect(gainOf({ ...PEAK, ratio: 1 }, threshold + 16)).toBeCloseTo(0, 2);
    expect(gainOf({ ...PEAK, ratio: 30 }, threshold + 16)).toBeCloseTo(-16 * (29 / 30), 0);
  });

  it('the threshold knob: 0 dB at the bottom (nothing compressed), deeper by its cube, -120 dB at the top', () => {
    expect(gainOf({ ...PEAK, thresh: 0 }, -1)).toBeCloseTo(0, 2);
    const reductions = [0.6, 0.7, 0.8, 0.9].map((thresh) => -gainOf({ ...PEAK, thresh }, -6));
    reductions.forEach((reduction, i) => {
      const expected = 0.75 * (-6 - thresholdDb(0.6 + 0.1 * i));
      expect(Math.abs(reduction - expected)).toBeLessThan(0.4);
    });
    // at the top a quiet signal is far over it
    expect(gainOf({ ...PEAK, thresh: 1 }, -60)).toBeLessThan(-40);
  });

  it('the release: the reduction falls by e in its time, the attack is twice as fast as its knob', () => {
    const input = quadrature(RATE, 1000, [
      [-60, 0.2],
      [-3, 1],
      [-60, 1],
    ]);
    const frame = (seconds: number) => Math.round(seconds * RATE);
    const released = renderCompressor({ thresh: 0.7, attack: 1, release: 200 }, RATE, input);
    const before = gainAt(released, input, frame(1.19));
    // (0.1 s after the step: the highpass has settled)
    const [early, late] = [gainAt(released, input, frame(1.3)), gainAt(released, input, frame(1.5))];
    expect(early / before).toBeCloseTo(Math.exp(-0.1 / 0.2), 1);
    expect(late / early).toBeCloseTo(Math.exp(-1), 1);
    // the attack 100 ms: 1 - 1/e of the way after 50 ms, at the mean of the levels of both channels
    const attacked = renderCompressor({ thresh: 0.7, attack: 100, release: 1000 }, RATE, input);
    const full = gainAt(attacked, input, frame(1.19));
    const share = gainAt(attacked, input, frame(0.25)) / full;
    expect(share).toBeGreaterThan(0.55);
    expect(share).toBeLessThan(0.66);
  });

  it('links the channels by the louder one: both get one gain', () => {
    const loud = sine(1000, 0.5, 1);
    const quiet = loud.map((value) => value / 8);
    const out = renderCompressor({ ...PEAK, thresh: 0.7 }, RATE, [loud, quiet]);
    const from = RATE / 2;
    const left = rms(out.left, from) / rms(loud, from);
    const right = rms(out.right, from) / rms(quiet, from);
    expect(left).toBeLessThan(0.5);
    expect(right / left).toBeCloseTo(1, 4);
    // the other way around
    const swapped = renderCompressor({ ...PEAK, thresh: 0.7 }, RATE, [quiet, loud]);
    expect(rms(swapped.left, from) / rms(quiet, from)).toBeCloseTo(left, 4);
  });

  it('the makeup gain, the level and the mix by the laws of their knobs', () => {
    const quiet: Params = { thresh: 0 };
    expect(gainOf({ ...quiet, gain: 0.5 }, -40)).toBeCloseTo(dB(makeupGain(0.5)), 2);
    expect(gainOf({ ...quiet, gain: 1 }, -40)).toBeCloseTo(dB(32), 2);
    expect(gainOf({ ...quiet, level: 0.25 }, -40)).toBeCloseTo(dB(levelGain(0.25)), 2);
    expect(gainOf({ ...quiet, level: 1 }, -40)).toBeCloseTo(dB(4), 2);
    const silent = held(-20);
    expect(rms(renderCompressor({ ...quiet, level: 0 }, RATE, silent).left)).toBe(0);
    // the mix: the dry signal and the compressed one added, both in phase
    const wet = 10 ** (gainOf({ ...PEAK, thresh: 0.8 }, -6) / 20);
    expect(gainOf({ ...PEAK, thresh: 0.8, mix: 0.5 }, -6)).toBeCloseTo(dB((1 + wet) / 2), 1);
    expect(gainOf({ ...PEAK, thresh: 0.8, mix: 0 }, -6)).toBeCloseTo(0, 2);
  });

  it('takes the lows off with a highpass of one pole at 12 Hz, whatever the mix', () => {
    [1, 0].forEach((mix) => {
      const low = sine(12, 0.05, 2);
      const out = renderCompressor({ thresh: 0, mix }, RATE, [low, low]);
      expect(dB(rms(out.left, RATE) / rms(low, RATE))).toBeCloseTo(-3.01, 1);
      const dc = Float64Array.from({ length: RATE }, () => 0.05);
      const blocked = renderCompressor({ thresh: 0, mix }, RATE, [dc, dc]);
      expect(Math.abs(blocked.left[RATE - 1])).toBeLessThan(1e-4);
    });
  });
});

describe('compressor core: three bands', () => {
  const MULTI: Params = { multi: 1 };

  it('with no compression its bands sum to the input at any level of the mix: no notch at a crossover', () => {
    [1, 0.5, 0].forEach((mix) => {
      [60, 131, 600, 2500, 7000].forEach((hz) => {
        const input = sine(hz, 0.1, 1);
        const out = renderCompressor({ ...MULTI, ratio: 1, mix }, RATE, [input, input]);
        const highpass = hz / Math.hypot(hz, 12);
        expect(dB(rms(out.left, RATE / 2) / (rms(input, RATE / 2) * highpass))).toBeCloseTo(0, 1);
      });
    });
  });

  it('compresses a band over its threshold alone: the others keep their level', () => {
    const [low, high] = [sine(60, 0.4, 1.5), sine(6000, 0.01, 1.5)];
    const both = low.map((value, i) => value + high[i]);
    const out = renderCompressor({ ...MULTI, ratio: 20 }, RATE, [both, both]);
    const read = (x: ArrayLike<number>, hz: number) => toneOf(x, hz, RATE, RATE / 2, RATE / 2).amplitude;
    expect(dB(read(out.left, 60) / read(both, 60))).toBeLessThan(-10);
    expect(dB(read(out.left, 6000) / read(both, 6000))).toBeCloseTo(0, 0);
  });

  it('the threshold knob moves the thresholds of the bands, those its tooltip tells (bandThresholdsDb)', () => {
    const OVER = 8;
    [0.3, 0.5, 0.7].forEach((thresh) => {
      [60, 600, 9000].forEach((hz, band) => {
        const threshold = bandThresholdsDb(thresh)[band];
        const params: Params = { ...MULTI, thresh, ratio: 20 };
        // (the highpass takes a little off 60 Hz)
        const flat = dB(hz / Math.hypot(hz, 12));
        expect(Math.abs(gainOf(params, threshold - 3, hz) - flat)).toBeLessThan(0.5);
        expect(Math.abs(gainOf(params, threshold + OVER, hz) - flat + OVER * (1 - 1 / 20))).toBeLessThan(1);
      });
    });
  });

  it('the gains of the bands, in dB', () => {
    const neutral: Params = { ...MULTI, ratio: 1 };
    expect(gainOf({ ...neutral, low: 6 }, -40, 40)).toBeCloseTo(6 + dB(40 / Math.hypot(40, 12)), 0);
    expect(gainOf({ ...neutral, mid: -12 }, -40, 600)).toBeCloseTo(-12, 0);
    expect(gainOf({ ...neutral, high: 9 }, -40, 9000)).toBeCloseTo(9, 0);
    // the crossovers move the bands: 600 Hz is in the low band of a crossover at 2 kHz
    expect(gainOf({ ...neutral, low: -12, xlow: 2000, xhigh: 6000 }, -40, 600)).toBeCloseTo(-12, 0);
    // the high crossover never goes under the low one
    expect(gainOf({ ...neutral, mid: -24, xlow: 2000, xhigh: 300 }, -40, 600)).toBeCloseTo(0, 0);
  });

  it('Below lifts what is under the lower thresholds, up to +36 dB; a silence stays one', () => {
    expect(gainOf(MULTI, -60)).toBeCloseTo(0, 1);
    const lifted = gainOf({ ...MULTI, below: 0.5 }, -60);
    expect(lifted).toBeGreaterThan(10);
    expect(gainOf({ ...MULTI, below: 1 }, -60)).toBeGreaterThan(lifted + 8);
    // far under: the ceiling of the gain (the other bands lift what leaks into them too)
    const far = gainOf({ ...MULTI, below: 1 }, -100);
    expect(far).toBeGreaterThan(35);
    expect(far).toBeLessThan(40);
    const silence = new Float64Array(RATE);
    const out = renderCompressor({ ...MULTI, below: 1, gain: 1 }, RATE, [silence, silence]);
    expect(out.left.every((value) => value === 0)).toBe(true);
    expect(out.idle.every((idle) => idle)).toBe(true);
  });

  it('the Attack knob does nothing', () => {
    const input = held(-6, 0.3);
    const fast = renderCompressor({ ...MULTI, attack: 0.1 }, RATE, input);
    const slow = renderCompressor({ ...MULTI, attack: 1000 }, RATE, input);
    expect(Array.from(slow.left)).toEqual(Array.from(fast.left));
  });

  it('the release of the high band is faster than the one of the others', () => {
    const fall = (hz: number) => {
      const input = quadrature(RATE, hz, [
        [-60, 0.2],
        [0, 0.6],
        [-40, 0.6],
      ]);
      const out = renderCompressor({ ...MULTI, release: 200 }, RATE, input);
      return gainAt(out, input, Math.round(0.95 * RATE)) / gainAt(out, input, Math.round(0.79 * RATE));
    };
    const [mid, high] = [fall(600), fall(9000)];
    expect(mid).toBeGreaterThan(0.3);
    expect(high).toBeLessThan(mid - 0.1);
  });
});

describe('compressor core: its state', () => {
  it('is idle until a sound, awake through it, idle again once it has let go', () => {
    const input = quadrature(RATE, 500, [
      [-200, 0.1],
      [-6, 0.3],
      [-400, 2.6],
    ]).map((channel) => channel.map((value) => (Math.abs(value) < 1e-9 ? 0 : value))) as [
      Float64Array,
      Float64Array,
    ];
    [0, 1].forEach((multi) => {
      const { idle, left } = renderCompressor({ multi, release: 100 }, RATE, input);
      expect(idle[0]).toBe(true);
      expect(idle[Math.round((0.2 * RATE) / 128)]).toBe(false);
      expect(idle.at(-1)).toBe(true);
      expect(left.subarray(left.length - RATE).every((value) => value === 0)).toBe(true);
    });
  });

  it('clear forgets the reduction: the next sound starts uncompressed', () => {
    const input = held(-3, 0.5);
    const at = input[0].length - 4096;
    const kept = renderCompressor({ thresh: 0.8, attack: 300, release: 1000 }, RATE, input);
    const cleared = renderCompressor({ thresh: 0.8, attack: 300, release: 1000 }, RATE, input, [
      { at, clear: true },
    ]);
    expect(gainAt(kept, input, at + 256)).toBeLessThan(-10);
    expect(gainAt(cleared, input, at + 256)).toBeGreaterThan(-3);
  });

  it('a knob glides: no step in the output when the level or the mode changes', () => {
    const input: [Float64Array, Float64Array] = [sine(300, 0.05, 1), sine(300, 0.05, 1)];
    const largest = (out: { left: Float32Array }) => {
      let step = 0;
      for (let i = RATE / 4; i < out.left.length; i++)
        step = Math.max(step, Math.abs(out.left[i] - out.left[i - 1]));
      return step;
    };
    const plain = largest(renderCompressor({}, RATE, input));
    const changes = [
      { at: 20000, params: { level: 0.7 } },
      { at: 30000, params: { multi: 1 } },
      { at: 40000, params: { multi: 0, mix: 0.3 } },
    ];
    // (the level doubles: so does the step of the sine from a sample to the next)
    expect(largest(renderCompressor({}, RATE, input, changes))).toBeLessThan(plain * 2.2);
  });

  it('its meter: the gain of each band and the peak of the input, 0 while idle', () => {
    const input = held(-6, 0.5);
    const single = renderCompressor({ ...PEAK, thresh: 0.7 }, RATE, input).meters.at(-1);
    const expected = gainAt(
      renderCompressor({ ...PEAK, thresh: 0.7 }, RATE, input),
      input,
      input[0].length - 1
    );
    expect(single?.gains[0]).toBeCloseTo(expected, 1);
    expect(single?.gains[1]).toBe(single?.gains[0]);
    expect(single?.gains[2]).toBe(single?.gains[0]);
    expect(single?.input).toBeCloseTo(10 ** (-6 / 20), 2);
    // three bands: the mid one is pressed down, the low one (nearly silent) lifted to the ceiling of the gain, the
    // little of the sine in the high one is between its thresholds
    const bands = renderCompressor({ multi: 1, below: 1 }, RATE, input).meters.at(-1);
    expect(bands?.gains[1]).toBeLessThan(-6);
    expect(bands?.gains[0]).toBeCloseTo(36, 3);
    expect(bands?.gains[2]).toBe(0);
    const silence = new Float64Array(RATE / 2);
    const idle = renderCompressor({ multi: 1, below: 1 }, RATE, [silence, silence]).meters.at(-1);
    expect(idle).toEqual({ gains: [0, 0, 0], input: 0 });
  });

  it('the meter of an idle core is at rest from the block it goes idle in, whatever the bands were lifted by', () => {
    const input = quadrature(RATE, 500, [
      [-6, 0.3],
      [-400, 3],
    ]).map((channel) => channel.map((value) => (Math.abs(value) < 1e-9 ? 0 : value))) as [
      Float64Array,
      Float64Array,
    ];
    const { idle, meters } = renderCompressor({ multi: 1, below: 1, release: 50 }, RATE, input);
    const first = idle.findIndex((value, block) => value && block > 10);
    // lifted near the ceiling of the gain right before
    meters[first - 1].gains.forEach((gain) => expect(gain).toBeGreaterThan(30));
    idle.forEach((value, block) => {
      if (value) expect(meters[block]).toEqual({ gains: [0, 0, 0], input: 0 });
    });
  });

  it('the defaults are those of a fresh compressor', () => {
    expect(COMPRESSOR_DEFAULTS).toMatchObject({
      multi: 0,
      thresh: 0.5,
      ratio: 4,
      attack: 90,
      release: 90,
      mix: 1,
    });
  });
});
