// the parts of the core the TS has no reference of: the slots of the store, the refcounts of the versions, the
// pool of the mix tables
use crate::envelope::EnvelopeParams;
use crate::glided::Glided;
use crate::scope::{bend_into, Scope, SET};
use crate::shared::{Shared, PARAMS};
use crate::store::{EntryRef, Store, FRAME_GUARD};
use crate::timeline::{Kind, Timeline};
use crate::velocity::VoiceVelocity;
use crate::voice::{level_x, OscOptions, UnisonShape, Voice, VoiceOptions, LEVEL_BAND};
use alloc::vec;
use alloc::vec::Vec;
use jsmath::{floor, log2, max, min, pow};
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

// the allocator of the tests: on a thread without memory (the memory of the core used up) it has none
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

pub(crate) fn without_memory<T>(call: impl FnOnce() -> T) -> T {
    NO_MEMORY.with(|no| no.set(true));
    let result = call();
    NO_MEMORY.with(|no| no.set(false));
    result
}

fn layout() -> [alloc::vec::Vec<i32>; 3] {
    [vec![1, 0], vec![4, 1], vec![0, 7]]
}

// a version of `length` samples of `value`, every chunk of it come (one)
fn version(store: &mut Store, table: u32, version: f64, length: usize, value: f32) -> u32 {
    let slot = store
        .begin(table, version, 1, layout(), length, 0.0)
        .expect("a slot");
    store.chunk(slot, 0, length).expect("its room").fill(value);
    slot
}

#[test]
fn a_version_stays_until_no_one_holds_it() {
    let mut store = Store::default();
    store.track_freed = true;
    let slot = version(&mut store, 7, 1.0, 8, 0.5);
    assert!(store.commit(slot));
    let first = store.latest(7).expect("the latest version");
    let held = store.acquire(first);
    let slot = version(&mut store, 7, 2.0, 8, 0.0);
    assert!(store.commit(slot));
    // a voice still plays version 1
    assert!(store.freed.is_empty());
    assert_eq!(store.levels(held).data[0], 0.5);
    assert_eq!(store.freed_bytes, 0.0);
    store.release(held);
    assert_eq!(store.freed, vec![(7, 1.0)]);
    // (its bytes counted, for a version refused before)
    assert_eq!(store.freed_bytes, 32.0);
    // a stale version is freed at once, the latest plays on
    let slot = version(&mut store, 7, 1.5, 8, 0.0);
    assert!(store.commit(slot));
    assert_eq!(store.freed, vec![(7, 1.0), (7, 1.5)]);
    assert_ne!(store.latest(7), Some(first));
    store.remove(7);
    assert_eq!(store.latest(7), None);
    assert_eq!(store.freed.len(), 3);
}

#[test]
fn a_version_has_a_serial_no_other_ever_has() {
    // (the cycle a warped mix was built of is kept by it: a version in the slot and the buffer of one freed is
    // another table)
    let mut store = Store::default();
    let slot = version(&mut store, 1, 1.0, 8, 0.5);
    assert!(store.commit(slot));
    let first = store.latest(1).expect("the latest version");
    let (serial, data) = (store.serial(first), store.levels(first).data.as_ptr());
    assert_ne!(serial, store.serial(EntryRef::Sine));
    store.remove(1);
    let slot = version(&mut store, 1, 1.0, 8, 0.25);
    assert!(store.commit(slot));
    let second = store.latest(1).expect("the latest version");
    assert_eq!((second, store.levels(second).data.as_ptr()), (first, data));
    assert_ne!(store.serial(second), serial);
}

#[test]
fn a_freed_buffer_is_reused_by_a_table_it_holds() {
    let mut store = Store::default();
    let slot = store.begin(1, 1.0, 1, layout(), 8, 0.0).expect("a slot");
    let first = store.chunk(slot, 0, 8).expect("its room").as_ptr();
    assert!(store.commit(slot));
    store.remove(1);
    // a shorter table takes it too
    let slot = store.begin(2, 1.0, 1, layout(), 6, 0.0).expect("a slot");
    assert_eq!(store.chunk(slot, 0, 6).expect("its room").as_ptr(), first);
    // a slot never committed is not a version
    assert_eq!(store.latest(2), None);
    assert_eq!(store.latest(1), None);
    assert!(store.latest(3).is_none());
    let _ = EntryRef::Sine;
}

#[test]
fn the_smallest_buffer_that_holds_a_table_is_taken_the_others_wait() {
    let mut store = Store::default();
    let (a, b) = (
        version(&mut store, 1, 1.0, 100, 0.0),
        version(&mut store, 2, 1.0, 10, 0.0),
    );
    assert!(store.commit(a) && store.commit(b));
    let small = store.levels(store.latest(2).expect("a version")).data.as_ptr();
    store.remove(1);
    store.remove(2);
    let slot = store.begin(3, 1.0, 1, layout(), 8, 0.0).expect("a slot");
    assert_eq!(store.chunk(slot, 0, 8).expect("its room").as_ptr(), small);
    // the large one is still in the pool
    let large = store.begin(4, 1.0, 1, layout(), 90, 0.0).expect("a slot");
    assert!(store.chunk(large, 0, 90).is_some());
}

#[test]
fn the_chunks_come_in_order_within_the_length_of_the_version() {
    let mut store = Store::default();
    let slot = store.begin(1, 1.0, 1, layout(), 10, 0.0).expect("a slot");
    // not the next one: before it, after it, past the length
    assert!(store.chunk(slot, 4, 4).is_none());
    assert!(store.chunk(slot, 0, 11).is_none());
    store.chunk(slot, 0, 4).expect("the first").fill(1.0);
    assert!(store.chunk(slot, 0, 4).is_none());
    assert!(store.chunk(slot, 5, 4).is_none());
    assert!(store.chunk(slot, 4, 7).is_none());
    // only the chunk is zeroed, then written
    let second = store.chunk(slot, 4, 4).expect("the second");
    assert_eq!(second, &[0.0; 4]);
    second.fill(2.0);
    // a version a chunk of which is missing is refused, its slot aborted
    assert!(!store.commit(slot));
    assert_eq!(store.latest(1), None);
    assert!(store.chunk(slot, 8, 2).is_none());
    let slot = store.begin(1, 2.0, 1, layout(), 10, 0.0).expect("a slot");
    store.chunk(slot, 0, 6).expect("the first").fill(1.0);
    store.chunk(slot, 6, 4).expect("the last").fill(3.0);
    assert!(store.commit(slot));
    let latest = store.latest(1).expect("a version");
    assert_eq!(
        store.levels(latest).data[..],
        [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 3.0, 3.0, 3.0, 3.0]
    );
}

#[test]
fn the_mix_tables_are_pooled_by_length() {
    let mut shared = Shared::default();
    let mix = shared.acquire_mix(4096).expect("a mix");
    assert_eq!(mix.len(), 4096 + 3);
    let at = mix.as_ptr();
    shared.release_mix(mix);
    let again = shared.acquire_mix(4096).expect("a mix");
    assert_eq!(again.as_ptr(), at);
    let other = shared.acquire_mix(4096).expect("a mix");
    assert_ne!(other.as_ptr(), at);
}

#[test]
fn a_mix_without_memory_is_none() {
    // (more than the address space: try_reserve fails as it does without memory)
    let mut shared = Shared::default();
    assert!(shared.acquire_mix(usize::MAX / 4).is_none());
    assert!(shared.acquire_mix(usize::MAX).is_none());
    assert!(shared.acquire_mix(16).is_some());
}

#[test]
fn an_aborted_slot_gives_its_buffer_back() {
    let mut store = Store::default();
    let slot = store.begin(1, 1.0, 1, layout(), 8, 0.0).expect("a slot");
    let first = store.chunk(slot, 0, 4).expect("its room").as_ptr();
    store.abort(slot);
    assert!(store.chunk(slot, 4, 4).is_none());
    assert!(!store.commit(slot));
    assert_eq!(store.latest(1), None);
    // its buffer goes to a table of its size, its slot to the next version
    let again = store.begin(2, 1.0, 1, layout(), 8, 0.0).expect("a slot");
    assert_eq!(again, slot);
    assert_eq!(store.chunk(again, 0, 8).expect("its room").as_ptr(), first);
    // every slot of a worker that stopped
    let other = store.begin(3, 1.0, 1, layout(), 8, 0.0).expect("a slot");
    store.abort_all();
    assert!(store.chunk(again, 8, 0).is_none() && store.chunk(other, 0, 8).is_none());
}

#[test]
fn a_version_of_a_table_still_coming_is_aborted_by_the_next() {
    let mut store = Store::default();
    let slot = store.begin(1, 1.0, 1, layout(), 8, 0.0).expect("a slot");
    let next = version(&mut store, 1, 2.0, 8, 0.0);
    // (its slot taken again by the next one)
    assert_eq!(next, slot);
    assert!(store.commit(next));
    assert_eq!(store.stats()[0], 1.0);
    assert!(store.latest(1).is_some());
    // another table keeps its slot
    let a = store.begin(2, 1.0, 1, layout(), 8, 0.0).expect("a slot");
    let b = store.begin(3, 1.0, 1, layout(), 8, 0.0).expect("a slot");
    assert!(store.chunk(a, 0, 8).is_some() && store.chunk(b, 0, 8).is_some());
}

#[test]
fn the_budget_lets_the_first_build_of_a_block_through() {
    let mut shared = Shared::default();
    assert!(shared.take_build(0.0, 500000.0));
    assert!(!shared.take_build(0.0, 1.0));
    assert!(shared.take_build(128.0, 300000.0));
    assert!(shared.take_build(128.0, 60000.0));
    assert!(!shared.take_build(128.0, 1.0));
}

// --- the timeline of a param: the values an AudioParam has by the formulas of the spec, in f32 ---

const RATE: f64 = 48000.0;
const BIG: f32 = f32::MAX;

fn timeline(value: f64) -> Timeline {
    Timeline::new(RATE, value, -BIG, BIG)
}

// the values of a block of `n` frames at `frame` (one: the block doesn't change)
fn block(timeline: &mut Timeline, frame: f64, n: usize) -> Vec<f32> {
    let mut out = vec![0.0; n];
    let count = timeline.render(frame, &mut out);
    out.truncate(count);
    out
}

#[test]
fn a_param_without_events_is_one_value_its_initial_one_in_f32() {
    let mut param = timeline(0.1);
    assert_eq!(block(&mut param, 0.0, 128), [0.1f32]);
    assert_eq!(block(&mut param, 128.0, 128), [0.1f32]);
    assert!(param.is_empty());
}

#[test]
fn a_set_acts_from_the_first_frame_not_before_its_time() {
    let mut param = timeline(1.0);
    // between frames 140 and 141: from 141
    param.insert(Kind::Set, 140.5 / RATE, 2.5, 0.0);
    let values = block(&mut param, 128.0, 128);
    assert_eq!(values.len(), 128);
    assert!(values[..13].iter().all(|v| *v == 1.0));
    assert!(values[13..].iter().all(|v| *v == 2.5));
    // on a frame: from it
    param.insert(Kind::Set, 300.0 / RATE, 3.0, 0.0);
    let values = block(&mut param, 256.0, 128);
    assert_eq!(values[43], 2.5);
    assert_eq!(values[44], 3.0);
    // after it: one value
    assert_eq!(block(&mut param, 384.0, 128), [3.0]);
}

#[test]
fn an_event_in_the_past_acts_from_the_block_it_is_seen_in() {
    let mut param = timeline(1.0);
    assert_eq!(block(&mut param, 0.0, 128), [1.0]);
    param.insert(Kind::Set, 10.0 / RATE, 0.25, 0.0);
    assert_eq!(block(&mut param, 128.0, 128), [0.25]);
    // a value of the event in f32, as an AudioParam keeps it
    param.insert(Kind::Set, 20.0 / RATE, 2.1, 0.0);
    assert_eq!(block(&mut param, 256.0, 128), [2.1f32]);
}

#[test]
fn a_target_follows_the_formula_of_the_spec_from_the_value_before_it() {
    let mut param = timeline(0.2);
    let (time, constant) = (100.0 / RATE, 0.0033);
    param.insert(Kind::Target, time, 0.8, constant);
    let values = block(&mut param, 0.0, 128);
    for (i, value) in values.iter().enumerate() {
        let t = i as f64 / RATE;
        let expected = if t < time {
            0.2f32 as f64
        } else {
            0.8f32 as f64 + (0.2f32 as f64 - 0.8f32 as f64) * jsmath::exp(-(t - time) / constant)
        };
        assert_eq!(*value, expected as f32, "frame {i}");
    }
    // a second target starts where the first one is at its time
    let second = 200.0 / RATE;
    param.insert(Kind::Target, second, 0.0, constant);
    let from = (0.8f32 as f64 + (0.2f32 as f64 - 0.8f32 as f64) * jsmath::exp(-(second - time) / constant))
        as f32 as f64;
    let values = block(&mut param, 128.0, 128);
    let t = 250.0 / RATE;
    assert_eq!(values[122], (from * jsmath::exp(-(t - second) / constant)) as f32);
    // a set after it holds its value: one value again
    param.insert(Kind::Set, 300.0 / RATE, 0.0, 0.0);
    assert_eq!(block(&mut param, 384.0, 128), [0.0]);
}

#[test]
fn an_exponential_ramp_runs_from_the_event_before_it() {
    let mut param = timeline(440.0);
    let (t0, t1) = (64.0 / RATE, 1000.0 / RATE);
    param.insert(Kind::Set, t0, 220.0, 0.0);
    param.insert(Kind::Ramp, t1, 880.0, 0.0);
    let mut values = Vec::new();
    for b in 0..8 {
        values.extend(block(&mut param, b as f64 * 128.0, 128));
    }
    assert_eq!(values.len(), 1024);
    assert_eq!(values[63], 440.0);
    for f in 64..1000 {
        let t = f as f64 / RATE;
        let expected = 220.0 * jsmath::pow(880.0 / 220.0, (t - t0) / (t1 - t0));
        assert_eq!(values[f], expected as f32, "frame {f}");
    }
    assert_eq!(values[1000], 880.0);
    assert_eq!(block(&mut param, 1024.0, 128), [880.0]);
}

#[test]
fn a_linear_ramp_runs_from_the_event_before_it() {
    let mut param = timeline(0.0);
    let (t0, t1) = (10.0 / RATE, 100.0 / RATE);
    param.insert(Kind::Set, t0, 0.25, 0.0);
    param.insert(Kind::Linear, t1, 0.75, 0.0);
    let values = block(&mut param, 0.0, 128);
    assert_eq!(values[9], 0.0);
    for f in 10..100 {
        let t = f as f64 / RATE;
        assert_eq!(
            values[f],
            (0.25 + (0.75 - 0.25) * ((t - t0) / (t1 - t0))) as f32,
            "frame {f}"
        );
    }
    assert_eq!(values[100], 0.75);
    assert_eq!(block(&mut param, 128.0, 128), [0.75]);
}

#[test]
fn a_ramp_from_zero_or_across_zero_holds_the_value_before_it() {
    let mut param = timeline(0.0);
    param.insert(Kind::Ramp, 100.0 / RATE, 1.0, 0.0);
    param.insert(Kind::Set, 0.0, 0.0, 0.0);
    let values = block(&mut param, 0.0, 128);
    assert!(values[..100].iter().all(|v| *v == 0.0));
    assert!(values[100..].iter().all(|v| *v == 1.0));
}

#[test]
fn a_cancel_drops_the_events_at_its_time_and_after_it() {
    let mut param = timeline(1.0);
    param.insert(Kind::Set, 10.0 / RATE, 2.0, 0.0);
    param.insert(Kind::Set, 50.0 / RATE, 3.0, 0.0);
    param.insert(Kind::Ramp, 90.0 / RATE, 6.0, 0.0);
    param.cancel(50.0 / RATE);
    assert_eq!(param.len(), 1);
    let values = block(&mut param, 0.0, 128);
    assert_eq!((values[9], values[10], values[127]), (1.0, 2.0, 2.0));
}

#[test]
fn an_event_of_the_same_kind_at_the_same_time_replaces_it() {
    let mut param = timeline(1.0);
    param.insert(Kind::Set, 10.0 / RATE, 1.5, 0.0);
    param.insert(Kind::Set, 10.0 / RATE, 1.0, 0.0);
    // another kind at that time comes after it
    param.insert(Kind::Target, 10.0 / RATE, 0.0, 0.01);
    assert_eq!(param.len(), 2);
    let values = block(&mut param, 0.0, 128);
    assert_eq!(values[9], 1.0);
    assert_eq!(values[10], 1.0);
    assert!(values[11] < 1.0);
}

#[test]
fn the_values_are_clamped_to_the_range_of_the_param() {
    let mut param = Timeline::new(RATE, 1.5, 0.0, 1.0);
    assert_eq!(block(&mut param, 0.0, 128), [1.0]);
    param.insert(Kind::Set, 0.0, -0.5, 0.0);
    assert_eq!(block(&mut param, 128.0, 128), [0.0]);
}

#[test]
fn the_events_of_long_ago_are_forgotten_their_value_kept() {
    let mut param = timeline(1.0);
    param.insert(Kind::Set, 0.01, 2.0, 0.0);
    param.insert(Kind::Target, 0.02, 4.0, 0.001);
    param.insert(Kind::Set, 0.1, 4.0, 0.0);
    let mut frame = 0.0;
    while frame < RATE {
        block(&mut param, frame, 128);
        frame += 128.0;
    }
    // the last one is kept, the value before it is the base
    assert_eq!(param.len(), 1);
    assert_eq!(block(&mut param, frame, 128), [4.0]);
    // a cancel of every event: the value before the last
    param.cancel(0.0);
    let held = block(&mut param, frame + 128.0, 128);
    assert_eq!(held.len(), 1);
    assert!((held[0] - 4.0).abs() < 1e-3);
}

// --- the voices of a node ---

// a note with no oscillator on, its envelopes flat
fn note() -> VoiceOptions {
    let flat = EnvelopeParams {
        sustain: 1.0,
        ..EnvelopeParams::default()
    };
    VoiceOptions {
        osc: [None, None],
        noise: None,
        sub: None,
        start: 0.0,
        envelopes: vec![flat; 3],
        env_start: 0.0,
        phrase: 0.0,
        routes: Vec::new(),
        filter: None,
        velocity: VoiceVelocity::default(),
    }
}

#[test]
fn an_event_without_memory_ends_its_voice_the_others_take_theirs() {
    let (mut store, mut shared) = (Store::default(), Shared::default());
    let mut scope = Scope::new(RATE, [(-BIG, BIG); PARAMS]);
    for id in [1.0, 2.0] {
        scope.on(id, note(), [0.0; PARAMS], false, false, &mut store, &mut shared);
    }
    scope.event(SET, 1.0, 0, 100.0, 0.0, 0.0, &mut store, &mut shared);
    // in place of one of its kind at its time: no memory needed
    without_memory(|| scope.event(SET, 1.0, 0, 200.0, 0.0, 0.0, &mut store, &mut shared));
    assert_eq!((scope.voices(), scope.events()), (2, 1));
    // the release of voice 1 finds none: it ends, told ended
    without_memory(|| scope.event(SET, 1.0, 1, 0.0, 0.1, 0.0, &mut store, &mut shared));
    assert_eq!((scope.voices(), scope.ended.as_slice()), (1, [1.0].as_slice()));
    scope.event(SET, 2.0, 1, 0.0, 0.1, 0.0, &mut store, &mut shared);
    assert_eq!(scope.events(), 1);
    scope.end(&mut store, &mut shared);
}

// the voices that wait for the next one: a pair, more while every one is wide (Ladder 12 from Res 40 % on) in one
// layout; a wide pair that waits finishes alone before one that is not, which waits for the next one in turn (not a
// group of three whose last runs alone); wide ones before one wide in another layout too, which waits with its own
#[test]
fn a_voice_that_is_not_wide_after_a_wide_pair_waits_for_the_next_one() {
    use crate::filter::{FilterOptions, Kind as FilterKind};
    use dsp_core::filter_model::ModelType;
    let (mut store, mut shared) = (Store::default(), Shared::default());
    let mut scope = Scope::new(RATE, [(-BIG, BIG); PARAMS]);
    let filtered = |(ty, resonance): (ModelType, f64)| VoiceOptions {
        filter: Some(FilterOptions {
            kind: FilterKind::Model(ty),
            cutoff: 1000.0,
            resonance,
            gain: 0.0,
            drive: 0.0,
            variation: 0.0,
        }),
        ..note()
    };
    let play =
        |scope: &mut Scope, store: &mut Store, shared: &mut Shared, resonances: &[(ModelType, f64)]| {
            // (the gate held)
            let mut held = [0.0; PARAMS];
            held[1] = 1.0;
            for (k, &resonance) in resonances.iter().enumerate() {
                scope.on(
                    k as f64 + 1.0,
                    filtered(resonance),
                    held,
                    false,
                    false,
                    store,
                    shared,
                );
            }
            scope.finished.clear();
            scope.process(0.0, 128, store, shared);
            let finished = core::mem::take(&mut scope.finished);
            scope.end(store, shared);
            finished
        };
    let ladders = |resonances: &[f64]| -> Vec<(ModelType, f64)> {
        resonances.iter().map(|&res| (ModelType::Ladder12, res)).collect()
    };
    // (wide, wide, plain, plain, wide, wide)
    let pattern = ladders(&[80.0, 80.0, 20.0, 20.0, 80.0, 80.0]);
    assert_eq!(play(&mut scope, &mut store, &mut shared, &pattern), [2, 2, 2]);
    let wide = ladders(&[80.0; 6]);
    assert_eq!(play(&mut scope, &mut store, &mut shared, &wide), [4, 2]);
    let plain = ladders(&[20.0, 20.0, 20.0]);
    assert_eq!(play(&mut scope, &mut store, &mut shared, &plain), [2, 1]);
    // wide in two layouts (Ladder 12, Low 12): a group of each, never one of both (its pairs would each run alone)
    let (ladder, low) = ((ModelType::Ladder12, 80.0), (ModelType::Low12, 80.0));
    let two = [ladder, ladder, ladder, low, low];
    assert_eq!(play(&mut scope, &mut store, &mut shared, &two), [3, 2]);
    let pairs = [ladder, ladder, low, low];
    assert_eq!(play(&mut scope, &mut store, &mut shared, &pairs), [2, 2]);
    let turns = [ladder, low, low, ladder, ladder];
    assert_eq!(play(&mut scope, &mut store, &mut shared, &turns), [1, 2, 2]);
}

#[test]
fn a_voice_of_mono_lives_on_release_lead_after_its_release_a_note_meanwhile_takes_it_over() {
    let (mut store, mut shared) = (Store::default(), Shared::default());
    let mut scope = Scope::new(RATE, [(-BIG, BIG); PARAMS]);
    // ENV 1 released over 10 ms, the gate held at the note on
    let released = EnvelopeParams {
        sustain: 1.0,
        release: 0.01,
        ..EnvelopeParams::default()
    };
    let options = || VoiceOptions {
        envelopes: vec![released; 3],
        ..note()
    };
    let mut held = [0.0; PARAMS];
    held[1] = 1.0;
    // 1 of Poly, 2–4 of mono (they linger)
    for (id, linger) in [(1.0, false), (2.0, true), (3.0, true), (4.0, true)] {
        scope.on(id, options(), held, false, linger, &mut store, &mut shared);
    }
    // released at 0.01 s (frame 480), held 0.01 s: their releases end at frame 960
    for id in [1.0, 2.0, 3.0] {
        scope.event(SET, id, 1, 2.01, 0.01, 0.0, &mut store, &mut shared);
    }
    // 4 stolen there: its fade (20 ms) ends it
    scope.event(SET, 4.0, 1, -1.0, 0.01, 0.0, &mut store, &mut shared);
    // a note takes 3 over at 0.05 s (frame 2400): after the end of its release, within RELEASE_LEAD of it
    scope.event(SET, 3.0, 1, 1.5, 0.05, 0.0, &mut store, &mut shared);
    let mut ends = Vec::new();
    let mut frame = 0.0;
    while frame < 0.2 * RATE {
        scope.process(frame, 128, &mut store, &mut shared);
        ends.extend(scope.ended.drain(..).map(|id| (id, frame)));
        frame += 128.0;
    }
    // each in the block of its end: 1 at its release's (960), 4 at its fade's (480 + 960), 2 RELEASE_LEAD (2400
    // frames) after its release's (3360); 3 plays on
    assert_eq!(ends, [(1.0, 896.0), (4.0, 1408.0), (2.0, 3328.0)]);
    assert_eq!(scope.voices(), 1);
    scope.end(&mut store, &mut shared);
}

#[test]
fn a_stolen_voice_fades_out_over_the_share_of_kill_fade_its_gate_asks_for() {
    let (mut store, mut shared) = (Store::default(), Shared::default());
    let mut scope = Scope::new(RATE, [(-BIG, BIG); PARAMS]);
    let mut held = [0.0; PARAMS];
    held[1] = 1.0;
    for id in [1.0, 2.0, 3.0, 4.0, 5.0] {
        scope.on(id, note(), held, false, false, &mut store, &mut shared);
    }
    // stolen at 0.01 s (frame 480): -1 and under over all of KILL_FADE (960 frames), -0.25 over a quarter (240),
    // -0.05 over a twentieth (48), next to 0 over a frame at least
    for (id, gate) in [(1.0, -1.0), (2.0, -3.0), (3.0, -0.25), (4.0, -0.05), (5.0, -1e-6)] {
        scope.event(SET, id, 1, gate, 0.01, 0.0, &mut store, &mut shared);
    }
    let mut ends = Vec::new();
    let mut frame = 0.0;
    while frame < 0.05 * RATE {
        scope.process(frame, 128, &mut store, &mut shared);
        ends.extend(scope.ended.drain(..).map(|id| (id, frame)));
        frame += 128.0;
    }
    // each in the block of the end of its fade: 481 (the block from 384), 528 (512), 720 (640), 1440 (1408)
    assert_eq!(
        ends,
        [
            (5.0, 384.0),
            (4.0, 512.0),
            (3.0, 640.0),
            (1.0, 1408.0),
            (2.0, 1408.0)
        ]
    );
    scope.end(&mut store, &mut shared);
}

#[test]
fn the_bend_of_the_node_is_on_top_of_a_detune_one_value_while_both_are() {
    let mut bend = Glided::new(0.0);
    bend.glide(100.0, 4.0);
    bend.render(0, 4);
    // gliding: one a sample, from one value of the detune or its own
    let mut one = [1200.0, 0.0, 0.0, 0.0];
    assert_eq!(bend_into(&bend, &mut one, 1), 4);
    assert_eq!(one, [1200.0, 1225.0, 1250.0, 1275.0]);
    let mut each = [0.0, 10.0, 20.0, 30.0];
    assert_eq!(bend_into(&bend, &mut each, 4), 4);
    assert_eq!(each, [0.0, 35.0, 70.0, 105.0]);
    // there: one value stays one
    bend.render(0, 4);
    let mut steady = [-1200.0, 0.0, 0.0, 0.0];
    assert_eq!(bend_into(&bend, &mut steady, 1), 1);
    assert_eq!(steady[0], -1100.0);
}

// --- the frames of a moving position (dsp/measurements/frame-fades.json) ---

// samples of a frame of the tables of constant frames
const LEN: usize = 512;

// a version of table 1 of constant frames: frame j is `values[j]` at every sample (and its guards), so a voice on
// it plays (1 - m) · the frame it comes from + m · the one it goes to (one level below 9.5 kHz, the silent one
// above)
fn constant_frames(store: &mut Store, version: f64, values: &[f32]) {
    let n = values.len();
    let level = n * (LEN + FRAME_GUARD);
    let layout = [vec![1, 0], vec![LEN as i32, 1], vec![0, level as i32]];
    let length = level + n * (1 + FRAME_GUARD);
    let slot = store
        .begin(1, version, n as i32, layout, length, 0.0)
        .expect("a slot");
    let data = store.chunk(slot, 0, length).expect("its room");
    for (j, value) in values.iter().enumerate() {
        data[j * (LEN + FRAME_GUARD)..(j + 1) * (LEN + FRAME_GUARD)].fill(*value);
    }
    assert!(store.commit(slot));
}

// a version of table 1 of `n` silent frames (no harmonics)
fn silent_frames(store: &mut Store, version: f64, n: usize) {
    let length = n * (1 + FRAME_GUARD);
    let slot = store
        .begin(1, version, n as i32, [vec![0], vec![1], vec![0]], length, 0.0)
        .expect("a slot");
    store.chunk(slot, 0, length).expect("its room").fill(0.0);
    assert!(store.commit(slot));
}

// a version of table 1 of two levels of `lengths` (and the silent one) of constant frames: frame j of level l is
// `values[l][j]` at every sample, so a voice between them at the share w of the second plays (1 - w) · its frame on
// the first + w · on the second (255 harmonics on the first: x = 1 + 3·log2(256 · f / nyquist))
fn two_level_frames(store: &mut Store, lengths: [usize; 2], values: [&[f32]; 2]) {
    let n = values[0].len();
    let sizes = lengths.map(|length| n * (length + FRAME_GUARD));
    let offsets = vec![0, sizes[0] as i32, (sizes[0] + sizes[1]) as i32];
    let layout = [
        vec![255, 127, 0],
        vec![lengths[0] as i32, lengths[1] as i32, 1],
        offsets.clone(),
    ];
    let length = sizes[0] + sizes[1] + n * (1 + FRAME_GUARD);
    let slot = store
        .begin(1, 1.0, n as i32, layout, length, 0.0)
        .expect("a slot");
    let data = store.chunk(slot, 0, length).expect("its room");
    for (l, level) in values.iter().enumerate() {
        let size = lengths[l] + FRAME_GUARD;
        for (j, value) in level.iter().enumerate() {
            let start = offsets[l] as usize + j * size;
            data[start..start + size].fill(*value);
        }
    }
    assert!(store.commit(slot));
}

// a voice of osc 1 on table 1 (its unison and its shape), block by block for `frames`: its frequency and position
// at each sample, `before` called before each block; its left and right channels
fn play(
    store: &mut Store,
    unison: f64,
    shape: UnisonShape,
    frames: usize,
    frequency: impl Fn(usize) -> f32,
    position: impl Fn(usize) -> f32,
    mut before: impl FnMut(usize, &mut Store),
) -> (Vec<f32>, Vec<f32>) {
    let mut shared = Shared::default();
    let osc = OscOptions {
        table: 1,
        unison,
        phase: 0.0,
        phase_rand: 0.0,
        random: [0.0; 8],
        shape,
        warp_mode: 0,
        warp: 0.0,
    };
    let mut voice = Voice::new(
        RATE,
        VoiceOptions {
            osc: [Some(osc), None],
            ..note()
        },
        &mut shared,
    );
    voice.attach(store, &mut shared);
    let (mut left, mut right) = (vec![0.0; frames], vec![0.0; frames]);
    for frame in (0..frames).step_by(128) {
        before(frame, store);
        let at = |value: &dyn Fn(usize) -> f32| -> Vec<f32> { (0..128).map(|i| value(frame + i)).collect() };
        let (f, q) = (at(&frequency), at(&position));
        let params = [
            f.as_slice(),
            &[1.0],
            q.as_slice(),
            &[0.0],
            &[0.0],
            &[1.0],
            &[0.5],
            &[0.0],
            &[0.0],
            &[0.0],
            &[1.0],
            &[0.5],
        ];
        let end = (frame + 128).min(frames);
        voice.process(
            frame as f64,
            &params,
            &[0.0],
            &mut left[frame..end],
            &mut right[frame..end],
            store,
            &mut shared,
        );
    }
    voice.end(store, &mut shared);
    (left, right)
}

fn one(
    store: &mut Store,
    frames: usize,
    frequency: impl Fn(usize) -> f32,
    position: impl Fn(usize) -> f32,
) -> Vec<f32> {
    play(
        store,
        1.0,
        UnisonShape::default(),
        frames,
        frequency,
        position,
        |_, _| (),
    )
    .0
}

// `out` from `from` to `to` as a fade from `a` to `b` over `length` samples from `start`, then `b` (within the f32 of
// the sum)
fn expect_fade(out: &[f32], from: usize, to: usize, start: usize, length: f64, a: f64, b: f64) {
    for (i, value) in out.iter().enumerate().take(to).skip(from) {
        let m = ((i as f64 - start as f64) / length).clamp(0.0, 1.0);
        let expected = a + (b - a) * m;
        assert!(
            (*value as f64 - expected).abs() < 1e-5,
            "sample {i}: {value}, not {expected}"
        );
    }
}

#[test]
fn a_new_frame_fades_in_over_a_period_from_a_point_and_is_never_cut_short() {
    let mut store = Store::default();
    constant_frames(&mut store, 1.0, &[0.0, 1.0, 2.0, 3.0]);
    // 480 Hz: a period of 100 samples. Frame 1 from sample 140 (seen at the point of 160), frame 3 from 200 (the
    // fade goes on to its end at 260, the next point at 288 goes to frame 3, past frame 2)
    let out = one(
        &mut store,
        512,
        |_| 480.0,
        |i| match i {
            0..140 => 0.1,
            140..200 => 0.3,
            // (moving: every 32 samples a point)
            _ => 0.9 + (i % 2) as f32 * 1e-6,
        },
    );
    expect_fade(&out, 0, 288, 160, 100.0, 0.0, 1.0);
    expect_fade(&out, 288, 512, 288, 100.0, 1.0, 3.0);
}

#[test]
fn a_change_a_fade_held_back_comes_at_the_first_point_after_it_while_the_pitch_moves() {
    let mut store = Store::default();
    constant_frames(&mut store, 1.0, &[0.0, 1.0, 2.0, 3.0]);
    // 240 Hz at the points (moving: every 32 samples a point), a period of 200 samples; a still position in each
    // block: frame 1 from 128 (to 328), frame 3 from 256, held back by the fade, from the point of 352 (not the
    // start of the next block)
    let out = one(
        &mut store,
        640,
        |i| 240.0 + (i % 2) as f32 * 1e-3,
        |i| match i {
            0..128 => 0.1,
            128..256 => 0.3,
            _ => 0.9,
        },
    );
    expect_fade(&out, 0, 352, 128, 200.0, 0.0, 1.0);
    expect_fade(&out, 352, 640, 352, 200.0, 1.0, 3.0);
}

#[test]
fn a_fade_takes_at_most_5_ms_its_length_fixed_at_its_start() {
    let mut store = Store::default();
    constant_frames(&mut store, 1.0, &[0.0, 1.0]);
    let step = |i: usize| if i < 128 { 0.25 } else { 0.75 };
    // 55 Hz: a period of 873 samples, the fade 5 ms
    expect_fade(
        &one(&mut store, 640, |_| 55.0, step),
        0,
        640,
        128,
        240.0,
        0.0,
        1.0,
    );
    // a glide from 480 Hz down to 55 Hz under it: the period at its start
    let glide = |i: usize| if i < 128 { 480.0 } else { 480.0 - (i - 128) as f32 };
    expect_fade(&one(&mut store, 512, glide, step), 0, 512, 128, 100.0, 0.0, 1.0);
}

#[test]
fn a_still_position_moved_between_blocks_fades_from_the_block_its_mix_after() {
    let mut store = Store::default();
    constant_frames(&mut store, 1.0, &[0.0, 1.0, 2.0]);
    // still at frame 0 (its mix) for 4 blocks, then at frame 2: from the first sample of the block, over blocks
    // played directly (a mix of either frame would step), then the mix of frame 2
    let out = one(&mut store, 1280, |_| 480.0, |i| if i < 512 { 0.0 } else { 1.0 });
    expect_fade(&out, 0, 1280, 512, 100.0, 0.0, 2.0);
}

#[test]
fn each_voice_of_a_unison_fades_on_its_own() {
    let mut store = Store::default();
    constant_frames(&mut store, 1.0, &[0.0, 1.0, 2.0, 3.0]);
    // u2 at a spread of 0.6: the lower voice (right) on the position, the higher one (left) half of 0.6 of the table
    // (1.2 frames) below it. q 1 (frames 0 and 0), q 2 at 256 (the lower one to 1), q 2.4 at 512 (the lower one to 2,
    // the higher one to 1); each at the level of a voice of u2
    let shape = UnisonShape {
        position_spread: 0.6,
        ..UnisonShape::default()
    };
    let (left, right) = play(
        &mut store,
        2.0,
        shape,
        768,
        |_| 480.0,
        |i| match i {
            0..256 => 0.25,
            256..512 => 0.5,
            _ => 0.6,
        },
        |_, _| (),
    );
    expect_fade(&right, 0, 512, 256, 100.0, 0.0, U2);
    expect_fade(&right, 512, 768, 512, 100.0, U2, 2.0 * U2);
    expect_fade(&left, 0, 768, 512, 100.0, 0.0, U2);
}

#[test]
fn a_position_spread_is_taken_within_its_range_a_nan_as_none() {
    let mut store = Store::default();
    constant_frames(&mut store, 1.0, &[0.0, 1.0, 2.0, 3.0]);
    let mut spread = |unison: f64, position_spread: f64, position: f32| {
        let shape = UnisonShape {
            position_spread,
            ..UnisonShape::default()
        };
        play(&mut store, unison, shape, 256, |_| 480.0, |_| position, |_, _| ())
    };
    // u3 at a quarter of the table (q 1, frame 0): at a spread of 2 the third voice a quarter of the spread up would
    // play frame 2, at 1 it plays frame 1; at -2 the second one half of it up past the end (frame 3), at -1 frame 2
    assert_eq!(spread(3.0, 2.0, 0.25), spread(3.0, 1.0, 0.25));
    assert_eq!(spread(3.0, -2.0, 0.25), spread(3.0, -1.0, 0.25));
    // a NaN: the voices on the position (frame 2), not on frame 0; a unison of 2 one voice, as at 0
    for unison in [1.0, 2.0] {
        assert_eq!(spread(unison, f64::NAN, 0.75), spread(unison, 0.0, 0.75));
    }
}

#[test]
fn a_unison_that_is_not_a_number_is_one_voice() {
    let mut store = Store::default();
    constant_frames(&mut store, 1.0, &[0.5]);
    let mut unison = |unison: f64| {
        play(
            &mut store,
            unison,
            UnisonShape::default(),
            256,
            |_| 480.0,
            |_| 0.0,
            |_, _| (),
        )
    };
    assert_eq!(unison(f64::NAN), unison(1.0));
}

#[test]
fn a_fade_between_two_levels_reads_both_frames_on_each() {
    // a pitch at w 0.3 between the levels (90.7 Hz, the fade 5 ms), frame 0 then 1 from 128: on levels of other
    // lengths (render22) and of one (render22_same, in f32), each frame of each level a value of its own
    let (f, w) = pitch_at(0.3);
    for lengths in [[512, 256], [512, 512]] {
        let mut store = Store::default();
        two_level_frames(&mut store, lengths, [&[1.0, 2.0], &[4.0, 8.0]]);
        let out = one(&mut store, 640, |_| f, |i| if i < 128 { 0.25 } else { 0.75 });
        for (i, value) in out.iter().enumerate() {
            let m = ((i as f64 - 128.0) / 240.0).clamp(0.0, 1.0);
            let expected = (1.0 - w) * (1.0 + m) + w * (4.0 + 4.0 * m);
            assert!(
                (*value as f64 - expected).abs() < 1e-5,
                "{lengths:?}, sample {i}: {value}, not {expected}"
            );
        }
    }
}

// the frequency of the pitch at x = 1 + 3·log2(base · f / nyquist) on two_level_frames (in f32), and the weight of
// the second level a voice reads there (in the top LEVEL_BAND of the first: level_x)
fn pitch_x(x: f64) -> (f32, f64) {
    let nyquist = log2(RATE / 2.0);
    let f = pow(2.0, (x - 1.0) / 3.0 + nyquist - 8.0) as f32;
    let x = level_x(1.0 + 3.0 * (8.0 - nyquist) + 3.0 * log2(f as f64));
    (f, x - floor(x))
}

// the x of the pitch at the weight w (0..1) of the second level
fn x_at(w: f64) -> f64 {
    1.0 - LEVEL_BAND + LEVEL_BAND * w
}

// the pitch at the weight w (0..1) of the second level
fn pitch_at(w: f64) -> (f32, f64) {
    pitch_x(x_at(w))
}

// `out` is 1 + 3w at the weight w of the second level at each sample (two_level_frames of 1 and 4)
fn expect_weights(out: &[f32], w: impl Fn(usize) -> f64) {
    for (i, value) in out.iter().enumerate() {
        let expected = 1.0 + 3.0 * w(i);
        assert!(
            (*value as f64 - expected).abs() < 1e-5,
            "sample {i}: {value}, not {expected}"
        );
    }
}

#[test]
fn a_mix_left_for_the_one_of_a_new_pitch_glides_the_levels_it_reads_over_a_period() {
    // the pitch at w 0.3 (its mix from the second block), at 0.4 from 512: still on the mix of 0.3 (its reach holds
    // it), the mix of 0.4 built at 640 and glided into over 5 ms (a period of 92 Hz is 11 ms) at the points of the
    // block (its edges: a constant pitch), from 896 its mix
    let ((a, wa), (b, wb)) = (pitch_at(0.3), pitch_at(0.4));
    let mut store = Store::default();
    two_level_frames(&mut store, [512, 256], [&[1.0], &[4.0]]);
    let out = one(&mut store, 1024, |i| if i < 512 { a } else { b }, |_| 0.0);
    let glide = |c: f64| wa + (wb - wa) * c;
    expect_weights(&out, |i| match i {
        0..640 => wa,
        640..768 => glide((i - 640) as f64 / 240.0),
        768..896 => glide(128.0 / 240.0 + (1.0 - 128.0 / 240.0) * (i - 768) as f64 / 128.0),
        _ => wb,
    });
}

#[test]
fn a_pitch_that_steps_out_of_the_reach_of_its_mix_reads_its_own_levels_at_once() {
    // from w 0.3 on its mix to 0.6 at 512, past its reach (a quarter of a level) and that of either level: the levels
    // of the pitch from that sample, then its mix
    let ((a, wa), (b, wb)) = (pitch_at(0.3), pitch_at(0.6));
    let mut store = Store::default();
    two_level_frames(&mut store, [512, 256], [&[1.0], &[4.0]]);
    let out = one(&mut store, 1024, |i| if i < 512 { a } else { b }, |_| 0.0);
    expect_weights(&out, |i| if i < 512 { wa } else { wb });
}

#[test]
fn a_voice_that_leaves_the_reach_of_its_mix_while_the_pitch_moves_glides_without_a_step() {
    // on the mix of w 0.3 from the second block, then up to 0.9 over 1536 samples from 512 (no build: it holds a
    // band of the reach for less than one costs): on that mix while its reach holds the pitch (to 0.55), then a
    // glide to the levels of the pitch. Without it a step of 3 × 0.25
    let (a, wa) = pitch_at(0.3);
    let mut store = Store::default();
    two_level_frames(&mut store, [512, 256], [&[1.0], &[4.0]]);
    let frequency = |i: usize| {
        if i < 512 {
            a
        } else {
            pitch_at(0.3 + 0.6 * min(1.0, (i - 512) as f64 / 1536.0)).0
        }
    };
    let out = one(&mut store, 2560, frequency, |_| 0.0);
    // (on the mix while the pitch moves)
    assert!((out[700] as f64 - (1.0 + 3.0 * wa)).abs() < 1e-5);
    let most = out
        .windows(2)
        .map(|pair| (pair[1] as f64 - pair[0] as f64).abs())
        .fold(0.0, max);
    assert!(most < 0.01, "a step of {most}");
}

#[test]
fn a_mix_at_the_top_of_its_level_plays_nowhere_past_it() {
    // on the mix of w 0.9 (its reach up to 1, where the first level reaches the nyquist), then at x 1.3 from 512: the
    // flat of the second level (a whole x, 1, as the top of that reach): the second level alone at once, not the
    // mix (1 + 3 · 0.9)
    let (a, wa) = pitch_at(0.9);
    let (b, wb) = pitch_x(1.3);
    assert_eq!(wb, 0.0);
    let mut store = Store::default();
    two_level_frames(&mut store, [512, 256], [&[1.0], &[4.0]]);
    let out = one(&mut store, 1024, |i| if i < 512 { a } else { b }, |_| 0.0);
    expect_weights(&out, |i| if i < 512 { wa } else { 1.0 });
}

#[test]
fn a_mix_at_the_top_of_its_level_is_left_gliding_before_the_pitch_passes_it() {
    // on the mix of w 0.9, its reach up to 1 (where the first level reaches the nyquist: from there the second
    // alone), then up as fast as w 0.3 over 1536 samples from 512: it leaves the mix as far before 1 as a glide
    // takes, so the first level is gone by then (1 + 3w below it, 4 above it: no step at 1, nor where the glide would
    // end past it, the levels of the mix read up there)
    let (a, _) = pitch_at(0.9);
    let mut store = Store::default();
    two_level_frames(&mut store, [512, 256], [&[1.0], &[4.0]]);
    let frequency = |i: usize| {
        if i < 512 {
            a
        } else {
            pitch_x(x_at(0.9) + LEVEL_BAND * 0.3 * min(1.0, (i - 512) as f64 / 1536.0)).0
        }
    };
    let out = one(&mut store, 2560, frequency, |_| 0.0);
    // (a glide of the weights over 5 ms on the rise of the pitch: 0.002 a sample at most; one that went on past 1,
    // its first level cut there within a segment of 32 samples, would step 0.009 a sample)
    let most = out
        .windows(2)
        .map(|pair| (pair[1] as f64 - pair[0] as f64).abs())
        .fold(0.0, max);
    assert!(most < 0.003, "a step of {most}");
}

#[test]
fn a_fade_goes_on_above_the_nyquist_and_into_a_version_of_fewer_frames() {
    let mut store = Store::default();
    constant_frames(&mut store, 1.0, &[0.0, 1.0]);
    // a fade from 128 (to 228), above the nyquist from the point of 192 to the next block (the segment before it
    // fades into the silent level): done there, frame 1 alone from 256
    let out = one(
        &mut store,
        384,
        |i| if (192..256).contains(&i) { 30000.0 } else { 480.0 },
        |i| if i < 128 { 0.25 } else { 0.75 },
    );
    expect_fade(&out, 0, 160, 128, 100.0, 0.0, 1.0);
    assert!(out[192..256].iter().all(|value| *value == 0.0));
    assert!(out[256..].iter().all(|value| *value == 1.0));
    // 4 frames, a fade from frame 0 to 3 (5 ms, 55 Hz) into a version of 2 frames (5 and 6) on the way: over the
    // crossfade of the versions (10 ms from 256) the old one goes on with its fade, the new one plays its frame
    constant_frames(&mut store, 2.0, &[0.0, 1.0, 2.0, 3.0]);
    let (out, _) = play(
        &mut store,
        1.0,
        UnisonShape::default(),
        1280,
        |_| 55.0,
        |i| if i < 128 { 0.0 } else { 1.0 },
        |frame, store| {
            if frame == 256 {
                constant_frames(store, 3.0, &[5.0, 6.0]);
            }
        },
    );
    expect_fade(&out, 0, 256, 128, 240.0, 0.0, 3.0);
    for (i, value) in out.iter().enumerate().skip(256) {
        let old = 3.0 * ((i as f64 - 128.0) / 240.0).clamp(0.0, 1.0);
        let share = ((i - 256) as f64 / 480.0).clamp(0.0, 1.0);
        let expected = old + (6.0 - old) * share;
        assert!(
            (*value as f64 - expected).abs() < 1e-5,
            "sample {i}: {value}, not {expected}"
        );
    }
}

#[test]
fn a_silent_table_keeps_the_frame_of_the_position_for_the_version_after_it() {
    let mut store = Store::default();
    constant_frames(&mut store, 1.0, &[0.0, 1.0, 2.0, 3.0]);
    // on frame 0, then a silent version of as many frames (crossfaded in from 256), the position to frame 3 on it
    // (at 1024), then frames again (at 1536): the new version starts on frame 3, crossfaded in over 10 ms from
    // silence, no fade from frame 0
    let (out, _) = play(
        &mut store,
        1.0,
        UnisonShape::default(),
        2048,
        |_| 480.0,
        |i| if i < 1024 { 0.0 } else { 1.0 },
        |frame, store| match frame {
            256 => silent_frames(store, 2.0, 4),
            1536 => constant_frames(store, 3.0, &[0.0, 10.0, 20.0, 30.0]),
            _ => (),
        },
    );
    expect_fade(&out, 736, 1536, 0, 1.0, 0.0, 0.0);
    for (i, value) in out.iter().enumerate().skip(1536) {
        let expected = 30.0 * ((i - 1536) as f64 / 480.0).clamp(0.0, 1.0);
        assert!(
            (*value as f64 - expected).abs() < 1e-5,
            "sample {i}: {value}, not {expected}"
        );
    }
}

// --- the LFOs of the shared ---

#[test]
fn the_gain_of_a_voice_follows_an_lfo_of_the_shared_from_its_note_on() {
    use crate::modulation::VoiceRoute;
    use crate::shared::LFO_STATE;
    use crate::targets::{target, GAIN, OSC};
    let mut store = Store::default();
    constant_frames(&mut store, 1.0, &[0.5]);
    let mut shared = Shared::default();
    // LFO 1 a square of 0.25 s, the others sines of 0.5 s
    let mut square = vec![0.0f64; 2049];
    square[..1024].fill(1.0);
    square[2048] = 1.0;
    shared.lfo_table(0, &square);
    let mut state = [0.0; 4 * LFO_STATE];
    for lfo in 0..4 {
        state[lfo * LFO_STATE + 7] = if lfo == 0 { 0.25 } else { 0.5 };
    }
    state[8] = 1.0;
    shared.set_lfos(0.0, true, &state);
    let osc = OscOptions {
        table: 1,
        unison: 1.0,
        phase: 0.0,
        phase_rand: 0.0,
        random: [0.0; 8],
        shape: UnisonShape::default(),
        warp_mode: 0,
        warp: 0.0,
    };
    let route = VoiceRoute {
        source: 4.0,
        param: target(OSC, 0, GAIN),
        amount: 0.5,
        min: 0.0,
        max: 1.0,
        scale: 0,
        bipolar: false,
    };
    // the note on 0.05 s in: the square from there
    let start = 2400;
    let mut voice = Voice::new(
        RATE,
        VoiceOptions {
            osc: [Some(osc), None],
            start: start as f64 / RATE,
            env_start: start as f64 / RATE,
            routes: vec![route],
            ..note()
        },
        &mut shared,
    );
    voice.attach(&mut store, &mut shared);
    let frames = 24064;
    let mut out = vec![0.0f32; frames];
    let mut right = vec![0.0f32; frames];
    for frame in (0..frames).step_by(128) {
        let params: [&[f32]; PARAMS] = [
            &[100.0],
            &[1.0],
            &[0.0],
            &[0.0],
            &[0.0],
            &[0.5],
            &[0.5],
            &[0.0],
            &[0.0],
            &[0.0],
            &[1.0],
            &[0.5],
        ];
        voice.process(
            frame as f64,
            &params,
            &[0.0],
            &mut out[frame..frame + 128],
            &mut right[frame..frame + 128],
            &mut store,
            &mut shared,
        );
    }
    voice.end(&mut store, &mut shared);
    // a frame of 0.5 at a gain of 0.5 + 0.5 × the square: 0.5 for an eighth of a second from the note on, then 0.25
    for (i, value) in out.iter().enumerate().skip(start) {
        let t = (i - start) as f64 / RATE;
        let phase = (t / 0.25) % 1.0;
        let expected = if phase < 0.5 { 0.5 } else { 0.25 };
        // (the points every 32 samples interpolate across a step of the square)
        if (phase - 0.5).abs() > 0.003 && phase > 0.003 && phase < 0.997 {
            assert!(
                (*value as f64 - expected).abs() < 1e-6,
                "{i}: {value}, not {expected}"
            );
        }
    }
}

// --- a route on the pitch (Semi, Fine) ---

#[test]
fn the_routes_on_the_pitch_add_their_offsets_to_the_detune_within_their_bounds() {
    use crate::envelope::EnvelopeBlock;
    use crate::modulation::{BaseOf, Modulation, Sources, VoiceRoute};
    use crate::targets::{target, FINE, OSC, PITCH};
    const PITCH1: usize = target(OSC, 0, PITCH);
    const FINE1: usize = target(OSC, 0, FINE);
    // the offsets of the pitch: of base 0
    struct Zero;
    impl BaseOf for Zero {
        fn base(&self, _module: usize, _instance: usize, _knob: usize) -> &[f32] {
            &[0.0]
        }
    }
    // ENV 2 a kick: its level 1 at the note on, down to 0 in 80 ms
    let kick = EnvelopeParams {
        attack: 0.0,
        hold: 0.0,
        decay: 0.08,
        sustain: 0.0,
        release: 0.0,
        curves: [0.0, 3.49, 3.49],
    };
    // Oct -1 and Semi +5: the detune -700 cents; ENV 2 on Semi up from it (24 semitones at 1), within its
    // bounds (-1700..700: Semi from +5 within ±12), and around Fine of 0 at 100% (200 cents, within -100..100)
    let pitch = VoiceRoute {
        source: 1.0,
        param: PITCH1,
        amount: 2400.0,
        min: -1700.0,
        max: 700.0,
        scale: 0,
        bipolar: false,
    };
    let fine = VoiceRoute {
        param: FINE1,
        amount: 200.0,
        min: -100.0,
        max: 100.0,
        bipolar: true,
        ..pitch
    };
    let mut envelopes = note().envelopes;
    envelopes[1] = kick;
    let blocks = 75;
    // the offsets the routes give the pitch of osc 1 from 0, block by block
    let mut modulation = Modulation::new(RATE, 3, false, &[pitch, fine], 1 << PITCH1 | 1 << FINE1);
    let mut levels: Vec<EnvelopeBlock> = envelopes
        .iter()
        .map(|params| EnvelopeBlock::new(*params, RATE, 0.0))
        .collect();
    let velocity = Glided::new(0.0);
    let bases = Zero;
    let offsets: Vec<[Vec<f32>; 2]> = (0..blocks)
        .map(|block| {
            let frame = (block * 128) as f64;
            levels
                .iter_mut()
                .for_each(|envelope| envelope.render(frame, 0.0, 128.0));
            let sources = Sources {
                envelopes: &levels,
                velocity: &velocity,
                lfos: &[],
            };
            modulation.apply(&bases, &sources, frame, 0.0, 128.0, 128);
            [PITCH1, FINE1].map(|param| modulation.moved(param).expect("moved").to_vec())
        })
        .collect();
    // Semi at the top of its bounds (+12) while the kick is over 700 / 2400 (27 ms), then down to its value;
    // Fine from +100 down to -100: one value each once the kick is over
    let [semi, cents] = &offsets[0];
    assert!(semi.iter().all(|offset| *offset == 700.0) && cents[0] == 100.0);
    assert!(offsets[20][0]
        .iter()
        .all(|offset| *offset > 0.0 && *offset < 700.0));
    assert_eq!(offsets[blocks - 1], [vec![0.0], vec![-100.0]]);

    // a voice of 3 unison voices on the sine of the store, its detune moved by the routes or given the sum
    let play = |routes: Vec<VoiceRoute>, detune: &dyn Fn(usize) -> Vec<f32>| {
        let (mut store, mut shared) = (Store::default(), Shared::default());
        let osc = OscOptions {
            table: 9,
            unison: 3.0,
            phase: 0.0,
            phase_rand: 0.0,
            random: [0.0; 8],
            shape: UnisonShape::default(),
            warp_mode: 0,
            warp: 0.0,
        };
        let mut voice = Voice::new(
            RATE,
            VoiceOptions {
                osc: [Some(osc), None],
                envelopes: envelopes.clone(),
                routes,
                ..note()
            },
            &mut shared,
        );
        voice.attach(&mut store, &mut shared);
        let (mut left, mut right) = (vec![0.0f32; blocks * 128], vec![0.0f32; blocks * 128]);
        for block in 0..blocks {
            let frame = block * 128;
            let d = detune(block);
            let params: [&[f32]; PARAMS] = [
                &[110.0],
                &[1.0],
                &[0.0],
                d.as_slice(),
                &[20.0],
                &[0.5],
                &[0.5],
                &[0.0],
                &[0.0],
                &[0.0],
                &[0.5],
                &[0.5],
            ];
            voice.process(
                frame as f64,
                &params,
                &[0.0],
                &mut left[frame..frame + 128],
                &mut right[frame..frame + 128],
                &mut store,
                &mut shared,
            );
        }
        voice.end(&mut store, &mut shared);
        (left, right)
    };
    let at = |values: &[f32], i: usize| values[if values.len() > 1 { i } else { 0 }] as f64;
    let routed = play(vec![pitch, fine], &|_| vec![-700.0]);
    let given = play(Vec::new(), &|block| {
        let [semi, cents] = &offsets[block];
        let length = semi.len().max(cents.len());
        (0..length)
            .map(|i| (-700.0 + at(semi, i) + at(cents, i)) as f32)
            .collect()
    });
    assert_eq!(routed, given);
    // (not the note alone)
    assert_ne!(routed, play(Vec::new(), &|_| vec![-700.0]));
}

// --- the blend of a unison (a param of the oscillator: still, the gains of its voices; moving, those of the centre
// and of the others at the points of every 32 samples, linear between them) ---

// a voice of osc 1 of `unison` voices at a spread of 20 cents (and `shape`) on table 1 of one frame of 1 at every
// sample (each voice plays its gain × the level of the unison), its blend at each sample; its left and right
// channels (`frames` a multiple of 128)
fn play_blend(
    unison: f64,
    shape: UnisonShape,
    frames: usize,
    blend: impl Fn(usize) -> f32,
) -> (Vec<f32>, Vec<f32>) {
    let (mut store, mut shared) = (Store::default(), Shared::default());
    constant_frames(&mut store, 1.0, &[1.0]);
    let osc = OscOptions {
        table: 1,
        unison,
        phase: 0.0,
        phase_rand: 0.0,
        random: [0.0; 8],
        shape,
        warp_mode: 0,
        warp: 0.0,
    };
    let mut voice = Voice::new(
        RATE,
        VoiceOptions {
            osc: [Some(osc), None],
            ..note()
        },
        &mut shared,
    );
    voice.attach(&mut store, &mut shared);
    let (mut left, mut right) = (vec![0.0f32; frames], vec![0.0f32; frames]);
    for frame in (0..frames).step_by(128) {
        let values: Vec<f32> = (frame..frame + 128).map(&blend).collect();
        let params: [&[f32]; PARAMS] = [
            &[480.0],
            &[1.0],
            &[0.0],
            &[0.0],
            &[20.0],
            &[1.0],
            values.as_slice(),
            &[0.0],
            &[0.0],
            &[0.0],
            &[1.0],
            &[0.5],
        ];
        voice.process(
            frame as f64,
            &params,
            &[0.0],
            &mut left[frame..frame + 128],
            &mut right[frame..frame + 128],
            &mut store,
            &mut shared,
        );
    }
    voice.end(&mut store, &mut shared);
    (left, right)
}

// the gains of the centre voices and of the others at a blend against the centre at 0, the levels of a voice of u2,
// u4 and u5 and the middle one of an odd count in each channel against one hard left or right: the curves of the
// renders (dsp/measurements/blend.json)
fn blend_gains(blend: f64) -> (f64, f64) {
    let b2 = blend * blend;
    (1.0 - 0.554903 * b2, 0.0445334 + 1.28871 * b2 - 0.740236 * b2 * b2)
}
const U2: f64 = 0.8077;
const U4: f64 = 1.0738;
const U5: f64 = 1.0416;
const CENTRE_PAN: f64 = 0.39718;

// the gains of a moving blend between the points of its modulation, linear, against those of each sample: 2.2% off
// at most where it sweeps the whole range in 256 samples (5.3 ms; near 1, where the gain of the others curves the
// most), less by the square of the speed (h²/8 · |g''| over a segment); the bound 2.5%
const BETWEEN_POINTS: f64 = 0.025;

#[test]
fn a_blend_moves_the_centre_voices_against_the_others_at_the_points_of_its_modulation() {
    // still at 0.25, up to 1, still at 1, down to 0, still at 0: the blocks that move it mix the centre and the
    // others at the gains of the blend at the points of the modulation, linear between them (within
    // BETWEEN_POINTS), the still ones play the gains of the voices
    let blend = |i: usize| -> f32 {
        let i = i as f64;
        (if i < 128.0 {
            0.25
        } else if i < 640.0 {
            0.25 + 0.75 * (i - 128.0) / 512.0
        } else if i < 768.0 {
            1.0
        } else if i < 1024.0 {
            1.0 - (i - 768.0) / 256.0
        } else {
            0.0
        }) as f32
    };
    // u5: the middle one in both channels at its pan (its centre one: a width leaves it), two others in each; u4:
    // one of the middle two and one other in each. Each voice at the level of the unison, a width below 1 adds the
    // other channel × sin to it × cos (both alike here)
    for (unison, level, middle, others) in [(5.0, U5, true, 2.0), (4.0, U4, false, 1.0)] {
        for width in [1.0, 0.5] {
            let shape = UnisonShape {
                width,
                ..UnisonShape::default()
            };
            let (left, right) = play_blend(unison, shape, 1152, blend);
            let pan = (1.0 - width) * jsmath::PI / 4.0;
            let stereo = if width < 1.0 {
                jsmath::cos(pan) + jsmath::sin(pan)
            } else {
                1.0
            };
            for i in 0..1152 {
                let (c, s) = blend_gains(blend(i) as f64);
                let expected = if middle {
                    level * (c * CENTRE_PAN + others * s * stereo)
                } else {
                    level * (c + others * s) * stereo
                };
                // the points of the modulation in a block: every 32 samples, then the last one
                let bound = if matches!(i % 128, 0 | 32 | 64 | 96 | 127) {
                    1e-5
                } else {
                    BETWEEN_POINTS * expected
                };
                for out in [&left, &right] {
                    assert!(
                        (out[i] as f64 - expected).abs() < bound,
                        "u{unison} width {width} at {i}: {} against {expected}",
                        out[i]
                    );
                }
            }
            // a still blend after a moving one plays as a blend always still there
            let still = play_blend(unison, shape, 1152, |_| 0.0);
            assert_eq!(left[1024..], still.0[1024..]);
        }
    }
}

#[test]
fn a_unison_of_one_or_two_is_all_centre_whatever_its_blend() {
    for unison in [1.0, 2.0] {
        let moving = play_blend(unison, UnisonShape::default(), 512, |i| (i as f64 / 512.0) as f32);
        assert_eq!(moving, play_blend(unison, UnisonShape::default(), 512, |_| 0.5));
    }
}

// --- the warp (warp.rs) ---

mod warped {
    use super::*;
    use crate::shared::CycleKey;
    use crate::store::MAX_LEVEL_LENGTH;
    use crate::targets::WARP;
    use crate::warp::{self, BEND_BOTH, BEND_DOWN, BEND_UP, OFF, PWM};
    use jsmath::exp;

    // a version of table 1 of one frame on the levels of two_level_frames (255 and 127 harmonics: pitch_x): a saw of
    // each, its guards around it
    fn saw_levels(store: &mut Store) {
        let (lengths, harmonics) = ([1024usize, 512], [255, 127]);
        let sizes = lengths.map(|length| length + FRAME_GUARD);
        let offsets = vec![0, sizes[0] as i32, (sizes[0] + sizes[1]) as i32];
        let layout = [vec![255, 127, 0], vec![1024, 512, 1], offsets.clone()];
        let length = sizes[0] + sizes[1] + 1 + FRAME_GUARD;
        let slot = store.begin(1, 1.0, 1, layout, length, 0.0).expect("a slot");
        let data = store.chunk(slot, 0, length).expect("its room");
        for l in 0..2 {
            let len = lengths[l];
            for i in 0..sizes[l] {
                let k = (i + len - 1) % len;
                let x = 2.0 * core::f64::consts::PI * k as f64 / len as f64;
                let value: f64 = (1..=harmonics[l])
                    .map(|h| jsmath::sin(h as f64 * x) / h as f64)
                    .sum();
                data[offsets[l] as usize + i] = (0.5 * value) as f32;
            }
        }
        assert!(store.commit(slot));
    }

    // a version of table 1 of one frame laid out as the store lays out a saw of `harmonics` (wavetable-levels.ts:
    // levels a third of an octave apart from the power of two over them, 32 samples a harmonic within 512..4096, the
    // silent one last), each level a saw of its harmonics (summed by the recurrence of the sines: in doubles)
    fn saw_table(store: &mut Store, harmonics: i32) {
        saw_frames(store, harmonics, 1);
    }

    // saw_table of `frames` frames: the saw, then its odd harmonics alone (a square), and so on
    fn saw_frames(store: &mut Store, harmonics: i32, frames: usize) {
        let base = crate::voice::level_base(harmonics);
        let mut counts = Vec::new();
        for r in 0.. {
            let count = floor(base * pow(2.0, -(r as f64) / 3.0) + 1e-9) as i32;
            if count < 1 {
                break;
            }
            counts.push(count.min(harmonics));
        }
        counts.push(0);
        let lengths: Vec<i32> = counts
            .iter()
            .map(|&h| {
                if h == 0 {
                    1
                } else {
                    ((32 * h) as u32).next_power_of_two().clamp(512, 4096) as i32
                }
            })
            .collect();
        let mut offsets = Vec::new();
        let mut size = 0;
        for &length in &lengths {
            offsets.push(size as i32);
            size += frames * (length as usize + FRAME_GUARD);
        }
        let layout = [counts.clone(), lengths.clone(), offsets.clone()];
        let slot = store
            .begin(1, 1.0, frames as i32, layout, size, 0.0)
            .expect("a slot");
        let data = store.chunk(slot, 0, size).expect("its room");
        for l in 0..counts.len() {
            let len = lengths[l] as usize;
            for frame in 0..frames {
                let start = offsets[l] as usize + frame * (len + FRAME_GUARD);
                for i in 0..len + FRAME_GUARD {
                    let k = (i + len - 1) % len;
                    let x = 2.0 * core::f64::consts::PI * k as f64 / len as f64;
                    let (c, mut before, mut now, mut value) =
                        (2.0 * jsmath::cos(x), 0.0, jsmath::sin(x), 0.0);
                    for h in 1..=counts[l] {
                        if frame % 2 == 0 || h % 2 == 1 {
                            value += now / h as f64;
                        }
                        (before, now) = (now, c * now - before);
                    }
                    data[start + i] = (0.5 * value) as f32;
                }
            }
        }
        assert!(store.commit(slot));
    }

    // the frequency of the pitch at x = 1 + 3·log2(base · f / nyquist) on a table of `harmonics` (saw_table)
    fn frequency_at(harmonics: i32, x: f64) -> f32 {
        let base = crate::voice::level_base(harmonics);
        (RATE / 2.0 / base * pow(2.0, (x - 1.0) / 3.0)) as f32
    }

    // a voice of osc 1 (unison `unison`) on the saw at `frequency`, its warp (mode, knob) at the start; `frames`
    // rendered in blocks of `size`, `before` called before each one (a knobs event); its left channel
    fn play(
        warp: (u32, f64),
        unison: f64,
        frequency: impl Fn(usize) -> f32,
        frames: usize,
        size: usize,
        mut before: impl FnMut(usize, &mut Voice),
    ) -> Vec<f32> {
        render(
            saw_levels,
            warp,
            unison,
            frequency,
            frames,
            size,
            |frame, voice, _| {
                before(frame, voice);
                true
            },
        )
    }

    // play on the table `table` lays out, `before` given the shared too (its refusals of the builds) and telling
    // whether the block has memory (else no allocation succeeds in it)
    fn render(
        table: impl FnOnce(&mut Store),
        warp: (u32, f64),
        unison: f64,
        frequency: impl Fn(usize) -> f32,
        frames: usize,
        size: usize,
        before: impl FnMut(usize, &mut Voice, &mut Shared) -> bool,
    ) -> Vec<f32> {
        render_at(table, warp, unison, frequency, None, frames, size, before)
    }

    // render at the `position` of each sample (None: still at 0, a param of one value)
    #[allow(clippy::too_many_arguments)]
    fn render_at(
        table: impl FnOnce(&mut Store),
        warp: (u32, f64),
        unison: f64,
        frequency: impl Fn(usize) -> f32,
        position: Option<&dyn Fn(usize) -> f32>,
        frames: usize,
        size: usize,
        mut before: impl FnMut(usize, &mut Voice, &mut Shared) -> bool,
    ) -> Vec<f32> {
        let mut store = Store::default();
        table(&mut store);
        let mut shared = Shared::default();
        let osc = OscOptions {
            table: 1,
            unison,
            phase: 0.0,
            phase_rand: 0.3,
            random: [0.0, 0.11, 0.42, 0.73, 0.19, 0.58, 0.27, 0.86],
            shape: UnisonShape::default(),
            warp_mode: warp.0,
            warp: warp.1,
        };
        let mut voice = Voice::new(
            RATE,
            VoiceOptions {
                osc: [Some(osc), None],
                ..note()
            },
            &mut shared,
        );
        voice.attach(&mut store, &mut shared);
        let (mut left, mut right) = (vec![0.0; frames], vec![0.0; frames]);
        for frame in (0..frames).step_by(size) {
            let memory = before(frame, &mut voice, &mut shared);
            let f: Vec<f32> = (0..size).map(|i| frequency(frame + i)).collect();
            let q: Vec<f32> = match position {
                Some(position) => (0..size).map(|i| position(frame + i)).collect(),
                None => vec![0.0],
            };
            let params = [
                f.as_slice(),
                &[1.0],
                q.as_slice(),
                &[0.0],
                &[30.0],
                &[1.0],
                &[0.5],
                &[0.0],
                &[0.0],
                &[0.0],
                &[1.0],
                &[0.5],
            ];
            let end = (frame + size).min(frames);
            let mut process = || {
                voice.process(
                    frame as f64,
                    &params,
                    &[0.0],
                    &mut left[frame..end],
                    &mut right[frame..end],
                    &mut store,
                    &mut shared,
                )
            };
            if memory {
                process();
            } else {
                without_memory(process);
            }
        }
        voice.end(&mut store, &mut shared);
        left
    }

    // a pitch on the flat of level 0 (no mix to build), and one gliding over both levels and their crossfade
    fn still(_: usize) -> f32 {
        pitch_x(0.5).0
    }
    fn gliding(i: usize) -> f32 {
        pitch_x(0.3 + 1.4 * (i as f64 / 2048.0)).0
    }

    #[test]
    fn a_neutral_warp_plays_the_bits_of_no_warp() {
        for frequency in [still as fn(usize) -> f32, gliding] {
            let plain = play((OFF, 0.7), 3.0, frequency, 2048, 128, |_, _| ());
            for warp in [(BEND_UP, 0.0), (BEND_DOWN, 0.0), (BEND_BOTH, 0.5), (PWM, 0.0)] {
                assert_eq!(
                    play(warp, 3.0, frequency, 2048, 128, |_, _| ()),
                    plain,
                    "{warp:?}"
                );
            }
        }
    }

    #[test]
    fn a_warp_changes_the_sound() {
        let plain = play((OFF, 0.0), 1.0, still, 1024, 128, |_, _| ());
        for warp in [(BEND_UP, 0.6), (BEND_DOWN, 0.6), (BEND_BOTH, 0.1), (PWM, 0.5)] {
            let warped = play(warp, 1.0, still, 1024, 128, |_, _| ());
            assert!(
                warped.iter().zip(&plain).any(|(a, b)| (a - b).abs() > 0.05),
                "{warp:?}"
            );
        }
    }

    #[test]
    fn a_warped_block_cut_into_other_spans_plays_the_same_bits() {
        for warp in [(BEND_UP, 0.7), (PWM, 0.5)] {
            let whole = play(warp, 4.0, still, 2048, 128, |_, _| ());
            assert_eq!(play(warp, 4.0, still, 2048, 64, |_, _| ()), whole, "{warp:?}");
        }
        // a bend of a < 0 whose knob moves (from 0 at 128, through the one-pole: 0.4 within 1e-7 after 8700 samples;
        // its levels sample by sample, no warped mix): the same bits; still, the block it builds its warped mix in is
        // another (the first steady one): within 61.2 dB of its peak (a_warped_mix_plays_as_the_voice_read_directly)
        let moved = |frame: usize, voice: &mut Voice| {
            if frame == 128 {
                voice.set_knobs(WARP, &[BEND_DOWN as f64, 0.4, 0.0, 0.0]);
            }
        };
        let whole = play((BEND_DOWN, 0.0), 4.0, still, 2048, 128, moved);
        assert_eq!(play((BEND_DOWN, 0.0), 4.0, still, 2048, 64, moved), whole);
        let bend = (BEND_DOWN, 0.4);
        let table = |size: usize| render_saw(255, bend, 4.0, 7.69, 2048, size, |_, _, _| true);
        let (whole, cut) = (table(128), table(64));
        assert!(whole[64..128] != cut[64..128]);
        let (peak, difference) = peak_and_difference(&whole, &cut);
        assert!(difference < 1e-3 * peak, "{difference} of {peak}");
    }

    #[test]
    fn a_voice_warped_and_back_plays_as_one_never_warped() {
        // the phase a voice keeps is never warped: once its knob is back at 0 (the one-pole there, within WARP_THERE)
        // it plays the bits of a voice that never warped
        let back = |frame: usize, voice: &mut Voice| {
            if frame == 0 {
                voice.set_knobs(WARP, &[BEND_DOWN as f64, 0.8, 0.0, 0.0]);
            } else if frame == 4096 {
                voice.set_knobs(WARP, &[BEND_DOWN as f64, 0.0, 0.0, 0.0]);
            }
        };
        let warped = play((BEND_DOWN, 0.0), 2.0, gliding, 16384, 128, back);
        let plain = play((BEND_DOWN, 0.0), 2.0, gliding, 16384, 128, |_, _| ());
        assert!(warped[..4096]
            .iter()
            .zip(&plain)
            .any(|(a, b)| (a - b).abs() > 0.05));
        // (0.8 to 1e-7 in 16 time constants: 8700 samples, then a block)
        assert_eq!(warped[13056..], plain[13056..]);
    }

    #[test]
    fn a_new_mode_crossfades_into_the_sound_of_that_mode() {
        let switch = |frame: usize, voice: &mut Voice| {
            if frame == 512 {
                voice.set_knobs(WARP, &[PWM as f64, 0.6, 0.0, 0.0]);
            }
        };
        let switched = play((BEND_UP, 0.6), 1.0, still, 2048, 128, switch);
        let (from, to) = (
            play((BEND_UP, 0.6), 1.0, still, 2048, 128, |_, _| ()),
            play((PWM, 0.6), 1.0, still, 2048, 128, |_, _| ()),
        );
        // the old mode until the block of the event, a crossfade of 10 ms (480 samples) from it, the new one after
        assert_eq!(switched[..512], from[..512]);
        for i in 512..992 {
            let share = (i - 512) as f64 / 480.0;
            let expected = from[i] as f64 + (to[i] as f64 - from[i] as f64) * share;
            assert!(
                (switched[i] as f64 - expected).abs() < 1e-5,
                "{i}: {} against {expected}",
                switched[i]
            );
        }
        assert_eq!(switched[1024..], to[1024..]);
    }

    // the runs of level_cut over xs[from..=end]: (a, b, level, w at a, w at b)
    fn cuts(xs: &[f64], from: usize) -> Vec<(usize, usize, f64, f64, f64)> {
        let (end, mut a, mut runs) = (xs.len() - 1, from, Vec::new());
        while a < end {
            let (b, level, w0, w1) = crate::voice::level_cut(xs, a, end);
            runs.push((a, b, level, w0, w1));
            a = b;
        }
        runs
    }

    #[test]
    fn a_segment_within_one_crossfade_is_one_run_of_its_weights() {
        let xs: Vec<f64> = (0..=32).map(|i| 3.2 + 0.7 * i as f64 / 32.0).collect();
        let runs = cuts(&xs, 0);
        assert_eq!(runs.len(), 1);
        let (_, b, level, w0, w1) = runs[0];
        assert_eq!((b, level), (32, 3.0));
        assert!((w0 - 0.2).abs() < 1e-12 && (w1 - 0.9).abs() < 1e-12);
    }

    #[test]
    fn the_levels_of_a_warp_that_jump_are_cut_where_they_leave_a_crossfade() {
        // rising most at the start (PWM near its top: the levels of 1 / (1 - k) a line), then falling: the runs
        // cover the segment one after another, each one sample or within a level and the next with the weights of
        // its ends, the next one from where it ended
        let rising: Vec<f64> = (0..=32)
            .map(|i| 2.0 + 3.0 * log2(1.0 + 600.0 * i as f64 / 32.0))
            .collect();
        let falling: Vec<f64> = rising.iter().rev().copied().collect();
        for (xs, from) in [(&rising, 0), (&falling, 0), (&rising, 5)] {
            let runs = cuts(xs, from);
            assert_eq!(runs[0].0, from);
            assert_eq!(runs.last().unwrap().1, 32);
            assert!(runs.len() > 3, "{runs:?}");
            for pair in runs.windows(2) {
                assert_eq!(pair[0].1, pair[1].0);
            }
            for &(a, b, level, w0, w1) in &runs {
                assert!(b > a);
                assert_eq!(w0, (xs[a] - level).clamp(0.0, 1.0));
                assert_eq!(w1, (xs[b] - level).clamp(0.0, 1.0));
                if b > a + 1 {
                    assert!(
                        xs[a..=b].iter().all(|x| *x >= level && *x <= level + 1.0),
                        "{a}..{b}"
                    );
                }
            }
        }
    }

    #[test]
    fn a_frame_that_fades_under_levels_that_jump_is_cut_as_each_frame_alone() {
        // PWM from near its top down (the levels of its pitch fall by 9 in the first 32 samples of the one-pole, by
        // more than one in each for 5 segments) at the block the position goes to the other frame: a fade of 5 ms
        // (83 Hz) over them. A fade is linear in its frames: it is the voice still on each, cut where the levels
        // leave a crossfade, by its share (one crossfade over a segment of the fade read levels richer than the pitch)
        let f = frequency_at(255, 0.5);
        let voice = |position: &dyn Fn(usize) -> f32| {
            render_at(
                |store| saw_frames(store, 255, 2),
                (PWM, 0.995),
                1.0,
                |_| f,
                Some(position),
                1024,
                128,
                |frame, voice, _| {
                    if frame == 512 {
                        voice.set_knobs(WARP, &[PWM as f64, 0.3, 0.0, 0.0]);
                    }
                    true
                },
            )
        };
        let (first, second) = (voice(&|_| 0.0), voice(&|_| 1.0));
        let faded = voice(&|i| if i < 512 { 0.0 } else { 1.0 });
        let (_, apart) = peak_and_difference(&first[512..752], &second[512..752]);
        assert!(apart > 0.1, "{apart}");
        for i in 0..1024 {
            let m = ((i as f64 - 512.0) / 240.0).clamp(0.0, 1.0);
            let expected = first[i] as f64 + (second[i] as f64 - first[i] as f64) * m;
            assert!(
                (faded[i] as f64 - expected).abs() < 1e-5,
                "sample {i}: {}, not {expected}",
                faded[i]
            );
        }
    }

    #[test]
    fn a_voice_that_glides_from_its_mix_under_levels_that_jump_is_cut_too() {
        // PWM at 0.98 (its pitch 16.9 levels up: in the crossfade of levels 20 and 21, a mix of them), then at 512,
        // where its frame wraps (a period of 256 samples), its knob to 0 (the levels of its pitch fall by 5.8 in the
        // first 32 samples of the one-pole) and its pitch a little up, within the reach of the mix: the voice glides
        // from the mix to the levels of its pitch in that segment. It is the voice that never had a mix (its builds
        // refused: read directly, cut where the levels leave a crossfade); one crossfade over the segment read from
        // level 16 down, far richer than its pitch through a slope of 50: 0.21 of its peak off
        let (from, to) = (frequency_at(255, 4.0), frequency_at(255, 4.02));
        let voice = |refuse: bool| {
            render(
                |store| saw_table(store, 255),
                (PWM, 0.98),
                1.0,
                |i| if i < 512 { from } else { to },
                1024,
                128,
                |frame, voice, shared| {
                    shared.refuse_builds = refuse;
                    if frame == 512 {
                        voice.set_knobs(WARP, &[PWM as f64, 0.0, 0.0, 0.0]);
                    }
                    true
                },
            )
        };
        let (mixed, direct) = (voice(false), voice(true));
        let (peak, difference) = peak_and_difference(&direct[512..], &mixed[512..]);
        assert!(difference < 1e-3 * peak, "{difference} of {peak}");
    }

    #[test]
    fn the_room_of_the_kept_cycles_comes_with_the_buffers_of_the_block() {
        // (a block of the scope grows the shared: the first warped mix of a note allocates no cycle)
        let mut shared = Shared::default();
        shared.grow(128);
        let key = |serial: u64| CycleKey {
            serial,
            data: 0,
            a: 0,
            length: MAX_LEVEL_LENGTH,
            first: (0, MAX_LEVEL_LENGTH),
            second: None,
        };
        let taken = without_memory(|| [shared.cycle(key(1)), shared.cycle(key(2))]);
        assert_eq!(taken, [Some((0, false)), Some((1, false))]);
    }

    #[test]
    fn a_run_holds_its_crossfade_where_the_x_turns_back_within_it() {
        // the pitch up while the warp goes down: an x that turns within one crossfade is one run, one that leaves it
        // in the middle is cut there
        let within = [4.1, 4.5, 4.8, 4.6, 4.3];
        let runs = cuts(&within, 0);
        assert_eq!(runs.len(), 1);
        assert_eq!((runs[0].0, runs[0].1, runs[0].2), (0, 4, 4.0));
        // (4.1 to 4.9 a run; then the samples that cross 5, one each; back within 4..5 from 4.6)
        let leaving = [4.1, 4.9, 5.3, 4.6, 4.3];
        let bounds: Vec<(usize, usize)> = cuts(&leaving, 0).iter().map(|r| (r.0, r.1)).collect();
        assert_eq!(bounds, vec![(0, 1), (1, 2), (2, 3), (3, 4)]);
    }

    #[test]
    fn a_new_mode_keeps_the_mixes_of_the_oscillator() {
        // a pitch on the crossfade of the levels (its mix built), Off to Bend + (no levels up either): after the
        // crossfade (512..992) the mix it had is still there, never built again
        let (mut before, mut after) = (None, None);
        let switch = |frame: usize, voice: &mut Voice| {
            if frame == 512 {
                before = voice.kept_mix(0, 0);
                voice.set_knobs(WARP, &[BEND_UP as f64, 0.6, 0.0, 0.0]);
            } else if frame == 1024 {
                after = voice.kept_mix(0, 0);
            }
        };
        play((OFF, 0.0), 1.0, |_| pitch_x(0.9).0, 2048, 128, switch);
        assert!(
            before.is_some_and(|(_, _, w, warp)| w > 0.0 && warp.is_none()),
            "{before:?}"
        );
        assert_eq!(after, before);
    }

    // play on saw_table of `harmonics` at x (frequency_at), still
    fn render_saw(
        harmonics: i32,
        warp: (u32, f64),
        unison: f64,
        x: f64,
        frames: usize,
        size: usize,
        before: impl FnMut(usize, &mut Voice, &mut Shared) -> bool,
    ) -> Vec<f32> {
        let f = frequency_at(harmonics, x);
        render(
            |store| saw_table(store, harmonics),
            warp,
            unison,
            |_| f,
            frames,
            size,
            before,
        )
    }

    // the peak of `a` and the largest difference of `b` from it
    fn peak_and_difference(a: &[f32], b: &[f32]) -> (f64, f64) {
        let peak = a.iter().fold(0.0, |m, v| max(m, (*v as f64).abs()));
        let difference = a
            .iter()
            .zip(b)
            .fold(0.0, |m, (x, y)| max(m, (*x as f64 - *y as f64).abs()));
        (peak, difference)
    }

    // the voice and the same refused every build (read directly: the reference); refuse_builds set before its first block
    fn with_and_without_builds(
        harmonics: i32,
        warp: (u32, f64),
        unison: f64,
        x: f64,
        frames: usize,
        mut before: impl FnMut(usize, &mut Voice),
    ) -> (Vec<f32>, Vec<f32>) {
        let mut run = |refuse: bool| {
            render_saw(harmonics, warp, unison, x, frames, 128, |frame, voice, shared| {
                shared.refuse_builds = refuse;
                before(frame, voice);
                true
            })
        };
        (run(false), run(true))
    }

    #[test]
    fn a_still_bend_under_0_reads_a_warped_mix_of_its_own_from_its_first_steady_block() {
        // a pitch on the crossfade of the levels, still: Bend + (no levels up) builds its mix, Bend - and Bend +/- over
        // 0.5 a warped one in the first steady block (the second: the first has no block before it), of its mode, a
        // and pitch
        let kept = |warp: (u32, f64), at: usize| {
            let mut mix = None;
            play(
                warp,
                1.0,
                |_| pitch_x(0.9).0,
                2048,
                128,
                |frame, voice: &mut Voice| {
                    if frame == at {
                        mix = voice.kept_mix(0, 0);
                    }
                },
            );
            mix
        };
        assert!(kept((BEND_UP, 0.6), 1920).is_some_and(|(_, _, _, warp)| warp.is_none()));
        for (mode, knob) in [(BEND_DOWN, 0.6), (BEND_BOTH, 0.8)] {
            assert_eq!(kept((mode, knob), 128), None);
            let mix = kept((mode, knob), 256);
            let a = warp::param(mode, knob as f32 as f64);
            assert!(
                mix.is_some_and(|(frame, _, _, warp)| frame == 0
                    && warp.is_some_and(|(m, at, x)| m == mode && at == a && x.is_finite())),
                "{mode}: {mix:?}"
            );
            assert_eq!(kept((mode, knob), 1920), mix);
        }
    }

    #[test]
    fn the_voices_of_a_unison_take_their_warped_mixes_at_the_cost_of_a_cycle_kept() {
        // a unison of 8 on a level of 4096 samples, in its first steady block the budget with room for one mix that
        // fills its cycle and seven of it kept (8 + 7 · 1.5 multiply-adds a sample; at the cost of a fill each: two):
        // all eight on their mixes from that block on
        use crate::shared::MIX_BUDGET_WASM;
        let mut kept = Vec::new();
        render_saw(
            255,
            (BEND_DOWN, 0.6),
            8.0,
            3.0,
            512,
            128,
            |frame, voice, shared| {
                if frame == 128 {
                    assert!(shared.take_build(128.0, MIX_BUDGET_WASM - 4096.0 * (8.0 + 7.0 * 1.5)));
                }
                if frame == 256 {
                    kept = (0..8).map(|v| voice.kept_mix(0, v)).collect();
                }
                true
            },
        );
        assert_eq!(kept.len(), 8);
        assert!(
            kept.iter()
                .all(|mix| mix.is_some_and(|(_, _, _, warp)| warp.is_some())),
            "{kept:?}"
        );
    }

    // the difference of `b` from `a` in dB: its largest under the peak of `a`, its RMS under the RMS of `a`
    fn difference_db(a: &[f32], b: &[f32]) -> (f64, f64) {
        let db = |x: f64| 20.0 * log2(x) / log2(10.0);
        let rms = |x: &mut dyn Iterator<Item = f64>| {
            let (sum, n) = x.fold((0.0, 0.0), |(sum, n), v| (sum + v * v, n + 1.0));
            (sum / n).sqrt()
        };
        let (peak, difference) = peak_and_difference(a, b);
        let signal = rms(&mut a.iter().map(|v| *v as f64));
        let residue = rms(&mut a.iter().zip(b).map(|(x, y)| *x as f64 - *y as f64));
        (db(difference / peak), db(residue / signal))
    }

    #[test]
    fn a_warped_mix_plays_as_the_voice_read_directly() {
        // a still bend of a < 0 on a saw as the store lays it out (unison 3, each voice its own pitch), against the
        // same refused every build: the bits of before until its first steady block, then its table, as long as the
        // level of its pitch, read linearly between the samples of the voice read directly. The largest difference
        // at the jump of the saw under its peak, its RMS under the RMS of the voice (dB): a middle pitch (2048 samples
        // of 50 harmonics the level) 59.0 and 73.4, Bend +/- 61.3 and 73.7, Bend - at 0.2 60.5 and 75.6, at 1 (its wrap 9
        // times as steep) 51.7 and 67.1, a high pitch 60.9 and 66.2, a higher one 83.1 and 87.9; its level of 4096
        // samples (low notes: 149 Hz of 255 harmonics, 30 Hz of them, 55 Hz of 1023) 58.6 and 73.7, 32.4 and 53.8, 44.2
        // and 62.6 (a droop over 15 kHz)
        let cases = [
            (255, (BEND_DOWN, 0.6), 7.69, -58.0, -72.0),
            (255, (BEND_BOTH, 0.9), 7.69, -60.0, -72.0),
            (255, (BEND_DOWN, 0.2), 7.69, -59.5, -74.0),
            (255, (BEND_DOWN, 1.0), 7.69, -50.5, -66.0),
            (255, (BEND_DOWN, 0.8), 12.4, -60.0, -65.0),
            (255, (BEND_DOWN, 0.6), 18.0, -82.0, -86.0),
            (255, (BEND_DOWN, 0.6), 3.0, -57.5, -72.5),
            (255, (BEND_DOWN, 0.6), -3.9, -31.0, -52.5),
            (1023, (BEND_DOWN, 0.6), 4.7, -43.0, -61.5),
        ];
        for (harmonics, warp, x, largest_db, rms_db) in cases {
            let (table, direct) = with_and_without_builds(harmonics, warp, 3.0, x, 2048, |_, _| ());
            assert_eq!(table[..128], direct[..128]);
            assert!(table[128..] != direct[128..], "{warp:?} at {x}: no warped mix");
            let (largest, rms) = difference_db(&direct, &table);
            assert!(
                largest < largest_db && rms < rms_db,
                "{warp:?} at {x} of {harmonics}: {largest} dB, RMS {rms} dB"
            );
        }
    }

    #[test]
    fn a_voice_goes_from_its_warped_mix_to_directly_and_back_without_a_step() {
        // its warped mix from block 1, its knob moved at 1024 (directly while the one-pole moves it), on its warped
        // mix of the new knob once there (0.6 to 0.7 within 1e-7 in 12.7 time constants: 6900 samples, from 8704):
        // against the voice read directly all along within 57.0 dB of its peak (the linear read of a table), the
        // difference at either change of what it reads stepping by 114 to 143 dB under it: no step
        let knob = |frame: usize, voice: &mut Voice| {
            if frame == 1024 {
                voice.set_knobs(WARP, &[BEND_DOWN as f64, 0.7, 0.0, 0.0]);
            }
        };
        let (table, direct) = with_and_without_builds(255, (BEND_DOWN, 0.6), 1.0, 7.69, 12288, knob);
        let (peak, difference) = peak_and_difference(&direct, &table);
        assert!(difference < 1.5e-3 * peak, "{difference} of {peak}");
        // (the voice on its warped mix before 1024, directly after it, on its warped mix again by the end)
        assert!(table[512..1024] != direct[512..1024]);
        assert_eq!(table[1024..4096], direct[1024..4096]);
        assert!(table[11264..] != direct[11264..]);
        let d: Vec<f64> = table
            .iter()
            .zip(&direct)
            .map(|(a, b)| *a as f64 - *b as f64)
            .collect();
        let back = (4096..12288)
            .find(|&i| d[i] != 0.0)
            .expect("its warped mix again");
        assert_eq!(back % 128, 0);
        for change in [128, 1024, back] {
            let step = (d[change] - d[change - 1]).abs();
            assert!(step < 1e-5 * peak, "{change}: {step} of {peak}");
        }
    }

    #[test]
    fn a_warped_mix_and_a_mix_of_no_warp_never_play_for_each_other() {
        // a new mode on the same version keeps the mixes: from the first steady block after the crossfade (512..992:
        // the block after it reads the levels of the new mode, 1152) the voice in the new mode plays the bits of one
        // that played it from the start (its own table built again), never the table of the other
        let switched = |from: (u32, f64), to: (u32, f64)| {
            let mut kept = None;
            let out = play(
                from,
                1.0,
                |_| pitch_x(0.9).0,
                2048,
                128,
                |frame, voice: &mut Voice| {
                    if frame == 512 {
                        voice.set_knobs(WARP, &[to.0 as f64, to.1, 0.0, 0.0]);
                    } else if frame == 1920 {
                        kept = voice.kept_mix(0, 0);
                    }
                },
            );
            (out, kept)
        };
        let (bend_up, bend_down) = ((BEND_UP, 0.6), (BEND_DOWN, 0.6));
        for (from, to) in [(bend_up, bend_down), (bend_down, bend_up)] {
            let (out, kept) = switched(from, to);
            let alone = play(to, 1.0, |_| pitch_x(0.9).0, 2048, 128, |_, _| ());
            assert_eq!(out[1152..], alone[1152..], "{from:?} to {to:?}");
            assert_eq!(
                kept.is_some_and(|(_, _, _, warp)| warp.is_some()),
                to == bend_down
            );
        }
    }

    #[test]
    fn a_warped_mix_without_memory_for_it_leaves_the_voice_read_directly() {
        // (the first block allocates the buffers of the shared; no other block has memory)
        let without = render_saw(255, (BEND_DOWN, 0.6), 3.0, 7.69, 2048, 128, |frame, _, _| {
            frame == 0
        });
        let (_, direct) = with_and_without_builds(255, (BEND_DOWN, 0.6), 3.0, 7.69, 2048, |_, _| ());
        assert_eq!(without, direct);
    }

    #[test]
    fn a_knob_event_moves_the_warp_through_a_one_pole() {
        // the knob at once, the warp the voices read after it through the one-pole of warp::SMOOTHING: at the start of
        // each block where the one-pole of a still input is, still at its knob once there (then the bits of a voice
        // that had that knob all along)
        let tau = warp::SMOOTHING * RATE;
        let mut seen = Vec::new();
        let event = |frame: usize, voice: &mut Voice| {
            if frame == 256 {
                voice.set_knobs(WARP, &[BEND_UP as f64, 0.8, 0.0, 0.0]);
            }
            seen.push((frame, voice.warp_smoothed(0)));
        };
        let moved = play((BEND_UP, 0.2), 1.0, still, 12288, 128, event);
        let (before, after) = (
            play((BEND_UP, 0.2), 1.0, still, 12288, 128, |_, _| ()),
            play((BEND_UP, 0.8), 1.0, still, 12288, 128, |_, _| ()),
        );
        assert_eq!(moved[..256], before[..256]);
        // (the knobs as the voice has them: f32)
        let (from, to) = (0.2f32 as f64, 0.8f32 as f64);
        for (frame, smoothed) in seen.into_iter().skip(1) {
            let expected = if frame <= 256 {
                from
            } else {
                to - (to - from) * exp(-((frame - 256) as f64) / tau)
            };
            if (expected - to).abs() >= 1e-7 {
                assert!(
                    (smoothed - expected).abs() < 1e-12,
                    "{frame}: {smoothed} against {expected}"
                );
            } else {
                assert_eq!(smoothed, to, "{frame}");
            }
        }
        assert!(moved[300..1200]
            .iter()
            .zip(&after[300..1200])
            .any(|(a, b)| (a - b).abs() > 1e-4));
        assert_eq!(moved[9216..], after[9216..]);
    }

    #[test]
    fn a_note_starts_at_its_knob_and_off_forgets_the_one_pole() {
        // the first block of a note at its knob (no glide from 0); a mode Off reads none: a mode after it starts at
        // the knob it has then
        let mut seen = Vec::new();
        let event = |frame: usize, voice: &mut Voice| {
            if frame == 512 {
                voice.set_knobs(WARP, &[OFF as f64, 0.9, 0.0, 0.0]);
            } else if frame == 1536 {
                voice.set_knobs(WARP, &[PWM as f64, 0.9, 0.0, 0.0]);
            }
            seen.push((frame, voice.warp_smoothed(0)));
        };
        play((BEND_DOWN, 0.6), 1.0, still, 2048, 128, event);
        // (before a block: 128 the first block's)
        assert_eq!(seen[1], (128, 0.6f32 as f64));
        // (Off from the block after the crossfade of 480 samples: none)
        assert!(seen
            .iter()
            .any(|(frame, x)| *frame > 1024 && *frame <= 1536 && x.is_nan()));
        assert_eq!(seen.last(), Some(&(1920, 0.9f32 as f64)));
    }
}
