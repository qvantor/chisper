use super::*;

// a seeded noise in [-1, 1)
fn noise(seed: &mut u64) -> f32 {
    *seed = seed
        .wrapping_mul(6364136223846793005)
        .wrapping_add(1442695040888963407);
    ((*seed >> 40) as f64 / (1u64 << 23) as f64 - 1.0) as f32
}

// the params of a fresh compressor: one band, or three with `below`
fn params(multi: f64, below: f64) -> [f64; PARAMS] {
    let mut params = [0.0; PARAMS];
    params[MULTI] = multi;
    params[THRESH] = 0.5;
    params[RATIO] = 4.0;
    params[ATTACK] = 90.0;
    params[RELEASE] = 90.0;
    params[XLOW] = 131.0;
    params[XHIGH] = 2500.0;
    params[BELOW] = below;
    params[LEVEL] = 0.5;
    params[MIX] = 1.0;
    params
}

// bursts of noise and of a sine, loud and quiet
fn program(frames: usize, seed: u64) -> (Vec<f32>, Vec<f32>) {
    let mut seed = seed;
    let mut left = Vec::with_capacity(frames);
    let mut right = Vec::with_capacity(frames);
    for i in 0..frames {
        let level = [0.9, 0.02, 0.3, 0.001][(i / 3000) % 4];
        let tone = jsmath::sin(i as f64 * 0.05) as f32;
        left.push(level * (0.6 * tone + 0.4 * noise(&mut seed)));
        right.push(level * (0.5 * tone - 0.5 * noise(&mut seed)));
    }
    (left, right)
}

fn render(
    compressor: &mut Compressor,
    input: &(Vec<f32>, Vec<f32>),
    blocks: &mut dyn FnMut() -> usize,
) -> Vec<f32> {
    let frames = input.0.len();
    let (mut out_l, mut out_r) = (vec![0.0; frames], vec![0.0; frames]);
    let mut at = 0;
    while at < frames {
        let n = blocks().min(frames - at);
        compressor.process(
            &input.0[at..at + n],
            &input.1[at..at + n],
            &mut out_l[at..at + n],
            &mut out_r[at..at + n],
        );
        at += n;
    }
    out_l.extend(out_r);
    out_l
}

fn bits(values: &[f32]) -> Vec<u32> {
    values.iter().map(|x| x.to_bits()).collect()
}

fn rms(values: &[f32]) -> f64 {
    (values.iter().map(|x| (*x as f64) * (*x as f64)).sum::<f64>() / values.len() as f64).sqrt()
}

// the lanes of the one band circuit are four samples of time: blocks of any length render what one sample after
// the other does. The spans of the bands end with a block: blocks of whole spans render what one long block does
#[test]
fn the_blocks_render_what_a_sample_after_the_other_would() {
    let input = program(20000, 7);
    for (multi, below) in [(0.0, 0.0), (1.0, 0.0), (1.0, 0.7)] {
        for rate in [22050.0, 44100.0, 96000.0] {
            let mut whole = Compressor::new(rate, &params(multi, below));
            let plain = render(&mut whole, &input, &mut || if multi == 0.0 { 1 } else { 20000 });
            let mut seed = 99u64;
            let mut by_block = Compressor::new(rate, &params(multi, below));
            let mut lengths = || {
                let length = 1 + ((noise(&mut seed) + 1.0) * 150.0) as usize;
                if multi == 0.0 {
                    length
                } else {
                    length.div_ceil(SPAN) * SPAN
                }
            };
            let blocks = render(&mut by_block, &input, &mut lengths);
            assert!(
                bits(&plain) == bits(&blocks),
                "multi {multi}, below {below}, {rate} Hz"
            );
            assert!(rms(&plain) > 0.01);
        }
    }
}

// the bands with no compression sum to the input through an allpass: a sine keeps its level at any frequency, at
// any mix (the dry signal is the sum of the bands: no notch at a crossover)
#[test]
fn the_bands_sum_to_an_allpass() {
    for mix in [1.0, 0.5, 0.0] {
        for frequency in [60.0, 131.0, 400.0, 2500.0, 9000.0] {
            let mut neutral = params(1.0, 0.0);
            neutral[RATIO] = 1.0;
            neutral[MIX] = mix;
            let mut compressor = Compressor::new(48000.0, &neutral);
            let sine: Vec<f32> = (0..48000)
                .map(|i| (0.25 * jsmath::sin(2.0 * PI * frequency * i as f64 / 48000.0)) as f32)
                .collect();
            let out = render(&mut compressor, &(sine.clone(), sine.clone()), &mut || BLOCK);
            let highpass = frequency / (frequency * frequency + HIGHPASS * HIGHPASS).sqrt();
            let ratio = rms(&out[24000..48000]) / (rms(&sine[24000..]) * highpass);
            assert!((ratio - 1.0).abs() < 2e-3, "{frequency} Hz, mix {mix}: {ratio}");
        }
    }
}

// the gains of the bands every SPAN samples, linear between: what differs from gains worked out at every sample
// is 30 dB under the signal and more, on a program that jumps by 60 dB (where the gains move tens of dB in a
// millisecond)
#[test]
fn the_points_of_the_bands_follow_the_gain_of_every_sample() {
    let input = program(40000, 3);
    for below in [0.0, 1.0] {
        let mut spans = Compressor::new(48000.0, &params(1.0, below));
        let mut every = Compressor::new(48000.0, &params(1.0, below));
        every.every_sample = true;
        let a = render(&mut spans, &input, &mut || BLOCK);
        let b = render(&mut every, &input, &mut || BLOCK);
        let difference: Vec<f32> = a.iter().zip(&b).map(|(x, y)| x - y).collect();
        let under = 20.0 * jsmath::log10(rms(&difference) / rms(&b));
        assert!(under < -30.0, "below {below}: {under} dB");
    }
}

// a silence stays one, whatever the upward compression would add to it, and the core goes idle; a sound as quiet
// as a noise floor is never lifted over the ceiling of the gain
#[test]
fn a_silence_stays_a_silence() {
    for (multi, below) in [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0)] {
        let mut compressor = Compressor::new(48000.0, &params(multi, below));
        let loud = program(6000, 5);
        render(&mut compressor, &loud, &mut || BLOCK);
        let silence = (vec![0.0; 48000 * 4], vec![0.0; 48000 * 4]);
        let out = render(&mut compressor, &silence, &mut || BLOCK);
        assert!(out[out.len() / 2 - 48000..out.len() / 2]
            .iter()
            .all(|x| *x == 0.0));
        assert!(compressor.idle(), "multi {multi}, below {below}");
        let mut seed = 1;
        let floor: Vec<f32> = (0..48000).map(|_| 1e-6 * noise(&mut seed)).collect();
        let lifted = render(&mut compressor, &(floor.clone(), floor.clone()), &mut || BLOCK);
        let gain = 20.0 * jsmath::log10(rms(&lifted[24000..48000]) / rms(&floor[24000..]));
        assert!(gain < GAIN_CEILING + 0.1, "{gain}");
        if below == 1.0 {
            assert!(gain > GAIN_CEILING - 1.0, "{gain}");
        } else {
            assert!(gain.abs() < 0.1, "{gain}");
        }
    }
}

// a silence puts the core to rest at any Below (a small one never lifts a band to the ceiling of the gain: its
// mean squares held are flushed to 0) and while a route moves a param at every block
#[test]
fn a_silence_rests_the_core_at_a_small_below_and_under_a_route() {
    for (multi, below) in [
        (0.0, 0.0),
        (1.0, 0.0),
        (1.0, 0.02),
        (1.0, 0.05),
        (1.0, 0.15),
        (1.0, 1.0),
    ] {
        for routed in [false, true] {
            let mut compressor = Compressor::new(48000.0, &params(multi, below));
            let loud = program(6000, 5);
            render(&mut compressor, &loud, &mut || BLOCK);
            let silence = vec![0.0; BLOCK];
            let (mut out_l, mut out_r) = (vec![0.0; BLOCK], vec![0.0; BLOCK]);
            let mut changes = [0.0; PARAMS];
            for block in 0..48000 * 8 / BLOCK {
                if routed {
                    changes[THRESH] = 0.5 + 0.2 * jsmath::sin(block as f64 * 0.01);
                    changes[MIX] = 0.7 + 0.3 * jsmath::sin(block as f64 * 0.013);
                    compressor.set(1 << THRESH | 1 << MIX, &changes);
                }
                compressor.process(&silence, &silence, &mut out_l, &mut out_r);
            }
            assert!(compressor.idle(), "multi {multi}, below {below}, routed {routed}");
            // the sound after the rest is the one of a fresh core at the params as they are then
            if routed {
                let mut fresh_params = params(multi, below);
                fresh_params[THRESH] = changes[THRESH];
                fresh_params[MIX] = changes[MIX];
                let mut fresh = Compressor::new(48000.0, &fresh_params);
                let woken = render(&mut compressor, &loud, &mut || BLOCK);
                assert!(bits(&woken) == bits(&render(&mut fresh, &loud, &mut || BLOCK)));
            }
        }
    }
}

// NaN or an infinity past the io (process_io zeroes them, process doesn't): its block is silence, the state
// forgets it, the next blocks sound
#[test]
fn a_block_that_is_not_finite_is_forgotten() {
    let sine: Vec<f32> = (0..BLOCK)
        .map(|i| (0.5 * jsmath::sin(i as f64 * 0.21)) as f32)
        .collect();
    for special in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        for multi in [0.0, 1.0] {
            let mut compressor = Compressor::new(48000.0, &params(multi, 0.5));
            let mut poisoned = sine.clone();
            poisoned[17] = special;
            let (mut out_l, mut out_r) = (vec![0.0; BLOCK], vec![0.0; BLOCK]);
            compressor.process(&sine, &sine, &mut out_l, &mut out_r);
            compressor.process(&poisoned, &sine, &mut out_l, &mut out_r);
            assert!(
                out_l.iter().chain(&out_r).all(|x| *x == 0.0),
                "{special} multi {multi}: {:?}",
                &out_l[14..22]
            );
            for _ in 0..4 {
                compressor.process(&sine, &sine, &mut out_l, &mut out_r);
                assert!(out_l.iter().chain(&out_r).all(|x| x.is_finite()));
            }
            assert!(out_l.iter().any(|x| x.abs() > 0.01));
        }
    }
}

// a switch of the circuit fades from one to the other: both render, no step in the output
#[test]
fn a_switch_of_the_circuit_is_a_fade() {
    let sine: Vec<f32> = (0..48000)
        .map(|i| (0.05 * jsmath::sin(2.0 * PI * 500.0 * i as f64 / 48000.0)) as f32)
        .collect();
    let mut compressor = Compressor::new(48000.0, &params(0.0, 0.0));
    let (mut out_l, mut out_r) = (vec![0.0; 48000], vec![0.0; 48000]);
    let mut largest = 0.0f32;
    let mut last = 0.0f32;
    for block in 0..375 {
        if block == 100 || block == 200 || block == 203 {
            let mut changes = [0.0; PARAMS];
            changes[MULTI] = if block == 100 || block == 203 { 1.0 } else { 0.0 };
            compressor.set(1 << MULTI, &changes);
        }
        let at = block * BLOCK;
        let (l, r) = (&mut out_l[at..at + BLOCK], &mut out_r[at..at + BLOCK]);
        compressor.process(&sine[at..at + BLOCK], &sine[at..at + BLOCK], l, r);
        if block > 50 {
            for x in l.iter() {
                largest = largest.max((x - last).abs());
                last = *x;
            }
        } else {
            last = l[BLOCK - 1];
        }
    }
    // the step of the sine from a sample to the next: 0.05 × 2π × 500 / 48000 = 0.0033
    assert!(largest < 0.005, "{largest}");
    assert!(rms(&out_l[40000..]) > 0.02);
}

// a hit after a silence or a quiet sound, the bands at the ceiling of their gain before it (Below): the span of
// the hit gets the gains of each of its samples, wherever it starts in it (a line from the gains of before would
// lift its first samples by tens of dB: a click of several times the hit)
#[test]
fn a_hit_after_a_silence_gets_the_gains_of_its_samples() {
    let hit = |lead: usize, quiet: f32, silence: usize| {
        let mut seed = 11u64;
        let (mut left, mut right) = (Vec::new(), Vec::new());
        for i in 0..lead + silence + 2000 {
            let level = if i < lead {
                0.5
            } else if i < lead + silence {
                quiet
            } else {
                0.9
            };
            let tone = jsmath::sin(2.0 * PI * 1000.0 * i as f64 / 48000.0) as f32;
            left.push(level * (0.7 * tone + 0.3 * noise(&mut seed)));
            right.push(level * (0.7 * tone - 0.3 * noise(&mut seed)));
        }
        (left, right)
    };
    let peak = |x: &[f32]| x.iter().fold(0.0f32, |a, b| a.max(b.abs()));
    for below in [0.75, 1.0] {
        // (asleep: the hit at any place of a span, of a block; awake after a sound; a noise floor before it)
        for (lead, quiet, silence) in [
            (0, 0.0, 4801),
            (0, 0.0, 4800),
            (0, 0.0, 4807),
            (0, 0.0, 4736),
            (6000, 0.0, 24001),
            (6000, 0.0, 2401),
            (6000, 1e-4, 24003),
        ] {
            let input = hit(lead, quiet, silence);
            let mut spans = Compressor::new(48000.0, &params(1.0, below));
            let mut every = Compressor::new(48000.0, &params(1.0, below));
            every.every_sample = true;
            let a = render(&mut spans, &input, &mut || BLOCK);
            let b = render(&mut every, &input, &mut || BLOCK);
            let at = lead + silence;
            let (ours, theirs) = (peak(&a[at..at + 2 * SPAN]), peak(&b[at..at + 2 * SPAN]));
            let over = 20.0 * jsmath::log10(ours as f64 / theirs as f64);
            assert!(
                over.abs() < 0.1,
                "below {below}, {lead} {quiet} {silence}: {ours} against {theirs}"
            );
            // the hit is never louder than it came in
            assert!(ours < peak(&input.0[at..at + 2 * SPAN]), "{ours}");
        }
    }
}
