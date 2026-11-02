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
use crate::level::LevelEntity;

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
    world
        .run_system_once(|cam: Res<EditorCamera>, cams: Query<(&Camera, &GlobalTransform)>, mut ray_cast: MeshRayCast, editor_only: Query<(), With<EditorOnly>>| {
            let (camera, gt) = cam.entity.and_then(|e| cams.get(e).ok())?;
            let size = camera.logical_target_size()?;
            let ray = camera.viewport_to_world(gt, size * 0.5).ok()?;
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

/// The entity a hit on `hit` should select.
fn pick_root(hit: Entity, parents: &Query<&ChildOf>, level: &Query<(), With<LevelEntity>>, names: &Query<(), With<Name>>) -> Entity {
    let mut cur = hit;
    let mut topmost_named = names.contains(hit).then_some(hit);
    loop {
        if level.contains(cur) {
            return cur;
        }
        match parents.get(cur) {
            Ok(p) => {
                cur = p.parent();
                if names.contains(cur) {
                    topmost_named = Some(cur);
                }
            }
            Err(_) => return topmost_named.unwrap_or(hit),
        }
    }
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
    names: Query<(), With<Name>>,
    editor_only: Query<(), With<EditorOnly>>,
    mut press: Local<Option<Vec2>>,
) {
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
    let hit = ray_cast.cast_ray(ray, &settings).first().map(|(e, _)| *e);
    let toggle = keys.any_pressed([KeyCode::ShiftLeft, KeyCode::ShiftRight, KeyCode::ControlLeft, KeyCode::ControlRight, KeyCode::SuperLeft, KeyCode::SuperRight]);
    match hit {
        Some(h) => {
            let root = pick_root(h, &parents, &level, &names);
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
