// Every clip of the promo page opens its preset on the site: GET /api/presets/:id answers it, under the name of
// its card; so does every preset the manual opens (apps/site/src/manual/presets.ts). Run it before a deploy and after
// presets are edited on the site (the names of the presets of the synth lost their prefixes "[AI] " and "FX " by
// scripts/presets/flags.mjs: run it after that):
//   node scripts/site/check-presets.mjs [--url=https://chisper.qvantor.org]
import { parseArgs } from '../bench-common.mjs';
import { DEMOS, MANUAL_PRESETS, SITE } from './common.mjs';

const args = parseArgs(process.argv.slice(2));
const URL_BASE = args.url ?? SITE;

const check = async ({ slug, presetId, name }) => {
  const response = await fetch(`${URL_BASE}/api/presets/${presetId}`);
  if (!response.ok) return `${slug}: ${presetId} answers ${response.status}`;
  const preset = await response.json();
  if (preset.name !== name) return `${slug}: the preset is "${preset.name}", the card says "${name}"`;
  return null;
};

const PRESETS = [...DEMOS, ...MANUAL_PRESETS];
const problems = (await Promise.all(PRESETS.map(check))).filter(Boolean);
for (const problem of problems) console.error(problem);
console.log(`${PRESETS.length - problems.length} of ${PRESETS.length} presets open as their cards say`);
process.exitCode = problems.length ? 1 : 0;
