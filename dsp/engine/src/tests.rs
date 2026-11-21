//! The engine against its halves run by hand, bit for bit: a block of it is the voices, then the chain on their
//! sum; a trap is of the half it was in; a block allocates nothing

use alloc::{vec, vec::Vec};
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::panic::{catch_unwind, AssertUnwindSafe};

use crate::*;
use chain::chain::{Event, IN_PROCESS, LIMITER_STAGE, OUTSIDE, SET_ACTIVE, SET_MIX, SET_ORDER};
use chain::units::{CHORUS, COMPRESSOR, DELAY, DISTORTION, EQ, MAX_PARAMS, REVERB, SLOTS};
use dsp_core::biquad::FilterType;
use wavetable_osc::envelope::EnvelopeParams;
use wavetable_osc::filter::{FilterOptions, Kind};
use wavetable_osc::shared::PARAMS;
use wavetable_osc::store::FRAME_GUARD;
use wavetable_osc::velocity::VoiceVelocity;
use wavetable_osc::voice::{OscOptions, UnisonShape, VoiceOptions};

// the allocator of the tests: on a thread without memory it has none (a block that allocates fails)
struct Allocator;

thread_local! {
    static NO_MEMORY: Cell<bool> = const { Cell::new(false) };
}

unsafe impl GlobalAlloc for Allocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if NO_MEMORY.with(Cell::get) {
            return core::ptr::null_mut();
        }
        System.alloc(layout)
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout);
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        if NO_MEMORY.with(Cell::get) {
            return core::ptr::null_mut();
        }
        System.realloc(ptr, layout, size)
    }
}

#[global_allocator]
static ALLOCATOR: Allocator = Allocator;

const BIG: f32 = 1e9;
const LEN: usize = 512;

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
    all
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

// the scope, its store (table 1: a triangle of one level) and shared, a chain of `kinds` in this order, each on
struct Parts {
    scope: Scope,
    store: Store,
    shared: Shared,
    chain: Chain,
}

fn parts(rate: f64, kinds: &[u32]) -> Parts {
    let mut store = Store::default();
    let level = LEN + FRAME_GUARD;
    let layout = [vec![1, 0], vec![LEN as i32, 1], vec![0, level as i32]];
    let length = level + 1 + FRAME_GUARD;
    let slot = store.begin(1, 1.0, 1, layout, length, 0.0).expect("a slot");
    let data = store.chunk(slot, 0, length).expect("its room");
    for (i, value) in data[..level].iter_mut().enumerate() {
        let x = (i % LEN) as f32 / LEN as f32;
        *value = 1.0 - 4.0 * (x - 0.5).abs();
    }
    assert!(store.commit(slot));
    let mut chain = Chain::new(rate, &params(), true);
    let order: Vec<f64> = kinds.iter().map(|kind| *kind as f64).collect();
    chain.push(event(SET_ORDER, kinds.len() as f64, 0.0, &order));
    for kind in kinds {
        chain.push(event(SET_MIX, *kind as f64, 0.5, &[]));
        chain.push(event(SET_ACTIVE, *kind as f64, 1.0, &[]));
    }
    Parts {
        scope: Scope::new(rate, [(-BIG, BIG); PARAMS]),
        store,
        shared: Shared::default(),
        chain,
    }
}

// a voice of osc 1 on table 1 at `frequency`
fn on(parts: &mut Parts, id: f64, frequency: f64) {
    let flat = EnvelopeParams {
        sustain: 1.0,
        ..EnvelopeParams::default()
    };
    let osc = OscOptions {
        table: 1,
        unison: 3.0,
        phase: 0.0,
        phase_rand: 0.0,
        random: [0.0; 8],
        shape: UnisonShape::default(),
    };
    let options = VoiceOptions {
        osc: [Some(osc), None],
        noise: None,
        sub: None,
        start: 0.0,
        envelopes: vec![flat; 3],
        env_start: 0.0,
        phrase: 0.0,
        routes: Vec::new(),
        // (a filter: the trap of the tests is where a voice finishes its block)
        filter: Some(FilterOptions {
            kind: Kind::Web(Some(FilterType::Lowpass)),
            cutoff: 4000.0,
            resonance: 1.0,
            gain: 0.0,
            drive: 0.0,
            variation: 0.0,
        }),
        velocity: VoiceVelocity::default(),
    };
    let values = [frequency, 1.0, 0.0, 0.0, 0.3, 0.4, 0.5, 0.0, 0.0, 0.0, 1.0, 0.5];
    let Parts {
        scope, store, shared, ..
    } = parts;
    scope.on(id, options, values, false, false, store, shared);
}

fn engine(parts: &mut Parts) -> Engine {
    // SAFETY: the parts outlive the engine of a test, which alone calls them while it renders
    unsafe {
        Engine::new(
            &mut parts.scope,
            &mut parts.store,
            &mut parts.shared,
            &mut parts.chain,
        )
    }
}

fn output(chain: &mut Chain, frames: usize) -> [Vec<f32>; 2] {
    let data = chain.reserve(frames);
    // SAFETY: the block reserved: inL, inR, outL, outR
    let block = unsafe { core::slice::from_raw_parts(data, 4 * frames) };
    [
        block[2 * frames..3 * frames].to_vec(),
        block[3 * frames..].to_vec(),
    ]
}

// `blocks` of `frames` by the engine: the output, the flags of each block
fn by_engine(parts: &mut Parts, frames: usize, blocks: usize) -> ([Vec<f32>; 2], Vec<u32>) {
    let mut engine = engine(parts);
    let (mut out, mut flags) = ([Vec::new(), Vec::new()], Vec::new());
    for block in 0..blocks {
        parts.chain.reserve(frames);
        // SAFETY: the block reserved
        flags.push(unsafe { engine.process((block * frames) as f64) });
        let [left, right] = output(&mut parts.chain, frames);
        out[0].extend(left);
        out[1].extend(right);
    }
    (out, flags)
}

// the same blocks by hand: the scope into its own sum, the sum copied into the chain
fn by_hand(parts: &mut Parts, frames: usize, blocks: usize) -> [Vec<f32>; 2] {
    let mut out = [Vec::new(), Vec::new()];
    for block in 0..blocks {
        let frame = (block * frames) as f64;
        parts
            .scope
            .process(frame, frames, &mut parts.store, &mut parts.shared);
        let data = parts.chain.reserve(frames);
        // SAFETY: the block reserved
        unsafe { core::slice::from_raw_parts_mut(data, 2 * frames) }
            .copy_from_slice(&parts.scope.sum[..2 * frames]);
        parts.chain.process(frame);
        let [left, right] = output(&mut parts.chain, frames);
        out[0].extend(left);
        out[1].extend(right);
    }
    out
}

fn same(a: &[Vec<f32>; 2], b: &[Vec<f32>; 2], what: &str) {
    for channel in 0..2 {
        assert_eq!(a[channel].len(), b[channel].len(), "{what}");
        let first = (0..a[channel].len()).find(|&i| a[channel][i].to_bits() != b[channel][i].to_bits());
        assert_eq!(first, None, "{what}: channel {channel}");
    }
}

fn sounds(out: &[Vec<f32>; 2]) -> bool {
    out[0].iter().any(|value| value.abs() > 1e-4)
}

fn trapped(call: impl FnOnce() -> u32) -> bool {
    catch_unwind(AssertUnwindSafe(call)).is_err()
}

const ALL: [u32; 6] = [DISTORTION, CHORUS, DELAY, COMPRESSOR, REVERB, EQ];

#[test]
fn a_block_is_the_voices_then_the_chain_on_their_sum() {
    for (rate, frames) in [(44100.0, 128), (48000.0, 37), (96000.0, 128), (192000.0, 1000)] {
        let make = || {
            let mut parts = parts(rate, &ALL);
            on(&mut parts, 1.0, 220.0);
            on(&mut parts, 2.0, 331.0);
            parts
        };
        let (out, flags) = by_engine(&mut make(), frames, 40);
        assert!(sounds(&out));
        assert!(flags.iter().all(|flags| *flags == 0));
        same(&out, &by_hand(&mut make(), frames, 40), "the engine");
    }
}

// no voice: the chain is told its input is silent, the tails of its effects sound on as they would
#[test]
fn a_block_without_a_voice_is_the_chain_on_silence() {
    let run = |hand: bool| {
        let mut parts = parts(48000.0, &[DELAY, REVERB]);
        on(&mut parts, 1.0, 220.0);
        let head = if hand {
            by_hand(&mut parts, 128, 8)
        } else {
            by_engine(&mut parts, 128, 8).0
        };
        let Parts {
            scope, store, shared, ..
        } = &mut parts;
        scope.end(store, shared);
        let tail = if hand {
            by_hand(&mut parts, 128, 600)
        } else {
            by_engine(&mut parts, 128, 600).0
        };
        (head, tail)
    };
    let (head, tail) = run(false);
    let (head_by_hand, tail_by_hand) = run(true);
    assert!(sounds(&tail));
    same(&head, &head_by_hand, "the head");
    same(&tail, &tail_by_hand, "the tail");
}

// a voice that ends is told by the flags of its block
#[test]
fn the_flags_tell_what_there_is_to_read() {
    let mut parts = parts(48000.0, &[REVERB]);
    on(&mut parts, 1.0, 220.0);
    let mut engine = engine(&mut parts);
    parts.chain.reserve(128);
    assert_eq!(unsafe { engine.process(0.0) }, 0);
    parts.scope.set_trap(1.0);
    assert!(trapped(|| unsafe { engine.process(128.0) }));
    assert_eq!(unsafe { engine.fail() }, DROPPED);
    assert_eq!(unsafe { engine.resume() }, VOICES);
    assert_eq!(parts.scope.ended, [1.0]);
    parts.scope.ended.clear();
    parts.store.freed_bytes = 8.0;
    assert_eq!(unsafe { engine.process(256.0) }, FREED);
}

// a voice that traps ends alone (the first two are filtered together: it is the third), the others play on through
// the chain
#[test]
fn a_voice_that_traps_leaves_the_others_playing() {
    let mut parts = parts(48000.0, &[CHORUS, REVERB]);
    on(&mut parts, 1.0, 220.0);
    on(&mut parts, 2.0, 331.0);
    on(&mut parts, 3.0, 442.0);
    let mut engine = engine(&mut parts);
    parts.chain.reserve(128);
    unsafe { engine.process(0.0) };
    parts.scope.set_trap(3.0);
    assert!(trapped(|| unsafe { engine.process(128.0) }));
    assert_eq!(unsafe { engine.fail() }, DROPPED);
    assert_eq!(unsafe { engine.resume() }, VOICES);
    assert_eq!(
        (parts.scope.voices(), parts.scope.ended.as_slice()),
        (2, [3.0].as_slice())
    );
    assert!(sounds(&output(&mut parts.chain, 128)));
    assert_eq!(unsafe { engine.process(256.0) }, VOICES);
    assert!(sounds(&output(&mut parts.chain, 128)));
}

// an effect that traps is out of its slot, the voices and the other effects play on; the limiter: silence
#[test]
fn an_effect_that_traps_leaves_the_voices_and_the_others_playing() {
    let mut parts = parts(48000.0, &[CHORUS, REVERB]);
    on(&mut parts, 1.0, 220.0);
    let mut engine = engine(&mut parts);
    parts.chain.reserve(128);
    unsafe { engine.process(0.0) };
    parts.chain.trap_in(CHORUS, IN_PROCESS);
    assert!(trapped(|| unsafe { engine.process(128.0) }));
    assert_eq!(unsafe { engine.fail() }, DROPPED);
    assert_eq!(unsafe { engine.resume() }, STAGES);
    assert_eq!(parts.chain.take_reports(), 1 << CHORUS);
    assert_eq!(parts.scope.voices(), 1);
    assert!(sounds(&output(&mut parts.chain, 128)));
    assert_eq!(unsafe { engine.process(256.0) }, 0);
    assert!(sounds(&output(&mut parts.chain, 128)));

    parts.chain.trap_in(LIMITER_STAGE, IN_PROCESS);
    assert!(trapped(|| unsafe { engine.process(384.0) }));
    assert_eq!(unsafe { engine.fail() }, DROPPED);
    assert_eq!(unsafe { engine.resume() }, STAGES);
    assert!(!sounds(&output(&mut parts.chain, 128)));
    assert_eq!(parts.scope.voices(), 1);
}

// a trap of the chain that is in no stage is the end of the node
#[test]
fn a_trap_of_the_chain_in_no_stage_breaks_the_engine() {
    let mut parts = parts(48000.0, &[REVERB]);
    on(&mut parts, 1.0, 220.0);
    let mut engine = engine(&mut parts);
    parts.chain.reserve(128);
    parts.chain.trap_in(OUTSIDE, IN_PROCESS);
    assert!(trapped(|| unsafe { engine.process(0.0) }));
    assert_eq!(unsafe { engine.fail() }, BROKEN);
}

// a trap of the voices that is in no voice: the block has none of them, the chain renders it, the voices play in
// the next one
#[test]
fn a_trap_of_the_voices_in_no_voice_is_a_block_without_them() {
    let mut parts = parts(48000.0, &[REVERB]);
    on(&mut parts, 1.0, 220.0);
    let mut engine = engine(&mut parts);
    parts.chain.reserve(128);
    unsafe { engine.process(0.0) };
    engine.trap = true;
    assert!(trapped(|| unsafe { engine.process(128.0) }));
    assert_eq!(unsafe { engine.fail() }, SILENCED);
    assert_eq!(unsafe { engine.resume() }, 0);
    assert_eq!(parts.scope.voices(), 1);
    // (the tail of the reverb)
    assert!(sounds(&output(&mut parts.chain, 128)));
    unsafe { engine.process(256.0) };
    assert!(parts.scope.mixed);
}

#[test]
fn nothing_allocates_in_a_block() {
    let mut parts = parts(48000.0, &ALL);
    on(&mut parts, 1.0, 220.0);
    on(&mut parts, 2.0, 331.0);
    let mut engine = engine(&mut parts);
    parts.chain.reserve(128);
    for block in 0..8 {
        unsafe { engine.process(block as f64 * 128.0) };
    }
    NO_MEMORY.with(|no| no.set(true));
    let failed = trapped(|| {
        (8..40)
            .map(|block| unsafe { engine.process(block as f64 * 128.0) })
            .sum()
    });
    NO_MEMORY.with(|no| no.set(false));
    assert!(!failed);
    assert!(sounds(&output(&mut parts.chain, 128)));
}
