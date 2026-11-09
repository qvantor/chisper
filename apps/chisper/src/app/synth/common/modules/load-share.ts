import { BehaviorSubject, distinctUntilChanged, EMPTY, filter, map, merge, switchMap, timer } from 'rxjs';
import { PrimitiveBS } from '@chisper/rxjs-react';
import type { LoadShare } from '@chisper/ui-kit';
import type { TableState } from '../wavetable/wavetable-engine';

// the progress of a table (or a sample) while it loads, 0..1: its download gives up to DOWNLOAD_SHARE, the table
// loaded stays at STORE_SHARE until the wavetable oscillator has stored it (or refused it, or failed to build it)
export const DOWNLOAD_SHARE = 0.9;
export const STORE_SHARE = 0.95;
// ms: a table loaded the wavetable oscillator doesn't answer by then (a worker or a store that hangs) ends its
// progress as failed; its state stays, an answer after it plays it all the same
export const STORE_WAIT_MS = 10_000;

// the progress once its load ended: the table loaded on its way to the store (the engine ready: it sent it at once),
// none once loaded (null: played, or the engine sends it once it is ready), failed without it (the version before
// plays)
export const shareAfterLoad = (loaded: boolean, state: TableState | undefined): LoadShare => {
  if (!loaded) return 'failed';
  return state === 'sending' ? STORE_SHARE : null;
};

// the share of a download that may start again from 0 (the other route of bucketLoader, a retry) as one that never
// goes back: a start again fills the rest from the share it had
export const resumedShare = () => {
  let base = 0;
  let last = 0;
  return (share: number) => {
    if (share < last) base += (1 - base) * last;
    last = share;
    return base + (1 - base) * share;
  };
};

// the loads of the table (or the sample) a model sends to the wavetable oscillator under `id`: whether one is on, its
// progress (null: none loading) until the oscillator answered the table loaded, where the table is in the oscillator
// (null: not sent yet; refused or failed: the version before plays) and whether its notes play the table of its
// path: loaded and in the oscillator (stored, or refused or failed). The table loaded goes to the oscillator before
// its load ends (it is sending then), so no moment between them reads as played
export const tableLoads = ($tables: BehaviorSubject<Record<string, TableState>>, id: string) => {
  const $loading = new PrimitiveBS<boolean>(false);
  const $progress = new PrimitiveBS<LoadShare>(null);
  const $state = $tables.pipe(
    map((tables) => tables[id] ?? null),
    distinctUntilChanged()
  );
  const played = () => !$loading.value && $tables.value[id] !== 'sending';
  // the share of the download of the load on (its retries and routes included)
  let downloaded = resumedShare();
  return {
    $loading,
    $progress,
    $state,
    played,
    start: () => {
      downloaded = resumedShare();
      $loading.next(true);
      $progress.next(0);
    },
    // its download reports its share (not once given up: a newer path)
    report: (signal: AbortSignal) => (share: number) => {
      if (!signal.aborted) $progress.next(DOWNLOAD_SHARE * downloaded(share));
    },
    end: (loaded: boolean) => {
      $loading.next(false);
      $progress.next(shareAfterLoad(loaded, $tables.value[id]));
    },
    // the progress ends once the table loaded is played (an edit sent meanwhile has none): none once stored, failed
    // once refused or failed to build, or without an answer within STORE_WAIT_MS
    followStore: () =>
      merge(
        $state.pipe(
          filter(played),
          map((state): LoadShare => (state === 'refused' || state === 'failed' ? 'failed' : null))
        ),
        $progress.pipe(
          switchMap((progress) => (progress === STORE_SHARE ? timer(STORE_WAIT_MS) : EMPTY)),
          map((): LoadShare => 'failed')
        )
      ).subscribe((progress) => $progress.next(progress)),
  };
};
