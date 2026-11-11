// The tables of the oversampling cascade of the distortion (dsp/dsp-core/src/consts.rs: CASCADE_*), as the bits of
// each double. The first stage: a Kaiser sinc (β 5) by 2 whose window is 15 samples wide each way (its delay), up
// cut at 0.9 of the nyquist (also read 1/8 of a sample later, its top lifted: the half point the ADAA of the hard
// clip delays, the top its mean of two points takes off),
// down at the nyquist (its odd stream: the even one is its centre alone). The second: halfbands (a Kaiser sinc cut
// at a quarter of the rate), 7 taps up (β 4) and 11 down (β 5), their even taps alone (the others are 0 but the
// centre), each side summing to the gain of its centre. run.mjs holds how they were chosen.
//
//   node scripts/distortion-adaa/tables.mjs
const TAPS = 32;
const BETA = 5;
const CENTRE = 15;

const besselI0 = (x) => {
  let sum = 1;
  let term = 1;
  for (let k = 1; term > sum * 1e-16; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
  }
  return sum;
};
const sinc = (x) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
const kaiserSinc = (x, halfWidth, beta, cutoff = 1) => {
  if (x <= -halfWidth || x >= halfWidth) return 0;
  const r = x / halfWidth;
  return (cutoff * sinc(cutoff * x) * besselI0(beta * Math.sqrt(1 - r * r))) / besselI0(beta);
};
// tap j of a phase weighs the sample written j steps ago: `offset` of a sample after the centre. `lift`: less that
// share of itself half a sample before and after (the top the mean of two points takes off: run.mjs)
const phase = (offset, cutoff, lift = 0) => {
  const at = (x) => kaiserSinc(x, CENTRE, BETA, cutoff);
  const kernel = Float64Array.from({ length: TAPS }, (_, j) => {
    const x = j - CENTRE + offset;
    return (1 + 2 * lift) * at(x) - lift * (at(x - 0.5) + at(x + 0.5));
  });
  const sum = kernel.reduce((a, b) => a + b);
  return kernel.map((tap) => tap / sum);
};
// the even taps of a halfband of `length` (the first half: they are symmetric), their sum over both halves `gain`
const halfband = (length, beta, gain) => {
  const half = (length - 1) / 2;
  const taps = Array.from({ length: (half + 1) / 2 }, (_, k) =>
    kaiserSinc((2 * k - half) / 2, (half + 1) / 2, beta, 1)
  );
  const sum = 2 * taps.reduce((a, b) => a + b);
  return taps.map((tap) => (tap * gain) / sum);
};

const bits = (value) => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return `f64::from_bits(0x${view.getBigUint64(0).toString(16).padStart(16, '0')})`;
};
const row = (values) => `[\n${[...values].map((value) => `    ${bits(value)},`).join('\n')}\n]`;
const table = (name, rows) =>
  `pub const ${name}: [[f64; ${TAPS}]; ${rows.length}] = [\n${rows
    .map((values) => `    [\n${[...values].map((value) => `        ${bits(value)},`).join('\n')}\n    ],`)
    .join('\n')}\n];`;

console.log(
  [
    table(
      'CASCADE_UP_PHASES',
      [0, 0.5].map((offset) => phase(offset, 0.9))
    ),
    table(
      'CASCADE_UP_LATE_PHASES',
      [0, 0.5].map((offset) => phase(offset + 1 / 8, 0.9, 1 / 32))
    ),
    table('CASCADE_DOWN_PHASE', [phase(0.5, 1)]),
    `pub const CASCADE_HALF_UP: [f64; 2] = ${row(halfband(7, 4, 1))};`,
    `pub const CASCADE_HALF_DOWN: [f64; 3] = ${row(halfband(11, 5, 0.5))};`,
  ].join('\n\n')
);
