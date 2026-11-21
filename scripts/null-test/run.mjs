// the null test of the wasm cores: the scenes of the browser parity (scripts/wasm-browsers/scenes.mjs) rendered in
// Node by the cores of this tree (tmp/wasm) and by those of a reference (--against=<ref>: its worktree and cores as
// bench-perf makes them), the difference of the two against the signal, in dB: over the whole band, under 16 kHz and
// over it. A change of the DSP that is meant to keep the sound shows here how much of it it moved. A scene of a core
// the reference doesn't have (the chain: its effects were cores of their own before it), or of its chain with other
// kinds (an effect added: the ABI of the slots differs), is compared with the scene of the same name of the
// reference, rendered by its own scenes.mjs: its facades, its cores.
//   node scripts/null-test/run.mjs --against=main [--only=reverb] [--limit=-90]
// With --limit a scene whose difference is over it (dB) fails the run
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, root } from '../bench-common.mjs';
import { prepareReference } from '../bench-perf/reference.mjs';
import { hasCore, nodeRender, SCENES } from '../wasm-browsers/scenes.mjs';

const SIZE = 4096;
const SPLIT = 16000;

// the FFT of `size` complex values in place (radix 2)
const fft = (re, im) => {
  const size = re.length;
  for (let i = 1, j = 0; i < size; i++) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let length = 2; length <= size; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    for (let start = 0; start < size; start += length)
      for (let k = 0; k < length / 2; k++) {
        const [cos, sin] = [Math.cos(angle * k), Math.sin(angle * k)];
        const [a, b] = [start + k, start + k + length / 2];
        const [x, y] = [re[b] * cos - im[b] * sin, re[b] * sin + im[b] * cos];
        re[b] = re[a] - x;
        im[b] = im[a] - y;
        re[a] += x;
        im[a] += y;
      }
  }
};

// the power of a signal under and over SPLIT: Hann windows of SIZE, half overlapped
const bands = (signal, rate) => {
  const window = Float64Array.from(
    { length: SIZE },
    (_, n) => 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / SIZE)
  );
  const split = Math.round((SPLIT / rate) * SIZE);
  let [low, high] = [0, 0];
  for (let at = 0; at < signal.length; at += SIZE / 2) {
    const re = Float64Array.from({ length: SIZE }, (_, n) => (signal[at + n] ?? 0) * window[n]);
    const im = new Float64Array(SIZE);
    fft(re, im);
    for (let bin = 0; bin <= SIZE / 2; bin++) {
      const power = re[bin] ** 2 + im[bin] ** 2;
      if (bin < split) low += power;
      else high += power;
    }
  }
  return { low, high, all: low + high };
};

const db = (ratio) => (ratio > 0 ? 10 * Math.log10(ratio) : -Infinity);
const show = (value) => (Number.isFinite(value) ? value.toFixed(1).padStart(7) : '      –');

// the phases of the voices (Math.random of a scene) the same on both sides
const seeded = async (render) => {
  const random = Math.random;
  let seed = 12345;
  Math.random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  try {
    return await render();
  } finally {
    Math.random = random;
  }
};

const args = parseArgs(process.argv.slice(2));
if (!args.against) throw new Error('--against=<ref>: the commit to compare the cores with');
const limit = args.limit === undefined ? null : Number(args.limit);
const reference = await prepareReference(args.against, { build: false });
const theirs = path.relative(root, path.join(reference.dir, 'tmp/wasm'));
const scenes = SCENES.filter((scene) => !args.only || scene.name.includes(args.only));

// the kinds of the chain of a tree (FX_KINDS of its chain-params.ts): a chain of other kinds is another ABI
// (the params of its slots in the buffer of chain_new), its scenes of the chain are its own
const kindsOf = (dir) =>
  fs
    .readFileSync(path.join(dir, 'apps/chisper/src/app/synth/common/chain/chain-params.ts'), 'utf8')
    .match(/FX_KINDS = \[([^\]]*)\]/)?.[1]
    .split(',')
    .map((kind) => kind.trim().replace(/'/g, ''))
    .filter(Boolean) ?? [];
const sameChain = JSON.stringify(kindsOf(reference.dir)) === JSON.stringify(kindsOf(root));

// the scenes of the reference as it renders them itself (null: it has none)
let own;
const ownScenes = async () => {
  if (own !== undefined) return own;
  const file = path.join(reference.dir, 'scripts/wasm-browsers/scenes.mjs');
  const module = fs.existsSync(file) ? await import(pathToFileURL(file).href) : null;
  own = module?.nodeRender && module.SCENES ? module : null;
  return own;
};
// a scene by the cores of this tree and by those of the reference; of a core the reference doesn't have: its own
// scene of that name and of the same input, against ours without what it had not (`alone` of the scene); of its
// chain of other kinds: its own scene as it is (the limiter after both). null: nothing to compare with
const renders = async (scene) => {
  const chained = scene.module === 'chain' || scene.module === 'engine';
  const theirCore = scene.module && hasCore(scene.module, theirs);
  if (!scene.module || (theirCore && (sameChain || !chained)))
    return [await seeded(() => nodeRender(scene)), await seeded(() => nodeRender(scene, theirs))];
  const module = await ownScenes();
  const same = module?.SCENES.find(({ name, rate }) => name === scene.name && rate === scene.rate);
  if (!same || (same.module && !module.hasCore?.(same.module))) return null;
  const create = theirCore ? scene.create : (scene.alone ?? scene.create);
  const ours = await seeded(() => nodeRender({ ...scene, create }));
  const base = await seeded(() => module.nodeRender(same));
  // (the voices of a scene of the engine are its input: of the same scenes of the oscillator, seeded alike)
  const alike =
    !base.input ||
    base.input.every(
      (channel, c) =>
        channel.length === ours.input[c].length && channel.every((value, n) => value === ours.input[c][n])
    );
  return alike ? [ours, base] : null;
};

console.log(`the difference from ${reference.short}, dB under the signal (whole band, < 16 kHz, > 16 kHz)`);
let failed = false;
for (const scene of scenes) {
  const both = await renders(scene);
  if (!both) {
    console.log(
      `${' '.repeat(8)}no ${scene.module} core in ${reference.short}, no such scene  ${scene.name}`
    );
    continue;
  }
  const [ours, base] = both;
  const total = { signal: { low: 0, high: 0, all: 0 }, difference: { low: 0, high: 0, all: 0 } };
  let worst = 0;
  base.output.forEach((channel, c) => {
    const difference = Float64Array.from(channel, (value, n) => ours.output[c][n] - value);
    difference.forEach((value) => (worst = Math.max(worst, Math.abs(value))));
    const [signal, changed] = [bands(channel, scene.rate), bands(difference, scene.rate)];
    for (const band of ['low', 'high', 'all']) {
      total.signal[band] += signal[band];
      total.difference[band] += changed[band];
    }
  });
  const of = (band) => db(total.difference[band] / total.signal[band]);
  const over = limit !== null && of('all') > limit;
  failed ||= over;
  console.log(
    `${show(of('all'))} ${show(of('low'))} ${show(of('high'))}  max ${worst.toExponential(1)}  ${scene.name}${
      over ? `  (over ${limit} dB)` : ''
    }`
  );
}
if (failed) process.exitCode = 1;
