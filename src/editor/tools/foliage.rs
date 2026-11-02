//! Foliage tool: hand edits on top of procedural dressing (`PcgOverrides` on a `PcgVolume`).
//!
//! | Mode | Pointer | Does |
//! |---|---|---|
//! | Select | hover highlights what `pcg_pick` finds (works on merged meshes) | click picks it, drag moves it (applied on release), Delete removes it |
//! | Paint | a ring follows the ground | drag a capsule-shaped area with `density` (0 clears, 0.3 thins) |
//! | Place | a marker follows the ground | click adds one catalog `item` (its spawn node from the graph) |
//!
//! Every edit is a `SetComponent(PcgOverrides)` op on the volume (the component is added when the
//! volume has none), so undo removes it again and only the touched cells respawn.

use bevy::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{Pointer, ToolState, component_op, ground_hit, ground_y, ok, xz};
use crate::editor::backend::read_component;
use crate::editor::EditorState;
use crate::pcg::pcg_core::{Area, Op as PcgOp};
use crate::pcg::{OverrideArea, PcgCatalog, PcgGraphAsset, PcgGraphRef, PcgOverrides, PcgPick, PcgVolume, PointKey, pcg_pick};

fn type_path() -> &'static str {
    <PcgOverrides as bevy::reflect::TypePath>::type_path()
}

#[derive(Reflect, Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum FoliageMode {
    #[default]
    Select,
    Paint,
    Place,
}

#[derive(Reflect, Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct FoliageSettings {
    pub mode: FoliageMode,
    /// Paint: area radius in metres.
    pub radius: f32,
    /// Paint: share of the generated items kept in the area (0 = clear it).
    #[reflect(@0.0f32..=1.0f32)]
    pub density: f32,
    /// Place: the catalog item.
    pub item: String,
    /// Place: the Spawn node that draws it (empty = the graph's node that spawns this item).
    pub node: String,
    /// Place: random yaw.
    pub random_yaw: bool,
    /// Place: scale.
    pub scale: f32,
    /// Which volume edits go to: `Auto` (see the docs) or a volume's name.
    pub volume: String,
}

impl Default for FoliageSettings {
    fn default() -> Self {
        FoliageSettings { mode: FoliageMode::Select, radius: 20.0, density: 0.0, item: String::new(), node: String::new(), random_yaw: true, scale: 1.0, volume: AUTO.into() }
    }
}

/// An item the tool has picked.
pub(crate) struct Picked {
    pub volume: Entity,
    pub key: PointKey,
    pub item: String,
    pub transform: Transform,
    /// Where the generator put it (the identity of a moved point).
    pub at: Vec3,
}

impl From<&PcgPick> for Picked {
    fn from(p: &PcgPick) -> Self {
        Picked { volume: p.volume, key: p.key.clone(), item: p.item.clone(), transform: p.transform, at: p.transform.translation }
    }
}

pub(crate) struct ItemDrag {
    to: Vec3,
    moved: bool,
}

pub fn catalog_items(world: &World) -> Option<Vec<String>> {
    let c = world.get_resource::<PcgCatalog>()?;
    let mut v: Vec<String> = c.meshes.keys().cloned().collect();
    v.sort();
    Some(v)
}

fn graph_of(world: &World, volume: Entity) -> Option<std::sync::Arc<crate::pcg::pcg_core::Graph>> {
    match &world.get::<PcgVolume>(volume)?.graph {
        PcgGraphRef::Inline(g) => Some(g.clone()),
        PcgGraphRef::Asset(h) => world.get_resource::<Assets<PcgGraphAsset>>()?.get(h).map(|a| a.0.clone()),
    }
}

/// The Spawn / Emit node of the volume's graph that draws `item`.
fn node_for(world: &World, volume: Entity, item: &str) -> Option<String> {
    graph_of(world, volume)?.nodes.iter().find_map(|n| match &n.op {
        PcgOp::Spawn(s) if s.items.iter().any(|(i, _)| i == item) => Some(n.id.clone()),
        PcgOp::Emit { port } if port == item => Some(n.id.clone()),
        _ => None,
    })
}

/// Catalog items a volume's graph spawns.
pub fn volume_items(world: &World, volume: Entity) -> Vec<String> {
    let mut v: Vec<String> = graph_of(world, volume).map(|g| g.nodes.iter().flat_map(|n| match &n.op {
        PcgOp::Spawn(s) => s.items.iter().map(|(i, _)| i.clone()).collect::<Vec<_>>(),
        _ => Vec::new(),
    }).collect()).unwrap_or_default();
    v.sort();
    v.dedup();
    v
}

/// [`volume_names`] for a shared world (the settings are built from `&World`).
pub fn volume_names_ro(world: &World) -> Vec<String> {
    let mut v = vec![AUTO.to_string()];
    if let Some(mut q) = world.try_query_filtered::<&Name, With<PcgVolume>>() {
        v.extend(q.iter(world).map(|n| n.as_str().to_string()));
    }
    v
}

pub const AUTO: &str = "Auto";

/// The volume an edit at `(x, z)` goes to. A named target wins; else the selected volume; else the
/// volumes holding the point that use `item` / `node` (the smallest area if several); else the
/// only volume holding the point. Several candidates left: an error, never a guess.
fn resolve_volume(world: &mut World, s: &FoliageSettings, x: f32, z: f32, item: Option<&str>, node: Option<&str>) -> Result<Entity, String> {
    let all: Vec<(Entity, String, Area)> = world.query::<(Entity, Option<&Name>, &PcgVolume)>().iter(world).map(|(e, n, v)| (e, n.map_or(String::new(), |n| n.as_str().to_string()), v.area)).collect();
    if all.is_empty() {
        return Err("no PcgVolume in this level".into());
    }
    if s.volume != AUTO && !s.volume.is_empty() {
        return all.iter().find(|(_, n, _)| *n == s.volume).map(|v| v.0).ok_or_else(|| format!("no foliage volume named `{}`", s.volume));
    }
    if let Some(sel) = world.resource::<EditorState>().selection.first().copied()
        && all.iter().any(|v| v.0 == sel)
    {
        return Ok(sel);
    }
    let holds = |a: &Area| x >= a.min.x && x <= a.max.x && z >= a.min.y && z <= a.max.y;
    let here: Vec<&(Entity, String, Area)> = all.iter().filter(|v| holds(&v.2)).collect();
    let uses = |e: Entity| match (item, node) {
        (_, Some(n)) => graph_of(world, e).is_some_and(|g| g.nodes.iter().any(|x| x.id == n)),
        (Some(i), None) => node_for(world, e, i).is_some(),
        _ => true,
    };
    let area = |a: &Area| (a.max.x - a.min.x) * (a.max.y - a.min.y);
    let filtered: Vec<&&(Entity, String, Area)> = here.iter().filter(|v| uses(v.0)).collect();
    if item.is_some() || node.is_some() {
        if let Some(best) = filtered.iter().min_by(|a, b| area(&a.2).total_cmp(&area(&b.2))) {
            return Ok(best.0);
        }
        return Err(format!("no foliage volume here has a node for {}", node.or(item).unwrap_or("that")));
    }
    match here.as_slice() {
        [one] => Ok(one.0),
        [] => Err("no foliage volume covers this spot".into()),
        _ => Err("several foliage volumes here: pick one in the Tool panel".into()),
    }
}

/// Edits the volume's overrides and records the change as one undo step.
fn edit(world: &mut World, volume: Entity, label: &str, f: impl FnOnce(&mut PcgOverrides) -> bool) -> bool {
    let before = read_component(world, volume, type_path());
    let mut o = world.get::<PcgOverrides>(volume).cloned().unwrap_or_default();
    if !f(&mut o) {
        return false;
    }
    world.entity_mut(volume).insert(o);
    if let Some(op) = component_op(world, volume, type_path(), before) {
        world.resource_mut::<EditorState>().record(label, op, None);
    }
    true
}

fn delete_picked(world: &mut World, p: &Picked) -> bool {
    edit(world, p.volume, "Delete foliage", |o| o.remove_point(&p.key, p.at))
}

fn move_picked(world: &mut World, p: &Picked, to: Vec3) -> Option<PointKey> {
    let mut key = None;
    let t = Transform { translation: to, ..p.transform };
    edit(world, p.volume, "Move foliage", |o| {
        key = Some(o.move_point(&p.key, p.at, &p.item, t));
        true
    });
    key
}

/// Capsule polygon (XZ) of `radius` around the segment `a`-`b`.
pub fn capsule(a: Vec2, b: Vec2, radius: f32) -> Vec<Vec2> {
    let d = b - a;
    let base = if d.length() < 1e-3 { 0.0 } else { d.y.atan2(d.x) };
    let mut out = Vec::new();
    let n = 10;
    // Half circle around `b` (from -90 to +90 degrees about the travel direction), then around `a`.
    for i in 0..=n {
        let t = base - std::f32::consts::FRAC_PI_2 + std::f32::consts::PI * i as f32 / n as f32;
        out.push(b + Vec2::new(t.cos(), t.sin()) * radius);
    }
    for i in 0..=n {
        let t = base + std::f32::consts::FRAC_PI_2 + std::f32::consts::PI * i as f32 / n as f32;
        out.push(a + Vec2::new(t.cos(), t.sin()) * radius);
    }
    out
}

fn paint_area(world: &mut World, s: &FoliageSettings, from: Vec3, to: Vec3, radius: f32, density: f32) -> Result<(), String> {
    let node = (!s.node.is_empty()).then_some(s.node.as_str());
    let vol = resolve_volume(world, s, from.x, from.z, None, node)?;
    let poly = capsule(Vec2::new(from.x, from.z), Vec2::new(to.x, to.z), radius.max(1.0));
    let label = if density <= 0.0 { "Clear foliage" } else { "Thin foliage" };
    edit(world, vol, label, |o| {
        o.areas.push(OverrideArea { polygon: poly, density: density.clamp(0.0, 1.0), nodes: node.map(|n| vec![n.to_string()]) });
        true
    });
    Ok(())
}

fn place_item(world: &mut World, s: &FoliageSettings, at: Vec3, seed: u32) -> Result<(), String> {
    if s.item.is_empty() {
        return Err("choose an item in the Tool panel".into());
    }
    let item = Some(s.item.as_str());
    let vol = resolve_volume(world, s, at.x, at.z, item, (!s.node.is_empty()).then_some(s.node.as_str()))?;
    let node = if s.node.is_empty() { node_for(world, vol, &s.item).ok_or_else(|| format!("no Spawn node draws `{}`: set `node`", s.item))? } else { s.node.clone() };
    let yaw = if s.random_yaw { (seed.wrapping_mul(2_654_435_761) as f32 / u32::MAX as f32) * std::f32::consts::TAU } else { 0.0 };
    let t = Transform::from_translation(at).with_rotation(Quat::from_rotation_y(yaw)).with_scale(Vec3::splat(s.scale.max(0.01)));
    edit(world, vol, "Place foliage", |o| {
        o.add_item(&s.item, &node, t);
        true
    });
    Ok(())
}

fn ring(world: &World, c: Vec3, r: f32) -> Vec<Vec3> {
    (0..=48)
        .map(|i| {
            let a = i as f32 / 48.0 * std::f32::consts::TAU;
            let (x, z) = (c.x + a.cos() * r, c.z + a.sin() * r);
            Vec3::new(x, ground_y(world, x, z) + 0.3, z)
        })
        .collect()
}

fn marker_radius(world: &World, p: Vec3) -> f32 {
    let cam = world.resource::<crate::editor::camera::EditorCamera>().pos;
    (cam.distance(p) * 0.02).max(0.6)
}

/// Pointer handling.
pub fn interact(world: &mut World, ts: &mut ToolState, p: &Pointer) {
    if p.bracket != 0 {
        ts.foliage.radius = (ts.foliage.radius * 1.15f32.powi(p.bracket)).clamp(1.0, 500.0);
    }
    // Always show what is selected.
    if let Some(sel) = ts.foliage_pick.as_ref() {
        let c = sel.transform.translation;
        ts.overlay.spheres.push((c, marker_radius(world, c) * 1.3, Color::srgb(1.0, 0.9, 0.2)));
    }
    let ground = p.ray.and_then(|r| ground_hit(world, r));
    match ts.foliage.mode {
        FoliageMode::Select => select_mode(world, ts, p, ground),
        FoliageMode::Paint => {
            let colour = if ts.foliage.density <= 0.0 { Color::srgb(1.0, 0.3, 0.3) } else { Color::srgb(0.4, 1.0, 0.4) };
            if let Some(g) = ground.filter(|_| p.over || ts.area_drag.is_some()) {
                ts.overlay.lines.push((ring(world, g, ts.foliage.radius), colour));
            }
            match (&mut ts.area_drag, ground) {
                (None, Some(g)) if p.pressed => ts.area_drag = Some((g, g)),
                (Some((_, end)), Some(g)) if p.down => {
                    *end = g;
                    let a = Vec2::new(ts.area_drag.unwrap_or_default().0.x, ts.area_drag.unwrap_or_default().0.z);
                    let poly: Vec<Vec3> = capsule(a, Vec2::new(g.x, g.z), ts.foliage.radius).iter().map(|v| Vec3::new(v.x, ground_y(world, v.x, v.y) + 0.3, v.y)).collect();
                    ts.overlay.lines.push((poly, colour));
                }
                _ => {}
            }
            if ts.area_drag.is_some() && !p.down {
                let (a, b) = ts.area_drag.take().unwrap_or_default();
                if let Err(e) = paint_area(world, &ts.foliage.clone(), a, b, ts.foliage.radius, ts.foliage.density) {
                    super::super::log(world, editor_proto::Level::Warn, "foliage", e);
                }
            }
        }
        FoliageMode::Place => {
            if let Some(g) = ground.filter(|_| p.over) {
                ts.overlay.spheres.push((g + Vec3::Y * 0.5, marker_radius(world, g) * 0.8, Color::srgb(0.4, 1.0, 0.4)));
                if p.pressed {
                    let seed = (g.x * 31.0 + g.z * 17.0) as i64 as u32;
                    if let Err(e) = place_item(world, &ts.foliage.clone(), g, seed) {
                        super::super::log(world, editor_proto::Level::Warn, "foliage", e);
                    }
                }
            }
        }
    }
}

fn select_mode(world: &mut World, ts: &mut ToolState, p: &Pointer, ground: Option<Vec3>) {
    // A drag in progress: the item follows the ground, applied on release.
    if let (Some(sel), Some(drag)) = (ts.foliage_pick.as_ref(), ts.foliage_drag.as_mut()) {
        if p.down {
            if let Some(g) = ground {
                drag.to = g;
                drag.moved = drag.moved || g.distance(sel.transform.translation) > 0.3;
            }
            ts.overlay.spheres.push((drag.to, marker_radius(world, drag.to), Color::srgb(0.3, 1.0, 1.0)));
            ts.overlay.lines.push((vec![sel.transform.translation, drag.to], Color::srgb(0.3, 1.0, 1.0)));
            return;
        }
        let drag = ts.foliage_drag.take().expect("checked");
        if drag.moved {
            let sel = ts.foliage_pick.as_ref().map(|s| Picked { volume: s.volume, key: s.key.clone(), item: s.item.clone(), transform: s.transform, at: s.at });
            if let Some(sel) = sel
                && let Some(key) = move_picked(world, &sel, drag.to)
                && let Some(cur) = ts.foliage_pick.as_mut()
            {
                cur.key = key;
                cur.transform.translation = drag.to;
            }
        }
        return;
    }
    if p.delete
        && let Some(sel) = ts.foliage_pick.take()
    {
        delete_picked(world, &sel);
    }
    let hit = p.ray.filter(|_| p.over).and_then(|r| pcg_pick(world, r.origin, *r.direction));
    if let Some(h) = &hit {
        let c = h.transform.translation;
        ts.overlay.spheres.push((c, marker_radius(world, c), Color::srgb(0.3, 1.0, 1.0)));
    }
    if p.pressed {
        match hit {
            Some(h) => {
                ts.foliage_pick = Some(Picked::from(&h));
                ts.foliage_drag = Some(ItemDrag { to: h.transform.translation, moved: false });
            }
            None => ts.foliage_pick = None,
        }
    }
}

/// Scripted actions: `pick {at: [x, z]}`, `delete`, `move {to: [x, z]}`,
/// `area {center | from + to, radius?, density?}`, `place {at: [x, z], item?, node?}`.
pub fn action(world: &mut World, act: &str, p: &Value) -> Result<Value, String> {
    let at3 = |world: &World, v: &Value| xz(v).map(|a| Vec3::new(a.x, ground_y(world, a.x, a.y), a.y));
    let s = world.resource::<ToolState>().foliage.clone();
    match act {
        "pick" => {
            let a = p.get("at").and_then(|v| at3(world, v)).ok_or("`at` [x, z] is required")?;
            let pick = pcg_pick(world, a + Vec3::Y * 200.0, Vec3::NEG_Y).ok_or("no generated item there")?;
            let out = json!({"ok": true, "item": pick.item, "node": pick.key.node, "seed": pick.key.seed, "at": pick.transform.translation.to_array(), "emitted": pick.emitted});
            world.resource_mut::<ToolState>().foliage_pick = Some(Picked::from(&pick));
            Ok(out)
        }
        "scan" => {
            // Every pickable item within `radius` of `at`, found with downward rays on a grid.
            let a = p.get("at").and_then(|v| at3(world, v)).ok_or("`at` [x, z] is required")?;
            let r = p.get("radius").and_then(Value::as_f64).unwrap_or(30.0).clamp(1.0, 80.0) as f32;
            let step = p.get("step").and_then(Value::as_f64).unwrap_or(2.0).clamp(0.5, 10.0) as f32;
            let mut seen: Vec<(String, u64)> = Vec::new();
            let mut items = Vec::new();
            let n = (r / step) as i32;
            for i in -n..=n {
                for j in -n..=n {
                    let q = a + Vec3::new(i as f32 * step, 0.0, j as f32 * step);
                    if let Some(h) = pcg_pick(world, Vec3::new(q.x, ground_y(world, q.x, q.z) + 200.0, q.z), Vec3::NEG_Y) {
                        let id = (h.key.node.clone(), h.key.seed);
                        if !seen.contains(&id) {
                            seen.push(id);
                            let t = h.transform.translation;
                            items.push(json!({"item": h.item, "node": h.key.node, "at": [t.x, t.z], "y": t.y}));
                        }
                    }
                }
            }
            Ok(json!({"count": items.len(), "items": items}))
        }
        "delete" => {
            let sel = world.resource_mut::<ToolState>().foliage_pick.take().ok_or("nothing is picked")?;
            delete_picked(world, &sel);
            ok()
        }
        "move" => {
            let to = p.get("to").and_then(|v| at3(world, v)).ok_or("`to` [x, z] is required")?;
            let sel = world.resource::<ToolState>().foliage_pick.as_ref().map(|s| Picked { volume: s.volume, key: s.key.clone(), item: s.item.clone(), transform: s.transform, at: s.at }).ok_or("nothing is picked")?;
            let key = move_picked(world, &sel, to).ok_or("move failed")?;
            if let Some(cur) = world.resource_mut::<ToolState>().foliage_pick.as_mut() {
                cur.key = key;
                cur.transform.translation = to;
            }
            ok()
        }
        "area" => {
            let radius = p.get("radius").and_then(Value::as_f64).map_or(s.radius, |r| r as f32);
            let density = p.get("density").and_then(Value::as_f64).map_or(s.density, |d| d as f32);
            let (a, b) = match (p.get("center").and_then(|v| at3(world, v)), p.get("from").and_then(|v| at3(world, v)), p.get("to").and_then(|v| at3(world, v))) {
                (Some(c), _, _) => (c, c),
                (None, Some(a), Some(b)) => (a, b),
                _ => return Err("`center` or `from` + `to` ([x, z]) is required".into()),
            };
            let mut s = s;
            if let Some(n) = p.get("node").and_then(Value::as_str) {
                s.node = n.into();
            }
            if let Some(v) = p.get("volume").and_then(Value::as_str) {
                s.volume = v.into();
            }
            paint_area(world, &s, a, b, radius, density)?;
            ok()
        }
        "place" => {
            let a = p.get("at").and_then(|v| at3(world, v)).ok_or("`at` [x, z] is required")?;
            let mut s = s;
            if let Some(i) = p.get("item").and_then(Value::as_str) {
                s.item = i.into();
            }
            if let Some(n) = p.get("node").and_then(Value::as_str) {
                s.node = n.into();
            }
            if let Some(v) = p.get("volume").and_then(Value::as_str) {
                s.volume = v.into();
            }
            place_item(world, &s, a, 7)?;
            ok()
        }
        _ => Err(format!("foliage: unknown action `{act}` (pick, delete, move, area, place)")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_capsule_covers_both_ends_and_the_strip_between() {
        let poly = capsule(Vec2::new(0.0, 0.0), Vec2::new(30.0, 0.0), 5.0);
        let (min, max) = poly.iter().fold((Vec2::splat(f32::MAX), Vec2::splat(f32::MIN)), |(a, b), p| (a.min(*p), b.max(*p)));
        assert!((min.x + 5.0).abs() < 0.01 && (max.x - 35.0).abs() < 0.01, "{min} {max}");
        assert!((min.y + 5.0).abs() < 0.01 && (max.y - 5.0).abs() < 0.01);
        let c = capsule(Vec2::ZERO, Vec2::ZERO, 3.0);
        assert!(c.iter().all(|p| (p.length() - 3.0).abs() < 1e-3), "a click is a circle");
    }
}

#[cfg(test)]
mod volume_tests {

    use bevy::ecs::reflect::AppTypeRegistry;

    use super::*;
    use crate::pcg::pcg_core::{Graph, Inputs, Tier};

    fn volume(w: &mut World, name: &str, item: &str, node: &str, half: f32) -> Entity {
        let g = Graph::build(1).input("lots").poisson(5.0).spawn(&[(item, 1.0)], Tier::Normal).id(node).finish().unwrap();
        w.spawn((Name::new(name.to_string()), PcgVolume::new(g, Inputs::default(), Area::new(Vec2::splat(-half), Vec2::splat(half))))).id()
    }

    fn world() -> (World, Entity, Entity) {
        let mut w = World::new();
        w.init_resource::<AppTypeRegistry>();
        {
            let reg = w.resource::<AppTypeRegistry>().clone();
            let mut r = reg.write();
            r.register::<PcgOverrides>();
            r.register::<Transform>();
        }
        w.insert_resource(EditorState::default());
        // Both cover the point; `rocks` is the smaller one.
        let trees = volume(&mut w, "Trees", "tree", "trees", 2000.0);
        let rocks = volume(&mut w, "Rocks", "rock", "rocks", 1000.0);
        (w, trees, rocks)
    }

    #[test]
    fn place_goes_to_the_volume_that_spawns_the_item() {
        let (mut w, trees, rocks) = world();
        let s = FoliageSettings { item: "tree".into(), ..default() };
        place_item(&mut w, &s, Vec3::new(5.0, 0.0, 5.0), 1).unwrap();
        assert_eq!(w.get::<PcgOverrides>(trees).unwrap().added.len(), 1);
        assert!(w.get::<PcgOverrides>(rocks).is_none());
        let s = FoliageSettings { item: "rock".into(), ..default() };
        place_item(&mut w, &s, Vec3::new(5.0, 0.0, 5.0), 1).unwrap();
        assert_eq!(w.get::<PcgOverrides>(rocks).unwrap().added[0].node, "rocks");
    }

    #[test]
    fn area_with_a_node_filter_goes_to_the_volume_with_that_node() {
        let (mut w, trees, rocks) = world();
        let s = FoliageSettings { node: "trees".into(), ..default() };
        paint_area(&mut w, &s, Vec3::ZERO, Vec3::ZERO, 10.0, 0.0).unwrap();
        let a = &w.get::<PcgOverrides>(trees).unwrap().areas;
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].nodes.as_deref(), Some(&["trees".to_string()][..]));
        assert!(w.get::<PcgOverrides>(rocks).is_none());
    }

    #[test]
    fn an_ambiguous_spot_is_an_error_and_a_selection_or_name_decides() {
        let (mut w, trees, rocks) = world();
        let s = FoliageSettings::default();
        let err = paint_area(&mut w, &s, Vec3::ZERO, Vec3::ZERO, 10.0, 0.0).unwrap_err();
        assert!(err.contains("several foliage volumes"), "{err}");
        assert!(w.get::<PcgOverrides>(trees).is_none() && w.get::<PcgOverrides>(rocks).is_none());
        // The selected volume wins.
        w.resource_mut::<EditorState>().selection = vec![rocks];
        paint_area(&mut w, &s, Vec3::ZERO, Vec3::ZERO, 10.0, 0.5).unwrap();
        assert_eq!(w.get::<PcgOverrides>(rocks).unwrap().areas.len(), 1);
        // So does a named target, over the selection.
        let s = FoliageSettings { volume: "Trees".into(), ..default() };
        paint_area(&mut w, &s, Vec3::ZERO, Vec3::ZERO, 10.0, 0.5).unwrap();
        assert_eq!(w.get::<PcgOverrides>(trees).unwrap().areas.len(), 1);
        assert!(paint_area(&mut w, &FoliageSettings { volume: "Nope".into(), ..default() }, Vec3::ZERO, Vec3::ZERO, 1.0, 0.0).is_err());
        assert_eq!(volume_items(&w, trees), vec!["tree".to_string()]);
    }
}
