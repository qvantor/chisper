import { UPDATED } from '../../../common/services';
import { wasmBytes } from '../../../../test-utils/wasm';
import { loadEngineCore } from './engine-core';

// (the url of the core is the bundle's: `import.meta` is no syntax of the specs)
jest.mock('./engine-wasm-url', () => ({
  ENGINE_WASM_URL: 'https://chisper.test/engine.0123456789abcdef.wasm',
}));

// what the server answers: a status, the bytes of the core with a type that is not of wasm (compiled from the bytes)
const answer = (status: number) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: () => 'application/octet-stream' },
  arrayBuffer: () => Promise.resolve(Uint8Array.from(wasmBytes('engine')).buffer),
});

const fetchMock = jest.fn();

beforeEach(() => {
  fetchMock.mockReset();
  Object.assign(globalThis, { fetch: fetchMock });
});

// (one module a page: the specs run in the order of a page, the loads that fail first)
describe('loadEngineCore', () => {
  it('a core that is gone (a page of before a deploy): reload the page, the next export asks again', async () => {
    fetchMock.mockResolvedValue(answer(404));
    await expect(loadEngineCore()).rejects.toThrow(UPDATED);
    await expect(loadEngineCore()).rejects.toThrow(UPDATED);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith('https://chisper.test/engine.0123456789abcdef.wasm');
  });

  it('a server that fails otherwise: its status', async () => {
    fetchMock.mockResolvedValue(answer(503));
    await expect(loadEngineCore()).rejects.toThrow('The engine core failed to load (503)');
  });

  it('compiles the core once a page, an instance of its own each time', async () => {
    fetchMock.mockResolvedValue(answer(200));
    const first = await loadEngineCore();
    const second = await loadEngineCore();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(typeof first.engine_new).toBe('function');
    expect(second.memory).not.toBe(first.memory);
  });
});
