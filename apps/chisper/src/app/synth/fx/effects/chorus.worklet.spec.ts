import { installWorkletScope } from '../../../../test-utils/worklet-scope';
import { CHORUS_PROCESSOR } from '../../common/processors';
import { ChorusDspParams } from './chorus-params';

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

  it('ends once stopped', () => {
    const processor = create({ params: PARAMS });
    processor.port.onmessage({ data: { stop: true } });
    expect(processor.process([[]], [[new Float32Array(128), new Float32Array(128)]])).toBe(false);
  });
});
