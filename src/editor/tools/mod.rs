//! World tools: Spline, Sculpt, Paint, Foliage and Place. Each tool has a settings struct (shown
//! in the Tool panel through the generic property grid, so the UI knows nothing about brushes),
//! viewport interaction in `update` (real pointer) and the same actions as plain functions that
//! `editor.tool_action` calls for scripts.
//!
//! | Tool | Needs | Does | File |
//! |---|---|---|---|
//! | `sculpt` | terrain (`world`) | brush strokes on the heights; `[` `]` radius, Shift inverts | `terrain.rs` |
//! | `paint` | terrain with a splat map | paint a splat layer; Shift paints layer 0 (erase) | `terrain.rs` |
//! | `spline` | a selected `Spline` | select / drag / add (Ctrl+click) / delete points | `spline.rs` |
//! | `foliage` | a `PcgVolume` | pick, delete, move, paint density areas, place catalog items | `foliage.rs` |
//! | `place` | `Placeables` | click places the chosen type at the cursor | `place.rs` |
//!
//! Every edit is an `Op` recorded for undo through [`EditorState::record`]: `SetComponent` on the
//! `Spline` / `PcgOverrides`, `TerrainPatch` for a stroke (the data is in the terrain's blob
//! store), `Spawn` for a placed entity.

use bevy::input::ButtonInput;
use bevy::prelude::*;
use bevy::window::PrimaryWindow;
use editor_proto::{Op, StableId, StableOrId, ToolDoc, TypeSchema};
use serde_json::{Value, json};

use super::camera::EditorCamera;
use super::gizmo::EditorGizmos;
use super::{EditorState, picking, schema};

pub mod foliage;
pub mod place;
pub mod spline;
pub mod terrain;

pub const TRANSFORM: &str = "bevy_transform::components::transform::Transform";

/// Tool ids in toolbar order.
pub const IDS: [&str; 5] = ["spline", "sculpt", "paint", "foliage", "place"];

/// Which tool is active and every tool's settings and drag state.
#[derive(Resource, Default)]
pub struct ToolState {
    pub active: Option<String>,
    pub sculpt: terrain::SculptSettings,
    pub paint: terrain::PaintSettings,
    pub spline: spline::SplineSettings,
    pub foliage: foliage::FoliageSettings,
    pub place: place::PlaceSettings,
    pub overlay: Overlay,
    pub(crate) terrain: terrain::StrokeState,
    pub(crate) spline_drag: Option<spline::PointDrag>,
    pub(crate) foliage_pick: Option<foliage::Picked>,
    pub(crate) foliage_drag: Option<foliage::ItemDrag>,
    pub(crate) area_drag: Option<(Vec3, Vec3)>,
    /// The default gizmo group's depth bias before the spline tool drew on top of the terrain.
    pub(crate) saved_bias: Option<f32>,
}

/// Lines and markers the tools want drawn this frame (filled by `update`, drawn by `draw`).
#[derive(Default)]
pub struct Overlay {
    pub lines: Vec<(Vec<Vec3>, Color)>,
    pub spheres: Vec<(Vec3, f32, Color)>,
}

/// What the pointer did this frame, in viewport terms.
#[derive(Clone, Default)]
pub struct Pointer {
    pub ray: Option<Ray3d>,
    /// The cursor relative to the viewport, in egui points (the camera's logical pixels).
    pub mouse: Option<Vec2>,
    /// Over the viewport with nothing from egui or a camera drag in the way.
    pub over: bool,
    pub pressed: bool,
    pub down: bool,
    pub released: bool,
    pub shift: bool,
    pub ctrl: bool,
    pub delete: bool,
    /// `]` minus `[` presses this frame.
    pub bracket: i32,
    pub dt: f32,
}

fn pointer(world: &mut World) -> Pointer {
    let mut p = Pointer { dt: world.resource::<Time<Real>>().delta_secs(), ..default() };
    let st = world.resource::<EditorState>();
    let (vp, over_ui, busy) = (st.ui.viewport, st.ui.pointer_over_viewport && !st.ui.wants_pointer, st.cam_busy);
    let typing = st.ui.wants_keyboard;
    let keys = world.resource::<ButtonInput<KeyCode>>();
    let mouse = world.resource::<ButtonInput<MouseButton>>();
    p.shift = keys.any_pressed([KeyCode::ShiftLeft, KeyCode::ShiftRight]);
    p.ctrl = keys.any_pressed([KeyCode::ControlLeft, KeyCode::ControlRight, KeyCode::SuperLeft, KeyCode::SuperRight]);
    let alt = keys.any_pressed([KeyCode::AltLeft, KeyCode::AltRight]);
    if !typing {
        p.delete = keys.any_just_pressed([KeyCode::Delete, KeyCode::Backspace]);
        p.bracket = i32::from(keys.just_pressed(KeyCode::BracketRight)) - i32::from(keys.just_pressed(KeyCode::BracketLeft));
    }
    p.over = over_ui && !busy && !alt;
    p.pressed = p.over && mouse.just_pressed(MouseButton::Left);
    p.down = mouse.pressed(MouseButton::Left);
    p.released = mouse.just_released(MouseButton::Left);
    let cam = world.resource::<EditorCamera>().entity;
    let (Some(cam), Some(vp)) = (cam, vp) else { return p };
    let Ok(window) = world.query_filtered::<&Window, With<PrimaryWindow>>().single(world) else { return p };
    let (Some(c), Some(gt)) = (world.get::<Camera>(cam), world.get::<GlobalTransform>(cam)) else { return p };
    p.ray = picking::cursor_ray(c, gt, window, vp);
    p.mouse = window.cursor_position().map(|m| m - Vec2::new(vp[0], vp[1]));
    p
}

/// Ray against the terrain, else the ground plane `y = 0` (so Place and the spline tool work on
/// levels without terrain).
pub fn ground_hit(world: &World, ray: Ray3d) -> Option<Vec3> {
    if let Some(h) = world.get_resource::<crate::world::TerrainHeights>()
        && let Some(p) = terrain::ray_terrain(h, ray)
    {
        return Some(p);
    }
    if world.get_resource::<crate::world::TerrainHeights>().is_some() {
        return None;
    }
    (ray.direction.y.abs() > 1e-4).then(|| -ray.origin.y / ray.direction.y).filter(|t| *t > 0.0 && *t < 5000.0).map(|t| ray.origin + *ray.direction * t)
}

/// Ground height under `(x, z)`: terrain, else 0.
pub fn ground_y(world: &World, x: f32, z: f32) -> f32 {
    world.get_resource::<crate::world::TerrainHeights>().filter(|h| h.contains(x, z)).map_or(0.0, |h| h.height_at(x, z))
}

/// Runs the active tool on this frame's pointer.
pub fn update(world: &mut World) {
    world.resource_scope(|world, mut ts: Mut<ToolState>| {
        ts.overlay.lines.clear();
        ts.overlay.spheres.clear();
        world.resource_mut::<EditorState>().tool_active = ts.active.is_some();
        let Some(id) = ts.active.clone() else { return };
        if world.resource::<EditorState>().play.is_running() {
            return;
        }
        let p = pointer(world);
        match id.as_str() {
            "sculpt" | "paint" => terrain::interact(world, &mut ts, &p, &id),
            "spline" => spline::interact(world, &mut ts, &p),
            "foliage" => foliage::interact(world, &mut ts, &p),
            "place" => place::interact(world, &mut ts, &p),
            _ => {}
        }
        let busy = ts.terrain.open || ts.spline_drag.is_some() || ts.foliage_drag.is_some() || ts.area_drag.is_some();
        world.resource_mut::<EditorState>().tool_busy = busy;
    });
}

/// Draws the overlay.
pub fn draw(mut g: Gizmos<EditorGizmos>, ts: Res<ToolState>) {
    for (pts, c) in &ts.overlay.lines {
        g.linestrip(pts.iter().copied(), *c);
    }
    for (p, r, c) in &ts.overlay.spheres {
        g.sphere(Isometry3d::from_translation(*p), *r, *c);
    }
}

fn label(id: &str) -> (&'static str, &'static str) {
    match id {
        "spline" => ("Spline", "Select a Spline entity. Click a point to select, drag to move it on the ground, Ctrl+click adds a point, Delete removes it."),
        "sculpt" => ("Sculpt", "Drag on the terrain. [ ] change the radius, Shift inverts (raise/lower)."),
        "paint" => ("Paint", "Drag on the terrain to paint the splat layer. [ ] change the radius, Shift paints layer 0 (erase)."),
        "foliage" => ("Foliage", "Select: click picks a generated item, drag moves it, Delete removes it. Paint: drag an area with a density (0 clears). Place: click adds an item."),
        "place" => ("Place", "Pick a type in the Tool panel, then click in the viewport."),
        _ => ("", ""),
    }
}

/// The tool's settings as JSON with their schema.
pub fn settings_of(world: &World, ts: &ToolState, id: &str) -> Option<(Value, TypeSchema)> {
    let registry = world.resource::<bevy::ecs::reflect::AppTypeRegistry>().clone();
    let reg = registry.read();
    macro_rules! of {
        ($v:expr, $t:ty) => {{
            let info = <$t as bevy::reflect::Typed>::type_info();
            (serde_json::to_value($v).ok()?, schema::schema_of(&reg, info))
        }};
    }
    Some(match id {
        "sculpt" => of!(&ts.sculpt, terrain::SculptSettings),
        "paint" => of!(&ts.paint, terrain::PaintSettings),
        "spline" => of!(&ts.spline, spline::SplineSettings),
        "foliage" => {
            let (v, mut s) = of!(&ts.foliage, foliage::FoliageSettings);
            // The catalog's items as a choice.
            // The items of the chosen volume's graph, else the whole catalog.
            let chosen = world.try_query_filtered::<(Entity, &Name), With<crate::pcg::PcgVolume>>().and_then(|mut q| q.iter(world).find(|(_, n)| n.as_str() == ts.foliage.volume).map(|(e, _)| e));
            let items = chosen.map(|e| foliage::volume_items(world, e)).filter(|v| !v.is_empty()).or_else(|| foliage::catalog_items(world));
            if let TypeSchema::Struct { fields } = &mut s {
                if let Some(items) = items.filter(|i| !i.is_empty())
                    && let Some(f) = fields.iter_mut().find(|(n, _)| n == "item")
                {
                    schema::set_inner(&mut f.1, TypeSchema::Enum { variants: items.into_iter().map(|i| (i, None)).collect() });
                }
                if let Some(f) = fields.iter_mut().find(|(n, _)| n == "volume") {
                    schema::set_inner(&mut f.1, TypeSchema::Enum { variants: foliage::volume_names_ro(world).into_iter().map(|i| (i, None)).collect() });
                }
            }
            (v, s)
        }
        "place" => {
            let (v, mut s) = of!(&ts.place, place::PlaceSettings);
            if let Some(list) = world.get_resource::<crate::level::Placeables>()
                && let TypeSchema::Struct { fields } = &mut s
                && let Some(f) = fields.iter_mut().find(|(n, _)| n == "type_path")
            {
                schema::set_inner(&mut f.1, TypeSchema::Enum { variants: list.0.iter().map(|p| (p.type_path.to_string(), None)).collect() });
            }
            (v, s)
        }
        _ => return None,
    })
}

/// Replaces a tool's settings from JSON (missing fields keep their defaults).
pub fn set_settings(ts: &mut ToolState, id: &str, v: Value) -> Result<(), String> {
    fn from<T: serde::de::DeserializeOwned>(v: Value) -> Result<T, String> {
        serde_json::from_value(v).map_err(|e| e.to_string())
    }
    match id {
        "sculpt" => ts.sculpt = from(v)?,
        "paint" => ts.paint = from(v)?,
        "spline" => ts.spline = from(v)?,
        "foliage" => ts.foliage = from(v)?,
        "place" => ts.place = from(v)?,
        _ => return Err(format!("no tool `{id}`")),
    }
    Ok(())
}

/// Every tool the current level can use (a terrain tool needs terrain, and so on).
pub fn docs(world: &World) -> Vec<ToolDoc> {
    let Some(ts) = world.get_resource::<ToolState>() else { return Vec::new() };
    IDS.iter()
        .filter(|id| available(world, id))
        .filter_map(|id| {
            let (settings, schema) = settings_of(world, ts, id)?;
            let (l, hint) = label(id);
            Some(ToolDoc { id: (*id).into(), label: l.into(), hint: hint.into(), settings, schema })
        })
        .collect()
}

fn available(world: &World, id: &str) -> bool {
    match id {
        "sculpt" => world.contains_resource::<crate::world::TerrainHeights>(),
        "paint" => world.contains_resource::<crate::world::TerrainSplat>(),
        "place" => world.get_resource::<crate::level::Placeables>().is_some_and(|p| !p.0.is_empty()),
        "foliage" => world.contains_resource::<crate::pcg::PcgCatalog>(),
        _ => true,
    }
}

/// Activates a tool (`None`: the transform gizmo tools). Leaving a tool ends its drags.
pub fn activate(world: &mut World, id: Option<&str>) -> Result<(), String> {
    if let Some(id) = id
        && (!IDS.contains(&id) || !available(world, id))
    {
        return Err(format!("tool `{id}` is not available in this level"));
    }
    // Finish an open stroke so it is not lost.
    world.resource_scope(|world, mut ts: Mut<ToolState>| {
        terrain::finish_stroke(world, &mut ts);
        ts.spline_drag = None;
        ts.foliage_drag = None;
        ts.area_drag = None;
        ts.active = id.map(str::to_owned);
        // A fresh tool starts on something valid.
        if ts.foliage.item.is_empty()
            && let Some(first) = foliage::catalog_items(world).and_then(|v| v.into_iter().next())
        {
            ts.foliage.item = first;
        }
        if ts.place.type_path.is_empty()
            && let Some(p) = world.get_resource::<crate::level::Placeables>().and_then(|l| l.0.first())
        {
            ts.place.type_path = p.type_path.to_string();
        }
        ts.overlay.lines.clear();
        ts.overlay.spheres.clear();
    });
    // The spline tool shows the curve and its points.
    #[cfg(feature = "spline")]
    {
        let on = id == Some("spline");
        if let Some(mut g) = world.get_resource_mut::<crate::spline::SplineGizmos>() {
            g.enabled = on;
            g.selected_only = on;
            // The default draws only within 400 m of the camera; the editor looks from further.
            g.range = 5000.0;
        }
        if !on && let Some(mut s) = world.get_resource_mut::<crate::spline::SplineSelection>() {
            *s = default();
        }
        // The curve is drawn just above the ground: on top of far, coarse terrain LODs too.
        let saved = world.resource::<ToolState>().saved_bias;
        if let Some(mut store) = world.get_resource_mut::<bevy::gizmos::config::GizmoConfigStore>() {
            let (cfg, _) = store.config_mut::<bevy::gizmos::config::DefaultGizmoConfigGroup>();
            let new_saved = if on && saved.is_none() {
                let prev = cfg.depth_bias;
                cfg.depth_bias = -1.0;
                Some(prev)
            } else if !on && let Some(b) = saved {
                cfg.depth_bias = b;
                None
            } else {
                saved
            };
            world.resource_mut::<ToolState>().saved_bias = new_saved;
        }
    }
    Ok(())
}

/// The entity's stable reference for an op.
pub fn eref(world: &World, e: Entity) -> StableOrId {
    world.get::<crate::level::LevelEntity>(e).map_or(StableOrId::Id(e.to_bits()), |l| StableOrId::Stable(StableId(l.id.0)))
}

/// A `SetComponent` op for `type_path` going from `before` to the entity's current value.
pub fn component_op(world: &World, e: Entity, type_path: &str, before: Option<Value>) -> Option<Op> {
    let after = super::backend::read_component(world, e, type_path);
    (before != after).then(|| Op::SetComponent { entity: eref(world, e), type_path: type_path.into(), before, after })
}

/// `{"action": ...}` for `editor.tool_action`.
pub fn action(world: &mut World, p: &Value) -> Result<Value, String> {
    let id = world.resource::<ToolState>().active.clone().ok_or("no tool is active: call editor.tool first")?;
    let act = p.get("action").and_then(Value::as_str).ok_or("`action` is required")?;
    match id.as_str() {
        "sculpt" | "paint" => terrain::action(world, &id, act, p),
        "spline" => spline::action(world, act, p),
        "foliage" => foliage::action(world, act, p),
        "place" => place::action(world, act, p),
        _ => Err(format!("tool `{id}` has no actions")),
    }
}

pub(crate) fn xz(v: &Value) -> Option<Vec2> {
    let a = v.as_array()?;
    Some(Vec2::new(a.first()?.as_f64()? as f32, a.get(1)?.as_f64()? as f32))
}

pub(crate) fn vec3(v: &Value) -> Option<Vec3> {
    let a = v.as_array()?;
    Some(Vec3::new(a.first()?.as_f64()? as f32, a.get(1)?.as_f64()? as f32, a.get(2)?.as_f64()? as f32))
}

pub(crate) fn ok() -> Result<Value, String> {
    Ok(json!({"ok": true}))
}

/// Settings from the panel or `editor.tool`. The spline tool's selected-point fields edit the
/// point (and are recorded).
pub fn apply_settings(world: &mut World, id: &str, v: Value) -> Result<(), String> {
    world.resource_scope(|world, mut ts: Mut<ToolState>| {
        if id == "spline" {
            let new: spline::SplineSettings = serde_json::from_value(v).map_err(|e| e.to_string())?;
            spline::apply_settings(world, &mut ts, new);
            Ok(())
        } else {
            set_settings(&mut ts, id, v)
        }
    })
}
