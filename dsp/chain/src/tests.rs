//! The chain against its units run by hand, bit for bit: a slot is its effect and its mix, the order is the order,
//! a rest is the blocks it skipped; the events, the modulation, a stage that traps

use alloc::{vec, vec::Vec};

use crate::chain::*;
use crate::modulation::{
    Bases, Modulation, KEYS, LFO_SOURCE, LFO_STATE, LFO_TARGET, LINE_EQ, LINE_FB, LINE_PAN, LINE_TIME,
    MACRO_SOURCE, MIX_KEY, NOTE,
};
use crate::units::*;
use crate::{delay, eq, fxfilter};
use dsp_core::lfo::RATE;
use dsp_core::sources::VELO;

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
    all[EQ as usize][..9].copy_from_slice(&[1.0, 300.0, 50.0, 6.0, 2.0, 8000.0, 40.0, 0.0, 0.6]);
    // (Low 12 at 1 kHz, Res 50 %, Drive 20 %, Pan 60: its two channels apart, the level a touch up, all wet)
    all[FXFILTER as usize][..8].copy_from_slice(&[5.0, 1000.0, 50.0, 20.0, 0.0, 60.0, 0.55, 1.0]);
    all
}

// a seeded noise in [-1, 1)
pub(crate) fn noise(seed: u32) -> impl FnMut() -> f32 {
    let mut state = seed;
    move || {
        state = state.wrapping_mul(1664525).wrapping_add(1013904223);
        (state >> 8) as f32 / 8388608.0 - 1.0
    }
}

// blocks of one length
pub(crate) fn blocks_of(length: usize) -> impl FnMut() -> usize {
    move || length
}

// a sine of `level` in both channels at `rate`
pub(crate) fn sine(hz: f64, frames: usize, level: f64, rate: f64) -> [Vec<f32>; 2] {
    let left: Vec<f32> = (0..frames)
        .map(|i| (level * jsmath::sin(2.0 * jsmath::PI * hz * i as f64 / rate)) as f32)
        .collect();
    [left.clone(), left]
}

pub(crate) fn signal(seed: u32, frames: usize, level: f32) -> [Vec<f32>; 2] {
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
    Unit::new(kind, rate, &params).unwrap()
}

pub(crate) fn bits(data: &[f32]) -> Vec<u32> {
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

// after a clear a slot is where its knobs have it at once: all wet, the distortion, the delay, the reverb and the
// EQ are their units from the first block
#[test]
fn a_slot_all_wet_after_a_clear_is_its_unit() {
    let rate = 48000.0;
    let input = signal(2, 30 * BLOCK, 0.4);
    for kind in [DISTORTION, DELAY, REVERB, EQ, FXFILTER] {
        let mut chain = chain_of(rate, &[kind], 1.0, false);
        chain.push(event(CLEAR, 0.0, 0.0, &[]));
        let out = render(&mut chain, &input, |_, _| {});
        let mut unit = Unit::new(kind, rate, &params()[kind as usize]).unwrap();
        let alone = through(&mut unit, &input);
        assert!(sounds(&out));
        // (all wet: no dry signal at all, by equal power too)
        same(&out, &alone, "all wet");
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
    let mut unit = Unit::new(DISTORTION, rate, &params()[0]).unwrap();
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

// a slot whose effect is late (the distortion, 32 samples) crosses from its input as it is to the late one and
// back: no hole and no step as it starts and stops in a sound, a wire again once it is out
#[test]
fn a_late_slot_fades_in_and_out_of_a_sound() {
    let rate = 48000.0;
    let frames = 80 * BLOCK;
    let steady = [vec![0.25f32; frames], vec![0.25f32; frames]];
    // (a sine of 1 kHz: 32 samples are two thirds of its cycle)
    let sine: Vec<f32> = (0..frames)
        .map(|i| (0.25 * jsmath::sin(2.0 * jsmath::PI * 1000.0 * i as f64 / rate)) as f32)
        .collect();
    let most = (0.25 * 2.0 * jsmath::PI * 1000.0 / rate) as f32;
    for (input, step) in [(steady, 0.02), ([sine.clone(), sine], 2.0 * most)] {
        let mut chain = Chain::new(rate, &params(), false);
        chain.push(event(SET_ORDER, 1.0, 0.0, &[DISTORTION as f64]));
        chain.push(event(SET_MIX, DISTORTION as f64, 0.3, &[]));
        let out = render(&mut chain, &input, |chain, at| {
            if at == 10 * BLOCK {
                chain.push(event(SET_ACTIVE, DISTORTION as f64, 1.0, &[]));
            }
            if at == 30 * BLOCK {
                chain.push(event(SET_ACTIVE, DISTORTION as f64, 0.0, &[]));
            }
        });
        assert_eq!(bits(&out[0][..10 * BLOCK]), bits(&input[0][..10 * BLOCK]));
        for i in 1..frames {
            assert!((out[0][i] - out[0][i - 1]).abs() < step, "a step at {i}");
        }
        // (it plays: the dry signal late, the wet one over it)
        assert_ne!(
            bits(&out[0][28 * BLOCK..29 * BLOCK]),
            bits(&input[0][28 * BLOCK..29 * BLOCK])
        );
        assert_eq!(bits(&out[0][70 * BLOCK..]), bits(&input[0][70 * BLOCK..]));
    }
}

// a slot that sounds and leaves the order fades out where it is, then the order is the new one; back in the
// order before it is out, it plays on
#[test]
fn a_slot_that_leaves_the_order_fades_out() {
    let rate = 48000.0;
    let frames = 140 * BLOCK;
    let input = [vec![0.25f32; frames], vec![0.25f32; frames]];
    let steps = |out: &[Vec<f32>; 2]| {
        for i in 1..frames {
            assert!((out[0][i] - out[0][i - 1]).abs() < 0.02, "a step at {i}");
        }
    };
    let mut chain = chain_of(rate, &[COMPRESSOR], 1.0, false);
    chain.push(event(CLEAR, 0.0, 0.0, &[]));
    let out = render(&mut chain, &input, |chain, at| {
        if at == 30 * BLOCK {
            chain.push(event(SET_ORDER, 0.0, 0.0, &[]));
        }
    });
    assert!((out[0][30 * BLOCK - 1] - 0.25).abs() > 0.01);
    steps(&out);
    assert_eq!(bits(&out[0][70 * BLOCK..]), bits(&input[0][70 * BLOCK..]));
    assert!(chain.idle(COMPRESSOR as usize));

    // another slot takes its place once it is out, not before
    let mut chain = chain_of(rate, &[COMPRESSOR], 1.0, false);
    chain.push(event(SET_MIX, DISTORTION as f64, 1.0, &[]));
    chain.push(event(SET_ACTIVE, DISTORTION as f64, 1.0, &[]));
    chain.push(event(CLEAR, 0.0, 0.0, &[]));
    let out = render(&mut chain, &input, |chain, at| {
        if at == 30 * BLOCK {
            chain.push(event(SET_ORDER, 1.0, 0.0, &[DISTORTION as f64]));
        }
    });
    steps(&out);
    // (the distortion plays at the end: not its input)
    assert!((out[0][frames - 1] - 0.25).abs() > 0.01);
    assert!(!chain.idle(DISTORTION as usize) && chain.idle(COMPRESSOR as usize));

    // back in the order two blocks later: it plays on
    let mut chain = chain_of(rate, &[COMPRESSOR], 1.0, false);
    chain.push(event(CLEAR, 0.0, 0.0, &[]));
    let out = render(&mut chain, &input, |chain, at| {
        if at == 30 * BLOCK {
            chain.push(event(SET_ORDER, 0.0, 0.0, &[]));
        }
        if at == 32 * BLOCK {
            chain.push(event(SET_ORDER, 1.0, 0.0, &[COMPRESSOR as f64]));
        }
    });
    steps(&out);
    // (its effect went on all the while: the sound of a slot that never left)
    let mut plain = chain_of(rate, &[COMPRESSOR], 1.0, false);
    plain.push(event(CLEAR, 0.0, 0.0, &[]));
    let alone = render(&mut plain, &input, |_, _| {});
    assert_ne!(
        bits(&out[0][31 * BLOCK..32 * BLOCK]),
        bits(&alone[0][31 * BLOCK..32 * BLOCK])
    );
    assert!((out[0][frames - 1] - alone[0][frames - 1]).abs() < 1e-6);
    assert!((alone[0][frames - 1] - 0.25).abs() > 0.01);
}

// a mute with a time ends its fade that long after its time, however late it is taken
#[test]
fn a_mute_taken_late_ends_in_time() {
    let rate = 48000.0;
    let frames = 20 * BLOCK;
    let input = [vec![0.5f32; frames], vec![0.5f32; frames]];
    let mut chain = Chain::new(rate, &params(), false);
    let out = render(&mut chain, &input, |chain, at| {
        // (its time is 64 samples before the block that takes it: 64 of its 128 samples are left)
        if at == 16 * BLOCK {
            chain.push(Event {
                at: (16 * BLOCK - 64) as f64,
                ..event(MUTE, 128.0 / rate, 0.0, &[])
            });
        }
    });
    assert_eq!(out[0][16 * BLOCK - 1], 0.5);
    assert_eq!(out[0][16 * BLOCK], 0.5);
    assert_eq!(out[0][16 * BLOCK + 32], 0.25);
    assert_eq!(out[0][16 * BLOCK + 64], 0.0);
}

// the blocks a silent chain skips leave what rendering them would have: the LFO of the chorus where it would be,
// the next sound the same
#[test]
fn a_rest_is_the_blocks_it_skipped() {
    let rate = 44100.0;
    let frames = 2500 * BLOCK;
    let mut input = signal(6, frames, 0.4);
    // (a sound, a long silence of +0, a sound again: the reverb at rest after some 2100 blocks)
    for channel in input.iter_mut() {
        channel[20 * BLOCK..2400 * BLOCK].fill(0.0);
    }
    let kinds = [DISTORTION, CHORUS, DELAY, COMPRESSOR, REVERB, EQ, FXFILTER];
    let run = |restless: bool| {
        let mut chain = chain_of(rate, &kinds, 0.5, true);
        chain.restless = restless;
        (render(&mut chain, &input, |_, _| {}), chain.rests)
    };
    let ((rested, rests), (rendered, _)) = (run(false), run(true));
    assert!(rests > 0);
    same(&rested, &rendered, "a rest");
    assert!(sounds(&[
        rested[0][2450 * BLOCK..].to_vec(),
        rested[1][2450 * BLOCK..].to_vec()
    ]));
}

// so with routes: the routes are worked out at rest too (the time and the offsets of the delay through their pole,
// the lines that glide from where they were on a new note, a knob of a unit a macro moves in the silence; a route on
// Time holds the delay awake for the length of its line)
#[test]
fn a_rest_with_routes_is_the_blocks_it_skipped() {
    let rate = 44100.0;
    let frames = 2100 * BLOCK;
    let mut input = signal(14, frames, 0.4);
    for channel in input.iter_mut() {
        channel[20 * BLOCK..2000 * BLOCK].fill(0.0);
    }
    let kinds = [DISTORTION, CHORUS, DELAY, EQ];
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
        DELAY as usize * KEYS + delay::PAN,
        LFO_SOURCE,
        0.01,
        -0.05,
        0.05,
    );
    route(&mut routes, DELAY as usize * KEYS + delay::FB, 0, 0.3, 0.0, 0.9);
    route(
        &mut routes,
        EQ as usize * KEYS + eq::F1,
        LFO_SOURCE,
        1.0,
        20.0,
        20000.0,
    );
    route(
        &mut routes,
        DISTORTION as usize * KEYS + MIX_KEY,
        LFO_SOURCE + 1,
        0.4,
        0.0,
        1.0,
    );
    route(
        &mut routes,
        DISTORTION as usize * KEYS + distortion::LEVEL,
        MACRO_SOURCE + 1,
        -12.0,
        -24.0,
        12.0,
    );
    let run = |restless: bool| {
        let mut chain = chain_of(rate, &kinds, 0.5, true);
        chain.restless = restless;
        // sines of 10 and of 7.7 Hz on the clock (free)
        let mut lfos = vec![0.0; 4 * LFO_STATE];
        for (lfo, period) in [0.1, 0.13, 0.1, 0.1].into_iter().enumerate() {
            lfos[lfo * LFO_STATE..(lfo + 1) * LFO_STATE]
                .copy_from_slice(&[1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, period, 0.0]);
        }
        chain.written(0).0.set_lfos(0.0, true, &lfos);
        chain.written(0).0.set_routes(&routes);
        let first = note(0.0, 0.05, 1.0);
        chain.written(0).0.set_note(true, &first);
        // MACRO 2 to 1 in the silence
        let mut level = event(SET_MACROS, 0.0, 0.0, &[f64::NAN, 1.0, f64::NAN, f64::NAN]);
        level.at = (1700 * BLOCK) as f64;
        chain.push(level);
        let out = render(&mut chain, &input, |chain, at| {
            // (a note with the sound again)
            if at == 1990 * BLOCK {
                let next = note((2000 * BLOCK) as f64 / rate, 0.05, 0.7);
                chain.written(0).0.set_note(true, &next);
            }
        });
        (out, chain.rests)
    };
    let ((rested, rests), (rendered, _)) = (run(false), run(true));
    assert!(rests > 0);
    same(&rested, &rendered, "a rest with routes");
    assert!(sounds(&[
        rested[0][2050 * BLOCK..].to_vec(),
        rested[1][2050 * BLOCK..].to_vec()
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

// an event without a time is never taken before one with a time that came before it: the mute, the clear and
// the unmute of a preset switch that meet no block between them leave the output open
#[test]
fn an_event_without_a_time_follows_the_ones_before_it() {
    let rate = 48000.0;
    let frames = 12 * BLOCK;
    let input = [vec![0.5f32; frames], vec![0.5f32; frames]];
    let mut chain = Chain::new(rate, &params(), false);
    let out = render(&mut chain, &input, |chain, at| {
        if at == 4 * BLOCK {
            chain.push(Event {
                at: at as f64,
                ..event(MUTE, 0.02, 0.0, &[])
            });
            chain.push(event(CLEAR, 0.0, 0.0, &[]));
            chain.push(event(UNMUTE, 0.0, 0.0, &[]));
            chain.push(event(MASTER_GAIN, 0.5, 0.0, &[]));
        }
        // (a time that has passed holds no one back)
        if at == 8 * BLOCK {
            chain.push(event(MASTER_GAIN, 1.0, 0.0, &[]));
        }
    });
    assert_eq!(bits(&out[0][..4 * BLOCK]), bits(&input[0][..4 * BLOCK]));
    assert!(out[0][4 * BLOCK..8 * BLOCK].iter().all(|value| *value == 0.25));
    assert_eq!(bits(&out[0][8 * BLOCK..]), bits(&input[0][8 * BLOCK..]));
}

// the LFO of a chorus goes on in a slot that renders nothing (off, out of the order) as in one at rest: where a
// unit left to rest that long has it
#[test]
fn the_lfo_of_a_chorus_goes_on_in_a_slot_that_is_off() {
    let rate = 48000.0;
    let blocks = 50;
    let input = signal(14, blocks * BLOCK, 0.4);
    let mut unit = unit_of(CHORUS, rate, 0.5);
    for _ in 0..blocks {
        unit.rest(BLOCK);
    }
    let mut rested = [0.0; MAX_METER];
    unit.meter(&mut rested);
    assert_ne!(rested[0], 0.0);

    for order in [&[][..], &[CHORUS as f64][..]] {
        let mut chain = Chain::new(rate, &params(), false);
        chain.push(event(SET_ORDER, order.len() as f64, 0.0, order));
        chain.push(event(SET_MIX, CHORUS as f64, 0.5, &[]));
        let out = render(&mut chain, &input, |_, _| {});
        same(&out, &input, "a slot that is off");
        let mut values = [0.0; MAX_METER];
        assert_eq!(chain.meter(CHORUS as usize, &mut values), 6);
        assert_eq!(values[0].to_bits(), rested[0].to_bits());
    }
}

// the limiter holds the output under its ceiling, late by its lookahead; without it the chain is its slots
#[test]
fn the_limiter_ends_the_chain() {
    let rate = 48000.0;
    let input = signal(7, 60 * BLOCK, 3.0);
    let mut chain = Chain::new(rate, &params(), true);
    let out = render(&mut chain, &input, |_, _| {});
    let mut limiter = Unit::new(LIMITER, rate, &[0.0; MAX_PARAMS]).unwrap();
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
    let mut unit = Unit::new(DISTORTION, rate, &params()[0]).unwrap();
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
    chain.trap(OUTSIDE);
    assert!(trapped(&mut chain, &input, 20 * BLOCK));
    assert!(!chain.fail());
    assert_eq!(chain.take_reports(), 0);
}

// a block whose trap is in a stage is finished without it: whether it trapped
fn finished(chain: &mut Chain, input: &[Vec<f32>; 2], at: usize) -> bool {
    let failed = trapped(chain, input, at);
    if failed {
        assert!(chain.fail());
        chain.resume();
    }
    failed
}

fn from(input: &[Vec<f32>; 2], at: usize) -> [Vec<f32>; 2] {
    [input[0][at..].to_vec(), input[1][at..].to_vec()]
}

// a clear takes the order to come at once: a slot new in it is where its knobs have it from the first block, not
// fading in from a wire once the order is taken
#[test]
fn a_clear_takes_the_order_to_come() {
    let rate = 48000.0;
    let input = signal(21, 40 * BLOCK, 0.4);
    let mut chain = chain_of(rate, &[REVERB], 1.0, false);
    chain.push(event(SET_MIX, DISTORTION as f64, 1.0, &[]));
    chain.push(event(SET_ACTIVE, DISTORTION as f64, 1.0, &[]));
    chain.push(event(CLEAR, 0.0, 0.0, &[]));
    let out = render(&mut chain, &input, |chain, at| {
        if at == 10 * BLOCK {
            // (the reverb sounds: the order waits for it, the clear does not)
            chain.push(event(SET_ORDER, 1.0, 0.0, &[DISTORTION as f64]));
            chain.push(event(CLEAR, 0.0, 0.0, &[]));
        }
    });
    let rest = from(&input, 10 * BLOCK);
    let alone = through(&mut unit_of(DISTORTION, rate, 1.0), &rest);
    assert!(sounds(&alone));
    same(&from(&out, 10 * BLOCK), &alone, "the order after a clear");
}

// a trap in a knob of an effect as an event sets it: the effect is dropped alone, the event and those after it
// reach the others, the block is finished
#[test]
fn an_effect_that_traps_in_a_knob_leaves_the_others_playing() {
    let rate = 48000.0;
    let input = signal(22, 20 * BLOCK, 0.3);
    let mut chain = chain_of(rate, &[DISTORTION, CHORUS, COMPRESSOR], 1.0, false);
    chain.push(event(CLEAR, 0.0, 0.0, &[]));
    let mut distortion_unit = unit_of(DISTORTION, rate, 1.0);
    let mut chorus_unit = unit_of(CHORUS, rate, 1.0);
    let mut compressor_unit = unit_of(COMPRESSOR, rate, 1.0);
    let mut level = [0.0; MAX_PARAMS];
    level[distortion::LEVEL] = -6.0;
    for block in 0..20 {
        let at = block * BLOCK;
        if block == 10 {
            chain.trap_in(CHORUS, IN_SET);
            let mut rate_of = [0.0; MAX_PARAMS];
            rate_of[chorus::RATE] = 2.0;
            chain.push(event(
                SET_PARAMS,
                CHORUS as f64,
                (1 << chorus::RATE) as f64,
                &rate_of,
            ));
            chain.push(event(
                SET_PARAMS,
                DISTORTION as f64,
                (1 << distortion::LEVEL) as f64,
                &level,
            ));
            distortion_unit.set(1 << distortion::LEVEL, &level, false);
        }
        assert_eq!(finished(&mut chain, &input, at), block == 10);
        assert_eq!(chain.take_reports(), if block == 10 { 1 << CHORUS } else { 0 });
        let piece = [
            input[0][at..at + BLOCK].to_vec(),
            input[1][at..at + BLOCK].to_vec(),
        ];
        let mut sound = through(&mut distortion_unit, &piece);
        if block < 10 {
            sound = through(&mut chorus_unit, &sound);
        }
        sound = through(&mut compressor_unit, &sound);
        same(&output(&mut chain), &sound, "the block");
    }
    // made again: it tells so (a stage no one knows: not)
    chain.trap(u32::MAX);
    assert!(chain.retry(CHORUS));
    assert!(chain.retry(CHORUS));
    assert!(!chain.retry(LIMITER_STAGE + 1));
}

// a trap in a knob a route moves: the effect is dropped, its slot a wire from that block on
#[test]
fn an_effect_that_traps_in_a_knob_a_route_moves_is_dropped() {
    let rate = 48000.0;
    let input = signal(23, 20 * BLOCK, 0.3);
    let mut chain = chain_of(rate, &[DISTORTION], 1.0, false);
    chain.push(event(CLEAR, 0.0, 0.0, &[]));
    let mut routes = Vec::new();
    route(
        &mut routes,
        DISTORTION as usize * KEYS + distortion::LEVEL,
        0,
        -12.0,
        -24.0,
        12.0,
    );
    chain.written(0).0.set_routes(&routes);
    // (an envelope that rises all the while: the knob is set every block)
    let played = note(0.0, 1.0, 1.0);
    chain.written(0).0.set_note(true, &played);
    for block in 0..20 {
        let at = block * BLOCK;
        if block == 10 {
            chain.trap_in(DISTORTION, IN_SET);
        }
        assert_eq!(finished(&mut chain, &input, at), block == 10);
        assert_eq!(
            chain.take_reports(),
            if block == 10 { 1 << DISTORTION } else { 0 }
        );
        let piece = [
            input[0][at..at + BLOCK].to_vec(),
            input[1][at..at + BLOCK].to_vec(),
        ];
        if block >= 10 {
            same(&output(&mut chain), &piece, "a wire");
        } else {
            assert_ne!(bits(&output(&mut chain)[0]), bits(&piece[0]));
        }
    }
}

// a trap in the rest of an effect that renders nothing: it is dropped, the slots that play are their units
#[test]
fn an_effect_that_traps_at_rest_leaves_the_others_playing() {
    let rate = 48000.0;
    let input = signal(24, 20 * BLOCK, 0.3);
    let mut chain = chain_of(rate, &[DISTORTION], 1.0, false);
    chain.push(event(CLEAR, 0.0, 0.0, &[]));
    let mut failed = 0;
    let mut out = [Vec::new(), Vec::new()];
    for block in 0..20 {
        if block == 10 {
            chain.trap_in(CHORUS, IN_REST);
        }
        if finished(&mut chain, &input, block * BLOCK) {
            failed += 1;
            assert_eq!(chain.take_reports(), 1 << CHORUS);
        }
        let piece = output(&mut chain);
        out[0].extend_from_slice(&piece[0]);
        out[1].extend_from_slice(&piece[1]);
    }
    assert_eq!(failed, 1);
    let mut values = [0.0; MAX_METER];
    assert_eq!(chain.meter(CHORUS as usize, &mut values), 0);
    same(
        &out,
        &through(&mut unit_of(DISTORTION, rate, 1.0), &input),
        "the distortion",
    );
}

// a trap as a clear forgets the sound of an effect: it is dropped, the clear reaches the others (the distortion is
// its unit from that block on); of the limiter: the master is silent
#[test]
fn an_effect_that_traps_as_it_forgets_is_dropped() {
    let rate = 48000.0;
    let input = signal(25, 30 * BLOCK, 0.3);
    let mut chain = chain_of(rate, &[REVERB, DISTORTION], 1.0, false);
    chain.push(event(CLEAR, 0.0, 0.0, &[]));
    let mut out = [Vec::new(), Vec::new()];
    for block in 0..30 {
        if block == 10 {
            chain.trap_in(REVERB, IN_FORGET);
            chain.push(event(CLEAR, 0.0, 0.0, &[]));
        }
        assert_eq!(finished(&mut chain, &input, block * BLOCK), block == 10);
        assert_eq!(chain.take_reports(), if block == 10 { 1 << REVERB } else { 0 });
        if block >= 10 {
            let piece = output(&mut chain);
            out[0].extend_from_slice(&piece[0]);
            out[1].extend_from_slice(&piece[1]);
        }
    }
    let alone = through(&mut unit_of(DISTORTION, rate, 1.0), &from(&input, 10 * BLOCK));
    same(&out, &alone, "the distortion after the clear");

    let mut chain = chain_of(rate, &[DISTORTION], 1.0, true);
    for block in 0..10 {
        assert!(!trapped(&mut chain, &input, block * BLOCK));
    }
    chain.trap_in(LIMITER_STAGE, IN_FORGET);
    chain.push(event(CLEAR, 0.0, 0.0, &[]));
    assert!(finished(&mut chain, &input, 10 * BLOCK));
    assert_eq!(chain.take_reports(), 1 << LIMITER_STAGE);
    assert!(output(&mut chain)[0].iter().all(|value| *value == 0.0));
    chain.trap(u32::MAX);
    assert!(chain.retry(LIMITER_STAGE));
    for block in 11..20 {
        assert!(!trapped(&mut chain, &input, block * BLOCK));
    }
    assert!(sounds(&output(&mut chain)));
}

// a trap past the stage of an effect is of no stage: the effect before it is not the one dropped
#[test]
fn a_trap_between_two_stages_is_of_neither() {
    let rate = 48000.0;
    let input = signal(26, 20 * BLOCK, 0.3);
    let mut chain = chain_of(rate, &[DISTORTION, COMPRESSOR], 1.0, false);
    for block in 0..10 {
        assert!(!trapped(&mut chain, &input, block * BLOCK));
    }
    chain.trap_in(DISTORTION, AFTER);
    assert!(trapped(&mut chain, &input, 10 * BLOCK));
    assert!(!chain.fail());
    assert_eq!(chain.take_reports(), 0);
}

// a unit made again takes the knobs its routes move anew: not left at the knob until the route changes
#[test]
fn a_unit_made_again_follows_its_routes() {
    let rate = 48000.0;
    let input = signal(14, 60 * BLOCK, 0.2);
    let run = |routed: bool| {
        let mut chain = chain_of(rate, &[DISTORTION], 1.0, false);
        chain.push(event(CLEAR, 0.0, 0.0, &[]));
        if routed {
            // (VELO, held: the same value every block)
            let mut routes = Vec::new();
            route(
                &mut routes,
                DISTORTION as usize * KEYS + distortion::LEVEL,
                3,
                -12.0,
                -24.0,
                12.0,
            );
            chain.written(0).0.set_routes(&routes);
            let played = note(0.0, 0.0, 1.0);
            chain.written(0).0.set_note(true, &played);
        }
        let mut loud = 0.0f32;
        for block in 0..60 {
            if block == 10 {
                chain.trap(DISTORTION);
            }
            if trapped(&mut chain, &input, block * BLOCK) {
                assert!(chain.fail());
                chain.resume();
                chain.trap(u32::MAX);
                chain.retry(DISTORTION);
            }
            if block >= 50 {
                loud = output(&mut chain)[0]
                    .iter()
                    .fold(loud, |loud, value| loud.max(value.abs()));
            }
        }
        loud
    };
    let (moved, still) = (run(true), run(false));
    assert!(still > 0.05);
    // (12 dB down: a quarter)
    assert!(moved < 0.4 * still, "{moved} against {still}");
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

    let mut unit = Unit::new(DISTORTION, rate, &params()[0]).unwrap();
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

// a macro on a knob of a unit, without a note: the event of its level is taken at its frame (the first block at
// it or after it) and the level glides there in 10 ms, the unit set to the knob moved once a block as by hand; a
// level that is not a number leaves its macro
#[test]
fn a_macro_moves_a_knob_of_a_unit_without_a_note_from_the_block_of_its_level_gliding_there() {
    let rate = 48000.0;
    let input = signal(13, 40 * BLOCK, 0.4);
    let mut chain = chain_of(rate, &[DISTORTION], 1.0, false);
    chain.push(event(CLEAR, 0.0, 0.0, &[]));
    let mut routes = Vec::new();
    route(
        &mut routes,
        DISTORTION as usize * KEYS + distortion::LEVEL,
        MACRO_SOURCE + 1,
        -12.0,
        -24.0,
        12.0,
    );
    write(&mut chain, &routes);
    chain.written(routes.len()).0.set_routes(&routes);
    let nan = f64::NAN;
    // MACRO 2 to 1 at frame 1000 (the block at 1024), then MACRO 1 alone (MACRO 2 as it is) at 2000
    let mut level = event(SET_MACROS, 0.0, 0.0, &[nan, 1.0, nan, nan]);
    level.at = 1000.0;
    chain.push(level);
    let mut other = event(SET_MACROS, 0.0, 0.0, &[0.5, nan, nan, nan]);
    other.at = 2000.0;
    chain.push(other);
    let out = render(&mut chain, &input, |_, _| {});

    let mut unit = Unit::new(DISTORTION, rate, &params()[0]).unwrap();
    let mut macro2 = dsp_core::glided::Glided::new(0.0);
    let mut alone = [Vec::new(), Vec::new()];
    let mut last = f64::NAN;
    for block in 0..40 {
        if block == 8 {
            macro2.glide(1.0, dsp_core::glided::glide_length(rate));
        }
        macro2.render(0, BLOCK);
        let level = if macro2.constant {
            macro2.value()
        } else {
            macro2.values[0] as f64
        };
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
    assert_eq!(last, -12.0);
    same(&out, &alone, "the level moved by MACRO 2");
}

// a macro on Rate of an LFO, without a note (its runner free: no point before its first one, tD -inf): the LFO
// at the rate moved, finite (an LFO of 10 Hz an octave up is the one of 20 Hz)
#[test]
fn a_macro_moves_the_rate_of_an_lfo_without_a_note() {
    let rate = 48000.0;
    let frames = 100 * BLOCK;
    let input = [vec![0.5f32; frames], vec![0.5f32; frames]];
    let run = |period: f64, macro_on_rate: bool| {
        let mut chain = chain_of(rate, &[DISTORTION], 0.5, false);
        chain.push(event(CLEAR, 0.0, 0.0, &[]));
        // a sine on the clock (free), its table the default one
        let mut values = vec![0.0; 4 * LFO_STATE];
        for lfo in 0..4 {
            values[lfo * LFO_STATE..(lfo + 1) * LFO_STATE]
                .copy_from_slice(&[1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, period, 0.0]);
        }
        chain.written(0).0.set_lfos(0.0, true, &values);
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
        if macro_on_rate {
            // MACRO 4 on Rate of LFO 1, log: an octave at 1
            route(&mut routes, LFO_TARGET + RATE, MACRO_SOURCE + 3, 1.0, 0.01, 100.0);
            routes[12] = 1.0;
            chain.push(event(SET_MACROS, 1.0, 0.0, &[f64::NAN, f64::NAN, f64::NAN, 1.0]));
        }
        chain.written(0).0.set_routes(&routes);
        render(&mut chain, &input, |_, _| {})
    };
    let moved = run(0.1, true);
    let twice = run(0.05, false);
    let still = run(0.1, false);
    assert!(moved[0].iter().chain(&moved[1]).all(|value| value.is_finite()));
    let worst = (0..frames).fold(0.0f32, |worst, i| worst.max((moved[0][i] - twice[0][i]).abs()));
    assert!(worst < 1e-4, "{worst}");
    assert!((0..frames).any(|i| (moved[0][i] - still[0][i]).abs() > 0.01));
}

// a route of the note on a knob of an LFO (VELO on Rate of LFO 1, log: an octave at 1) moves it while there is a
// note; without one the knob is its own: the bits of the chain without the route (only a macro moves it then)
#[test]
fn a_route_of_the_note_moves_a_knob_of_an_lfo_only_with_a_note() {
    let rate = 48000.0;
    let frames = 100 * BLOCK;
    let input = [vec![0.5f32; frames], vec![0.5f32; frames]];
    let run = |period: f64, noted: bool, velo_on_rate: bool| {
        let mut chain = chain_of(rate, &[DISTORTION], 0.5, false);
        chain.push(event(CLEAR, 0.0, 0.0, &[]));
        // a sine on the clock (free), its table the default one
        let mut values = vec![0.0; 4 * LFO_STATE];
        for lfo in 0..4 {
            values[lfo * LFO_STATE..(lfo + 1) * LFO_STATE]
                .copy_from_slice(&[1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, period, 0.0]);
        }
        chain.written(0).0.set_lfos(0.0, true, &values);
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
        if velo_on_rate {
            route(&mut routes, LFO_TARGET + RATE, VELO, 1.0, 0.01, 100.0);
            routes[12] = 1.0;
        }
        chain.written(0).0.set_routes(&routes);
        if noted {
            chain.written(0).0.set_note(true, &note(0.0, 0.0, 1.0));
        }
        render(&mut chain, &input, |_, _| {})
    };
    let moved = run(0.1, true, true);
    let twice = run(0.05, true, false);
    let still = run(0.1, true, false);
    let worst = (0..frames).fold(0.0f32, |worst, i| worst.max((moved[0][i] - twice[0][i]).abs()));
    assert!(worst < 1e-4, "{worst}");
    assert!((0..frames).any(|i| (moved[0][i] - still[0][i]).abs() > 0.01));
    same(
        &run(0.1, false, true),
        &run(0.1, false, false),
        "no note: the knob its own",
    );
}

// a switch of a unit with lines (the mode of the delay, the types of the bands of the EQ) is no knob a route moves:
// set at every block it would change the mode, or start a fade of the type, again and again; the level of the EQ is
#[test]
fn a_route_moves_no_switch() {
    let mut modulation = Modulation::new(48000.0);
    let mut routes = Vec::new();
    let knobs = [
        (DELAY, delay::MODE),
        (EQ, eq::T1),
        (EQ, eq::T2),
        (FXFILTER, fxfilter::TYPE),
        (EQ, eq::LEVEL),
    ];
    for (slot, key) in knobs {
        route(&mut routes, slot as usize * KEYS + key, 0, 1.0, 0.0, 2.0);
    }
    modulation.set_routes(&routes);
    let moved = knobs.map(|(slot, key)| modulation.moves(slot as usize, key));
    assert_eq!(moved, [false, false, false, false, true]);
}

// the line of the frequency of a band is in octaves: a route of the log scale moves any knob by the same, so a
// jump of the knob leaves it where it is and the band glides to it in octaves (in Hz the offset of the new knob
// came in 10 ms, the knob on its way there in octaves: the band under 0 Hz, at its bottom, ~20 ms)
#[test]
fn a_jump_of_the_frequency_of_a_band_keeps_its_route_in_octaves() {
    let mut modulation = Modulation::new(48000.0);
    modulation.grow(BLOCK);
    let mut routes = Vec::new();
    // the velocity, an octave down
    route(&mut routes, EQ as usize * KEYS + eq::F1, 3, -1.0, 20.0, 20000.0);
    routes[5] = 1.0;
    modulation.set_routes(&routes);
    modulation.set_note(true, &note(0.0, 0.01, 1.0));
    let mut params = params();
    let mix = [1.0; SLOTS];
    let (on, mixes) = ([true; SLOTS], [true; SLOTS]);
    for block in 0..16 {
        params[EQ as usize][eq::F1] = if block < 8 { 100.0 } else { 10000.0 };
        let bases = Bases {
            params: &params,
            mix: &mix,
            on: &on,
            mixes: &mixes,
        };
        modulation.block((block * BLOCK) as f64, BLOCK, &bases, &mut |_, _, _| {});
        // (from the 5th block on: the route came in from 0 in 10 ms)
        if block >= 4 {
            let line = modulation.line(LINE_EQ, BLOCK).unwrap();
            let worst = line
                .iter()
                .map(|value| (value + 1.0).abs())
                .fold(0.0, jsmath::max);
            assert!(worst < 1e-12, "block {block}: {worst}");
        }
    }
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

// the time of the delay and the offsets of its channels follow their routes through the pole of the Audio Unit: a
// step of the target (the velocity of a note that comes) exact at the points, a line between them, no jump; the
// feedback glides in GLIDE as before; a line gone goes down through the pole, no more once within NEAR_SAMPLES of
// a sample of 0
#[test]
fn the_lines_of_the_times_of_the_delay_go_through_its_pole() {
    let rate = 48000.0;
    let tau = delay::TIME_SMOOTHING * rate;
    let mut modulation = Modulation::new(rate);
    modulation.grow(BLOCK);
    let mut routes = Vec::new();
    // the velocity: 10 ms more of the time, 2 ms of the left channel late, 0.3 of the feedback
    route(
        &mut routes,
        DELAY as usize * KEYS + delay::TIME,
        3,
        0.01,
        0.0,
        1.0,
    );
    route(
        &mut routes,
        DELAY as usize * KEYS + delay::PAN,
        3,
        0.002,
        -0.05,
        0.05,
    );
    route(&mut routes, DELAY as usize * KEYS + delay::FB, 3, 0.3, 0.0, 0.9);
    modulation.set_routes(&routes);
    let step = 4 * BLOCK;
    modulation.set_note(true, &note(step as f64 / rate, 0.01, 1.0));
    let params = params();
    let mix = [1.0; SLOTS];
    let (on, mixes) = ([true; SLOTS], [true; SLOTS]);
    let bases = Bases {
        params: &params,
        mix: &mix,
        on: &on,
        mixes: &mixes,
    };
    let lines = [LINE_TIME, LINE_PAN, LINE_FB];
    let mut values: [Vec<f64>; 3] = Default::default();
    let run = |modulation: &mut Modulation, block: usize, values: &mut [Vec<f64>; 3]| {
        modulation.block((block * BLOCK) as f64, BLOCK, &bases, &mut |_, _, _| {});
        for (line, values) in lines.iter().zip(values.iter_mut()) {
            match modulation.line(*line, BLOCK) {
                Some(block) => values.extend_from_slice(block),
                None => values.extend_from_slice(&[0.0; BLOCK]),
            }
        }
        lines.map(|line| modulation.line(line, BLOCK).is_some())
    };
    let held = 40;
    for block in 0..held {
        run(&mut modulation, block, &mut values);
    }
    // (the input a line from 0 over the sample before the step, then the target)
    for (k, target) in [(0, 0.01), (1, 0.002)] {
        let first = dsp_core::blocks::smooth(0.0, 0.0, target, 1.0, tau, None);
        let exact = |n: usize| target - (target - first) * jsmath::exp(-((n - step) as f64) / tau);
        assert!(values[k][..step].iter().all(|value| *value == 0.0));
        let mut steepest = 0.0f64;
        for n in step..held * BLOCK {
            let off = (values[k][n] - exact(n)).abs();
            // (the points: every 32 samples of a block and its last one)
            let point = n % BLOCK == BLOCK - 1 || (n % BLOCK).is_multiple_of(32);
            assert!(
                off < if point { 1e-12 } else { 2e-4 } * target,
                "line {k} at {n}: {off}"
            );
            steepest = jsmath::max(steepest, values[k][n] - values[k][n - 1]);
        }
        assert!(steepest <= 1.001 * target / tau, "line {k}: a step of {steepest}");
    }
    // the feedback: in GLIDE (10 ms) at its target, a line as before
    let glided = step + (0.01 * rate) as usize;
    assert!(values[2][glided..held * BLOCK]
        .iter()
        .all(|value| (value - 0.3).abs() < 1e-12));

    // the routes gone: down through the pole, no step, none once within NEAR_SAMPLES of a sample of 0
    modulation.set_routes(&[]);
    let from = values[0][held * BLOCK - 1];
    let mut block = held;
    while run(&mut modulation, block, &mut values)[0] {
        block += 1;
        assert!(block < held + 1000);
    }
    let gone = (block - held) as f64 * BLOCK as f64;
    let expected = tau * jsmath::log(from * rate / delay::NEAR_SAMPLES);
    assert!((gone - expected).abs() < 2.0 * BLOCK as f64, "{gone} {expected}");
    for n in held * BLOCK + 1..values[0].len() {
        assert!(values[0][n] <= values[0][n - 1] && values[0][n] >= 0.0, "at {n}");
    }
}

// a step of a route on the time (the velocity of a note that comes) bends the echoes, no jump in them: a sine
// through the delay, its largest step between two samples within that of the delay left alone (before the pole a
// jump of the read of 20 ms: up to twice the sine at once)
#[test]
fn a_step_of_a_route_on_the_time_bends_the_echoes_without_a_jump() {
    let rate = 48000.0;
    let frames = 120 * BLOCK;
    let sine: Vec<f32> = (0..frames)
        .map(|i| (0.25 * jsmath::sin(core::f64::consts::TAU * i as f64 / 256.0)) as f32)
        .collect();
    let input = [sine.clone(), sine];
    let step = 60 * BLOCK;
    let render_of = |moved: bool| {
        let mut chain = chain_of(rate, &[DELAY], 1.0, false);
        chain.push(event(CLEAR, 0.0, 0.0, &[]));
        if moved {
            let mut routes = Vec::new();
            route(
                &mut routes,
                DELAY as usize * KEYS + delay::TIME,
                3,
                0.02,
                0.0,
                1.0,
            );
            chain.written(0).0.set_routes(&routes);
            chain
                .written(0)
                .0
                .set_note(true, &note(step as f64 / rate, 0.01, 1.0));
        }
        render(&mut chain, &input, |_, _| {})
    };
    let (moved, still) = (render_of(true), render_of(false));
    let largest = |data: &[f32]| {
        data.windows(2)
            .map(|pair| (pair[1] - pair[0]).abs())
            .fold(0.0f32, f32::max)
    };
    let tail = 20 * BLOCK;
    assert!(largest(&still[0][tail..]) > 0.0);
    assert!(largest(&moved[0][tail..]) <= 1.05 * largest(&still[0][tail..]));
    assert_ne!(bits(&moved[0][step..]), bits(&still[0][step..]));
}

// a slot a route moves the mix of stops (off, or out of the order): the offset of the route goes down with its
// gains, no step; as it starts, late, the offset comes in with them
#[test]
fn a_slot_that_stops_takes_the_lines_of_its_mix_down_with_it() {
    let rate = 48000.0;
    let frames = 80 * BLOCK;
    let input = [vec![0.25f32; frames], vec![0.25f32; frames]];
    for leaves in [false, true] {
        let run = |routed: bool| {
            let mut chain = Chain::new(rate, &params(), false);
            chain.push(event(SET_ORDER, 1.0, 0.0, &[DISTORTION as f64]));
            chain.push(event(SET_MIX, DISTORTION as f64, 0.2, &[]));
            if routed {
                // ENV 1 held at 1: the mix all wet
                let mut routes = Vec::new();
                route(
                    &mut routes,
                    DISTORTION as usize * KEYS + MIX_KEY,
                    0,
                    0.8,
                    0.0,
                    1.0,
                );
                chain.written(0).0.set_routes(&routes);
                let played = note(0.0, BLOCK as f64 / rate, 1.0);
                chain.written(0).0.set_note(true, &played);
            }
            render(&mut chain, &input, |chain, at| {
                if at == 10 * BLOCK {
                    chain.push(event(SET_ACTIVE, DISTORTION as f64, 1.0, &[]));
                }
                if at == 30 * BLOCK {
                    chain.push(if leaves {
                        event(SET_ORDER, 0.0, 0.0, &[])
                    } else {
                        event(SET_ACTIVE, DISTORTION as f64, 0.0, &[])
                    });
                }
            })
        };
        let (moved, still) = (run(true), run(false));
        assert!((moved[0][29 * BLOCK] - still[0][29 * BLOCK]).abs() > 0.01);
        for i in 1..frames {
            assert!((moved[0][i] - moved[0][i - 1]).abs() < 0.002, "a step at {i}");
        }
        assert_eq!(bits(&moved[0][70 * BLOCK..]), bits(&input[0][70 * BLOCK..]));
    }
}

// a slot a route moves the mix of waits out of the order for one that leaves it to fade out: the offset of the
// route comes in with its gains once it is in the order, not before (no step as the order settles)
#[test]
fn a_slot_that_waits_for_the_order_starts_the_lines_of_its_mix_in_it() {
    let rate = 48000.0;
    let frames = 140 * BLOCK;
    let input = [vec![0.25f32; frames], vec![0.25f32; frames]];
    let mut chain = chain_of(rate, &[COMPRESSOR], 1.0, false);
    chain.push(event(SET_MIX, DELAY as f64, 0.2, &[]));
    chain.push(event(CLEAR, 0.0, 0.0, &[]));
    // ENV 1 held at 1: the mix all wet
    let mut routes = Vec::new();
    route(&mut routes, DELAY as usize * KEYS + MIX_KEY, 0, 0.8, 0.0, 1.0);
    chain.written(0).0.set_routes(&routes);
    let played = note(0.0, BLOCK as f64 / rate, 1.0);
    chain.written(0).0.set_note(true, &played);
    // the first block of the new order: the compressor has faded out and is forgotten
    let mut settled = None;
    let out = render(&mut chain, &input, |chain, at| {
        if at == 30 * BLOCK {
            chain.push(event(SET_ORDER, 1.0, 0.0, &[DELAY as f64]));
            chain.push(event(SET_ACTIVE, COMPRESSOR as f64, 0.0, &[]));
            chain.push(event(SET_ACTIVE, DELAY as f64, 1.0, &[]));
        }
        if at > 30 * BLOCK && settled.is_none() && chain.idle(COMPRESSOR as usize) {
            settled = Some(at);
        }
    });
    let settled = settled.unwrap();
    assert!(settled > 32 * BLOCK);
    // (the delay has no echo yet: its slot goes from a wire to no dry signal in 10 ms, the offset with it)
    for i in settled..settled + 3 * BLOCK {
        assert!((out[0][i] - out[0][i - 1]).abs() < 0.002, "a step at {i}");
    }
    assert!((out[0][settled] - 0.25).abs() < 0.002);
    assert!(out[0][settled + 520].abs() < 0.01);
}

// every effect and the limiter at the rates of a render, 192 kHz too: finite, it sounds, under the ceiling
#[test]
fn the_chain_renders_at_the_rates_of_an_export() {
    for &rate in &[22050.0, 44100.0, 48000.0, 88200.0, 96000.0, 176400.0, 192000.0] {
        let input = signal(13, 300 * BLOCK, 0.4);
        let mut chain = chain_of(
            rate,
            &[DISTORTION, CHORUS, DELAY, COMPRESSOR, REVERB, EQ, FXFILTER],
            0.5,
            true,
        );
        let out = render(&mut chain, &input, |_, _| {});
        assert!(
            out[0].iter().chain(&out[1]).all(|value| value.is_finite()),
            "at {rate}"
        );
        assert!(sounds(&out), "at {rate}");
        assert!(out[0].iter().all(|value| value.abs() <= 1.0), "at {rate}");
    }
}
