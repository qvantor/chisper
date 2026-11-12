import type { Config, Context } from '@netlify/functions';
import type { z } from 'zod';
import {
  clipIdSchema,
  normalizeClip,
  normalizedClipHash,
  saveClipRequestSchema,
  updateClipRequestSchema,
} from '../../libs/preset-schema/src';
import type { Clip, ClipResponse, SaveClipResponse, UpdateClipResponse } from '../../libs/preset-schema/src';
import { clipTag, purgeTags } from '../utils/cdn-cache';
import { db } from '../utils/db';
import { matchesEditToken, newEditToken } from '../utils/edit-token';
import { errorResponse, getIpHash, HttpError, json, readJson } from '../utils/http';
import { clipOfRow, countLastHour, isUniqueViolation } from '../utils/queries';
import { verifyTurnstile } from '../utils/turnstile';

// clips of the track: opened only by their links (`?clip=<id>`), no list, no search, no scores

// a clip of CLIP_NOTES_MAX notes at their longest numbers is ~49 KB of JSON, a captcha token up to 4 KB
const MAX_BODY_BYTES = 64 * 1024;
const SAVES_PER_HOUR = 10;
const UPDATE_INTERVAL_SECONDS = 5;

const findByHash = async (hash: string) =>
  (await db()<{ id: string }[]>`SELECT id FROM clips WHERE hash = ${hash}`)[0];

// the name is the only part typed by hand: a profane one is told, the rest is a broken client
const invalidClip = (error: z.ZodError) => {
  const name = error.issues.find(
    ({ path, code }) => path[0] === 'clip' && path[1] === 'name' && code === 'custom'
  );
  return new HttpError(400, name?.message ?? 'Invalid clip');
};

// the name is stored apart from the data: the same notes under another name are the same clip (its hash)
const parseClipBody = async <T extends { clip: unknown }>(req: Request, schema: z.ZodType<T>) => {
  const parsed = schema.safeParse(await readJson(req, MAX_BODY_BYTES));
  if (!parsed.success) throw invalidClip(parsed.error);
  const { name, ...data } = normalizeClip(parsed.data.clip);
  return { ...parsed.data, name: name ?? null, data, hash: normalizedClipHash(data) };
};

// in lower case, as the DB gives it: Postgres takes a uuid in any case, the tags of the CDN are those of the DB
const parseId = (id: string) => {
  const parsed = clipIdSchema.safeParse(id);
  if (!parsed.success) throw new HttpError(400, 'Invalid clip id');
  return parsed.data.toLowerCase();
};

const saveClip = async (req: Request, context: Context) => {
  const { turnstileToken, name, data, hash } = await parseClipBody(req, saveClipRequestSchema);

  const sql = db();
  const ipHash = getIpHash(context);
  const [existing, count] = await Promise.all([findByHash(hash), countLastHour('clips', ipHash)]);
  // the same notes are returned without spending the captcha, without a token: they may be someone else's
  if (existing) return json({ id: existing.id, existed: true } as SaveClipResponse);
  if (count >= SAVES_PER_HOUR) throw new HttpError(429, 'Too many clips saved, try again later');

  if (!(await verifyTurnstile(turnstileToken, context.ip)))
    throw new HttpError(403, 'Captcha check failed, try again');

  // the author gets the token once, only its hash is stored
  const { token: editToken, hash: editTokenHash } = newEditToken();
  const [inserted] = await sql<{ id: string }[]>`
    INSERT INTO clips (hash, name, data, ip_hash, edit_token_hash)
    VALUES (${hash}, ${name}, ${sql.json(data)}, ${ipHash}, ${editTokenHash})
    ON CONFLICT (hash) DO NOTHING
    RETURNING id`;
  if (inserted) return json({ id: inserted.id, existed: false, editToken } as SaveClipResponse, 201);

  // saved by a concurrent request since the lookup above
  const concurrent = await findByHash(hash);
  if (!concurrent) throw new Error(`clip ${hash} conflicted but is gone`);
  return json({ id: concurrent.id, existed: true } as SaveClipResponse);
};

// overwrites the notes and the name, links to the clip play the updated one, so do presets that open with it (the CDN
// keeps them under the tag of the clip; the answer doesn't wait for its purge)
const updateClip = async (id: string, req: Request, context: Context) => {
  const clipId = parseId(id);
  const { editToken, name, data, hash } = await parseClipBody(req, updateClipRequestSchema);

  const sql = db();
  const [clip] = await sql<{ editTokenHash: string | null; throttled: boolean }[]>`
    SELECT edit_token_hash AS "editTokenHash",
      COALESCE(updated_at > now() - make_interval(secs => ${UPDATE_INTERVAL_SECONDS}), false) AS throttled
    FROM clips WHERE id = ${clipId}`;
  if (!clip) throw new HttpError(404, 'Clip not found');
  if (!matchesEditToken(clip.editTokenHash, editToken))
    throw new HttpError(403, 'You can only edit clips saved from this browser');
  if (clip.throttled) throw new HttpError(429, 'Too many updates, try again in a few seconds');

  try {
    await sql`
      UPDATE clips SET hash = ${hash}, name = ${name}, data = ${sql.json(data)}, updated_at = now()
      WHERE id = ${clipId}`;
  } catch (error) {
    // the same notes of this clip are its own row, they never conflict
    if (!isUniqueViolation(error, 'clips_hash_key')) throw error;
    const existing = await findByHash(hash);
    return json({ error: 'These notes are already saved as another clip', ...existing }, 409);
  }
  context.waitUntil(purgeTags([clipTag(clipId)]));
  return json({ id: clipId } as UpdateClipResponse);
};

// cleanup keeps a clip whose link is opened; one write a day at most, and the clip is read even if it fails
const markOpened = async (clipId: string) => {
  try {
    await db()`
      UPDATE clips SET opened_at = now()
      WHERE id = ${clipId} AND (opened_at IS NULL OR opened_at < now() - interval '1 day')`;
  } catch (error) {
    console.error(error);
  }
};

const getClip = async (id: string) => {
  const clipId = parseId(id);
  // (the mark beside the read: a missing clip marks nothing)
  const [[row]] = await Promise.all([
    db()<{ id: string; name: string | null; data: Clip; createdAt: string }[]>`
      SELECT id, name, data, created_at AS "createdAt" FROM clips WHERE id = ${clipId}`,
    markOpened(clipId),
  ]);
  if (!row) throw new HttpError(404, 'Clip not found');

  const { name, data, createdAt } = row;
  // not cached: the author can overwrite the clip
  return json({ id: row.id, clip: clipOfRow(name, data), createdAt } as ClipResponse);
};

export default async (req: Request, context: Context) => {
  try {
    const url = new URL(req.url);
    const [id, ...rest] = url.pathname
      .replace(/^\/api\/clips\/?/, '')
      .split('/')
      .filter(Boolean);
    if (rest.length > 0) throw new HttpError(404, 'Not found');

    // no list of clips: GET /api/clips is not allowed
    if (!id) {
      if (req.method === 'POST') return await saveClip(req, context);
    } else {
      if (req.method === 'GET') return await getClip(id);
      if (req.method === 'PUT') return await updateClip(id, req, context);
    }
    throw new HttpError(405, 'Method not allowed');
  } catch (error) {
    return errorResponse(error);
  }
};

export const config: Config = {
  path: ['/api/clips', '/api/clips/*'],
};
