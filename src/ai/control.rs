//! `ai.*` control commands (feature `devtools`). See docs/AI.md for the list.

use bevy::prelude::*;
use serde_json::{Value, json};

use super::agent::{NavAgent, NavAgentState};
use super::bt::BtAgent;
use super::blackboard::Blackboard;
use super::debug::AiDebug;
use super::nav::query::{NavQuery, raycast};
use super::nav::sources::{NavMeshes, SourceCache};
use super::perception::{Noise, Perception};
use super::utility::UtilityAi;
use super::{AiConfig, AiStats};
use crate::devtools::{AddControlCommand, PendingReplies, ReplyId, params};

#[derive(Resource, Default)]
struct BakeReplies(Vec<(ReplyId, u64)>);

pub(crate) fn register(app: &mut App) {
    app.init_resource::<BakeReplies>()
        .add_systems(PostUpdate, answer_bakes)
        .add_deferred_control_command(
            "ai.nav.bake",
            "Rebake every navmesh tile now; replies when the bake finished with its stats",
            params(&[]),
            nav_bake,
        )
        .add_control_command(
            "ai.nav.path",
            "Find a path on the navmesh",
            params(&[
                ("from", "array", "[x, y, z]"),
                ("to", "array", "[x, y, z]"),
                ("agent_type", "integer", "mesh index (default 0)"),
            ]),
            nav_path,
        )
        .add_control_command(
            "ai.nav.raycast",
            "Walk the navmesh surface from `from` towards `to`; reports the first wall hit",
            params(&[("from", "array", "[x, y, z]"), ("to", "array", "[x, y, z]"), ("agent_type", "integer", "mesh index")]),
            nav_raycast,
        )
        .add_control_command(
            "ai.nav.nearest",
            "Nearest point on the navmesh",
            params(&[("pos", "array", "[x, y, z]"), ("agent_type", "integer", "mesh index")]),
            nav_nearest,
        )
        .add_control_command("ai.nav.stats", "Navmesh tiles/polys/area, last bake timings, sources", params(&[]), nav_stats)
        .add_control_command(
            "ai.nav.debug",
            "Toggle gizmo drawing (navmesh, paths, agents, perception)",
            params(&[
                ("on", "boolean", "all layers on/off"),
                ("navmesh", "boolean", ""),
                ("paths", "boolean", ""),
                ("agents", "boolean", ""),
                ("perception", "boolean", ""),
                ("agent_type", "integer", "which mesh to draw"),
            ]),
            nav_debug,
        )
        .add_control_command("ai.agents", "Every nav agent: position, status, target, speed, path", params(&[("limit", "integer", "max rows (default 200)")]), agents)
        .add_control_command(
            "ai.agent.goto",
            "Send agents to a point",
            params(&[("entity", "integer", "entity bits or index; all agents if omitted"), ("to", "array", "[x, y, z]")]),
            agent_goto,
        )
        .add_control_command("ai.bt", "Behaviour tree state, blackboard and utility scores of an entity", params(&[("entity", "integer", "entity bits or index; first BT agent if omitted")]), bt)
        .add_control_command("ai.perception", "What an entity perceives / remembers", params(&[("entity", "integer", "entity bits or index")]), perception)
        .add_control_command(
            "ai.noise",
            "Emit a noise",
            params(&[("pos", "array", "[x, y, z]"), ("radius", "number", "metres (default 10)")]),
            noise,
        )
        .add_control_command("ai.stats", "Per-frame AI costs and counts", params(&[]), stats);
}

fn vec3(p: &Value, k: &str) -> Result<Vec3, String> {
    let a = p.get(k).and_then(|v| v.as_array()).ok_or_else(|| format!("`{k}` must be [x, y, z]"))?;
    let f = |i: usize| a.get(i).and_then(|v| v.as_f64()).map(|v| v as f32).ok_or_else(|| format!("`{k}` must be [x, y, z]"));
    Ok(Vec3::new(f(0)?, f(1)?, f(2)?))
}

fn agent_type(p: &Value) -> usize {
    p.get("agent_type").and_then(|v| v.as_u64()).unwrap_or(0) as usize
}

fn j3(v: Vec3) -> Value {
    json!([v.x, v.y, v.z])
}

/// An entity from `entity` (full bits, or a bare index matched against entities having `T`).
fn entity_param<T: Component>(world: &mut World, p: &Value) -> Result<Option<Entity>, String> {
    let Some(v) = p.get("entity").and_then(|v| v.as_u64()) else { return Ok(None) };
    if let Some(e) = Entity::try_from_bits(v)
        && world.get_entity(e).is_ok()
    {
        return Ok(Some(e));
    }
    let mut q = world.query_filtered::<Entity, With<T>>();
    q.iter(world).find(|e| e.index_u32() as u64 == v).map(Some).ok_or_else(|| format!("no entity {v}"))
}

fn nav_bake(world: &mut World, _: Value, reply: ReplyId) -> Result<(), String> {
    let since = world.resource::<NavMeshes>().generation;
    world.resource_mut::<NavMeshes>().request_full_rebake();
    world.resource_mut::<BakeReplies>().0.push((reply, since));
    Ok(())
}

fn answer_bakes(mut waiting: ResMut<BakeReplies>, navs: Res<NavMeshes>, pending: Option<ResMut<PendingReplies>>) {
    if waiting.0.is_empty() {
        return;
    }
    let Some(mut pending) = pending else { return };
    let done = navs.generation;
    waiting.0.retain(|&(id, since)| {
        if done > since && !navs.is_baking() {
            pending.reply(id, Ok(stats_json(&navs)));
            false
        } else {
            true
        }
    });
}

fn stats_json(navs: &NavMeshes) -> Value {
    json!({
        "generation": navs.generation,
        "baking": navs.is_baking(),
        "last_bake": navs.last_bake,
        "last_bake_ms": navs.last_bake.wall_us as f64 / 1000.0,
        "gather_ms": navs.last_gather_us as f64 / 1000.0,
        "meshes": navs.meshes.iter().map(|m| json!({
            "name": m.settings.name,
            "tiles": m.tile_count(),
            "polys": m.poly_count(),
            "area_m2": m.area(),
            "offmesh_links": m.offmesh_links().len(),
            "bounds": m.bounds().map(|(lo, hi)| json!([j3(lo), j3(hi)])),
            "version": m.version,
        })).collect::<Vec<_>>(),
    })
}

fn nav_stats(world: &mut World, _: Value) -> Result<Value, String> {
    let mut v = stats_json(world.resource::<NavMeshes>());
    let cache = world.resource::<SourceCache>();
    v["sources"] = json!(cache.source_count());
    v["source_triangles"] = json!(cache.triangle_count());
    Ok(v)
}

fn nav_path(world: &mut World, p: Value) -> Result<Value, String> {
    let from = vec3(&p, "from")?;
    let to = vec3(&p, "to")?;
    let cfg = world.resource::<AiConfig>().clone();
    let navs = world.resource::<NavMeshes>();
    let mesh = navs.get(agent_type(&p)).ok_or("no such agent type")?;
    let mut q = NavQuery::new();
    let t0 = std::time::Instant::now();
    let path = q.find_path(mesh, from, to, cfg.query_extents, cfg.max_search_nodes).map_err(|e| e.to_string())?;
    Ok(json!({
        "complete": path.complete,
        "length": path.length(),
        "points": path.points.iter().map(|p| json!({"pos": j3(p.pos), "offmesh": p.offmesh})).collect::<Vec<_>>(),
        "polys": path.polys.len(),
        "nodes": q.last_nodes,
        "us": t0.elapsed().as_micros() as u64,
    }))
}

fn nav_raycast(world: &mut World, p: Value) -> Result<Value, String> {
    let from = vec3(&p, "from")?;
    let to = vec3(&p, "to")?;
    let ext = world.resource::<AiConfig>().query_extents;
    let navs = world.resource::<NavMeshes>();
    let mesh = navs.get(agent_type(&p)).ok_or("no such agent type")?;
    let (r, s) = mesh.nearest_poly(from, ext).ok_or("`from` is not on the navmesh")?;
    let h = raycast(mesh, r, s, to);
    Ok(json!({"hit": h.hit, "t": h.t, "point": j3(h.point), "normal": j3(h.normal)}))
}

fn nav_nearest(world: &mut World, p: Value) -> Result<Value, String> {
    let pos = vec3(&p, "pos")?;
    let ext = world.resource::<AiConfig>().query_extents;
    let navs = world.resource::<NavMeshes>();
    let mesh = navs.get(agent_type(&p)).ok_or("no such agent type")?;
    Ok(match mesh.nearest_poly(pos, ext) {
        Some((_, c)) => json!({"found": true, "point": j3(c), "distance": c.distance(pos)}),
        None => json!({"found": false}),
    })
}

fn nav_debug(world: &mut World, p: Value) -> Result<Value, String> {
    let mut d = world.resource_mut::<AiDebug>();
    if let Some(on) = p.get("on").and_then(|v| v.as_bool()) {
        d.set_all(on);
    }
    let flag = |k: &str| p.get(k).and_then(|v| v.as_bool());
    if let Some(v) = flag("navmesh") {
        d.navmesh = v;
    }
    if let Some(v) = flag("paths") {
        d.paths = v;
    }
    if let Some(v) = flag("agents") {
        d.agents = v;
    }
    if let Some(v) = flag("perception") {
        d.perception = v;
    }
    if let Some(t) = p.get("agent_type").and_then(|v| v.as_u64()) {
        d.agent_type = t as usize;
    }
    Ok(json!({"navmesh": d.navmesh, "paths": d.paths, "agents": d.agents, "perception": d.perception, "agent_type": d.agent_type}))
}

fn agents(world: &mut World, p: Value) -> Result<Value, String> {
    let limit = p.get("limit").and_then(|v| v.as_u64()).unwrap_or(200) as usize;
    let mut q = world.query::<(Entity, &NavAgent, &NavAgentState, &Transform)>();
    let mut rows = Vec::new();
    let mut total = 0;
    for (e, a, st, tf) in q.iter(world) {
        total += 1;
        if rows.len() >= limit {
            continue;
        }
        let feet = tf.translation - Vec3::Y * a.base_offset;
        rows.push(json!({
            "entity": e.to_bits(),
            "index": e.index_u32(),
            "pos": j3(feet),
            "status": st.status,
            "target": st.target.map(j3),
            "speed": st.velocity.length(),
            "path_points": st.path.len(),
            "next": st.next,
            "remaining": st.remaining(feet),
            "complete": st.path_complete,
            "agent_type": a.agent_type,
        }));
    }
    Ok(json!({"count": total, "agents": rows}))
}

fn agent_goto(world: &mut World, p: Value) -> Result<Value, String> {
    let to = vec3(&p, "to")?;
    let target = entity_param::<NavAgent>(world, &p)?;
    let mut q = world.query::<(Entity, &mut NavAgentState)>();
    let mut n = 0;
    for (e, mut st) in q.iter_mut(world) {
        if target.is_none_or(|t| t == e) {
            st.set_target(to);
            n += 1;
        }
    }
    Ok(json!({"agents": n}))
}

fn bt(world: &mut World, p: Value) -> Result<Value, String> {
    let e = match entity_param::<BtAgent>(world, &p)? {
        Some(e) => e,
        None => {
            let mut q = world.query_filtered::<Entity, With<BtAgent>>();
            q.iter(world).next().ok_or("no behaviour tree agents")?
        }
    };
    let mut v = json!({"entity": e.to_bits(), "index": e.index_u32()});
    if let Some(a) = world.get::<BtAgent>(e) {
        v["bt"] = a.to_json();
    }
    if let Some(u) = world.get::<UtilityAi>(e) {
        v["utility"] = u.to_json();
    }
    if let Some(bb) = world.get::<Blackboard>(e) {
        v["blackboard"] = bb.to_json();
    }
    if let Some(n) = world.get::<Name>(e) {
        v["name"] = json!(n.as_str());
    }
    Ok(v)
}

fn perception(world: &mut World, p: Value) -> Result<Value, String> {
    let e = entity_param::<Perception>(world, &p)?.ok_or("`entity` required")?;
    let m = world.get::<Perception>(e).ok_or("entity has no Perception")?;
    Ok(json!({"entity": e.to_bits(), "known": m.to_json()}))
}

fn noise(world: &mut World, p: Value) -> Result<Value, String> {
    let pos = vec3(&p, "pos")?;
    let radius = p.get("radius").and_then(|v| v.as_f64()).unwrap_or(10.0) as f32;
    world.write_message(Noise { pos, radius, source: None });
    Ok(json!({"ok": true}))
}

fn stats(world: &mut World, _: Value) -> Result<Value, String> {
    Ok(serde_json::to_value(*world.resource::<AiStats>()).unwrap_or_default())
}
