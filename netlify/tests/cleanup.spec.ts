import cleanup, { config } from '../functions/cleanup.mjs';
import { createFakeSql } from './fake-sql';

const mockSql = createFakeSql();
jest.mock('../utils/db', () => ({ db: () => mockSql.sql }));

beforeEach(() => {
  mockSql.reset();
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
      "< now() - interval '90 days' AND qualified_at IS NULL AND NOT featured"
  );
  // stayed <= heard: the whole row is out of the 60 days of the scores
  expect(listens.text).toBe('DELETE FROM listens WHERE heard < current_date - 60');
  // reports of hidden presets and those older than half a year
  expect(reports.text).toBe(
    "DELETE FROM reports WHERE created_at < now() - interval '180 days' " +
      'OR preset_id IN (SELECT id FROM presets WHERE hidden)'
  );
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
