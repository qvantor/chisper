import type { PresetData } from './schema';
import {
  type DataFeature,
  isSubcategoryOf,
  type PresetCategory,
  type PresetTag,
  PRESET_TAGS_MAX,
} from './taxonomy';

// a route that moves its knob: not switched off, an amount
const moves = (value: PresetData['mod'][string]) =>
  typeof value === 'number' ? value !== 0 : !value.off && value.a !== 0;

// the sources the routes of a preset read
const sourcesRead = (data: PresetData) =>
  new Set(
    Object.entries(data.mod)
      .filter(([, value]) => moves(value))
      .map(([key]) => key.slice(0, key.indexOf(':')))
  );

// what a preset does, out of its data (a preset as normalizePreset gives it): Mono (Poly 1), Glide (a portamento),
// Tempo-sync (an LFO a route reads, an envelope that sounds — ENV 1 always, the amplitude — or a delay or chorus
// that plays, in BPM). The server works them out as a preset is saved, scripts/presets/categorize.mjs for the
// presets saved before
export const presetFeatures = (data: PresetData): DataFeature[] => {
  const read = sourcesRead(data);
  const lfos = ([1, 2, 3, 4] as const).some((n) => data.lfo[`l${n}`].bpm && read.has(`lfo${n}`));
  const envs = ([1, 2, 3] as const).some((n) => data.env[`e${n}`].bpm && (n === 1 || read.has(`env${n}`)));
  const fx = [data.fx.delay, data.fx.chorus].some((effect) => effect.a && effect.on && effect.sync === 1);
  // (in the order of PRESET_FEATURES)
  const features: DataFeature[] = [];
  if (lfos || envs || fx) features.push('tempo-sync');
  if (data.v.max === 1) features.push('mono');
  if (data.v.port > 0) features.push('glide');
  return features;
};

// a name that says it is an FX ("FX Coin Grab", "[AI] FX …": the factory presets were named so)
const FX_NAME = /^(\[[^\]]*\]\s*)?s?fx\b/;

// words of a name that tell its category (a Pluck Bass is a bass, a Bell Pad a pad); BS, LD, PD, PL: the prefixes
// of the presets of some synths
const CATEGORY_WORDS: [PresetCategory, RegExp][] = [
  ['drums', /\b(kick|snare|hi-?hats?|hats?|drums?|perc|percussion|clap|toms?|cymbal)\b/],
  ['bass', /\b(bass|basses|reese|wobble|growl|303|bs)\b/],
  ['lead', /\b(lead|supersaw|super saw|ld|theremin)\b/],
  ['pad', /\b(pad|pads|choir|atmo|atmosphere|strings|pd)\b/],
  ['keys', /\b(keys|piano|e-?piano|rhodes|wurli|organ|clav|clavinet)\b/],
  ['brass-chord', /\b(brass|horns?|trumpet|chords?|stabs?)\b/],
  ['pluck', /\b(pluck\w*|bells?|mallet|marimba|kalimba|harp|vibes|guitar|music box|pl)\b/],
];

// the subcategories by words, within a category
const SUBCATEGORY_WORDS: Record<PresetCategory, [string, RegExp][]> = {
  bass: [
    ['sub', /\bsub\b/],
    ['reese', /\breese\b/],
    ['growl-wobble', /\b(growl|wobble|wub)/],
    ['acid', /\b(acid|303)\b/],
    ['pluck', /\bpluck/],
    ['analog', /\b(analog|moog|mini)\b/],
  ],
  lead: [
    ['supersaw', /\b(supersaw|super saw|trance)\b/],
    ['sync', /\bsync\b/],
    ['chip', /\b(chip|8-?bit|nes|gameboy)\b/],
    ['soft', /\b(soft|flute|whistle)\b/],
    ['analog', /\b(analog|moog)\b/],
  ],
  pad: [
    ['strings', /\bstrings?\b/],
    ['choir', /\b(choir|vox|voices?|aah|ooh)\b/],
    ['evolving', /\b(evolv\w*|motion|morph\w*|shifting)\b/],
    ['atmosphere', /\b(atmo\w*|ambient|air|space)\b/],
    ['dark', /\bdark\b/],
    ['warm', /\bwarm\b/],
  ],
  keys: [
    ['e-piano', /\b(e-?piano|rhodes|wurli|ep)\b/],
    ['piano', /\bpiano\b/],
    ['organ', /\borgan\b/],
    ['clav', /\bclav/],
  ],
  pluck: [
    ['bell-mallet', /\b(bell\w*|mallet|marimba|vibes|kalimba|glock\w*|chimes?|music box)\b/],
    ['string', /\b(harp|guitar|koto|pizz\w*|strings?)\b/],
    ['pluck', /\bpluck\w*/],
  ],
  'brass-chord': [
    ['brass', /\b(brass|horns?|trumpet)\b/],
    ['chord', /\bchords?\b/],
    ['stab', /\bstabs?\b/],
  ],
  drums: [],
  // the first that matches wins: a Piano Sting is a stinger, a Glitch Transition a transition
  fx: [
    ['stinger', /\b(fanfare|dun dun|horror|stinger|sting|dramatic|reveal)\b/],
    [
      'game',
      /\b(8-?bit|coin|level up|quest|power ?up|jump|arcade|retro game|achievement|heal|restore|bonus|item|jackpot|win|secret|stage clear|xp|stars|ka-ching|purchase)\b/,
    ],
    [
      'ui-alert',
      /\b(notification|notify|click|hover|pop-?up|pop|toggle|chimes?|alert|ui|beep|ding|button|bubble|ring|message|panel|slide|ticks|success|complete)\b/,
    ],
    [
      'magic',
      /\b(spell|portal|sparkle|teleport|magic\w*|fairy|shimmer|enchant\w*|potion|transformation|bowl)\b/,
    ],
    [
      'transition',
      /\b(whoosh|swoosh|swish|riser|rising|downlifter|downer|reverse|sweep|uplifter|transition|tape stop|vinyl stop)\b/,
    ],
    ['impact', /\b(boom|explosion|slam|trailer hit|sub drop|impact|hit|crash|thud|braam)\b/],
    [
      'sci-fi',
      /\b(laser|blaster|railgun|zap|ufo|sci-?fi|robot|alien|glitch\w*|malfunction|data|computer|modem|crt|hacking|emp|cannon|weapon|gun|electric\w*|shock|sparks|energy|charge|overcharge|power|arc|lightning|tesla|static|tv|radio|signal|sonar|taser|buzz|circuit)\b/,
    ],
    ['ambience', /\b(wind|helicopter|ambience|rain|ocean|drone)\b/],
  ],
};

// the categories a name tells, the first that matches wins: one named an FX, then the words of a category, then
// those of a kind of FX
const NAME_RULES: [PresetCategory, (words: string) => boolean][] = [
  ['fx', (words) => FX_NAME.test(words)],
  ...CATEGORY_WORDS.map(([category, pattern]): [PresetCategory, (words: string) => boolean] => [
    category,
    (words) => pattern.test(words),
  ]),
  ['fx', (words) => SUBCATEGORY_WORDS.fx.some(([, pattern]) => pattern.test(words))],
];

const TAG_WORDS: [PresetTag, RegExp][] = [
  ['dark', /\bdark/],
  ['bright', /\bbright/],
  ['warm', /\bwarm/],
  ['clean', /\bclean/],
  ['dirty', /\b(dirty|distort\w*|grit\w*|fuzz)\b/],
  ['aggressive', /\b(aggressive|angry|hard|brutal)\b/],
  ['soft', /\b(soft|gentle|mellow)\b/],
  ['wide', /\b(wide|supersaw|super saw)\b/],
  ['evolving', /\b(evolv\w*|morph\w*)\b/],
  ['lo-fi', /\b(lo-?fi|tape|vinyl|cassette)\b/],
  ['analog', /\banalog/],
  ['digital', /\b(digital|fm|glass\w*)\b/],
  ['metallic', /\b(metal\w*|bells?)\b/],
];

export interface PresetInfoGuess {
  category: PresetCategory | null;
  subcategory: string | null;
  tags: PresetTag[];
  // why (a column of the sheet of scripts/presets/categorize.mjs)
  reason: string;
}

// the octave the oscillators that play are at, the lowest
const lowestOctave = (data: PresetData) =>
  Math.min(...[data.osc1, data.osc2].filter((osc) => osc.a).map((osc) => osc.o), Infinity);

// what a preset is by its sound: Poly 1 an octave down a bass, a long attack and release of ENV 1 a pad, no sustain
// and a short decay a pluck
const categoryByData = (data: PresetData): PresetCategory | null => {
  const { attack, decay, sustain, release } = data.env.e1;
  if (data.v.max === 1 && lowestOctave(data) <= -1) return 'bass';
  if (attack >= 0.3 && release >= 1) return 'pad';
  if (sustain === 0 && decay <= 0.6) return 'pluck';
  return null;
};

// a guess of what a preset is: by the words of its name, then (no category in it) by its sound; of a known category
// (an FX of a factory preset) only its subcategory. The Save dialog offers it, categorize.mjs writes it into a sheet
export const guessPresetInfo = (
  name: string,
  data: PresetData,
  known: PresetCategory | null = null
): PresetInfoGuess => {
  const words = name.toLowerCase();
  const reasons: string[] = [];
  let category = known;
  if (category === null) {
    category = NAME_RULES.find(([, matches]) => matches(words))?.[0] ?? null;
    if (category !== null) reasons.push(`name: ${category}`);
  }
  if (category === null) {
    category = categoryByData(data);
    if (category !== null) reasons.push(`sound: ${category}`);
  }
  const subcategory =
    category === null
      ? null
      : (SUBCATEGORY_WORDS[category].find(
          ([slug, pattern]) => isSubcategoryOf(category, slug) && pattern.test(words)
        )?.[0] ?? null);
  if (subcategory !== null) reasons.push(`name: ${subcategory}`);
  const tags = TAG_WORDS.filter(([, pattern]) => pattern.test(words))
    .map(([tag]) => tag)
    .slice(0, PRESET_TAGS_MAX);
  if (tags.length) reasons.push(`name: ${tags.join(' ')}`);
  return { category, subcategory, tags, reason: reasons.join('; ') };
};
