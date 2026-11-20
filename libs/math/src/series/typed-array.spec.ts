import { concat, slice } from './typed-array';

describe('typedArray.slice', () => {
  const array = new Float32Array([0, 1, 2, 3, 4]);

  it('copies count items starting from index into a plain array', () => {
    const result = slice(array, 1, 3);
    expect(result).toEqual([1, 2, 3]);
    expect(Array.isArray(result)).toBe(true);
  });

  it('returns an empty array for zero count', () => {
    expect(slice(array, 2, 0)).toEqual([]);
  });

  it('fills out-of-range items with undefined', () => {
    expect(slice(array, 4, 2)).toEqual([4, undefined]);
  });
});

describe('typedArray.concat', () => {
  it('puts the parts one after another in a buffer of their own', () => {
    const first = Uint8Array.of(1, 2, 3).subarray(1);
    const result = concat([first, Uint8Array.of(), Uint8Array.of(4)]);
    expect([...result]).toEqual([2, 3, 4]);
    expect(result.buffer).not.toBe(first.buffer);
    expect(result.byteLength).toBe(result.buffer.byteLength);
  });

  it('of no parts is empty', () => {
    expect(concat([]).length).toBe(0);
  });
});
