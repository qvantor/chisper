// The texts of the manual: a page per file, src/content/manual/<lang>/<page id>.mdx (MDX: the components of the
// manual in the text, components/manual/), its head in the frontmatter
import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';
import { PRESET_KEYS, type PresetKey } from './manual/open-preset';

const presets = PRESET_KEYS as [PresetKey, ...PresetKey[]];

const manual = defineCollection({
  loader: glob({ pattern: '*/*.mdx', base: './src/content/manual' }),
  schema: z.object({
    // <title>: the search the page answers
    title: z.string().min(20).max(70),
    // the heading of the page
    h1: z.string().min(10),
    // the description of search results (and of Open Graph)
    description: z.string().min(80).max(160),
    // its name in the nav, the breadcrumbs, the footer, prev/next
    nav: z.string().min(3).max(32),
    // the date of the last change of its facts (dateModified of its structured data)
    updated: z.coerce.date(),
    // the preset the page opens (Open in Chisper under its title): of a clip of the landing or of the manual's list
    preset: z.enum(presets),
    // the picture of the page in its structured data (a file of src/assets/manual without .png)
    image: z.string().optional(),
  }),
});

export const collections = { manual };
