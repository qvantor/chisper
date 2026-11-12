import { installWorkletScope } from '../../../../test-utils/worklet-scope';
import { COMPRESSOR_DEFAULTS } from '../../../../test-utils/compressor-render';
import { COMPRESSOR_PROCESSOR } from '../../common/processors';
import type { CompressorDspParams, CompressorMeterMessage } from './compressor-params';

const RATE = 48000;
const processors = installWorkletScope(RATE);

// deep and fast: a loud sine is far under its level
const PARAMS: CompressorDspParams = {
  ...COMPRESSOR_DEFAULTS,
  thresh: 0.8,
  ratio: 20,
  attack: 1,
  release: 50,
};

const block = (value: (i: number) => number) => Float32Array.from({ length: 128 }, (_, i) => value(i));
const loudest = (data: Float32Array) => data.reduce((max, value) => Math.max(max, Math.abs(value)), 0);

interface Processor {
  port: { onmessage: (event: { data: unknown }) => void; postMessage: (message: unknown) => void };
  process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
  // what it posted, copied as a port copies it (the processor posts the same message every time), and as given
  posts: jest.Mock;
  given: unknown[];
}
const create = (processorOptions: object): Processor => {
  const processor = new processors[COMPRESSOR_PROCESSOR]({ processorOptions }) as unknown as Processor;
  processor.posts = jest.fn();
  processor.given = [];
  processor.port.postMessage = (message) => {
    processor.given.push(message);
    processor.posts(JSON.parse(JSON.stringify(message)));
  };
  return processor;
};

// `blocks` blocks of a sine of 0.5: the peak of the output over the second half of them
const peakOf = (processor: Processor, blocks = 40) => {
  let peak = 0;
  for (let i = 0; i < blocks; i++) {
    const out = [[new Float32Array(128), new Float32Array(128)]];
    processor.process([[block((n) => 0.5 * Math.sin((i * 128 + n) / 9))]], out);
    if (i >= blocks / 2) peak = Math.max(peak, loudest(out[0][0]));
  }
  return peak;
};

describe('compressor wasm worklet', () => {
  beforeAll(() => import('./compressor.worklet'));

  it('registers the compressor processor with the Rust core, started with the node options', () => {
    expect(processors[COMPRESSOR_PROCESSOR]).toBeDefined();
    expect(peakOf(create({ params: PARAMS }))).toBeLessThan(0.1);
    // a threshold of 0 dB: nothing is compressed
    expect(peakOf(create({ params: { ...PARAMS, thresh: 0 } }))).toBeCloseTo(0.5, 2);
  });

  it('applies the posted params, the mix among them, and the knobs the envelopes move', () => {
    const processor = create({ params: PARAMS });
    processor.port.onmessage({ data: { params: { thresh: 0 } } });
    expect(peakOf(processor)).toBeCloseTo(0.5, 2);
    const dry = create({ params: PARAMS });
    dry.port.onmessage({ data: { params: { mix: 0 } } });
    expect(peakOf(dry)).toBeCloseTo(0.5, 2);
    const routed = create({ params: { ...PARAMS, thresh: 0 } });
    routed.port.onmessage({
      data: {
        mod: {
          note: {
            start: 0,
            release: null,
            envelopes: [0, 1, 2].map(() => ({ attack: 0, hold: 0, decay: 0, sustain: 1, release: 0 })),
          },
          routes: [{ source: 1, param: 'thresh', amount: 0.8, min: 0, max: 1 }],
        },
      },
    });
    expect(peakOf(routed, 60)).toBeLessThan(0.1);
  });

  it('posts its meter about 30 times a second, only while it is asked for', () => {
    const processor = create({ params: PARAMS });
    peakOf(processor);
    expect(processor.posts).not.toHaveBeenCalled();
    processor.port.onmessage({ data: { meter: true } });
    // a second of blocks
    peakOf(processor, RATE / 128);
    const { calls } = processor.posts.mock;
    expect(calls.length).toBeGreaterThanOrEqual(27);
    expect(calls.length).toBeLessThanOrEqual(30);
    const [{ meter }] = calls.at(-1) as [CompressorMeterMessage];
    expect(meter.input).toBeCloseTo(0.5, 2);
    expect(meter.gains[0]).toBeLessThan(-10);
    expect(meter.gains).toEqual([meter.gains[0], meter.gains[0], meter.gains[0]]);
    processor.port.onmessage({ data: { meter: false } });
    processor.posts.mockClear();
    peakOf(processor);
    expect(processor.posts).not.toHaveBeenCalled();
  });

  it('at rest the meter is posted once, then again from the next sound or for a new watcher', () => {
    const processor = create({ params: PARAMS, meter: true });
    const quiet = (blocks: number) => {
      for (let i = 0; i < blocks; i++)
        processor.process([[new Float32Array(128)]], [[new Float32Array(128), new Float32Array(128)]]);
    };
    // (never woken: idle from the start)
    quiet(RATE / 128);
    const { calls } = processor.posts.mock;
    expect(calls).toEqual([[{ meter: { gains: [0, 0, 0], input: 0 } }]]);
    processor.port.onmessage({ data: { meter: true } });
    quiet(40);
    expect(calls).toHaveLength(2);
    peakOf(processor, 40);
    expect(calls.length).toBeGreaterThan(2);
    expect((calls.at(-1) as [CompressorMeterMessage])[0].meter.input).toBeCloseTo(0.5, 2);
  });

  it('makes nothing for its meter on the audio thread: the same message every time, its values those of then', () => {
    const processor = create({ params: PARAMS, meter: true });
    peakOf(processor, RATE / 128);
    const { given } = processor;
    expect(given.length).toBeGreaterThan(20);
    expect(new Set(given).size).toBe(1);
    expect(new Set(given.map((message) => (message as CompressorMeterMessage).meter)).size).toBe(1);
    // the reduction grows over the attack: the copies differ
    const gains = processor.posts.mock.calls.map(([{ meter }]) => meter.gains[0]);
    expect(new Set(gains).size).toBeGreaterThan(1);
  });

  it('a node made while its meter is watched posts it from the start', () => {
    const processor = create({ params: PARAMS, meter: true });
    peakOf(processor, 20);
    expect(processor.posts).toHaveBeenCalled();
  });

  it('ends once stopped', () => {
    const processor = create({ params: PARAMS, meter: true });
    processor.port.onmessage({ data: { stop: true } });
    expect(processor.process([[]], [[new Float32Array(128), new Float32Array(128)]])).toBe(false);
    expect(processor.posts).not.toHaveBeenCalled();
  });
});
