import { REVOKE_MS, saveFile } from './save-file';

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('saveFile', () => {
  it('clicks a link of the file and its name; keeps its URL long after (a browser may read it late)', () => {
    jest.useFakeTimers();
    const createObjectURL = jest.fn((_: Blob) => 'blob:x');
    const revokeObjectURL = jest.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const blob = new Blob(['RIFF'], { type: 'audio/wav' });
    saveFile(blob, 'Pad 120 BPM.wav');
    expect(createObjectURL).toHaveBeenCalledWith(blob);
    const link = click.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(link.href).toBe('blob:x');
    expect(link.download).toBe('Pad 120 BPM.wav');
    expect(REVOKE_MS).toBe(40_000);
    jest.advanceTimersByTime(REVOKE_MS - 1);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:x');
  });
});
