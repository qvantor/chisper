import { db } from './db';

export const isUniqueViolation = (error: unknown, constraint: string) => {
  const { code, constraint_name } = error as { code?: string; constraint_name?: string };
  return code === '23505' && constraint_name === constraint;
};

// the rows an IP made in the last hour (its limits)
export const countLastHour = async (table: 'presets' | 'reports' | 'clips', ipHash: string) => {
  const sql = db();
  const [{ count }] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM ${sql(table)}
    WHERE ip_hash = ${ipHash} AND created_at > now() - interval '1 hour'`;
  return count;
};
