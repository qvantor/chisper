import { registrar } from 'standardized-audio-context-mock';
import {
  CHAIN_PROCESSOR,
  ChainMessage,
  ChainOptions,
  ChainReport,
} from '../app/synth/common/chain/chain-params';

// the node of the chain as the stub of test-setup makes it: its name, the options it was made with, a port that
// records what it is posted
export interface ChainNodeStub extends AudioWorkletNode {
  name: string;
  options: AudioWorkletNodeOptions & { processorOptions: ChainOptions };
  port: AudioWorkletNode['port'] & { postMessage: jest.Mock<void, [ChainMessage]> };
}

// the worklet module loads asynchronously: the node exists after the pending promises settle
export const flushChain = () => new Promise((resolve) => setTimeout(resolve));

// the nodes of the chain a context has had, in the order they were made (a retry makes another)
export const chainNodes = (audioCtx: BaseAudioContext) =>
  (
    registrar.getAudioNodes(audioCtx as never, 'AudioWorkletNode' as never) as unknown as ChainNodeStub[]
  ).filter(({ name }) => name === CHAIN_PROCESSOR);

// the node that plays (the last one made; none yet: an error, the spec forgot to wait for it)
export const chainNode = (audioCtx: BaseAudioContext) => {
  const nodes = chainNodes(audioCtx);
  if (nodes.length === 0) throw new Error('no chain node yet');
  return nodes[nodes.length - 1];
};

// everything a node was posted, in order
export const chainPosts = (node: ChainNodeStub): ChainMessage[] =>
  node.port.postMessage.mock.calls.map(([message]) => message);

// a message of the worklet to the main thread
export const chainReports = (node: ChainNodeStub, data: ChainReport) =>
  node.port.onmessage?.({ data } as MessageEvent);
