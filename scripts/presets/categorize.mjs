// The categories, subcategories and tags of the presets saved before them (db/migrations/007_preset_info.sql), and
// what each does (its features, worked out of its data as a save does: presetFeatures of libs/preset-schema).
// Without --apply it writes a sheet to check by hand, tmp/presets/categories.csv (or --csv=<file>): every preset
// with what it is (its own info kept, the rest guessed by its name and sound: guessPresetInfo) and why. With
// `--apply --csv=<checked file>` the sheet is written to the database (its info as it says; the description stays)
// and the features of every preset; then `netlify api purgeCache`. DATABASE_URL of .env or of the environment.
// Run it after scripts/presets/flags.mjs: the names lose "FX " there, the category FX taken from it.
//   node scripts/presets/categorize.mjs [--csv=<file>] [--apply]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs, root } from '../bench-common.mjs';
import { loadApp } from '../bench-perf/util.mjs';
import { isMain } from '../site/main.mjs';
import { withPresetsDb, writeChanges } from './db.mjs';

const SHEET = path.join(root, 'tmp', 'presets', 'categories.csv');
const COLUMNS = ['id', 'name', 'factory', 'category', 'subcategory', 'tags', 'reason'];

export const loadSchema = (name = 'categorize') =>
  loadApp({
    contents: `export { guessPresetInfo, normalizePreset, presetFeatures, presetInfoSchema } from './libs/preset-schema/src';`,
    name,
  });

// --- the sheet: CSV, a field in quotes where it has a comma, a quote or a line break ---

const field = (value) => {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export const toCsv = (rows) =>
  [COLUMNS.join(','), ...rows.map((row) => COLUMNS.map((column) => field(row[column])).join(','))].join(
    '\n'
  ) + '\n';

export const parseCsv = (text) => {
  const records = [];
  let record = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        value += '"';
        i++;
      } else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      record.push(value);
      value = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      record.push(value);
      records.push(record);
      record = [];
      value = '';
    } else value += char;
  }
  if (value !== '' || record.length) records.push([...record, value]);
  const [header = [], ...rest] = records.filter((cells) => cells.some((cell) => cell !== ''));
  return rest.map((cells) =>
    Object.fromEntries(header.map((column, i) => [column.trim(), (cells[i] ?? '').trim()]))
  );
};

// --- the plans (pure: the test of the script) ---

// the sheet of the presets: their own info, what is missing guessed. rows: {id, name, factory, category,
// subcategory, tags, data}
export const sheetOf = (rows, { guessPresetInfo, normalizePreset }) =>
  rows.map((row) => {
    let data;
    try {
      data = normalizePreset(row.data);
    } catch {
      data = normalizePreset({});
    }
    // (of its own category the guess is of a subcategory within it)
    const guess = guessPresetInfo(row.name, data, row.category ?? null);
    const tags = row.tags?.length ? row.tags : guess.tags;
    return {
      id: row.id,
      name: row.name,
      factory: row.factory ? 'yes' : '',
      category: guess.category ?? '',
      subcategory: row.subcategory ?? guess.subcategory ?? '',
      tags: tags.join(' '),
      reason: [row.category ? 'its own category' : '', guess.reason].filter(Boolean).join('; '),
    };
  });

const sameList = (a = [], b = []) => a.length === b.length && a.every((item, i) => item === b[i]);

// the rows to write: the info of the checked sheet (validated by the schema) and the features of every preset.
// rows: {id, name, category, subcategory, description, tags, features, data}
export const planApply = (rows, sheet, { presetInfoSchema, presetFeatures, normalizePreset }) => {
  const byId = new Map(sheet.map((entry) => [entry.id.toLowerCase(), entry]));
  const known = new Set(rows.map(({ id }) => id.toLowerCase()));
  const errors = [...byId.keys()]
    .filter((id) => !known.has(id))
    .map((id) => `  no preset ${id} of the sheet`);
  // (they don't stop the run)
  const warnings = [];
  const changes = [];
  for (const row of rows) {
    const entry = byId.get(row.id.toLowerCase());
    let info = { category: row.category, subcategory: row.subcategory, tags: row.tags ?? [] };
    if (entry) {
      const parsed = presetInfoSchema.safeParse({
        category: entry.category || null,
        subcategory: entry.subcategory || null,
        description: row.description,
        tags: entry.tags ? entry.tags.split(/[\s,]+/).filter(Boolean) : [],
      });
      if (!parsed.success) {
        errors.push(
          `  ${row.name} (${row.id}): ${parsed.error.issues.map(({ message }) => message).join('; ')}`
        );
        continue;
      }
      info = parsed.data;
    }
    let features = row.features ?? [];
    try {
      features = presetFeatures(normalizePreset(row.data));
    } catch {
      warnings.push(`  ${row.name} (${row.id}): the schema rejects its data, its features kept`);
    }
    const changed =
      info.category !== row.category ||
      info.subcategory !== row.subcategory ||
      !sameList(info.tags, row.tags ?? []) ||
      !sameList(features, row.features ?? []);
    if (changed) changes.push({ id: row.id, ...info, features });
  }
  const changed = new Map(changes.map((change) => [change.id, change]));
  const categorized = rows.filter((row) => (changed.get(row.id) ?? row).category).length;
  return {
    changes,
    lines: [
      `${rows.length} presets, ${byId.size} of the sheet, ${changes.length} to write, ${categorized} of a category`,
      ...errors,
      ...warnings,
    ],
    blocked: errors.length > 0,
  };
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const schema = await loadSchema();
  const file = args.csv === undefined ? SHEET : path.resolve(args.csv);
  await withPresetsDb(async (sql) => {
    const rows = await sql`
      SELECT id, name, factory, category, subcategory, description, tags, features, data
      FROM presets ORDER BY factory DESC, category NULLS LAST, name`;
    if (!args.apply) {
      const sheet = sheetOf(rows, schema);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, toCsv(sheet));
      const guessed = sheet.filter(({ category }) => category).length;
      console.log(`${rows.length} presets, ${guessed} of a category: ${path.relative(process.cwd(), file)}`);
      console.log('check it by hand, then: --apply --csv=<the file>');
      return;
    }
    const { changes, lines, blocked } = planApply(rows, parseCsv(readFileSync(file, 'utf8')), schema);
    lines.forEach((line) => console.log(line));
    if (blocked) {
      process.exitCode = 1;
      return;
    }
    await writeChanges(
      sql,
      changes,
      (transaction, { id, category, subcategory, tags, features }) => transaction`
        UPDATE presets SET category = ${category}, subcategory = ${subcategory}, tags = ${tags}::text[],
          features = ${features}::text[]
        WHERE id = ${id}`
    );
  });
};

if (isMain(import.meta)) await main();
