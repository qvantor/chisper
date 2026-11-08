import type { ClipNote } from '@chisper/preset-schema';

// the undo of the clip: its notes and length before each edit, in memory (not kept by the tab), HISTORY_MAX steps

export interface ClipBody {
  length: number;
  notes: ClipNote[];
}

export const HISTORY_MAX = 100;

export interface ClipHistory {
  past: ClipBody[];
  future: ClipBody[];
}

export const emptyHistory = (): ClipHistory => ({ past: [], future: [] });

// an edit from `before`: it can be undone, what was undone can't be redone
export const record = ({ past }: ClipHistory, before: ClipBody): ClipHistory => ({
  past: [...past, before].slice(-HISTORY_MAX),
  future: [],
});

// the body before the last edit (null: none) and the history with `current` to redo
export const undo = ({ past, future }: ClipHistory, current: ClipBody) =>
  past.length
    ? { body: past[past.length - 1], history: { past: past.slice(0, -1), future: [current, ...future] } }
    : null;

export const redo = ({ past, future }: ClipHistory, current: ClipBody) =>
  future.length
    ? { body: future[0], history: { past: [...past, current].slice(-HISTORY_MAX), future: future.slice(1) } }
    : null;
