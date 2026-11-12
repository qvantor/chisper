import { meterDue, metered, METER_RATE, watchMeter } from './meter-report';

const RATE = 48000;
// messages over `blocks` blocks of 128
const due = (state: Parameters<typeof meterDue>[0], blocks: number) => {
  let count = 0;
  for (let i = 0; i < blocks; i++) count += +meterDue(state, 128, RATE);
  return count;
};

describe('meter report', () => {
  it('nothing is due while no one watches', () => {
    const state = { ...metered(false), idle: false };
    expect(due(state, 400)).toBe(0);
    expect(state.waited).toBe(0);
  });

  it('about 30 a second while watched: a message once the frames of one have gone by', () => {
    const state = { ...metered(true), idle: false };
    expect(METER_RATE).toBe(30);
    expect(due(state, 12)).toBe(0);
    expect(due(state, 1)).toBe(1);
    expect(due(state, 375)).toBe(28);
  });

  it('a core at rest is told once, again once it sounded or for a new watcher', () => {
    const state = { ...metered(true), idle: true };
    expect(due(state, 375)).toBe(1);
    watchMeter(state, true);
    expect(due(state, 375)).toBe(1);
    state.idle = false;
    expect(due(state, 26)).toBe(2);
    state.idle = true;
    expect(due(state, 375)).toBe(1);
    watchMeter(state, false);
    expect(due(state, 375)).toBe(0);
  });
});
