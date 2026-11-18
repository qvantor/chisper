import { CLIP_PPQ, ClipNote } from '@chisper/preset-schema';
import { createSynth, createTrack, stopModels } from '../../../../test-utils/models';
import { createOfflineEngine } from '../../../../test-utils/offline-engine';
import { onsetJump, onsetSteps } from '../../../../test-utils/onset-steps';
import { MIN_TAKE_ATTACK } from '../../common/modules/synth';
import { TRACK_LEAD } from './track';

// a riff of more notes than Poly on the real core: no note clicks at its start, whatever the attack of ENV 1. A
// note above Poly steals a voice: the voice plays it (its envelopes start again from their levels) or fades out
// under a new one. An attack of 0 on a voice taken over jumped its amplitude from its decay to 1 in one sample
// under a sounding filter: a step of several times the level before it at almost every note (WAVEFORM-41)

const flush = () => new Promise((resolve) => setTimeout(resolve));

afterEach(() => {
  stopModels();
  sessionStorage.clear();
});

const BPM = 124;
const NOTES = 40;
// a saw: every harmonic, so a step of the amplitude is a step of the signal
const SAW = Array.from({ length: 2048 }, (_, i) => 1 - (2 * i) / 2047);
// E minor over two octaves, in an order of its own (a fixed generator: the same riff every run)
const SCALE = [52, 54, 55, 57, 59, 60, 62, 64, 66, 67, 69, 71, 72, 74];
const riff = (length: number): ClipNote[] => {
  let seed = 7;
  let last = -1;
  return Array.from({ length: NOTES }, (_, k) => {
    let index = last;
    while (index === last) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      index = seed % SCALE.length;
    }
    last = index;
    return [(k * CLIP_PPQ) / 4, length, SCALE[index], 100] as ClipNote;
  });
};

interface Scene {
  poly: number;
  attack: number;
  // the ticks a note is held: a 16th (each released where the next starts), or shorter
  length?: number;
  // the curve of the attack of ENV 1 (k; a line by default)
  curve?: number;
  legato?: boolean;
  // nearer the preset of WAVEFORM-41, both oscillators (the second an octave up) with a unison of 8 into a
  // resonant filter. The phases of the unison not at random: a voice that starts anywhere in its wave steps by
  // itself, as much with no voice stolen (and against one quiet voice before it, in mono, by more than CLICK)
  heavy?: boolean;
}

// the riff through the synth at Poly `poly`, ENV 1 as a pluck with a long release (the voices of the notes before
// still sound under every note), the filter on: the steps of its notes at their starts
const play = async ({
  poly,
  attack,
  length = CLIP_PPQ / 4,
  curve = 0,
  legato = false,
  heavy = false,
}: Scene) => {
  const engine = createOfflineEngine(undefined, { limited: false });
  const modules = createSynth();
  await flush();
  const [{ audioCtx, wavetables }] = modules.synthCore;
  engine.attach(audioCtx, wavetables);
  modules.osc1[1].setWaveTable([SAW]);
  await flush();
  engine.flushWorker();
  const [, envelopes] = modules.envelopes;
  envelopes.setEnvelopeValue('env1', 'attack', attack);
  envelopes.setEnvelopeValue('env1', 'hold', 0);
  envelopes.setEnvelopeValue('env1', 'decay', 0.36);
  envelopes.setEnvelopeValue('env1', 'sustain', 0);
  envelopes.setEnvelopeValue('env1', 'release', 1.24);
  envelopes.setEnvelopeCurve('env1', 'attack', curve);
  modules.filter[1].toggleActive();
  if (heavy) {
    modules.osc2[1].toggleActive();
    modules.osc2[1].setWaveTable([SAW]);
    modules.osc2[1].setOscValue('octave', 1);
    [modules.osc1, modules.osc2].forEach(([, osc]) => {
      osc.setOscValue('unison', 8);
      osc.setOscValue('phaseRand', 0);
    });
    modules.filter[1].setNumericValue('resonance', 12);
    await flush();
    engine.flushWorker();
  }
  modules.transport[1].setBpm(BPM);
  const [, synthActions] = modules.synth;
  synthActions.setMaxVoices(poly);
  synthActions.setLegato(legato);
  synthActions.setPortamento(0);
  const { track, clock } = createTrack(modules);
  const notes = riff(length);
  track[1].setNotes(notes);
  track[1].play();
  const rate = audioCtx.sampleRate;
  const sixteenth = 60 / BPM / 4;
  // (the voices alive before each block: the most at once)
  let alive = 0;
  const left = engine.render(Math.ceil(((TRACK_LEAD + NOTES * sixteenth) * rate) / 128), () => {
    alive = Math.max(alive, engine.alive());
    clock.tick();
  });
  const starts = notes.map((_, k) => Math.ceil((TRACK_LEAD + k * sixteenth) * rate - 1e-6));
  const steps = onsetSteps(left, starts, rate);
  // (the step of each note as it is, not against the level before it)
  const jumps = starts.map((start) => onsetJump(left, start, rate));
  return { steps, jumps, alive, made: engine.made() };
};

// a note steps less than this share of the level before it. Measured on this riff: a new voice (its filter at
// rest) 0.33 at most, a voice taken over through an attack of 2 ms 0.31, of 5 ms 0.22; taken over with an attack
// of 0 (before MIN_TAKE_ATTACK) 31 to 35 notes of 39 stepped over it at Poly 1 to 8, 2.1 at the median, 5.2 at most
const CLICK = 0.5;
// (every note but the first sounds over the ones before: each has a step to measure)
const expectNoClick = (steps: number[]) => {
  expect(steps.length).toBeGreaterThanOrEqual(NOTES - 2);
  expect(Math.max(...steps)).toBeLessThan(CLICK);
};

const ATTACKS = [0, 0.001, 0.002, 0.005, 0.02];
const POLY = [1, 2, 4, 8, 32];
const SCENES = POLY.flatMap((poly) => ATTACKS.map((attack) => ({ poly, attack })));

describe('notes above Poly on the core: no click at their start', () => {
  it.each(SCENES)('Poly $poly, ENV 1 attack $attack s', async (scene) => {
    const { steps, alive, made } = await play(scene);
    expectNoClick(steps);
    // what it costs: a stolen voice that fades out under a new one is one voice over Poly, for its fade (20 ms at
    // most, less the quieter it is: gone before the next 16th); one taken over is no voice more, and none made
    const fades = scene.attack < MIN_TAKE_ATTACK;
    expect(alive).toBeLessThanOrEqual(Math.min(NOTES, scene.poly + (fades ? 1 : 0)));
    // (a voice sounds through its 16th and its release, 12 notes: at a Poly over that none is stolen, each note
    // has a voice of its own)
    expect(made).toBe(fades || scene.poly > 12 ? NOTES : scene.poly);
  });

  // an attack that rises within a few samples of its 2 ms, at its start (k 10) or at its end (k -10), is as sharp
  // as a shorter line (attackRise): the stolen voice fades out under a new one. Taken over through k 10 a note
  // stepped 0.57 of the level before it at Poly 4 and 0.49 at Poly 1 (0.28 and 0.32 on a new voice). The rise of
  // k -10 comes at the end of the attack, after the millisecond a step is measured in: held to the same rule, its
  // step not seen here
  it.each([
    { poly: 1, attack: MIN_TAKE_ATTACK, curve: 10 },
    { poly: 4, attack: MIN_TAKE_ATTACK, curve: 10 },
    { poly: 1, attack: MIN_TAKE_ATTACK, curve: -10 },
    { poly: 4, attack: MIN_TAKE_ATTACK, curve: -10 },
  ])('Poly $poly, ENV 1 attack 2 ms through a curve of $curve', async (scene) => {
    const { steps, alive, made } = await play(scene);
    expectNoClick(steps);
    expect(alive).toBeLessThanOrEqual(scene.poly + 1);
    expect(made).toBe(NOTES);
  });

  // the heavy patch: no note steps over CLICK, nor more than the notes do with no voice stolen (Poly 32: every
  // note a voice of its own). Measured: 0.88 to 1.03 of the largest step of that render, 0.30 to 0.37 of the level
  // before; taken over with an attack of 0 (before MIN_TAKE_ATTACK) 11 to 29 times it, 4.0 to 11.4 of the level
  describe.each([0, 0.001])('the heavy patch, ENV 1 attack %d s', (attack) => {
    let free: Promise<number>;
    beforeAll(() => {
      free = play({ poly: 32, attack, heavy: true }).then(({ jumps }) => Math.max(...jumps));
    });

    it.each([1, 2, 4, 8])('Poly %d', async (poly) => {
      const { steps, jumps, alive } = await play({ poly, attack, heavy: true });
      expectNoClick(steps);
      expect(Math.max(...jumps)).toBeLessThan(1.1 * (await free));
      expect(alive).toBeLessThanOrEqual(poly + 1);
    });
  });

  // in legato a note with no key held starts its envelopes as sharply: the voice in its release fades out by its
  // level, a voice more for that long only
  it.each([1, 4])('Poly %d in legato, staccato notes, attack 0', async (poly) => {
    const { steps, alive } = await play({ poly, attack: 0, length: CLIP_PPQ / 8, legato: true });
    expectNoClick(steps);
    expect(alive).toBeLessThanOrEqual(poly + 1);
  });

  // notes shorter than their step: a voice in its release is the one stolen
  it.each([1, 4])('Poly %d, staccato notes, attack 0', async (poly) => {
    const { steps } = await play({ poly, attack: 0, length: CLIP_PPQ / 8 });
    expectNoClick(steps);
  });
});
