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
// Its knobs are 0..1: the times are 32 s · v⁵, the sustain v² (-12 dB at 0.5), the voices 1 + 15v.
// `--only=envelopes,unison,unison-modes,phases,frames,frame-fades,aliasing,spread,blend,noise,sub,compressor,chorus`
// renders some of them
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { downloadTables, fileName, readEnv } from '../bench-common.mjs';
import { analyze, frameOf, PITCHES, sawFrame, SIZE, TABLES } from '../bench-osc/sound.mjs';
import { editedState, noisesFolder, tables, writeSample, writeTable } from './state.mjs';

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
// the complex amplitude of a tone of `frequency` in x over n samples from `from` (Hann): its amplitude and its
// phase (degrees) against a sine from sample 0
const tone = (x, frequency, from, n) => {
  let re = 0;
  let im = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const phase = (2 * Math.PI * frequency * (from + i)) / RATE;
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
const dB = (v) => +(20 * Math.log10(v)).toFixed(3);
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
  const fundamental = (x, rate, note) => {
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
// state.mjs; null: an empty rack, the dry signal)
const RACK_RATE = 44100;
const rackStand = (tag) => {
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
  const render = (sample, fx) => {
    if (laneSample !== sample.path) {
      const before = laneJobs;
      lane = lane.then(() => Promise.allSettled(before));
      laneSample = sample.path;
      laneJobs = [];
    }
    const name = `${tag}-${renders++}`;
    const state = join(work, `state-${name}.bin`);
    writeFileSync(state, editedState(init, [], [], sample, fx && [fx]));
    const seconds = sample.frames / R + 0.3;
    const once = (attempt) =>
      hostRender(`${name}-${attempt}`, {
        rate: R,
        seconds,
        state,
        params: NOISE,
        notes: [{ note: 72, on: 0.05, off: seconds - 0.02 }],
      });
    const same = (a, b) =>
      a.every((channel, c) => channel.every((value, i) => Math.abs(value - b[c][i]) < 1e-5));
    // rendered until two renders in a row agree (now and then a render is of another state: one in a hundred)
    const job = lane.then(async () => {
      let [before, last] = [await once(0), await once(1)];
      for (let attempt = 2; !same(before, last); attempt++) {
        if (attempt > 5) throw new Error(`the renders of ${name} never agree`);
        [before, last] = [last, await once(attempt)];
      }
      return last;
    });
    laneJobs.push(job);
    return job;
  };
  // a sample through the rack, rendered once
  const play = (sample, fx) => {
    const key = `${sample.path} ${JSON.stringify(fx)}`;
    if (!played.has(key)) played.set(key, render(sample, fx));
    return played.get(key);
  };
  return { sampleOf, play, remove: () => samples.splice(0).forEach((file) => rmSync(file, { force: true })) };
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
  // where the click of the dry render at `at` comes out of a wet channel: its correlation with the dry click
  // over the lags [-8, to), the peaks above `floor` of the dry one (parabolic): [lag in samples, gain]
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
