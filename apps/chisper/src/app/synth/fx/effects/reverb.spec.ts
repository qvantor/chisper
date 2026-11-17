import { mapValues, omit } from 'lodash';
import { FX_PARAMS } from '@chisper/preset-schema';
import { CHAIN_KEYS, NEUTRAL_PARAMS } from '../../common/chain/chain-params';
import { reverb } from './reverb';
import { REVERB_ERAS } from './reverb-era';
import { REVERB_PRESETS } from './reverb-presets';

const DEFAULTS = mapValues(FX_PARAMS.reverb, (param) => param.default);
const [NOW, EIGHTIES, SEVENTIES] = REVERB_ERAS;
const RATE = 48000;

describe('reverb', () => {
  it('a knob for every param of the schema with its range, the era a switch over the eras', () => {
    const { params } = reverb;
    expect(Object.keys(params).sort()).toEqual(Object.keys(FX_PARAMS.reverb).sort());
    (Object.keys(FX_PARAMS.reverb) as (keyof typeof FX_PARAMS.reverb)[]).forEach((key) =>
      expect(params[key]).toMatchObject(FX_PARAMS.reverb[key])
    );
    expect(params.era.options).toBe(REVERB_ERAS);
    // only the era is a switch: the others are targets of the routes
    Object.keys(omit(params, 'era')).forEach((key) =>
      expect(params[key as keyof typeof params].options).toBeUndefined()
    );
    // a route is `<source>:<effect>.<param>`: lower case letters and digits
    Object.keys(params).forEach((key) => expect(key).toMatch(/^[a-z][a-z0-9]*$/));
    expect(reverb.label).toBe('Reverb');
    expect(reverb.presets).toBe(REVERB_PRESETS);
  });

  it('the laws of its knobs: Hz, ms and seconds, shares in percent, the levels on faders', () => {
    const { params } = reverb;
    expect(params.lowcut.mode).toBe('log');
    expect(params.lowcut.formatValue?.(80)).toBe('80Hz');
    expect(params.pre.formatValue?.(0.02)).toBe('20ms');
    expect(params.size.formatValue?.(0.5)).toBe('50%');
    expect(params.decay.mode).toBe('log');
    expect(params.decay.formatValue?.(0.6)).toBe('600ms');
    expect(params.decay.formatValue?.(2)).toBe('2.0s');
    expect(params.damp.formatValue?.(6000)).toBe('6.0kHz');
    expect(params.bass.formatValue?.(1.5)).toBe('×1.50');
    (['depth', 'sep', 'er'] as const).forEach((key) => {
      expect(params[key].control).toBe('fader');
      expect(params[key].formatValue?.(0.2)).toBe('20%');
    });
    // the stereo width fills from its natural 100%
    expect(params.sep.fillFrom).toBe(1);
  });

  it('the core takes its knobs as they are, the era as the values of its input stage (80s by default)', () => {
    expect(reverb.core(DEFAULTS, 120, RATE)).toEqual({
      ...omit(DEFAULTS, 'era'),
      drive: EIGHTIES.drive,
      bandwidth: EIGHTIES.bandwidth,
      body: EIGHTIES.body,
    });
    expect(reverb.core({ ...DEFAULTS, era: 2 }, 120, RATE)).toMatchObject({
      drive: SEVENTIES.drive,
      bandwidth: SEVENTIES.bandwidth,
      body: SEVENTIES.body,
    });
    // the era itself is not a param of the core
    expect(reverb.core(DEFAULTS, 120, RATE)).not.toHaveProperty('era');
  });

  it('the full band of the now era is nyquist at the rate of the context', () => {
    expect(NOW.bandwidth).toBeNull();
    expect(reverb.core({ ...DEFAULTS, era: 0 }, 120, 44100)).toMatchObject({
      drive: 0,
      bandwidth: 22050,
      body: 0,
    });
    expect(reverb.core({ ...DEFAULTS, era: 0 }, 120, 96000)['bandwidth']).toBe(48000);
    // an era of the 80s is band limited the same at every rate
    expect(reverb.core({ ...DEFAULTS, era: 1 }, 120, 96000)['bandwidth']).toBe(EIGHTIES.bandwidth);
  });

  it('an era out of the list or between two is the nearest one', () => {
    expect(reverb.core({ ...DEFAULTS, era: 7 }, 120, RATE)['bandwidth']).toBe(SEVENTIES.bandwidth);
    expect(reverb.core({ ...DEFAULTS, era: -1 }, 120, RATE)['bandwidth']).toBe(RATE / 2);
    expect(reverb.core({ ...DEFAULTS, era: 1.4 }, 120, RATE)['bandwidth']).toBe(EIGHTIES.bandwidth);
  });

  it('falsy knobs reach the core, the tempo changes nothing', () => {
    const params = { ...DEFAULTS, pre: 0, size: 0, depth: 0, sep: 0, er: 0 };
    expect(reverb.core(params, 120, RATE)).toMatchObject({ pre: 0, size: 0, depth: 0, sep: 0, er: 0 });
    expect(reverb.core(params, 60, RATE)).toEqual(reverb.core(params, 120, RATE));
  });

  it('gives the core every param of its kind and no other, the defaults those a chain starts with', () => {
    REVERB_PRESETS.forEach(({ params }) =>
      expect(Object.keys(reverb.core(params, 120, RATE)).sort()).toEqual([...CHAIN_KEYS.reverb].sort())
    );
    expect(reverb.core(DEFAULTS, 120, RATE)).toEqual(NEUTRAL_PARAMS.reverb);
  });

  it('follows no tempo, its routes are within its knobs, it has no meter', () => {
    expect(reverb.paramChange).toBeUndefined();
    expect(reverb.bounds).toBeUndefined();
    expect(reverb.metered).toBeUndefined();
  });
});
