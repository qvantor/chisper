//! The filter: its response is the design of its type (f32 lanes at a low cutoff too), Pan is a filter of each
//! channel at its own cutoff, still knobs design nothing and a sweep designs its cells, how the blocks are cut
//! changes nothing while the knobs rest, a change of type and a sweep move it without a click, the level and the mix
//! are its laws, silence rests it after its tail

use super::*;
use crate::tests::{bits, blocks_of, noise, sine};
use alloc::vec;
use alloc::vec::Vec;
use dsp_core::filter_model::{design_gain2, model_design, more_droop};
use jsmath::cos;

const RATE: f64 = 48000.0;

// the defaults of a fresh one (MG Low 6 at 425 Hz, all wet), some keys set
fn params(values: &[(usize, f64)]) -> [f64; PARAMS] {
    let mut all = [0.0, 425.18, 0.0, 0.0, 0.0, 50.0, 0.5, 1.0];
    for &(key, value) in values {
        all[key] = value;
    }
    all
}

fn index_of(ty: ModelType) -> f64 {
    TYPES.iter().position(|&t| t == ty).unwrap() as f64
}

// `input` through the filter in blocks of `blocks()` samples, `before` at the start of each (its frame), `lines` its
// lines from that frame on (an empty one: none)
fn render(
    filter: &mut FxFilter,
    input: &[Vec<f32>; 2],
    blocks: &mut dyn FnMut() -> usize,
    mut before: impl FnMut(&mut FxFilter, usize),
    lines: Option<&[Vec<f64>; 5]>,
) -> [Vec<f32>; 2] {
    let frames = input[0].len();
    let mut out = [vec![0.0f32; frames], vec![0.0f32; frames]];
    filter.grow(256);
    let mut at = 0;
    while at < frames {
        let count = blocks().min(frames - at);
        before(filter, at);
        let moves = Moves {
            filter: core::array::from_fn(|knob| {
                lines
                    .filter(|lines| !lines[knob].is_empty())
                    .map(|lines| &lines[knob][at..at + count])
            }),
            ..Moves::default()
        };
        let [left, right] = &mut out;
        filter.process(
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

fn signal(seed: u32, frames: usize, level: f32) -> [Vec<f32>; 2] {
    let mut left = noise(seed);
    let mut right = noise(seed + 100);
    [
        (0..frames).map(|_| level * left()).collect(),
        (0..frames).map(|_| level * right()).collect(),
    ]
}

fn rms(data: &[f32]) -> f64 {
    let sum: f64 = data.iter().map(|&x| x as f64 * x as f64).sum();
    jsmath::sqrt(sum / data.len() as f64)
}

// the most a sample of the output steps from the one before (a click shows as a step far over those of the sound)
fn steepest(data: &[f32]) -> f32 {
    data.windows(2)
        .map(|pair| (pair[1] - pair[0]).abs())
        .fold(0.0, f32::max)
}

// |H|² of the design of the filter at f: its type at its knobs with its droop (what the loops play, small signal)
fn gain2(ty: ModelType, cutoff: f64, res: f64, f: f64) -> f64 {
    let mut design = model_design(ty, cutoff, res / 100.0, 0.0, RATE);
    design.droop = more_droop(design.droop, fx_droop(ty));
    design_gain2(&design, f, RATE)
}

// a quiet sine through a filter: its gain (dB) over the last half of a second and a half
fn measured(ty: ModelType, cutoff: f64, res: f64, f: f64) -> f64 {
    let frames = (1.5 * RATE) as usize;
    let mut filter = FxFilter::new(
        RATE,
        &params(&[(TYPE, index_of(ty)), (CUTOFF, cutoff), (RES, res)]),
    );
    let input = sine(f, frames, 1e-3, RATE);
    let out = render(&mut filter, &input, &mut blocks_of(128), |_, _| {}, None);
    let tail = frames / 3;
    20.0 * log2(amplitude(&out[0], f, frames - tail) / amplitude(&input[0], f, frames - tail)) / log2(10.0)
}

// the amplitude of the frequency f in data from `from` on (a ring of a resonance at another one left out)
fn amplitude(data: &[f32], f: f64, from: usize) -> f64 {
    let (mut re, mut im) = (0.0, 0.0);
    for (i, &x) in data.iter().enumerate().skip(from) {
        let phase = 2.0 * PI * f * i as f64 / RATE;
        re += x as f64 * cos(phase);
        im += x as f64 * sin(phase);
    }
    2.0 * jsmath::sqrt(re * re + im * im) / (data.len() - from) as f64
}

// each type plays the response of its design (its droop with it), a low cutoff in the lanes of f32 too: Low and
// High 24 at 20 Hz, no resonance and all of it
#[test]
fn a_type_plays_its_design() {
    let cases = [
        (ModelType::Ladder24, 1000.0, 0.0),
        (ModelType::Ladder6, 425.18, 0.0),
        (ModelType::Low12, 2000.0, 30.0),
        (ModelType::High12, 500.0, 30.0),
        (ModelType::Band24, 1500.0, 20.0),
        (ModelType::Peak12, 3000.0, 20.0),
        (ModelType::Notch12, 1000.0, 0.0),
        (ModelType::Low24, 20.0, 0.0),
        (ModelType::Low24, 20.0, 100.0),
        (ModelType::High24, 20.0, 0.0),
        (ModelType::High24, 20.0, 100.0),
    ];
    for (ty, cutoff, res) in cases {
        for f in [30.0, 110.0, 440.0, 1500.0, 5000.0, 12000.0] {
            let expected = 10.0 * log2(gain2(ty, cutoff, res, f)) / log2(10.0);
            // (deep in a stop band the sine is under the floor of f32 the measure reads)
            if expected < -60.0 {
                continue;
            }
            let got = measured(ty, cutoff, res, f);
            assert!(
                (got - expected).abs() < 0.1,
                "{ty:?} at {cutoff} Hz, Res {res}: {f} Hz {got} dB, its design {expected} dB"
            );
        }
    }
}

// Pan moves the cutoff of each channel by ±32 x³ semitones: each channel is a filter at its own cutoff (the left one
// up left of the middle)
#[test]
fn pan_is_a_filter_of_each_channel_at_its_cutoff() {
    let frames = 40 * 128;
    let input = signal(3, frames, 0.3);
    for pan in [0.0, 20.0, 35.0, 65.0, 100.0] {
        let knobs = [
            (TYPE, index_of(ModelType::Low12)),
            (CUTOFF, 800.0),
            (RES, 60.0),
            (PAN, pan),
        ];
        let mut panned = FxFilter::new(RATE, &params(&knobs));
        let out = render(&mut panned, &input, &mut blocks_of(128), |_, _| {}, None);
        let octaves = pan_octaves(pan);
        assert!(octaves * (50.0 - pan) > 0.0, "{pan}");
        for (channel, sign) in [(0, 1.0), (1, -1.0)] {
            let cutoff = pow(2.0, log2(800.0) + sign * octaves);
            let mut alone = FxFilter::new(
                RATE,
                &params(&[(TYPE, index_of(ModelType::Low12)), (CUTOFF, cutoff), (RES, 60.0)]),
            );
            let each = render(&mut alone, &input, &mut blocks_of(128), |_, _| {}, None);
            let error = out[channel]
                .iter()
                .zip(&each[channel])
                .map(|(a, b)| (a - b).abs())
                .fold(0.0, f32::max);
            assert!(error < 1e-5, "pan {pan}, channel {channel}: {error}");
        }
    }
    assert_eq!(pan_octaves(50.0), 0.0);
    assert!((pan_octaves(0.0) - 32.0 / 12.0).abs() < 1e-12);
    assert!((pan_octaves(25.0) - 32.0 / 12.0 / 8.0).abs() < 1e-12);
}

// still knobs design once: the blocks after take the coefficients as they are; a cutoff that sweeps alone takes the
// designs of its cells, kept: an LFO coming back to a cell designs nothing more
#[test]
fn still_knobs_design_nothing_and_a_sweep_its_cells() {
    let frames = 200 * 128;
    let input = signal(5, frames, 0.3);
    let mut filter = FxFilter::new(
        RATE,
        &params(&[
            (TYPE, index_of(ModelType::Ladder24)),
            (CUTOFF, 1200.0),
            (RES, 50.0),
        ]),
    );
    render(&mut filter, &input, &mut blocks_of(128), |_, _| {}, None);
    // (one design: its first span; at rest a design a block was over a hundred)
    assert!(
        filter.designs.worked_out() <= 1,
        "{}",
        filter.designs.worked_out()
    );
    assert_eq!(filter.spans, 200, "a span a block");

    // an LFO of 8 Hz over ±1.5 octaves, four of its cycles
    let lfo: Vec<f64> = (0..frames)
        .map(|i| 1.5 * sin(2.0 * PI * 8.0 * i as f64 / RATE))
        .collect();
    let lines = [lfo, Vec::new(), Vec::new(), Vec::new(), Vec::new()];
    let mut swept = FxFilter::new(
        RATE,
        &params(&[
            (TYPE, index_of(ModelType::Ladder24)),
            (CUTOFF, 1200.0),
            (RES, 50.0),
        ]),
    );
    let half = frames / 2;
    let first = [input[0][..half].to_vec(), input[1][..half].to_vec()];
    let first_lines: [Vec<f64>; 5] = core::array::from_fn(|k| {
        if lines[k].is_empty() {
            Vec::new()
        } else {
            lines[k][..half].to_vec()
        }
    });
    render(
        &mut swept,
        &first,
        &mut blocks_of(128),
        |_, _| {},
        Some(&first_lines),
    );
    let designs = swept.designs.worked_out();
    // (3 octaves of cells, 16 an octave, three designs a cell at most: under one a span)
    assert!(designs < 3 * 16 * 3 + 8, "{designs}");
    assert!(
        designs < swept.spans / 2,
        "{designs} designs, {} spans",
        swept.spans
    );
    let second = [input[0][half..].to_vec(), input[1][half..].to_vec()];
    let second_lines: [Vec<f64>; 5] = core::array::from_fn(|k| {
        if lines[k].is_empty() {
            Vec::new()
        } else {
            lines[k][half..].to_vec()
        }
    });
    render(
        &mut swept,
        &second,
        &mut blocks_of(128),
        |_, _| {},
        Some(&second_lines),
    );
    // (the LFO comes back to the cells it swept: few more)
    assert!(
        swept.designs.worked_out() - designs < 16,
        "{}",
        swept.designs.worked_out()
    );
}

// at rest how the blocks are cut changes no bit
#[test]
fn the_blocks_change_nothing_at_rest() {
    let frames = 60 * 128;
    let input = signal(7, frames, 0.4);
    for ty in [
        ModelType::Ladder24,
        ModelType::Low12,
        ModelType::Band24,
        ModelType::High18,
    ] {
        let knobs = params(&[
            (TYPE, index_of(ty)),
            (CUTOFF, 2000.0),
            (RES, 70.0),
            (DRIVE, 30.0),
            (VAR, 20.0),
            (PAN, 40.0),
            (LEVEL, 0.6),
            (MIX, 0.8),
        ]);
        let whole = render(
            &mut FxFilter::new(RATE, &knobs),
            &input,
            &mut blocks_of(128),
            |_, _| {},
            None,
        );
        let mut sizes = [64, 128, 32, 96, 128, 128].into_iter().cycle();
        let cut = render(
            &mut FxFilter::new(RATE, &knobs),
            &input,
            &mut move || sizes.next().unwrap(),
            |_, _| {},
            None,
        );
        assert_eq!(bits(&whole[0]), bits(&cut[0]), "{ty:?} left");
        assert_eq!(bits(&whole[1]), bits(&cut[1]), "{ty:?} right");
    }
}

// a change of type on a playing filter crossfades in FADE: no click; one during the fade waits for its end
#[test]
fn a_change_of_type_crossfades() {
    let frames = 40 * 128;
    let input = sine(220.0, frames, 0.5, RATE);
    let knobs = params(&[(TYPE, index_of(ModelType::Low24)), (CUTOFF, 300.0), (RES, 40.0)]);
    let changes = [
        (10 * 128, index_of(ModelType::High12)),
        (11 * 128, index_of(ModelType::Band24)),
    ];
    let mut filter = FxFilter::new(RATE, &knobs);
    let out = render(
        &mut filter,
        &input,
        &mut blocks_of(128),
        |filter, at| {
            for &(frame, ty) in changes.iter() {
                if frame == at {
                    filter.set(1 << TYPE, &params(&[(TYPE, ty)]));
                }
            }
        },
        None,
    );
    // (a sine of 220 Hz at 0.5 steps by 0.0145 at most a sample)
    assert!(steepest(&out[0]) < 0.03, "{}", steepest(&out[0]));
    assert_eq!(filter.ty, ModelType::Band24);
    // the one at once: idle
    let mut idle = FxFilter::new(RATE, &knobs);
    idle.set(1 << TYPE, &params(&[(TYPE, index_of(ModelType::Peak24))]));
    assert_eq!(idle.ty, ModelType::Peak24);
    assert!(idle.fade.is_none());
}

// a cutoff swept by its line from 100 Hz to 10 kHz in 50 ms (a fast envelope) and a resonance by its own: no click,
// the sound follows it
#[test]
fn a_fast_sweep_makes_no_click() {
    let frames = 30 * 128;
    let input = sine(110.0, frames, 0.5, RATE);
    let ramp = |from: f64, to: f64| -> Vec<f64> {
        (0..frames)
            .map(|i| from + (to - from) * min(1.0, i as f64 / (0.05 * RATE)))
            .collect()
    };
    for ty in [ModelType::Ladder24, ModelType::Low12, ModelType::Band12] {
        let lines = [
            ramp(0.0, log2(10000.0 / 100.0)),
            ramp(0.0, 60.0),
            Vec::new(),
            Vec::new(),
            Vec::new(),
        ];
        let mut filter = FxFilter::new(
            RATE,
            &params(&[(TYPE, index_of(ty)), (CUTOFF, 100.0), (RES, 20.0)]),
        );
        let out = render(&mut filter, &input, &mut blocks_of(128), |_, _| {}, Some(&lines));
        assert!(out[0].iter().all(|x| x.is_finite()));
        assert!(steepest(&out[0]) < 0.06, "{ty:?}: {}", steepest(&out[0]));
    }
}

// Drive, or Var under Res 40 % (its FAT, the saturation with it), taken by a line through 0 and under it inside the
// first span of a block (every span end of the block at 0 or under it, its start over 0): the sections go on along
// the line from where the block before left them, no step of the level at the start of the block
#[test]
fn a_drive_or_a_fat_gone_in_the_first_span_makes_no_click() {
    // a steady level (a step of the gain is a step of the output), the filter open
    let frames = 8 * 128;
    let input = [vec![0.5f32; frames], vec![0.5f32; frames]];
    let base = [(TYPE, index_of(ModelType::Low12)), (CUTOFF, 12000.0), (RES, 30.0)];
    // the steps of the envelope itself (Drive 4.3e-3..4.6e-3, Var 1.2e-3; left out at once they stepped 6.5e-3 to
    // 2.6e-2, 2.4e-3 to 7.9e-3, more the later the 0)
    for (knob, bound) in [(2, 0.005), (3, 0.0015)] {
        for k in [8, 16, 24, 31] {
            // a fast envelope: 25 down to 0 in 5 ms, 0 at 384 + k, on under it
            let zero = (384 + k) as f64;
            let line: Vec<f64> = (0..frames)
                .map(|i| min(25.0, 25.0 * (zero - i as f64) / 240.0))
                .collect();
            let mut lines: [Vec<f64>; 5] = Default::default();
            lines[knob] = line;
            let mut filter = FxFilter::new(RATE, &params(&base));
            let out = render(&mut filter, &input, &mut blocks_of(128), |_, _| {}, Some(&lines));
            assert!(out[0].iter().all(|x| x.is_finite()));
            // (after the step of the level at its start)
            let step = steepest(&out[0][256..]);
            assert!(step < bound, "knob {knob}, 0 at {zero}: {step}");
        }
    }
}

// the level is a gain of 4 v², the mix wet sin²(π mix / 2) and dry 1 - wet², the level of both
#[test]
fn the_level_and_the_mix_are_its_laws() {
    let frames = 20 * 128;
    let input = signal(11, frames, 0.3);
    let base = [(TYPE, index_of(ModelType::Low12)), (CUTOFF, 1500.0), (RES, 30.0)];
    let wet = render(
        &mut FxFilter::new(RATE, &params(&base)),
        &input,
        &mut blocks_of(128),
        |_, _| {},
        None,
    );
    for (level, mix) in [(0.25, 1.0), (0.5, 0.5), (0.8, 0.25), (0.5, 0.0)] {
        let knobs = [base[0], base[1], base[2], (LEVEL, level), (MIX, mix)];
        let out = render(
            &mut FxFilter::new(RATE, &params(&knobs)),
            &input,
            &mut blocks_of(128),
            |_, _| {},
            None,
        );
        let share = sin(0.5 * PI * mix);
        let w = share * share;
        let gain = 4.0 * level * level;
        for channel in 0..2 {
            for i in 0..frames {
                let expected = gain * ((1.0 - w * w) * input[channel][i] as f64 + w * wet[channel][i] as f64);
                assert!(
                    (out[channel][i] as f64 - expected).abs() < 1e-6,
                    "level {level} mix {mix} at {i}"
                );
            }
        }
    }
}

// silence after a sound: it plays its tail, then rests (idle) and gives silence; a resonance rings on longer
#[test]
fn silence_rests_it_after_its_tail() {
    let frames = 600 * 128;
    let mut input = signal(13, frames, 0.3);
    for channel in input.iter_mut() {
        channel[10 * 128..].fill(0.0);
    }
    for (res, by) in [(0.0, 40), (95.0, 400)] {
        let mut filter = FxFilter::new(
            RATE,
            &params(&[(TYPE, index_of(ModelType::Low12)), (CUTOFF, 1000.0), (RES, res)]),
        );
        let mut rested = None;
        let out = render(
            &mut filter,
            &input,
            &mut blocks_of(128),
            |filter, at| {
                if rested.is_none() && at > 10 * 128 && filter.idle() {
                    rested = Some(at / 128);
                }
            },
            None,
        );
        assert!(rested.is_some_and(|block| block <= by), "Res {res}: {rested:?}");
        // (the tail before it rests)
        assert!(rms(&out[0][10 * 128..11 * 128]) > 0.0);
        assert!(out[0][(by + 1) * 128..].iter().all(|&x| x == 0.0), "Res {res}");
    }
}

// what is not finite in a knob is taken as 0; a type no one has is MG Low 6
#[test]
fn a_knob_not_finite_or_out_of_range() {
    assert_eq!(type_of(f64::NAN), ModelType::Ladder6);
    assert_eq!(type_of(18.0), ModelType::Ladder6);
    assert_eq!(type_of(-1.0), ModelType::Ladder6);
    assert_eq!(type_of(4.4), ModelType::Low6);
    let frames = 10 * 128;
    let input = signal(17, frames, 0.3);
    let knobs = params(&[
        (CUTOFF, f64::NAN),
        (RES, f64::INFINITY),
        (DRIVE, f64::NAN),
        (PAN, f64::NAN),
    ]);
    let out = render(
        &mut FxFilter::new(RATE, &knobs),
        &input,
        &mut blocks_of(128),
        |_, _| {},
        None,
    );
    assert!(out.iter().all(|channel| channel.iter().all(|x| x.is_finite())));
}
