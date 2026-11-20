import { asyncScheduler, SchedulerLike } from 'rxjs';
import { contextTimeAt } from '../../../common/services';

// The time the models of the sound read: the clock of the context they play in (contextClock), or the one a render
// moves block by block (render-clock.ts), whose timers and throttles wait for its time, not the page's
export interface SynthClock {
  // seconds of the context: the time rendered up to
  readonly currentTime: number;
  readonly sampleRate: number;
  // ms on the clock of performance.now() (a key held: currentTime moves by device buffers)
  now(): number;
  // the scheduler of the timers and the throttles of the models
  readonly scheduler: SchedulerLike;
  // the time of the context the output plays at `ms` of now() (an event, a MIDI Clock)
  contextTimeAt(ms: number): number;
}

// the clock of a context: its time, the page's timers
export const contextClock = (audioCtx: BaseAudioContext): SynthClock => ({
  get currentTime() {
    return audioCtx.currentTime;
  },
  get sampleRate() {
    return audioCtx.sampleRate;
  },
  now: () => performance.now(),
  scheduler: asyncScheduler,
  contextTimeAt: (ms) => contextTimeAt(audioCtx, ms),
});

// `fn` once `seconds` of the clock have passed; the cancel of it
export const after = (clock: SynthClock, seconds: number, fn: () => void) => {
  const action = clock.scheduler.schedule(fn, seconds * 1000);
  return () => action.unsubscribe();
};
