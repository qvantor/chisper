import { CLIP_PPQ, ClipNote } from '@chisper/preset-schema';
import { createSynth, createTrack, stopModels } from '../../../../test-utils/models';
import { createOfflineEngine } from '../../../../test-utils/offline-engine';
import { TRACK_LEAD } from './track';

// the track played into the voices node of the core, offline: a note of the clip sounds from the first frame of its
// time on the transport, ceil(timeAt · rate), not from the block its event was sent in

const flush = () => new Promise((resolve) => setTimeout(resolve));

afterEach(() => {
  stopModels();
  sessionStorage.clear();
});

const firstSound = (left: Float32Array) => left.findIndex((sample) => sample !== 0);

describe('the track on the voices of the core', () => {
  it('starts each note at the frame of its beat', async () => {
    const engine = createOfflineEngine();
    const modules = createSynth();
    await flush();
    const [{ audioCtx, wavetables }] = modules.synthCore;
    engine.attach(audioCtx, wavetables);
    engine.flushWorker();
    // a sharp attack: the first frame of a note is heard at once
    modules.envelopes[1].setEnvelopeValue('env1', 'attack', 0);
    const { track, clock } = createTrack(modules);
    const [, actions] = track;
    // beats 0 and 1.25 at 120 BPM
    actions.setNotes([
      [0, CLIP_PPQ / 4, 60, 100],
      [CLIP_PPQ + CLIP_PPQ / 4, CLIP_PPQ / 4, 67, 100],
    ]);
    actions.play();
    const rate = audioCtx.sampleRate;
    const left = engine.render(Math.ceil((0.8 * rate) / 128), () => clock.tick());
    const at = (time: number) => Math.ceil(time * rate - 1e-6);
    expect(firstSound(left)).toBe(at(TRACK_LEAD));
    // the second note: silence between them (a 16th, then its release), its first frame at its beat
    const second = at(TRACK_LEAD + 1.25 * 0.5);
    expect(left.subarray(second - 2000, second).every((sample) => sample === 0)).toBe(true);
    expect(firstSound(left.subarray(second))).toBe(0);
    expect(engine.made()).toBe(2);
  });

  it('mono: notes that take the voice over closer than TRACK_LEAD each play at their own velocity', async () => {
    // a note that makes the voice, then two that take it over in legato a 64th apart (31 ms at 120 BPM: both
    // sent before the block of the first); the velocity sets the volume (Amp 1)
    const play = async (notes: ClipNote[]) => {
      const engine = createOfflineEngine();
      const modules = createSynth();
      await flush();
      const [{ audioCtx, wavetables }] = modules.synthCore;
      engine.attach(audioCtx, wavetables);
      engine.flushWorker();
      const [, synthActions] = modules.synth;
      synthActions.setMaxVoices(1);
      synthActions.setLegato(true);
      synthActions.setPortamento(0);
      const { track, clock } = createTrack(modules);
      const [, actions] = track;
      actions.setNotes(notes);
      actions.play();
      const left = engine.render(Math.ceil((0.7 * audioCtx.sampleRate) / 128), () => clock.tick());
      expect(engine.made()).toBe(1);
      stopModels();
      return { left, rate: audioCtx.sampleRate };
    };
    const made: ClipNote = [0, 1100, 48, 60];
    const first: ClipNote = [CLIP_PPQ, 1100, 55, 127];
    const second: ClipNote = [CLIP_PPQ + CLIP_PPQ / 16, 1000, 60, 20];
    const both = await play([made, first, second]);
    const alone = await play([made, first]);
    const at = (tick: number) => Math.ceil((TRACK_LEAD + (tick / CLIP_PPQ) * 0.5) * both.rate - 1e-6);
    // up to the second note the first one plays at its own velocity, not at that of the second one
    expect(both.left.subarray(0, at(second[0]))).toEqual(alone.left.subarray(0, at(second[0])));
    // then the second one at its own: quieter
    const peakOf = (left: Float32Array, from: number, to: number) =>
      Math.max(...left.subarray(from, to).map(Math.abs));
    const loud = peakOf(both.left, at(first[0]) + 0.015 * both.rate, at(second[0]));
    const quiet = peakOf(both.left, at(second[0]) + 0.015 * both.rate, at(second[0]) + 0.05 * both.rate);
    expect(quiet).toBeLessThan(0.3 * loud);
  });
});
