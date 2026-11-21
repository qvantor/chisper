//! The EQ: its bands are the cookbook, a neutral band is the input, how the blocks are cut changes nothing while
//! the knobs rest, a glide, a line and a change of type move it without a click, silence rests it

use super::*;
use crate::tests::{bits, noise};
use alloc::vec;
use alloc::vec::Vec;

const RATE: f64 = 48000.0;

fn params(values: &[(usize, f64)]) -> [f64; PARAMS] {
    // the defaults of the app: shelves at 0 dB, the level at a half
    let mut all = [0.0, 210.0, 60.0, 0.0, 0.0, 2040.0, 60.0, 0.0, 0.5];
    for &(key, value) in values {
        all[key] = value;
    }
    all
}

fn all(keys: &[(usize, f64)]) -> u32 {
    keys.iter().fold(0, |bits, (key, _)| bits | 1 << key)
}

// `input` through the EQ in blocks of `blocks()` samples, `before` at the start of each (its frame), `moves` its
// lines from that frame on (an empty one: none, no route moves that knob)
fn render(
    eq: &mut Eq,
    input: &[Vec<f32>; 2],
    blocks: &mut dyn FnMut() -> usize,
    mut before: impl FnMut(&mut Eq, usize),
    lines: Option<&[Vec<f64>; 6]>,
) -> [Vec<f32>; 2] {
    let frames = input[0].len();
    let mut out = [vec![0.0f32; frames], vec![0.0f32; frames]];
    let mut at = 0;
    while at < frames {
        let count = blocks().min(frames - at);
        before(eq, at);
        let moves = Moves {
            eq: core::array::from_fn(|knob| {
                lines
                    .filter(|lines| !lines[knob].is_empty())
                    .map(|lines| &lines[knob][at..at + count])
            }),
            ..Moves::default()
        };
        let [left, right] = &mut out;
        eq.process(
            &input[0][at..at + count],
            &input[1][at..at + count],
            &mut left[at..at + count],
            &mut right[at..at + count],
            &moves,
        );
        at += count;
    }
    out
}

fn blocks_of(length: usize) -> impl FnMut() -> usize {
    move || length
}

fn sine(hz: f64, frames: usize, level: f64) -> [Vec<f32>; 2] {
    let left: Vec<f32> = (0..frames)
        .map(|i| (level * sin(2.0 * PI * hz * i as f64 / RATE)) as f32)
        .collect();
    [left.clone(), left]
}

// the cookbook (Audio EQ Cookbook, R. Bristow-Johnson) of a band: [b0, b1, b2, a0, a1, a2]
fn cookbook(band: usize, ty: u32, freq: f64, reso: f64, gain: f64) -> [f64; 6] {
    let x = reso / 100.0;
    let q = if ty == SHELF {
        0.4 + 1.7416 * x * x * x
    } else {
        0.1 + 18.9 * x * x * x * x
    };
    let w0 = 2.0 * PI * freq / RATE;
    let (c, s) = (cos(w0), sin(w0));
    let al = s / (2.0 * q);
    let a = pow(10.0, gain / 40.0);
    let sq = 2.0 * sqrt(a) * al;
    match (ty, band) {
        (PASS, 0) => [
            (1.0 + c) / 2.0,
            -(1.0 + c),
            (1.0 + c) / 2.0,
            1.0 + al,
            -2.0 * c,
            1.0 - al,
        ],
        (PASS, _) => [
            (1.0 - c) / 2.0,
            1.0 - c,
            (1.0 - c) / 2.0,
            1.0 + al,
            -2.0 * c,
            1.0 - al,
        ],
        (PEAK, _) => [
            1.0 + al * a,
            -2.0 * c,
            1.0 - al * a,
            1.0 + al / a,
            -2.0 * c,
            1.0 - al / a,
        ],
        (_, 0) => [
            a * ((a + 1.0) - (a - 1.0) * c + sq),
            2.0 * a * ((a - 1.0) - (a + 1.0) * c),
            a * ((a + 1.0) - (a - 1.0) * c - sq),
            (a + 1.0) + (a - 1.0) * c + sq,
            -2.0 * ((a - 1.0) + (a + 1.0) * c),
            (a + 1.0) + (a - 1.0) * c - sq,
        ],
        _ => [
            a * ((a + 1.0) + (a - 1.0) * c + sq),
            -2.0 * a * ((a - 1.0) + (a + 1.0) * c),
            a * ((a + 1.0) + (a - 1.0) * c - sq),
            (a + 1.0) - (a - 1.0) * c + sq,
            2.0 * ((a - 1.0) - (a + 1.0) * c),
            (a + 1.0) - (a - 1.0) * c - sq,
        ],
    }
}

// a signal through a biquad, direct form I in doubles
fn biquad(c: [f64; 6], input: &[f32]) -> Vec<f64> {
    let [b0, b1, b2, a0, a1, a2] = c;
    let (mut x1, mut x2, mut y1, mut y2) = (0.0, 0.0, 0.0, 0.0);
    input
        .iter()
        .map(|&x| {
            let x = x as f64;
            let y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
            (x2, x1, y2, y1) = (x1, x, y1, y);
            y
        })
        .collect()
}

// each band of each type is the biquad of the cookbook with the laws of the reference (both channels)
#[test]
fn the_bands_are_the_cookbook() {
    let mut source = noise(3);
    let frames = 4096;
    let input = [
        (0..frames).map(|_| source() * 0.3).collect::<Vec<f32>>(),
        (0..frames).map(|_| source() * 0.3).collect::<Vec<f32>>(),
    ];
    for band in 0..2 {
        for ty in [SHELF, PEAK, PASS] {
            for &(freq, reso, gain) in &[(60.0, 0.0, 12.0), (1000.0, 50.0, -18.0), (9000.0, 100.0, 24.0)] {
                let [t, f, q, g] = BANDS[band];
                let mut eq = Eq::new(RATE, &params(&[(t, ty as f64), (f, freq), (q, reso), (g, gain)]));
                let out = render(&mut eq, &input, &mut blocks_of(128), |_, _| {}, None);
                for channel in 0..2 {
                    let reference = biquad(cookbook(band, ty, freq, reso, gain), &input[channel]);
                    for (i, (&ours, &theirs)) in out[channel].iter().zip(reference.iter()).enumerate() {
                        assert!(
                            (ours as f64 - theirs).abs() < 1e-5,
                            "band {band} type {ty} at {freq} Hz, {reso} %, {gain} dB: {ours} for {theirs} at {i}"
                        );
                    }
                }
            }
        }
    }
}

// shelves and peaks at 0 dB and the level at a half: the input bit for bit; a pass is not
#[test]
fn a_neutral_band_is_the_input() {
    let mut source = noise(5);
    let input = [
        (0..3000).map(|_| source() * 0.8).collect::<Vec<f32>>(),
        (0..3000).map(|_| source() * 0.8).collect::<Vec<f32>>(),
    ];
    for (t1, t2) in [(SHELF, SHELF), (PEAK, SHELF), (SHELF, PEAK), (PEAK, PEAK)] {
        let mut eq = Eq::new(RATE, &params(&[(T1, t1 as f64), (T2, t2 as f64), (Q1, 100.0)]));
        let out = render(&mut eq, &input, &mut blocks_of(128), |_, _| {}, None);
        assert_eq!(bits(&out[0]), bits(&input[0]));
        assert_eq!(bits(&out[1]), bits(&input[1]));
    }
    let mut eq = Eq::new(RATE, &params(&[(T1, PASS as f64)]));
    let out = render(&mut eq, &input, &mut blocks_of(128), |_, _| {}, None);
    assert_ne!(bits(&out[0]), bits(&input[0]));
}

// while the knobs rest a block of any length renders what one long block does
#[test]
fn blocks_of_any_length_while_the_knobs_rest() {
    let mut source = noise(9);
    let frames = 20000;
    let input = [
        (0..frames).map(|_| source() * 0.5).collect::<Vec<f32>>(),
        (0..frames).map(|_| source() * 0.5).collect::<Vec<f32>>(),
    ];
    let knobs = params(&[
        (T1, 1.0),
        (F1, 400.0),
        (Q1, 70.0),
        (G1, 9.0),
        (T2, 2.0),
        (F2, 6000.0),
        (Q2, 30.0),
        (LEVEL, 0.4),
    ]);
    let mut lengths = noise(11);
    let mut cut = || 1 + ((lengths() + 1.0) * 150.0) as usize;
    let rendered = render(&mut Eq::new(RATE, &knobs), &input, &mut cut, |_, _| {}, None);
    let whole = render(
        &mut Eq::new(RATE, &knobs),
        &input,
        &mut blocks_of(frames),
        |_, _| {},
        None,
    );
    assert_eq!(bits(&rendered[0]), bits(&whole[0]));
    assert_eq!(bits(&rendered[1]), bits(&whole[1]));
}

// the largest third difference of a signal from `from` on: a click is a jump of it
fn roughness(data: &[f32], from: usize) -> f64 {
    (from.max(3)..data.len())
        .map(|i| {
            let [a, b, c, d] = [data[i - 3], data[i - 2], data[i - 1], data[i]].map(|v| v as f64);
            (d - 3.0 * c + 3.0 * b - a).abs()
        })
        .fold(0.0, max)
}

fn worst_apart(a: &[f32], b: &[f32]) -> f64 {
    a.iter()
        .zip(b)
        .map(|(a, b)| (*a as f64 - *b as f64).abs())
        .fold(0.0, max)
}

// a sine as the knobs of the bands glide far (6 octaves, the resonance and 48 dB at once), as a change of type
// fades and as routes move them: near what designs at every sample render and as smooth; the coefficients of a
// segment at once (a stair) are far from it, a zipper
#[test]
fn the_knobs_move_as_designs_at_every_sample() {
    let frames = 24000;
    let input = sine(110.0, frames, 0.5);
    let start = params(&[
        (T1, 1.0),
        (F1, 80.0),
        (Q1, 60.0),
        (G1, -24.0),
        (T2, 0.0),
        (G2, 6.0),
    ]);
    let moved = [(F1, 6000.0), (Q1, 10.0), (G1, 24.0), (F2, 300.0), (G2, -12.0)];
    let types = [(T1, 2.0), (T2, 1.0)];
    let ramp = |to: f64| -> Vec<f64> {
        (0..frames)
            .map(|i| to * min(1.0, max(0.0, (i as f64 - 4096.0) / (0.1 * RATE))))
            .collect()
    };
    let zero = vec![0.0; frames];
    // (the frequency in octaves: 80 Hz to 2.56 kHz)
    let lines = [
        ramp(5.0),
        zero.clone(),
        ramp(30.0),
        zero.clone(),
        ramp(40.0),
        zero,
    ];
    // (how: 0 the glides, 1 a change of type, 2 lines)
    let run = |how: usize, every: usize, stairs: bool| {
        let mut eq = Eq::new(RATE, &start);
        eq.every = every;
        for band in eq.bands.iter_mut() {
            band.stairs = stairs;
        }
        render(
            &mut eq,
            &input,
            &mut blocks_of(128),
            |eq, at| {
                if at == 4096 && how < 2 {
                    let changes: &[(usize, f64)] = if how == 0 { &moved } else { &types };
                    eq.set(all(changes), &params(changes));
                }
            },
            (how == 2).then_some(&lines),
        )
    };
    for (how, name) in ["glides", "a change of type", "lines"].iter().enumerate() {
        let ideal = run(how, 1, false);
        let ours = run(how, SEGMENT, false);
        let stairs = run(how, SEGMENT, true);
        let ours_apart = worst_apart(&ours[0], &ideal[0]);
        let stairs_apart = worst_apart(&stairs[0], &ideal[0]);
        assert!(ours_apart < 3e-3, "{name}: {ours_apart}");
        assert!(
            stairs_apart > 15.0 * ours_apart,
            "{name}: {stairs_apart} {ours_apart}"
        );
        // (about as rough as the designs every sample: no click of ours; a stair is)
        let rough = roughness(&ours[0], 4096);
        assert!(rough < 2.0 * roughness(&ideal[0], 4096), "{name}: {rough}");
        assert!(roughness(&stairs[0], 4096) > 50.0 * rough, "{name}");
    }
    // (they moved it: in the lines the peak went up away from the sine, a cut of it before)
    let out = run(2, SEGMENT, false);
    let level = |data: &[f32]| data.iter().fold(0.0f32, |a, b| a.max(b.abs()));
    assert!(level(&out[0][2000..4000]) < 0.4);
    assert!((level(&out[0][frames - 4000..]) - 0.5).abs() < 0.01);
}

// lines that stand still move a band as its knobs would (to rounding)
#[test]
fn a_line_is_an_offset_of_its_knob() {
    let mut source = noise(21);
    let frames = 6000;
    let input = [
        (0..frames).map(|_| source() * 0.5).collect::<Vec<f32>>(),
        (0..frames).map(|_| source() * 0.5).collect::<Vec<f32>>(),
    ];
    let base = params(&[
        (T1, 1.0),
        (F1, 500.0),
        (Q1, 40.0),
        (G1, 6.0),
        (T2, 2.0),
        (F2, 5000.0),
        (Q2, 20.0),
    ]);
    // (the frequencies in octaves)
    let offsets = [log2(1200.0 / 500.0), 15.0, -9.0, log2(3000.0 / 5000.0), 30.0, 0.0];
    let lines: [Vec<f64>; 6] = core::array::from_fn(|knob| vec![offsets[knob]; frames]);
    let moved = render(
        &mut Eq::new(RATE, &base),
        &input,
        &mut blocks_of(128),
        |_, _| {},
        Some(&lines),
    );
    let knobs = params(&[
        (T1, 1.0),
        (F1, 1200.0),
        (Q1, 55.0),
        (G1, -3.0),
        (T2, 2.0),
        (F2, 3000.0),
        (Q2, 50.0),
    ]);
    let set = render(
        &mut Eq::new(RATE, &knobs),
        &input,
        &mut blocks_of(128),
        |_, _| {},
        None,
    );
    // (the first segment goes from the knobs to the offsets: what it left behind rings out first)
    for channel in 0..2 {
        assert!(worst_apart(&moved[channel][2000..], &set[channel][2000..]) < 1e-5);
    }
}

// what moves a band but not its sound designs nothing: shelves and peaks at 0 dB under lines of their frequency and
// resonance (and a glide of it) are the input bit for bit, a pass under a line of its gain is the pass as it is;
// lines that stand go as lines of coefficients in their first segment alone
#[test]
fn a_band_nothing_moves_is_not_redesigned() {
    let mut source = noise(31);
    let frames = 4096;
    let input = [
        (0..frames).map(|_| source() * 0.5).collect::<Vec<f32>>(),
        (0..frames).map(|_| source() * 0.5).collect::<Vec<f32>>(),
    ];
    let sweep = |depth: f64| -> Vec<f64> {
        (0..frames)
            .map(|i| depth * sin(2.0 * PI * i as f64 / 1000.0))
            .collect()
    };
    for (t1, t2) in [(SHELF, SHELF), (PEAK, PEAK)] {
        let mut eq = Eq::new(RATE, &params(&[(T1, t1 as f64), (T2, t2 as f64)]));
        let lines = [sweep(2.0), sweep(30.0), vec![], sweep(-3.0), sweep(20.0), vec![]];
        let out = render(
            &mut eq,
            &input,
            &mut blocks_of(128),
            |eq, at| {
                if at == 1024 {
                    let glide = [(F2, 9000.0)];
                    eq.set(all(&glide), &params(&glide));
                }
            },
            Some(&lines),
        );
        assert_eq!(bits(&out[0]), bits(&input[0]));
        assert_eq!(bits(&out[1]), bits(&input[1]));
        assert!(eq.bands.iter().all(|band| !band.moving && band.lined == 0));
    }

    let pass = params(&[(T1, PASS as f64), (F1, 300.0), (Q1, 40.0)]);
    let gain = [vec![], vec![], sweep(12.0), vec![], vec![], vec![]];
    let mut eq = Eq::new(RATE, &pass);
    let moved = render(&mut eq, &input, &mut blocks_of(128), |_, _| {}, Some(&gain));
    let still = render(
        &mut Eq::new(RATE, &pass),
        &input,
        &mut blocks_of(128),
        |_, _| {},
        None,
    );
    assert_eq!(bits(&moved[0]), bits(&still[0]));
    assert_eq!(bits(&moved[1]), bits(&still[1]));
    assert!(eq.bands.iter().all(|band| band.lined == 0));

    let peak = params(&[(T1, PEAK as f64), (F1, 500.0), (Q1, 40.0), (G1, 6.0)]);
    let stand = [
        vec![1.0; frames],
        vec![10.0; frames],
        vec![-3.0; frames],
        vec![],
        vec![],
        vec![],
    ];
    let mut eq = Eq::new(RATE, &peak);
    render(&mut eq, &input, &mut blocks_of(128), |_, _| {}, Some(&stand));
    assert_eq!(eq.bands[0].lined, 1);
}

// the level: a gain of 4 v², gliding
#[test]
fn the_level_is_four_times_its_square() {
    let input = sine(1000.0, 8000, 0.25);
    for (knob, gain) in [(0.25, 0.25), (0.5, 1.0), (1.0, 4.0), (0.0, 0.0)] {
        let mut eq = Eq::new(RATE, &params(&[(LEVEL, knob)]));
        let out = render(&mut eq, &input, &mut blocks_of(128), |_, _| {}, None);
        for (a, b) in out[0].iter().zip(input[0].iter()) {
            assert!((*a as f64 - gain * *b as f64).abs() < 1e-6);
        }
    }
    let mut eq = Eq::new(RATE, &params(&[]));
    let out = render(
        &mut eq,
        &input,
        &mut blocks_of(128),
        |eq, at| {
            if at == 2048 {
                eq.set(1 << LEVEL, &params(&[(LEVEL, 1.0)]));
            }
        },
        None,
    );
    assert!(roughness(&out[0], 2048) < roughness(&sine(1500.0, 8000, 1.0)[0], 0));
}

// an idle EQ designs only the bands what is set is of (a route on the level sets it every block, the EQ idle while
// a reverb after it rings): the level alone designs none and plays at once, a frequency its band alone
#[test]
fn an_idle_eq_designs_only_the_bands_it_is_set() {
    let knobs = params(&[(T1, PEAK as f64), (G1, 6.0), (T2, PASS as f64)]);
    let mut eq = Eq::new(RATE, &knobs);
    assert!(eq.idle());
    let designs = |eq: &Eq| eq.bands.each_ref().map(|band| band.designs);
    let before = designs(&eq);
    for _ in 0..10 {
        eq.set(1 << LEVEL, &params(&[(LEVEL, 1.0)]));
    }
    assert_eq!(designs(&eq), before);
    eq.set(all(&[(F1, 0.0)]), &params(&[(F1, 900.0)]));
    assert_eq!(designs(&eq), [before[0] + 1, before[1]]);
    eq.set(
        all(&[(T2, 0.0), (G2, 0.0)]),
        &params(&[(T2, SHELF as f64), (G2, -6.0)]),
    );
    assert_eq!(designs(&eq), [before[0] + 1, before[1] + 1]);

    // what it plays is what a fresh EQ of those knobs plays
    let set = params(&[
        (T1, PEAK as f64),
        (F1, 900.0),
        (G1, 6.0),
        (T2, SHELF as f64),
        (G2, -6.0),
        (LEVEL, 1.0),
    ]);
    let input = sine(1000.0, 4096, 0.25);
    let out = render(&mut eq, &input, &mut blocks_of(128), |_, _| {}, None);
    let fresh = render(
        &mut Eq::new(RATE, &set),
        &input,
        &mut blocks_of(128),
        |_, _| {},
        None,
    );
    assert_eq!(bits(&out[0]), bits(&fresh[0]));
    assert_eq!(bits(&out[1]), bits(&fresh[1]));
}

// silence after a sound: the EQ rests once its tail is out, then a sound is what a fresh one renders
#[test]
fn silence_rests_it() {
    let frames = 3 * 48000;
    let mut input = sine(60.0, frames, 0.5);
    for channel in input.iter_mut() {
        channel[24000..96000].fill(0.0);
    }
    let knobs = params(&[
        (T1, 1.0),
        (F1, 200.0),
        (Q1, 60.0),
        (G1, 12.0),
        (T2, 2.0),
        (F2, 4000.0),
    ]);
    let mut eq = Eq::new(RATE, &knobs);
    let mut idle_at = None;
    let out = render(
        &mut eq,
        &input,
        &mut blocks_of(128),
        |eq, at| {
            if idle_at.is_none() && at > 24000 && eq.idle() {
                idle_at = Some(at);
            }
        },
        None,
    );
    let idle_at = idle_at.expect("it rests");
    // (a peak of 12 dB and Q 2.55 at 200 Hz rings out under -200 dB in 0.4 s; one of Q 19 and 24 dB at 60 Hz
    // would ring for 40 s, as a resonator does)
    assert!(idle_at < 24000 + 24000, "{idle_at}");
    assert!(out[0][idle_at..96000].iter().all(|value| *value == 0.0));
    let fresh = render(
        &mut Eq::new(RATE, &knobs),
        &[input[0][96000..].to_vec(), input[1][96000..].to_vec()],
        &mut blocks_of(128),
        |_, _| {},
        None,
    );
    assert_eq!(bits(&out[0][96000..]), bits(&fresh[0]));
}

// a channel silent alone while the other plays on (a voice panned to a side): only a silence of both forgets the
// states, so those of the silent one come to 0 at the end of a segment before they decay into the denormals (they
// stood there, a few of their steps over the smallest, the band at rest and moving, a shelf, a peak, a pass); its
// output goes out as 0 under TINY: it came to the denormals of f32 long before the states to those of doubles (it
// went out in them for tens of ms, into the chain after it)
#[test]
fn a_channel_silent_alone_never_comes_near_a_denormal() {
    let frames = 4 * 48000;
    let mut source = noise(5);
    let mut left: Vec<f32> = (0..frames).map(|_| source() * 0.5).collect();
    left[48000..].fill(0.0);
    let right: Vec<f32> = (0..frames).map(|_| source() * 0.5).collect();
    let input = [left, right];
    let denormal = |x: f64| x != 0.0 && x.abs() < f64::MIN_POSITIVE;
    let shelf_and_peak = params(&[
        (T1, 0.0),
        (F1, 100.0),
        (G1, 6.0),
        (T2, 1.0),
        (F2, 1000.0),
        (G2, 6.0),
    ]);
    let passes = params(&[(T1, 2.0), (F1, 400.0), (T2, 2.0), (F2, 5000.0)]);
    let mut offsets: [Vec<f64>; 6] = core::array::from_fn(|_| vec![0.0; frames]);
    offsets[0] = vec![50.0; frames];
    let mut worst = [0usize; 3];
    let mut tiny = [0usize; 3];
    for (case, (knobs, lines)) in [
        (shelf_and_peak, None),
        (shelf_and_peak, Some(&offsets)),
        (passes, None),
    ]
    .into_iter()
    .enumerate()
    {
        let mut eq = Eq::new(RATE, &knobs);
        let out = render(
            &mut eq,
            &input,
            &mut blocks_of(128),
            |eq, _| {
                let lanes = eq
                    .bands
                    .iter()
                    .flat_map(|band| band.state)
                    .flat_map(|x| [x.lo(), x.hi()]);
                worst[case] += lanes.filter(|x| denormal(*x)).count();
            },
            lines,
        );
        tiny[case] = out
            .iter()
            .flatten()
            .filter(|x| **x != 0.0 && x.abs() < TINY)
            .count();
        assert!(
            out[0][..48000].iter().any(|x| x.abs() > 0.1),
            "case {case}: the left one played"
        );
        if worst[case] > 0 {
            continue;
        }
        assert!(!eq.idle(), "case {case}");
        for band in eq.bands.iter() {
            for x in band.state {
                assert_eq!(x.lo().to_bits(), 0, "case {case}: the left lane rests at +0");
                assert!(x.hi() != 0.0, "case {case}: the right one plays");
            }
        }
    }
    // (the states in the denormals at the ends of the blocks, of each case; the samples out under TINY, not 0)
    assert_eq!(worst, [0; 3]);
    assert_eq!(tiny, [0; 3]);
}

// a block that is not finite out is silence, the EQ forgotten
#[test]
fn a_non_finite_block_is_forgotten() {
    let mut eq = Eq::new(RATE, &params(&[(T1, 1.0), (G1, 12.0)]));
    let mut input = sine(300.0, 1024, 0.5);
    input[0][700] = f32::NAN;
    let out = render(&mut eq, &input, &mut blocks_of(128), |_, _| {}, None);
    assert!(out[0][640..768].iter().all(|value| *value == 0.0));
    assert!(out[0].iter().all(|value| value.is_finite()));
    assert!(out[0][900..].iter().any(|value| value.abs() > 0.1));
}

// a neutral EQ (the bands at 0 dB, the level at a half) passes the input as it is, but not what is not finite: a
// block of a NaN or an infinity is silence too
#[test]
fn a_neutral_eq_takes_what_is_not_finite_as_silence() {
    let mut source = noise(41);
    let frames = 2048;
    let mut input = [
        (0..frames).map(|_| source() * 0.5).collect::<Vec<f32>>(),
        (0..frames).map(|_| source() * 0.5).collect::<Vec<f32>>(),
    ];
    input[0][700] = f32::NAN;
    input[1][1500] = f32::INFINITY;
    let out = render(
        &mut Eq::new(RATE, &params(&[])),
        &input,
        &mut blocks_of(128),
        |_, _| {},
        None,
    );
    let parts = [
        (0..640, false),
        (640..768, true),
        (768..1408, false),
        (1408..1536, true),
        (1536..frames, false),
    ];
    for channel in 0..2 {
        for (part, silent) in parts.clone() {
            if silent {
                assert!(out[channel][part].iter().all(|value| *value == 0.0));
            } else {
                assert_eq!(bits(&out[channel][part.clone()]), bits(&input[channel][part]));
            }
        }
    }
}

// the knobs out of their ranges are their ends, a type over a pass is a pass (the reference)
#[test]
fn the_knobs_stop_at_their_ends() {
    let at = |band, ty, freq, reso, gain| design(band, ty, freq, reso, gain, RATE);
    assert_eq!(at(0, PEAK, 5.0, 50.0, 12.0), at(0, PEAK, 20.0, 50.0, 12.0));
    assert_eq!(at(0, PEAK, 25000.0, 50.0, 12.0), at(0, PEAK, 20000.0, 50.0, 12.0));
    assert_eq!(at(1, PEAK, 1000.0, -10.0, 12.0), at(1, PEAK, 1000.0, 0.0, 12.0));
    assert_eq!(
        at(1, SHELF, 1000.0, 150.0, 12.0),
        at(1, SHELF, 1000.0, 100.0, 12.0)
    );
    assert_eq!(at(0, SHELF, 1000.0, 50.0, 40.0), at(0, SHELF, 1000.0, 50.0, 24.0));
    assert_eq!(at(0, PASS, 1000.0, 50.0, 12.0), at(0, PASS, 1000.0, 50.0, -24.0));
    assert_eq!(type_of(5.0), PASS);
    assert_eq!(type_of(-1.0), SHELF);
    assert_eq!(type_of(f64::NAN), SHELF);
    // (nyquist: at 22.05 kHz the top is under 11.025 kHz)
    assert!(at(1, PEAK, 20000.0, 50.0, 12.0)[0].is_finite());
    assert!(design(0, PASS, 20000.0, 50.0, 0.0, 22050.0)[0] < 1000.0);
}
