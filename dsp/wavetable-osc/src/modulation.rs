//! apps/chisper/src/app/synth/common/wavetable/voice-modulation.ts: the envelopes of a voice move its params,
//! base + Σ amount × level (base × 2^Σ for a log one), clamped; one value while every envelope a param follows
//! is in a flat stage. Source 3, after ENV 1–3, is the velocity of the voice (VELO: velocity.rs), flat but
//! for a glide to the velocity of a note that takes the voice over; sources 4–7 its LFOs (lfo.rs), 8–11 the macros
//! of the node (dsp-core/src/macros.rs: one level each in Shared, flat but for a glide to a new one). A bipolar
//! route moves a param by amount × (level - ½) (a uni one: amount × level, to the bit). The params are the knobs of
//! the modules of targets.rs, by id; the base of each comes from the module that has it (BaseOf), asked only for
//! the params a route moves. The pitch of an oscillator (Semi, Fine) is two params of base 0 (an offset of its
//! detune within the bounds of its routes: the range of the knob from its value), so is the pitch of the noise. The
//! knobs of the LFOs are params too (a Modulation of their own in the voice, every source but the LFOs): the times
//! by a share of their travel (pow: the knob is max · share⁴), Phase around the cycle (not clamped)

use crate::envelope::EnvelopeBlock;
use crate::glided::{glide_length, Glided};
use crate::lfo::{frac, LfoBlock, PHASE};
use crate::macros::Macros;
use crate::targets::{self, CUTOFF, FILTER, FILTER_EXTRA, FILTER_GAIN, LFO_KNOBS, TARGETS, WARP};
use crate::voice::is_constant;
use alloc::{vec, vec::Vec};
use jsmath::{max, min, pow, sqrt};

/// knob `knob` of LFO `lfo` as a param of the routes
pub const fn lfo_target(lfo: usize, knob: usize) -> usize {
    targets::target(LFO_KNOBS, lfo, knob)
}

/// the base of a param in a block (one value, or one a sample), by the module that has it: knob `knob` of instance
/// `instance` of `module` (targets.rs)
pub trait BaseOf {
    fn base(&self, module: usize, instance: usize, knob: usize) -> &[f32];
}

// the sources of the routes, by index (sources.rs of dsp-core, those of the chain: MOD_SOURCES of the schema): ENV
// 1–3, the velocity of the voice, LFO 1–4, the macros of the node
use crate::sources::VELO;
pub use crate::sources::{is_lfo, LFO_SOURCE as LFO, MACRO_SOURCE as MACRO, SOURCES};

/// the scale of a param: linear, log (the routes in octaves), pow (a share of the travel of the knob)
pub const LINEAR: u32 = 0;
pub const LOG: u32 = 1;
pub const POW: u32 = 2;

/// a route of a note (VoiceRoute)
#[derive(Clone, Copy, Debug)]
pub struct VoiceRoute {
    pub source: f64,
    pub param: usize,
    pub amount: f64,
    pub min: f64,
    pub max: f64,
    pub scale: u32,
    pub bipolar: bool,
}

/// what the routes of a voice read: its envelopes, its velocity (VELO), its LFOs (none for the routes of the knobs
/// of the LFOs), the macros of its node (rendered for the block)
pub struct Sources<'a> {
    pub envelopes: &'a [EnvelopeBlock],
    pub velocity: &'a Glided,
    pub lfos: &'a [LfoBlock],
    pub macros: &'a Macros,
}

const BLOCK: usize = 128;
const SEGMENT: f64 = 32.0;
// (the filter reads its cutoff and gain at the starts of its spans: the points of the routes, `sparse`)
const _: () = assert!(SEGMENT as usize == crate::filter::SEGMENT);

// the levels of a source of the routes in a block: one value while it is flat (`constant`), else one a sample
#[derive(Clone, Copy)]
struct Level<'a> {
    constant: bool,
    value: f64,
    values: &'a [f32],
}

// source `k` that is the velocity or a macro: flat but for a glide
#[inline(always)]
fn glided<'a>(sources: &Sources<'a>, k: usize) -> &'a Glided {
    if k == VELO {
        sources.velocity
    } else {
        &sources.macros.levels[k - MACRO]
    }
}

// source `k` of the routes: an envelope, the velocity, an LFO, a macro (their fields, no call through a vtable in
// the loops of the routes)
#[inline(always)]
fn source<'a>(sources: &Sources<'a>, k: usize) -> Level<'a> {
    if k == VELO || k >= MACRO {
        let glided = glided(sources, k);
        Level {
            constant: glided.constant,
            value: glided.value(),
            values: &glided.values,
        }
    } else if k >= LFO {
        let lfo = &sources.lfos[k - LFO];
        Level {
            constant: lfo.constant,
            value: lfo.value,
            values: &lfo.values,
        }
    } else {
        let envelope = &sources.envelopes[k];
        Level {
            constant: envelope.constant,
            value: envelope.value,
            values: &envelope.values,
        }
    }
}

// the frame the flat stage of source `k` lasts until (-Infinity: it moved); the velocity and a macro are flat but
// for a glide
fn flat_until(sources: &Sources, k: usize) -> f64 {
    if is_lfo(k) {
        sources.lfos[k - LFO].flat_until()
    } else if k < VELO {
        sources.envelopes[k].flat_until()
    } else if glided(sources, k).gliding() {
        f64::NEG_INFINITY
    } else {
        f64::INFINITY
    }
}

// a glide of `step` a sample from `value`, `frames` on: not past its `target`
#[inline(always)]
fn toward(value: f64, step: f64, target: f64, frames: f64) -> f64 {
    if step == 0.0 {
        return value;
    }
    let next = value + step * frames;
    if if step > 0.0 { next > target } else { next < target } {
        target
    } else {
        next
    }
}

// a param moved by the sum of its routes from its base `x`, not clamped
#[inline(always)]
fn moved_value(scale: u32, x: f64, sum: f64, max_value: f64) -> f64 {
    match scale {
        LOG => x * pow(2.0, sum),
        POW => {
            let share = sqrt(sqrt(x / max_value)) + sum;
            let share = if share > 1.0 {
                1.0
            } else if share > 0.0 {
                share
            } else {
                0.0
            };
            max_value * (share * share * share * share)
        }
        _ => x + sum,
    }
}

struct Route {
    source: usize,
    // ½ of a bipolar one, else 0; another polarity glides there as the amount does
    offset: f64,
    offset_target: f64,
    offset_step: f64,
    amount: f64,
    target: f64,
    step: f64,
    removed: bool,
    level: f64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Current {
    None,
    One,
    Values,
}

struct Target {
    param: usize,
    // the knob it is (targets::of): its base comes from its module
    module: usize,
    instance: usize,
    knob: usize,
    routes: Vec<Route>,
    min: f64,
    max: f64,
    scale: u32,
    // the Phase of an LFO: around the cycle, not clamped
    wrap: bool,
    // read only at the points the routes work out (a..b by SEGMENT, from a): the cutoff and the gain of the filter,
    // which reads them at the start of each of its spans; the lines between the points and the values outside a..b
    // are left out
    sparse: bool,
    values: Vec<f32>,
    one: [f32; 1],
    current: Current,
    base: f64,
}

// a knob of the filter: its range and its scale are those of the type of the filter, which may change on a note
fn of_filter(module: usize) -> bool {
    module == FILTER || module == FILTER_EXTRA
}

// the targets the routes set: all of them, all but the knobs of the filter, those alone
#[derive(Clone, Copy)]
enum Which {
    All,
    Others,
    Filter,
}

impl Which {
    fn takes(self, module: usize) -> bool {
        match self {
            Which::All => true,
            Which::Others => !of_filter(module),
            Which::Filter => of_filter(module),
        }
    }
}

pub struct Modulation {
    glide: f64,
    targets: Vec<Target>,
    // the envelopes of the voice a route may read (ENV 1–3 at most), whether a route may read an LFO, the sources
    // the routes read
    envelopes: usize,
    lfos: bool,
    used: [bool; SOURCES],
    dropped: bool,
    quiet_until: f64,
    // the params of the voice a route may move, bits of their ids (an oscillator off for the note has none)
    accesses: u128,
    pub active: bool,
    // a change of type of the filter waits for the end of a fade: the routes of its knobs sent meanwhile, of the next
    // type, wait for it (`held`); those that play keep their amounts and ranges until it comes (an amount in % of
    // a model type is not one in dB of a type of a BiquadFilterNode)
    holding: bool,
    held: Vec<VoiceRoute>,
    // the buffers of the targets `release` makes (it comes in a block, where a core never allocates: they are made
    // with the routes held), the values of a block and room for a route of each source
    spare: Vec<(Vec<f32>, Vec<Route>)>,
}

impl Modulation {
    /// the routes of a voice with `envelopes` envelopes, the velocity and (`lfos`) its LFOs to the params of
    /// `accesses` (bits of their ids)
    pub fn new(
        sample_rate: f64,
        envelopes: usize,
        lfos: bool,
        initial: &[VoiceRoute],
        accesses: u128,
    ) -> Modulation {
        let mut modulation = Modulation {
            glide: glide_length(sample_rate),
            targets: Vec::new(),
            envelopes: envelopes.min(VELO),
            lfos,
            used: [false; SOURCES],
            dropped: false,
            quiet_until: f64::NEG_INFINITY,
            accesses,
            active: false,
            holding: false,
            held: Vec::new(),
            spare: Vec::new(),
        };
        modulation.set_routes(initial, false, false);
        modulation
    }

    /// the values the routes give `param` instead of its base (target.current), None: the base
    pub fn moved(&self, param: usize) -> Option<&[f32]> {
        let target = self.targets.iter().find(|target| target.param == param)?;
        match target.current {
            Current::None => None,
            Current::One => Some(&target.one),
            Current::Values => Some(&target.values),
        }
    }

    fn index(&mut self) {
        self.quiet_until = f64::NEG_INFINITY;
        for target in self.targets.iter_mut() {
            target
                .routes
                .retain(|route| !(route.removed && route.amount == 0.0));
        }
        // the last route gone: the base again (the target and its current go)
        self.targets.retain(|target| !target.routes.is_empty());
        self.used.fill(false);
        for target in &self.targets {
            for route in &target.routes {
                self.used[route.source] = true;
            }
        }
        self.active = !self.targets.is_empty() || self.dropped;
    }

    fn set_routes(&mut self, routes: &[VoiceRoute], gliding: bool, hold: bool) {
        // (the routes held before: these now, or none)
        self.held.clear();
        self.holding = hold;
        if hold {
            let filter = routes
                .iter()
                .filter(|route| targets::of(route.param).is_some_and(|(module, _, _)| of_filter(module)));
            self.held.extend(filter);
        }
        self.update(routes, gliding, if hold { Which::Others } else { Which::All });
        // (after the others: those of their targets that come take no room of the routes held)
        if hold {
            self.reserve_held();
        }
    }

    // room for the routes held, which `release` sets in a block: a route of each source in every target of a knob
    // of the filter, a target of each param held (a spare buffer, a place among the targets) whether its target
    // plays or not (it may be gone by then)
    fn reserve_held(&mut self) {
        for target in self.targets.iter_mut().filter(|target| of_filter(target.module)) {
            target.routes.reserve(SOURCES.saturating_sub(target.routes.len()));
        }
        let held = &self.held;
        let params = (0..held.len())
            .filter(|&i| !held[..i].iter().any(|route| route.param == held[i].param))
            .count();
        self.targets.reserve(params);
        while self.spare.len() < params {
            self.spare.push((vec![0.0; BLOCK], Vec::with_capacity(SOURCES)));
        }
    }

    // the routes of the targets `which` (the others as they are); `gliding`: their amounts glide there, those of a
    // knob of the filter whose range or scale changed (a change of type: its base too) at once
    fn update(&mut self, routes: &[VoiceRoute], gliding: bool, which: Which) {
        self.quiet_until = f64::NEG_INFINITY;
        for target in self.targets.iter_mut() {
            if which.takes(target.module) {
                for route in target.routes.iter_mut() {
                    route.removed = true;
                }
            }
        }
        // the params whose amounts change at once (bits of their ids)
        let mut jumps: u128 = 0;
        for route in routes {
            let source = route.source;
            // not a whole index of a source, of an envelope the voice has not, or an LFO where none is read
            if !(source >= 0.0 && source < SOURCES as f64 && source == jsmath::floor(source)) {
                continue;
            }
            let source = source as usize;
            if (source < VELO && source >= self.envelopes) || (is_lfo(source) && !self.lfos) {
                continue;
            }
            if route.param >= TARGETS || self.accesses >> route.param & 1 == 0 {
                continue;
            }
            let Some((module, instance, knob)) = targets::of(route.param) else {
                continue;
            };
            if !which.takes(module) {
                continue;
            }
            let scale = if route.scale == LOG || route.scale == POW {
                route.scale
            } else {
                LINEAR
            };
            let wrap = module == LFO_KNOBS && knob == PHASE;
            let index = match self.targets.iter().position(|target| target.param == route.param) {
                Some(index) => index,
                None => {
                    // (a spare buffer: never written while it waits, its values are 0)
                    let (values, routes) = self.spare.pop().unwrap_or_else(|| (vec![0.0; BLOCK], Vec::new()));
                    self.targets.push(Target {
                        param: route.param,
                        module,
                        instance,
                        knob,
                        routes,
                        min: route.min,
                        max: route.max,
                        scale,
                        wrap,
                        sparse: (module == FILTER && (knob == CUTOFF || knob == FILTER_GAIN))
                            || module == WARP,
                        values,
                        one: [0.0],
                        current: Current::None,
                        base: f64::NAN,
                    });
                    self.targets.len() - 1
                }
            };
            let target = &mut self.targets[index];
            if of_filter(module)
                && (target.min != route.min || target.max != route.max || target.scale != scale)
            {
                jumps |= 1 << route.param;
            }
            target.min = route.min;
            target.max = route.max;
            target.scale = scale;
            target.base = f64::NAN;
            let offset = if route.bipolar { 0.5 } else { 0.0 };
            let position = match target.routes.iter().position(|item| item.source == source) {
                Some(position) => position,
                None => {
                    target.routes.push(Route {
                        source,
                        offset,
                        offset_target: offset,
                        offset_step: 0.0,
                        amount: if gliding { 0.0 } else { route.amount },
                        target: route.amount,
                        step: 0.0,
                        removed: false,
                        level: f64::NAN,
                    });
                    target.routes.len() - 1
                }
            };
            let item = &mut target.routes[position];
            item.removed = false;
            item.offset_target = offset;
            item.target = route.amount;
        }
        let glide = self.glide;
        for target in self.targets.iter_mut() {
            if !which.takes(target.module) {
                continue;
            }
            let jump = jumps >> target.param & 1 != 0;
            for route in target.routes.iter_mut() {
                if route.removed {
                    route.target = 0.0;
                }
                if jump {
                    route.amount = route.target;
                }
                route.step = (route.target - route.amount) / glide;
                route.offset_step = (route.offset_target - route.offset) / glide;
            }
        }
        self.index();
    }

    /// the routes of a playing note changed: their amounts glide
    pub fn set(&mut self, routes: &[VoiceRoute]) {
        self.set_routes(routes, true, false);
    }

    /// the routes of a playing note changed while a change of type of its filter waits for the end of a fade: their
    /// amounts glide, those of the knobs of the filter wait for `release` (they play as they were until then)
    pub fn set_holding(&mut self, routes: &[VoiceRoute]) {
        self.set_routes(routes, true, true);
    }

    /// the change of type came: the knobs of the filter take the routes that waited for it
    pub fn release(&mut self) {
        if !self.holding {
            return;
        }
        self.holding = false;
        let held = core::mem::take(&mut self.held);
        self.update(&held, true, Which::Filter);
        self.held = held;
        self.held.clear();
    }

    pub fn holds(&self) -> bool {
        self.holding
    }

    pub fn renders(&self, k: usize, end: f64) -> bool {
        k < self.envelopes && self.used[k] && end > self.quiet_until
    }

    /// a route reads source `k`
    pub fn uses(&self, k: usize) -> bool {
        self.used[k]
    }

    /// a route reads an LFO
    pub fn uses_lfos(&self) -> bool {
        self.used[LFO..MACRO].iter().any(|used| *used)
    }

    pub fn wake(&mut self) {
        self.quiet_until = f64::NEG_INFINITY;
    }

    /// a route moves `param` (its target is there: `apply` reads its base)
    pub fn moves(&self, param: usize) -> bool {
        self.targets.iter().any(|target| target.param == param)
    }

    pub fn raises(&self, param: usize) -> bool {
        self.targets
            .iter()
            .any(|target| target.param == param && target.routes.iter().any(|route| route.target > 0.0))
    }

    /// the moved params of the samples a..b of a block of n; `bases` the base of each param in the block (asked
    /// only for the params it moves), the levels of the sources there
    pub fn apply<B: BaseOf>(&mut self, bases: &B, sources: &Sources, frame: f64, a: f64, b: f64, n: usize) {
        if self.dropped {
            self.dropped = false;
            self.index();
        }
        if b <= a {
            return;
        }
        if frame + b <= self.quiet_until {
            let still = self.targets.iter().all(|target| {
                let base = bases.base(target.module, target.instance, target.knob);
                base[0] as f64 == target.base && is_constant(base)
            });
            if still {
                return;
            }
        }
        let mut quiet = true;
        let mut dropped = false;
        for target in self.targets.iter_mut() {
            let (min_value, max_value, scale, wrap, sparse) =
                (target.min, target.max, target.scale, target.wrap, target.sparse);
            let base = bases.base(target.module, target.instance, target.knob);
            // (128 equal values in Firefox are one value too: the per-sample path cost +19% of a voice there)
            let mut constant = is_constant(base);
            let mut same = constant && base[0] as f64 == target.base && target.current == Current::One;
            for route in &target.routes {
                let envelope = source(sources, route.source);
                if !envelope.constant || route.step != 0.0 || route.offset_step != 0.0 {
                    constant = false;
                    same = false;
                } else if envelope.value != route.level {
                    same = false;
                }
            }
            if same {
                continue;
            }
            if constant {
                let mut sum = 0.0;
                for route in target.routes.iter_mut() {
                    route.level = source(sources, route.source).value;
                    // (a uni route: level - 0, its bits)
                    sum += route.amount * (route.level - route.offset);
                }
                let x = base[0] as f64;
                let value = moved_value(scale, x, sum, max_value);
                target.one[0] = if wrap {
                    frac(value)
                } else {
                    min(max_value, max(min_value, value))
                } as f32;
                target.base = x;
                target.current = Current::One;
                continue;
            }
            target.base = f64::NAN;
            quiet = false;
            if target.values.len() != n {
                target.values = vec![0.0; n];
            }
            let values = &mut target.values;
            let last = b - 1.0;
            let mut from = a;
            let mut p = a;
            loop {
                let mut sum = 0.0;
                for route in &target.routes {
                    let envelope = source(sources, route.source);
                    let amount = toward(route.amount, route.step, route.target, p - a);
                    let offset = toward(route.offset, route.offset_step, route.offset_target, p - a);
                    let level = if envelope.constant {
                        envelope.value
                    } else {
                        envelope.values[p as usize] as f64
                    };
                    sum += amount * (level - offset);
                }
                let x = if base.len() > 1 { base[p as usize] } else { base[0] } as f64;
                let value = moved_value(scale, x, sum, max_value);
                values[p as usize] = if wrap {
                    frac(value)
                } else if value < min_value {
                    min_value
                } else if value > max_value {
                    max_value
                } else {
                    value
                } as f32;
                if p > from && !sparse {
                    let start = values[from as usize] as f64;
                    let slope = (values[p as usize] as f64 - start) / (p - from);
                    let mut i = from + 1.0;
                    while i < p {
                        values[i as usize] = (start + slope * (i - from)) as f32;
                        i += 1.0;
                    }
                }
                if p == last {
                    break;
                }
                from = p;
                p = min(p + SEGMENT, last);
            }
            // the glides go on
            for route in target.routes.iter_mut() {
                if route.offset_step != 0.0 {
                    route.offset = toward(route.offset, route.offset_step, route.offset_target, b - a);
                    if route.offset == route.offset_target {
                        route.offset_step = 0.0;
                    }
                }
                if route.step == 0.0 {
                    continue;
                }
                route.amount = toward(route.amount, route.step, route.target, b - a);
                if route.amount == route.target {
                    route.step = 0.0;
                    if route.removed {
                        dropped = true;
                    }
                }
            }
            if !sparse {
                let (first, end) = (values[a as usize], values[b as usize - 1]);
                values[..a as usize].fill(first);
                values[b as usize..n].fill(end);
            }
            target.current = Current::Values;
        }
        if dropped {
            self.dropped = true;
        }
        self.quiet_until = f64::NEG_INFINITY;
        if !quiet {
            return;
        }
        self.quiet_until = f64::INFINITY;
        for (k, used) in self.used.iter().enumerate() {
            if *used {
                self.quiet_until = min(self.quiet_until, flat_until(sources, k));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envelope::EnvelopeParams;
    use crate::lfo::{LfoGlobal, LfoState, DELAY, KNOBS, LFOS, RATE};
    use crate::targets::{target, CUTOFF, FILTER, GAIN, OSC};
    use core::cell::RefCell;

    const RATE_48: f64 = 48000.0;
    const GAIN1: usize = target(OSC, 0, GAIN);
    const CUTOFF1: usize = target(FILTER, 0, CUTOFF);

    // one base for every param; the params asked for, in order
    struct Bases<'a> {
        values: &'a [f32],
        asked: RefCell<Vec<(usize, usize, usize)>>,
    }

    impl<'a> Bases<'a> {
        fn new(values: &'a [f32]) -> Bases<'a> {
            Bases {
                values,
                asked: RefCell::new(Vec::new()),
            }
        }
    }

    impl BaseOf for Bases<'_> {
        fn base(&self, module: usize, instance: usize, knob: usize) -> &[f32] {
            self.asked.borrow_mut().push((module, instance, knob));
            self.values
        }
    }

    fn only(param: usize) -> u128 {
        1 << param
    }

    // ENV 1–3 at a level: an attack of 0 to a sustain of `level`, rendered for the block at 0
    fn envelopes(level: f64) -> Vec<EnvelopeBlock> {
        let params = EnvelopeParams {
            sustain: level,
            ..EnvelopeParams::default()
        };
        (0..3)
            .map(|_| {
                let mut envelope = EnvelopeBlock::new(params, RATE_48, 0.0);
                envelope.render(0.0, 0.0, 128.0);
                envelope
            })
            .collect()
    }

    fn route(source: f64, param: usize, amount: f64, scale: u32, bipolar: bool) -> VoiceRoute {
        let (min, max) = if scale == POW {
            (0.0, 32.0)
        } else {
            (-100.0, 100.0)
        };
        VoiceRoute {
            source,
            param,
            amount,
            min,
            max,
            scale,
            bipolar,
        }
    }

    // the value of `param` moved by `routes` from a base of `base` (one value), the envelopes at `level`
    fn moved_one(routes: &[VoiceRoute], param: usize, base: f32, level: f64, lfos: bool) -> Option<f32> {
        let mut modulation = Modulation::new(RATE_48, 3, lfos, routes, only(param));
        let envelopes = envelopes(level);
        let velocity = Glided::new(0.0);
        let one = [base];
        let bases = Bases::new(&one);
        let sources = Sources {
            envelopes: &envelopes,
            velocity: &velocity,
            lfos: &[],
            macros: &Macros::default(),
        };
        modulation.apply(&bases, &sources, 0.0, 0.0, 128.0, 128);
        modulation.moved(param).map(|values| values[0])
    }

    #[test]
    fn a_bipolar_route_moves_around_the_base_a_uni_one_up_from_it() {
        let uni = moved_one(&[route(1.0, GAIN1, 10.0, LINEAR, false)], GAIN1, 1.0, 0.25, false);
        assert_eq!(uni, Some((1.0 + 10.0 * 0.25) as f32));
        let bipolar = moved_one(&[route(1.0, GAIN1, 10.0, LINEAR, true)], GAIN1, 1.0, 0.25, false);
        assert_eq!(bipolar, Some((1.0 + 10.0 * (0.25 - 0.5)) as f32));
        // a log one in octaves around it
        let log = moved_one(&[route(0.0, CUTOFF1, 2.0, LOG, true)], CUTOFF1, 4.0, 1.0, false);
        assert_eq!(log, Some(8.0));
    }

    // a change of type of the filter waits for the end of a fade: the routes of its knobs sent with it wait for it,
    // those that play keep their amounts and ranges until it comes (then their amounts change at once, as the knobs
    // do), the others take theirs at once
    #[test]
    fn the_routes_of_the_knobs_of_the_filter_wait_for_its_type() {
        use crate::targets::{FILTER_EXTRA, RESONANCE, VARIATION};
        let resonance = target(FILTER, 0, RESONANCE);
        let variation = target(FILTER_EXTRA, 0, VARIATION);
        let ranged = |param: usize, amount: f64, max: f64| VoiceRoute {
            min: 0.0,
            max,
            ..route(1.0, param, amount, LINEAR, false)
        };
        // Res in dB of a Biquad LP (0..20), Var of none; Res in % of a model type (0..100), its Var
        let web = [ranged(resonance, 10.0, 20.0), ranged(GAIN1, 1.0, 2.0)];
        let model = [
            ranged(resonance, 50.0, 100.0),
            ranged(GAIN1, 2.0, 4.0),
            ranged(variation, 30.0, 100.0),
        ];
        let mut modulation = Modulation::new(
            RATE_48,
            3,
            false,
            &web,
            only(resonance) | only(GAIN1) | only(variation),
        );
        let envelopes = envelopes(1.0);
        let velocity = Glided::new(0.0);
        let one = [1.0f32];
        let mut frame = 0.0;
        // the value of `param` at the last sample of `blocks` blocks
        let mut moved = |modulation: &mut Modulation, blocks: usize, param: usize| {
            let bases = Bases::new(&one);
            let sources = Sources {
                envelopes: &envelopes,
                velocity: &velocity,
                lfos: &[],
                macros: &Macros::default(),
            };
            for _ in 0..blocks {
                modulation.apply(&bases, &sources, frame, 0.0, 128.0, 128);
                frame += 128.0;
            }
            modulation.moved(param).map(|values| values[values.len() - 1])
        };
        // (past the glide of an amount)
        let glided = 64;
        modulation.set_holding(&model);
        assert!(modulation.holds());
        assert_eq!(moved(&mut modulation, glided, resonance), Some(11.0));
        assert_eq!(moved(&mut modulation, 0, GAIN1), Some(3.0));
        assert_eq!(moved(&mut modulation, 0, variation), None);
        modulation.release();
        assert!(!modulation.holds());
        // (from its first block: the amount of the next type, not one gliding there from that of the type before)
        assert_eq!(moved(&mut modulation, 1, resonance), Some(51.0));
        assert_eq!(moved(&mut modulation, glided, variation), Some(31.0));
        // a change of type that doesn't wait: at once too
        modulation.set(&web);
        assert_eq!(moved(&mut modulation, 1, resonance), Some(11.0));
        // routes set again before it came (back to the type that plays): theirs, none held
        modulation.set_holding(&model);
        modulation.set(&web);
        assert!(!modulation.holds());
        assert_eq!(moved(&mut modulation, 1, resonance), Some(11.0));
        modulation.release();
        assert_eq!(moved(&mut modulation, 1, resonance), Some(11.0));
    }

    // the routes held come in a block, where a core never allocates: the room of their targets is made with them (a
    // new source of a target that plays, a param no route moved, one whose target is gone by then)
    #[test]
    fn the_routes_held_come_without_memory() {
        use crate::targets::{DRIVE, FILTER_EXTRA, RESONANCE, VARIATION};
        use crate::tests::without_memory;
        let resonance = target(FILTER, 0, RESONANCE);
        let variation = target(FILTER_EXTRA, 0, VARIATION);
        let drive = target(FILTER_EXTRA, 0, DRIVE);
        let ranged = |source: f64, param: usize, amount: f64, max: f64| VoiceRoute {
            min: 0.0,
            max,
            ..route(source, param, amount, LINEAR, false)
        };
        let accesses = only(resonance) | only(variation) | only(drive) | only(GAIN1);
        let initial = [
            ranged(1.0, resonance, 10.0, 20.0),
            ranged(1.0, variation, 5.0, 100.0),
        ];
        let mut modulation = Modulation::new(RATE_48, 3, false, &initial, accesses);
        let envelopes = envelopes(1.0);
        let velocity = Glided::new(0.0);
        let one = [1.0f32];
        let mut frame = 0.0;
        let mut moved = |modulation: &mut Modulation, blocks: usize, param: usize| {
            let bases = Bases::new(&one);
            let sources = Sources {
                envelopes: &envelopes,
                velocity: &velocity,
                lfos: &[],
                macros: &Macros::default(),
            };
            for _ in 0..blocks {
                modulation.apply(&bases, &sources, frame, 0.0, 128.0, 128);
                frame += 128.0;
            }
            modulation.moved(param).map(|values| values[values.len() - 1])
        };
        let glided = 64;
        // (the route of Res glides out: its target goes while the others wait)
        modulation.set(&[ranged(1.0, GAIN1, 1.0, 2.0), ranged(1.0, variation, 5.0, 100.0)]);
        modulation.set_holding(&[
            ranged(1.0, GAIN1, 1.0, 2.0),
            ranged(1.0, resonance, 50.0, 100.0),
            ranged(2.0, resonance, 20.0, 100.0),
            ranged(1.0, variation, 30.0, 100.0),
            ranged(2.0, variation, 10.0, 100.0),
            ranged(0.0, drive, 40.0, 100.0),
        ]);
        assert_eq!(moved(&mut modulation, glided, resonance), None);
        assert_eq!(moved(&mut modulation, 0, variation), Some(6.0));
        assert_eq!(moved(&mut modulation, 0, drive), None);
        without_memory(|| modulation.release());
        assert_eq!(moved(&mut modulation, glided, resonance), Some(71.0));
        assert_eq!(moved(&mut modulation, 0, variation), Some(41.0));
        assert_eq!(moved(&mut modulation, 0, drive), Some(41.0));
    }

    // the routes of a knob of the filter in the same range (a type of the same units): their amounts glide
    #[test]
    fn the_amounts_of_a_knob_of_the_filter_in_the_same_range_glide() {
        use crate::targets::RESONANCE;
        let resonance = target(FILTER, 0, RESONANCE);
        let ranged = |amount: f64| VoiceRoute {
            min: 0.0,
            max: 100.0,
            ..route(1.0, resonance, amount, LINEAR, false)
        };
        let mut modulation = Modulation::new(RATE_48, 3, false, &[ranged(10.0)], only(resonance));
        let envelopes = envelopes(1.0);
        let velocity = Glided::new(0.0);
        let one = [1.0f32];
        let bases = Bases::new(&one);
        let sources = Sources {
            envelopes: &envelopes,
            velocity: &velocity,
            lfos: &[],
            macros: &Macros::default(),
        };
        modulation.apply(&bases, &sources, 0.0, 0.0, 128.0, 128);
        modulation.set(&[ranged(50.0)]);
        modulation.apply(&bases, &sources, 128.0, 0.0, 128.0, 128);
        let last = modulation.moved(resonance).expect("moved")[127];
        assert!(last > 11.0 && last < 51.0, "{last}");
    }

    #[test]
    fn a_pow_knob_moves_by_a_share_of_its_travel() {
        let value = moved_one(
            &[route(0.0, lfo_target(1, DELAY), 0.25, POW, false)],
            lfo_target(1, DELAY),
            0.5,
            1.0,
            false,
        )
        .expect("moved");
        let share = sqrt(sqrt(0.5f32 as f64 / 32.0)) + 0.25;
        assert_eq!(value, (32.0 * (share * share * share * share)) as f32);
        // within its travel: 0 at most -1, its max at most +1
        let low = moved_one(
            &[route(0.0, lfo_target(1, DELAY), -1.0, POW, false)],
            lfo_target(1, DELAY),
            0.5,
            1.0,
            false,
        );
        assert_eq!(low, Some(0.0));
        let high = moved_one(
            &[route(0.0, lfo_target(1, DELAY), 1.0, POW, false)],
            lfo_target(1, DELAY),
            0.5,
            1.0,
            false,
        );
        assert_eq!(high, Some(32.0));
    }

    #[test]
    fn a_phase_goes_around_the_cycle_not_clamped() {
        let param = lfo_target(2, PHASE);
        let mut phase = route(0.0, param, 0.5, LINEAR, false);
        phase.max = 1.0;
        phase.min = 0.0;
        assert_eq!(moved_one(&[phase], param, 0.75, 1.0, false), Some(0.25));
    }

    #[test]
    fn the_routes_of_the_knobs_of_the_lfos_take_no_lfo() {
        let param = lfo_target(0, RATE);
        // LFO 2 (source 5) on Rate of LFO 1: left out, ENV 2 there is not
        assert_eq!(
            moved_one(&[route(5.0, param, 1.0, LOG, false)], param, 2.0, 1.0, false),
            None
        );
        assert_eq!(
            moved_one(&[route(1.0, param, 1.0, LOG, false)], param, 2.0, 1.0, false),
            Some(4.0)
        );
        // a route of the params of the voice reads them
        let mut modulation = Modulation::new(
            RATE_48,
            3,
            true,
            &[route(5.0, GAIN1, 1.0, LINEAR, false)],
            only(GAIN1),
        );
        assert!(modulation.uses_lfos() && modulation.uses(LFO + 1));
        modulation.set(&[]);
        assert!(modulation.uses(LFO + 1));
    }

    #[test]
    fn a_macro_moves_a_param_by_its_level_as_sources_8_to_11_and_the_knobs_of_the_lfos_take_it() {
        let envelopes = envelopes(0.0);
        let velocity = Glided::new(0.0);
        let mut macros = Macros::default();
        macros.set(&[0.25, 0.5, 0.75, 1.0], true, 1.0);
        macros.render(0.0, 128);
        let one = [1.0f32];
        let moved = |routes: &[VoiceRoute], param: usize, lfos: bool| {
            let mut modulation = Modulation::new(RATE_48, 3, lfos, routes, only(param));
            let bases = Bases::new(&one);
            let sources = Sources {
                envelopes: &envelopes,
                velocity: &velocity,
                lfos: &[],
                macros: &macros,
            };
            modulation.apply(&bases, &sources, 0.0, 0.0, 128.0, 128);
            (
                modulation.moved(param).map(|values| values[0]),
                modulation.quiet_until,
            )
        };
        for (k, level) in [0.25, 0.5, 0.75, 1.0].into_iter().enumerate() {
            let source = (MACRO + k) as f64;
            assert_eq!(
                moved(&[route(source, GAIN1, 2.0, LINEAR, false)], GAIN1, true),
                (Some((1.0 + 2.0 * level) as f32), f64::INFINITY)
            );
            // (bipolar: around the knob)
            assert_eq!(
                moved(&[route(source, GAIN1, 2.0, LINEAR, true)], GAIN1, true).0,
                Some((1.0 + 2.0 * (level - 0.5)) as f32)
            );
        }
        // MACRO 2 on Rate of LFO 1 (a Modulation of the knobs of the LFOs: no LFO there, a macro is)
        let rate = lfo_target(0, RATE);
        assert_eq!(
            moved(&[route(9.0, rate, 1.0, LOG, false)], rate, false).0,
            Some(2f32.sqrt())
        );
        assert_eq!(moved(&[route(5.0, rate, 1.0, LOG, false)], rate, false).0, None);
        // a macro is not an LFO: the LFOs of the voice are not rendered for it
        let modulation = Modulation::new(
            RATE_48,
            3,
            true,
            &[route(8.0, GAIN1, 1.0, LINEAR, false)],
            only(GAIN1),
        );
        assert!(modulation.uses(MACRO) && !modulation.uses_lfos());
        // past the macros: no source
        assert_eq!(
            moved(&[route(12.0, GAIN1, 2.0, LINEAR, false)], GAIN1, true).0,
            None
        );
    }

    #[test]
    fn a_macro_that_glides_moves_its_params_without_a_step_and_they_are_quiet_again_once_it_is_there() {
        let envelopes = envelopes(0.0);
        let velocity = Glided::new(0.0);
        let mut macros = Macros::default();
        let mut modulation = Modulation::new(
            RATE_48,
            3,
            true,
            &[route(10.0, GAIN1, 10.0, LINEAR, false)],
            only(GAIN1),
        );
        let one = [1.0f32];
        let bases = Bases::new(&one);
        let glide = glide_length(RATE_48);
        let mut played: Vec<f32> = Vec::new();
        let mut quiet = Vec::new();
        for block in 0..8 {
            // MACRO 3 to 1 from block 2 on
            if block == 2 {
                macros.set(&[f64::NAN, f64::NAN, 1.0, f64::NAN], false, glide);
                modulation.wake();
            }
            macros.render(block as f64 * 128.0, 128);
            let sources = Sources {
                envelopes: &envelopes,
                velocity: &velocity,
                lfos: &[],
                macros: &macros,
            };
            let frame = played.len() as f64;
            modulation.apply(&bases, &sources, frame, 0.0, 128.0, 128);
            quiet.push(modulation.quiet_until);
            let moved = modulation.moved(GAIN1).expect("moved");
            played.extend((0..128).map(|i| moved[if moved.len() > 1 { i } else { 0 }]));
        }
        let glide = glide as usize;
        assert!(played[..256].iter().all(|value| *value == 1.0));
        assert!(played[256 + glide..].iter().all(|value| *value == 11.0));
        // 10 × 1 over the glide, a line (the points of the routes every 32 samples, linear between them)
        let most = 10.0 / glide as f64 * 1.001;
        for i in 1..played.len() {
            assert!(
                ((played[i] - played[i - 1]) as f64).abs() <= most,
                "{i}: {} after {}",
                played[i],
                played[i - 1]
            );
        }
        // quiet while it is flat, worked out every block while it glides (and the block after it got there)
        assert_eq!(quiet[1], f64::INFINITY);
        assert!(quiet[2..6].iter().all(|until| *until == f64::NEG_INFINITY));
        assert_eq!(quiet[7], f64::INFINITY);
    }

    #[test]
    fn an_lfo_in_its_delay_keeps_the_routes_quiet_until_the_delay_ends() {
        let mut lfo = LfoGlobal::default();
        lfo.set(
            0.0,
            &LfoState {
                mode: 0,
                delay: 0.1,
                rise: 0.0,
                smooth: 0.0,
                phase: 0.0,
                anchor: None,
                table: false,
            },
            true,
        );
        let mut modulation = Modulation::new(
            RATE_48,
            3,
            true,
            &[route(4.0, GAIN1, 1.0, LINEAR, false)],
            only(GAIN1),
        );
        let envelopes = envelopes(1.0);
        let velocity = Glided::new(0.0);
        let mut lfos: Vec<LfoBlock> = (0..LFOS).map(|_| LfoBlock::new(RATE_48, 0.0)).collect();
        let one = [0.5f32];
        let bases = Bases::new(&one);
        lfos[0].render(0.0, 0.0, 128.0, 128, &lfo, &[None; KNOBS]);
        let sources = Sources {
            envelopes: &envelopes,
            velocity: &velocity,
            lfos: &lfos,
            macros: &Macros::default(),
        };
        modulation.apply(&bases, &sources, 0.0, 0.0, 128.0, 128);
        assert_eq!(modulation.moved(GAIN1).map(|values| values[0]), Some(0.5));
        assert_eq!(modulation.quiet_until, 4800.0);
    }

    #[test]
    fn another_polarity_glides_as_the_amount_does() {
        let uni = route(1.0, GAIN1, 10.0, LINEAR, false);
        let bipolar = route(1.0, GAIN1, 10.0, LINEAR, true);
        let mut modulation = Modulation::new(RATE_48, 3, false, &[uni], only(GAIN1));
        let envelopes = envelopes(0.25);
        let velocity = Glided::new(0.0);
        let one = [1.0f32];
        let bases = Bases::new(&one);
        let sources = Sources {
            envelopes: &envelopes,
            velocity: &velocity,
            lfos: &[],
            macros: &Macros::default(),
        };
        let mut played: Vec<f32> = Vec::new();
        let mut render = |modulation: &mut Modulation, blocks: usize| {
            for _ in 0..blocks {
                let frame = played.len() as f64;
                modulation.apply(&bases, &sources, frame, 0.0, 128.0, 128);
                let moved = modulation.moved(GAIN1).expect("moved");
                played.extend((0..128).map(|i| moved[if moved.len() > 1 { i } else { 0 }]));
            }
        };
        // 1 + 10 × 0.25 uni, then bipolar at 256: 1 + 10 × (0.25 - ½), uni again at 1024
        render(&mut modulation, 2);
        modulation.set(&[bipolar]);
        render(&mut modulation, 6);
        modulation.set(&[uni]);
        render(&mut modulation, 6);
        let glide = glide_length(RATE_48) as usize;
        assert!(played[..257].iter().all(|value| *value == 3.5));
        assert!(played[256 + glide..1024].iter().all(|value| *value == -1.5));
        assert!(played[1024 + glide..].iter().all(|value| *value == 3.5));
        // no step: amount × ½ over the glide
        let most = 10.0 * 0.5 / glide as f64 * 1.001;
        for i in 1..played.len() {
            assert!(
                ((played[i] - played[i - 1]) as f64).abs() <= most,
                "{i}: {} after {}",
                played[i],
                played[i - 1]
            );
        }
    }

    #[test]
    fn the_bases_are_asked_only_of_the_params_a_route_moves_and_by_their_module() {
        // routes on Gain of osc 1 and on Cutoff, every param of the voice open to them
        let routes = [
            route(1.0, GAIN1, 0.5, LINEAR, false),
            route(0.0, CUTOFF1, 1.0, LOG, false),
        ];
        let mut modulation = Modulation::new(RATE_48, 3, false, &routes, u128::MAX);
        let envelopes = envelopes(0.5);
        let velocity = Glided::new(0.0);
        let one = [100.0f32];
        let bases = Bases::new(&one);
        let sources = Sources {
            envelopes: &envelopes,
            velocity: &velocity,
            lfos: &[],
            macros: &Macros::default(),
        };
        modulation.apply(&bases, &sources, 0.0, 0.0, 128.0, 128);
        assert_eq!(
            bases.asked.borrow().as_slice(),
            [(OSC, 0, GAIN), (FILTER, 0, CUTOFF)].as_slice()
        );
        // a param out of the accesses takes no route, so no base is asked for it
        let mut modulation = Modulation::new(RATE_48, 3, false, &routes, only(GAIN1));
        let bases = Bases::new(&one);
        modulation.apply(&bases, &sources, 0.0, 0.0, 128.0, 128);
        assert_eq!(bases.asked.borrow().as_slice(), [(OSC, 0, GAIN)].as_slice());
        assert_eq!(modulation.moved(CUTOFF1), None);
    }
}
