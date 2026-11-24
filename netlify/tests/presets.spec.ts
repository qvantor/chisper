import { purgeCache } from '@netlify/functions';
import {
  DESCRIPTION_LINK_MESSAGE,
  EMPTY_PRESET_INFO,
  PRESET_NAME_MAX_LENGTH,
  presetDataSchema,
  presetHash,
} from '../../libs/preset-schema/src';
import { BROWSER_REVALIDATE, PRESET_CDN_CACHE } from '../utils/cdn-cache';
import { sha256 } from '../utils/http';
import { verifyTurnstile } from '../utils/turnstile';
import handler, { config } from '../functions/presets.mjs';
import { createFakeSql, JsonValue, pgError } from './fake-sql';
import { caller, context, ID, IP_HASH, IP_SALT, OTHER_ID, request } from './helpers';

const mockSql = createFakeSql();
jest.mock('../utils/db', () => ({ db: () => mockSql.sql }));
jest.mock('../utils/turnstile', () => ({ verifyTurnstile: jest.fn() }));
jest.mock('@netlify/functions', () => ({ purgeCache: jest.fn() }));

const verifyTurnstileMock = verifyTurnstile as jest.Mock;
const purgeCacheMock = purgeCache as jest.Mock;

const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

// unrounded number to check that the stored sound is normalized
const data = { ...presetDataSchema.parse({}), filter: { a: true, cut: 1234.5678 } };
const EDIT_TOKEN = 'e'.repeat(43);
const CLIP_ID = uuid(77);

// the columns of an empty info, as the DB gives them
const INFO_ROW = { category: null, subcategory: null, description: null, tags: [] };
const INFO = EMPTY_PRESET_INFO;
// a row of a list as the DB gives it and the item of the answer
const listRow = (i: number, row: Record<string, unknown> = {}) => ({
  id: uuid(i),
  name: `P${i}`,
  uniqueUsers: i,
  ...INFO_ROW,
  factory: false,
  features: [],
  hasClip: false,
  aiGenerated: false,
  ...row,
});
const listItem = (i: number, item: Record<string, unknown> = {}) => ({
  id: uuid(i),
  name: `P${i}`,
  uniqueUsers: i,
  ...INFO,
  features: [],
  factory: false,
  ...item,
});

const Q = {
  findByHash:
    /^SELECT id, name, clip_id AS "clipId", category, subcategory, description, tags FROM presets WHERE hash =/,
  nameTaken: /WHERE lower\(name\) = lower/,
  countPresets: /FROM "presets" WHERE ip_hash/,
  countReports: /FROM "reports" WHERE ip_hash/,
  insert: /^INSERT INTO presets/,
  editable: /^SELECT edit_token_hash/,
  update: /^UPDATE presets SET name/,
  info: /^UPDATE presets SET category/,
  opened: /^UPDATE presets SET author_opened_at/,
  get: /^SELECT p\.id, p\.name, p\.data, p\.created_at/,
  top: /AND \(p\.featured OR s\.popular\)/,
  topFiltered: /ORDER BY p\.featured DESC, COALESCE\(s\.popular, false\) DESC/,
  counts: /GROUP BY category, subcategory/,
  list: /AS "cursorKey" FROM presets p LEFT JOIN preset_scores/,
  byIds: /p\.id = ANY/,
  exists: /^SELECT id FROM presets WHERE id/,
  insertReport: /^INSERT INTO reports/,
  hide: /^UPDATE presets SET hidden/,
};

const call = caller(handler);

const decodeCursor = (cursor: string) => JSON.parse(Buffer.from(cursor, 'base64url').toString());
const encodeCursor = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

beforeEach(() => {
  mockSql.reset();
  mockSql.respond(Q.countPresets, [{ count: 0 }]);
  mockSql.respond(Q.countReports, [{ count: 0 }]);
  verifyTurnstileMock.mockReset().mockResolvedValue(true);
  purgeCacheMock.mockReset().mockResolvedValue(undefined);
  process.env.IP_HASH_SALT = IP_SALT;
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.REPORT_HIDE_THRESHOLD;
});

it('is routed to /api/presets', () => {
  expect(config.path).toEqual(['/api/presets', '/api/presets/*']);
});

describe('routing', () => {
  it.each([`/api/presets/${ID}/report/more`, `/api/presets/${ID}/unknown`, '/api/presets/top/x/y'])(
    '404 for %s',
    async (path) => {
      const { status, body } = await call('GET', path);
      expect(status).toBe(404);
      expect(body).toEqual({ error: 'Not found' });
      expect(mockSql.queries).toHaveLength(0);
    }
  );

  it.each([
    ['DELETE', '/api/presets'],
    ['PUT', '/api/presets'],
    ['POST', '/api/presets/top'],
    ['POST', '/api/presets/name-available?name=a'],
    ['POST', `/api/presets/${ID}`],
    ['DELETE', `/api/presets/${ID}`],
    ['GET', `/api/presets/${ID}/report`],
    ['GET', `/api/presets/${ID}/opened`],
  ])('405 for %s %s', async (method, path) => {
    const { status, body } = await call(method, path);
    expect(status).toBe(405);
    expect(body).toEqual({ error: 'Method not allowed' });
  });

  it('accepts a trailing slash', async () => {
    const { status } = await call('GET', '/api/presets/');
    expect(status).toBe(200);
    expect(mockSql.find(Q.list)).toHaveLength(1);
  });

  it('hides database errors behind 500', async () => {
    mockSql.respond(Q.get, new Error('connection refused'));
    const { status, body } = await call('GET', `/api/presets/${ID}`);
    expect(status).toBe(500);
    expect(body).toEqual({ error: 'Internal error' });
  });
});

describe('POST /api/presets', () => {
  const save = (body: unknown = { name: 'My Pad', data, turnstileToken: 'turnstile' }) =>
    call('POST', '/api/presets', body);

  it('creates a preset and returns the edit token once', async () => {
    mockSql.respond(Q.insert, [{ id: ID, name: 'My Pad', clipId: null }]);
    const { status, body } = await save({ name: '  My   Pad ', data, turnstileToken: 'turnstile' });

    expect(status).toBe(201);
    expect(body).toEqual({
      id: ID,
      name: 'My Pad',
      existed: false,
      editToken: expect.any(String),
      clipId: null,
      info: INFO,
    });
    expect(body.editToken.length).toBeGreaterThanOrEqual(40);
    expect(verifyTurnstileMock).toHaveBeenCalledWith('turnstile', '1.2.3.4');

    const [insert] = mockSql.find(Q.insert);
    const [hash, name, stored, ipHash, editTokenHash, clipId, ...info] = insert.values;
    expect(hash).toBe(presetHash(data));
    expect(name).toBe('My Pad');
    expect((stored as JsonValue).json).toMatchObject({ filter: { a: true, cut: 1235, t: 'lowpass' } });
    expect(ipHash).toBe(IP_HASH);
    expect(editTokenHash).toBe(sha256(body.editToken));
    // no clip: it opens without one
    expect(clipId).toBeNull();
    // no info, nothing it does: a preset of All and of the search only
    expect(info).toEqual([null, null, null, [], []]);
    expect(insert.values).not.toContain(body.editToken);
    expect(insert.values).not.toContain('1.2.3.4');
  });

  it('saves the clip the preset opens with', async () => {
    mockSql.respond(Q.insert, [{ id: ID, name: 'My Pad', clipId: CLIP_ID }]);
    const { status, body } = await save({ name: 'My Pad', data, turnstileToken: 't', clipId: CLIP_ID });
    expect(status).toBe(201);
    expect(body.clipId).toBe(CLIP_ID);
    expect(mockSql.find(Q.insert)[0].values[5]).toBe(CLIP_ID);
    expect(mockSql.find(Q.insert)[0].text).toContain('RETURNING id, name, clip_id AS "clipId"');
  });

  it('saves the names of its macros, trimmed', async () => {
    mockSql.respond(Q.insert, [{ id: ID, name: 'My Pad', clipId: null }]);
    const named = { ...data, mac: { n1: ' Bright  Air ' }, mod: { 'macro1:filter.cutoff': 0.5 } };
    const { status } = await save({ name: 'My Pad', data: named, turnstileToken: 't' });
    expect(status).toBe(201);
    const [hash, , stored] = mockSql.find(Q.insert)[0].values;
    expect((stored as JsonValue).json).toMatchObject({ mac: { n1: 'Bright Air' } });
    expect(hash).toBe(presetHash(named));
  });

  it('rejects a clip that is not saved with 400', async () => {
    mockSql.respond(Q.insert, pgError('23503', 'presets_clip_id_fkey'));
    const { status, body } = await save({ name: 'My Pad', data, turnstileToken: 't', clipId: CLIP_ID });
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'Clip not found' });
  });

  it('gives every preset a new edit token', async () => {
    mockSql.respond(Q.insert, [{ id: ID, name: 'My Pad' }]);
    const first = await save();
    const second = await save();
    expect(first.body.editToken).not.toBe(second.body.editToken);
  });

  it('saves its info and what it does, worked out of its data', async () => {
    mockSql.respond(Q.insert, [{ id: ID, name: 'My Bass', clipId: null }]);
    const info = {
      category: 'bass',
      subcategory: 'sub',
      description: '  Deep   and round ',
      tags: ['warm', 'dark'],
    };
    const sound = { ...data, v: { max: 1, port: 80 } };
    const { status, body } = await save({ name: 'My Bass', data: sound, turnstileToken: 't', info });
    expect(status).toBe(201);
    const saved = {
      category: 'bass',
      subcategory: 'sub',
      description: 'Deep and round',
      tags: ['dark', 'warm'],
    };
    expect(body.info).toEqual(saved);
    const [insert] = mockSql.find(Q.insert);
    expect(insert.text).toContain('category, subcategory, description, tags, features)');
    expect(insert.text).toContain('$7, $8, $9, $10::text[], $11::text[])');
    expect(insert.values.slice(6)).toEqual([
      'bass',
      'sub',
      'Deep and round',
      ['dark', 'warm'],
      ['mono', 'glide'],
    ]);
  });

  it.each([
    ['a subcategory of another category', { category: 'pad', subcategory: 'sub' }],
    ['a subcategory without a category', { subcategory: 'sub' }],
    ['an unknown category', { category: 'noise' }],
    ['an unknown tag', { tags: ['loud'] }],
    ['four tags', { tags: ['dark', 'warm', 'soft', 'wide'] }],
    ['a too long description', { description: 'x'.repeat(281) }],
  ])('rejects an info with %s with 400', async (_, info) => {
    const { status, body } = await save({ name: 'My Pad', data, turnstileToken: 't', info });
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'Invalid preset' });
    expect(mockSql.queries).toHaveLength(0);
  });

  it.each(['see https://spam.example', 'at www.spam', 'go to spam.com now'])(
    'rejects a description with a link, %p, saying so',
    async (description) => {
      const { status, body } = await save({
        name: 'My Pad',
        data,
        turnstileToken: 't',
        info: { description },
      });
      expect(status).toBe(400);
      expect(body).toEqual({ error: DESCRIPTION_LINK_MESSAGE });
    }
  );

  it('rejects a profane description with 400, naming its word', async () => {
    const info = { description: 'a fucking bass' };
    const { status, body } = await save({ name: 'My Pad', data, turnstileToken: 't', info });
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'Please leave “fucking” out of the description' });
    expect(mockSql.queries).toHaveLength(0);
  });

  it('returns an existing preset with the same sound without the captcha, its clip and info kept', async () => {
    const existing = { ...INFO_ROW, category: 'pad', tags: ['warm'] };
    mockSql.respond(Q.findByHash, [{ id: OTHER_ID, name: 'Old name', clipId: CLIP_ID, ...existing }]);
    const info = { category: 'bass', description: 'Another' };
    const { status, body } = await save({
      name: 'My Pad',
      data,
      turnstileToken: 'turnstile',
      clipId: null,
      info,
    });
    expect(status).toBe(200);
    expect(body).toEqual({
      id: OTHER_ID,
      name: 'Old name',
      existed: true,
      clipId: CLIP_ID,
      info: { ...INFO, category: 'pad', tags: ['warm'] },
    });
    expect(mockSql.find(Q.findByHash)[0].values).toEqual([presetHash(data)]);
    expect(verifyTurnstileMock).not.toHaveBeenCalled();
    expect(mockSql.find(Q.insert)).toHaveLength(0);
  });

  it('returns the existing preset even when the name and the limit are taken', async () => {
    mockSql.respond(Q.findByHash, [{ id: OTHER_ID, name: 'Old name' }]);
    mockSql.respond(Q.nameTaken, [{ '?column?': 1 }]);
    mockSql.respond(Q.countPresets, [{ count: 100 }]);
    expect((await save()).status).toBe(200);
  });

  it('rejects a taken name with 409', async () => {
    mockSql.respond(Q.nameTaken, [{ '?column?': 1 }]);
    const { status, body } = await save();
    expect(status).toBe(409);
    expect(body).toEqual({ error: 'Name “My Pad” is already taken' });
    expect(mockSql.find(Q.nameTaken)[0].values).toEqual(['My Pad']);
    expect(verifyTurnstileMock).not.toHaveBeenCalled();
  });

  it('limits saves to 5 per hour per IP', async () => {
    mockSql.respond(Q.countPresets, [{ count: 5 }]);
    const { status } = await save();
    expect(status).toBe(429);
    expect(mockSql.find(Q.countPresets)[0].values).toEqual([IP_HASH]);
    expect(verifyTurnstileMock).not.toHaveBeenCalled();

    mockSql.respond(Q.countPresets, [{ count: 4 }]);
    mockSql.respond(Q.insert, [{ id: ID, name: 'My Pad' }]);
    expect((await save()).status).toBe(201);
  });

  it('rejects a failed captcha with 403', async () => {
    verifyTurnstileMock.mockResolvedValue(false);
    const { status, body } = await save();
    expect(status).toBe(403);
    expect(body).toEqual({ error: 'Captcha check failed, try again' });
    expect(mockSql.find(Q.insert)).toHaveLength(0);
  });

  it('returns the preset saved by a concurrent request with the same sound', async () => {
    let lookups = 0;
    mockSql.respond(Q.findByHash, () =>
      lookups++ === 0 ? [] : [{ id: OTHER_ID, name: 'Concurrent', clipId: null, ...INFO_ROW }]
    );
    const { status, body } = await save();
    expect(status).toBe(200);
    expect(body).toEqual({ id: OTHER_ID, name: 'Concurrent', existed: true, clipId: null, info: INFO });
    expect(body.editToken).toBeUndefined();
  });

  it('rejects a name taken by a concurrent request with 409', async () => {
    mockSql.respond(Q.insert, pgError('23505', 'presets_name_key'));
    const { status, body } = await save();
    expect(status).toBe(409);
    expect(body).toEqual({ error: 'Name “My Pad” is already taken' });
  });

  it('fails with 500 on other database errors', async () => {
    mockSql.respond(Q.insert, pgError('23505', 'some_other_key'));
    expect((await save()).status).toBe(500);
  });

  it.each([
    ['invalid JSON', '{'],
    ['a missing captcha token', { name: 'My Pad', data }],
    ['an empty name', { name: '   ', data, turnstileToken: 't' }],
    ['a too long name', { name: 'x'.repeat(PRESET_NAME_MAX_LENGTH + 1), data, turnstileToken: 't' }],
    ['out of range data', { name: 'My Pad', data: { ...data, v: { max: 100 } }, turnstileToken: 't' }],
    ['a clip id that is not a uuid', { name: 'My Pad', data, turnstileToken: 't', clipId: 'clip' }],
    // (it would be saved as the default type, under the hash of that sound)
    [
      'a filter type it does not know',
      { name: 'My Pad', data: { ...data, filter: { t: 'comb', res: 80 } }, turnstileToken: 't' },
    ],
  ])('rejects %s with 400', async (_, body) => {
    const { status } = await save(body);
    expect(status).toBe(400);
    expect(mockSql.queries).toHaveLength(0);
  });

  it('rejects profane names with 400', async () => {
    const { status, body } = await save({ name: 'fuck', data, turnstileToken: 't' });
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'Please choose another name' });
  });

  it('rejects profane names of macros with 400: whoever opens the preset sees them', async () => {
    const named = {
      ...data,
      mac: { n1: 'Bright', n2: 'Assorted shit' },
      mod: { 'macro1:osc1.wave': 0.5, 'macro2:filter.cutoff': 0.5 },
    };
    const { status, body } = await save({ name: 'My Pad', data: named, turnstileToken: 't' });
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'Please choose other names of the macros' });
    expect(mockSql.queries).toHaveLength(0);
  });

  it('rejects bodies over 20 KB with 413', async () => {
    const { status } = await save({ name: 'My Pad', data, turnstileToken: 't', junk: 'x'.repeat(20 * 1024) });
    expect(status).toBe(413);
  });
});

describe('PUT /api/presets/:id', () => {
  const update = (body: unknown = { name: 'New name', data, editToken: EDIT_TOKEN }, id = ID) =>
    call('PUT', `/api/presets/${id}`, body);
  const editable = (row: Partial<{ editTokenHash: string | null; hidden: boolean; throttled: boolean }>) =>
    mockSql.respond(Q.editable, [
      { editTokenHash: sha256(EDIT_TOKEN), hidden: false, throttled: false, ...row },
    ]);

  // the row the update returns
  const updated = (clipId: string | null, info: Record<string, unknown> = {}) => [
    { clipId, ...INFO_ROW, ...info },
  ];

  it('overwrites the name and the sound, the clip and the info kept without them in the request', async () => {
    editable({});
    mockSql.respond(Q.update, updated(CLIP_ID, { category: 'pad' }));
    const { status, body } = await update({ name: ' New   name ', data, editToken: EDIT_TOKEN });
    expect(status).toBe(200);
    expect(body).toEqual({ id: ID, name: 'New name', clipId: CLIP_ID, info: { ...INFO, category: 'pad' } });

    expect(mockSql.find(Q.editable)[0].values).toEqual([5, ID]);
    const [query] = mockSql.find(Q.update);
    const [name, stored, hash, features, id] = query.values;
    expect(name).toBe('New name');
    expect((stored as JsonValue).json).toMatchObject({ filter: { cut: 1235 } });
    expect(hash).toBe(presetHash(data));
    expect(features).toEqual([]);
    expect(id).toBe(ID);
    expect(query.text).toContain('features = $4::text[], updated_at = now()');
    expect(query.text).not.toContain('clip_id =');
    expect(query.text).not.toContain('category =');
    expect(query.text).toContain('RETURNING clip_id AS "clipId", category, subcategory, description, tags');
    // the CDN answers the updated preset
    expect(purgeCacheMock).toHaveBeenCalledTimes(1);
    expect(purgeCacheMock).toHaveBeenCalledWith({ tags: [`preset-${ID}`] });
  });

  it('purges the tag of the id in lower case, as the DB gives it, whatever the case of the URL', async () => {
    editable({});
    mockSql.respond(Q.update, updated(null));
    const { status, body } = await update(undefined, ID.toUpperCase());
    expect(status).toBe(200);
    expect(body).toEqual({ id: ID, name: 'New name', clipId: null, info: INFO });
    expect(mockSql.find(Q.update)[0].values[4]).toBe(ID);
    expect(purgeCacheMock).toHaveBeenCalledWith({ tags: [`preset-${ID}`] });
  });

  it('succeeds when the purge of the cache fails, logging it', async () => {
    editable({});
    mockSql.respond(Q.update, updated(null));
    purgeCacheMock.mockRejectedValue(new Error('purge failed'));
    const { status, body } = await update();
    expect(status).toBe(200);
    expect(body).toEqual({ id: ID, name: 'New name', clipId: null, info: INFO });
    expect(console.error).toHaveBeenCalledWith('Cache purge failed', [`preset-${ID}`], expect.any(Error));
  });

  it('answers without waiting for the purge, handed to the runtime', async () => {
    editable({});
    mockSql.respond(Q.update, updated(null));
    // the purge API hangs until the end of the test
    let answerPurge: () => void = () => undefined;
    purgeCacheMock.mockReturnValue(new Promise<void>((resolve) => (answerPurge = resolve)));
    const waitUntil = jest.fn();
    const body = { name: 'New name', data, editToken: EDIT_TOKEN };
    const response = await handler(request('PUT', `/api/presets/${ID}`, body), { ...context, waitUntil });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: ID, name: 'New name', clipId: null, info: INFO });
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise));
    expect(purgeCacheMock).toHaveBeenCalledWith({ tags: [`preset-${ID}`] });
    answerPurge();
    await waitUntil.mock.calls[0][0];
  });

  it.each([
    ['sets the clip the preset opens with', CLIP_ID],
    ['takes the clip away with null', null],
  ])('%s', async (_, clipId) => {
    editable({});
    mockSql.respond(Q.update, updated(clipId));
    const { status, body } = await update({ name: 'New name', data, editToken: EDIT_TOKEN, clipId });
    expect(status).toBe(200);
    expect(body).toEqual({ id: ID, name: 'New name', clipId, info: INFO });
    const [query] = mockSql.find(Q.update);
    expect(query.text).toContain('updated_at = now() , clip_id = $5 WHERE id = $6');
    expect(query.values.slice(4)).toEqual([clipId, ID]);
    expect(purgeCacheMock).toHaveBeenCalledWith({ tags: [`preset-${ID}`] });
  });

  it('overwrites the info with the one of the request, what the sound does worked out again', async () => {
    editable({});
    const info = { category: 'lead', subcategory: 'soft', description: 'Airy', tags: ['soft'] };
    mockSql.respond(Q.update, updated(null, info));
    const sound = { ...data, v: { max: 1 } };
    const { status, body } = await update({ name: 'New name', data: sound, editToken: EDIT_TOKEN, info });
    expect(status).toBe(200);
    expect(body.info).toEqual(info);
    const [query] = mockSql.find(Q.update);
    expect(query.text).toContain(
      'updated_at = now() , category = $5, subcategory = $6, description = $7, tags = $8::text[] WHERE id = $9'
    );
    expect(query.values.slice(3)).toEqual([['mono'], 'lead', 'soft', 'Airy', ['soft'], ID]);
  });

  it('empties the info with an empty one', async () => {
    editable({});
    mockSql.respond(Q.update, updated(null));
    const { body } = await update({ name: 'New name', data, editToken: EDIT_TOKEN, info: {} });
    expect(body.info).toEqual(INFO);
    expect(mockSql.find(Q.update)[0].values.slice(4, 8)).toEqual([null, null, null, []]);
  });

  it('rejects a clip that is not saved with 400', async () => {
    editable({});
    mockSql.respond(Q.update, pgError('23503', 'presets_clip_id_fkey'));
    const { status, body } = await update({ name: 'New name', data, editToken: EDIT_TOKEN, clipId: CLIP_ID });
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'Clip not found' });
    expect(purgeCacheMock).not.toHaveBeenCalled();
  });

  it('returns 404 for an invalid id without a query', async () => {
    const { status } = await update(undefined, 'not-a-uuid');
    expect(status).toBe(404);
    expect(mockSql.queries).toHaveLength(0);
  });

  it('returns 404 for a missing or hidden preset', async () => {
    expect((await update()).status).toBe(404);
    editable({ hidden: true });
    expect((await update()).status).toBe(404);
    expect(mockSql.find(Q.update)).toHaveLength(0);
    expect(purgeCacheMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a preset without a token', null],
    ['a wrong token', sha256('another token value')],
    ['a malformed stored hash', 'short'],
  ])('rejects %s with 403', async (_, editTokenHash) => {
    editable({ editTokenHash });
    const { status, body } = await update();
    expect(status).toBe(403);
    expect(body).toEqual({ error: 'You can only edit presets saved from this browser' });
    expect(mockSql.find(Q.update)).toHaveLength(0);
    expect(purgeCacheMock).not.toHaveBeenCalled();
  });

  it('allows one update per 5 seconds', async () => {
    editable({ throttled: true });
    expect((await update()).status).toBe(429);
    expect(mockSql.find(Q.update)).toHaveLength(0);
    expect(purgeCacheMock).not.toHaveBeenCalled();
  });

  it('rejects a name of another preset with 409', async () => {
    editable({});
    mockSql.respond(Q.update, pgError('23505', 'presets_name_key'));
    const { status, body } = await update();
    expect(status).toBe(409);
    expect(body).toEqual({ error: 'Name “New name” is already taken' });
    expect(purgeCacheMock).not.toHaveBeenCalled();
  });

  it('rejects a sound of another preset with 409 and returns that preset', async () => {
    editable({});
    mockSql.respond(Q.update, pgError('23505', 'presets_hash_key'));
    mockSql.respond(Q.findByHash, [{ id: OTHER_ID, name: 'Other', clipId: null, ...INFO_ROW }]);
    const { status, body } = await update();
    expect(status).toBe(409);
    expect(body).toEqual({
      error: 'This sound is already saved as “Other”',
      id: OTHER_ID,
      name: 'Other',
      clipId: null,
      info: INFO,
    });
    expect(mockSql.find(Q.findByHash)[0].values).toEqual([presetHash(data)]);
    expect(purgeCacheMock).not.toHaveBeenCalled();
  });

  it('fails with 500 on other database errors', async () => {
    editable({});
    mockSql.respond(Q.update, new Error('deadlock'));
    expect((await update()).status).toBe(500);
    expect(purgeCacheMock).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid JSON', '{'],
    ['a missing token', { name: 'New name', data }],
    ['a short token', { name: 'New name', data, editToken: 'short' }],
    ['a profane name', { name: 'fuck', data, editToken: EDIT_TOKEN }],
    [
      'a profane description',
      { name: 'New name', data, editToken: EDIT_TOKEN, info: { description: 'shit' } },
    ],
    [
      'a profane name of a macro',
      {
        name: 'New name',
        data: { ...data, mac: { n3: 'fuck' }, mod: { 'macro3:osc1.wave': 0.5 } },
        editToken: EDIT_TOKEN,
      },
    ],
    ['an unknown tag', { name: 'New name', data, editToken: EDIT_TOKEN, info: { tags: ['loud'] } }],
    ['a clip id that is not a uuid', { name: 'New name', data, editToken: EDIT_TOKEN, clipId: 'clip' }],
    [
      'a filter type it does not know',
      { name: 'New name', data: { ...data, filter: { t: 'comb', res: 80 } }, editToken: EDIT_TOKEN },
    ],
  ])('rejects %s with 400', async (_, body) => {
    editable({});
    expect((await update(body)).status).toBe(400);
    expect(mockSql.find(Q.update)).toHaveLength(0);
    expect(purgeCacheMock).not.toHaveBeenCalled();
  });
});

describe('PUT /api/presets/:id/info', () => {
  const INFO_BODY = {
    category: 'fx',
    subcategory: 'game',
    description: ' Coins  and jumps ',
    tags: ['bright'],
  };
  const edit = (body: unknown = { editToken: EDIT_TOKEN, info: INFO_BODY }, id = ID) =>
    call('PUT', `/api/presets/${id}/info`, body);
  const editable = (row: Partial<{ editTokenHash: string | null; hidden: boolean; throttled: boolean }>) =>
    mockSql.respond(Q.editable, [
      { editTokenHash: sha256(EDIT_TOKEN), hidden: false, throttled: false, ...row },
    ]);

  it('writes the info alone, the sound, name and hash as they are, and purges the preset', async () => {
    editable({});
    const { status, body } = await edit();
    expect(status).toBe(200);
    const info = { category: 'fx', subcategory: 'game', description: 'Coins and jumps', tags: ['bright'] };
    expect(body).toEqual({ id: ID, info });
    expect(mockSql.find(Q.editable)[0].values).toEqual([5, ID]);
    const [query] = mockSql.find(Q.info);
    expect(query.text).toBe(
      'UPDATE presets SET category = $1, subcategory = $2, description = $3, tags = $4::text[], ' +
        'updated_at = now() WHERE id = $5'
    );
    expect(query.values).toEqual(['fx', 'game', 'Coins and jumps', ['bright'], ID]);
    expect(mockSql.find(Q.update)).toHaveLength(0);
    expect(purgeCacheMock).toHaveBeenCalledWith({ tags: [`preset-${ID}`] });
  });

  it('empties the info', async () => {
    editable({});
    const { body } = await edit({ editToken: EDIT_TOKEN, info: { description: '   ' } });
    expect(body).toEqual({ id: ID, info: INFO });
    expect(mockSql.find(Q.info)[0].values).toEqual([null, null, null, [], ID]);
  });

  it('rejects a wrong token with 403, a missing or hidden preset with 404, a quick edit with 429', async () => {
    expect((await edit()).status).toBe(404);
    editable({ editTokenHash: sha256('another token value') });
    expect((await edit()).status).toBe(403);
    editable({ hidden: true });
    expect((await edit()).status).toBe(404);
    editable({ throttled: true });
    expect((await edit()).status).toBe(429);
    expect(mockSql.find(Q.info)).toHaveLength(0);
    expect(purgeCacheMock).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid JSON', '{', 'Invalid JSON'],
    ['a missing token', { info: INFO_BODY }, 'Invalid info'],
    ['a missing info', { editToken: EDIT_TOKEN }, 'Invalid info'],
    ['an unknown category', { editToken: EDIT_TOKEN, info: { category: 'noise' } }, 'Invalid info'],
    ['a link', { editToken: EDIT_TOKEN, info: { description: 'www.spam.io' } }, DESCRIPTION_LINK_MESSAGE],
    [
      'a profane description',
      { editToken: EDIT_TOKEN, info: { description: 'fuck' } },
      'Please leave “fuck” out of the description',
    ],
  ])('rejects %s with 400 without a query', async (_, body, error) => {
    editable({});
    const response = await edit(body);
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error });
    expect(mockSql.queries).toHaveLength(0);
  });

  it('answers 404 for an invalid id and 405 for another method', async () => {
    expect((await edit(undefined, 'nope')).status).toBe(404);
    expect((await call('GET', `/api/presets/${ID}/info`)).status).toBe(405);
  });
});

describe('POST /api/presets/:id/opened', () => {
  const open = (body: unknown = { editToken: EDIT_TOKEN }, id = ID) =>
    call('POST', `/api/presets/${id}/opened`, body);

  it('marks a visible preset with this edit token as opened by its author, once a day', async () => {
    const { status, body } = await open();
    expect(status).toBe(204);
    expect(body).toBeUndefined();

    expect(mockSql.queries).toHaveLength(1);
    const [query] = mockSql.find(Q.opened);
    expect(query.text).toBe(
      'UPDATE presets SET author_opened_at = now() WHERE id = $1 AND edit_token_hash = $2 AND NOT hidden ' +
        "AND (author_opened_at IS NULL OR author_opened_at < now() - interval '1 day')"
    );
    expect(query.values).toEqual([ID, sha256(EDIT_TOKEN)]);
  });

  it('returns 404 for an invalid id without a query', async () => {
    expect((await open(undefined, 'not-a-uuid')).status).toBe(404);
    expect(mockSql.queries).toHaveLength(0);
  });

  it.each([
    ['invalid JSON', '{'],
    ['a missing token', {}],
    ['a short token', { editToken: 'short' }],
  ])('rejects %s with 400 without a query', async (_, body) => {
    const response = await open(body);
    expect(response.status).toBe(400);
    expect(mockSql.queries).toHaveLength(0);
  });

  it('fails with 500 on database errors', async () => {
    mockSql.respond(Q.opened, new Error('connection refused'));
    expect((await open()).status).toBe(500);
  });
});

describe('GET /api/presets/:id', () => {
  const row = { id: ID, name: 'Pad', data, createdAt: '2026-01-01T00:00:00Z' };
  const rest = { ...INFO_ROW, factory: false, features: [], aiGenerated: false };
  const answered = { info: INFO, factory: false, features: [] };
  const noClip = { clipId: null, clipName: null, clipData: null, ...rest };
  const clipData = { bpm: 128, length: 3840, notes: [[0, 480, 60, 100]] };

  it('returns a visible preset, kept by the CDN under its tag', async () => {
    mockSql.respond(Q.get, [{ ...row, ...noClip }]);
    const { status, body, headers } = await call('GET', `/api/presets/${ID}`);
    expect(status).toBe(200);
    expect(body).toEqual({ ...row, clip: null, ...answered });
    expect(headers.get('Cache-Control')).toBe(BROWSER_REVALIDATE);
    expect(headers.get('Netlify-CDN-Cache-Control')).toBe(PRESET_CDN_CACHE);
    expect(headers.get('Netlify-Cache-Tag')).toBe(`preset-${ID}`);
    // a day, a minute stale at most: one deleted, hidden or not purged is never answered the week of a list
    expect(PRESET_CDN_CACHE).toBe('public, durable, s-maxage=86400, stale-while-revalidate=60');

    const [query] = mockSql.find(Q.get);
    expect(query.values).toEqual([ID]);
    expect(query.text).toContain('LEFT JOIN clips c ON c.id = p.clip_id');
    expect(query.text).toContain('AND NOT p.hidden');
  });

  it('returns the clip it opens with, its name in it', async () => {
    mockSql.respond(Q.get, [{ ...row, clipId: CLIP_ID, clipName: 'Riff', clipData, ...rest }]);
    const { body, headers } = await call('GET', `/api/presets/${ID}`);
    expect(body).toEqual({
      ...row,
      clip: { id: CLIP_ID, clip: { ...clipData, name: 'Riff' } },
      ...answered,
      features: ['clip'],
    });
    // an update of the clip purges the presets that open with it
    expect(headers.get('Netlify-Cache-Tag')).toBe(`preset-${ID},clip-${CLIP_ID}`);

    mockSql.respond(Q.get, [{ ...row, clipId: CLIP_ID, clipName: null, clipData, ...rest }]);
    expect((await call('GET', `/api/presets/${ID}`)).body.clip).toEqual({ id: CLIP_ID, clip: clipData });
  });

  it('returns its info, whether it is of the synth and what it does, in the order of the icons', async () => {
    const info = { category: 'fx', subcategory: 'game', description: 'Coins', tags: ['bright'] };
    mockSql.respond(Q.get, [
      { ...row, ...noClip, ...info, factory: true, features: ['tempo-sync', 'mono'], aiGenerated: true },
    ]);
    const { body } = await call('GET', `/api/presets/${ID}`);
    expect(body).toEqual({ ...row, clip: null, info, factory: true, features: ['ai', 'tempo-sync', 'mono'] });
    expect(mockSql.find(Q.get)[0].text).toContain(
      'p.category, p.subcategory, p.description, p.tags, p.factory, p.features, p.ai_generated AS "aiGenerated"'
    );
  });

  it('returns 404 for a missing or hidden preset, never cached', async () => {
    const { status, body, headers } = await call('GET', `/api/presets/${ID}`);
    expect(status).toBe(404);
    expect(body).toEqual({ error: 'Preset not found' });
    expect(headers.get('Cache-Control')).toBe('no-store');
    expect(headers.get('Netlify-CDN-Cache-Control')).toBeNull();
  });

  it('returns 404 for an invalid id without a query', async () => {
    expect((await call('GET', '/api/presets/123')).status).toBe(404);
    expect(mockSql.queries).toHaveLength(0);
  });
});

describe('GET /api/presets/name-available', () => {
  const check = (name?: string) =>
    call(
      'GET',
      `/api/presets/name-available${name === undefined ? '' : `?name=${encodeURIComponent(name)}`}`
    );

  it('reports a free name', async () => {
    const { status, body } = await check('Pad');
    expect(status).toBe(200);
    expect(body).toEqual({ available: true });
  });

  it('reports a taken name', async () => {
    mockSql.respond(Q.nameTaken, [{ '?column?': 1 }]);
    expect((await check('Pad')).body).toEqual({ available: false });
  });

  it('normalizes the name before the lookup', async () => {
    await check('  My   Pad ');
    expect(mockSql.find(Q.nameTaken)[0].values).toEqual(['My Pad']);
  });

  it.each([undefined, '', '   ', 'x'.repeat(PRESET_NAME_MAX_LENGTH + 1)])(
    'rejects %p with 400',
    async (name) => {
      const { status, body } = await check(name);
      expect(status).toBe(400);
      expect(body).toEqual({ error: 'Invalid name' });
      expect(mockSql.queries).toHaveLength(0);
    }
  );
});

describe('GET /api/presets/top', () => {
  const rows = (count: number) => Array.from({ length: count }, (_, i) => listRow(i, { popular: true }));
  const items = (count: number) => Array.from({ length: count }, (_, i) => listItem(i, { popular: true }));

  it('returns at most 50 presets in one query, cached for 5 minutes', async () => {
    mockSql.respond(Q.top, rows(50));
    const { status, body, headers } = await call('GET', '/api/presets/top');
    expect(status).toBe(200);
    expect(body).toEqual(items(50));
    expect(headers.get('Cache-Control')).toBe('public, s-maxage=300');
    expect(mockSql.queries).toHaveLength(1);
    expect(mockSql.find(Q.top)[0].values).toEqual([50]);
  });

  it('takes every visible featured preset and the visible presets above the popular threshold', async () => {
    await call('GET', '/api/presets/top');
    const [query] = mockSql.find(Q.top);
    expect(query.text).toContain('FROM presets p LEFT JOIN preset_scores s ON s.preset_id = p.id');
    expect(query.text).toContain('WHERE NOT p.hidden AND (p.featured OR s.popular) ORDER BY');
  });

  it('puts featured presets first whatever their score, the rest by score', async () => {
    await call('GET', '/api/presets/top');
    const [query] = mockSql.find(Q.top);
    expect(query.text).toContain(
      'ORDER BY p.featured DESC, s.score DESC NULLS LAST, p.created_at DESC, p.id DESC'
    );
  });

  it('shows unique users of featured presets below the popular threshold, 0 without a score', async () => {
    await call('GET', '/api/presets/top');
    const [query] = mockSql.find(Q.top);
    expect(query.text).toContain('COALESCE(s.unique_users, 0) AS "uniqueUsers"');
  });

  it('returns featured presets on a cold start', async () => {
    mockSql.respond(Q.top, rows(1));
    expect((await call('GET', '/api/presets/top')).body).toEqual(items(1));
  });

  it('gives each its info, origin and features: of its data, its clip and AI, in the order of the icons', async () => {
    const info = { category: 'fx', subcategory: 'game', description: 'Coins', tags: ['bright'] };
    mockSql.respond(Q.top, [
      listRow(0, {
        ...info,
        factory: true,
        features: ['glide', 'tempo-sync'],
        hasClip: true,
        aiGenerated: true,
        popular: true,
      }),
    ]);
    const { body } = await call('GET', '/api/presets/top');
    expect(body).toEqual([
      listItem(0, { ...info, factory: true, features: ['clip', 'ai', 'tempo-sync', 'glide'], popular: true }),
    ]);
    expect(mockSql.find(Q.top)[0].text).toContain(
      'p.factory, p.features, p.clip_id IS NOT NULL AS "hasClip", p.ai_generated AS "aiGenerated"'
    );
  });

  it('fills the Popular of a category with its other presets by score, featured and popular first', async () => {
    mockSql.respond(Q.topFiltered, rows(2));
    const { status, body, headers } = await call('GET', '/api/presets/top?category=fx&subcategory=game');
    expect(status).toBe(200);
    expect(body).toEqual(items(2));
    expect(headers.get('Cache-Control')).toBe('public, s-maxage=300');
    expect(mockSql.find(Q.top)).toHaveLength(0);
    const [query] = mockSql.find(Q.topFiltered);
    expect(query.text).toContain('WHERE NOT p.hidden AND p.category = $1 AND p.subcategory = $2 ORDER BY');
    expect(query.text).toContain(
      'ORDER BY p.featured DESC, COALESCE(s.popular, false) DESC, s.score DESC NULLS LAST, ' +
        'p.created_at DESC, p.id DESC LIMIT $3'
    );
    expect(query.values).toEqual(['fx', 'game', 50]);
  });

  it('says of each whether it is popular: featured or above the threshold, the rest of a filter not', async () => {
    mockSql.respond(Q.topFiltered, [listRow(0, { popular: true }), listRow(1, { popular: false })]);
    const { body } = await call('GET', '/api/presets/top?category=bass');
    expect(body).toEqual([listItem(0, { popular: true }), listItem(1, { popular: false })]);
    expect(mockSql.find(Q.topFiltered)[0].text).toContain(
      '"aiGenerated", p.featured OR COALESCE(s.popular, false) AS "popular" FROM presets p'
    );

    await call('GET', '/api/presets/top');
    expect(mockSql.find(Q.top)[0].text).toContain('p.featured OR COALESCE(s.popular, false) AS "popular"');
  });

  it('fills the Popular of tags, features and an origin alike', async () => {
    await call('GET', '/api/presets/top?tags=dark,warm&features=mono,clip,ai&origin=community');
    const [query] = mockSql.find(Q.topFiltered);
    expect(query.text).toContain(
      'WHERE NOT p.hidden AND p.tags @> $1::text[] AND p.features @> $2::text[] AND p.clip_id IS NOT NULL ' +
        'AND p.ai_generated AND NOT p.factory ORDER BY'
    );
    expect(query.values).toEqual([['dark', 'warm'], ['mono'], 50]);
  });

  it.each([
    ['an unknown category', '?category=noise'],
    ['a subcategory without its category', '?subcategory=game'],
    ['a subcategory of another category', '?category=pad&subcategory=game'],
    ['an unknown tag', '?tags=loud'],
    ['an unknown feature', '?features=stereo'],
    ['an unknown origin', '?origin=mine'],
  ])('rejects %s with 400', async (_, query) => {
    const { status, body } = await call('GET', `/api/presets/top${query}`);
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'Invalid query' });
    expect(mockSql.queries).toHaveLength(0);
  });
});

describe('GET /api/presets/counts', () => {
  it('counts the visible presets of each category and subcategory, cached for 5 minutes', async () => {
    mockSql.respond(Q.counts, [
      { category: null, subcategory: null, count: 10 },
      { category: 'fx', subcategory: null, count: 3 },
      { category: 'fx', subcategory: 'game', count: 5 },
      { category: 'fx', subcategory: 'magic', count: 2 },
      { category: 'drums', subcategory: null, count: 1 },
    ]);
    const { status, body, headers } = await call('GET', '/api/presets/counts');
    expect(status).toBe(200);
    expect(body).toEqual({
      total: 21,
      categories: {
        fx: { count: 10, subcategories: { game: 5, magic: 2 } },
        drums: { count: 1, subcategories: {} },
      },
    });
    expect(headers.get('Cache-Control')).toBe('public, s-maxage=300');
    expect(mockSql.find(Q.counts)[0].text).toBe(
      'SELECT category, subcategory, count(*)::int AS count FROM presets WHERE NOT hidden ' +
        'GROUP BY category, subcategory'
    );
  });

  it('answers 405 for another method', async () => {
    expect((await call('POST', '/api/presets/counts')).status).toBe(405);
  });
});

describe('GET /api/presets', () => {
  const rows = (count: number) =>
    Array.from({ length: count }, (_, i) => listRow(i, { cursorKey: `key-${i}` }));
  const list = (query = '') => call('GET', `/api/presets${query}`);

  it('returns the newest visible presets by default', async () => {
    mockSql.respond(Q.list, rows(2));
    const { status, body, headers } = await list();
    expect(status).toBe(200);
    expect(body).toEqual({ items: [listItem(0), listItem(1)], nextCursor: null });
    expect(headers.get('Cache-Control')).toBe('public, s-maxage=60');

    const [query] = mockSql.find(Q.list);
    expect(query.text).toContain('p.created_at::text AS "cursorKey"');
    expect(query.text).toContain('WHERE NOT p.hidden');
    expect(query.text).toContain('ORDER BY p.created_at DESC, p.id DESC');
    expect(query.text).not.toContain('ILIKE');
    expect(query.values).toEqual([31]);
  });

  it('returns a cursor of the last item when there are more rows', async () => {
    mockSql.respond(Q.list, rows(31));
    const { body } = await list();
    expect(body.items).toHaveLength(30);
    expect(body.items[29]).toEqual(listItem(29));
    expect(decodeCursor(body.nextCursor)).toEqual(['key-29', uuid(29)]);
  });

  it('returns no cursor for exactly one page', async () => {
    mockSql.respond(Q.list, rows(30));
    expect((await list()).body.nextCursor).toBeNull();
  });

  it.each([
    [
      'new',
      'p.created_at::text',
      '(p.created_at, p.id) < ($1::timestamptz, $2::uuid)',
      'p.created_at DESC, p.id DESC',
    ],
    ['name', 'p.name', '(p.name, p.id) > ($1, $2::uuid)', 'p.name, p.id'],
    [
      'popular',
      'COALESCE(s.score, 0)::text',
      '(COALESCE(s.score, 0), p.id) < ($1::float8, $2::uuid)',
      'COALESCE(s.score, 0) DESC, p.id DESC',
    ],
  ])('continues %s sort after the cursor', async (sort, key, after, order) => {
    mockSql.respond(Q.list, rows(31));
    const first = await list(`?sort=${sort}`);
    const [firstQuery] = mockSql.find(Q.list);
    expect(firstQuery.text).toContain(`${key} AS "cursorKey"`);
    expect(firstQuery.text).toContain(`ORDER BY ${order}`);
    expect(firstQuery.text).not.toContain(after);

    await list(`?sort=${sort}&cursor=${first.body.nextCursor}`);
    const [, nextQuery] = mockSql.find(Q.list);
    expect(nextQuery.text).toContain(`AND ${after}`);
    expect(nextQuery.values).toEqual(['key-29', uuid(29), 31]);
  });

  it('searches by name and description with escaped LIKE wildcards and no caching', async () => {
    const { headers } = await list(`?q=${encodeURIComponent(' 50%_off\\ ')}`);
    expect(headers.get('Cache-Control')).toBe('no-store');
    const [query] = mockSql.find(Q.list);
    expect(query.text).toContain('AND (p.name ILIKE $1 OR p.description ILIKE $2 )');
    expect(query.values).toEqual(['%50\\%\\_off\\\\%', '%50\\%\\_off\\\\%', 31]);
  });

  it('searches the tags by their labels too', async () => {
    await list('?q=DAR');
    const [query] = mockSql.find(Q.list);
    expect(query.text).toContain('AND (p.name ILIKE $1 OR p.description ILIKE $2 OR p.tags && $3::text[])');
    expect(query.values).toEqual(['%DAR%', '%DAR%', ['dark'], 31]);
  });

  it('filters by a category, a subcategory, tags, features and an origin, the sort and cursor kept', async () => {
    await list('?category=bass&subcategory=sub&tags=dark&features=glide,tempo-sync&origin=factory&sort=name');
    const [query] = mockSql.find(Q.list);
    expect(query.text).toContain(
      'WHERE NOT p.hidden AND p.category = $1 AND p.subcategory = $2 AND p.tags @> $3::text[] ' +
        'AND p.features @> $4::text[] AND p.factory ORDER BY p.name, p.id'
    );
    expect(query.values).toEqual(['bass', 'sub', ['dark'], ['glide', 'tempo-sync'], 31]);
  });

  it('caches a filtered list without a search', async () => {
    const { headers } = await list('?category=pad');
    expect(headers.get('Cache-Control')).toBe('public, s-maxage=60');
  });

  it('gives the presets of a list of the browser in its order, those still there, never cached', async () => {
    mockSql.respond(Q.byIds, [listRow(2), listRow(1)]);
    const ids = [uuid(2), uuid(9), uuid(1).toUpperCase()];
    const { status, body, headers } = await list(`?ids=${ids.join(',')}`);
    expect(status).toBe(200);
    expect(body).toEqual({ items: [listItem(2), listItem(1)], nextCursor: null });
    expect(headers.get('Cache-Control')).toBe('no-store');
    expect(mockSql.find(Q.list)).toHaveLength(0);
    const [query] = mockSql.find(Q.byIds);
    expect(query.text).toContain(
      'FROM presets p LEFT JOIN preset_scores s ON s.preset_id = p.id WHERE NOT p.hidden AND p.id = ANY($1::uuid[])'
    );
    expect(query.text).toMatch(/ORDER BY array_position\(\$2::uuid\[\], p\.id\)$/);
    expect(query.values).toEqual([ids, ids]);
  });

  it('rejects more than 100 ids or one that is not a uuid with 400', async () => {
    const many = Array.from({ length: 101 }, (_, i) => uuid(i)).join(',');
    expect((await list(`?ids=${many}`)).status).toBe(400);
    expect((await list('?ids=abc')).status).toBe(400);
    expect(mockSql.queries).toHaveLength(0);
  });

  it('ignores a blank search', async () => {
    await list('?q=%20%20');
    expect(mockSql.find(Q.list)[0].text).not.toContain('ILIKE');
  });

  it.each([
    ['an unknown sort', '?sort=random'],
    ['a too long search', `?q=${'x'.repeat(PRESET_NAME_MAX_LENGTH + 1)}`],
  ])('rejects %s with 400', async (_, query) => {
    const { status, body } = await list(query);
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'Invalid query' });
  });

  it.each([
    ['garbage', 'not-a-cursor'],
    ['a non-uuid id', encodeCursor(['key', 'abc'])],
    ['a non-string key', encodeCursor([1, ID])],
    ['not an array', encodeCursor({ key: 'a' })],
  ])('rejects a cursor with %s with 400', async (_, cursor) => {
    const { status, body } = await list(`?cursor=${cursor}`);
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'Invalid cursor' });
    expect(mockSql.queries).toHaveLength(0);
  });
});

describe('POST /api/presets/:id/report', () => {
  const report = (id = ID) => call('POST', `/api/presets/${id}/report`);

  it('stores the report and hides the preset over the threshold', async () => {
    mockSql.respond(Q.exists, [{ id: ID }]);
    const { status, body } = await report();
    expect(status).toBe(204);
    expect(body).toBeUndefined();

    expect(mockSql.find(Q.countReports)[0].values).toEqual([IP_HASH]);
    const [insert] = mockSql.find(Q.insertReport);
    expect(insert.values).toEqual([ID, IP_HASH]);
    expect(insert.text).toContain('ON CONFLICT DO NOTHING');
    const [hide] = mockSql.find(Q.hide);
    expect(hide.values).toEqual([ID, ID, 5]);
    expect(hide.text).toContain('AND NOT hidden');
    expect(hide.text).toContain('RETURNING id');
    // under the threshold: nothing hidden, nothing purged
    expect(purgeCacheMock).not.toHaveBeenCalled();
  });

  it('purges the cached preset once reports hide it', async () => {
    mockSql.respond(Q.exists, [{ id: ID }]);
    mockSql.respond(Q.hide, [{ id: ID }]);
    expect((await report()).status).toBe(204);
    expect(purgeCacheMock).toHaveBeenCalledTimes(1);
    expect(purgeCacheMock).toHaveBeenCalledWith({ tags: [`preset-${ID}`] });
  });

  it('purges the tag of the id in lower case, as the DB gives it, whatever the case of the URL', async () => {
    mockSql.respond(Q.exists, [{ id: ID }]);
    mockSql.respond(Q.hide, [{ id: ID }]);
    expect((await report(ID.toUpperCase())).status).toBe(204);
    expect(mockSql.find(Q.hide)[0].values).toEqual([ID, ID, 5]);
    expect(purgeCacheMock).toHaveBeenCalledWith({ tags: [`preset-${ID}`] });
  });

  it('hides the preset when the purge of the cache fails, logging it', async () => {
    mockSql.respond(Q.exists, [{ id: ID }]);
    mockSql.respond(Q.hide, [{ id: ID }]);
    purgeCacheMock.mockRejectedValue(new Error('purge failed'));
    expect((await report()).status).toBe(204);
    expect(mockSql.find(Q.hide)).toHaveLength(1);
    expect(console.error).toHaveBeenCalledWith('Cache purge failed', [`preset-${ID}`], expect.any(Error));
  });

  it('takes the threshold from REPORT_HIDE_THRESHOLD', async () => {
    process.env.REPORT_HIDE_THRESHOLD = '3';
    mockSql.respond(Q.exists, [{ id: ID }]);
    await report();
    expect(mockSql.find(Q.hide)[0].values).toEqual([ID, ID, 3]);
  });

  it('limits reports to 20 per hour per IP', async () => {
    mockSql.respond(Q.countReports, [{ count: 20 }]);
    mockSql.respond(Q.exists, [{ id: ID }]);
    expect((await report()).status).toBe(429);
    expect(mockSql.find(Q.insertReport)).toHaveLength(0);
  });

  it('returns 404 for a missing preset', async () => {
    expect((await report()).status).toBe(404);
    expect(mockSql.find(Q.insertReport)).toHaveLength(0);
  });

  it('returns 404 for an invalid id without a query', async () => {
    expect((await report('nope')).status).toBe(404);
    expect(mockSql.queries).toHaveLength(0);
  });
});
