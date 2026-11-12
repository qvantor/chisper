//! log2 and 2^x of four lanes of f32: the exponent by the bits, the rest a polynomial of sums and products in one
//! order (no fused product, no table): the same bits in every browser and in Node. Their errors are far under what
//! a gain shows (the tests hold them against jsmath)

use dsp_core::simd::{F32x4, U32x4};

// 2 / (k ln 2): log2((1 + s) / (1 - s)) = 2 / ln 2 (s + s³ / 3 + s⁵ / 5 + s⁷ / 7 …)
const LOG_1: f32 = 2.885_39;
const LOG_3: f32 = 0.961_796_7;
const LOG_5: f32 = 0.577_078;
const LOG_7: f32 = 0.412_198_57;
// ln(2)^k / k!: 2^f = 1 + f ln 2 + (f ln 2)² / 2 …
const EXP_1: f32 = core::f32::consts::LN_2;
const EXP_2: f32 = 0.240_226_5;
const EXP_3: f32 = 0.055_504_11;
const EXP_4: f32 = 0.009_618_129;
const EXP_5: f32 = 0.001_333_355_8;
const EXP_6: f32 = 0.000_154_035_3;

/// log2 of lanes over 0 (within 2e-6 for a normal x; 0 and the denormals read as their bits: -127 and up, a level
/// under every threshold)
#[inline(always)]
pub fn log2(x: F32x4) -> F32x4 {
    let bits = x.bits();
    let exponent = bits.shifted(23).to_f32() - F32x4::splat(127.0);
    // the mantissa in [1, 2), then in [√½, √2): the series of s = (m - 1) / (m + 1) stays short
    let mantissa = F32x4::from_bits(bits.and(U32x4::splat(0x007f_ffff)).or(U32x4::splat(0x3f80_0000)));
    let upper = mantissa.over(F32x4::splat(core::f32::consts::SQRT_2));
    let mantissa = (mantissa * F32x4::splat(0.5)).or_else(upper, mantissa);
    let exponent = (exponent + F32x4::splat(1.0)).or_else(upper, exponent);
    let s = (mantissa - F32x4::splat(1.0)) / (mantissa + F32x4::splat(1.0));
    let s2 = s * s;
    let series = F32x4::splat(LOG_1)
        + s2 * (F32x4::splat(LOG_3) + s2 * (F32x4::splat(LOG_5) + s2 * F32x4::splat(LOG_7)));
    exponent + s * series
}

/// 2^y of lanes (y held to -126..126), within 3e-7 of it
#[inline(always)]
pub fn exp2(y: F32x4) -> F32x4 {
    let y = y.max(F32x4::splat(-126.0)).min(F32x4::splat(126.0));
    let whole = (y + F32x4::splat(0.5)).floor();
    // the rest in -0.5..0.5
    let f = y - whole;
    let series = F32x4::splat(1.0)
        + f * (F32x4::splat(EXP_1)
            + f * (F32x4::splat(EXP_2)
                + f * (F32x4::splat(EXP_3)
                    + f * (F32x4::splat(EXP_4) + f * (F32x4::splat(EXP_5) + f * F32x4::splat(EXP_6))))));
    let power = F32x4::from_bits(whole.to_int().plus(U32x4::splat(127)).shifted_left(23));
    series * power
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log2_is_the_one_of_doubles() {
        let mut worst = 0.0f64;
        let mut x = 1e-30f32;
        while x < 1e30 {
            let got = log2(F32x4::new(x, x * 1.01, x * 1.3, x * 1.9)).lanes();
            for (lane, factor) in [1.0f32, 1.01, 1.3, 1.9].iter().enumerate() {
                let exact = jsmath::log2((x * factor) as f64);
                worst = jsmath::max(worst, (got[lane] as f64 - exact).abs());
            }
            x *= 1.07;
        }
        // (the rounding of f32 at an exponent of 100: 8e-6)
        assert!(worst < 1.2e-5, "{worst}");
        // around the levels of a sound
        let mut worst = 0.0f64;
        let mut x = 1e-6f32;
        while x < 8.0 {
            let got = log2(F32x4::splat(x)).lanes()[0] as f64;
            worst = jsmath::max(worst, (got - jsmath::log2(x as f64)).abs());
            x *= 1.003;
        }
        assert!(worst < 2.5e-6, "{worst}");
        // 0 is under every level, no NaN
        assert_eq!(log2(F32x4::splat(0.0)).lanes()[0], -127.0);
    }

    #[test]
    fn exp2_is_the_one_of_doubles() {
        let mut worst = 0.0f64;
        let mut y = -40.0f32;
        while y < 40.0 {
            let got = exp2(F32x4::splat(y)).lanes()[0] as f64;
            let exact = jsmath::pow(2.0, y as f64);
            worst = jsmath::max(worst, (got / exact - 1.0).abs());
            y += 0.0137;
        }
        assert!(worst < 3e-7, "{worst}");
        assert_eq!(
            exp2(F32x4::new(0.0, 1.0, -1.0, 10.0)).lanes(),
            [1.0, 2.0, 0.5, 1024.0]
        );
        // held at the ends, a NaN stays one
        let ends = exp2(F32x4::new(-1000.0, 1000.0, f32::NAN, 0.5)).lanes();
        assert!(ends[0] > 0.0 && ends[0] < 2e-38 && ends[1] > 8e37 && ends[1].is_finite());
        assert!(ends[2].is_nan());
    }
}
