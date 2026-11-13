import { normalizePreset, presetHash } from '../../libs/preset-schema/src';

// A change of the preset schema (a new effect, a new knob with a default) changes what every stored preset
// normalizes to and so its hash: the rows are brought to the schema of now. Pure: scripts/presets/rehash.mjs reads
// the rows and writes the changes (run on production before the deploy of such a change: no file of db/migrations)

export interface PresetRow {
  id: string;
  hash: string;
  data: unknown;
}

export interface Rehashed {
  // the rows whose data or hash differ from those of the schema of now
  changes: PresetRow[];
  // the rows the schema rejects (never saved by it: left as they are), with why
  invalid: { id: string; error: string }[];
  // presets that become the same sound (one hash): the ids of each group, the first one keeps the hash
  collisions: string[][];
}

// a value with the keys of its objects in order: jsonb gives them back in an order of its own
const ordered = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(ordered);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, ordered((value as Record<string, unknown>)[key])])
  );
};
const same = (a: unknown, b: unknown) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));

export const rehashPresets = (rows: PresetRow[]): Rehashed => {
  const result: Rehashed = { changes: [], invalid: [], collisions: [] };
  const byHash = new Map<string, string[]>();
  for (const row of rows) {
    let data: ReturnType<typeof normalizePreset>;
    try {
      data = normalizePreset(row.data);
    } catch (error) {
      result.invalid.push({ id: row.id, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const hash = presetHash(data);
    byHash.set(hash, [...(byHash.get(hash) ?? []), row.id]);
    if (hash !== row.hash || !same(data, row.data)) result.changes.push({ id: row.id, hash, data });
  }
  result.collisions = [...byHash.values()].filter((ids) => ids.length > 1);
  return result;
};
