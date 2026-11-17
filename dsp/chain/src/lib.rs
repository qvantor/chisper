//! The chain: everything after the voices in one core. The effects in their slots, the master gain and the
//! limiter (the crates of the effects are its units, `units`).
//!
//! The C ABI, numbers in and out, blocks in the memory of the core (chain-wasm.ts wraps it). `unit_*` is one
//! effect alone, as the specs, the benches and a render at another rate (the limiter) drive it: unit_new of a
//! kind, unit_buffers reserves a block of `frames` (inL, inR, outL, outR one after another), unit_process renders
//! it, unit_set changes params, unit_clear forgets the sound before. Params come through unit_command.
//!
//! `chain_*` is the whole of it, the same for a worklet and for a render on the main thread: chain_new (the
//! params of every slot in the command buffer), chain_buffers reserves a block as unit_buffers does,
//! chain_process renders it at a frame; chain_event queues an event with its time (the command buffer: its kind,
//! a, b, values); the routes, the last note and the LFOs come through the scratch of the chain (chain_scratch);
//! chain_fail and chain_resume after a trap, chain_reports what failed, chain_retry makes it again

#![cfg_attr(target_arch = "wasm32", no_std)]

extern crate alloc;

use alloc::boxed::Box;
use wasm_rt as _;

use dsp_core::io::StereoIo;

pub mod chain;
pub mod delay;
pub mod modulation;
pub mod units;

#[cfg(test)]
mod tests;

use chain::{Chain, Event};
use modulation::{LFO_STATE, NOTE, ROUTE};
use units::{Unit, MAX_METER, MAX_PARAMS, SLOTS};

/// an effect alone with the buffers of its blocks
pub struct UnitIo {
    unit: Unit,
    io: StereoIo,
}

/// the values of the command buffer: the params of every slot of chain_new
pub const COMMAND_LENGTH: usize = SLOTS * MAX_PARAMS;

// the params of unit_new ([active, ...params]) and of unit_set ([the bits of the keys it changes (1 << key),
// ...params]) in the order of the keys of the kind, written by the JS wrapper; unit_meter writes what it shows
// into its first values
static mut COMMAND: [f64; COMMAND_LENGTH] = [0.0; COMMAND_LENGTH];

fn command() -> (f64, [f64; MAX_PARAMS]) {
    // SAFETY: one thread (the audio thread of the scope); the wrapper writes it right before the call reading it
    let command = unsafe { *core::ptr::addr_of!(COMMAND) };
    (command[0], core::array::from_fn(|key| command[1 + key]))
}

/// the buffer the wrapper writes the params of unit_new and unit_set into
#[no_mangle]
pub extern "C" fn unit_command() -> *mut f64 {
    core::ptr::addr_of_mut!(COMMAND) as *mut f64
}

/// an effect of `kind` (`units`) at a rate, its options in the command buffer: active, then the params. Null
/// for a kind no one knows
#[no_mangle]
pub extern "C" fn unit_new(kind: u32, sample_rate: f64) -> *mut UnitIo {
    let (active, params) = command();
    match Unit::new(kind, sample_rate, &params, active != 0.0) {
        Some(unit) => Box::into_raw(Box::new(UnitIo {
            unit,
            io: StereoIo::default(),
        })),
        None => core::ptr::null_mut(),
    }
}

/// # Safety
/// `unit` comes from unit_new and was not freed
#[no_mangle]
pub unsafe extern "C" fn unit_free(unit: *mut UnitIo) {
    drop(Box::from_raw(unit));
}

/// room for a block of `frames`: the address of inL, inR, outL and outR one after another
///
/// # Safety
/// `unit` comes from unit_new and was not freed
#[no_mangle]
pub unsafe extern "C" fn unit_buffers(unit: *mut UnitIo, frames: usize) -> *mut f32 {
    let unit = &mut *unit;
    // the block buffers grow here, not while it renders
    unit.unit.grow(frames);
    unit.io.reserve(frames)
}

/// # Safety
/// `unit` comes from unit_new and was not freed, its buffers reserved for the block
#[no_mangle]
pub unsafe extern "C" fn unit_process(unit: *mut UnitIo) {
    let UnitIo { unit, io } = &mut *unit;
    if unit.guards_input() {
        io.finite_inputs();
    }
    let (in_l, in_r, out_l, out_r) = io.split();
    unit.process(in_l, in_r, out_l, out_r);
}

/// the params that changed, in the command buffer; `routed`: a route moves them
///
/// # Safety
/// `unit` comes from unit_new and was not freed
#[no_mangle]
pub unsafe extern "C" fn unit_set(unit: *mut UnitIo, routed: bool) {
    let (present, values) = command();
    (*unit).unit.set(present as u32, &values, routed);
}

/// # Safety
/// `unit` comes from unit_new and was not freed
#[no_mangle]
pub unsafe extern "C" fn unit_set_active(unit: *mut UnitIo, active: bool) {
    (*unit).unit.set_active(active);
}

/// # Safety
/// `unit` comes from unit_new and was not freed
#[no_mangle]
pub unsafe extern "C" fn unit_clear(unit: *mut UnitIo) {
    (*unit).unit.forget();
}

/// # Safety
/// `unit` comes from unit_new and was not freed
#[no_mangle]
pub unsafe extern "C" fn unit_idle(unit: *mut UnitIo) -> bool {
    (*unit).unit.idle()
}

/// # Safety
/// `unit` comes from unit_new and was not freed
#[no_mangle]
pub unsafe extern "C" fn unit_latency(unit: *mut UnitIo) -> usize {
    (*unit).unit.latency()
}

/// the meter into the command buffer (`Unit::meter`): how many values it wrote
///
/// # Safety
/// `unit` comes from unit_new and was not freed
#[no_mangle]
pub unsafe extern "C" fn unit_meter(unit: *mut UnitIo) -> usize {
    let mut values = [0.0; MAX_METER];
    let count = (*unit).unit.meter(&mut values);
    let command = core::ptr::addr_of_mut!(COMMAND) as *mut f64;
    for (k, value) in values.iter().enumerate().take(count) {
        *command.add(k) = *value;
    }
    count
}

/// a chain at a rate, the params of its slots in the command buffer (MAX_PARAMS of each kind, one after another);
/// `limited` (not 0): with the limiter
#[no_mangle]
pub extern "C" fn chain_new(sample_rate: f64, limited: u32) -> *mut Chain {
    // SAFETY: one thread; the wrapper writes it right before the call reading it
    let command = unsafe { *core::ptr::addr_of!(COMMAND) };
    let params: [[f64; MAX_PARAMS]; SLOTS] =
        core::array::from_fn(|kind| core::array::from_fn(|key| command[kind * MAX_PARAMS + key]));
    Box::into_raw(Box::new(Chain::new(sample_rate, &params, limited != 0)))
}

/// # Safety
/// `chain` comes from chain_new and was not freed
#[no_mangle]
pub unsafe extern "C" fn chain_free(chain: *mut Chain) {
    drop(Box::from_raw(chain));
}

/// room for a block of `frames`: the address of inL, inR, outL and outR one after another
///
/// # Safety
/// `chain` comes from chain_new and was not freed
#[no_mangle]
pub unsafe extern "C" fn chain_buffers(chain: *mut Chain, frames: usize) -> *mut f32 {
    (*chain).reserve(frames)
}

/// the block reserved, at `frame` of the context
///
/// # Safety
/// `chain` comes from chain_new and was not freed, its buffers reserved for the block
#[no_mangle]
pub unsafe extern "C" fn chain_process(chain: *mut Chain, frame: f64) {
    (*chain).process(frame);
}

/// after a trap of chain_process or chain_resume (the stack pointer put back): the stage that trapped is dropped.
/// 0: the trap was not in a stage
///
/// # Safety
/// `chain` comes from chain_new and was not freed
#[no_mangle]
pub unsafe extern "C" fn chain_fail(chain: *mut Chain) -> u32 {
    (*chain).fail() as u32
}

/// the rest of the block after chain_fail
///
/// # Safety
/// `chain` comes from chain_new and was not freed
#[no_mangle]
pub unsafe extern "C" fn chain_resume(chain: *mut Chain) {
    (*chain).resume();
}

/// the stages that failed since the last call: the bit of each (a slot by its kind, then the limiter)
///
/// # Safety
/// `chain` comes from chain_new and was not freed
#[no_mangle]
pub unsafe extern "C" fn chain_reports(chain: *mut Chain) -> u32 {
    (*chain).take_reports()
}

/// the unit of a stage that failed made again
///
/// # Safety
/// `chain` comes from chain_new and was not freed
#[no_mangle]
pub unsafe extern "C" fn chain_retry(chain: *mut Chain, stage: u32) {
    (*chain).retry(stage);
}

/// an event from frame `at` on, in the command buffer: its kind (`chain::SET_PARAMS`…), a, b, then MAX_PARAMS
/// values
///
/// # Safety
/// `chain` comes from chain_new and was not freed
#[no_mangle]
pub unsafe extern "C" fn chain_event(chain: *mut Chain, at: f64) {
    let command = *core::ptr::addr_of!(COMMAND);
    (*chain).push(Event {
        at,
        kind: command[0] as u32,
        a: command[1],
        b: command[2],
        values: core::array::from_fn(|key| command[3 + key]),
    });
}

/// room for `length` values of the routes, a note or the LFOs
///
/// # Safety
/// `chain` comes from chain_new and was not freed
#[no_mangle]
pub unsafe extern "C" fn chain_scratch(chain: *mut Chain, length: usize) -> *mut f64 {
    (*chain).scratch(length)
}

/// the routes of the knobs, `count` of them in the scratch (`modulation::ROUTE` values each), at once
///
/// # Safety
/// `chain` comes from chain_new and was not freed
#[no_mangle]
pub unsafe extern "C" fn chain_routes(chain: *mut Chain, count: usize) {
    let (modulation, values) = (*chain).written(count * ROUTE);
    modulation.set_routes(values);
}

/// the last note in the scratch (`modulation::NOTE` values), taken at its start; `present` 0: none
///
/// # Safety
/// `chain` comes from chain_new and was not freed
#[no_mangle]
pub unsafe extern "C" fn chain_note(chain: *mut Chain, present: u32) {
    let (modulation, values) = (*chain).written(NOTE);
    modulation.set_note(present != 0, values);
}

/// the levels of a new shape of LFO `lfo` in the scratch (2049 within 0..1): the next state that has a new shape
/// for it takes them
///
/// # Safety
/// `chain` comes from chain_new and was not freed
#[no_mangle]
pub unsafe extern "C" fn chain_lfo_table(chain: *mut Chain, lfo: usize) {
    let (modulation, values) = (*chain).written(dsp_core::lfo::TABLE + 1);
    modulation.lfo_table(lfo, values);
}

/// the LFOs from `at` (seconds of the context) on, in the scratch: `modulation::LFO_STATE` values of each;
/// `instantly` (not 0): there at once
///
/// # Safety
/// `chain` comes from chain_new and was not freed
#[no_mangle]
pub unsafe extern "C" fn chain_lfos(chain: *mut Chain, at: f64, instantly: u32) {
    let (modulation, values) = (*chain).written(dsp_core::lfo::LFOS * LFO_STATE);
    modulation.set_lfos(at, instantly != 0, values);
}

/// the meter of the effect of a slot into the command buffer: how many values it wrote
///
/// # Safety
/// `chain` comes from chain_new and was not freed
#[no_mangle]
pub unsafe extern "C" fn chain_meter(chain: *mut Chain, kind: usize) -> usize {
    let mut values = [0.0; MAX_METER];
    let count = (*chain).meter(kind, &mut values);
    let command = core::ptr::addr_of_mut!(COMMAND) as *mut f64;
    for (k, value) in values.iter().enumerate().take(count) {
        *command.add(k) = *value;
    }
    count
}

/// the effect of a slot has nothing to play
///
/// # Safety
/// `chain` comes from chain_new and was not freed
#[no_mangle]
pub unsafe extern "C" fn chain_idle(chain: *mut Chain, kind: usize) -> bool {
    (*chain).idle(kind)
}

/// the samples the limiter of the chain delays the sound by
///
/// # Safety
/// `chain` comes from chain_new and was not freed
#[no_mangle]
pub unsafe extern "C" fn chain_latency(chain: *mut Chain) -> usize {
    (*chain).latency()
}

/// the stage `stage` (a slot by its kind, then the limiter) traps from now on (the specs: only the perf build has
/// it)
///
/// # Safety
/// `chain` comes from chain_new and was not freed
#[cfg(feature = "perf")]
#[no_mangle]
pub unsafe extern "C" fn chain_trap(chain: *mut Chain, stage: u32) {
    (*chain).trap(stage);
}
