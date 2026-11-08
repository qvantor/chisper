import { getEditToken, setEditToken } from '../../../presets/services/edit-tokens';
import { getClipEditToken, setClipEditToken } from './clip-edit-tokens';

beforeEach(() => {
  localStorage.clear();
});

describe('clip edit tokens', () => {
  it('stores tokens per clip', () => {
    setClipEditToken('a', 'token-a');
    setClipEditToken('b', 'token-b');
    expect(getClipEditToken('a')).toBe('token-a');
    expect(getClipEditToken('b')).toBe('token-b');
    expect(getClipEditToken('c')).toBeUndefined();
    expect(JSON.parse(localStorage.getItem('clipEditTokens') ?? '')).toEqual({ a: 'token-a', b: 'token-b' });
  });

  it('keeps them apart from the tokens of the presets', () => {
    setClipEditToken('a', 'clip-token');
    setEditToken('a', 'preset-token');
    expect(getClipEditToken('a')).toBe('clip-token');
    expect(getEditToken('a')).toBe('preset-token');
  });

  it.each(['not json', 'null', '"string"'])('treats %s in storage as no tokens', (raw) => {
    localStorage.setItem('clipEditTokens', raw);
    expect(getClipEditToken('a')).toBeUndefined();
    setClipEditToken('a', 'token');
    expect(getClipEditToken('a')).toBe('token');
  });
});
