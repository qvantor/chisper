import { normalizePreset, presetHash } from '../../libs/preset-schema/src';
import { rehashPresets } from '../utils/rehash';

// a preset as the schema of now stores it
const stored = (data: unknown, id: string) => {
  const normalized = normalizePreset(data);
  return { id, hash: presetHash(normalized), data: normalized };
};

// the same preset as a schema before the chorus stored it: no chorus, its old order, another hash
const before = (data: unknown, id: string) => {
  const { fx, ...rest } = normalizePreset(data);
  const { chorus, o, ...effects } = fx;
  expect(chorus).toBeDefined();
  return {
    id,
    hash: `old-${id}`,
    data: { ...rest, fx: { ...effects, o: o.filter((type) => type !== 'chorus') } },
  };
};

const SOUND = { osc1: { u: 4 }, fx: { o: ['reverb', 'delay', 'distortion'], reverb: { a: true, decay: 3 } } };

describe('rehashPresets', () => {
  it('leaves the presets of the schema of now alone', () => {
    const rows = [stored({}, 'a'), stored(SOUND, 'b')];
    expect(rehashPresets(rows)).toEqual({ changes: [], invalid: [], collisions: [] });
  });

  it('a preset from before the chorus gets it with its defaults, in its place, and its new hash', () => {
    const row = before(SOUND, 'b');
    const { changes, invalid, collisions } = rehashPresets([row]);
    expect(invalid).toEqual([]);
    expect(collisions).toEqual([]);
    expect(changes).toHaveLength(1);
    const [{ id, hash, data }] = changes;
    expect(id).toBe('b');
    expect(hash).toBe(stored(SOUND, 'b').hash);
    expect(data).toEqual(stored(SOUND, 'b').data);
    const { fx } = data as ReturnType<typeof normalizePreset>;
    expect(fx.o).toEqual(['chorus', 'compressor', 'reverb', 'delay', 'distortion']);
    expect(fx.chorus).toMatchObject({ a: false, on: true, mix: 0.5, rate: 0.078, depth: 26, fb: 0.095 });
    // the sound itself is kept
    expect(fx.reverb).toMatchObject({ a: true, decay: 3 });
  });

  it('the order of the keys of a stored preset (jsonb has its own) is no change', () => {
    const row = stored(SOUND, 'b');
    const reversed = (value: unknown): unknown =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value)
              .reverse()
              .map(([key, inner]) => [key, reversed(inner)])
          )
        : value;
    expect(rehashPresets([{ ...row, data: reversed(row.data) }]).changes).toEqual([]);
  });

  it('a right hash over old data, or old data under a right hash, is a change too', () => {
    const now = stored(SOUND, 'b');
    expect(rehashPresets([{ ...now, hash: 'stale' }]).changes).toEqual([now]);
    expect(rehashPresets([{ ...before(SOUND, 'b'), hash: now.hash }]).changes).toEqual([now]);
  });

  it('a row the schema rejects is reported and left alone', () => {
    const { changes, invalid } = rehashPresets([
      { id: 'bad', hash: 'x', data: { osc1: { u: 99 } } },
      { id: 'null', hash: 'y', data: null },
      before({}, 'ok'),
    ]);
    expect(invalid.map(({ id }) => id)).toEqual(['bad', 'null']);
    invalid.forEach(({ error }) => expect(error).not.toBe(''));
    expect(changes.map(({ id }) => id)).toEqual(['ok']);
  });

  it('presets that become one sound are reported: their hash is unique in the table', () => {
    // the same sound saved twice by schemas apart: one with the chorus at its defaults, one without it
    const rows = [stored(SOUND, 'new'), before(SOUND, 'old'), before({}, 'other')];
    const { collisions, changes } = rehashPresets(rows);
    expect(collisions).toEqual([['new', 'old']]);
    expect(changes.map(({ id }) => id)).toEqual(['old', 'other']);
  });
});
