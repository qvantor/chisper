import { BuilderMessage, createTableBuilder } from '../app/synth/common/wavetable/wavetable-builder';
import type { WavetableEngineDependencies } from '../app/synth/common/wavetable/wavetable-engine';

// a port whose messages wait in the queue of its channel until flush() delivers them
class QueuedPort {
  onmessage: ((event: MessageEvent) => void) | null = null;
  other: QueuedPort | null = null;
  constructor(
    private readonly queue: (() => void)[],
    private readonly later: () => void
  ) {}
  postMessage(data: unknown) {
    this.queue.push(() => this.other?.onmessage?.({ data } as MessageEvent));
    this.later();
  }
}

export interface InProcessWorker {
  terminated: boolean;
  messages: BuilderMessage[];
}

// The builder of a wavetable engine run in the spec: each worker is a builder of its own here, each channel two
// ports between it and the store; their messages and the builds wait for flush() (one queue, in order). What the
// store gets is what a worker sends: chunks asked for and acknowledged, versions stored or refused
export const inProcessBuilder = ({ auto = false } = {}) => {
  const queue: (() => void)[] = [];
  // (auto: the queue flushed by a timer of its own as it fills: a render waits for the page)
  let timer: ReturnType<typeof setTimeout> | null = null;
  const later = () => {
    if (!auto || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    });
  };
  const workers: InProcessWorker[] = [];
  const createChannel = () => {
    const port1 = new QueuedPort(queue, later);
    const port2 = new QueuedPort(queue, later);
    port1.other = port2;
    port2.other = port1;
    return { port1, port2 } as unknown as MessageChannel;
  };
  const createWorker = () => {
    const builder = createTableBuilder((run) => {
      queue.push(run);
      later();
    });
    const own: InProcessWorker = { terminated: false, messages: [] };
    workers.push(own);
    return {
      onerror: null,
      onmessage: null,
      postMessage: (message: BuilderMessage) => {
        if (own.terminated) return;
        own.messages.push(message);
        builder.receive(message);
      },
      terminate: () => {
        own.terminated = true;
      },
    } as unknown as Worker;
  };
  const dependencies: WavetableEngineDependencies = { createWorker, createChannel };
  // every message and build waiting, those they make too
  function flush() {
    for (let runs = 0; queue.length > 0; runs++) {
      if (runs > 1e6) throw new Error('The builder never settles');
      (queue.shift() as () => void)();
    }
  }
  return { dependencies, workers, flush };
};
