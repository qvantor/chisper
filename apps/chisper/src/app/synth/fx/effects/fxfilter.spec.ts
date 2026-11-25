import { FX_MIX_PARAMS, FX_PARAMS } from '@chisper/preset-schema';
import { FX_FILTER_DEFAULTS } from '../../../../test-utils/fxfilter-render';
import { CHAIN_KEYS, NEUTRAL_PARAMS } from '../../common/chain/chain-params';
import { filterTypeBrowser } from '../../filter/filter-types';
import { fxfilter } from './fxfilter';
import { FX_FILTER_TYPES, fxFilterIndexOf, fxFilterPanOctaves, fxFilterTypeOf } from './fxfilter-params';
import { FX_FILTER_PRESETS } from './fxfilter-presets';
import { FX_FILTER_KEYS } from './fxfilter-wasm';
import { levelGain } from './level';

const RATE = 48000;

describe('fxfilter', () => {
  it('its types by index, as the core has them (append-only), named as those of the filter of a voice', () => {
    expect(FX_FILTER_TYPES).toEqual([
      'ladder6',
      'ladder12',
      'ladder18',
      'ladder24',
      'low6',
      'low12',
      'low18',
      'low24',
      'high6',
      'high12',
      'high18',
      'high24',
      'band12',
      'band24',
      'peak12',
      'peak24',
      'notch12',
      'notch24',
    ]);
    expect(FX_PARAMS.fxfilter.type.max).toBe(FX_FILTER_TYPES.length - 1);
    expect(fxfilter.params.type.options?.map(({ id }) => id)).toEqual([...FX_FILTER_TYPES]);
    const labels = fxfilter.params.type.options?.map(({ label }) => label);
    expect([labels?.[0], labels?.[17]]).toEqual(['Ladder 6', 'Notch 24']);
    // (every type in a folder of the browser)
    const { pathOf } = filterTypeBrowser(FX_FILTER_TYPES);
    FX_FILTER_TYPES.forEach((type) => expect(pathOf(type)).toHaveLength(2));
    expect(fxFilterIndexOf('band24')).toBe(13);
    expect([fxFilterTypeOf(0), fxFilterTypeOf(17), fxFilterTypeOf(18), fxFilterTypeOf(-1)]).toEqual([
      'ladder6',
      'notch24',
      'ladder6',
      'ladder6',
    ]);
  });

  it('the laws of its knobs: the cutoff on a log scale, the others in %, Pan centered, the level in dB', () => {
    const { params } = fxfilter;
    expect(params.cutoff.mode).toBe('log');
    expect([params.cutoff.min, params.cutoff.max, params.cutoff.default]).toEqual([8.176, 22050, 425]);
    expect(params.cutoff.formatValue?.(425)).toBe('425Hz');
    expect(params.cutoff.formatValue?.(2400)).toBe('2.4kHz');
    expect(params.res.formatValue?.(33.3)).toBe('33%');
    expect(params.pan.formatValue?.(50)).toBe('C');
    expect(params.pan.formatValue?.(20)).toBe('20%');
    expect(params.pan.fillFrom).toBe(50);
    expect(params.level.formatValue?.(0.5)).toBe('0.0dB');
    expect(levelGain(FX_FILTER_DEFAULTS.level)).toBe(1);
    // (Pan: the octaves of the left channel over the knob, the right one's under it)
    expect(fxFilterPanOctaves(50)).toBe(0);
    expect(fxFilterPanOctaves(0)).toBeCloseTo(32 / 12, 12);
    expect(fxFilterPanOctaves(75)).toBeCloseTo(-32 / 12 / 8, 12);
  });

  it('a knob for every param of the schema, the core takes them in its order, the mix last (inside)', () => {
    expect(Object.keys(fxfilter.params).sort()).toEqual(Object.keys(FX_PARAMS.fxfilter).sort());
    expect(CHAIN_KEYS.fxfilter).toEqual(['type', 'cutoff', 'res', 'drive', 'var', 'pan', 'level', 'mix']);
    expect([...FX_FILTER_KEYS]).toEqual([...CHAIN_KEYS.fxfilter]);
    // a route is `<source>:<effect>.<param>`: lower case letters and digits
    Object.keys(fxfilter.params).forEach((key) => expect(key).toMatch(/^[a-z][a-z0-9]*$/));
  });

  it('the core takes its knobs as they are, falsy ones included, at any tempo and rate', () => {
    const params = { ...FX_FILTER_DEFAULTS, type: 0, res: 0, drive: 0, var: 0, pan: 0, level: 0 };
    expect(fxfilter.core(params, 120, RATE)).toEqual(params);
    expect(fxfilter.core(params, 60, 96000)).toEqual(params);
  });

  it('its defaults are those of a fresh filter of the reference and of a chain made before the fx model', () => {
    expect(fxfilter.core(FX_FILTER_DEFAULTS, 120, RATE)).toEqual(
      Object.fromEntries(Object.entries(NEUTRAL_PARAMS.fxfilter).filter(([key]) => key !== 'mix'))
    );
    expect(NEUTRAL_PARAMS.fxfilter['mix']).toBe(1);
    expect(FX_MIX_PARAMS.fxfilter.default).toBe(1);
    expect(fxFilterTypeOf(FX_FILTER_DEFAULTS.type)).toBe('ladder6');
    expect(FX_FILTER_DEFAULTS.pan).toBe(50);
  });

  it('a route moves nothing it plays of a knob its type reads not: the resonance of a one-pole, Fat of a notch', () => {
    const unheard = (type: (typeof FX_FILTER_TYPES)[number]) =>
      fxfilter.unheard?.({ ...FX_FILTER_DEFAULTS, type: fxFilterIndexOf(type) }, []);
    expect(unheard('low6')).toEqual(['res', 'var']);
    expect(unheard('high6')).toEqual(['res', 'var']);
    expect(unheard('notch12')).toEqual(['var']);
    expect(unheard('ladder24')).toEqual([]);
    expect(unheard('band12')).toEqual([]);
  });

  it('tells no meter, follows no tempo, its label and presets', () => {
    expect(fxfilter.metered).toBeUndefined();
    expect(fxfilter.paramChange).toBeUndefined();
    expect(fxfilter.bounds).toBeUndefined();
    expect(fxfilter.label).toBe('Filter');
    expect(fxfilter.presets).toBe(FX_FILTER_PRESETS);
  });
});
