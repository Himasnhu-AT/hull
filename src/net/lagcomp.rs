//! Server-side lag compensation ("favor the shooter"): the server keeps recent transforms of
//! [`LagCompensated`] entities by tick, and every client input carries the (fractional) tick
//! that client was rendering remote entities at. A hit test can then rewind to what the
//! shooter actually saw:
//!
//! ```ignore
//! fn fire(lag: Res<LagCompensation>, shots: MessageReader<FromClient<Shoot>>, ..) {
//!     for s in shots.read() {
//!         let tick = lag.view_tick(s.client).unwrap_or(now);
//!         if let Some((victim, dist)) = lag.ray_cast(origin, dir, 100.0, tick, |_| Some(0.5)) { .. }
//!     }
//! }
//! ```
//! Off unless `NetConfig::lag_compensation_ticks > 0` (then ~32 bytes per entity per tick).
//! Rewinds `Transform` only; colliders of other shapes / physics queries at a past tick are
//! the game's job (use [`LagCompensation::transform_at`]).

use std::collections::VecDeque;

use bevy::platform::collections::HashMap;
use bevy::prelude::*;

use super::endpoint::ClientId;
use super::{NetClock, NetConfig};

/// Server: keep this entity's transform history for lag-compensated hit tests.
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct LagCompensated;

/// Transform history + each client's view tick.
#[derive(Resource, Default)]
pub struct LagCompensation {
    history: HashMap<Entity, VecDeque<(u32, Transform)>>,
    views: HashMap<ClientId, f64>,
    stamp: u32,
    seen: HashMap<Entity, u32>,
}

impl LagCompensation {
    /// The server tick `client` was rendering remote entities at in its latest input.
    pub fn view_tick(&self, client: ClientId) -> Option<f64> {
        self.views.get(&client).copied()
    }

    pub(crate) fn set_view(&mut self, client: ClientId, tick: f64) {
        let v = self.views.entry(client).or_insert(tick);
        *v = v.max(tick); // inputs can arrive out of order
    }

    /// `entity`'s transform at a (fractional) past tick, interpolated between recorded ticks.
    /// Clamped to the oldest/newest record.
    pub fn transform_at(&self, entity: Entity, tick: f64) -> Option<Transform> {
        let h = self.history.get(&entity)?;
        let (first, last) = (h.front()?, h.back()?);
        if tick <= f64::from(first.0) {
            return Some(first.1);
        }
        if tick >= f64::from(last.0) {
            return Some(last.1);
        }
        let i = h.partition_point(|(t, _)| f64::from(*t) <= tick);
        let (ta, a) = h[i - 1];
        let (tb, b) = h[i];
        let f = ((tick - f64::from(ta)) / f64::from(tb - ta).max(1.0)) as f32;
        Some(Transform {
            translation: a.translation.lerp(b.translation, f),
            rotation: a.rotation.slerp(b.rotation, f),
            scale: a.scale.lerp(b.scale, f),
        })
    }

    /// Nearest entity whose sphere (`radius(entity)`, `None` = skip) at `tick` the ray hits.
    pub fn ray_cast(&self, origin: Vec3, dir: Dir3, max_dist: f32, tick: f64, radius: impl Fn(Entity) -> Option<f32>) -> Option<(Entity, f32)> {
        let mut best: Option<(Entity, f32)> = None;
        for &e in self.history.keys() {
            let Some(r) = radius(e) else { continue };
            let Some(t) = self.transform_at(e, tick) else { continue };
            // Ray-sphere: |o + d s - c|^2 = r^2.
            let oc = origin - t.translation;
            let b = oc.dot(*dir);
            let c = oc.length_squared() - r * r;
            let disc = b * b - c;
            if disc < 0.0 {
                continue;
            }
            let s = -b - disc.sqrt();
            let s = if s < 0.0 { -b + disc.sqrt() } else { s };
            if s >= 0.0 && s <= max_dist && best.is_none_or(|(_, d)| s < d) {
                best = Some((e, s));
            }
        }
        best
    }

    pub fn tracked(&self) -> usize {
        self.history.len()
    }
}

/// `FixedLast`: record this tick's transforms; forget despawned entities and old ticks.
pub(crate) fn record(clock: Res<NetClock>, cfg: Res<NetConfig>, mut lag: ResMut<LagCompensation>, q: Query<(Entity, &Transform), With<LagCompensated>>) {
    let window = cfg.lag_compensation_ticks;
    if window == 0 {
        return;
    }
    let lag = &mut *lag;
    lag.stamp = lag.stamp.wrapping_add(1);
    for (e, t) in &q {
        let h = lag.history.entry(e).or_default();
        while h.back().is_some_and(|(tk, _)| *tk >= clock.tick) {
            h.pop_back();
        }
        h.push_back((clock.tick, *t));
        while h.front().is_some_and(|(tk, _)| clock.tick.wrapping_sub(*tk) > window) {
            h.pop_front();
        }
        lag.seen.insert(e, lag.stamp);
    }
    let stamp = lag.stamp;
    if lag.seen.len() != q.iter().len() || stamp.is_multiple_of(64) {
        let seen = &lag.seen;
        lag.history.retain(|e, _| seen.get(e) == Some(&stamp));
        lag.seen.retain(|_, s| *s == stamp);
    }
}
