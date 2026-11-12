import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { client } from '../utils';
import { BROWSER_REVALIDATE, LIST_CDN_CACHE } from '../utils/cdn-cache';
import handler from '../functions/get-noises-list.mjs';
import { caller } from './helpers';

jest.mock('../utils', () => ({
  ...jest.requireActual('../utils'),
  client: { send: jest.fn() },
}));

const send = client.send as jest.Mock;
const call = caller(handler);

const list = async () => {
  const { status, headers, body } = await call('GET', '/.netlify/functions/get-noises-list');
  return { status, headers, tree: body };
};
const page = (keys: string[], next?: string) => ({
  Contents: keys.map((Key) => ({ Key, Size: 2, ETag: '"x"' })),
  IsTruncated: next !== undefined,
  NextContinuationToken: next,
});
const noOrder = () => Promise.reject(Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }));

// the bucket: its pages of the list in turn, order.json the text of `order` (none: not there)
const bucket = (pages: object[], order?: () => Promise<string>) =>
  send.mockImplementation((command) => {
    if (command instanceof GetObjectCommand)
      return order ? Promise.resolve({ Body: { transformToString: order } }) : noOrder();
    return Promise.resolve(pages.shift());
  });
const listCalls = () => send.mock.calls.map(([c]) => c).filter((c) => c instanceof ListObjectsV2Command);

beforeEach(() => {
  send.mockReset();
  process.env.R2_NOISES_BUCKET = 'noises';
});

afterAll(() => {
  delete process.env.R2_NOISES_BUCKET;
});

it('lists the noise bucket as a tree of its folders, a leaf its key and size', async () => {
  bucket([page(['Analog/', 'Analog/Pink.wav', 'Analog/White.wav', 'Textures/Rain.wav'])]);
  const response = await list();
  expect(listCalls()[0].input).toEqual({ Bucket: 'noises', ContinuationToken: undefined });
  expect(response.status).toBe(200);
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  // kept by the CDN: a visit doesn't run the function
  expect(response.headers.get('Netlify-CDN-Cache-Control')).toBe(LIST_CDN_CACHE);
  expect(response.headers.get('Cache-Control')).toBe(BROWSER_REVALIDATE);
  expect(response.tree).toEqual([
    {
      name: 'Analog',
      children: [
        { Key: 'Analog/Pink.wav', Size: 2 },
        { Key: 'Analog/White.wav', Size: 2 },
      ],
    },
    { name: 'Textures', children: [{ Key: 'Textures/Rain.wav', Size: 2 }] },
  ]);
});

it('reads every page of the list', async () => {
  bucket([page(['A/one.wav'], 'next'), page(['A/two.wav'])]);
  const { tree } = await list();
  expect(listCalls()[1].input.ContinuationToken).toBe('next');
  expect(tree).toEqual([
    {
      name: 'A',
      children: [
        { Key: 'A/one.wav', Size: 2 },
        { Key: 'A/two.wav', Size: 2 },
      ],
    },
  ]);
});

it('answers an empty list without samples', async () => {
  bucket([{ IsTruncated: false }]);
  expect((await list()).tree).toEqual([]);
});

it('answers 500 without the error when the bucket fails, and logs it', async () => {
  const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const failure = new Error('No bucket');
  send.mockRejectedValue(failure);
  const { status, headers, tree } = await list();
  expect(status).toBe(500);
  expect(headers.get('Access-Control-Allow-Origin')).toBe('*');
  // a failure isn't cached: the next visit asks the bucket again
  expect(headers.get('Cache-Control')).toBe('no-store');
  expect(headers.get('Netlify-CDN-Cache-Control')).toBeNull();
  expect(tree).toEqual({ error: 'Internal error' });
  expect(error).toHaveBeenCalledWith(failure);
  error.mockRestore();
});

describe('order.json', () => {
  const keys = (tree: { name: string; children: { Key: string }[] }[]) =>
    tree.map(({ name, children }) => [name, children.map((c) => c.Key.split('/')[1])]);

  it('orders the folders and their samples by it, those it lacks after them by key; it is no sample', async () => {
    bucket(
      [
        page([
          'Analog/Band 1600.wav',
          'Analog/Band 400.wav',
          'Analog/New.wav',
          'Analog/Pink.wav',
          'Analog/White.wav',
          'Kicks/Boom.wav',
          'Other/A.wav',
          'Textures/Rain.wav',
          'Textures/Wind.wav',
          'order.json',
        ]),
      ],
      async () =>
        JSON.stringify([
          'Analog/White.wav',
          'Analog/Pink.wav',
          'Analog/Band 400.wav',
          'Analog/Band 1600.wav',
          'Analog/Gone.wav',
          'Textures/Wind.wav',
          'Textures/Rain.wav',
          'Kicks/Boom.wav',
        ])
    );
    const { tree } = await list();
    expect(send.mock.calls.some(([c]) => c instanceof GetObjectCommand && c.input.Key === 'order.json')).toBe(
      true
    );
    expect(send.mock.calls.find(([c]) => c instanceof GetObjectCommand)[0].input.Bucket).toBe('noises');
    expect(keys(tree)).toEqual([
      ['Analog', ['White.wav', 'Pink.wav', 'Band 400.wav', 'Band 1600.wav', 'New.wav']],
      ['Textures', ['Wind.wav', 'Rain.wav']],
      ['Kicks', ['Boom.wav']],
      ['Other', ['A.wav']],
    ]);
  });

  it.each([
    ['not there', undefined],
    ['not JSON', async () => '{'],
    ['not a list', async () => '{"Analog/White.wav": 0}'],
  ])('%s: the list by key', async (_, order) => {
    bucket([page(['Analog/Pink.wav', 'Analog/White.wav', 'order.json'])], order);
    const { status, tree } = await list();
    expect(status).toBe(200);
    expect(keys(tree)).toEqual([['Analog', ['Pink.wav', 'White.wav']]]);
  });

  it.each([
    ['its request', 'request'],
    ['its body', 'body'],
  ])(
    'R2 failing to give it (%s): 500, not cached, not a list by key the CDN would keep',
    async (_, where) => {
      const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const failure = Object.assign(new Error('reset'), { name: 'InternalError' });
      if (where === 'body') bucket([page(['Analog/Pink.wav', 'order.json'])], () => Promise.reject(failure));
      else
        send.mockImplementation((command) =>
          command instanceof GetObjectCommand
            ? Promise.reject(failure)
            : Promise.resolve(page(['Analog/Pink.wav', 'order.json']))
        );
      const { status, headers, tree } = await list();
      expect(status).toBe(500);
      expect(headers.get('Cache-Control')).toBe('no-store');
      expect(headers.get('Netlify-CDN-Cache-Control')).toBeNull();
      expect(tree).toEqual({ error: 'Internal error' });
      expect(error).toHaveBeenCalledWith(failure);
      error.mockRestore();
    }
  );

  it('takes only the strings of it', async () => {
    bucket([page(['A/one.wav', 'A/two.wav'])], async () =>
      JSON.stringify([1, null, 'A/two.wav', { k: 'A/one.wav' }])
    );
    expect(keys((await list()).tree)).toEqual([['A', ['two.wav', 'one.wav']]]);
  });
});
