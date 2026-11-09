import { BehaviorSubject, distinctUntilChanged, filter, map } from 'rxjs';
import { PrimitiveBS } from '@chisper/rxjs-react';
import type { TableState } from '../wavetable/wavetable-engine';

// the progress of a table (or a sample) while it loads, 0..1: its download gives up to DOWNLOAD_SHARE, the table
// loaded stays at STORE_SHARE until the wavetable oscillator has stored it (or refused it, or failed to build it)
export const DOWNLOAD_SHARE = 0.9;
export const STORE_SHARE = 0.95;

// the progress once its load ended: the table loaded on its way to the store (the engine ready: it sent it at once),
// else none (null: played, or the load failed and the version before plays)
export const shareAfterLoad = (loaded: boolean, state: TableState | undefined) =>
  loaded && state === 'sending' ? STORE_SHARE : null;

// the loads of the table (or the sample) a model sends to the wavetable oscillator under `id`: whether one is on, its
// progress (null: none loading) until the oscillator answered the table loaded, where the table is in the oscillator
// (null: not sent yet; refused or failed: the version before plays) and whether its notes play the table of its
// path: loaded and in the oscillator (stored, or refused or failed). The table loaded goes to the oscillator before
// its load ends (it is sending then), so no moment between them reads as played
export const tableLoads = ($tables: BehaviorSubject<Record<string, TableState>>, id: string) => {
  const $loading = new PrimitiveBS<boolean>(false);
  const $progress = new PrimitiveBS<number | null>(null);
  const $state = $tables.pipe(
    map((tables) => tables[id] ?? null),
    distinctUntilChanged()
  );
  const played = () => !$loading.value && $tables.value[id] !== 'sending';
  return {
    $loading,
    $progress,
    $state,
    played,
    start: () => {
      $loading.next(true);
      $progress.next(0);
    },
    // its download reports its share (not once given up: a newer path)
    report: (signal: AbortSignal) => (share: number) => {
      if (!signal.aborted) $progress.next(DOWNLOAD_SHARE * share);
    },
    end: (loaded: boolean) => {
      $loading.next(false);
      $progress.next(shareAfterLoad(loaded, $tables.value[id]));
    },
    // the progress is gone once the table loaded is played (an edit sent meanwhile has none)
    clearOnPlayed: () => $state.pipe(filter(played)).subscribe(() => $progress.next(null)),
  };
};
