import { FX_FILTER_TYPES } from '../fx/effects/fxfilter-params';
import { filterTypeBrowser, typeInCategory } from './filter-types';

describe('filterTypeBrowser', () => {
  it('gives the categories that have any of the types offered, their types in the order of ◀ ▶', () => {
    const { categories, options } = filterTypeBrowser(FX_FILTER_TYPES);
    expect(categories.map(({ value, label, types }) => [value, label, types])).toEqual([
      [
        'low-pass',
        'Low Pass',
        ['ladder6', 'ladder12', 'ladder18', 'ladder24', 'low6', 'low12', 'low18', 'low24'],
      ],
      ['high-pass', 'High Pass', ['high6', 'high12', 'high18', 'high24']],
      ['band-pass', 'Band Pass', ['band12', 'band24']],
      ['notch-peak', 'Notch & Peak', ['notch12', 'notch24', 'peak12', 'peak24']],
    ]);
    expect(options.map(({ value }) => value)).toEqual(categories.map(({ value }) => value));
    // (all of a voice: the EQ ones too)
    expect(filterTypeBrowser().categories.map(({ value }) => value)).toEqual([
      'low-pass',
      'high-pass',
      'band-pass',
      'notch-peak',
      'eq',
    ]);
  });
});

describe('typeInCategory', () => {
  const high = ['high6', 'high12', 'high18', 'high24'] as const;
  const band = ['band12', 'band24'] as const;

  it('the first of the slope of the type now', () => {
    expect(typeInCategory(['ladder6', 'ladder12', 'low12'], 'high12')).toBe('ladder12');
    expect(typeInCategory([...high], 'notch24')).toBe('high24');
  });

  it('else its first: no type of that slope, a type of no slope', () => {
    expect(typeInCategory([...band], 'ladder6')).toBe('band12');
    expect(typeInCategory(['lowshelf', 'loweq6'], 'lowpass')).toBe('lowshelf');
  });
});
