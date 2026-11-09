import toast from 'react-hot-toast';
import {
  clearUrlPresetId,
  clipUrl,
  getUrlClipId,
  getUrlPresetId,
  presetUrl,
  setUrlClipId,
  setUrlPresetId,
  shareClip,
  sharePreset,
} from './url';

describe('url', () => {
  it('reads the preset id from the search params', () => {
    expect(getUrlPresetId()).toBeNull();
    window.history.replaceState(null, '', '/?preset=abc');
    expect(getUrlPresetId()).toBe('abc');
  });

  it('builds a preset url without other params', () => {
    window.history.replaceState(null, '', '/synth?osc1-u=3#x');
    expect(presetUrl('a b')).toBe(`${window.location.origin}/synth?preset=a+b`);
  });

  it('replaces the url with the preset id', () => {
    window.history.replaceState(null, '', '/?osc1-u=3');
    const length = window.history.length;
    setUrlPresetId('xyz');
    expect(window.location.search).toBe('?preset=xyz');
    expect(window.history.length).toBe(length);
  });

  it('clears the preset id and the legacy params', () => {
    window.history.replaceState(null, '', '/synth?preset=xyz&osc1-u=3');
    const length = window.history.length;
    clearUrlPresetId();
    expect(window.location.pathname).toBe('/synth');
    expect(window.location.search).toBe('');
    expect(window.history.length).toBe(length);
  });

  it('keeps the clip of the track beside the preset', () => {
    window.history.replaceState(null, '', '/?clip=c1&osc1-u=3');
    setUrlPresetId('p1');
    expect(window.location.search).toBe('?preset=p1&clip=c1');
    expect(getUrlClipId()).toBe('c1');
    clearUrlPresetId();
    expect(window.location.search).toBe('?clip=c1');
    setUrlPresetId('p2');
    setUrlClipId('c2');
    expect(window.location.search).toBe('?preset=p2&clip=c2');
    setUrlClipId(null);
    expect(window.location.search).toBe('?preset=p2');
  });

  it('builds a link to a clip with a preset or without one', () => {
    window.history.replaceState(null, '', '/?preset=x');
    expect(clipUrl('c1', 'p1')).toBe(`${window.location.origin}/?preset=p1&clip=c1`);
    expect(clipUrl('c1', null)).toBe(`${window.location.origin}/?clip=c1`);
  });

  describe('sharePreset', () => {
    const writeText = jest.fn();
    beforeEach(() => {
      Object.assign(navigator, { clipboard: { writeText } });
    });

    it('copies the preset url', async () => {
      writeText.mockResolvedValue(undefined);
      await sharePreset('id1');
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/?preset=id1`);
      expect(toast.success).toHaveBeenCalled();
    });

    it('copies the link to a clip', async () => {
      writeText.mockResolvedValue(undefined);
      await shareClip('c1', 'p1');
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/?preset=p1&clip=c1`);
    });

    it('shows an error when the clipboard is unavailable', async () => {
      writeText.mockRejectedValue(new Error('denied'));
      await sharePreset('id1');
      expect(toast.error).toHaveBeenCalledWith('Could not copy the link');
    });
  });
});
