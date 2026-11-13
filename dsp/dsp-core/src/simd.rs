//! Lanes of wasm SIMD (arrays elsewhere, doing the same operations in the same order, so a cargo test computes the
//! bits of the wasm): F64x2, two lanes of f64 (the left and the right channel of a block), and F32x4, four lanes of
//! f32 (four taps of a FIR, four samples of a block, four lines of a reverb). No fused multiply-add and no relaxed
//! SIMD: the same bits in every browser. min and max are those of wasm (NaN if either is, -0 under +0), the same as
//! Math.min and Math.max

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
mod lanes {
    use core::arch::wasm32::*;

    #[derive(Clone, Copy)]
    #[repr(transparent)]
    pub struct F64x2(pub(super) v128);

    impl F64x2 {
        #[inline(always)]
        pub fn new(a: f64, b: f64) -> F64x2 {
            F64x2(f64x2(a, b))
        }
        #[inline(always)]
        pub fn splat(x: f64) -> F64x2 {
            F64x2(f64x2_splat(x))
        }
        #[inline(always)]
        pub fn lo(self) -> f64 {
            f64x2_extract_lane::<0>(self.0)
        }
        #[inline(always)]
        pub fn hi(self) -> f64 {
            f64x2_extract_lane::<1>(self.0)
        }
        #[inline(always)]
        pub(super) fn op(self, other: F64x2, op: u8) -> F64x2 {
            F64x2(match op {
                b'+' => f64x2_add(self.0, other.0),
                b'-' => f64x2_sub(self.0, other.0),
                b'*' => f64x2_mul(self.0, other.0),
                _ => f64x2_div(self.0, other.0),
            })
        }
        #[inline(always)]
        pub fn abs(self) -> F64x2 {
            F64x2(f64x2_abs(self.0))
        }
        // Math.floor of each lane
        #[inline(always)]
        pub fn floor(self) -> F64x2 {
            F64x2(f64x2_floor(self.0))
        }
        // Math.min / Math.max of each lane
        #[inline(always)]
        pub fn min(self, other: F64x2) -> F64x2 {
            F64x2(f64x2_min(self.0, other.0))
        }
        #[inline(always)]
        pub fn max(self, other: F64x2) -> F64x2 {
            F64x2(f64x2_max(self.0, other.0))
        }
    }
}

#[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
mod lanes {
    #[derive(Clone, Copy)]
    pub struct F64x2(pub(super) [f64; 2]);

    impl F64x2 {
        #[inline(always)]
        pub fn new(a: f64, b: f64) -> F64x2 {
            F64x2([a, b])
        }
        #[inline(always)]
        pub fn splat(x: f64) -> F64x2 {
            F64x2([x, x])
        }
        #[inline(always)]
        pub fn lo(self) -> f64 {
            self.0[0]
        }
        #[inline(always)]
        pub fn hi(self) -> f64 {
            self.0[1]
        }
        #[inline(always)]
        pub(super) fn op(self, other: F64x2, op: u8) -> F64x2 {
            let lane = |a: f64, b: f64| match op {
                b'+' => a + b,
                b'-' => a - b,
                b'*' => a * b,
                _ => a / b,
            };
            F64x2([lane(self.0[0], other.0[0]), lane(self.0[1], other.0[1])])
        }
        #[inline(always)]
        pub fn abs(self) -> F64x2 {
            F64x2([self.0[0].abs(), self.0[1].abs()])
        }
        #[inline(always)]
        pub fn floor(self) -> F64x2 {
            F64x2([jsmath::floor(self.0[0]), jsmath::floor(self.0[1])])
        }
        #[inline(always)]
        pub fn min(self, other: F64x2) -> F64x2 {
            F64x2([
                jsmath::min(self.0[0], other.0[0]),
                jsmath::min(self.0[1], other.0[1]),
            ])
        }
        #[inline(always)]
        pub fn max(self, other: F64x2) -> F64x2 {
            F64x2([
                jsmath::max(self.0[0], other.0[0]),
                jsmath::max(self.0[1], other.0[1]),
            ])
        }
    }
}

pub use lanes::F64x2;

#[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
mod lanes4 {
    use core::arch::wasm32::*;

    #[derive(Clone, Copy)]
    #[repr(transparent)]
    pub struct F32x4(pub(super) v128);

    impl F32x4 {
        #[inline(always)]
        pub fn new(a: f32, b: f32, c: f32, d: f32) -> F32x4 {
            F32x4(f32x4(a, b, c, d))
        }
        #[inline(always)]
        pub fn splat(x: f32) -> F32x4 {
            F32x4(f32x4_splat(x))
        }
        /// the first four values of a slice
        #[inline(always)]
        pub fn load(values: &[f32]) -> F32x4 {
            assert!(values.len() >= 4);
            // SAFETY: four f32 at the pointer; v128.load takes any alignment
            F32x4(unsafe { v128_load(values.as_ptr() as *const v128) })
        }
        /// # Safety
        /// four f32 can be read at `values`
        #[inline(always)]
        pub unsafe fn load_at(values: *const f32) -> F32x4 {
            F32x4(v128_load(values as *const v128))
        }
        /// into the first four values of a slice
        #[inline(always)]
        pub fn store(self, values: &mut [f32]) {
            assert!(values.len() >= 4);
            // SAFETY: four f32 at the pointer; v128.store takes any alignment
            unsafe { v128_store(values.as_mut_ptr() as *mut v128, self.0) }
        }
        /// # Safety
        /// four f32 can be written at `values`
        #[inline(always)]
        pub unsafe fn store_at(self, values: *mut f32) {
            v128_store(values as *mut v128, self.0)
        }
        #[inline(always)]
        pub fn lanes(self) -> [f32; 4] {
            [
                f32x4_extract_lane::<0>(self.0),
                f32x4_extract_lane::<1>(self.0),
                f32x4_extract_lane::<2>(self.0),
                f32x4_extract_lane::<3>(self.0),
            ]
        }
        #[inline(always)]
        pub(super) fn op(self, other: F32x4, op: u8) -> F32x4 {
            F32x4(match op {
                b'+' => f32x4_add(self.0, other.0),
                b'-' => f32x4_sub(self.0, other.0),
                b'*' => f32x4_mul(self.0, other.0),
                _ => f32x4_div(self.0, other.0),
            })
        }
        #[inline(always)]
        pub fn abs(self) -> F32x4 {
            F32x4(f32x4_abs(self.0))
        }
        #[inline(always)]
        pub fn min(self, other: F32x4) -> F32x4 {
            F32x4(f32x4_min(self.0, other.0))
        }
        #[inline(always)]
        pub fn max(self, other: F32x4) -> F32x4 {
            F32x4(f32x4_max(self.0, other.0))
        }
        /// the sum of the lanes, (0 + 2) + (1 + 3)
        #[inline(always)]
        pub fn sum(self) -> f32 {
            let halves = f32x4_add(self.0, i32x4_shuffle::<2, 3, 0, 1>(self.0, self.0));
            f32x4_extract_lane::<0>(halves) + f32x4_extract_lane::<1>(halves)
        }
        /// the lanes of two F64x2 rounded to f32: those of `lo` in lanes 0 and 1, of `hi` in 2 and 3
        #[inline(always)]
        pub fn from_f64(lo: super::F64x2, hi: super::F64x2) -> F32x4 {
            let (a, b) = (f32x4_demote_f64x2_zero(lo.0), f32x4_demote_f64x2_zero(hi.0));
            F32x4(i32x4_shuffle::<0, 1, 4, 5>(a, b))
        }
        /// the lanes under TINY as +0 (a NaN stays): a state in f32 that decays would reach the denormals, which
        /// wasm can't flush and a CPU works out many times slower
        #[inline(always)]
        pub fn flush(self) -> F32x4 {
            let tiny = f32x4_lt(f32x4_abs(self.0), f32x4_splat(super::TINY));
            F32x4(v128_andnot(self.0, tiny))
        }
        /// the lanes that equal those of `other`: all their bits set, else none
        #[inline(always)]
        pub fn equal(self, other: F32x4) -> U32x4 {
            U32x4(f32x4_eq(self.0, other.0))
        }
        /// the lanes of `self` where those of `mask` are set (all their bits or none), else those of `other`
        #[inline(always)]
        pub fn or_else(self, mask: U32x4, other: F32x4) -> F32x4 {
            F32x4(v128_bitselect(self.0, other.0, mask.0))
        }
        /// the lanes over those of `other`: all their bits set, else none (a NaN is over nothing)
        #[inline(always)]
        pub fn over(self, other: F32x4) -> U32x4 {
            U32x4(f32x4_gt(self.0, other.0))
        }
        /// the bits of the lanes
        #[inline(always)]
        pub fn bits(self) -> U32x4 {
            U32x4(self.0)
        }
        #[inline(always)]
        pub fn from_bits(bits: U32x4) -> F32x4 {
            F32x4(bits.0)
        }
        /// the largest integer under each lane or equal to it
        #[inline(always)]
        pub fn floor(self) -> F32x4 {
            F32x4(f32x4_floor(self.0))
        }
        /// the lanes truncated to i32 (two's complement in the u32; one out of its range saturates, a NaN is 0)
        #[inline(always)]
        pub fn to_int(self) -> U32x4 {
            U32x4(i32x4_trunc_sat_f32x4(self.0))
        }
        /// four lanes picked out of the eight of `self` (0..4) and `other` (4..8)
        #[inline(always)]
        pub fn pick<const A: usize, const B: usize, const C: usize, const D: usize>(
            self,
            other: F32x4,
        ) -> F32x4 {
            F32x4(i32x4_shuffle::<A, B, C, D>(self.0, other.0))
        }
        /// the samples at[lane] and at[lane] + 1 after `base`, of each lane: the first ones, the second ones (a
        /// load of 64 bits per lane: wasm has no gather)
        ///
        /// # Safety
        /// two f32 can be read at base + at[lane] for every lane
        #[inline(always)]
        pub unsafe fn pairs_at(base: *const f32, at: [u32; 4]) -> (F32x4, F32x4) {
            let pair = |lane: usize| base.add(at[lane] as usize) as *const u64;
            let zero = f32x4_splat(0.0);
            let first = v128_load64_lane::<1>(v128_load64_lane::<0>(zero, pair(0)), pair(1));
            let second = v128_load64_lane::<1>(v128_load64_lane::<0>(zero, pair(2)), pair(3));
            (
                F32x4(i32x4_shuffle::<0, 2, 4, 6>(first, second)),
                F32x4(i32x4_shuffle::<1, 3, 5, 7>(first, second)),
            )
        }
    }

    #[derive(Clone, Copy)]
    #[repr(transparent)]
    pub struct U32x4(v128);

    impl U32x4 {
        #[inline(always)]
        pub fn new(a: u32, b: u32, c: u32, d: u32) -> U32x4 {
            U32x4(u32x4(a, b, c, d))
        }
        #[inline(always)]
        pub fn splat(x: u32) -> U32x4 {
            U32x4(u32x4_splat(x))
        }
        #[inline(always)]
        pub fn lanes(self) -> [u32; 4] {
            [
                u32x4_extract_lane::<0>(self.0),
                u32x4_extract_lane::<1>(self.0),
                u32x4_extract_lane::<2>(self.0),
                u32x4_extract_lane::<3>(self.0),
            ]
        }
        /// modulo 2^32
        #[inline(always)]
        pub fn plus(self, other: U32x4) -> U32x4 {
            U32x4(u32x4_add(self.0, other.0))
        }
        /// every lane >> bits (bits under 32)
        #[inline(always)]
        pub fn shifted(self, bits: u32) -> U32x4 {
            U32x4(u32x4_shr(self.0, bits))
        }
        /// every lane << bits (bits under 32)
        #[inline(always)]
        pub fn shifted_left(self, bits: u32) -> U32x4 {
            U32x4(u32x4_shl(self.0, bits))
        }
        #[inline(always)]
        pub fn and(self, other: U32x4) -> U32x4 {
            U32x4(v128_and(self.0, other.0))
        }
        #[inline(always)]
        pub fn or(self, other: U32x4) -> U32x4 {
            U32x4(v128_or(self.0, other.0))
        }
        /// the lanes as f32 (each under 2^31)
        #[inline(always)]
        pub fn to_f32(self) -> F32x4 {
            F32x4(f32x4_convert_i32x4(self.0))
        }
    }
}

#[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
mod lanes4 {
    #[derive(Clone, Copy)]
    pub struct F32x4(pub(super) [f32; 4]);

    // f32x4.min and f32x4.max of wasm: NaN if either is, -0 under +0
    fn min(a: f32, b: f32) -> f32 {
        if a.is_nan() || b.is_nan() {
            f32::NAN
        } else if a < b || (a == b && a.is_sign_negative()) {
            a
        } else {
            b
        }
    }
    fn max(a: f32, b: f32) -> f32 {
        if a.is_nan() || b.is_nan() {
            f32::NAN
        } else if a > b || (a == b && a.is_sign_positive()) {
            a
        } else {
            b
        }
    }

    impl F32x4 {
        #[inline(always)]
        pub fn new(a: f32, b: f32, c: f32, d: f32) -> F32x4 {
            F32x4([a, b, c, d])
        }
        #[inline(always)]
        pub fn splat(x: f32) -> F32x4 {
            F32x4([x; 4])
        }
        #[inline(always)]
        pub fn load(values: &[f32]) -> F32x4 {
            F32x4([values[0], values[1], values[2], values[3]])
        }
        /// # Safety
        /// four f32 can be read at `values`
        #[inline(always)]
        pub unsafe fn load_at(values: *const f32) -> F32x4 {
            F32x4(core::ptr::read_unaligned(values as *const [f32; 4]))
        }
        #[inline(always)]
        pub fn store(self, values: &mut [f32]) {
            values[..4].copy_from_slice(&self.0);
        }
        /// # Safety
        /// four f32 can be written at `values`
        #[inline(always)]
        pub unsafe fn store_at(self, values: *mut f32) {
            core::ptr::write_unaligned(values as *mut [f32; 4], self.0)
        }
        #[inline(always)]
        pub fn lanes(self) -> [f32; 4] {
            self.0
        }
        #[inline(always)]
        fn zip(self, other: F32x4, f: impl Fn(f32, f32) -> f32) -> F32x4 {
            F32x4(core::array::from_fn(|k| f(self.0[k], other.0[k])))
        }
        #[inline(always)]
        pub(super) fn op(self, other: F32x4, op: u8) -> F32x4 {
            self.zip(other, |a, b| match op {
                b'+' => a + b,
                b'-' => a - b,
                b'*' => a * b,
                _ => a / b,
            })
        }
        #[inline(always)]
        pub fn abs(self) -> F32x4 {
            F32x4(self.0.map(f32::abs))
        }
        #[inline(always)]
        pub fn min(self, other: F32x4) -> F32x4 {
            self.zip(other, min)
        }
        #[inline(always)]
        pub fn max(self, other: F32x4) -> F32x4 {
            self.zip(other, max)
        }
        #[inline(always)]
        pub fn sum(self) -> f32 {
            (self.0[0] + self.0[2]) + (self.0[1] + self.0[3])
        }
        #[inline(always)]
        pub fn from_f64(lo: super::F64x2, hi: super::F64x2) -> F32x4 {
            F32x4([lo.0[0] as f32, lo.0[1] as f32, hi.0[0] as f32, hi.0[1] as f32])
        }
        #[inline(always)]
        pub fn flush(self) -> F32x4 {
            F32x4(self.0.map(|x| if x.abs() < super::TINY { 0.0 } else { x }))
        }
        #[inline(always)]
        pub fn equal(self, other: F32x4) -> U32x4 {
            U32x4(core::array::from_fn(|k| {
                if self.0[k] == other.0[k] {
                    u32::MAX
                } else {
                    0
                }
            }))
        }
        #[inline(always)]
        pub fn or_else(self, mask: U32x4, other: F32x4) -> F32x4 {
            F32x4(core::array::from_fn(|k| {
                if mask.0[k] != 0 {
                    self.0[k]
                } else {
                    other.0[k]
                }
            }))
        }
        #[inline(always)]
        pub fn over(self, other: F32x4) -> U32x4 {
            U32x4(core::array::from_fn(|k| {
                if self.0[k] > other.0[k] {
                    u32::MAX
                } else {
                    0
                }
            }))
        }
        #[inline(always)]
        pub fn bits(self) -> U32x4 {
            U32x4(self.0.map(f32::to_bits))
        }
        #[inline(always)]
        pub fn from_bits(bits: U32x4) -> F32x4 {
            F32x4(bits.0.map(f32::from_bits))
        }
        // (the floor of an f32 is an f32: through the floor of doubles of jsmath, std has none off wasm)
        #[inline(always)]
        pub fn floor(self) -> F32x4 {
            F32x4(self.0.map(|x| jsmath::floor(x as f64) as f32))
        }
        // (`as` saturates and takes a NaN as 0, as i32x4.trunc_sat_f32x4)
        #[inline(always)]
        pub fn to_int(self) -> U32x4 {
            U32x4(self.0.map(|x| x as i32 as u32))
        }
        #[inline(always)]
        pub fn pick<const A: usize, const B: usize, const C: usize, const D: usize>(
            self,
            other: F32x4,
        ) -> F32x4 {
            let lane = |k: usize| if k < 4 { self.0[k] } else { other.0[k - 4] };
            F32x4([lane(A), lane(B), lane(C), lane(D)])
        }
        /// # Safety
        /// two f32 can be read at base + at[lane] for every lane
        #[inline(always)]
        pub unsafe fn pairs_at(base: *const f32, at: [u32; 4]) -> (F32x4, F32x4) {
            (
                F32x4(at.map(|i| *base.add(i as usize))),
                F32x4(at.map(|i| *base.add(i as usize + 1))),
            )
        }
    }

    #[derive(Clone, Copy)]
    pub struct U32x4([u32; 4]);

    impl U32x4 {
        #[inline(always)]
        pub fn new(a: u32, b: u32, c: u32, d: u32) -> U32x4 {
            U32x4([a, b, c, d])
        }
        #[inline(always)]
        pub fn splat(x: u32) -> U32x4 {
            U32x4([x; 4])
        }
        #[inline(always)]
        pub fn lanes(self) -> [u32; 4] {
            self.0
        }
        #[inline(always)]
        pub fn plus(self, other: U32x4) -> U32x4 {
            U32x4(core::array::from_fn(|k| self.0[k].wrapping_add(other.0[k])))
        }
        #[inline(always)]
        pub fn shifted(self, bits: u32) -> U32x4 {
            U32x4(self.0.map(|x| x >> bits))
        }
        #[inline(always)]
        pub fn shifted_left(self, bits: u32) -> U32x4 {
            U32x4(self.0.map(|x| x << bits))
        }
        #[inline(always)]
        pub fn and(self, other: U32x4) -> U32x4 {
            U32x4(core::array::from_fn(|k| self.0[k] & other.0[k]))
        }
        #[inline(always)]
        pub fn or(self, other: U32x4) -> U32x4 {
            U32x4(core::array::from_fn(|k| self.0[k] | other.0[k]))
        }
        #[inline(always)]
        pub fn to_f32(self) -> F32x4 {
            F32x4(self.0.map(|x| x as i32 as f32))
        }
    }
}

pub use lanes4::{F32x4, U32x4};

/// what F32x4::flush takes as 0: far under what sounds (-500 dB), far over the denormals of f32 (1.2e-38)
pub const TINY: f32 = 1e-25;

macro_rules! lane_op {
    ($trait:ident, $method:ident, $op:literal) => {
        impl core::ops::$trait for F64x2 {
            type Output = F64x2;
            #[inline(always)]
            fn $method(self, other: F64x2) -> F64x2 {
                self.op(other, $op)
            }
        }
        impl core::ops::$trait for F32x4 {
            type Output = F32x4;
            #[inline(always)]
            fn $method(self, other: F32x4) -> F32x4 {
                self.op(other, $op)
            }
        }
    };
}
lane_op!(Add, add, b'+');
lane_op!(Sub, sub, b'-');
lane_op!(Mul, mul, b'*');
lane_op!(Div, div, b'/');

impl Default for F64x2 {
    fn default() -> Self {
        F64x2::splat(0.0)
    }
}

impl Default for F32x4 {
    fn default() -> Self {
        F32x4::splat(0.0)
    }
}

impl F64x2 {
    /// a function of f64 on each lane
    #[inline(always)]
    pub fn map(self, f: impl Fn(f64) -> f64) -> F64x2 {
        F64x2::new(f(self.lo()), f(self.hi()))
    }
}

#[cfg(test)]
mod tests {
    use super::F64x2;

    #[test]
    fn lanes_are_independent() {
        let a = F64x2::new(1.5, -2.0);
        let b = F64x2::new(0.25, 4.0);
        let sum = a + b;
        let product = a * b;
        assert_eq!((sum.lo(), sum.hi()), (1.75, 2.0));
        assert_eq!((product.lo(), product.hi()), (0.375, -8.0));
        let min = F64x2::new(0.0, f64::NAN).min(F64x2::new(-0.0, 1.0));
        assert!(min.lo().is_sign_negative() && min.lo() == 0.0);
        assert!(min.hi().is_nan());
        // floor as Math.floor (f64x2.floor of wasm): -0 stays, NaN stays
        let floor = F64x2::new(-0.5, 2.5).floor();
        assert_eq!((floor.lo(), floor.hi()), (-1.0, 2.0));
        let floor = F64x2::new(-0.0, f64::NAN).floor();
        assert!(floor.lo().is_sign_negative() && floor.lo() == 0.0);
        assert!(floor.hi().is_nan());
    }

    #[test]
    fn four_lanes_of_f32() {
        use super::F32x4;
        let a = F32x4::new(1.5, -2.0, 0.25, 8.0);
        let b = F32x4::load(&[0.5, 4.0, -1.0, 2.0, 99.0]);
        assert_eq!((a + b).lanes(), [2.0, 2.0, -0.75, 10.0]);
        assert_eq!((a - b).lanes(), [1.0, -6.0, 1.25, 6.0]);
        assert_eq!((a * b).lanes(), [0.75, -8.0, -0.25, 16.0]);
        assert_eq!((a / b).lanes(), [3.0, -0.5, -0.25, 4.0]);
        assert_eq!(a.abs().lanes(), [1.5, 2.0, 0.25, 8.0]);
        assert_eq!(a.min(b).lanes(), [0.5, -2.0, -1.0, 2.0]);
        assert_eq!(a.max(b).lanes(), [1.5, 4.0, 0.25, 8.0]);
        assert_eq!(a.sum(), (1.5 + 0.25) + (-2.0 + 8.0));
        let mut stored = [0.0; 5];
        a.store(&mut stored[1..]);
        assert_eq!(stored, [0.0, 1.5, -2.0, 0.25, 8.0]);
        let min = F32x4::new(0.0, f32::NAN, -0.0, 1.0).min(F32x4::new(-0.0, 1.0, 0.0, f32::NAN));
        assert!(min.lanes()[0].is_sign_negative() && min.lanes()[2].is_sign_negative());
        assert!(min.lanes()[1].is_nan() && min.lanes()[3].is_nan());
        let max = F32x4::new(0.0, f32::NAN, -0.0, 1.0).max(F32x4::new(-0.0, 1.0, 0.0, f32::NAN));
        assert!(max.lanes()[0].is_sign_positive() && max.lanes()[2].is_sign_positive());
        assert!(max.lanes()[1].is_nan() && max.lanes()[3].is_nan());
        let rounded = F32x4::from_f64(F64x2::new(0.1, -2.5), F64x2::new(1e300, 1e-300));
        assert_eq!(rounded.lanes(), [0.1, -2.5, f32::INFINITY, 0.0]);
        let same = a.equal(F32x4::new(1.5, 2.0, 0.25, f32::NAN));
        assert_eq!(same.lanes(), [u32::MAX, 0, u32::MAX, 0]);
        assert_eq!(a.or_else(same, b).lanes(), [1.5, 4.0, 0.25, 2.0]);
        // (a NaN equals nothing, 0 equals -0)
        let zero = F32x4::new(0.0, f32::NAN, -0.0, 1.0).equal(F32x4::new(-0.0, f32::NAN, 0.0, 1.0));
        assert_eq!(zero.lanes(), [u32::MAX, 0, u32::MAX, u32::MAX]);
        let table = [0.0, 1.0, 2.0, 3.0, 4.0, 5.0];
        // SAFETY: the places and the ones after them are in the table
        let (first, second) = unsafe { F32x4::pairs_at(table.as_ptr(), [4, 0, 2, 1]) };
        assert_eq!(first.lanes(), [4.0, 0.0, 2.0, 1.0]);
        assert_eq!(second.lanes(), [5.0, 1.0, 3.0, 2.0]);
        use super::U32x4;
        let phase = U32x4::new(0xffff_fff0, 7, 1 << 31, 0x1234_5678);
        assert_eq!(
            phase.plus(U32x4::splat(0x20)).lanes(),
            [0x10, 0x27, (1 << 31) + 0x20, 0x1234_5698]
        );
        assert_eq!(phase.shifted(28).lanes(), [15, 0, 8, 1]);
        assert_eq!(
            phase.and(U32x4::splat(0xfff)).to_f32().lanes(),
            [4080.0, 7.0, 0.0, 1656.0]
        );
        let over = a.over(F32x4::new(1.0, -2.0, f32::NAN, 7.0));
        assert_eq!(over.lanes(), [u32::MAX, 0, 0, u32::MAX]);
        assert_eq!(a.bits().lanes(), [1.5f32, -2.0, 0.25, 8.0].map(f32::to_bits));
        assert_eq!(F32x4::from_bits(a.bits()).lanes(), a.lanes());
        let floor = F32x4::new(-0.5, 2.5, -3.0, 1e10).floor().lanes();
        assert_eq!(floor, [-1.0, 2.0, -3.0, 1e10]);
        // truncated, saturated at the ends of i32, a NaN as 0
        let ints = F32x4::new(-2.7, 3.9, 1e12, f32::NAN).to_int().lanes();
        assert_eq!(ints, [-2i32 as u32, 3, i32::MAX as u32, 0]);
        assert_eq!(a.pick::<0, 4, 3, 7>(b).lanes(), [1.5, 0.5, 8.0, 2.0]);
        assert_eq!(phase.shifted_left(4).lanes(), [0xffff_ff00, 0x70, 0, 0x2345_6780]);
        assert_eq!(
            U32x4::splat(0xf0).or(U32x4::new(1, 2, 4, 0x100)).lanes(),
            [0xf1, 0xf2, 0xf4, 0x1f0]
        );
        let flushed = F32x4::new(1e-26, -1e-30, -1e-24, f32::NAN).flush().lanes();
        assert_eq!(flushed[..3], [0.0, 0.0, -1e-24]);
        assert!(flushed[0].is_sign_positive() && flushed[1].is_sign_positive() && flushed[3].is_nan());
    }
}
