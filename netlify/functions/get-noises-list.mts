import { GetObjectCommand, ListObjectsV2Command, _Object } from '@aws-sdk/client-s3';
import { client, listResponse, serverError } from '../utils';
import { listToTree } from '../utils/tree';

// the order of the samples in the synth: the keys of the bucket's order.json (scripts/noises/process.mjs writes
// it from the manifest, upload.mjs puts it with them)
const ORDER_KEY = 'order.json';

// none (or not a list of keys): no order. One R2 failed to give (a request or its body cut short) throws: the list
// answers 500, which the CDN doesn't keep, not the samples by key it would keep a day
const readOrder = async (Bucket: string | undefined): Promise<string[]> => {
  let text: string;
  try {
    const { Body } = await client.send(new GetObjectCommand({ Bucket, Key: ORDER_KEY }));
    text = (await Body?.transformToString()) ?? '[]';
  } catch (error) {
    if (error instanceof Error && error.name === 'NoSuchKey') return [];
    throw error;
  }
  try {
    const keys: unknown = JSON.parse(text);
    return Array.isArray(keys) ? keys.filter((key): key is string => typeof key === 'string') : [];
  } catch {
    return [];
  }
};

// every page of the list, by key
const listSamples = async (Bucket: string | undefined) => {
  const samples: _Object[] = [];
  let ContinuationToken: string | undefined;
  do {
    const result = await client.send(new ListObjectsV2Command({ Bucket, ContinuationToken }));
    (result.Contents ?? []).forEach(({ Key, Size }) => {
      if (Key && !Key.endsWith('/') && Key !== ORDER_KEY) samples.push({ Key, Size });
    });
    ContinuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return samples;
};

// the samples of the noise oscillator (the bucket R2_NOISES_BUCKET, scripts/noises/upload.mjs puts them there) as
// a tree of their folders (its categories), a leaf its key and size; in the order of order.json (a folder where its
// first sample is), those it hasn't after them by key. Cached by the CDN (listResponse): an upload shows in the synth
// after a deploy or within a day; a failure of the list or of order.json isn't cached (serverError). At
// /.netlify/functions/<name> (no path of its own)
export default async () => {
  try {
    const Bucket = process.env.R2_NOISES_BUCKET;
    const [order, samples] = await Promise.all([readOrder(Bucket), listSamples(Bucket)]);
    const rank = new Map(order.map((key, i) => [key, i]));
    const at = (sample: _Object) => rank.get(sample.Key ?? '') ?? order.length;
    return listResponse(listToTree(samples.sort((a, b) => at(a) - at(b))));
  } catch (error) {
    return serverError(error);
  }
};
