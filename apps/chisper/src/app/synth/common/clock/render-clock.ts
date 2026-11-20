import { SchedulerAction, SchedulerLike, Subscription } from 'rxjs';
import type { SynthClock } from './synth-clock';

interface Queue {
  now: () => number;
  add: (action: RenderAction<unknown>) => void;
  remove: (action: RenderAction<unknown>) => void;
}

// a task of a render clock due at `at` (ms of the clock): a timer of the models, a throttle of rxjs (it schedules
// itself again where a period asks for it)
class RenderAction<T> extends Subscription implements SchedulerAction<T> {
  at = 0;
  private state: T | undefined;

  constructor(
    private readonly queue: Queue,
    private readonly work: (this: SchedulerAction<T>, state?: T) => void
  ) {
    super();
    this.add(() => queue.remove(this as RenderAction<unknown>));
  }

  schedule(state?: T, delay = 0): Subscription {
    if (this.closed) return this;
    this.state = state;
    this.at = this.queue.now() + Math.max(0, delay);
    this.queue.add(this as RenderAction<unknown>);
    return this;
  }

  run() {
    this.work.call(this, this.state);
  }
}

// The clock of a render: its time is the frames the engine has rendered, moved by the loop that renders them
// (advance), never by the page. Its timers and the throttles of the models wait for its time: runDue() runs those
// whose time has come, in their order (a render repeats whatever the page does meanwhile)
export const createRenderClock = (sampleRate: number) => {
  let frame = 0;
  const due: RenderAction<unknown>[] = [];
  const now = () => (frame / sampleRate) * 1000;
  const queue: Queue = {
    now,
    add: (action) => {
      queue.remove(action);
      // (in the order of their times, then of their scheduling)
      let index = due.length;
      while (index > 0 && due[index - 1].at > action.at) index -= 1;
      due.splice(index, 0, action);
    },
    remove: (action) => {
      const index = due.indexOf(action);
      if (index >= 0) due.splice(index, 1);
    },
  };
  const scheduler: SchedulerLike = {
    now,
    schedule: <T>(work: (this: SchedulerAction<T>, state?: T) => void, delay = 0, state?: T) =>
      new RenderAction<T>(queue, work).schedule(state, delay),
  };
  const clock: SynthClock = {
    get currentTime() {
      return frame / sampleRate;
    },
    sampleRate,
    now,
    scheduler,
    contextTimeAt: (ms) => ms / 1000,
  };
  return {
    clock,
    // the frames rendered so far
    get frame() {
      return frame;
    },
    // the tasks waiting
    get pending() {
      return due.length;
    },
    advance: (frames: number) => {
      frame += frames;
    },
    // the tasks whose time has come (those they schedule for now too)
    runDue: () => {
      while (due.length > 0 && due[0].at <= now()) {
        const action = due.shift() as RenderAction<unknown>;
        action.run();
      }
    },
  };
};
