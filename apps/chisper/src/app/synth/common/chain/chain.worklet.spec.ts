import { chainState, noise, slotOf } from '../../../../test-utils/chain-render';
import { installWorkletScope } from '../../../../test-utils/worklet-scope';
import {
  CHAIN_KEYS,
  CHAIN_PROCESSOR,
  ChainMessage,
  ChainState,
  FX_KINDS,
  LFO_SOURCE,
  LIMITER_STAGE,
  TARGET_KEYS,
} from './chain-params';
import { ChainWasm, TRAP_IN } from './chain-wasm';

const RATE = 48000;
const processors = installWorkletScope(RATE);

const peak = (data: Float32Array) => data.reduce((max, value) => Math.max(max, Math.abs(value)), 0);

interface Processor {
  port: { onmessage: (event: { data: ChainMessage }) => void; postMessage: (message: unknown) => void };
  process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
  chain: ChainWasm | null;
  // what it posted, copied as a port copies it (the processor posts the same message every time)
  posts: jest.Mock;
}
const create = (state?: ChainState): Processor => {
  const processor = new processors[CHAIN_PROCESSOR](
    state ? { processorOptions: { state } } : {}
  ) as unknown as Processor;
  processor.posts = jest.fn();
  processor.port.postMessage = (message) => processor.posts(JSON.parse(JSON.stringify(message)));
  return processor;
};

// `blocks` blocks of `input` from `frame` on (null: the node gets no channel), the output of the left channel
const run = (processor: Processor, input: Float32Array[] | null, blocks: number, frame = 0) => {
  const left = new Float32Array(blocks * 128);
  const right = new Float32Array(blocks * 128);
  for (let block = 0; block < blocks; block++) {
    const from = block * 128;
    Object.assign(globalThis, { currentFrame: frame + from });
    const outputs = [[left.subarray(from, from + 128), right.subarray(from, from + 128)]];
    const inputs = input ? [input.map((channel) => channel.subarray(from, from + 128))] : [[]];
    expect(processor.process(inputs, outputs)).toBe(true);
  }
  return { left, right };
};

describe('chain wasm worklet', () => {
  beforeAll(() => import('./chain.worklet'));

  it('registers the processor of the chain with the Rust core, a wire with its limiter when made without a state', () => {
    expect(processors[CHAIN_PROCESSOR]).toBeDefined();
    const input = noise(20 * 128, 0.2);
    const processor = create();
    const { left } = run(processor, input, 20);
    const latency = processor.chain?.latency ?? 0;
    expect(latency).toBeGreaterThan(0);
    // (under the ceiling the limiter is its input, late by its lookahead)
    expect(Array.from(left.subarray(latency))).toEqual(
      Array.from(input[0].subarray(0, left.length - latency))
    );
  });

  it('starts with the state of its node: the slots, their order, the gains', () => {
    const input = noise(40 * 128, 0.2);
    const wire = run(create(), input, 40).left;
    const state = chainState(['distortion'], 1, { distortion: { params: { drive: 12 } } });
    const driven = run(create(state), input, 40).left;
    expect(driven).not.toEqual(wire);
    expect(peak(driven)).toBeGreaterThan(0.01);
    const quiet = run(create(chainState([], 1, {}, { masterGain: 0.5 })), input, 40).left;
    expect(peak(quiet)).toBeCloseTo(0.5 * peak(wire), 5);
    expect(peak(run(create(chainState([], 1, {}, { muted: true })), input, 40).left)).toBe(0);
  });

  it('takes a mono input into both channels, no input as silence', () => {
    const input = noise(20 * 128, 0.2);
    const processor = create();
    const { left, right } = run(processor, [input[0]], 20);
    expect(peak(left)).toBeGreaterThan(0.01);
    expect(right).toEqual(left);
    expect(peak(run(create(), null, 20).left)).toBe(0);
  });

  it('applies the messages of the main thread: the knobs, the mix, the state, the order, the gains', () => {
    const input = noise(60 * 128, 0.2);
    const half = input.map((channel) => channel.subarray(30 * 128));
    const wire = run(create(), input, 60).left;
    const told = (messages: ChainMessage[]) => {
      const processor = create();
      run(processor, input, 30);
      messages.forEach((data) => processor.port.onmessage({ data }));
      return run(processor, half, 30, 30 * 128).left;
    };
    const tail = wire.subarray(30 * 128);
    const slot = slotOf('distortion');
    const on: ChainMessage[] = [{ order: [slot] }, { mix: [slot, 1] }, { active: [slot, true] }];
    const distorted = told(on);
    expect(distorted).not.toEqual(tail);
    expect(told([...on, { params: [slot, { drive: 12 }] }])).not.toEqual(distorted);
    expect(told([...on, { mix: [slot, 0.5] }])).not.toEqual(distorted);
    // (not in the order: a wire)
    expect(told([{ mix: [slot, 1] }, { active: [slot, true] }])).toEqual(tail);
    // (after the lookahead of the limiter: what it holds was at the gain before)
    expect(peak(told([{ masterGain: 0.5 }]).subarray(128))).toBeCloseTo(0.5 * peak(tail.subarray(128)), 2);
    expect(peak(told([{ mute: 0 }]).subarray(128))).toBe(0);
    expect(peak(told([{ mute: 0 }, { unmute: true }]))).toBeGreaterThan(0.01);
  });

  it('takes an event at its time, in seconds of the context', () => {
    const frames = 40 * 128;
    const input = [new Float32Array(frames).fill(0.25), new Float32Array(frames).fill(0.25)];
    const processor = create();
    processor.port.onmessage({ data: { at: (20 * 128) / RATE, masterGain: 0.5 } });
    const { left } = run(processor, input, 40);
    const latency = processor.chain?.latency ?? 0;
    expect(left[20 * 128 + latency - 1]).toBe(0.25);
    expect(left[20 * 128 + latency]).toBe(0.125);
  });

  it('takes what came after a mute with a time after it, with no block between them', () => {
    const input = noise(20 * 128, 0.2);
    const processor = create();
    run(processor, input, 20);
    // (a preset switch while the time of the context stands still: its mute, then its clear and its unmute)
    const messages: ChainMessage[] = [
      { mute: 0.02, at: (20 * 128) / RATE },
      { clear: true },
      { unmute: true },
    ];
    messages.forEach((data) => processor.port.onmessage({ data }));
    const { left } = run(processor, input, 20, 20 * 128);
    expect(peak(left.subarray(10 * 128))).toBeGreaterThan(0.01);
  });

  it('forgets the tails of the effects and the sound in the limiter on a clear', () => {
    const frames = 80 * 128;
    const input = noise(frames, 0.3);
    input.forEach((channel) => channel.fill(0, 10 * 128));
    const state = () => chainState(['delay'], 0.5, { delay: { params: { time: 0.03, fb: 0.8 } } });
    expect(peak(run(create(state()), input, 80).left.subarray(40 * 128))).toBeGreaterThan(1e-3);
    const processor = create(state());
    run(processor, input, 20);
    processor.port.onmessage({ data: { clear: true } });
    const rest = input.map((channel) => channel.subarray(20 * 128));
    expect(peak(run(processor, rest, 60, 20 * 128).left)).toBe(0);
  });

  it('moves the knobs by the routes of the last note, the note taken at its start', () => {
    const input = noise(60 * 128, 0.2);
    const state = chainState(['distortion']);
    const plain = run(create(state), input, 60).left;
    const held = { attack: 0, hold: 0, decay: 0, sustain: 1, release: 0 };
    const target = slotOf('distortion') * TARGET_KEYS + CHAIN_KEYS.distortion.indexOf('level');
    const processor = create(state);
    processor.port.onmessage({
      data: {
        routes: [{ target, source: 0, amount: -24, min: -24, max: 12 }],
        note: { envelopes: [held, held, held], start: (30 * 128) / RATE, release: null },
      },
    });
    const moved = run(processor, input, 60).left;
    expect(moved.subarray(0, 30 * 128)).toEqual(plain.subarray(0, 30 * 128));
    expect(peak(moved.subarray(50 * 128))).toBeLessThan(0.1 * peak(plain.subarray(50 * 128)));
    // an LFO of the state, a state that comes late for its time takes over now
    const swept = create(state);
    swept.port.onmessage({
      data: {
        lfos: {
          at: -1,
          instantly: false,
          lfos: [0, 1, 2, 3].map(() => ({
            mode: 1,
            delay: 0,
            rise: 0,
            smooth: 0,
            phase: 0,
            anchor: { time: 0, phase: 0, period: 0.05 },
          })),
        },
        routes: [{ target, source: LFO_SOURCE, amount: -12, min: -24, max: 12 }],
        note: null,
      },
    });
    const { left } = run(swept, input, 60);
    const blocks = Array.from({ length: 40 }, (_, block) =>
      peak(left.subarray((20 + block) * 128, (21 + block) * 128))
    );
    expect(Math.max(...blocks) / Math.min(...blocks)).toBeGreaterThan(2);
  });

  it('posts the meter of an effect about 30 times a second, only while it is watched', () => {
    const second = Math.round(RATE / 128);
    const input = noise(second * 128, 0.5);
    const processor = create(chainState(['compressor', 'chorus']));
    run(processor, input, second);
    expect(processor.posts).not.toHaveBeenCalled();
    const compressor = slotOf('compressor');
    processor.port.onmessage({ data: { meter: [compressor, true] } });
    run(processor, input, second, second * 128);
    const { calls } = processor.posts.mock;
    expect(calls.length).toBeGreaterThanOrEqual(28);
    expect(calls.length).toBeLessThanOrEqual(31);
    const [kind, values] = calls[0][0].meter as [number, { gains: number[]; input: number }];
    expect(kind).toBe(compressor);
    expect(values.gains).toHaveLength(3);
    expect(values.input).toBeGreaterThan(0.1);
    processor.posts.mockClear();
    // the chorus too: its LFO and its knobs, whether it has anything to play
    processor.port.onmessage({ data: { meter: [compressor, false] } });
    processor.port.onmessage({ data: { meter: [slotOf('chorus'), true] } });
    run(processor, input, second, 2 * second * 128);
    const chorus = processor.posts.mock.calls[5][0].meter as [number, Record<string, unknown>];
    expect(chorus[0]).toBe(slotOf('chorus'));
    expect(Object.keys(chorus[1])).toEqual(['phase', 'rate', 'd1', 'd2', 'depth', 'cut', 'idle']);
    expect(chorus[1]['idle']).toBe(false);
    // a node made while a screen watches starts with its meter on; at rest it is posted once
    const watched = create(chainState(['compressor'], 1, {}, { meters: [compressor] }));
    run(watched, null, second);
    expect(watched.posts).toHaveBeenCalledTimes(1);
  });

  it('plays on without an effect that trapped and tells which, the effect made again on a retry', () => {
    const input = noise(90 * 128, 0.2);
    const processor = create(chainState(['chorus', 'distortion']));
    run(processor, input, 20);
    processor.chain?.trap(slotOf('chorus'));
    const part = (from: number) => input.map((channel) => channel.subarray(from * 128));
    const failed = run(processor, part(20), 20, 20 * 128).left;
    expect(processor.posts.mock.calls).toEqual([[{ failed: [slotOf('chorus')] }]]);
    // the distortion alone from there on
    expect(peak(failed)).toBeGreaterThan(0.01);
    const alone = run(create(chainState(['distortion'])), input, 40).left.subarray(20 * 128);
    const difference = failed.subarray(10 * 128).map((value, i) => value - alone[10 * 128 + i]);
    expect(peak(difference)).toBeLessThan(1e-3);
    processor.chain?.trap(-1);
    processor.port.onmessage({ data: { retry: slotOf('chorus') } });
    const again = run(processor, part(40), 50, 40 * 128).left;
    const reference = run(create(chainState(['distortion'])), input, 90).left.subarray(40 * 128);
    expect(peak(again.subarray(30 * 128).map((value, i) => value - reference[30 * 128 + i]))).toBeGreaterThan(
      0.01
    );
    // (the retry told it was made)
    expect(processor.posts.mock.calls).toEqual([
      [{ failed: [slotOf('chorus')] }],
      [{ remade: slotOf('chorus') }],
    ]);
  });

  it('tells a retry that could not make its effect: failed again, made by the next one', () => {
    const input = noise(40 * 128, 0.2);
    const chorus = slotOf('chorus');
    const processor = create(chainState(['chorus']));
    run(processor, input, 10);
    processor.chain?.trap(chorus);
    run(processor, input, 10, 10 * 128);
    processor.chain?.trap(chorus, TRAP_IN.make);
    processor.port.onmessage({ data: { retry: chorus } });
    processor.chain?.trap(-1);
    processor.port.onmessage({ data: { retry: chorus } });
    expect(processor.posts.mock.calls).toEqual([
      [{ failed: [chorus] }],
      [{ failed: [chorus] }],
      [{ remade: chorus }],
    ]);
  });

  it('drops an effect that traps as a message sets its knob: the others play, the knobs after it are taken', () => {
    const input = noise(40 * 128, 0.2);
    const [chorus, distortion] = [slotOf('chorus'), slotOf('distortion')];
    const processor = create(chainState(['chorus', 'distortion']));
    run(processor, input, 10);
    processor.chain?.trap(chorus, TRAP_IN.set);
    processor.port.onmessage({ data: { params: [chorus, { rate: 2 }] } });
    processor.port.onmessage({ data: { params: [distortion, { level: -12 }] } });
    const part = input.map((channel) => channel.subarray(10 * 128));
    const out = run(processor, part, 30, 10 * 128).left;
    expect(processor.posts.mock.calls).toEqual([[{ failed: [chorus] }]]);
    expect(processor.chain).not.toBeNull();
    // the distortion alone, at its new level
    const alone = create(chainState(['distortion']));
    run(alone, input, 10);
    alone.port.onmessage({ data: { params: [distortion, { level: -12 }] } });
    const reference = run(alone, part, 30, 10 * 128).left;
    const difference = out.subarray(15 * 128).map((value, i) => value - reference[15 * 128 + i]);
    expect(peak(reference.subarray(15 * 128))).toBeGreaterThan(0.01);
    expect(peak(difference)).toBeLessThan(1e-3);
  });

  it('is silent once its limiter trapped and tells it, the sound back on a retry', () => {
    const input = noise(60 * 128, 0.2);
    const processor = create(chainState(['distortion']));
    expect(peak(run(processor, input, 20).left)).toBeGreaterThan(0.01);
    processor.chain?.trap(LIMITER_STAGE);
    const part = (from: number) => input.map((channel) => channel.subarray(from * 128));
    expect(peak(run(processor, part(20), 20, 20 * 128).left)).toBe(0);
    expect(processor.posts.mock.calls).toEqual([[{ failed: [LIMITER_STAGE] }]]);
    processor.chain?.trap(-1);
    processor.port.onmessage({ data: { retry: LIMITER_STAGE } });
    expect(peak(run(processor, part(40), 20, 40 * 128).left)).toBeGreaterThan(0.01);
    expect(FX_KINDS).toHaveLength(LIMITER_STAGE);
  });

  it('a trap that is in no stage: silence, the main thread is told the core is over, the node ends', () => {
    const input = noise(20 * 128, 0.2);
    const processor = create(chainState(['distortion']));
    run(processor, input, 10);
    processor.chain?.trap(LIMITER_STAGE + 1);
    const out = [[new Float32Array(128).fill(1), new Float32Array(128).fill(1)]];
    expect(processor.process([input.map((channel) => channel.subarray(0, 128))], out)).toBe(false);
    expect(peak(out[0][0])).toBe(0);
    expect(peak(out[0][1])).toBe(0);
    expect(processor.posts.mock.calls).toEqual([[{ broken: true }]]);
    expect(processor.chain).toBeNull();
    // (told once: no block after it, a message is ignored)
    expect(processor.process([[]], out)).toBe(false);
    processor.port.onmessage({ data: { masterGain: 2 } });
    expect(processor.posts).toHaveBeenCalledTimes(1);
  });

  it('posts no meter of an effect that trapped, its meter again once it is made again', () => {
    const second = Math.round(RATE / 128);
    const input = noise(second * 128, 0.5);
    const chorus = slotOf('chorus');
    const processor = create(chainState(['chorus'], 1, {}, { meters: [chorus] }));
    run(processor, input, 20);
    processor.chain?.trap(chorus);
    processor.posts.mockClear();
    run(processor, input, second, 20 * 128);
    expect(processor.posts.mock.calls).toEqual([[{ failed: [chorus] }]]);
    processor.chain?.trap(-1);
    processor.port.onmessage({ data: { retry: chorus } });
    processor.posts.mockClear();
    run(processor, input, second, (20 + second) * 128);
    const { calls } = processor.posts.mock;
    expect(calls.length).toBeGreaterThanOrEqual(28);
    const [slot, values] = calls[0][0].meter as [number, Record<string, unknown>];
    expect(slot).toBe(chorus);
    expect(typeof values['phase']).toBe('number');
    expect(typeof values['d1']).toBe('number');
  });

  it('ends when it is stopped: its core freed, no block rendered', () => {
    const processor = create();
    processor.port.onmessage({ data: { stop: true } });
    const out = [[new Float32Array(128), new Float32Array(128)]];
    expect(processor.process([[]], out)).toBe(false);
    // (a message after it is ignored)
    processor.port.onmessage({ data: { masterGain: 2 } });
    expect(processor.chain).toBeNull();
  });
});
