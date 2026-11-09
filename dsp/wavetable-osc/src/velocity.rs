//! The velocity of a voice: its VELO level (a source of the routes, after the envelopes) and its amp (the volume
//! after ENV 1, 1 − Amp + Amp · level), both read at the note on and constant for it, but for a glide of
//! ROUTE_GLIDE to the velocity of a note that takes the voice over (mono)

use crate::envelope::EnvelopeBlock;
use crate::glided::{glide_length, Glided};
use alloc::vec::Vec;

/// VoiceVelocity: the level of VELO (the curve of the velocity of the note) and the amp of the voice
#[derive(Clone, Copy, Debug)]
pub struct VoiceVelocity {
    pub level: f64,
    pub amp: f64,
}

impl Default for VoiceVelocity {
    // a voice without a velocity: no VELO (no route reads it), its volume ENV 1 alone
    fn default() -> VoiceVelocity {
        VoiceVelocity { level: 0.0, amp: 1.0 }
    }
}

pub struct Velocity {
    pub level: Glided,
    pub amp: Glided,
    glide: f64,
}

impl Velocity {
    pub fn new(sample_rate: f64, velocity: VoiceVelocity) -> Velocity {
        Velocity {
            level: Glided::new(velocity.level),
            amp: Glided::new(velocity.amp),
            glide: glide_length(sample_rate),
        }
    }

    /// a note took the voice over: both glide to its velocity
    pub fn set(&mut self, velocity: VoiceVelocity) {
        self.level.glide(velocity.level, self.glide);
        self.amp.glide(velocity.amp, self.glide);
    }

    pub fn render(&mut self, a: usize, b: usize) {
        self.level.render(a, b);
        self.amp.render(a, b);
    }
}

// the velocities that wait at most: the notes of the track are sent 50 ms ahead (a 1/64 triplet at 300 BPM is 8 ms)
const PENDING: usize = 16;

/// the velocities notes take a voice over with (mono), each from the frame of its time: the notes of the track are
/// sent ahead of their times, several may wait. By their frames; one sent replaces those that wait from its frame on
/// (the one sent last is the voice's at last, as the main thread holds it); PENDING at most, the earliest goes past
/// them. No allocation after `default`
pub struct PendingVelocities {
    queue: Vec<(f64, VoiceVelocity)>,
}

impl Default for PendingVelocities {
    fn default() -> PendingVelocities {
        PendingVelocities {
            queue: Vec::with_capacity(PENDING),
        }
    }
}

impl PendingVelocities {
    /// `velocity` from `frame` on
    pub fn push(&mut self, frame: f64, velocity: VoiceVelocity) {
        self.queue.retain(|&(at, _)| at < frame);
        if self.queue.len() == PENDING {
            self.queue.remove(0);
        }
        self.queue.push((frame, velocity));
    }

    /// the last of those whose frame a block starting at `frame` has reached (they go); none when none has
    pub fn take(&mut self, frame: f64) -> Option<VoiceVelocity> {
        let due = self.queue.iter().take_while(|&&(at, _)| at <= frame).count();
        if due == 0 {
            return None;
        }
        let (_, velocity) = self.queue[due - 1];
        self.queue.drain(..due);
        Some(velocity)
    }
}

/// the volume of a voice in a block: ENV 1 × the amp of its velocity, one pass over the output. Each of them one
/// value (their product in `gain`) or per sample; at an amp of 1 every product is ENV 1, to the bit
#[derive(Clone, Copy)]
pub struct Volume<'a> {
    pub gain: f64,
    env: Option<&'a [f32]>,
    amp: Option<&'a [f32]>,
}

impl<'a> Volume<'a> {
    /// of a block from `a` (ENV 1 and the amp rendered)
    pub fn new(env: &'a EnvelopeBlock, amp: &'a Glided, a: usize) -> Volume<'a> {
        let (gain, env) = if env.constant {
            (env.values[a] as f64, None)
        } else {
            (1.0, Some(env.values.as_slice()))
        };
        let (gain, amp) = if amp.constant {
            (gain * amp.value(), None)
        } else {
            (gain, Some(amp.values.as_slice()))
        };
        Volume { gain, env, amp }
    }

    /// one value in the block: `gain`
    pub fn constant(&self) -> bool {
        self.env.is_none() && self.amp.is_none()
    }

    #[inline(always)]
    pub fn at(&self, i: usize) -> f64 {
        match (self.env, self.amp) {
            (None, None) => self.gain,
            (Some(env), None) => env[i] as f64 * self.gain,
            (None, Some(amp)) => amp[i] as f64 * self.gain,
            (Some(env), Some(amp)) => env[i] as f64 * amp[i] as f64 * self.gain,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_velocity_is_flat_and_glides_to_another_one_in_10_ms() {
        let mut velocity = Velocity::new(48000.0, VoiceVelocity { level: 0.5, amp: 1.0 });
        velocity.render(0, 128);
        assert_eq!((velocity.amp.constant, velocity.amp.value()), (true, 1.0));
        assert!(velocity.level.constant);
        assert_eq!((velocity.level.value(), velocity.level.gliding()), (0.5, false));

        velocity.set(VoiceVelocity {
            level: 1.0,
            amp: 0.25,
        });
        velocity.render(0, 128);
        assert!(!velocity.amp.constant && !velocity.level.constant);
        assert!(velocity.level.gliding());
        // 480 samples from 0.5 to 1: 1/960 a sample
        assert_eq!(velocity.level.values[0] as f64, 0.5);
        assert_eq!(
            velocity.level.values[96] as f64,
            (0.5 + 96.0 / 960.0) as f32 as f64
        );
        assert_eq!(
            velocity.amp.values[127] as f64,
            (1.0 - 0.75 * 127.0 / 480.0) as f32 as f64
        );
        // the rest of the 480 samples, then there
        for _ in 0..3 {
            velocity.render(0, 128);
        }
        assert_eq!(velocity.level.values[127] as f64, 1.0);
        assert_eq!(velocity.amp.values[127] as f64, 0.25);
        velocity.render(0, 128);
        assert!(velocity.level.constant && velocity.amp.constant);
        assert_eq!((velocity.level.value(), velocity.amp.value()), (1.0, 0.25));
    }

    fn velocity(level: f64) -> VoiceVelocity {
        VoiceVelocity { level, amp: 1.0 }
    }

    fn level(taken: Option<VoiceVelocity>) -> Option<f64> {
        taken.map(|velocity| velocity.level)
    }

    #[test]
    fn velocities_sent_ahead_wait_each_for_its_frame() {
        let mut pending = PendingVelocities::default();
        pending.push(1024.0, velocity(0.25));
        pending.push(2048.0, velocity(0.5));
        assert_eq!(level(pending.take(896.0)), None);
        assert_eq!(level(pending.take(1024.0)), Some(0.25));
        assert_eq!(level(pending.take(1152.0)), None);
        assert_eq!(level(pending.take(2048.0)), Some(0.5));
        assert_eq!(level(pending.take(4096.0)), None);
    }

    #[test]
    fn of_those_a_block_has_reached_the_last_is_taken() {
        let mut pending = PendingVelocities::default();
        pending.push(1000.0, velocity(0.25));
        pending.push(1010.0, velocity(0.5));
        pending.push(2048.0, velocity(0.75));
        assert_eq!(level(pending.take(1024.0)), Some(0.5));
        assert_eq!(level(pending.take(2048.0)), Some(0.75));
    }

    #[test]
    fn a_velocity_replaces_those_that_wait_from_its_frame_on() {
        let mut pending = PendingVelocities::default();
        pending.push(1024.0, velocity(0.25));
        pending.push(2048.0, velocity(0.5));
        // now (a note of the keys): the one sent last is the voice's at last
        pending.push(0.0, velocity(0.75));
        assert_eq!(level(pending.take(128.0)), Some(0.75));
        assert_eq!(level(pending.take(4096.0)), None);
        // at the same frame: the one sent later
        pending.push(1024.0, velocity(0.25));
        pending.push(1024.0, velocity(0.5));
        assert_eq!(level(pending.take(1024.0)), Some(0.5));
    }

    #[test]
    fn past_pending_the_earliest_goes_without_an_allocation() {
        let mut pending = PendingVelocities::default();
        let capacity = pending.queue.capacity();
        for i in 0..=PENDING {
            pending.push(1000.0 + i as f64, velocity(i as f64));
        }
        assert_eq!(pending.queue.len(), PENDING);
        assert_eq!(pending.queue.capacity(), capacity);
        assert_eq!(pending.queue[0].1.level, 1.0);
        assert_eq!(level(pending.take(1000.0)), None);
        assert_eq!(level(pending.take(1001.0)), Some(1.0));
    }

    #[test]
    fn a_glide_to_the_same_velocity_moves_nothing() {
        let mut velocity = Velocity::new(48000.0, VoiceVelocity::default());
        velocity.set(VoiceVelocity::default());
        velocity.render(0, 128);
        assert!(velocity.amp.constant && velocity.level.constant);
        assert_eq!(velocity.amp.value(), 1.0);
    }
}
