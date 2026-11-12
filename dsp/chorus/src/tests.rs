use super::*;

// a seeded noise in [-1, 1)
fn noise(seed: &mut u64) -> f32 {
    *seed = seed
        .wrapping_mul(6364136223846793005)
        .wrapping_add(1442695040888963407);
    ((*seed >> 40) as f64 / (1u64 << 23) as f64 - 1.0) as f32
}

// the params of a fresh chorus
fn fresh() -> [f64; PARAMS] {
    let mut params = [0.0; PARAMS];
    params[RATE] = 0.078125;
    params[D1] = 5.0;
    params[DEPTH] = 26.0;
    params[FB] = 0.095;
    params[CUT] = 1000.0;
    params[LEVEL] = 0.5;
    params[MIX] = 0.5;
    params
}

// the taps alone: the filter open, no feedback, the wet signal at its level
fn taps(first: f64, second: f64, depth: f64, rate: f64) -> [f64; PARAMS] {
    let mut params = fresh();
    params[RATE] = rate;
    params[D1] = first;
    params[D2] = second;
    params[DEPTH] = depth;
    params[FB] = 0.0;
    params[CUT] = 20000.0;
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

fn render(chorus: &mut Chorus, input: &(Vec<f32>, Vec<f32>), blocks: &mut dyn FnMut() -> usize) -> Vec<f32> {
    let frames = input.0.len();
    let (mut out_l, mut out_r) = (vec![0.0; frames], vec![0.0; frames]);
    let mut at = 0;
    while at < frames {
        let n = blocks().min(frames - at);
        chorus.process(
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

// a smooth click (a Hann bump of 32 samples, 1 in all) in both channels from `at`: the filter passes it as it is
fn click(frames: usize, at: usize) -> (Vec<f32>, Vec<f32>) {
    let mut left = vec![0.0; frames];
    for i in 0..32 {
        left[at + i] = ((1.0 - jsmath::cos(2.0 * PI * (i as f64 + 0.5) / 32.0)) / 32.0) as f32;
    }
    (left.clone(), left)
}

// where the click from `at` comes out of a channel between `from` and `to` samples after it: the middle of its
// samples by their level, samples after the middle of the click; and how much of it comes out there
fn arrival(output: &[f32], at: usize, from: f64, to: f64) -> (f64, f64) {
    let (mut sum, mut moment) = (0.0, 0.0);
    for i in at + from as usize..at + to as usize {
        sum += output[i] as f64;
        moment += output[i] as f64 * (i - at) as f64;
    }
    (moment / sum - 15.5, sum)
}

// the groups of four samples render what one sample after the other does, at the rates where every segment is in
// groups, where none is (a low rate: the taps under five samples) and with the LFO fast and the feedback high
#[test]
fn the_groups_render_what_a_sample_after_the_other_would() {
    let input = program(30000, 7);
    for rate in [22050.0, 44100.0, 96000.0] {
        for (lfo, feedback) in [(0.078125, 0.095), (7.0, 0.9)] {
            let mut params = fresh();
            params[RATE] = lfo;
            params[FB] = feedback;
            let mut plain = Chorus::new(rate, &params);
            plain.sample_by_sample = true;
            let expected = render(&mut plain, &input, &mut || 128);
            let mut grouped = Chorus::new(rate, &params);
            let got = render(&mut grouped, &input, &mut || 128);
            assert!(bits(&expected) == bits(&got), "{rate} Hz, LFO {lfo}");
            assert!(rms(&expected) > 0.01);
        }
    }
}

// the delays are worked out from the place in the segment, the gains do not move: a block of any length renders
// the same samples
#[test]
fn how_a_block_is_cut_changes_no_sample() {
    let input = program(30000, 11);
    for rate in [22050.0, 48000.0] {
        let mut whole = Chorus::new(rate, &fresh());
        let expected = render(&mut whole, &input, &mut || 128);
        let mut seed = 99u64;
        let mut cut = Chorus::new(rate, &fresh());
        let got = render(&mut cut, &input, &mut || {
            1 + ((noise(&mut seed) + 1.0) * 150.0) as usize
        });
        assert!(bits(&expected) == bits(&got), "{rate} Hz");
    }
}

// with no depth a tap is its knob and the latency after the dry click (and what the filter delays it by), whatever
// the rate
#[test]
fn a_tap_is_its_delay_after_the_click() {
    for rate in [22050.0, 44100.0, 96000.0] {
        for (first, second) in [(5.0, 0.0), (20.0, 10.0), (1.0, 12.0)] {
            // (the filter at 4 kHz: a pole pair there delays the click by some 40 µs, at any rate)
            let mut params = taps(first, second, 0.0, 0.078125);
            params[CUT] = 4000.0;
            let mut chorus = Chorus::new(rate, &params);
            let output = render(&mut chorus, &click(8192, 100), &mut || 128);
            let places: Vec<f64> = [second, first]
                .iter()
                .map(|knob| {
                    let expected = (LATENCY + knob * 0.001) * rate;
                    let (got, level) = arrival(
                        &output[..8192],
                        100,
                        expected - 8.0,
                        expected + 32.0 + 0.0015 * rate,
                    );
                    assert!(
                        (got - expected).abs() < 6e-5 * rate,
                        "{rate} Hz, {knob} ms: {got} for {expected}"
                    );
                    assert!((level - 0.5).abs() < 0.01);
                    got
                })
                .collect();
            let apart = (first - second) * 0.001 * rate;
            assert!(
                (places[1] - places[0] - apart).abs() < 0.01,
                "{rate} Hz: {places:?}"
            );
        }
    }
}

// at rest the LFO has the first tap of the left channel at the top of its travel, the second at the bottom, those
// of the right channel half way
#[test]
fn the_taps_are_a_quarter_of_a_cycle_apart() {
    let rate = 44100.0;
    let mut chorus = Chorus::new(rate, &taps(20.0, 0.0, 2.0, 0.0));
    let output = render(&mut chorus, &click(8192, 100), &mut || 128);
    let travel = 2.0 / MAX_DEPTH * TRAVEL * rate;
    let (near, far) = (LATENCY * rate, (LATENCY + 0.02) * rate);
    let place = |channel: usize, delay: f64| {
        arrival(
            &output[channel * 8192..(channel + 1) * 8192],
            100,
            delay - 8.0,
            delay + 56.0,
        )
        .0
    };
    let bottom = place(0, far) - 0.02 * rate;
    for (channel, delay, expected) in [
        (0, near + travel, travel),
        (1, near + 0.5 * travel, 0.5 * travel),
        (1, far + 0.5 * travel, 0.02 * rate + 0.5 * travel),
    ] {
        let got = place(channel, delay) - bottom;
        assert!((got - expected).abs() < 1e-3, "{got} for {expected}");
    }
}

// a delay follows the triangle through its pole: between the ends of the travel, rounded at them by the rate
#[test]
fn the_lfo_moves_the_taps_inside_their_travel() {
    let rate = 44100.0;
    for (lfo, reached) in [(1.0, 0.8), (20.0, 0.2)] {
        let mut chorus = Chorus::new(rate, &taps(20.0, 0.0, 1.0, lfo));
        let silence = (vec![1e-3; 44100], vec![1e-3; 44100]);
        render(&mut chorus, &silence, &mut || 128);
        let (low, high) = (LATENCY * rate, (LATENCY + TRAVEL / MAX_DEPTH) * rate);
        let (mut least, mut most) = (f64::INFINITY, 0.0f64);
        for _ in 0..2000 {
            render(&mut chorus, &(vec![1e-3; 32], vec![1e-3; 32]), &mut || 32);
            least = min(least, chorus.from[0]);
            most = max(most, chorus.from[0]);
        }
        assert!(least >= low && most <= high);
        let share = (most - least) / (high - low);
        assert!(share > reached && share < reached + 0.2, "{lfo} Hz: {share}");
    }
}

// each tap feeds itself alone: a click comes back every delay of its tap, × the feedback, and never at the sum of
// the delays of two taps
#[test]
fn a_tap_feeds_only_itself() {
    let rate = 44100.0;
    let mut params = taps(10.0, 7.0, 0.0, 0.0);
    params[FB] = 0.5;
    let mut chorus = Chorus::new(rate, &params);
    let output = render(&mut chorus, &click(8192, 100), &mut || 128);
    let level = |ms: f64| {
        let at = (LATENCY + ms * 0.001) * rate;
        arrival(&output[..8192], 100, at - 8.0, at + 56.0).1
    };
    let latency = LATENCY * 1000.0;
    for delay in [10.0, 7.0] {
        let first = level(delay);
        assert!((first - 0.5).abs() < 0.01);
        let second = level(2.0 * delay + latency);
        assert!((second / first - 0.5).abs() < 0.03, "{second} after {first}");
    }
    assert!(level(17.0 + latency).abs() < 0.005);
}

// what goes in at no mix comes out as it is × the level; the wet signal alone is the two taps of a channel, a half
// each
#[test]
fn the_mix_and_the_level() {
    let input = program(4096, 3);
    for level in [0.5, 1.0, 0.25] {
        let mut params = fresh();
        params[MIX] = 0.0;
        params[LEVEL] = level;
        let mut chorus = Chorus::new(48000.0, &params);
        let output = render(&mut chorus, &input, &mut || 128);
        let gain = (4.0 * level * level) as f32;
        assert!(output[..4096]
            .iter()
            .zip(&input.0)
            .all(|(y, x)| (y - gain * x).abs() < 1e-6));
    }
    let mut chorus = Chorus::new(44100.0, &taps(0.0, 0.0, 0.0, 0.0));
    let output = render(&mut chorus, &click(4096, 100), &mut || 128);
    let sum: f32 = output[100..200].iter().sum();
    assert!((sum - 1.0).abs() < 0.02, "{sum}");
}

// silent in and out for longer than its longest tap, it rests; the next sound wakes it with nothing of the one
// before
#[test]
fn it_rests_after_its_tail_and_wakes_clean() {
    let mut params = fresh();
    params[FB] = 0.9;
    let mut chorus = Chorus::new(44100.0, &params);
    assert!(chorus.idle());
    let input = program(4096, 5);
    let first = render(&mut chorus, &input, &mut || 128);
    assert!(!chorus.idle());
    let silence = (vec![0.0; 128], vec![0.0; 128]);
    let mut blocks = 0;
    while !chorus.idle() {
        render(&mut chorus, &silence, &mut || 128);
        blocks += 1;
        assert!(blocks < 20000);
    }
    assert!(blocks as f64 * 128.0 > 0.08 * 44100.0);
    let rest = render(&mut chorus, &silence, &mut || 128);
    assert!(rest.iter().all(|x| *x == 0.0));
    // the LFO went on while it slept: the same sound is another one now
    let again = render(&mut chorus, &input, &mut || 128);
    assert!(rms(&again) > 0.5 * rms(&first) && bits(&again) != bits(&first));
}

// forget() drops the lines: a click in them never comes out
#[test]
fn forgetting_drops_the_tail() {
    let mut chorus = Chorus::new(44100.0, &taps(20.0, 20.0, 0.0, 0.0));
    render(&mut chorus, &click(256, 10), &mut || 128);
    chorus.forget();
    assert!(chorus.idle());
    let silence = (vec![0.0; 4096], vec![0.0; 4096]);
    assert!(render(&mut chorus, &silence, &mut || 128)
        .iter()
        .all(|x| *x == 0.0));
}

// params that move glide: no step in the output of a steady tone as the mix, the level and the feedback jump
#[test]
fn the_gains_glide() {
    let frames = 128 * 80;
    let tone: Vec<f32> = (0..frames)
        .map(|i| 0.5 * jsmath::sin(i as f64 * 0.01) as f32)
        .collect();
    let mut chorus = Chorus::new(44100.0, &taps(0.0, 0.0, 0.0, 0.0));
    let mut output = Vec::new();
    for block in 0..80 {
        if block == 20 {
            let mut changes = [0.0; PARAMS];
            changes[MIX] = 0.0;
            changes[LEVEL] = 1.0;
            changes[FB] = 0.9;
            chorus.set(1 << MIX | 1 << LEVEL | 1 << FB, &changes);
        }
        let range = block * 128..(block + 1) * 128;
        let (mut out_l, mut out_r) = (vec![0.0; 128], vec![0.0; 128]);
        chorus.process(&tone[range.clone()], &tone[range], &mut out_l, &mut out_r);
        output.extend(out_l);
    }
    let steepest = output
        .windows(2)
        .map(|pair| (pair[1] - pair[0]).abs())
        .fold(0.0f32, f32::max);
    assert!(steepest < 0.05, "{steepest}");
    assert!((output[frames - 1] / tone[frames - 1] - 4.0).abs() < 0.01);
}

// a block that is not finite is forgotten: silence, and the next ones are whole
#[test]
fn a_block_that_is_not_finite_is_forgotten() {
    let mut chorus = Chorus::new(44100.0, &fresh());
    let input = program(1024, 1);
    render(&mut chorus, &input, &mut || 128);
    let broken = (vec![f32::NAN; 128], vec![f32::INFINITY; 128]);
    let output = render(&mut chorus, &broken, &mut || 128);
    assert!(output.iter().all(|x| *x == 0.0));
    assert!(chorus.idle());
    let output = render(&mut chorus, &input, &mut || 128);
    assert!(output.iter().all(|x| x.is_finite()) && rms(&output) > 0.01);
}

// the filter stays stable at the top of its knob at any rate
#[test]
fn the_filter_holds_at_any_cutoff() {
    for rate in [22050.0, 44100.0, 192000.0] {
        for (cutoff, high) in [(20000.0, 0.0), (20000.0, 1.0), (20.0, 0.0), (20.0, 1.0)] {
            let mut params = taps(0.0, 0.0, 0.0, 0.0);
            params[CUT] = cutoff;
            params[HPF] = high;
            let mut chorus = Chorus::new(rate, &params);
            let output = render(&mut chorus, &program(20000, 13), &mut || 128);
            assert!(output.iter().all(|x| x.abs() < 8.0), "{rate} Hz, {cutoff} Hz");
        }
    }
}

// the meter: the LFO as it is (it went on by its rate over the samples rendered, asleep or not) and the knobs
// that place the taps, held to their ranges
#[test]
fn the_meter_is_the_lfo_and_the_knobs_of_the_taps() {
    let rate = 44100.0;
    let mut chorus = Chorus::new(rate, &taps(7.0, 3.0, 13.0, 2.0));
    assert_eq!(
        chorus.meter(),
        Meter {
            phase: 0.0,
            rate: 2.0,
            d1: 7.0,
            d2: 3.0,
            depth: 13.0,
            cut: 20000.0,
        }
    );
    // asleep
    let silence = (vec![0.0; 128], vec![0.0; 128]);
    for _ in 0..10 {
        render(&mut chorus, &silence, &mut || 128);
    }
    assert!(chorus.idle());
    let asleep = 2.0 * 1280.0 / rate;
    assert!((chorus.meter().phase - asleep).abs() < 1e-12);
    // awake: a segment at a time
    let input = program(1280, 3);
    render(&mut chorus, &input, &mut || 128);
    assert!(!chorus.idle());
    let phase = chorus.meter().phase;
    assert!((phase - 2.0 * asleep).abs() < 1e-12 && phase < 1.0);
    // a knob out of its range is where the taps have it
    let mut changes = [0.0; PARAMS];
    changes[RATE] = 50.0;
    changes[D1] = -1.0;
    changes[DEPTH] = 40.0;
    chorus.set(1 << RATE | 1 << D1 | 1 << DEPTH, &changes);
    let meter = chorus.meter();
    assert_eq!(
        (meter.rate, meter.d1, meter.d2, meter.depth),
        (20.0, 0.0, 3.0, 26.0)
    );
}
