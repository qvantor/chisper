export const slice = (array: Float32Array, from: number, count: number) => {
  const slice = [];
  for (let i = from; i < from + count; i++) slice.push(array[i]);
  return slice;
};

// the bytes of the parts one after another, in a buffer of their own
export const concat = (parts: readonly Uint8Array[]) => {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
};
