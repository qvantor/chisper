import type { Clip } from '../../libs/preset-schema/src';
import { db } from './db';

// a Postgres error of SQLSTATE `code` on `constraint`
const violation = (code: string) => (error: unknown, constraint: string) => {
  const { code: errorCode, constraint_name } = error as { code?: string; constraint_name?: string };
  return errorCode === code && constraint_name === constraint;
};
export const isUniqueViolation = violation('23505');
export const isForeignKeyViolation = violation('23503');

// a clip as it is stored: its name apart from its data (the same notes under another name are the same clip)
export const clipOfRow = (name: string | null, data: Omit<Clip, 'name'>): Clip => ({
  ...data,
  ...(name !== null && { name }),
});

// the rows an IP made in the last hour (its limits)
export const countLastHour = async (table: 'presets' | 'reports' | 'clips', ipHash: string) => {
  const sql = db();
  const [{ count }] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM ${sql(table)}
    WHERE ip_hash = ${ipHash} AND created_at > now() - interval '1 hour'`;
  return count;
};
