// The presets of the database brought to the preset schema of this tree (netlify/utils/rehash.ts): a new effect or
// a knob with a default changes what a stored preset normalizes to, and its hash. A dry run unless `--apply`
// (DATABASE_URL of .env or of the environment); run on production before the deploy of such a change (a migration
// of the data: it has no file in db/migrations). A preset the schema rejects is left as it is; presets that would
// get one hash (the same sound saved by schemas apart) stop the run: the hash is unique, one of them has to go
// first.
//   node scripts/presets/rehash.mjs [--apply]
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readEnv } from '../bench-common.mjs';
import { loadApp } from '../bench-perf/util.mjs';

// the changes of `rows` as a report and the rows to write (pure: the test of the script)
export const plan = (rows, rehashPresets) => {
  const { changes, invalid, collisions } = rehashPresets(rows);
  const lines = [
    `${rows.length} presets, ${changes.length} to rewrite, ${invalid.length} the schema rejects`,
    ...invalid.map(({ id, error }) => `  rejected ${id}: ${error.split('\n')[0]}`),
    ...collisions.map((ids) => `  the same sound: ${ids.join(', ')}`),
  ];
  return { changes, lines, blocked: collisions.length > 0 };
};

const main = async () => {
  const apply = process.argv.includes('--apply');
  readEnv();
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL of .env: the database of the presets');
  const { rehashPresets } = await loadApp({
    contents: `export { rehashPresets } from './netlify/utils/rehash';`,
    name: 'rehash',
  });
  // (ESM only: a require of it gives its namespace, not the function)
  const { default: postgres } = await import('postgres');
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
  try {
    const rows = await sql`SELECT id, hash, data FROM presets ORDER BY created_at, id`;
    const { changes, lines, blocked } = plan(rows, rehashPresets);
    lines.forEach((line) => console.log(line));
    if (blocked) {
      console.log('presets of one sound: remove or change all but one of each group first');
      process.exitCode = 1;
      return;
    }
    if (!apply) {
      console.log('a dry run: --apply writes them');
      return;
    }
    await sql.begin(async (transaction) => {
      for (const { id, hash, data } of changes)
        await transaction`UPDATE presets SET data = ${transaction.json(data)}, hash = ${hash} WHERE id = ${id}`;
    });
    console.log(`${changes.length} presets rewritten: netlify api purgeCache`);
  } finally {
    await sql.end();
  }
};

// the module `url` is the script node was started with (import.meta.url is the real path as a URL: a space of the
// path is %20 there, a link is followed; a comparison that misses either would run nothing and exit 0)
export const startedAs = (url, script) => {
  if (!script) return false;
  try {
    return url === pathToFileURL(realpathSync(script)).href;
  } catch {
    return false;
  }
};

if (startedAs(import.meta.url, process.argv[1])) await main();
