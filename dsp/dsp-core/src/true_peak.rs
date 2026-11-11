//! The 4× true peak of a stream (the true-peak.ts of the app), the interpolation skipped while the last TAPS samples
//! are too quiet to reach the threshold; a detector per channel of the limiter. The samples are f32 as the input
//! is, the three phases between them FIRs in f32 (fir::dot): their peaks within 1e-6 of the ones in doubles

use crate::consts::{TRUE_PEAK_BOUND, TRUE_PEAK_PHASES};
use crate::fir::{dot, lanes_of, phases};
use crate::simd::F64x2;

pub const TRUE_PEAK_TAPS: usize = 32;
pub const TRUE_PEAK_DELAY: usize = TRUE_PEAK_TAPS / 2;

static PHASES: [[f32; TRUE_PEAK_TAPS]; 3] = phases(&TRUE_PEAK_PHASES, false, 1.0);

/// the true peaks of the left and the right channel, in the low and the high lane
pub struct StereoTruePeak {
    quiet: f64,
    // the last TAPS samples of each channel, the newest first, written twice
    history: [[f32; 2 * TRUE_PEAK_TAPS]; 2],
    pos: usize,
    // the samples each channel still interpolates since its last loud one
    loud: [usize; 2],
}

impl StereoTruePeak {
    pub fn new(threshold: f64) -> StereoTruePeak {
        StereoTruePeak {
            quiet: threshold / TRUE_PEAK_BOUND,
            history: [[0.0; 2 * TRUE_PEAK_TAPS]; 2],
            pos: 0,
            loud: [0, 0],
        }
    }

    /// the last TAPS samples of both channels were too quiet to reach the threshold
    pub fn quiet(&self) -> bool {
        self.loud == [0, 0]
    }

    // the peak of a channel at its new sample (an f32 as a double)
    #[inline(always)]
    fn channel(&mut self, channel: usize, sample: f32) -> f64 {
        let pos = self.pos;
        let history = &mut self.history[channel];
        history[pos] = sample;
        history[pos + TRUE_PEAK_TAPS] = sample;
        let mut peak = history[pos + TRUE_PEAK_DELAY].abs();
        let x = sample as f64;
        self.loud[channel] = if x >= self.quiet || -x >= self.quiet {
            TRUE_PEAK_TAPS
        } else {
            self.loud[channel].saturating_sub(1)
        };
        if self.loud[channel] != 0 {
            let window = &history[pos..pos + TRUE_PEAK_TAPS];
            for phase in &PHASES {
                let between = dot(window, &lanes_of(phase)).abs();
                // (a NaN is taken: samples near the top of f32 sum to an infinity, or to none)
                if between > peak || between.is_nan() {
                    peak = between;
                }
            }
            // the top of f32 at most: an infinity would never let the limiter go
            if peak > f32::MAX || peak.is_nan() {
                peak = f32::MAX;
            }
        }
        peak as f64
    }

    #[inline(always)]
    pub fn next(&mut self, l: f32, r: f32) -> F64x2 {
        self.pos = if self.pos == 0 {
            TRUE_PEAK_TAPS - 1
        } else {
            self.pos - 1
        };
        F64x2::new(self.channel(0, l), self.channel(1, r))
    }

    /// as `n` samples of +0 on both sides once the history holds only +0 and both channels are quiet: the ring
    /// moves on, nothing else changes
    pub fn skip(&mut self, n: usize) {
        self.pos = (self.pos + TRUE_PEAK_TAPS - n % TRUE_PEAK_TAPS) % TRUE_PEAK_TAPS;
    }

    /// the bits of its state (the specs of a core compare a core that skipped silence with one that rendered it)
    pub fn state_bits(&self) -> impl Iterator<Item = u64> + '_ {
        let history = self.history.iter().flatten().map(|h| h.to_bits() as u64);
        [self.pos as u64, self.loud[0] as u64, self.loud[1] as u64]
            .into_iter()
            .chain(history)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::consts::CEILING;
    use jsmath::max;

    // the detector of one channel in doubles, its sums in the order of the taps
    struct TruePeak {
        quiet: f64,
        history: [f64; 2 * TRUE_PEAK_TAPS],
        pos: usize,
        loud: usize,
    }

    impl TruePeak {
        fn new(threshold: f64) -> TruePeak {
            TruePeak {
                quiet: threshold / TRUE_PEAK_BOUND,
                history: [0.0; 2 * TRUE_PEAK_TAPS],
                pos: 0,
                loud: 0,
            }
        }

        fn next(&mut self, x: f64) -> f64 {
            self.pos = if self.pos == 0 {
                TRUE_PEAK_TAPS - 1
            } else {
                self.pos - 1
            };
            let pos = self.pos;
            self.history[pos] = x;
            self.history[pos + TRUE_PEAK_TAPS] = x;
            let peak = self.history[pos + TRUE_PEAK_DELAY].abs();
            if x >= self.quiet || -x >= self.quiet {
                self.loud = TRUE_PEAK_TAPS;
            } else if self.loud > 0 {
                self.loud -= 1;
            }
            if self.loud == 0 {
                return peak;
            }
            let window = &self.history[pos..pos + TRUE_PEAK_TAPS];
            let [p1, p2, p3] = &TRUE_PEAK_PHASES;
            let mut y1 = 0.0;
            let mut y2 = 0.0;
            let mut y3 = 0.0;
            for j in 0..TRUE_PEAK_TAPS {
                let h = window[j];
                y1 += h * p1[j];
                y2 += h * p2[j];
                y3 += h * p3[j];
            }
            max(max(max(peak, y1.abs()), y2.abs()), y3.abs())
        }
    }

    // a deterministic noise within ±1 (xorshift)
    fn noise(seed: u64) -> impl FnMut() -> f64 {
        let mut x = seed;
        move || {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            (x >> 11) as f64 / (1u64 << 52) as f64 - 1.0
        }
    }

    // each channel loud and quiet in stretches of its own (one loud while the other is quiet, both, neither), around
    // the bound and on it: every lane the detector of its channel in doubles, within 1e-6 of its peak
    #[test]
    fn each_lane_is_the_detector_of_its_channel() {
        let mut next = noise(5);
        let mut stereo = StereoTruePeak::new(CEILING);
        let (mut left, mut right) = (TruePeak::new(CEILING), TruePeak::new(CEILING));
        let quiet = CEILING / TRUE_PEAK_BOUND;
        let level = |stretch: usize, channel: usize| match (stretch / (7 + 5 * channel)) % 5 {
            0 => 0.0,
            1 => 0.2 * quiet,
            2 => 1.1 * quiet,
            3 => 3.0,
            _ => 0.9 * quiet,
        };
        let (mut interpolated, mut one_loud) = (0, 0);
        for step in 0..60000 {
            let stretch = step / 50;
            let mut sample = |channel| match step % 97 {
                // the bound itself, either sign
                0 => quiet,
                1 => -quiet,
                _ => level(stretch, channel) * next(),
            } as f32;
            let (l, r) = (sample(0), sample(1));
            let peak = stereo.next(l, r);
            let (l, r) = (l as f64, r as f64);
            for (ours, exact) in [(peak.lo(), left.next(l)), (peak.hi(), right.next(r))] {
                assert!(
                    (ours - exact).abs() <= 1e-6 * exact,
                    "step {step}: {ours} != {exact}"
                );
            }
            interpolated += usize::from(!stereo.quiet());
            one_loud += usize::from((stereo.loud[0] == 0) != (stereo.loud[1] == 0));
        }
        assert!(interpolated > 10000 && one_loud > 5000);
    }

    // samples at the top of f32: their sums overflow, the peak is the top of f32, never an infinity or a NaN
    #[test]
    fn the_peak_of_the_loudest_samples_is_finite() {
        let mut stereo = StereoTruePeak::new(CEILING);
        for step in 0..200 {
            let x = if step % 3 == 0 { f32::MAX } else { -f32::MAX };
            let peak = stereo.next(x, -x);
            assert!(peak.lo() <= f32::MAX as f64 && peak.hi() <= f32::MAX as f64);
        }
    }
}
