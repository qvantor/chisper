import {
  CHORUS_DEFAULTS,
  CHORUS_TAPS,
  CLICK_MIDDLE,
  clickInto,
  mainTaps,
  mixGains,
  renderChorus,
  TAP_LATENCY_MS,
  tapsOf,
} from '../../../../test-utils/chorus-render';
import { dB, toneOf } from '../../../../test-utils/measures';
import { depthMs, levelGain } from './chorus-params';

// the Rust core of the chorus (dsp/chorus) through its facade: its taps, its LFO, its feedback, its filter, its
// mix, its rest. chorus-measured.spec.ts holds it to the Audio Unit, chorus-goldens.spec.ts to its bits

const RATE = 48000;
const ms = (samples: number) => (samples / RATE) * 1000;
const AT = 4800;
const click = (frames = 24000) => {
  const signal = new Float64Array(frames);
  clickInto(signal, AT);
  return signal;
};
// where each channel brings the click out (ms)
const taps = (params: Partial<typeof CHORUS_TAPS>, rest = 0) => {
  const signal = click();
  const { left, right } = renderChorus({ ...CHORUS_TAPS, ...params }, RATE, [signal, signal], { rest });
  return [left, right].map((channel) =>
    mainTaps(tapsOf(channel, signal, AT + CLICK_MIDDLE, Math.round(0.1 * RATE), 0.1)).map(([lag]) => ms(lag))
  );
};
const tone = (hz: number, seconds: number, level = 0.25) =>
  Float64Array.from(
    { length: Math.round(seconds * RATE) },
    (_, i) => level * Math.sin((2 * Math.PI * hz * i) / RATE)
  );

describe('chorus dsp', () => {
  it('two taps a channel: Delay 2 and Delay 1 after the latency of a tap, alike in both channels at rest', () => {
    const [left, right] = taps({ depth: 0, d1: 12, d2: 3 });
    expect(left).toHaveLength(2);
    expect(left[0]).toBeCloseTo(3 + TAP_LATENCY_MS, 1);
    expect(left[1]).toBeCloseTo(12 + TAP_LATENCY_MS, 1);
    left.forEach((tap, i) => expect(right[i]).toBeCloseTo(tap, 3));
  });

  it('the LFO at rest (rate 0): the taps of a channel half a cycle apart, the channels a quarter', () => {
    const travel = depthMs(2);
    const [left, right] = taps({ depth: 2, rate: 0, d1: 20, d2: 0 });
    expect(left[0]).toBeCloseTo(TAP_LATENCY_MS + travel, 1);
    expect(left[1]).toBeCloseTo(20 + TAP_LATENCY_MS, 1);
    expect(right[0]).toBeCloseTo(TAP_LATENCY_MS + travel / 2, 1);
    expect(right[1]).toBeCloseTo(20 + TAP_LATENCY_MS + travel / 2, 1);
  });

  it('the LFO goes on while it rests: a rest of half a cycle swaps the taps of a channel', () => {
    const travel = depthMs(2);
    // (a cycle of 1 Hz, half of it gone when the click comes; the pole of a tap is at its target when it wakes)
    const [left] = taps({ depth: 2, rate: 1, d1: 20, d2: 0 }, RATE / 2 - AT);
    expect(left[0]).toBeCloseTo(TAP_LATENCY_MS, 0);
    expect(left[1]).toBeCloseTo(20 + TAP_LATENCY_MS + travel, 0);
  });

  it('the depth is the travel of a tap: 62.5 ms at its top, held there', () => {
    expect(depthMs(26)).toBe(62.5);
    const [top] = taps({ depth: 26, rate: 0, d1: 20, d2: 0 });
    const [over] = taps({ depth: 40, rate: 0, d1: 20, d2: 0 });
    expect(top[top.length - 1]).toBeCloseTo(62.5 + TAP_LATENCY_MS, 1);
    expect(over).toEqual(top);
  });

  it('the mix: wet sin²(π mix / 2), dry 1 - wet², the level × 4 knob²', () => {
    expect(mixGains(0)).toEqual([1, 0]);
    expect(mixGains(0.5)[0]).toBeCloseTo(0.75, 9);
    expect(mixGains(0.5)[1]).toBeCloseTo(0.5, 9);
    expect(mixGains(1)[0]).toBeCloseTo(0, 9);
    expect(mixGains(2)).toEqual(mixGains(1));
    expect(levelGain(0.5)).toBe(1);
    expect(levelGain(1)).toBe(4);
    // a tone held: the dry signal alone at no mix, × the level
    const input = tone(440, 0.5);
    for (const level of [0.25, 0.5, 1]) {
      const { left } = renderChorus({ mix: 0, level }, RATE, [input, input]);
      const gain = toneOf(left, 440, RATE, 12000, 8192).amplitude / 0.25;
      expect(dB(gain)).toBeCloseTo(dB(levelGain(level)), 2);
    }
    // the taps of a channel at one delay, the filter open: the wet signal as loud as the dry one was
    const { left } = renderChorus({ ...CHORUS_TAPS, depth: 0, d1: 0, d2: 0 }, RATE, [input, input]);
    expect(dB(toneOf(left, 440, RATE, 12000, 8192).amplitude / 0.25)).toBeCloseTo(0, 1);
  });

  it('the filter of the wet signal: a low pass under its cutoff, a high pass over it, the dry signal whole', () => {
    const gain = (hz: number, params: object) => {
      const input = tone(hz, 0.5);
      const { left } = renderChorus({ ...CHORUS_TAPS, depth: 0, d1: 0, d2: 0, ...params }, RATE, [
        input,
        input,
      ]);
      return dB(toneOf(left, hz, RATE, 12000, 8192).amplitude / 0.25);
    };
    expect(gain(100, { cut: 1000 })).toBeCloseTo(0, 0);
    expect(gain(8000, { cut: 1000 })).toBeLessThan(-30);
    expect(gain(100, { cut: 1000, hpf: 1 })).toBeLessThan(-30);
    expect(gain(8000, { cut: 1000, hpf: 1 })).toBeCloseTo(0, 0);
    // (its resonance: 3 dB at the cutoff it has, a little under its knob)
    expect(gain(860, { cut: 1000 })).toBeGreaterThan(2);
    expect(gain(8000, { cut: 1000, mix: 0 })).toBeCloseTo(0, 2);
  });

  it('idle until a sound, idle again once its taps have drained: the longer its feedback, the later', () => {
    const blocksAwake = (fb: number) => {
      const signal = new Float64Array(RATE * 3);
      clickInto(signal, 1280);
      const { idle } = renderChorus({ fb, d1: 20, d2: 20, depth: 0 }, RATE, [signal, signal]);
      expect(idle[0]).toBe(true);
      expect(idle[10]).toBe(false);
      expect(idle[idle.length - 1]).toBe(true);
      return idle.filter((value) => !value).length;
    };
    const [short, long] = [blocksAwake(0), blocksAwake(0.5)];
    // never before its longest tap could have come back
    expect((short * 128) / RATE).toBeGreaterThan(0.0825);
    expect(long).toBeGreaterThan(2 * short);
  });

  it('clear() drops the taps: a click in them never comes out', () => {
    const signal = click(12000);
    const params = { ...CHORUS_TAPS, depth: 0, d1: 20, d2: 20 };
    const whole = renderChorus(params, RATE, [signal, signal]);
    const cleared = renderChorus(params, RATE, [signal, signal], {
      changes: [{ at: AT + 256, clear: true }],
    });
    const loudest = (out: Float32Array) => out.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
    expect(loudest(whole.left)).toBeGreaterThan(0.1);
    expect(loudest(cleared.left)).toBe(0);
    expect(cleared.idle[Math.floor((AT + 256) / 128)]).toBe(true);
  });

  it('a knob that jumps glides: no click in a held tone', () => {
    const input = tone(220, 1);
    const steepest = (changes: Parameters<typeof renderChorus>[3]) => {
      const { left } = renderChorus({ rate: 0.5, depth: 2 }, RATE, [input, input], changes);
      let step = 0;
      for (let i = 12000; i < left.length; i++) step = Math.max(step, Math.abs(left[i] - left[i - 1]));
      return step;
    };
    const steady = steepest({});
    const moved = steepest({
      changes: [
        { at: 14400, params: { d1: 20, d2: 15, depth: 20 } },
        { at: 24000, params: { mix: 1, level: 0.8, fb: 0.9, cut: 8000 } },
        { at: 33600, params: { hpf: 1, mix: 0.2, d1: 0 } },
      ],
    });
    expect(moved).toBeLessThan(6 * steady);
  });

  it('the defaults of the schema are a fresh chorus', () => {
    expect(CHORUS_DEFAULTS).toEqual({
      rate: 0.078,
      d1: 5,
      d2: 0,
      depth: 26,
      fb: 0.095,
      cut: 1000,
      hpf: 0,
      level: 0.5,
      mix: 0.5,
    });
  });
});
