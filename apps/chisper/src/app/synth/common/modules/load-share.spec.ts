import { shareAfterLoad, STORE_SHARE } from './load-share';

describe('shareAfterLoad', () => {
  it('waits for the store with a table loaded on its way to it', () => {
    expect(shareAfterLoad(true, 'sending')).toBe(STORE_SHARE);
  });

  it.each([
    ['the wavetable oscillator not ready (it sends the table once it is)', true, undefined],
    ['a table stored at once', true, 'stored'],
    ['a table refused', true, 'refused'],
    ['a failed load (an edit of the version before on its way)', false, 'sending'],
    ['a failed load', false, undefined],
  ] as const)('is none with %s', (_, loaded, state) => {
    expect(shareAfterLoad(loaded, state)).toBeNull();
  });
});
