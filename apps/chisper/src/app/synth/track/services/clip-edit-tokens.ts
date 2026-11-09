import { editTokenStore } from '../../../presets/services/edit-tokens';

// secrets for editing clips saved from this browser, apart from those of the presets
const clipTokens = editTokenStore('clipEditTokens');

export const getClipEditToken = clipTokens.get;

export const setClipEditToken = clipTokens.set;
