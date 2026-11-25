// The laws of the delay of the Audio Unit out of its renders (dsp/measurements/delay.json, scripts/renders/run.mjs
// --only=delay): what its knobs are in ours (delayOfAudioUnit of apps/chisper/src/test-utils/delay-render.ts holds
// them, delay-measured.spec.ts the core to them). Prints each law and how far the renders are from it; writes
// nothing
//   node scripts/delay-fit/fit.mjs
import { readFileSync } from 'node:fs';
import { coefficients, magnitudeDb } from '../../libs/math/src/filter/biquad.ts';

const measured = JSON.parse(
  readFileSync(new URL('../../dsp/measurements/delay.json', import.meta.url), 'utf8')
);
const R = measured.rate;
const round = (value, digits = 3) => +value.toFixed(digits);
// (a lag as read is 0.14 of a sample over its sample: the peak of a filtered click between two)
const samples = (lag) => Math.round(lag - 0.14);
// the echo of the free time 0.1 (4364 samples), and whether a lag is a repeat of it: Time and a sample apart
const ECHO = measured.impulse.lags[0];
const repeats = ([lag]) => Math.abs((lag - ECHO) % (ECHO + 1)) < 1.5;

// the free time: an echo max(8, ceil((knob - 1 ms) · rate)) - 2 samples after the sound
const free = measured.free.filter(([, lag]) => lag !== null);
const freeLaw = (knob) => Math.max(8, Math.ceil(Math.fround((knob - 0.001) * R))) - 2;
console.log(
  'free time: the echo against max(8, ceil((knob - 0.001) · rate)) - 2, samples (knob: off)',
  free
    .filter(([knob]) => knob <= 0.4)
    .map(([knob, lag]) => `${knob}: ${samples(lag) - freeLaw(knob)}`)
    .join(', ')
);
console.log(
  'free time over 0.4:',
  measured.free
    .filter(([knob]) => knob > 0.4)
    .map(([knob, lag]) => `${knob}: ${lag === null ? 'no echo' : `${round(samples(lag) / R, 4)} s`}`)
    .join(', ')
);
console.log(
  'the channels apart (an offset is a factor of the time under its 1 ms):',
  measured.apart
    .map(
      ({ echo, kParamTimeL, kParamTimeR, kParamOffsetL = 1, kParamOffsetR = 1 }) =>
        `L ${samples(echo[0]) - (Math.ceil((kParamTimeL - 0.001) * kParamOffsetL * R) - 2)}, R ${
          samples(echo[1]) - (Math.ceil((kParamTimeR - 0.001) * kParamOffsetR * R) - 2)
        }`
    )
    .join('; ')
);

// the sync: the beats of an echo by the knob (at 240 BPM a beat is 11025 samples), the knobs each division is
// found between
const beat = (60 / 240) * R;
const steps = [];
measured.sync.forEach(([knob, lag]) => {
  const beats = lag === null ? null : round((samples(lag) + 2) / beat, 4);
  const last = steps[steps.length - 1];
  if (last && last.beats === beats) last.to = knob;
  else steps.push({ beats, from: knob, to: knob });
});
console.log(
  'sync, beats of the echo by the knob (2 samples before the beat):',
  steps.map(({ beats, from, to }) => `${beats ?? 'over 2.9 s'} at ${from}..${to}`).join(', ')
);
console.log(
  'the tempo of the host (seconds of a fresh time: a beat):',
  measured.tempos.map(([bpm, lag]) => `${bpm ?? 'none'}: ${round((samples(lag) + 2) / R, 4)}`).join(', ')
);

// the feedback: what a repeat is of the one before against the knob (the filter wide: under it by the filter)
console.log(
  'feedback, a repeat of the one before over the knob:',
  measured.feedback
    .filter(([percent, found]) => percent > 0 && found.length > 2)
    .map(([percent, found]) => {
      const main = found.filter(repeats);
      return `${percent} %: ${round(main[1][1] / main[0][1] / (percent / 100))}, ${round(main[2][1] / main[1][1] / (percent / 100))}`;
    })
    .join('; ')
);
// (the echoes of a list, the ripples within 100 samples after the first left out)
const apart = (found) => found.filter(([lag], i) => i === 0 || lag - found[0][0] > 100);
console.log(
  'the times apart (0.05 and 0.08 at 50 %): the right repeats against 0.5^(0.08 / 0.05) of the left ones',
  round(apart(measured.uneven[1])[1][1] / apart(measured.uneven[1])[0][1], 4),
  round((apart(measured.uneven[0])[1][1] / apart(measured.uneven[0])[0][1] / 0.5) * 0.5 ** 1.6, 4)
);

// the mix: the wet gain sin²(knob · π / 2), the dry one 1 - wet²; the level 4v²
const mixed = measured.mix.map(([knob, dry, wet]) => {
  const share = Math.sin((knob * Math.PI) / 2) ** 2;
  return [Math.abs(wet - share), Math.abs(dry - (1 - share * share))];
});
console.log(
  'mix, the worst of the wet gain against sin²(knob π / 2) and of the dry one against 1 - wet²:',
  round(Math.max(...mixed.map(([wet]) => wet)), 4),
  round(Math.max(...mixed.map(([, dry]) => dry)), 4)
);
console.log(
  'level, the gain against 4v²:',
  measured.level.map(([knob, gain]) => `${knob}: ${round(gain - 4 * knob * knob, 4)}`).join(', ')
);

// the bandpass: the cookbook's (0 dB at its peak) at the knob, its Q by BW. The Q of each render by the gain of
// its far skirts, then Q = 1 / (2 sinh(c · BW)) and the worst of every render against the law
const dbAt = (f0, q, f) => magnitudeDb(coefficients('bandpass', { frequency: f0, Q: q, gain: 0 }, R), f, R);
const worst = (f0, q, gains) =>
  Math.max(
    ...measured.frequencies.map((hz, i) =>
      gains[i] > -40 && hz < 16000 ? Math.abs(dbAt(f0, q, hz) - gains[i]) : 0
    )
  );
const fit = (f0, gains) => {
  let [low, high] = [Math.log(0.002), Math.log(4)];
  for (let pass = 0; pass < 60; pass++) {
    const [a, b] = [low + (high - low) / 3, high - (high - low) / 3];
    if (worst(f0, Math.exp(a), gains) < worst(f0, Math.exp(b), gains)) high = b;
    else low = a;
  }
  return Math.exp((low + high) / 2);
};
const rows = measured.filter.filter(
  ([freq, width]) => freq >= 40 && freq <= 18000 && width >= 0.75 && width <= 8.25
);
const widths = [...new Set(rows.map(([, width]) => width))];
const factors = widths.map((width) => {
  const [freq, , gains] = rows.find(([f, w]) => w === width && f === 1000);
  const q = fit(freq, gains);
  return [width, q, Math.asinh(1 / (2 * q)) / width];
});
console.log(
  'bandpass at 1 kHz, [BW, Q, asinh(1 / 2Q) / BW]:',
  factors.map((row) => row.map((value) => round(value, 4)).join(' ')).join('; ')
);
const C = 0.6;
console.log(
  `bandpass, every render against Q = 1 / (2 sinh(${C} BW)), the worst dB under 16 kHz and over -40 dB:`,
  round(
    Math.max(...rows.map(([freq, width, gains]) => worst(freq, 1 / (2 * Math.sinh(C * width)), gains))),
    3
  )
);
console.log(
  'out of its range (as the nearest of it):',
  measured.filter
    .filter(([freq, width]) => !rows.some((row) => row[0] === freq && row[1] === width))
    .map(([freq, width, gains]) => {
      const [f0, bw] = [Math.min(Math.max(freq, 40), 18000), Math.min(Math.max(width, 0.75), 8.25)];
      return `${freq} Hz BW ${width}: ${round(worst(f0, 1 / (2 * Math.sinh(C * bw)), gains), 3)} dB`;
    })
    .join(', ')
);
console.log('a fresh delay:', JSON.stringify(measured.fresh));
console.log(
  'kParamHQ, the first echo [lag, gain] at the free time 0.10001:',
  measured.hq.map(([value, tap]) => `${value}: ${JSON.stringify(tap)}`).join(', ')
);
// the modes: where a click of one channel comes out
measured.modes.forEach(({ input, mode, left, right }) =>
  console.log(
    `mode ${mode}, a click of the ${input} channel: left ${JSON.stringify(apart(left).slice(0, 3))}, right ${JSON.stringify(apart(right).slice(0, 3))}`
  )
);
