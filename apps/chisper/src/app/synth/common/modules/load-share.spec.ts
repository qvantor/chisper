import { BehaviorSubject } from 'rxjs';
import type { TableState } from '../wavetable/wavetable-engine';
import {
  DOWNLOAD_SHARE,
  resumedShare,
  shareAfterLoad,
  STORE_SHARE,
  STORE_WAIT_MS,
  tableLoads,
} from './load-share';

describe('shareAfterLoad', () => {
  it('waits for the store with a table loaded on its way to it', () => {
    expect(shareAfterLoad(true, 'sending')).toBe(STORE_SHARE);
  });

  it.each([
    ['the wavetable oscillator not ready (it sends the table once it is)', true, undefined],
    ['a table stored at once', true, 'stored'],
    ['a table refused', true, 'refused'],
  ] as const)('is none with %s', (_, loaded, state) => {
    expect(shareAfterLoad(loaded, state)).toBeNull();
  });

  it.each([
    ['an edit of the version before on its way', 'sending'],
    ['nothing sent', undefined],
  ] as const)('is failed with a failed load, %s', (_, state) => {
    expect(shareAfterLoad(false, state)).toBe('failed');
  });
});

describe('resumedShare', () => {
  it('follows a download, one that starts again fills the rest from the share it had', () => {
    const share = resumedShare();
    expect(share(0)).toBe(0);
    expect(share(0.6)).toBeCloseTo(0.6);
    expect(share(0)).toBeCloseTo(0.6);
    expect(share(0.5)).toBeCloseTo(0.8);
    expect(share(0.2)).toBeCloseTo(0.84);
    expect(share(1)).toBeCloseTo(1);
  });
});

describe('tableLoads', () => {
  const setup = () => {
    const $tables = new BehaviorSubject<Record<string, TableState>>({});
    const loads = tableLoads($tables, 't');
    const subscription = loads.followStore();
    const report = loads.report(new AbortController().signal);
    return { $tables, loads, subscription, report };
  };
  afterEach(() => jest.useRealTimers());

  it('never goes back within a load, a new one starts from nothing', () => {
    const { loads, report } = setup();
    loads.start();
    report(0.6);
    report(0);
    expect(loads.$progress.value).toBeCloseTo(DOWNLOAD_SHARE * 0.6);
    report(0.5);
    expect(loads.$progress.value).toBeCloseTo(DOWNLOAD_SHARE * 0.8);

    loads.start();
    expect(loads.$progress.value).toBe(0);
    report(0.5);
    expect(loads.$progress.value).toBeCloseTo(DOWNLOAD_SHARE * 0.5);
  });

  it('reports nothing once given up', () => {
    const { loads } = setup();
    loads.start();
    const controller = new AbortController();
    const report = loads.report(controller.signal);
    controller.abort();
    report(0.5);
    expect(loads.$progress.value).toBe(0);
  });

  it("fails a table loaded the store doesn't answer within STORE_WAIT_MS, not one that moves on", () => {
    jest.useFakeTimers();
    const { $tables, loads, subscription } = setup();
    loads.start();
    $tables.next({ t: 'sending' });
    loads.end(true);
    jest.advanceTimersByTime(STORE_WAIT_MS - 1);
    expect(loads.$progress.value).toBe(STORE_SHARE);
    jest.advanceTimersByTime(1);
    expect(loads.$progress.value).toBe('failed');

    // stored before it: no timeout after it
    loads.start();
    loads.end(true);
    $tables.next({ t: 'stored' });
    expect(loads.$progress.value).toBeNull();
    jest.advanceTimersByTime(STORE_WAIT_MS);
    expect(loads.$progress.value).toBeNull();

    // stopped with the model: no timer left
    $tables.next({ t: 'sending' });
    loads.start();
    loads.end(true);
    subscription.unsubscribe();
    expect(jest.getTimerCount()).toBe(0);
  });
});
