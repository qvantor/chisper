import { isWorkletSupported, loadWorklet } from '../../fx/effects/load-worklet';
import { createEngineHost, MakeEngine } from './engine-host';
import {
  ENGINE_MODULE,
  ENGINE_NODE_OPTIONS,
  ENGINE_PROCESSOR,
  EngineMessage,
  EngineReport,
  PROBED_NODE_OPTIONS,
} from './engine-params';

// The node of the engine of the synth (engine.worklet.ts: the voices, the effects, the master gain and the limiter
// in one core) → output, once its module has loaded, hosted as engine-host.ts hosts a node: where the browser has
// no AudioWorklet or no wasm SIMD nothing plays ('unsupported'). A processor that threw, or whose core trapped out
// of its voices and its stages, fails the node
export const createEngineNode = (audioCtx: BaseAudioContext) => {
  const output = audioCtx.createGain();
  let node: AudioWorkletNode | undefined;
  // where the voices before the effects go (the probe of the perf build)
  let probe: AudioNode | null = null;
  let destroyed = false;

  const make: MakeEngine = (processorOptions, { report, fail }) => {
    const current = new AudioWorkletNode(audioCtx, ENGINE_PROCESSOR, {
      ...(__PERF__ ? PROBED_NODE_OPTIONS : ENGINE_NODE_OPTIONS),
      processorOptions,
    });
    node = current;
    // the processor threw: it outputs silence from now on, a retry creates a new one
    current.onprocessorerror = (event) => fail(event);
    current.port.onmessage = ({ data }: MessageEvent<EngineReport>) => report(data);
    current.connect(output, 0);
    if (probe) {
      current.connect(probe, 1, 0);
      current.port.postMessage({ probe: true } satisfies EngineMessage);
    }
    return {
      post: (message, transfer) => {
        if (transfer) current.port.postMessage(message, transfer);
        else current.port.postMessage(message);
      },
      // the processor ends (its engine is freed: it keeps its state in the memory of the module until then)
      close: () => {
        if (node === current) node = undefined;
        current.port.postMessage({ stop: true } satisfies EngineMessage);
        current.disconnect();
      },
    };
  };

  const host = createEngineHost(() =>
    isWorkletSupported(audioCtx, ENGINE_MODULE) ? loadWorklet(audioCtx, ENGINE_MODULE).then(() => make) : null
  );

  return {
    ...host,
    output,
    // the voices as the chain takes them into input 0 of `target` (null: no more); the perf build: a node has the
    // output for it only there
    tapVoices: (target: AudioNode | null) => {
      if (!__PERF__) return;
      if (probe && node) node.disconnect(probe, 1, 0);
      probe = target;
      if (probe && node) node.connect(probe, 1, 0);
      host.post({ probe: target !== null });
    },
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      host.destroy();
      output.disconnect();
    },
  };
};
