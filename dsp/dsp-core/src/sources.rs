//! The sources of the routes by index, in the voices and in the chain alike (MOD_SOURCES of the app: only appended
//! to): ENV 1–3, VELO (the velocity of the note), LFO 1–4, MACRO 1–4

use crate::lfo::LFOS;
use crate::macros::MACROS;

pub const ENVELOPES: usize = 3;
pub const VELO: usize = ENVELOPES;
pub const LFO_SOURCE: usize = VELO + 1;
pub const MACRO_SOURCE: usize = LFO_SOURCE + LFOS;
pub const SOURCES: usize = MACRO_SOURCE + MACROS;

/// source `k` is an LFO
pub const fn is_lfo(k: usize) -> bool {
    k >= LFO_SOURCE && k < MACRO_SOURCE
}

/// source `k` is a macro
pub const fn is_macro(k: usize) -> bool {
    k >= MACRO_SOURCE && k < SOURCES
}
