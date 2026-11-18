import { chainCore } from '../../../../test-utils/chain-render';
import { CHAIN_KEYS, FX_KINDS, LFO_SOURCE, LFO_TARGET, MIX_KEY, TARGET_KEYS } from './chain-params';
import { prewarmChain, warmRoutes } from './chain-prewarm';
import type { ChainExports } from './chain-wasm';

const RATE = 48000;

// the core with some of its exports counted
const counted = <K extends keyof ChainExports>(names: K[]) => {
  const core = chainCore();
  const calls = Object.fromEntries(names.map((name) => [name, 0])) as Record<K, number>;
  const spied = Object.fromEntries(
    names.map((name) => [
      name,
      (...args: unknown[]) => {
        calls[name] += 1;
        return (core[name] as (...all: unknown[]) => unknown)(...args);
      },
    ])
  );
  return { core: { ...core, ...spied } as ChainExports, calls };
};

describe('the warm-up of the chain core', () => {
  it('renders every block with every stage and frees its chain', () => {
    const { core, calls } = counted(['chain_new', 'chain_free', 'chain_process', 'chain_fail']);
    expect(prewarmChain(core, RATE)).toBe(true);
    expect(calls.chain_new).toBe(1);
    expect(calls.chain_free).toBe(1);
    expect(calls.chain_process).toBe(19);
    expect(calls.chain_fail).toBe(0);
  });

  it('runs at the rates of a context', () => {
    [44100, 96000, 192000].forEach((rate) => expect(prewarmChain(chainCore(), rate)).toBe(true));
  });

  it('gives the core the routes, a note and the LFOs, one with a shape', () => {
    const { core, calls } = counted(['chain_routes', 'chain_note', 'chain_lfos', 'chain_lfo_table']);
    prewarmChain(core, RATE);
    expect(calls).toEqual({ chain_routes: 1, chain_note: 1, chain_lfos: 1, chain_lfo_table: 1 });
  });

  it('tells a core that traps in it', () => {
    const core = chainCore();
    const trapping: ChainExports = {
      ...core,
      chain_new: (rate, limited) => {
        const chain = core.chain_new(rate, limited);
        core.chain_trap?.(chain, FX_KINDS.indexOf('delay'), 0);
        return chain;
      },
    };
    expect(prewarmChain(trapping, RATE)).toBe(false);
  });

  it('moves a knob of every effect, every line of the delay, the mix of every slot and the rate of an LFO', () => {
    const routes = warmRoutes();
    const targets = routes.map(({ target }) => target);
    expect(new Set(targets).size).toBe(targets.length);
    // (a key that is not of its kind would be -1: the target of another slot)
    const knobs = routes.filter(({ target }) => target < LFO_TARGET && target % TARGET_KEYS !== MIX_KEY);
    knobs.forEach(({ target }) => {
      const kind = FX_KINDS[Math.floor(target / TARGET_KEYS)];
      expect(target % TARGET_KEYS).toBeLessThan(CHAIN_KEYS[kind].length);
    });
    expect(new Set(knobs.map(({ target }) => Math.floor(target / TARGET_KEYS))).size).toBe(FX_KINDS.length);
    const delay = FX_KINDS.indexOf('delay') * TARGET_KEYS;
    ['time', 'fb', 'pan', 'freq', 'q'].forEach((key) =>
      expect(targets).toContain(delay + CHAIN_KEYS.delay.indexOf(key))
    );
    FX_KINDS.forEach((_, slot) => expect(targets).toContain(slot * TARGET_KEYS + MIX_KEY));
    expect(targets).toContain(LFO_TARGET);
    // an envelope and an LFO among the sources; no LFO on a knob of an LFO
    expect(routes.some(({ source }) => source < 3)).toBe(true);
    expect(routes.some(({ source }) => source >= LFO_SOURCE)).toBe(true);
    expect(routes.find(({ target }) => target === LFO_TARGET)?.source).toBeLessThan(LFO_SOURCE);
  });
});
