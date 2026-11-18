//! The engine: the whole path of the sound in one core. The voices of the node (wavetable-osc: the scope, the
//! store of the tables, what the voices share) render their sum straight into the input of the chain (the
//! effects, the master, the limiter), no copy between them and one call a block.
//!
//! The C ABI of both halves is in this module as it was in theirs (`osc_*`, `chain_*`, `unit_*`: the events, the
//! tables, the reports; a voice or an effect alone for the specs and the benches). `engine_*` is the block:
//! engine_new of a scope, its store and shared and a chain (it owns none of them), engine_process renders the
//! block the chain reserved (chain_buffers) and tells what there is to read after it (`VOICES`: osc_scope_reports,
//! `STAGES`: chain_reports, `FREED`: the bytes the store freed), so a block with nothing to tell is one call.
//!
//! A trap is of the half it was in (`phase`, in memory before each): engine_fail ends the voice that trapped or
//! drops the effect, engine_resume finishes the block. A trap of the voices that is in no voice leaves the block
//! without them (the chain renders on: its tails sound); one of the chain that is in no stage is the end of the
//! node (engine_fail 0)

#![cfg_attr(target_arch = "wasm32", no_std)]

extern crate alloc;

use alloc::boxed::Box;
use core::sync::atomic::{compiler_fence, Ordering};
use wasm_rt as _;

// (the exports of the halves are those of this module)
pub use chain;
pub use wavetable_osc;

use chain::chain::Chain;
use wavetable_osc::scope::Scope;
use wavetable_osc::shared::Shared;
use wavetable_osc::store::Store;

#[cfg(test)]
mod tests;

/// what there is to read after a block: the voices that started or ended, the stages that failed, the bytes the
/// store freed
pub const VOICES: u32 = 1;
pub const STAGES: u32 = 2;
pub const FREED: u32 = 4;

// the half a block is in: the voices render, the voices are over without their sum (a trap in none of them) and
// the chain has not begun, the chain renders, the block is over
const IN_VOICES: u32 = 0;
const VOICELESS: u32 = 1;
const IN_CHAIN: u32 = 2;
const OVER: u32 = 3;

/// what engine_fail tells: the node is over, the block goes on without what trapped (a voice, an effect), the
/// block goes on without the voices
pub const BROKEN: u32 = 0;
pub const DROPPED: u32 = 1;
pub const SILENCED: u32 = 2;

pub struct Engine {
    scope: *mut Scope,
    store: *mut Store,
    shared: *mut Shared,
    chain: *mut Chain,
    frame: f64,
    phase: u32,
    // the voices trap before any of them renders (the tests)
    #[cfg(test)]
    pub trap: bool,
}

impl Engine {
    /// # Safety
    /// the four come from their constructors and outlive the engine, no one else calls them while a block renders
    pub unsafe fn new(
        scope: *mut Scope,
        store: *mut Store,
        shared: *mut Shared,
        chain: *mut Chain,
    ) -> Engine {
        Engine {
            scope,
            store,
            shared,
            chain,
            frame: 0.0,
            phase: OVER,
            #[cfg(test)]
            trap: false,
        }
    }

    // the block is in `phase` from now on: in memory before the call that may trap
    #[inline(always)]
    fn at(&mut self, phase: u32) {
        self.phase = phase;
        compiler_fence(Ordering::SeqCst);
    }

    /// the block the chain reserved, at `frame`: the voices into its input, then the chain. What there is to read
    ///
    /// # Safety
    /// as `new`; the chain has its block reserved
    pub unsafe fn process(&mut self, frame: f64) -> u32 {
        self.frame = frame;
        self.at(IN_VOICES);
        let chain = &mut *self.chain;
        let (frames, input) = (chain.frames(), chain.input());
        #[cfg(test)]
        if core::mem::take(&mut self.trap) {
            panic!("a trap of the tests");
        }
        (*self.scope).process_into(frame, frames, input, &mut *self.store, &mut *self.shared);
        self.play()
    }

    // the chain on what the voices left in its input (nothing of them in it: it is told so, not made to look)
    unsafe fn play(&mut self) -> u32 {
        let silent = !(*self.scope).mixed;
        self.at(IN_CHAIN);
        (*self.chain).process_fed(self.frame, silent);
        self.over()
    }

    unsafe fn over(&mut self) -> u32 {
        self.at(OVER);
        let scope = &*self.scope;
        let mut flags = 0;
        if !scope.started.is_empty() || !scope.ended.is_empty() {
            flags |= VOICES;
        }
        if (*self.chain).reported() {
            flags |= STAGES;
        }
        if (*self.store).freed_bytes != 0.0 {
            flags |= FREED;
        }
        flags
    }

    /// after a trap of `process` or `resume`: `DROPPED` (the voice that trapped ended, those filtered with it too;
    /// or the effect is out of its slot), `SILENCED` (the voices trapped in no voice: the block has none of
    /// them), `BROKEN` (the chain trapped in no stage)
    ///
    /// # Safety
    /// as `new`
    pub unsafe fn fail(&mut self) -> u32 {
        match self.phase {
            IN_VOICES => {
                if (*self.scope).fail(&mut *self.store, &mut *self.shared) {
                    return DROPPED;
                }
                self.at(VOICELESS);
                let chain = &mut *self.chain;
                core::slice::from_raw_parts_mut(chain.input(), 2 * chain.frames()).fill(0.0);
                (*self.scope).mixed = false;
                SILENCED
            }
            IN_CHAIN if (*self.chain).fail() => DROPPED,
            _ => BROKEN,
        }
    }

    /// the rest of the block after `fail`. What there is to read
    ///
    /// # Safety
    /// as `process`
    pub unsafe fn resume(&mut self) -> u32 {
        match self.phase {
            IN_VOICES => {
                (*self.scope).resume(&mut *self.store, &mut *self.shared);
                self.play()
            }
            VOICELESS => self.play(),
            IN_CHAIN => {
                (*self.chain).resume();
                self.over()
            }
            _ => self.over(),
        }
    }
}

/// an engine of a scope, its store and shared and a chain: it renders them, they stay their owner's
///
/// # Safety
/// the four come from their constructors and are freed after the engine
#[no_mangle]
pub unsafe extern "C" fn engine_new(
    scope: *mut Scope,
    store: *mut Store,
    shared: *mut Shared,
    chain: *mut Chain,
) -> *mut Engine {
    Box::into_raw(Box::new(Engine::new(scope, store, shared, chain)))
}

/// # Safety
/// `engine` comes from engine_new and was not freed
#[no_mangle]
pub unsafe extern "C" fn engine_free(engine: *mut Engine) {
    drop(Box::from_raw(engine));
}

/// the block the chain reserved (chain_buffers: the output there), at `frame` of the context. The bits of what
/// there is to read: `VOICES`, `STAGES`, `FREED`
///
/// # Safety
/// `engine` comes from engine_new and was not freed, the chain has its block reserved
#[no_mangle]
pub unsafe extern "C" fn engine_process(engine: *mut Engine, frame: f64) -> u32 {
    (*engine).process(frame)
}

/// after a trap of engine_process or engine_resume (the stack pointer put back): `BROKEN`, `DROPPED` or `SILENCED`
///
/// # Safety
/// `engine` comes from engine_new and was not freed
#[no_mangle]
pub unsafe extern "C" fn engine_fail(engine: *mut Engine) -> u32 {
    (*engine).fail()
}

/// the rest of the block after engine_fail, what there is to read as engine_process tells it
///
/// # Safety
/// `engine` comes from engine_new and was not freed
#[no_mangle]
pub unsafe extern "C" fn engine_resume(engine: *mut Engine) -> u32 {
    (*engine).resume()
}
