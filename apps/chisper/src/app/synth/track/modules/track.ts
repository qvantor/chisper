import {
  BehaviorSubject,
  combineLatest,
  debounceTime,
  defer,
  distinctUntilChanged,
  filter,
  fromEvent,
  map,
  merge,
  pairwise,
  skip,
  startWith,
  Subject,
  Subscription,
  tap,
} from 'rxjs';
import { isEqual, omit } from 'lodash';
import toast from 'react-hot-toast';
import { PrimitiveBS, rxModel, rxModelReact } from '@chisper/rxjs-react';
import {
  CLIP_BAR,
  CLIP_LENGTH_DEFAULT,
  CLIP_LENGTH_MAX,
  CLIP_NOTES_MAX,
  CLIP_PPQ,
  Clip,
  ClipNote,
  ClipResponse,
  clipHash,
  clipSchema,
  emptyClip,
  normalizeClip,
  normalizedClipHash,
} from '@chisper/preset-schema';
import type { AppModule } from '../../../app/modules';
import { readStored, writeStored } from '../../../common/services';
import { getUrlClipId, setUrlClipId } from '../../../presets/services/url';
import { midiToNote, noteToMidi } from '../../services';
import { sourceKey } from '../../common/modules/input-controller';
import { focusTakesKeys } from '../../common/modules/keyboard-controller';
import type { InputControllerModule, NoteSource } from '../../common/modules/input-controller';
import type { SynthCoreModule } from '../../common/modules/synth-core';
import type { SynthModule } from '../../common/modules/synth';
import type { TransportModule } from '../../common/modules/transport';
import { CreateTrackClock, createTrackClock } from '../track-clock';
import {
  loopEvents,
  loopTick,
  passStart,
  PlayedNote,
  playedNotes,
  soundingAt,
  TrackEvent,
  withoutEnded,
} from '../track-events';
import { ClipBody, ClipHistory, emptyHistory, record, redo, undo } from '../track-history';
import { finishNote, HeldNote, insertNotes, loopLength, withLength } from '../track-edit';
import { MidiImport, MidiPart, parseMidiFile } from '../midi-file';
import { fetchClip } from '../services/clips-api';

// seconds: a note of the track goes to the synth this long before its time, in the order of their times (a note of
// the keys meanwhile doesn't mix up its phrase, its legato or the stack of mono): a step of currentTime (a device
// buffer: up to 40 ms on Android) and the way of a message to the audio thread
export const TRACK_LEAD = 0.05;

const TRACK = 'track' as const;

// the inputs a recording takes: the computer keyboard and the piano on the screen, MIDI. Not the track's own notes,
// nor the roll's (its keys and the sound of its edits: an edit would be recorded again)
const RECORDED: ReadonlySet<NoteSource> = new Set<NoteSource>(['keys', 'midi']);

// no note held (the roll asks every frame)
const NO_NOTES: readonly ClipNote[] = [];

// a .mid of several parts waiting for those to import to be chosen
export interface PendingMidi {
  bytes: Uint8Array | ArrayBuffer;
  parts: MidiPart[];
}

// the state of the tab (sessionStorage): the clip, its id and the hash it was saved or loaded with, so a reload
// keeps a clip not saved yet
const TAB_STATE_KEY = 'trackState';
interface TabState {
  clip: Clip;
  id: string | null;
  hash: string | null;
}
const isTabState = (value: unknown): value is TabState => {
  const { clip, id, hash } = (value ?? {}) as Partial<Record<keyof TabState, unknown>>;
  return (
    (id === null || typeof id === 'string') &&
    (hash === null || typeof hash === 'string') &&
    clipSchema.safeParse(clip).success
  );
};

// changed since it was saved or loaded (by the hashes); not saved yet: once it has notes
const dirtyOf = (clip: Clip, hash: string | null) =>
  hash === null ? clip.notes.length > 0 : clipHash(clip) !== hash;

const bodyOf = ({ length, notes }: Clip): ClipBody => ({ length, notes });

interface Dependencies {
  app: AppModule;
  synthCore: SynthCoreModule;
  transport: TransportModule;
  inputController: InputControllerModule;
  synth: SynthModule;
  // the clock of the player (a worker; the specs tick their own)
  createClock?: CreateTrackClock;
  // a clip by its id (the API)
  loadClip?: (id: string) => Promise<ClipResponse>;
}

// the track: one clip of notes in a loop, played into the synth at the tempo and the position of the transport (a
// note of the source `track`, TRACK_LEAD ahead of its time); edited by the piano roll with an undo, kept by the tab,
// saved apart from the presets and opened by a link (?clip=)
export const track = ({
  app: [{ $windowKeyDown }],
  synthCore: [{ audioCtx }],
  transport: [
    { $bpm, $source, $playing: $transportPlaying, $changes, beatAt, timeAt, contextTimeAt },
    { setBpm, locate, setPlaying },
  ],
  inputController: [{ $onPress, $onRelease }, { onPress, onRelease }],
  synth: [, { followFx }],
  createClock = createTrackClock,
  loadClip = fetchClip,
}: Dependencies) =>
  rxModel(() => {
    const $clip = new BehaviorSubject<Clip>(emptyClip($bpm.value));
    // the id it was saved or loaded under (null: not saved) and the hash then
    const $id = new PrimitiveBS<string | null>(null);
    const $savedHash = new PrimitiveBS<string | null>(null);
    const $dirty = new PrimitiveBS<boolean>(false);
    // Play is on: the track plays while the transport does (a MIDI Clock starts and stops it)
    const $armed = new PrimitiveBS<boolean>(false);
    const $playing = new PrimitiveBS<boolean>(false);
    const $history = new BehaviorSubject<ClipHistory>(emptyHistory());
    // the piano roll is open (desktop: over the synth, the keys and the preview stay)
    const $rollOpen = new PrimitiveBS<boolean>(false);
    // a .mid of several parts imported: the dialog chooses its parts (null: none)
    const $midiImport = new BehaviorSubject<PendingMidi | null>(null);
    // the pitches of the track the output plays now (the keys light them in their own color)
    const $sounding = new BehaviorSubject<number[]>([]);
    // the player: the tick of the transport (ticks over the loops from beat 0) up to which the notes were sent (null:
    // from where the transport is at the next tick), the pitches it holds in the synth, the time of the context its
    // play started at (the output before it is not the track), the notes as they play, whether it waits for the
    // transport to be located (a MIDI Start takes it to beat 0 at the next clock), and the tick of the transport the
    // loops count from: the start of the pass it starts in (beat 0 is tick 0 of the loop: a Song Position plays it at
    // its position modulo the length), of the one REC ran the loop on from
    const player = {
      next: null as number | null,
      held: new Set<number>(),
      from: 0,
      played: [] as PlayedNote[],
      waiting: false,
      offset: 0,
    };
    // an edit dragged over many moves is one step of the undo: the clip before its first change, and the history
    // then (a cancelled drag puts both back)
    const gesture: { before: ClipBody | null; history: ClipHistory | null; recorded: boolean } = {
      before: null,
      history: null,
      recorded: false,
    };
    // REC is on: the notes of the inputs go into the loop while the track plays, over its notes; the loop runs on
    // to the bar the player comes to (up to the longest loop), it doesn't go round
    const $recording = new PrimitiveBS<boolean>(false);
    // notes recorded into the clip: the notes before and after (the roll keeps its selection on the same notes)
    const $recorded = new Subject<{ before: ClipNote[]; after: ClipNote[] }>();
    // the recording: the notes the inputs hold (by sourceKey; each goes into the loop as it is released), those
    // recorded while a drag edits the notes (they go in once it ends: its moves would take them away), the history
    // after the last note of the take (one step of the undo while nothing else changed it) and whether it was told
    // the clip is full
    const recorder = {
      held: new Map<string, HeldNote>(),
      pending: [] as ClipNote[],
      history: null as ClipHistory | null,
      full: false,
    };
    // ticks from beat 0 of the transport (over the loops) the output plays at `ms` of performance.now(), not before
    // the start of the play
    const tickAt = (ms = performance.now()) => beatAt(Math.max(contextTimeAt(ms), player.from)) * CLIP_PPQ;
    // a held note of a recording as a note of the loop up to `end` (ticks of the transport)
    const finish = (note: HeldNote, end: number) => finishNote(note, end, $clip.value.length, player.offset);
    // the position in the loop (ticks) at `tick` of the transport (the loops from the offset of the player)
    const loopAt = (tick: number) => loopTick(tick - player.offset, $clip.value.length);
    // the notes the player holds in the synth released at `at` (none: now)
    const releaseHeld = (at?: number) => {
      player.held.forEach((pitch) =>
        onRelease(midiToNote(pitch), { source: TRACK, ...(at !== undefined && { at }) })
      );
      player.held.clear();
    };
    return {
      $clip,
      $id,
      $savedHash,
      $dirty,
      $armed,
      $playing,
      $history,
      $rollOpen,
      $midiImport,
      $sounding,
      $recording,
      $recorded,
      player,
      gesture,
      recorder,
      releaseHeld,
      tickAt,
      finish,
      loopAt,
      // the position of the loop (ticks) the output plays at `ms` of performance.now() (null: not playing, or before
      // its start)
      positionAt: (ms = performance.now()) => {
        if (!$playing.value || player.waiting) return null;
        const t = contextTimeAt(ms);
        if (t < player.from) return null;
        return loopAt(beatAt(t) * CLIP_PPQ);
      },
      // the notes the inputs hold while REC records, from where they were pressed to where the output plays at `ms`
      // (the roll draws them growing)
      recordingNotes: (ms = performance.now()): readonly ClipNote[] => {
        if (!recorder.held.size) return NO_NOTES;
        const end = tickAt(ms);
        return [...recorder.held.values()].map((note) => finish(note, end));
      },
    };
  })
    .actions((model) => {
      const {
        $clip,
        $id,
        $savedHash,
        $armed,
        $history,
        $rollOpen,
        $midiImport,
        $recording,
        $recorded,
        player,
        gesture,
        recorder,
      } = model;
      // (the notes as they play before the clip: its subscribers play them)
      const setClip = (clip: Clip) => {
        player.played = playedNotes(clip.notes, clip.length);
        $clip.next(clip);
      };
      const applyBody = ({ length, notes }: ClipBody) => setClip({ ...$clip.value, length, notes });
      // the tempo of a clip opened or imported is the tempo of the synth; shown only while a MIDI Clock leads it
      const takeTempo = (bpm: number) => {
        if ($source.value !== 'midi') setBpm(bpm);
      };
      // a clip opened: no undo across it (nor a recording: the notes held go into no clip)
      const open = (clip: Clip, id: string | null, hash: string | null) => {
        recorder.held.clear();
        recorder.pending = [];
        recorder.history = null;
        setClip(clip);
        $id.next(id);
        $savedHash.next(hash);
        $history.next(emptyHistory());
        takeTempo(clip.bpm);
        // (the url as it is when it has the clip: a start keeps what else it has)
        if (getUrlClipId() !== id) setUrlClipId(id);
      };
      const playFrom = (beat: number) => {
        $armed.next(true);
        if ($source.value === 'midi') return;
        locate(beat, audioCtx.currentTime + TRACK_LEAD);
        setPlaying(true);
      };
      const edit = (body: Partial<ClipBody>) => {
        const before = bodyOf($clip.value);
        const next = { ...before, ...body };
        if (isEqual(next, before)) return;
        $history.next(record($history.value, before));
        applyBody(next);
      };
      // a change of a take (a note recorded, the loop run on): one step of the undo a take, while nothing else
      // changed the history since its last change
      const takeStep = (before: ClipBody) => {
        if ($history.value !== recorder.history) $history.next(record($history.value, before));
        recorder.history = $history.value;
      };
      // notes recorded into the loop (over its notes): a change of the take; while a drag edits the notes they wait
      // for its end
      const addRecorded = (notes: readonly ClipNote[]) => {
        if (!notes.length) return;
        if (gesture.before) {
          recorder.pending.push(...notes);
          return;
        }
        const before = bodyOf($clip.value);
        const after = insertNotes(before.notes, notes);
        if (before.notes.length + notes.length > CLIP_NOTES_MAX && !recorder.full) {
          recorder.full = true;
          toast(`The clip is full: ${CLIP_NOTES_MAX} notes`);
        }
        if (after.length === before.notes.length) return;
        takeStep(before);
        applyBody({ notes: after, length: loopLength(before, after) });
        $recorded.next({ before: before.notes, after });
      };
      // the notes the inputs hold go into the loop up to where the output plays now
      const commitHeld = () => {
        const notes = model.recordingNotes();
        recorder.held.clear();
        addRecorded(notes);
      };
      // the loop run on to `length` by a recording (the player comes to its end): a change of the take; a drag that
      // edits the notes meanwhile keeps it (its moves would take it back)
      const extendLoop = (length: number) => {
        const before = bodyOf($clip.value);
        if (length <= before.length) return;
        if (gesture.before) gesture.before = { ...gesture.before, length };
        else takeStep(before);
        applyBody({ notes: before.notes, length });
      };
      const stopRecording = () => {
        commitHeld();
        if ($recording.value) $recording.next(false);
      };
      // REC: a new take (its notes one step of the undo); from a stop the track plays from beat 0 (a MIDI Clock
      // leads: armed, it records once its Start plays it)
      const startRecording = () => {
        if ($recording.value) return;
        recorder.history = null;
        recorder.full = false;
        $recording.next(true);
        if (!$armed.value) playFrom(0);
      };
      const endGesture = () => {
        gesture.before = null;
        gesture.history = null;
        gesture.recorded = false;
        addRecorded(recorder.pending.splice(0));
      };
      // a clip of its own: not saved, out of the url (a Save makes a new link, the clip saved before keeps its notes)
      const detach = () => {
        $id.next(null);
        $savedHash.next(null);
        setUrlClipId(null);
      };
      // the clip of a .mid in place of the notes (it can be undone): its tempo, its name (none without one). A new
      // clip, as New makes: a Save would put the file under the link of the clip before
      const applyMidi = ({ clip, truncated, tempo }: MidiImport) => {
        edit({ length: clip.length, notes: clip.notes });
        const rest = omit($clip.value, 'name');
        setClip(clip.name ? { ...rest, name: clip.name } : rest);
        detach();
        if (tempo !== null) takeTempo(tempo);
        if (truncated) toast('The clip is cut to 32 bars and 2048 notes');
      };
      // a .mid read (or false: it isn't one, a toast says why)
      const readMidi = (bytes: ArrayBuffer | Uint8Array, parts?: readonly number[]) => {
        try {
          return parseMidiFile(bytes, { bpm: $bpm.value, parts });
        } catch (e) {
          toast.error(e instanceof Error ? e.message : 'Not a MIDI file');
          return false;
        }
      };
      // the roll closed: a file waiting for its parts goes
      const setRollOpen = (open: boolean) => {
        if (!open && $midiImport.value) $midiImport.next(null);
        $rollOpen.next(open);
      };
      // a step of the undo (undo, redo) from the clip as it is
      const stepHistory = (take: typeof undo) => {
        const step = take($history.value, bodyOf($clip.value));
        if (!step) return;
        $history.next(step.history);
        applyBody(step.body);
      };
      return {
        // an edit of the notes (one step of the undo); the loop follows them (loopLength)
        setNotes: (notes: ClipNote[]) => edit({ notes, length: loopLength(bodyOf($clip.value), notes) }),
        // the length of the loop (its flag): the notes that start past it go, those through it end there
        setLength: (length: number) => edit({ length, notes: withLength($clip.value.notes, length) }),
        // a drag: its moves are one step of the undo
        startGesture: () => {
          gesture.before = bodyOf($clip.value);
          gesture.history = $history.value;
          gesture.recorded = false;
        },
        moveGesture: (notes: ClipNote[]) => {
          if (gesture.before && !gesture.recorded) {
            if (isEqual(notes, gesture.before.notes)) return;
            $history.next(record($history.value, gesture.before));
            gesture.recorded = true;
          }
          const length = loopLength(gesture.before ?? bodyOf($clip.value), notes);
          // (a move that changes nothing: the pointer within a step of the grid)
          if (length === $clip.value.length && isEqual(notes, $clip.value.notes)) return;
          applyBody({ length, notes });
        },
        endGesture,
        // a drag given up (Escape): the clip and the undo as they were before it
        cancelGesture: () => {
          const { before, history, recorded } = gesture;
          if (before && history && recorded) {
            $history.next(history);
            applyBody(before);
          }
          endGesture();
        },
        undo: () => stepHistory(undo),
        redo: () => stepHistory(redo),
        // (the notes as they play don't change)
        setName: (name: string) => {
          const rest = omit($clip.value, 'name');
          $clip.next(name.trim() ? { ...rest, name } : rest);
        },
        // a new empty clip of the default length (it can be undone; not saved, out of the url)
        newClip: () => {
          edit({ notes: [], length: CLIP_LENGTH_DEFAULT });
          setClip(omit($clip.value, 'name'));
          detach();
        },
        // a Standard MIDI File in place of the notes (it can be undone): its tempo, its name; false when it isn't one.
        // A file of several parts (channels of tracks) waits in $midiImport for those to import to be chosen
        importMidi: (bytes: ArrayBuffer | Uint8Array) => {
          const read = readMidi(bytes);
          if (!read) return false;
          if (read.parts.length > 1) $midiImport.next({ bytes, parts: read.parts });
          else applyMidi(read);
          return true;
        },
        // the parts of the file waiting chosen (indexes into its parts): their notes imported
        importParts: (parts: readonly number[]) => {
          const pending = $midiImport.value;
          if (!pending) return;
          $midiImport.next(null);
          const read = readMidi(pending.bytes, parts);
          if (read) applyMidi(read);
        },
        cancelImport: () => $midiImport.next(null),
        // saved (or updated) under `id` with the notes of `clip` (those sent: an edit while it went is not saved),
        // in the url
        setSaved: (id: string, clip: Clip) => {
          $id.next(id);
          $savedHash.next(clipHash(clip));
          setUrlClipId(id);
        },
        // the clip of a link: loaded, its tempo taken
        loadById: async (id: string) => {
          try {
            const { clip } = await loadClip(id);
            const normalized = normalizeClip(clip);
            open(normalized, id, normalizedClipHash(normalized));
          } catch {
            toast.error('Clip from the link was not found');
          }
        },
        // the state of the tab after a reload
        restore: ({ clip, id, hash }: TabState) => open(normalizeClip(clip), id, hash),
        // Play: from beat 0 TRACK_LEAD from now (the free LFOs of HOST with it); a MIDI Clock leads: armed, its Start
        // and Stop play it
        play: () => {
          if (!$armed.value) playFrom(0);
        },
        // Play from a beat of the loop (a bar of the ruler); while it plays the track goes there, what it holds goes;
        // a MIDI Clock leads: armed only (the clock places the transport)
        playFrom,
        stop: () => {
          stopRecording();
          if (!$armed.value) return;
          $armed.next(false);
          if ($source.value !== 'midi') setPlaying(false);
        },
        record: startRecording,
        // REC off: the notes held go into the loop up to now; the track plays on
        stopRecording,
        toggleRecording: () => ($recording.value ? stopRecording() : startRecording()),
        addRecorded,
        commitHeld,
        extendLoop,
        setRollOpen,
        toggleRoll: () => setRollOpen(!$rollOpen.value),
      };
    })
    .subscriptions((model, { restore, loadById, play, stop, addRecorded, commitHeld, extendLoop }) => {
      const {
        $clip,
        $id,
        $savedHash,
        $dirty,
        $armed,
        $playing,
        $rollOpen,
        $sounding,
        $recording,
        player,
        recorder,
        releaseHeld,
      } = model;
      const send = ({ tick, on, pitch, velocity }: TrackEvent) => {
        const at = timeAt(tick / CLIP_PPQ);
        const note = midiToNote(pitch);
        if (on) {
          if (player.held.has(pitch)) onRelease(note, { source: TRACK, at });
          onPress(note, velocity, { source: TRACK, at });
          player.held.add(pitch);
        } else if (player.held.delete(pitch)) onRelease(note, { source: TRACK, at });
      };
      const showSounding = (pitches: number[]) => {
        if (!isEqual(pitches, $sounding.value)) $sounding.next(pitches);
      };
      // the player starts at `tick` of the transport: the loops count from the start of its pass
      const startAt = (tick: number) => {
        player.next = tick;
        player.offset = tick - loopTick(tick, $clip.value.length);
        return tick;
      };
      // REC runs the loop on: as the notes would be sent past its end, it takes the bars up to the one they would be
      // sent to (the flag moves on; at most the longest loop, then it goes round), from the start of the pass it is
      // in (the loops count from there: the position doesn't move)
      const runOn = (next: number, horizon: number) => {
        const { length } = $clip.value;
        if (!$recording.value || length >= CLIP_LENGTH_MAX) return;
        const start = passStart(next, player.offset, length);
        if (horizon - start < length) return;
        player.offset = start;
        extendLoop(Math.min(CLIP_LENGTH_MAX, (Math.floor((horizon - start) / CLIP_BAR) + 1) * CLIP_BAR));
      };
      // a tick whose time has passed (on the newest segment, as the notes are sent)
      const passed = (at: number) => timeAt(at / CLIP_PPQ) <= audioCtx.currentTime;
      // every tick: the notes up to TRACK_LEAD from now, at the times of their beats on the transport now (a new
      // tempo plays from the next notes on); after the page stood (a long task) those that ended meanwhile don't
      // play, one that still sounds plays from now. The fx follow a note whose time has come, the keys light those
      // the output plays
      const tick = () => {
        if (!$playing.value || player.waiting) return;
        const horizon = beatAt(audioCtx.currentTime + TRACK_LEAD) * CLIP_PPQ;
        const next = player.next ?? startAt(horizon);
        if (horizon > next) {
          runOn(next, horizon);
          const events = loopEvents(player.played, $clip.value.length, next, horizon, player.offset);
          withoutEnded(events, passed).forEach(send);
          player.next = horizon;
        }
        followFx();
        const position = model.positionAt();
        showSounding(position === null ? [] : soundingAt(player.played, position));
      };
      const clock = createClock(tick);
      // the clip changed while it plays: a note it holds that no longer sounds where the player is goes at the time
      // the notes were sent up to (its note off would never come)
      const reconcile = () => {
        if (!$playing.value || player.next === null || player.held.size === 0) return;
        const sounding = new Set(soundingAt(player.played, model.loopAt(player.next)));
        const at = timeAt(player.next / CLIP_PPQ);
        player.held.forEach((pitch) => {
          if (sounding.has(pitch)) return;
          onRelease(midiToNote(pitch), { source: TRACK, at });
          player.held.delete(pitch);
        });
      };
      // the tab keeps a clip with notes or an id
      const saveTabState = () => {
        const clip = $clip.value;
        const kept = clip.notes.length > 0 || $id.value !== null;
        writeStored(
          'sessionStorage',
          TAB_STATE_KEY,
          kept ? { clip, id: $id.value, hash: $savedHash.value } : null
        );
      };
      return [
        // the clip of the link, or of the tab after a reload (unless it was given a link to another clip)
        defer(async () => {
          const urlId = getUrlClipId();
          const saved = readStored('sessionStorage', TAB_STATE_KEY, null, isTabState);
          if (saved && saved.id === urlId) restore(saved);
          else if (urlId) await loadById(urlId);
        }).subscribe(),
        // the tempo of the synth is the tempo of the clip (saved with it)
        $bpm.pipe(skip(1)).subscribe((bpm) => {
          if ($clip.value.bpm !== bpm) $clip.next({ ...$clip.value, bpm });
        }),
        $clip.pipe(skip(1)).subscribe(reconcile),
        merge($clip, $savedHash)
          .pipe(debounceTime(100))
          .subscribe(() => $dirty.next(dirtyOf($clip.value, $savedHash.value))),
        merge($clip, $id, $savedHash).pipe(skip(1), debounceTime(200)).subscribe(saveTabState),
        // a reload within the debounce
        fromEvent(window, 'pagehide').subscribe(saveTabState),
        // it plays while Play is on and the transport plays
        combineLatest([$armed, $transportPlaying])
          .pipe(
            map(([armed, playing]) => [armed, playing] as const),
            startWith([false, false] as const),
            pairwise()
          )
          .subscribe(([[wasArmed, wasPlaying], [armed, playing]]) => {
            const on = armed && playing;
            if (on === $playing.value) return;
            if (on) {
              // a MIDI Start or Continue: from where the next clock locates the transport; Play while it runs: from
              // where it is
              player.waiting = $source.value === 'midi' && wasArmed && !wasPlaying;
              $playing.next(true);
              clock.start();
              tick();
              return;
            }
            $playing.next(false);
            // (the notes a recording holds go into the loop up to now: Stop, a MIDI Stop, the clock lost)
            commitHeld();
            clock.stop();
            releaseHeld();
            player.next = null;
            player.waiting = false;
            player.offset = 0;
            showSounding([]);
          }),
        // the transport located (Play, a MIDI Start, a Song Position): the track plays from there, what it holds goes
        // (the notes a recording holds go into the loop up to now)
        $changes.subscribe(({ segment, locate: located }) => {
          if (!located || !$armed.value) return;
          // a Song Position while the clock stands (the transport goes on): its Continue plays from there, at the
          // locate of its next clock
          if ($source.value === 'midi' && !$transportPlaying.value) return;
          commitHeld();
          releaseHeld(segment.time);
          startAt(segment.beat * CLIP_PPQ);
          player.from = segment.time;
          player.waiting = false;
        }),
        // Space plays and stops the clip wherever the focus is (the roll too) but on a control that takes the key (a
        // text field, a select, a dialog). Nothing to play (stopped, no notes, the roll closed): the page keeps it. A
        // press, not its auto-repeat
        $windowKeyDown
          .pipe(
            filter((e) => e.key === ' ' && !e.metaKey && !e.ctrlKey && !e.altKey && !focusTakesKeys(e)),
            filter(() => $armed.value || $rollOpen.value || $clip.value.notes.length > 0),
            tap((e) => e.preventDefault()),
            filter((e) => !e.repeat)
          )
          .subscribe(() => ($armed.value ? stop() : play())),
        // the MIDI Clock is gone (or switched off) while Play is on and it stands: Play goes off
        $source.pipe(distinctUntilChanged(), skip(1)).subscribe((source) => {
          if (source === 'internal' && $armed.value && !$transportPlaying.value) stop();
        }),
        // REC: a note of an input pressed while the track plays is held from where the output plays (where it was
        // heard), it goes into the loop as it is released
        $onPress.subscribe(({ note, velocity, source }) => {
          if (!RECORDED.has(source) || !$recording.value || !$playing.value || player.waiting) return;
          recorder.held.set(sourceKey(source, note), {
            tick: model.tickAt(),
            pitch: noteToMidi(note),
            velocity,
          });
        }),
        $onRelease.subscribe(({ note, source }) => {
          if (!recorder.held.size) return;
          const key = sourceKey(source, note);
          const held = recorder.held.get(key);
          if (!held) return;
          recorder.held.delete(key);
          addRecorded([model.finish(held, model.tickAt())]);
        }),
        new Subscription(() => clock.destroy()),
      ];
    })
    .destroy(({ releaseHeld }) => releaseHeld());

export const {
  ModelProvider: TrackProvider,
  useModel: useTrack,
  Context: TrackContext,
} = rxModelReact('track', track);
