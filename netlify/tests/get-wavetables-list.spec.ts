import { ListObjectsCommand } from '@aws-sdk/client-s3';
import { client } from '../utils';
import { BROWSER_REVALIDATE, LIST_CDN_CACHE } from '../utils/cdn-cache';
import handler from '../functions/get-wavetables-list.mjs';
import { caller } from './helpers';

jest.mock('../utils', () => ({
  ...jest.requireActual('../utils'),
  client: { send: jest.fn() },
}));

const send = client.send as jest.Mock;
const call = caller(handler);

const answer = async () => {
  const { status, headers, body } = await call('GET', '/.netlify/functions/get-wavetables-list');
  return { status, headers, tree: body };
};

const list = (keys: string[]) => {
  send.mockResolvedValue({ Contents: keys.map((Key) => ({ Key, Size: 1 })) });
  return answer();
};

beforeEach(() => {
  send.mockReset();
  process.env.R2_BUCKET = 'tables';
});

afterAll(() => {
  delete process.env.R2_BUCKET;
});

it('lists the bucket', async () => {
  const response = await list([]);
  const [command] = send.mock.calls[0];
  expect(command).toBeInstanceOf(ListObjectsCommand);
  expect(command.input).toEqual({ Bucket: 'tables' });
  expect(response.status).toBe(200);
  expect(Object.fromEntries(response.headers)).toEqual({
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'Content-Type',
    'access-control-allow-methods': 'GET, OPTION',
    'content-type': 'application/json',
    'cache-control': BROWSER_REVALIDATE,
    'netlify-cdn-cache-control': LIST_CDN_CACHE,
  });
  expect(response.tree).toEqual([]);
});

it('is kept a day in the shared cache of the CDN, a week stale still answered, the browser asks it every time', () => {
  expect(LIST_CDN_CACHE).toBe('public, durable, s-maxage=86400, stale-while-revalidate=604800');
  expect(BROWSER_REVALIDATE).toBe('public, max-age=0, must-revalidate');
});

it('builds a folder tree from the keys', async () => {
  const { tree } = await list(['root.wav', 'A/B/one.wav', 'A/B/two.wav', 'A/three.wav', 'C/four.wav']);
  expect(tree).toEqual([
    { Key: 'root.wav', Size: 1 },
    {
      name: 'A',
      children: [
        {
          name: 'B',
          children: [
            { Key: 'A/B/one.wav', Size: 1 },
            { Key: 'A/B/two.wav', Size: 1 },
          ],
        },
        { Key: 'A/three.wav', Size: 1 },
      ],
    },
    { name: 'C', children: [{ Key: 'C/four.wav', Size: 1 }] },
  ]);
});

it.each([
  ['the file', ['A/B', 'A/B/one.wav']],
  ['the folder', ['A/B/one.wav', 'A/B']],
])('keeps a file and a folder with the same name when %s comes first', async (_, keys) => {
  const { tree } = await list(keys);
  expect(tree).toEqual([
    {
      name: 'A',
      children: expect.arrayContaining([
        { Key: 'A/B', Size: 1 },
        { name: 'B', children: [{ Key: 'A/B/one.wav', Size: 1 }] },
      ]),
    },
  ]);
});

it('answers 500 without the error when the bucket fails, and logs it', async () => {
  const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const failure = new Error('No bucket');
  send.mockRejectedValue(failure);
  const { status, headers, tree } = await answer();
  expect(status).toBe(500);
  expect(headers.get('Access-Control-Allow-Origin')).toBe('*');
  // a failure isn't cached: the next visit asks the bucket again
  expect(headers.get('Cache-Control')).toBe('no-store');
  expect(headers.get('Netlify-CDN-Cache-Control')).toBeNull();
  expect(tree).toEqual({ error: 'Internal error' });
  expect(error).toHaveBeenCalledWith(failure);
  error.mockRestore();
});
