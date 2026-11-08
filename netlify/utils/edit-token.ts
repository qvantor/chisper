import { randomBytes, timingSafeEqual } from 'node:crypto';
import { sha256 } from './http';

// the secret of an author (of a preset, of a clip): the token goes to them once, only its hash is stored
export const newEditToken = () => {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: sha256(token) };
};

// whether `token` is the one of the stored hash (none: saved without one, it can't be edited)
export const matchesEditToken = (hash: string | null, token: string) => {
  if (!hash) return false;
  const given = sha256(token);
  return hash.length === given.length && timingSafeEqual(Buffer.from(hash), Buffer.from(given));
};
