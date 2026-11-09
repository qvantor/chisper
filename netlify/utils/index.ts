import { S3Client } from '@aws-sdk/client-s3';
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

// the CDN keeps a list a day in its shared (durable) cache, a deploy clears it: every start of the synth asks for both
// lists, the function runs about once a day for the whole site, not once a visit. A day stale it is still answered
// while the CDN asks the function again. The browser asks the CDN every time
export const LIST_CDN_CACHE = 'public, durable, s-maxage=86400, stale-while-revalidate=604800';
export const LIST_BROWSER_CACHE = 'public, max-age=0, must-revalidate';

// the tree of a list, cached (LIST_CDN_CACHE)
export const listResponse = (tree: unknown) =>
  json(tree, 200, {
    ...getHeaders(),
    'Cache-Control': LIST_BROWSER_CACHE,
    'Netlify-CDN-Cache-Control': LIST_CDN_CACHE,
  });

// the answer of a list that failed (R2 unreachable, its variables missing): logged, no error or trace sent (Netlify
// would answer a function that threw with its message and stack), never cached (no-store of `json`)
export const serverError = (error: unknown) => {
  console.error(error);
  return json({ error: 'Internal error' }, 500, getHeaders());
};
