// reads the chunks of a RIFF WAVE file and the frames of an ID3v2.3 tag back, as the specs check them

export const bytesView = (bytes: Uint8Array) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

export const bytesText = (bytes: Uint8Array, at = 0, length = bytes.length - at) =>
  String.fromCharCode(...bytes.subarray(at, at + length));

// text ended by NULs (a field of a fixed size, a text of INFO): the text before them
export const nulText = (bytes: Uint8Array, at = 0, length = bytes.length - at) =>
  bytesText(bytes, at, length).replace(/\0+$/, '');

// the chunks from `from` (after WAVE by default; 4: those of a LIST, after its type): each its id, the size it tells
// and its body (an odd one's pad byte after it skipped)
export const riffChunks = (bytes: Uint8Array, from = 12) => {
  const chunks: { id: string; size: number; at: number; body: Uint8Array }[] = [];
  const view = bytesView(bytes);
  for (let at = from; at + 8 <= bytes.length;) {
    const size = view.getUint32(at + 4, true);
    chunks.push({
      id: bytesText(bytes, at, 4),
      size,
      at: at + 8,
      body: bytes.subarray(at + 8, at + 8 + size),
    });
    at += 8 + size + (size % 2);
  }
  return chunks;
};

// the frames of an ID3v2.3 tag by id (its size synchsafe, theirs 32 bits big endian); throws on a size that is not
// the tag's or a frame with flags
export const id3Frames = (bytes: Uint8Array) => {
  const view = bytesView(bytes);
  if (bytesText(bytes, 0, 3) !== 'ID3' || bytes[3] !== 3) throw new Error('Not an ID3v2.3 tag');
  const size = (bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9];
  if (size !== bytes.length - 10) throw new Error(`The tag tells ${size} bytes, it has ${bytes.length - 10}`);
  const frames = new Map<string, Uint8Array>();
  for (let at = 10; at < bytes.length;) {
    const length = view.getUint32(at + 4);
    if (view.getUint16(at + 8) !== 0) throw new Error('A frame with flags');
    frames.set(bytesText(bytes, at, 4), bytes.subarray(at + 10, at + 10 + length));
    at += 10 + length;
  }
  return frames;
};

// text of ID3 in its encoding: 0 ISO-8859-1, 1 UTF-16 from its BOM (little endian)
export const id3Text = (encoding: number, bytes: Uint8Array) => {
  if (encoding === 0) return bytesText(bytes);
  if (bytes[0] !== 0xff || bytes[1] !== 0xfe) throw new Error('UTF-16 without its BOM');
  return String.fromCharCode(...new Uint16Array(bytes.slice(2).buffer));
};

// the text of a text frame (its encoding first)
export const id3TextFrame = (body: Uint8Array | undefined) =>
  body ? id3Text(body[0], body.subarray(1)) : undefined;
