import type { ImageMetadata } from 'astro';

// the pictures of the manual: src/assets/manual/<name>.png (scripts/site/screens.mjs shoots them from the synth)
const FILES = import.meta.glob<{ default: ImageMetadata }>('../assets/manual/*.png', { eager: true });

export const figureOf = (name: string) => {
  const file = FILES[`../assets/manual/${name}.png`];
  if (!file) throw new Error(`No picture ${name} of the manual: src/assets/manual/${name}.png (screens.mjs)`);
  return file.default;
};
