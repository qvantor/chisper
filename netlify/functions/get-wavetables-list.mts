import { ListObjectsCommand } from '@aws-sdk/client-s3';
import { client, listResponse, serverError } from '../utils';
import { listToTree } from '../utils/tree';

// the wavetables of the bucket as a folder tree, cached by the CDN (listResponse); at /.netlify/functions/<name> (no
// path of its own)
export default async () => {
  try {
    const result = await client.send(new ListObjectsCommand({ Bucket: process.env.R2_BUCKET }));
    return listResponse(listToTree(result.Contents ?? []));
  } catch (error) {
    return serverError(error);
  }
};
