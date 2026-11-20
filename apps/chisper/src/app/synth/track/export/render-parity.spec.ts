import { CLIP_PPQ, ClipNote } from '@chisper/preset-schema';
import { inProcessBuilder } from '../../../../test-utils/in-process-builder';
import { createSynth, createTrack, initModel, stopModels } from '../../../../test-utils/models';
import { createOfflineEngine } from '../../../../test-utils/offline-engine';
import { firstMismatch } from '../../../../test-utils/parity';
import { seeded } from '../../../../test-utils/voice-dsp';
import { wasmCore } from '../../../../test-utils/wasm';
import type { EngineExports } from '../../common/engine/engine-wasm';
import { fx } from '../../fx/modules/fx';
import { renderClip, RENDER_BLOCK, SETTLE } from './render-clip';
import { pageSound } from './page-sound';

// The render of a clip against the synth of the page playing it on its track (the live models, the node of the
// core offline, a tick of the track every block): the same events, the same samples for a seed. The page settles
// as the render does (its throttles in its own time, the same blocks of silence) and plays the track from the same
// time; the render's file starts at the first frame of the clip, after the latency of the limiter

const SAW = Array.from({ length: 2048 }, (_, i) => i / 1024 - 1);
const SINE = Array.from({ length: 2048 }, (_, i) => Math.sin((2 * Math.PI * i) / 2048));
const SEED = 9;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  stopModels();
  sessionStorage.clear();
});

type Page = ReturnType<typeof createSynth> & { fx: ReturnType<typeof createFxModel> };
const createFxModel = (modules: ReturnType<typeof createSynth>) =>
  initModel(
    fx({
      synthCore: modules.synthCore,
      transport: modules.transport,
      synth: modules.synth,
      lfo: modules.lfos,
      modulation: modules.modulation,
    }),
    'fx',
    undefined
  );

const parity = async (notes: ClipNote[], setUp: (page: Page) => void) => {
  const engine = createOfflineEngine(seeded(SEED));
  const modules = createSynth();
  const page: Page = { ...modules, fx: createFxModel(modules) };
  await wait(0);
  const [{ audioCtx, wavetables }] = page.synthCore;
  engine.attach(audioCtx, wavetables);
  page.osc1[1].setWaveTable([SAW]);
  page.osc2[1].setWaveTable([SINE]);
  page.envelopes[1].setEnvelopeValue('env1', 'attack', 0.002);
  page.envelopes[1].setEnvelopeValue('env1', 'release', 0.1);
  setUp(page);
  // (the throttles of the page: in its time)
  await wait(150);
  engine.flushWorker();
  const { track, clock } = createTrack(page);
  track[1].setNotes(notes);
  const { length } = track[0].$clip.value;
  const sound = pageSound(
    [page.osc1[0], page.osc2[0]],
    page.noise[0],
    page.transport[0].$bpm.value,
    page.synthCore[0].$masterGain.value
  );

  // the render
  const left: number[] = [];
  const { frames } = await renderClip({
    exports: wasmCore<EngineExports>('engine'),
    sound,
    clip: { notes, length },
    sampleRate: audioCtx.sampleRate,
    seed: SEED,
    wavetables: inProcessBuilder({ auto: true }).dependencies,
    pause: () => Promise.resolve(),
    write: (outL) => left.push(...outL),
  });

  // the page: the blocks of silence of the render's settling, then the track from there
  const settle = Math.ceil((SETTLE * audioCtx.sampleRate) / RENDER_BLOCK);
  engine.renderStereo(settle);
  track[1].play();
  const rate = audioCtx.sampleRate;
  const start = Math.ceil(((settle * RENDER_BLOCK) / rate) * rate + 0.05 * rate - 1e-6) + engine.latency();
  const blocks = Math.ceil((start + frames) / RENDER_BLOCK) - settle + 1;
  const [live] = engine.renderStereo(blocks, () => clock.tick());
  const played = live.subarray(start - settle * RENDER_BLOCK, start - settle * RENDER_BLOCK + frames);
  return { rendered: Float32Array.from(left).subarray(0, frames), played, frames };
};

const peak = (samples: Float32Array) => samples.reduce((most, x) => Math.max(most, Math.abs(x)), 0);

describe('a render of the clip against the page playing it', () => {
  it('poly with stealing, legato and a glide: the same samples', async () => {
    const notes: ClipNote[] = [
      [0, CLIP_PPQ, 60, 100],
      [CLIP_PPQ / 2, CLIP_PPQ, 64, 90],
      [CLIP_PPQ, CLIP_PPQ, 67, 80],
      [2 * CLIP_PPQ, CLIP_PPQ / 2, 72, 110],
      [2 * CLIP_PPQ + CLIP_PPQ / 4, CLIP_PPQ, 55, 70],
    ];
    const { rendered, played } = await parity(notes, (page) => {
      page.synth[1].setMaxVoices(2);
      page.synth[1].setLegato(true);
      page.synth[1].setPortamento(60);
      page.osc2[1].toggleActive();
    });
    expect(peak(rendered)).toBeGreaterThan(0.05);
    expect(firstMismatch(rendered, played)).toBe(-1);
  });

  it('mono: the same samples', async () => {
    const notes: ClipNote[] = [
      [0, CLIP_PPQ, 48, 100],
      [CLIP_PPQ / 2, CLIP_PPQ, 55, 100],
      [CLIP_PPQ, CLIP_PPQ / 4, 60, 100],
      [3 * CLIP_PPQ, CLIP_PPQ / 2, 52, 100],
    ];
    const { rendered, played } = await parity(notes, (page) => {
      page.synth[1].setMaxVoices(1);
      page.synth[1].setPortamento(40);
    });
    expect(peak(rendered)).toBeGreaterThan(0.05);
    expect(firstMismatch(rendered, played)).toBe(-1);
  });

  it('the Master over 0 dB, driving the limiter: the same samples', async () => {
    const notes: ClipNote[] = [
      [0, CLIP_PPQ, 48, 127],
      [0, CLIP_PPQ, 55, 127],
      [CLIP_PPQ, CLIP_PPQ, 60, 127],
    ];
    const { rendered, played } = await parity(notes, (page) => {
      page.osc2[1].toggleActive();
      page.synthCore[1].setMasterGain(4);
    });
    expect(peak(rendered)).toBeGreaterThan(0.85);
    expect(firstMismatch(rendered, played)).toBe(-1);
  });

  it('an effect following the notes and an LFO in BPM: the same samples', async () => {
    const notes: ClipNote[] = [
      [0, CLIP_PPQ / 2, 60, 100],
      [CLIP_PPQ, CLIP_PPQ / 2, 63, 60],
      [2 * CLIP_PPQ, CLIP_PPQ, 67, 127],
    ];
    const { rendered, played } = await parity(notes, (page) => {
      page.fx[1].setAdded('reverb', true);
      page.fx[1].setOn('reverb', true);
      page.modulation[1].setAmount('env2', 'reverb.size', 0.5);
      page.lfos[1].setBpm('lfo1', true);
      page.modulation[1].setAmount('lfo1', 'filter.cutoff', 0.4);
      page.filter[1].toggleActive();
    });
    expect(peak(rendered)).toBeGreaterThan(0.05);
    expect(firstMismatch(rendered, played)).toBe(-1);
  });
});
