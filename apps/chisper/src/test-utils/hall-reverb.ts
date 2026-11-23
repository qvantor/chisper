import { number } from '@chisper/math';

// The Hall of the reference Audio Unit as the knobs of our reverb: what a converter of its presets writes
// (dsp/measurements/reverb.json: its laws; reverb-measured.spec.ts holds the scenes of that file to it). Its Size
// 25, 50 and 75 are fitted on those scenes (FITS), between them a line; its decay and its dampings scale them by the
// measured laws

export interface HallMeasures {
  octaves: number[];
  size: { kParamSize: number; rt60: number[] }[];
  decay: { kParamDelay: number; rt60: number[] }[];
}

// the plain params of a Hall (the defaults of the Audio Unit where one is not written)
export interface HallParams {
  size?: number;
  decay?: number;
  lowDamp?: number;
  highDamp?: number;
  preDelay?: number;
  wet: number;
}

export const HALL_DEFAULTS = { size: 35, decay: 30, lowDamp: 0, highDamp: 35, preDelay: 0 };

// by Size: our size, decay (s, at its default decay), damp (Hz), bass, depth, and the level of our tail against
// its own at the same share of the wet signal
const FITS = [
  { at: 25, size: 0.7051, decay: 3.44, damp: 3865, bass: 1.041, depth: 0.5281, level: 0.8415 },
  { at: 50, size: 0.78, decay: 2.757, damp: 19310, bass: 1.438, depth: 0.4015, level: 0.8714 },
  { at: 75, size: 0.987, decay: 5.08, damp: 20000, bass: 1.019, depth: 0.985, level: 0.6346 },
];
// our size by its Size: the fits, a line to ours at 0 under its Size 25 and to 1 over its Size 75
const SIZES = [{ at: 0, size: 0.45 }, ...FITS, { at: 100, size: 1 }];
// what our tail loses of its level as the wet signal takes over (a dense tail against sparse echoes), a share of
// the wet gain over that of Wet 30
const LEVEL_BY_WET = 0.3274;
const clamp = number.thresholds;

// a row of a table (a sweep, the fits) at `value` of its knob: a line between its rows, the nearest one outside
const between = <T>(rows: T[], knob: (row: T) => number, read: (row: T) => number, value: number) => {
  const v = clamp(value, knob(rows[0]), knob(rows[rows.length - 1]));
  const next = Math.max(
    1,
    rows.findIndex((row) => knob(row) >= v)
  );
  const [a, b] = [rows[next - 1], rows[next]];
  return read(a) + ((read(b) - read(a)) * (v - knob(a))) / (knob(b) - knob(a));
};

// a value of the fits at its Size (a line of their logs: `log`)
const fitted = (key: Exclude<keyof (typeof FITS)[number], 'at'>, size: number, log = false) =>
  log
    ? Math.exp(
        between(
          FITS,
          (fit) => fit.at,
          (fit) => Math.log(fit[key]),
          size
        )
      )
    : between(
        FITS,
        (fit) => fit.at,
        (fit) => fit[key],
        size
      );

// RT60 of its mids (s): the octaves of 500 Hz and 1 kHz
export const mids = (measured: HallMeasures, rt60: number[]) =>
  (rt60[measured.octaves.indexOf(500)] + rt60[measured.octaves.indexOf(1000)]) / 2;

// RT60 of the mids of the Hall by its Size and its decay: the fourth root of the sum of the fourth powers of
// what each gives alone (a large Size rings long whatever the decay, a long decay whatever the Size; measured off
// the axes: `cross` of the file, within 15 %)
export const hallDecay = (measured: HallMeasures, size: number, decay: number) => {
  const byDecay = (value: number) =>
    between(
      measured.decay,
      (row) => row.kParamDelay,
      (row) => mids(measured, row.rt60),
      value
    );
  const bySize = between(
    measured.size,
    (row) => row.kParamSize,
    (row) => mids(measured, row.rt60),
    size
  );
  const alone = Math.max(0, bySize ** 4 - byDecay(HALL_DEFAULTS.decay) ** 4);
  return (alone + byDecay(decay) ** 4) ** 0.25;
};

// the gains of its Wet (0..100): [dry, wet]
export const hallMix = (wet: number) => {
  const s = Math.sin(((wet / 100) * Math.PI) / 2) ** 2;
  return [1 - s * s, s];
};

// the knobs of our reverb (the era Now) and the mix of its slot for a Hall
export const hallReverb = (measured: HallMeasures, hall: HallParams) => {
  const { size, decay, lowDamp, highDamp, preDelay, wet } = { ...HALL_DEFAULTS, ...hall };
  const at = clamp(size, FITS[0].at, FITS[FITS.length - 1].at);
  const [dryGain, wetGain] = hallMix(wet);
  const level = fitted('level', size) * (1 - LEVEL_BY_WET * (wetGain - hallMix(30)[1]));
  return {
    params: {
      lowcut: 20,
      pre: clamp(preDelay, 0, 0.3),
      size: between(
        SIZES,
        (row) => row.at,
        (row) => row.size,
        size
      ),
      // (the fit at the default decay of the nearest fitted Size, by what the Size and the decay make of it)
      decay: clamp(
        (fitted('decay', size, true) * hallDecay(measured, size, decay)) /
          hallDecay(measured, at, HALL_DEFAULTS.decay),
        0.1,
        20
      ),
      // (its damping of the highs: a knob of 25 an octave)
      damp: clamp(fitted('damp', size, true) * 2 ** ((HALL_DEFAULTS.highDamp - highDamp) / 25), 500, 20000),
      // (of the lows: they ring up to a third shorter)
      bass: clamp(fitted('bass', size) * (1 - 0.3 * (lowDamp / 100)), 0.25, 4),
      depth: fitted('depth', size),
      sep: 1,
      er: 0,
      era: 0,
    },
    // the wet signal against the dry one as its gains have them, our tail at its level
    mix: dryGain > 0 ? (2 / Math.PI) * Math.atan(wetGain / (dryGain * level)) : 1,
  };
};
