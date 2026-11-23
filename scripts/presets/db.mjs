// The database of the presets for a script of this folder: DATABASE_URL of .env or of the environment, one
// connection, closed after `run`.
import { readEnv } from '../bench-common.mjs';

export const withPresetsDb = async (run) => {
  readEnv();
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL of .env: the database of the presets');
  // (ESM only: a require of it gives its namespace, not the function)
  const { default: postgres } = await import('postgres');
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
  try {
    return await run(sql);
  } finally {
    await sql.end();
  }
};

// the rows of a plan written in one transaction, `update` the query of each (a list: postgres.js pipelines them, in
// their order), then what is left to do
export const writeChanges = async (sql, changes, update) => {
  await sql.begin((transaction) => changes.map((change) => update(transaction, change)));
  console.log(`${changes.length} presets written: netlify api purgeCache`);
};
