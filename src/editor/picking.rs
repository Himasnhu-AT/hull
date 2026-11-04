//! Viewport picking: click to select, rays, bounds.
//!
//! Plain `MeshRayCast` from the editor camera (no `MeshPickingPlugin`, so nothing runs per frame
//! while the pointer is still). A hit walks up to the nearest `LevelEntity` (the thing you can
//! edit), or for generated content to the topmost named ancestor.

use bevy::camera::primitives::Aabb;
use bevy::ecs::system::RunSystemOnce;
use bevy::picking::mesh_picking::ray_cast::{MeshRayCast, MeshRayCastSettings, RayCastVisibility};
use bevy::prelude::*;
use bevy::window::PrimaryWindow;

use super::camera::EditorCamera;
use super::gizmo::GizmoState;
use super::{EditorOnly, EditorState};
use crate::level::{GeneratedBy, LevelEntity};

/// Ray under the cursor for a camera whose viewport is a sub-rect of the window.
pub fn cursor_ray(camera: &Camera, gt: &GlobalTransform, window: &Window, vp: [f32; 4]) -> Option<Ray3d> {
    let cursor = window.cursor_position()?;
    let rect = Rect::new(vp[0], vp[1], vp[2], vp[3]);
    if !rect.contains(cursor) {
        return None;
    }
    camera.viewport_to_world(gt, cursor - rect.min).ok()
}

/// Mean position of the selection, if any.
pub fn selection_centre(st: &EditorState, gts: &Query<&GlobalTransform>) -> Option<Vec3> {
    let pts: Vec<Vec3> = st.selection.iter().filter_map(|e| gts.get(*e).ok().map(|g| g.translation())).collect();
    (!pts.is_empty()).then(|| pts.iter().copied().sum::<Vec3>() / pts.len() as f32)
}

/// World-space box around `entities` and everything below them (mesh bounds where known,
/// else the entity position).
pub fn bounds_of(world: &World, entities: &[Entity]) -> Option<(Vec3, Vec3)> {
    let mut min = Vec3::splat(f32::MAX);
    let mut max = Vec3::splat(f32::MIN);
    let mut any = false;
    let mut stack: Vec<Entity> = entities.to_vec();
    while let Some(e) = stack.pop() {
        let Ok(er) = world.get_entity(e) else { continue };
        if let Some(gt) = er.get::<GlobalTransform>() {
            match er.get::<Aabb>() {
                Some(aabb) => {
                    let (c, h) = (Vec3::from(aabb.center), Vec3::from(aabb.half_extents));
                    for i in 0..8u8 {
                        let corner = c + h * Vec3::new(if i & 1 == 0 { -1.0 } else { 1.0 }, if i & 2 == 0 { -1.0 } else { 1.0 }, if i & 4 == 0 { -1.0 } else { 1.0 });
                        let p = gt.transform_point(corner);
                        min = min.min(p);
                        max = max.max(p);
                    }
                    any = true;
                }
                None if entities.contains(&e) => {
                    let p = gt.translation();
                    min = min.min(p - Vec3::splat(0.5));
                    max = max.max(p + Vec3::splat(0.5));
                    any = true;
                }
                None => {}
            }
        }
        if let Some(kids) = er.get::<Children>() {
            stack.extend(kids.iter());
        }
    }
    any.then_some((min, max))
}

/// Where the middle of the viewport looks at: the first mesh hit, else the ground plane, else a
/// point 8 m ahead. Used to place new assets.
pub fn view_centre_hit(world: &mut World) -> Vec3 {
    view_hit(world, Vec2::splat(0.5))
}

/// Like [`view_centre_hit`] for a point of the viewport given as a fraction (`0..1`, y down):
/// the drop point of a dragged asset.
pub fn view_hit(world: &mut World, uv: Vec2) -> Vec3 {
    let uv = uv.clamp(Vec2::ZERO, Vec2::ONE);
    world
        .run_system_once(move |cam: Res<EditorCamera>, cams: Query<(&Camera, &GlobalTransform)>, mut ray_cast: MeshRayCast, editor_only: Query<(), With<EditorOnly>>| {
            let (camera, gt) = cam.entity.and_then(|e| cams.get(e).ok())?;
            let size = camera.logical_target_size()?;
            let ray = camera.viewport_to_world(gt, size * uv).ok()?;
            let filter = |e: Entity| !editor_only.contains(e);
            let settings = MeshRayCastSettings::default().with_filter(&filter).with_visibility(RayCastVisibility::Visible);
            if let Some((_, hit)) = ray_cast.cast_ray(ray, &settings).first() {
                return Some(hit.point);
            }
            // y = 0 plane.
            if ray.direction.y.abs() > 1e-4 {
                let t = -ray.origin.y / ray.direction.y;
                if t > 0.0 && t < 500.0 {
                    return Some(ray.origin + *ray.direction * t);
                }
            }
            Some(ray.origin + *ray.direction * 8.0)
        })
        .ok()
        .flatten()
        .unwrap_or(Vec3::ZERO)
}

/// The entity a hit on `hit` should select, walking up through `parent`:
/// 1. the nearest `LevelEntity` (the thing you can edit);
/// 2. else the nearest ancestor that declares itself generated (`GeneratedBy`): the building, not
///    its wall mesh;
/// 3. else the topmost *named* ancestor that is not an engine-internal one (`cell 3,4`, `World`:
///    picking those would select a whole streaming cell);
/// 4. else the hit itself (an unnamed or merged mesh is selectable on its own).
fn pick_root_with(hit: Entity, parent: impl Fn(Entity) -> Option<Entity>, is_level: impl Fn(Entity) -> bool, is_generated_by: impl Fn(Entity) -> bool, name: impl Fn(Entity) -> Option<String>) -> Entity {
    let user_named = |e: Entity| name(e).is_some_and(|n| !n.is_empty() && !super::backend::is_internal_name(&n));
    let mut topmost_named = user_named(hit).then_some(hit);
    let mut generated_root = is_generated_by(hit).then_some(hit);
    let mut cur = hit;
    for _ in 0..512 {
        if is_level(cur) {
            return cur;
        }
        match parent(cur) {
            Some(p) => {
                cur = p;
                if user_named(cur) {
                    topmost_named = Some(cur);
                }
                if generated_root.is_none() && is_generated_by(cur) {
                    generated_root = Some(cur);
                }
            }
            None => break,
        }
    }
    generated_root.or(topmost_named).unwrap_or(hit)
}

fn pick_root(hit: Entity, parents: &Query<&ChildOf>, level: &Query<(), With<LevelEntity>>, names: &Query<&Name>, generated: &Query<(), With<GeneratedBy>>) -> Entity {
    pick_root_with(hit, |e| parents.get(e).ok().map(ChildOf::parent), |e| level.contains(e), |e| generated.contains(e), |e| names.get(e).ok().map(|n| n.as_str().to_string()))
}

/// Left click in the viewport (a press and release that barely moved) selects what is under the
/// cursor; Shift / Ctrl / Cmd toggles; a click on nothing clears.
#[allow(clippy::too_many_arguments)]
pub fn click_select(
    mut st: ResMut<EditorState>,
    gizmo: Res<GizmoState>,
    mouse: Res<ButtonInput<MouseButton>>,
    keys: Res<ButtonInput<KeyCode>>,
    window: Option<Single<&Window, With<PrimaryWindow>>>,
    cam: Res<EditorCamera>,
    cams: Query<(&Camera, &GlobalTransform)>,
    mut ray_cast: MeshRayCast,
    parents: Query<&ChildOf>,
    level: Query<(), With<LevelEntity>>,
    names: Query<&Name>,
    generated: Query<(), With<GeneratedBy>>,
    editor_only: Query<(), With<EditorOnly>>,
    lights: Query<(Entity, &GlobalTransform), (With<LevelEntity>, Or<(With<PointLight>, With<SpotLight>, With<DirectionalLight>)>)>,
    mut press: Local<Option<Vec2>>,
    tools: Option<Res<super::tools::ToolState>>,
) {
    // A tool owns the left button.
    if tools.is_some_and(|t| t.active.is_some()) {
        *press = None;
        return;
    }
    let Some(window) = window else { return };
    let over = st.ui.pointer_over_viewport && !st.ui.wants_pointer;
    let alt = keys.any_pressed([KeyCode::AltLeft, KeyCode::AltRight]);
    if mouse.just_pressed(MouseButton::Left) {
        *press = (over && !alt && !gizmo.engaged()).then(|| window.cursor_position()).flatten();
    }
    if !mouse.just_released(MouseButton::Left) {
        return;
    }
    let Some(down) = press.take() else { return };
    let Some(now) = window.cursor_position() else { return };
    if now.distance(down) > 4.0 || gizmo.engaged() || st.busy() {
        return;
    }
    let Some((camera, gt)) = cam.entity.and_then(|e| cams.get(e).ok()) else { return };
    let Some(vp) = st.ui.viewport else { return };
    let Some(ray) = cursor_ray(camera, gt, &window, vp) else { return };
    let filter = |e: Entity| !editor_only.contains(e);
    let settings = MeshRayCastSettings::default().with_filter(&filter).with_visibility(RayCastVisibility::Visible);
    let mesh_hit = ray_cast.cast_ray(ray, &settings).first().map(|(e, h)| (*e, h.distance));
    // Lights have no mesh: pick their marker sphere when it is nearer than what the ray hits.
    let light_hit = lights
        .iter()
        .filter_map(|(e, lt)| {
            let c = lt.translation();
            let depth = (c - ray.origin).length().max(1.0);
            ray_sphere(ray, c, (0.02 * depth).max(0.25)).map(|t| (e, t))
        })
        .min_by(|a, b| a.1.total_cmp(&b.1));
    let hit = match (mesh_hit, light_hit) {
        (Some((m, md)), Some((l, ld))) => Some(if ld < md { l } else { m }),
        (Some((m, _)), None) => Some(m),
        (None, Some((l, _))) => Some(l),
        (None, None) => None,
    };
    let toggle = keys.any_pressed([KeyCode::ShiftLeft, KeyCode::ShiftRight, KeyCode::ControlLeft, KeyCode::ControlRight, KeyCode::SuperLeft, KeyCode::SuperRight]);
    match hit {
        Some(h) => {
            let root = pick_root(h, &parents, &level, &names, &generated);
            if toggle {
                if let Some(i) = st.selection.iter().position(|e| *e == root) {
                    st.selection.remove(i);
                } else {
                    st.selection.push(root);
                }
            } else {
                st.selection = vec![root];
            }
        }
        None if !toggle => st.selection.clear(),
        None => {}
    }
}

/// Distance along the ray to a sphere, if it is hit in front of the origin.
fn ray_sphere(ray: Ray3d, centre: Vec3, radius: f32) -> Option<f32> {
    let oc = ray.origin - centre;
    let b = oc.dot(*ray.direction);
    let c = oc.length_squared() - radius * radius;
    let disc = b * b - c;
    if disc < 0.0 {
        return None;
    }
    let t = -b - disc.sqrt();
    (t > 0.0).then_some(t)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// A tiny tree: entity index -> (parent, name, level, generated_by).
    struct T(HashMap<u32, (Option<u32>, Option<&'static str>, bool, bool)>);
    fn e(i: u32) -> Entity {
        Entity::from_raw_u32(i).unwrap()
    }
    impl T {
        fn pick(&self, hit: u32) -> u32 {
            let m = &self.0;
            pick_root_with(
                e(hit),
                |x| m.get(&x.index_u32()).and_then(|v| v.0).map(e),
                |x| m.get(&x.index_u32()).is_some_and(|v| v.2),
                |x| m.get(&x.index_u32()).is_some_and(|v| v.3),
                |x| m.get(&x.index_u32()).and_then(|v| v.1).map(str::to_string),
            )
            .index_u32()
        }
    }

    #[test]
    fn level_entity_wins_over_everything_below_it() {
        let t = T(HashMap::from([(1, (None, Some("Crate"), true, false)), (2, (Some(1), Some("node"), false, false)), (3, (Some(2), None, false, false))]));
        assert_eq!(t.pick(3), 1);
    }

    #[test]
    fn unnamed_generated_mesh_selects_itself() {
        let t = T(HashMap::from([(5, (None, None, false, false))]));
        assert_eq!(t.pick(5), 5);
    }

    #[test]
    fn merged_mesh_under_internal_cell_is_not_the_cell() {
        // `cell 3,4` is engine-internal: a hit on its child picks the child.
        let t = T(HashMap::from([(1, (None, Some("cell 3,4"), false, false)), (2, (Some(1), Some("pcg tree"), false, false))]));
        assert_eq!(t.pick(2), 2);
    }

    #[test]
    fn generated_by_ancestor_is_the_root() {
        let t = T(HashMap::from([(1, (None, None, false, true)), (2, (Some(1), None, false, false)), (3, (Some(2), None, false, false))]));
        assert_eq!(t.pick(3), 1);
    }

    #[test]
    fn topmost_user_named_ancestor_wins_without_generated_by() {
        let t = T(HashMap::from([(1, (None, Some("Town"), false, false)), (2, (Some(1), Some("House"), false, false)), (3, (Some(2), None, false, false))]));
        assert_eq!(t.pick(3), 1);
    }

    #[test]
    fn internal_names_are_skipped() {
        let t = T(HashMap::from([(1, (None, Some("World"), false, false)), (2, (Some(1), None, false, false))]));
        assert_eq!(t.pick(2), 2);
    }
}
