// The flags of the presets of the database (db/migrations/007_preset_info.sql) and the names they had before them:
// `factory` for every preset of the synth (its author's: the one ip hash of FACTORY_IP_PREFIX; cleanup keeps them),
// `ai_generated` for every one of them named "[AI] …" and for the ids of `--ai=<file>` (a JSON list of ids, or an
// object of them as keys: the edit-tokens.json of a batch of ported presets). Such a name loses the prefix "[AI] " and
// then "FX " (that preset is of the category FX: its name said so), RENAMES where the bare name is taken. A preset of
// a user named "[AI] …" (a copy of one of the author's, saved with a change) stays as it is. Names are unique: a
// name two presets would have stops the run. A dry run unless `--apply` (DATABASE_URL of .env or of the
// environment); then `netlify api purgeCache` (the CDN keeps the presets of before a day).
//   node scripts/presets/flags.mjs [--ai=<file>] [--apply]
import { readFileSync } from 'node:fs';
import { parseArgs } from '../bench-common.mjs';
import { isMain } from '../site/main.mjs';
import { withPresetsDb, writeChanges } from './db.mjs';

export const FACTORY_IP_PREFIX = '389e880d';

// a name the bare one of which another preset has (checked 2026-11-23: "Reverse Swell" is a pad, featured)
const RENAMES = { '[AI] FX Reverse Swell': 'Reverse Riser' };

const AI_PREFIX = /^\[AI\]\s*/;
const FX_PREFIX = /^FX\s+/;

// the ids of a file of --ai: a list, or the keys of an object
export const idsOf = (json) => (Array.isArray(json) ? json : Object.keys(json ?? {})).map(String);

// what a name becomes: without "[AI] ", then without "FX " (an FX), or its rename
export const bareName = (name) => {
  if (!AI_PREFIX.test(name)) return { name, fx: false };
  const stripped = name.replace(AI_PREFIX, '');
  const fx = FX_PREFIX.test(stripped);
  return { name: RENAMES[name] ?? (fx ? stripped.replace(FX_PREFIX, '') : stripped), fx };
};

// the rows to write and a report (pure: the test of the script); rows: {id, name, ipHash, factory, aiGenerated,
// category}
export const plan = (rows, { aiIds = [] } = {}) => {
  const hashes = [
    ...new Set(rows.map(({ ipHash }) => ipHash).filter((hash) => hash.startsWith(FACTORY_IP_PREFIX))),
  ];
  if (hashes.length !== 1)
    return {
      changes: [],
      lines: [`${hashes.length} ip hashes start with ${FACTORY_IP_PREFIX}: one is the author's`],
      blocked: true,
    };
  const [factoryHash] = hashes;
  const ai = new Set(aiIds.map((id) => id.toLowerCase()));
  const known = new Set(rows.map(({ id }) => id.toLowerCase()));
  const unknown = [...ai].filter((id) => !known.has(id));

  const changes = [];
  const finalNames = new Map();
  for (const row of rows) {
    const bare = row.ipHash === factoryHash ? bareName(row.name) : { name: row.name, fx: false };
    const next = {
      id: row.id,
      name: bare.name,
      factory: row.factory || row.ipHash === factoryHash,
      aiGenerated: row.aiGenerated || bare.name !== row.name || ai.has(row.id.toLowerCase()),
      category: row.category ?? (bare.fx ? 'fx' : null),
    };
    const changed =
      next.name !== row.name ||
      next.factory !== row.factory ||
      next.aiGenerated !== row.aiGenerated ||
      next.category !== row.category;
    if (changed) changes.push({ ...next, from: row.name });
    const key = next.name.trim().toLowerCase();
    finalNames.set(key, [
      ...(finalNames.get(key) ?? []),
      next.name === row.name ? row.name : `${row.name} → ${next.name}`,
    ]);
  }
  const collisions = [...finalNames.entries()].filter(([key, names]) => key === '' || names.length > 1);
  const renamed = changes.filter(({ name, from }) => name !== from);
  const changed = new Map(changes.map((change) => [change.id, change]));
  const count = (key) => rows.filter((row) => row[key] || changed.get(row.id)?.[key]).length;
  const lines = [
    `${rows.length} presets: ${count('factory')} factory, ${count('aiGenerated')} AI generated, ` +
      `${renamed.length} renamed, ${changes.length} to write`,
    ...renamed.map(({ from, name }) => `  ${from} → ${name}`),
    ...unknown.map((id) => `  no preset ${id} of --ai`),
    ...collisions.map(([, names]) => `  one name: ${names.join(', ')}`),
  ];
  return { changes, lines, blocked: collisions.length > 0 };
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const aiIds = args.ai ? idsOf(JSON.parse(readFileSync(args.ai, 'utf8'))) : [];
  await withPresetsDb(async (sql) => {
    const rows = await sql`
      SELECT id, name, ip_hash AS "ipHash", factory, ai_generated AS "aiGenerated", category
      FROM presets ORDER BY created_at, id`;
    const { changes, lines, blocked } = plan(rows, { aiIds });
    lines.forEach((line) => console.log(line));
    if (blocked) {
      console.log('names two presets would have: a rename in RENAMES first');
      process.exitCode = 1;
      return;
    }
    if (!args.apply) {
      console.log('a dry run: --apply writes them');
      return;
    }
    // a name only loses its prefix: none takes the name another one leaves (one would be the same name at the end)
    await writeChanges(
      sql,
      changes,
      (transaction, { id, name, factory, aiGenerated, category }) => transaction`
        UPDATE presets SET name = ${name}, factory = ${factory}, ai_generated = ${aiGenerated},
          category = ${category}
        WHERE id = ${id}`
    );
  });
};

if (isMain(import.meta)) await main();
