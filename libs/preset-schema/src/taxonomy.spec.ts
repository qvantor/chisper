import { presetFilterQuerySchema, listPresetsQuerySchema, type PresetListItem } from './schema';
import {
  CATEGORY_SLUGS,
  categoryPath,
  DESCRIPTION_LINK_MESSAGE,
  EMPTY_PRESET_INFO,
  fitsCategory,
  isFiltered,
  isSubcategoryOf,
  matchesPresetFilter,
  PRESET_CATEGORIES,
  PRESET_FEATURES,
  PRESET_TAGS,
  presetFilterParams,
  presetInfoSchema,
  sortFeatures,
  TAG_SLUGS,
  tagLabel,
  tagsMatching,
} from './taxonomy';

describe('the closed lists', () => {
  // slugs live in the database and the links: they only grow, never renamed
  it('keeps the slugs of the categories, their subcategories and the tags', () => {
    expect(
      PRESET_CATEGORIES.map(({ slug, subcategories }) => [slug, subcategories.map((sub) => sub.slug)])
    ).toEqual([
      ['bass', ['sub', 'reese', 'growl-wobble', 'acid', 'pluck', 'analog']],
      ['lead', ['supersaw', 'sync', 'analog', 'soft', 'chip']],
      ['pad', ['warm', 'strings', 'choir', 'evolving', 'dark', 'atmosphere']],
      ['keys', ['piano', 'e-piano', 'organ', 'clav']],
      ['pluck', ['pluck', 'bell-mallet', 'string']],
      ['brass-chord', ['brass', 'chord', 'stab']],
      ['drums', []],
      ['fx', ['game', 'ui-alert', 'magic', 'sci-fi', 'impact', 'transition', 'stinger', 'ambience']],
    ]);
    expect(TAG_SLUGS).toEqual([
      'dark',
      'bright',
      'warm',
      'clean',
      'dirty',
      'aggressive',
      'soft',
      'wide',
      'evolving',
      'lo-fi',
      'analog',
      'digital',
      'metallic',
    ]);
    expect(PRESET_FEATURES).toEqual(['clip', 'ai', 'tempo-sync', 'mono', 'glide']);
  });

  it('gives every tag a hint and its label', () => {
    PRESET_TAGS.forEach(({ label, hint }) => {
      expect(label).not.toBe('');
      expect(hint).not.toBe('');
    });
  });

  it('knows a subcategory within its category only', () => {
    expect(isSubcategoryOf('bass', 'pluck')).toBe(true);
    expect(isSubcategoryOf('pluck', 'pluck')).toBe(true);
    expect(isSubcategoryOf('pad', 'sub')).toBe(false);
    expect(isSubcategoryOf('drums', 'kick')).toBe(false);
    expect(isSubcategoryOf('noise', 'sub')).toBe(false);
  });

  it('takes none or a subcategory of its category: the info of a preset and a filter alike', () => {
    expect(fitsCategory(null, null)).toBe(true);
    expect(fitsCategory(undefined, undefined)).toBe(true);
    expect(fitsCategory('bass', null)).toBe(true);
    expect(fitsCategory('bass', 'sub')).toBe(true);
    expect(fitsCategory('pad', 'sub')).toBe(false);
    expect(fitsCategory(null, 'sub')).toBe(false);
    expect(fitsCategory(undefined, 'sub')).toBe(false);
  });

  it('names a category with its subcategory, a tag by its label (an unknown slug as it is)', () => {
    expect(categoryPath('fx', 'game')).toBe('FX › Game');
    expect(categoryPath('brass-chord', null)).toBe('Brass & Chord');
    expect(categoryPath('pad')).toBe('Pad');
    expect(tagLabel('lo-fi')).toBe('Lo-fi');
    expect(tagLabel('shiny')).toBe('shiny');
  });

  it('sorts features in the order of the icons', () => {
    expect(sortFeatures(['glide', 'clip', 'mono', 'ai'])).toEqual(['clip', 'ai', 'mono', 'glide']);
  });
});

describe('presetInfoSchema', () => {
  const parse = (info: unknown) => presetInfoSchema.safeParse(info);

  it('takes an empty info: no category, no subcategory, no description, no tags', () => {
    expect(parse({}).data).toEqual(EMPTY_PRESET_INFO);
    expect(parse({ category: null, subcategory: null, description: null, tags: [] }).data).toEqual(
      EMPTY_PRESET_INFO
    );
  });

  it('keeps a category, a subcategory of it, a description and up to 3 tags in the order of the list', () => {
    expect(
      parse({ category: 'fx', subcategory: 'game', description: 'Coins', tags: ['wide', 'bright', 'wide'] })
        .data
    ).toEqual({ category: 'fx', subcategory: 'game', description: 'Coins', tags: ['bright', 'wide'] });
  });

  it('makes a description one line, trimmed; a blank one none', () => {
    expect(parse({ description: '  A warm\n\n pad\t ' }).data?.description).toBe('A warm pad');
    expect(parse({ description: '   ' }).data?.description).toBeNull();
    expect(parse({ description: 'x'.repeat(280) }).success).toBe(true);
    expect(parse({ description: ` ${'x'.repeat(280)} ` }).success).toBe(true);
  });

  it.each([
    ['an unknown category', { category: 'noise' }],
    ['a subcategory without a category', { subcategory: 'sub' }],
    ['a subcategory of another category', { category: 'pad', subcategory: 'sub' }],
    ['an unknown tag', { tags: ['loud'] }],
    ['four tags', { tags: ['dark', 'warm', 'soft', 'wide'] }],
    ['a description of 281 characters', { description: 'x'.repeat(281) }],
  ])('refuses %s', (_, info) => {
    expect(parse(info).success).toBe(false);
  });

  it.each([
    'see https://x.io',
    'http://a',
    'at www.example',
    'mysite.com',
    'go to t.me/abc',
    'Spam.NET now',
    'my-site.club for more',
    'Write me: spam.me',
    'SPAM.DE!',
    'spam.es/presets now',
  ])('refuses a link in a description: %p', (description) => {
    const parsed = parse({ description });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map(({ message }) => message)).toContain(DESCRIPTION_LINK_MESSAGE);
  });

  it.each([
    'A pad for 3.5 minutes',
    'Lo-fi, warm. Then bright.',
    'e.g. a bass',
    // a sentence after a dot without a space
    'Fat bass.So good',
    'Warm pad.Be gentle',
    'Mallet.Es klingt weich',
    'Play it slow.to the end',
    'Un pad cálido.es perfecto',
    'Wide.me likes it',
  ])('takes a description with dots that are no link: %p', (description) => {
    expect(parse({ description }).success).toBe(true);
  });
});

describe('the filters', () => {
  const item: PresetListItem = {
    id: 'a',
    name: 'Coin Grab',
    uniqueUsers: 0,
    category: 'fx',
    subcategory: 'game',
    description: 'A bright pickup',
    tags: ['bright', 'digital'],
    features: ['clip', 'ai'],
    factory: true,
  };

  it('matches an item as the server filters', () => {
    expect(matchesPresetFilter(item, {})).toBe(true);
    expect(matchesPresetFilter(item, { category: 'fx', subcategory: 'game' })).toBe(true);
    expect(matchesPresetFilter(item, { category: 'bass' })).toBe(false);
    expect(matchesPresetFilter(item, { category: 'fx', subcategory: 'magic' })).toBe(false);
    expect(matchesPresetFilter(item, { tags: ['bright', 'digital'] })).toBe(true);
    expect(matchesPresetFilter(item, { tags: ['bright', 'dark'] })).toBe(false);
    expect(matchesPresetFilter(item, { features: ['clip'] })).toBe(true);
    expect(matchesPresetFilter(item, { features: ['clip', 'mono'] })).toBe(false);
    expect(matchesPresetFilter(item, { origin: 'factory' })).toBe(true);
    expect(matchesPresetFilter(item, { origin: 'community' })).toBe(false);
  });

  it('finds a search in the name, the description or the label of a tag, in any case', () => {
    expect(matchesPresetFilter(item, { q: 'coin' })).toBe(true);
    expect(matchesPresetFilter(item, { q: 'PICKUP' })).toBe(true);
    expect(matchesPresetFilter(item, { q: 'digi' })).toBe(true);
    expect(matchesPresetFilter(item, { q: 'laser' })).toBe(false);
    expect(matchesPresetFilter({ ...item, description: null }, { q: 'pickup' })).toBe(false);
    expect(matchesPresetFilter(item, { q: '  ' })).toBe(true);
  });

  it('finds the tags of a search by their labels', () => {
    expect(tagsMatching('lo-f')).toEqual(['lo-fi']);
    expect(tagsMatching('AR')).toEqual(['dark', 'warm']);
    expect(tagsMatching(' ')).toEqual([]);
  });

  it('tells a filter from none', () => {
    expect(isFiltered({})).toBe(false);
    expect(isFiltered({ tags: [], features: [], q: '' })).toBe(false);
    expect(isFiltered({ category: 'fx' })).toBe(true);
    expect(isFiltered({ tags: ['dark'] })).toBe(true);
    expect(isFiltered({ origin: 'community' })).toBe(true);
  });

  it('writes a filter as the query the server reads', () => {
    const filter = {
      category: 'bass' as const,
      subcategory: 'sub',
      tags: ['dark' as const, 'warm' as const],
      features: ['mono' as const],
      origin: 'factory' as const,
      q: 'deep',
    };
    const params = presetFilterParams(filter);
    expect(params.toString()).toBe(
      'category=bass&subcategory=sub&tags=dark%2Cwarm&features=mono&origin=factory&q=deep'
    );
    const read = presetFilterQuerySchema.parse(Object.fromEntries(params));
    expect(read).toEqual(filter);
    // no subcategory without its category
    expect(presetFilterParams({ subcategory: 'sub' }).toString()).toBe('');
  });

  it('reads a list query: its filter, its sort, its ids', () => {
    expect(listPresetsQuerySchema.parse({})).toEqual({ sort: 'new' });
    const id = '00000000-0000-4000-8000-000000000001';
    expect(listPresetsQuerySchema.parse({ ids: `${id},,${id}`, category: 'pad', sort: 'name' })).toEqual({
      ids: [id, id],
      category: 'pad',
      sort: 'name',
    });
    expect(listPresetsQuerySchema.safeParse({ ids: 'x' }).success).toBe(false);
    expect(listPresetsQuerySchema.safeParse({ subcategory: 'sub' }).success).toBe(false);
    expect(CATEGORY_SLUGS).toContain('fx');
  });
});
