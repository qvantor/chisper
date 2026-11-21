import { FX_TYPES } from '@chisper/preset-schema';
import {
  chainCore,
  chainState,
  makeChain,
  noise,
  renderChain,
  slotOf,
} from '../../../../test-utils/chain-render';
import { expectSameBits } from '../../../../test-utils/parity';
import { renderStereo } from '../../../../test-utils/fx-render';
import { createDelayWasm } from '../../fx/effects/delay-wasm';
import { createDistortionWasm } from '../../fx/effects/distortion-wasm';
import { createChorusWasm } from '../../fx/effects/chorus-wasm';
import { createCompressorWasm } from '../../fx/effects/compressor-wasm';
import { createReverbWasm } from '../../fx/effects/reverb-wasm';
import { createEqWasm } from '../../fx/effects/eq-wasm';
import { createLimiterWasm } from '../limiter/limiter-wasm';
import { CEILING } from '../limiter/limiter-params';
import type { LfosState } from '../lfo/lfo-curve';
import { CHAIN_KEYS, FX_KINDS, LFO_SOURCE, MIX_KEY, NEUTRAL_PARAMS, TARGET_KEYS } from './chain-params';

// The chain core through its facade (the crate has its own tests: cargo test -p chain): its slots are the units of
// the effects, what a node is made with is what it plays, the events and the routes reach the core

const RATE = 48000;
const FRAMES = 40 * 128;
const peak = (data: Float32Array) => data.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
const same = (name: string, a: { left: Float32Array; right: Float32Array }, b: typeof a) => {
  expectSameBits(name, 0, 'left', a.left, b.left);
  expectSameBits(name, 0, 'right', a.right, b.right);
};

describe('the chain core', () => {
  it('has the kinds of the preset schema, the neutral params of its keys', () => {
    expect([...FX_KINDS]).toEqual([...FX_TYPES]);
    FX_KINDS.forEach((kind) => expect(Object.keys(NEUTRAL_PARAMS[kind])).toEqual(CHAIN_KEYS[kind]));
  });

  it('is a wire without a slot, at the gains of 1 and without its limiter', () => {
    const input = noise(FRAMES);
    const out = renderChain(makeChain(chainState([])), input);
    same('a wire', out, { left: input[0], right: input[1] });
  });

  it('plays an effect alone in its slot as its unit does, to the bit', () => {
    const input = noise(FRAMES);
    const core = chainCore();
    const units = {
      distortion: () => createDistortionWasm(core, RATE, { params: NEUTRAL_PARAMS.distortion as never }),
      chorus: () => createChorusWasm(core, RATE, { params: { ...NEUTRAL_PARAMS.chorus, mix: 1 } as never }),
      compressor: () =>
        createCompressorWasm(core, RATE, { params: { ...NEUTRAL_PARAMS.compressor, mix: 1 } as never }),
    };
    (Object.keys(units) as (keyof typeof units)[]).forEach((kind) => {
      const out = renderChain(makeChain(chainState([kind]), RATE), input);
      expect(peak(out.left)).toBeGreaterThan(0.01);
      same(kind, out, renderStereo<Record<string, number>>(units[kind](), input));
    });
  });

  it('runs the slots in their order: the units one into the other', () => {
    const input = noise(FRAMES);
    const core = chainCore();
    const out = renderChain(makeChain(chainState(['compressor', 'distortion']), RATE), input);
    const first = renderStereo<Record<string, number>>(
      createCompressorWasm(core, RATE, { params: { ...NEUTRAL_PARAMS.compressor, mix: 1 } as never }),
      input
    );
    const second = renderStereo<Record<string, number>>(
      createDistortionWasm(core, RATE, { params: NEUTRAL_PARAMS.distortion as never }),
      [first.left, first.right]
    );
    same('compressor, then distortion', out, second);
    const other = renderChain(makeChain(chainState(['distortion', 'compressor']), RATE), input);
    expect(other.left).not.toEqual(out.left);
  });

  it('mixes a slot by the law of its kind: equal power for the echoes and the reverb', () => {
    const input = noise(FRAMES);
    const core = chainCore();
    const mix = 0.3;
    const out = renderChain(
      makeChain(chainState(['delay'], mix, { delay: { params: { time: 0.011 } } })),
      input
    );
    const wet = renderStereo<Record<string, number>>(
      createDelayWasm(core, RATE, { ...NEUTRAL_PARAMS.delay, time: 0.011 } as never),
      input
    );
    const [dry, share] = [
      Math.fround(Math.cos((mix * Math.PI) / 2)),
      Math.fround(Math.sin((mix * Math.PI) / 2)),
    ];
    const expected = input[0].map((value, i) => Math.fround(dry * value) + Math.fround(share * wet.left[i]));
    out.left.forEach((value, i) => expect(Math.abs(value - expected[i])).toBeLessThan(1e-6));
    expect(peak(wet.left)).toBeGreaterThan(0.01);
    const reverb = renderChain(makeChain(chainState(['reverb'], 1)), input);
    const alone = renderStereo<Record<string, number>>(
      createReverbWasm(core, RATE, { params: NEUTRAL_PARAMS.reverb as never }),
      input
    );
    reverb.left.forEach((value, i) => expect(Math.abs(value - alone.left[i])).toBeLessThan(1e-6));
  });

  it('mixes the EQ linearly (the wet signal in time with the dry one), its bands moved by the routes as lines', () => {
    const input = noise(FRAMES);
    const params = { t1: 1, f1: 700, q1: 70, g1: 12, t2: 2, f2: 5000, q2: 50 };
    const unit = renderStereo<Record<string, number>>(
      createEqWasm(chainCore(), RATE, { params: { ...NEUTRAL_PARAMS.eq, ...params } as never }),
      input
    );
    const eq = (mix: number, rest = {}) =>
      renderChain(makeChain(chainState(['eq'], mix, { eq: { params } }, rest)), input);
    // all wet: its unit to the bit
    same('the EQ all wet', eq(1), unit);
    // a mix of 0.4: 0.6 of the input and 0.4 of the EQ
    const mixed = eq(0.4);
    mixed.left.forEach((value, i) =>
      expect(
        Math.abs(value - (Math.fround(0.6 * input[0][i]) + Math.fround(0.4 * unit.left[i])))
      ).toBeLessThan(1e-6)
    );
    // an LFO on the frequency of band 1: a line of it, the band moves
    const f1 = slotOf('eq') * TARGET_KEYS + CHAIN_KEYS.eq.indexOf('f1');
    const moved = eq(1, {
      routes: [{ target: f1, source: LFO_SOURCE, amount: 2, min: 21.53, max: 20000, scale: 'log' }],
      lfos: lfos(),
    });
    expect(moved.left.every(Number.isFinite)).toBe(true);
    expect(moved.left.subarray(20 * 128)).not.toEqual(unit.left.subarray(20 * 128));
  });

  it('ends in the limiter: the output under its ceiling, late by its lookahead', () => {
    const input = noise(FRAMES, 3);
    const chain = makeChain(chainState([]), RATE, true);
    const limiter = createLimiterWasm(chainCore(), RATE);
    expect(chain.latency).toBe(limiter.latency);
    const out = renderChain(chain, input);
    expect(peak(out.left)).toBeLessThanOrEqual(CEILING);
    same('the limiter', out, renderStereo(Object.assign(limiter, { set: () => undefined }), input));
    expect(makeChain(chainState([])).latency).toBe(0);
  });

  it('takes the knobs, the mix, the state and the order of a slot as events', () => {
    const input = noise(FRAMES);
    const run = (before?: Parameters<typeof renderChain>[2]) =>
      renderChain(makeChain(chainState(['distortion'])), input, before);
    const plain = run();
    const at = 10 * 128;
    const driven = run((chain, frame) => {
      if (frame === at) chain.setParams(0, { drive: 12, nope: 1 });
    });
    expect(driven.left.subarray(0, at)).toEqual(plain.left.subarray(0, at));
    expect(driven.left.subarray(at)).not.toEqual(plain.left.subarray(at));
    // off: a wire once its effect has faded out (a tenth of a second)
    const off = run((chain, frame) => {
      if (frame === 128) chain.setActive(0, false);
    });
    expect(off.left.subarray(39 * 128)).toEqual(input[0].subarray(39 * 128));
    // out of the order: it fades out the same, where it was
    const out = run((chain, frame) => {
      if (frame === 128) chain.setOrder([]);
    });
    expect(out.left.subarray(128, 2 * 128)).not.toEqual(input[0].subarray(128, 2 * 128));
    expect(out.left.subarray(39 * 128)).toEqual(input[0].subarray(39 * 128));
    const half = run((chain, frame) => {
      if (frame === at) chain.setMix(0, 0);
    });
    half.left.subarray(30 * 128).forEach((value, i) => {
      // (all dry once its gains have glided there: the input, late by the latency of the distortion)
      expect(value).toBeCloseTo(input[0][30 * 128 + i - 32], 2);
    });
  });

  it('takes an event at its frame: the master gain, the mute and its end', () => {
    const frames = 20 * 128;
    const input: [Float32Array, Float32Array] = [
      new Float32Array(frames).fill(0.5),
      new Float32Array(frames),
    ];
    const chain = makeChain(chainState([], 1, {}, { masterGain: 0.5 }));
    chain.setMasterGain(0.25, 8 * 128);
    chain.mute(64 / RATE, 12 * 128);
    chain.unmute(16 * 128);
    const { left } = renderChain(chain, input);
    expect(left[0]).toBe(0.25);
    expect(left[8 * 128 - 1]).toBe(0.25);
    expect(left[8 * 128]).toBe(0.125);
    expect(left[12 * 128 + 32]).toBe(0.0625);
    expect(left[12 * 128 + 64]).toBe(0);
    expect(left[16 * 128 - 1]).toBe(0);
    expect(left[16 * 128]).toBe(0.125);
    // a mute with a time taken late (64 samples after it) ends in time: 64 samples are left of its 128
    const late = makeChain(chainState([]));
    late.mute(128 / RATE, 12 * 128 - 64);
    const faded = renderChain(late, input).left;
    expect(faded[12 * 128 - 1]).toBe(0.5);
    expect(faded[12 * 128 + 32]).toBe(0.25);
    expect(faded[12 * 128 + 64]).toBe(0);
    // made muted: silent until it is opened
    const muted = makeChain(chainState([], 1, {}, { muted: true }));
    muted.unmute(4 * 128);
    const quiet = renderChain(muted, input);
    expect(peak(quiet.left.subarray(0, 4 * 128))).toBe(0);
    expect(quiet.left[4 * 128]).toBe(0.5);
  });

  it('forgets the tails of its effects when it is cleared', () => {
    const frames = 60 * 128;
    const input = noise(frames);
    input.forEach((channel) => channel.fill(0, 10 * 128));
    const state = () => chainState(['delay', 'reverb'], 0.5, { delay: { params: { time: 0.02, fb: 0.8 } } });
    const tail = renderChain(makeChain(state()), input);
    expect(peak(tail.left.subarray(40 * 128))).toBeGreaterThan(1e-3);
    const cleared = renderChain(makeChain(state()), input, (chain, frame) => {
      if (frame === 20 * 128) chain.clear();
    });
    expect(peak(cleared.left.subarray(20 * 128))).toBe(0);
  });

  const lfos = (): LfosState => ({
    at: 0,
    instantly: true,
    lfos: [0, 1, 2, 3].map(() => ({
      mode: 1,
      delay: 0,
      rise: 0,
      smooth: 0,
      phase: 0,
      anchor: { time: 0, phase: 0, period: 0.05 },
    })),
  });
  const held = { attack: 0, hold: 0, decay: 0, sustain: 1, release: 0 };
  const note = (start: number, velo?: number) => ({
    envelopes: [held, held, held],
    start,
    release: null,
    ...(velo !== undefined && { velo }),
  });

  it('moves the knobs by the routes of the last note: an envelope, the velocity, an LFO', () => {
    const input = noise(FRAMES);
    const level = slotOf('distortion') * TARGET_KEYS + CHAIN_KEYS.distortion.indexOf('level');
    const route = (source: number, amount = -24) => ({ target: level, source, amount, min: -24, max: 12 });
    const plain = renderChain(makeChain(chainState(['distortion'])), input);
    // a held envelope at 1: 24 dB down from the first block on (made with the state), and as a message
    const state = chainState(['distortion'], 1, {}, { routes: [route(0)], note: note(0) });
    const moved = renderChain(makeChain(state), input);
    expect(peak(moved.left.subarray(20 * 128))).toBeLessThan(0.1 * peak(plain.left.subarray(20 * 128)));
    const later = renderChain(makeChain(chainState(['distortion'])), input, (chain, frame) => {
      if (frame !== 10 * 128) return;
      chain.setRoutes([route(0)]);
      chain.setNote(note(0));
    });
    expect(later.left.subarray(0, 10 * 128)).toEqual(plain.left.subarray(0, 10 * 128));
    expect(peak(later.left.subarray(30 * 128))).toBeLessThan(0.1 * peak(plain.left.subarray(30 * 128)));
    // a note that starts later is taken at its start; without a note an envelope is 0
    const waiting = renderChain(
      makeChain(chainState(['distortion'], 1, {}, { routes: [route(1)], note: note((20 * 128) / RATE) })),
      input
    );
    expect(waiting.left.subarray(0, 20 * 128)).toEqual(plain.left.subarray(0, 20 * 128));
    expect(waiting.left.subarray(20 * 128)).not.toEqual(plain.left.subarray(20 * 128));
    // the velocity of the note
    const velocity = renderChain(
      makeChain(chainState(['distortion'], 1, {}, { routes: [route(3)], note: note(0, 0.5) })),
      input
    );
    const ratio = peak(velocity.left.subarray(20 * 128)) / peak(plain.left.subarray(20 * 128));
    expect(20 * Math.log10(ratio)).toBeCloseTo(-12, 0);
    // an LFO: without a note too, the level goes up and down
    const swept = renderChain(
      makeChain(chainState(['distortion'], 1, {}, { routes: [route(LFO_SOURCE, -12)], lfos: lfos() })),
      input
    );
    const blocks = Array.from({ length: 30 }, (_, block) =>
      peak(swept.left.subarray((10 + block) * 128, (11 + block) * 128))
    );
    expect(Math.max(...blocks) / Math.min(...blocks)).toBeGreaterThan(2);
  });

  it('moves the mix of a slot and the knobs of the delay a sample at a time', () => {
    const frames = 80 * 128;
    const input: [Float32Array, Float32Array] = [
      new Float32Array(frames).fill(0.5),
      new Float32Array(frames).fill(0.5),
    ];
    const mix = slotOf('reverb') * TARGET_KEYS + MIX_KEY;
    // (a reverb of a steady input is far from it: the output follows the gains of the mix)
    const routes = [{ target: mix, source: LFO_SOURCE, amount: 0.8, min: 0, max: 1 }];
    const state = () => chainState(['reverb'], 0.1, {}, { routes, lfos: lfos() });
    const { left } = renderChain(makeChain(state()), input);
    const tail = left.subarray(40 * 128);
    for (let i = 1; i < tail.length; i++) expect(Math.abs(tail[i] - tail[i - 1])).toBeLessThan(0.01);
    const still = renderChain(makeChain(chainState(['reverb'], 0.1)), input).left.subarray(40 * 128);
    const spread = (data: Float32Array) => Math.max(...data) - Math.min(...data);
    expect(spread(tail)).toBeGreaterThan(spread(still) + 0.05);

    const clicks = noise(frames);
    const time = slotOf('delay') * TARGET_KEYS + CHAIN_KEYS.delay.indexOf('time');
    const delayed = (moved: boolean) =>
      renderChain(
        makeChain(
          chainState(
            ['delay'],
            1,
            { delay: { params: { time: 0.02 } } },
            moved
              ? {
                  routes: [{ target: time, source: LFO_SOURCE, amount: 0.005, min: 0.01, max: 1 }],
                  lfos: lfos(),
                }
              : {}
          )
        ),
        clicks
      );
    const bent = delayed(true);
    expect(bent.left.every(Number.isFinite)).toBe(true);
    expect(bent.left.subarray(40 * 128)).not.toEqual(delayed(false).left.subarray(40 * 128));
  });

  it('drops an effect that traps: its slot passes its input, the others play, made again it plays', () => {
    const input = noise(FRAMES);
    const chain = makeChain(chainState(['chorus', 'distortion']));
    const reports: number[] = [];
    const out = renderChain(chain, input, (current, frame) => {
      reports.push(current.reports());
      if (frame === 10 * 128) current.trap(slotOf('chorus'));
      if (frame === 20 * 128) {
        current.trap(-1);
        current.retry(slotOf('chorus'));
      }
    });
    expect(reports.filter((report) => report !== 0)).toEqual([1 << slotOf('chorus')]);
    expect(reports.indexOf(1 << slotOf('chorus'))).toBe(11);
    // without the chorus: the distortion of the input (its state from the blocks before: not to the bit)
    const alone = renderChain(makeChain(chainState(['distortion'])), input);
    const [from, to] = [16 * 128, 20 * 128];
    const difference = out.left.subarray(from, to).map((value, i) => value - alone.left[from + i]);
    expect(peak(difference)).toBeLessThan(1e-3);
    expect(peak(out.left.subarray(from, to))).toBeGreaterThan(0.01);
    // made again
    const after = out.left.subarray(30 * 128).map((value, i) => value - alone.left[30 * 128 + i]);
    expect(peak(after)).toBeGreaterThan(0.01);
  });

  it('is silent once its limiter traps, until the limiter is made again', () => {
    const input = noise(FRAMES);
    const chain = makeChain(chainState(['distortion']), RATE, true);
    const reports: number[] = [];
    const out = renderChain(chain, input, (current, frame) => {
      reports.push(current.reports());
      if (frame === 10 * 128) current.trap(FX_KINDS.length);
      if (frame === 20 * 128) {
        current.trap(-1);
        current.retry(FX_KINDS.length);
      }
    });
    expect(reports.filter((report) => report !== 0)).toEqual([1 << FX_KINDS.length]);
    expect(peak(out.left.subarray(0, 10 * 128))).toBeGreaterThan(0.01);
    expect(peak(out.left.subarray(10 * 128, 20 * 128))).toBe(0);
    expect(peak(out.left.subarray(22 * 128))).toBeGreaterThan(0.01);
  });

  it('a trap that is in no stage: the block is silent and the chain says it is over, no stage is told', () => {
    const chain = makeChain(chainState(['distortion']));
    const loud = new Float32Array(128).fill(0.5);
    const out = new Float32Array(128);
    expect(chain.process(loud, loud, out, out, 0)).toBe(true);
    chain.trap(FX_KINDS.length + 1);
    out.fill(1);
    expect(chain.process(loud, loud, out, out, 128)).toBe(false);
    expect(peak(out)).toBe(0);
    expect(chain.reports()).toBe(0);
  });

  it('a unit made again has no meter until then: nothing to read of one that failed', () => {
    const chain = makeChain(chainState(['chorus']));
    const loud = new Float32Array(128).fill(0.5);
    const out = new Float32Array(128);
    chain.process(loud, loud, out, out, 0);
    chain.trap(slotOf('chorus'));
    chain.process(loud, loud, out, out, 128);
    expect(chain.meter(slotOf('chorus'))).toHaveLength(0);
    chain.trap(-1);
    chain.retry(slotOf('chorus'));
    expect(chain.meter(slotOf('chorus'))).toHaveLength(6);
    chain.free();
  });

  it('tells the meter of an effect and whether it has anything to play', () => {
    const chain = makeChain(chainState(['compressor', 'chorus']));
    expect(chain.idle(slotOf('compressor'))).toBe(true);
    const loud = new Float32Array(128).fill(0.9);
    const out = new Float32Array(128);
    for (let block = 0; block < 20; block++) chain.process(loud, loud, out, out, block * 128);
    expect(chain.idle(slotOf('compressor'))).toBe(false);
    const meter = Array.from(chain.meter(slotOf('compressor')));
    expect(meter).toHaveLength(4);
    expect(meter[3]).toBeCloseTo(0.9, 5);
    expect(chain.meter(slotOf('chorus'))).toHaveLength(6);
    expect(chain.meter(slotOf('distortion'))).toHaveLength(0);
    chain.free();
  });
});
