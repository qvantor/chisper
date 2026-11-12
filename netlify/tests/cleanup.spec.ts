import { purgeCache } from '@netlify/functions';
import cleanup, { config } from '../functions/cleanup.mjs';
import { createFakeSql } from './fake-sql';
import { ID, OTHER_ID } from './helpers';

const mockSql = createFakeSql();
jest.mock('../utils/db', () => ({ db: () => mockSql.sql }));
jest.mock('@netlify/functions', () => ({ purgeCache: jest.fn() }));

const purgeCacheMock = purgeCache as jest.Mock;
const deletePresets = /^DELETE FROM presets/;

beforeEach(() => {
  mockSql.reset();
  purgeCacheMock.mockReset().mockResolvedValue(undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

it('runs daily', () => {
  expect(config.schedule).toBe('@daily');
});

it('removes unqualified presets not saved, edited or opened by their author for 90 days, old listeners and reports', async () => {
  await cleanup();
  const [presets, listens, reports] = mockSql.queries;
  expect(mockSql.queries).toHaveLength(4);
  expect(presets.text).toBe(
    'DELETE FROM presets WHERE GREATEST(created_at, updated_at, author_opened_at) ' +
      "< now() - interval '90 days' AND qualified_at IS NULL AND NOT featured RETURNING id"
  );
  // stayed <= heard: the whole row is out of the 60 days of the scores
  expect(listens.text).toBe('DELETE FROM listens WHERE heard < current_date - 60');
  // reports of hidden presets and those older than half a year
  expect(reports.text).toBe(
    "DELETE FROM reports WHERE created_at < now() - interval '180 days' " +
      'OR preset_id IN (SELECT id FROM presets WHERE hidden)'
  );
});

it('purges the cached answers of the deleted presets in one request', async () => {
  mockSql.respond(deletePresets, [{ id: ID }, { id: OTHER_ID }]);
  await cleanup();
  expect(purgeCacheMock).toHaveBeenCalledTimes(1);
  expect(purgeCacheMock).toHaveBeenCalledWith({ tags: [`preset-${ID}`, `preset-${OTHER_ID}`] });
});

it('purges nothing when no preset is deleted', async () => {
  await cleanup();
  expect(purgeCacheMock).not.toHaveBeenCalled();
});

it('goes on when the purge of the cache fails, logging it', async () => {
  mockSql.respond(deletePresets, [{ id: ID }]);
  purgeCacheMock.mockRejectedValue(new Error('purge failed'));
  await cleanup();
  expect(console.error).toHaveBeenCalledWith('Cache purge failed', [`preset-${ID}`], expect.any(Error));
  expect(mockSql.find(/^DELETE FROM clips/)).toHaveLength(1);
});

it('removes clips not saved, edited or opened by their link for 180 days, but those a preset opens with', async () => {
  await cleanup();
  const clips = mockSql.find(/^DELETE FROM clips/);
  expect(clips).toHaveLength(1);
  // GREATEST skips NULLs: a clip never edited nor opened counts from its creation
  expect(clips[0].text).toBe(
    "DELETE FROM clips WHERE GREATEST(created_at, updated_at, opened_at) < now() - interval '180 days' " +
      'AND NOT EXISTS (SELECT 1 FROM presets WHERE clip_id = clips.id)'
  );
  expect(clips[0].values).toEqual([]);
});
