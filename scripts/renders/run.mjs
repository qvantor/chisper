// the renders of an Audio Unit (manual: macOS, the RENDERS_* of .env; `node scripts/renders/run.mjs`):
// host.swift, an offline host of its AU (AVAudioEngine, manual rendering), renders notes of its init patch with
// parameters set, the measurements of them go to dsp/measurements, which the specs compare the engine with
// (no Audio Unit in CI):
// - envelopes.json: the level of ENV 1 every 10 ms of an attack, a decay (to -12 dB) and a release of 1 s each, at
//   the curves 25, 50, 66.6 (the default of the decay and the release) and 75%: the render over the one of a flat
//   envelope at the same phase (Rand Phase 0), so the wave cancels out
// - unison.json: the voices of a unison of C5 (their cents from the note, their level in each channel against one
//   voice) at 2..7 voices, its Blend, Width and Detune
// - phases.json: osc A and B on one sine, their unisons and Rand Phase: which of their voices start in phase
// - frames.json: tables of ours (state.mjs: written into User of its tables, removed after), frame j a
//   sine of harmonic j + 1: the frame a position plays, how a table with a morph mark is expanded to 256 frames
//   (the shares of the source frames in each), the morph marks 1..4 on frames of other phases
// - frame-fades.json: how a moving position (A WT Pos automated by host.swift) goes from one frame to another:
//   the length of the fade by note and rate, sweeps, two unison voices (a position spread with and without a
//   detune), a pitch bend during a fade
// - aliasing.json: the sound criteria of the oscillator benchmark (scripts/bench-osc: its tables, pitches and rates,
//   the frame it compares as a table of one frame), which it checks ours against
// - spread.json: the position spread of a unison (A Uni WT Pos, bipolar) on a table of ours of 64 frames of one
//   harmonic each: the frames each channel plays by the unison, the spread, the position, a detune mode, a stack
// - blend.json: the blend of a unison (A Uni Blend) of 2..8 voices on a sine: the level of each voice in each
//   channel by the knob, by Macro 1 routed to it (a mod slot of the state), and while either moves it
// - noise.json: the noise oscillator on samples of ours (state.mjs: written into User of its noises, removed after):
//   the pitch of Pitch, Fine and Pitch Track, the bend, the laws of Level and Pan, where Start and Rand start a
//   note, a one-shot's end, mono notes, the images and aliasing of a sine by pitch
// - sub.json: the sub oscillator: the harmonics and a cycle of each shape, its level against the oscillator, the laws
//   of Level and Pan, Octave and Coarse, the bend, portamento, the phase notes start at by Phase and Cont. Phase
//   (apart, overlapping, mono), the aliasing of saw and square by note
// - compressor.json: the compressor of its effect rack (state.mjs: an effect of the rack in the state) on samples of
//   ours played by the noise oscillator (sines of both channels in quadrature: their level is hypot(L, R) at every
//   sample): one band (the law of the threshold, the ratio, the attack and the release, the link of the channels,
//   the makeup, the level, the mix, the highpass) and three bands (the crossovers, the curves of each band down
//   and up, their detector on a mono sine, their release)
// - chorus.json: the chorus of its effect rack on clicks and noise of ours: the delays of its four taps by its
//   knobs, how its LFO moves them (trains of clicks: where each comes out), the feedback, the filter, the laws of
//   the mix and the level, the level of the mono sum
// - delay.json: the delay of its effect rack on a click of ours: the echoes by its times (free, by the tempo of the
//   host, the channels apart, the offsets), the feedback, the laws of the mix and the level, the bandpass in its
//   loop by Freq and BW, where its modes send a click of one channel, its defaults, the click and its echoes as
//   rendered; its times moved by LFO 1 (a mod slot of the state): the delay a sine through it is read at, sample
//   by sample, at four rates (`--parts=static,lfo`)
// - eq.json: the EQ of its effect rack on an impulse of ours: the response of each band by its type, frequency,
//   resonance and gain (a grid, a sweep of the resonance), its defaults, the law of the level, its knobs out of
//   their ranges, at another rate
// - reverb.json: the reverb of its effect rack on an impulse of ours, a quiet tone under it (asleep it answers
//   otherwise): RT60 by octave, the level, the first echoes and their density of the Hall by its Size, its decay,
//   its dampings, the other types at their defaults, the law of Wet, and a chord of saws through it (the level and
//   the third octaves of windows of it: the scenes ours is held to)
// - reverb-presets.json: the factory presets of its reverb (the files of Effect Chains/Reverb/Factory) measured as
//   reverb.json: the impulse all wet, the gains of their own Wet, the chord at it (the built-in presets of ours are
//   fitted to them)
// - filter-types.json: Filter 1 of a voice, the types of Normal and the EQ ones of Misc: the response of each by
//   the cutoff and the resonance (a multisine of our table through it), the EQ ones by DB +/-, the law and the
//   saturation of Drive, FAT and the saturation of a resonance on sines at the cutoff
// - filter-resonance.json: the resonance of MG Low 12 and 24, Low and Band 12 at Res 0.9 and 1 by the cutoff: a quiet
//   sine around the cutoff (its peak, its width), a sine at it by its amplitude (the saturation)
// - warp.json: the warp of osc A (A Warp Mode, A Warp) on tables of ours: the map of the phase of Bend +, Bend -,
//   Bend +/- and PWM by the knob (a sine and a cosine: the warped phase of each sample), the harmonics of a saw and a
//   sine by it, the aliasing of a saw at C6 and C7, the knob automated every sample (how it follows), the harmonics of
//   Bend - and Bend +/- at D2 and D4 to 16 kHz (how bright a frame squeezed at its wrap stays)
// - fxfilter.json: the FX Filter of its effect rack on samples of ours (a multisine, sines, a burst): the response of
//   each type of Normal by the cutoff and the resonance (those of the filter of a voice, more droop), a fresh one, Pan
//   (the cutoff of each channel), the laws of the mix and the level, Drive, FAT, the ring of a resonance, a route of a
//   macro on the cutoff (`fxfilter-routes`), LFO 1 on the cutoff (`fxfilter-lfo`)
// Its knobs are 0..1: the times are 32 s · v⁵, the sustain v² (-12 dB at 0.5), the voices 1 + 15v.
// `--only=envelopes,unison,unison-modes,phases,frames,frame-fades,aliasing,spread,blend,noise,sub,compressor,chorus,delay,eq,reverb,reverb-presets,filter-types,filter-resonance,warp,fxfilter,fxfilter-routes,fxfilter-lfo`
// renders some of them
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { join, parse } from 'node:path';
import { downloadTables, fileName, readEnv } from '../bench-common.mjs';
import { analyze, frameOf, PITCHES, sawFrame, SIZE, TABLES } from '../bench-osc/sound.mjs';
import {
  editedState,
  fxPresetParams,
  noisesFolder,
  reverbPresetsFolder,
  tables,
  writeSample,
  writeTable,
} from './state.mjs';

const require = createRequire(import.meta.url);
const FFT = require('fft.js');
const root = new URL('../..', import.meta.url).pathname;
// the Audio Unit of the stand and its tables: the RENDERS_* of .env
readEnv();
const work = join(root, 'tmp/renders');
const out = join(root, 'dsp/measurements');
mkdirSync(work, { recursive: true });
mkdirSync(out, { recursive: true });
const RATE = 48000;
const only = process.argv
  .find((arg) => arg.startsWith('--only='))
  ?.slice(7)
  .split(',');
const runs = (part) => !only || only.includes(part);

// two runs of the stand at once (two checkouts, two sessions) play each other's samples or the init patch, and write
// and remove the same files of the Audio Unit: a lock between them, a port of localhost this run listens on (the
// system frees it with the process, however it ends: nothing is left behind to take over), taken before this run
// builds or writes anything and held until it ends
const LOCK_PORT = 47219;
const listen = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', (error) => (error.code === 'EADDRINUSE' ? resolve(false) : reject(error)));
    // (unref: it holds the port, not the process)
    server.listen(LOCK_PORT, '127.0.0.1', () => resolve(server.unref()));
  });
const lock = async () => {
  let told = false;
  while (!(await listen())) {
    if (!told) console.log(`waiting for the renders of another run (port ${LOCK_PORT} of localhost)`);
    told = true;
    await new Promise((done) => setTimeout(done, 500));
  }
};
await lock();

const host = join(work, 'host');
execFileSync('swiftc', ['-O', join(root, 'scripts/renders/host.swift'), '-o', host], { stdio: 'inherit' });

// a job of the host: its stereo output, channel by channel
const render = (name, params, notes, seconds) => {
  const job = join(work, `${name}.json`);
  const file = join(work, `${name}.f32`);
  writeFileSync(job, JSON.stringify({ rate: RATE, seconds, params, notes }));
  const { status, stderr } = spawnSync(host, ['render', job, file], { timeout: 300000 });
  if (status !== 0) throw new Error(`the host failed on ${name}: ${stderr}`);
  const bytes = readFileSync(file);
  const samples = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
  return [0, 1].map((channel) => samples.filter((_, i) => i % 2 === channel));
};

// a job of the host in a pool of 8 processes: its stereo output, channel by channel
let running = 0;
const waiting = [];
const hostRender = (name, job) =>
  new Promise((resolve, reject) => {
    const start = () => {
      running++;
      const file = join(work, `${name}.json`);
      const output = join(work, `${name}.f32`);
      writeFileSync(file, JSON.stringify({ rate: RATE, ...job }));
      spawn(host, ['render', file, output]).on('exit', (code) => {
        running--;
        waiting.shift()?.();
        if (code !== 0) return reject(new Error(`the host failed on ${name}`));
        const bytes = readFileSync(output);
        const samples = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
        resolve([0, 1].map((channel) => samples.filter((_, i) => i % 2 === channel)));
      });
    };
    if (running < 8) start();
    else waiting.push(start);
  });
const init = join(work, 'init-state.bin');
execFileSync(host, ['state', init]);

// osc A of the init patch at the phase 0 of every voice, ENV 1 open
const FLAT = { 'A Rand Phase': 0, 'A Phase': 0, 'Env 1 Attack': 0, 'Env 1 Sustain': 1 };
// the init state with its oscillators on `oscs` (editedState: their tables, plain params) and its mod slots `slots`
// in a file of its own
const stateOf = (name, oscs, slots) => {
  const state = join(work, `state-${name}.bin`);
  writeFileSync(state, editedState(init, oscs, slots));
  return state;
};
// a table of ours (frames of 2048 samples, its mark) written into User of the tables of the Audio Unit, and the
// init state with its first `oscs` oscillators on it (A alone by default); `removeTables` removes them
const written = [];
const tableState = (name, frames, flags = '00000000', oscs = 1) => {
  const file = join(tables(), 'User', `chisper-test-${name}.wav`);
  writeTable(file, frames, flags);
  written.push(file);
  const path = `User/chisper-test-${name}.wav`;
  return stateOf(
    name,
    Array.from({ length: oscs }, () => ({ path, frames: frames.length }))
  );
};
const removeTables = () => written.splice(0).forEach((file) => rmSync(file, { force: true }));
// a frame of 2048 samples: a sine of harmonic h (-1: inverted)
const sine = (h = 1) => Array.from({ length: 2048 }, (_, i) => Math.sin((2 * Math.PI * h * i) / 2048));
// `count` frames, frame j a sine of harmonic j + 1
const sines = (count) => Array.from({ length: count }, (_, j) => sine(j + 1));
// the middle value (the upper one of an even count)
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
};

// the magnitude spectrum of 2^18 samples from 0.2 s (Hann), the amplitude of a sine at its peak
const N = 1 << 18;
const hann = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
const spectrum = (x) => {
  const fft = new FFT(N);
  const bins = fft.createComplexArray();
  fft.realTransform(
    bins,
    Array.from({ length: N }, (_, i) => x[i + 9600] * hann[i])
  );
  return Float64Array.from({ length: N / 2 }, (_, k) => Math.hypot(bins[2 * k], bins[2 * k + 1]) / (N / 4));
};
// the Hann windows of `tone` by their length
const windows = new Map();
const windowOf = (n) => {
  if (!windows.has(n))
    windows.set(
      n,
      Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)))
    );
  return windows.get(n);
};
// the complex amplitude of a tone of `frequency` in x over n samples from `from` at `rate` (Hann): its amplitude and
// its phase (degrees) against a sine from sample 0
const tone = (x, frequency, from, n, rate = RATE) => {
  const window = windowOf(n);
  let re = 0;
  let im = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const w = window[i];
    const phase = (2 * Math.PI * frequency * (from + i)) / rate;
    re += x[from + i] * w * Math.sin(phase);
    im += x[from + i] * w * Math.cos(phase);
    sum += w;
  }
  return { amplitude: (2 * Math.hypot(re, im)) / sum, phase: (Math.atan2(im, re) * 180) / Math.PI };
};
// the measures of a held note (the noise, the sub): a note of C5 from 0.05 to 1.5 s, read over 0.3..1.3 s
const held = (note = 72) => [{ note, on: 0.05, off: 1.5 }];
const from = Math.round(0.3 * RATE);
// the frequency of a sine by its rising zero crossings over n samples from `start`
const frequency = (x, start = from, n = RATE) => {
  const crossings = [];
  for (let i = start; i < start + n; i++)
    if (x[i] <= 0 && x[i + 1] > 0) crossings.push(i + x[i] / (x[i] - x[i + 1]));
  return ((crossings.length - 1) / (crossings.at(-1) - crossings[0])) * RATE;
};
const semitones = (x, base, start, n) => +(12 * Math.log2(frequency(x, start, n) / base)).toFixed(3);
const amplitude = (x, f) => tone(x, f, from, RATE).amplitude;
// renders of `once(attempt)` until two in a row agree (`same`; now and then a render is of another state); the
// first two at once where `together` (a host each), else one after the other
const untilAgree = async (name, once, same, together = false) => {
  let [before, last] = together ? await Promise.all([once(0), once(1)]) : [await once(0), await once(1)];
  for (let attempt = 2; !same(before, last); attempt++) {
    if (attempt > 5) throw new Error(`the renders of ${name} never agree`);
    [before, last] = [last, await once(attempt)];
  }
  return last;
};
// a result as JSON, a row of a table on a line of its own
const writeRows = (file, result) => {
  const lines = Object.entries(result).map(([key, value]) =>
    Array.isArray(value)
      ? ` ${JSON.stringify(key)}: [\n${value.map((row) => `  ${JSON.stringify(row)}`).join(',\n')}\n ]`
      : ` ${JSON.stringify(key)}: ${JSON.stringify(value)}`
  );
  writeFileSync(file, `{\n${lines.join(',\n')}\n}\n`);
};
const dB = (v) => +(20 * Math.log10(v)).toFixed(3);
// the frequency of a note the AU plays: the one within ±1 cent (by 0.05) its fundamental is loudest at over the last
// SIZE samples (the bands of the benchmark's analysis are ±14 bins wide: a harmonic 400 of 55 Hz 0.025 cent off is
// within 0.3 Hz)
const loudestFundamental = (x, rate, note) => {
  const nominal = 440 * 2 ** ((note - 69) / 12);
  const from = x.length - SIZE;
  let best = { frequency: nominal, amplitude: -1 };
  for (let c = -20; c <= 20; c++) {
    const frequency = nominal * 2 ** (c / 24000);
    const w = (2 * Math.PI * frequency) / rate;
    let a = 0;
    let b = 0;
    for (let n = from; n < x.length; n++) {
      a += x[n] * Math.cos(w * n);
      b += x[n] * Math.sin(w * n);
    }
    const amplitude = Math.hypot(a, b);
    if (amplitude > best.amplitude) best = { frequency, amplitude };
  }
  return best.frequency;
};
// the shares of the harmonics 1..count of f0 in x over 0.15..0.45 s (their amplitudes, summing to 1)
const harmonicShares = (x, f0, count) => {
  const amplitudes = Array.from(
    { length: count },
    (_, j) => tone(x, f0 * (j + 1), Math.round(0.15 * RATE), Math.round(0.3 * RATE)).amplitude
  );
  const total = amplitudes.reduce((a, b) => a + b, 0);
  return amplitudes.map((a) => a / total);
};

// --- envelopes ---
if (runs('envelopes')) {
  const ON = 0.1;
  const OFF = 2.6;
  const flat = { 'A Rand Phase': 0, 'A Phase': 0 };
  const [reference] = render(
    'ref',
    { ...flat, 'Env 1 Attack': 0, 'Env 1 Hold': 0, 'Env 1 Decay': 0, 'Env 1 Sustain': 1, 'Env 1 Release': 0 },
    [{ note: 60, on: ON, off: 4.4 }],
    4.5
  );
  let loudest = 0;
  for (let i = 0.2 * RATE; i < 0.4 * RATE; i++) loudest = Math.max(loudest, Math.abs(reference[i]));
  // the level every 10 ms from `from` (s) for `seconds`: the median of render / reference where it is loud
  const levels = (left, from, seconds) =>
    Array.from({ length: Math.round(seconds * 100) + 1 }, (_, k) => {
      const start = Math.round((from + k / 100) * RATE);
      const ratios = [];
      for (let i = start; i < start + 480; i++)
        if (Math.abs(reference[i]) > 0.3 * loudest) ratios.push(left[i] / reference[i]);
      return Number(median(ratios).toFixed(5));
    });
  const curves = {};
  for (const curve of [0.25, 0.5, 0.666, 0.75]) {
    const [left] = render(
      `curve-${curve}`,
      {
        ...flat,
        'Env 1 Attack': 0.5,
        'Env 1 Hold': 0,
        'Env 1 Decay': 0.5,
        'Env 1 Sustain': 0.5,
        'Env 1 Release': 0.5,
        'Env 1 Atk Curve': curve,
        'Env 1 Dec Curve': curve,
        'Env 1 Rel Curve': curve,
      },
      [{ note: 60, on: ON, off: OFF }],
      4.5
    );
    curves[curve] = {
      attack: levels(left, ON, 1),
      decay: levels(left, ON + 1, 1),
      release: levels(left, OFF, 1),
    };
  }
  writeFileSync(
    join(out, 'envelopes.json'),
    `${JSON.stringify(
      {
        about:
          'ENV 1 of the init patch of the Audio Unit: attack, decay and release of 1 s, the sustain at -12 dB (0.25); the level every 10 ms (the median of a window of 10 ms from there) of each stage, by its curve (0..1, 0.5 the attack and 0.666 the decay and the release by default); scripts/renders/run.mjs',
        sustain: 0.25,
        curves,
      },
      null,
      1
    )}\n`
  );
}

// --- unison ---
if (runs('unison')) {
  const NOTE = 72;
  const F0 = 440 * 2 ** ((NOTE - 69) / 12);
  // the voices around the fundamental: their cents and their amplitude in each channel (the main lobe of a Hann)
  const voices = (channels) => {
    const [l, r] = channels.map(spectrum);
    const bin = (cents) => (F0 * 2 ** (cents / 1200) * N) / RATE;
    const peaks = [];
    for (let k = Math.floor(bin(-260)) + 1; k < Math.ceil(bin(260)); k++) {
      const m = l[k] + r[k];
      if (m > l[k - 1] + r[k - 1] && m >= l[k + 1] + r[k + 1] && m > 0.0005) {
        const amplitude = (s) => Math.hypot(s[k - 1], s[k], s[k + 1]);
        peaks.push({ cents: 1200 * Math.log2((k * RATE) / N / F0), left: amplitude(l), right: amplitude(r) });
      }
    }
    return peaks;
  };
  const unison = (name, count, params = {}) =>
    voices(
      render(
        name,
        { 'A Rand Phase': 0, 'Env 1 Attack': 0, 'Env 1 Sustain': 1, 'A Unison': (count - 1) / 15, ...params },
        [{ note: NOTE, on: 0, off: 6 }],
        6
      )
    );
  const [one] = unison('u1', 1);
  const db = (amplitude) =>
    amplitude > 1e-6 ? Number((20 * Math.log10(amplitude / one.left)).toFixed(1)) : null;
  const table = (peaks) =>
    peaks.map(({ cents, left, right }) => ({
      cents: Number(cents.toFixed(1)),
      left: db(left),
      right: db(right),
    }));
  const cases = {};
  for (const count of [2, 3, 4, 5, 7])
    cases[`u${count}`] = table(unison(`u${count}`, count, { 'A Uni Detune': 1 }));
  for (const blend of [0, 0.25, 0.5, 1])
    for (const count of [4, 5])
      cases[`u${count} blend ${blend}`] = table(
        unison(`u${count}-blend${blend}`, count, { 'A Uni Detune': 1, 'A Uni Blend': blend })
      );
  for (const width of [0.5, 0.75])
    cases[`u5 width ${width}`] = table(
      unison(`u5-width${width}`, 5, { 'A Uni Detune': 1, 'A Uni Width': width })
    );
  for (const detune of [0.25, 0.5, 0.75])
    cases[`u5 detune ${detune}`] = table(unison(`u5-detune${detune}`, 5, { 'A Uni Detune': detune }));
  writeFileSync(
    join(out, 'unison.json'),
    `${JSON.stringify(
      {
        about:
          'Osc A of the init patch of the Audio Unit at C5 with a unison (Blend 0.75, Width 1, Detune 1 unless named): each voice its cents from the note and its level in each channel (dB against a single voice, null: not heard); scripts/renders/run.mjs',
        cases,
      },
      null,
      1
    )}\n`
  );
  console.log(`dsp/measurements: ${Object.keys(cases).length} unisons`);
}

// --- unison modes ---
// the detune modes (kParamDetuneMode of the plain params of osc A: no parameter of the AU sets it) and the stacks
// (A Uni Stack, 9 values: floor(v·9)) of a unison of a sine (a table of ours: its harmonics would hide the
// stacked voices), merged into unison.json: each voice its cents (modes, Detune 1: ±200), and its semitones of
// the stack, its cents of the detune and its side (stacks, Detune 0.5: ±35 cents)
if (runs('unison-modes')) {
  const table = join(tables(), 'User', 'chisper-test-sine.wav');
  writeTable(table, [sine()], '00000000');
  const C4 = 440 * 2 ** ((60 - 69) / 12);
  const sineState = (name, params) =>
    stateOf(name, [{ path: 'User/chisper-test-sine.wav', frames: 1, params }]);
  // the peaks from `low` to `high` cents of C4, the cents refined by the parabola of their three bins
  const peaks = (channels, low, high) => {
    const [l, r] = channels.map(spectrum);
    const bin = (cents) => (C4 * 2 ** (cents / 1200) * N) / RATE;
    const found = [];
    for (let k = Math.floor(bin(low)) + 1; k < Math.ceil(bin(high)); k++) {
      const [y0, y1, y2] = [l[k - 1] + r[k - 1], l[k] + r[k], l[k + 1] + r[k + 1]];
      if (y1 > y0 && y1 >= y2 && y1 > 0.001) {
        const d = (0.5 * (y0 - y2)) / (y0 - 2 * y1 + y2);
        const amplitude = (s) => Math.hypot(s[k - 1], s[k], s[k + 1]);
        found.push({
          cents: 1200 * Math.log2(((k + d) * RATE) / N / C4),
          left: amplitude(l),
          right: amplitude(r),
        });
      }
    }
    return found;
  };
  const note = (name, state, params) =>
    hostRender(name, {
      seconds: 6.5,
      state,
      params: { 'A Rand Phase': 0, 'Env 1 Attack': 0, 'Env 1 Sustain': 1, ...params },
      notes: [{ note: 60, on: 0, off: 6.5 }],
    });
  const modes = {};
  const stacks = {};
  const STACKS = [
    'off',
    '12 (1x)',
    '12 (2x)',
    '12 (3x)',
    '12+7 (1x)',
    '12+7 (2x)',
    '12+7 (3x)',
    'Center-12',
    'Center-24',
  ];
  const STEPS = [-24, -12, 0, 7, 12, 19, 24, 31, 36];
  try {
    const jobs = [];
    for (const mode of ['kDetuneLinear', 'kDetuneSuper', 'kDetuneExp', 'kDetuneInv']) {
      const state = sineState(mode, { kParamDetuneMode: mode });
      for (const count of [3, 4, 5, 6, 7, 8, 9, 10, 12, 16])
        jobs.push(
          note(`${mode}-${count}`, state, { 'A Unison': (count - 1) / 15, 'A Uni Detune': 1 }).then((x) => {
            modes[`${mode.slice(7).toLowerCase()} u${count}`] = peaks(x, -300, 300).map((p) =>
              Number(p.cents.toFixed(2))
            );
          })
        );
    }
    const linear = sineState('linear', { kParamDetuneMode: 'kDetuneLinear' });
    STACKS.forEach((name, i) => {
      for (const count of [1, 2, 3, 4, 5, 6, 7, 8, 16])
        jobs.push(
          note(`stack-${i}-${count}`, linear, {
            'A Unison': (count - 1) / 15,
            'A Uni Detune': 0.5,
            'A Uni Stack': (i + 0.5) / 9,
          }).then((x) => {
            stacks[`${name} u${count}`] = peaks(x, -2500, 4000)
              .map(({ cents, left, right }) => {
                const st = cents / 100;
                const step = STEPS.reduce((a, b) => (Math.abs(st - b) < Math.abs(st - a) ? b : a));
                const side = left > 2 * right ? 'L' : right > 2 * left ? 'R' : 'C';
                return { step, detune: Math.round((st - step) * 100), side };
              })
              .sort((a, b) => a.detune - b.detune);
          })
        );
    });
    await Promise.all(jobs);
  } finally {
    rmSync(table, { force: true });
  }
  const file = join(out, 'unison.json');
  const unison = JSON.parse(readFileSync(file, 'utf8'));
  const sorted = (o) =>
    Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })));
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        ...unison,
        about_modes:
          'Osc A of the Audio Unit on a sine (a table of ours) at C4: `modes` the cents of each voice by detune mode (kParamDetuneMode of its state) at Detune 1 and 3..16 voices; `stacks` each voice by A Uni Stack at Detune 0.5 and 1..16 voices: the semitones of its stack, its detune (cents) and its side (L, R, C both); scripts/renders/run.mjs --only=unison-modes',
        modes: sorted(modes),
        stacks: sorted(stacks),
      },
      null,
      1
    )}\n`
  );
  console.log(
    `dsp/measurements: ${Object.keys(modes).length} detune modes, ${Object.keys(stacks).length} stacks`
  );
}

// --- phases ---
// the start phases of osc A and B on one sine (a table of ours) at C5, their unisons at Detune 1 (linear: voice j
// of n at 200 · (2j / (n - 1) - 1) cents): each pair of voices of A and B at one pitch, on each of 12 notes, the
// amplitude of the pair over the sum of those of its voices alone. The first 4 notes of a render are left out:
// they start at about the Phase whatever the Rand Phase (the random draws of the AU start near 0)
if (runs('phases')) {
  const NOTE = 72;
  const C5 = 440 * 2 ** ((NOTE - 69) / 12);
  const SKIPPED = 4;
  const NOTES = Array.from({ length: SKIPPED + 12 }, (_, k) => ({
    note: NOTE,
    on: 0.1 + 0.6 * k,
    off: 0.6 + 0.6 * k,
  }));
  const MEASURED = NOTES.slice(SKIPPED);
  const cents = (j, n) => (n === 1 ? 0 : 200 * ((2 * j) / (n - 1) - 1));
  // the amplitude of a tone of `cents` from C5 in x over 0.05..0.45 s of a note
  const amplitude = (x, c, on) =>
    tone(x, C5 * 2 ** (c / 1200), Math.round((on + 0.05) * RATE), Math.round(0.4 * RATE)).amplitude;
  // an oscillator of a case: its unison, Rand Phase and Phase (shares of a period)
  const osc = ({ unison = 1, rand = 1, phase = 0.5 }) => ({ unison, rand, phase });
  const oscParams = (side, { unison, rand, phase }) => ({
    [`${side} Unison`]: (unison - 1) / 15,
    [`${side} Uni Detune`]: 1,
    [`${side} Rand Phase`]: rand,
    [`${side} Phase`]: phase,
  });
  const CASES = Object.entries({
    u1: [{}, {}],
    u2: [{ unison: 2 }, { unison: 2 }],
    u3: [{ unison: 3 }, { unison: 3 }],
    u4: [{ unison: 4 }, { unison: 4 }],
    'u3 + u2': [{ unison: 3 }, { unison: 2 }],
    'u1 + u3': [{}, { unison: 3 }],
    'u1, B Rand Phase 0': [{}, { rand: 0 }],
    'u1, B Rand Phase 0.5': [{}, { rand: 0.5 }],
    'u1, Rand Phase 0.5': [{ rand: 0.5 }, { rand: 0.5 }],
    'u1, B Phase 0.25': [{}, { phase: 0.25 }],
  }).map(([name, oscs]) => [name, oscs.map(osc)]);
  const UNISONS = [...new Set(CASES.flatMap(([, oscs]) => oscs.map(({ unison }) => unison)))];
  const state = tableState('phases', [sine()], '00000000', 2);
  // the notes in L + R
  const notes = async (name, params) => {
    const [l, r] = await hostRender(name, {
      seconds: 0.1 + 0.6 * NOTES.length,
      state,
      params: { 'Env 1 Attack': 0, 'Env 1 Sustain': 1, 'Env 1 Release': 0, ...params },
      notes: NOTES,
    });
    return Float64Array.from(l, (value, i) => value + r[i]);
  };
  const [alone, rendered] = await Promise.all([
    // osc A alone at each unison (B plays as A)
    Promise.all(
      UNISONS.map((n) =>
        notes(`phases-alone-u${n}`, { 'B Enable': 0, ...oscParams('A', osc({ unison: n })) })
      )
    ),
    Promise.all(
      CASES.map(([name, [a, b]]) =>
        notes(`phases-${name.replace(/\W+/g, '-')}`, {
          'B Enable': 1,
          ...oscParams('A', a),
          ...oscParams('B', b),
        })
      )
    ),
  ]).finally(removeTables);
  // the amplitude of each voice of a unison alone (by the unison): the median over the notes
  const aloneOf = Object.fromEntries(
    UNISONS.map((n, i) => [
      n,
      Array.from({ length: n }, (_, j) =>
        median(MEASURED.map(({ on }) => amplitude(alone[i], cents(j, n), on)))
      ),
    ])
  );
  const cases = CASES.map(([name, [a, b]], c) => {
    const [m, n] = [a.unison, b.unison];
    const pairs = [];
    for (let j = 0; j < m; j++)
      for (let k = 0; k < n; k++) {
        const pitch = cents(j, m);
        if (Math.abs(pitch - cents(k, n)) < 1) {
          const sum = aloneOf[m][j] + aloneOf[n][k];
          pairs.push({
            a: j,
            b: k,
            cents: Number(pitch.toFixed(1)),
            levels: MEASURED.map(({ on }) => Number((amplitude(rendered[c], pitch, on) / sum).toFixed(3))),
          });
        }
      }
    return [name, { a, b, pairs }];
  });
  writeFileSync(
    join(out, 'phases.json'),
    `${JSON.stringify(
      {
        about:
          'Osc A and B of the init patch of the Audio Unit on a sine (a table of ours) at C5, each its unison at Detune 1 (linear: voice j of n at 200 · (2j / (n - 1) - 1) cents, from the lowest), its Rand Phase (`rand`) and Phase (`phase`, shares of a period; 1 and 0.5 unless named), the same Level: on each of 12 notes (0.5 s long; the 4 before them of the render left out, they start at about the Phase whatever the Rand Phase) each pair of voices of A (`a`) and B (`b`) at one pitch, the amplitude of the pair in L + R over the sum of those of its two voices alone (1: in phase; two of one level cancel at 0); scripts/renders/run.mjs --only=phases',
        cases: Object.fromEntries(cases),
      },
      null,
      1
    )}\n`
  );
  console.log(`dsp/measurements: phases of ${cases.length} pairs of oscillators`);
}

// --- frames ---
if (runs('frames')) {
  const FRAMES_NOTE = 36;
  const FRAMES_F0 = 440 * 2 ** ((FRAMES_NOTE - 69) / 12);
  // a note of osc A: its left channel
  const renderAsync = async (name, state, params) =>
    (
      await hostRender(name, {
        seconds: 0.5,
        state,
        params: { ...FLAT, ...params },
        notes: [{ note: FRAMES_NOTE, on: 0, off: 0.5 }],
      })
    )[0];
  // the complex amplitude of harmonic h over 0.15..0.45 s, its phase against a sine from the note on
  const harmonic = (x, h) => tone(x, FRAMES_F0 * h, Math.round(0.15 * RATE), Math.round(0.3 * RATE));
  // the shares of the source frames (the amplitudes of their harmonics, summing to 1) at a position
  const shares = async (name, state, count, position) =>
    harmonicShares(await renderAsync(name, state, { 'A WT Pos': position }), FRAMES_F0, count);
  const lower = (row) => row.findIndex((share) => share > 0.0005);
  try {
    // the frame a position plays: just below and above k / N (no mark)
    const played = {};
    for (const count of [3, 4]) {
      const state = tableState(`plain-${count}`, sines(count));
      const edges = Array.from({ length: count - 1 }, (_, i) => i + 1);
      played[count] = await Promise.all(
        edges.map(async (k) => {
          const [below, above] = await Promise.all(
            [k / count - 1e-4, k / count + 1e-4].map((v, i) =>
              shares(`plain-${count}-${k}-${i}`, state, count, v)
            )
          );
          return { edge: k / count, below: lower(below), above: lower(above) };
        })
      );
    }
    // the expanded frames of a table with a morph mark: the source frame below and the share of the next one
    const morphed = {};
    for (const count of [3, 4, 16]) {
      const state = tableState(`morph-${count}`, sines(count), '10000000');
      morphed[count] = await Promise.all(
        Array.from({ length: 256 }, async (_, e) => {
          const row = await shares(`morph-${count}-${e}`, state, count, (e + 0.5) / 256);
          const j = lower(row);
          return [j, Number((row[j + 1] ?? 0).toFixed(5))];
        })
      );
    }
    // the marks 1..4 (crossfade, spectral, spectral without the phase of the fundamental, without any phases) and
    // 01 on 2 frames of other phases: h1 1 at 0°, h2 0.5 at 0°; h1 0.5 at 120°, h2 1 at -90°; at e = 128
    const frame = (parts) =>
      Array.from({ length: 2048 }, (_, i) =>
        parts.reduce(
          (sum, [h, a, p]) => sum + a * Math.sin((2 * Math.PI * h * i) / 2048 + (p * Math.PI) / 180),
          0
        )
      );
    const pair = [
      frame([
        [1, 1, 0],
        [2, 0.5, 0],
      ]),
      frame([
        [1, 0.5, 120],
        [2, 1, -90],
      ]),
    ];
    const marks = {};
    for (const mark of ['00000000', '01000000', '10000000', '20000000', '30000000', '40000000']) {
      const state = tableState(`mark-${mark.slice(0, 2)}`, pair, mark);
      const [first, middle] = await Promise.all(
        [0.5 / 256, 128.5 / 256].map((v, i) => renderAsync(`mark-${mark}-${i}`, state, { 'A WT Pos': v }))
      );
      const at = (x) => [1, 2].map((h) => harmonic(x, h));
      const [r1, r2] = at(first);
      const [m1, m2] = at(middle);
      const relative = (c, r) => ({
        amplitude: Number((c.amplitude / r1.amplitude).toFixed(4)),
        phase: Number((((c.phase - r.phase + 540) % 360) - 180).toFixed(2)),
      });
      marks[mark] = { h1: relative(m1, r1), h2: relative(m2, r2) };
    }
    writeFileSync(
      join(out, 'frames.json'),
      `${JSON.stringify(
        {
          about:
            'Osc A of the init patch of the Audio Unit playing tables of ours (frame j a sine of harmonic j + 1; the state of its Audio Unit with the path of its table swapped): `played` the source frame just below and above each edge k / N of the position (no mark), `morphed` for each of the 256 frames a table with the mark 1 expands to (at the position (e + 0.5) / 256) the source frame below and the share of the next one, `marks` the harmonics 1 and 2 at e = 128 of 2 frames (h1 1 at 0°, h2 0.5 at 0°; h1 0.5 at 120°, h2 1 at -90°) against frame 0, by mark; scripts/renders/run.mjs',
          played,
          morphed,
          marks,
        },
        null,
        1
      )}\n`
    );
    console.log(`dsp/measurements: frames of ${Object.keys(morphed).length} morphed tables`);
  } finally {
    removeTables();
  }
}

// --- frame fades ---
// how osc A goes from one frame to another while its position moves (A WT Pos automated, set every 16 samples):
// tables of ours of sines of one phase and the other (frame j: (-1)^j · a sine), so the sign of the output tells
// the frame, and between two frames x = (1 - 2m) · the sine, m the share of the new one
if (runs('frame-fades')) {
  const note = (name, job) => hostRender(name, { step: 16, ...job });
  // A WT Pos through its points [seconds, value]; a step from frame 0 to 1 of 2 frames at 0.5 s
  const wtPos = (...points) => ({ name: 'A WT Pos', points });
  const STEP = wtPos([0, 0.25], [0.5, 0.25], [0.5, 0.75]);
  // the sine of frequency f in x over [n0, n1): its amplitude and phase (`cents`: f refined within ±cents, by
  // 0.01; a note of the init patch is its frequency, an error of 0.1 cent would turn its phase 20° in 4 s)
  const fit = (x, rate, f, n0, n1, cents = 0) => {
    let best = null;
    for (let c = -cents; c <= cents + 1e-9; c += 0.01) {
      const w = (2 * Math.PI * f * 2 ** (c / 1200)) / rate;
      let a = 0;
      let b = 0;
      for (let n = n0; n < n1; n++) {
        a += x[n] * Math.cos(w * n);
        b += x[n] * Math.sin(w * n);
      }
      const amp = (2 * Math.hypot(a, b)) / (n1 - n0);
      if (!best || amp > best.amp) best = { w, amp, phi: Math.atan2(a, b) };
    }
    return best;
  };
  // x over that sine from n0 to n1 where it is not near 0 (|sin| above `low`): [n, x / the sine]
  const against = (x, s, n0, n1, low = 0.3) => {
    const out = [];
    for (let n = n0; n < n1; n++) {
      const sn = Math.sin(s.w * n + s.phi);
      if (Math.abs(sn) > low) out.push([n, x[n] / sn / s.amp]);
    }
    return out;
  };
  // the fade of the first change of a: the line of m = (1 - a) / 2 through 0.15..0.85 (its start where it is 0,
  // its length the samples to 1; `fadeOf` of wavetable-osc-dsp.spec.ts measures the engine so: keep them alike)
  const fadeOf = (a) => {
    const first = a.findIndex(([, v]) => v < 0.98);
    if (first < 0) throw new Error('fadeOf: no change of frame');
    const mid = [];
    for (let i = first; i < a.length && a[i][1] > -0.98; i++)
      if (a[i][1] < 0.7 && a[i][1] > -0.7) mid.push([a[i][0], (1 - a[i][1]) / 2]);
    if (mid.length < 2) throw new Error(`fadeOf: a step, not a fade (${mid.length} samples within ±0.7)`);
    const mx = mid.reduce((t, [n]) => t + n, 0) / mid.length;
    const my = mid.reduce((t, [, m]) => t + m, 0) / mid.length;
    const slope =
      mid.reduce((t, [n, m]) => t + (n - mx) * (m - my), 0) / mid.reduce((t, [n]) => t + (n - mx) ** 2, 0);
    const start = mx - my / slope;
    // the most a sample of it is off the line (a fade linear in time: within the noise of the fit)
    const off = Math.max(...mid.map(([n, m]) => Math.abs(m - (n - start) * slope)));
    return { start: Math.round(start), length: Number((1 / slope).toFixed(1)), off: Number(off.toFixed(3)) };
  };
  // the sine of frequency f of a channel (fitted over 0.1..0.4 s, refined within ±cents) and the fade of its first
  // change from 0.45 s on
  const fadeAt = (x, f, cents = 0, rate = RATE) => {
    const s = fit(x, rate, f, Math.round(0.1 * rate), Math.round(0.4 * rate), cents);
    return [s, fadeOf(against(x, s, Math.round(0.45 * rate), x.length))];
  };
  try {
    const flip = tableState('flip', [sine(1), sine(-1)]);
    // the step by note and rate: the start of the fade and its length
    const lengths = {};
    const jobs = [];
    for (const rate of [44100, 48000, 96000]) {
      lengths[rate] = [];
      for (const key of [33, 45, 57, 69, 81, 93]) {
        const f = 440 * 2 ** ((key - 69) / 12);
        jobs.push(
          note(`fade-${rate}-${key}`, {
            rate,
            seconds: 1,
            state: flip,
            params: FLAT,
            automation: [STEP],
            notes: [{ note: key, on: 0, off: 1 }],
          }).then(([left]) => {
            const [, { start, length }] = fadeAt(left, f, 0, rate);
            lengths[rate].push({ note: key, period: Number((rate / f).toFixed(1)), start, length });
          })
        );
      }
    }
    // a sweep of 256 frames at 220 Hz over 4, 1 and 0.25 s from 0.3 s: every fade that passes 0 (|x / the sine|
    // below 0.5: between frames of the same sign there is none to see) where it starts (below 0.98), how long it
    // takes (back above 0.98), and the sign before and after it
    const alternate = tableState(
      'alternate',
      Array.from({ length: 256 }, (_, j) => sine(j % 2 ? -1 : 1))
    );
    const sweeps = {};
    for (const seconds of [4, 1, 0.25])
      jobs.push(
        note(`sweep-${seconds}`, {
          seconds: seconds + 0.6,
          state: alternate,
          params: FLAT,
          automation: [wtPos([0, 0], [0.3, 0], [0.3 + seconds, 1])],
          notes: [{ note: 57, on: 0, off: seconds + 0.6 }],
        }).then(([left]) => {
          const s = fit(left, RATE, 220, Math.round(0.05 * RATE), Math.round(0.25 * RATE));
          const a = against(left, s, Math.round(0.25 * RATE), left.length, 0.5);
          const changes = [];
          for (let i = 1; i < a.length; i++) {
            if (Math.abs(a[i][1]) > 0.98 || Math.abs(a[i - 1][1]) <= 0.98) continue;
            let j = i;
            let deepest = 1;
            for (; j < a.length && Math.abs(a[j][1]) <= 0.98; j++)
              deepest = Math.min(deepest, Math.abs(a[j][1]));
            if (j === a.length) break;
            if (deepest < 0.5)
              changes.push([a[i][0], a[j][0] - a[i][0], Math.sign(a[i - 1][1]), Math.sign(a[j][1])]);
            i = j;
          }
          sweeps[seconds] = { changes };
        })
      );
    // two voices (A Unison 2: one right, one left): at Detune 1 (±200 cents) both fade at one step, each over
    // its own period; A Uni WT Pos 0.75 (+50%) at Detune 0 and at Detune 1 (the right voice on the position, the
    // left one, the higher, a quarter of the table below it: spread.json), the right one crosses into frame 1 at
    // 0.5 s, the left one at 0.7 s
    const unison = {};
    const two = { ...FLAT, 'A Unison': 1 / 15 };
    const SPREAD = wtPos([0, 0.1], [0.5, 0.1], [0.5, 0.6], [0.7, 0.6], [0.7, 0.9]);
    // channel c of a note of 440 Hz at Detune 1 (the left voice 200 cents up, the right one 200 down): its period
    // and its fade
    const detunedFade = (x, c) => {
      const [s, fade] = fadeAt(x, 440 * 2 ** ((c ? -200 : 200) / 1200), 3);
      return { period: Number(((2 * Math.PI) / s.w).toFixed(1)), ...fade };
    };
    jobs.push(
      note('fade-detuned', {
        seconds: 1,
        state: flip,
        params: { ...two, 'A Uni Detune': 1 },
        automation: [STEP],
        notes: [{ note: 69, on: 0, off: 1 }],
      }).then((channels) => {
        unison.detuned = channels.map(detunedFade);
      }),
      note('fade-spread', {
        seconds: 1,
        state: flip,
        params: { ...two, 'A Uni Detune': 0, 'A Uni WT Pos': 0.75 },
        automation: [SPREAD],
        notes: [{ note: 57, on: 0, off: 1 }],
      }).then((channels) => {
        unison.spread = channels.map((x) => fadeAt(x, 220)[1]);
      }),
      note('fade-spread-detuned', {
        seconds: 1,
        state: flip,
        params: { ...two, 'A Uni Detune': 1, 'A Uni WT Pos': 0.75 },
        automation: [SPREAD],
        notes: [{ note: 69, on: 0, off: 1 }],
      }).then((channels) => {
        unison.spreadDetuned = channels.map(detunedFade);
      })
    );
    // a pitch bend of 12 semitones up and down (Pitch Bend 0.5 → 0.75 or 0.25 over 0.49..0.53 s) while the right
    // voice fades (the left one, on frame 0, has its phase): m = (1 - right / left) / 2, and the period of the left
    // one around it
    const bends = {};
    for (const [name, to] of [
      ['up', 0.75],
      ['down', 0.25],
    ])
      jobs.push(
        note(`fade-bend-${name}`, {
          seconds: 1,
          state: flip,
          params: { ...two, 'A Uni Detune': 0, 'A Uni WT Pos': 1, 'Bend Down': 0.25, 'Bend Up': 0.75 },
          automation: [
            wtPos([0, 0.1], [0.5, 0.1], [0.5, 0.6]),
            {
              name: 'Pitch Bend',
              points: [
                [0, 0.5],
                [0.49, 0.5],
                [0.53, to],
              ],
            },
          ],
          notes: [{ note: 57, on: 0, off: 1 }],
        }).then(([left, right]) => {
          let peak = 0;
          for (let n = 9600; n < 19200; n++) peak = Math.max(peak, Math.abs(left[n]));
          const a = [];
          for (let n = Math.round(0.45 * RATE); n < Math.round(0.7 * RATE); n++)
            if (Math.abs(left[n]) > 0.3 * peak) a.push([n, right[n] / left[n]]);
          const fade = fadeOf(a);
          const crossings = [];
          for (let n = Math.round(0.45 * RATE); n < Math.round(0.7 * RATE); n++)
            if (left[n - 1] < 0 && left[n] >= 0)
              crossings.push(n - 1 - left[n - 1] / (left[n] - left[n - 1]));
          // the period that ends first after t
          const periodAt = (t) => {
            const i = crossings.findIndex((c) => c > t);
            return Number((crossings[i] - crossings[i - 1]).toFixed(1));
          };
          bends[name] = { ...fade, periods: [periodAt(fade.start), periodAt(fade.start + fade.length)] };
        })
      );
    await Promise.all(jobs);
    Object.values(lengths).forEach((rows) => rows.sort((a, b) => a.note - b.note));
    writeFileSync(
      join(out, 'frame-fades.json'),
      `${JSON.stringify(
        {
          about:
            'Osc A of the init patch of the Audio Unit playing tables of ours (frame j (-1)^j · a sine: the sign of the output tells the frame, between two frames it is (1 - 2m) · the sine, m the share of the new one) while A WT Pos is automated (set every 16 samples; the AU glides it, its fades start some ms after a step): `lengths` a step from frame 0 to 1 by rate and note: the sample the fade starts at and its length in samples (the line of m through 0.15..0.85); `sweeps` 256 frames swept from 0.3 s over 4, 1 and 0.25 s at 220 Hz: each change of sign [start, samples, sign before, sign after]; `unison` A Unison 2 (one voice right, one left): `detuned` at Detune 1 (±200 cents) each channel its period and its fade, `spread` Detune 0 and A Uni WT Pos 0.75: the right voice crosses at 0.5 s, the left one at 0.7 s, `spreadDetuned` the same at Detune 1 (as `detuned`): the right voice (the lower) crosses at 0.5 s, the left one (the higher) at 0.7 s; `bends` a pitch bend of 12 semitones up and down over 0.49..0.53 s while the right voice fades (m against the left one, on frame 0): the fade, the most a sample of it is off its line (`off`) and the periods of the left voice at its start and its end; scripts/renders/run.mjs --only=frame-fades',
          lengths,
          sweeps,
          unison,
          bends,
        },
        null,
        1
      )}\n`
    );
    console.log(
      `dsp/measurements: frame fades of ${Object.keys(lengths).length} rates, ${
        Object.keys(sweeps).length
      } sweeps`
    );
  } finally {
    removeTables();
  }
}

// --- the position spread of a unison ---
// A Uni WT Pos (bipolar: 0 is -100%, 0.5 none, 1 +100%) on a table of ours of 64 frames, frame j a sine of harmonic
// j + 1, at a still A WT Pos: every voice at Detune 0 and the phase 0, so each channel is the frames of its voices,
// each harmonic the share of the voices on its frame
if (runs('spread')) {
  const COUNT = 64;
  const NOTE = 24;
  const F0 = 440 * 2 ** ((NOTE - 69) / 12);
  // 0, the middle of frames 16, 32 and 48 (an edge between two frames would not tell the one played), 1
  const POSITIONS = [0, 16.5 / COUNT, 32.5 / COUNT, 48.5 / COUNT, 1];
  const AMOUNTS = [-1, -0.5, -0.25, 0.25, 0.5, 1];
  const name = 'spread';
  // a case (its unison, spread, position, a detune mode or the stack 12 (1x)) on `state`: each channel [frame,
  // share] of the frames its voices play (below 1% left out; a stacked voice plays them at their harmonic doubled)
  const play = (state, c) =>
    hostRender(`spread-${Object.values(c).join('-')}`, {
      seconds: 0.5,
      state,
      params: {
        ...FLAT,
        'A Unison': (c.unison - 1) / 15,
        'A Uni Detune': 0,
        'A Uni WT Pos': 0.5 + c.spread / 2,
        'A WT Pos': c.position,
        ...(c.stack && { 'A Uni Stack': 1.5 / 9 }),
      },
      notes: [{ note: NOTE, on: 0, off: 0.5 }],
    }).then((x) => {
      const [left, right] = x.map((channel) =>
        harmonicShares(channel, F0, c.stack ? 2 * COUNT : COUNT).flatMap((share, j) =>
          share > 0.01 ? [[j, Number(share.toFixed(3))]] : []
        )
      );
      return { ...c, left, right };
    });
  try {
    const plain = tableState(name, sines(COUNT));
    const jobs = [];
    for (const unison of [2, 3, 4, 5, 8])
      for (const spread of AMOUNTS)
        for (const position of POSITIONS) jobs.push(play(plain, { unison, spread, position }));
    // the detune modes: do the voices follow their shares of the detune or their order
    for (const mode of ['kDetuneLinear', 'kDetuneSuper', 'kDetuneExp', 'kDetuneInv']) {
      const state = stateOf(`${name}-${mode}`, [
        { path: `User/chisper-test-${name}.wav`, frames: COUNT, params: { kParamDetuneMode: mode } },
      ]);
      for (const spread of [-1, 1])
        jobs.push(
          play(state, { unison: 8, spread, position: POSITIONS[2], mode: mode.slice(7).toLowerCase() })
        );
    }
    // a stack (12 (1x): voices 0 and 2 of 3 an octave up): their order or their pitch
    jobs.push(play(plain, { unison: 3, spread: 1, position: POSITIONS[2], stack: '12x1' }));
    const cases = await Promise.all(jobs);
    writeFileSync(
      join(out, 'spread.json'),
      `${JSON.stringify(
        {
          about: `Osc A of the init patch of the Audio Unit on a table of ours of ${COUNT} frames (frame j a sine of harmonic j + 1) at note ${NOTE}, Detune 0 and the phase 0 of every voice, A WT Pos still at \`position\`, A Uni WT Pos at \`spread\` (-1..1: -100..+100%): \`left\` and \`right\` [frame, share] of the frames the voices of each channel play (the amplitudes of their harmonics, summing to 1; below 1% left out); \`mode\` a detune mode (kParamDetuneMode), \`stack\` 12 (1x) (the frames of the stacked voices at their harmonic doubled); scripts/renders/run.mjs --only=spread`,
          cases,
        },
        null,
        1
      )}\n`
    );
    console.log(`dsp/measurements: the position spread of ${cases.length} unisons`);
  } finally {
    removeTables();
  }
}

// --- the blend of a unison ---
// A Uni Blend (0..1, its knob) of a unison of 2..8 voices on a sine (a table of ours) at C4, Detune 1 (linear: voice
// j of n at 200 · (2j / (n - 1) - 1) cents), Width 1, the phase 0 of every voice: each voice its level in each
// channel by the blend; Macro 1 routed to it (a mod slot: kParamDetuneWid, the param of A Uni Blend) from the knob by
// an amount, uni and bipolar; the blend moved over 2 s up and back by the knob (automated) and by Macro 1, at C7
// (the voices 125 Hz apart at least: windows of 40 ms tell them apart)
if (runs('blend')) {
  const C4 = 440 * 2 ** ((60 - 69) / 12);
  const name = 'blend-sine';
  const path = `User/chisper-test-${name}.wav`;
  const cents = (j, n) => (n === 1 ? 0 : 200 * ((2 * j) / (n - 1) - 1));
  const db = (amplitude) => (amplitude > 3e-5 ? Number((20 * Math.log10(amplitude)).toFixed(2)) : null);
  // the voices of n: each [cents, left, right] (dB against one voice: the main lobe of a Hann at its peak, null not
  // heard)
  const voices = (channels, n, one = 1) => {
    const [l, r] = channels.map(spectrum);
    const bin = (c) => (C4 * 2 ** (c / 1200) * N) / RATE;
    return Array.from({ length: n }, (_, j) => {
      let best = Math.round(bin(cents(j, n)));
      for (let k = Math.floor(bin(cents(j, n) - 8)); k <= Math.ceil(bin(cents(j, n) + 8)); k++)
        if (l[k] + r[k] > l[best] + r[best]) best = k;
      const amplitude = (s) => Math.hypot(s[best - 1], s[best], s[best + 1]) / one;
      return [Math.round(cents(j, n)), db(amplitude(l)), db(amplitude(r))];
    });
  };
  const play = (job, state, params, { seconds = 6, note = 60, automation } = {}) =>
    hostRender(`blend-${job}`, {
      seconds,
      state,
      params: { ...FLAT, 'A Uni Detune': 1, ...params },
      automation,
      notes: [{ note, on: 0, off: seconds }],
    });
  // a render measured, again while a voice of it isn't heard (now and then the AU plays a job at the params of its
  // state, one voice: it loaded the state after them)
  const measured = async (render, measure, tries = 3) => {
    const result = measure(await render());
    const heard = (result.voices ?? result).every((row) => row.slice(1).some((v) => v !== null));
    if (heard || tries === 1) return result;
    return measured(render, measure, tries - 1);
  };
  const MACRO = { source: 25, osc: 0, param: 27, name: 'kParamDetuneWid' };
  const BLENDS = Array.from({ length: 21 }, (_, i) => i / 20);
  const ROUTES = [
    { blend: 0, amount: 1, bipolar: false },
    { blend: 0.5, amount: 0.5, bipolar: false },
    { blend: 0.5, amount: 1, bipolar: false },
    { blend: 0.5, amount: 1, bipolar: true },
    { blend: 1, amount: -1, bipolar: false },
  ];
  const POINTS = [
    [0.5, 0],
    [2.5, 1],
    [4.5, 0],
  ];
  try {
    writeTable(join(tables(), path), [sine()], '00000000');
    written.push(join(tables(), path));
    const plain = stateOf(name, [{ path, frames: 1 }]);
    const [one] = (await play('u1', plain, { 'A Unison': 0 })).map((x) => {
      const s = spectrum(x);
      const k = Math.round((C4 * N) / RATE);
      return Math.hypot(s[k - 1], s[k], s[k + 1]);
    });
    const levels = {};
    const routes = [];
    const moving = {};
    const jobs = [];
    for (let n = 2; n <= 8; n++)
      for (const blend of BLENDS)
        jobs.push(
          measured(
            () => play(`u${n}-${blend}`, plain, { 'A Unison': (n - 1) / 15, 'A Uni Blend': blend }),
            (x) => voices(x, n, one)
          ).then((result) => {
            levels[`u${n} ${blend}`] = result;
          })
        );
    ROUTES.forEach((route, i) => {
      const state = stateOf(
        `${name}-route${i}`,
        [{ path, frames: 1 }],
        [{ ...MACRO, amount: 100 * route.amount, bipolar: route.bipolar }]
      );
      for (const level of [0, 0.25, 0.5, 0.75, 1])
        jobs.push(
          measured(
            () =>
              play(`route${i}-${level}`, state, {
                'A Unison': 4 / 15,
                'A Uni Blend': route.blend,
                'Macro 1': level,
              }),
            (x) => ({ ...route, level, voices: voices(x, 5, one) })
          ).then((result) => routes.push(result))
        );
    });
    // the level of a centre voice (u5 its middle one, u4 the lower of its middle two: left) and of the lowest one
    // (right) every 50 ms, over 40 ms (Hann), against one voice at C7
    const macro = stateOf(`${name}-macro`, [{ path, frames: 1 }], [{ ...MACRO, amount: 100 }]);
    const C7 = 8 * C4;
    const window = Math.round(0.04 * RATE);
    const amplitude = (x, frequency, from) => {
      let re = 0;
      let im = 0;
      let sum = 0;
      for (let i = 0; i < window; i++) {
        const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (window - 1));
        const phase = (2 * Math.PI * frequency * (from + i)) / RATE;
        re += x[from + i] * w * Math.sin(phase);
        im += x[from + i] * w * Math.cos(phase);
        sum += w;
      }
      return (2 * Math.hypot(re, im)) / sum;
    };
    const [high] = await play('u1-c7', plain, { 'A Unison': 0 }, { seconds: 1, note: 96 });
    const highOne = amplitude(high, C7, Math.round(0.5 * RATE));
    for (const n of [4, 5])
      for (const [how, state, param] of [
        ['knob', plain, 'A Uni Blend'],
        ['macro', macro, 'Macro 1'],
      ])
        jobs.push(
          measured(
            () =>
              play(
                `moving-u${n}-${how}`,
                state,
                { 'A Unison': (n - 1) / 15, 'A Uni Blend': 0 },
                { seconds: 5, note: 96, automation: [{ name: param, points: POINTS }] }
              ),
            ([l, r]) => {
              const centre = cents((n - 1) >> 1, n);
              return Array.from({ length: 89 }, (_, k) => {
                const t = Number((0.3 + 0.05 * k).toFixed(2));
                const from = Math.round(t * RATE) - window / 2;
                return [
                  t,
                  db(amplitude(l, C7 * 2 ** (centre / 1200), from) / highOne),
                  db(amplitude(r, C7 * 2 ** (cents(0, n) / 1200), from) / highOne),
                ];
              });
            }
          ).then((result) => {
            moving[`u${n} ${how}`] = result;
          })
        );
    await Promise.all(jobs);
    const sorted = (o) =>
      Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })));
    routes.sort(
      (a, b) => a.blend - b.blend || a.amount - b.amount || a.bipolar - b.bipolar || a.level - b.level
    );
    writeFileSync(
      join(out, 'blend.json'),
      `${JSON.stringify(
        {
          about:
            'Osc A of the init patch of the Audio Unit on a sine (a table of ours) at C4, Detune 1 (linear: voice j of n at 200 · (2j / (n - 1) - 1) cents), Width 1, the phase 0 of every voice: `levels` each voice of `u<n> <A Uni Blend>` [cents, left, right] (dB against one voice: the main lobe of a Hann at its peak; null not heard); `routes` u5 with Macro 1 routed to A Uni Blend (a mod slot of its state: kParamDetuneWid) at `amount` of its travel (uni, or `bipolar`) from the knob at `blend`, the macro at `level`; `moving` the blend from 0 up to 1 over 0.5..2.5 s and back to 0 at 4.5 s by the knob (automated) or Macro 1 (amount 1 from 0), at C7: [seconds, a centre voice in its left (u5 the middle one, u4 the lower of the middle two), the lowest one in its right] every 50 ms over 40 ms (Hann) against one voice; scripts/renders/run.mjs --only=blend',
          levels: sorted(levels),
          routes,
          moving: sorted(moving),
        },
        null,
        1
      )}\n`
    );
    console.log(
      `dsp/measurements: the blend of ${Object.keys(levels).length} unisons, ${routes.length} routes`
    );
  } finally {
    removeTables();
  }
}

// --- aliasing ---
if (runs('aliasing')) {
  const RATES = [44100, 48000, 96000];
  // the frames of a table of the bucket (mono float32, frames of 2048 samples, 256 at most: as the benchmark reads it)
  const framesOf = (file) => {
    const bytes = readFileSync(file);
    let float = false;
    for (let at = 12; at + 8 <= bytes.length;) {
      const id = bytes.toString('latin1', at, at + 4);
      const size = bytes.readUInt32LE(at + 4);
      if (id === 'fmt ') float = bytes.readUInt16LE(at + 8) === 3 && bytes.readUInt16LE(at + 22) === 32;
      if (id === 'data') {
        if (!float) throw new Error(`${file}: not float32`);
        const start = bytes.byteOffset + at + 8;
        const samples = new Float32Array(bytes.buffer.slice(start, start + size));
        return Array.from({ length: Math.min(256, Math.floor(samples.length / 2048)) }, (_, k) => [
          ...samples.subarray(k * 2048, (k + 1) * 2048),
        ]);
      }
      at += 8 + size + (size & 1);
    }
    throw new Error(`${file}: no data`);
  };
  const tablesDir = join(root, 'tmp/bench-osc/tables');
  await downloadTables(TABLES, tablesDir);
  const sources = [
    ['saw', sawFrame()],
    ...TABLES.map((key) => {
      const frames = framesOf(join(tablesDir, fileName(key)));
      return [fileName(key), frames[frameOf(frames)]];
    }),
  ];
  // the note nearest to a pitch of the benchmark (it plays 1046 Hz, the AU C6 at 1046.5), the frequency of it the
  // AU plays: the one within ±1 cent (by 0.05) the fundamental is loudest at (the bands of the analysis are ±14
  // bins wide: a harmonic 400 of 55 Hz 0.025 cent off is within 0.3 Hz)
  const noteOf = (pitch) => Math.round(69 + 12 * Math.log2(pitch / 440));
  const fundamental = loudestFundamental;
  const round = (value) => Number(value.toFixed(1));
  try {
    const results = {};
    const floor = {};
    const jobs = [];
    // a note of osc A at one voice on the frame (a table of it alone): its left channel, SIZE samples after 0.25 s
    const play = (name, state, rate, note) =>
      hostRender(name, {
        rate,
        seconds: SIZE / rate + 0.25,
        state,
        params: { ...FLAT, 'A Unison': 0 },
        notes: [{ note, on: 0, off: SIZE / rate + 0.25 }],
      }).then(([left]) => {
        if (left.length < SIZE) throw new Error(`${name}: ${left.length} samples`);
        return left;
      });
    // the floor of the stand: a sine (the patch adds nothing to the oscillator)
    const sineState = tableState('alias-sine', [sine()]);
    for (const rate of RATES)
      jobs.push(
        play(`alias-sine-${rate}`, sineState, rate, 57).then((left) => {
          floor[rate] = round(analyze(left, fundamental(left, rate, 57), rate, sine()).aliasing);
        })
      );
    sources.forEach(([table, frame], t) => {
      const state = tableState(`alias-${t}`, [frame]);
      for (const rate of RATES) {
        const rows = ((results[rate] ??= {})[table] = []);
        PITCHES.forEach((pitch, p) => {
          const note = noteOf(pitch);
          jobs.push(
            play(`alias-${t}-${rate}-${note}`, state, rate, note).then((left) => {
              const frequency = fundamental(left, rate, note);
              const { aliasing, spur, highest } = analyze(left, frequency, rate, frame);
              rows[p] = {
                pitch,
                note,
                frequency: Number(frequency.toFixed(3)),
                aliasing: round(aliasing),
                spur: round(spur),
                highest,
              };
            })
          );
        });
      }
    });
    await Promise.all(jobs);
    writeFileSync(
      join(out, 'aliasing.json'),
      `${JSON.stringify(
        {
          about:
            'Osc A of the init patch of the Audio Unit at one voice on a table of one frame: the frame the oscillator benchmark compares (scripts/bench-osc/sound.mjs: the saw, the middle frame of each of its tables), a note of each of its pitches (the nearest one: 1046 Hz is C6 at 1046.5) at each of its rates; `analyze` of the benchmark over the last 65536 samples (from 0.25 s on), at the frequency the fundamental is loudest at within ±1 cent of the note: `aliasing` the power outside the harmonics against theirs, `spur` the loudest bin outside them against the fundamental (dB), `highest` the highest harmonic played at half its amplitude in the frame at least; `floor` the aliasing of a sine at A3 (the noise of the stand); scripts/renders/run.mjs --only=aliasing',
          floor,
          rates: results,
        },
        null,
        1
      )}\n`
    );
    console.log(
      `dsp/measurements: aliasing of ${sources.length} tables at ${
        RATES.length
      } rates, floor ${JSON.stringify(floor)}`
    );
  } finally {
    removeTables();
  }
}

// --- noise ---
if (runs('noise')) {
  // samples of ours (float32 at 44.1 kHz) written into User of the noises of the Audio Unit, removed after; the
  // init state with osc A off and the noise on one of them, at Level 1, ENV 1 open
  const samples = [];
  const noiseState = (name, channels, params) => {
    const file = join(noisesFolder(), 'User', `chisper-test-${name}.wav`);
    writeSample(file, channels);
    samples.push(file);
    const state = join(work, `state-noise-${name}.bin`);
    writeFileSync(
      state,
      editedState(init, [], [], {
        path: `User/chisper-test-${name}.wav`,
        frames: channels[0].length,
        channels: channels.length,
        rate: 44100,
        params,
      })
    );
    return state;
  };
  const NOISE = { 'A Enable': 0, 'Noise Enable': 1, 'Noise Level': 1, 'Env 1 Attack': 0, 'Env 1 Sustain': 1 };
  const sineOf = (hz, seconds) =>
    Float64Array.from({ length: Math.round(seconds * 44100) }, (_, i) =>
      Math.sin((2 * Math.PI * hz * i) / 44100)
    );
  const play = (name, state, params, notes = held()) =>
    hostRender(name, { seconds: 1.6, state, params: { ...NOISE, ...params }, notes });
  // L the sine, R the cosine of one turn over 2 s: the share of the sample a frame reads is atan2(L, R) / 2π
  const TURN = 2 * 44100;
  const turn = [0, 1].map((c) =>
    Float64Array.from({ length: TURN }, (_, i) => (c ? Math.cos : Math.sin)((2 * Math.PI * i) / TURN))
  );
  const shareAt = (l, r, k) => (Math.atan2(l[k], r[k]) / (2 * Math.PI) + 1) % 1;
  // the share each note of `ons` starts at: 8 frames after its first sound, less the 8 · 44100 / RATE samples it read
  const startShares = (l, r, ons) =>
    ons.map((on) => {
      let i = Math.round(on * RATE) - 64;
      while (Math.abs(l[i]) + Math.abs(r[i]) < 1e-6) i++;
      return +((shareAt(l, r, i + 8) - (8 * 44100) / RATE / TURN + 1) % 1).toFixed(4);
    });
  try {
    const sine = noiseState('sine', [sineOf(1000, 3)]);
    const pair = noiseState('pair', [sineOf(1000, 3), sineOf(1500, 3)]);
    const turned = noiseState('turn', turn);
    const shot = noiseState('shot', turn, { kParamOneShot: { f32: 1 } });
    const short = noiseState(
      'short',
      turn.map((c) => c.slice(0, 22050)),
      { kParamOneShot: { f32: 1 } }
    );
    const PITCHES = [0, 0.1, 0.2, 0.25, 0.3, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7, 0.75, 0.8, 0.9, 1];
    const pitch = PITCHES.filter((v) => v >= 0.25).map((v) =>
      play(`noise-pitch-${v}`, sine, { 'Noise Pitch': v }).then(([l]) => [v, semitones(l, 1000)])
    );
    const fine = [0, 0.25, 0.75, 1].flatMap((f) =>
      [0.4, 0.5, 0.6].map((p) =>
        play(`noise-fine-${p}-${f}`, sine, { 'Noise Pitch': p, 'Noise Fine': f }).then(([l]) => [
          p,
          f,
          semitones(l, 1000),
        ])
      )
    );
    const track = [36, 60, 61, 72, 84].map((note) =>
      play(`noise-track-${note}`, sine, { 'Noise Pitch Track': 1 }, held(note)).then(([l]) => [
        note,
        semitones(l, 1000),
      ])
    );
    const bend = [0, 1].map((on) =>
      play(`noise-bend-${on}`, sine, { 'Noise Pitch Track': on, 'Pitch Bend': 1 }).then(([l]) => [
        !!on,
        semitones(l, 1000),
      ])
    );
    const level = [1, 0.75, 0.5, 0.25, 0.1].map((v) =>
      play(`noise-level-${v}`, sine, { 'Noise Level': v }).then(([l]) => [v, amplitude(l, 1000)])
    );
    // osc A on a sine of ours at A Level 1 against the noise on a sine at Level 1: the same scale?
    const frame = Array.from({ length: 2048 }, (_, i) => Math.sin((2 * Math.PI * i) / 2048));
    writeTable(join(tables(), 'User', 'chisper-test-noise-sine.wav'), [frame], '00000000');
    written.push(join(tables(), 'User', 'chisper-test-noise-sine.wav'));
    const oscillator = hostRender('noise-osc', {
      seconds: 1.6,
      state: stateOf('noise-osc', [{ path: 'User/chisper-test-noise-sine.wav', frames: 1 }]),
      params: { 'A Level': 1, 'Env 1 Attack': 0, 'Env 1 Sustain': 1 },
      notes: held(),
    }).then(([l]) => amplitude(l, 440 * 2 ** (3 / 12)));
    const pan = Array.from({ length: 21 }, (_, k) => k / 20).map((v) =>
      Promise.all([
        play(`noise-pan-${v}`, sine, { 'Noise Pan': v }),
        play(`noise-pan2-${v}`, pair, { 'Noise Pan': v }),
      ]).then(([[l, r], [sl, sr]]) => ({
        v,
        mono: [amplitude(l, 1000), amplitude(r, 1000)],
        stereo: [amplitude(sl, 1000), amplitude(sl, 1500), amplitude(sr, 1000), amplitude(sr, 1500)],
      }))
    );
    // notes every 0.25 s; the Audio Unit draws the same random shares in every render
    const ons = Array.from({ length: 16 }, (_, j) => 0.1 + j * 0.25);
    const notes = ons.map((on) => ({ note: 72, on, off: on + 0.2 }));
    const starts = (name, state, params) =>
      hostRender(name, {
        seconds: 4.3,
        state,
        params: { ...NOISE, 'Env 1 Release': 0, ...params },
        notes,
      }).then(([l, r]) => startShares(l, r, ons));
    const phase = [0, 0.25, 0.5, 0.9].map((v) =>
      // (a share of 1 is 0: the start of the loop)
      starts(`noise-phase-${v}`, turned, { 'Noise Phase': v }).then((s) => [v, median(s) % 1])
    );
    const rand = [1, 0.75, 0.5, 0.25, 0.1].map((v) =>
      starts(`noise-rand-${v}`, turned, { 'Noise Rand Phase': v }).then((s) => [v, s])
    );
    const late = [
      ['loop', turned],
      ['oneShot', shot],
    ].map(([mode, state]) =>
      starts(`noise-late-${mode}`, state, { 'Noise Phase': 0.8, 'Noise Rand Phase': 0.5 }).then((s) => [
        mode,
        s,
      ])
    );
    // a sample of 0.5 s held 1.45 s: the last frame it sounds at
    const end = [
      [
        'loop',
        noiseState(
          'short-loop',
          turn.map((c) => c.slice(0, 22050))
        ),
      ],
      ['oneShot', short],
    ].map(([mode, state]) =>
      play(`noise-end-${mode}`, state, {}).then(([l, r]) => {
        let last = 0;
        for (let i = 0; i < l.length; i++) if (Math.abs(l[i]) + Math.abs(r[i]) > 1e-6) last = i;
        return [mode, +(last / RATE - 0.05).toFixed(3)];
      })
    );
    // mono, notes at 0.1, 0.6 and 1.1 s held: the share read just before and just after each one
    const mono = [
      [0, 0],
      [1, 0],
      [0, 1],
    ].map(([legato, randPhase]) =>
      hostRender(`noise-mono-${legato}-${randPhase}`, {
        seconds: 2.4,
        state: turned,
        params: { ...NOISE, 'Mono Toggle': 1, Legato: legato, 'Noise Rand Phase': randPhase },
        notes: [0.1, 0.6, 1.1].map((on, j) => ({ note: 72 + 2 * j, on, off: 2.2 })),
      }).then(([l, r]) => ({
        legato: !!legato,
        rand: randPhase,
        shares: [0.59, 0.61, 1.09, 1.11].map((t) => [t, +shareAt(l, r, Math.round(t * RATE)).toFixed(4)]),
      }))
    );
    // a sine of 15 kHz (44.1 kHz) by pitch: the tone and the loudest other component 200 Hz off it at least (dB)
    const fifteen = noiseState('fifteen', [sineOf(15000, 3)]);
    const quality = [0, 1, 12, -12, -24].map((st) =>
      // (spectrum reads 2^18 samples from 0.2 s)
      hostRender(`noise-quality-${st}`, {
        seconds: 6,
        state: fifteen,
        params: { ...NOISE, 'Noise Pitch': 0.5 + st / (st < 0 ? 384 : 96) },
        notes: [{ note: 72, on: 0.05, off: 5.9 }],
      }).then(([l]) => {
        const x = spectrum(l);
        let main = 1;
        for (let k = 1; k < x.length; k++) if (x[k] > x[main]) main = k;
        const hz = (k) => (k * RATE) / N;
        let other = 1;
        for (let k = 1; k < x.length; k++) if (Math.abs(hz(k) - hz(main)) > 200 && x[k] > x[other]) other = k;
        return {
          st,
          tone: [+hz(main).toFixed(1), dB(x[main])],
          other: [+hz(other).toFixed(1), dB(x[other])],
        };
      })
    );
    const all = (list) => Promise.all(list);
    const [center] = await all(level);
    const levels = await all(level);
    const pans = await all(pan);
    const centerPan = pans.find(({ v }) => v === 0.5);
    const rand1 = (await all(rand))[0][1];
    const result = {
      about:
        'The noise oscillator of the Audio Unit (osc A off, the noise on samples of ours: float32 at 44.1 kHz in User of its noises, at Level 1, ENV 1 open; notes of C5 held 0.05..1.5 s, measured over 0.3..1.3 s): `pitch` [knob, semitones] of the sample played (Pitch Track off; a sine of 1 kHz); `fine` [Pitch, Fine knob, semitones]; `track` [note, semitones] with Pitch Track on; `bend` [Pitch Track, semitones] at Pitch Bend 1 (Bend Up 2); `level` [knob, dB against Level 1]; `oscillator` the noise at Level 1 over osc A at A Level 1, both on a sine of amplitude 1; `pan` [knob, left, right] of a mono sample against the centre, `stereo` [knob, L of the left channel, R of the left channel, L of the right channel, R of the right channel] of a stereo one (dB against the centre); `phase` [knob, the share of the sample a note starts at]; `rand` [knob, the span of the shares against those of Rand 1 (the same draws in every render)]; `late` the shares of notes at Phase 0.8, Rand 0.5, looped and one-shot; `end` [mode, the seconds a sample of 0.5 s sounds]; `mono` the shares read around notes of mono (0.1, 0.6, 1.1 s); `quality` a sine of 15 kHz by semitones: the tone and the loudest other component [Hz, dB full scale]; scripts/renders/run.mjs --only=noise',
      pitch: await all(pitch),
      fine: await all(fine),
      track: await all(track),
      bend: await all(bend),
      level: levels.map(([v, a]) => [v, dB(a / center[1])]),
      oscillator: +(center[1] / (await oscillator)).toFixed(5),
      pan: pans.map(({ v, mono: [l, r] }) => [
        v,
        +(l / centerPan.mono[0]).toFixed(5),
        +(r / centerPan.mono[1]).toFixed(5),
      ]),
      stereo: pans
        .filter(({ v }) => [0, 0.25, 0.5, 0.75, 1].includes(v))
        .map(({ v, stereo }) => [v, ...stereo.map((a, i) => dB(a / centerPan.stereo[i < 2 ? 0 : 3]))]),
      phase: await all(phase),
      rand: (await all(rand)).map(([v, s]) => [v, +median(s.map((share, i) => share / rand1[i])).toFixed(4)]),
      late: Object.fromEntries(await all(late)),
      end: Object.fromEntries(await all(end)),
      mono: await all(mono),
      quality: await all(quality),
    };
    writeFileSync(join(out, 'noise.json'), `${JSON.stringify(result, null, 1)}\n`);
    console.log(
      'dsp/measurements: noise',
      JSON.stringify({ oscillator: result.oscillator, rand: result.rand })
    );
  } finally {
    samples.forEach((file) => rmSync(file, { force: true }));
    removeTables();
  }
}

// --- sub ---
if (runs('sub')) {
  // the init state with osc A off and the sub on at Level 1, ENV 1 open and closing in 0.3 ms (at Release 0 a held
  // note stops after about 1 s)
  const SUB = {
    'A Enable': 0,
    'Sub Enable': 1,
    'Sub Level': 1,
    'Env 1 Attack': 0,
    'Env 1 Sustain': 1,
    'Env 1 Release': 0.1,
  };
  const SHAPES = ['sine', 'roundRect', 'triangle', 'saw', 'square', 'pulse'];
  // the knob of shape i (the Audio Unit takes floor(6v))
  const shapeOf = (i) => (i + 0.5) / 6;
  const hz = (note) => 440 * 2 ** ((note - 69) / 12);
  const play = (name, params, notes = held(), seconds = 1.6) =>
    hostRender(`sub-${name}`, { seconds, params: { ...SUB, ...params }, notes });
  const turns = (v) => +(((v % 1) + 1) % 1).toFixed(4);
  // the sample a note at `on` s starts at: the host sends it at the start of its block of 64 (the sub sounds about
  // 3.7 samples after it: `start`)
  const onset = (on) => Math.floor((on * RATE) / 64) * 64;
  // the phase (turns of a sine) at sample `at` of a tone of `f` in x: read over 0.1 s from 10 ms after `at` (or
  // up to 10 ms before it)
  const phaseAt = (x, f, at, before = false) => {
    const start = before ? at - 5280 : at + 480;
    return turns(tone(x, f, start, 4800).phase / 360 + (f * at) / RATE);
  };
  const sineState = tableState('sub-sine', [sine()]);
  // osc A on a sine of ours at A Level 1, the sub off
  const OSC = { 'A Level': 1, 'A Rand Phase': 0, 'A Phase': 0, 'Env 1 Attack': 0, 'Env 1 Sustain': 1 };
  try {
    // the harmonics 1..40 of each shape at C2: [amplitude, phase against n × the phase of the first (degrees)]
    const NOTE_SHAPE = 36;
    const shapes = SHAPES.map((shape, i) =>
      play(`shape-${shape}`, { 'Sub Shape': shapeOf(i) }, held(NOTE_SHAPE)).then(([l]) => {
        const parts = Array.from({ length: 40 }, (_, j) => tone(l, hz(NOTE_SHAPE) * (j + 1), from, RATE));
        const first = parts[0].phase;
        return [
          shape,
          parts.map(({ amplitude: a, phase }, j) => [
            +a.toFixed(5),
            +(((((phase - (j + 1) * first) % 360) + 540) % 360) - 180).toFixed(1),
          ]),
        ];
      })
    );
    // one cycle of each shape at C1 at Phase 0: 128 points of its second cycle from the note on
    const NOTE_CYCLE = 24;
    const cycles = SHAPES.map((shape, i) =>
      play(
        `cycle-${shape}`,
        { 'Sub Shape': shapeOf(i) },
        [{ note: NOTE_CYCLE, on: 0.05, off: 0.5 }],
        0.6
      ).then(([l]) => {
        const period = RATE / hz(NOTE_CYCLE);
        const at = onset(0.05) + period;
        return [
          shape,
          Array.from({ length: 128 }, (_, k) => {
            const t = at + (k * period) / 128;
            const i0 = Math.floor(t);
            return +(l[i0] + (l[i0 + 1] - l[i0]) * (t - i0)).toFixed(4);
          }),
        ];
      })
    );
    const oscillator = hostRender('sub-osc', {
      seconds: 1.6,
      state: sineState,
      params: OSC,
      notes: held(),
    }).then(([l]) => amplitude(l, hz(72)));
    const level = [1, 0.75, 0.5, 0.25, 0.1].map((v) =>
      play(`level-${v}`, { 'Sub Level': v }).then(([l]) => [v, amplitude(l, hz(72))])
    );
    const pan = Array.from({ length: 21 }, (_, k) => k / 20).map((v) =>
      play(`pan-${v}`, { 'Sub Pan': v }).then(([l, r]) => [v, amplitude(l, hz(72)), amplitude(r, hz(72))])
    );
    const octave = [-4, -3, -2, -1, 0, 1, 2, 3, 4].map((o) =>
      play(`octave-${o}`, { 'Sub Octave': (o + 4) / 8 }).then(([l]) => [o, semitones(l, hz(72))])
    );
    const coarse = [0, 0.1, 0.25, 0.4, 0.45, 0.49, 0.5, 0.51, 0.55, 0.6, 0.75, 0.9, 1].map((v) =>
      play(`coarse-${v}`, { 'Sub Coarse Pitch': v }).then(([l]) => [v, semitones(l, hz(72))])
    );
    const both = [
      [0.25, 0.6],
      [0.75, 0.4],
    ].map(([o, c]) =>
      play(`pitch-${o}-${c}`, { 'Sub Octave': o, 'Sub Coarse Pitch': c }).then(([l]) => [
        o,
        c,
        semitones(l, hz(72)),
      ])
    );
    const bend = play('bend', { 'Pitch Bend': 1 }).then(([l]) => semitones(l, hz(72)));
    const track = [60, 72].map((note) =>
      play(`track-${note}`, { 'Sub Pitch Track': 0 }, held(note)).then(([l]) => [
        note,
        +frequency(l).toFixed(2),
      ])
    );
    // mono, Porta Always: C4 at 0.05 s, C5 at 0.6 s (legato): the semitones over C4 every 20 ms from 0.56 s, of
    // the sub and of osc A on a sine
    const PORTA = { 'Mono Toggle': 1, 'Porta Always': 1, 'Porta Time': 0.3 };
    const portaNotes = [
      { note: 60, on: 0.05, off: 0.65 },
      { note: 72, on: 0.6, off: 1.5 },
    ];
    const glideOf = (l) =>
      Array.from({ length: 30 }, (_, k) => {
        const t = 0.56 + k * 0.02;
        return [+t.toFixed(2), semitones(l, hz(60), Math.round(t * RATE), 960)];
      });
    const porta = Promise.all([
      play('porta', PORTA, portaNotes),
      hostRender('sub-porta-osc', {
        seconds: 1.6,
        state: sineState,
        params: { ...OSC, ...PORTA },
        notes: portaNotes,
      }),
    ]).then(([[sub], [osc]]) => ({ sub: glideOf(sub), osc: glideOf(osc) }));
    // notes of C5 every 0.25 s, 0.2 s long: the phase each starts at by Phase
    const ons = Array.from({ length: 12 }, (_, j) => 0.1 + j * 0.25);
    const phase = [0, 0.25, 0.5, 0.75].map((v) =>
      play(
        `phase-${v}`,
        { 'Sub Phase': v },
        ons.map((on) => ({ note: 72, on, off: on + 0.2 })),
        3.2
      ).then(([l]) => [v, ons.map((on) => phaseAt(l, hz(72), onset(on)))])
    );
    // a note of C1, C3, C5 and C7 at Phase 0: the phase at the start of its block (the sine starts at 0.5 some
    // samples after it)
    const start = [24, 48, 72, 96].map((note) =>
      play(`start-${note}`, {}, [{ note, on: 0.05, off: 0.5 }], 0.6).then(([l]) => [
        note,
        phaseAt(l, hz(note), onset(0.05)),
      ])
    );
    // Cont. Phase (and Phase 0.25): the phase every note starts at and the one it has at its end
    const CONTIGUOUS = {
      gap: [
        [72, 0.1, 0.6],
        [72, 0.85, 1.3],
      ],
      longer: [
        [72, 0.1, 0.6],
        [72, 0.97, 1.3],
      ],
      other: [
        [72, 0.1, 0.6],
        [79, 0.85, 1.3],
      ],
      overlap: [
        [72, 0.1, 1.3],
        [79, 0.5, 1.3],
      ],
      three: [
        [72, 0.1, 1.4],
        [76, 0.4, 1.4],
        [79, 0.7, 1.4],
      ],
    };
    const contiguous = Object.entries(CONTIGUOUS).map(([name, notes]) =>
      play(
        `contiguous-${name}`,
        { 'Sub Cont. Phase': 1, 'Sub Phase': 0.25 },
        notes.map(([note, on, off]) => ({ note, on, off })),
        1.6
      ).then(([l]) => [
        name,
        notes.map(([note, on, off]) => [
          note,
          on,
          off,
          phaseAt(l, hz(note), onset(on)),
          phaseAt(l, hz(note), onset(off), true),
        ]),
      ])
    );
    // mono: C5 held from 0.1 s, G5 from 0.6 s: the phase of C5 at 0.6 s and the one G5 starts at, by Legato and
    // Cont. Phase (Phase 0.25)
    const mono = [
      [0, 0],
      [1, 0],
      [0, 1],
    ].map(([legato, cont]) =>
      play(
        `mono-${legato}-${cont}`,
        { 'Mono Toggle': 1, Legato: legato, 'Sub Cont. Phase': cont, 'Sub Phase': 0.25 },
        [
          { note: 72, on: 0.1, off: 0.65 },
          { note: 79, on: 0.6, off: 1.3 },
        ]
      ).then(([l]) => [
        !!legato,
        !!cont,
        phaseAt(l, hz(72), onset(0.6), true),
        phaseAt(l, hz(79), onset(0.6)),
      ])
    );
    // saw and square by note: the fundamental and the loudest component 20 Hz off every harmonic (dB full scale)
    const quality = ['saw', 'square'].flatMap((shape) =>
      [84, 96, 108].map((note) =>
        play(
          `quality-${shape}-${note}`,
          { 'Sub Shape': shapeOf(SHAPES.indexOf(shape)) },
          [{ note, on: 0.05, off: 5.9 }],
          6
        ).then(([l]) => {
          const x = spectrum(l);
          const f0 = hz(note);
          const bin = (k) => (k * RATE) / N;
          let other = 1;
          for (let k = 1; k < x.length; k++) {
            const off = Math.abs(bin(k) / f0 - Math.round(bin(k) / f0)) * f0;
            if (off > 20 && x[k] > x[other]) other = k;
          }
          return {
            shape,
            note,
            tone: dB(x[Math.round((f0 * N) / RATE)]),
            other: [+bin(other).toFixed(1), dB(x[other])],
          };
        })
      )
    );
    const all = (list) => Promise.all(list);
    const levels = await all(level);
    const pans = await all(pan);
    const center = pans.find(([v]) => v === 0.5);
    const result = {
      about:
        'The sub oscillator of the Audio Unit (osc A off, the sub at Level 1, ENV 1 open, release 0; notes of C5 held 0.05..1.5 s, measured over 0.3..1.3 s at 48 kHz): `shapes` [shape, the harmonics 1..40 at C2: [amplitude, phase against n × the phase of the first, degrees]]; `cycles` [shape, one cycle at C1 at Phase 0: 128 points of its second cycle from the note on]; `oscillator` the sub (sine) at Level 1 over osc A at A Level 1 on a sine; `level` [knob, dB against Level 1]; `pan` [knob, left, right] against the centre; `octave` [Octave, semitones]; `coarse` [knob, semitones]; `pitch` [Octave knob, Coarse knob, semitones]; `bend` the semitones at Pitch Bend 1 (Bend Up 2); `track` [note, Hz] with Sub Pitch Track off; `porta` mono, Porta Always, Porta Time 0.3: C4 at 0.05 s, C5 at 0.6 s, [s, semitones over C4] of the sub and of osc A on a sine; `phase` [knob, the phase (turns of a sine) notes of C5 every 0.25 s start at]; `start` [note, the phase at the start of the block of its note on at Phase 0]; `contiguous` Cont. Phase on, Phase 0.25: [scenario, [note, on, off, the phase at its on, the phase at its off]] (the phases at the starts of the blocks of the events: the host sends them at the start of their block of 64); `mono` [Legato, Cont. Phase, the phase of C5 at 0.6 s, the phase G5 starts at at 0.6 s] (Phase 0.25); `quality` saw and square by note: the fundamental and the loudest component 20 Hz off every harmonic [Hz, dB full scale]; scripts/renders/run.mjs --only=sub',
      shapes: Object.fromEntries(await all(shapes)),
      cycles: Object.fromEntries(await all(cycles)),
      oscillator: +(levels[0][1] / (await oscillator)).toFixed(5),
      level: levels.map(([v, a]) => [v, dB(a / levels[0][1])]),
      pan: pans.map(([v, l, r]) => [v, +(l / center[1]).toFixed(5), +(r / center[2]).toFixed(5)]),
      octave: await all(octave),
      coarse: await all(coarse),
      pitch: await all(both),
      bend: await bend,
      track: await all(track),
      porta: await porta,
      phase: await all(phase),
      start: await all(start),
      contiguous: Object.fromEntries(await all(contiguous)),
      mono: await all(mono),
      quality: await all(quality),
    };
    writeFileSync(join(out, 'sub.json'), `${JSON.stringify(result, null, 1)}\n`);
    console.log(
      'dsp/measurements: sub',
      JSON.stringify({ oscillator: result.oscillator, bend: result.bend })
    );
  } finally {
    removeTables();
  }
}

// --- the effect rack ---
// a stand of an effect of the rack: samples of ours (44.1 kHz: the noise oscillator plays them as they are, no
// resampling, one-shot, osc A off) through the rack with the effect `fx` ({ module, type, params, kept } of
// state.mjs; null: an empty rack, the dry signal), rendered at `rate` (another one than that of the samples: the
// noise oscillator resamples them, alike in a render with the effect and in the dry one). `valid`: whether a
// render is of the sample (another run of the stand at once without the lock: the init patch, its sample); one
// that is not is rendered again. `play` takes more of the job of the host (`bpm`), the mod slots of its state
// (`slots`, of state.mjs) and params over those of the stand (`params`: a macro, the rate of an LFO; set before the
// render: a macro the host moves while it renders never reaches an effect of the rack)
const RACK_RATE = 44100;
const rackStand = (tag, rate = RACK_RATE, valid = () => true) => {
  const R = RACK_RATE;
  const samples = [];
  const NOISE = { 'A Enable': 0, 'Noise Enable': 1, 'Noise Level': 1, 'Env 1 Attack': 0, 'Env 1 Sustain': 1 };
  const sampleOf = (name, channels) => {
    const file = join(noisesFolder(), 'User', `chisper-test-${tag}-${name}.wav`);
    writeSample(file, channels);
    samples.push(file);
    return {
      path: `User/chisper-test-${tag}-${name}.wav`,
      frames: channels[0].length,
      channels: channels.length,
      rate: R,
      params: { kParamOneShot: { f32: 1 } },
    };
  };
  let renders = 0;
  // renders of one sample run together, those of another wait for them (hosts loading different samples of the
  // noise oscillator at once have played the sample of another)
  let lane = Promise.resolve();
  let laneSample = null;
  let laneJobs = [];
  const played = new Map();
  // `more`: the mod slots of the state (`slots` of editedState), parameters of the host set (`params`), the rest
  // of a job of the host (`automation`, set every `step` samples: host.swift)
  const render = (sample, fx, more) => {
    if (laneSample !== sample.path) {
      const before = laneJobs;
      lane = lane.then(() => Promise.allSettled(before));
      laneSample = sample.path;
      laneJobs = [];
    }
    const name = `${tag}-${renders++}`;
    const state = join(work, `state-${name}.bin`);
    const { slots = [], params = {}, ...rest } = more ?? {};
    writeFileSync(state, editedState(init, [], slots, sample, fx && [fx]));
    const seconds = sample.frames / R + 0.3;
    const once = async (attempt) => {
      for (let again = 0; ; again++) {
        const channels = await hostRender(`${name}-${attempt}`, {
          rate,
          seconds,
          state,
          params: { ...NOISE, ...params },
          notes: [{ note: 72, on: 0.05, off: seconds - 0.02 }],
          ...rest,
        });
        if (valid(channels)) return channels;
        if (again > 8) throw new Error(`${name}: never a render of its sample`);
      }
    };
    const same = (a, b) =>
      a.every((channel, c) => channel.every((value, i) => Math.abs(value - b[c][i]) < 1e-5));
    // rendered until two renders in a row agree (now and then a render is of another state: one in a hundred)
    const job = lane.then(() => untilAgree(name, once, same));
    laneJobs.push(job);
    return job;
  };
  // a sample through the rack, rendered once
  const play = (sample, fx, more) => {
    const key = `${sample.path} ${JSON.stringify(fx)} ${JSON.stringify(more)}`;
    if (!played.has(key)) played.set(key, render(sample, fx, more));
    return played.get(key);
  };
  return { sampleOf, play, remove: () => samples.splice(0).forEach((file) => rmSync(file, { force: true })) };
};

// where the click of the dry render at `at` comes out of a wet channel: its correlation with the dry click over
// the lags [-8, to), the peaks above `floor` of the dry one (parabolic): [lag in samples, gain]
const tapsOf = (wet, dry, at, to, floor) => {
  const W = 24;
  let auto = 0;
  for (let i = -W; i <= W; i++) auto += dry[at + i] ** 2;
  const lags = Float64Array.from({ length: to + 8 }, (_, k) => {
    let sum = 0;
    for (let i = -W; i <= W; i++) sum += dry[at + i] * (wet[at + k - 8 + i] ?? 0);
    return sum / auto;
  });
  const found = [];
  for (let k = 1; k < lags.length - 1; k++) {
    const [a, b, c] = [Math.abs(lags[k - 1]), Math.abs(lags[k]), Math.abs(lags[k + 1])];
    if (b <= floor || b < a || b <= c) continue;
    const shift = (a - c) / (2 * (a - 2 * b + c));
    found.push([k - 8 + shift, lags[k] - 0.25 * (lags[k - 1] - lags[k + 1]) * shift]);
  }
  return found;
};

// --- compressor ---
if (runs('compressor')) {
  const R = RACK_RATE;
  const stand = rackStand('comp');
  const { sampleOf } = stand;
  // a sample through the rack with a compressor of the plain params `comp` (null: an empty rack, the dry signal)
  const play = (sample, comp) =>
    stand.play(sample, comp === null ? null : { module: 'FXComp', type: 5, params: comp });
  const MULTI = { kParamMultiband: 1 };
  // a program of a sine of both channels in quadrature: [dB, seconds] one after another
  const program = (hz, segments, mono = false) => {
    const total = Math.round(segments.reduce((sum, [, seconds]) => sum + seconds, 0) * R);
    const channels = [new Float64Array(total), new Float64Array(total)];
    let i = 0;
    for (const [level, seconds] of segments) {
      const a = 10 ** (level / 20);
      for (let k = 0; k < Math.round(seconds * R); k++, i++) {
        const phase = (2 * Math.PI * hz * i) / R;
        channels[0][i] = a * Math.sin(phase);
        channels[1][i] = a * (mono ? Math.sin(phase) : Math.cos(phase));
      }
    }
    return channels;
  };
  const envelope = ([l, r]) => Float64Array.from(l, (v, i) => Math.hypot(v, r[i]));
  const round = (v, digits = 3) => +v.toFixed(digits);
  try {
    // the first sound of a render (the note on) and the level of the dry output against the sample
    const steady = sampleOf('steady', program(1000, [[-20, 1]]));
    const dryOf = async (sample) => envelope(await play(sample, null));
    const steadyDry = await dryOf(steady);
    const on = steadyDry.findIndex((v) => v > 1e-6);
    const output = steadyDry[on + R / 2] / 0.1;
    // the gain (dB) of a render against the dry one at seconds of the sample
    const gainAt = (wet, dry, seconds) => {
      const i = on + Math.round(seconds * R);
      return round(dB(wet[i] / dry[i]));
    };
    // --- one band ---
    // steps up and down of 1 kHz: -40 dB 0.4 s, -9 dB 1.2 s, -40 dB 1.6 s
    const step = sampleOf(
      'step',
      program(1000, [
        [-40, 0.4],
        [-9, 1.2],
        [-40, 1.6],
      ])
    );
    const stepDry = await dryOf(step);
    const stepped = async (comp) => envelope(await play(step, comp));
    // the peak is read: the attack 1 ms, the release 1 s, the threshold knob 0.7
    const PEAK = { kParamThresh: 0.7, kParamAttack: 1, kParamRelease: 1000 };
    const TIMES = [0.25, 0.5, 1, 2, 3, 5, 8, 12, 20, 30, 50, 80, 120, 200, 400];
    const trace = (wet, from) => TIMES.map((ms) => [ms, gainAt(wet, stepDry, from + ms / 1000)]);
    // the threshold by its knob: the reduction of a level held
    const threshold = Promise.all(
      [0.3, 0.4, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1].map(async (knob) => {
        const wet = await stepped({ ...PEAK, kParamThresh: knob });
        return [knob, gainAt(wet, stepDry, 1.5), gainAt(wet, stepDry, 0.35)];
      })
    );
    const ratio = Promise.all(
      [1, 1.5, 2, 3, 4, 8, 20].map(async (value) => {
        return [value, gainAt(await stepped({ ...PEAK, kParamRatio: value }), stepDry, 1.5)];
      })
    );
    const attack = Promise.all(
      [1, 10, 100].map(async (ms) => {
        const wet = await stepped({ ...PEAK, kParamAttack: ms });
        return [ms, trace(wet, 0.4)];
      })
    );
    const release = Promise.all(
      [10, 100, 1000].map(async (ms) => {
        const wet = await stepped({ ...PEAK, kParamRelease: ms });
        return [ms, [[0, gainAt(wet, stepDry, 1.59)], ...trace(wet, 1.6)]];
      })
    );
    // a fresh compressor: its attack and its release
    const fresh = stepped({ kParamThresh: 0.7 }).then((wet) => ({
      held: gainAt(wet, stepDry, 1.5),
      attack: trace(wet, 0.4),
      release: trace(wet, 1.6),
    }));
    const makeup = Promise.all(
      [2, 4, 16, 31].map(async (plain) => [
        round((plain - 1) / 30, 4),
        gainAt(await stepped({ kParamMakeup: plain, kParamThresh: 0 }), stepDry, 0.35),
      ])
    );
    const level = Promise.all(
      [0.25, 0.5, 0.75, 1].map(async (knob) => [
        knob,
        gainAt(await stepped({ kParamLevelOut: knob, kParamThresh: 0 }), stepDry, 0.35),
      ])
    );
    const mix = Promise.all(
      [0, 25, 50, 75, 100].map(async (wet) => [
        wet / 100,
        gainAt(await stepped({ ...PEAK, kParamWet: wet }), stepDry, 1.5),
      ])
    );
    // the link of the channels: the gain of the left one with the right one as loud, a quarter of it, silent
    const tones = (a, b) =>
      [0, 1].map((c) =>
        Float64Array.from({ length: 1.5 * R }, (_, i) => (c ? b : a) * Math.sin((2 * Math.PI * 1000 * i) / R))
      );
    const PEAK_LEVEL = 10 ** (-9 / 20);
    const link = Promise.all(
      [
        ['both', 1],
        ['quarter', 0.25],
        ['left', 0],
      ].map(async ([name, right]) => {
        const sample = sampleOf(`link-${name}`, tones(PEAK_LEVEL, PEAK_LEVEL * right));
        const [[dry], [wet]] = await Promise.all([play(sample, null), play(sample, PEAK)]);
        // (tone reads at RATE: the frequency as it is there)
        const read = (x) => tone(x, (1000 * RATE) / R, on + Math.round(0.8 * R), 8192).amplitude;
        return [name, round(dB(read(wet) / read(dry)))];
      })
    );
    // the highpass: sines with no compression (the threshold at 0 dB), the gain and the phase against the dry one
    const highpass = Promise.all(
      [5, 10, 20, 40, 100, 1000].map(async (hz) => {
        const sample = sampleOf(`hp-${hz}`, [
          Float64Array.from({ length: 3 * R }, (_, i) => 0.25 * Math.sin((2 * Math.PI * hz * i) / R)),
        ]);
        const [[dry], [wet]] = await Promise.all([play(sample, null), play(sample, { kParamThresh: 0 })]);
        const read = (x) => tone(x, (hz * RATE) / R, on + Math.round(0.8 * R), 2 * R);
        const [a, b] = [read(dry), read(wet)];
        return [hz, round(dB(b.amplitude / a.amplitude)), round(((b.phase - a.phase + 540) % 360) - 180, 1)];
      })
    );

    // --- three bands ---
    // the levels of a band, held 0.6 s each (after 1.2 s at the lowest): the gain at the end of each
    const LEVELS = Array.from({ length: 19 }, (_, k) => -72 + 4 * k);
    const ladder = (hz, mono = false) =>
      program(hz, [[-72, 1.2], ...LEVELS.map((value) => [value, 0.6])], mono);
    const BANDS = [
      ['low', 60],
      ['mid', 1000],
      ['high', 8000],
    ];
    const CURVES = {
      fresh: MULTI,
      'thresh 0.7': { ...MULTI, kParamThresh: 0.7 },
      'ratio 20': { ...MULTI, kParamRatio: 20 },
      'below 0.5': { ...MULTI, kParamRatioBelow: 0.5 },
      'below 1': { ...MULTI, kParamRatioBelow: 1 },
      'below 1, thresh 0.7': { ...MULTI, kParamRatioBelow: 1, kParamThresh: 0.7 },
    };
    const curves = Promise.all(
      BANDS.map(async ([name, hz]) => {
        const sample = sampleOf(`ladder-${name}`, ladder(hz));
        const dry = await dryOf(sample);
        const rows = await Promise.all(
          Object.entries(CURVES).map(async ([knobs, comp]) => {
            const wet = envelope(await play(sample, comp));
            return [knobs, LEVELS.map((_, k) => gainAt(wet, dry, 1.2 + (k + 0.95) * 0.6))];
          })
        );
        return [name, { hz, gains: Object.fromEntries(rows) }];
      })
    );
    // the detector of a band on a mono sine (both channels alike): the gain of its fundamental by level
    const monoSample = sampleOf('ladder-mono', ladder(220, true));
    const mono = Promise.all(
      ['fresh', 'thresh 0.7', 'below 1'].map(async (knobs) => {
        const comp = CURVES[knobs];
        const [[dry], [wet]] = await Promise.all([play(monoSample, null), play(monoSample, comp)]);
        const read = (x, k) =>
          tone(x, (220 * RATE) / R, on + Math.round((1.2 + (k + 0.6) * 0.6) * R), Math.round(0.2 * R))
            .amplitude;
        return [knobs, LEVELS.map((_, k) => round(dB(read(wet, k) / read(dry, k))))];
      })
    );
    // the release of a band: a step down of 1 kHz and of 8 kHz (0 dB 0.8 s after -40 dB 0.4 s, then -40 dB)
    const fall = (hz) =>
      program(hz, [
        [-40, 0.4],
        [0, 0.8],
        [-40, 3.2],
      ]);
    const midFall = sampleOf('fall-mid', fall(1000));
    const FALL = [20, 50, 100, 200, 400, 800, 1500, 2500];
    const falls = Promise.all(
      BANDS.slice(1).map(async ([name, hz]) => {
        const sample = name === 'mid' ? midFall : sampleOf(`fall-${name}`, fall(hz));
        const dry = await dryOf(sample);
        const rows = await Promise.all(
          [10, 90, 1000].map(async (ms) => {
            const wet = envelope(await play(sample, { ...MULTI, kParamRelease: ms }));
            return [
              ms,
              [[0, gainAt(wet, dry, 1.19)], ...FALL.map((t) => [t, gainAt(wet, dry, 1.2 + t / 1000)])],
            ];
          })
        );
        return [name, rows];
      })
    );
    // the attack of a band does not follow the knob: the gain after a step up at Attack 1 and 1000 ms
    const RISE = [2, 3, 5, 7, 10, 15, 20, 30, 50, 100];
    const rise = Promise.all(
      [1, 1000].map(async (ms) => {
        const dry = await dryOf(midFall);
        const wet = envelope(await play(midFall, { ...MULTI, kParamAttack: ms }));
        return [ms, RISE.map((t) => [t, gainAt(wet, dry, 0.4 + t / 1000)])];
      })
    );
    // a hit of 1 kHz at 0 dB and at -40 dB after a second of a tone at -72 dB (the bands at the ceiling of their
    // gain before it): the gain at each of its first samples, then by ms (after a silence from the start of a
    // render the first sound fades in over some 2.4 ms, which no silence after a sound brings back: `gaps`)
    const HIT_AT = 1;
    const HIT_SAMPLES = 32;
    const HIT_MS = [1, 2, 3, 5, 10, 20, 50, 100, 200];
    const onset = Promise.all(
      [
        ['0 dB', 0],
        ['-40 dB', -40],
      ].map(async ([name, hit], index) => {
        const sample = sampleOf(
          `onset-${index}`,
          program(1000, [
            [-72, HIT_AT],
            [hit, 0.3],
          ])
        );
        const dry = await dryOf(sample);
        const first = on + Math.round(HIT_AT * R);
        const rows = await Promise.all(
          [0.75, 1].map(async (below) => {
            const wet = envelope(await play(sample, { ...MULTI, kParamRatioBelow: below }));
            return [
              `below ${below}`,
              {
                samples: Array.from({ length: HIT_SAMPLES }, (_, k) =>
                  round(dB(wet[first + k] / dry[first + k]))
                ),
                trace: HIT_MS.map((ms) => [ms, gainAt(wet, dry, HIT_AT + ms / 1000)]),
              },
            ];
          })
        );
        return [name, Object.fromEntries(rows)];
      })
    );
    // the silence that puts the bands to sleep: a hit at 0 dB after a tone at 0 dB and a silence of so many
    // seconds, Below 1
    const gaps = Promise.all(
      [0.05, 0.2, 1, 4].map(async (gap) => {
        const sample = sampleOf(
          `gap-${gap}`,
          program(1000, [
            [0, 0.3],
            [-Infinity, gap],
            [0, 0.3],
          ])
        );
        const dry = await dryOf(sample);
        const wet = envelope(await play(sample, { ...MULTI, kParamRatioBelow: 1 }));
        return [gap, HIT_MS.map((ms) => [ms, gainAt(wet, dry, 0.3 + gap + ms / 1000)])];
      })
    );
    // the crossovers: an impulse (after a quiet tone: the rack awake) with no compression (the ratio 1), the
    // response of all bands, of each alone (the others at -24 dB), at a mix of a half, moved
    const N = 1 << 16;
    const click = new Float64Array(Math.round(0.4 * R) + N + 1000);
    for (let i = 0; i < Math.round(0.35 * R); i++)
      click[i] =
        1e-3 * Math.sin((2 * Math.PI * 1000 * i) / R) * Math.min(1, (Math.round(0.35 * R) - i) / 2000);
    click[Math.round(0.4 * R)] = 0.5;
    const impulse = sampleOf('impulse', [click]);
    const [clickDry] = await play(impulse, null);
    let peak = 0;
    for (let i = 0; i < clickDry.length; i++) if (Math.abs(clickDry[i]) > Math.abs(clickDry[peak])) peak = i;
    const transform = (x) => {
      const fft = new FFT(N);
      const bins = fft.createComplexArray();
      fft.realTransform(
        bins,
        Array.from({ length: N }, (_, i) => x[peak - 64 + i])
      );
      return bins;
    };
    const base = transform(clickDry);
    const FREQUENCIES = [
      20, 30, 40, 60, 80, 100, 131, 160, 200, 300, 500, 1000, 1800, 2500, 3200, 5000, 8000, 14000,
    ];
    const response = async (comp) => {
      const bins = transform((await play(impulse, comp))[0]);
      return FREQUENCIES.map((hz) => {
        const k = Math.round((hz * N) / R);
        const power = base[2 * k] ** 2 + base[2 * k + 1] ** 2;
        const re = (bins[2 * k] * base[2 * k] + bins[2 * k + 1] * base[2 * k + 1]) / power;
        const im = (bins[2 * k + 1] * base[2 * k] - bins[2 * k] * base[2 * k + 1]) / power;
        return [round(dB(Math.hypot(re, im)), 2), round((Math.atan2(im, re) * 180) / Math.PI, 1)];
      });
    };
    const FLAT = { ...MULTI, kParamRatio: 1 };
    const QUIET = -24;
    const crossover = Promise.all(
      Object.entries({
        all: FLAT,
        low: { ...FLAT, kParamGain1: QUIET, kParamGain2: QUIET },
        mid: { ...FLAT, kParamGain0: QUIET, kParamGain2: QUIET },
        high: { ...FLAT, kParamGain0: QUIET, kParamGain1: QUIET },
        'mix 0.5': { ...FLAT, kParamWet: 50 },
        'mid + 12 dB, mix 0.5': { ...FLAT, kParamGain1: 12, kParamWet: 50 },
        'low 500 Hz, high 5000 Hz, mid alone': {
          ...FLAT,
          kParamXoverLow: 500,
          kParamXoverHi: 5000,
          kParamGain0: QUIET,
          kParamGain2: QUIET,
        },
      }).map(async ([name, comp]) => [name, await response(comp)])
    );

    const result = {
      about:
        'The compressor of the effect rack of the Audio Unit (alone in the rack; osc A off, the noise oscillator plays samples of ours one-shot at 44.1 kHz, the rate of the renders: sines of both channels in quadrature, their level hypot(L, R) at every sample; a gain is the level of a render over the one of the dry render, the rack empty, dB). `output`: the dry output over the sample (the rack is before Main Vol); `levels`: dB of a sample, add 20 log10(output) for the level at the output. `single` (one band, a step of 1 kHz from -40 to -9 dB and back): `threshold` [knob, gain at -9 dB, gain at -40 dB] with the attack 1 ms and the release 1 s (the peak is read); `ratio` [ratio, gain at -9 dB] at the threshold knob 0.7; `attack` and `release` [ms of the knob, [ms after the step, gain]] (the release from the gain at 0); `fresh` the same at the knobs of a fresh one (threshold 0.7); `makeup` and `level` [knob, gain] with no compression (at -40 dB: the rack clips an output over full scale); `mix` [mix, gain]; `link` the gain of the left channel with the right one as loud, a quarter of it, silent; `highpass` [Hz, dB, degrees] with no compression. `multi` (three bands): `curves` by band (a sine of its `hz`) and knobs: the gain at each of `levels` held 0.6 s; `mono` the same on a sine of 220 Hz alike in both channels (its fundamental); `falls` [ms of the release, [ms after a step from 0 to -40 dB, gain]] of the mid (1 kHz) and the high (8 kHz) band; `rise` [ms of the attack knob, [ms after a step from -40 to 0 dB of 1 kHz, gain]]; `onset` a hit of 1 kHz at 0 dB and at -40 dB after a second of a tone at -72 dB, by Below: the gain at each of its first `samples`, then its `trace` [ms after it, gain]; `gaps` [seconds of a silence between two tones of 1 kHz at 0 dB, [ms after the second one starts, gain]] at Below 1; `crossover` the response [dB, degrees] at `frequencies` with no compression: all bands, each alone (the others at -24 dB), at a mix of a half, with the crossovers moved; scripts/renders/run.mjs --only=compressor',
      rate: R,
      output: round(output, 5),
      single: {
        threshold: await threshold,
        ratio: await ratio,
        attack: await attack,
        release: await release,
        fresh: await fresh,
        makeup: await makeup,
        level: await level,
        mix: await mix,
        link: Object.fromEntries(await link),
        highpass: await highpass,
      },
      multi: {
        levels: LEVELS,
        curves: Object.fromEntries(await curves),
        mono: Object.fromEntries(await mono),
        falls: Object.fromEntries(await falls),
        rise: await rise,
        onset: Object.fromEntries(await onset),
        gaps: await gaps,
        frequencies: FREQUENCIES,
        crossover: Object.fromEntries(await crossover),
      },
    };
    writeFileSync(join(out, 'compressor.json'), `${JSON.stringify(result, null, 1)}\n`);
    console.log(
      'dsp/measurements: compressor',
      JSON.stringify({ output: result.output, link: result.single.link })
    );
  } finally {
    stand.remove();
  }
}

// --- chorus ---
if (runs('chorus')) {
  const R = RACK_RATE;
  const stand = rackStand('chorus');
  const { sampleOf } = stand;
  // a sample through the rack with a chorus of the plain params `chorus` (null: an empty rack, the dry signal)
  const play = (sample, chorus) =>
    stand.play(sample, chorus === null ? null : { module: 'FXChorus', type: 3, params: chorus });
  const round = (v, digits = 3) => +v.toFixed(digits);
  const ms = (samples) => round((samples / R) * 1000);
  // clicks every `period` s for `seconds` (one with no period) after a quiet tone (the rack awake), a tail after.
  // The tone goes on under a train: in a silence between two clicks the chorus sleeps and its LFO stops (with
  // no feedback its taps then move slower, and unevenly)
  const AT = Math.round(0.4 * R);
  const clicks = (seconds, period = 0) => {
    const x = new Float64Array(AT + Math.round((seconds + 0.2) * R));
    const quiet = period ? x.length : AT - Math.round(0.05 * R);
    for (let i = 0; i < quiet; i++)
      x[i] = 1e-3 * Math.sin((2 * Math.PI * 1000 * i) / R) * Math.min(1, (quiet - i) / 2000);
    const step = Math.round(period * R);
    for (let i = 0; i < (step ? seconds * R : 1); i += step || 1) x[AT + i] += 0.5;
    return x;
  };
  // the knobs at which the taps are read: all of the wet signal, the filter open, no feedback
  const OPEN = { kParamWet: 100, kParamFilt: 20000, kParamFeedback: 0 };
  const STILL = { ...OPEN, kParamDepth: 0 };
  try {
    const click = sampleOf('click', [clicks(1.2)]);
    const [dry] = await play(click, null);
    let at = 0;
    for (let i = 0; i < dry.length; i++) if (Math.abs(dry[i]) > Math.abs(dry[at])) at = i;
    const tapped = async (chorus, floor = 0.1, to = Math.round(0.1 * R)) => {
      const wet = await play(click, chorus);
      return wet.map((channel) => tapsOf(channel, dry, at, to, floor));
    };
    // the delays of the taps by the knobs Delay 1 and Delay 2 (the depth at 0): of each channel, ms
    const delays = Promise.all(
      [
        [5, 0],
        [0, 0],
        [1, 0],
        [2, 0],
        [10, 0],
        [20, 0],
        [30, 0],
        [10, 3],
        [20, 10],
        [20, 30],
      ].map(async ([first, second]) => {
        const [l, r] = await tapped({ ...STILL, kParamDelay: first, kParamDelay2: second });
        return [first, second, l.map(([lag]) => ms(lag)), r.map(([lag]) => ms(lag))];
      })
    );
    // a fresh chorus against one with its defaults written: the difference of the renders, dB under the first
    const DEFAULTS = {
      kParamRate: 20 * 0.25 ** 4,
      kParamDelay: 5,
      kParamDelay2: 0,
      kParamDepth: 26,
      kParamFeedback: 9.5,
      kParamFilt: 1000,
      kParamWet: 50,
      kParamLevelOut: 0.5,
    };
    const fresh = Promise.all([play(click, {}), play(click, DEFAULTS)]).then(([[a], [b]]) => {
      let [signal, difference] = [0, 0];
      for (let i = 0; i < a.length; i++) {
        signal += a[i] ** 2;
        difference += (a[i] - b[i]) ** 2;
      }
      return { ...DEFAULTS, apart: round(10 * Math.log10(difference / signal + 1e-20), 1) };
    });
    // the LFO: trains of clicks, where the taps of each channel bring out each click (ms, in order)
    const moving = async ({ seconds, period, ...knobs }) => {
      const sample = sampleOf(`train-${seconds}-${period}`, [clicks(seconds, period)]);
      const [[dryTrain], wet] = await Promise.all([play(sample, null), play(sample, { ...OPEN, ...knobs })]);
      const step = Math.round(period * R);
      const rows = [];
      for (let k = 0; k * step < seconds * R - step; k++) {
        const [l, r] = wet.map((channel) =>
          tapsOf(channel, dryTrain, at + k * step, step - 60, 0.12).map(([lag]) => ms(lag))
        );
        rows.push([round((k * step) / R, 4), l, r]);
      }
      return { ...knobs, taps: rows };
    };
    const FAR = { kParamDelay: 20, kParamDelay2: 0 };
    const trains = async () => {
      const rows = [];
      // (one train after another: each is a sample of its own)
      for (const job of [
        { seconds: 12.8, period: 0.1 },
        { seconds: 3, period: 0.025, kParamRate: 1.013, kParamDepth: 1, ...FAR },
        { seconds: 2, period: 0.025, kParamRate: 5.03, kParamDepth: 1, ...FAR },
        { seconds: 1, period: 0.025, kParamRate: 19.9, kParamDepth: 1, ...FAR },
        { seconds: 1.2, period: 0.025, kParamRate: 40, kParamDepth: 1, ...FAR },
        { seconds: 4, period: 0.05, kParamRate: 0.5, kParamDepth: 5, ...FAR },
        { seconds: 4.2, period: 0.1, kParamRate: 0.5, kParamDepth: 50, kParamDelay: 20, kParamDelay2: 0 },
        { seconds: 0.5, period: 0.05, kParamRate: 0, kParamDepth: 2, ...FAR },
      ])
        rows.push(await moving(job));
      return rows;
    };
    // the feedback: the repeats of a click ([ms, gain] of the left channel), both taps at 10 ms, then apart
    const BOTH = { ...STILL, kParamDelay: 10, kParamDelay2: 10 };
    const repeats = async (chorus) =>
      (await tapped(chorus, 0.03, Math.round(0.056 * R)))[0].map(([lag, gain]) => [ms(lag), round(gain, 4)]);
    const feedback = Promise.all(
      [-50, 25, 50, 75, 95, 100].map(async (value) => [
        value,
        await repeats({ ...BOTH, kParamFeedback: value }),
      ])
    );
    const loops = repeats({ ...BOTH, kParamDelay2: 7, kParamFeedback: 50 });
    // the response of the wet signal against the dry one: dB at each of the frequencies
    const N = 1 << 15;
    const transform = (x) => {
      const fft = new FFT(N);
      const bins = fft.createComplexArray();
      fft.realTransform(
        bins,
        Array.from({ length: N }, (_, i) => x[at - 64 + i])
      );
      return bins;
    };
    const base = transform(dry);
    const FREQUENCIES = Array.from({ length: 41 }, (_, i) => round(25 * 2 ** (i / 4.25), 1));
    const response = async (chorus) => {
      const bins = transform((await play(click, chorus))[0]);
      return FREQUENCIES.map((hz) => {
        const k = Math.round((hz * N) / R);
        return round(
          dB(Math.hypot(bins[2 * k], bins[2 * k + 1]) / Math.hypot(base[2 * k], base[2 * k + 1])),
          2
        );
      });
    };
    // the filter: both taps at 0 ms (one arrival), low and high pass by the knob
    const ZERO = { kParamWet: 100, kParamFeedback: 0, kParamDepth: 0, kParamDelay: 0, kParamDelay2: 0 };
    const CUTOFFS = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
    const filter = Promise.all(
      [
        ['low', {}],
        ['high', { kParamFiltMode: 1 }],
      ].map(async ([name, mode]) => [
        name,
        await Promise.all(
          CUTOFFS.map(async (hz) => [hz, await response({ ...ZERO, ...mode, kParamFilt: hz })])
        ),
      ])
    );
    const comb = Promise.all(
      [50, 95].map(async (value) => [value, await response({ ...BOTH, kParamFeedback: value })])
    );
    // the mix: the gain of the dry click and of the wet one (both taps at 10 ms), the level: dB against 0.5
    const parts = async (chorus) => {
      const [found] = await tapped(chorus, 0.005, Math.round(0.012 * R));
      const gain = (ms) => found.find(([lag]) => Math.abs(lag / R - ms / 1000) < 1e-4)?.[1] ?? 0;
      return [gain(0), gain(10.12)];
    };
    const mix = Promise.all(
      [0, 12.5, 25, 37.5, 50, 62.5, 75, 87.5, 100].map(async (value) => {
        const [dryGain, wetGain] = await parts({ ...BOTH, kParamWet: value });
        return [value / 100, round(dryGain, 4), round(wetGain, 4)];
      })
    );
    const level = Promise.all(
      [0.1, 0.25, 0.5, 0.75, 1].map(async (knob) => {
        const [dryGain, wetGain] = await parts({ ...BOTH, kParamWet: 50, kParamLevelOut: knob });
        return [knob, round(dB(dryGain)), round(dB(wetGain))];
      })
    );
    // the mono sum of a fresh chorus on white noise (seeded: x = x * 1664525 + 1013904223 mod 2^32, its top
    // 24 bits as -0.25..0.25) over a cycle of its LFO: the level of a channel and of the half sum against the dry
    const SECONDS = 13.2;
    let seed = 1;
    const noise = Float64Array.from({ length: Math.round(SECONDS * R) }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return ((seed >>> 8) / (1 << 24) - 0.5) * 0.5;
    });
    const levels = ([[dryNoise], [l, r]]) => {
      const on = dryNoise.findIndex((v) => Math.abs(v) > 1e-6);
      const power = (of) => {
        let sum = 0;
        for (let i = on + Math.round(0.2 * R); i < on + Math.round(13 * R); i++) sum += of(i) ** 2;
        return sum;
      };
      const reference = power((i) => dryNoise[i]);
      return {
        seconds: SECONDS,
        left: round(dB(Math.sqrt(power((i) => l[i]) / reference))),
        right: round(dB(Math.sqrt(power((i) => r[i]) / reference))),
        sum: round(dB(Math.sqrt(power((i) => (l[i] + r[i]) / 2) / reference))),
      };
    };
    const result = {
      about:
        'The chorus of the effect rack of the Audio Unit on samples of ours played by its noise oscillator ' +
        '(44.1 kHz), its plain params named as its state has them (kParamRate Hz, kParamDelay and kParamDelay2 ' +
        'ms, kParamDepth 0..26, kParamFeedback %, kParamFilt Hz, kParamFiltMode 1 a high pass, kParamWet %, ' +
        'kParamLevelOut a knob 0..1). delays: [Delay 1, Delay 2, the taps of the left channel (ms after the ' +
        'dry click), of the right one] at the depth 0. fresh: the defaults of its knobs and how far a render ' +
        'with them written is from the one of a fresh chorus (dB under it). lfo: trains of clicks (the knobs ' +
        'of each, the rest fresh, the mix 100 %, the filter open, no feedback; a tone of 1 kHz at 0.001 under ' +
        'the clicks, fading out over their last 2000 samples: the chorus awake): taps [the time of a click (s after the ' +
        'first), where the left channel brings it out (ms, in order), the right one]. feedback: [%, the ' +
        'repeats of a click [ms, gain]] with both delays 10 ms, loops the same with Delay 2 at 7 ms and 50 %. ' +
        'filter: low and high pass, [the knob (Hz), the gain of the wet signal (dB against the dry click) at ' +
        'each of frequencies] with both taps at 0 ms and no feedback. comb: [feedback %, the same gains] with both delays ' +
        '10 ms. mix: [the knob 0..1, the gain of the dry click, the gain of the wet one (two taps at once)], ' +
        'level: [the knob, the dry gain (dB), the wet gain (dB)] at the mix 50 %. mono: a fresh chorus on ' +
        'white noise (x = x * 1664525 + 1013904223 mod 2^32 from 1, its top 24 bits as -0.25..0.25) over 0.2..13 ' +
        's: the level of each channel and of the half sum (dB against the dry noise). ' +
        'scripts/renders/run.mjs --only=chorus',
      rate: R,
      delays: await delays,
      fresh: await fresh,
      feedback: await feedback,
      loops: await loops,
      frequencies: FREQUENCIES,
      filter: Object.fromEntries(await filter),
      comb: await comb,
      mix: await mix,
      level: await level,
    };
    // a sample after another, never two at once and never back to one (a host has played the sample of the
    // renders before it, twice alike): the click first, then each train, then the noise
    result.lfo = await trains();
    const hiss = sampleOf('noise', [noise]);
    result.mono = levels(await Promise.all([play(hiss, null), play(hiss, {})]));
    writeFileSync(join(out, 'chorus.json'), `${JSON.stringify(result, null, 1)}\n`);
    console.log('dsp/measurements: chorus', JSON.stringify({ fresh: result.fresh, mono: result.mono }));
  } finally {
    stand.remove();
  }
}

// --- delay ---
// `--parts=static,lfo` renders some of them, the others kept as delay.json has them
if (runs('delay')) {
  const parts = process.argv
    .find((arg) => arg.startsWith('--parts='))
    ?.slice(8)
    .split(',') ?? ['static', 'lfo'];
  const file = join(out, 'delay.json');
  const R = RACK_RATE;
  // (a render loud before the click is not of its sample, nor one with no sound at all: its sample gone)
  const valid = (channels) =>
    channels.some((x) => x.some((value) => Math.abs(value) > 1e-9)) &&
    channels.every((x) => {
      for (let i = Math.round(0.06 * R); i < Math.round(0.3 * R); i++)
        if (Math.abs(x[i]) > 0.01) return false;
      return true;
    });
  const stand = rackStand('delay', R, valid);
  const { sampleOf } = stand;
  // a sample through the rack with a delay of the plain params `delay` (null: an empty rack, the dry signal)
  const play = (sample, delay, more) =>
    stand.play(sample, delay === null ? null : { module: 'FXDelay', type: 4, params: delay }, more);
  const round = (v, digits = 3) => +v.toFixed(digits);
  // a click of 0.5 after a quiet tone (the rack awake), a tail of silence after it for its echoes
  const AT = Math.round(0.4 * R);
  const TAIL = 3.2;
  const TO = Math.round((TAIL - 0.2) * R);
  const clicks = () => {
    const x = new Float64Array(AT + Math.round(TAIL * R));
    const until = AT - Math.round(0.05 * R);
    for (let i = 0; i < until; i++)
      x[i] = 1e-3 * Math.sin((2 * Math.PI * 1000 * i) / R) * Math.min(1, (until - i) / 2000);
    x[AT] = 0.5;
    return x;
  };
  // the knobs the echoes are read at: all of the wet signal, no feedback, the time free, the filter wide
  const FREE = { kParamWet: 100, kParamFeedback: 0, kParamBeatSync: 0 };
  const WIDE = { kParamFreq: 1000, kParamBW: 8.25 };
  const at01 = (more) => ({ ...FREE, kParamTimeL: 0.1, kParamTimeR: 0.1, ...more });
  const ABOUT =
    'The delay of the effect rack of the Audio Unit on a click of ours played by its noise oscillator (44.1 ' +
    'kHz; 0.5 at 0.4 s after a tone of 1 kHz at 0.001, the rack awake; 3.2 s of silence after it), its plain ' +
    'params named as its state has them (kParamTimeL and kParamTimeR, kParamOffsetL and kParamOffsetR, ' +
    'kParamBeatSync 0: the times free, kParamFeedback %, kParamWet %, kParamFreq Hz, kParamBW, kParamMode, ' +
    'kParamLevelOut a knob 0..1, kParamLink, kParamHQ). An echo is where the click of the dry render comes ' +
    'out of the wet one: [lag in samples, gain] (the correlation with the dry click: a filtered echo has a ' +
    'gain under its level). impulse: `click` the dry click as rendered, 128 samples from 32 before its ' +
    'peak, of the peak; `echoes` the first three echoes the same way (their `lags`) at the free time 0.1, ' +
    'the feedback and the filter of a fresh delay, the wet signal alone. fresh: the defaults of its knobs and how far a render with them ' +
    'written is from the one of a fresh delay (dB under it). free: [the knob of both times, the first echo ' +
    'of the left channel (its lag; null: none in 3 s), of the right one], no feedback. apart: the knobs of ' +
    'the channels apart and `echo`, the first echo of each. tempos: [the tempo of the host (null: it tells ' +
    'none), the first echo of a fresh time], the sync on (the default). sync: [the knob of both times, the ' +
    'first echo] at 240 BPM (a beat is 11025 samples); offsets: [kParamOffsetL and R, the first echo] of a ' +
    'fresh time at 240 BPM. feedback: [%, the repeats of the click in the left channel] at the free time ' +
    '0.1, the filter wide (1 kHz, BW 8.25); uneven: the repeats of each channel at 50 % with the times 0.05 ' +
    'and 0.08. mix: [the knob 0..1, the gain of the dry click, the gain of its echo against the one at 100 ' +
    '%]; level: [kParamLevelOut, the gain of the dry click against the one at 0.5] at the mix 50 %. ' +
    'filter: [kParamFreq, kParamBW, the gain of the echo (dB against the dry click) at each of ' +
    'frequencies], no feedback. hq: [kParamHQ, the first echo [lag, gain]] at the free time 0.10001. ' +
    'modes: a click in one channel alone (`input`) by kParamMode at 50 % of feedback, the filter at 1 kHz ' +
    'and BW 2, the times 0.05 and 0.08: the echoes of the left channel, of the right one. ' +
    'lfo: LFO 1 (its default shape: a triangle from 0 up, from the note) routed to kParamTimeL and kParamTimeR ' +
    '(mod slots, source 6) by `amount` % of their travel from the free time `base`, all wet, no feedback, the ' +
    'filter wide, a sine of `period` samples through it; `law` [the share of the travel, the first echo of a ' +
    'click] (Macro 1 routed alike, held: the time a share gives); the delay a sample is read at is the triangle ' +
    'from the sample `start` (of the sine) through `law` and a one-pole of `tau` ms, within `rms` samples. ' +
    'lfoDivisions: the rate of LFO 1 at `knob` (the `division` its menu shows: `hz` at 120 BPM, the tempo it ' +
    'takes without one of the host), its own fit. lfoRows: [the division (its index), the sample from the ' +
    'start of the sine, the delay it is read at there] every 32 samples over a cycle from 1 s, out of the phase ' +
    'of the render against the dry one (their analytic signals). ' +
    'scripts/renders/run.mjs --only=delay [--parts=static,lfo]';
  // LFO 1 on both times by AMOUNT % of their travel from the free time 0.1 at four rates ([its division, the knob of
  // LFO 1 Rate its menu shows as it, beats]), the delay of each sample read off a sine of period P through it
  const LFO = {
    amount: 4,
    base: 0.1,
    divisions: [
      ['1/4', 0.5, 1],
      ['1/8', 0.58, 0.5],
      ['1/16', 0.66, 0.25],
      ['1/32', 0.74, 0.125],
    ],
  };
  const P = 256;
  const lfoParts = async () => {
    const slots = (source) =>
      [
        [6, 'kParamTimeL'],
        [7, 'kParamTimeR'],
      ].map(([param, name]) => ({ source, osc: 0, param, name, amount: LFO.amount, type: 'FXDelay' }));
    const BASE = at01({ ...WIDE, kParamTimeL: LFO.base, kParamTimeR: LFO.base });
    // the law of the travel: Macro 1 (source 25) held at each share, the first echo of a click (a stand of its own:
    // a sample after another, never back to one)
    const lawStand = rackStand('delay-law', R, valid);
    const law = await (async () => {
      try {
        const sample = lawStand.sampleOf('click', [clicks()]);
        const fx = (delay) => delay && { module: 'FXDelay', type: 4, params: delay };
        const [dry] = await lawStand.play(sample, fx(null));
        let at = 0;
        for (let i = 0; i < dry.length; i++) if (Math.abs(dry[i]) > Math.abs(dry[at])) at = i;
        // (awaited here: the sample stays until its renders are done)
        return await Promise.all(
          [0, 0.25, 0.5, 0.75, 1].map(async (m) => {
            const [left] = await lawStand.play(sample, fx(BASE), {
              slots: slots(25),
              params: { 'Macro 1': m },
            });
            const [lag] = tapsOf(left, dry, at, TO, 0.03).find(([k]) => Math.abs(k) > 4);
            return [round((m * LFO.amount) / 100, 4), round(lag, 2)];
          })
        );
      } finally {
        lawStand.remove();
      }
    })();
    const lawAt = (u) => {
      for (let i = 0; i < law.length - 1; i++)
        if (u <= law[i + 1][0])
          return law[i][1] + ((u - law[i][0]) / (law[i + 1][0] - law[i][0])) * (law[i + 1][1] - law[i][1]);
      return law[law.length - 1][1];
    };
    // the phase of a channel sample by sample (unwrapped), by its analytic signal
    const phaseOf = (x) => {
      let N = 1;
      while (N < x.length) N <<= 1;
      const fft = new FFT(N);
      const input = new Float64Array(N);
      input.set(x);
      const bins = fft.createComplexArray();
      fft.realTransform(bins, input);
      fft.completeSpectrum(bins);
      for (let k = 1; k < N; k++) {
        const scale = k < N / 2 ? 2 : k === N / 2 ? 1 : 0;
        bins[2 * k] *= scale;
        bins[2 * k + 1] *= scale;
      }
      const z = fft.createComplexArray();
      fft.inverseTransform(z, bins);
      const phase = new Float64Array(x.length);
      for (let n = 0; n < x.length; n++) {
        const p = Math.atan2(z[2 * n + 1], z[2 * n]);
        phase[n] = n === 0 ? p : p + 2 * Math.PI * Math.round((phase[n - 1] - p) / (2 * Math.PI));
      }
      return phase;
    };
    const sineStand = rackStand('delay-lfo', R, (channels) =>
      channels.some((x) => x.some((value) => Math.abs(value) > 1e-3))
    );
    try {
      const SECONDS = 3;
      const sine = Float64Array.from(
        { length: Math.round(SECONDS * R) },
        (_, i) => 0.25 * Math.sin((2 * Math.PI * i) / P) * Math.min(1, i / 2000)
      );
      const sample = sineStand.sampleOf('sine', [sine]);
      const fx = (delay) => delay && { module: 'FXDelay', type: 4, params: delay };
      const [dry] = await sineStand.play(sample, fx(null));
      // (the sine starts at S of the renders: the frames are counted from there)
      let S = 0;
      while (Math.abs(dry[S]) < 1e-6) S++;
      const dryPhase = phaseOf(dry);
      const wets = await Promise.all(
        LFO.divisions.map(([, knob]) =>
          sineStand.play(sample, fx(BASE), { slots: slots(6), params: { 'LFO 1 Rate': knob } })
        )
      );
      const [from, to] = [Math.round(1.0 * R), Math.round(2.0 * R)];
      const tri = (x) => 1 - Math.abs(1 - 2 * (x - Math.floor(x)));
      const share = LFO.amount / 100;
      // (the mean of the law over a cycle: a one-pole keeps it, the delay read is its branch nearest to it)
      let mean = 0;
      for (let i = 0; i < 1000; i++) mean += lawAt(share * tri((i + 0.5) / 1000)) / 1000;
      const cases = LFO.divisions.map(([division, knob, beats], c) => {
        const wetPhase = phaseOf(wets[c][0]);
        const raw = Float64Array.from(
          { length: dry.length - S },
          (_, n) => ((dryPhase[S + n] - wetPhase[S + n]) * P) / (2 * Math.PI)
        );
        let average = 0;
        for (let n = from; n < to; n++) average += raw[n] / (to - from);
        const branch = Math.round((mean - average) / P) * P;
        return { division, knob, hz: 2 / beats, period: (beats * R) / 2, d: raw.map((v) => v + branch) };
      });
      // the rms (samples) of a case against the triangle from `start` through the law and a one-pole of `tau` ms
      // (from 0.3 s before the window, at its target there: e^-12 of a step of a time constant of 25 ms)
      const misfit = ({ period, d }, start, tau) => {
        const a = 1 - Math.exp(-1000 / (tau * R));
        const target = (n) => lawAt(share * tri((n - start) / period));
        let y = target(from - Math.round(0.3 * R));
        let sum = 0;
        let count = 0;
        for (let n = from - Math.round(0.3 * R); n < to; n++) {
          y += a * (target(n) - y);
          if (n >= from && (n & 7) === 0) {
            sum += (y - d[n]) ** 2;
            count++;
          }
        }
        return Math.sqrt(sum / count);
      };
      // a grid of start (samples) and tau (ms), then a finer one around the best
      const fit = (group) => {
        const total = (start, tau) =>
          Math.sqrt(group.reduce((sum, c) => sum + misfit(c, start, tau) ** 2, 0) / group.length);
        let best = { rms: Infinity };
        for (let start = -256; start <= 256; start += 8)
          for (let tau = 10; tau <= 40; tau += 1) {
            const rms = total(start, tau);
            if (rms < best.rms) best = { start, tau, rms };
          }
        const coarse = best;
        for (let start = coarse.start - 8; start <= coarse.start + 8; start++)
          for (let tau = coarse.tau - 1; tau <= coarse.tau + 1 + 1e-9; tau += 0.1) {
            const rms = total(start, tau);
            if (rms < best.rms) best = { start, tau: round(tau, 1), rms };
          }
        return { ...best, rms: round(best.rms, 2) };
      };
      const all = fit(cases);
      // (a row a line in the file: the fits, then the delay of each division)
      const lfoRows = [];
      const lfoDivisions = cases.map((c, index) => {
        const own = fit([c]);
        // a cycle from the first start of one after `from`
        const first = all.start + Math.ceil((from - all.start) / c.period) * c.period;
        for (let n = Math.ceil(first); n < first + c.period; n += 32)
          lfoRows.push([index, n, round(c.d[n], 2)]);
        return { division: c.division, knob: c.knob, hz: c.hz, tau: own.tau, start: own.start, rms: own.rms };
      });
      return {
        lfo: {
          amount: LFO.amount,
          base: LFO.base,
          period: P,
          law,
          start: all.start,
          tau: all.tau,
          rms: all.rms,
        },
        lfoDivisions,
        lfoRows,
      };
    } finally {
      sineStand.remove();
    }
  };
  // the static part: the knobs held
  const measured = async () => {
    const click = sampleOf('click', [clicks()]);
    const [dry] = await play(click, null);
    let at = 0;
    for (let i = 0; i < dry.length; i++) if (Math.abs(dry[i]) > Math.abs(dry[at])) at = i;
    // where each channel brings the click out: [lag in samples, gain], the dry click (lag 0) left out
    const taps = async (delay, { floor = 0.03, to = TO, sample = click, more } = {}) => {
      const wet = await play(sample, delay, more);
      return wet.map((channel) =>
        tapsOf(channel, dry, at, to, floor)
          .filter(([lag]) => Math.abs(lag) > 4)
          .map(([lag, gain]) => [round(lag, 2), round(gain, 4)])
      );
    };
    // the first echo of each channel: its lag (null: none within the tail)
    const first = async (delay, more) => (await taps(delay, { more })).map((found) => found[0]?.[0] ?? null);

    // the free time by its knob (both alike), then the channels apart, the offsets, the link
    const free = Promise.all(
      [
        0.0005, 0.001, 0.0012, 0.0015, 0.002, 0.003, 0.005, 0.01, 0.02, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.41,
        0.42, 0.45, 0.5, 0.501, 0.6, 1,
      ].map(async (knob) => [knob, ...(await first({ ...FREE, kParamTimeL: knob, kParamTimeR: knob }))])
    );
    const apart = Promise.all(
      [
        { kParamTimeL: 0.1, kParamTimeR: 0.2 },
        { kParamTimeL: 0.05, kParamTimeR: 0.08 },
        { kParamTimeL: 0.1, kParamTimeR: 0.2, kParamLink: 0 },
        { kParamTimeL: 0.1, kParamTimeR: 0.1, kParamOffsetL: 1.5, kParamOffsetR: 0.5 },
        { kParamTimeL: 0.1, kParamTimeR: 0.1, kParamOffsetL: 0.6667, kParamOffsetR: 1.3333 },
        { kParamTimeL: 0.2, kParamTimeR: 0.1, kParamOffsetL: 1.02, kParamOffsetR: 1.48 },
      ].map(async (knobs) => ({ ...knobs, echo: await first({ ...FREE, ...knobs }) }))
    );
    // the sync: a fresh time by the tempo of the host (null: it tells none), the knob at 240 BPM
    const SYNC = { kParamWet: 100, kParamFeedback: 0 };
    const tempos = Promise.all(
      [null, 60, 120, 150, 240].map(async (bpm) => [bpm, (await first(SYNC, bpm && { bpm }))[0]])
    );
    const sync = Promise.all(
      Array.from({ length: 56 }, (_, k) => round(0.004 * 1.105 ** k, 5)).map(async (knob) => [
        knob,
        (await first({ ...SYNC, kParamTimeL: knob, kParamTimeR: knob }, { bpm: 240 }))[0],
      ])
    );
    const offsets = Promise.all(
      [0.5, 0.6667, 1, 1.3333, 1.5].map(async (offset) => [
        offset,
        (await first({ ...SYNC, kParamOffsetL: offset, kParamOffsetR: offset }, { bpm: 240 }))[0],
      ])
    );
    // the feedback: the repeats of the click in the left channel, the filter wide; then the times apart
    const feedback = Promise.all(
      [0, 10, 25, 40, 50, 75, 90, 100].map(async (value) => [
        value,
        (await taps(at01({ ...WIDE, kParamFeedback: value })))[0].slice(0, 10),
      ])
    );
    const uneven = taps({ ...FREE, ...WIDE, kParamFeedback: 50, kParamTimeL: 0.05, kParamTimeR: 0.08 }).then(
      (found) => found.map((channel) => channel.slice(0, 6))
    );
    // the mix: the gain of the dry click and of its echo (against the echo at 100 %), the level at 50 %
    const parts = async (delay) => {
      const wet = await play(click, at01({ ...WIDE, ...delay }));
      const found = tapsOf(wet[0], dry, at, Math.round(0.15 * R), 0.002);
      const gain = (lag) => found.find(([k]) => Math.abs(k - lag) < 1.5)?.[1] ?? 0;
      return [gain(0), gain(4364)];
    };
    const whole = parts({});
    const mix = Promise.all(
      [0, 5, 12.5, 25, 30, 35, 50, 62.5, 75, 87.5, 95, 100].map(async (value) => {
        const [[dryGain, wetGain], [, all]] = await Promise.all([parts({ kParamWet: value }), whole]);
        return [value / 100, round(dryGain, 4), round(wetGain / all, 4)];
      })
    );
    const level = Promise.all(
      [0, 0.1, 0.25, 0.5, 0.75, 0.85, 1].map(async (knob) => {
        const [[dryGain], [reference]] = await Promise.all([
          parts({ kParamWet: 50, kParamLevelOut: knob }),
          parts({ kParamWet: 50 }),
        ]);
        return [knob, round(dryGain / reference, 4)];
      })
    );
    // the filter: the response of the echo against the dry click, dB at each of the frequencies
    const N = 1 << 15;
    const transform = (x, from) => {
      const fft = new FFT(N);
      const bins = fft.createComplexArray();
      fft.realTransform(
        bins,
        Array.from({ length: N }, (_, i) => x[from + i] ?? 0)
      );
      return bins;
    };
    const base = transform(dry, at - 64);
    const FREQUENCIES = Array.from({ length: 41 }, (_, i) => round(20 * 2 ** (i / 4.1), 1));
    const response = async (delay) => {
      const bins = transform((await play(click, at01(delay)))[0], at - 64 + 4364);
      return FREQUENCIES.map((hz) => {
        const k = Math.round((hz * N) / R);
        return round(
          dB(Math.hypot(bins[2 * k], bins[2 * k + 1]) / Math.hypot(base[2 * k], base[2 * k + 1])),
          2
        );
      });
    };
    const filter = Promise.all(
      [
        ...[40, 100, 300, 1000, 3000, 8000, 18000].flatMap((freq) =>
          [0.75, 1, 2, 4, 6.75, 8.25].map((bw) => [freq, bw])
        ),
        [1000, 0.1],
        [1000, 12],
        [20, 2],
        [22000, 2],
      ].map(async ([freq, bw]) => [freq, bw, await response({ kParamFreq: freq, kParamBW: bw })])
    );
    // a fresh delay against one with its defaults written: the difference of the renders, dB under the first
    const DEFAULTS = { kParamWet: 30, kParamFeedback: 40, kParamFreq: Math.sqrt(40 * 18000), kParamBW: 6.75 };
    const fresh = Promise.all([play(click, {}), play(click, DEFAULTS)]).then(([[a], [b]]) => {
      let [signal, difference] = [0, 0];
      for (let i = 0; i < a.length; i++) {
        signal += a[i] ** 2;
        difference += (a[i] - b[i]) ** 2;
      }
      return {
        ...DEFAULTS,
        kParamFreq: round(DEFAULTS.kParamFreq, 2),
        apart: round(10 * Math.log10(difference / signal + 1e-20), 1),
      };
    });
    const fine = Promise.all(
      [0, 1].map(async (value) => [
        value,
        (await taps(at01({ kParamHQ: value, kParamTimeL: 0.10001, kParamTimeR: 0.10001 })))[0][0],
      ])
    );
    // the click itself and its echoes as rendered (of the peak of the dry click): 128 samples from 32 before
    // each, a fresh delay (40 % of feedback, its filter) all wet
    const window = (x, lag) =>
      Array.from({ length: 128 }, (_, i) => round(x[at + lag - 32 + i] / dry[at], 5));
    const impulse = play(click, at01({ ...DEFAULTS, kParamWet: 100 })).then(([wet]) => ({
      click: window(dry, 0),
      lags: [4364, 8729, 13094],
      echoes: [4364, 8729, 13094].map((lag) => window(wet, lag)),
    }));
    const result = {
      about: ABOUT,
      rate: R,
      impulse: await impulse,
      fresh: await fresh,
      free: await free,
      apart: await apart,
      tempos: await tempos,
      sync: await sync,
      offsets: await offsets,
      feedback: await feedback,
      uneven: await uneven,
      mix: await mix,
      level: await level,
      frequencies: FREQUENCIES,
      filter: await filter,
      hq: await fine,
    };
    // a sample after another, never two at once and never back to one (the modes of one together): the click in
    // one channel alone
    const silent = new Float64Array(clicks().length);
    result.modes = [];
    for (const [input, channels] of [
      ['left', [clicks(), silent]],
      ['right', [silent, clicks()]],
    ]) {
      const sample = sampleOf(input, channels);
      const modes = await Promise.all(
        [0, 1, 2].map(async (mode) => {
          const [left, right] = await taps(
            {
              ...FREE,
              kParamFeedback: 50,
              kParamFreq: 1000,
              kParamBW: 2,
              kParamTimeL: 0.05,
              kParamTimeR: 0.08,
              kParamMode: mode,
            },
            { sample, to: Math.round(0.9 * R) }
          );
          return { input, mode, left: left.slice(0, 6), right: right.slice(0, 6) };
        })
      );
      result.modes.push(...modes);
    }
    return result;
  };
  try {
    const result = parts.includes('static') ? await measured() : JSON.parse(readFileSync(file, 'utf8'));
    result.about = ABOUT;
    // (a sample after another: the moving part after the static one)
    if (parts.includes('lfo')) Object.assign(result, await lfoParts());
    writeRows(file, result);
    console.log(
      'dsp/measurements: delay',
      parts.join(', '),
      JSON.stringify({
        tempos: result.tempos,
        lfo: result.lfo && { tau: result.lfo.tau, rms: result.lfo.rms },
      })
    );
  } finally {
    stand.remove();
  }
}

// --- eq ---
if (runs('eq')) {
  const R = RACK_RATE;
  const round = (v, digits = 3) => +v.toFixed(digits);
  // an impulse after a quiet tone (the rack awake), the FFT of N samples from it (at 25 Hz and Q 19 a peak rings
  // out in a quarter of them)
  const N = 1 << 16;
  const click = new Float64Array(Math.round(0.4 * R) + N + 1000);
  for (let i = 0; i < Math.round(0.35 * R); i++)
    click[i] = 1e-3 * Math.sin((2 * Math.PI * 1000 * i) / R) * Math.min(1, (Math.round(0.35 * R) - i) / 2000);
  click[Math.round(0.4 * R)] = 0.5;
  // a stand rendering at `rate` (the noise oscillator plays the sample of 44.1 kHz resampled alike in a render
  // with the eq and in the dry one): the response [dB, degrees] of an eq of the plain params `eq` at `frequencies`
  // (the left channel: the noise oscillator plays both alike)
  const standAt = (rate) => {
    const stand = rackStand(`eq${rate}`, rate);
    const impulse = stand.sampleOf('impulse', [click]);
    const transform = (x, peak) => {
      const fft = new FFT(N);
      const bins = fft.createComplexArray();
      fft.realTransform(
        bins,
        Array.from({ length: N }, (_, i) => x[peak - 64 + i])
      );
      return bins;
    };
    const base = stand.play(impulse, null).then(([dry]) => {
      let peak = 0;
      for (let i = 0; i < dry.length; i++) if (Math.abs(dry[i]) > Math.abs(dry[peak])) peak = i;
      return { peak, bins: transform(dry, peak) };
    });
    const response = async (eq, frequencies) => {
      const { peak, bins: dry } = await base;
      const bins = transform((await stand.play(impulse, { module: 'FXEQ', type: 7, params: eq }))[0], peak);
      return frequencies.map((hz) => {
        const k = Math.round((hz * N) / rate);
        const power = dry[2 * k] ** 2 + dry[2 * k + 1] ** 2;
        const re = (bins[2 * k] * dry[2 * k] + bins[2 * k + 1] * dry[2 * k + 1]) / power;
        const im = (bins[2 * k + 1] * dry[2 * k] - bins[2 * k] * dry[2 * k + 1]) / power;
        return [round(dB(Math.hypot(re, im)), 3), round((Math.atan2(im, re) * 180) / Math.PI, 2)];
      });
    };
    return { stand, response };
  };
  // the frequencies of a response, each that of a bin of the FFT at its rate (a narrow peak read where it is): 64
  // from 20 Hz to 21 kHz; of the sweep of the resonance 241 around 1 kHz
  const binsOf = (list, rate) => list.map((hz) => round((Math.round((hz * N) / rate) * rate) / N, 4));
  const SPREAD = Array.from({ length: 64 }, (_, i) => 20 * 1050 ** (i / 63));
  const FREQUENCIES = binsOf(SPREAD, R);
  const Q_FREQUENCIES = binsOf(
    Array.from({ length: 241 }, (_, i) => 400 * 6.25 ** (i / 240)),
    R
  );
  // the plain params of a band: type 0 a shelf (low of band 1, high of band 2), 1 a peak, 2 a pass (high of band
  // 1, low of band 2)
  const bandOf = (band, type, freq, reso, gain) => ({
    [`kParamType${band}`]: type,
    [`kParamFreq${band}`]: freq,
    [`kParamReso${band}`]: reso,
    [`kParamGain${band}`]: gain,
  });
  const GRID_FREQS = [25, 60, 150, 400, 1000, 2500, 6000, 12000, 16000, 19000];
  const GRID_RESOS = [0, 15, 30, 50, 70, 85, 100];
  const GRID_GAINS = [-24, -12, -3, 3, 12, 24];
  const grid = [
    ...[1, 2].flatMap((band) =>
      GRID_FREQS.flatMap((freq) =>
        GRID_RESOS.flatMap((reso) => GRID_GAINS.map((gain) => [band, 0, freq, reso, gain]))
      )
    ),
    ...GRID_FREQS.flatMap((freq) =>
      GRID_RESOS.flatMap((reso) => GRID_GAINS.map((gain) => [1, 1, freq, reso, gain]))
    ),
    ...GRID_FREQS.flatMap((freq) =>
      [15, 50, 85].flatMap((reso) => [-12, 12].map((gain) => [2, 1, freq, reso, gain]))
    ),
    ...[1, 2].flatMap((band) =>
      GRID_FREQS.flatMap((freq) => GRID_RESOS.map((reso) => [band, 2, freq, reso, 0]))
    ),
  ];
  const RATE_ROWS = [
    [1, 1, 16000, 50, 12],
    [1, 1, 8000, 80, -12],
    [2, 0, 10000, 70, 12],
    [2, 2, 15000, 60, 0],
    [1, 2, 100, 50, 0],
    [1, 0, 100, 50, 12],
    [2, 2, 20000, 100, 0],
    // (the lowest frequency: 21.53 Hz at 44.1 kHz)
    [1, 1, 5, 50, 12],
    [1, 1, 30, 50, 12],
  ];
  const stands = [];
  try {
    const at = standAt(R);
    stands.push(at.stand);
    const respond = (eq, frequencies = FREQUENCIES) => at.response(eq, frequencies);
    const magnitudes = async (eq, frequencies) => (await respond(eq, frequencies)).map(([gain]) => gain);
    const rowsOf = (list) => Promise.all(list.map(async (row) => [...row, await magnitudes(bandOf(...row))]));
    const fresh = respond({});
    const defaults = Promise.all(
      [1, 2].flatMap((band) =>
        [-12, 12].map(async (gain) => [band, gain, await magnitudes({ [`kParamGain${band}`]: gain })])
      )
    );
    const level = Promise.all(
      [0.1, 0.25, 0.5, 0.75, 0.9, 1].map(async (v) => [v, (await respond({ kParamLevelOut: v }))[20][0]])
    );
    // knobs out of their ranges and at their ends: alike
    const clamps = rowsOf([
      [1, 1, 5, 50, 12],
      [1, 1, 20, 50, 12],
      [1, 1, 25000, 50, 12],
      [1, 1, 20000, 50, 12],
      [1, 1, 1000, -10, 12],
      [1, 1, 1000, 0, 12],
      [1, 1, 1000, 150, 12],
      [1, 1, 1000, 100, 12],
      [1, 1, 1000, 50, 40],
      [1, 1, 1000, 50, 24],
      [1, 1, 1000, 50, -40],
      [1, 1, 1000, 50, -24],
      [1, 5, 1000, 50, 12],
      [2, 5, 1000, 50, 12],
      [1, 2, 1000, 50, 12],
      [2, 2, 1000, 50, -12],
    ]);
    const phase = Promise.all(
      [
        [1, 0, 150, 70, 12],
        [2, 0, 6000, 50, -12],
        [1, 1, 1000, 85, 12],
        [1, 1, 400, 30, -24],
        [1, 2, 60, 70, 0],
        [2, 2, 12000, 30, 0],
      ].map(async (row) => [...row, await respond(bandOf(...row))])
    );
    const RESOS = Array.from({ length: 21 }, (_, i) => i * 5);
    const q = Promise.all(
      [0, 1, 2].flatMap((type) =>
        RESOS.map(async (reso) => [
          type,
          reso,
          await magnitudes(bandOf(1, type, 1000, reso, 12), Q_FREQUENCIES),
        ])
      )
    );
    const result = {
      about:
        'The EQ of the effect rack of the Audio Unit (alone in the rack; osc A off, the noise oscillator plays an impulse of ours one-shot at 44.1 kHz after a quiet tone of 1 kHz that keeps the rack awake; a response is the FFT of 2^16 samples from the impulse through the EQ over the one of the dry render, the rack empty, dB, at `frequencies`). Its plain params: kParamType1/2 (0 a shelf: low of band 1, high of band 2; 1 a peak; 2 a pass: high of band 1, low of band 2; more is 2), kParamFreq1/2 (Hz), kParamReso1/2 (%), kParamGain1/2 (dB, none on a pass), kParamLevelOut (a knob). `fresh` [dB, degrees] of a fresh EQ; `defaults` [band, gain, dB] a fresh EQ with the gain of one band set; `level` [knob, dB]; `clamps` [band, type, Hz, reso, gain, dB] knobs out of their ranges and at their ends; `phase` [band, type, Hz, reso, gain, [dB, degrees]]; `q` [type, reso, dB at `qFrequencies`] band 1 at 1 kHz, gain 12 dB; `grid` [band, type, Hz, reso, gain, dB]; `rates` by rate the `rows` rendered at it, at its `frequencies` (the sample resampled alike with and without the EQ); scripts/renders/run.mjs --only=eq',
      rate: R,
      frequencies: FREQUENCIES,
      qFrequencies: Q_FREQUENCIES,
      fresh: await fresh,
      level: await level,
      defaults: await defaults,
      clamps: await clamps,
      phase: await phase,
      q: await q,
      grid: await rowsOf(grid),
    };
    const at96 = standAt(96000);
    stands.push(at96.stand);
    const frequencies96 = binsOf(SPREAD, 96000);
    const rows96 = await Promise.all(
      RATE_ROWS.map(async (row) => [
        ...row,
        (await at96.response(bandOf(...row), frequencies96)).map(([g]) => g),
      ])
    );
    result.rates = { 96000: { frequencies: frequencies96, rows: rows96 } };
    writeRows(join(out, 'eq.json'), result);
    console.log('dsp/measurements: eq', JSON.stringify({ level: result.level }));
  } finally {
    stands.forEach((stand) => stand.remove());
  }
}

// --- reverb ---
// the tools of the renders of the reverb (reverb, reverb-presets): a stand of the rack (`tag`), the impulse and the
// tone under it, the measures of a response, the chord of the scenes and its windows
const reverbTools = (tag) => {
  const R = RACK_RATE;
  const stand = rackStand(tag);
  const { sampleOf } = stand;
  const round = (v, digits = 2) => (Number.isFinite(v) ? +v.toFixed(digits) : null);
  const dB = (energy) => 10 * Math.log10(energy + 1e-30);
  // a sample through the rack with a reverb of the plain params `reverb` (null: an empty rack, the dry signal)
  const play = (sample, reverb) =>
    stand.play(sample, reverb === null ? null : { module: 'FXReverb', type: 6, params: reverb });
  // A quiet tone under every sample, from its start: in a silence the reverb sleeps, and woken by the signal it
  // answers otherwise (an impulse into a sleeping Hall: a tail 18 dB louder, none at all over Size 60; the other
  // types nothing). 25 Hz, under every band read here
  const TONE = 1e-4;
  const withTone = (x) => x.map((value, i) => value + TONE * Math.sin((2 * Math.PI * 25 * i) / R));
  const SECONDS = 9;
  const impulse = new Float64Array(SECONDS * R);
  impulse[Math.round(0.3 * R)] = 0.5;
  // (an FFT of each length, made once: a long one takes a while to make)
  const ffts = new Map();
  const fftOf = (n) => {
    if (!ffts.has(n)) ffts.set(n, new FFT(n));
    return ffts.get(n);
  };
  // the signal of `x` in each [lo, hi] Hz of `ranges` (the bins of one FFT of all of it)
  const bands = (x, ranges) => {
    let n = 1;
    while (n < x.length) n <<= 1;
    const fft = fftOf(n);
    const input = new Float64Array(n);
    input.set(x);
    const spectrum = fft.createComplexArray();
    fft.realTransform(spectrum, input);
    fft.completeSpectrum(spectrum);
    const back = fft.createComplexArray();
    return ranges.map(([lo, hi]) => {
      const bins = spectrum.slice();
      for (let k = 0; k < n; k++) {
        const f = (Math.min(k, n - k) * R) / n;
        if (f < lo || f > hi) bins[2 * k] = bins[2 * k + 1] = 0;
      }
      fft.inverseTransform(back, bins);
      return Float64Array.from({ length: x.length }, (_, i) => back[2 * i]);
    });
  };
  const band = (x, lo, hi) => bands(x, [[lo, hi]])[0];
  // RT60 (s) of the fall from -5 to -25 dB of the energy left (Schroeder) from `from`
  const rt60 = (x, from) => {
    const left = new Float64Array(x.length - from);
    let sum = 0;
    for (let i = x.length - 1; i >= from; i--) left[i - from] = sum += x[i] * x[i];
    const at = (level) => left.findIndex((e) => dB(e / left[0]) < level);
    const [a, b] = [at(-5), at(-25)];
    return b > 0 ? ((b - a) / R) * 3 : NaN;
  };
  const energy = (x, from, to) => {
    let sum = 0;
    for (let i = Math.max(0, Math.round(from)); i < Math.min(x.length, Math.round(to)); i++)
      sum += x[i] * x[i];
    return sum;
  };
  // the octaves RT60 is read in: [centre, from, to] Hz
  const OCTAVES = [63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000].map((c) => [
    c,
    c / Math.SQRT2,
    Math.min(20000, c * Math.SQRT2),
  ]);
  // the measures of the response to the impulse (the dry one at `at`, of energy `dryEnergy`): RT60 by octave, the
  // energy of all of it against the dry impulse, the first echo after the direct sound (ms), the first sound (ms),
  // the level every `LEVELS` s (50 ms, dB against the dry impulse), side against mid over 0.2..1 s
  const LEVELS = [0, 0.05, 0.1, 0.2, 0.5, 1, 2, 4];
  const measure = ([l, r], at, dryEnergy) => {
    const [hl, hr] = [band(l, 40, 21000), band(r, 40, 21000)];
    const mono = Float64Array.from(hl, (x, i) => (x + hr[i]) / 2);
    let top = 0;
    for (let i = at - 8; i < hl.length; i++) top = Math.max(top, Math.abs(hl[i]), Math.abs(hr[i]));
    const loud = (i, share) => Math.max(Math.abs(hl[i]), Math.abs(hr[i])) > top * share;
    let first = at - 8;
    while (first < hl.length && !loud(first, 0.02)) first++;
    let echo = at + Math.round(0.002 * R);
    while (echo < hl.length && !loud(echo, 0.25)) echo++;
    let side = 0;
    let mid = 0;
    for (let i = at + Math.round(0.2 * R); i < at + R; i++) {
      side += ((hl[i] - hr[i]) / 2) ** 2;
      mid += ((hl[i] + hr[i]) / 2) ** 2;
    }
    return {
      rt60: bands(
        mono,
        OCTAVES.map(([, lo, hi]) => [lo, hi])
      ).map((octave) => round(rt60(octave, at + Math.round(0.1 * R)))),
      energy: round(dB((energy(hl, at - 8, hl.length) + energy(hr, at - 8, hr.length)) / dryEnergy), 1),
      first: round(((first - at) / R) * 1000, 1),
      echo: round(((echo - at) / R) * 1000, 1),
      levels: LEVELS.map((t) =>
        round(
          dB(
            (energy(hl, at + t * R, at + (t + 0.05) * R) + energy(hr, at + t * R, at + (t + 0.05) * R)) /
              dryEnergy
          ),
          1
        )
      ),
      side: round(dB(side / (mid + 1e-30)), 1),
    };
  };
  // the echoes of a response: its first `count` samples over a quarter of its peak, 0.2 ms apart at least:
  // [ms after the impulse, left, right] against the dry impulse
  const echoes = ([l, r], at, dryPeak, count = 12) => {
    let top = 0;
    for (let i = at - 8; i < at + 2 * R; i++) top = Math.max(top, Math.abs(l[i]), Math.abs(r[i]));
    const found = [];
    for (let i = at - 8; i < at + 2 * R && found.length < count; i++)
      if (Math.max(Math.abs(l[i]), Math.abs(r[i])) > top / 4) {
        found.push([round(((i - at) / R) * 1000, 1), round(l[i] / dryPeak, 3), round(r[i] / dryPeak, 3)]);
        i += 8;
      }
    return found;
  };
  // how dense the echoes are `seconds` after the impulse: the share of the samples of 20 ms over their standard
  // deviation, against that of a noise (0.3173)
  const density = ([l], at, seconds) => {
    const [from, to] = [at + Math.round((seconds - 0.01) * R), at + Math.round((seconds + 0.01) * R)];
    const deviation = Math.sqrt(energy(l, from, to) / (to - from));
    let over = 0;
    for (let i = from; i < to; i++) if (Math.abs(l[i]) > deviation) over++;
    return round(over / (to - from) / 0.3173);
  };
  // The scenes: a chord of saws (C3, G3, E4, 0.2..2 s) through the Hall, what a window of 4096 samples around
  // each `SCENE_TIMES` s holds: its level (dB of the mean square of both channels, the sample at full scale 0 dB)
  // and the share of the third octaves from 50 Hz in the spectrum of its mid (dB of their sum, Hann)
  const SCENE_TIMES = [0.35, 0.9, 1.5, 1.9, 2.2, 2.6, 3.1, 3.8, 4.6, 5.5];
  const WINDOW = 4096;
  const BANDS = 25;
  const NOTES = [130.8128, 195.9977, 329.6276];
  const chord = () => {
    const x = new Float64Array(6 * R);
    for (const f of NOTES)
      for (let h = 1; h * f < 16000; h++)
        for (let i = Math.round(0.2 * R); i < Math.round(2.03 * R); i++) {
          const t = i / R;
          const gate = Math.min(1, (t - 0.2) / 0.005, (2.03 - t) / 0.03);
          x[i] += ((0.12 * gate) / h) * Math.sin(2 * Math.PI * h * f * t);
        }
    return x;
  };
  const windowsOf = ([l, r], delay, gain) => {
    const fft = new FFT(WINDOW);
    return SCENE_TIMES.map((t) => {
      const from = Math.round(t * R) + delay - WINDOW / 2;
      let square = 0;
      const mid = new Float64Array(WINDOW);
      for (let i = 0; i < WINDOW; i++) {
        const [a, b] = [(l[from + i] ?? 0) / gain, (r[from + i] ?? 0) / gain];
        square += (a * a + b * b) / 2;
        mid[i] = ((a + b) / 2) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WINDOW));
      }
      const bins = fft.createComplexArray();
      fft.realTransform(bins, mid);
      const bands = new Float64Array(BANDS);
      let total = 0;
      // (from 43 Hz: the tone of the stand is under it)
      for (let k = 4; k < WINDOW / 2; k++) {
        const e = bins[2 * k] ** 2 + bins[2 * k + 1] ** 2;
        total += e;
        const b = Math.floor(3 * Math.log2((k * R) / WINDOW / 50) + 0.5);
        if (b >= 0 && b < BANDS) bands[b] += e;
      }
      return [
        round(dB(square / WINDOW), 1),
        ...Array.from(bands, (e) => round(dB(e / (total + 1e-30) + 1e-9), 1)),
      ];
    });
  };
  // the impulse played dry: the sample of its peak, the peak, the energy over 40 Hz the measures are read against
  const dryImpulse = async (click) => {
    const [dry] = await play(click, null);
    let at = 0;
    for (let i = 0; i < dry.length; i++) if (Math.abs(dry[i]) > Math.abs(dry[at])) at = i;
    return { dry, at, dryPeak: dry[at], dryEnergy: 2 * energy(band(dry, 40, 21000), at - 8, at + 400) };
  };
  // the gains of a render `x` of Wet as the sum of those at 0 (`zero`) and 100 (`full`), [dry, wet], and what is
  // left of it (dB): least squares over 2 s from the impulse
  const wetGains = (x, zero, full, at) => {
    const sums = { dd: 0, dw: 0, ww: 0, xd: 0, xw: 0 };
    const to = at + 2 * R;
    for (let i = at - 8; i < to; i++) {
      sums.dd += zero[i] * zero[i];
      sums.dw += zero[i] * full[i];
      sums.ww += full[i] * full[i];
      sums.xd += x[i] * zero[i];
      sums.xw += x[i] * full[i];
    }
    const det = sums.dd * sums.ww - sums.dw * sums.dw;
    const a = (sums.xd * sums.ww - sums.xw * sums.dw) / det;
    const b = (sums.xw * sums.dd - sums.xd * sums.dw) / det;
    let rest = 0;
    let all = 0;
    for (let i = at - 8; i < to; i++) {
      rest += (x[i] - a * zero[i] - b * full[i]) ** 2;
      all += x[i] * x[i];
    }
    return [a, b, dB(rest / all)];
  };
  // the stand plays a sample late and quieter: by its dry render (its first sample over a hundredth of the peak
  // against that of the source; the levels of both over 0.5..1.5 s)
  const standOf = (dry, source) => {
    const onset = (x) => {
      let top = 0;
      for (const value of x) top = Math.max(top, Math.abs(value));
      return x.findIndex((value) => Math.abs(value) > top / 100);
    };
    const delay = onset(band(dry, 40, 21000)) - onset(source);
    const gain = Math.sqrt(energy(dry, delay + 0.5 * R, delay + 1.5 * R) / energy(source, 0.5 * R, 1.5 * R));
    return { delay, gain };
  };
  return {
    ...{ R, stand, sampleOf, round, dB, play, withTone, impulse, bands, band, energy, OCTAVES, LEVELS },
    ...{ measure, echoes, density, SCENE_TIMES, NOTES, chord, windowsOf, dryImpulse, wetGains, standOf },
  };
};

if (runs('reverb')) {
  const tools = reverbTools('reverb');
  const { R, stand, sampleOf, round, play, withTone, impulse, OCTAVES, LEVELS } = tools;
  const { measure, echoes, density, SCENE_TIMES, NOTES, chord, windowsOf, dryImpulse, wetGains, standOf } =
    tools;
  const HALL = { kParamWet: 100, kParamType: 'kHall' };
  try {
    const click = sampleOf('impulse', [withTone(impulse)]);
    const { at, dryPeak, dryEnergy } = await dryImpulse(click);
    const measured = async (reverb) => measure(await play(click, reverb), at, dryEnergy);
    const sweep = (key, values, base = HALL) =>
      Promise.all(
        values.map(async (value) => ({ [key]: value, ...(await measured({ ...base, [key]: value })) }))
      );
    // every type at its defaults (no Type: the first of its list)
    const types = Promise.all(
      [null, 'kHall', 'kVintage', 'kSpace', 'kAbyss'].map(async (type) => ({
        type,
        ...(await measured(type ? { kParamWet: 100, kParamType: type } : { kParamWet: 100 })),
      }))
    );
    const hall = play(click, HALL).then((wet) => ({
      ...measure(wet, at, dryEnergy),
      echoes: echoes(wet, at, dryPeak),
      density: [0.02, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2].map((t) => [t, density(wet, at, t)]),
    }));
    const size = Promise.all(
      [0, 10, 25, 37.5, 50, 62.5, 75, 90, 100].map(async (value) => {
        const wet = await play(click, { ...HALL, kParamSize: value });
        return { kParamSize: value, ...measure(wet, at, dryEnergy), echoes: echoes(wet, at, dryPeak, 6) };
      })
    );
    const decay = sweep('kParamDelay', [0, 10, 20, 30, 40, 50, 75, 100, 150, 250]);
    const lowDamp = sweep('kParamFreq', [0, 15, 30, 50, 75, 100]);
    const highDamp = sweep('kParamFreqB', [0, 15, 35, 50, 75, 100]);
    const predelay = sweep('kParamPreDelay', [0, 0.01, 0.05, 0.1, 0.33]);
    const width = sweep('kParamWidth', [0, 20, 50, 100]);
    const feedback = sweep('kParamFeedback', [0, 50, 100]);
    const level = sweep('kParamLevelOut', [0.3, 0.5, 0.75, 1]);
    // off the axes of the sweeps: do the laws of Size, of the decay and of the damping multiply
    const cross = Promise.all(
      [
        { kParamSize: 25, kParamDelay: 50 },
        { kParamSize: 25, kParamDelay: 10 },
        { kParamSize: 75, kParamDelay: 50 },
        { kParamSize: 75, kParamDelay: 10 },
        { kParamSize: 25, kParamFreqB: 75 },
        { kParamSize: 75, kParamFreqB: 75 },
        { kParamSize: 75, kParamFreq: 50 },
      ].map(async (params) => ({ ...params, ...(await measured({ ...HALL, ...params })) }))
    );
    // the law of Wet: a render at Wet w as the sum of those at 0 and at 100, [w, the gain of the dry one, of the
    // wet one, what is left of it (dB)]
    const wetLaw = Promise.all([play(click, { ...HALL, kParamWet: 0 }), play(click, HALL)]).then(
      ([[zero], [full]]) =>
        Promise.all(
          [10, 30, 50, 60, 80].map(async (wet) => {
            const [x] = await play(click, { ...HALL, kParamWet: wet });
            const [a, b, rest] = wetGains(x, zero, full, at);
            return [wet, round(a, 4), round(b, 4), round(rest, 0)];
          })
        )
    );
    const result = {
      about:
        'The reverb of the effect rack of the Audio Unit (FXReverb, an item of type 6) on samples of ours played by its noise oscillator (one-shot, 44.1 kHz, rendered at 44.1 kHz), a tone of 25 Hz at 1e-4 under each from its start: in a silence the reverb sleeps, and woken by the signal alone it answers otherwise. Its plain params: kParamType (kHall, kVintage, kSpace, kAbyss; none: the first type), kParamSize 0..100, kParamDelay (the decay) 0..250, kParamFreq (the damping of the lows) and kParamFreqB (of the highs) 0..100, kParamPreDelay (s), kParamWidth, kParamFeedback, kParamLevelOut 0..1, kParamWet 0..100; one not written is at its default (Hall: Size about 35, the decay about 30, FreqB 35, Freq 0, Width 20, LevelOut 0.5). An impulse of 0.5 at 0.3 s, all wet, a measure of it: rt60 (s) of the octaves `octaves` (the fall of the energy left from -5 to -25 dB, from 0.1 s after the impulse, times 3: of 9 s, so a decay over about 12 s is cut short), energy (dB, all of the response against the dry impulse, over 40 Hz), first (ms, the first sample over 2 % of its peak), echo (ms, the first sample over a quarter of its peak from 2 ms on: the first echo after the direct sound), levels (dB against the dry impulse, 50 ms from each of `levelTimes` s), side (dB against the mid, 0.2..1 s). types: every type at its defaults. hall: the Hall at its defaults, echoes [ms, left, right] (the first samples over a quarter of the peak, against the dry impulse: the lines of the Hall are a sixth of an octave apart, left and right in turn), density [s, the share of the samples of 20 ms over their standard deviation against that of a noise]. size, decay, lowDamp, highDamp, predelay, width, feedback, level: the Hall by one param. cross: by two. wet: [Wet, the gain of the dry signal, of the wet one, the rest in dB] of a render at Wet as the sum of those at 0 and 100: the wet gain is s = sin²(Wet/100 · π/2), the dry one 1 - s². scenes: a chord of saws (`chord`: the notes in Hz, each the sum of its harmonics under 16 kHz at 0.12 / h, sines from t = 0, a gate from 0.2 s (5 ms up) to 2.03 s (30 ms down), 6 s) through the Hall at {size, wet}, rows of the windows of 4096 samples around `sceneTimes` s: [level (dB of the mean square of both channels, the sample at full scale 0 dB), the share of each of 25 third octaves from 50 Hz in the spectrum of the mid (Hann, bins from 43 Hz), dB]; dry: the same of the empty rack. scripts/renders/run.mjs --only=reverb',
      rate: R,
      octaves: OCTAVES.map(([centre]) => centre),
      levelTimes: LEVELS,
      types: await types,
      hall: await hall,
      size: await size,
      decay: await decay,
      lowDamp: await lowDamp,
      highDamp: await highDamp,
      predelay: await predelay,
      width: await width,
      feedback: await feedback,
      level: await level,
      cross: await cross,
      wet: await wetLaw,
    };
    // (a sample after another: every render of the impulse is done)
    const source = chord();
    const saws = sampleOf('chord', [withTone(source)]);
    const dryChord = await play(saws, null);
    const { delay, gain } = standOf(dryChord[0], source);
    const scenes = await Promise.all(
      [
        [25, 30],
        [50, 30],
        [75, 30],
        [50, 60],
      ].map(async ([sceneSize, wet]) => ({
        size: sceneSize,
        wet,
        windows: windowsOf(
          await play(saws, { kParamType: 'kHall', kParamSize: sceneSize, kParamWet: wet }),
          delay,
          gain
        ),
      }))
    );
    Object.assign(result, {
      chord: NOTES,
      sceneTimes: SCENE_TIMES,
      stand: { delay, gain: round(gain, 4) },
      dry: windowsOf(dryChord, delay, gain),
      scenes,
    });
    writeRows(join(out, 'reverb.json'), result);
    console.log(
      'dsp/measurements: reverb',
      JSON.stringify({ hall: result.hall.rt60, wet: result.wet, stand: result.stand })
    );
  } finally {
    stand.remove();
  }
}

// --- the factory presets of the reverb ---
if (runs('reverb-presets')) {
  const tools = reverbTools('reverb-presets');
  const { R, stand, sampleOf, round, dB, play, withTone, impulse, bands, energy, OCTAVES, LEVELS } = tools;
  const { measure, density, SCENE_TIMES, NOTES, chord, windowsOf, dryImpulse, wetGains, standOf } = tools;
  const folder = reverbPresetsFolder();
  const presets = readdirSync(folder)
    .filter((file) => !file.startsWith('.'))
    .sort()
    .map((file) => ({ name: parse(file).name, params: fxPresetParams(join(folder, file)) }));
  const DENSITY_TIMES = [0.02, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2];
  // the energy of each octave of a response over `from`..the end
  const octaveEnergies = ([l, r], from) => {
    const mono = Float64Array.from(l, (x, i) => (x + r[i]) / 2);
    return bands(
      mono,
      OCTAVES.map(([, lo, hi]) => [lo, hi])
    ).map((x) => energy(x, from, x.length));
  };
  try {
    const click = sampleOf('impulse', [withTone(impulse)]);
    const { dry, at, dryEnergy } = await dryImpulse(click);
    const dryOctaves = octaveEnergies([dry, dry], at - 8);
    const rows = await Promise.all(
      presets.map(async ({ name, params }) => {
        const [full, zero, own] = await Promise.all([
          play(click, { ...params, kParamWet: 100 }),
          play(click, { ...params, kParamWet: 0 }),
          play(click, params),
        ]);
        const [a, b, rest] = wetGains(own[0], zero[0], full[0], at);
        return {
          name,
          params,
          ...measure(full, at, dryEnergy),
          octaves: octaveEnergies(full, at - 8).map((e, k) => round(dB(e / dryOctaves[k]), 1)),
          density: DENSITY_TIMES.map((t) => [t, density(full, at, t)]),
          gains: [round(a, 4), round(b, 4), round(rest, 0)],
        };
      })
    );
    // (a sample after another: every render of the impulse is done)
    const source = chord();
    const saws = sampleOf('chord', [withTone(source)]);
    const dryChord = await play(saws, null);
    const { delay, gain } = standOf(dryChord[0], source);
    const scenes = await Promise.all(
      presets.map(async ({ params }) => windowsOf(await play(saws, params), delay, gain))
    );
    writeRows(join(out, 'reverb-presets.json'), {
      about:
        'The factory presets of the reverb of the Audio Unit (Effect Chains/Reverb/Factory: `params` their plain params, the others at their defaults; kParamType none: the first type, Plate) in its effect rack, rendered and measured as reverb.json (its stand: the noise oscillator plays samples of ours one-shot at 44.1 kHz, a tone of 25 Hz at 1e-4 under each). The impulse all wet (Wet 100): rt60, energy, first, echo, levels and side as in reverb.json; octaves (dB, the energy of each octave of `octaves` of the response against that of the dry impulse); density [s, the share of the samples of 20 ms over their standard deviation against that of a noise]. gains: [the gain of the dry signal, of the wet one, the rest in dB] of its render at its own Wet as the sum of those at Wet 0 and 100. scene: the chord of reverb.json through it at its own Wet, the windows of reverb.json at `sceneTimes`; dry: the same of the empty rack. scripts/renders/run.mjs --only=reverb-presets',
      rate: R,
      octaves: OCTAVES.map(([centre]) => centre),
      levelTimes: LEVELS,
      sceneTimes: SCENE_TIMES,
      chord: NOTES,
      stand: { delay, gain: round(gain, 4) },
      dry: windowsOf(dryChord, delay, gain),
      presets: rows.map((row, i) => ({ ...row, scene: scenes[i] })),
    });
    console.log(
      'dsp/measurements: reverb-presets',
      JSON.stringify(rows.map(({ name, rt60 }) => [name, rt60[4]]))
    );
  } finally {
    stand.remove();
  }
}

// --- the filter: filter-types, filter-resonance ---
// Filter 1 of a voice (osc A goes through it alone): its type an index of 107 (Filter 1 Type = i / 106), its
// Freq the note 136.8 v (the display: 440 · 2^((136.8 v - 69) / 12), 8 Hz..22050 Hz)
const FILTER_TYPES = {
  'MG Low 6': 0,
  'MG Low 12': 1,
  'MG Low 18': 2,
  'MG Low 24': 3,
  'Low 6': 4,
  'Low 12': 5,
  'Low 18': 6,
  'Low 24': 7,
  'High 6': 8,
  'High 12': 9,
  'High 18': 10,
  'High 24': 11,
  'Band 12': 12,
  'Band 24': 13,
  'Peak 12': 14,
  'Peak 24': 15,
  'Notch 12': 16,
  'Notch 24': 17,
  'Low EQ 6': 71,
  'Low EQ 12': 72,
  'Band EQ 12': 73,
  'High EQ 6': 74,
  'High EQ 12': 75,
};
const filterKnobOf = (hz) => (69 + 12 * Math.log2(hz / 440)) / 136.8;
const noteHz = (note) => 440 * 2 ** ((note - 69) / 12);
const FILTER_FROM = Math.round(0.5 * RATE);
// a note of osc A through Filter 1 (filter null: off), its left channel; `agree`: rendered until two renders in a
// row agree (now and then a render is of another state)
const playFilter = async (name, state, note, filter, params = {}, agree = false) => {
  const knobs = filter
    ? {
        'Filter 1 On': 1,
        'Filter 1 Type': FILTER_TYPES[filter.type] / 106,
        'Filter 1 Freq': filter.cut === 'max' ? 1 : filterKnobOf(filter.cut),
        'Filter 1 Res': filter.res ?? 0,
        'Filter 1 Drive': filter.drive ?? 0,
        'Filter 1 Var': filter.var ?? 0,
      }
    : {};
  const once = async (attempt) => {
    const [left] = await hostRender(`filter-${name}${attempt ? `-${attempt}` : ''}`, {
      seconds: 1.6,
      state,
      params: { ...FLAT, 'Env 1 Decay': 0, ...params, ...knobs },
      notes: [{ note, on: 0, off: 1.55, velocity: 127 }],
    });
    return left;
  };
  if (!agree) return once(0);
  const same = (a, b) => a.every((value, i) => Math.abs(value - b[i]) < 1e-6);
  return untilAgree(name, once, same, true);
};
// the amplitude of a frequency over 0.5..1.5 s (Hann)
const filterLevel = (x, f) => tone(x, f, FILTER_FROM, RATE).amplitude;
const round = (v, digits = 2) => +v.toFixed(digits);
// the harmonics of C1 read at a cutoff (Hz; 'max': 22.05 kHz) up to `top`: 40 from 1 to 733 (23.97 kHz) evenly in log
// (`LOG_HARMONICS`), every one within ±`spread` of the cutoff
const LOG_HARMONICS = [...new Set(Array.from({ length: 40 }, (_, i) => Math.round(733 ** (i / 39))))];
const harmonicsAt = (cut, top = 733, spread = 0.35) => {
  const hz = cut === 'max' ? 22050 : cut;
  const f0 = noteHz(24);
  const near = [];
  for (
    let h = Math.ceil(((1 - spread) * hz) / f0);
    h <= Math.min(top, Math.floor(((1 + spread) * hz) / f0));
    h++
  )
    near.push(h);
  return [...new Set([...LOG_HARMONICS.filter((h) => h <= top), ...near])].sort((a, b) => a - b);
};
// the gain (dB) of the fundamental of a sine through a filter (y) against the dry render and its harmonics 2..7 (dB
// under the fundamental): `level` the amplitude of harmonic k in a render
const harmonicGains = (level, dry, y) => {
  const fundamental = level(y, 1);
  return [
    round(20 * Math.log10(fundamental / level(dry, 1))),
    [2, 3, 4, 5, 6, 7].map((k) => round(Math.max(-140, 20 * Math.log10(level(y, k) / fundamental)), 1)),
  ];
};
// a sine (osc A on a table of one sine `state`, at the amplitude A Level²) through a filter: the gain of its
// fundamental against the dry render and its harmonics 2..7 (dB under the fundamental); a dry render once a note
// and amplitude (no two hosts writing one file); `agree` as playFilter's
const sineGainsOf = (state, agree = false) => {
  const drys = new Map();
  const dryOf = (note, amp, params) => {
    const key = `${note}-${amp}`;
    if (!drys.has(key)) drys.set(key, playFilter(`sine-dry-${key}`, state, note, null, params, agree));
    return drys.get(key);
  };
  return async (name, note, filter, amp) => {
    const params = { 'A Level': Math.sqrt(amp) };
    const f = noteHz(note);
    const [dry, y] = await Promise.all([
      dryOf(note, amp, params),
      playFilter(`sine-${name}-${note}-${amp}`, state, note, filter, params, agree),
    ]);
    return harmonicGains((x, k) => filterLevel(x, k * f), dry, y);
  };
};

// --- filter-types ---
if (runs('filter-types')) {
  const EQ = ['Low EQ 6', 'Low EQ 12', 'Band EQ 12', 'High EQ 6', 'High EQ 12'];
  const NORMAL = Object.keys(FILTER_TYPES).filter((name) => !EQ.includes(name));
  // a frame of harmonics 1..1000 of one magnitude, Schroeder phases (its crest low): the response of a filter at
  // every harmonic of the note at once
  const multisine = (() => {
    const x = new Float64Array(2048);
    for (let h = 1; h <= 1000; h++)
      for (let i = 0; i < 2048; i++)
        x[i] += Math.cos((2 * Math.PI * h * i) / 2048 + (Math.PI * h * (h - 1)) / 1000);
    const peak = Math.max(...x.map(Math.abs));
    return Array.from(x, (v) => v / peak);
  })();
  const msState = tableState('filter-multisine', [multisine]);
  const sineState = tableState('filter-sine', [sine()]);
  // the multisine on C1: the gain of a filter (dB against the dry render, -120 at least) at harmonics hs
  const F0 = noteHz(24);
  const ms = (name, filter, params) => playFilter(name, msState, 24, filter, { 'A Level': 0.3, ...params });
  const dryMs = ms('ms-dry', null);
  const gains = async (y, hs) => {
    const dry = await dryMs;
    return hs.map((h) =>
      round(Math.max(-120, 20 * Math.log10(filterLevel(y, h * F0) / filterLevel(dry, h * F0))))
    );
  };
  const CUTS = [100, 300, 1000, 3000, 8000, 15000, 'max'];
  const RES = [0, 0.25, 0.5, 0.75, 1];
  const responses = Promise.all(
    NORMAL.flatMap((type) =>
      CUTS.flatMap((cut) =>
        RES.map(async (res) => {
          const y = await ms(`ms-${FILTER_TYPES[type]}-${cut}-${res}`, { type, cut, res });
          return [type, cut, res, await gains(y, harmonicsAt(cut))];
        })
      )
    )
  );
  // the EQ types by DB +/- (Var)
  const EQ_CUTS = [300, 1000, 3000, 10000];
  const VARS = [0, 0.25, 0.5, 0.75, 1];
  const eqResponses = Promise.all(
    EQ.flatMap((type) =>
      EQ_CUTS.flatMap((cut) =>
        [0, 0.5, 1].flatMap((res) =>
          VARS.map(async (v) => {
            const y = await ms(`eq-${FILTER_TYPES[type]}-${cut}-${res}-${v}`, { type, cut, res, var: v });
            return [type, cut, res, v, await gains(y, harmonicsAt(cut))];
          })
        )
      )
    )
  );
  // the law of DB +/-: the gain of Low EQ 6 at 1 kHz on C1 (h1, 32.7 Hz) and of High EQ 6 at 300 Hz at h 245 (8 kHz)
  const DB_VARS = Array.from({ length: 21 }, (_, i) => i / 20);
  const dbLaw = Promise.all(
    DB_VARS.map(async (v) => {
      const [low] = await gains(await ms(`dblaw-low-${v}`, { type: 'Low EQ 6', cut: 1000, var: v }), [1]);
      const [high] = await gains(await ms(`dblaw-high-${v}`, { type: 'High EQ 6', cut: 300, var: v }), [245]);
      return [v, low, high];
    })
  );
  const sineGains = sineGainsOf(sineState);
  // Drive: the gain of a quiet sine (220 Hz, -60 dB) by the knob, Low 12 open; then the saturation of louder ones
  // at Drive 0, 0.5 and 1, before Low 12 and MG Low 12 open
  const DRIVES = Array.from({ length: 11 }, (_, i) => i / 10);
  const AMPS = [0.01, 0.03, 0.1, 0.2, 0.3, 0.5625, 1];
  const driveLaw = Promise.all(
    DRIVES.map(async (drive) => [
      drive,
      (await sineGains(`drive-${drive}`, 57, { type: 'Low 12', cut: 'max', drive }, 0.001))[0],
    ])
  );
  const driveCurves = Promise.all(
    ['Low 12', 'MG Low 12'].flatMap((type) =>
      [0, 0.5, 1].flatMap((drive) =>
        AMPS.map(async (amp) => [
          type,
          drive,
          amp,
          ...(await sineGains(`drive-${FILTER_TYPES[type]}-${drive}`, 57, { type, cut: 'max', drive }, amp)),
        ])
      )
    )
  );
  // where the drive is: a sine at 220, 440 and 880 Hz before Low 12 at 1.5 kHz (its harmonics filtered or not)
  const drivePlace = Promise.all(
    [57, 69, 81].map(async (note) => [
      note,
      ...(await sineGains(`drive-place`, note, { type: 'Low 12', cut: 1500, drive: 1 }, 0.1)),
    ])
  );
  // FAT (Var of the types of Normal) and the saturation of a resonance: a sine at the cutoff (B5, 987.8 Hz) by
  // its amplitude, the resonance and FAT
  const FAT_TYPES = ['Low 12', 'Low 24', 'High 12', 'Band 12', 'Peak 12', 'MG Low 12', 'MG Low 24'];
  const FAT_AMPS = [0.001, 0.03, 0.1, 0.3, 0.5625, 1];
  const fat = Promise.all(
    FAT_TYPES.flatMap((type) =>
      [0.5, 0.9, 1].flatMap((res) =>
        [0, 0.5, 1].flatMap((v) =>
          FAT_AMPS.map(async (amp) => [
            type,
            res,
            v,
            amp,
            ...(await sineGains(
              `fat-${FILTER_TYPES[type]}-${res}-${v}`,
              83,
              { type, cut: noteHz(83), res, var: v },
              amp
            )),
          ])
        )
      )
    )
  );
  // FAT on the multisine (quiet: the response of the small signal) at 1 kHz
  const fatResponses = Promise.all(
    FAT_TYPES.flatMap((type) =>
      [0.25, 0.5, 0.75, 1].flatMap((res) =>
        [0.5, 1].map(async (v) => {
          const y = await ms(`fatms-${FILTER_TYPES[type]}-${res}-${v}`, { type, cut: 1000, res, var: v });
          return [type, res, v, await gains(y, harmonicsAt(1000))];
        })
      )
    )
  );
  try {
    const result = {
      about:
        'Filter 1 of a voice of the Audio Unit (osc A alone goes through it, its table ours), Freq the note ' +
        '136.8 v. responses: a multisine on C1 (harmonics 1..1000 of one magnitude, Schroeder phases, at the ' +
        'amplitude 0.09 into the filter), the gain of each type (dB against the filter off, -120 at least) at ' +
        'harmonics `harmonics[cut]` of 32.703 Hz, by the cutoff (Hz) and the resonance (0..1), Drive and Var 0: ' +
        '[type, cut, res, gains]. eq: the EQ types the same by DB +/- (Var 0..1): [type, cut, res, var, gains]. ' +
        'dbLaw: [var, the gain of Low EQ 6 at 1 kHz on 32.7 Hz, of High EQ 6 at 300 Hz on 8 kHz]. Sines (osc A ' +
        'on a sine at the amplitude A Level²): [gain of the fundamental against the filter off (dB), harmonics ' +
        '2..7 under it (dB)]. driveLaw: [drive, gain] of a sine of 220 Hz at -60 dB before Low 12 open. ' +
        'driveCurves: [type, drive, amplitude, gain, harmonics] of a sine of 220 Hz, the type open. drivePlace: ' +
        '[note, gain, harmonics] of a sine at amplitude 0.1 before Low 12 at 1.5 kHz, Drive 1. fat: [type, res, ' +
        'var, amplitude, gain, harmonics] of a sine at the cutoff (987.8 Hz). fatResponses: [type, res, var, ' +
        'gains] of the multisine at 1 kHz. scripts/renders/run.mjs --only=filter-types',
      rate: RATE,
      f0: round(F0, 4),
      types: FILTER_TYPES,
      harmonics: Object.fromEntries(
        [...new Set([...CUTS, ...EQ_CUTS])].map((cut) => [cut, harmonicsAt(cut)])
      ),
      responses: await responses,
      eq: await eqResponses,
      dbLaw: await dbLaw,
      driveLaw: await driveLaw,
      driveCurves: await driveCurves,
      drivePlace: await drivePlace,
      fat: await fat,
      fatResponses: await fatResponses,
    };
    writeRows(join(out, 'filter-types.json'), result);
    console.log(
      'dsp/measurements: filter-types',
      result.responses.length,
      result.eq.length,
      result.fat.length
    );
  } finally {
    removeTables();
  }
}

// --- filter-resonance ---
if (runs('filter-resonance')) {
  // the resonance of a type at Res 0.9 and 1 by the cutoff (filter-types reads it at 987.8 Hz alone): a quiet
  // sine (1e-4, its small signal) at a note with the cutoff `cents` under it (the sine `cents` over the cutoff),
  // and a sine at the cutoff by its amplitude (the saturation)
  const TYPES = ['MG Low 12', 'MG Low 24', 'Low 12', 'Band 12'];
  const RES = [0.9, 1];
  const NOTES = [48, 60, 72, 83, 95, 107, 115];
  const CENTS = Array.from({ length: 17 }, (_, i) => -40 + 5 * i);
  const AMPS = [0.01, 0.03, 0.1, 0.3, 1];
  // the fine grids of MG Low 24 around its peak (its resonance a few cents wide at Res 1): [from, to, step] cents by Res
  const FINE = [
    [0.8, -240, 40, 10],
    [0.9, -160, 40, 8],
    [0.95, -100, 30, 5],
    [0.98, -50, 25, 2.5],
    [1, -16, 16, 1],
  ];
  const sineGains = sineGainsOf(tableState('filter-resonance-sine', [sine()]), true);
  // `--parts=peaks,levels,fine`: those rendered again, the others kept from the file
  const parts = process.argv
    .find((arg) => arg.startsWith('--parts='))
    ?.slice(8)
    .split(',');
  const file = join(out, 'filter-resonance.json');
  const before = parts ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const part = (name, rows) => (!parts || parts.includes(name) ? Promise.all(rows()) : before[name]);
  const fine = part('fine', () =>
    FINE.flatMap(([res, from, to, step]) =>
      NOTES.flatMap((note) =>
        Array.from({ length: Math.round((to - from) / step) + 1 }, (_, i) => from + i * step).map(
          async (cents) => {
            const cut = noteHz(note) * 2 ** (-cents / 1200);
            const [gain] = await sineGains(
              `fine-${res}-${cents}`,
              note,
              { type: 'MG Low 24', cut, res },
              1e-4
            );
            return ['MG Low 24', res, note, cents, gain];
          }
        )
      )
    )
  );
  const peaks = part('peaks', () =>
    TYPES.flatMap((type) =>
      RES.flatMap((res) =>
        NOTES.flatMap((note) =>
          CENTS.map(async (cents) => {
            const cut = noteHz(note) * 2 ** (-cents / 1200);
            const name = `res-${FILTER_TYPES[type]}-${res}-${cents}`;
            const [gain] = await sineGains(name, note, { type, cut, res }, 1e-4);
            return [type, res, note, cents, gain];
          })
        )
      )
    )
  );
  const levels = part('levels', () =>
    TYPES.flatMap((type) =>
      RES.flatMap((res) =>
        NOTES.flatMap((note) =>
          AMPS.map(async (amp) => [
            type,
            res,
            note,
            amp,
            ...(await sineGains(
              `lvl-${FILTER_TYPES[type]}-${res}`,
              note,
              { type, cut: noteHz(note), res },
              amp
            )),
          ])
        )
      )
    )
  );
  try {
    const result = {
      about:
        'Filter 1 of a voice of the Audio Unit (osc A alone goes through it, on a sine of ours at the amplitude ' +
        'A Level²), Freq the note 136.8 v, Drive and Var 0. peaks: [type, res, note, cents, gain] a sine of 1e-4 ' +
        '(the small signal) at the note, the cutoff `cents` under it: the gain of the sine against the filter off ' +
        '(dB). levels: [type, res, note, amplitude, gain, harmonics] a sine at the cutoff: the gain of its ' +
        'fundamental (dB), its harmonics 2..7 under it (dB). fine: [type, res, note, cents, gain] as peaks, MG Low 24 ' +
        'on fine grids around its peak at Res 0.8..1. scripts/renders/run.mjs --only=filter-resonance ' +
        '[--parts=peaks,levels,fine]',
      rate: RATE,
      peaks: await peaks,
      levels: await levels,
      fine: await fine,
    };
    writeRows(file, result);
    console.log(
      'dsp/measurements: filter-resonance',
      result.peaks.length,
      result.levels.length,
      result.fine.length
    );
  } finally {
    removeTables();
  }
}

// --- warp ---
// the warp of osc A (A Warp Mode, A Warp) on tables of ours, one voice, Rand Phase 0: its map of the phase w(φ) at
// C0 (a sine and a cosine: w = atan2(sin, cos) / 2π, whatever level of the table is read), the harmonics and the
// mean of a saw, a sine and a cosine by the warp at C0, the aliasing of the saw at C6 and C7, the knob moved every sample (the map read
// back sample by sample), the harmonics to 16 kHz of Bend - and Bend +/- at D2 and D4.
// `--parts=curves,spectra,aliasing,moving,notes` renders some of them
if (runs('warp')) {
  const parts = process.argv
    .find((arg) => arg.startsWith('--parts='))
    ?.slice(8)
    .split(',') ?? ['curves', 'spectra', 'aliasing', 'moving', 'notes'];
  const file = join(out, 'warp.json');
  const before = parts.length < 5 ? JSON.parse(readFileSync(file, 'utf8')) : {};
  // the modes of the menu of A Warp Mode measured here (70 of them: the index floor(70 v))
  const MODES = { 'bend+': 2, 'bend-': 3, 'bend+-': 4, pwm: 5 };
  const modeValue = (index) => (index + 0.5) / 70;
  const WARPS = Array.from({ length: 21 }, (_, i) => i / 20);
  const C0 = 12;
  const f0 = 440 * 2 ** ((C0 - 69) / 12);
  const period = RATE / f0;
  const frac = (x) => x - Math.floor(x);
  const cosine = Array.from({ length: 2048 }, (_, i) => Math.cos((2 * Math.PI * i) / 2048));
  const play = (name, state, params, { note = C0, seconds = 0.5, automation, step } = {}) =>
    hostRender(`warp-${name}`, {
      seconds,
      state,
      params: { ...FLAT, 'A Unison': 0, ...params },
      automation,
      step,
      notes: [{ note, on: 0, off: seconds }],
    }).then(([left]) => left);
  const warpParams = (mode, warp) => ({ 'A Warp Mode': modeValue(mode ? MODES[mode] : 0), 'A Warp': warp });
  // the warped phase of each sample of a sine and a cosine render
  const phases = (sin, cos) => Float64Array.from(sin, (v, i) => frac(Math.atan2(v, cos[i]) / (2 * Math.PI)));
  const result = { ...before };
  try {
    const states = {
      sin: tableState('warp-sin', [sine()]),
      cos: tableState('warp-cos', [cosine]),
      saw: tableState('warp-saw', [sawFrame()]),
      // the saw from 0 up, its jump in the middle (frame 0 of Basic Shapes, of Default Shapes of the Audio Unit)
      ramp: tableState('warp-ramp', [sawFrame().map((_, i, saw) => -saw[(i + saw.length / 2) % saw.length])]),
    };
    // the phase of sample i of a note of C0 unwarped: frac(i / period + offset) (the circular mean over 6000..18000)
    const pair = (name, params, options) =>
      Promise.all([
        play(`sin-${name}`, states.sin, params, options),
        play(`cos-${name}`, states.cos, params, options),
      ]);
    const [offSin, offCos] = await pair('off', warpParams(null, 0));
    const unwarped = phases(offSin, offCos);
    let [re, im] = [0, 0];
    for (let i = 6000; i < 18000; i++) {
      re += Math.cos(2 * Math.PI * (unwarped[i] - i / period));
      im += Math.sin(2 * Math.PI * (unwarped[i] - i / period));
    }
    const offset = frac(Math.atan2(im, re) / (2 * Math.PI));
    const phaseAt = (i) => frac(i / period + offset);
    const round6 = (x) => Number(x.toFixed(6));

    if (parts.includes('curves')) {
      // 64 points of the third cycle of each mode and warp: [φ, w] at the samples nearest to φ = j / 64
      const first = Math.ceil((3 - offset) * period);
      result.curves = [];
      await Promise.all(
        Object.keys(MODES).flatMap((mode) =>
          WARPS.map(async (warp) => {
            const w = phases(...(await pair(`${mode}-${warp}`, warpParams(mode, warp))));
            const points = Array.from({ length: 64 }, (_, j) => {
              const i = first + Math.round(((j / 64 - phaseAt(first) + 1) % 1) * period);
              return [round6(phaseAt(i)), round6(w[i])];
            });
            result.curves.push({ mode, warp, points });
          })
        )
      );
      const order = Object.keys(MODES);
      result.curves.sort((a, b) => order.indexOf(a.mode) - order.indexOf(b.mode) || a.warp - b.warp);
    }

    if (parts.includes('spectra')) {
      // the harmonics 1..40 of the saw, the sine and the cosine at C0 (dB against the fundamental unwarped, Hann over
      // 0.3 s) and their mean over 4 cycles from sample 6000 against it (the cosine starts at 1: what PWM holds over
      // the rest of a cycle tells itself there, none of a table that starts at 0)
      const harmonics = (x) =>
        Array.from({ length: 40 }, (_, j) => tone(x, f0 * (j + 1), 6000, 14400).amplitude);
      const cycles = Math.round(4 * period);
      const mean = (x) => {
        let sum = 0;
        for (let i = 6000; i < 6000 + cycles; i++) sum += x[i];
        return sum / cycles;
      };
      const tables = { saw: states.saw, sine: states.sin, cos: states.cos };
      result.spectra = [];
      for (const [table, state] of Object.entries(tables)) {
        const [unwarped] = harmonics(await play(`${table}-spectrum-off`, state, warpParams(null, 0)));
        await Promise.all(
          Object.keys(MODES).flatMap((mode) =>
            WARPS.filter((_, i) => i % 2 === 0).map(async (warp) => {
              const x = await play(`${table}-spectrum-${mode}-${warp}`, state, warpParams(mode, warp));
              const levels = harmonics(x).map((a) => (a > 1e-7 ? dB(a / unwarped) : null));
              const dc = Number((mean(x) / unwarped).toFixed(4));
              result.spectra.push({ table, mode, warp, harmonics: levels, dc });
            })
          )
        );
      }
      result.spectra.sort(
        (a, b) => a.table.localeCompare(b.table) || a.mode.localeCompare(b.mode) || a.warp - b.warp
      );
    }

    if (parts.includes('aliasing')) {
      // the saw at C6 and C7 at 48 kHz, analyze of the oscillator benchmark (as aliasing.json) over the last SIZE
      // samples, at the frequency of the note the fundamental is loudest at within ±1 cent
      const saw = sawFrame();
      const seconds = SIZE / RATE + 0.25;
      result.aliasing = [];
      const cases = [
        [null, 0],
        ...Object.keys(MODES).flatMap((mode) => [
          [mode, 0.5],
          [mode, 1],
        ]),
      ];
      await Promise.all(
        [84, 96].flatMap((note) =>
          cases.map(async ([mode, warp]) => {
            const x = await play(`alias-${note}-${mode}-${warp}`, states.saw, warpParams(mode, warp), {
              note,
              seconds,
            });
            const frequency = loudestFundamental(x, RATE, note);
            const { aliasing, spur } = analyze(x, frequency, RATE, saw);
            result.aliasing.push({
              note,
              mode: mode ?? 'off',
              warp,
              aliasing: +aliasing.toFixed(1),
              spur: +spur.toFixed(1),
            });
          })
        )
      );
      result.aliasing.sort((a, b) => a.note - b.note || a.mode.localeCompare(b.mode) || a.warp - b.warp);
    }

    if (parts.includes('moving')) {
      // Bend + at C0, A Warp automated from 0 to 1 over 0.1..0.4 s, set every sample (step 1): the knob each sample
      // plays, read back from its map (where |2φ - 1| is in 0.2..0.9: the map tells the knob there)
      const automation = [
        {
          name: 'A Warp',
          points: [
            [0.1, 0],
            [0.4, 1],
          ],
        },
      ];
      const [sin, cos] = await pair('moving', warpParams('bend+', 0), { automation, step: 1 });
      const w = phases(sin, cos);
      const knob = [];
      for (let i = Math.round(0.08 * RATE); i < Math.round(0.42 * RATE); i++) {
        const d = 2 * phaseAt(i) - 1;
        if (Math.abs(d) < 0.2 || Math.abs(d) > 0.9) continue;
        const q = w[i] - 0.5;
        const a = (0.5 * d - q) / (2 * q * Math.abs(d) - q - 0.5 * d);
        knob.push([i, round6(a / 0.8)]);
      }
      // the one-pole (a time constant in ms, by 0.1) the knob follows the automation through, best by squares
      const automated = (i) => Math.min(1, Math.max(0, (i / RATE - 0.1) / 0.3));
      const fit = (tau) => {
        const pole = Math.exp(-1 / (tau * 1e-3 * RATE));
        let [y, error, next] = [0, 0, 0];
        for (let i = 0; i <= knob.at(-1)[0]; i++) {
          y = automated(i) + (y - automated(i)) * pole;
          if (knob[next]?.[0] === i) error += (knob[next++][1] - y) ** 2;
        }
        return error;
      };
      let tau = 1;
      for (let t = 1; t <= 50; t += 0.1) if (fit(t) < fit(tau)) tau = t;
      result.moving = { tau: +tau.toFixed(1), knob: knob.filter(([i]) => i % 16 === 0) };
    }

    if (parts.includes('notes')) {
      // Bend - and Bend +/- (a < 0 over 0.5: the wrap of the frame squeezed, its middle stretched) at D2 and D4: the
      // harmonics of the saw and the ramp to 16 kHz, dB against the fundamental of the note unwarped (Hann as spectra)
      const NOTES = [38, 62];
      const harmonics = (x, f) =>
        Array.from({ length: Math.floor(16000 / f) }, (_, j) => tone(x, f * (j + 1), 6000, 14400).amplitude);
      result.notes = [];
      await Promise.all(
        ['saw', 'ramp'].flatMap((table) =>
          NOTES.map(async (note) => {
            const f = 440 * 2 ** ((note - 69) / 12);
            const options = { note };
            const off = await play(`notes-${table}-${note}-off`, states[table], warpParams(null, 0), options);
            const [unwarped] = harmonics(off, f);
            await Promise.all(
              ['bend-', 'bend+-'].flatMap((mode) =>
                [0.1, 0.5, 0.9, 1].map(async (warp) => {
                  const x = await play(
                    `notes-${table}-${note}-${mode}-${warp}`,
                    states[table],
                    warpParams(mode, warp),
                    options
                  );
                  const levels = harmonics(x, f).map((a) => (a > 1e-7 ? dB(a / unwarped) : null));
                  result.notes.push({ table, note, mode, warp, harmonics: levels });
                })
              )
            );
          })
        )
      );
      result.notes.sort(
        (a, b) =>
          a.table.localeCompare(b.table) || a.note - b.note || a.mode.localeCompare(b.mode) || a.warp - b.warp
      );
    }
  } finally {
    removeTables();
  }
  writeRows(file, {
    about:
      'Osc A of the Audio Unit at one voice, Rand Phase 0, on tables of ours, A Warp Mode (its index floor(70 v): Bend + 2, Bend - 3, Bend +/- 4, PWM 5) and A Warp. curves: {mode, warp, points: [φ, w]} the warped phase w of 64 samples of a cycle of C0 at the phase φ of the unwarped note (w = atan2 of a sine and a cosine render / 2π). spectra: {table, mode, warp, harmonics, dc} the harmonics 1..40 of the saw (scripts/bench-osc/sound.mjs), the sine and the cosine at C0, dB against the fundamental unwarped (null: under -140 dB), dc the mean of 4 cycles from sample 6000 against that fundamental. aliasing: {note, mode, warp, aliasing, spur} the saw at C6 and C7 at 48 kHz, analyze of the oscillator benchmark (as aliasing.json). moving: Bend + at C0 with A Warp automated from 0 at 0.1 s to 1 at 0.4 s, set every sample: `knob` [sample, knob] the knob the map of a sample tells (every 16th, where |2φ - 1| is within 0.2..0.9: it moves every sample), `tau` the time constant (ms) of the one-pole it follows the automation through (the one-pole of the knob and its routes in the core, warp::SMOOTHING, is 11.3 ms: an LFO on the knob, 0.5 to 100 Hz at D2 and D4, follows one of 11.3 ms and no delay in every mode, its renders against those of the core at 11.3 and 10.5 ms). notes: {table, note, mode, warp, harmonics} the saw and the ramp (the saw from 0 up, its jump in the middle: frame 0 of Default Shapes) at D2 and D4 by Bend - and Bend +/-, the harmonics to 16 kHz as spectra, dB against the fundamental of the note unwarped. scripts/renders/run.mjs --only=warp [--parts=curves,spectra,aliasing,moving,notes]',
    ...Object.fromEntries(
      ['curves', 'spectra', 'aliasing', 'moving', 'notes'].map((key) => [key, result[key]])
    ),
  });
  console.log('dsp/measurements: warp', parts.join(', '));
}

// --- fxfilter ---
// the filter of the effect rack (FXFilter, an item of type 8; by the manual it "operates identically to the per-voice
// synth filter … as a master effect"): samples of ours at 44.1 kHz played by the noise oscillator (one-shot, osc A
// off) through the rack, rendered at 48 kHz, the rate of filter-types.json (the noise oscillator resamples them alike
// with and without the filter). Its plain params: kParamType (a code; none: its default type), kParamFreq (a knob),
// kParamReso, kParamDrive, kParamVar, kParamStereo (Pan), kParamWet (%), kParamLevelOut (a knob)
const FX_FILTER_CODES = {
  'MG Low 6': 'MgL6',
  'MG Low 12': 'MgL12',
  'MG Low 18': 'MgL18',
  'MG Low 24': 'MgL24',
  'Low 6': 'L6',
  'Low 12': 'L12',
  'Low 18': 'L18',
  'Low 24': 'L24',
  'High 6': 'H6',
  'High 12': 'H12',
  'High 18': 'H18',
  'High 24': 'H24',
  'Band 12': 'B12',
  'Band 24': 'B24',
  'Peak 12': 'P12',
  'Peak 24': 'P24',
  'Notch 12': 'N12',
  'Notch 24': 'N24',
};
if (runs('fxfilter')) {
  const R = RACK_RATE;
  const SECONDS = 1.6;
  const LENGTH = Math.round(SECONDS * R);
  // a multisine on C1 as the one of filter-types (Schroeder phases, the amplitude 0.09), its harmonics under the band
  // of the resampler of the noise oscillator
  const F0 = noteHz(24);
  const TOP = Math.floor(21500 / F0);
  const multisine = (() => {
    const x = new Float64Array(LENGTH);
    for (let h = 1; h <= TOP; h++) {
      const w = (2 * Math.PI * h * F0) / R;
      const phi = (Math.PI * h * (h - 1)) / TOP;
      for (let i = 0; i < LENGTH; i++) x[i] += Math.cos(w * i + phi);
    }
    let peak = 0;
    for (const v of x) peak = Math.max(peak, Math.abs(v));
    return { x: Array.from(x, (v) => (0.09 * v) / peak), each: 0.09 / peak };
  })();
  // the harmonics read at a cutoff: those of filter-types up to TOP
  const harmonicsOf = (cut, spread) => harmonicsAt(cut, TOP, spread);
  const fxOf = (type, { cut, res = 0, drive = 0, v = 0, pan, wet = 100, level } = {}) => ({
    module: 'FXFilter',
    type: 8,
    params: {
      ...(type ? { kParamType: FX_FILTER_CODES[type] } : {}),
      ...(cut === undefined ? {} : { kParamFreq: cut === 'max' ? 1 : filterKnobOf(cut) }),
      kParamReso: res * 100,
      kParamDrive: drive * 100,
      kParamVar: v * 100,
      kParamWet: wet,
      ...(pan === undefined ? {} : { kParamStereo: pan }),
      ...(level === undefined ? {} : { kParamLevelOut: level }),
    },
  });
  // a stand at `rate`: the gains (dB against the empty rack, -120 at least) of the multisine through an effect at
  // harmonics hs, of the `channels` (both unless said), read over 1 s from 0.5 s
  const standAt = (tag, rate) => {
    const stand = rackStand(tag, rate);
    const ms = stand.sampleOf('multisine', [multisine.x]);
    const dry = stand.play(ms, null);
    const start = Math.round(0.5 * rate);
    const level = (x, h) => tone(x, h * F0, start, rate, rate).amplitude;
    // (the dry level of a harmonic of a channel, read once)
    const dryLevels = new Map();
    const dryLevel = (d, c, h) => {
      const key = `${c}-${h}`;
      if (!dryLevels.has(key)) dryLevels.set(key, level(d[c], h));
      return dryLevels.get(key);
    };
    const gains = async (fx, hs, channels = [0, 1]) => {
      const [d, y] = await Promise.all([dry, stand.play(ms, fx)]);
      return channels.map((c) =>
        hs.map((h) => round(Math.max(-120, 20 * Math.log10(level(y[c], h) / dryLevel(d, c, h)))))
      );
    };
    return { stand, ms, dry, start, level, gains };
  };
  const at48 = standAt('fxf', RATE);
  // (rendered after all of 48 kHz: hosts loading different samples at once play the sample of another)
  let at44 = null;
  const left = async (fx, hs) => (await at48.gains(fx, hs, [0]))[0];
  const NORMAL = Object.keys(FX_FILTER_CODES);
  const CUTS = [100, 300, 1000, 3000, 8000, 15000, 'max'];
  const RES = [0, 0.25, 0.5, 0.75, 1];
  // the dry level of a harmonic against the one of the sample: what the rack is given
  const input = at48.dry.then(([d]) => dB(at48.level(d, 10) / multisine.each));
  // a fresh filter (nothing written): its type and knobs by its response
  const FRESH = [
    ...new Set([...LOG_HARMONICS.filter((h) => h <= TOP), ...Array.from({ length: 120 }, (_, i) => i + 1)]),
  ].sort((a, b) => a - b);
  const fresh = at48.gains({ module: 'FXFilter', type: 8, params: {} }, FRESH);
  // without kParamType, Wet 100 and the knobs written: its default type
  const untyped = Promise.all(
    [300, 3000].flatMap((cut) =>
      [0, 0.75].map(async (res) => [cut, res, await left(fxOf(null, { cut, res }), harmonicsOf(cut))])
    )
  );
  const responses = Promise.all(
    NORMAL.flatMap((type) =>
      CUTS.flatMap((cut) =>
        RES.map(async (res) => [type, cut, res, await left(fxOf(type, { cut, res }), harmonicsOf(cut))])
      )
    )
  );
  // at 44.1 kHz: the knob is a frequency whatever the rate
  const ratesOf = () =>
    Promise.all(
      ['Low 12', 'MG Low 24', 'High 12'].flatMap((type) =>
        [300, 3000, 12000].flatMap((cut) =>
          [0, 0.75].map(async (res) => [
            type,
            cut,
            res,
            (await at44.gains(fxOf(type, { cut, res }), harmonicsOf(cut), [0]))[0],
          ])
        )
      )
    );
  // Pan (kParamStereo): Low 12 at Res 0.75, each channel
  const PANS = [0, 10, 25, 40, 50, 60, 75, 90, 100];
  const PAN_CUTS = [300, 1000, 5000];
  const pan = Promise.all(
    PAN_CUTS.flatMap((cut) =>
      PANS.map(async (p) => [
        cut,
        p,
        ...(await at48.gains(fxOf('Low 12', { cut, res: 0.75, pan: p }), harmonicsOf(cut, 0.6))),
      ])
    )
  );
  // Mix (kParamWet): a render at Wet w as a·(Wet 0) + b·(Wet 100), least squares over 1 s of the left channel, the
  // rest of it (dB under the render); Wet 0 against the empty rack the same (a·dry)
  const WETS = [0, 10, 25, 50, 75, 90, 100];
  const mixFx = (wet) => fxOf('Low 12', { cut: 1000, res: 0.5, wet });
  const fit = (y, a, b) => {
    const s = at48.start;
    let [aa, ab, bb, ya, yb, yy] = [0, 0, 0, 0, 0, 0];
    for (let i = s; i < s + RATE; i++) {
      const bi = b ? b[i] : 0;
      aa += a[i] * a[i];
      ab += a[i] * bi;
      bb += bi * bi;
      ya += y[i] * a[i];
      yb += y[i] * bi;
      yy += y[i] * y[i];
    }
    const det = aa * bb - ab * ab;
    const [ka, kb] = b ? [(ya * bb - yb * ab) / det, (yb * aa - ya * ab) / det] : [ya / aa, 0];
    let rest = 0;
    for (let i = s; i < s + RATE; i++) rest += (y[i] - ka * a[i] - kb * (b ? b[i] : 0)) ** 2;
    return [round(ka, 4), round(kb, 4), round(10 * Math.log10(Math.max(rest, 1e-30) / yy), 1)];
  };
  const mix = (async () => {
    const [[y0], [y100], [d]] = await Promise.all([
      at48.stand.play(at48.ms, mixFx(0)),
      at48.stand.play(at48.ms, mixFx(100)),
      at48.dry,
    ]);
    const rows = await Promise.all(
      WETS.map(async (wet) => [wet, ...fit((await at48.stand.play(at48.ms, mixFx(wet)))[0], y0, y100)])
    );
    return { rows, dry: fit(y0, d) };
  })();
  // Level (kParamLevelOut): the gain of harmonic 3 through Low 12 open
  const LEVELS = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1];
  const level = Promise.all(
    LEVELS.map(async (v) => [v, (await left(fxOf('Low 12', { cut: 'max', level: v }), [3]))[0]])
  );
  // sines of ours (44.1 kHz) through the filter: the gain of the fundamental against the empty rack and the
  // harmonics 2..7 under it (dB), over 1 s from 0.5 s
  const sines = new Map();
  const sineOf = (f, amp) => {
    const key = `${f.toFixed(2)}-${amp}`;
    if (!sines.has(key))
      sines.set(
        key,
        at48.stand.sampleOf(`sine-${key}`, [
          Array.from({ length: LENGTH }, (_, i) => amp * Math.sin((2 * Math.PI * f * i) / R)),
        ])
      );
    return sines.get(key);
  };
  const sineGains = async (f, amp, fx) => {
    const sample = sineOf(f, amp);
    const [[d], [y]] = await Promise.all([at48.stand.play(sample, null), at48.stand.play(sample, fx)]);
    return harmonicGains((x, k) => tone(x, k * f, at48.start, RATE).amplitude, d, y);
  };
  // rows of the gains of sines of `f` ({ head, amp, fx }: the row starts with head), in their order, asked sample by
  // sample (an amplitude a sample: renders of one sample run together, never back to one)
  const sineRows = (f, rows) => {
    const asked = new Map();
    [...rows].sort((a, b) => a.amp - b.amp).forEach((row) => asked.set(row, sineGains(f, row.amp, row.fx)));
    return Promise.all(rows.map(async (row) => [...row.head, ...(await asked.get(row))]));
  };
  const A3 = noteHz(57);
  const DRIVES = Array.from({ length: 11 }, (_, i) => i / 10);
  const AMPS = [0.01, 0.03, 0.1, 0.3, 0.5625, 1];
  const driveLaw = Promise.all(
    DRIVES.map(async (drive) => [
      drive,
      (await sineGains(A3, 0.001, fxOf('Low 12', { cut: 'max', drive })))[0],
    ])
  );
  const driveCurves = sineRows(
    A3,
    ['Low 12', 'MG Low 12'].flatMap((type) =>
      [0, 0.5, 1].flatMap((drive) =>
        AMPS.map((amp) => ({ head: [type, drive, amp], amp, fx: fxOf(type, { cut: 'max', drive }) }))
      )
    )
  );
  // FAT and the saturation of a resonance: a sine at the cutoff (B5) by its amplitude
  const B5 = noteHz(83);
  const fat = sineRows(
    B5,
    ['Low 12', 'MG Low 12', 'MG Low 24', 'Band 12'].flatMap((type) =>
      [0.5, 1].flatMap((res) =>
        [0, 1].flatMap((v) =>
          [0.03, 0.3, 1].map((amp) => ({
            head: [type, res, v, amp],
            amp,
            fx: fxOf(type, { cut: B5, res, v }),
          }))
        )
      )
    )
  );
  // a ring: 50 ms of a noise at 0.1, then a silence; the level (dB of the mean square, both channels) every 50 ms
  // from its end, by the type at Res 1 at 1 kHz
  const ring = (async () => {
    let seed = 1;
    const noise = Array.from({ length: LENGTH }, (_, i) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return i < 0.05 * R ? 0.1 * (2 * (seed / 2147483648) - 1) : 0;
    });
    const sample = at48.stand.sampleOf('burst', [noise]);
    return Promise.all(
      ['Low 12', 'MG Low 24', 'Band 12'].map(async (type) => {
        const [l, r] = await at48.stand.play(sample, fxOf(type, { cut: 1000, res: 1 }));
        const end = Math.round(0.1 * RATE);
        const n = Math.round(0.05 * RATE);
        return [
          type,
          Array.from({ length: 24 }, (_, k) => {
            let sum = 0;
            for (let i = end + k * n; i < end + (k + 1) * n; i++) sum += l[i] ** 2 + r[i] ** 2;
            return round(Math.max(-200, 10 * Math.log10(sum / (2 * n))), 1);
          }),
        ];
      })
    );
  })();
  try {
    const result = {
      about:
        'The FX Filter of the effect rack of the Audio Unit (FXFilter, an item of type 8, alone in the rack; osc A ' +
        'off, the noise oscillator plays samples of ours one-shot at 44.1 kHz, rendered at 48 kHz unless said). Its ' +
        'plain params: kParamType (codes: `codes`), kParamFreq (a knob: written as the note 136.8 v of the voice ' +
        'filter, `cut` in Hz), kParamReso, kParamDrive, kParamVar (%), kParamStereo (Pan, %), kParamWet (%), ' +
        'kParamLevelOut (a knob); Wet 100 unless said. input: the dry level of a harmonic of the multisine against ' +
        'the sample (dB). Gains: dB against the empty rack (-120 at least) at harmonics of 32.703 Hz: a multisine on ' +
        'C1 (harmonics 1..`top` of one magnitude, Schroeder phases, the amplitude 0.09 in the sample), read over 1 s ' +
        'from 0.5 s. fresh: [left, right] of a fresh filter at `freshHarmonics`. untyped: [cut, res, gains] ' +
        'without kParamType. responses: [type, cut, res, gains] at `harmonics[cut]` (those of filter-types.json up ' +
        'to `top`), Drive and Var 0. rates: the same at 44.1 kHz. pan: [cut, pan, left, right] Low 12 at Res 0.75 ' +
        'at `panHarmonics[cut]`. mix: rows [wet, a, b, rest] a render at Wet as a·(Wet 0) + b·(Wet 100) (least ' +
        'squares over 1 s of the left channel; rest dB under it), Low 12 at 1 kHz Res 0.5; dry [a, 0, rest] Wet 0 ' +
        'as a·(the empty rack). level: [knob, dB] Low 12 open at harmonic 3. Sines (ours, 44.1 kHz): [gain of the ' +
        'fundamental (dB), harmonics 2..7 under it (dB)]. driveLaw: [drive, gain] a sine of 220 Hz at 0.001 before ' +
        'Low 12 open; driveCurves: [type, drive, amplitude, gain, harmonics] 220 Hz; fat: [type, res, var, ' +
        'amplitude, gain, harmonics] a sine at the cutoff (987.8 Hz). routes: --only=fxfilter-routes. ring: ' +
        '[type, dB every 50 ms] of the mean square after 50 ms of a noise at 0.1, ' +
        'Res 1 at 1 kHz. scripts/renders/run.mjs --only=fxfilter',
      rate: RATE,
      f0: round(F0, 4),
      top: TOP,
      codes: FX_FILTER_CODES,
      input: await input,
      harmonics: Object.fromEntries(CUTS.map((cut) => [cut, harmonicsOf(cut)])),
      panHarmonics: Object.fromEntries(PAN_CUTS.map((cut) => [cut, harmonicsOf(cut, 0.6)])),
      freshHarmonics: FRESH,
      fresh: await fresh,
      untyped: await untyped,
      responses: await responses,
      rates: null,
      pan: await pan,
      mix: await mix,
      level: await level,
      driveLaw: await driveLaw,
      driveCurves: await driveCurves,
      fat: await fat,
      ring: await ring,
    };
    at44 = standAt('fxf44', R);
    result.rates = await ratesOf();
    writeRows(join(out, 'fxfilter.json'), result);
    console.log(
      'dsp/measurements: fxfilter',
      JSON.stringify({ input: result.input, level: result.level, mix: result.mix })
    );
  } finally {
    at48.stand.remove();
    at44?.stand.remove();
  }
}

// --- fxfilter-routes ---
// a route of Macro 1 (source 25) to kParamFreq of the FX Filter (the item 0 of the rack, param 3): a sine of 2 kHz
// through Low 12 at Res 0 from the knob 0.5 (425 Hz), the macro still at 1 (a parameter of the host), the route by
// `amount` (% of the travel of the knob, up or down): [amount, dB of the sine against its level in the sample, the
// peak of |y| over a period at 0.5 s]; `wet`: the macro routed to kParamWet by -100 % (the dry sine); `dryLevel`: Wet 0 at Level 0.25 (whether the level is of the dry signal too). The macro
// automated over a render moves no route of the rack in the host: no steps. Into fxfilter.json
if (runs('fxfilter-routes')) {
  const R = RACK_RATE;
  const stand = rackStand('fxfr', RATE);
  const length = Math.round(1.6 * R);
  const sample = stand.sampleOf('sine', [
    Array.from({ length }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 2000 * i) / R)),
  ]);
  const fx = {
    module: 'FXFilter',
    type: 8,
    params: { kParamType: FX_FILTER_CODES['Low 12'], kParamFreq: 0.5, kParamReso: 0, kParamWet: 100 },
  };
  const slot = (param, name, amount) => ({ source: 25, osc: 0, param, name, type: 'FXFilter', amount });
  const period = RATE / 2000;
  const levelAt = (y, t) => {
    const end = Math.round(t * RATE);
    let peak = 0;
    for (let i = end - period; i < end; i++) peak = Math.max(peak, Math.abs(y[i]));
    return round(20 * Math.log10(peak / 0.3));
  };
  try {
    const AMOUNTS = [-30, -10, 0, 10, 20, 30, 50];
    const routes = await Promise.all(
      AMOUNTS.map(async (amount) => {
        const slots = amount ? [slot(3, 'kParamFreq', amount)] : [];
        const [y] = await stand.play(sample, fx, { slots, params: { 'Macro 1': 1 } });
        return [amount, levelAt(y, 0.5)];
      })
    );
    const [dry] = await stand.play(sample, fx, {
      slots: [slot(1, 'kParamWet', -100)],
      params: { 'Macro 1': 1 },
    });
    // the level of the dry signal: Wet 0 at Level 0.25 (-12 dB if the level is of the whole module, 0 of the wet one
    // alone)
    const [quiet] = await stand.play(sample, {
      ...fx,
      params: { ...fx.params, kParamWet: 0, kParamLevelOut: 0.25 },
    });
    const file = join(out, 'fxfilter.json');
    const result = JSON.parse(readFileSync(file, 'utf8'));
    result.routes = { rows: routes, wet: levelAt(dry, 0.5), dryLevel: levelAt(quiet, 0.5) };
    writeRows(file, result);
    console.log('dsp/measurements: fxfilter routes', JSON.stringify(result.routes));
  } finally {
    stand.remove();
  }
}

// --- fxfilter-lfo ---
// LFO 1 (its default shape: a triangle from 0 up, from the note) routed to kParamFreq of the FX Filter by `amount` % of
// the travel of the knob: a sine of 2 kHz at 0.3 through Low 12 from the knob 0.5 (425 Hz) at each Res, LFO 1 at the
// rates of the delay's (`divisions`: its knob, the Hz at 120 BPM); the level of the sine (dB against 0.3: the rms of a
// period of it, centred, × √2) every 32 samples over a cycle from 1 s after the sine starts. Into fxfilter.json
if (runs('fxfilter-lfo')) {
  const R = RACK_RATE;
  const stand = rackStand('fxfl', RATE, (channels) =>
    channels.some((x) => x.some((value) => Math.abs(value) > 1e-3))
  );
  const SECONDS = 3;
  const AMOUNT = 30;
  const RES = [0, 0.5];
  const DIVISIONS = [
    ['1/4', 0.5, 2],
    ['1/8', 0.58, 4],
    ['1/16', 0.66, 8],
    ['1/32', 0.74, 16],
  ];
  const sample = stand.sampleOf('sine', [
    Array.from(
      { length: Math.round(SECONDS * R) },
      (_, i) => 0.3 * Math.sin((2 * Math.PI * 2000 * i) / R) * Math.min(1, i / 2000)
    ),
  ]);
  const fx = (res) => ({
    module: 'FXFilter',
    type: 8,
    params: { kParamType: FX_FILTER_CODES['Low 12'], kParamFreq: 0.5, kParamReso: res * 100, kParamWet: 100 },
  });
  const slots = [{ source: 6, osc: 0, param: 3, name: 'kParamFreq', type: 'FXFilter', amount: AMOUNT }];
  const period = RATE / 2000;
  try {
    const [dry] = await stand.play(sample, null);
    let S = 0;
    while (Math.abs(dry[S]) < 1e-6) S++;
    const cases = RES.flatMap((res) =>
      DIVISIONS.map(([division, knob, hz]) => ({ res, division, knob, hz }))
    );
    const renders = await Promise.all(
      cases.map(({ res, knob }) => stand.play(sample, fx(res), { slots, params: { 'LFO 1 Rate': knob } }))
    );
    const rows = [];
    cases.forEach(({ hz }, index) => {
      const [y] = renders[index];
      const from = Math.round(1.0 * RATE);
      for (let n = from; n < from + RATE / hz; n += 32) {
        let sum = 0;
        for (let k = -period / 2; k < period / 2; k++) sum += y[S + n + k] ** 2;
        rows.push([index, n, round(20 * Math.log10(Math.sqrt((2 * sum) / period) / 0.3), 3)]);
      }
    });
    const file = join(out, 'fxfilter.json');
    const result = JSON.parse(readFileSync(file, 'utf8'));
    if (!result.about.includes('--only=fxfilter-lfo'))
      result.about = result.about.replace(
        ' ring:',
        ' lfo: --only=fxfilter-lfo, LFO 1 (a triangle from 0 up, from the note) on kParamFreq by `amount` % from the ' +
          'knob 0.5, a sine of 2 kHz at 0.3 through Low 12 at the Res of each case; lfoRows: [case, the sample from ' +
          'the start of the sine, dB of the sine against 0.3 (the rms of a period, centred)] every 32 samples over a ' +
          'cycle from 1 s. ring:'
      );
    delete result.lfo;
    delete result.lfoRows;
    result.lfo = { amount: AMOUNT, knob: 0.5, cases };
    result.lfoRows = rows;
    writeRows(file, result);
    console.log('dsp/measurements: fxfilter lfo', JSON.stringify(result.lfo));
  } finally {
    stand.remove();
  }
}
