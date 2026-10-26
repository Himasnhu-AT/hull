//! Nav agents: path following + arrive + separation + ORCA avoidance, constrained to the mesh.
//!
//! ```ignore
//! commands.spawn((NavAgent { max_speed: 3.5, ..default() }, Transform::from_xyz(0.0, 0.0, 0.0)));
//! // later
//! state.set_target(Vec3::new(20.0, 0.0, 5.0));
//! ```
//! Motion: [`NavMotion::Transform`] moves the `Transform` along the mesh surface (no physics
//! needed), [`NavMotion::Velocity`] writes avian `LinearVelocity` (XZ; Y is left to gravity) for
//! kinematic or dynamic bodies, [`NavMotion::Manual`] only fills
//! [`NavAgentState::desired_velocity`] for the game's own controller.

use avian3d::prelude::LinearVelocity;
use bevy::prelude::*;

use super::nav::mesh::PolyRef;
use super::nav::query::{NavPath, PathError, PathPoint, move_along_surface};
use super::nav::sources::{NavMeshChanged, NavMeshes};
use super::rvo::{Line, Neighbor, SpatialGrid, orca_velocity};
use super::{AiConfig, AiStats};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Reflect, serde::Serialize)]
pub enum NavMotion {
    /// Move the Transform along the navmesh surface.
    #[default]
    Transform,
    /// Write avian `LinearVelocity` (XZ).
    Velocity,
    /// Compute velocities only.
    Manual,
}

/// A navigating agent. Its `Transform` origin is `base_offset` above its feet.
#[derive(Component, Clone, Debug, Reflect)]
#[require(NavAgentState, Transform)]
pub struct NavAgent {
    /// Index into [`AiConfig::agent_types`] (which navmesh to walk).
    pub agent_type: usize,
    pub radius: f32,
    pub max_speed: f32,
    pub max_accel: f32,
    /// Start slowing down this far from the goal.
    pub slowing_distance: f32,
    /// Arrived when this close to the goal.
    pub stop_distance: f32,
    /// ORCA avoidance with other avoiding agents.
    pub avoidance: bool,
    /// Separation steering weight (0 = off).
    pub separation: f32,
    pub motion: NavMotion,
    /// Turn the Transform to face the movement direction (rad/s; 0 = don't).
    pub turn_speed: f32,
    /// Height of the Transform origin above the feet (e.g. half a capsule's height).
    pub base_offset: f32,
}

impl Default for NavAgent {
    fn default() -> Self {
        NavAgent {
            agent_type: 0,
            radius: 0.4,
            max_speed: 3.5,
            max_accel: 12.0,
            slowing_distance: 1.5,
            stop_distance: 0.2,
            avoidance: true,
            separation: 0.0,
            motion: NavMotion::Transform,
            turn_speed: 10.0,
            base_offset: 0.0,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Reflect, serde::Serialize)]
pub enum NavStatus {
    #[default]
    Idle,
    /// Waiting in the path queue.
    Pending,
    Moving,
    /// On an off-mesh link (jump/ladder).
    TraversingLink,
    Arrived,
    /// No path (start or goal off the mesh).
    Failed,
}

/// Runtime state of a [`NavAgent`] (path, velocity, status). Set goals with
/// [`Self::set_target`].
#[derive(Component, Clone, Debug, Default)]
pub struct NavAgentState {
    pub target: Option<Vec3>,
    pub status: NavStatus,
    pub path: Vec<PathPoint>,
    pub corridor: Vec<PolyRef>,
    /// Index of the path point being walked to.
    pub next: usize,
    /// `false` when the goal is unreachable and the path ends at the closest point.
    pub path_complete: bool,
    pub velocity: Vec3,
    pub desired_velocity: Vec3,
    pub poly: Option<PolyRef>,
    /// Off-mesh link being traversed: (start, end, progress 0..1, link index).
    pub link: Option<(Vec3, Vec3, f32, u32)>,
    pub(crate) needs_path: bool,
    pub(crate) queued: bool,
    pub(crate) repath_cooldown: f32,
}

impl NavAgentState {
    /// Walk to `p` (a path is requested from the budgeted queue).
    pub fn set_target(&mut self, p: Vec3) {
        self.target = Some(p);
        self.needs_path = true;
    }

    /// Stop and forget the goal.
    pub fn stop(&mut self) {
        self.target = None;
        self.path.clear();
        self.corridor.clear();
        self.needs_path = false;
        self.status = NavStatus::Idle;
        self.desired_velocity = Vec3::ZERO;
    }

    /// Distance left along the path.
    pub fn remaining(&self, from: Vec3) -> f32 {
        let mut d = 0.0;
        let mut prev = from;
        for p in self.path.iter().skip(self.next) {
            d += prev.distance(p.pos);
            prev = p.pos;
        }
        d
    }

    pub(crate) fn set_path(&mut self, res: Result<NavPath, PathError>) {
        match res {
            Ok(p) => {
                self.path_complete = p.complete;
                self.path = p.points;
                self.corridor = p.polys;
                self.next = 1.min(self.path.len());
                self.status = NavStatus::Moving;
                self.link = None;
            }
            Err(_) => {
                self.path.clear();
                self.corridor.clear();
                self.status = NavStatus::Failed;
            }
        }
    }
}

/// Per-agent working data for one frame (SoA-ish, reused).
#[derive(Clone, Copy)]
struct Sim {
    entity: Entity,
    pos: Vec3,
    vel: Vec2,
    pref: Vec2,
    radius: f32,
    max_speed: f32,
    separation: f32,
    avoid: bool,
    active: bool,
}

#[derive(Default)]
pub(crate) struct CrowdScratch {
    sims: Vec<Sim>,
    grid: SpatialGrid,
    neighbors: Vec<(f32, Neighbor)>,
    nb: Vec<Neighbor>,
    lines: Vec<Line>,
    proj: Vec<Line>,
    out: Vec<Vec2>,
}

/// Marks agents whose corridor crosses rebaked tiles for a new path.
pub(crate) fn repath_on_mesh_change(
    mut msgs: MessageReader<NavMeshChanged>,
    navs: Res<NavMeshes>,
    mut agents: Query<(&NavAgent, &mut NavAgentState)>,
) {
    let mut any = false;
    for _ in msgs.read() {
        any = true;
    }
    if !any {
        return;
    }
    for (a, mut st) in &mut agents {
        let Some(mesh) = navs.get(a.agent_type) else { continue };
        let stale = st.corridor.iter().any(|r| !mesh.is_valid(*r)) || st.poly.is_some_and(|r| !mesh.is_valid(r));
        if stale && st.target.is_some() {
            st.needs_path = true;
        }
        if st.poly.is_some_and(|r| !mesh.is_valid(r)) {
            st.poly = None;
        }
    }
}

/// Steering + avoidance + movement for every agent.
pub(crate) fn steer_agents(
    cfg: Res<AiConfig>,
    navs: Res<NavMeshes>,
    time: Res<Time>,
    mut agents: Query<(Entity, &NavAgent, &mut NavAgentState, &mut Transform, Option<&mut LinearVelocity>)>,
    mut scratch: Local<CrowdScratch>,
    mut stats: ResMut<AiStats>,
) {
    let t0 = std::time::Instant::now();
    let dt = time.delta_secs();
    let sc = &mut *scratch;
    sc.sims.clear();
    if dt <= 0.0 {
        return;
    }
    let ext = cfg.query_extents;
    // 1. Gather + path following → preferred velocity.
    for (e, a, mut st, tf, _) in &mut agents {
        let Some(mesh) = navs.get(a.agent_type) else { continue };
        let feet = tf.translation - Vec3::Y * a.base_offset;
        // Track the poly under the agent.
        let poly = match st.poly.filter(|r| mesh.is_valid(*r)) {
            Some(r) if mesh.poly(r).is_some_and(|p| p.contains_xz(feet.x, feet.z)) => Some(r),
            Some(r) => Some(move_along_surface(mesh, r, mesh.poly(r).unwrap().closest_point(feet), feet).0),
            None => mesh.nearest_poly(feet, ext).map(|(r, _)| r),
        };
        if st.poly != poly {
            st.poly = poly;
        }
        st.repath_cooldown = (st.repath_cooldown - dt).max(0.0);
        let mut pref = Vec2::ZERO;
        let mut active = false;
        if st.status == NavStatus::Moving && !st.path.is_empty() {
            active = true;
            // Off the corridor (pushed away): ask for a new path, throttled.
            if let Some(p) = poly
                && st.repath_cooldown <= 0.0
                && !st.corridor.contains(&p)
            {
                st.needs_path = true;
                st.repath_cooldown = 0.5;
            }
            let reach = (a.radius * 0.5).max(0.15);
            while st.next < st.path.len() {
                let pt = st.path[st.next];
                let d = Vec2::new(pt.pos.x - feet.x, pt.pos.z - feet.z).length();
                let last = st.next + 1 == st.path.len();
                if let Some(li) = pt.offmesh
                    && d <= reach.max(a.max_speed * dt * 1.5)
                {
                    let end = st.path.get(st.next + 1).map(|p| p.pos).unwrap_or(pt.pos);
                    st.link = Some((pt.pos, end, 0.0, li));
                    st.status = NavStatus::TraversingLink;
                    st.next += 1;
                    break;
                }
                if !last && d <= reach {
                    st.next += 1;
                    continue;
                }
                break;
            }
            if st.status == NavStatus::Moving {
                let goal = st.path.last().unwrap().pos;
                let corner = st.path[st.next.min(st.path.len() - 1)].pos;
                let to_goal = Vec2::new(goal.x - feet.x, goal.z - feet.z).length();
                if st.next + 1 >= st.path.len() && to_goal <= a.stop_distance {
                    st.status = NavStatus::Arrived;
                    active = false;
                } else {
                    let dir = Vec2::new(corner.x - feet.x, corner.z - feet.z).normalize_or_zero();
                    let remaining = st.remaining(feet);
                    let speed = a.max_speed * (remaining / a.slowing_distance.max(1e-3)).min(1.0);
                    pref = dir * speed;
                }
            }
        }
        st.desired_velocity = Vec3::new(pref.x, 0.0, pref.y);
        let vel = Vec2::new(st.velocity.x, st.velocity.z);
        sc.sims.push(Sim { entity: e, pos: feet, vel, pref, radius: a.radius, max_speed: a.max_speed, separation: a.separation, avoid: a.avoidance, active });
    }
    // 2. Separation + ORCA.
    let n = sc.sims.len();
    sc.grid.rebuild(cfg.avoidance_neighbor_dist.max(1.0), sc.sims.iter().map(|s| s.pos.xz()));
    sc.out.clear();
    sc.out.resize(n, Vec2::ZERO);
    let mut neighbor_checks = 0u32;
    for i in 0..n {
        let s = sc.sims[i];
        let mut pref = s.pref;
        if !s.avoid {
            sc.out[i] = pref;
            continue;
        }
        sc.neighbors.clear();
        let range = cfg.avoidance_neighbor_dist + s.radius;
        let sims = &sc.sims;
        let neighbors = &mut sc.neighbors;
        sc.grid.query(s.pos.xz(), range, |j| {
            let j = j as usize;
            if j == i {
                return;
            }
            let o = &sims[j];
            if (o.pos.y - s.pos.y).abs() > 2.0 {
                return;
            }
            let d2 = o.pos.xz().distance_squared(s.pos.xz());
            if d2 > range * range {
                return;
            }
            let responsibility = if o.avoid { 0.5 } else { 1.0 };
            neighbors.push((d2, Neighbor { pos: o.pos.xz(), vel: o.vel, radius: o.radius, responsibility }));
        });
        neighbor_checks += sc.neighbors.len() as u32;
        let k = cfg.avoidance_max_neighbors.max(1);
        if sc.neighbors.len() > k {
            sc.neighbors.select_nth_unstable_by(k - 1, |a, b| a.0.total_cmp(&b.0));
            sc.neighbors.truncate(k);
        }
        // Separation (on top of ORCA, for loose crowds).
        let sep_w = s.separation;
        if sep_w > 0.0 {
            let mut push = Vec2::ZERO;
            for (d2, o) in &sc.neighbors {
                let min = s.radius + o.radius + 0.2;
                if *d2 < min * min && *d2 > 1e-8 {
                    let d = d2.sqrt();
                    push += (s.pos.xz() - o.pos) / d * (min - d) / min;
                }
            }
            pref += push * sep_w * s.max_speed;
            pref = pref.clamp_length_max(s.max_speed);
        }
        sc.nb.clear();
        sc.nb.extend(sc.neighbors.iter().map(|(_, n)| *n));
        sc.out[i] = if sc.nb.is_empty() {
            pref
        } else {
            orca_velocity(s.pos.xz(), s.vel, s.radius, pref, s.max_speed, &sc.nb, cfg.avoidance_time_horizon, dt, &mut sc.lines, &mut sc.proj)
        };
    }
    // 3. Integrate + apply.
    let mut moving = 0u32;
    for i in 0..n {
        let s = sc.sims[i];
        let Ok((_, a, mut st, mut tf, lv)) = agents.get_mut(s.entity) else { continue };
        let Some(mesh) = navs.get(a.agent_type) else { continue };
        // Off-mesh link traversal: straight line at max speed.
        if st.status == NavStatus::TraversingLink
            && let Some((from, to, t, li)) = st.link
        {
            let len = from.distance(to).max(1e-3);
            let t = (t + a.max_speed * dt / len).min(1.0);
            let p = from.lerp(to, t);
            let v = (to - from) / len * a.max_speed;
            st.velocity = v;
            match a.motion {
                NavMotion::Transform => tf.translation = p + Vec3::Y * a.base_offset,
                NavMotion::Velocity => {
                    if let Some(mut lv) = lv {
                        lv.0.x = v.x;
                        lv.0.z = v.z;
                    }
                }
                NavMotion::Manual => {}
            }
            st.desired_velocity = v;
            if t >= 1.0 {
                st.link = None;
                st.status = NavStatus::Moving;
                st.poly = mesh.nearest_poly(to, cfg.query_extents).map(|(r, _)| r);
            } else {
                st.link = Some((from, to, t, li));
            }
            moving += 1;
            continue;
        }
        let want = sc.out[i];
        let dv = (want - s.vel).clamp_length_max(a.max_accel * dt);
        let mut v = s.vel + dv;
        if !s.active && want == Vec2::ZERO && v.length_squared() < 1e-4 {
            v = Vec2::ZERO;
        }
        if v != Vec2::ZERO {
            moving += 1;
        }
        match a.motion {
            NavMotion::Transform => {
                if v != Vec2::ZERO {
                    let target = s.pos + Vec3::new(v.x, 0.0, v.y) * dt;
                    let (r, p) = match st.poly {
                        Some(r) => move_along_surface(mesh, r, s.pos, target),
                        None => (PolyRef { slot: u32::MAX, poly: 0, salt: 0 }, target),
                    };
                    if r.slot != u32::MAX {
                        st.poly = Some(r);
                    }
                    // Actual velocity after wall sliding.
                    let real = (p - s.pos) / dt;
                    v = Vec2::new(real.x, real.z);
                    tf.translation = p + Vec3::Y * a.base_offset;
                }
            }
            NavMotion::Velocity => {
                if let Some(mut lv) = lv {
                    lv.0.x = v.x;
                    lv.0.z = v.y;
                }
            }
            NavMotion::Manual => {}
        }
        if a.turn_speed > 0.0 && v.length_squared() > 0.01 {
            let yaw = (-v.x).atan2(-v.y);
            let target = Quat::from_rotation_y(yaw);
            tf.rotation = tf.rotation.slerp(target, (a.turn_speed * dt).min(1.0));
        }
        st.velocity = Vec3::new(v.x, 0.0, v.y);
        if a.motion == NavMotion::Manual {
            st.desired_velocity = st.velocity;
        }
    }
    stats.agents = n as u32;
    stats.agents_moving = moving;
    stats.neighbor_checks = neighbor_checks;
    stats.steer_us = t0.elapsed().as_micros() as u32;
}
