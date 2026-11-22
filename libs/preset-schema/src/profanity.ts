import { englishDataset, englishRecommendedTransformers, RegExpMatcher } from 'obscenity';

// words the English list takes for its own (it refuses a part of them) that a sound or an instrument is told with
const ALLOWED_WORDS = ['assort', 'assonan', 'cockpit', 'shiitake', 'fagott'];

const english = englishDataset.build();
const englishMatcher = new RegExpMatcher({
  ...english,
  whitelistedTerms: [...(english.whitelistedTerms ?? []), ...ALLOWED_WORDS],
  ...englishRecommendedTransformers,
});

const russianPatterns = [
  /(^|[^а-я])(на|по|за|от|вы|до|об|у|раз|рас|с|съ|из|при)?ху(й|е|я|и|ю)/,
  /пизд/,
  /(^|[^а-я])(на|по|за|от|вы|до|у|раз|рас|съ|из|при)?еб(а|у|л|н|и|ы|е|ч)/,
  /бля(д|т|ь|$|[^а-я])/,
  /(^|[^а-я])сук(а|и|е|у|ой|$|[^а-я])/,
  /муд(а|о)(к|з|ч)/,
  /залуп/,
  /пид(о|а)р/,
  /гандон|гондон/,
  /шлюх/,
];

const normalizeRussian = (value: string) =>
  value
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[a-z]/g, (char) => ({ a: 'а', e: 'е', o: 'о', p: 'р', c: 'с', y: 'у', x: 'х' })[char] ?? char)
    .replace(/[^а-я\s]/g, '');

export const isProfane = (name: string) =>
  englishMatcher.hasMatch(name) || russianPatterns.some((pattern) => pattern.test(normalizeRussian(name)));

// the marks around a word ("word," "(word)")
const EDGES = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

// the first word of a text the filter refuses (null: none, or only words together are refused)
export const profaneWord = (text: string) =>
  text
    .split(/\s+/)
    .map((word) => word.replace(EDGES, ''))
    .find((word) => word !== '' && isProfane(word)) ?? null;

// why a description can't be saved for its words (null: it can): the word told, so that one taken for another is
// rephrased
export const profaneDescription = (text: string) => {
  if (!isProfane(text)) return null;
  const word = profaneWord(text);
  return word ? `Please leave “${word}” out of the description` : 'Please choose another description';
};
