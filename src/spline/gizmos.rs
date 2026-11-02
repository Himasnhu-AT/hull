//! Gizmo drawing of splines: curve, control points, width edges and bank. Off by default; set
//! [`SplineGizmos::enabled`] or use the `spline.gizmos {on}` control command. Only runs in
//! windowed builds (needs Bevy's gizmo plugin).

use bevy::gizmos::config::GizmoConfigStore;
use bevy::prelude::*;

use super::{Spline, SplineCache};

/// What to draw.
#[derive(Resource, Clone, Debug)]
pub struct SplineGizmos {
    pub enabled: bool,
    /// Control points (spheres).
    pub points: bool,
    /// Left and right edges at the interpolated width.
    pub edges: bool,
    /// Banked up-vectors at the control points.
    pub banks: bool,
    /// Metres between edge samples.
    pub edge_step: f32,
    /// Skip everything farther than this from the camera, in metres.
    pub range: f32,
    /// Draw points, edges and banks for the selected spline only (the editor's Spline tool).
    pub selected_only: bool,
    /// Splines other than the selected one (with `selected_only`): draw only a thin faint curve, and only this close.
    pub others_range: f32,
    /// Most curve segments drawn for splines other than the selected one, per frame.
    pub others_max_segments: usize,
    /// Control point rings are drawn at most this many screen pixels across (radius).
    pub point_px: f32,
}

impl Default for SplineGizmos {
    fn default() -> Self {
        SplineGizmos { enabled: false, points: true, edges: true, banks: true, edge_step: 3.0, range: 400.0, selected_only: false, others_range: 900.0, others_max_segments: 6000, point_px: 7.0 }
    }
}

/// The point the editor (or a test) has selected; drawn highlighted.
#[derive(Resource, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SplineSelection {
    pub entity: Option<Entity>,
    pub point: Option<usize>,
}

pub(crate) fn draw_enabled(g: Res<SplineGizmos>, store: Option<Res<GizmoConfigStore>>) -> bool {
    g.enabled && store.is_some()
}

pub(crate) fn draw(
    cfg: Res<SplineGizmos>,
    sel: Res<SplineSelection>,
    splines: Query<(Entity, &Spline, &SplineCache, &GlobalTransform)>,
    cams: Query<(&GlobalTransform, &Camera, Option<&Projection>), With<Camera3d>>,
    mut g: Gizmos,
) {
    let active = cams.iter().find(|(_, c, _)| c.is_active).or_else(|| cams.iter().next());
    let cam = active.map(|c| c.0.translation());
    // World size of one screen pixel at distance 1 (perspective): 2 tan(fov/2) / viewport height.
    let px_per_m = active.and_then(|(_, c, p)| match p {
        Some(Projection::Perspective(p)) => Some(2.0 * (p.fov * 0.5).tan() / c.logical_viewport_size()?.y.max(1.0)),
        _ => None,
    });
    let mut others_left = cfg.others_max_segments;
    let range2 = cfg.range * cfg.range;
    let near = |p: Vec3| cam.is_none_or(|c| c.distance_squared(p) <= range2);
    let curve = Color::srgb(0.2, 0.85, 1.0);
    let edge = Color::srgb(1.0, 0.6, 0.15);
    let upc = Color::srgb(0.4, 1.0, 0.4);
    let pointc = Color::srgb(1.0, 1.0, 1.0);
    let selc = Color::srgb(1.0, 0.9, 0.1);
    for (entity, spline, cache, gt) in &splines {
        let lift = Vec3::Y * 0.08;
        let world = |p: Vec3| gt.transform_point(p) + lift;
        let line = cache.polyline();
        // The selected spline gets everything; the rest is a faint thin curve nearby (23 roads
        // with rings and edges each would bury the one you are editing).
        let selected_spline = sel.entity == Some(entity);
        if cfg.selected_only && !selected_spline {
            let faint = curve.with_alpha(0.28);
            let r2 = cfg.others_range * cfg.others_range;
            for w in line.windows(2) {
                if others_left == 0 {
                    break;
                }
                let (a, b) = (world(w[0]), world(w[1]));
                if cam.is_none_or(|c| c.distance_squared(a) <= r2) {
                    g.line(a, b, faint);
                    others_left -= 1;
                }
            }
            continue;
        }
        for w in line.windows(2) {
            let (a, b) = (world(w[0]), world(w[1]));
            if near(a) {
                g.line(a, b, curve);
            }
        }
        if cfg.edges && spline.points.len() > 1 {
            let (mut left, mut right): (Option<Vec3>, Option<Vec3>) = (None, None);
            for s in cache.samples(spline, cfg.edge_step.max(0.25)) {
                let (c, r) = (world(s.pos), gt.to_matrix().transform_vector3(s.right));
                let (l, rt) = (c - r * s.width * 0.5, c + r * s.width * 0.5);
                if near(c) {
                    if let (Some(pl), Some(pr)) = (left, right) {
                        g.line(pl, l, edge);
                        g.line(pr, rt, edge);
                    }
                    left = Some(l);
                    right = Some(rt);
                } else {
                    left = None;
                    right = None;
                }
            }
        }
        for (i, p) in spline.points.iter().enumerate() {
            let at = world(p.pos);
            if !near(at) {
                continue;
            }
            let selected = sel.entity == Some(entity) && sel.point == Some(i);
            // A ring about `point_px` pixels in radius, whatever the distance.
            let size = match (cam, px_per_m) {
                (Some(c), Some(k)) => (c.distance(at) * k * cfg.point_px).max(0.15),
                (Some(c), None) => (c.distance(at) * 0.006).clamp(0.15, 3.0),
                _ => 0.5,
            };
            if cfg.points {
                g.sphere(Isometry3d::from_translation(at), if selected { size * 1.8 } else { size }, if selected { selc } else { pointc });
            }
            if cfg.banks && let Some(s) = cache.sample_at(spline, point_distance(spline, cache, i)) {
                let up = gt.to_matrix().transform_vector3(s.up);
                g.arrow(at, at + up * (p.width * 0.35).max(1.0), upc);
            }
        }
    }
}

/// Distance along the curve of control point `i` (from the table; exact to table resolution).
fn point_distance(spline: &Spline, cache: &SplineCache, i: usize) -> f32 {
    let s = i as f32;
    let _ = spline;
    cache.distance_of_param(s)
}
