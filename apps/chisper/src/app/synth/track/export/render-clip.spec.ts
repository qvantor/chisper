import { CLIP_BAR, CLIP_PPQ, ClipNote } from '@chisper/preset-schema';
import { getSnapshot } from '../../../app';
import { inProcessBuilder } from '../../../../test-utils/in-process-builder';
import { dB } from '../../../../test-utils/measures';
import { createSynth, stopModels } from '../../../../test-utils/models';
import { voicesNodes } from '../../../../test-utils/voice-events';
import { wasmCore } from '../../../../test-utils/wasm';
import { LIMITER_STAGE } from '../../common/chain/chain-params';
import type { EngineExports } from '../../common/engine/engine-wasm';
import { CEILING } from '../../common/limiter/limiter-params';
import { MAX_TAIL, renderClip, RenderClipOptions, SEAM, SILENCE, TAIL_FADE } from './render-clip';
import { pageSound } from './page-sound';
import { truePeak } from './true-peak';

const RATE = 44100;
const SAW = Array.from({ length: 2048 }, (_, i) => i / 1024 - 1);
const SINE = Array.from({ length: 2048 }, (_, i) => Math.sin((2 * Math.PI * i) / 2048));
// (the page: the specs of the models, their models stopped after each)
const flush = () => new Promise((resolve) => setTimeout(resolve));

afterEach(() => {
  stopModels();
  jest.restoreAllMocks();
});

type Synth = ReturnType<typeof createSynth>;

// the synth of the page: a saw in OSC 1, its phase at 0, a sharp attack and a short release
const pageSynth = async () => {
  const modules = createSynth();
  await flush();
  const [, osc] = modules.osc1;
  osc.setWaveTable([SAW]);
  osc.setOscValue('phase', 0);
  osc.setOscValue('phaseRand', 0);
  modules.envelopes[1].setEnvelopeValue('env1', 'attack', 0);
  modules.envelopes[1].setEnvelopeValue('env1', 'release', 0.05);
  return modules;
};

// the clip rendered, the samples written (copied: the blocks are the render's)
const render = async (
  modules: Synth,
  notes: ClipNote[],
  options: Partial<RenderClipOptions> = {},
  builder = inProcessBuilder({ auto: true })
) => {
  const left: number[] = [];
  const right: number[] = [];
  const result = await renderClip({
    exports: wasmCore<EngineExports>('engine'),
    sound: pageSound(
      [modules.osc1[0], modules.osc2[0]],
      modules.noise[0],
      modules.transport[0].$bpm.value,
      modules.synthCore[0].$masterGain.value
    ),
    clip: { notes, length: CLIP_BAR },
    sampleRate: RATE,
    seed: 1,
    wavetables: builder.dependencies,
    pause: () => Promise.resolve(),
    write: (outL, outR) => {
      left.push(...outL);
      right.push(...outR);
    },
    ...options,
  });
  return { ...result, left: Float32Array.from(left), right: Float32Array.from(right), builder };
};

// a bar at 120 BPM, a beat
const BAR_FRAMES = 2 * RATE;
const BEAT_FRAMES = RATE / 2;
const firstSound = (samples: Float32Array) => samples.findIndex((x) => x !== 0);
// the last frame over the silence in either channel
const lastSound = (left: Float32Array, right: Float32Array) => {
  for (let i = left.length - 1; i >= 0; i--)
    if (Math.abs(left[i]) > SILENCE || Math.abs(right[i]) > SILENCE) return i;
  return -1;
};
const peak = (samples: Float32Array) => samples.reduce((most, x) => Math.max(most, Math.abs(x)), 0);
// the second difference at `i` (a click: a step of a frame stands out of it)
const bend = (x: Float32Array, i: number) => Math.abs(x[i + 1] - 2 * x[i] + x[i - 1]);

describe('renderClip', () => {
  it('renders the pass of the clip from its first frame: the first note there, the bar long', async () => {
    const modules = await pageSynth();
    const { frames, left, right } = await render(modules, [[0, CLIP_PPQ / 4, 60, 100]]);
    expect(frames).toBe(BAR_FRAMES);
    expect(left.length).toBeGreaterThanOrEqual(frames);
    expect(firstSound(left)).toBe(0);
    expect(peak(left.subarray(0, RATE / 4))).toBeGreaterThan(0.05);
    expect(peak(right.subarray(0, RATE / 4))).toBeGreaterThan(0.05);
    // a 16th and its release, then silence
    expect(peak(left.subarray(RATE / 2, frames))).toBe(0);
  });

  it('plays each note at the frame of its beat', async () => {
    const modules = await pageSynth();
    const { left } = await render(modules, [
      [0, CLIP_PPQ / 4, 60, 100],
      [2 * CLIP_PPQ, CLIP_PPQ / 4, 67, 100],
    ]);
    const second = RATE; // beat 2 at 120 BPM
    expect(peak(left.subarray(second - 2000, second))).toBe(0);
    expect(firstSound(left.subarray(second))).toBe(0);
  });

  it('one seed renders the same samples, another seed others', async () => {
    const modules = await pageSynth();
    modules.osc1[1].setOscValue('unison', 4);
    modules.osc1[1].setOscValue('phaseRand', 1);
    const notes: ClipNote[] = [[0, CLIP_PPQ, 60, 100]];
    const first = await render(modules, notes, { seed: 5 });
    const again = await render(modules, notes, { seed: 5 });
    const other = await render(modules, notes, { seed: 6 });
    expect(again.left).toEqual(first.left);
    expect(other.left).not.toEqual(first.left);
  });

  it('a tail past the pass: rendered until nothing plays, the silence at its end cut to the end of its beat', async () => {
    const modules = await pageSynth();
    modules.envelopes[1].setEnvelopeValue('env1', 'release', 1.5);
    const { frames, beats, left, right } = await render(modules, [[3 * CLIP_PPQ, CLIP_PPQ, 60, 100]]);
    expect(frames).toBeGreaterThan(BAR_FRAMES + RATE / 2);
    expect(frames).toBeLessThan(BAR_FRAMES + 5 * RATE);
    expect(left.length).toBeLessThan(BAR_FRAMES + MAX_TAIL * RATE);
    // a whole number of beats: the last frame that sounds in the last one
    expect(frames).toBe(beats * BEAT_FRAMES);
    const last = lastSound(left, right);
    expect(last).toBeGreaterThanOrEqual(frames - BEAT_FRAMES);
    expect(last).toBeLessThan(frames);
    expect(peak(left.subarray(last + 1))).toBeLessThanOrEqual(SILENCE);
    expect(peak(right.subarray(last + 1))).toBeLessThanOrEqual(SILENCE);
  });

  it('a tail that outlasts its most: faded out over its last TAIL_FADE, never cut', async () => {
    const modules = await pageSynth();
    modules.envelopes[1].setEnvelopeValue('env1', 'release', 8);
    // (a beat, its note off half a second in: the most of the tail 3 s past it)
    const notes: ClipNote[] = [[0, CLIP_PPQ, 60, 100]];
    const cut = await render(modules, notes, { maxTail: 3 });
    const longer = await render(modules, notes, { maxTail: 6 });
    const end = Math.round(3.5 * RATE);
    const fade = Math.round(TAIL_FADE * RATE);
    // the frames of a window around `at`
    const around = (x: Float32Array, at: number) => x.subarray(at - 500, at + 500);
    expect(cut.frames).toBe(cut.beats * BEAT_FRAMES);
    expect(cut.frames).toBeGreaterThanOrEqual(end);
    [
      [cut.left, longer.left],
      [cut.right, longer.right],
    ].forEach(([file, on]) => {
      // as the longer one up to its fade, never louder in it; half as loud in its middle
      expect(file.subarray(0, end - fade - 2)).toEqual(on.subarray(0, end - fade - 2));
      for (let i = end - fade - 2; i < end; i++)
        expect(Math.abs(file[i])).toBeLessThanOrEqual(Math.abs(on[i]));
      expect(peak(around(file, end - fade / 2)) / peak(around(on, end - fade / 2))).toBeCloseTo(0.5, 1);
      // the longer one still sounds at the most of the other, which ends in silence there: no step
      expect(peak(on.subarray(end - 100, end))).toBeGreaterThan(0.01);
      expect(peak(file.subarray(end - 100, end + 2))).toBeLessThan(1e-4);
      expect(peak(file.subarray(end + 2))).toBe(0);
    });
  });

  it('a tail of a clip off the beats: on to a whole beat, past what was rendered in silence', async () => {
    const modules = await pageSynth();
    // (a clip of 3½ beats, its note gone at once: the file ends half a beat after it)
    const notes: ClipNote[] = [[0, CLIP_PPQ / 4, 60, 100]];
    const clip = { notes, length: 3.5 * CLIP_PPQ };
    // (with headroom too: the file kept, then written)
    for (const level of ['played', 'headroom'] as const) {
      const { frames, beats, left, right } = await render(modules, notes, { clip, level });
      expect(beats).toBe(4);
      expect(frames).toBe(BAR_FRAMES);
      expect(left.length).toBe(frames);
      expect(peak(left.subarray(0, RATE / 4))).toBeGreaterThan(0.05);
      expect(peak(left.subarray(RATE / 2))).toBe(0);
      expect(peak(right.subarray(RATE / 2))).toBe(0);
    }
  });

  it('the beats of a file as long as the clip: those of the clip, whole or not', async () => {
    const modules = await pageSynth();
    const notes: ClipNote[] = [[0, CLIP_PPQ / 4, 60, 100]];
    for (const span of ['clip', 'loop'] as const) {
      expect((await render(modules, notes, { span })).beats).toBe(4);
      const off = await render(modules, notes, { span, clip: { notes, length: 3.5 * CLIP_PPQ } });
      expect(off.beats).toBe(3.5);
      expect(off.frames).toBe(3.5 * BEAT_FRAMES);
    }
  });

  it('a seamless loop: as long as the clip, the tail of its end at its start', async () => {
    const modules = await pageSynth();
    modules.envelopes[1].setEnvelopeValue('env1', 'release', 1);
    const notes: ClipNote[] = [
      [CLIP_PPQ, CLIP_PPQ / 2, 64, 100],
      [3 * CLIP_PPQ, CLIP_PPQ, 60, 100],
    ];
    const once = await render(modules, notes);
    const loop = await render(modules, notes, { span: 'loop' });
    expect(loop.frames).toBe(BAR_FRAMES);
    expect(loop.left.length).toBe(BAR_FRAMES);
    // before its first note: the tail of the last one of the pass before
    expect(peak(once.left.subarray(0, RATE / 2))).toBe(0);
    expect(peak(loop.left.subarray(0, RATE / 2))).toBeGreaterThan(0.01);
    // its first note at the frame of its beat, as in a pass alone
    expect(loop.left.subarray(RATE / 2 + 2000, RATE)).not.toEqual(new Float32Array(RATE / 2 - 2000));
  });

  it('a seamless loop: its end flows into its start where the passes differ (the phases at random)', async () => {
    const modules = await pageSynth();
    const [, osc] = modules.osc1;
    osc.setWaveTable([SINE]);
    osc.setOscValue('phaseRand', 1);
    modules.synth[1].setMaxVoices(1);
    modules.envelopes[1].setEnvelopeValue('env1', 'attack', 0.005);
    modules.envelopes[1].setEnvelopeValue('env1', 'release', 0.3);
    // (the last note released just before the end: its tail sounds on under the first one, its phase another in
    // each pass)
    const notes: ClipNote[] = [
      [0, CLIP_PPQ, 43, 100],
      [3 * CLIP_PPQ, CLIP_PPQ - 30, 43, 100],
    ];
    const loop = await render(modules, notes, { span: 'loop' });
    // the two passes as one clip: the end of the first, the second as the loop has it
    const both: ClipNote[] = [
      ...notes,
      ...notes.map(([tick, ...note]): ClipNote => [tick + CLIP_BAR, ...note]),
    ];
    const twice = await render(modules, both, { clip: { notes: both, length: 2 * CLIP_BAR } });
    const seam = Math.round(SEAM * RATE);
    [
      [loop.left, twice.left],
      [loop.right, twice.right],
    ].forEach(([file, passes]) => {
      const second = passes.subarray(BAR_FRAMES, 2 * BAR_FRAMES);
      // the second pass up to its last SEAM, those crossed into the end of the first one: its last frame is the
      // frame before its start
      expect(file.subarray(0, BAR_FRAMES - seam)).toEqual(second.subarray(0, BAR_FRAMES - seam));
      expect(file.subarray(BAR_FRAMES - seam)).not.toEqual(second.subarray(BAR_FRAMES - seam));
      expect(file[BAR_FRAMES - 1]).toBe(passes[BAR_FRAMES - 1]);
      // looped, no click: the seam bends as the two passes in one do there (before, a step of a frame: a bend
      // over a hundred times the most of the file elsewhere)
      const looped = Float32Array.of(...file.subarray(BAR_FRAMES - 2), ...file.subarray(0, 2));
      const played = passes.subarray(BAR_FRAMES - 2, BAR_FRAMES + 2);
      [1, 2].forEach((i) => expect(bend(looped, i)).toBeCloseTo(bend(played, i), 6));
    });
  });

  it('the clip alone: as long as it, from silence, what still sounds at its end faded out into silence', async () => {
    const modules = await pageSynth();
    modules.envelopes[1].setEnvelopeValue('env1', 'attack', 0.005);
    modules.envelopes[1].setEnvelopeValue('env1', 'release', 1);
    // (the last note held through the end: it sounds there)
    const notes: ClipNote[] = [
      [0, CLIP_PPQ, 60, 100],
      [3 * CLIP_PPQ, CLIP_PPQ, 64, 100],
    ];
    const once = await render(modules, notes);
    const clip = await render(modules, notes, { span: 'clip' });
    const seam = Math.round(SEAM * RATE);
    expect(clip.frames).toBe(BAR_FRAMES);
    expect(clip.left.length).toBe(BAR_FRAMES);
    [
      [clip.left, once.left],
      [clip.right, once.right],
    ].forEach(([file, tail]) => {
      // the pass of the clip and its tail up to the last SEAM, then that faded out (never louder)
      expect(file.subarray(0, BAR_FRAMES - seam)).toEqual(tail.subarray(0, BAR_FRAMES - seam));
      expect(peak(tail.subarray(BAR_FRAMES - seam, BAR_FRAMES))).toBeGreaterThan(0.05);
      for (let i = BAR_FRAMES - seam; i < BAR_FRAMES; i++)
        expect(Math.abs(file[i])).toBeLessThanOrEqual(Math.abs(tail[i]));
      // looped, from silence into silence: its last frame the one before the clip, its first the start of a note
      expect(file[BAR_FRAMES - 1]).toBe(0);
      expect(Math.abs(file[0])).toBeLessThan(1e-3);
    });
  });

  it('headroom: a sound under the ceiling of the limiter is the file as played', async () => {
    const modules = await pageSynth();
    const notes: ClipNote[] = [[0, CLIP_PPQ, 60, 100]];
    const played = await render(modules, notes);
    const headroom = await render(modules, notes, { level: 'headroom' });
    expect(peak(played.left)).toBeLessThan(CEILING / 2);
    expect(headroom.gain).toBe(1);
    expect(headroom.frames).toBe(played.frames);
    expect(headroom.left.subarray(0, played.frames)).toEqual(played.left.subarray(0, played.frames));
    expect(headroom.right.subarray(0, played.frames)).toEqual(played.right.subarray(0, played.frames));
  });

  it('headroom: a sound over the ceiling turned down as a whole to it, its peaks not squashed', async () => {
    const modules = await pageSynth();
    // (a chord of saws in unison: far over the ceiling)
    modules.osc1[1].setOscValue('unison', 4);
    const notes: ClipNote[] = [48, 55, 60, 64, 67].map((pitch): ClipNote => [0, 2 * CLIP_PPQ, pitch, 127]);
    modules.osc1[1].setGain(1);
    const hot = await render(modules, notes, { level: 'headroom' });
    const squashed = await render(modules, notes);
    modules.osc1[1].setGain(0.05);
    const quiet = await render(modules, notes, { level: 'headroom' });
    expect(quiet.gain).toBe(1);
    expect(hot.gain).toBeLessThan(0.5);
    const { frames } = hot;
    const loudest = Math.max(truePeak(hot.left.subarray(0, frames)), truePeak(hot.right.subarray(0, frames)));
    expect(dB(loudest / CEILING)).toBeCloseTo(0, 3);
    // the shape of the quiet one (the limiter left out), not of the one it squashed
    const at = quiet.left.reduce((best, x, i) => (Math.abs(x) > Math.abs(quiet.left[best]) ? i : best), 0);
    const ratio = hot.left[at] / quiet.left[at];
    const off = (file: Float32Array, k: number) =>
      file.subarray(0, frames).reduce((most, x, i) => Math.max(most, Math.abs(x - k * quiet.left[i])), 0);
    expect(off(hot.left, ratio)).toBeLessThan(1e-4);
    expect(off(squashed.left, squashed.left[at] / quiet.left[at])).toBeGreaterThan(0.05);
  });

  it('as played at the Master of the page: under the ceiling scaled by it, over it held there by the limiter', async () => {
    const modules = await pageSynth();
    const notes: ClipNote[] = [[0, CLIP_PPQ, 60, 100]];
    const unity = await render(modules, notes);
    modules.synthCore[1].setMasterGain(0.5);
    const half = await render(modules, notes);
    // (+12 dB: the top of the Master)
    modules.synthCore[1].setMasterGain(4);
    const loud = await render(modules, notes);
    expect(peak(unity.left)).toBeLessThan(CEILING / 2);
    expect(half.frames).toBe(unity.frames);
    expect(half.left).toEqual(unity.left.map((x) => x / 2));
    expect(half.right).toEqual(unity.right.map((x) => x / 2));
    // driven into the limiter: louder than at 0 dB, its true peak at the ceiling
    const { frames } = loud;
    expect(peak(loud.left)).toBeGreaterThan(1.8 * peak(unity.left));
    const loudest = Math.max(
      truePeak(loud.left.subarray(0, frames)),
      truePeak(loud.right.subarray(0, frames))
    );
    expect(dB(loudest / CEILING)).toBeLessThan(0.1);
  });

  it('headroom at the Master of the page: a sound under the ceiling the file as played, one over turned down', async () => {
    const modules = await pageSynth();
    const notes: ClipNote[] = [[0, CLIP_PPQ, 60, 100]];
    modules.synthCore[1].setMasterGain(0.5);
    const played = await render(modules, notes);
    const quiet = await render(modules, notes, { level: 'headroom' });
    expect(quiet.gain).toBe(1);
    expect(quiet.left.subarray(0, played.frames)).toEqual(played.left.subarray(0, played.frames));
    modules.synthCore[1].setMasterGain(4);
    const hot = await render(modules, notes, { level: 'headroom' });
    expect(hot.gain).toBeLessThan(1);
    const { frames } = hot;
    const loudest = Math.max(truePeak(hot.left.subarray(0, frames)), truePeak(hot.right.subarray(0, frames)));
    expect(dB(loudest / CEILING)).toBeCloseTo(0, 3);
  });

  it('leaves the page as it was: its snapshot, its models, its node, its storage and its url', async () => {
    const modules = await pageSynth();
    const [{ audioCtx }] = modules.synthCore;
    const snapshot = getSnapshot();
    const node = voicesNodes(audioCtx).at(-1);
    const posted = node?.port.postMessage.mock.calls.length;
    localStorage.setItem('kept', '1');
    const storage = { ...localStorage };
    const url = window.location.href;
    await render(modules, [[0, CLIP_PPQ, 60, 100]], { onProgress: () => undefined });
    expect(getSnapshot()).toEqual(snapshot);
    expect(Object.keys(getSnapshot()).sort()).toEqual(Object.keys(snapshot).sort());
    expect(node?.port.postMessage.mock.calls.length).toBe(posted);
    expect({ ...localStorage }).toEqual(storage);
    expect(window.location.href).toBe(url);
    // the models of the page play on
    modules.osc1[1].setGain(0.25);
    expect(getSnapshot()['osc1']).toMatchObject({ g: 0.25 });
  });

  it('tells its progress up to 1', async () => {
    const modules = await pageSynth();
    const shares: number[] = [];
    await render(modules, [[0, CLIP_PPQ, 60, 100]], { onProgress: (share) => shares.push(share) });
    expect(shares.length).toBeGreaterThan(10);
    expect(shares.every((share, i) => i === 0 || share >= shares[i - 1])).toBe(true);
    expect(shares.at(-1)).toBe(1);
  });

  it('a cancel ends it with its reason: its core and its worker gone', async () => {
    const modules = await pageSynth();
    const abort = new AbortController();
    const builder = inProcessBuilder({ auto: true });
    let made: { engine: { $status: { value: string } } } | null = null;
    const rendering = render(
      modules,
      [[0, CLIP_PPQ, 60, 100]],
      {
        signal: abort.signal,
        onRender: (core) => (made = core),
        onProgress: (share) => share > 0.2 && abort.abort(new Error('cancelled')),
        // (the pause takes the cancel)
        pause: () => new Promise((resolve) => setTimeout(resolve)),
      },
      builder
    );
    await expect(rendering).rejects.toThrow('cancelled');
    expect(builder.workers[0].terminated).toBe(true);
    expect(made).not.toBeNull();
  });

  it('a stage that fails ends it with its name', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const modules = await pageSynth();
    let trapped = false;
    let core: Parameters<NonNullable<RenderClipOptions['onRender']>>[0] | null = null;
    await expect(
      render(modules, [[0, CLIP_PPQ, 60, 100]], {
        onRender: (made) => (core = made),
        onProgress: () => {
          if (trapped || !core) return;
          trapped = true;
          (core as typeof core & object).engine.wasm?.chain.trap(LIMITER_STAGE);
        },
      })
    ).rejects.toThrow('The limiter failed in the render');
  });

  it('the engine failing ends it as such, not by the name of a stage (the chain shows them all failed then)', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const modules = await pageSynth();
    await expect(
      render(modules, [[0, CLIP_PPQ, 60, 100]], {
        // (its module: no memory for it)
        onRender: (core) => core.engine.fail(new Error('no memory')),
      })
    ).rejects.toThrow('The engine of the render failed');
  });

  it('the worker of its tables failing while they come: the engine failed at once, not a wait to the time up', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const modules = await pageSynth();
    // (a builder nobody flushes, its workers caught)
    const builder = inProcessBuilder();
    const workers: Worker[] = [];
    const createWorker = (url: string) => {
      const worker = (builder.dependencies.createWorker as (url: string) => Worker)(url);
      workers.push(worker);
      return worker;
    };
    const rendering = render(
      modules,
      [[0, CLIP_PPQ, 60, 100]],
      { readyTimeout: 4000, wavetables: { ...builder.dependencies, createWorker } },
      builder
    );
    await flush();
    expect(workers).toHaveLength(1);
    workers[0].onerror?.(new Event('error') as ErrorEvent);
    await expect(rendering).rejects.toThrow('The engine of the render failed');
  });

  it('a voice that fails ends it: the file would lack its note', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const modules = await pageSynth();
    // (the perf build traps a voice as it finishes its block: through its filter)
    modules.filter[1].toggleActive();
    let trapped = false;
    let core: Parameters<NonNullable<RenderClipOptions['onRender']>>[0] | null = null;
    await expect(
      render(modules, [[0, CLIP_BAR, 60, 100]], {
        onRender: (made) => (core = made),
        onProgress: (share) => {
          if (trapped || !core || share < 0.2) return;
          trapped = true;
          // (the first voice of the render: the note)
          (core as typeof core & object).engine.wasm?.voices.trap(1);
        },
      })
    ).rejects.toThrow('A note failed in the render');
    expect(trapped).toBe(true);
  });

  it('a noise on without its sample (its load failed): rendered off, as the page plays it, no table of it waited for', async () => {
    const modules = await pageSynth();
    const notes: ClipNote[] = [[0, CLIP_PPQ, 60, 100]];
    const plain = await render(modules, notes);
    // (its sample never comes: the page holds none)
    modules.noise[1].toggleActive();
    expect(modules.noise[0].$sample.value).toBeNull();
    const noised = await render(modules, notes);
    expect(noised.left).toEqual(plain.left);
    expect(noised.right).toEqual(plain.right);
  });

  it('a sound whose tables never come: an error once the time is up', async () => {
    const modules = await pageSynth();
    // (a builder nobody flushes)
    await expect(
      render(modules, [[0, CLIP_PPQ, 60, 100]], { readyTimeout: 50 }, inProcessBuilder())
    ).rejects.toThrow('The sound did not load in time');
  });

  it('a cancel while the tables are coming ends the wait with its reason, its listener gone', async () => {
    const modules = await pageSynth();
    const abort = new AbortController();
    const removed = jest.spyOn(abort.signal, 'removeEventListener');
    const rendering = render(
      modules,
      [[0, CLIP_PPQ, 60, 100]],
      { signal: abort.signal, readyTimeout: 5000 },
      // (a builder nobody flushes)
      inProcessBuilder()
    );
    await flush();
    abort.abort(new Error('cancelled'));
    await expect(rendering).rejects.toThrow('cancelled');
    expect(removed.mock.calls.map(([type]) => type)).toContain('abort');
  });
});
