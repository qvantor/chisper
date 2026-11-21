const { readFileSync } = require('fs');
const { join } = require('path');
const { NxAppWebpackPlugin } = require('@nx/webpack/app-plugin');
const { NxReactWebpackPlugin } = require('@nx/react/webpack-plugin');
const { DefinePlugin } = require('webpack');
const { releaseOf } = require('./release.cjs');

// the release of the analytics (common/services/analytics.ts), inlined as every NX_PUBLIC_* variable is
process.env.NX_PUBLIC_RELEASE = releaseOf(process.env);

// robots.txt at the root (the promo pages of apps/site join the folder after the build: scripts/site/merge.mjs);
// the worklet bundles of a configuration (`npm run worklets`). The core of the engine a render of the track runs on
// the main thread is a module of the bundle (engine-wasm-url.ts: named by its bytes)
const assetsOf = (worklets) => [
  './src/favicon.ico',
  './src/robots.txt',
  './src/assets',
  { input: worklets, glob: '*.js', output: 'assets/worklets' },
  // their source maps (scripts/analytics/sourcemaps.mjs uploads them to PostHog, then removes them)
  { input: worklets, glob: '*.js.map', output: 'assets/worklets' },
];

// the configurations of the build and the serve targets (project.json; the inferred tasks of @nx/webpack/plugin
// run webpack-cli with the configuration in NX_TASK_TARGET_CONFIGURATION), webpack-cli alone runs the defaults; the
// folder of each configuration in dist/apps is CHISPER_DIST of the env of the build in project.json, its outputs
const build = {
  default: {
    compiler: 'babel',
    outputPath: join('../../dist/apps', process.env.CHISPER_DIST ?? 'chisper'),
    index: './src/index.html',
    baseHref: '/',
    main: './src/main.tsx',
    polyfills: './src/polyfills.ts',
    tsConfig: './tsconfig.app.json',
    assets: assetsOf('../../tmp/worklets'),
  },
  development: { extractLicenses: false, optimization: false, sourceMap: true, vendorChunk: true },
  production: {
    optimization: true,
    outputHashing: 'all',
    // maps with no link to them in the bundles: scripts/analytics/sourcemaps.mjs uploads them to PostHog (its
    // stacks of the errors unfolded) and removes them before the deploy
    sourceMap: 'hidden-source-map',
    namedChunks: false,
    extractLicenses: true,
    vendorChunk: false,
  },
  // the production build with the test hook of the perf suite (`npm run build:perf`) and its worklets
  perf: {
    optimization: true,
    outputHashing: 'all',
    sourceMap: false,
    namedChunks: false,
    extractLicenses: true,
    vendorChunk: false,
    assets: assetsOf('../../tmp/worklets-perf'),
    // from the root of the workspace (the plugin resolves them from there, its other paths from the project)
    fileReplacements: [
      {
        replace: 'apps/chisper/src/app/perf/perf-hook.tsx',
        with: 'apps/chisper/src/app/perf/perf-hook.perf.tsx',
      },
      // the core of the engine of a render on the main thread: the perf build's (tmp/wasm-perf)
      {
        replace: 'apps/chisper/src/app/synth/common/engine/engine-wasm-url.ts',
        with: 'apps/chisper/src/app/synth/common/engine/engine-wasm-url.perf.ts',
      },
    ],
  },
};

const serve = {
  default: {
    port: 4200,
    hot: true,
    liveReload: false,
    headers: { 'Access-Control-Allow-Origin': '*' },
    historyApiFallback: {
      index: '/index.html',
      disableDotRule: true,
      htmlAcceptHeaders: ['text/html', 'application/xhtml+xml'],
    },
  },
  // the functions of `netlify dev` (`npm start`)
  development: { proxy: JSON.parse(readFileSync(join(__dirname, '../../proxy.conf.json'), 'utf8')) },
  production: { hot: false },
};

const configuration = process.env.NX_TASK_TARGET_CONFIGURATION || 'default';

module.exports = {
  // the build of before goes (the executor of Nx deleted it): Netlify publishes the folder
  output: { clean: true },
  devServer: { ...serve.default, ...serve[configuration] },
  plugins: [
    new NxAppWebpackPlugin({ ...build.default, ...build[configuration] }),
    new NxReactWebpackPlugin(),
    // __PERF__ (src/globals.d.ts): true in the perf configuration only, so the code of the perf suite is dead in
    // every other build and the minifier drops it
    new DefinePlugin({ __PERF__: JSON.stringify(configuration === 'perf') }),
  ],
};
