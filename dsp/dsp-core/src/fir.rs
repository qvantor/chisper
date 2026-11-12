//! A FIR of 32 taps in f32: four taps in the lanes, the sum of the lanes at the end. The tables of `consts` are
//! doubles, their phases as f32 here

use crate::simd::F32x4;

pub const TAPS: usize = 32;

/// the taps of each phase in f32, × scale; `reverse`: the other way round (for a window that runs forward in time)
pub const fn phases<const N: usize>(taps: &[[f64; TAPS]; N], reverse: bool, scale: f64) -> [[f32; TAPS]; N] {
    let mut out = [[0.0f32; TAPS]; N];
    let mut p = 0;
    while p < N {
        let mut k = 0;
        while k < TAPS {
            out[p][k] = (taps[p][if reverse { TAPS - 1 - k } else { k }] * scale) as f32;
            k += 1;
        }
        p += 1;
    }
    out
}

/// the taps of a phase, four a lane
#[inline(always)]
pub fn lanes_of(taps: &[f32; TAPS]) -> [F32x4; TAPS / 4] {
    core::array::from_fn(|k| F32x4::load(&taps[4 * k..]))
}

/// the sum of window[k] · taps[k] over the 32 taps: four sums of four lanes each (taps 0..4 and 16..20 in the
/// first, 4..8 and 20..24 in the second…), added as (0 + 1) + (2 + 3), then the lanes as F32x4::sum
#[inline(always)]
pub fn dot(window: &[f32], taps: &[F32x4; TAPS / 4]) -> f32 {
    assert!(window.len() >= TAPS);
    let at = |k: usize| F32x4::load(&window[4 * k..]) * taps[k];
    let a = at(0) + at(4);
    let b = at(1) + at(5);
    let c = at(2) + at(6);
    let d = at(3) + at(7);
    ((a + b) + (c + d)).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_dot_is_the_sum_of_the_products() {
        let window: [f32; TAPS] = core::array::from_fn(|k| (k as f32 * 0.37).sin());
        let taps: [f32; TAPS] = core::array::from_fn(|k| (k as f32 * 1.3).cos());
        let exact: f64 = (0..TAPS).map(|k| window[k] as f64 * taps[k] as f64).sum();
        assert!((dot(&window, &lanes_of(&taps)) as f64 - exact).abs() < 1e-6);
    }
}
