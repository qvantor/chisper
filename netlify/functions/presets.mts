import type { Config, Context } from '@netlify/functions';
import type postgres from 'postgres';
import type { z } from 'zod';
import {
  DATA_FEATURES,
  EMPTY_PRESET_INFO,
  isFiltered,
  isProfane,
  listPresetsQuerySchema,
  normalizePreset,
  presetFeatures,
  presetFilterQuerySchema,
  presetHash,
  presetIdSchema,
  presetNameSchema,
  presetOpenedRequestSchema,
  savePresetRequestSchema,
  sortFeatures,
  tagsMatching,
  updatePresetInfoRequestSchema,
  updatePresetRequestSchema,
} from '../../libs/preset-schema/src';
import type {
  Clip,
  DataFeature,
  NameAvailableResponse,
  Preset,
  PresetCategory,
  PresetCounts,
  PresetFilter,
  PresetInfo,
  PresetListItem,
  PresetSort,
  PresetsPage,
  PresetTag,
  SavePresetResponse,
  TopPresetItem,
  UpdatePresetInfoResponse,
  UpdatePresetResponse,
} from '../../libs/preset-schema/src';
import { cachedHeaders, clipTag, PRESET_CDN_CACHE, presetTag, purgeTags } from '../utils/cdn-cache';
import { db } from '../utils/db';
import { matchesEditToken, newEditToken } from '../utils/edit-token';
import { envNumber } from '../utils/env';
import { empty, errorResponse, getIpHash, HttpError, json, readJson, sha256 } from '../utils/http';
import { clipOfRow, countLastHour, isForeignKeyViolation, isUniqueViolation } from '../utils/queries';
import { verifyTurnstile } from '../utils/turnstile';

const MAX_BODY_BYTES = 20 * 1024;
const SAVES_PER_HOUR = 5;
const REPORTS_PER_HOUR = 20;
const TOP_SIZE = 50;
const PAGE_SIZE = 30;
const UPDATE_INTERVAL_SECONDS = 5;
// the popular presets and the counts of the categories: kept 5 minutes by the CDN
const SUMMARY_CACHE = { 'Cache-Control': 'public, s-maxage=300' };

const nameTakenError = (name: string) => new HttpError(409, `Name “${name}” is already taken`);
// the clip a preset is saved with is gone (deleted by the cleanup) or never was
const clipNotFoundError = () => new HttpError(400, 'Clip not found');

// names are unique case-insensitively, hidden presets keep their names too
const isNameTaken = async (name: string) =>
  (await db()`SELECT 1 FROM presets WHERE lower(name) = lower(${name})`).length > 0;

// the columns of the info of a preset (PresetInfo)
interface InfoRow {
  category: PresetCategory | null;
  subcategory: string | null;
  description: string | null;
  tags: PresetTag[];
}

const infoOf = ({ category, subcategory, description, tags }: InfoRow): PresetInfo => ({
  category,
  subcategory,
  description,
  tags,
});

// the info written into its columns (an update)
const setInfo = (sql: postgres.Sql, info: PresetInfo) =>
  sql`category = ${info.category}, subcategory = ${info.subcategory}, description = ${info.description},
    tags = ${info.tags}::text[]`;

// what a preset does: the features of its data (a column), its clip and AI of its row, in the order of the icons
const featuresOf = (features: DataFeature[], hasClip: boolean, aiGenerated: boolean) =>
  sortFeatures([
    ...features,
    ...(hasClip ? (['clip'] as const) : []),
    ...(aiGenerated ? (['ai'] as const) : []),
  ]);

const findByHash = async (hash: string) => {
  const [row] = await db()<({ id: string; name: string; clipId: string | null } & InfoRow)[]>`
    SELECT id, name, clip_id AS "clipId", category, subcategory, description, tags
    FROM presets WHERE hash = ${hash}`;
  if (!row) return undefined;
  const { id, name, clipId } = row;
  return { id, name, clipId, info: infoOf(row) };
};

// a body zod refused: the description is typed by hand, what is wrong with it (a link, a word) is told; the rest is a
// broken client
const invalidBody = (error: z.ZodError, fallback: string) => {
  const description = error.issues.find(
    ({ path, code }) => path[0] === 'info' && path[1] === 'description' && code === 'custom'
  );
  return new HttpError(400, description?.message ?? fallback);
};

const parsePresetBody = async <T extends { name: string; data: unknown; info?: PresetInfo }>(
  req: Request,
  schema: z.ZodType<T>
) => {
  const parsed = schema.safeParse(await readJson(req, MAX_BODY_BYTES));
  if (!parsed.success) throw invalidBody(parsed.error, 'Invalid preset');
  if (isProfane(parsed.data.name)) throw new HttpError(400, 'Please choose another name');
  const data = normalizePreset(parsed.data.data);
  return { ...parsed.data, data, hash: presetHash(data) };
};

// in lower case, as the DB gives it: Postgres takes a uuid in any case, the tags of the CDN are those of the DB
const parseId = (id: string) => {
  const parsed = presetIdSchema.safeParse(id);
  if (!parsed.success) throw new HttpError(404, 'Preset not found');
  return parsed.data.toLowerCase();
};

const savePreset = async (req: Request, context: Context) => {
  const {
    name,
    turnstileToken,
    data,
    hash,
    clipId = null,
    info = EMPTY_PRESET_INFO,
  } = await parsePresetBody(req, savePresetRequestSchema);

  const sql = db();
  const ipHash = getIpHash(context);
  const [existing, nameTaken, count] = await Promise.all([
    findByHash(hash),
    isNameTaken(name),
    countLastHour('presets', ipHash),
  ]);
  // the same sound is returned without spending the captcha, its name, its clip and its info are kept
  if (existing) return json({ ...existing, existed: true } as SavePresetResponse);
  if (nameTaken) throw nameTakenError(name);
  if (count >= SAVES_PER_HOUR) throw new HttpError(429, 'Too many presets saved, try again later');

  if (!(await verifyTurnstile(turnstileToken, context.ip)))
    throw new HttpError(403, 'Captcha check failed, try again');

  // the author gets the token once, only its hash is stored
  const { token: editToken, hash: editTokenHash } = newEditToken();
  try {
    const [inserted] = await sql<{ id: string; name: string; clipId: string | null }[]>`
      INSERT INTO presets (hash, name, data, ip_hash, edit_token_hash, clip_id,
        category, subcategory, description, tags, features)
      VALUES (${hash}, ${name}, ${sql.json(data)}, ${ipHash}, ${editTokenHash}, ${clipId},
        ${info.category}, ${info.subcategory}, ${info.description}, ${info.tags}::text[],
        ${presetFeatures(data)}::text[])
      ON CONFLICT (hash) DO NOTHING
      RETURNING id, name, clip_id AS "clipId"`;
    if (inserted) return json({ ...inserted, info, existed: false, editToken } as SavePresetResponse, 201);
  } catch (error) {
    // checks above can race with a concurrent save
    if (isUniqueViolation(error, 'presets_name_key')) throw nameTakenError(name);
    if (isForeignKeyViolation(error, 'presets_clip_id_fkey')) throw clipNotFoundError();
    throw error;
  }
  return json({ ...(await findByHash(hash)), existed: true } as SavePresetResponse);
};

// an edit of the author: the preset is there, the token theirs, their last edit a few seconds ago at least
const checkEditable = async (presetId: string, editToken: string) => {
  const [preset] = await db()<{ editTokenHash: string | null; hidden: boolean; throttled: boolean }[]>`
    SELECT edit_token_hash AS "editTokenHash", hidden,
      COALESCE(updated_at > now() - make_interval(secs => ${UPDATE_INTERVAL_SECONDS}), false) AS throttled
    FROM presets WHERE id = ${presetId}`;
  if (!preset || preset.hidden) throw new HttpError(404, 'Preset not found');
  if (!matchesEditToken(preset.editTokenHash, editToken))
    throw new HttpError(403, 'You can only edit presets saved from this browser');
  if (preset.throttled) throw new HttpError(429, 'Too many updates, try again in a few seconds');
};

// overwrites sound and name (and the clip it opens with, when the request names one or null; its info, when the
// request has one), links to the preset play the updated sound (the answer doesn't wait for the purge of the cached
// one)
const updatePreset = async (id: string, req: Request, context: Context) => {
  const presetId = parseId(id);
  const { name, editToken, data, hash, clipId, info } = await parsePresetBody(req, updatePresetRequestSchema);
  await checkEditable(presetId, editToken);

  const sql = db();
  let updated: ({ clipId: string | null } & InfoRow) | undefined;
  try {
    [updated] = await sql<({ clipId: string | null } & InfoRow)[]>`
      UPDATE presets SET name = ${name}, data = ${sql.json(data)}, hash = ${hash},
        features = ${presetFeatures(data)}::text[], updated_at = now()
        ${clipId === undefined ? sql`` : sql`, clip_id = ${clipId}`}
        ${info === undefined ? sql`` : sql`, ${setInfo(sql, info)}`}
      WHERE id = ${presetId}
      RETURNING clip_id AS "clipId", category, subcategory, description, tags`;
  } catch (error) {
    // renaming own preset (e.g. changing case) is the same row, so it never conflicts
    if (isUniqueViolation(error, 'presets_name_key')) throw nameTakenError(name);
    if (isForeignKeyViolation(error, 'presets_clip_id_fkey')) throw clipNotFoundError();
    if (!isUniqueViolation(error, 'presets_hash_key')) throw error;
    const existing = await findByHash(hash);
    return json({ error: `This sound is already saved as “${existing?.name}”`, ...existing }, 409);
  }
  context.waitUntil(purgeTags([presetTag(presetId)]));
  const response: UpdatePresetResponse = {
    id: presetId,
    name,
    clipId: updated?.clipId ?? null,
    info: updated ? infoOf(updated) : (info ?? EMPTY_PRESET_INFO),
  };
  return json(response);
};

// Edit info: the category, description and tags of a preset of the author alone, its sound and hash as they are (its
// cached answer purged as by an update)
const updatePresetInfo = async (id: string, req: Request, context: Context) => {
  const presetId = parseId(id);
  const parsed = updatePresetInfoRequestSchema.safeParse(await readJson(req, MAX_BODY_BYTES));
  if (!parsed.success) throw invalidBody(parsed.error, 'Invalid info');
  const { editToken, info } = parsed.data;
  await checkEditable(presetId, editToken);
  const sql = db();
  await sql`UPDATE presets SET ${setInfo(sql, info)}, updated_at = now() WHERE id = ${presetId}`;
  context.waitUntil(purgeTags([presetTag(presetId)]));
  return json({ id: presetId, info } as UpdatePresetInfoResponse);
};

// the author opened the preset (the client sends the edit token it keeps): cleanup counts the 90 days of an
// unqualified preset from then. At most one write a day; a wrong token, a missing or hidden preset change nothing
const markOpened = async (id: string, req: Request) => {
  const presetId = parseId(id);
  const parsed = presetOpenedRequestSchema.safeParse(await readJson(req, MAX_BODY_BYTES));
  if (!parsed.success) throw new HttpError(400, 'Invalid edit token');
  await db()`
    UPDATE presets SET author_opened_at = now()
    WHERE id = ${presetId} AND edit_token_hash = ${sha256(parsed.data.editToken)} AND NOT hidden
      AND (author_opened_at IS NULL OR author_opened_at < now() - interval '1 day')`;
  return empty();
};

const getNameAvailable = async (url: URL) => {
  const parsed = presetNameSchema.safeParse(url.searchParams.get('name') ?? '');
  if (!parsed.success) throw new HttpError(400, 'Invalid name');
  return json({ available: !(await isNameTaken(parsed.data)) } as NameAvailableResponse);
};

interface PresetRow extends Pick<Preset, 'id' | 'name' | 'data' | 'createdAt' | 'factory'>, InfoRow {
  clipId: string | null;
  clipName: string | null;
  clipData: Omit<Clip, 'name'> | null;
  features: DataFeature[];
  aiGenerated: boolean;
}

// with the clip it opens with (its name in it, as GET /api/clips/:id gives it) and its info. Kept by the CDN under
// the tags of the preset and of its clip: an update of either, a preset hidden by reports or deleted by cleanup
// purge them (PRESET_CDN_CACHE). A missing or hidden preset is a 404 never cached
const getPreset = async (id: string) => {
  const [row] = await db()<PresetRow[]>`
    SELECT p.id, p.name, p.data, p.created_at AS "createdAt",
      c.id AS "clipId", c.name AS "clipName", c.data AS "clipData",
      p.category, p.subcategory, p.description, p.tags, p.factory, p.features, p.ai_generated AS "aiGenerated"
    FROM presets p LEFT JOIN clips c ON c.id = p.clip_id
    WHERE p.id = ${parseId(id)} AND NOT p.hidden`;
  if (!row) throw new HttpError(404, 'Preset not found');
  const { clipId, clipName, clipData } = row;
  const clip =
    clipId !== null && clipData !== null ? { id: clipId, clip: clipOfRow(clipName, clipData) } : null;
  const tags = [presetTag(row.id), ...(clip ? [clipTag(clip.id)] : [])];
  const preset: Preset = {
    id: row.id,
    name: row.name,
    data: row.data,
    createdAt: row.createdAt,
    clip,
    info: infoOf(row),
    factory: row.factory,
    features: featuresOf(row.features, clip !== null, row.aiGenerated),
  };
  return json(preset, 200, cachedHeaders(PRESET_CDN_CACHE, tags));
};

// a row of a list: its info, its origin, what it does
interface ListRow extends Pick<PresetListItem, 'id' | 'name' | 'uniqueUsers' | 'factory'>, InfoRow {
  features: DataFeature[];
  hasClip: boolean;
  aiGenerated: boolean;
}

// the columns of a row of a list and where they come from: the presets shown with their scores
const listColumns = (sql: postgres.Sql) => sql`
  p.id, p.name, COALESCE(s.unique_users, 0) AS "uniqueUsers", p.category, p.subcategory, p.description, p.tags,
  p.factory, p.features, p.clip_id IS NOT NULL AS "hasClip", p.ai_generated AS "aiGenerated"`;
const listedPresets = (sql: postgres.Sql) => sql`
  FROM presets p LEFT JOIN preset_scores s ON s.preset_id = p.id WHERE NOT p.hidden`;

const listItem = (row: ListRow): PresetListItem => ({
  id: row.id,
  name: row.name,
  uniqueUsers: row.uniqueUsers,
  ...infoOf(row),
  features: featuresOf(row.features, row.hasClip, row.aiGenerated),
  factory: row.factory,
});

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (char) => `\\${char}`);

// the conditions of a filter (matchesPresetFilter of the schema filters a list of the browser alike): every tag and
// feature asked for, a search in the name, the description and the labels of the tags
const presetFilter = (
  sql: postgres.Sql,
  { q, category, subcategory, tags = [], features = [], origin }: PresetFilter
) => {
  const data = features.filter((feature): feature is DataFeature =>
    (DATA_FEATURES as readonly string[]).includes(feature)
  );
  const pattern = `%${escapeLike(q ?? '')}%`;
  const matching = q ? tagsMatching(q) : [];
  return sql`
    ${category ? sql`AND p.category = ${category}` : sql``}
    ${subcategory ? sql`AND p.subcategory = ${subcategory}` : sql``}
    ${tags.length ? sql`AND p.tags @> ${tags}::text[]` : sql``}
    ${data.length ? sql`AND p.features @> ${data}::text[]` : sql``}
    ${features.includes('clip') ? sql`AND p.clip_id IS NOT NULL` : sql``}
    ${features.includes('ai') ? sql`AND p.ai_generated` : sql``}
    ${origin === 'factory' ? sql`AND p.factory` : origin === 'community' ? sql`AND NOT p.factory` : sql``}
    ${
      q
        ? sql`AND (p.name ILIKE ${pattern} OR p.description ILIKE ${pattern}
            ${matching.length ? sql`OR p.tags && ${matching}::text[]` : sql``})`
        : sql``
    }`;
};

// every featured preset (curated) comes first, whatever its score, the rest are popular presets by score. Of a
// filter (a category, a tag…) the other presets of it follow by score: few short sounds pass the threshold (a
// listener stays a minute), the Popular of FX would be empty. Each says whether it is popular (featured or over the
// threshold): the browser draws a line before the rest
const getTop = async (url: URL) => {
  const parsed = presetFilterQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) throw new HttpError(400, 'Invalid query');
  const sql = db();
  const filtered = isFiltered(parsed.data);
  const rows = await sql<(ListRow & { popular: boolean })[]>`
    SELECT ${listColumns(sql)}, p.featured OR COALESCE(s.popular, false) AS "popular"
    ${listedPresets(sql)} ${filtered ? presetFilter(sql, parsed.data) : sql`AND (p.featured OR s.popular)`}
    ORDER BY p.featured DESC, ${filtered ? sql`COALESCE(s.popular, false) DESC,` : sql``}
      s.score DESC NULLS LAST, p.created_at DESC, p.id DESC
    LIMIT ${TOP_SIZE}`;
  const items: TopPresetItem[] = rows.map((row) => ({ ...listItem(row), popular: row.popular }));
  return json(items, 200, SUMMARY_CACHE);
};

// the presets of each category and subcategory (the browser hides the empty ones)
const getCounts = async () => {
  const rows = await db()<{ category: PresetCategory | null; subcategory: string | null; count: number }[]>`
    SELECT category, subcategory, count(*)::int AS count FROM presets WHERE NOT hidden
    GROUP BY category, subcategory`;
  const counts: PresetCounts = { total: 0, categories: {} };
  for (const { category, subcategory, count } of rows) {
    counts.total += count;
    if (category === null) continue;
    const entry = (counts.categories[category] ??= { count: 0, subcategories: {} });
    entry.count += count;
    if (subcategory !== null) entry.subcategories[subcategory] = count;
  }
  return json(counts, 200, SUMMARY_CACHE);
};

// keyset pagination, cursor is an opaque [sort key as text, id] pair
const encodeCursor = (key: string, id: string) =>
  Buffer.from(JSON.stringify([key, id])).toString('base64url');
const decodeCursor = (cursor: string): [string, string] => {
  try {
    const [key, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if (typeof key !== 'string' || !presetIdSchema.safeParse(id).success) throw new Error();
    return [key, id];
  } catch (e) {
    throw new HttpError(400, 'Invalid cursor');
  }
};

// these presets of a list of the browser (Favorites, Recent, Mine): those still there, in the order asked, one page
// (the browser filters them: matchesPresetFilter)
const listByIds = async (ids: string[]) => {
  const sql = db();
  const rows = await sql<ListRow[]>`
    SELECT ${listColumns(sql)}
    ${listedPresets(sql)} AND p.id = ANY(${ids}::uuid[])
    ORDER BY array_position(${ids}::uuid[], p.id)`;
  const page: PresetsPage = { items: rows.map(listItem), nextCursor: null };
  return json(page);
};

const listPresets = async (url: URL) => {
  const parsed = listPresetsQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) throw new HttpError(400, 'Invalid query');
  const { q, sort, cursor, ids } = parsed.data;
  if (ids) return await listByIds(ids);
  const sql = db();
  const after = cursor ? decodeCursor(cursor) : null;

  const orders: Record<PresetSort, Record<'key' | 'after' | 'order', postgres.Fragment>> = {
    new: {
      key: sql`p.created_at::text`,
      after: after ? sql`AND (p.created_at, p.id) < (${after[0]}::timestamptz, ${after[1]}::uuid)` : sql``,
      order: sql`p.created_at DESC, p.id DESC`,
    },
    name: {
      key: sql`p.name`,
      after: after ? sql`AND (p.name, p.id) > (${after[0]}, ${after[1]}::uuid)` : sql``,
      order: sql`p.name, p.id`,
    },
    popular: {
      key: sql`COALESCE(s.score, 0)::text`,
      after: after ? sql`AND (COALESCE(s.score, 0), p.id) < (${after[0]}::float8, ${after[1]}::uuid)` : sql``,
      order: sql`COALESCE(s.score, 0) DESC, p.id DESC`,
    },
  };
  const { key, after: afterCondition, order } = orders[sort];

  const rows = await sql<(ListRow & { cursorKey: string })[]>`
    SELECT ${listColumns(sql)}, ${key} AS "cursorKey"
    ${listedPresets(sql)} ${presetFilter(sql, parsed.data)}
      ${afterCondition}
    ORDER BY ${order}
    LIMIT ${PAGE_SIZE + 1}`;

  const items = rows.slice(0, PAGE_SIZE).map(listItem);
  const last = rows[PAGE_SIZE - 1];
  const page: PresetsPage = {
    items,
    nextCursor: rows.length > PAGE_SIZE ? encodeCursor(last.cursorKey, last.id) : null,
  };
  return json(page, 200, { 'Cache-Control': q ? 'no-store' : 'public, s-maxage=60' });
};

const reportPreset = async (id: string, context: Context) => {
  const presetId = parseId(id);
  const sql = db();
  const ipHash = getIpHash(context);
  if ((await countLastHour('reports', ipHash)) >= REPORTS_PER_HOUR)
    throw new HttpError(429, 'Too many reports, try again later');

  const [preset] = await sql`SELECT id FROM presets WHERE id = ${presetId}`;
  if (!preset) throw new HttpError(404, 'Preset not found');

  await sql`INSERT INTO reports (preset_id, ip_hash) VALUES (${presetId}, ${ipHash}) ON CONFLICT DO NOTHING`;
  const hidden = await sql`
    UPDATE presets SET hidden = true
    WHERE id = ${presetId} AND NOT hidden
      AND (SELECT count(*) FROM reports WHERE preset_id = ${presetId}) >= ${envNumber(
        'REPORT_HIDE_THRESHOLD',
        5
      )}
    RETURNING id`;
  // the CDN keeps answering it until purged
  if (hidden.length > 0) context.waitUntil(purgeTags([presetTag(presetId)]));
  return empty();
};

export default async (req: Request, context: Context) => {
  try {
    const url = new URL(req.url);
    const [id, action, ...rest] = url.pathname
      .replace(/^\/api\/presets\/?/, '')
      .split('/')
      .filter(Boolean);
    if (rest.length > 0) throw new HttpError(404, 'Not found');

    if (!id) {
      if (req.method === 'GET') return await listPresets(url);
      if (req.method === 'POST') return await savePreset(req, context);
    } else if (id === 'top' && !action) {
      if (req.method === 'GET') return await getTop(url);
    } else if (id === 'counts' && !action) {
      if (req.method === 'GET') return await getCounts();
    } else if (id === 'name-available' && !action) {
      if (req.method === 'GET') return await getNameAvailable(url);
    } else if (!action) {
      if (req.method === 'GET') return await getPreset(id);
      if (req.method === 'PUT') return await updatePreset(id, req, context);
    } else if (action === 'report') {
      if (req.method === 'POST') return await reportPreset(id, context);
    } else if (action === 'opened') {
      if (req.method === 'POST') return await markOpened(id, req);
    } else if (action === 'info') {
      if (req.method === 'PUT') return await updatePresetInfo(id, req, context);
    } else throw new HttpError(404, 'Not found');
    throw new HttpError(405, 'Method not allowed');
  } catch (error) {
    return errorResponse(error);
  }
};

export const config: Config = {
  path: ['/api/presets', '/api/presets/*'],
};
