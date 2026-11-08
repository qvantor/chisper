import toast from 'react-hot-toast';
import { registrar } from 'standardized-audio-context-mock';
import {
  CLIP_BAR,
  CLIP_LENGTH_MAX,
  CLIP_NOTES_MAX,
  CLIP_PPQ,
  Clip,
  ClipNote,
  clipHash,
} from '@chisper/preset-schema';
import { songFile } from '../../../../test-utils/midi-file';
import { createSynth, createTrack, stopModels } from '../../../../test-utils/models';
import { voiceEvents } from '../../../../test-utils/voice-events';
import { NoteOff, NoteOn, NoteSource } from '../../common/modules/input-controller';
import { getFq, midiToNote, noteToString, stringToNote } from '../../services';
import { writeMidiFile } from '../midi-file';
import { TRACK_LEAD } from './track';

// the wavetable oscillator loads its module asynchronously
const flush = () => new Promise((resolve) => setTimeout(resolve));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// a note of the clip: from beat `start`, `beats` long
const note = (start: number, beats: number, pitch = 60, velocity = 100): ClipNote => [
  start * CLIP_PPQ,
  beats * CLIP_PPQ,
  pitch,
  velocity,
];

const setup = async (loadClip?: (id: string) => Promise<{ id: string; clip: Clip; createdAt: string }>) => {
  const modules = createSynth();
  await flush();
  const { track, clock } = createTrack(modules, loadClip);
  const [{ audioCtx }] = modules.synthCore;
  const [model, actions] = track;
  const [transportModel, transportActions] = modules.transport;
  // the notes the track sent to the synth: `on C4 @0.05`
  const sent: string[] = [];
  const [{ $onPress, $onRelease }] = modules.inputController;
  const label = (kind: string, { note: played, at }: NoteOn | NoteOff) =>
    `${kind} ${noteToString(played)} @${at === undefined ? 'now' : +at.toFixed(4)}`;
  $onPress.subscribe((event) => event.source === 'track' && sent.push(label('on', event)));
  $onRelease.subscribe((event) => event.source === 'track' && sent.push(label('off', event)));
  const travel = async (seconds: number) => {
    await registrar.getDeLorean(audioCtx as never)?.travel(seconds);
  };
  // ticks of the player every 10 ms over `seconds`
  const play = async (seconds: number) => {
    for (let t = 0; t < seconds - 1e-9; t += 0.01) {
      await travel(0.01);
      clock.tick();
    }
  };
  return {
    ...modules,
    model,
    actions,
    transportModel,
    transportActions,
    audioCtx,
    clock,
    sent,
    travel,
    play,
  };
};

afterEach(() => {
  stopModels();
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('track', () => {
  describe('the player', () => {
    it('plays from beat 0 TRACK_LEAD from now: each note ahead of its time, at the time of its beat', async () => {
      const { actions, model, transportModel, clock, sent, play } = await setup();
      actions.setNotes([note(0, 0.5), note(1, 0.5, 64, 90)]);
      actions.play();
      expect(model.$playing.value).toBe(true);
      expect(transportModel.$playing.value).toBe(true);
      expect(clock.running).toBe(true);
      // at 120 BPM a beat is 0.5 s from TRACK_LEAD on
      expect(transportModel.timeAt(0)).toBeCloseTo(TRACK_LEAD, 9);

      await play(0.02);
      expect(sent).toEqual(['on C4 @0.05']);
      await play(0.5);
      expect(sent).toEqual(['on C4 @0.05', 'off C4 @0.3', 'on E4 @0.55']);
    });

    it('sends each note TRACK_LEAD ahead at most', async () => {
      const { actions, sent, play } = await setup();
      actions.setNotes([note(0.5, 0.25)]);
      actions.play();
      // the note at 0.3: sent once the clock is past 0.25
      await play(0.24);
      expect(sent).toEqual([]);
      await play(0.02);
      expect(sent).toEqual(['on C4 @0.3']);
    });

    it('plays the loop again: a note through its end released there, before the note at its start', async () => {
      const { actions, sent, play } = await setup();
      // (a clip of a .mid or of before: a note through the end of its loop)
      actions.restore({
        clip: { bpm: 120, length: CLIP_PPQ, notes: [note(0, 0.5), note(0.5, 2, 62)] },
        id: null,
        hash: null,
      });
      actions.play();
      await play(1.05);
      expect(sent).toEqual([
        'on C4 @0.05',
        'off C4 @0.3',
        'on D4 @0.3',
        // the end of the loop
        'off D4 @0.55',
        'on C4 @0.55',
        'off C4 @0.8',
        'on D4 @0.8',
        'off D4 @1.05',
        'on C4 @1.05',
      ]);
    });

    it('releases a note where the next one of its pitch starts', async () => {
      const { actions, sent, play } = await setup();
      actions.setNotes([note(0, 2), note(1, 0.5)]);
      actions.play();
      await play(0.8);
      expect(sent).toEqual(['on C4 @0.05', 'off C4 @0.55', 'on C4 @0.55', 'off C4 @0.8']);
    });

    it('after the page stood leaves out the notes that ended meanwhile, plays one that still sounds', async () => {
      const { actions, sent, play, travel, clock } = await setup();
      // C4 sounds before the stall, D4 starts and ends in it, E4 starts in it and sounds after
      actions.setNotes([note(0, 0.25), note(0.25, 0.25, 62), note(0.5, 2, 64)]);
      actions.play();
      await play(0.02);
      expect(sent).toEqual(['on C4 @0.05']);
      // a long task: no tick for 0.4 s
      await travel(0.4);
      clock.tick();
      expect(sent).toEqual(['on C4 @0.05', 'off C4 @0.175', 'on E4 @0.3']);
      await play(0.9);
      expect(sent).toEqual(['on C4 @0.05', 'off C4 @0.175', 'on E4 @0.3', 'off E4 @1.3']);
    });

    it('in Poly 1 a chord plays its lowest note, a melody over it goes back there, released on its own note', async () => {
      const { actions, synth, synthCore, audioCtx, sent, play } = await setup();
      const [, synthActions] = synth;
      synthActions.setMaxVoices(1);
      synthActions.setLegato(true);
      synthActions.setPortamento(0);
      const { voices } = voiceEvents(audioCtx, synthCore[0].wavetables);
      // a chord of C3, E4 and G5 over 2 beats (G5 a half), E5 and A5 over it; A5 ends with the chord
      actions.setNotes([
        note(0, 2, 48),
        note(0, 2, 64),
        note(0, 0.5, 79),
        note(1, 0.25, 76),
        note(1.5, 0.5, 81),
      ]);
      actions.play();
      await play(1.1);
      expect(sent).toEqual([
        // the ons of a tick from the highest pitch down: the last one pressed (the lowest) plays
        'on G5 @0.05',
        'on E4 @0.05',
        'on C3 @0.05',
        'off G5 @0.3',
        'on E5 @0.55',
        'off E5 @0.675',
        'on A5 @0.8',
        // the offs of a tick in the order their notes were pressed: the key on top of the stack last
        'off E4 @1.05',
        'off C3 @1.05',
        'off A5 @1.05',
      ]);

      expect(voices()).toHaveLength(1);
      const [voice] = voices();
      const fq = (pitch: number) => Math.fround(getFq(midiToNote(pitch)));
      expect(voice.values.frequency).toBe(fq(79));
      const steps = (voice.params.frequency.setValueAtTime as jest.Mock).mock.calls;
      // G5 under E4, then C3 at once; E5 over it, back to C3, then A5, which it is released on: no step there
      expect(steps).toEqual([
        [fq(64), expect.closeTo(0.05, 9)],
        [fq(48), expect.closeTo(0.05, 9)],
        [fq(76), expect.closeTo(0.55, 9)],
        [fq(48), expect.closeTo(0.675, 9)],
        [fq(81), expect.closeTo(0.8, 9)],
      ]);
      const gates = (voice.params.gate.setValueAtTime as jest.Mock).mock.calls;
      expect(gates).toEqual([[expect.any(Number), expect.closeTo(1.05, 9)]]);
    });

    it('a new tempo plays from the next notes on', async () => {
      const { actions, transportModel, transportActions, sent, play } = await setup();
      actions.setNotes([note(0, 0.25), note(1, 0.25, 62), note(2, 0.25, 64)]);
      actions.play();
      await play(0.3);
      expect(sent).toEqual(['on C4 @0.05', 'off C4 @0.175']);
      // 60 BPM from now + LFO_LEAD on, at the beat the transport is at there
      transportActions.setBpm(60);
      await play(2);
      const time = (event: string) => Number(sent.find((item) => item.startsWith(event))?.split('@')[1]);
      expect(time('on D4')).toBeCloseTo(transportModel.timeAt(1), 6);
      // a beat a second from then on
      expect(time('on E4') - time('on D4')).toBeCloseTo(1, 6);
      expect(time('off D4') - time('on D4')).toBeCloseTo(0.25, 6);
    });

    it('Stop releases what it holds now and sends nothing more', async () => {
      const { actions, model, transportModel, clock, sent, play } = await setup();
      actions.setNotes([note(0, 4)]);
      actions.play();
      await play(0.1);
      actions.stop();
      expect(sent).toEqual(['on C4 @0.05', 'off C4 @now']);
      expect(model.$playing.value).toBe(false);
      expect(transportModel.$playing.value).toBe(false);
      expect(clock.running).toBe(false);
      await play(0.5);
      expect(sent).toHaveLength(2);
    });

    it('Play again starts from beat 0', async () => {
      const { actions, sent, play } = await setup();
      actions.setNotes([note(0, 0.25)]);
      actions.play();
      await play(0.1);
      actions.stop();
      await play(0.2);
      actions.play();
      await play(0.05);
      expect(sent.at(-1)).toBe('on C4 @0.35');
    });

    it('plays from a bar: its notes first, TRACK_LEAD from now', async () => {
      const { actions, model, transportModel, sent, play } = await setup();
      actions.setNotes([note(0, 0.5), note(8, 0.5, 67)]);
      actions.playFrom(8);
      expect(model.$playing.value).toBe(true);
      expect(transportModel.beatAt(TRACK_LEAD)).toBeCloseTo(8, 9);
      await play(0.02);
      expect(sent).toEqual(['on G4 @0.05']);
    });

    it('plays from a bar while it plays: what it holds goes there, the bar plays from then', async () => {
      const { actions, transportModel, sent, play, audioCtx } = await setup();
      actions.setNotes([note(0, 4), note(4, 0.5, 64)]);
      actions.play();
      await play(0.1);
      expect(sent).toEqual(['on C4 @0.05']);
      const time = audioCtx.currentTime + TRACK_LEAD;
      const at = +time.toFixed(4);
      actions.playFrom(4);
      expect(transportModel.beatAt(time)).toBeCloseTo(4, 6);
      await play(0.02);
      expect(sent).toEqual(['on C4 @0.05', `off C4 @${at}`, `on E4 @${at}`]);
    });

    it('releases a note it holds that an edit took away, at the time it sent the notes up to', async () => {
      const { actions, sent, play, audioCtx } = await setup();
      actions.setNotes([note(0, 4), note(0, 4, 64)]);
      actions.play();
      await play(0.1);
      actions.setNotes([note(0, 4, 64)]);
      const off = sent.at(-1) ?? '';
      expect(off).toMatch(/^off C4 @/);
      expect(Number(off.split('@')[1])).toBeCloseTo(audioCtx.currentTime + TRACK_LEAD, 2);
      expect(sent.filter((event) => event.startsWith('off E4'))).toEqual([]);
    });

    it('lights the notes the output plays', async () => {
      const { actions, model, play } = await setup();
      actions.setNotes([note(0, 0.5), note(0, 1, 67)]);
      actions.play();
      expect(model.$sounding.value).toEqual([]);
      await play(0.2);
      expect(model.$sounding.value).toEqual([60, 67]);
      await play(0.25);
      expect(model.$sounding.value).toEqual([67]);
      actions.stop();
      expect(model.$sounding.value).toEqual([]);
    });

    it('tells the position the output plays (none before the start)', async () => {
      const { actions, model, play, transportModel } = await setup();
      actions.setNotes([note(0, 1)]);
      expect(model.positionAt()).toBeNull();
      actions.play();
      expect(model.positionAt()).toBeNull();
      await play(0.3);
      // 0.25 s past the start at 120 BPM: half a beat, where the output plays (the latency before it)
      const ms = performance.now();
      const output = transportModel.contextTimeAt(ms);
      expect(output).toBeLessThan(0.3);
      // (the clock of the output of the mock moves between two calls)
      expect(model.positionAt(ms)).toBeCloseTo((output - TRACK_LEAD) * 2 * CLIP_PPQ, 0);
    });

    describe('led by a MIDI Clock', () => {
      it('Play arms it: a Start plays it from the beat the next clock locates, a Stop stops it', async () => {
        const { actions, model, transportActions, sent, play, audioCtx } = await setup();
        transportActions.setSource('midi');
        actions.setNotes([note(0, 0.5)]);
        actions.play();
        expect(model.$armed.value).toBe(true);
        expect(model.$playing.value).toBe(false);
        await play(0.1);
        expect(sent).toEqual([]);

        // Start: playing, waiting for the clock
        transportActions.setPlaying(true);
        expect(model.$playing.value).toBe(true);
        await play(0.05);
        expect(sent).toEqual([]);
        const at = audioCtx.currentTime + 0.02;
        transportActions.locate(0, at);
        await play(0.03);
        expect(sent).toEqual([`on C4 @${+at.toFixed(4)}`]);

        transportActions.setPlaying(false);
        expect(model.$playing.value).toBe(false);
        expect(model.$armed.value).toBe(true);
        expect(sent.at(-1)).toBe('off C4 @now');
      });

      it('plays from a bar: armed only, the clock places the transport', async () => {
        const { actions, model, transportModel, transportActions } = await setup();
        transportActions.setSource('midi');
        const beat = transportModel.beatAt(1);
        actions.playFrom(8);
        expect(model.$armed.value).toBe(true);
        expect(model.$playing.value).toBe(false);
        expect(transportModel.beatAt(1)).toBe(beat);
      });

      it('a Song Position plays the loop from the position modulo its length', async () => {
        const { actions, transportActions, sent, play, audioCtx } = await setup();
        transportActions.setSource('midi');
        actions.setLength(CLIP_BAR);
        actions.setNotes([note(2, 0.5, 62)]);
        actions.play();
        transportActions.setPlaying(true);
        const at = audioCtx.currentTime + 0.02;
        // beat 6: beat 2 of the loop of 4
        transportActions.locate(6, at);
        await play(0.05);
        expect(sent).toEqual([`on D4 @${+at.toFixed(4)}`]);
      });

      it('a Song Position while the clock stands: its Continue plays from there once the clock locates it', async () => {
        const { actions, model, transportActions, sent, play, audioCtx } = await setup();
        transportActions.setSource('midi');
        actions.setLength(CLIP_BAR);
        actions.setNotes([note(0, 0.5), note(2, 0.5, 62)]);
        // REC: armed, the loop doesn't run on
        actions.record();
        // the DAW stopped: a Song Position at beat 6 (beat 2 of the loop of 4), the transport goes on
        transportActions.locate(6, audioCtx.currentTime + 0.02);
        await play(2);
        expect(sent).toEqual([]);

        // Continue: playing, waiting for the clock (not the notes since the Song Position at once)
        transportActions.setPlaying(true);
        expect(model.$playing.value).toBe(true);
        await play(0.05);
        expect(sent).toEqual([]);
        const at = audioCtx.currentTime + 0.02;
        transportActions.locate(6, at);
        await play(0.05);
        expect(sent).toEqual([`on D4 @${+at.toFixed(4)}`]);
        expect(model.$clip.value.length).toBe(CLIP_BAR);
      });

      it('Play while the clock plays starts from where the transport is', async () => {
        const { actions, model, transportActions, sent, play } = await setup();
        transportActions.setSource('midi');
        transportActions.setPlaying(true);
        actions.setLength(CLIP_PPQ);
        actions.setNotes([note(0, 0.5)]);
        actions.play();
        expect(model.$playing.value).toBe(true);
        await play(0.6);
        expect(sent.length).toBeGreaterThan(0);
      });

      it('the clock lost: Play goes off', async () => {
        const { actions, model, transportActions } = await setup();
        transportActions.setSource('midi');
        actions.play();
        transportActions.setPlaying(true);
        transportActions.setPlaying(false);
        transportActions.setSource('internal');
        expect(model.$armed.value).toBe(false);
      });
    });

    it('goes on through a preset switch: its notes wait as keys do', async () => {
      const { actions, synth, sent, play } = await setup();
      actions.setNotes([note(0, 0.25), note(0.5, 2, 62)]);
      actions.play();
      synth[1].pause();
      await play(0.4);
      // C4 came and went while it waited, D4 is held: it starts on the next preset
      expect(synth[0].$voicesCount.value).toBe(0);
      synth[1].resume();
      expect(sent).toEqual(['on C4 @0.05', 'off C4 @0.175', 'on D4 @0.3']);
      expect(synth[0].$voicesCount.value).toBe(1);
    });
  });

  describe('recording', () => {
    // a still clock of the page: the output plays the time of the context less its latency (the mock has no output
    // stamp), the same at every call
    beforeEach(() => jest.spyOn(performance, 'now').mockReturnValue(1000));
    afterEach(() => jest.restoreAllMocks());

    const rec = async () => {
      const context = await setup();
      const {
        audioCtx,
        transportModel,
        inputController: [, { onPress, onRelease }],
      } = context;
      // the tick (from beat 0, over the loops) the output plays now
      const heard = () =>
        Math.round(transportModel.beatAt(audioCtx.currentTime - audioCtx.baseLatency) * CLIP_PPQ);
      const press = (name: string, velocity = 100, source: NoteSource = 'keys') =>
        onPress(stringToNote(name), velocity, { source });
      const release = (name: string, source: NoteSource = 'keys') =>
        onRelease(stringToNote(name), { source });
      return { ...context, heard, press, release };
    };

    it('REC from a stop plays from beat 0, Stop stops both; while it plays REC switches only the recording', async () => {
      const { actions, model, transportModel, play } = await rec();
      actions.record();
      expect(model.$recording.value).toBe(true);
      expect(model.$armed.value).toBe(true);
      expect(model.$playing.value).toBe(true);
      expect(transportModel.timeAt(0)).toBeCloseTo(TRACK_LEAD, 9);
      await play(0.3);
      actions.stopRecording();
      expect(model.$recording.value).toBe(false);
      expect(model.$playing.value).toBe(true);
      actions.toggleRecording();
      expect(model.$recording.value).toBe(true);
      // (the track goes on from where it is)
      expect(transportModel.timeAt(0)).toBeCloseTo(TRACK_LEAD, 9);
      actions.stop();
      expect(model.$recording.value).toBe(false);
      expect(model.$armed.value).toBe(false);
      expect(model.$playing.value).toBe(false);
    });

    it('records the notes of the keys and MIDI where the output played them, at their velocity; not the track nor the roll', async () => {
      const { actions, model, play, heard, press, release, sent } = await rec();
      actions.setNotes([note(1, 0.25, 72)]);
      actions.record();
      await play(0.2);
      const start = heard();
      press('C4');
      press('E4', 64, 'midi');
      press('G4', 100, 'roll');
      await play(0.25);
      const end = heard();
      release('C4');
      release('E4', 'midi');
      release('G4', 'roll');
      // the track plays its C5 meanwhile
      await play(0.4);
      expect(sent).toContain('on C5 @0.55');
      expect(model.$clip.value.notes).toEqual([
        [start, end - start, 60, 100],
        [start, end - start, 64, 64],
        note(1, 0.25, 72),
      ]);
    });

    it('takes no note pressed before REC; one pressed before the play starts goes to its start', async () => {
      const { actions, model, play, heard, press, release } = await rec();
      press('E4');
      actions.record();
      // (the output plays the start TRACK_LEAD and its latency from now)
      press('C4');
      await play(0.2);
      const end = heard();
      release('C4');
      release('E4');
      expect(model.$clip.value.notes).toEqual([[0, end, 60, 100]]);
    });

    it('the notes held go in up to where the output plays as REC goes off, on Stop, as it plays from a bar', async () => {
      const { actions, model, play, heard, press, release } = await rec();
      const notes = () => model.$clip.value.notes;
      actions.record();
      await play(0.2);
      const c = heard();
      press('C4');
      await play(0.1);
      actions.stopRecording();
      expect(notes()).toEqual([[c, heard() - c, 60, 100]]);
      // released after: nothing more
      release('C4');
      expect(notes()).toHaveLength(1);

      actions.record();
      await play(0.1);
      const d = heard();
      press('D4');
      await play(0.1);
      const dEnd = heard();
      actions.playFrom(0);
      expect(notes()).toContainEqual([d, dEnd - d, 62, 100]);
      release('D4');
      expect(notes()).toHaveLength(2);

      await play(0.2);
      const e = heard();
      press('E4');
      await play(0.1);
      const eEnd = heard();
      actions.stop();
      expect(notes()).toContainEqual([e, eEnd - e, 64, 100]);
      expect(notes()).toHaveLength(3);
    });

    it('runs the loop on while REC records: the bar after its end joins it as the player comes to it', async () => {
      const { actions, model, play, heard, press, release, sent } = await rec();
      const ons = (name: string) => sent.filter((event) => event.startsWith(`on ${name} `)).length;
      // a loop of a beat (half a second), D4 at its start
      actions.setLength(CLIP_PPQ);
      actions.setNotes([note(0, 0.25, 62)]);
      actions.record();
      await play(0.4);
      expect(model.$clip.value.length).toBe(CLIP_PPQ);
      const start = heard();
      press('C4');
      // the notes would be sent past its end (0.55 s, TRACK_LEAD ahead): it takes the bar
      await play(0.15);
      expect(model.$clip.value.length).toBe(CLIP_BAR);
      await play(0.2);
      const end = heard();
      release('C4');
      // a note held over its end goes on; it doesn't go round: D4 played once, the output past the beat
      expect(end).toBeGreaterThan(CLIP_PPQ);
      expect(model.$clip.value.notes).toEqual([note(0, 0.25, 62), [start, end - start, 60, 100]]);
      expect(ons('D4')).toBe(1);
      expect(model.positionAt()).toBeGreaterThan(CLIP_PPQ);
      // the next bar as the player comes to the end of this one (2 s)
      await play(1.4);
      expect(model.$clip.value.length).toBe(2 * CLIP_BAR);
      // REC off: the loop as it ran on, it goes round at its end (4 s), C4 played by the track there
      actions.stopRecording();
      await play(2.4);
      expect(model.$clip.value.length).toBe(2 * CLIP_BAR);
      expect(ons('D4')).toBe(2);
      expect(ons('C4')).toBe(1);
      // the take: its notes and the bars it ran on, one step of the undo
      actions.undo();
      expect(model.$clip.value).toMatchObject({ length: CLIP_PPQ, notes: [note(0, 0.25, 62)] });
    });

    it('runs the loop on from the pass REC starts in: the position goes on, its notes where they were heard', async () => {
      const { actions, model, play, heard, press, release, sent } = await rec();
      actions.setLength(CLIP_PPQ);
      actions.setNotes([note(0, 0.25, 62)]);
      actions.play();
      // the third pass (from 1.05 s)
      await play(1.2);
      const before = model.positionAt() as number;
      actions.record();
      await play(0.1);
      const start = heard();
      press('C4');
      // its end (1.55 s): the bar from the start of this pass
      await play(0.4);
      const end = heard();
      release('C4');
      expect(model.$clip.value.length).toBe(CLIP_BAR);
      const position = model.positionAt() as number;
      expect(position).toBeCloseTo(before + 0.5 * 2 * CLIP_PPQ, 6);
      expect(position).toBeGreaterThan(CLIP_PPQ);
      expect(sent.filter((event) => event.startsWith('on D4'))).toHaveLength(3);
      expect(model.$clip.value.notes).toEqual([
        note(0, 0.25, 62),
        [start - 2 * CLIP_PPQ, end - start, 60, 100],
      ]);
      // played again: from beat 0, its tick 0
      actions.stop();
      actions.play();
      await play(0.3);
      expect(Math.round(model.positionAt() as number)).toBe(heard());
    });

    it('goes round at the longest loop: a note held through its end ends there', async () => {
      const { actions, model, play, heard, press, release } = await rec();
      actions.setLength(CLIP_LENGTH_MAX);
      // its last beat
      actions.playFrom(CLIP_LENGTH_MAX / CLIP_PPQ - 1);
      actions.record();
      await play(0.3);
      const start = heard();
      press('C4');
      await play(0.4);
      release('C4');
      expect(model.$clip.value.length).toBe(CLIP_LENGTH_MAX);
      expect(model.$clip.value.notes).toEqual([[start, CLIP_LENGTH_MAX - start, 60, 100]]);
      expect(model.positionAt()).toBeLessThan(CLIP_PPQ);
    });

    it('a drag of the notes keeps the loop REC ran on meanwhile, given up too', async () => {
      const { actions, model, play } = await rec();
      const length = () => model.$clip.value.length;
      actions.setLength(CLIP_PPQ);
      actions.setNotes([note(0, 0.25, 62)]);
      actions.record();
      await play(0.3);
      actions.startGesture();
      actions.moveGesture([note(0.25, 0.25, 62)]);
      await play(0.3);
      expect(length()).toBe(CLIP_BAR);
      actions.moveGesture([note(0.5, 0.25, 62)]);
      expect(length()).toBe(CLIP_BAR);
      actions.cancelGesture();
      expect(model.$clip.value).toMatchObject({ length: CLIP_BAR, notes: [note(0, 0.25, 62)] });
      actions.startGesture();
      actions.moveGesture([note(0.5, 0.25, 62)]);
      actions.endGesture();
      expect(model.$clip.value).toMatchObject({ length: CLIP_BAR, notes: [note(0.5, 0.25, 62)] });
    });

    it('a take is one step of the undo; an edit or an undo between its notes starts another', async () => {
      const { actions, model, play, press, release } = await rec();
      const pitches = () => model.$clip.value.notes.map(([, , pitch]) => pitch);
      const tap = async (name: string) => {
        press(name);
        await play(0.05);
        release(name);
        await play(0.05);
      };
      actions.setNotes([note(4, 1, 72)]);
      actions.record();
      await play(0.1);
      await tap('C4');
      await tap('D4');
      expect(model.$history.value.past).toHaveLength(2);
      expect(pitches()).toEqual([60, 62, 72]);
      actions.undo();
      expect(pitches()).toEqual([72]);
      // after the undo: another step
      await tap('E4');
      expect(model.$history.value.past).toHaveLength(2);
      // an edit between: another step
      actions.setNotes(
        model.$clip.value.notes.map(([start, duration, pitch]): ClipNote => [start, duration, pitch, 80])
      );
      await tap('F4');
      expect(model.$history.value.past).toHaveLength(4);
      // REC again: a new take
      actions.stopRecording();
      actions.record();
      await tap('G4');
      expect(model.$history.value.past).toHaveLength(5);
      actions.undo();
      actions.undo();
      actions.undo();
      expect(model.$clip.value.notes).toEqual([expect.arrayContaining([64, 100]), note(4, 1, 72)]);
    });

    it('notes recorded while a drag edits the notes go in once it ends, given up too', async () => {
      const { actions, model, play, press, release } = await rec();
      const pitches = () => model.$clip.value.notes.map(([, , pitch]) => pitch);
      const tap = async (name: string) => {
        press(name);
        await play(0.05);
        release(name);
      };
      actions.setNotes([note(4, 1, 72)]);
      actions.record();
      await play(0.1);
      actions.startGesture();
      actions.moveGesture([note(5, 1, 72)]);
      await tap('C4');
      actions.moveGesture([note(6, 1, 72)]);
      expect(pitches()).toEqual([72]);
      actions.endGesture();
      expect(pitches()).toEqual([60, 72]);
      expect(model.$clip.value.notes[1]).toEqual(note(6, 1, 72));

      const [recorded] = model.$clip.value.notes;
      actions.startGesture();
      actions.moveGesture([recorded, note(7, 1, 72)]);
      await tap('D4');
      actions.cancelGesture();
      expect(pitches()).toEqual([60, 62, 72]);
      expect(model.$clip.value.notes[2]).toEqual(note(6, 1, 72));
      // the take: one step after the drag
      actions.undo();
      expect(model.$clip.value.notes).toEqual([note(6, 1, 72)]);
      actions.undo();
      expect(model.$clip.value.notes).toEqual([note(4, 1, 72)]);
    });

    it('led by a MIDI Clock REC arms it: it records once the Start plays it; its Stop keeps REC on', async () => {
      const { actions, model, transportActions, play, heard, press, release, audioCtx } = await rec();
      transportActions.setSource('midi');
      actions.record();
      expect(model.$armed.value).toBe(true);
      expect(model.$playing.value).toBe(false);
      press('C4');
      await play(0.1);
      release('C4');
      // Start: waiting for the clock
      transportActions.setPlaying(true);
      press('D4');
      await play(0.05);
      release('D4');
      expect(model.$clip.value.notes).toEqual([]);

      transportActions.locate(0, audioCtx.currentTime + 0.02);
      await play(0.1);
      const e = heard();
      press('E4');
      await play(0.1);
      const end = heard();
      // Stop: the note held goes in
      transportActions.setPlaying(false);
      expect(model.$clip.value.notes).toEqual([[e, end - e, 64, 100]]);
      expect(model.$recording.value).toBe(true);
    });

    it('records no note past the most notes: tells it once a take', async () => {
      const { actions, model, play, press, release } = await rec();
      actions.setNotes(Array.from({ length: CLIP_NOTES_MAX }, (_, i): ClipNote => [i * 2, 1, 40, 100]));
      actions.record();
      await play(0.1);
      for (const name of ['C4', 'D4']) {
        press(name);
        await play(0.05);
        release(name);
      }
      expect(model.$clip.value.notes).toHaveLength(CLIP_NOTES_MAX);
      expect(model.$clip.value.notes.some(([, , pitch]) => pitch === 60)).toBe(false);
      expect(toast).toHaveBeenCalledTimes(1);
    });

    it('shows the notes held growing up to where the output plays', async () => {
      const { actions, model, play, heard, press, release } = await rec();
      actions.record();
      await play(0.2);
      const start = heard();
      press('C4', 90);
      expect(model.recordingNotes()).toEqual([[start, 1, 60, 90]]);
      await play(0.1);
      expect(model.recordingNotes()).toEqual([[start, heard() - start, 60, 90]]);
      release('C4');
      expect(model.recordingNotes()).toEqual([]);
    });

    it('a clip opened while a note is held takes none of it', async () => {
      const { actions, model, play, press, release } = await rec();
      actions.record();
      await play(0.1);
      press('C4');
      await play(0.1);
      actions.restore({ clip: { bpm: 120, length: CLIP_BAR, notes: [] }, id: null, hash: null });
      release('C4');
      expect(model.$clip.value.notes).toEqual([]);
    });
  });

  describe('the clip', () => {
    it('undoes and redoes the edits of the notes and the length', async () => {
      const { actions, model } = await setup();
      actions.setNotes([note(0, 1)]);
      actions.setNotes([note(0, 1), note(1, 1)]);
      actions.setLength(CLIP_PPQ);
      expect(model.$clip.value.notes).toEqual([note(0, 1)]);
      actions.undo();
      expect(model.$clip.value).toMatchObject({ length: 4 * CLIP_BAR, notes: [note(0, 1), note(1, 1)] });
      actions.undo();
      expect(model.$clip.value.notes).toEqual([note(0, 1)]);
      actions.redo();
      expect(model.$clip.value.notes).toEqual([note(0, 1), note(1, 1)]);
      actions.setNotes([]);
      actions.redo();
      expect(model.$clip.value.notes).toEqual([]);
    });

    it('a drag is one step of the undo, none when it moved nothing', async () => {
      const { actions, model } = await setup();
      actions.setNotes([note(0, 1)]);
      actions.startGesture();
      actions.moveGesture([note(0, 1)]);
      actions.endGesture();
      expect(model.$history.value.past).toHaveLength(1);
      actions.startGesture();
      actions.moveGesture([note(1, 1)]);
      actions.moveGesture([note(2, 1)]);
      actions.endGesture();
      expect(model.$history.value.past).toHaveLength(2);
      actions.undo();
      expect(model.$clip.value.notes).toEqual([note(0, 1)]);
    });

    it('its loop follows the notes: 4 bars, longer to the end of their bar; its flag sets it apart', async () => {
      const { actions, model } = await setup();
      // a new clip: 4 bars
      expect(model.$clip.value.length).toBe(4 * CLIP_BAR);
      actions.setNotes([note(8, 1)]);
      expect(model.$clip.value.length).toBe(4 * CLIP_BAR);
      // a note in bar 6: to its end; taken away, 4 bars again
      actions.setNotes([note(0, 1), note(20, 1)]);
      expect(model.$clip.value.length).toBe(6 * CLIP_BAR);
      actions.setNotes([note(0, 1)]);
      expect(model.$clip.value.length).toBe(4 * CLIP_BAR);
      // a loop of 2 bars by its flag: kept by the edits within it, a note past it takes it to the end of its bar
      actions.setLength(2 * CLIP_BAR);
      actions.setNotes([note(0, 1), note(4, 1)]);
      expect(model.$clip.value.length).toBe(2 * CLIP_BAR);
      actions.setNotes([note(0, 1), note(8, 1)]);
      expect(model.$clip.value.length).toBe(3 * CLIP_BAR);
      // a drag: by the notes as they are, from the loop before it
      actions.startGesture();
      actions.moveGesture([note(0, 1), note(28, 1)]);
      expect(model.$clip.value.length).toBe(8 * CLIP_BAR);
      actions.moveGesture([note(0, 1), note(4, 1)]);
      expect(model.$clip.value.length).toBe(3 * CLIP_BAR);
      actions.endGesture();
      // the flag before a note: it ends there; a new clip is 4 bars again
      actions.setNotes([note(0, 6)]);
      actions.setLength(CLIP_BAR);
      expect(model.$clip.value.notes).toEqual([note(0, 4)]);
      actions.newClip();
      expect(model.$clip.value).toMatchObject({ length: 4 * CLIP_BAR, notes: [] });
    });

    it('a drag given up puts back the notes and the undo as they were', async () => {
      const { actions, model } = await setup();
      actions.setNotes([note(0, 1)]);
      actions.setNotes([note(1, 1)]);
      actions.undo();
      const history = model.$history.value;
      actions.startGesture();
      actions.moveGesture([note(2, 1)]);
      actions.moveGesture([note(3, 1)]);
      actions.cancelGesture();
      expect(model.$clip.value.notes).toEqual([note(0, 1)]);
      expect(model.$history.value).toBe(history);
      // nothing moved: nothing to put back
      actions.startGesture();
      actions.cancelGesture();
      expect(model.$history.value).toBe(history);
      actions.redo();
      expect(model.$clip.value.notes).toEqual([note(1, 1)]);
    });

    it('its tempo is the tempo of the synth', async () => {
      const { model, transportModel, transportActions } = await setup();
      transportActions.setBpm(97.5);
      expect(transportModel.$bpm.value).toBe(97.5);
      expect(model.$clip.value.bpm).toBe(97.5);
    });

    it('is dirty once it has notes, clean once saved, dirty again on an edit', async () => {
      const { actions, model } = await setup();
      expect(model.$dirty.value).toBe(false);
      actions.setNotes([note(0, 1)]);
      await wait(150);
      expect(model.$dirty.value).toBe(true);
      actions.setSaved('c1', model.$clip.value);
      await wait(150);
      expect(model.$dirty.value).toBe(false);
      expect(window.location.search).toBe('?clip=c1');
      actions.setNotes([note(0, 2)]);
      await wait(150);
      expect(model.$dirty.value).toBe(true);
    });

    it('saved with the notes sent: an edit made while they went stays dirty', async () => {
      const { actions, model } = await setup();
      actions.setNotes([note(0, 1)]);
      const sent = model.$clip.value;
      actions.setNotes([note(0, 1), note(1, 1, 64)]);
      actions.setSaved('c1', sent);
      expect(model.$savedHash.value).toBe(clipHash(sent));
      await wait(150);
      expect(model.$dirty.value).toBe(true);
      actions.setNotes([note(0, 1)]);
      await wait(150);
      expect(model.$dirty.value).toBe(false);
    });

    it('under a name the filter refuses: dirty and clean as any other', async () => {
      const { actions, model } = await setup();
      actions.setNotes([note(0, 1)]);
      actions.setName('Sexy pad');
      await wait(150);
      expect(model.$dirty.value).toBe(true);
      actions.setSaved('c1', model.$clip.value);
      await wait(150);
      expect(model.$dirty.value).toBe(false);
      actions.setNotes([note(0, 2)]);
      await wait(150);
      expect(model.$dirty.value).toBe(true);
    });

    it('a new clip is empty, out of the url; it can be undone', async () => {
      const { actions, model } = await setup();
      actions.setNotes([note(0, 1)]);
      actions.setName('Bass');
      actions.setSaved('c1', model.$clip.value);
      actions.newClip();
      expect(model.$clip.value.notes).toEqual([]);
      expect(model.$clip.value.name).toBeUndefined();
      expect(model.$id.value).toBeNull();
      expect(window.location.search).toBe('');
      actions.undo();
      expect(model.$clip.value.notes).toEqual([note(0, 1)]);
    });

    it('imports a MIDI file: its notes, its length, its name and its tempo', async () => {
      const { actions, model, transportModel } = await setup();
      const bytes = writeMidiFile({ bpm: 140, length: CLIP_BAR, notes: [note(0, 1, 48)], name: 'Riff' });
      expect(actions.importMidi(bytes)).toBe(true);
      expect(model.$clip.value).toEqual({
        bpm: 140,
        length: CLIP_BAR,
        notes: [note(0, 1, 48)],
        name: 'Riff',
      });
      expect(transportModel.$bpm.value).toBe(140);
      actions.undo();
      expect(model.$clip.value.notes).toEqual([]);
      expect(actions.importMidi(new Uint8Array([1, 2, 3]))).toBe(false);
    });

    it('a MIDI file of several parts waits for those to import, then imports them in one step of the undo', async () => {
      const { actions, model, transportModel } = await setup();
      actions.setNotes([note(0, 1)]);
      const bytes = songFile(
        [
          { name: 'Lead', notes: [note(0, 1, 72)] },
          { name: 'Bass', notes: [note(0, 2, 36, 80)] },
        ],
        140
      );
      expect(actions.importMidi(bytes)).toBe(true);
      // nothing yet
      expect(model.$clip.value.notes).toEqual([note(0, 1)]);
      expect(transportModel.$bpm.value).toBe(120);
      expect(model.$midiImport.value?.parts.map(({ name }) => name)).toEqual(['Lead', 'Bass']);
      actions.importParts([1]);
      expect(model.$midiImport.value).toBeNull();
      expect(model.$clip.value).toEqual({
        bpm: 140,
        length: CLIP_BAR,
        notes: [note(0, 2, 36, 80)],
        name: 'Bass',
      });
      expect(transportModel.$bpm.value).toBe(140);
      actions.undo();
      expect(model.$clip.value.notes).toEqual([note(0, 1)]);
    });

    it('a MIDI file is a new clip: not saved, out of the url, without the name of the clip before', async () => {
      const { actions, model } = await setup();
      actions.setNotes([note(0, 1)]);
      actions.setName('Bass');
      actions.setSaved('c1', model.$clip.value);
      actions.importMidi(writeMidiFile({ bpm: 120, length: CLIP_BAR, notes: [note(0, 1, 48)] }));
      expect(model.$clip.value.notes).toEqual([note(0, 1, 48)]);
      expect(model.$clip.value.name).toBeUndefined();
      expect(model.$id.value).toBeNull();
      expect(model.$savedHash.value).toBeNull();
      expect(window.location.search).toBe('');
      await wait(150);
      expect(model.$dirty.value).toBe(true);

      // its parts chosen: the same, the name of the part
      actions.setSaved('c2', model.$clip.value);
      actions.importMidi(
        songFile([
          { name: 'Lead', notes: [note(0, 1, 72)] },
          { name: 'Bass', notes: [note(0, 2, 36)] },
        ])
      );
      actions.importParts([0]);
      expect(model.$clip.value.name).toBe('Lead');
      expect(model.$id.value).toBeNull();
      expect(window.location.search).toBe('');
    });

    it('a MIDI file of several parts given up or the roll closed imports nothing', async () => {
      const { actions, model } = await setup();
      const bytes = songFile([
        { name: 'Lead', notes: [note(0, 1, 72)] },
        { name: 'Drums', channel: 10, notes: [note(0, 1, 36)] },
      ]);
      actions.importMidi(bytes);
      expect(model.$midiImport.value?.parts.map(({ drums }) => drums)).toEqual([false, true]);
      actions.cancelImport();
      expect(model.$midiImport.value).toBeNull();
      actions.setRollOpen(true);
      actions.importMidi(bytes);
      actions.toggleRoll();
      expect(model.$rollOpen.value).toBe(false);
      expect(model.$midiImport.value).toBeNull();
      // nothing waiting: nothing to import
      actions.importParts([0]);
      expect(model.$clip.value.notes).toEqual([]);
      actions.undo();
      expect(model.$clip.value.notes).toEqual([]);
    });

    it('a MIDI file keeps the tempo a MIDI Clock leads', async () => {
      const { actions, transportModel, transportActions } = await setup();
      transportActions.setSource('midi');
      actions.importMidi(writeMidiFile({ bpm: 140, length: CLIP_BAR, notes: [] }));
      expect(transportModel.$bpm.value).toBe(120);
    });
  });

  describe('the link and the tab', () => {
    const saved: Clip = { bpm: 90, length: CLIP_BAR, notes: [note(0, 1, 50)], name: 'Linked' };

    it('opens the clip of the link with its tempo', async () => {
      window.history.replaceState(null, '', '/?clip=c9');
      const loadClip = jest.fn().mockResolvedValue({ id: 'c9', clip: saved, createdAt: '' });
      const { model, transportModel } = await setup(loadClip);
      await flush();
      expect(loadClip).toHaveBeenCalledWith('c9');
      expect(model.$clip.value).toEqual(saved);
      expect(model.$id.value).toBe('c9');
      expect(model.$savedHash.value).toBe(clipHash(saved));
      expect(transportModel.$bpm.value).toBe(90);
    });

    it('a clip of the link that is not found leaves an empty clip', async () => {
      window.history.replaceState(null, '', '/?clip=gone');
      const { model } = await setup();
      await flush();
      expect(model.$clip.value.notes).toEqual([]);
    });

    it('keeps the clip in the tab: a reload restores it, not the clip of the server', async () => {
      const first = await setup();
      first.actions.setNotes([note(0, 1, 70)]);
      await wait(250);
      stopModels();
      const loadClip = jest.fn();
      const { model } = await setup(loadClip);
      await flush();
      expect(model.$clip.value.notes).toEqual([note(0, 1, 70)]);
      expect(model.$id.value).toBeNull();
      expect(loadClip).not.toHaveBeenCalled();
    });

    it('keeps a clip under a name the filter refuses: a reload restores its notes and name', async () => {
      const first = await setup();
      first.actions.setNotes([note(0, 1, 70)]);
      first.actions.setName('Sexy pad');
      await wait(250);
      stopModels();
      const { model } = await setup(jest.fn());
      await flush();
      expect(model.$clip.value.notes).toEqual([note(0, 1, 70)]);
      expect(model.$clip.value.name).toBe('Sexy pad');
    });

    it('a link to another clip opens that one', async () => {
      sessionStorage.setItem('trackState', JSON.stringify({ clip: saved, id: 'old', hash: null }));
      window.history.replaceState(null, '', '/?clip=c9');
      const loadClip = jest
        .fn()
        .mockResolvedValue({ id: 'c9', clip: { ...saved, notes: [] }, createdAt: '' });
      const { model } = await setup(loadClip);
      await flush();
      expect(loadClip).toHaveBeenCalledWith('c9');
      expect(model.$clip.value.notes).toEqual([]);
    });

    it('keeps nothing for an empty clip of no id', async () => {
      const { actions } = await setup();
      actions.setNotes([note(0, 1)]);
      await wait(250);
      expect(sessionStorage.getItem('trackState')).not.toBeNull();
      actions.setNotes([]);
      await wait(250);
      expect(sessionStorage.getItem('trackState')).toBeNull();
    });
  });

  describe('Space', () => {
    // a keydown of Space on `target` (none focused: the body)
    const space = (init: KeyboardEventInit = {}, target: EventTarget = document.body) => {
      const event = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(event);
      return event;
    };
    // an element in the page, focused
    const focused = <T extends HTMLElement>(element: T, parent: HTMLElement = document.body) => {
      parent.appendChild(element);
      element.focus();
      return element;
    };

    afterEach(() => {
      document.body.innerHTML = '';
    });

    it("plays and stops a clip of notes wherever the focus is; the page doesn't take it", async () => {
      const { actions, model, transportModel } = await setup();
      actions.setNotes([note(0, 1)]);
      expect(space().defaultPrevented).toBe(true);
      expect(model.$armed.value).toBe(true);
      expect(transportModel.$playing.value).toBe(true);
      // a button focused (Play clicked): the press doesn't click it too
      const button = focused(document.createElement('button'));
      expect(space({}, button).defaultPrevented).toBe(true);
      expect(model.$armed.value).toBe(false);
      expect(transportModel.$playing.value).toBe(false);
    });

    it('an empty clip: the page keeps it while the roll is closed and the track stopped', async () => {
      const { actions, model } = await setup();
      expect(space().defaultPrevented).toBe(false);
      expect(model.$armed.value).toBe(false);
      // REC from an empty clip plays it: Space stops it
      actions.play();
      expect(space().defaultPrevented).toBe(true);
      expect(model.$armed.value).toBe(false);
    });

    it('the roll open: an empty loop plays too (to record into it)', async () => {
      const { actions, model } = await setup();
      actions.setRollOpen(true);
      expect(space().defaultPrevented).toBe(true);
      expect(model.$armed.value).toBe(true);
    });

    it.each([
      ['a text field', () => focused(document.createElement('input'))],
      ['a checkbox', () => focused(Object.assign(document.createElement('input'), { type: 'checkbox' }))],
      ['a textarea', () => focused(document.createElement('textarea'))],
      ['a select', () => focused(document.createElement('select'))],
      [
        'a button of a dialog',
        () => {
          const dialog = document.createElement('div');
          dialog.setAttribute('role', 'dialog');
          document.body.appendChild(dialog);
          return focused(document.createElement('button'), dialog);
        },
      ],
    ])('leaves it to %s', async (_, target) => {
      const { actions, model } = await setup();
      actions.setNotes([note(0, 1)]);
      expect(space({}, target()).defaultPrevented).toBe(false);
      expect(model.$armed.value).toBe(false);
    });

    it('leaves it to a control that took it, and with Cmd, Ctrl or Alt', async () => {
      const { actions, model } = await setup();
      actions.setNotes([note(0, 1)]);
      const button = focused(document.createElement('button'));
      button.addEventListener('keydown', (e) => e.preventDefault(), { once: true });
      space({}, button);
      [{ metaKey: true }, { ctrlKey: true }, { altKey: true }].forEach((init) =>
        expect(space(init).defaultPrevented).toBe(false)
      );
      expect(model.$armed.value).toBe(false);
      // Shift+Space plays
      space({ shiftKey: true });
      expect(model.$armed.value).toBe(true);
    });

    it("a press, not its auto-repeat (the page doesn't scroll by it either)", async () => {
      const { actions, model } = await setup();
      actions.setNotes([note(0, 1)]);
      space();
      expect(space({ repeat: true }).defaultPrevented).toBe(true);
      expect(space({ repeat: true }).defaultPrevented).toBe(true);
      expect(model.$armed.value).toBe(true);
    });

    it('stops listening once the track is gone', async () => {
      const { actions, model } = await setup();
      actions.setNotes([note(0, 1)]);
      stopModels();
      expect(space().defaultPrevented).toBe(false);
      expect(model.$armed.value).toBe(false);
    });
  });
});
