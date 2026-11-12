import { S3Client } from '@aws-sdk/client-s3';
import { cachedHeaders, LIST_CDN_CACHE } from './cdn-cache';
import { json } from './http';

// the buckets of the tables (R2_BUCKET) and of the noise samples (R2_NOISES_BUCKET), Cloudflare R2 through its S3
// API: their lists (the browser fetches the files from their custom domains)
export const client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID ?? ''}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
  },
});

export const getHeaders = () => {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTION',
  };
};

// the tree of a list, kept by the CDN (LIST_CDN_CACHE): an upload shows after a deploy or within a day
export const listResponse = (tree: unknown) =>
  json(tree, 200, { ...getHeaders(), ...cachedHeaders(LIST_CDN_CACHE) });

// the answer of a list that failed (R2 unreachable, its variables missing): logged, no error or trace sent (Netlify
// would answer a function that threw with its message and stack), never cached (no-store of `json`)
export const serverError = (error: unknown) => {
  console.error(error);
  return json({ error: 'Internal error' }, 500, getHeaders());
};
