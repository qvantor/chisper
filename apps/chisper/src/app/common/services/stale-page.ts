// A page loaded before a deploy that loads a file of its build only now (the chunk of the export, the core of the
// engine it renders on): the site keeps the files of the last deploy alone, its own are gone (and one of a later
// build would not fit its code). What the page is told then, whether a load failed so (a chunk of webpack)
export const UPDATED = 'Chisper was updated: reload the page to export';
export const isChunkGone = (error: unknown) => error instanceof Error && error.name === 'ChunkLoadError';
