import { installWorkletScope } from '../../../../test-utils/worklet-scope';
import { CHORUS_PROCESSOR } from '../../common/processors';
import { ChorusDspParams, ChorusMeterMessage } from './chorus-params';

const processors = installWorkletScope(48000);

// both taps of a channel 10 ms after the click, no LFO, the filter open, the wet signal alone
const PARAMS: ChorusDspParams = {
  rate: 0,
  d1: 10,
  d2: 10,
  depth: 0,
  fb: 0.5,
  cut: 20000,
  hpf: 0,
  level: 0.5,
  mix: 1,
};
type Processor = {
  process: (i: Float32Array[][], o: Float32Array[][]) => boolean;
  port: { onmessage: (event: { data: unknown }) => void };
};
// the left output of `blocks` blocks from a click, after 8 blocks of silence (a param that glides is there)
const rendered = (processor: Processor, blocks = 16) => {
  const out = new Float32Array(blocks * 128);
  for (let i = -8; i < blocks; i++) {
    const outs = [[new Float32Array(128), new Float32Array(128)]];
    processor.process([[Float32Array.from({ length: 128 }, (_, n) => (i === 0 && n === 32 ? 1 : 0))]], outs);
    if (i >= 0) out.set(outs[0][0], i * 128);
  }
  return out;
};
// the loudest sample `ms` after the click (half a ms around it)
const levelAt = (out: Float32Array, ms: number) => {
  const at = 32 + Math.round(ms * 48);
  return out.subarray(at - 24, at + 24).reduce((max, value) => Math.max(max, Math.abs(value)), 0);
};
// a repeat against the click before it (its interpolation takes some highs off a click of one sample)
const repeated = (out: Float32Array) => levelAt(out, 20.24) / levelAt(out, 10.12);
const create = (processorOptions: object): Processor =>
  new processors[CHORUS_PROCESSOR]({ processorOptions });

describe('chorus wasm worklet', () => {
  beforeAll(() => import('./chorus.worklet'));

  it('registers the chorus processor with the Rust core, started with the node options', () => {
    expect(processors[CHORUS_PROCESSOR]).toBeDefined();
    const out = rendered(create({ params: PARAMS }));
    // the click 10 ms later (the dry one gone), its repeat at half of it
    expect(levelAt(out, 0)).toBeLessThan(0.01);
    expect(levelAt(out, 10.12)).toBeGreaterThan(0.5);
    expect(repeated(out)).toBeGreaterThan(0.38);
    expect(repeated(out)).toBeLessThan(0.52);
  });

  it('applies the posted params, the mix among them, and the knobs the routes move', () => {
    const processor = create({ params: PARAMS });
    processor.port.onmessage({ data: { params: { mix: 0, d1: 5 } } });
    const dry = rendered(processor);
    expect(levelAt(dry, 0)).toBeCloseTo(1, 1);
    expect(levelAt(dry, 10.12)).toBeLessThan(0.01);
    const routed = create({ params: PARAMS });
    routed.port.onmessage({
      data: {
        mod: {
          note: {
            start: 0,
            release: null,
            envelopes: [0, 1, 2].map(() => ({ attack: 0, hold: 0, decay: 0, sustain: 1, release: 0 })),
          },
          routes: [{ source: 1, param: 'level', amount: -0.5, min: 0, max: 1 }],
        },
      },
    });
    expect(levelAt(rendered(routed), 10.12)).toBeLessThan(0.01);
  });

  it('not active it has no feedback: its taps drain, the feedback of its knob is back with it', () => {
    const processor = create({ params: PARAMS });
    processor.port.onmessage({ data: { active: false } });
    const drained = rendered(processor);
    expect(levelAt(drained, 10.12)).toBeGreaterThan(0.5);
    expect(levelAt(drained, 20.24)).toBeLessThan(0.01);
    // a feedback set meanwhile (a knob, a route) waits
    processor.port.onmessage({ data: { params: { fb: 0.25 } } });
    expect(levelAt(rendered(processor), 20.24)).toBeLessThan(0.01);
    processor.port.onmessage({ data: { active: true } });
    const back = rendered(processor);
    expect(repeated(back)).toBeGreaterThan(0.19);
    expect(repeated(back)).toBeLessThan(0.26);
    // a node made while it is not active starts so
    const started = rendered(create({ params: PARAMS, inactive: true }));
    expect(levelAt(started, 20.24)).toBeLessThan(0.01);
  });

  describe('its meter', () => {
    // the LFO at 2 Hz: a block of 128 at 48 kHz is this much of a cycle
    const METERED = { ...PARAMS, rate: 2, d1: 7, d2: 3, depth: 13 };
    const BLOCK = (2 * 128) / 48000;
    // what it posted, copied as a port copies it (the processor posts the same message every time), and as given
    const metered = (processorOptions: object) => {
      const processor = create(processorOptions);
      const posts = jest.fn();
      const given: unknown[] = [];
      (processor.port as unknown as { postMessage: (message: unknown) => void }).postMessage = (message) => {
        given.push(message);
        posts(JSON.parse(JSON.stringify(message)));
      };
      const run = (blocks: number, level: number) => {
        for (let i = 0; i < blocks; i++) {
          const input = Float32Array.from({ length: 128 }, (_, n) => level * Math.sin((i * 128 + n) / 9));
          processor.process([[input]], [[new Float32Array(128), new Float32Array(128)]]);
        }
      };
      const meters = () => posts.mock.calls.map(([message]) => (message as ChorusMeterMessage).meter);
      return {
        processor,
        posts,
        given,
        meters,
        sound: (blocks: number) => run(blocks, 0.5),
        quiet: (blocks: number) => run(blocks, 0),
      };
    };

    it('posts the LFO of the core and the knobs of its taps about 30 times a second, only while asked', () => {
      const { processor, posts, meters, sound } = metered({ params: METERED });
      sound(40);
      expect(posts).not.toHaveBeenCalled();
      processor.port.onmessage({ data: { meter: true } });
      // a second of blocks
      sound(375);
      expect(posts.mock.calls.length).toBeGreaterThanOrEqual(27);
      expect(posts.mock.calls.length).toBeLessThanOrEqual(30);
      expect(meters().at(-1)).toMatchObject({ rate: 2, d1: 7, d2: 3, depth: 13, cut: 20000, idle: false });
      // the LFO as it is then: 13 blocks on from a message to the next (the 40 before it among them)
      meters().forEach(({ phase }, i) => {
        const cycles = (40 + 13 * (i + 1)) * BLOCK;
        expect(phase).toBeCloseTo(cycles - Math.floor(cycles), 9);
      });
      // the knobs as the core has them now
      processor.port.onmessage({ data: { params: { d1: 9, rate: 0.5 } } });
      sound(13);
      expect(meters().at(-1)).toMatchObject({ rate: 0.5, d1: 9 });
      processor.port.onmessage({ data: { meter: false } });
      posts.mockClear();
      sound(40);
      expect(posts).not.toHaveBeenCalled();
    });

    it('at rest it is posted once (its LFO goes on), then again from the next sound or for a new watcher', () => {
      const { processor, posts, meters, sound, quiet } = metered({ params: METERED, meter: true });
      // (never woken: idle from the start)
      quiet(375);
      expect(posts).toHaveBeenCalledTimes(1);
      expect(meters()[0]).toMatchObject({ rate: 2, idle: true });
      expect(meters()[0].phase).toBeCloseTo(13 * BLOCK, 9);
      processor.port.onmessage({ data: { meter: true } });
      quiet(40);
      expect(posts).toHaveBeenCalledTimes(2);
      expect(meters()[1].idle).toBe(true);
      sound(40);
      expect(posts.mock.calls.length).toBeGreaterThan(2);
      expect(meters().at(-1)?.idle).toBe(false);
    });

    it('makes nothing for it on the audio thread: the same message every time, its values those of then', () => {
      const { given, meters, sound } = metered({ params: METERED, meter: true });
      sound(375);
      expect(given.length).toBeGreaterThan(20);
      expect(new Set(given).size).toBe(1);
      expect(new Set(given.map((message) => (message as ChorusMeterMessage).meter)).size).toBe(1);
      expect(new Set(meters().map(({ phase }) => phase)).size).toBeGreaterThan(20);
    });

    it('the knobs the routes move are told as moved', () => {
      const { processor, meters, sound } = metered({ params: METERED, meter: true });
      processor.port.onmessage({
        data: {
          mod: {
            note: {
              start: 0,
              release: null,
              envelopes: [0, 1, 2].map(() => ({ attack: 0, hold: 0, decay: 0, sustain: 1, release: 0 })),
            },
            routes: [{ source: 1, param: 'depth', amount: 0.5, min: 0, max: 26 }],
          },
        },
      });
      sound(40);
      expect(meters().at(-1)?.depth).toBeGreaterThan(13);
    });
  });

  it('ends once stopped', () => {
    const processor = create({ params: PARAMS });
    processor.port.onmessage({ data: { stop: true } });
    expect(processor.process([[]], [[new Float32Array(128), new Float32Array(128)]])).toBe(false);
  });
});
