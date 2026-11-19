import { registrar } from 'standardized-audio-context-mock';
import { ChainMessage, ChainReport } from '../app/synth/common/chain/chain-params';
import { ENGINE_PROCESSOR, EngineOptions } from '../app/synth/common/engine/engine-params';

// the node of the engine as the chain sees it (the stub of test-setup makes it): its name, the options it was made
// with, a port that records what it is posted
export interface ChainNodeStub extends AudioWorkletNode {
  name: string;
  options: AudioWorkletNodeOptions & { processorOptions: EngineOptions };
  port: AudioWorkletNode['port'] & { postMessage: jest.Mock<void, [ChainMessage]> };
}

// the worklet module loads asynchronously: the node exists after the pending promises settle
export const flushChain = () => new Promise((resolve) => setTimeout(resolve));

// the nodes of the engine a context has had, in the order they were made (a retry makes another), as `Stub` sees
// them (the chain: what it is posted; the voices: voice-events.ts)
export const engineNodes = <Stub extends { name: string }>(audioCtx: BaseAudioContext) =>
  (registrar.getAudioNodes(audioCtx as never, 'AudioWorkletNode' as never) as unknown as Stub[]).filter(
    ({ name }) => name === ENGINE_PROCESSOR
  );
export const chainNodes = (audioCtx: BaseAudioContext) => engineNodes<ChainNodeStub>(audioCtx);

// the node that plays (the last one made; none yet: an error, the spec forgot to wait for it)
export const chainNode = (audioCtx: BaseAudioContext) => {
  const nodes = chainNodes(audioCtx);
  if (nodes.length === 0) throw new Error('no engine node yet');
  return nodes[nodes.length - 1];
};

// everything a node was posted for its chain, in order (not the events of its voices, the port and the requests of
// its store)
export const chainPosts = (node: ChainNodeStub): ChainMessage[] =>
  node.port.postMessage.mock.calls
    .map(([message]) => message)
    .filter((message) => !('events' in message || 'port' in message || 'stats' in message));

// a message of the worklet to the main thread
export const chainReports = (node: ChainNodeStub, data: ChainReport) =>
  node.port.onmessage?.({ data } as MessageEvent);
