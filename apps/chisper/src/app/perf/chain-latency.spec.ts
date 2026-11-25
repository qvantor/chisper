import { chainCore, chainState, makeChain, renderChain } from '../../test-utils/chain-render';
import { mixGains } from '../../test-utils/chorus-render';
import { oscScope } from '../../test-utils/voice-dsp';
import type { FxKind } from '../synth/common/chain/chain-params';
import { createLimiterWasm } from '../synth/common/limiter/limiter-wasm';
import { buildLevels } from '../synth/common/wavetable/wavetable-mipmap';
import {
  createTableStoreWasm,
  createVoiceSharedWasm,
  createVoiceWasm,
} from '../synth/common/wavetable/wavetable-osc-wasm';
import type { EnvelopeParams } from '../synth/common/envelope/envelope-curve';
import { VoiceParam } from '../synth/common/wavetable/wavetable-osc-params';
import { DISTORTION_LATENCY, TONE_OPEN } from '../synth/fx/effects/distortion-params';
import { createOnsetDetector, PROBE_DEFAULTS } from './probe-dsp';

// the latency the synth adds to a note, worked out offline (it replaces the chain latency the browser suite
// measured with its probe): the voice starts at the frame of the note on, the filter is inside it, the chain
// (one core: the effects in their slots, the master gain, the limiter) delays the dry path of a slot only by the
// latency of its effect (the distortion: DISTORTION_LATENCY, its wet and its dry signal alike; the delay and the
// reverb: none) and all of it by the limiter (its lookahead and the delay of its true peak detector). What the
// browser and the device add (the render lag, the output) is measured by the browser suite (scripts/bench-perf,
// L1 and L3)

const BLOCK = 128;
const RATES = [44100, 48000, 96000];
// the latency of the oversampler of the distortion: half of it is its interpolation, half its decimation
const OVERSAMPLER_LATENCY = DISTORTION_LATENCY;

// a mild drive: the curve is about linear for a signal of 0.25
const DISTORTION = { mode: 0, drive: 0, tone: TONE_OPEN, level: 0 };

// renders `input` (frame → sample, both channels) through a chain of the distortion alone and its limiter in
// render quanta; the input and the output
const renderLimited = (rate: number, frames: number, input: (frame: number) => number) => {
  const chain = makeChain(chainState(['distortion'], 1, { distortion: { params: DISTORTION } }), rate, true);
  const latency = chain.latency;
  const dry = Float32Array.from({ length: frames }, (_, frame) => input(frame));
  const { left: out } = renderChain(chain, [dry, dry]);
  return { dry, out, limiter: latency, chain: latency + DISTORTION_LATENCY };
};

// an impulse at `at` through a chain of `kind` alone at `mix`, without its limiter
const impulse = (kind: FxKind, mix: number, rate: number, at = 300, frames = 2048) => {
  const dry = new Float32Array(frames);
  dry[at] = 0.25;
  return renderChain(makeChain(chainState([kind], mix), rate), [dry, dry]).left;
};

const loudest = (data: Float32Array) =>
  data.reduce((best, value, i) => (Math.abs(value) > Math.abs(data[best]) ? i : best), 0);

// the onsets the probe of the perf build hears in a signal (frames)
const onsets = (data: Float32Array) => {
  const detect = createOnsetDetector(PROBE_DEFAULTS);
  const found: number[] = [];
  for (let start = 0; start < data.length; start += BLOCK) {
    const onset = detect([data.subarray(start, start + BLOCK)], Math.min(BLOCK, data.length - start));
    if (onset >= 0) found.push(start + onset);
  }
  return found;
};

const SINE = Array.from({ length: 2048 }, (_, n) => Math.sin((2 * Math.PI * n) / 2048));
const PARAMS = Object.fromEntries(
  Object.entries({
    frequency: 440,
    gate: 1,
    position1: 0,
    position2: 0,
    detune1: 0,
    detune2: 0,
    spread1: 0,
    spread2: 0,
    gain1: 0.25,
    gain2: 0,
    blend1: 0.5,
    blend2: 0.5,
  }).map(([name, value]) => [name, Float32Array.of(value)])
) as Record<VoiceParam, Float32Array>;

// ENV 1 at full level from the start: the voice as the oscillator plays it
const FLAT: EnvelopeParams = { attack: 0, hold: 0, decay: 0, sustain: 1, release: 0 };

// a note at `start` (seconds): its voice at phase rand 0 from a quarter of the sine (its peak), left channel
const renderVoice = (rate: number, frames: number, start: number) => {
  const scope = oscScope();
  const store = createTableStoreWasm(scope);
  store.set('a', 1, buildLevels([SINE]));
  const voice = createVoiceWasm(
    scope,
    rate,
    {
      osc: [{ table: 'a', unison: 1, phase: 0.25, phaseRand: 0 }, null],
      start,
      envelopes: [FLAT, FLAT, FLAT],
      envStart: start,
      phrase: 0,
      routes: [],
      filter: null,
    },
    store,
    () => 0,
    createVoiceSharedWasm(scope)
  );
  const out = new Float32Array(frames);
  const right = new Float32Array(BLOCK);
  for (let frame = 0; frame < frames; frame += BLOCK)
    voice.process(frame, PARAMS, out.subarray(frame, frame + BLOCK), right);
  return { out, voice };
};

describe('the latency of the chain', () => {
  it.each([
    [44100, 104, 136],
    [48000, 112, 144],
    [96000, 208, 240],
  ])(
    'at %i Hz: an impulse comes out of the distortion and the limiter %i + 32 = %i frames later',
    (rate, limiter, chain) => {
      expect(createLimiterWasm(chainCore(), rate).latency).toBe(limiter);
      const at = 300;
      const rendered = renderLimited(rate, 2048, (frame) => (frame === at ? 0.25 : 0));
      // the limiter of the chain is that unit: its lookahead is all an empty chain adds
      expect(rendered.limiter).toBe(limiter);
      expect(rendered.chain).toBe(chain);
      expect(loudest(rendered.out) - at).toBe(chain);
    }
  );

  it.each([
    [44100, 104],
    [48000, 112],
    [96000, 208],
  ])('at %i Hz a chain without a slot is late by its limiter alone: %i frames', (rate, limiter) => {
    const at = 300;
    const dry = new Float32Array(2048);
    dry[at] = 0.25;
    const chain = makeChain(chainState([]), rate, true);
    expect(chain.latency).toBe(limiter);
    expect(loudest(renderChain(chain, [dry, dry]).left) - at).toBe(limiter);
    // without its limiter: a wire
    expect(makeChain(chainState([]), rate).latency).toBe(0);
  });

  it.each(RATES)(
    'at %i Hz the dry signal of the distortion slot is delayed by the same 32 frames',
    (rate) => {
      const at = 300;
      // all dry: the input, late by the latency of the distortion
      const out = impulse('distortion', 0, rate, at);
      expect(loudest(out) - at).toBe(DISTORTION_LATENCY);
      expect(out[at + DISTORTION_LATENCY]).toBe(0.25);
      expect(out[at]).toBe(0);
      // all wet: its peak at the same frame, the mix doesn't comb filter
      expect(loudest(impulse('distortion', 1, rate, at)) - at).toBe(DISTORTION_LATENCY);
    }
  );

  it.each(RATES)('at %i Hz the delay and the reverb add none to the dry path', (rate) => {
    const at = 300;
    (['delay', 'reverb'] as const).forEach((kind) => {
      // all dry: the input as it is
      const dry = impulse(kind, 0, rate, at);
      expect(loudest(dry)).toBe(at);
      expect(dry[at]).toBe(0.25);
      // mixed (equal power; the echoes by the law of the chorus: the dry gain 1 - sin⁴): the dry signal still
      // at its frame, the echoes and the tail after it
      const mixed = impulse(kind, 0.5, rate, at);
      expect(mixed[at]).toBeCloseTo(0.25 * (kind === 'delay' ? mixGains(0.5)[0] : Math.cos(Math.PI / 4)), 6);
      expect(mixed.subarray(0, at).every((value) => value === 0)).toBe(true);
    });
  });

  it.each(RATES)(
    'at %i Hz the probe hears a note through the chain at most 16 frames before its latency',
    (rate) => {
      const frames = 4096;
      const { out: voice } = renderVoice(rate, frames, 1000 / rate);
      const { out, chain } = renderLimited(rate, frames, (frame) => voice[frame]);
      const [heard] = onsets(voice);
      const [through] = onsets(out);
      expect(heard).toBe(1000);
      // the interpolator of the oversampler rings ahead of its peak (linear phase): the onset crosses the
      // threshold of the probe up to half its taps at the input rate early
      expect(through - heard).toBeLessThanOrEqual(chain);
      expect(through - heard).toBeGreaterThanOrEqual(chain - OVERSAMPLER_LATENCY / 2);
    }
  );

  it.each([
    [44100, 3.084],
    [48000, 3],
    [96000, 2.5],
  ])('at %i Hz a note leaves the limiter %f ms after the frame of its note on, within 3.1 ms', (rate, ms) => {
    // the note on schedules the voice at the context time (synth.ts): it starts at that frame
    const start = 777 / rate;
    const { voice } = renderVoice(rate, 2048, start);
    expect(voice.startedAt).toBe(voice.startFrame);
    expect(voice.startFrame).toBe(777);
    const { chain } = renderLimited(rate, BLOCK, () => 0);
    const latency = ((voice.startedAt - voice.startFrame + chain) / rate) * 1000;
    expect(latency).toBeCloseTo(ms, 3);
    expect(latency).toBeLessThanOrEqual(3.1);
  });
});
