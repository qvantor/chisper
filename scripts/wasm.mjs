// `npm run wasm`: the Rust cores of the worklets (dsp/) into tmp/wasm/<name>.wasm, and with the counters of the
// perf build (the cargo feature `perf`, as __PERF__) into tmp/wasm-perf/<name>.wasm (`build:perf` and the specs).
// cargo builds them (dsp/rust-toolchain.toml: the toolchain and wasm32-unknown-unknown), wasm-opt -O3 of binaryen
// (a devDependency) shrinks them, never with fast-math: the bits stay those of the TS cores.
// --only=prod builds tmp/wasm alone (build, client:start), --only=perf tmp/wasm-perf alone (build:perf, the specs);
// --sizes prints their gzip sizes, --check-sizes fails over the budget of a module (CI), --watch builds them
// again on every change of dsp/ (client:start)
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, watch } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';

const DSP = 'dsp';
const OUT = 'tmp/wasm';
const OUT_PERF = 'tmp/wasm-perf';
// the cores: crate, its bundle (the worklet bundle of the same name embeds it), the gzip budget (bytes, about 10%
// over the size of the port: dlmalloc, the tables of jsmath and the fmt the panic sites still reference are ~12 KB)
const CORES = [
  // the one core of the one node: the voices and the store of their tables (the crate wavetable-osc) into the chain
  // (the effects, their slots and their modulation, the delay, the master and the limiter). The runtime once,
  // where the two modules had it twice: 167.2 KB, they were 74.0 and 110.1; 178.2 KB with the spans of the filter of
  // a voice as lines (their coefficients a step on at every refresh in each of its loops, the lines taken); 182.5 KB
  // with the loops of a filter at rest apart from those of its lines (in one, a chord at rest was 3 % slower);
  // 187.0 KB with the EQ (a sixth slot, its unit and the lines of its bands); 192.5 KB with the warp of the
  // oscillators (the pass of the phases of a span through its map, a read loop a shape on them); 193.5 KB with its
  // knob through a one-pole and the edge of PWM a line (a pass of its own); 196.4 KB with the levels of a bend of
  // a < 0 sample by sample (the pass of its phases and of their shares of two levels, the loop of a span of them);
  // 198.3 KB with the warped mix of a still voice of such a bend (its cycle built once that way, read as a mix);
  // 199.8 KB with the loop of the voices of a warp apart from the one of no warp (render_voices_warped); 200.4 KB
  // with the passes of a warped mix over half its cycle, the rest their mirror (render_warped_cycle); 203.0 KB with
  // the cycle of a warped mix kept for the voices of a unison (its fill, the pass of the levels of its slopes, the
  // shares of a pitch and the mix of them: fill_warped_cycle, apply_warped_cycle); 203.1 KB with a build of a cycle
  // kept at its own cost in the budget (what a mix is built of worked out before the budget is asked: warped_plan);
  // 203.4 KB with a fade cut with its segment where the levels jump (render_cuts_warped); 204.3 KB with a table
  // under a still map read in one loop (render11_mapped: a voice held on PWM 6 % faster, on Bend + 2 %); 206.3 KB with
  // the macros of the node as sources of the routes of the voices and of the chain (Macros, the levels that wait
  // for their frames: Shared::set_macros, render_macros; the levels of the chain at the points: level_at)
  { crate: 'engine', name: 'engine', budget: 206600 },
  // jsmath exported to the specs (not bundled)
  { crate: 'jsmath-check', name: 'jsmath-check', budget: null },
];

const args = process.argv.slice(2);
const require = createRequire(import.meta.url);
const wasmOpt = join(dirname(require.resolve('binaryen/package.json')), 'bin', 'wasm-opt');

const run = (command, commandArgs, options = {}) => {
  const { status, error } = spawnSync(command, commandArgs, { stdio: 'inherit', ...options });
  if (error)
    throw new Error(`${command}: ${error.message}${error.code === 'ENOENT' ? ' (is it installed?)' : ''}`);
  if (status !== 0) throw new Error(`${command} ${commandArgs.join(' ')} failed (${status})`);
};

const artifact = (targetDir, crate) =>
  join(DSP, targetDir, 'wasm32-unknown-unknown', 'release', `${crate.replace(/-/g, '_')}.wasm`);

const cargo = (perf) => {
  const packages = CORES.flatMap(({ crate }) => ['-p', crate]);
  const features = perf
    ? [
        '--features',
        CORES.filter((c) => c.budget)
          .map((c) => `${c.crate}/perf`)
          .join(','),
      ]
    : [];
  const targetDir = perf ? 'target/perf' : 'target';
  run(
    'cargo',
    [
      'build',
      '--release',
      '--target',
      'wasm32-unknown-unknown',
      '--target-dir',
      targetDir,
      ...packages,
      ...features,
    ],
    // in dsp/: rustup reads the toolchain of dsp/rust-toolchain.toml from the working directory
    { cwd: DSP }
  );
  return targetDir;
};

// the functions of a core -O3 doesn't inline (patterns of their names in the build of cargo): the render of each
// source of a voice (the noise, the sub) stays a function of its own (inlined into Voice::process, its one caller, its loops would share
// the registers of everything else the voice does in a block); so do the spans of the filter of a voice alone
// (inlined into run_alone, next to the design of a span: a third slower); so do the pass of a warped voice and its
// reads of a span (render_voices calls them where a voice is warped alone: inlined, each of its callers had a copy),
// the levels of a bend sample by sample too, and the loop of the voices of a warp (render_voices_warped: inlined into
// render_voices, the voices of no warp were 3 to 7 % slower)
const NO_INLINE = {
  engine: [
    '*Noise11render_into*',
    '*Sub11render_into*',
    '*filter10model_span*',
    '*filter10model_line*',
    '*filter16model_line_plain*',
    '*warp11warp_phases*',
    '*voice12segment_warp*',
    '*voice18render_span_warped*',
    '*voice18render_fade_warped*',
    '*warp12local_phases*',
    '*voice19render_local_warped*',
    '*voice20render_voices_warped*',
    '*voice19render_table_mapped*',
    '*voice19render_jumps_warped*',
  ],
};

const optimize = (from, to, crate) => {
  // the features of the module from its target_features section; -O3, no --fast-math
  const kept = (NO_INLINE[crate] ?? []).map((pattern) => `--no-inline=${pattern}`);
  run(wasmOpt, [from, ...kept, '-O3', '--detect-features', '-o', to]);
};

const only = args.find((arg) => arg.startsWith('--only='))?.slice('--only='.length);
const VARIANTS = [
  [false, OUT],
  [true, OUT_PERF],
].filter(([perf]) => !only || only === (perf ? 'perf' : 'prod'));

const build = () => {
  const started = Date.now();
  for (const [perf, out] of VARIANTS) {
    const targetDir = cargo(perf);
    mkdirSync(out, { recursive: true });
    for (const { crate, name } of CORES) {
      const from = artifact(targetDir, crate);
      if (crate === 'jsmath-check') copyFileSync(from, join(out, `${name}.wasm`));
      else optimize(from, join(out, `${name}.wasm`), crate);
    }
    // a core that is no more (one a crate of CORES took in) is not left for a spec or a bench to load in its place
    for (const file of readdirSync(out)) {
      if (file.endsWith('.wasm') && !CORES.some(({ name }) => file === `${name}.wasm`))
        rmSync(join(out, file));
    }
  }
  const into = VARIANTS.map(([, out]) => out).join(' and ');
  console.log(`wasm: ${CORES.length} cores into ${into} in ${Date.now() - started} ms`);
};

const sizes = (check) => {
  let over = false;
  for (const { name, budget } of CORES) {
    if (budget === null) continue;
    const file = join(OUT, `${name}.wasm`);
    if (!existsSync(file)) throw new Error(`${file} is missing: run \`npm run wasm\``);
    const bytes = readFileSync(file);
    const gzip = gzipSync(bytes, { level: 9 }).length;
    const fits = gzip <= budget;
    over ||= !fits;
    console.log(`${name}.wasm: ${bytes.length} bytes, ${gzip} gzip (budget ${budget})${fits ? '' : ' OVER'}`);
  }
  if (check && over) {
    console.error('a wasm core is over its gzip budget (scripts/wasm.mjs)');
    process.exit(1);
  }
};

if (args.includes('--sizes') || args.includes('--check-sizes')) sizes(args.includes('--check-sizes'));
else {
  build();
  if (args.includes('--watch')) {
    let timer = null;
    watch(DSP, { recursive: true }, (_, file) => {
      if (!file || file.startsWith('target')) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          build();
        } catch (error) {
          console.error(error.message);
        }
      }, 200);
    });
  }
}
