//! Spline tool: edit the control points of the selected `Spline` entity.
//!
//! - Click a point to select it (the engine's `SplineSelection`, drawn highlighted by
//!   `SplineGizmos`, which this tool switches on); drag it and it follows the ground under the
//!   cursor (terrain, else `y = 0`) plus `ground_offset`.
//! - Ctrl+click adds a point: on the curve it is inserted into the nearest segment, past either
//!   end it is appended / prepended.
//! - Delete removes the selected point (a spline keeps at least two).
//! - The selected point's `width`, `bank`, `tags` and `data` are in the Tool panel.
//!
//! Every edit is a `SetComponent(Spline)` op; a drag is one op from where it started.

use bevy::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{Pointer, ToolState, component_op, ground_hit, ground_y, ok, vec3, xz};
use crate::editor::backend::read_component;
use crate::editor::control::entity_param;
use crate::editor::EditorState;
use crate::spline::{Spline, SplineCache, SplinePoint, SplineSelection};

/// Pixels within which a point can be picked.
const PICK_PX: f32 = 14.0;

fn type_path() -> &'static str {
    <Spline as bevy::reflect::TypePath>::type_path()
}

/// Settings plus a mirror of the selected point (the panel edits the point through it).
#[derive(Reflect, Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SplineSettings {
    /// Metres above the ground for points you drag or add.
    pub ground_offset: f32,
    /// Follow the ground (off: drag in the horizontal plane of the point).
    pub snap_to_ground: bool,
    /// Selected control point, -1 for none. Change it to select another.
    #[reflect(@-1i32..=1000i32)]
    pub point: i32,
    /// Selected point: full width in metres.
    pub width: f32,
    /// Selected point: roll in radians.
    pub bank: f32,
    /// Selected point: game-defined bits.
    pub tags: u32,
    /// Selected point: game-defined payload (empty = none).
    pub data: String,
}

impl Default for SplineSettings {
    fn default() -> Self {
        SplineSettings { ground_offset: 0.1, snap_to_ground: true, point: -1, width: 0.0, bank: 0.0, tags: 0, data: String::new() }
    }
}

pub(crate) struct PointDrag {
    entity: Entity,
    index: usize,
    before: Option<Value>,
    /// World height of the point when the drag started (for `snap_to_ground` off).
    y: f32,
}

/// The selected spline entity, kept in step with the editor selection.
fn current(world: &mut World) -> Option<Entity> {
    let editor_sel = world.resource::<EditorState>().selection.first().copied();
    let mut sel = world.resource_mut::<SplineSelection>();
    if let Some(e) = editor_sel
        && sel.entity != Some(e)
    {
        sel.entity = Some(e);
        sel.point = None;
    }
    let e = sel.entity?;
    world.get::<Spline>(e).map(|_| e)
}

fn select_point(world: &mut World, e: Entity, i: Option<usize>) {
    let mut sel = world.resource_mut::<SplineSelection>();
    sel.entity = Some(e);
    sel.point = i;
}

/// Mirrors the selected point into the settings.
fn mirror(world: &World, ts: &mut ToolState, e: Option<Entity>) {
    let sel = world.resource::<SplineSelection>().point;
    let p = e.and_then(|e| world.get::<Spline>(e)).zip(sel).and_then(|(s, i)| s.points.get(i));
    match p {
        Some(p) => {
            ts.spline.point = sel.map_or(-1, |i| i as i32);
            ts.spline.width = p.width;
            ts.spline.bank = p.bank;
            ts.spline.tags = p.tags;
            ts.spline.data = p.data.clone().unwrap_or_default();
        }
        None => {
            ts.spline.point = -1;
            ts.spline.width = 0.0;
            ts.spline.bank = 0.0;
            ts.spline.tags = 0;
            ts.spline.data.clear();
        }
    }
}

/// World position the dragged point should take for a mouse ray.
fn target(world: &World, ts: &ToolState, ray: Ray3d, keep_y: f32) -> Option<Vec3> {
    if ts.spline.snap_to_ground {
        let h = ground_hit(world, ray)?;
        Some(h + Vec3::Y * ts.spline.ground_offset)
    } else {
        let t = (keep_y - ray.origin.y) / ray.direction.y;
        (ray.direction.y.abs() > 1e-4 && t > 0.0).then(|| ray.origin + *ray.direction * t)
    }
}

fn set_point_pos(world: &mut World, e: Entity, i: usize, world_pos: Vec3) {
    let local = world.get::<GlobalTransform>(e).map_or(world_pos, |gt| gt.affine().inverse().transform_point3(world_pos));
    if let Some(mut s) = world.get_mut::<Spline>(e)
        && let Some(p) = s.points.get_mut(i)
        && p.pos != local
    {
        p.pos = local;
    }
}

fn record(world: &mut World, e: Entity, before: Option<Value>, label: &str, key: Option<String>) {
    if let Some(op) = component_op(world, e, type_path(), before) {
        world.resource_mut::<EditorState>().record(label, op, key);
    }
}

/// Adds a point at world position `at`; returns its index.
fn add_point(world: &mut World, e: Entity, at: Vec3) -> Option<usize> {
    let local = world.get::<GlobalTransform>(e).map_or(at, |gt| gt.affine().inverse().transform_point3(at));
    let before = read_component(world, e, type_path());
    let cache = world.get::<SplineCache>(e).cloned();
    let mut s = world.get_mut::<Spline>(e)?;
    let n = s.points.len();
    let idx = if n < 2 {
        s.points.push(SplinePoint::at(local));
        n
    } else {
        let cache = cache.unwrap_or_else(|| SplineCache::build(&s));
        let t = cache.nearest(&s, local).map_or(n as f32, |(_, sample, _)| sample.t);
        if !s.is_loop() && t >= (n - 1) as f32 - 1e-3 {
            let mut p = s.points[n - 1].clone();
            p.pos = local;
            s.points.push(p);
            n
        } else if !s.is_loop() && t <= 1e-3 {
            let mut p = s.points[0].clone();
            p.pos = local;
            s.points.insert(0, p);
            0
        } else {
            s.insert_point(t.floor() as usize, local)
        }
    };
    record(world, e, before, "Add spline point", None);
    Some(idx)
}

fn delete_point(world: &mut World, e: Entity, i: usize) -> Result<(), String> {
    let before = read_component(world, e, type_path());
    let mut s = world.get_mut::<Spline>(e).ok_or("no spline")?;
    if s.points.len() <= 2 {
        return Err("a spline keeps at least two points".into());
    }
    s.remove_point(i).ok_or("no such point")?;
    record(world, e, before, "Delete spline point", None);
    select_point(world, e, None);
    Ok(())
}

/// Pointer handling.
pub fn interact(world: &mut World, ts: &mut ToolState, p: &Pointer) {
    let Some(e) = current(world) else {
        mirror(world, ts, None);
        ts.spline_drag = None;
        return;
    };
    mirror(world, ts, Some(e));
    // A drag in progress.
    if let Some(d) = ts.spline_drag.as_ref() {
        if p.down {
            if let Some(ray) = p.ray
                && let Some(w) = target(world, ts, ray, d.y)
            {
                set_point_pos(world, e, d.index, w);
            }
        } else {
            let d = ts.spline_drag.take().expect("checked");
            record(world, d.entity, d.before, "Move spline point", None);
        }
        return;
    }
    let cam = world.resource::<crate::editor::camera::EditorCamera>().entity;
    let (Some(cam), Some(mouse)) = (cam, p.mouse) else { return };
    let Some(camera) = world.get::<Camera>(cam) else { return };
    let Some(cam_gt) = world.get::<GlobalTransform>(cam) else { return };
    let (Some(spline), Some(gt)) = (world.get::<Spline>(e), world.get::<GlobalTransform>(e)) else { return };
    // The point under the cursor.
    let mut hover: Option<(usize, f32, Vec3)> = None;
    for (i, pt) in spline.points.iter().enumerate() {
        let w = gt.transform_point(pt.pos);
        if let Ok(px) = camera.world_to_viewport(cam_gt, w) {
            let d = px.distance(mouse);
            if d <= PICK_PX && hover.is_none_or(|h| d < h.1) {
                hover = Some((i, d, w));
            }
        }
    }
    if p.over
        && let Some((_, _, w)) = hover
    {
        let r = (cam_gt.translation().distance(w) * 0.02).max(0.4);
        ts.overlay.spheres.push((w, r, Color::srgb(1.0, 0.9, 0.2)));
    }
    if !p.over {
        return;
    }
    if p.delete
        && let Some(i) = world.resource::<SplineSelection>().point
        && let Err(err) = delete_point(world, e, i)
    {
        warn!("spline: {err}");
    }
    if !p.pressed {
        return;
    }
    if p.ctrl {
        if let Some(ray) = p.ray
            && let Some(h) = ground_hit(world, ray)
        {
            let at = h + Vec3::Y * ts.spline.ground_offset;
            if let Some(i) = add_point(world, e, at) {
                select_point(world, e, Some(i));
            }
        }
    } else if let Some((i, _, w)) = hover {
        select_point(world, e, Some(i));
        let before = read_component(world, e, type_path());
        ts.spline_drag = Some(PointDrag { entity: e, index: i, before, y: w.y });
    } else {
        select_point(world, e, None);
    }
}

/// The panel changed the settings: select another point, or edit the selected point's fields.
pub fn apply_settings(world: &mut World, ts: &mut ToolState, new: SplineSettings) {
    let old = ts.spline.clone();
    ts.spline = new.clone();
    let Some(e) = current(world) else { return };
    let n = world.get::<Spline>(e).map_or(0, |s| s.points.len());
    if new.point != old.point {
        select_point(world, e, usize::try_from(new.point).ok().filter(|i| *i < n));
        return;
    }
    let Some(i) = world.resource::<SplineSelection>().point else { return };
    let before = read_component(world, e, type_path());
    let Some(mut s) = world.get_mut::<Spline>(e) else { return };
    let Some(pt) = s.points.get_mut(i) else { return };
    let data = (!new.data.is_empty()).then(|| new.data.clone());
    if pt.width == new.width && pt.bank == new.bank && pt.tags == new.tags && pt.data == data {
        return;
    }
    pt.width = new.width;
    pt.bank = new.bank;
    pt.tags = new.tags;
    pt.data = data;
    let key = format!("spline-point|{}|{i}", e.to_bits());
    record(world, e, before, "Edit spline point", Some(key));
}

/// Scripted actions: `select {entity | stable | name, point?}`, `add {pos}`, `move {point, to}`,
/// `delete {point?}`, `set {width?, bank?, tags?, data?}`.
pub fn action(world: &mut World, act: &str, p: &Value) -> Result<Value, String> {
    let e = match act {
        "select" => {
            let e = entity_param(world, p)?;
            if world.get::<Spline>(e).is_none() {
                return Err("that entity has no Spline".into());
            }
            world.resource_mut::<EditorState>().selection = vec![e];
            e
        }
        _ => current(world).ok_or("select a Spline entity first (action `select`)")?,
    };
    let offset = world.resource::<ToolState>().spline.ground_offset;
    let at_xz = |world: &World, v: &Value| -> Option<Vec3> {
        vec3(v).or_else(|| xz(v).map(|a| Vec3::new(a.x, ground_y(world, a.x, a.y) + offset, a.y)))
    };
    match act {
        "select" => {
            let i = p.get("point").and_then(Value::as_u64).map(|i| i as usize);
            select_point(world, e, i);
            ok()
        }
        "add" => {
            let at = p.get("pos").and_then(|v| at_xz(world, v)).ok_or("`pos` [x, z] or [x, y, z] is required")?;
            let i = add_point(world, e, at).ok_or("could not add")?;
            select_point(world, e, Some(i));
            Ok(json!({"ok": true, "point": i}))
        }
        "move" => {
            let i = p.get("point").and_then(Value::as_u64).map(|i| i as usize).or(world.resource::<SplineSelection>().point).ok_or("`point` is required")?;
            let to = p.get("to").and_then(|v| at_xz(world, v)).ok_or("`to` [x, z] or [x, y, z] is required")?;
            if world.get::<Spline>(e).is_none_or(|s| i >= s.points.len()) {
                return Err(format!("no point {i}"));
            }
            let before = read_component(world, e, type_path());
            set_point_pos(world, e, i, to);
            select_point(world, e, Some(i));
            record(world, e, before, "Move spline point", None);
            ok()
        }
        "delete" => {
            let i = p.get("point").and_then(Value::as_u64).map(|i| i as usize).or(world.resource::<SplineSelection>().point).ok_or("`point` is required")?;
            delete_point(world, e, i)?;
            ok()
        }
        "set" => {
            let mut s = world.resource::<ToolState>().spline.clone();
            if world.resource::<SplineSelection>().point.is_none() {
                return Err("no point is selected".into());
            }
            if let Some(v) = p.get("width").and_then(Value::as_f64) {
                s.width = v as f32;
            }
            if let Some(v) = p.get("bank").and_then(Value::as_f64) {
                s.bank = v as f32;
            }
            if let Some(v) = p.get("tags").and_then(Value::as_u64) {
                s.tags = v as u32;
            }
            if let Some(v) = p.get("data").and_then(Value::as_str) {
                s.data = v.to_string();
            }
            world.resource_scope(|world, mut ts: Mut<ToolState>| apply_settings(world, &mut ts, s));
            ok()
        }
        _ => Err(format!("spline: unknown action `{act}` (select, add, move, delete, set)")),
    }
}
