import { purgeCache } from '@netlify/functions';
import {
  CLIP_LENGTH_MAX,
  CLIP_NAME_MAX_LENGTH,
  CLIP_NOTES_MAX,
  clipHash,
  ClipNote,
} from '../../libs/preset-schema/src';
import { sha256 } from '../utils/http';
import { verifyTurnstile } from '../utils/turnstile';
import handler, { config } from '../functions/clips.mjs';
import { createFakeSql, JsonValue, pgError } from './fake-sql';
import { caller, context, ID, IP_HASH, IP_SALT, OTHER_ID, request } from './helpers';

const mockSql = createFakeSql();
jest.mock('../utils/db', () => ({ db: () => mockSql.sql }));
jest.mock('../utils/turnstile', () => ({ verifyTurnstile: jest.fn() }));
jest.mock('@netlify/functions', () => ({ purgeCache: jest.fn() }));

const verifyTurnstileMock = verifyTurnstile as jest.Mock;
const purgeCacheMock = purgeCache as jest.Mock;

// unsorted, a duplicate and a note past the end of the loop, a tempo off the grid: the stored clip is normalized
const clip = {
  bpm: 128.123,
  length: 3840,
  notes: [
    [960, 480, 64, 100],
    [0, 960, 60, 90],
    [0, 960, 60, 90],
    [3840, 10, 72, 100],
  ] as ClipNote[],
};
const normalized = {
  bpm: 128.12,
  length: 3840,
  notes: [
    [0, 960, 60, 90],
    [960, 480, 64, 100],
  ],
};
const EDIT_TOKEN = 'e'.repeat(43);

const Q = {
  findByHash: /^SELECT id FROM clips WHERE hash =/,
  count: /^SELECT count\(\*\)::int AS count FROM "clips" WHERE ip_hash/,
  insert: /^INSERT INTO clips/,
  editable: /^SELECT edit_token_hash/,
  update: /^UPDATE clips SET hash/,
  opened: /^UPDATE clips SET opened_at/,
  get: /^SELECT id, name, data, created_at/,
};

const call = caller(handler);

beforeEach(() => {
  mockSql.reset();
  mockSql.respond(Q.count, [{ count: 0 }]);
  verifyTurnstileMock.mockReset().mockResolvedValue(true);
  purgeCacheMock.mockReset().mockResolvedValue(undefined);
  process.env.IP_HASH_SALT = IP_SALT;
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

it('is routed to /api/clips', () => {
  expect(config.path).toEqual(['/api/clips', '/api/clips/*']);
});

describe('routing', () => {
  it.each([`/api/clips/${ID}/opened`, `/api/clips/${ID}/a/b`])('404 for %s', async (path) => {
    const { status, body } = await call('GET', path);
    expect(status).toBe(404);
    expect(body).toEqual({ error: 'Not found' });
    expect(mockSql.queries).toHaveLength(0);
  });

  it.each([
    // no list of clips
    ['GET', '/api/clips'],
    ['PUT', '/api/clips'],
    ['DELETE', '/api/clips'],
    ['POST', `/api/clips/${ID}`],
    ['DELETE', `/api/clips/${ID}`],
  ])('405 for %s %s', async (method, path) => {
    const { status, body } = await call(method, path);
    expect(status).toBe(405);
    expect(body).toEqual({ error: 'Method not allowed' });
    expect(mockSql.queries).toHaveLength(0);
  });

  it('accepts a trailing slash', async () => {
    mockSql.respond(Q.insert, [{ id: ID }]);
    const { status } = await call('POST', '/api/clips/', { clip, turnstileToken: 'turnstile' });
    expect(status).toBe(201);
  });

  it('hides database errors behind 500', async () => {
    mockSql.respond(Q.get, new Error('connection refused'));
    const { status, body } = await call('GET', `/api/clips/${ID}`);
    expect(status).toBe(500);
    expect(body).toEqual({ error: 'Internal error' });
  });
});

describe('POST /api/clips', () => {
  const save = (body: unknown = { clip, turnstileToken: 'turnstile' }) => call('POST', '/api/clips', body);

  it('creates a clip and returns the edit token once', async () => {
    mockSql.respond(Q.insert, [{ id: ID }]);
    const { status, body } = await save({
      clip: { ...clip, name: '  My   Loop ' },
      turnstileToken: 'turnstile',
    });

    expect(status).toBe(201);
    expect(body).toEqual({ id: ID, existed: false, editToken: expect.any(String) });
    expect(body.editToken.length).toBeGreaterThanOrEqual(40);
    expect(verifyTurnstileMock).toHaveBeenCalledWith('turnstile', '1.2.3.4');

    const [insert] = mockSql.find(Q.insert);
    expect(insert.text).toContain('ON CONFLICT (hash) DO NOTHING');
    const [hash, name, stored, ipHash, editTokenHash] = insert.values;
    expect(hash).toBe(clipHash(clip));
    expect(name).toBe('My Loop');
    // the name is a column of its own, not in the data
    expect((stored as JsonValue).json).toEqual(normalized);
    expect(ipHash).toBe(IP_HASH);
    expect(editTokenHash).toBe(sha256(body.editToken));
    expect(insert.values).not.toContain(body.editToken);
    expect(insert.values).not.toContain('1.2.3.4');
  });

  it.each([
    ['no name', undefined],
    ['an empty name', '   '],
  ])('stores a clip with %s with the name NULL', async (_, name) => {
    mockSql.respond(Q.insert, [{ id: ID }]);
    expect((await save({ clip: { ...clip, name }, turnstileToken: 't' })).status).toBe(201);
    const [, stored, data] = mockSql.find(Q.insert)[0].values;
    expect(stored).toBeNull();
    expect((data as JsonValue).json).toEqual(normalized);
  });

  it('gives every clip a new edit token', async () => {
    mockSql.respond(Q.insert, [{ id: ID }]);
    const first = await save();
    const second = await save();
    expect(first.body.editToken).not.toBe(second.body.editToken);
  });

  it('returns an existing clip of the same notes without the captcha and without a token', async () => {
    mockSql.respond(Q.findByHash, [{ id: OTHER_ID }]);
    const { status, body } = await save({ clip: { ...clip, name: 'Another name' }, turnstileToken: 't' });
    expect(status).toBe(200);
    expect(body).toEqual({ id: OTHER_ID, existed: true });
    expect(mockSql.find(Q.findByHash)[0].values).toEqual([clipHash(clip)]);
    expect(verifyTurnstileMock).not.toHaveBeenCalled();
    expect(mockSql.find(Q.insert)).toHaveLength(0);
  });

  it('returns the existing clip even over the limit', async () => {
    mockSql.respond(Q.findByHash, [{ id: OTHER_ID }]);
    mockSql.respond(Q.count, [{ count: 100 }]);
    expect((await save()).status).toBe(200);
  });

  it('limits saves to 10 per hour per IP', async () => {
    mockSql.respond(Q.count, [{ count: 10 }]);
    const { status, body } = await save();
    expect(status).toBe(429);
    expect(body).toEqual({ error: 'Too many clips saved, try again later' });
    const [count] = mockSql.find(Q.count);
    expect(count.values).toEqual([IP_HASH]);
    expect(count.text).toContain("created_at > now() - interval '1 hour'");
    expect(verifyTurnstileMock).not.toHaveBeenCalled();
    expect(mockSql.find(Q.insert)).toHaveLength(0);

    mockSql.respond(Q.count, [{ count: 9 }]);
    mockSql.respond(Q.insert, [{ id: ID }]);
    expect((await save()).status).toBe(201);
  });

  it('rejects a failed captcha with 403', async () => {
    verifyTurnstileMock.mockResolvedValue(false);
    const { status, body } = await save();
    expect(status).toBe(403);
    expect(body).toEqual({ error: 'Captcha check failed, try again' });
    expect(mockSql.find(Q.insert)).toHaveLength(0);
  });

  it('returns the clip saved by a concurrent request with the same notes, without a token', async () => {
    let lookups = 0;
    mockSql.respond(Q.findByHash, () => (lookups++ === 0 ? [] : [{ id: OTHER_ID }]));
    const { status, body } = await save();
    expect(status).toBe(200);
    expect(body).toEqual({ id: OTHER_ID, existed: true });
    expect(mockSql.find(Q.insert)).toHaveLength(1);
  });

  it('fails with 500 when the conflicting clip is gone', async () => {
    expect((await save()).status).toBe(500);
  });

  it('fails with 500 on database errors', async () => {
    mockSql.respond(Q.insert, pgError('23505', 'clips_pkey'));
    expect((await save()).status).toBe(500);
  });

  it.each([
    ['invalid JSON', '{'],
    ['a missing captcha token', { clip }],
    ['a missing clip', { turnstileToken: 't' }],
    ['a tempo out of range', { clip: { ...clip, bpm: 400 }, turnstileToken: 't' }],
    ['a length out of range', { clip: { ...clip, length: CLIP_LENGTH_MAX + 1 }, turnstileToken: 't' }],
    ['a fractional tick', { clip: { ...clip, notes: [[0.5, 10, 60, 100]] }, turnstileToken: 't' }],
    ['velocity 0', { clip: { ...clip, notes: [[0, 10, 60, 0]] }, turnstileToken: 't' }],
    [
      'too many notes',
      {
        clip: {
          ...clip,
          length: CLIP_LENGTH_MAX,
          notes: Array.from({ length: CLIP_NOTES_MAX + 1 }, (_, i) => [i, 1, 60, 100]),
        },
        turnstileToken: 't',
      },
    ],
    [
      'a too long name',
      { clip: { ...clip, name: 'x'.repeat(CLIP_NAME_MAX_LENGTH + 1) }, turnstileToken: 't' },
    ],
  ])('rejects %s with 400 without a query', async (_, body) => {
    const response = await save(body);
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/^Invalid/);
    expect(mockSql.queries).toHaveLength(0);
  });

  it('rejects profane names with 400', async () => {
    const { status, body } = await save({ clip: { ...clip, name: 'fuck' }, turnstileToken: 't' });
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'Please choose another name' });
    expect(mockSql.queries).toHaveLength(0);
  });

  it('takes the largest clip', async () => {
    mockSql.respond(Q.insert, [{ id: ID }]);
    const notes = Array.from({ length: CLIP_NOTES_MAX }, (_, i) => [
      CLIP_LENGTH_MAX - 1 - i,
      CLIP_LENGTH_MAX,
      127,
      127,
    ]);
    const body = {
      clip: { bpm: 123.45, length: CLIP_LENGTH_MAX, notes, name: 'x'.repeat(CLIP_NAME_MAX_LENGTH) },
      turnstileToken: 't'.repeat(4096),
    };
    expect(JSON.stringify(body).length).toBeLessThan(64 * 1024);
    expect((await save(body)).status).toBe(201);
    expect(
      ((mockSql.find(Q.insert)[0].values[2] as JsonValue).json as { notes: unknown[] }).notes
    ).toHaveLength(CLIP_NOTES_MAX);
  });

  it('rejects bodies over 64 KB with 413', async () => {
    const { status } = await save({ clip, turnstileToken: 't', junk: 'x'.repeat(64 * 1024) });
    expect(status).toBe(413);
    expect(mockSql.queries).toHaveLength(0);
  });
});

describe('PUT /api/clips/:id', () => {
  const update = (body: unknown = { clip: { ...clip, name: 'New name' }, editToken: EDIT_TOKEN }, id = ID) =>
    call('PUT', `/api/clips/${id}`, body);
  const editable = (row: Partial<{ editTokenHash: string | null; throttled: boolean }>) =>
    mockSql.respond(Q.editable, [{ editTokenHash: sha256(EDIT_TOKEN), throttled: false, ...row }]);

  it('overwrites the notes and the name', async () => {
    editable({});
    const { status, body } = await update({ clip: { ...clip, name: ' New   name ' }, editToken: EDIT_TOKEN });
    expect(status).toBe(200);
    expect(body).toEqual({ id: ID });

    const [select] = mockSql.find(Q.editable);
    expect(select.values).toEqual([5, ID]);
    expect(select.text).toContain(
      'COALESCE(updated_at > now() - make_interval(secs => $1), false) AS throttled'
    );
    const [query] = mockSql.find(Q.update);
    const [hash, name, stored, id] = query.values;
    expect(hash).toBe(clipHash(clip));
    expect(name).toBe('New name');
    expect((stored as JsonValue).json).toEqual(normalized);
    expect(id).toBe(ID);
    expect(query.text).toContain('updated_at = now()');
    // the CDN answers the presets that open with it with the new notes
    expect(purgeCacheMock).toHaveBeenCalledTimes(1);
    expect(purgeCacheMock).toHaveBeenCalledWith({ tags: [`clip-${ID}`] });
  });

  it('purges the tag of the id in lower case, as the DB gives it, whatever the case of the URL', async () => {
    editable({});
    const { status, body } = await update(undefined, ID.toUpperCase());
    expect(status).toBe(200);
    expect(body).toEqual({ id: ID });
    expect(mockSql.find(Q.update)[0].values[3]).toBe(ID);
    expect(purgeCacheMock).toHaveBeenCalledWith({ tags: [`clip-${ID}`] });
  });

  it('succeeds when the purge of the cache fails, logging it', async () => {
    editable({});
    purgeCacheMock.mockRejectedValue(new Error('purge failed'));
    const { status, body } = await update();
    expect(status).toBe(200);
    expect(body).toEqual({ id: ID });
    expect(console.error).toHaveBeenCalledWith('Cache purge failed', [`clip-${ID}`], expect.any(Error));
  });

  it('answers without waiting for the purge, handed to the runtime', async () => {
    editable({});
    // the purge API hangs until the end of the test
    let answerPurge: () => void = () => undefined;
    purgeCacheMock.mockReturnValue(new Promise<void>((resolve) => (answerPurge = resolve)));
    const waitUntil = jest.fn();
    const body = { clip: { ...clip, name: 'New name' }, editToken: EDIT_TOKEN };
    const response = await handler(request('PUT', `/api/clips/${ID}`, body), { ...context, waitUntil });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: ID });
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise));
    expect(purgeCacheMock).toHaveBeenCalledWith({ tags: [`clip-${ID}`] });
    answerPurge();
    await waitUntil.mock.calls[0][0];
  });

  it('clears the name', async () => {
    editable({});
    expect((await update({ clip, editToken: EDIT_TOKEN })).status).toBe(200);
    expect(mockSql.find(Q.update)[0].values[1]).toBeNull();
  });

  it('returns 400 for an invalid id without a query', async () => {
    const { status, body } = await update(undefined, 'not-a-uuid');
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'Invalid clip id' });
    expect(mockSql.queries).toHaveLength(0);
  });

  it('returns 404 for a missing clip', async () => {
    const { status, body } = await update();
    expect(status).toBe(404);
    expect(body).toEqual({ error: 'Clip not found' });
    expect(mockSql.find(Q.update)).toHaveLength(0);
    expect(purgeCacheMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a clip without a token', null],
    ['a wrong token', sha256('another token value')],
    ['a malformed stored hash', 'short'],
  ])('rejects %s with 403', async (_, editTokenHash) => {
    editable({ editTokenHash });
    const { status, body } = await update();
    expect(status).toBe(403);
    expect(body).toEqual({ error: 'You can only edit clips saved from this browser' });
    expect(mockSql.find(Q.update)).toHaveLength(0);
    expect(purgeCacheMock).not.toHaveBeenCalled();
  });

  it('allows one update per 5 seconds', async () => {
    editable({ throttled: true });
    const { status, body } = await update();
    expect(status).toBe(429);
    expect(body).toEqual({ error: 'Too many updates, try again in a few seconds' });
    expect(mockSql.find(Q.update)).toHaveLength(0);
    expect(purgeCacheMock).not.toHaveBeenCalled();
  });

  it('rejects the notes of another clip with 409 and returns that clip', async () => {
    editable({});
    mockSql.respond(Q.update, pgError('23505', 'clips_hash_key'));
    mockSql.respond(Q.findByHash, [{ id: OTHER_ID }]);
    const { status, body } = await update();
    expect(status).toBe(409);
    expect(body).toEqual({ error: 'These notes are already saved as another clip', id: OTHER_ID });
    expect(mockSql.find(Q.findByHash)[0].values).toEqual([clipHash(clip)]);
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
    ['a missing token', { clip }],
    ['a short token', { clip, editToken: 'short' }],
    ['an invalid clip', { clip: { ...clip, length: 0 }, editToken: EDIT_TOKEN }],
  ])('rejects %s with 400', async (_, body) => {
    editable({});
    expect((await update(body)).status).toBe(400);
    expect(mockSql.queries).toHaveLength(0);
  });

  it('rejects a profane name with 400', async () => {
    editable({});
    const { status, body } = await update({ clip: { ...clip, name: 'fuck' }, editToken: EDIT_TOKEN });
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'Please choose another name' });
  });
});

describe('GET /api/clips/:id', () => {
  const row = { id: ID, name: 'Loop', data: normalized, createdAt: '2026-01-01T00:00:00Z' };

  it('returns the clip with its name, without caching', async () => {
    mockSql.respond(Q.get, [row]);
    const { status, body, headers } = await call('GET', `/api/clips/${ID}`);
    expect(status).toBe(200);
    expect(body).toEqual({
      id: ID,
      clip: { ...normalized, name: 'Loop' },
      createdAt: '2026-01-01T00:00:00Z',
    });
    expect(headers.get('Cache-Control')).toBe('no-store');
    expect(mockSql.find(Q.get)[0].values).toEqual([ID]);
  });

  it('returns a clip without a name without the key', async () => {
    mockSql.respond(Q.get, [{ ...row, name: null }]);
    const { body } = await call('GET', `/api/clips/${ID}`);
    expect(body.clip).toEqual(normalized);
    expect('name' in body.clip).toBe(false);
  });

  it('marks the clip as opened, at most once a day', async () => {
    mockSql.respond(Q.get, [row]);
    await call('GET', `/api/clips/${ID}`);
    const [opened] = mockSql.find(Q.opened);
    expect(opened.text).toBe(
      'UPDATE clips SET opened_at = now() WHERE id = $1 ' +
        "AND (opened_at IS NULL OR opened_at < now() - interval '1 day')"
    );
    expect(opened.values).toEqual([ID]);
  });

  it('returns the clip when marking it as opened fails', async () => {
    mockSql.respond(Q.get, [row]);
    mockSql.respond(Q.opened, new Error('read-only transaction'));
    const { status, body } = await call('GET', `/api/clips/${ID}`);
    expect(status).toBe(200);
    expect(body.id).toBe(ID);
    expect(console.error).toHaveBeenCalled();
  });

  it('returns 404 for a missing clip', async () => {
    const { status, body } = await call('GET', `/api/clips/${ID}`);
    expect(status).toBe(404);
    expect(body).toEqual({ error: 'Clip not found' });
  });

  it('returns 400 for an invalid id without a query', async () => {
    const { status, body } = await call('GET', '/api/clips/123');
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'Invalid clip id' });
    expect(mockSql.queries).toHaveLength(0);
  });
});
