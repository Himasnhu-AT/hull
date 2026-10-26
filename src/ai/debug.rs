//! Gizmo drawing of navmeshes, off-mesh links, agents, paths and perception cones. Off by
//! default; toggle with [`AiDebug`] or the `ai.nav.debug {on}` control command. Only runs in
//! windowed builds (needs Bevy's gizmo plugin).

use bevy::gizmos::config::GizmoConfigStore;
use bevy::prelude::*;

use super::agent::{NavAgent, NavAgentState, NavStatus};
use super::nav::sources::NavMeshes;
use super::perception::{Perceiver, Perception};

/// What to draw.
#[derive(Resource, Clone, Debug, Default)]
pub struct AiDebug {
    pub navmesh: bool,
    pub paths: bool,
    pub agents: bool,
    pub perception: bool,
    /// Which agent type's mesh to draw.
    pub agent_type: usize,
}

impl AiDebug {
    pub fn any(&self) -> bool {
        self.navmesh || self.paths || self.agents || self.perception
    }
    pub fn set_all(&mut self, on: bool) {
        self.navmesh = on;
        self.paths = on;
        self.agents = on;
        self.perception = on;
    }
}

pub(crate) fn debug_enabled(d: Res<AiDebug>, store: Option<Res<GizmoConfigStore>>) -> bool {
    d.any() && store.is_some()
}

pub(crate) fn draw_debug(
    dbg: Res<AiDebug>,
    navs: Res<NavMeshes>,
    agents: Query<(&NavAgent, &NavAgentState, &Transform)>,
    perceivers: Query<(&Perceiver, &Perception, &GlobalTransform)>,
    mut g: Gizmos,
) {
    let lift = Vec3::Y * 0.05;
    if dbg.navmesh
        && let Some(mesh) = navs.get(dbg.agent_type)
    {
        let edge = Color::srgba(0.2, 0.8, 1.0, 0.9);
        let link = Color::srgba(0.1, 0.4, 0.6, 0.5);
        for (_, tile) in mesh.tiles() {
            for p in &tile.polys {
                let c = [
                    Vec3::new(p.min.x, p.h[0], p.min.y),
                    Vec3::new(p.max.x, p.h[1], p.min.y),
                    Vec3::new(p.max.x, p.h[3], p.max.y),
                    Vec3::new(p.min.x, p.h[2], p.max.y),
                ];
                for k in 0..4 {
                    g.line(c[k] + lift, c[(k + 1) % 4] + lift, edge);
                }
                // Diagonal so filled vs hole is readable from above.
                g.line(c[0] + lift, c[2] + lift, link);
            }
        }
        let off = Color::srgb(1.0, 0.6, 0.1);
        for l in mesh.offmesh_links() {
            let mid = (l.start + l.end) * 0.5 + Vec3::Y * (l.start.distance(l.end) * 0.25 + 0.3);
            g.line(l.start + lift, mid, off);
            g.line(mid, l.end + lift, off);
        }
    }
    if dbg.agents || dbg.paths {
        for (a, st, tf) in &agents {
            let feet = tf.translation - Vec3::Y * a.base_offset;
            if dbg.agents {
                let c = match st.status {
                    NavStatus::Moving => Color::srgb(0.2, 1.0, 0.3),
                    NavStatus::TraversingLink => Color::srgb(1.0, 0.6, 0.1),
                    NavStatus::Arrived => Color::srgb(0.6, 0.6, 1.0),
                    NavStatus::Failed => Color::srgb(1.0, 0.1, 0.1),
                    NavStatus::Pending => Color::srgb(1.0, 1.0, 0.2),
                    NavStatus::Idle => Color::srgb(0.7, 0.7, 0.7),
                };
                g.circle(Isometry3d::new(feet + lift, Quat::from_rotation_x(std::f32::consts::FRAC_PI_2)), a.radius, c);
                if st.velocity.length_squared() > 1e-4 {
                    g.line(feet + lift, feet + lift + st.velocity * 0.5, c);
                }
            }
            if dbg.paths && st.path.len() > st.next && matches!(st.status, NavStatus::Moving | NavStatus::TraversingLink) {
                let pc = Color::srgb(1.0, 0.9, 0.2);
                let mut prev = feet;
                for p in &st.path[st.next..] {
                    g.line(prev + lift * 2.0, p.pos + lift * 2.0, pc);
                    prev = p.pos;
                }
            }
        }
    }
    if dbg.perception {
        for (p, mem, gt) in &perceivers {
            let eye = gt.translation() + Vec3::Y * p.eye_height;
            let fwd = gt.forward().as_vec3();
            let half = (p.fov_deg * 0.5).to_radians();
            let cone = Color::srgba(1.0, 0.3, 0.9, 0.7);
            for s in [-half, half] {
                g.line(eye, eye + Quat::from_rotation_y(s) * fwd * p.sight_range, cone);
            }
            for k in &mem.known {
                let c = if k.visible { Color::srgb(1.0, 0.1, 0.1) } else { Color::srgba(1.0, 0.5, 0.0, 0.6) };
                if k.visible {
                    g.line(eye, k.last_pos, c);
                }
                g.sphere(Isometry3d::from_translation(k.last_pos), 0.2, c);
            }
        }
    }
}
