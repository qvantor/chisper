import { EMPTY, filter, firstValueFrom, fromEvent, map, merge, Subscription, timeout } from 'rxjs';
import { CLIP_PPQ, type ClipNote } from '@chisper/preset-schema';
import { snapshotScope } from '../../../app';
import { FX_KINDS } from '../../common/chain/chain-params';
import type { EngineExports } from '../../common/engine/engine-wasm';
import { CEILING } from '../../common/limiter/limiter-params';
import { subTable } from '../../common/wavetable/sub-shapes';
import { KILL_FADE } from '../../common/wavetable/voice-options';
import { FX_REGISTRY } from '../../fx/effects';
import type { WavetableEngineDependencies } from '../../common/wavetable/wavetable-engine';
import { midiToNote } from '../../services';
import { clipKeys } from '../clip-schedule';
import { TRACK, TRACK_LEAD } from '../modules/track';
import { createRenderCore, RenderCore } from './render-core';
import { createRenderModels, RenderModels, RenderSound } from './render-models';
import { truePeak } from './true-peak';

// the frames of a block of the engine
export const RENDER_BLOCK = 128;
// seconds of the render before the clip: the throttles of the models send what the snapshot set (a table 100 ms
// after the first one, a state of the LFOs 20 ms), the engine renders the silence of then
export const SETTLE = 0.25;
// seconds of the end of a file as long as the clip crossfaded into the frames before its start (a raised cosine, as
// a stolen voice fades: no click on a bass note either), so that, looped, it flows into its start: of a loop the end
// of the pass before it (the passes differ: the phases a note draws at random, an LFO that runs free, a tail longer
// than the clip; the end of the second would step into the start of the file), of a clip the silence before it (what
// still sounds at its end fades out)
export const SEAM = KILL_FADE;
// the seconds a tail may last past the last note off at most (the longest Release and the tails of the effects after
// it); one that still sounds then fades out over the last TAIL_FADE of them (a raised cosine, as the seam)
export const MAX_TAIL = 60;
export const TAIL_FADE = 1;
// the level under which the end of a tail is silence (−90 dBFS)
export const SILENCE = 10 ** (-90 / 20);
// ms the tables of the sound may take to be stored before a render gives up
export const READY_TIMEOUT = 20000;
// ms of work between two pauses of a render on the main thread (the page answers, a cancel is taken)
const SLICE_MS = 15;
// frames a file kept for its level is measured and written by between two pauses (the silence to the end of a
// beat too)
const LEVEL_CHUNK = 4096;

// what a file holds of the clip: `clip`, one pass as long as the clip from silence, what still sounds at its end
// faded out over SEAM (it loops from silence into silence, in a player that pauses or fades at the loop point
// too); `tail`, one pass and its tail (MAX_TAIL past the last note off at most, faded out there), the silence at its
// end cut up to the next beat (a whole number of beats: the tempo a DAW works out of its length and beats is the
// clip's); `loop`, a seamless loop: the second of two
// passes, as long as the clip, the tails of the first one at its start, its last SEAM crossfaded into the end of
// the first one (its last frame is the one before its start)
export type ClipSpan = 'clip' | 'tail' | 'loop';

// how loud the file is: `played`, through the limiter, as loud as the synth plays it; `headroom`, without the
// limiter, a file whose true peak would go over its ceiling turned down as a whole to it (quieter, its peaks not
// squashed; one under it is the file as played)
export type ClipLevel = 'played' | 'headroom';

export interface RenderClipOptions {
  // an instance of the core of its own (engine-core.ts: loadEngineCore)
  exports: EngineExports;
  sound: RenderSound;
  clip: { notes: readonly ClipNote[]; length: number };
  // the rate of the file
  sampleRate: number;
  // what the file holds of the clip (ClipSpan; by default one pass and its tail)
  span?: ClipSpan;
  // how loud it is (ClipLevel; by default as played)
  level?: ClipLevel;
  // what a note draws at random: one seed, the same samples (none: at random, as the synth plays)
  seed?: number;
  // the builder of the tables (a worker of its own by default)
  wavetables?: WavetableEngineDependencies;
  signal?: AbortSignal;
  // the share of the render done
  onProgress?: (share: number) => void;
  // the frames of the file, block by block, in their order
  write: (left: Float32Array, right: Float32Array) => void;
  // a pause between two slices of work (by default the next task of the page)
  pause?: () => Promise<void>;
  // ms the tables may take to be stored
  readyTimeout?: number;
  // the seconds a tail may last past the last note off (MAX_TAIL)
  maxTail?: number;
  // the core of the render as it is made (the specs)
  onRender?: (render: RenderCore) => void;
}

export interface RenderedClip {
  // the frames of the file: those written up to the end of the beat of the last that sounds (as long as the clip:
  // all of them)
  frames: number;
  // the beats it lasts (a tail's whole; the clip's, the others)
  beats: number;
  // what the file was turned down by (headroom; 1: as rendered)
  gain: number;
}

// the next task of the page (no clamp of a nested timeout)
const nextTask = () =>
  new Promise<void>((resolve) => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => {
      port1.close();
      resolve();
    };
    port2.postMessage(null);
  });

// the stages of the chain by name (as a failure tells them)
const NAMES = [...FX_KINDS.map((kind) => FX_REGISTRY[kind].label), 'The limiter'];
const ENGINE_FAILED = 'The engine of the render failed';

// the tables the voices of the sound play (those of the sources that are on): stored, or not yet; one refused or
// failed fails the render
const tablesStored = ({ osc1, osc2, noise, sub }: RenderModels, tables: Record<string, string>) => {
  const ids = [
    osc1[0].$active.value ? osc1[0].id : null,
    osc2[0].$active.value ? osc2[0].id : null,
    noise[0].$active.value ? noise[0].id : null,
    sub[0].$active.value ? subTable(sub[0].$sub.value.shape) : null,
  ].filter((id): id is string => id !== null);
  if (ids.some((id) => tables[id] === 'refused' || tables[id] === 'failed'))
    throw new Error('A table of the sound could not be loaded into the render');
  return ids.every((id) => tables[id] === 'stored');
};

// the file kept for its level (headroom), written: its true peak (a loop read on into its start), the whole turned down
// to the ceiling where it goes over it; the gain
const writeLeveled = async (
  [fileL, fileR]: Float32Array[],
  cyclic: boolean,
  write: RenderClipOptions['write'],
  breathe: () => Promise<void>
) => {
  let peak = 0;
  for (let at = 0; at < fileL.length; at += LEVEL_CHUNK)
    for (const x of [fileL, fileR]) {
      peak = Math.max(peak, truePeak(x, at, Math.min(x.length, at + LEVEL_CHUNK), cyclic));
      await breathe();
    }
  const gain = peak > CEILING ? CEILING / peak : 1;
  for (let at = 0; at < fileL.length; at += LEVEL_CHUNK) {
    const outL = fileL.subarray(at, at + LEVEL_CHUNK);
    const outR = fileR.subarray(at, at + LEVEL_CHUNK);
    if (gain < 1)
      for (let i = 0; i < outL.length; i++) {
        outL[i] *= gain;
        outR[i] *= gain;
      }
    write(outL, outR);
    await breathe();
  }
  return gain;
};

// The clip played by a copy of the models of the sound on a core of its own, block by block on the main thread,
// faster than real time: as the synth plays the track from the start of the clip, the same samples for a seed. The
// models settle (SETTLE: the time of the render, not of the page), the tables are stored (the time of the page),
// then the clip starts: before each block the timers of the models whose time has come, the keys of the clip up to
// TRACK_LEAD ahead (as the track sends them), what the synth tells the fx; a block; what it tells the models. The
// file starts at the first frame of the clip (the latency of the limiter left out); one as long as the clip ends
// into the frames before its start (SEAM). With headroom the file is kept until its true peak is known, then
// written turned down. A cancel, the engine failed (its module, its worker: also while the tables come), a stage that
// fails (by its name) or a note that does (a voice that trapped: the file would lack it) end it with an error;
// whatever ends it, its models and its core go
export const renderClip = async ({
  exports,
  sound,
  clip,
  sampleRate,
  span = 'tail',
  level = 'played',
  seed,
  wavetables: dependencies,
  signal,
  onProgress,
  write,
  pause = nextTask,
  readyTimeout = READY_TIMEOUT,
  maxTail = MAX_TAIL,
  onRender,
}: RenderClipOptions): Promise<RenderedClip> => {
  const headroom = level === 'headroom';
  const render = createRenderCore({
    exports,
    sampleRate,
    seed,
    unlimited: headroom,
    masterGain: sound.masterGain,
    wavetables: dependencies,
  });
  onRender?.(render);
  const { time, engine, chain, wavetables } = render;
  const models = createRenderModels(render, sound, snapshotScope());
  const subscriptions = new Subscription();
  // (a stage alone: the chain shows every stage failed where its module did, the engine)
  let failure: string | null = null;
  NAMES.forEach((name, stage) =>
    subscriptions.add(
      chain.status(stage).subscribe((status) => {
        if (status === 'failed' && chain.$status.value === 'ready')
          failure ??= `${name} failed in the render`;
      })
    )
  );
  const left = new Float32Array(RENDER_BLOCK);
  const right = new Float32Array(RENDER_BLOCK);
  // (a stage that trapped is a fault of the engine too: its name first)
  const check = () => {
    signal?.throwIfAborted();
    if (engine.$status.value === 'failed') throw new Error(ENGINE_FAILED);
    if (failure) throw new Error(failure);
    if (engine.fault !== null) throw new Error('A note failed in the render', { cause: engine.fault });
  };
  let sliceStart = performance.now();
  const breathe = async () => {
    if (performance.now() - sliceStart < SLICE_MS) return;
    await pause();
    sliceStart = performance.now();
    check();
  };
  // a block of the engine, the time of the render on
  const step = () => {
    time.runDue();
    wavetables.flush();
    if (!engine.render(left, right)) throw new Error(ENGINE_FAILED);
    time.advance(RENDER_BLOCK);
    check();
  };

  try {
    await firstValueFrom(engine.$status.pipe(filter((status) => status !== 'loading')));
    check();
    if (wavetables.$status.value !== 'ready') throw new Error('This browser can not render the sound');
    while (time.clock.currentTime < SETTLE) {
      step();
      await breathe();
    }
    // (a cancel meanwhile ends the wait: its listener goes with it)
    const aborted = signal
      ? fromEvent(signal, 'abort').pipe(
          map(() => {
            throw signal.reason;
          })
        )
      : EMPTY;
    // (the engine failed meanwhile, its worker: its tables are gone with it)
    const broken = engine.$status.pipe(
      filter((status) => status === 'failed'),
      map(() => {
        throw new Error(ENGINE_FAILED);
      })
    );
    await firstValueFrom(
      merge(
        wavetables.$tables.pipe(
          filter((tables) => tablesStored(models, tables)),
          timeout({
            first: readyTimeout,
            with: () => Promise.reject(new Error('The sound did not load in time')),
          })
        ),
        aborted,
        broken
      )
    );
    check();

    // the clip from the soonest time the transport takes (as the track plays it from its start)
    const [transport, { locate }] = models.transport;
    locate(0, time.clock.currentTime + TRACK_LEAD);
    const timeOf = (tick: number) => transport.timeAt(tick / CLIP_PPQ);
    const frameOf = (seconds: number) => Math.ceil(seconds * sampleRate - 1e-6);
    const loop = span === 'loop';
    // (a file as long as the clip, which ends into the frames before its start)
    const fixed = span !== 'tail';
    const keys = clipKeys(clip.notes, clip.length, loop ? 2 : 1);
    const latency = engine.latency;
    const passStart = loop ? timeOf(clip.length) : timeOf(0);
    // the frames of the file from its start to `ticks` of the pass (on past it at the tempo)
    const framesOf = (ticks: number) => frameOf(passStart + timeOf(ticks) - timeOf(0)) - frameOf(passStart);
    const passFrames = framesOf(clip.length);
    const fileStart = frameOf(passStart) + latency;
    const lastKey = frameOf(keys.length > 0 ? timeOf(keys[keys.length - 1].tick) : passStart);
    // the end of the file (excluded): as long as the clip at once; a tail's once nothing plays, at most maxTail
    // past the last note off
    let fileEnd = fixed ? fileStart + passFrames : lastKey + latency + Math.round(maxTail * sampleRate);
    const expected = fixed ? fileEnd - time.frame : fileStart + passFrames + 2 * sampleRate - time.frame;
    const first = time.frame;
    // the last frames of the file cross into those before it: as long as the clip, the frames before the file (the
    // end of the pass before a loop, the silence before a clip); a tail at its most, silence (it fades out there,
    // one that ends before never gets to them)
    const seam = fixed
      ? Math.min(Math.round(SEAM * sampleRate), passFrames)
      : Math.min(Math.round(TAIL_FADE * sampleRate), fileEnd - fileStart);
    const seamStart = fileEnd - seam;
    const beforeL = new Float32Array(seam);
    const beforeR = new Float32Array(seam);
    // the last frame of the file that sounds
    let loud = -1;
    let next = 0;
    const [, input] = models.inputController;
    const [synth, { followFx }] = models.synth;
    const quiet = () => synth.$voicesCount.value === 0 && engine.idle();
    // (headroom: the file kept, as long as it may be) the frames written
    const kept = headroom ? [0, 1].map(() => new Float32Array(fileEnd - fileStart)) : null;
    let written = 0;
    const emit = (outL: Float32Array, outR: Float32Array) => {
      if (kept) {
        kept[0].set(outL, written);
        kept[1].set(outR, written);
      } else write(outL, outR);
      written += outL.length;
    };

    while (time.frame < fileEnd) {
      // the keys up to TRACK_LEAD ahead, at their times
      const horizon = time.clock.currentTime + TRACK_LEAD;
      while (next < keys.length && timeOf(keys[next].tick) < horizon) {
        const { tick, on, pitch, velocity } = keys[next++];
        const at = timeOf(tick);
        if (on) input.onPress(midiToNote(pitch), velocity, { source: TRACK, at });
        else input.onRelease(midiToNote(pitch), { source: TRACK, at });
      }
      followFx();
      const frame = time.frame;
      step();
      // (as long as the clip: the frames before the file kept)
      const keepFrom = Math.max(fileStart - seam, frame);
      const keepTo = Math.min(fileStart, frame + RENDER_BLOCK);
      if (fixed && keepTo > keepFrom) {
        beforeL.set(left.subarray(keepFrom - frame, keepTo - frame), keepFrom - fileStart + seam);
        beforeR.set(right.subarray(keepFrom - frame, keepTo - frame), keepFrom - fileStart + seam);
      }
      const from = Math.max(fileStart, frame);
      const to = Math.min(fileEnd, frame + RENDER_BLOCK);
      if (to > from) {
        // (a raised cosine, the gains summed to 1: never over the ceiling of the limiter; the last frame all the
        // one before the file, a tail's silence)
        for (let f = Math.max(from, seamStart); f < to; f++) {
          const k = f - seamStart;
          const w = 0.5 - 0.5 * Math.cos((Math.PI * (k + 1)) / seam);
          left[f - frame] = (1 - w) * left[f - frame] + w * beforeL[k];
          right[f - frame] = (1 - w) * right[f - frame] + w * beforeR[k];
        }
        const a = from - frame;
        const b = to - frame;
        const outL = left.subarray(a, b);
        const outR = right.subarray(a, b);
        emit(outL, outR);
        for (let i = outL.length - 1; i >= 0; i--)
          if (Math.abs(outL[i]) > SILENCE || Math.abs(outR[i]) > SILENCE) {
            loud = from - fileStart + i;
            break;
          }
      }
      // the pass at least; once nothing plays, the limiter lets out what it holds (its latency more)
      if (!fixed && frame >= lastKey && next === keys.length && quiet())
        fileEnd = Math.min(fileEnd, Math.max(fileStart + passFrames, frame + RENDER_BLOCK + latency));
      onProgress?.(Math.min(0.99, (time.frame - first) / expected));
      await breathe();
    }
    // a tail: the pass at least, up to the last frame that sounds, on to the end of its beat
    let frames = passFrames;
    let beats = clip.length / CLIP_PPQ;
    if (!fixed) {
      const sounding = Math.max(passFrames, loud + 1);
      beats = Math.ceil(beats);
      while (framesOf(beats * CLIP_PPQ) < sounding) beats++;
      frames = framesOf(beats * CLIP_PPQ);
    }
    const gain = kept
      ? await writeLeveled(
          kept.map((x) => x.subarray(0, Math.min(frames, written))),
          loop,
          write,
          breathe
        )
      : 1;
    // (the end of the beat past the frames rendered: silence)
    for (let at = written; at < frames; at += LEVEL_CHUNK) {
      const n = Math.min(LEVEL_CHUNK, frames - at);
      write(new Float32Array(n), new Float32Array(n));
      await breathe();
    }
    onProgress?.(1);
    return { frames, beats, gain };
  } finally {
    subscriptions.unsubscribe();
    models.stop();
    render.destroy();
  }
};
