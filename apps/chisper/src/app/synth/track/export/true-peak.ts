import { fir } from '@chisper/math';
import { TRUE_PEAK_DELAY } from '../../common/limiter/limiter-params';

// the 4× interpolator of the true peak detector of the limiter (dsp-core true_peak.rs, its taps worked out by the same
// sincPhase: Kaiser β 5, 32 taps a phase centred on its delay, cut at the nyquist): its phases 1..3, the points between
// two samples
const FACTOR = 4;
const TAPS = 2 * TRUE_PEAK_DELAY;
const BETA = 5;
let phases: Float64Array[] | null = null;

// The 4× true peak of the samples `from`..`to` of `x` (the most absolute of each sample and of the three points
// after it, before the next): around the file silence, or (`cyclic`, a loop) its other end
export const truePeak = (x: Float32Array, from = 0, to = x.length, cyclic = false) => {
  phases ??= [1, 2, 3].map((phase) => fir.sincPhase(phase, FACTOR, TAPS, BETA));
  const [p1, p2, p3] = phases;
  const n = x.length;
  const at = (i: number) => (i >= 0 && i < n ? x[i] : cyclic && n > 0 ? x[((i % n) + n) % n] : 0);
  let peak = 0;
  for (let i = from; i < to; i++) {
    // (point i + p/4 is phase p read with sample i + TRUE_PEAK_DELAY the newest: tap j weighs the sample j before it;
    // the three phases in one pass over the samples, each summed in the order of its taps)
    const newest = i + TRUE_PEAK_DELAY;
    let s1 = 0;
    let s2 = 0;
    let s3 = 0;
    if (newest - TAPS + 1 >= 0 && newest < n)
      for (let j = 0; j < TAPS; j++) {
        const v = x[newest - j];
        s1 += p1[j] * v;
        s2 += p2[j] * v;
        s3 += p3[j] * v;
      }
    else
      for (let j = 0; j < TAPS; j++) {
        const v = at(newest - j);
        s1 += p1[j] * v;
        s2 += p2[j] * v;
        s3 += p3[j] * v;
      }
    peak = Math.max(peak, Math.abs(x[i]), Math.abs(s1), Math.abs(s2), Math.abs(s3));
  }
  return peak;
};
