import { readStored, writeStored } from '../../common/services';

type Tokens = Record<string, string>;

const isTokens = (value: unknown): value is Tokens => !!value && typeof value === 'object';

// secrets for editing what was saved from this browser (presets, clips), by id in localStorage under `key`; the
// server stores only their hashes
export const editTokenStore = (key: string) => {
  const readTokens = () => readStored<Tokens>('localStorage', key, {}, isTokens);
  return {
    get: (id: string): string | undefined => readTokens()[id],
    set: (id: string, token: string) => writeStored('localStorage', key, { ...readTokens(), [id]: token }),
  };
};

const presetTokens = editTokenStore('presetEditTokens');

export const getEditToken = presetTokens.get;

export const setEditToken = presetTokens.set;
