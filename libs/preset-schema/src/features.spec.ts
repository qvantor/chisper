import { guessPresetInfo, presetFeatures } from './features';
import { normalizePreset } from './normalize';

const preset = (data: Record<string, unknown> = {}) => normalizePreset(data);

describe('presetFeatures', () => {
  it('finds nothing in Init', () => {
    expect(presetFeatures(preset())).toEqual([]);
  });

  it('finds Mono in Poly 1 and Glide in a portamento', () => {
    expect(presetFeatures(preset({ v: { max: 1 } }))).toEqual(['mono']);
    expect(presetFeatures(preset({ v: { max: 2, port: 0 } }))).toEqual([]);
    expect(presetFeatures(preset({ v: { port: 40 } }))).toEqual(['glide']);
    expect(presetFeatures(preset({ v: { max: 1, port: 40 } }))).toEqual(['mono', 'glide']);
  });

  it('finds Tempo-sync in an LFO in BPM that a route reads', () => {
    expect(presetFeatures(preset({ lfo: { l2: { bpm: true } } }))).toEqual([]);
    expect(presetFeatures(preset({ lfo: { l2: { bpm: true } }, mod: { 'lfo2:osc1.wave': 0.5 } }))).toEqual([
      'tempo-sync',
    ]);
    expect(presetFeatures(preset({ lfo: { l1: { bpm: true } }, mod: { 'lfo2:osc1.wave': 0.5 } }))).toEqual(
      []
    );
    // a route switched off or of no amount moves nothing
    expect(
      presetFeatures(preset({ lfo: { l2: { bpm: true } }, mod: { 'lfo2:osc1.wave': { a: 0.5, off: true } } }))
    ).toEqual([]);
    expect(presetFeatures(preset({ lfo: { l2: { bpm: true } }, mod: { 'lfo2:osc1.wave': 0 } }))).toEqual([]);
    expect(
      presetFeatures(
        preset({ lfo: { l3: { bpm: true } }, mod: { 'lfo3:filter.cutoff': { a: 0.2, bi: true } } })
      )
    ).toEqual(['tempo-sync']);
  });

  it('finds Tempo-sync in ENV 1 in BPM (it is the amplitude) and in an ENV 2 or 3 a route reads', () => {
    expect(presetFeatures(preset({ env: { e1: { bpm: true } } }))).toEqual(['tempo-sync']);
    expect(presetFeatures(preset({ env: { e2: { bpm: true } } }))).toEqual([]);
    expect(presetFeatures(preset({ env: { e2: { bpm: true } }, mod: { 'env2:osc1.wave': 0.5 } }))).toEqual([
      'tempo-sync',
    ]);
  });

  it('finds Tempo-sync in a delay or chorus in BPM that plays', () => {
    const fx = (effect: string, values: Record<string, unknown>) => preset({ fx: { [effect]: values } });
    expect(presetFeatures(fx('delay', { a: true, sync: 1 }))).toEqual(['tempo-sync']);
    expect(presetFeatures(fx('chorus', { a: true, sync: 1 }))).toEqual(['tempo-sync']);
    // out of the chain, bypassed, in MS
    expect(presetFeatures(fx('delay', { a: false, sync: 1 }))).toEqual([]);
    expect(presetFeatures(fx('delay', { a: true, on: false, sync: 1 }))).toEqual([]);
    expect(presetFeatures(fx('delay', { a: true, sync: 0 }))).toEqual([]);
  });
});

describe('guessPresetInfo', () => {
  const init = preset();

  it.each([
    ['Deep Sub Bass', 'bass', 'sub'],
    ['Reese Monster', 'bass', 'reese'],
    ['Acid 303 Line', 'bass', 'acid'],
    ['Pluck Bass', 'bass', 'pluck'],
    ['Trance Supersaw Lead', 'lead', 'supersaw'],
    ['Chip Lead', 'lead', 'chip'],
    ['Warm Pad', 'pad', 'warm'],
    ['Choir Pad', 'pad', 'choir'],
    ['Rhodes Keys', 'keys', 'e-piano'],
    ['Church Organ', 'keys', 'organ'],
    ['Glass Bell Pluck', 'pluck', 'bell-mallet'],
    ['Brass Stab', 'brass-chord', 'brass'],
    ['Chord Stab', 'brass-chord', 'chord'],
    ['Kick 909', 'drums', null],
  ])('guesses %p as %s / %s by its name', (name, category, subcategory) => {
    const guess = guessPresetInfo(name, init);
    expect(guess.category).toBe(category);
    expect(guess.subcategory).toBe(subcategory);
    expect(guess.reason).toContain(`name: ${category}`);
  });

  it.each([
    ['Coin Grab', 'game'],
    ['Level Up', 'game'],
    ['Notification Pop-up', 'ui-alert'],
    ['Spell Cast', 'magic'],
    ['Laser Blaster', 'sci-fi'],
    ['Trailer Hit', 'impact'],
    ['Sub Drop', 'impact'],
    ['Whoosh Up', 'transition'],
    ['Dun Dun Dun', 'stinger'],
    ['Helicopter', 'ambience'],
  ])('takes %p for an FX of %s', (name, subcategory) => {
    expect(guessPresetInfo(name, init)).toMatchObject({ category: 'fx', subcategory });
  });

  it('gives a known category its subcategory only', () => {
    expect(guessPresetInfo('Riser', init, 'fx')).toMatchObject({ category: 'fx', subcategory: 'transition' });
    expect(guessPresetInfo('Something', init, 'fx')).toMatchObject({ category: 'fx', subcategory: null });
    expect(guessPresetInfo('Something', init, 'fx').reason).toBe('');
  });

  it('guesses by the sound without a word: Poly 1 an octave down a bass, long a pad, no sustain a pluck', () => {
    expect(guessPresetInfo('Thing', preset({ v: { max: 1 }, osc1: { o: -1 } }))).toMatchObject({
      category: 'bass',
      reason: 'sound: bass',
    });
    expect(guessPresetInfo('Thing', preset({ v: { max: 1 } })).category).toBeNull();
    expect(guessPresetInfo('Thing', preset({ env: { e1: { attack: 0.8, release: 2 } } })).category).toBe(
      'pad'
    );
    expect(guessPresetInfo('Thing', preset({ env: { e1: { sustain: 0, decay: 0.3 } } })).category).toBe(
      'pluck'
    );
    expect(guessPresetInfo('Thing', init)).toEqual({
      category: null,
      subcategory: null,
      tags: [],
      reason: '',
    });
  });

  it('takes tags of the name, 3 at most', () => {
    expect(guessPresetInfo('Dark Warm Analog Pad', init).tags).toEqual(['dark', 'warm', 'analog']);
    expect(guessPresetInfo('Dark Bright Warm Clean Pad', init).tags).toHaveLength(3);
    expect(guessPresetInfo('Lo-Fi Keys', init).tags).toEqual(['lo-fi']);
  });
});
