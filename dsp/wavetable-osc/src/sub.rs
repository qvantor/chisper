//! The sub oscillator of a voice (VoiceSubOptions of voice-options.ts): one cycle of a shape, no unison, at the pitch
//! of the note (its frequency: the portamento; and the bend) × 2^(cents / 1200) (Octave and Coarse) plus the offset a
//! route of Coarse gives, panned, at a level, added to the bus of the voice before its filter and ENV 1. A shape is a
//! table of the store of one frame (`sub:<shape>` of the facade, built as any table: sub-shapes.ts), the sine of the
//! store for Sine. As the sub of the Audio Unit (dsp/measurements/sub.json): the level is SUB_SCALE · the knob², the
//! pan goes by the curve of the noise (PAN_CURVE: the same gains), a note starts at the phase of Phase (its shapes go
//! down from it: the sine of the store half a cycle on), with Contiguous at the phase the sub of the note started
//! last has now (still sounding) or had at its end (SubPhase of the shared), Phase aside; a mono note goes on with it.
//!
//! Its levels are read as an oscillator reads them (level_x: a level alone, the next one over the top LEVEL_BAND of
//! a third of an octave), linear between samples: the step and the level once a block while the pitch stands
//! (worked out again only when it changes; a level alone read in 0.32 fixed point: `steady`), at points SEGMENT
//! apart while it moves. Still gains and a pan of
//! 0 (no route of it) add into the centre of the bus (the filter and the output stage put it in both channels), any
//! other into a buffer of the shared (`fading`, free while the sub renders), then by the gains of each sample into
//! the left and the right. A shape whose version hasn't arrived is silent, its phase going on; the first one to
//! arrive is taken at the start of a block

use crate::lfo::frac;
use crate::noise::pan_gains;
use crate::shared::{Scratch, Shared};
use crate::source::{LevelPan, RenderCx, Source, StartCx};
use crate::store::{EntryRef, Levels, Store};
use crate::targets::{mask, target, COARSE, LEVEL, PAN, SUB};
use crate::voice::{
    advance, frame_start, level_base, level_weights, level_x, read, render11, render21, render21_same,
    span_level, Ctx, Params, FREQUENCY,
};
use alloc::{vec, vec::Vec};
use jsmath::{log2, max, min, pow};

/// the sub (a sine) at Level 1 against an oscillator at its gain 1 on a sine of amplitude 1 (sub.json `oscillator`)
pub const SUB_SCALE: f64 = 0.65747;
/// the phase of the sine of the store a sub starts at, at its phase 0: its shapes go down from 0 (sub.json `start`,
/// `cycles`), the sine of the store goes up
pub const SINE_PHASE: f64 = 0.5;
// the samples between the points of a pitch that moves (as the oscillators)
const SEGMENT: usize = 32;

/// the sub of a note at the note on (VoiceSubOptions)
#[derive(Clone, Copy, Debug)]
pub struct SubOptions {
    /// the table of its shape, None: the sine of the store
    pub table: Option<u32>,
    /// Octave and Coarse (cents)
    pub cents: f64,
    /// the share of a cycle a note starts at (Contiguous: unused)
    pub phase: f64,
    pub contiguous: bool,
    pub level: f64,
    pub pan: f64,
}

/// the knobs of the sub of a playing note (a `knobs` event): the level and the pan glide in 10 ms, the cents step
#[derive(Clone, Copy, Debug)]
pub struct SubKnobs {
    pub level: f64,
    pub pan: f64,
    pub cents: f64,
}

/// the phase of the sub of the note a node started last (`sub_serial` of the shared), at the end of the block it
/// rendered last (`frame`), its step then and whether it still sounds: the phase a note of Contiguous starts at (a
/// phase without the offset of the sine: the same shape of every table)
#[derive(Clone, Copy, Debug, Default)]
pub struct SubPhase {
    pub phase: f64,
    pub frame: f64,
    pub step: f64,
    pub running: bool,
}

impl SubPhase {
    /// its phase at `frame`: on at its step while the sub sounds, the one at its end once it stopped (back from it
    /// for a frame before)
    pub fn at(&self, frame: f64) -> f64 {
        let frames = frame - self.frame;
        let frames = if self.running { frames } else { min(0.0, frames) };
        frac(self.phase + self.step * frames)
    }
}

// the routes of the sub a block: the values of its knobs (one, or one a sample) and the offsets of its pitch (cents)
pub struct SubRoutes<'a> {
    pub level: Option<&'a [f32]>,
    pub pan: Option<&'a [f32]>,
    pub coarse: Option<&'a [f32]>,
}

// the gains of the channels at a level and a pan: SUB_SCALE · level² (within 0..1, a NaN: silent) by the pan of the
// noise
#[inline(always)]
fn gains(level: f64, pan: f64) -> (f64, f64) {
    let level = if level.is_nan() {
        0.0
    } else {
        min(1.0, max(0.0, level))
    };
    let (gl, gr) = pan_gains(pan);
    let gain = SUB_SCALE * level * level;
    (gain * gl, gain * gr)
}

// the log2 of the pitch f × 2^(cents / 1200), at the nyquist at most (NEG_INFINITY: none, a frequency of 0 or less)
#[inline(always)]
fn pitch_log(ctx: &Ctx, f: f64, cents: f64) -> f64 {
    let log = if f > 0.0 {
        min(ctx.log2_nyquist, log2(f) + cents / 1200.0)
    } else {
        f64::NEG_INFINITY
    };
    if log.is_nan() {
        f64::NEG_INFINITY
    } else {
        log
    }
}

pub struct Sub {
    table: Option<u32>,
    entry: Option<EntryRef>,
    // the phase of the table read next (the sine of the store: SINE_PHASE on)
    phase: f64,
    shift: f64,
    start_phase: f64,
    contiguous: bool,
    level_pan: LevelPan,
    cents: f64,
    // the samples of the fade-in left (a note of a legato phrase), of fade_length
    fade: i32,
    fade_length: i32,
    // its place among the subs of the node (SubPhase), 0 until it renders
    serial: u64,
    // the step and the log2 of the pitch at the points of a block, the step of its last sample
    steps: Vec<f64>,
    end_step: f64,
    logs: Vec<f64>,
    // a still pitch (frequency, cents) and its step and log2: worked out again only when it changes
    still: [f64; 2],
    // the cents of a glide of the frequency alone and their factor (2^(cents / 1200) / the rate)
    factor_cents: f64,
    factor: f64,
    still_step: f64,
    still_log: f64,
    // the x of `segment` at 1 Hz of its version (NaN: of none yet)
    offset: f64,
}

impl Sub {
    /// the sub of a note: only what it allocates (attach takes its version)
    pub fn new(sample_rate: f64, options: SubOptions) -> Sub {
        let phase = if options.phase.is_finite() {
            frac(options.phase)
        } else {
            0.0
        };
        let shift = if options.table.is_none() { SINE_PHASE } else { 0.0 };
        Sub {
            table: options.table,
            entry: None,
            phase: 0.0,
            shift,
            start_phase: phase,
            contiguous: options.contiguous,
            level_pan: LevelPan::new(sample_rate, options.level, options.pan),
            cents: options.cents,
            fade: 0,
            fade_length: 1,
            serial: 0,
            steps: vec![0.0; 128 / SEGMENT + 2],
            end_step: 0.0,
            logs: vec![0.0; 128 / SEGMENT + 2],
            still: [f64::NAN; 2],
            factor_cents: f64::NAN,
            factor: 0.0,
            still_step: 0.0,
            still_log: f64::NEG_INFINITY,
            offset: f64::NAN,
        }
    }

    /// its first sample, at `frame` of the node: the phase of Phase, or with Contiguous the one of the sub started last
    /// (`last`); a note of a legato phrase fades in over `fade` samples
    pub fn begin(&mut self, last: &SubPhase, frame: f64, fade: i32, fade_length: i32) {
        self.fade = fade;
        self.fade_length = fade_length.max(1);
        let phase = if self.contiguous {
            last.at(frame)
        } else {
            self.start_phase
        };
        self.phase = frac(phase + self.shift);
    }

    pub fn set(&mut self, knobs: SubKnobs) {
        self.level_pan.set(knobs.level, knobs.pan);
        self.cents = knobs.cents;
    }

    // the cents of sample i: Octave and Coarse, the route of Coarse and the bend
    #[inline(always)]
    fn cents_at(&self, routes: &SubRoutes, bend: &[f32], i: usize) -> f64 {
        let mut cents = self.cents;
        if let Some(coarse) = routes.coarse {
            cents += read(coarse, i) as f64;
        }
        cents + read(bend, i) as f64
    }

    // the step and the log2 of the pitch at sample i: the frequency of the note at its cents (no pitch: no step)
    #[inline(always)]
    fn pitch_at(
        &self,
        ctx: &Ctx,
        routes: &SubRoutes,
        frequency: &[f32],
        bend: &[f32],
        i: usize,
    ) -> (f64, f64) {
        let log = pitch_log(ctx, read(frequency, i) as f64, self.cents_at(routes, bend, i));
        if log == f64::NEG_INFINITY {
            return (0.0, log);
        }
        (pow(2.0, log) / ctx.sample_rate, log)
    }

    /// the samples a..b of a block added into the bus of the voice (`scratch.bus`, through `scratch.fading`)
    #[allow(clippy::too_many_arguments)]
    #[inline(never)]
    pub(crate) fn render_into(
        &mut self,
        store: &Store,
        ctx: &Ctx,
        routes: &SubRoutes,
        frequency: &[f32],
        bend: &[f32],
        scratch: &mut Scratch,
        a: usize,
        b: usize,
    ) {
        if b <= a {
            return;
        }
        // the points of the pitch: one for the block while nothing moves it
        let moving =
            routes.coarse.is_some_and(|values| values.len() > 1) || frequency.len() > 1 || bend.len() > 1;
        let segment = if moving { SEGMENT } else { b - a };
        let count = (b - a).div_ceil(segment);
        // the cents still while the frequency alone moves (a glide): its factor once, a multiply a point
        let still_cents = routes.coarse.is_none_or(|values| values.len() == 1) && bend.len() == 1;
        if moving && still_cents {
            let cents = self.cents_at(routes, bend, a);
            if cents != self.factor_cents {
                self.factor_cents = cents;
                self.factor = pow(2.0, cents / 1200.0) / ctx.sample_rate;
            }
            for p in 0..=count {
                let f = read(frequency, (a + p * segment).min(b - 1)) as f64;
                let log = pitch_log(ctx, f, cents);
                (self.steps[p], self.logs[p]) = if log == f64::NEG_INFINITY {
                    (0.0, log)
                } else if log == ctx.log2_nyquist {
                    (ctx.nyquist_inc, log)
                } else {
                    (f * self.factor, log)
                };
            }
        } else if moving {
            for p in 0..=count {
                let (step, log) = self.pitch_at(ctx, routes, frequency, bend, (a + p * segment).min(b - 1));
                self.steps[p] = step;
                self.logs[p] = log;
            }
        } else {
            let key = [frequency[0] as f64, self.cents_at(routes, bend, a)];
            if key != self.still {
                self.still = key;
                (self.still_step, self.still_log) = self.pitch_at(ctx, routes, frequency, bend, a);
            }
            self.steps[..2].fill(self.still_step);
            self.logs[..2].fill(self.still_log);
        }
        self.end_step = self.steps[count];
        let Some(entry) = self.entry else {
            self.skip(segment, count, a, b);
            return;
        };
        let levels = store.levels(entry);
        if levels.harmonics[0] == 0 {
            self.skip(segment, count, a, b);
            return;
        }
        if self.offset.is_nan() {
            // x = 1 + 3·log2(base · f / nyquist) = offset + 3·log2(f)
            self.offset = 1.0 + 3.0 * (log2(level_base(levels.harmonics[0])) - ctx.log2_nyquist);
        }
        let level = routes.level.unwrap_or(self.level_pan.level(b));
        let pan = routes.pan.unwrap_or(self.level_pan.pan(b));
        let still = level.len() == 1 && pan.len() == 1;
        let centred = pan.len() == 1 && pan[0] == 0.0;
        let points = Points {
            steps: &self.steps,
            logs: &self.logs,
            offset: self.offset,
            segment,
            count,
        };
        if still && centred && self.fade <= 0 {
            // steady in the centre: the gain in the render loop
            let (g, _) = gains(level[0] as f64, 0.0);
            self.phase = render_levels(levels, &points, self.phase, g, &mut scratch.bus.center, a, b);
            return;
        }
        let mono = &mut scratch.fading;
        mono[a..b].fill(0.0);
        self.phase = render_levels(levels, &points, self.phase, 1.0, mono, a, b);
        let bus = &mut scratch.bus;
        let still_gains = still.then(|| gains(level[0] as f64, pan[0] as f64));
        let mut fade = self.fade;
        for i in a..b {
            let (gl, gr) = match still_gains {
                Some(gains) => gains,
                None => gains(read(level, i) as f64, read(pan, i) as f64),
            };
            let v = if fade > 0 {
                let share = 1.0 - fade as f64 / self.fade_length as f64;
                fade -= 1;
                mono[i] as f64 * share
            } else {
                mono[i] as f64
            };
            if centred {
                bus.center[i] = (bus.center[i] as f64 + v * gl) as f32;
            } else {
                bus.left[i] = (bus.left[i] as f64 + v * gl) as f32;
                bus.right[i] = (bus.right[i] as f64 + v * gr) as f32;
            }
        }
        self.fade = fade;
    }

    // a block without a sound (no version yet, a silent one): the phase goes on
    fn skip(&mut self, segment: usize, count: usize, a: usize, b: usize) {
        let mut ph = self.phase;
        for p in 0..count {
            let length = ((a + (p + 1) * segment).min(b) - (a + p * segment)) as f64;
            let inc0 = self.steps[p];
            ph = advance(ph, inc0, (self.steps[p + 1] - inc0) / length, length);
        }
        self.phase = ph;
        self.fade = 0.max(self.fade - (b - a) as i32);
    }
}

// the pitch of a sub at the points of a block: the steps, the log2s, the x of `segment` at 1 Hz, the samples between
// the points and the segments
struct Points<'a> {
    steps: &'a [f64],
    logs: &'a [f64],
    offset: f64,
    segment: usize,
    count: usize,
}

// the segments a..b of a block from `levels` at the phase ph × g added into out: the phase after them
fn render_levels(
    levels: &Levels,
    points: &Points,
    mut ph: f64,
    g: f64,
    out: &mut [f32],
    a: usize,
    b: usize,
) -> f64 {
    let silent = (levels.lengths.len() - 1) as f64;
    let pitch = |log: f64| level_x(points.offset + 3.0 * log);
    for p in 0..points.count {
        let s0 = a + p * points.segment;
        let s1 = (s0 + points.segment).min(b);
        let length = (s1 - s0) as f64;
        let inc0 = points.steps[p];
        let d_inc = (points.steps[p + 1] - inc0) / length;
        let (level, w0, w1) = level_weights(pitch(points.logs[p]), pitch(points.logs[p + 1]));
        if level + (if w0 == 1.0 && w1 == 1.0 { 1.0 } else { 0.0 }) >= silent {
            // above the fundamental's nyquist: silent, the phase goes on
            ph = advance(ph, inc0, d_inc, length);
            continue;
        }
        ph = span(
            levels,
            level as usize,
            w0,
            (w1 - w0) / length,
            ph,
            inc0,
            d_inc,
            g,
            out,
            s0,
            s1,
        );
    }
    ph
}

// a span s0..s1 of the frame of `level` (w 0), of the next (w 1) or of both × g added into out: the loops of the
// oscillators (render11, render21_same, render21: functions of their own, in fixed point)
#[allow(clippy::too_many_arguments)]
fn span(
    levels: &Levels,
    level: usize,
    w: f64,
    dw: f64,
    ph: f64,
    inc: f64,
    d_inc: f64,
    g: f64,
    out: &mut [f32],
    s0: usize,
    s1: usize,
) -> f64 {
    let data = &levels.data;
    if let Some(level1) = span_level(level, w, dw) {
        let len1 = levels.lengths[level1] as f64;
        return render11(
            data,
            frame_start(levels, level1, 0),
            len1,
            ph,
            inc,
            d_inc,
            g,
            out,
            s0,
            s1,
        );
    }
    let (len1, len2) = (levels.lengths[level] as usize, levels.lengths[level + 1] as usize);
    let (o1, o2) = (frame_start(levels, level, 0), frame_start(levels, level + 1, 0));
    if len1 == len2 {
        return render21_same(data, o1, len1 as f64, o2, w, dw, ph, inc, d_inc, g, out, s0, s1);
    }
    render21(
        data,
        o1,
        len1 as f64,
        o2,
        len2 as f64,
        w,
        dw,
        ph,
        inc,
        d_inc,
        g,
        out,
        s0,
        s1,
    )
}

impl Source for Sub {
    fn targets(&self) -> u128 {
        mask(SUB, 0)
    }

    /// the voice holds the latest version of its shape (none yet: silent until one arrives), the sine of the store
    fn attach(&mut self, store: &mut Store) {
        self.entry = match self.table {
            None => Some(EntryRef::Sine),
            Some(table) => store.latest(table).map(|latest| store.acquire(latest)),
        };
    }

    /// room for the points of a block of `length`
    fn grow(&mut self, length: usize, _points: usize) {
        if self.steps.len() < length / SEGMENT + 2 {
            self.steps = vec![0.0; length / SEGMENT + 2];
            self.logs = vec![0.0; length / SEGMENT + 2];
        }
    }

    fn start(&mut self, cx: &StartCx) -> usize {
        self.begin(&cx.shared.sub, cx.frame, cx.fade, cx.fade_length);
        0
    }

    /// the level and the pan of the block
    fn glide(&mut self, a: usize, b: usize) {
        self.level_pan.render(a, b);
    }

    /// its level and its pan, the offset of its pitch from 0
    fn base<'a>(&'a self, knob: usize, _params: &'a Params<'a>, n: usize) -> &'a [f32] {
        self.level_pan.base(knob, n)
    }

    /// into the bus by its pan; the phase of the sub started last goes to the shared
    fn render(&mut self, cx: &RenderCx, store: &mut Store, shared: &mut Shared) {
        if self.serial == 0 {
            shared.sub_serial += 1;
            self.serial = shared.sub_serial;
        }
        if self.entry.is_none() {
            self.attach(store);
        }
        let moved = |knob| cx.modulation.moved(target(SUB, 0, knob));
        let routes = SubRoutes {
            level: moved(LEVEL),
            pan: moved(PAN),
            coarse: moved(COARSE),
        };
        self.render_into(
            store,
            cx.ctx,
            &routes,
            cx.params[FREQUENCY],
            cx.bend,
            &mut shared.scratch,
            cx.a,
            cx.b,
        );
        if self.serial == shared.sub_serial {
            shared.sub = SubPhase {
                phase: frac(self.phase - self.shift),
                frame: cx.ctx.block_frame + cx.b as f64,
                step: self.end_step,
                running: true,
            };
        }
    }

    /// the version goes back
    fn release(&mut self, store: &mut Store) {
        if let Some(entry) = self.entry.take() {
            store.release(entry);
        }
    }

    /// the sub started last stops: a note of Contiguous starts at its phase at its end
    fn free(&mut self, shared: &mut Shared) {
        if self.serial != 0 && self.serial == shared.sub_serial {
            shared.sub.running = false;
        }
    }

    /// level, pan, cents: the level and the pan glide in 10 ms, the cents step
    fn set_knobs(&mut self, module: usize, values: &[f64]) -> bool {
        if module != SUB || values.len() < 3 {
            return false;
        }
        self.set(SubKnobs {
            level: values[0],
            pan: values[1],
            cents: values[2],
        });
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modulation::Modulation;
    use crate::noise::PAN_CURVE;
    use crate::shared::PARAMS;
    use crate::targets::NOISE;
    use crate::tests::without_memory;
    use jsmath::{sin, PI};

    const RATE: f64 = 48000.0;
    const BLOCK: usize = 128;

    fn options() -> SubOptions {
        SubOptions {
            table: None,
            cents: 0.0,
            phase: 0.0,
            contiguous: false,
            level: 1.0,
            pan: 0.0,
        }
    }

    // table `table` of one frame of `values` with `harmonics`: one level and a silent one
    fn shape(store: &mut Store, table: u32, harmonics: i32, values: &[f32]) {
        let n = values.len();
        let stride = n + 3;
        let layout = [vec![harmonics, 0], vec![n as i32; 2], vec![0, stride as i32]];
        let slot = store
            .begin(table, 1.0, 1, layout, 2 * stride, 0.0)
            .expect("a slot");
        let data = store.chunk(slot, 0, 2 * stride).expect("its room");
        data.fill(0.0);
        data[0] = values[n - 1];
        data[1..=n].copy_from_slice(values);
        data[n + 1] = values[0];
        data[n + 2] = values[1];
        assert!(store.commit(slot));
    }

    // the params of a block at `frequency` (the sub reads no other)
    fn params(frequency: &[f32; 1]) -> Params<'_> {
        let mut params: Params = [&[0.0]; PARAMS];
        params[FREQUENCY] = frequency;
        params
    }

    // the bus (left, right, centre) of `blocks` of a sub at `frequency` from frame `from`: its blocks rendered as a
    // voice renders them (`bend` of each block)
    fn play(
        store: &mut Store,
        shared: &mut Shared,
        sub: &mut Sub,
        frequency: f32,
        bend: &[f32],
        from: usize,
        blocks: usize,
    ) -> [Vec<f32>; 3] {
        shared.grow(BLOCK);
        let modulation = Modulation::new(RATE, 0, true, &[], mask(SUB, 0));
        let f = [frequency];
        let params = params(&f);
        let mut out = [
            vec![0.0f32; BLOCK * blocks],
            vec![0.0f32; BLOCK * blocks],
            vec![0.0f32; BLOCK * blocks],
        ];
        for k in 0..blocks {
            shared.scratch.bus.clear(0, BLOCK);
            sub.glide(0, BLOCK);
            let ctx = Ctx::at(RATE, (from + k * BLOCK) as f64);
            let cx = RenderCx {
                ctx: &ctx,
                params: &params,
                bend,
                modulation: &modulation,
                a: 0,
                b: BLOCK,
            };
            sub.render(&cx, store, shared);
            let bus = &shared.scratch.bus;
            for (channel, values) in [&bus.left, &bus.right, &bus.center].into_iter().enumerate() {
                out[channel][k * BLOCK..(k + 1) * BLOCK].copy_from_slice(&values[..BLOCK]);
            }
        }
        out
    }

    fn started(store: &mut Store, options: SubOptions, last: &SubPhase, frame: f64) -> Sub {
        let mut sub = Sub::new(RATE, options);
        sub.attach(store);
        sub.grow(BLOCK, 0);
        sub.begin(last, frame, 0, 1);
        sub
    }

    #[test]
    fn the_sine_goes_down_from_its_phase_at_the_pitch_of_the_note_and_its_cents_into_the_centre() {
        let mut store = Store::default();
        let mut shared = Shared::default();
        for (cents, period) in [(0.0, 100.0), (1200.0, 50.0)] {
            let mut sub = started(
                &mut store,
                SubOptions { cents, ..options() },
                &SubPhase::default(),
                0.0,
            );
            let [left, right, centre] = play(&mut store, &mut shared, &mut sub, 480.0, &[0.0], 0, 2);
            assert!(left.iter().chain(right.iter()).all(|v| *v == 0.0));
            for (i, value) in centre.iter().enumerate() {
                let expected = -SUB_SCALE * sin(2.0 * PI * i as f64 / period);
                assert!(
                    (*value as f64 - expected).abs() < 2e-4,
                    "{cents} sample {i}: {value}, not {expected}"
                );
            }
        }
        // a bend of the block moves it as the cents do, at its points: the same samples
        let mut bent = started(&mut store, options(), &SubPhase::default(), 0.0);
        let mut tuned = started(
            &mut store,
            SubOptions {
                cents: 700.0,
                ..options()
            },
            &SubPhase::default(),
            0.0,
        );
        let bend = [700.0f32; BLOCK];
        assert_eq!(
            play(&mut store, &mut shared, &mut bent, 480.0, &bend, 0, 2),
            play(&mut store, &mut shared, &mut tuned, 480.0, &[0.0], 0, 2)
        );
    }

    #[test]
    fn its_level_is_the_scale_times_the_knob_squared_its_pan_the_curve_of_the_noise() {
        let mut store = Store::default();
        let mut shared = Shared::default();
        shape(&mut store, 3, 1, &[0.5; 256]);
        let options = SubOptions {
            table: Some(3),
            level: 0.5,
            pan: -1.0,
            ..options()
        };
        let mut sub = started(&mut store, options, &SubPhase::default(), 0.0);
        let [left, right, centre] = play(&mut store, &mut shared, &mut sub, 480.0, &[0.0], 0, 1);
        assert_eq!(
            left[10],
            (0.5 * SUB_SCALE * 0.25 * 2.0 * (1.0 - PAN_CURVE)) as f32
        );
        assert!(right.iter().chain(centre.iter()).all(|v| *v == 0.0));
        // (noise.json and sub.json `pan` at 0.75: 0.54304 and 1.37089 against the centre)
        let (gl, gr) = gains(1.0, 0.5);
        assert!(
            (gl / SUB_SCALE - 0.54304).abs() < 1e-4 && (gr / SUB_SCALE - 1.37089).abs() < 1e-4,
            "{gl} {gr}"
        );
        assert_eq!(gains(f64::NAN, 0.0), (0.0, 0.0));
        assert_eq!(gains(1.0, f64::NAN), (SUB_SCALE, SUB_SCALE));
    }

    #[test]
    fn a_change_of_its_knobs_glides_the_level_and_the_pan_in_10_ms_the_cents_step() {
        let mut store = Store::default();
        let mut shared = Shared::default();
        let mut sub = started(&mut store, options(), &SubPhase::default(), 0.0);
        assert!(!sub.set_knobs(NOISE, &[0.5, 0.0, 0.0]));
        assert!(sub.set_knobs(SUB, &[0.5, 0.5, 1200.0]));
        let [left, right, _] = play(&mut store, &mut shared, &mut sub, 480.0, &[0.0], 0, 1);
        assert_eq!(sub.level_pan.level(BLOCK).len(), BLOCK);
        assert_eq!(
            sub.level_pan.level(BLOCK)[100],
            (1.0 - 0.5 * 100.0 / 480.0) as f32
        );
        assert_eq!(sub.level_pan.pan(BLOCK)[100], (0.5 * 100.0 / 480.0) as f32);
        // the cents at once: a period of 50
        assert!(left[25].abs() < 1e-3 && right[25].abs() < 1e-3);
        assert!(left[12] < 0.0 && left[12] > right[12]);
    }

    #[test]
    fn a_shape_without_a_version_is_silent_its_phase_going_on_until_one_arrives() {
        let mut store = Store::default();
        let mut shared = Shared::default();
        let options = SubOptions {
            table: Some(9),
            ..options()
        };
        let mut sub = started(&mut store, options, &SubPhase::default(), 0.0);
        let [_, _, centre] = play(&mut store, &mut shared, &mut sub, 480.0, &[0.0], 0, 1);
        assert!(centre.iter().all(|v| *v == 0.0));
        assert!((sub.phase - 0.28).abs() < 1e-9, "{}", sub.phase);
        shape(&mut store, 9, 1, &[0.25; 256]);
        let [_, _, centre] = play(&mut store, &mut shared, &mut sub, 480.0, &[0.0], BLOCK, 1);
        assert!(centre.iter().all(|v| *v == (0.25 * SUB_SCALE) as f32));
        sub.release(&mut store);
    }

    #[test]
    fn a_pitch_above_the_nyquist_of_its_fundamental_is_silent_its_phase_going_on() {
        let mut store = Store::default();
        let mut shared = Shared::default();
        shape(&mut store, 3, 4, &[0.5; 256]);
        let options = SubOptions {
            table: Some(3),
            ..options()
        };
        let mut sub = started(&mut store, options, &SubPhase::default(), 0.0);
        let [_, _, centre] = play(&mut store, &mut shared, &mut sub, 5000.0, &[0.0], 0, 1);
        assert!(centre.iter().all(|v| *v == 0.0));
        assert!((sub.phase - frac(BLOCK as f64 * 5000.0 / RATE)).abs() < 1e-9);
    }

    #[test]
    fn a_note_of_contiguous_starts_at_the_phase_the_sub_started_last_has_or_had_at_its_end() {
        let mut store = Store::default();
        let mut shared = Shared::default();
        // a note at Phase 0.25 over two blocks at a step of 0.01
        let mut first = started(
            &mut store,
            SubOptions {
                phase: 0.25,
                ..options()
            },
            &shared.sub,
            0.0,
        );
        play(&mut store, &mut shared, &mut first, 480.0, &[0.0], 0, 2);
        let record = shared.sub;
        assert_eq!(
            (shared.sub_serial, record.frame, record.running),
            (1, 256.0, true)
        );
        // (the phase of a steady loop within 2^-32 a sample)
        assert!((record.phase - 0.81).abs() < 1e-8 && (record.step - 0.01).abs() < 1e-12);
        let contiguous = SubOptions {
            phase: 0.9,
            contiguous: true,
            ..options()
        };
        // still sounding: its phase now (Phase aside); before the end of its block, back from it
        let later = started(&mut store, contiguous, &shared.sub, 300.0);
        assert!(
            (later.phase - frac(0.81 + 0.44 + SINE_PHASE)).abs() < 1e-8,
            "{}",
            later.phase
        );
        let earlier = started(&mut store, contiguous, &shared.sub, 200.0);
        assert!((earlier.phase - frac(0.81 - 0.56 + SINE_PHASE)).abs() < 1e-8);
        // stopped: the phase at its end
        first.free(&mut shared);
        assert!(!shared.sub.running);
        let after = started(&mut store, contiguous, &shared.sub, 1000.0);
        assert!((after.phase - frac(0.81 + SINE_PHASE)).abs() < 1e-8);
        // the first sub of a node starts at 0; one off Contiguous at Phase
        let fresh = started(&mut store, contiguous, &SubPhase::default(), 500.0);
        assert_eq!(fresh.phase, SINE_PHASE);
        // a later one renders: it is the sub started last, the record its
        let mut second = started(&mut store, options(), &shared.sub, 256.0);
        assert_eq!(second.phase, SINE_PHASE);
        play(&mut store, &mut shared, &mut second, 960.0, &[0.0], 256, 1);
        assert_eq!(
            (shared.sub_serial, shared.sub.frame, shared.sub.running),
            (2, 384.0, true)
        );
        assert!((shared.sub.step - 0.02).abs() < 1e-12);
        // the end of an earlier one stops nothing
        first.free(&mut shared);
        assert!(shared.sub.running);
    }

    #[test]
    fn nothing_allocates_in_a_block() {
        let mut store = Store::default();
        let mut shared = Shared::default();
        shape(&mut store, 3, 1, &[0.5; 256]);
        let mut sub = started(
            &mut store,
            SubOptions {
                table: Some(3),
                pan: 0.3,
                ..options()
            },
            &SubPhase::default(),
            0.0,
        );
        sub.set_knobs(SUB, &[0.5, -0.2, 100.0]);
        // (the shared grown once before; a block of a pan, of gliding knobs and of a pitch that moves)
        play(&mut store, &mut shared, &mut sub, 480.0, &[0.0], 0, 1);
        sub.set_knobs(SUB, &[0.25, 0.4, 0.0]);
        let modulation = Modulation::new(RATE, 0, true, &[], mask(SUB, 0));
        let f = [480.0f32];
        let params = params(&f);
        let bend: Vec<f32> = (0..BLOCK).map(|i| i as f32).collect();
        let ctx = Ctx::at(RATE, BLOCK as f64);
        let cx = RenderCx {
            ctx: &ctx,
            params: &params,
            bend: &bend,
            modulation: &modulation,
            a: 0,
            b: BLOCK,
        };
        shared.scratch.bus.clear(0, BLOCK);
        without_memory(|| {
            sub.glide(0, BLOCK);
            sub.render(&cx, &mut store, &mut shared);
        });
        assert!(shared.scratch.bus.left[..BLOCK].iter().any(|v| *v != 0.0));
    }
}
