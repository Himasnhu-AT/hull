//! Place tool: the palette's types (`level::Placeables`). Pick one in the Tool panel, click in
//! the viewport: `Placeable::spawn` creates a level entity at the first mesh under the cursor,
//! else the ground. The `Spawn` op goes on the undo stack and the new entity is selected.

use bevy::ecs::system::RunSystemOnce;
use bevy::picking::mesh_picking::ray_cast::{MeshRayCast, MeshRayCastSettings, RayCastVisibility};
use bevy::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{Pointer, ToolState, ground_hit, ground_y, ok, xz};
use crate::editor::backend::snapshot_entity;
use crate::editor::{EditorOnly, EditorState};
use crate::level::Placeables;

#[derive(Reflect, Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PlaceSettings {
    /// The type to place (a `Placeable`'s component type path).
    pub type_path: String,
}

/// First mesh hit (visible, not the editor's own), else the ground.
fn scene_hit(world: &mut World, ray: Ray3d) -> Option<Vec3> {
    let mesh = world
        .run_system_once(move |mut cast: MeshRayCast, editor_only: Query<(), With<EditorOnly>>| {
            let filter = |e: Entity| !editor_only.contains(e);
            let s = MeshRayCastSettings::default().with_filter(&filter).with_visibility(RayCastVisibility::Visible);
            cast.cast_ray(ray, &s).first().map(|(_, h)| h.point)
        })
        .ok()
        .flatten();
    mesh.or_else(|| ground_hit(world, ray))
}

/// Spawns `type_path` at `at`, records the op, selects the entity.
pub fn place(world: &mut World, type_path: &str, at: Vec3) -> Result<Entity, String> {
    let p = world.get_resource::<Placeables>().and_then(|l| l.get(type_path)).cloned().ok_or_else(|| format!("`{type_path}` is not a registered placeable"))?;
    let n = world.query::<&Name>().iter(world).filter(|n| n.as_str().starts_with(p.name.as_str())).count();
    let name = if n == 0 { p.name.clone() } else { format!("{} {}", p.name, n + 1) };
    let e = p.spawn(world, Transform::from_translation(at), &name);
    let snap = snapshot_entity(world, e)?;
    let mut st = world.resource_mut::<EditorState>();
    st.record("Place", editor_proto::Op::Spawn { snapshot: snap }, None);
    st.selection = vec![e];
    Ok(e)
}

/// Pointer handling.
pub fn interact(world: &mut World, ts: &mut ToolState, p: &Pointer) {
    let Some(ray) = p.ray.filter(|_| p.over) else { return };
    if ts.place.type_path.is_empty() {
        return;
    }
    if let Some(g) = ground_hit(world, ray) {
        let cam = world.resource::<crate::editor::camera::EditorCamera>().pos;
        ts.overlay.spheres.push((g + Vec3::Y * 0.4, (cam.distance(g) * 0.015).max(0.3), Color::srgb(0.4, 1.0, 0.4)));
    }
    if p.pressed
        && let Some(at) = scene_hit(world, ray)
        && let Err(e) = place(world, &ts.place.type_path.clone(), at)
    {
        warn!("place: {e}");
    }
}

/// Scripted: `place {at: [x, z], type_path?}`.
pub fn action(world: &mut World, act: &str, p: &Value) -> Result<Value, String> {
    if act != "place" {
        return Err(format!("place: unknown action `{act}` (place)"));
    }
    let tp = p.get("type_path").and_then(Value::as_str).map(str::to_owned).unwrap_or_else(|| world.resource::<ToolState>().place.type_path.clone());
    let a = p.get("at").and_then(xz).ok_or("`at` [x, z] is required")?;
    let e = place(world, &tp, Vec3::new(a.x, ground_y(world, a.x, a.y), a.y))?;
    let _ = ok();
    Ok(json!({"ok": true, "id": e.to_bits()}))
}
