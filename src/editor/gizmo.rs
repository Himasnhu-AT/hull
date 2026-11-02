//! The transform gizmo and the selection outline, drawn with Bevy gizmos.
//!
//! Move: three arrows and three plane squares. Rotate: three rings. Scale: three handles with
//! boxes plus a centre box for uniform scale. The handles keep a constant size on screen. Picking
//! is by distance in screen space (arrows and rings: distance to the projected line; planes:
//! inside the projected square), so it works with any camera and needs no colliders.
//!
//! Dragging edits the entity's `Transform` directly while the mouse is down; on release one
//! `SetComponent` op (before = start, after = final) goes to the UI's undo with
//! `record_applied` + `seal_undo`, so a drag is one undo step. Snapping uses the toolbar's step
//! (metres for move and scale, degrees for rotate). Entities without a `LevelEntity` (generated)
//! get no gizmo: they are read-only.

use bevy::camera::primitives::Aabb;
use bevy::gizmos::config::{GizmoConfigGroup, GizmoConfigStore};
use bevy::gizmos::prelude::*;
use bevy::prelude::*;
use bevy::reflect::TypePath;
use bevy::window::PrimaryWindow;
use editor_proto::{Op, StableId, StableOrId, Tool};
use serde_json::{Value, json};

use super::camera::EditorCamera;
use super::host::EditorUiRes;
use super::EditorState;
use crate::level::LevelEntity;

/// The ground grid: depth tested like the scene (the other group is drawn on top of everything,
/// and two groups at the same depth would punch holes in each other's lines).
#[derive(GizmoConfigGroup, Default, Reflect)]
pub struct EditorGrid;

/// Gizmo group for everything the editor draws (on top of the scene: negative depth bias).
#[derive(GizmoConfigGroup, Default, Reflect)]
pub struct EditorGizmos;

pub fn build(app: &mut App) {
    app.init_gizmo_group::<EditorGizmos>().init_gizmo_group::<EditorGrid>().add_systems(Startup, configure);
}

fn configure(mut store: ResMut<GizmoConfigStore>) {
    let (config, _) = store.config_mut::<EditorGizmos>();
    config.depth_bias = -1.0;
    config.line.width = 4.0;
    let (grid, _) = store.config_mut::<EditorGrid>();
    grid.line.width = 1.5;
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Handle {
    Axis(usize),
    Plane(usize),
    Ring(usize),
    Scale(usize),
    ScaleAll,
}

struct Drag {
    handle: Handle,
    entity: Entity,
    stable: StableId,
    start: Transform,
    parent: Option<GlobalTransform>,
    world: Transform,
    origin: Vec3,
    axes: [Vec3; 3],
    /// Axis parameter / plane hit / ring angle at the start, depending on the handle.
    t0: f32,
    hit0: Vec3,
    mouse0: Vec2,
    centre_px: Vec2,
}

#[derive(Resource, Default)]
pub struct GizmoState {
    hover: Option<Handle>,
    drag: Option<Drag>,
}

impl GizmoState {
    /// The pointer is on a handle or dragging one: the click is the gizmo's, not a selection.
    pub fn engaged(&self) -> bool {
        self.hover.is_some() || self.drag.is_some()
    }
}

/// Where the gizmo is this frame.
struct Frame {
    origin: Vec3,
    axes: [Vec3; 3],
    size: f32,
}

const AXIS_COLORS: [Color; 3] = [Color::srgb(0.95, 0.25, 0.25), Color::srgb(0.35, 0.85, 0.3), Color::srgb(0.3, 0.5, 1.0)];
const HOVER: Color = Color::srgb(1.0, 0.9, 0.2);
const SELECT: Color = Color::srgb(1.0, 0.65, 0.1);
const HANDLE_PX: f32 = 140.0;
const PICK_PX: f32 = 9.0;

fn other_axes(i: usize) -> (usize, usize) {
    match i {
        0 => (1, 2),
        1 => (0, 2),
        _ => (0, 1),
    }
}

fn frame_for(camera: &Camera, cam_gt: &GlobalTransform, projection: Option<&Projection>, target: &GlobalTransform, local: bool) -> Option<Frame> {
    let origin = target.translation();
    let to = origin - cam_gt.translation();
    let depth = to.dot(*cam_gt.forward()).max(0.05);
    let vh = camera.logical_target_size()?.y.max(1.0);
    let per_px = match projection {
        Some(Projection::Orthographic(o)) => o.area.height() / vh,
        Some(Projection::Perspective(p)) => 2.0 * depth * (p.fov * 0.5).tan() / vh,
        _ => 2.0 * depth * 0.4 / vh,
    };
    let rot = if local { target.rotation() } else { Quat::IDENTITY };
    Some(Frame { origin, axes: [rot * Vec3::X, rot * Vec3::Y, rot * Vec3::Z], size: per_px * HANDLE_PX })
}

fn dist_to_segment(p: Vec2, a: Vec2, b: Vec2) -> f32 {
    let ab = b - a;
    let l2 = ab.length_squared();
    if l2 < 1e-6 {
        return p.distance(a);
    }
    let t = ((p - a).dot(ab) / l2).clamp(0.0, 1.0);
    p.distance(a + ab * t)
}

fn in_quad(p: Vec2, q: &[Vec2; 4]) -> bool {
    // A plane seen edge-on collapses to a line: not a target.
    let area: f32 = (0..4).map(|i| q[i].perp_dot(q[(i + 1) % 4])).sum::<f32>().abs() * 0.5;
    if area < 16.0 {
        return false;
    }
    let mut sign = 0.0f32;
    for i in 0..4 {
        let (a, b) = (q[i], q[(i + 1) % 4]);
        let c = (b - a).perp_dot(p - a);
        if c.abs() < 1e-6 {
            continue;
        }
        if sign == 0.0 {
            sign = c.signum();
        } else if sign != c.signum() {
            return false;
        }
    }
    true
}

fn ring_points(f: &Frame, i: usize, n: usize) -> impl Iterator<Item = Vec3> + '_ {
    let (j, k) = other_axes(i);
    let r = f.size * 0.85;
    (0..=n).map(move |s| {
        let a = s as f32 / n as f32 * std::f32::consts::TAU;
        f.origin + (f.axes[j] * a.cos() + f.axes[k] * a.sin()) * r
    })
}

fn plane_corners(f: &Frame, i: usize) -> [Vec3; 4] {
    let (j, k) = other_axes(i);
    let (a, b) = (f.size * 0.25, f.size * 0.5);
    let p = |u: f32, v: f32| f.origin + f.axes[j] * u + f.axes[k] * v;
    [p(a, a), p(b, a), p(b, b), p(a, b)]
}

/// The handle under `mouse` (viewport pixels), if any.
fn hit_test(tool: Tool, f: &Frame, camera: &Camera, gt: &GlobalTransform, mouse: Vec2) -> Option<Handle> {
    let proj = |p: Vec3| camera.world_to_viewport(gt, p).ok();
    let o = proj(f.origin)?;
    let mut best: Option<(f32, Handle)> = None;
    let mut consider = |d: f32, bias: f32, h: Handle| {
        if d <= PICK_PX && best.is_none_or(|(bd, _)| d + bias < bd) {
            best = Some((d + bias, h));
        }
    };
    match tool {
        Tool::Move => {
            for i in 0..3 {
                if let Some(t) = proj(f.origin + f.axes[i] * f.size) {
                    consider(dist_to_segment(mouse, o, t), 0.0, Handle::Axis(i));
                }
                let c = plane_corners(f, i);
                if let (Some(a), Some(b), Some(c2), Some(d)) = (proj(c[0]), proj(c[1]), proj(c[2]), proj(c[3]))
                    && in_quad(mouse, &[a, b, c2, d])
                {
                    consider(0.0, -3.0, Handle::Plane(i));
                }
            }
        }
        Tool::Rotate => {
            for i in 0..3 {
                let pts: Vec<Vec2> = ring_points(f, i, 48).filter_map(proj).collect();
                let d = pts.windows(2).map(|w| dist_to_segment(mouse, w[0], w[1])).fold(f32::MAX, f32::min);
                consider(d, 0.0, Handle::Ring(i));
            }
        }
        Tool::Scale => {
            consider(mouse.distance(o), -4.0, Handle::ScaleAll);
            for i in 0..3 {
                if let Some(t) = proj(f.origin + f.axes[i] * f.size) {
                    consider(dist_to_segment(mouse, o, t), 0.0, Handle::Scale(i));
                }
            }
        }
    }
    best.map(|(_, h)| h)
}

fn ray_at(camera: &Camera, gt: &GlobalTransform, mouse: Vec2) -> Option<Ray3d> {
    camera.viewport_to_world(gt, mouse).ok()
}

/// Parameter along the line `o + a t` of the point nearest to the ray.
fn line_param(o: Vec3, a: Vec3, ray: Ray3d) -> Option<f32> {
    let (u, v) = (a, *ray.direction);
    let w0 = o - ray.origin;
    let b = u.dot(v);
    let (d, e) = (u.dot(w0), v.dot(w0));
    let denom = 1.0 - b * b;
    (denom.abs() > 1e-4).then(|| (b * e - d) / denom)
}

fn plane_hit(o: Vec3, n: Vec3, ray: Ray3d) -> Option<Vec3> {
    let dn = n.dot(*ray.direction);
    if dn.abs() < 1e-4 {
        return None;
    }
    let t = n.dot(o - ray.origin) / dn;
    (t > 0.0).then(|| ray.origin + *ray.direction * t)
}

fn ring_angle(f_origin: Vec3, n: Vec3, hit: Vec3) -> f32 {
    let u = n.any_orthonormal_vector();
    let w = n.cross(u);
    let v = hit - f_origin;
    v.dot(w).atan2(v.dot(u))
}

fn snap_to(v: f32, step: f32) -> f32 {
    if step > 1e-6 { (v / step).round() * step } else { v }
}

fn transform_json(t: &Transform) -> Value {
    json!({"translation": t.translation.to_array(), "rotation": t.rotation.to_array(), "scale": t.scale.to_array()})
}

/// Mouse position relative to the viewport hole, in egui points (the camera's logical pixels).
fn viewport_mouse(vp: Option<[f32; 4]>, window: &Window) -> Option<Vec2> {
    let c = window.cursor_position()?;
    let r = vp?;
    Some(c - Vec2::new(r[0], r[1]))
}

/// Hover, begin, update and finish gizmo drags.
#[allow(clippy::too_many_arguments)]
pub fn interact(
    mut st: ResMut<EditorState>,
    mut gizmo: ResMut<GizmoState>,
    mouse: Res<ButtonInput<MouseButton>>,
    keys: Res<ButtonInput<KeyCode>>,
    window: Option<Single<&Window, With<PrimaryWindow>>>,
    cam: Res<EditorCamera>,
    cams: Query<(&Camera, &GlobalTransform, Option<&Projection>)>,
    gts: Query<&GlobalTransform>,
    parents: Query<&ChildOf>,
    levels: Query<&LevelEntity>,
    mut transforms: Query<&mut Transform>,
    ui: Option<ResMut<EditorUiRes>>,
    tool_active: Option<Res<super::tools::ToolState>>,
) {
    let Some(window) = window else { return };
    let Some((camera, cam_gt, projection)) = cam.entity.and_then(|e| cams.get(e).ok()) else { return };
    let tool = st.tool;
    let primary = st.selection.first().copied().filter(|e| levels.contains(*e)).filter(|_| !tool_active.is_some_and(|t| t.active.is_some()));
    let Some(target) = primary else {
        gizmo.hover = None;
        if gizmo.drag.take().is_some() {
            st.gizmo_busy = false;
        }
        return;
    };
    let Ok(target_gt) = gts.get(target) else { return };
    let local = st.local_space || tool == Tool::Scale;
    let Some(frame) = frame_for(camera, cam_gt, projection, target_gt, local) else { return };
    let mouse_px = viewport_mouse(st.ui.viewport, &window);

    // Running drag.
    if let Some(d) = gizmo.drag.as_ref() {
        if mouse.pressed(MouseButton::Left) {
            if let (Some(m), Ok(mut t)) = (mouse_px, transforms.get_mut(d.entity))
                && let Some(ray) = ray_at(camera, cam_gt, m)
            {
                let step = st.snap_step;
                let snap = st.snap;
                let new = drag_transform(d, ray, m, snap, step);
                if *t != new {
                    *t = new;
                }
            }
            return;
        }
        // Released: one undo step.
        let d = gizmo.drag.take().expect("checked above");
        st.gizmo_busy = false;
        if let Ok(t) = transforms.get(d.entity)
            && *t != d.start
            && let Some(mut ui) = ui
        {
            let label = match d.handle {
                Handle::Axis(_) | Handle::Plane(_) => "Move",
                Handle::Ring(_) => "Rotate",
                Handle::Scale(_) | Handle::ScaleAll => "Scale",
            };
            let op = Op::SetComponent {
                entity: StableOrId::Stable(d.stable),
                type_path: Transform::type_path().to_string(),
                before: Some(transform_json(&d.start)),
                after: Some(transform_json(t)),
            };
            ui.0.record_applied(label, op, Some(format!("gizmo|{}", d.stable.0)));
            ui.0.seal_undo();
        }
        return;
    }

    let alt = keys.any_pressed([KeyCode::AltLeft, KeyCode::AltRight]);
    let can_hover = st.ui.pointer_over_viewport && !st.ui.wants_pointer && !st.cam_busy && !alt;
    gizmo.hover = match (can_hover, mouse_px) {
        (true, Some(m)) => hit_test(tool, &frame, camera, cam_gt, m),
        _ => None,
    };
    let (Some(handle), Some(m)) = (gizmo.hover, mouse_px) else { return };
    if !mouse.just_pressed(MouseButton::Left) {
        return;
    }
    let Some(ray) = ray_at(camera, cam_gt, m) else { return };
    let Ok(start) = transforms.get(target).copied() else { return };
    let Some(stable) = levels.get(target).ok().map(|l| StableId(l.id.0)) else { return };
    let parent = parents.get(target).ok().and_then(|p| gts.get(p.parent()).ok()).copied();
    let (_, rot, trans) = target_gt.to_scale_rotation_translation();
    let world = Transform { translation: trans, rotation: rot, scale: target_gt.to_scale_rotation_translation().0 };
    let centre_px = camera.world_to_viewport(cam_gt, frame.origin).unwrap_or(m);
    let (t0, hit0) = match handle {
        Handle::Axis(i) | Handle::Scale(i) => (line_param(frame.origin, frame.axes[i], ray).unwrap_or(0.0), Vec3::ZERO),
        Handle::Plane(i) => (0.0, plane_hit(frame.origin, frame.axes[i], ray).unwrap_or(frame.origin)),
        Handle::Ring(i) => {
            let hit = plane_hit(frame.origin, frame.axes[i], ray).unwrap_or(frame.origin);
            (ring_angle(frame.origin, frame.axes[i], hit), hit)
        }
        Handle::ScaleAll => (0.0, Vec3::ZERO),
    };
    gizmo.drag = Some(Drag { handle, entity: target, stable, start, parent, world, origin: frame.origin, axes: frame.axes, t0, hit0, mouse0: m, centre_px });
    st.gizmo_busy = true;
}

/// The entity's new local transform for the current mouse ray.
fn drag_transform(d: &Drag, ray: Ray3d, mouse: Vec2, snap: bool, step: f32) -> Transform {
    let to_local = |world: Transform| match &d.parent {
        Some(p) => GlobalTransform::from(world).reparented_to(p),
        None => world,
    };
    let sn = |v: f32| if snap { snap_to(v, step) } else { v };
    match d.handle {
        Handle::Axis(i) => {
            let Some(t) = line_param(d.origin, d.axes[i], ray) else { return d.start };
            let mut w = d.world;
            w.translation = d.origin + d.axes[i] * sn(t - d.t0) + (d.world.translation - d.origin);
            to_local(w)
        }
        Handle::Plane(i) => {
            let Some(hit) = plane_hit(d.origin, d.axes[i], ray) else { return d.start };
            let (j, k) = other_axes(i);
            let delta = hit - d.hit0;
            let (dj, dk) = (sn(delta.dot(d.axes[j])), sn(delta.dot(d.axes[k])));
            let mut w = d.world;
            w.translation += d.axes[j] * dj + d.axes[k] * dk;
            to_local(w)
        }
        Handle::Ring(i) => {
            let Some(hit) = plane_hit(d.origin, d.axes[i], ray) else { return d.start };
            let mut delta = ring_angle(d.origin, d.axes[i], hit) - d.t0;
            if snap {
                delta = snap_to(delta.to_degrees(), step.max(1.0)).to_radians();
            }
            let mut w = d.world;
            let q = Quat::from_axis_angle(d.axes[i], delta);
            w.rotation = q * d.world.rotation;
            w.translation = d.world.translation;
            to_local(w)
        }
        Handle::Scale(i) => {
            let Some(t) = line_param(d.origin, d.axes[i], ray) else { return d.start };
            let factor = if d.t0.abs() > 0.05 { (t / d.t0).max(0.02) } else { 1.0 };
            let mut s = d.start;
            let v = d.start.scale[i] * factor;
            s.scale[i] = if snap { snap_to(v, step.max(0.01)).max(0.01) } else { v };
            s
        }
        Handle::ScaleAll => {
            let a = d.mouse0.distance(d.centre_px).max(8.0);
            let b = mouse.distance(d.centre_px);
            let factor = (b / a).max(0.02);
            let mut s = d.start;
            s.scale = if snap { (d.start.scale * factor).map(|v| snap_to(v, step.max(0.01)).max(0.01)) } else { d.start.scale * factor };
            s
        }
    }
}

type BoundsQuery<'w, 's> = Query<'w, 's, (&'static GlobalTransform, Option<&'static Aabb>, Option<&'static Children>)>;

/// World box around an entity and its descendants.
fn bounds(q: &BoundsQuery, root: Entity) -> Option<(Vec3, Vec3)> {
    let mut min = Vec3::splat(f32::MAX);
    let mut max = Vec3::splat(f32::MIN);
    let mut any = false;
    let mut stack = vec![root];
    while let Some(e) = stack.pop() {
        let Ok((gt, aabb, kids)) = q.get(e) else { continue };
        if let Some(a) = aabb {
            let (c, h) = (Vec3::from(a.center), Vec3::from(a.half_extents));
            for i in 0..8u8 {
                let s = Vec3::new(if i & 1 == 0 { -1.0 } else { 1.0 }, if i & 2 == 0 { -1.0 } else { 1.0 }, if i & 4 == 0 { -1.0 } else { 1.0 });
                let p = gt.transform_point(c + h * s);
                min = min.min(p);
                max = max.max(p);
            }
            any = true;
        }
        if let Some(k) = kids {
            stack.extend(k.iter());
        }
    }
    any.then_some((min, max))
}

/// Selection boxes, the ground grid, light markers and the gizmo handles.
#[allow(clippy::too_many_arguments)]
pub fn draw(
    mut g: Gizmos<EditorGizmos>,
    mut grid: Gizmos<EditorGrid>,
    st: Res<EditorState>,
    gizmo: Res<GizmoState>,
    cam: Res<EditorCamera>,
    cams: Query<(&Camera, &GlobalTransform, Option<&Projection>)>,
    gts: Query<&GlobalTransform>,
    levels: Query<(), With<LevelEntity>>,
    bq: BoundsQuery,
    lights: Query<(&GlobalTransform, Option<&PointLight>, Option<&SpotLight>, Option<&DirectionalLight>), (With<LevelEntity>, Or<(With<PointLight>, With<SpotLight>, With<DirectionalLight>)>)>,
    tool_active: Option<Res<super::tools::ToolState>>,
) {
    let Some((camera, cam_gt, projection)) = cam.entity.and_then(|e| cams.get(e).ok()) else { return };
    if !camera.is_active {
        return;
    }
    grid.grid(Isometry3d::from_rotation(Quat::from_rotation_x(std::f32::consts::FRAC_PI_2)), UVec2::splat(40), Vec2::ONE, Color::srgba(1.0, 1.0, 1.0, 0.07)).outer_edges();
    // Markers so lights can be seen (and picked) even without a mesh.
    for (gt, p, s, d) in &lights {
        let pos = gt.translation();
        let depth = (pos - cam_gt.translation()).length().max(1.0);
        let r = 0.012 * depth;
        let c = p.map(|l| l.color).or(s.map(|l| l.color)).or(d.map(|l| l.color)).unwrap_or(Color::WHITE);
        g.sphere(Isometry3d::from_translation(pos), r, c);
        if d.is_some() || s.is_some() {
            g.arrow(pos, pos + *gt.forward() * (depth * 0.08), c);
        }
    }
    let tool_on = tool_active.is_some_and(|t| t.active.is_some());
    for &e in &st.selection {
        let Ok(gt) = gts.get(e) else { continue };
        match bounds(&bq, e) {
            // A tool works on the entity's contents (a road's points): no box over the map.
            Some(_) if tool_on => {}
            Some((min, max)) => {
                g.cube(Transform::from_translation((min + max) * 0.5).with_scale(max - min), SELECT);
            }
            None => {
                let depth = (gt.translation() - cam_gt.translation()).length().max(1.0);
                g.sphere(Isometry3d::from_translation(gt.translation()), 0.03 * depth, SELECT);
            }
        }
    }
    if tool_on {
        return;
    }
    let Some(target) = st.selection.first().copied().filter(|e| levels.contains(*e)) else { return };
    let Ok(target_gt) = gts.get(target) else { return };
    let local = st.local_space || st.tool == Tool::Scale;
    let Some(f) = frame_for(camera, cam_gt, projection, target_gt, local) else { return };
    let active = gizmo.drag.as_ref().map(|d| d.handle).or(gizmo.hover);
    let col = |h: Handle, i: usize| if active == Some(h) { HOVER } else { AXIS_COLORS[i] };
    match st.tool {
        Tool::Move => {
            for i in 0..3 {
                let c = col(Handle::Axis(i), i);
                let tip = f.origin + f.axes[i] * f.size;
                g.line(f.origin + f.axes[i] * f.size * 0.18, tip, c);
                g.arrow(f.origin + f.axes[i] * f.size * 0.82, tip + f.axes[i] * f.size * 0.08, c).with_tip_length(f.size * 0.16);
                let q = plane_corners(&f, i);
                let c = col(Handle::Plane(i), i);
                g.linestrip([q[0], q[1], q[2], q[3], q[0]], c);
            }
        }
        Tool::Rotate => {
            for i in 0..3 {
                g.linestrip(ring_points(&f, i, 64), col(Handle::Ring(i), i));
            }
        }
        Tool::Scale => {
            for i in 0..3 {
                let c = col(Handle::Scale(i), i);
                let tip = f.origin + f.axes[i] * f.size;
                g.line(f.origin, tip, c);
                g.cube(Transform::from_translation(tip).with_rotation(target_gt.rotation()).with_scale(Vec3::splat(f.size * 0.09)), c);
            }
            let c = if active == Some(Handle::ScaleAll) { HOVER } else { Color::WHITE };
            g.cube(Transform::from_translation(f.origin).with_rotation(target_gt.rotation()).with_scale(Vec3::splat(f.size * 0.11)), c);
        }
    }
}

#[cfg(test)]
mod tests {
    use bevy::camera::CameraProjection;

    use super::*;

    fn drag(handle: Handle, axes: [Vec3; 3], t0: f32, hit0: Vec3) -> Drag {
        Drag {
            handle,
            entity: Entity::PLACEHOLDER,
            stable: StableId(1),
            start: Transform::IDENTITY,
            parent: None,
            world: Transform::IDENTITY,
            origin: Vec3::ZERO,
            axes,
            t0,
            hit0,
            mouse0: Vec2::new(100.0, 100.0),
            centre_px: Vec2::new(100.0, 200.0),
        }
    }

    const WORLD: [Vec3; 3] = [Vec3::X, Vec3::Y, Vec3::Z];

    /// A ray from z = 10 toward `target`.
    fn ray_to(target: Vec3) -> Ray3d {
        let o = Vec3::new(0.0, 0.0, 10.0);
        Ray3d::new(o, Dir3::new(target - o).unwrap())
    }

    #[test]
    fn axis_drag_follows_the_mouse_along_the_axis() {
        let d = drag(Handle::Axis(0), WORLD, 0.0, Vec3::ZERO);
        let t = drag_transform(&d, ray_to(Vec3::new(2.0, 0.0, 0.0)), Vec2::ZERO, false, 0.5);
        assert!((t.translation - Vec3::new(2.0, 0.0, 0.0)).length() < 1e-3, "{t:?}");
        // The mouse off the axis (up) does not move the entity up.
        let t = drag_transform(&d, ray_to(Vec3::new(2.0, 3.0, 0.0)), Vec2::ZERO, false, 0.5);
        assert!(t.translation.y.abs() < 1e-3);
    }

    #[test]
    fn move_snaps_to_the_step() {
        let d = drag(Handle::Axis(0), WORLD, 0.0, Vec3::ZERO);
        let t = drag_transform(&d, ray_to(Vec3::new(1.2, 0.0, 0.0)), Vec2::ZERO, true, 0.5);
        assert!((t.translation.x - 1.0).abs() < 1e-3, "{t:?}");
    }

    #[test]
    fn plane_drag_moves_in_the_plane_only() {
        // Plane(2) = the XY plane (normal Z).
        let d = drag(Handle::Plane(2), WORLD, 0.0, Vec3::ZERO);
        let t = drag_transform(&d, ray_to(Vec3::new(1.5, -2.0, 0.0)), Vec2::ZERO, false, 0.5);
        assert!((t.translation - Vec3::new(1.5, -2.0, 0.0)).length() < 1e-3, "{t:?}");
    }

    #[test]
    fn ring_drag_rotates_by_the_swept_angle() {
        // Ring(2) turns about Z. Start at the +X side of the ring, move the mouse to +Y: 90 degrees.
        let n = Vec3::Z;
        let a0 = ring_angle(Vec3::ZERO, n, Vec3::X);
        let d = drag(Handle::Ring(2), WORLD, a0, Vec3::X);
        let t = drag_transform(&d, ray_to(Vec3::new(0.0, 1.0, 0.0)), Vec2::ZERO, false, 15.0);
        let (axis, angle) = t.rotation.to_axis_angle();
        assert!((angle.to_degrees().abs() - 90.0).abs() < 0.5, "{angle}");
        assert!(axis.dot(Vec3::Z).abs() > 0.99);
        // With snapping on a 15 degree step, 80 degrees lands on 75.
        let t = drag_transform(&d, ray_to(Vec3::new(0.1763, 1.0, 0.0)), Vec2::ZERO, true, 15.0);
        let a = t.rotation.to_axis_angle().1.to_degrees();
        assert!((a - 75.0).abs() < 0.5 || (a - 285.0).abs() < 0.5 || (a + 75.0).abs() < 0.5, "{a}");
    }

    #[test]
    fn scale_handles_scale_by_the_ratio() {
        let mut d = drag(Handle::Scale(0), WORLD, 1.0, Vec3::ZERO);
        d.start.scale = Vec3::splat(2.0);
        let t = drag_transform(&d, ray_to(Vec3::new(3.0, 0.0, 0.0)), Vec2::ZERO, false, 0.1);
        assert!((t.scale - Vec3::new(6.0, 2.0, 2.0)).length() < 1e-3, "{t:?}");
        // Never zero or negative.
        let t = drag_transform(&d, ray_to(Vec3::new(-5.0, 0.0, 0.0)), Vec2::ZERO, false, 0.1);
        assert!(t.scale.x > 0.0);
        // Uniform scale by the distance ratio from the gizmo centre.
        let mut d = drag(Handle::ScaleAll, WORLD, 0.0, Vec3::ZERO);
        d.start.scale = Vec3::ONE;
        let t = drag_transform(&d, ray_to(Vec3::ZERO), Vec2::new(100.0, 0.0), false, 0.1);
        assert!((t.scale - Vec3::splat(2.0)).length() < 1e-3, "{t:?}");
    }

    #[test]
    fn a_parent_transform_is_taken_out_of_the_result() {
        let mut d = drag(Handle::Axis(0), WORLD, 0.0, Vec3::ZERO);
        d.parent = Some(GlobalTransform::from(Transform::from_translation(Vec3::new(10.0, 0.0, 0.0))));
        d.world = Transform::from_translation(Vec3::new(10.0, 0.0, 0.0));
        d.origin = d.world.translation;
        let ray = Ray3d::new(Vec3::new(12.0, 0.0, 10.0), Dir3::NEG_Z);
        let t = drag_transform(&d, ray, Vec2::ZERO, false, 0.5);
        // Moved 2 m along X in the world, so 2 m in the parent's frame.
        assert!((t.translation.x - 2.0).abs() < 1e-3, "{t:?}");
    }

    #[test]
    fn hit_test_picks_the_nearest_handle() {
        // A camera 10 m from the origin looking down -Z with a 90 degree viewport 200 px high.
        let mut cam = Camera::default();
        cam.computed.target_info = Some(bevy::camera::RenderTargetInfo { physical_size: UVec2::new(200, 200), scale_factor: 1.0 });
        let gt = GlobalTransform::from(Transform::from_xyz(0.0, 0.0, 10.0));
        let f = Frame { origin: Vec3::ZERO, axes: WORLD, size: 2.0 };
        cam.computed.clip_from_view = PerspectiveProjection { fov: std::f32::consts::FRAC_PI_2, aspect_ratio: 1.0, ..default() }.get_clip_from_view();
        let o = cam.world_to_viewport(&gt, Vec3::ZERO).ok();
        {
            let o = o.expect("projects");
            let tip = cam.world_to_viewport(&gt, Vec3::new(2.0, 0.0, 0.0)).unwrap();
            let mid = (o + tip) * 0.5;
            assert_eq!(hit_test(Tool::Move, &f, &cam, &gt, mid), Some(Handle::Axis(0)));
            assert_eq!(hit_test(Tool::Move, &f, &cam, &gt, Vec2::new(5.0, 5.0)), None);
        }
    }
}
