//! The chain against its units run by hand, bit for bit: a slot is its effect and its mix, the order is the order,
//! a rest is the blocks it skipped; the events, the modulation, a stage that traps

use alloc::{vec, vec::Vec};

use crate::chain::*;
use crate::delay;
use crate::modulation::{KEYS, LFO_SOURCE, LFO_STATE, MIX_KEY, NOTE};
use crate::units::*;

const BLOCK: usize = 128;

fn params() -> [[f64; MAX_PARAMS]; SLOTS] {
    let mut all = [[0.0; MAX_PARAMS]; SLOTS];
    all[DISTORTION as usize][..4].copy_from_slice(&[0.0, 8.0, 20000.0, 0.0]);
    all[CHORUS as usize][..9].copy_from_slice(&[0.5, 5.0, 2.0, 26.0, 0.1, 1000.0, 0.0, 0.5, 0.5]);
    all[DELAY as usize][..6].copy_from_slice(&[0.011, 0.5, 0.0, 0.0, 1000.0, 0.01]);
    all[COMPRESSOR as usize][..14].copy_from_slice(&[
        0.0, 0.5, 4.0, 9.0, 90.0, 0.2, 131.0, 2500.0, 0.0, 0.0, 0.0, 0.0, 0.5, 1.0,
    ]);
    all[REVERB as usize][..12].copy_from_slice(&[
        20.0, 0.02, 0.5, 2.0, 6000.0, 1.0, 0.2, 1.0, 0.5, 0.0, 24000.0, 0.0,
    ]);
    all
}

// a seeded noise in [-1, 1)
fn noise(seed: u32) -> impl FnMut() -> f32 {
    let mut state = seed;
    move || {
        state = state.wrapping_mul(1664525).wrapping_add(1013904223);
        (state >> 8) as f32 / 8388608.0 - 1.0
    }
}

fn signal(seed: u32, frames: usize, level: f32) -> [Vec<f32>; 2] {
    let mut source = noise(seed);
    [
        (0..frames).map(|_| source() * level).collect(),
        (0..frames).map(|_| source() * level).collect(),
    ]
}

fn event(kind: u32, a: f64, b: f64, values: &[f64]) -> Event {
    let mut all = [0.0; MAX_PARAMS];
    all[..values.len()].copy_from_slice(values);
    Event {
        at: 0.0,
        kind,
        a,
        b,
        values: all,
    }
}

// a chain with `kinds` in this order, each on at `mix`
fn chain_of(rate: f64, kinds: &[u32], mix: f64, limited: bool) -> Chain {
    let mut chain = Chain::new(rate, &params(), limited);
    let order: Vec<f64> = kinds.iter().map(|kind| *kind as f64).collect();
    chain.push(event(SET_ORDER, kinds.len() as f64, 0.0, &order));
    for kind in kinds {
        chain.push(event(SET_MIX, *kind as f64, mix, &[]));
        chain.push(event(SET_ACTIVE, *kind as f64, 1.0, &[]));
    }
    chain
}

fn render(
    chain: &mut Chain,
    input: &[Vec<f32>; 2],
    mut before: impl FnMut(&mut Chain, usize),
) -> [Vec<f32>; 2] {
    let frames = input[0].len();
    let mut out = [vec![0.0f32; frames], vec![0.0f32; frames]];
    let mut at = 0;
    while at < frames {
        let count = BLOCK.min(frames - at);
        before(chain, at);
        let data = chain.reserve(count);
        // SAFETY: the block reserved: inL, inR, outL, outR
        let block = unsafe { core::slice::from_raw_parts_mut(data, 4 * count) };
        block[..count].copy_from_slice(&input[0][at..at + count]);
        block[count..2 * count].copy_from_slice(&input[1][at..at + count]);
        chain.process(at as f64);
        out[0][at..at + count].copy_from_slice(&block[2 * count..3 * count]);
        out[1][at..at + count].copy_from_slice(&block[3 * count..]);
        at += count;
    }
    out
}

fn through(unit: &mut Unit, input: &[Vec<f32>; 2]) -> [Vec<f32>; 2] {
    let frames = input[0].len();
    let mut out = [vec![0.0f32; frames], vec![0.0f32; frames]];
    let mut at = 0;
    while at < frames {
        let count = BLOCK.min(frames - at);
        let [left, right] = &mut out;
        unit.process(
            &input[0][at..at + count],
            &input[1][at..at + count],
            &mut left[at..at + count],
            &mut right[at..at + count],
        );
        at += count;
    }
    out
}

// the unit of a kind as a slot at `mix` has it: an effect that mixes inside takes the mix as its param
fn unit_of(kind: u32, rate: f64, mix: f64) -> Unit {
    let mut params = params()[kind as usize];
    if let Law::Inside(key) = law(kind) {
        params[key] = mix;
    }
    Unit::new(kind, rate, &params, true).unwrap()
}

fn bits(data: &[f32]) -> Vec<u32> {
    data.iter().map(|value| value.to_bits()).collect()
}

fn same(a: &[Vec<f32>; 2], b: &[Vec<f32>; 2], what: &str) {
    for channel in 0..2 {
        let first = (0..a[channel].len()).find(|&i| a[channel][i].to_bits() != b[channel][i].to_bits());
        assert_eq!(first, None, "{what}: channel {channel}");
    }
}

fn sounds(out: &[Vec<f32>; 2]) -> bool {
    out[0].iter().any(|value| value.abs() > 1e-4)
}

// an effect that plays alone in its slot (the mix inside it, or all wet in time) is its unit, to the bit
#[test]
fn a_slot_alone_is_its_unit() {
    for &rate in &[44100.0, 96000.0] {
        let input = signal(1, 20 * BLOCK, 0.4);
        for kind in [CHORUS, COMPRESSOR] {
            let mut chain = chain_of(rate, &[kind], 0.7, false);
            // (at once where its knobs have it: no fade from a wire)
            chain.push(event(CLEAR, 0.0, 0.0, &[]));
            let out = render(&mut chain, &input, |_, _| {});
            let alone = through(&mut unit_of(kind, rate, 0.7), &input);
            assert!(sounds(&out));
            same(&out, &alone, "a slot alone");
        }
    }
}

// after a clear a slot is where its knobs have it at once: all wet, the distortion and the reverb are their units
// from the first block
#[test]
fn a_slot_all_wet_after_a_clear_is_its_unit() {
    let rate = 48000.0;
    let input = signal(2, 30 * BLOCK, 0.4);
    for kind in [DISTORTION, DELAY, REVERB] {
        let mut chain = chain_of(rate, &[kind], 1.0, false);
        chain.push(event(CLEAR, 0.0, 0.0, &[]));
        let out = render(&mut chain, &input, |_, _| {});
        let mut unit = Unit::new(kind, rate, &params()[kind as usize], true).unwrap();
        let alone = through(&mut unit, &input);
        assert!(sounds(&out));
        if kind == DISTORTION {
            // (linear: dry 0, wet 1)
            same(&out, &alone, "the distortion");
        } else {
            // (equal power at 1: the dry gain is cos(π / 2), 6e-17, the wet one 1: within a bit of f32)
            for (a, b) in out[0].iter().zip(&alone[0]) {
                assert!((a - b).abs() <= 1e-7 * (1.0 + b.abs()));
            }
        }
    }
}

// the mix of a slot: dry · the input, late by the latency of the effect, + wet · the effect
#[test]
fn a_slot_mixes_the_input_late_by_the_latency() {
    let rate = 48000.0;
    let input = signal(3, 30 * BLOCK, 0.4);
    let mut chain = chain_of(rate, &[DISTORTION], 0.3, false);
    chain.push(event(CLEAR, 0.0, 0.0, &[]));
    let out = render(&mut chain, &input, |_, _| {});
    let mut unit = Unit::new(DISTORTION, rate, &params()[0], true).unwrap();
    let latency = unit.latency();
    assert_eq!(latency, 32);
    let alone = through(&mut unit, &input);
    let (dry, wet) = ((1.0f64 - 0.3) as f32, 0.3f64 as f32);
    for channel in 0..2 {
        for i in 0..input[0].len() {
            let late = if i < latency {
                0.0
            } else {
                input[channel][i - latency]
            };
            let expected = dry * late + wet * alone[channel][i];
            assert_eq!(out[channel][i].to_bits(), expected.to_bits(), "sample {i}");
        }
    }
}

// the slots in their order are the units one into the other; another order is another sound
#[test]
fn the_order_is_the_order_of_the_units() {
    let rate = 44100.0;
    let input = signal(4, 40 * BLOCK, 0.3);
    let run = |kinds: &[u32]| {
        let mut chain = chain_of(rate, kinds, 1.0, false);
        chain.push(event(CLEAR, 0.0, 0.0, &[]));
        render(&mut chain, &input, |_, _| {})
    };
    let by_hand = |kinds: &[u32]| {
        let mut sound = input.clone();
        for &kind in kinds {
            sound = through(&mut unit_of(kind, rate, 1.0), &sound);
        }
        sound
    };
    let one = [DISTORTION, CHORUS, COMPRESSOR];
    let other = [COMPRESSOR, CHORUS, DISTORTION];
    same(&run(&one), &by_hand(&one), "distortion, chorus, compressor");
    same(&run(&other), &by_hand(&other), "compressor, chorus, distortion");
    assert_ne!(bits(&run(&one)[0]), bits(&run(&other)[0]));
}

// a slot that is off, or out of the order, is a wire; without a slot and at the gains of 1 the chain is one too
#[test]
fn a_slot_that_is_off_is_a_wire() {
    let rate = 48000.0;
    let input = signal(5, 10 * BLOCK, 0.4);
    let mut empty = Chain::new(rate, &params(), false);
    same(&render(&mut empty, &input, |_, _| {}), &input, "no slot");
    let mut chain = chain_of(rate, &[REVERB, DELAY], 0.5, false);
    chain.push(event(SET_ACTIVE, REVERB as f64, 0.0, &[]));
    chain.push(event(SET_ACTIVE, DELAY as f64, 0.0, &[]));
    chain.push(event(CLEAR, 0.0, 0.0, &[]));
    same(&render(&mut chain, &input, |_, _| {}), &input, "slots off");
}

// a slot fades in and out in the 10 ms of its gains: no step, a wire again once it is out (its effect forgotten)
#[test]
fn a_slot_fades_in_and_out() {
    let rate = 48000.0;
    let frames = 80 * BLOCK;
    let input = [vec![0.25f32; frames], vec![0.25f32; frames]];
    let mut chain = Chain::new(rate, &params(), false);
    chain.push(event(SET_ORDER, 1.0, 0.0, &[COMPRESSOR as f64]));
    let out = render(&mut chain, &input, |chain, at| {
        if at == 10 * BLOCK {
            chain.push(event(SET_ACTIVE, COMPRESSOR as f64, 1.0, &[]));
        }
        if at == 30 * BLOCK {
            chain.push(event(SET_ACTIVE, COMPRESSOR as f64, 0.0, &[]));
        }
    });
    assert_eq!(out[0][10 * BLOCK - 1], 0.25);
    // (the compressor at these knobs is louder than its input)
    assert!((out[0][29 * BLOCK] - 0.25).abs() > 0.01);
    for i in 1..frames {
        assert!((out[0][i] - out[0][i - 1]).abs() < 0.02, "a step at {i}");
    }
    assert_eq!(bits(&out[0][70 * BLOCK..]), bits(&input[0][70 * BLOCK..]));
    assert!(chain.idle(COMPRESSOR as usize));
}

// the blocks a silent chain skips leave what rendering them would have: the LFO of the chorus where it would be,
// the next sound the same
#[test]
fn a_rest_is_the_blocks_it_skipped() {
    let rate = 44100.0;
    let frames = 700 * BLOCK;
    let mut input = signal(6, frames, 0.4);
    // (a sound, a long silence of +0, a sound again)
    for channel in input.iter_mut() {
        channel[20 * BLOCK..600 * BLOCK].fill(0.0);
    }
    let kinds = [DISTORTION, CHORUS, DELAY, COMPRESSOR, REVERB];
    let run = |restless: bool| {
        let mut chain = chain_of(rate, &kinds, 0.5, true);
        chain.restless = restless;
        render(&mut chain, &input, |_, _| {})
    };
    let (rested, rendered) = (run(false), run(true));
    same(&rested, &rendered, "a rest");
    assert!(sounds(&[
        rested[0][650 * BLOCK..].to_vec(),
        rested[1][650 * BLOCK..].to_vec()
    ]));
}

// an event is taken at the first block at or after its frame, in the order of their times
#[test]
fn an_event_is_taken_at_its_frame() {
    let rate = 48000.0;
    let frames = 20 * BLOCK;
    let input = [vec![0.5f32; frames], vec![0.5f32; frames]];
    let mut chain = Chain::new(rate, &params(), false);
    let at = |frame: usize, kind: u32, a: f64| Event {
        at: frame as f64,
        ..event(kind, a, 0.0, &[])
    };
    // (pushed out of order)
    chain.push(at(12 * BLOCK, MASTER_GAIN, 0.25));
    chain.push(at(4 * BLOCK + 5, MASTER_GAIN, 0.5));
    chain.push(at(16 * BLOCK, MUTE, 64.0 / rate));
    chain.push(at(18 * BLOCK, UNMUTE, 0.0));
    let out = render(&mut chain, &input, |_, _| {});
    assert_eq!(out[0][5 * BLOCK - 1], 0.5);
    // (frame 4 · 128 + 5 is in the block of 4 · 128: the event waits for the next one)
    assert_eq!(out[0][5 * BLOCK], 0.25);
    assert_eq!(out[0][12 * BLOCK - 1], 0.25);
    assert_eq!(out[0][12 * BLOCK], 0.125);
    // the mute: a line from 1 to 0 in 64 samples, then silence, then at once back
    assert_eq!(out[0][16 * BLOCK], 0.125);
    assert_eq!(out[0][16 * BLOCK + 32], 0.0625);
    assert_eq!(out[0][16 * BLOCK + 64], 0.0);
    assert_eq!(out[0][18 * BLOCK - 1], 0.0);
    assert_eq!(out[0][18 * BLOCK], 0.125);
}

// the limiter holds the output under its ceiling, late by its lookahead; without it the chain is its slots
#[test]
fn the_limiter_ends_the_chain() {
    let rate = 48000.0;
    let input = signal(7, 60 * BLOCK, 3.0);
    let mut chain = Chain::new(rate, &params(), true);
    let out = render(&mut chain, &input, |_, _| {});
    let mut limiter = Unit::new(LIMITER, rate, &[0.0; MAX_PARAMS], true).unwrap();
    assert_eq!(chain.latency(), limiter.latency());
    same(&out, &through(&mut limiter, &input), "the limiter");
    assert!(out[0].iter().all(|value| value.abs() <= 1.0));
}

// the params of an event reach the unit: the same sound as the unit set by hand
#[test]
fn the_params_of_an_event_reach_the_unit() {
    let rate = 48000.0;
    let input = signal(8, 40 * BLOCK, 0.4);
    let mut chain = chain_of(rate, &[DISTORTION], 1.0, false);
    chain.push(event(CLEAR, 0.0, 0.0, &[]));
    let mut values = [0.0; MAX_PARAMS];
    values[distortion::DRIVE] = 12.0;
    values[distortion::TONE] = 3000.0;
    let present = (1 << distortion::DRIVE | 1 << distortion::TONE) as f64;
    let out = render(&mut chain, &input, |chain, at| {
        if at == 10 * BLOCK {
            chain.push(event(SET_PARAMS, DISTORTION as f64, present, &values));
        }
    });
    let mut unit = Unit::new(DISTORTION, rate, &params()[0], true).unwrap();
    let mut alone = [Vec::new(), Vec::new()];
    for (part, set) in [(0..10 * BLOCK, false), (10 * BLOCK..40 * BLOCK, true)] {
        if set {
            unit.set(present as u32, &values, false);
        }
        let piece = through(
            &mut unit,
            &[input[0][part.clone()].to_vec(), input[1][part].to_vec()],
        );
        alone[0].extend_from_slice(&piece[0]);
        alone[1].extend_from_slice(&piece[1]);
    }
    same(&out, &alone, "the distortion set");
}

fn trapped(chain: &mut Chain, input: &[Vec<f32>; 2], at: usize) -> bool {
    let count = BLOCK;
    let data = chain.reserve(count);
    // SAFETY: the block reserved
    let block = unsafe { core::slice::from_raw_parts_mut(data, 4 * count) };
    block[..count].copy_from_slice(&input[0][at..at + count]);
    block[count..2 * count].copy_from_slice(&input[1][at..at + count]);
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| chain.process(at as f64))).is_err()
}

fn output(chain: &mut Chain) -> [Vec<f32>; 2] {
    let data = chain.reserve(BLOCK);
    // SAFETY: the block reserved
    let block = unsafe { core::slice::from_raw_parts(data, 4 * BLOCK) };
    [block[2 * BLOCK..3 * BLOCK].to_vec(), block[3 * BLOCK..].to_vec()]
}

// an effect that traps is dropped: its slot is a wire from that block on, the others play on, a report names it;
// made again it plays
#[test]
fn an_effect_that_traps_leaves_the_others_playing() {
    let rate = 48000.0;
    let input = signal(9, 40 * BLOCK, 0.3);
    let mut chain = chain_of(rate, &[DISTORTION, CHORUS, COMPRESSOR], 1.0, false);
    chain.push(event(CLEAR, 0.0, 0.0, &[]));
    let mut by_hand: Vec<Unit> = [DISTORTION, COMPRESSOR]
        .iter()
        .map(|&kind| unit_of(kind, rate, 1.0))
        .collect();
    // (the chorus mixes its input in: its unit for the blocks before the trap)
    let mut chorus_unit = unit_of(CHORUS, rate, 1.0);
    for block in 0..20 {
        let at = block * BLOCK;
        if block == 10 {
            chain.trap(CHORUS);
        }
        let failed = trapped(&mut chain, &input, at);
        assert_eq!(failed, block == 10);
        if failed {
            assert!(chain.fail());
            chain.resume();
            assert_eq!(chain.take_reports(), 1 << CHORUS);
        } else {
            assert_eq!(chain.take_reports(), 0);
        }
        let piece = [
            input[0][at..at + BLOCK].to_vec(),
            input[1][at..at + BLOCK].to_vec(),
        ];
        let mut sound = through(&mut by_hand[0], &piece);
        if block < 10 {
            sound = through(&mut chorus_unit, &sound);
        }
        sound = through(&mut by_hand[1], &sound);
        same(&output(&mut chain), &sound, "the block");
    }
    // made again: it plays (the trap of the specs is off)
    chain.trap(u32::MAX);
    chain.retry(CHORUS);
    let before = output(&mut chain);
    for block in 20..30 {
        assert!(!trapped(&mut chain, &input, block * BLOCK));
    }
    assert_ne!(bits(&before[0]), bits(&output(&mut chain)[0]));
    assert!(!chain.idle(CHORUS as usize));
}

// the limiter that traps: silence from that block on, a report; made again the sound is back
#[test]
fn the_limiter_that_traps_leaves_silence() {
    let rate = 48000.0;
    let input = signal(10, 40 * BLOCK, 0.3);
    let mut chain = chain_of(rate, &[DISTORTION], 1.0, true);
    for block in 0..10 {
        assert!(!trapped(&mut chain, &input, block * BLOCK));
    }
    assert!(sounds(&output(&mut chain)));
    chain.trap(LIMITER_STAGE);
    assert!(trapped(&mut chain, &input, 10 * BLOCK));
    assert!(chain.fail());
    chain.resume();
    assert_eq!(chain.take_reports(), 1 << LIMITER_STAGE);
    assert!(output(&mut chain)[0].iter().all(|value| *value == 0.0));
    chain.trap(u32::MAX);
    assert!(!trapped(&mut chain, &input, 11 * BLOCK));
    assert!(output(&mut chain)[0].iter().all(|value| *value == 0.0));
    chain.retry(LIMITER_STAGE);
    for block in 12..20 {
        assert!(!trapped(&mut chain, &input, block * BLOCK));
    }
    assert!(sounds(&output(&mut chain)));
    // a trap that is in no stage: nothing to drop
    assert!(!chain.fail());
}

fn route(values: &mut Vec<f64>, target: usize, source: usize, amount: f64, min: f64, max: f64) {
    values.extend_from_slice(&[target as f64, source as f64, amount, min, max, 0.0, 0.0]);
}

fn write(chain: &mut Chain, values: &[f64]) {
    let scratch = chain.scratch(values.len());
    // SAFETY: the scratch reserved for these values
    unsafe { core::slice::from_raw_parts_mut(scratch, values.len()) }.copy_from_slice(values);
}

// a note whose first envelope is a line of `attack` seconds from 0 to 1, then held
fn note(start: f64, attack: f64, velo: f64) -> Vec<f64> {
    let mut values = vec![0.0; NOTE];
    values[0] = start;
    values[1] = f64::NAN;
    values[2] = velo;
    for envelope in 0..3 {
        values[7 + envelope * 8..7 + envelope * 8 + 5].copy_from_slice(&[attack, 0.0, 0.0, 1.0, 0.1]);
    }
    values
}

// a route of an envelope to a knob of a unit: the unit set to the knob moved, once a block, as by hand
#[test]
fn a_route_moves_a_knob_of_a_unit_once_a_block() {
    let rate = 48000.0;
    let input = signal(11, 40 * BLOCK, 0.4);
    let mut chain = chain_of(rate, &[DISTORTION], 1.0, false);
    chain.push(event(CLEAR, 0.0, 0.0, &[]));
    let mut routes = Vec::new();
    let target = DISTORTION as usize * KEYS + distortion::LEVEL;
    route(&mut routes, target, 0, -12.0, -24.0, 12.0);
    write(&mut chain, &routes);
    chain.written(routes.len()).0.set_routes(&routes);
    let attack = 20.0 * BLOCK as f64 / rate;
    let played = note(0.0, attack, 1.0);
    write(&mut chain, &played);
    chain.written(NOTE).0.set_note(true, &played);
    let out = render(&mut chain, &input, |_, _| {});

    let mut unit = Unit::new(DISTORTION, rate, &params()[0], true).unwrap();
    let mut alone = [Vec::new(), Vec::new()];
    let mut last = f64::NAN;
    for block in 0..40 {
        let level = jsmath::min(block as f64 * BLOCK as f64 / rate / attack, 1.0);
        let value = 0.0 + -12.0 * level;
        if value != last {
            last = value;
            let mut values = [0.0; MAX_PARAMS];
            values[distortion::LEVEL] = value;
            unit.set(1 << distortion::LEVEL, &values, true);
        }
        let part = block * BLOCK..(block + 1) * BLOCK;
        let piece = through(
            &mut unit,
            &[input[0][part.clone()].to_vec(), input[1][part].to_vec()],
        );
        alone[0].extend_from_slice(&piece[0]);
        alone[1].extend_from_slice(&piece[1]);
    }
    same(&out, &alone, "the level moved");

    // without its routes the knob is back where it is
    chain.written(0).0.set_routes(&[]);
    let after = render(&mut chain, &input, |_, _| {});
    unit.set(1 << distortion::LEVEL, &[0.0; MAX_PARAMS], true);
    same(&after, &through(&mut unit, &input), "the level back");
}

// an LFO on the mix of a slot: its gains move with it, a line a sample; the knobs of the delay too
#[test]
fn an_lfo_moves_the_lines_of_the_mix_and_of_the_delay() {
    let rate = 48000.0;
    let frames = 200 * BLOCK;
    let input = [vec![0.5f32; frames], vec![0.5f32; frames]];
    let lfos = |chain: &mut Chain| {
        // a sine of 10 Hz on the clock (free), its table the default one
        let mut values = vec![0.0; 4 * LFO_STATE];
        for lfo in 0..4 {
            values[lfo * LFO_STATE..(lfo + 1) * LFO_STATE]
                .copy_from_slice(&[1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.1, 0.0]);
        }
        chain.written(0).0.set_lfos(0.0, true, &values);
    };

    // the mix of the distortion (linear: dry 1 - mix, wet mix) between 0.2 and 0.8
    let mut chain = chain_of(rate, &[DISTORTION], 0.5, false);
    chain.push(event(CLEAR, 0.0, 0.0, &[]));
    lfos(&mut chain);
    let mut routes = Vec::new();
    route(
        &mut routes,
        DISTORTION as usize * KEYS + MIX_KEY,
        LFO_SOURCE,
        0.6,
        0.0,
        1.0,
    );
    routes[6] = 1.0;
    chain.written(0).0.set_routes(&routes);
    let moved = render(&mut chain, &input, |_, _| {});
    let mut plain = chain_of(rate, &[DISTORTION], 0.5, false);
    plain.push(event(CLEAR, 0.0, 0.0, &[]));
    let still = render(&mut plain, &input, |_, _| {});
    let tail = 100 * BLOCK;
    let spread = |data: &[f32]| {
        let (low, high) = data.iter().fold((f32::MAX, f32::MIN), |(low, high), value| {
            (low.min(*value), high.max(*value))
        });
        high - low
    };
    assert!(spread(&still[0][tail..]) < 1e-3);
    assert!(spread(&moved[0][tail..]) > 0.02);
    for i in tail + 1..frames {
        assert!((moved[0][i] - moved[0][i - 1]).abs() < 1e-3, "a step at {i}");
    }

    // the time of the delay: its echoes bend (another sound than the delay left alone), finite
    let clicks = signal(12, frames, 0.3);
    let mut chain = chain_of(rate, &[DELAY], 1.0, false);
    chain.push(event(CLEAR, 0.0, 0.0, &[]));
    lfos(&mut chain);
    let mut routes = Vec::new();
    route(
        &mut routes,
        DELAY as usize * KEYS + delay::TIME,
        LFO_SOURCE + 1,
        0.004,
        0.01,
        1.0,
    );
    route(
        &mut routes,
        DELAY as usize * KEYS + delay::FB,
        LFO_SOURCE,
        0.3,
        0.0,
        0.9,
    );
    route(
        &mut routes,
        DELAY as usize * KEYS + delay::PAN,
        LFO_SOURCE,
        0.01,
        -0.05,
        0.05,
    );
    route(
        &mut routes,
        DELAY as usize * KEYS + delay::FREQ,
        LFO_SOURCE,
        2000.0,
        50.0,
        17000.0,
    );
    chain.written(0).0.set_routes(&routes);
    let moved = render(&mut chain, &clicks, |_, _| {});
    let mut plain = chain_of(rate, &[DELAY], 1.0, false);
    plain.push(event(CLEAR, 0.0, 0.0, &[]));
    let still = render(&mut plain, &clicks, |_, _| {});
    assert!(moved[0].iter().chain(&moved[1]).all(|value| value.is_finite()));
    assert_ne!(bits(&moved[0][tail..]), bits(&still[0][tail..]));
}

// every effect and the limiter at the rates of a render, 192 kHz too: finite, it sounds, under the ceiling
#[test]
fn the_chain_renders_at_the_rates_of_an_export() {
    for &rate in &[22050.0, 44100.0, 48000.0, 88200.0, 96000.0, 176400.0, 192000.0] {
        let input = signal(13, 300 * BLOCK, 0.4);
        let mut chain = chain_of(rate, &[DISTORTION, CHORUS, DELAY, COMPRESSOR, REVERB], 0.5, true);
        let out = render(&mut chain, &input, |_, _| {});
        assert!(
            out[0].iter().chain(&out[1]).all(|value| value.is_finite()),
            "at {rate}"
        );
        assert!(sounds(&out), "at {rate}");
        assert!(out[0].iter().all(|value| value.abs() <= 1.0), "at {rate}");
    }
}
