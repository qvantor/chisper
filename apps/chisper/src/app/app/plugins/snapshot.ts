import { searchParamsSnapshotPlugin } from '@chisper/rxjs-react';

// the snapshot of the models of the page (presets, the url); `snapshotScope()`: one of its own for a copy of the
// models (a render of the track), which never takes the place of theirs
export const {
  plugin: urlSnapshotPlugin,
  getSnapshot,
  applySnapshot,
  $changes: $snapshotChanges,
  scope: snapshotScope,
} = searchParamsSnapshotPlugin();
