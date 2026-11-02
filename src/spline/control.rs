//! `spline.*` control commands (feature `devtools`). `entity` is optional when the world has
//! exactly one spline. Positions are in the spline entity's local space.
//!
//! | Command | Params | Result |
//! |---|---|---|
//! | `spline.list` | none | `[{entity, name, points, length, closed}]` |
//! | `spline.get` | `{entity?}` | `{entity, closed, mode, length, points: [...]}` |
//! | `spline.set_point` | `{entity?, index, point}` (partial: `pos, width, bank, tags, data`) | the new point |
//! | `spline.insert` | `{entity?, after, pos}` | `{index}` |
//! | `spline.remove` | `{entity?, index}` | `{points}` |
//! | `spline.nearest` | `{entity?, pos}` | `{distance_along, distance, sample}` |
//! | `spline.gizmos` | `{on?, points?, edges?, banks?, select_entity?, select_point?}` | the settings |

use bevy::prelude::*;
use serde_json::{Value, json};

use super::{Spline, SplineCache, SplineGizmos, SplineMode, SplinePoint, SplineSample, SplineSelection};
use crate::devtools::{AddControlCommand, params};

pub(super) fn register(app: &mut App) {
    let ent = ("entity", "integer", "entity bits or index (optional with a single spline)");
    app.add_control_command("spline.list", "Every spline: entity, name, point count, length", params(&[]), list)
        .add_control_command("spline.get", "A spline with all its points", params(&[ent]), get)
        .add_control_command(
            "spline.set_point",
            "Merge fields into a control point",
            params(&[ent, ("index", "integer", "point index"), ("point", "object", "any of pos [x,y,z], width, bank, tags, data")]),
            set_point,
        )
        .add_control_command(
            "spline.insert",
            "Insert a point after `after`",
            params(&[ent, ("after", "integer", "index to insert after"), ("pos", "array", "[x, y, z]")]),
            insert,
        )
        .add_control_command("spline.remove", "Remove a control point", params(&[ent, ("index", "integer", "point index")]), remove)
        .add_control_command(
            "spline.nearest",
            "Closest point on the curve to a position",
            params(&[ent, ("pos", "array", "[x, y, z]")]),
            nearest,
        )
        .add_control_command(
            "spline.gizmos",
            "Toggle spline gizmo drawing and the selected point",
            params(&[
                ("on", "boolean", "draw splines"),
                ("points", "boolean", ""),
                ("edges", "boolean", ""),
                ("banks", "boolean", ""),
                ("select_entity", "integer", "highlight this spline (0 clears)"),
                ("select_point", "integer", "highlight this point"),
            ]),
            gizmos,
        );
}

fn j3(v: Vec3) -> Value {
    json!([v.x, v.y, v.z])
}

fn vec3(v: &Value, what: &str) -> Result<Vec3, String> {
    let a = v.as_array().ok_or_else(|| format!("`{what}` must be [x, y, z]"))?;
    let f = |i: usize| a.get(i).and_then(Value::as_f64).map(|v| v as f32).ok_or_else(|| format!("`{what}` must be [x, y, z]"));
    Ok(Vec3::new(f(0)?, f(1)?, f(2)?))
}

fn entity(world: &mut World, p: &Value) -> Result<Entity, String> {
    let mut q = world.query_filtered::<Entity, With<Spline>>();
    let Some(v) = p.get("entity").filter(|v| !v.is_null()) else {
        let all: Vec<Entity> = q.iter(world).collect();
        return match all.as_slice() {
            [one] => Ok(*one),
            [] => Err("no spline in the world".into()),
            _ => Err("several splines: pass `entity` (see spline.list)".into()),
        };
    };
    let n = v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok())).ok_or("`entity` must be a number")?;
    if let Some(e) = Entity::try_from_bits(n)
        && world.get::<Spline>(e).is_some()
    {
        return Ok(e);
    }
    q.iter(world).find(|e| e.index_u32() as u64 == n).ok_or_else(|| format!("no spline entity {n}"))
}

fn usize_param(p: &Value, k: &str) -> Result<usize, String> {
    p.get(k).and_then(Value::as_u64).map(|v| v as usize).ok_or_else(|| format!("`{k}` (integer) is required"))
}

fn point_json(p: &SplinePoint) -> Value {
    json!({"pos": j3(p.pos), "width": p.width, "bank": p.bank, "tags": p.tags, "data": p.data})
}

fn sample_json(s: &SplineSample) -> Value {
    json!({"pos": j3(s.pos), "dir": j3(s.dir), "right": j3(s.right), "up": j3(s.up), "width": s.width, "bank": s.bank, "tags": s.tags, "t": s.t})
}

fn length(world: &World, e: Entity) -> f32 {
    world.get::<SplineCache>(e).map_or(0.0, SplineCache::length)
}

fn list(world: &mut World, _: Value) -> Result<Value, String> {
    let mut q = world.query::<(Entity, &Spline, Option<&Name>, Option<&SplineCache>)>();
    let rows: Vec<Value> = q
        .iter(world)
        .map(|(e, s, n, c)| json!({"entity": e.to_bits(), "name": n.map(|n| n.as_str()), "points": s.points.len(), "length": c.map_or(0.0, SplineCache::length), "closed": s.closed}))
        .collect();
    Ok(json!(rows))
}

fn get(world: &mut World, p: Value) -> Result<Value, String> {
    let e = entity(world, &p)?;
    let s = world.get::<Spline>(e).ok_or("not a spline")?;
    let mode = match s.mode {
        SplineMode::Catmull => "Catmull",
        SplineMode::Linear => "Linear",
    };
    Ok(json!({"entity": e.to_bits(), "closed": s.closed, "mode": mode, "length": length(world, e), "points": s.points.iter().map(point_json).collect::<Vec<_>>()}))
}

fn set_point(world: &mut World, p: Value) -> Result<Value, String> {
    let e = entity(world, &p)?;
    let i = usize_param(&p, "index")?;
    let patch = p.get("point").and_then(Value::as_object).ok_or("`point` (object) is required")?;
    let mut pt = world.get::<Spline>(e).and_then(|s| s.points.get(i)).cloned().ok_or_else(|| format!("no point {i}"))?;
    for (k, v) in patch {
        match k.as_str() {
            "pos" => pt.pos = vec3(v, "point.pos")?,
            "width" => pt.width = v.as_f64().ok_or("`width` must be a number")? as f32,
            "bank" => pt.bank = v.as_f64().ok_or("`bank` must be a number")? as f32,
            "tags" => pt.tags = v.as_u64().and_then(|t| u32::try_from(t).ok()).ok_or("`tags` must be a u32")?,
            "data" => pt.data = if v.is_null() { None } else { Some(v.as_str().ok_or("`data` must be a string or null")?.to_string()) },
            other => return Err(format!("unknown point field `{other}`")),
        }
    }
    let mut s = world.get_mut::<Spline>(e).ok_or("not a spline")?;
    s.points[i] = pt.clone();
    Ok(point_json(&pt))
}

fn insert(world: &mut World, p: Value) -> Result<Value, String> {
    let e = entity(world, &p)?;
    let after = usize_param(&p, "after")?;
    let pos = vec3(p.get("pos").ok_or("`pos` is required")?, "pos")?;
    let mut s = world.get_mut::<Spline>(e).ok_or("not a spline")?;
    Ok(json!({"index": s.insert_point(after, pos)}))
}

fn remove(world: &mut World, p: Value) -> Result<Value, String> {
    let e = entity(world, &p)?;
    let i = usize_param(&p, "index")?;
    let mut s = world.get_mut::<Spline>(e).ok_or("not a spline")?;
    s.remove_point(i).ok_or_else(|| format!("no point {i}"))?;
    Ok(json!({"points": s.points.len()}))
}

fn nearest(world: &mut World, p: Value) -> Result<Value, String> {
    let e = entity(world, &p)?;
    let pos = vec3(p.get("pos").ok_or("`pos` is required")?, "pos")?;
    let s = world.get::<Spline>(e).ok_or("not a spline")?;
    let c = world.get::<SplineCache>(e).ok_or("cache not built yet")?;
    let (along, sample, dist) = c.nearest(s, pos).ok_or("the spline has no points")?;
    Ok(json!({"distance_along": along, "distance": dist, "sample": sample_json(&sample)}))
}

fn gizmos(world: &mut World, p: Value) -> Result<Value, String> {
    let flag = |k: &str| p.get(k).and_then(Value::as_bool);
    {
        let mut g = world.resource_mut::<SplineGizmos>();
        if let Some(v) = flag("on") {
            g.enabled = v;
        }
        if let Some(v) = flag("points") {
            g.points = v;
        }
        if let Some(v) = flag("edges") {
            g.edges = v;
        }
        if let Some(v) = flag("banks") {
            g.banks = v;
        }
    }
    if p.get("select_entity").is_some() || p.get("select_point").is_some() {
        let ent = match p.get("select_entity").and_then(Value::as_u64) {
            Some(0) => None,
            Some(_) => Some(entity(world, &json!({"entity": p["select_entity"]}))?),
            None => entity(world, &json!({})).ok(),
        };
        *world.resource_mut::<SplineSelection>() = SplineSelection { entity: ent, point: p.get("select_point").and_then(Value::as_u64).map(|v| v as usize) };
    }
    let g = world.resource::<SplineGizmos>();
    Ok(json!({"on": g.enabled, "points": g.points, "edges": g.edges, "banks": g.banks}))
}
