// the delay of the native nodes, as the app played it before its core (dsp/chain/src/delay.rs), rendered into
// dsp/measurements/delay.json: `npx -y -p playwright@1.50.1 node scripts/delay-native/run.mjs`. The graph below is
// a copy of that delay (the lines and the bandpasses of DelayNodes and BiquadFilterNodes, their params as it set
// them: at once before a render, then setTargetAtTime, Time with its 100 ms), kept here as what the core is held
// to (delay-measured.spec.ts renders the scenes on the core). Chromium: the nodes of the browser most play it in
import fs from 'node:fs';
import path from 'node:path';
import { loadPlaywright, root } from '../bench-common.mjs';
import { SCENES } from './scenes.mjs';

const { chromium } = loadPlaywright();
const browser = await chromium.launch();
const page = await browser.newPage();

const render = (scene) =>
  page.evaluate(async ({ rate, frames, params, changes, input }) => {
    const context = new OfflineAudioContext(2, frames, rate);
    const source = context.createBufferSource();
    const buffer = context.createBuffer(2, frames, rate);
    input.forEach((channel, c) => buffer.copyToChannel(new Float32Array(channel), c));
    source.buffer = buffer;

    const LINE_MAX = 4;
    const PAN_MAX = 0.05;
    const TIME_GLIDE = 0.1;
    const GLIDE = 0.01;
    const splitter = context.createChannelSplitter(2);
    const merger = context.createChannelMerger(2);
    const gain = () => context.createGain();
    const bandpass = () => {
      const node = context.createBiquadFilter();
      node.type = 'bandpass';
      node.frequency.automationRate = 'k-rate';
      node.Q.automationRate = 'k-rate';
      return node;
    };
    const lines = { l: context.createDelay(LINE_MAX), r: context.createDelay(LINE_MAX) };
    const filters = { l: bandpass(), r: bandpass() };
    const offsets = { l: context.createDelay(PAN_MAX), r: context.createDelay(PAN_MAX) };
    const inputs = { l: gain(), r: gain(), x: gain() };
    const feedbacks = { ll: gain(), rr: gain(), lr: gain(), rl: gain() };
    source.connect(splitter);
    splitter.connect(inputs.l, 0);
    splitter.connect(inputs.r, 1);
    splitter.connect(inputs.x, 1);
    inputs.l.connect(lines.l);
    inputs.x.connect(lines.l);
    inputs.r.connect(lines.r);
    lines.l.connect(filters.l);
    lines.r.connect(filters.r);
    filters.l.connect(feedbacks.ll).connect(lines.l);
    filters.r.connect(feedbacks.rr).connect(lines.r);
    filters.l.connect(feedbacks.lr).connect(lines.r);
    filters.r.connect(feedbacks.rl).connect(lines.l);
    filters.l.connect(offsets.l).connect(merger, 0, 0);
    filters.r.connect(offsets.r).connect(merger, 0, 1);
    merger.connect(context.destination);

    // the params of the knobs: at once at 0, a change glides from its time
    const values = { ...params };
    const set = (param, value, at, seconds = GLIDE) =>
      at === 0 ? param.setValueAtTime(value, 0) : param.setTargetAtTime(value, at, seconds);
    const apply = (at) => {
      const pingPong = values.mode >= 0.5;
      set(inputs.l.gain, pingPong ? 0.5 : 1, at);
      set(inputs.x.gain, pingPong ? 0.5 : 0, at);
      set(inputs.r.gain, pingPong ? 0 : 1, at);
      set(feedbacks.ll.gain, pingPong ? 0 : values.fb, at);
      set(feedbacks.rr.gain, pingPong ? 0 : values.fb, at);
      set(feedbacks.lr.gain, pingPong ? values.fb : 0, at);
      set(feedbacks.rl.gain, pingPong ? values.fb : 0, at);
      set(lines.l.delayTime, values.time, at, TIME_GLIDE);
      set(lines.r.delayTime, values.time, at, TIME_GLIDE);
      set(offsets.l.delayTime, Math.max(0, values.pan), at);
      set(offsets.r.delayTime, Math.max(0, -values.pan), at);
      set(filters.l.frequency, values.freq, at);
      set(filters.r.frequency, values.freq, at);
      set(filters.l.Q, values.q, at);
      set(filters.r.Q, values.q, at);
    };
    apply(0);
    for (const { frame, params: next } of changes) {
      Object.assign(values, next);
      apply(frame / rate);
    }
    source.start(0);
    const rendered = await context.startRendering();
    return [0, 1].map((c) => Array.from(rendered.getChannelData(c)));
  }, scene);

const toBase64 = (data) => {
  const floats = Float32Array.from(data);
  return Buffer.from(floats.buffer).toString('base64');
};

await page.goto('about:blank');
const scenes = [];
for (const scene of SCENES) {
  const [left, right] = await render({ ...scene, input: scene.input.map((channel) => Array.from(channel)) });
  const { name, rate, frames, kind, params, changes } = scene;
  scenes.push({ name, rate, frames, kind, params, changes, left: toBase64(left), right: toBase64(right) });
  const peak = Math.max(...left.map(Math.abs), ...right.map(Math.abs));
  console.log(`${scene.name}: ${scene.frames} frames at ${scene.rate} Hz, peak ${peak.toFixed(4)}`);
}
const version = browser.version();
await browser.close();

const about =
  'The delay of the native nodes (scripts/delay-native/run.mjs: the graph the app played before the core of ' +
  'the chain) rendered in an OfflineAudioContext. A scene: its rate, its frames, the params of the knobs at ' +
  '0 (time and pan seconds, mode 1 ping-pong), the changes of them at a frame (a multiple of 128: they glide ' +
  'as the app set them), the input of scenes.mjs (`input`: its kind), the output as base64 of f32 (left, right).';
const file = path.join(root, 'dsp/measurements/delay.json');
fs.writeFileSync(file, JSON.stringify({ about, browser: `Chromium ${version}`, scenes }, null, 1) + '\n');
console.log(`${scenes.length} scenes into ${path.relative(root, file)}`);
