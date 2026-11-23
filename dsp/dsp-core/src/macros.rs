//! The macros of a node (MACRO 1–4): a level within 0..1 each, which the routes of its voices and of its chain read
//! as a source (MOD_SOURCES of the app: 8–11, after the LFOs). A new level glides there linearly in ROUTE_GLIDE (a
//! knob turned is no step; linear: the same bits everywhere), one sent `instantly` is there at once (a node made
//! again)

use crate::glided::Glided;
use jsmath::{max, min, round};

pub const MACROS: usize = 4;

/// the MACROS levels of `values` (one past them is not a number: its macro as it is)
pub fn levels_of(values: &[f64]) -> [f64; MACROS] {
    core::array::from_fn(|k| values.get(k).copied().unwrap_or(f64::NAN))
}

pub struct Macros {
    pub levels: [Glided; MACROS],
    // the frame of the block rendered last (NaN: none yet) and its samples
    at: f64,
    frames: usize,
    // none glides and each is one value: a block renders none of them (a level set renders them again)
    still: bool,
}

impl Default for Macros {
    fn default() -> Self {
        Macros {
            levels: core::array::from_fn(|_| Glided::new(0.0)),
            at: f64::NAN,
            frames: 0,
            still: true,
        }
    }
}

impl Macros {
    /// new levels from the next block: each glides there in `length` samples (`instantly`: there at once); a level
    /// that is not a number leaves its macro as it is, the others are within 0..1. Whether one was set
    pub fn set(&mut self, levels: &[f64; MACROS], instantly: bool, length: f64) -> bool {
        let mut set = false;
        for (glided, &level) in self.levels.iter_mut().zip(levels) {
            if level.is_nan() {
                continue;
            }
            let level = min(1.0, max(0.0, level));
            if instantly {
                glided.set(level);
            } else {
                glided.glide(level, length);
            }
            set = true;
        }
        // (one set at once may still be of a glide: one value from its next block)
        self.still &= !set;
        set
    }

    /// the levels of the block of `n` samples at `frame` (one value of each that does not glide), once a block: a
    /// call again at the same frame renders nothing (a glide takes its time)
    pub fn render(&mut self, frame: f64, n: usize) {
        if self.rendered(frame) {
            return;
        }
        self.at = frame;
        self.frames = n;
        if self.still {
            return;
        }
        for glided in self.levels.iter_mut() {
            glided.render(0, n);
        }
        self.still = self
            .levels
            .iter()
            .all(|glided| glided.constant && !glided.gliding());
    }

    /// the block at `frame` is the one rendered last
    pub fn rendered(&self, frame: f64) -> bool {
        frame == self.at
    }

    /// the level of macro `k` at sample `i` of the block rendered last (past it: where it is after the block)
    pub fn level(&self, k: usize, i: usize) -> f64 {
        let glided = &self.levels[k];
        if glided.constant || i >= self.frames {
            glided.value()
        } else {
            glided.values[i] as f64
        }
    }

    /// the level of macro `k` at `frame` (the nearest sample of the block rendered last; one before it: at its start)
    pub fn level_at(&self, k: usize, frame: f64) -> f64 {
        self.level(k, max(0.0, round(frame - self.at)) as usize)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::glided::glide_length;

    #[test]
    fn a_level_glides_there_in_10_ms_a_nan_leaves_it_one_out_of_range_is_within_0_1() {
        let length = glide_length(48000.0);
        let mut macros = Macros::default();
        assert!(macros.set(&[0.5, f64::NAN, 2.0, -1.0], false, length));
        macros.render(0.0, 128);
        assert!(!macros.levels[0].constant);
        assert_eq!(macros.level(0, 0), 0.0);
        assert_eq!(macros.level(0, 96), (0.5 * 96.0 / 480.0) as f32 as f64);
        // (NaN: as it was, 0; 2 is 1, -1 is 0)
        assert!(macros.levels[1].constant && macros.level(1, 5) == 0.0);
        assert_eq!(macros.level(2, 96), (96.0 / 480.0) as f32 as f64);
        assert!(macros.levels[3].constant);
        for block in 1..4 {
            macros.render(block as f64 * 128.0, 128);
        }
        assert_eq!(macros.level(0, 127), 0.5);
        // (once a block: the same frame again renders nothing)
        macros.render(384.0, 128);
        assert!(!macros.levels[0].constant);
        macros.render(512.0, 128);
        assert!(macros.levels[0].constant && !macros.levels[0].gliding());
        assert_eq!(macros.level(0, 64), 0.5);
        assert_eq!(macros.level(2, 64), 1.0);
        assert!(!macros.set(&[f64::NAN; MACROS], false, length));
    }

    #[test]
    fn levels_that_stand_still_render_nothing_a_new_one_glides_from_where_they_are() {
        let length = glide_length(48000.0);
        let nan = f64::NAN;
        let mut macros = Macros::default();
        assert!(macros.still);
        macros.set(&[0.5, nan, nan, nan], false, length);
        assert!(!macros.still);
        // (480 samples: over in the 4th block, one value from the 5th, a block that renders nothing after it)
        for block in 0..6 {
            macros.render(block as f64 * 128.0, 128);
        }
        assert!(macros.still && macros.rendered(640.0));
        assert_eq!(macros.level(0, 0), 0.5);
        assert_eq!(macros.level_at(0, 700.0), 0.5);
        // a level set again glides from where it is, from the next block
        macros.set(&[0.25, nan, nan, nan], false, length);
        macros.render(768.0, 128);
        assert!(!macros.still && !macros.levels[0].constant);
        assert_eq!(macros.level(0, 0), 0.5);
        assert_eq!(
            macros.level(0, 96),
            (0.5 + (0.25 - 0.5) / length * 96.0) as f32 as f64
        );
        // one set at once in a glide: one value from the next block
        macros.set(&[0.75, nan, nan, nan], true, length);
        macros.render(896.0, 128);
        assert!(macros.still && macros.levels[0].constant);
        assert_eq!(macros.level(0, 5), 0.75);
    }

    #[test]
    fn a_level_sent_instantly_is_there_at_once() {
        let mut macros = Macros::default();
        macros.set(&[0.25, 0.75, f64::NAN, 1.0], true, glide_length(44100.0));
        macros.render(0.0, 128);
        assert!(macros.levels.iter().all(|glided| glided.constant));
        assert_eq!(
            core::array::from_fn::<f64, MACROS, _>(|k| macros.level(k, 0)),
            [0.25, 0.75, 0.0, 1.0]
        );
    }
}
