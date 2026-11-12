//! The filter of a voice after the oscillators, its knobs glide, the routes move them. A state variable filter
//! (trapezoidal integrators) in f32, the response of a BiquadFilterNode: both are the bilinear transform of the
//! same prototype, this one keeps its precision at a low cutoff where a biquad in f32 loses it. The channels of a
//! voice in two lanes, those of two voices in four (each lane the operations of its channel, in the same order)

use alloc::{vec, vec::Vec};
use dsp_core::biquad::FilterType;
use dsp_core::simd::F32x4;
use jsmath::{cos, exp, log2, max, pow, sin, sqrt, PI, SQRT2};

/// the knobs of the filter (VoiceFilterOptions), the type an index of FILTER_TYPES (None: unknown)
#[derive(Clone, Copy, Debug)]
pub struct FilterOptions {
    pub ty: Option<FilterType>,
    pub cutoff: f64,
    pub resonance: f64,
    pub gain: f64,
}

const SEGMENT: usize = 32;
const SMOOTHING: f64 = 0.0033;
const BLOCK: usize = 128;

pub struct VoiceFilter {
    pub on: bool,
    ty: Option<FilterType>,
    sample_rate: f64,
    values: [f64; 3],
    targets: [f64; 3],
    still: [[f32; 1]; 3],
    gliding: [Vec<f32>; 3],
    // the knob of each base this block: its still value or its glide
    base_glides: [bool; 3],
    step: f64,
    // of the integrators and of the output (svf_into)
    coefficients: [f32; 6],
    // their damping (svf_into), the power of the resonance and the gain they were worked out with (power_of)
    k: f64,
    power: f64,
    last: [f64; 3],
    // the integrators: the first of the left and of the right, then the second ones
    state: [f32; 4],
}

impl VoiceFilter {
    pub fn new(sample_rate: f64, options: Option<FilterOptions>) -> VoiceFilter {
        let mut filter = VoiceFilter {
            on: false,
            ty: Some(FilterType::Lowpass),
            sample_rate,
            values: [0.0; 3],
            targets: [0.0; 3],
            still: [[0.0]; 3],
            gliding: [vec![0.0; BLOCK], vec![0.0; BLOCK], vec![0.0; BLOCK]],
            base_glides: [false; 3],
            step: 1.0 - exp(-1.0 / (SMOOTHING * sample_rate)),
            coefficients: FROZEN,
            k: 0.0,
            power: 0.0,
            last: [f64::NAN; 3],
            state: [0.0; 4],
        };
        filter.apply(options, false);
        filter
    }

    fn settle(&mut self, k: usize) {
        self.still[k][0] = if k == 0 {
            pow(2.0, self.targets[k])
        } else {
            self.targets[k]
        } as f32;
    }

    fn apply(&mut self, next: Option<FilterOptions>, glide: bool) {
        let Some(next) = next else {
            self.on = false;
            return;
        };
        self.targets[0] = log2(max(1e-3, next.cutoff));
        self.targets[1] = next.resonance;
        self.targets[2] = next.gain;
        let restart = !glide || !self.on;
        if restart || next.ty != self.ty {
            self.values = self.targets;
            for k in 0..3 {
                self.settle(k);
            }
            self.last = [f64::NAN; 3];
        }
        if restart {
            self.state = [0.0; 4];
        } else if next.ty != self.ty {
            // the integrators of a resonance hold its ring (1 / k of the sound): into a type that damps more they
            // come down to the ring of that one, the voice doesn't burst with the ring of the type before
            let power = power_of(next.ty, next.resonance, next.gain);
            let k = svf_into(
                &mut [0.0; 6],
                next.ty,
                next.cutoff,
                next.resonance,
                power,
                self.sample_rate,
            );
            if self.k > 0.0 && k > self.k {
                self.state = self.state.map(|x| (x as f64 * (self.k / k)) as f32);
            }
        }
        self.ty = next.ty;
        self.on = true;
    }

    /// the knobs changed on a playing note: they glide (None: off)
    pub fn set(&mut self, next: Option<FilterOptions>) {
        self.apply(next, true);
    }

    /// the base of knob k (0 cutoff, 1 resonance, 2 gain) this block: one value or one per sample
    pub fn base(&self, k: usize) -> &[f32] {
        if self.base_glides[k] {
            &self.gliding[k]
        } else {
            &self.still[k]
        }
    }

    /// the knobs of a block of n samples
    pub fn glide(&mut self, n: usize) {
        for k in 0..3 {
            let mut value = self.values[k];
            let target = self.targets[k];
            self.base_glides[k] = false;
            if value != target {
                if self.gliding[k].len() != n {
                    self.gliding[k] = vec![0.0; n];
                }
                let step = self.step;
                let out = &mut self.gliding[k];
                for slot in out.iter_mut().take(n) {
                    value += (target - value) * step;
                    *slot = if k == 0 { pow(2.0, value) } else { value } as f32;
                }
                self.base_glides[k] = true;
                self.values[k] = if (target - value).abs() <= target.abs() * 1e-6 + 1e-9 {
                    target
                } else {
                    value
                };
                if self.values[k] == target {
                    self.settle(k);
                }
            }
        }
    }

    /// the filter over a..b of a block: its knobs, those the routes move replaced (`moved`)
    pub fn pass<'a>(&'a mut self, a: usize, b: usize, moved: [Option<&'a [f32]>; 3]) -> Pass<'a> {
        let VoiceFilter {
            ty,
            sample_rate,
            still,
            gliding,
            base_glides,
            coefficients,
            k,
            power,
            last,
            state,
            ..
        } = self;
        let knobs = [0, 1, 2].map(|k| {
            moved[k].unwrap_or(if base_glides[k] {
                gliding[k].as_slice()
            } else {
                still[k].as_slice()
            })
        });
        Pass {
            ty: *ty,
            sample_rate: *sample_rate,
            moving: knobs.iter().any(|values| values.len() > 1),
            knobs,
            a,
            b,
            coefficients,
            k,
            power,
            last,
            state,
            current: FROZEN,
            active: false,
            next: 0,
        }
    }
}

/// the filter of a voice over the samples a..b of a block: its knobs are read at the start of each span (SEGMENT
/// samples from a while one moves, else the whole a..b), its coefficients worked out when they changed
pub struct Pass<'a> {
    ty: Option<FilterType>,
    sample_rate: f64,
    knobs: [&'a [f32]; 3],
    moving: bool,
    a: usize,
    b: usize,
    coefficients: &'a mut [f32; 6],
    k: &'a mut f64,
    power: &'a mut f64,
    last: &'a mut [f64; 3],
    state: &'a mut [f32; 4],
    // the coefficients of the span, whether the voice plays in it, where it ends
    current: [f32; 6],
    active: bool,
    next: usize,
}

impl Pass<'_> {
    // the span that starts at s (the end of the one before)
    fn step(&mut self, s: usize) {
        if s < self.a || s >= self.b {
            self.current = FROZEN;
            self.active = false;
            self.next = if s < self.a { self.a } else { usize::MAX };
            return;
        }
        let at = |values: &[f32]| (if values.len() > 1 { values[s] } else { values[0] }) as f64;
        let (f, q, g) = (at(self.knobs[0]), at(self.knobs[1]), at(self.knobs[2]));
        if f != self.last[0] || q != self.last[1] || g != self.last[2] {
            // (a cutoff that moves alone: the power of the span before)
            if q != self.last[1] || g != self.last[2] {
                *self.power = power_of(self.ty, q, g);
            }
            *self.k = svf_into(self.coefficients, self.ty, f, q, *self.power, self.sample_rate);
            *self.last = [f, q, g];
        }
        self.current = *self.coefficients;
        self.active = true;
        self.next = if self.moving {
            self.b.min(s + SEGMENT)
        } else {
            self.b
        };
    }
}

// no filter: the integrators keep their state, nothing comes out (a voice outside its a..b)
const FROZEN: [f32; 6] = [0.0; 6];

fn constant(out: &mut [f32; 6], value: f64) -> f64 {
    *out = [0.0, 0.0, 0.0, value as f32, 0.0, 0.0];
    0.0
}

/// the power the coefficients of a type read: its linear Q (the resonance of a lowpass and a highpass is in dB) or
/// the amplitude A of its gain; the others: none
pub fn power_of(ty: Option<FilterType>, q: f64, gain: f64) -> f64 {
    match ty {
        Some(FilterType::Lowpass | FilterType::Highpass) => pow(10.0, q / 20.0),
        Some(FilterType::Peaking | FilterType::Lowshelf | FilterType::Highshelf) => pow(10.0, gain / 40.0),
        _ => 0.0,
    }
}

/// The coefficients of the state variable filter with the response of a BiquadFilterNode (the Web Audio API spec,
/// Audio EQ Cookbook), `power` the power_of its resonance and gain. With g the prewarped cutoff, k the damping
/// and d = 1 + g (g + k): c = 2 g (g + k) / d, 2 g / d and 2 g² / d of the integrators (tick), then the shares
/// of the input, of the band (halved) and of the low (halved) in the output. Its edge cases at 0 Hz, at nyquist
/// and for Q <= 0 are constants, as those of the biquad; `ty` None: an unknown type (a constant 1). Worked out in
/// doubles, kept in f32; returns k (0 of a constant)
pub fn svf_into(
    out: &mut [f32; 6],
    ty: Option<FilterType>,
    frequency: f64,
    q: f64,
    power: f64,
    sample_rate: f64,
) -> f64 {
    let f = frequency / (sample_rate / 2.0);
    let inside = f > 0.0 && f < 1.0;
    // the prewarped frequency: tan(w0 / 2)
    let tan = || sin(PI * f / 2.0) / cos(PI * f / 2.0);
    let a = power;
    let (g, k, mix): (f64, f64, [f64; 3]) = match ty {
        None => return constant(out, 1.0),
        Some(FilterType::Lowpass) => {
            if f >= 1.0 {
                return constant(out, 1.0);
            }
            if f <= 0.0 {
                return constant(out, 0.0);
            }
            (tan(), 1.0 / power, [0.0, 0.0, 1.0])
        }
        Some(FilterType::Highpass) => {
            if f >= 1.0 {
                return constant(out, 0.0);
            }
            if f <= 0.0 {
                return constant(out, 1.0);
            }
            let k = 1.0 / power;
            (tan(), k, [1.0, -k, -1.0])
        }
        Some(FilterType::Bandpass) => {
            if !inside {
                return constant(out, 0.0);
            }
            if q <= 0.0 {
                return constant(out, 1.0);
            }
            (tan(), 1.0 / q, [0.0, 1.0 / q, 0.0])
        }
        Some(FilterType::Notch) => {
            if !inside {
                return constant(out, 1.0);
            }
            if q <= 0.0 {
                return constant(out, 0.0);
            }
            (tan(), 1.0 / q, [1.0, -1.0 / q, 0.0])
        }
        Some(FilterType::Allpass) => {
            if !inside {
                return constant(out, 1.0);
            }
            if q <= 0.0 {
                return constant(out, -1.0);
            }
            (tan(), 1.0 / q, [1.0, -2.0 / q, 0.0])
        }
        Some(FilterType::Peaking) => {
            if !inside {
                return constant(out, 1.0);
            }
            if q <= 0.0 {
                return constant(out, a * a);
            }
            let k = 1.0 / (q * a);
            (tan(), k, [1.0, k * (a * a - 1.0), 0.0])
        }
        // the shelves: a slope of 1 (k = √2), the cutoff moved by √A
        Some(FilterType::Lowshelf) => {
            if f >= 1.0 {
                return constant(out, a * a);
            }
            if f <= 0.0 {
                return constant(out, 1.0);
            }
            (tan() / sqrt(a), SQRT2, [1.0, SQRT2 * (a - 1.0), a * a - 1.0])
        }
        Some(FilterType::Highshelf) => {
            if f >= 1.0 {
                return constant(out, 1.0);
            }
            if f <= 0.0 {
                return constant(out, a * a);
            }
            (
                tan() * sqrt(a),
                SQRT2,
                [a * a, SQRT2 * (1.0 - a) * a, 1.0 - a * a],
            )
        }
    };
    let d = 1.0 + g * (g + k);
    *out = [
        2.0 * g * (g + k) / d,
        2.0 * g / d,
        2.0 * g * g / d,
        mix[0],
        mix[1] / 2.0,
        mix[2] / 2.0,
    ]
    .map(|value| value as f32);
    k
}

// A sample of the lanes through their filters: the trapezoidal integrators ic1 (the band) and ic2 (the low) step
// to n1 = 2 v1 - ic1 and n2 = 2 v2 - ic2 of the band v1 and the low v2. Written so that a state is three
// operations from the one before (the loop waits for nothing else) and its small shares are added to it, not
// folded into coefficients next to 1 (those would lose a low cutoff in f32)
#[inline(always)]
fn tick(c: &[F32x4; 6], ic1: &mut F32x4, ic2: &mut F32x4, x: F32x4) -> F32x4 {
    let [c1, a2, a3, m0, h1, h2] = *c;
    let v3 = x - *ic2;
    let n1 = (*ic1 - c1 * *ic1) + a2 * v3;
    let n2 = (*ic2 + a2 * *ic1) + a3 * v3;
    let y = m0 * x + h1 * (*ic1 + n1) + h2 * (*ic2 + n2);
    *ic1 = n1;
    *ic2 = n2;
    y
}

/// the channels of a voice (silent outside the a..b of its pass) through its filter, in place
pub fn run(pass: &mut Pass, left: &mut [f32], right: &mut [f32]) {
    let [l1, r1, l2, r2] = *pass.state;
    let mut ic1 = F32x4::new(l1, r1, 0.0, 0.0);
    let mut ic2 = F32x4::new(l2, r2, 0.0, 0.0);
    let mut s = pass.a;
    while s < pass.b {
        pass.step(s);
        let e = pass.next;
        let c = pass.current.map(F32x4::splat);
        let (left, right) = (&mut left[..e], &mut right[..e]);
        for i in s..e {
            let y = tick(&c, &mut ic1, &mut ic2, F32x4::new(left[i], right[i], 0.0, 0.0)).lanes();
            left[i] = y[0];
            right[i] = y[1];
        }
        // (the tail of a filter decays: no denormals in its state)
        ic1 = ic1.flush();
        ic2 = ic2.flush();
        s = e;
    }
    let (ic1, ic2) = (ic1.lanes(), ic2.lanes());
    *pass.state = [ic1[0], ic1[1], ic2[0], ic2[1]];
}

/// the channels of two voices of `n` samples through their filters, in place: a voice in the lanes 0 and 1, the
/// other in 2 and 3, each sample the operations `run` does (the spans of both: the coefficients of a voice change
/// at its own)
pub fn run_pair(passes: [&mut Pass; 2], outs: [[&mut [f32]; 2]; 2], n: usize) {
    let [p, q] = passes;
    let [[pl, pr], [ql, qr]] = outs;
    let (pl, pr, ql, qr) = (&mut pl[..n], &mut pr[..n], &mut ql[..n], &mut qr[..n]);
    let mut ic1 = F32x4::new(p.state[0], p.state[1], q.state[0], q.state[1]);
    let mut ic2 = F32x4::new(p.state[2], p.state[3], q.state[2], q.state[3]);
    let mut s = 0;
    while s < n {
        if s == p.next {
            p.step(s);
        }
        if s == q.next {
            q.step(s);
        }
        let e = n.min(p.next).min(q.next);
        if p.active || q.active {
            let (cp, cq) = (p.current, q.current);
            let c: [F32x4; 6] = core::array::from_fn(|k| F32x4::new(cp[k], cp[k], cq[k], cq[k]));
            match (p.active, q.active) {
                (true, true) => {
                    for i in s..e {
                        let x = F32x4::new(pl[i], pr[i], ql[i], qr[i]);
                        let y = tick(&c, &mut ic1, &mut ic2, x).lanes();
                        pl[i] = y[0];
                        pr[i] = y[1];
                        ql[i] = y[2];
                        qr[i] = y[3];
                    }
                }
                (true, false) => {
                    for i in s..e {
                        let x = F32x4::new(pl[i], pr[i], 0.0, 0.0);
                        let y = tick(&c, &mut ic1, &mut ic2, x).lanes();
                        pl[i] = y[0];
                        pr[i] = y[1];
                    }
                }
                _ => {
                    for i in s..e {
                        let x = F32x4::new(0.0, 0.0, ql[i], qr[i]);
                        let y = tick(&c, &mut ic1, &mut ic2, x).lanes();
                        ql[i] = y[2];
                        qr[i] = y[3];
                    }
                }
            }
            ic1 = ic1.flush();
            ic2 = ic2.flush();
        }
        s = e;
    }
    let (ic1, ic2) = (ic1.lanes(), ic2.lanes());
    *p.state = [ic1[0], ic1[1], ic2[0], ic2[1]];
    *q.state = [ic1[2], ic1[3], ic2[2], ic2[3]];
}

#[cfg(test)]
mod tests {
    use super::*;
    use dsp_core::biquad::Biquad;

    const RATE: f64 = 48000.0;
    const TYPES: [FilterType; 8] = [
        FilterType::Lowpass,
        FilterType::Highpass,
        FilterType::Bandpass,
        FilterType::Lowshelf,
        FilterType::Highshelf,
        FilterType::Peaking,
        FilterType::Notch,
        FilterType::Allpass,
    ];

    fn noise(length: usize, mut seed: u32) -> Vec<f32> {
        (0..length)
            .map(|_| {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                (seed >> 8) as f32 / (1 << 24) as f32 - 0.5
            })
            .collect()
    }

    fn filter_of(ty: FilterType, cutoff: f64, resonance: f64, gain: f64) -> VoiceFilter {
        VoiceFilter::new(
            RATE,
            Some(FilterOptions {
                ty: Some(ty),
                cutoff,
                resonance,
                gain,
            }),
        )
    }

    #[test]
    fn it_is_the_biquad_of_every_type() {
        // (cutoff, resonance, gain): the edges of the knobs too, the constants at and over the nyquist
        let knobs = [
            (1000.0, 3.0, 6.0),
            (20.0, 0.7, -12.0),
            (20.0, 20.0, 12.0),
            (8000.0, 10.0, -18.0),
            (15000.0, 0.01, 24.0),
            (300.0, -6.0, 0.0),
            (24000.0, 1.0, 6.0),
            (30000.0, 1.0, 6.0),
            (1000.0, 0.0, 6.0),
        ];
        for ty in TYPES {
            for (cutoff, resonance, gain) in knobs {
                let input = noise(4096, 7);
                let mut biquad = Biquad::default();
                biquad.set(ty, cutoff, resonance, gain, RATE);
                let mut filter = filter_of(ty, cutoff, resonance, gain);
                let (mut left, mut right) = (input.clone(), input.clone());
                run(&mut filter.pass(0, 4096, [None; 3]), &mut left, &mut right);
                let mut worst = 0.0f64;
                let mut peak = 1.0f64;
                for (i, &x) in input.iter().enumerate() {
                    let y = biquad.process(x as f64);
                    peak = max(peak, y.abs());
                    worst = max(worst, (left[i] as f64 - y).abs());
                    assert_eq!(left[i].to_bits(), right[i].to_bits());
                }
                assert!(
                    worst < 3e-5 * peak,
                    "{ty:?} at {cutoff} Hz, {resonance}, {gain} dB: {worst} of {peak}"
                );
            }
        }
    }

    #[test]
    fn its_tail_ends_in_zeros() {
        for ty in TYPES {
            let mut filter = filter_of(ty, 20.0, 2.0, 12.0);
            let mut left = noise(128, 3);
            let mut right = left.clone();
            run(&mut filter.pass(0, 128, [None; 3]), &mut left, &mut right);
            // the tail at 20 Hz: silence within 20 s, no denormal on the way
            let mut last = [1.0f32; 2];
            for _ in 0..(20.0 * RATE / 128.0) as usize {
                let (mut left, mut right) = ([0.0f32; 128], [0.0f32; 128]);
                run(&mut filter.pass(0, 128, [None; 3]), &mut left, &mut right);
                assert!(filter.state.iter().all(|x| *x == 0.0 || x.abs() >= 1e-25));
                last = [left[127], right[127]];
            }
            assert_eq!(last, [0.0; 2], "{ty:?}");
            assert_eq!(filter.state, [0.0; 4], "{ty:?}");
        }
    }

    #[test]
    fn two_voices_in_the_lanes_are_each_alone() {
        let n = 200;
        let cutoffs: [Vec<f32>; 2] = [
            (0..n).map(|i| 300.0 + 20.0 * i as f32).collect(),
            (0..n).map(|i| 9000.0 - 30.0 * i as f32).collect(),
        ];
        // (a, b) of each voice: late, stopped, the whole block, nothing
        for ranges in [
            [(0, n), (0, n)],
            [(37, n), (0, 150)],
            [(0, 3), (5, 199)],
            [(60, 60), (10, n)],
        ] {
            for moving in [false, true] {
                let input: [Vec<f32>; 4] = core::array::from_fn(|k| {
                    let (a, b) = ranges[k / 2];
                    let mut channel = noise(n, k as u32 + 1);
                    channel[..a].fill(0.0);
                    channel[b..].fill(0.0);
                    channel
                });
                let filters = || {
                    [
                        filter_of(FilterType::Lowpass, 700.0, 12.0, 0.0),
                        filter_of(FilterType::Peaking, 2000.0, 4.0, 9.0),
                    ]
                };
                let moved = |k: usize| [moving.then_some(cutoffs[k].as_slice()), None, None];
                let mut alone = input.clone();
                let mut one = filters();
                for (k, filter) in one.iter_mut().enumerate() {
                    let (a, b) = ranges[k];
                    let (left, right) = alone[2 * k..2 * k + 2].split_at_mut(1);
                    run(&mut filter.pass(a, b, moved(k)), &mut left[0], &mut right[0]);
                }
                let mut paired = input.clone();
                let mut two = filters();
                {
                    let [f0, f1] = &mut two;
                    let [l0, r0, l1, r1] = &mut paired;
                    let mut p = f0.pass(ranges[0].0, ranges[0].1, moved(0));
                    let mut q = f1.pass(ranges[1].0, ranges[1].1, moved(1));
                    run_pair([&mut p, &mut q], [[l0, r0], [l1, r1]], n);
                }
                for k in 0..4 {
                    let bits = |channel: &Vec<f32>| channel.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
                    assert_eq!(
                        bits(&alone[k]),
                        bits(&paired[k]),
                        "{ranges:?} {moving} channel {k}"
                    );
                }
                for k in 0..2 {
                    assert_eq!(one[k].state, two[k].state);
                }
            }
        }
    }
}
