//! Deterministic CPU simulation, independent of rendering and ECS.
//!
//! Particles live in structure-of-arrays buffers ([`Particles`]) sized once to the emitter's
//! capacity, so a running effect never allocates. Dead particles are swap-removed (the alive
//! range stays dense). The same seed and the same `dt` sequence give bit-identical results.
//!
//! ```ignore
//! let fx = CompiledEffect::new(presets::sparks())?;
//! let mut st = InstanceState::new(&fx, 42);
//! let budget = Budget::unlimited();
//! for _ in 0..60 { st.step(&fx, &FrameCtx { dt: 1.0 / 60.0, ..FrameCtx::at(Vec3::ZERO) }, &budget); }
//! assert!(st.alive() > 0);
//! ```

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use bevy::math::{Quat, Vec3, Vec3A};

use super::curve::{LUT, lut_index};
use super::def::{Collision, EffectDef, EmitterDef, RenderMode, Shape, Trigger, Velocity};
use super::rng::Rng;

/// Hard cap on a single emitter's capacity.
pub const MAX_CAPACITY: u32 = 1 << 21;
/// Most trail points per particle.
pub const MAX_TRAIL_POINTS: u8 = 64;

/// An [`EffectDef`] validated and baked (curves → tables, sub-emitter names → indices).
#[derive(Debug)]
pub struct CompiledEffect {
    pub def: EffectDef,
    pub emitters: Vec<CompiledEmitter>,
    /// Longest particle lifetime of any emitter (seconds).
    pub max_lifetime: f32,
    /// Sum of emitter capacities.
    pub capacity: u32,
}

#[derive(Debug)]
pub struct CompiledEmitter {
    pub size_lut: [f32; LUT],
    pub color_lut: [[f32; 4]; LUT],
    pub tint_lut: [[f32; 4]; LUT],
    pub taper_lut: [f32; LUT],
    /// `(trigger, target emitter index, count, inherit, chance)`.
    pub subs: Vec<(Trigger, usize, u32, f32, f32)>,
    pub has_death_subs: bool,
    pub has_spawn_subs: bool,
    pub has_collision_subs: bool,
    /// Trail points per particle (0 = no trail).
    pub trail_points: u8,
    pub trail_interval: f32,
}

impl CompiledEffect {
    pub fn new(def: EffectDef) -> Result<Self, String> {
        if def.emitters.is_empty() {
            return Err(format!("effect `{}` has no emitters", def.name));
        }
        let mut emitters = Vec::with_capacity(def.emitters.len());
        let mut max_lifetime: f32 = 0.0;
        let mut capacity = 0u32;
        for (i, e) in def.emitters.iter().enumerate() {
            if e.capacity == 0 || e.capacity > MAX_CAPACITY {
                return Err(format!("emitter `{}`: capacity {} not in 1..={MAX_CAPACITY}", e.name, e.capacity));
            }
            if !(e.lifetime.0 > 0.0 && e.lifetime.1 >= e.lifetime.0) {
                return Err(format!("emitter `{}`: lifetime {:?} must be > 0 and ordered", e.name, e.lifetime));
            }
            let mut subs = Vec::new();
            for s in &e.sub_emitters {
                let Some(t) = def.emitters.iter().position(|o| o.name == s.emitter) else {
                    return Err(format!("emitter `{}`: sub-emitter `{}` not found", e.name, s.emitter));
                };
                if t <= i {
                    return Err(format!("emitter `{}`: sub-emitter `{}` must come after it", e.name, s.emitter));
                }
                subs.push((s.on, t, s.count, s.inherit_velocity, s.chance.clamp(0.0, 1.0)));
            }
            let (trail_points, trail_interval, taper) = match &e.render.mode {
                RenderMode::Trail { points, interval, taper } => {
                    if !(2..=MAX_TRAIL_POINTS).contains(points) {
                        return Err(format!("emitter `{}`: trail points {points} not in 2..={MAX_TRAIL_POINTS}", e.name));
                    }
                    (*points, interval.max(1e-3), taper.bake())
                }
                _ => (0, 0.0, [1.0; LUT]),
            };
            if let Some(fb) = e.render.flipbook
                && (fb.cols == 0 || fb.rows == 0)
            {
                return Err(format!("emitter `{}`: flipbook needs cols, rows > 0", e.name));
            }
            max_lifetime = max_lifetime.max(e.lifetime.1);
            capacity = capacity.saturating_add(e.capacity);
            emitters.push(CompiledEmitter {
                size_lut: e.size_over_life.bake(),
                color_lut: e.color_over_life.bake(),
                tint_lut: e.start_tint.bake(),
                taper_lut: taper,
                has_death_subs: subs.iter().any(|s| s.0 == Trigger::Death),
                has_spawn_subs: subs.iter().any(|s| s.0 == Trigger::Spawn),
                has_collision_subs: subs.iter().any(|s| s.0 == Trigger::Collision),
                subs,
                trail_points,
                trail_interval,
            });
        }
        Ok(CompiledEffect { def, emitters, max_lifetime, capacity })
    }

    pub fn shared(def: EffectDef) -> Result<Arc<Self>, String> {
        Self::new(def).map(Arc::new)
    }
}

/// Structure-of-arrays particle storage. Index `i < len()` is alive.
#[derive(Debug, Default, Clone)]
pub struct Particles {
    pub pos: Vec<Vec3A>,
    pub vel: Vec<Vec3A>,
    pub age: Vec<f32>,
    pub inv_life: Vec<f32>,
    pub size: Vec<f32>,
    pub rot: Vec<f32>,
    pub spin: Vec<f32>,
    /// Per-particle random bits (tint, flipbook start, mesh axis).
    pub seed: Vec<u32>,
    /// `trail_points` slots per particle, ring-indexed by [`EmitterState::trail_head`].
    pub trail: Vec<Vec3A>,
    pub trail_len: Vec<u8>,
}

impl Particles {
    fn with_capacity(n: usize, trail: usize) -> Self {
        Particles {
            pos: Vec::with_capacity(n),
            vel: Vec::with_capacity(n),
            age: Vec::with_capacity(n),
            inv_life: Vec::with_capacity(n),
            size: Vec::with_capacity(n),
            rot: Vec::with_capacity(n),
            spin: Vec::with_capacity(n),
            seed: Vec::with_capacity(n),
            trail: Vec::with_capacity(n * trail),
            trail_len: if trail > 0 { Vec::with_capacity(n) } else { Vec::new() },
        }
    }

    #[inline]
    pub fn len(&self) -> usize {
        self.pos.len()
    }
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.pos.is_empty()
    }

    /// Normalized age `0..1`.
    #[inline]
    pub fn t(&self, i: usize) -> f32 {
        (self.age[i] * self.inv_life[i]).min(1.0)
    }

    pub fn clear(&mut self) {
        self.pos.clear();
        self.vel.clear();
        self.age.clear();
        self.inv_life.clear();
        self.size.clear();
        self.rot.clear();
        self.spin.clear();
        self.seed.clear();
        self.trail.clear();
        self.trail_len.clear();
    }

    #[inline]
    fn kill(&mut self, i: usize, trail: usize) {
        self.pos.swap_remove(i);
        self.vel.swap_remove(i);
        self.age.swap_remove(i);
        self.inv_life.swap_remove(i);
        self.size.swap_remove(i);
        self.rot.swap_remove(i);
        self.spin.swap_remove(i);
        self.seed.swap_remove(i);
        if trail > 0 {
            let last = self.trail_len.len() - 1;
            if i != last {
                self.trail.copy_within(last * trail..(last + 1) * trail, i * trail);
            }
            self.trail.truncate(last * trail);
            self.trail_len.swap_remove(i);
        }
    }
}

/// Particles requested by a sub-emitter trigger.
#[derive(Clone, Copy, Debug)]
pub struct SpawnEvent {
    pub pos: Vec3A,
    pub vel: Vec3A,
    pub count: u32,
}

#[derive(Debug, Clone)]
pub struct EmitterState {
    pub p: Particles,
    rng: Rng,
    accum: f32,
    pub(crate) incoming: Vec<SpawnEvent>,
    /// Ring index of the newest trail point.
    pub trail_head: u8,
    trail_timer: f32,
    /// Lifetime totals.
    pub spawned: u64,
    pub died: u64,
    /// Spawns refused by the global or emitter budget this frame.
    pub dropped: u32,
    /// Spawned this frame.
    pub spawned_frame: u32,
    /// World-space bounds of particle centres (valid when alive).
    pub min: Vec3A,
    pub max: Vec3A,
    /// Largest particle size (bounds padding).
    pub max_size: f32,
    /// Round-robin cursor for capped collision raycasts.
    pub collide_cursor: usize,
}

impl EmitterState {
    fn new(def: &EmitterDef, ce: &CompiledEmitter, rng: Rng) -> Self {
        EmitterState {
            p: Particles::with_capacity(def.capacity as usize, ce.trail_points as usize),
            rng,
            accum: 0.0,
            incoming: Vec::new(),
            trail_head: 0,
            trail_timer: 0.0,
            spawned: 0,
            died: 0,
            dropped: 0,
            spawned_frame: 0,
            min: Vec3A::ZERO,
            max: Vec3A::ZERO,
            max_size: 0.0,
            collide_cursor: 0,
        }
    }

    fn reset(&mut self, rng: Rng) {
        self.p.clear();
        self.rng = rng;
        self.accum = 0.0;
        self.incoming.clear();
        self.trail_head = 0;
        self.trail_timer = 0.0;
        self.spawned = 0;
        self.died = 0;
        self.dropped = 0;
        self.spawned_frame = 0;
        self.collide_cursor = 0;
    }
}

/// Global particle headroom shared by every effect this frame (thread-safe reservation).
#[derive(Debug)]
pub struct Budget(AtomicI64);

impl Budget {
    pub fn new(headroom: i64) -> Self {
        Budget(AtomicI64::new(headroom))
    }
    pub fn unlimited() -> Self {
        Budget(AtomicI64::new(i64::MAX / 2))
    }
    /// Takes up to `n`, returns what was granted.
    pub fn reserve(&self, n: u32) -> u32 {
        if n == 0 {
            return 0;
        }
        let mut cur = self.0.load(Ordering::Relaxed);
        loop {
            let take = (n as i64).min(cur.max(0));
            if take == 0 {
                return 0;
            }
            match self.0.compare_exchange_weak(cur, cur - take, Ordering::Relaxed, Ordering::Relaxed) {
                Ok(_) => return take as u32,
                Err(c) => cur = c,
            }
        }
    }
    pub fn remaining(&self) -> i64 {
        self.0.load(Ordering::Relaxed)
    }
}

/// Per-frame inputs from the world.
#[derive(Clone, Copy, Debug)]
pub struct FrameCtx {
    pub dt: f32,
    /// Effect origin (world).
    pub pos: Vec3,
    pub rot: Quat,
    pub scale: f32,
    /// Effect velocity (world, m/s) — for `inherit_velocity` and spawn interpolation.
    pub vel: Vec3,
    /// Distance the effect moved this frame (`rate_per_meter`).
    pub moved: f32,
    /// LOD multiplier on spawn counts.
    pub spawn_scale: f32,
    /// False: no new particles from rate/bursts (culled, stopped); sub-emitters still fire.
    pub emitting: bool,
}

impl FrameCtx {
    pub fn at(pos: Vec3) -> Self {
        FrameCtx { dt: 0.0, pos, rot: Quat::IDENTITY, scale: 1.0, vel: Vec3::ZERO, moved: 0.0, spawn_scale: 1.0, emitting: true }
    }
}

/// One playing effect: its emitters' particles, clock and RNG streams.
#[derive(Debug, Clone)]
pub struct InstanceState {
    pub emitters: Vec<EmitterState>,
    /// Seconds since (re)start.
    pub time: f32,
    pub seed: u64,
    /// Effect origin last frame (`local_space`).
    last_pos: Option<Vec3>,
}

impl InstanceState {
    pub fn new(fx: &CompiledEffect, seed: u64) -> Self {
        let emitters = fx
            .def
            .emitters
            .iter()
            .zip(&fx.emitters)
            .enumerate()
            .map(|(i, (d, c))| EmitterState::new(d, c, Rng::fork(seed, i as u64)))
            .collect();
        InstanceState { emitters, time: 0.0, seed, last_pos: None }
    }

    /// Back to time 0 with a new seed, keeping every buffer's capacity (pooling).
    pub fn restart(&mut self, seed: u64) {
        self.seed = seed;
        self.time = 0.0;
        self.last_pos = None;
        for (i, e) in self.emitters.iter_mut().enumerate() {
            e.reset(Rng::fork(seed, i as u64));
        }
    }

    pub fn alive(&self) -> usize {
        self.emitters.iter().map(|e| e.p.len()).sum()
    }

    /// Emission is over (non-looping effect past its duration).
    pub fn emission_over(&self, fx: &CompiledEffect) -> bool {
        let d = &fx.def;
        d.duration > 0.0 && !d.looping && self.time >= d.duration + fx.def.emitters.iter().map(|e| e.delay).fold(0.0, f32::max)
    }

    /// Emission over and every particle dead.
    pub fn finished(&self, fx: &CompiledEffect) -> bool {
        self.emission_over(fx) && self.emitters.iter().all(|e| e.p.is_empty() && e.incoming.is_empty())
    }

    /// Advances every emitter by `ctx.dt` (in effect order, so sub-emitters see this frame's
    /// triggers).
    pub fn step(&mut self, fx: &CompiledEffect, ctx: &FrameCtx, budget: &Budget) {
        let shift = if let Some(lp) = self.last_pos { Vec3A::from(ctx.pos - lp) } else { Vec3A::ZERO };
        self.last_pos = Some(ctx.pos);
        let t0 = self.time;
        let t1 = t0 + ctx.dt;
        for i in 0..self.emitters.len() {
            let (head, tail) = self.emitters.split_at_mut(i + 1);
            let e = &mut head[i];
            e.step(&fx.def, i, &fx.emitters[i], ctx, t0, t1, shift, budget, tail);
        }
        self.time = t1;
    }
}

/// Bursts firing in `[t0, t1)` (seconds since start).
fn burst_count(def: &EffectDef, e: &EmitterDef, t0: f32, t1: f32) -> u32 {
    if e.bursts.is_empty() {
        return 0;
    }
    let cycle = if def.looping && def.duration > 0.0 { def.duration } else { f32::INFINITY };
    let (c0, c1) = if cycle.is_finite() { ((t0 / cycle).floor() as i64, (t1 / cycle).floor() as i64) } else { (0, 0) };
    let mut n = 0;
    for c in c0..=c1 {
        let start = if cycle.is_finite() { c as f32 * cycle } else { 0.0 };
        for b in &e.bursts {
            for k in 0..b.cycles.max(1) {
                let local = e.delay + b.time + k as f32 * b.interval;
                if cycle.is_finite() && local >= cycle {
                    break;
                }
                let ft = start + local;
                if ft >= t0 && ft < t1 {
                    n += b.count;
                }
            }
        }
    }
    n
}

/// Fast sine (|err| < 0.001), argument any real.
#[inline]
fn fsin(x: f32) -> f32 {
    const INV_TAU: f32 = 1.0 / core::f32::consts::TAU;
    let x = x - core::f32::consts::TAU * (x * INV_TAU).round();
    const B: f32 = 4.0 / core::f32::consts::PI;
    const C: f32 = -4.0 / (core::f32::consts::PI * core::f32::consts::PI);
    let y = B * x + C * x * x.abs();
    0.225 * (y * y.abs() - y) + y
}

#[inline]
fn fcos(x: f32) -> f32 {
    fsin(x + core::f32::consts::FRAC_PI_2)
}

/// Divergence-free field: curl of a sine potential, two rotated octaves.
#[inline]
pub fn curl(p: Vec3A, t: f32) -> Vec3A {
    let a = Vec3A::new(fcos(p.y + t), fcos(p.z + 1.7 * t), fcos(p.x + 0.6 * t));
    // Second octave in a rotated frame (rotation about (1,1,1)/√3 by ~50°): Rᵀ·F(R·p).
    let q = Vec3A::new(0.76 * p.x - 0.35 * p.y + 0.55 * p.z, 0.55 * p.x + 0.76 * p.y - 0.35 * p.z, -0.35 * p.x + 0.55 * p.y + 0.76 * p.z) * 2.3;
    let f = Vec3A::new(fcos(q.y - 0.8 * t), fcos(q.z + 1.1 * t), fcos(q.x - 1.3 * t)) * 0.5;
    let b = Vec3A::new(0.76 * f.x + 0.55 * f.y - 0.35 * f.z, -0.35 * f.x + 0.76 * f.y + 0.55 * f.z, 0.55 * f.x - 0.35 * f.y + 0.76 * f.z);
    a + b
}

impl EmitterState {
    #[allow(clippy::too_many_arguments)]
    fn step(
        &mut self,
        fx: &EffectDef,
        index: usize,
        ce: &CompiledEmitter,
        ctx: &FrameCtx,
        t0: f32,
        t1: f32,
        shift: Vec3A,
        budget: &Budget,
        children: &mut [EmitterState],
    ) {
        let def = &fx.emitters[index];
        let dt = ctx.dt;
        let trail = ce.trail_points as usize;
        self.dropped = 0;
        self.spawned_frame = 0;
        let child_base = index + 1;

        if dt > 0.0 {
            // Local space: carry particles with the effect.
            if def.local_space && shift != Vec3A::ZERO {
                for p in &mut self.p.pos {
                    *p += shift;
                }
                if trail > 0 {
                    for p in &mut self.p.trail {
                        *p += shift;
                    }
                }
            }

            // 1. Age; dying particles fire death sub-emitters.
            let mut i = 0;
            while i < self.p.len() {
                self.p.age[i] += dt;
                if self.p.age[i] * self.p.inv_life[i] >= 1.0 {
                    if ce.has_death_subs {
                        fire(&ce.subs, Trigger::Death, self.p.pos[i], self.p.vel[i], &mut self.rng, children, child_base);
                    }
                    self.p.kill(i, trail);
                    self.died += 1;
                    continue;
                }
                i += 1;
            }

            // 2. Forces + integration (hoisted per feature, tight loops).
            let g = Vec3A::from(def.gravity) * dt;
            let damp = 1.0 / (1.0 + def.drag.max(0.0) * dt);
            for v in &mut self.p.vel {
                *v = (*v + g) * damp;
            }
            if let Some(tb) = def.turbulence {
                let (s, f, tt) = (tb.strength * dt, tb.frequency, t1 * tb.speed);
                for (p, v) in self.p.pos.iter().zip(self.p.vel.iter_mut()) {
                    *v += curl(*p * f, tt) * s;
                }
            }
            if !def.attractors.is_empty() {
                let origin = Vec3A::from(ctx.pos);
                for a in &def.attractors {
                    let c = origin + Vec3A::from(ctx.rot * (a.offset * ctx.scale));
                    let r2 = (a.radius * a.radius).max(1e-4);
                    let k2 = a.kill_radius * a.kill_radius;
                    for i in 0..self.p.len() {
                        let d = c - self.p.pos[i];
                        let l2 = d.length_squared();
                        if l2 < k2 {
                            self.p.age[i] = 1.0 / self.p.inv_life[i];
                        }
                        let acc = a.strength * r2 / (l2 + r2);
                        self.p.vel[i] += d * (acc * dt / (l2.sqrt() + 1e-4));
                    }
                }
            }
            if let Some(o) = def.orbit {
                let axis = (ctx.rot * o.axis).try_normalize().unwrap_or(Vec3::Y);
                let q = Quat::from_axis_angle(axis, o.speed * dt);
                let (c, ax) = (Vec3A::from(ctx.pos), Vec3A::from(axis));
                for (p, v) in self.p.pos.iter_mut().zip(self.p.vel.iter_mut()) {
                    let r = *p - c;
                    let rr = q * r;
                    *p = c + rr;
                    *v = q * *v;
                    if o.radial != 0.0 {
                        let out = rr - ax * rr.dot(ax);
                        *v += out.normalize_or_zero() * (o.radial * dt);
                    }
                }
            }
            for (p, v) in self.p.pos.iter_mut().zip(self.p.vel.iter()) {
                *p += *v * dt;
            }
            if def.spin.0 != 0.0 || def.spin.1 != 0.0 {
                for (r, s) in self.p.rot.iter_mut().zip(self.p.spin.iter()) {
                    *r += *s * dt;
                }
            }

            // 3. Ground-plane collision.
            if let Collision::Plane { height, restitution, friction, die } = def.collision {
                let mut i = 0;
                while i < self.p.len() {
                    let p = &mut self.p.pos[i];
                    if p.y < height {
                        let v = &mut self.p.vel[i];
                        if ce.has_collision_subs {
                            let hit = Vec3A::new(p.x, height, p.z);
                            fire(&ce.subs, Trigger::Collision, hit, *v, &mut self.rng, children, child_base);
                        }
                        if die {
                            self.p.kill(i, trail);
                            self.died += 1;
                            continue;
                        }
                        p.y = height + (height - p.y) * restitution;
                        v.y = -v.y * restitution;
                        v.x *= 1.0 - friction;
                        v.z *= 1.0 - friction;
                    }
                    i += 1;
                }
            }

            // 4. Trails: every particle records a point on the shared cadence.
            if trail > 0 {
                self.trail_timer += dt;
                if self.trail_timer >= ce.trail_interval {
                    self.trail_timer %= ce.trail_interval;
                    self.trail_head = ((self.trail_head as usize + 1) % trail) as u8;
                    let h = self.trail_head as usize;
                    for i in 0..self.p.len() {
                        self.p.trail[i * trail + h] = self.p.pos[i];
                        let l = &mut self.p.trail_len[i];
                        *l = (*l + 1).min(ce.trail_points);
                    }
                }
            }
        }

        // 5. Spawn: sub-emitter events, then rate and bursts.
        let alive = self.p.len() as u32;
        let room = def.capacity.saturating_sub(alive);
        let mut events = core::mem::take(&mut self.incoming);
        let event_want: u32 = events.iter().map(|e| e.count).sum();
        let emit = ctx.emitting && dt > 0.0 && t1 > def.delay && !(fx.duration > 0.0 && !fx.looping && t0 >= fx.duration + def.delay);
        let mut rate_n = 0u32;
        if emit {
            self.accum += (def.rate * dt + def.rate_per_meter * ctx.moved) * ctx.spawn_scale;
            rate_n = self.accum.floor().max(0.0) as u32;
            self.accum -= rate_n as f32;
        }
        let burst_n = if ctx.emitting { burst_count(fx, def, t0, t1) } else { 0 };
        let burst_n = if burst_n > 0 { ((burst_n as f32 * ctx.spawn_scale).round() as u32).max(1) } else { 0 };
        let want = event_want + rate_n + burst_n;
        let allowed = want.min(room);
        let granted = budget.reserve(allowed);
        self.dropped = want - granted;
        let mut left = granted;

        let rot = ctx.rot;
        let base = Vec3A::from(ctx.pos);
        let evel = Vec3A::from(ctx.vel);
        for ev in events.drain(..) {
            for _ in 0..ev.count {
                if left == 0 {
                    break;
                }
                left -= 1;
                self.spawn(def, ce, ev.pos, Quat::IDENTITY, ctx.scale, ev.vel, 0.0, children, child_base);
            }
        }
        self.incoming = events;
        for k in 0..burst_n {
            if left == 0 {
                break;
            }
            let _ = k;
            left -= 1;
            self.spawn(def, ce, base, rot, ctx.scale, evel * def.inherit_velocity, 0.0, children, child_base);
        }
        // Rate spawns are spread over the frame: earlier ones are pre-aged and placed back
        // along the effect's path, so fast emitters leave continuous trails.
        let n = rate_n.min(left);
        for k in 0..n {
            let frac = (k as f32 + 1.0) / n as f32;
            let back = 1.0 - frac;
            let origin = base - evel * (dt * back);
            self.spawn(def, ce, origin, rot, ctx.scale, evel * def.inherit_velocity, dt * back, children, child_base);
        }

        // 6. Bounds.
        if self.p.is_empty() {
            self.min = base;
            self.max = base;
        } else {
            let (mut lo, mut hi) = (Vec3A::splat(f32::MAX), Vec3A::splat(f32::MIN));
            for p in &self.p.pos {
                lo = lo.min(*p);
                hi = hi.max(*p);
            }
            if trail > 0 {
                for i in 0..self.p.len() {
                    let n = self.p.trail_len[i] as usize;
                    for k in 0..n {
                        let s = (self.trail_head as usize + trail - k) % trail;
                        let p = self.p.trail[i * trail + s];
                        lo = lo.min(p);
                        hi = hi.max(p);
                    }
                }
            }
            self.min = lo;
            self.max = hi;
        }
        let peak = ce.size_lut.iter().fold(0.0f32, |a, b| a.max(b.abs()));
        let stretch = match def.render.mode {
            RenderMode::Stretched { factor } => self.p.vel.iter().fold(0.0f32, |a, v| a.max(v.length_squared())).sqrt() * factor,
            _ => 0.0,
        };
        self.max_size = def.size.1 * ctx.scale * peak * def.aspect.max(1.0) + stretch;
    }

    #[allow(clippy::too_many_arguments)]
    #[inline]
    fn spawn(
        &mut self,
        def: &EmitterDef,
        ce: &CompiledEmitter,
        origin: Vec3A,
        rot: Quat,
        scale: f32,
        inherit: Vec3A,
        pre_age: f32,
        children: &mut [EmitterState],
        child_base: usize,
    ) {
        let rng = &mut self.rng;
        let local = def.shape.sample(rng);
        let pos = origin + rot * ((local + Vec3A::from(def.offset)) * scale);
        let dir = match (&def.velocity, &def.shape) {
            (Velocity::None, _) => Vec3A::ZERO,
            (Velocity::Radial { speed }, Shape::Cone { angle, .. }) => rot * rng.in_cap(*angle) * rng.range(speed.0, speed.1),
            (Velocity::Radial { speed }, _) => {
                let d = local.try_normalize().unwrap_or_else(|| rng.unit());
                rot * d * rng.range(speed.0, speed.1)
            }
            (Velocity::Cone { dir, angle, speed }, _) => rot * rng.in_cone(*dir, *angle) * rng.range(speed.0, speed.1),
            (Velocity::Fixed { v, jitter }, _) => rot * (Vec3A::from(*v) + rng.in_cube() * Vec3A::from(*jitter)),
        };
        let vel = dir * scale + inherit;
        let life = rng.range(def.lifetime.0, def.lifetime.1).max(1e-3);
        let size = rng.range(def.size.0, def.size.1) * scale;
        let r0 = rng.range(def.rotation.0, def.rotation.1);
        let spin = rng.range(def.spin.0, def.spin.1);
        let seed = rng.next_u32();
        let pos = pos + vel * pre_age;
        self.p.pos.push(pos);
        self.p.vel.push(vel);
        self.p.age.push(pre_age);
        self.p.inv_life.push(1.0 / life);
        self.p.size.push(size);
        self.p.rot.push(r0);
        self.p.spin.push(spin);
        self.p.seed.push(seed);
        let trail = ce.trail_points as usize;
        if trail > 0 {
            let start = self.p.trail.len();
            self.p.trail.resize(start + trail, pos);
            self.p.trail_len.push(1);
            self.p.trail[start + self.trail_head as usize] = pos;
        }
        self.spawned += 1;
        self.spawned_frame += 1;
        if ce.has_spawn_subs {
            fire(&ce.subs, Trigger::Spawn, pos, vel, &mut self.rng, children, child_base);
        }
    }

    /// Collision response for one particle hit (used by the physics raycast pass).
    #[cfg_attr(not(feature = "physics"), allow(dead_code))]
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn bounce(
        &mut self,
        i: usize,
        hit: Vec3A,
        normal: Vec3A,
        restitution: f32,
        friction: f32,
        die: bool,
        ce: &CompiledEmitter,
        children: &mut [EmitterState],
        child_base: usize,
    ) -> bool {
        let v = self.p.vel[i];
        if ce.has_collision_subs {
            fire(&ce.subs, Trigger::Collision, hit, v, &mut self.rng, children, child_base);
        }
        if die {
            self.p.kill(i, ce.trail_points as usize);
            self.died += 1;
            return true;
        }
        let vn = normal * v.dot(normal);
        let vt = v - vn;
        self.p.vel[i] = vt * (1.0 - friction) - vn * restitution;
        self.p.pos[i] = hit + normal * 0.01;
        false
    }
}

#[inline]
fn fire(
    subs: &[(Trigger, usize, u32, f32, f32)],
    on: Trigger,
    pos: Vec3A,
    vel: Vec3A,
    rng: &mut Rng,
    children: &mut [EmitterState],
    child_base: usize,
) {
    for &(t, target, count, inherit, chance) in subs {
        if t != on || (chance < 1.0 && rng.f01() >= chance) {
            continue;
        }
        if let Some(c) = children.get_mut(target - child_base) {
            c.incoming.push(SpawnEvent { pos, vel: vel * inherit, count });
        }
    }
}

/// Reads a baked table at normalized age `t`.
#[inline]
pub fn lut<T: Copy>(table: &[T; LUT], t: f32) -> T {
    table[lut_index(t)]
}

#[cfg(test)]
mod tests {
    use super::super::curve::Curve;
    use super::super::def::*;
    use super::*;

    fn one(e: EmitterDef) -> CompiledEffect {
        CompiledEffect::new(EffectDef::new("t").with(e)).unwrap()
    }

    fn run(fx: &CompiledEffect, st: &mut InstanceState, frames: usize, dt: f32) {
        let b = Budget::unlimited();
        for _ in 0..frames {
            st.step(fx, &FrameCtx { dt, ..FrameCtx::at(Vec3::ZERO) }, &b);
        }
    }

    #[test]
    fn rate_spawns_and_lifetime_kills() {
        let fx = one(EmitterDef { rate: 60.0, lifetime: (0.5, 0.5), capacity: 1000, ..default_e() });
        let mut st = InstanceState::new(&fx, 1);
        run(&fx, &mut st, 60, 1.0 / 60.0);
        // Steady state: rate × lifetime alive (± one frame's worth).
        let n = st.alive() as i32;
        assert!((n - 30).abs() <= 2, "alive {n}");
        assert_eq!(st.emitters[0].spawned, 60);
    }

    fn default_e() -> EmitterDef {
        EmitterDef::default()
    }

    #[test]
    fn gravity_integration_matches_closed_form() {
        let fx = one(EmitterDef {
            bursts: vec![Burst::at(0.0, 1)],
            lifetime: (10.0, 10.0),
            velocity: Velocity::Fixed { v: Vec3::new(2.0, 5.0, 0.0), jitter: Vec3::ZERO },
            gravity: Vec3::new(0.0, -10.0, 0.0),
            ..default_e()
        });
        let mut st = InstanceState::new(&fx, 1);
        let dt = 0.01;
        run(&fx, &mut st, 101, dt);
        // Spawned on frame 0 (no motion that frame), then 100 semi-implicit Euler steps.
        let p = st.emitters[0].p.pos[0];
        let n = 100.0;
        let t = n * dt;
        let y = 5.0 * t - 10.0 * dt * dt * n * (n + 1.0) / 2.0;
        assert!((p.x - 2.0 * t).abs() < 1e-4, "{p}");
        assert!((p.y - y).abs() < 1e-4, "{p} vs {y}");
    }

    #[test]
    fn deterministic_for_a_seed() {
        let fx = CompiledEffect::new(super::super::presets::explosion()).unwrap();
        let (mut a, mut b) = (InstanceState::new(&fx, 9), InstanceState::new(&fx, 9));
        run(&fx, &mut a, 90, 1.0 / 60.0);
        run(&fx, &mut b, 90, 1.0 / 60.0);
        assert_eq!(a.alive(), b.alive());
        for (ea, eb) in a.emitters.iter().zip(&b.emitters) {
            assert_eq!(ea.p.pos, eb.p.pos);
        }
        let mut c = InstanceState::new(&fx, 10);
        run(&fx, &mut c, 90, 1.0 / 60.0);
        let all = |s: &InstanceState| s.emitters.iter().flat_map(|e| e.p.pos.clone()).collect::<Vec<_>>();
        assert!(!all(&a).is_empty());
        assert_ne!(all(&a), all(&c), "another seed, other particles");
    }

    #[test]
    fn sub_emitters_fire_on_death_and_collision() {
        let fx = CompiledEffect::new(
            EffectDef::new("t")
                .once(0.1)
                .with(EmitterDef {
                    name: "shell".into(),
                    bursts: vec![Burst::at(0.0, 5)],
                    lifetime: (0.2, 0.2),
                    sub_emitters: vec![SubEmitter { on: Trigger::Death, emitter: "frag".into(), count: 4, ..Default::default() }],
                    ..default_e()
                })
                .with(EmitterDef {
                    name: "frag".into(),
                    lifetime: (5.0, 5.0),
                    velocity: Velocity::Fixed { v: Vec3::new(0.0, -3.0, 0.0), jitter: Vec3::ZERO },
                    collision: Collision::Plane { height: -1.0, restitution: 0.0, friction: 0.0, die: true },
                    sub_emitters: vec![SubEmitter { on: Trigger::Collision, emitter: "splash".into(), count: 2, ..Default::default() }],
                    ..default_e()
                })
                .with(EmitterDef { name: "splash".into(), lifetime: (5.0, 5.0), ..default_e() }),
        )
        .unwrap();
        let mut st = InstanceState::new(&fx, 3);
        run(&fx, &mut st, 20, 1.0 / 60.0); // shells die at 0.2 s
        assert_eq!(st.emitters[0].p.len(), 0);
        assert_eq!(st.emitters[1].spawned, 20);
        run(&fx, &mut st, 60, 1.0 / 60.0); // frags fall 1 m at 3 m/s
        assert_eq!(st.emitters[1].p.len(), 0, "frags died on the plane");
        assert_eq!(st.emitters[2].spawned, 40);
        assert!(st.emitters[2].p.pos.iter().all(|p| (p.y + 1.0).abs() < 1e-4));
        assert!(!st.finished(&fx));
    }

    #[test]
    fn spawn_triggers_mesh_surface_orbit_and_attractor() {
        // Every spawned carrier spawns 2 sparks where it is (Trigger::Spawn).
        let mesh: bevy::mesh::Mesh = bevy::math::primitives::Cuboid::new(2.0, 2.0, 2.0).into();
        let fx = CompiledEffect::new(
            EffectDef::new("t")
                .with(EmitterDef {
                    name: "carrier".into(),
                    bursts: vec![Burst::at(0.0, 10)],
                    lifetime: (5.0, 5.0),
                    shape: Shape::mesh_surface(&mesh, 64, 1),
                    sub_emitters: vec![SubEmitter { on: Trigger::Spawn, emitter: "spark".into(), count: 2, ..Default::default() }],
                    ..default_e()
                })
                .with(EmitterDef { name: "spark".into(), lifetime: (5.0, 5.0), ..default_e() }),
        )
        .unwrap();
        let mut st = InstanceState::new(&fx, 8);
        run(&fx, &mut st, 2, 1.0 / 60.0);
        assert_eq!(st.emitters[1].spawned, 20);
        // Surface points of a 2 m cube: max |coordinate| is 1.
        for p in &st.emitters[0].p.pos {
            assert!((p.abs().max_element() - 1.0).abs() < 1e-4, "{p}");
        }

        // Orbit keeps the radius (no radial term); an attractor pulls particles in.
        let orbit = one(EmitterDef {
            bursts: vec![Burst::at(0.0, 20)],
            lifetime: (9.0, 9.0),
            shape: Shape::Ring { radius: 2.0 },
            orbit: Some(Orbit { axis: Vec3::Y, speed: 2.0, radial: 0.0 }),
            ..default_e()
        });
        let mut st = InstanceState::new(&orbit, 1);
        run(&orbit, &mut st, 60, 1.0 / 60.0);
        let first = st.emitters[0].p.pos[0];
        assert!(st.emitters[0].p.pos.iter().all(|p| (p.length() - 2.0).abs() < 1e-3));
        run(&orbit, &mut st, 30, 1.0 / 60.0);
        assert!((st.emitters[0].p.pos[0] - first).length() > 0.5, "moved along the ring");

        let pull = one(EmitterDef {
            bursts: vec![Burst::at(0.0, 20)],
            lifetime: (9.0, 9.0),
            shape: Shape::Sphere { radius: 3.0, surface: true },
            attractors: vec![Attractor { strength: 20.0, radius: 1.0, kill_radius: 0.3, ..Default::default() }],
            drag: 2.0,
            ..default_e()
        });
        let mut st = InstanceState::new(&pull, 1);
        run(&pull, &mut st, 180, 1.0 / 60.0);
        let e = &st.emitters[0];
        assert!(e.died > 0 || e.p.pos.iter().all(|p| p.length() < 2.0), "pulled in: died {} {:?}", e.died, e.p.pos.first());
    }

    #[test]
    fn budgets_cap_spawns() {
        let fx = one(EmitterDef { rate: 6000.0, lifetime: (10.0, 10.0), capacity: 50, ..default_e() });
        let mut st = InstanceState::new(&fx, 1);
        run(&fx, &mut st, 10, 1.0 / 60.0);
        assert_eq!(st.alive(), 50, "capacity");
        let fx = one(EmitterDef { rate: 6000.0, lifetime: (10.0, 10.0), capacity: 5000, ..default_e() });
        let mut st = InstanceState::new(&fx, 1);
        let b = Budget::new(30);
        st.step(&fx, &FrameCtx { dt: 0.1, ..FrameCtx::at(Vec3::ZERO) }, &b);
        assert_eq!(st.alive(), 30, "global budget");
        assert_eq!(st.emitters[0].dropped, 570);
    }

    #[test]
    fn one_shot_finishes_and_restart_reuses_buffers() {
        let fx = one(EmitterDef { bursts: vec![Burst::at(0.0, 20)], lifetime: (0.3, 0.5), ..default_e() });
        let fx = CompiledEffect::new(EffectDef { duration: 0.1, ..fx.def.clone() }).unwrap();
        let mut st = InstanceState::new(&fx, 1);
        run(&fx, &mut st, 1, 1.0 / 60.0);
        assert_eq!(st.alive(), 20);
        let cap = st.emitters[0].p.pos.capacity();
        run(&fx, &mut st, 40, 1.0 / 60.0);
        assert!(st.finished(&fx));
        st.restart(2);
        run(&fx, &mut st, 1, 1.0 / 60.0);
        assert_eq!(st.alive(), 20);
        assert_eq!(st.emitters[0].p.pos.capacity(), cap, "no reallocation");
    }

    #[test]
    fn looping_bursts_repeat() {
        let fx = CompiledEffect::new(
            EffectDef { duration: 0.5, looping: true, ..EffectDef::new("t") }.with(EmitterDef {
                bursts: vec![Burst::at(0.0, 3)],
                lifetime: (10.0, 10.0),
                ..default_e()
            }),
        )
        .unwrap();
        let mut st = InstanceState::new(&fx, 1);
        run(&fx, &mut st, 61, 1.0 / 60.0); // t = 0 .. 1.0167 → bursts at 0, 0.5, 1.0
        assert_eq!(st.alive(), 9);
    }

    #[test]
    fn trails_record_history_and_survive_swap_remove() {
        let fx = one(EmitterDef {
            rate: 30.0,
            lifetime: (0.3, 0.6),
            velocity: Velocity::Fixed { v: Vec3::X, jitter: Vec3::ZERO },
            render: RenderDef { mode: RenderMode::Trail { points: 8, interval: 1.0 / 60.0, taper: Curve::linear(1.0, 0.0) }, ..Default::default() },
            ..default_e()
        });
        let mut st = InstanceState::new(&fx, 5);
        run(&fx, &mut st, 90, 1.0 / 60.0);
        let e = &st.emitters[0];
        assert!(!e.p.is_empty());
        for i in 0..e.p.len() {
            let n = e.p.trail_len[i] as usize;
            assert!(n >= 1);
            let head = e.p.trail[i * 8 + e.trail_head as usize];
            assert!((head - e.p.pos[i]).length() < 1e-4, "newest trail point is the particle");
            // Older points lie behind along -X.
            if n > 1 {
                let prev = e.p.trail[i * 8 + (e.trail_head as usize + 7) % 8];
                assert!(prev.x < head.x);
            }
        }
    }

    #[test]
    fn invalid_defs_are_rejected() {
        assert!(CompiledEffect::new(EffectDef::new("x")).is_err());
        let bad = EffectDef::new("x").with(EmitterDef {
            name: "a".into(),
            sub_emitters: vec![SubEmitter { emitter: "a".into(), ..Default::default() }],
            ..default_e()
        });
        assert!(CompiledEffect::new(bad).unwrap_err().contains("after"));
        assert!(CompiledEffect::new(EffectDef::new("x").with(EmitterDef { capacity: 0, ..default_e() })).is_err());
    }

    #[test]
    fn fast_trig_is_close() {
        for i in -400..400 {
            let x = i as f32 * 0.05;
            assert!((fsin(x) - x.sin()).abs() < 2e-3, "{x}");
        }
        // Divergence ≈ 0 (finite differences).
        let h = 1e-2;
        for i in 0..20 {
            let p = Vec3A::new(i as f32 * 0.37, i as f32 * -0.21, 1.3);
            let div = (curl(p + Vec3A::X * h, 0.4).x - curl(p - Vec3A::X * h, 0.4).x
                + curl(p + Vec3A::Y * h, 0.4).y
                - curl(p - Vec3A::Y * h, 0.4).y
                + curl(p + Vec3A::Z * h, 0.4).z
                - curl(p - Vec3A::Z * h, 0.4).z)
                / (2.0 * h);
            assert!(div.abs() < 0.15, "div {div} at {p}");
        }
    }
}
