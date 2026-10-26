//! Perception: sight (range + view cone + avian line-of-sight raycast, at most
//! [`AiConfig::sight_rays_per_frame`] rays per frame, stalest pairs first), hearing ([`Noise`]
//! messages with a radius) and memory of last known positions.
//!
//! ```ignore
//! commands.spawn((Perceiver::default(), Perception::default(), Transform::..));  // the guard
//! commands.spawn((Perceivable { team: 1, ..default() }, Collider::.., Transform::..)); // the player
//! noises.write(Noise { pos, radius: 15.0, source: Some(player) });
//! // read: perception.visible().next(), perception.last_known(player)
//! ```

use avian3d::prelude::{SpatialQuery, SpatialQueryFilter};
use bevy::prelude::*;
use serde_json::{Value, json};

use super::rvo::SpatialGrid;
use super::{AiConfig, AiStats};

/// Something that sees and hears. Looks along its Transform's forward (-Z).
#[derive(Component, Clone, Debug, Reflect)]
#[require(Perception)]
pub struct Perceiver {
    pub sight_range: f32,
    /// Full view cone angle (degrees).
    pub fov_deg: f32,
    /// Eye height above the Transform origin.
    pub eye_height: f32,
    /// Multiplies noise radii for this listener (0 = deaf).
    pub hearing: f32,
    /// Forget a target this long after last sensing it.
    pub memory_secs: f32,
    /// Ignore perceivables of the same team (0 = no team).
    pub team: u32,
}

impl Default for Perceiver {
    fn default() -> Self {
        Perceiver { sight_range: 25.0, fov_deg: 120.0, eye_height: 1.6, hearing: 1.0, memory_secs: 10.0, team: 0 }
    }
}

/// Something that can be seen. `aim_height` = the point rays target, above the origin.
#[derive(Component, Clone, Debug, Reflect)]
pub struct Perceivable {
    pub team: u32,
    pub aim_height: f32,
}

impl Default for Perceivable {
    fn default() -> Self {
        Perceivable { team: 0, aim_height: 1.0 }
    }
}

/// A sound: perceivers within `radius × hearing` remember `pos` (and `source`).
#[derive(Message, Clone, Copy, Debug)]
pub struct Noise {
    pub pos: Vec3,
    pub radius: f32,
    pub source: Option<Entity>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
pub enum Sense {
    Sight,
    Hearing,
}

/// One remembered stimulus.
#[derive(Clone, Copy, Debug)]
pub struct Percept {
    /// `None` for anonymous noises.
    pub entity: Option<Entity>,
    pub last_pos: Vec3,
    pub last_time: f64,
    pub visible: bool,
    pub sense: Sense,
    /// When line of sight was last tested (sight budget priority).
    pub last_check: f64,
}

/// What a [`Perceiver`] knows.
#[derive(Component, Clone, Debug, Default)]
pub struct Perception {
    pub known: Vec<Percept>,
}

impl Perception {
    pub fn get(&self, e: Entity) -> Option<&Percept> {
        self.known.iter().find(|p| p.entity == Some(e))
    }
    /// Currently visible entities.
    pub fn visible(&self) -> impl Iterator<Item = Entity> + '_ {
        self.known.iter().filter(|p| p.visible).filter_map(|p| p.entity)
    }
    pub fn sees(&self, e: Entity) -> bool {
        self.get(e).is_some_and(|p| p.visible)
    }
    pub fn last_known(&self, e: Entity) -> Option<Vec3> {
        self.get(e).map(|p| p.last_pos)
    }
    /// The freshest stimulus (visible first).
    pub fn most_recent(&self) -> Option<&Percept> {
        self.known.iter().max_by(|a, b| (a.visible, a.last_time).partial_cmp(&(b.visible, b.last_time)).unwrap_or(std::cmp::Ordering::Equal))
    }
    fn entry(&mut self, e: Option<Entity>, sense: Sense) -> &mut Percept {
        let i = match self.known.iter().position(|p| p.entity == e && (e.is_some() || p.sense == sense)) {
            Some(i) => i,
            None => {
                self.known.push(Percept { entity: e, last_pos: Vec3::ZERO, last_time: 0.0, visible: false, sense, last_check: f64::MIN });
                self.known.len() - 1
            }
        };
        &mut self.known[i]
    }
    pub fn to_json(&self) -> Value {
        Value::Array(
            self.known
                .iter()
                .map(|p| {
                    json!({
                        "entity": p.entity.map(|e| e.to_bits()),
                        "visible": p.visible,
                        "sense": p.sense,
                        "last_pos": [p.last_pos.x, p.last_pos.y, p.last_pos.z],
                        "last_time": p.last_time,
                    })
                })
                .collect(),
        )
    }
}

#[derive(Clone, Copy)]
struct Candidate {
    p: u32,
    t: u32,
    staleness: f64,
}

#[derive(Default)]
pub(crate) struct SenseScratch {
    perceivers: Vec<(Entity, Vec3, Vec3, f32, f32, u32)>, // entity, eye, forward, range, cos(half fov), team
    targets: Vec<(Entity, Vec3, u32)>,
    grid: SpatialGrid,
    cands: Vec<Candidate>,
    in_view: Vec<(u32, u32)>,
    tmap: bevy::platform::collections::HashMap<Entity, u32>,
    stamp: Vec<u32>,
    lastc: Vec<f64>,
}

/// Sight + hearing + forgetting.
pub(crate) fn update_perception(
    cfg: Res<AiConfig>,
    time: Res<Time>,
    spatial: SpatialQuery,
    perceivers: Query<(Entity, &Perceiver, &GlobalTransform)>,
    targets: Query<(Entity, &Perceivable, &GlobalTransform)>,
    parents: Query<&ChildOf>,
    mut perception: Query<(&Perceiver, &mut Perception)>,
    mut noises: MessageReader<Noise>,
    mut scratch: Local<SenseScratch>,
    mut stats: ResMut<AiStats>,
) {
    let t0 = std::time::Instant::now();
    let now = time.elapsed_secs_f64();
    let sc = &mut *scratch;
    sc.perceivers.clear();
    sc.targets.clear();
    let mut max_range = 1.0f32;
    for (e, p, gt) in &perceivers {
        let eye = gt.translation() + Vec3::Y * p.eye_height;
        let fwd = gt.forward().as_vec3();
        let half = (p.fov_deg.clamp(1.0, 360.0) * 0.5).to_radians();
        sc.perceivers.push((e, eye, fwd, p.sight_range, half.cos(), p.team));
        max_range = max_range.max(p.sight_range);
    }
    for (e, t, gt) in &targets {
        sc.targets.push((e, gt.translation() + Vec3::Y * t.aim_height, t.team));
    }
    // 1. Cheap filter: range + cone (grid over targets).
    sc.grid.rebuild((max_range * 0.5).max(4.0), sc.targets.iter().map(|t| t.1.xz()));
    sc.cands.clear();
    sc.in_view.clear();
    for (pi, &(pe, eye, fwd, range, cos_half, team)) in sc.perceivers.iter().enumerate() {
        let targets = &sc.targets;
        let in_view = &mut sc.in_view;
        sc.grid.query(eye.xz(), range, |ti| {
            let (te, tp, tteam) = targets[ti as usize];
            if te == pe || (team != 0 && tteam == team) {
                return;
            }
            let d = tp - eye;
            let dist = d.length();
            if dist > range || dist < 1e-4 {
                return;
            }
            if d.dot(fwd) / dist < cos_half {
                return;
            }
            in_view.push((pi as u32, ti));
        });
    }
    // Staleness from memory, O(known + in-view) per perceiver via per-target stamps.
    sc.tmap.clear();
    for (i, t) in sc.targets.iter().enumerate() {
        sc.tmap.insert(t.0, i as u32);
    }
    let nt = sc.targets.len();
    sc.stamp.clear();
    sc.stamp.resize(nt, 0);
    sc.lastc.clear();
    sc.lastc.resize(nt, f64::MIN);
    let mut lo = 0;
    for (pi, &(pe, ..)) in sc.perceivers.iter().enumerate() {
        let hi = lo + sc.in_view[lo..].partition_point(|&(i, _)| i as usize == pi);
        if hi > lo {
            let mark = pi as u32 + 1;
            if let Ok((_, m)) = perception.get(pe) {
                for k in &m.known {
                    if let Some(&ti) = k.entity.and_then(|e| sc.tmap.get(&e)) {
                        sc.stamp[ti as usize] = mark;
                        sc.lastc[ti as usize] = k.last_check;
                    }
                }
            }
            for &(_, ti) in &sc.in_view[lo..hi] {
                let last = if sc.stamp[ti as usize] == mark { sc.lastc[ti as usize] } else { f64::MIN };
                sc.cands.push(Candidate { p: pi as u32, t: ti, staleness: now - last.max(-1e9) });
            }
        }
        lo = hi;
    }
    // 2. Raycast the stalest `budget` pairs.
    let budget = cfg.sight_rays_per_frame as usize;
    if sc.cands.len() > budget && budget > 0 {
        sc.cands.select_nth_unstable_by(budget - 1, |a, b| b.staleness.total_cmp(&a.staleness));
        sc.cands.truncate(budget);
    } else if budget == 0 {
        sc.cands.clear();
    }
    let filter = SpatialQueryFilter::default();
    let mut rays = 0u32;
    for c in &sc.cands {
        let (pe, eye, ..) = sc.perceivers[c.p as usize];
        let (te, tp, _) = sc.targets[c.t as usize];
        let d = tp - eye;
        let dist = d.length();
        let Ok(dir) = Dir3::new(d / dist) else { continue };
        rays += 1;
        let is_self = |e: Entity| e == pe || parents.get(e).is_ok_and(|c| c.parent() == pe);
        let hit = spatial.cast_ray_predicate(eye, dir, dist, true, &filter, &|e| !is_self(e));
        let visible = match hit {
            None => true,
            Some(h) => h.entity == te || parents.get(h.entity).is_ok_and(|c| c.parent() == te),
        };
        if let Ok((_, mut mem)) = perception.get_mut(pe) {
            let p = mem.entry(Some(te), Sense::Sight);
            p.last_check = now;
            p.visible = visible;
            if visible {
                p.last_pos = tp;
                p.last_time = now;
                p.sense = Sense::Sight;
            }
        }
    }
    // Targets that left the cone/range are no longer visible; visible ones are tracked between
    // raycasts. Stamps mark this perceiver's in-view targets (O(known + in-view)).
    sc.stamp.iter_mut().for_each(|s| *s = 0);
    let mut lo = 0;
    for (pi, &(pe, ..)) in sc.perceivers.iter().enumerate() {
        let hi = lo + sc.in_view[lo..].partition_point(|&(i, _)| i as usize == pi);
        let mark = pi as u32 + 1;
        for &(_, ti) in &sc.in_view[lo..hi] {
            sc.stamp[ti as usize] = mark;
        }
        lo = hi;
        let Ok((_, mut mem)) = perception.get_mut(pe) else { continue };
        if !mem.known.iter().any(|p| p.visible) {
            continue;
        }
        for p in mem.known.iter_mut().filter(|p| p.visible) {
            match p.entity.and_then(|e| sc.tmap.get(&e)).copied() {
                Some(ti) if sc.stamp[ti as usize] == mark => {
                    p.last_pos = sc.targets[ti as usize].1;
                    p.last_time = now;
                }
                _ => p.visible = false,
            }
        }
    }
    // 3. Hearing.
    for n in noises.read() {
        for (pe, eye, ..) in &sc.perceivers {
            let Ok((cfg_p, mut mem)) = perception.get_mut(*pe) else { continue };
            if n.source == Some(*pe) || cfg_p.hearing <= 0.0 {
                continue;
            }
            if eye.distance(n.pos) > n.radius * cfg_p.hearing {
                continue;
            }
            let p = mem.entry(n.source, Sense::Hearing);
            p.last_pos = n.pos;
            p.last_time = now;
            if !p.visible {
                p.sense = Sense::Hearing;
            }
        }
    }
    // 4. Forget.
    for (p, mut mem) in &mut perception {
        let keep = p.memory_secs as f64;
        let keep_entry = |k: &Percept| k.visible || (k.last_time > 0.0 && now - k.last_time <= keep) || now - k.last_check < 1.0;
        if !mem.known.iter().all(keep_entry) {
            mem.known.retain(keep_entry);
        }
    }
    stats.sight_rays = rays;
    stats.sight_candidates = sc.in_view.len() as u32;
    stats.sense_us = t0.elapsed().as_micros() as u32;
}
