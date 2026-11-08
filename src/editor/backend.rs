//! [`EditorBackend`] on the Bevy `World`.
//!
//! [`WorldBackend`] wraps `&mut World`; the egui pass, the `editor.*` control commands and the
//! gizmo all go through it, so there is one implementation of every edit.
//!
//! Rules:
//! - Entities are addressed by [`StableId`] when they have a `LevelEntity`, else by session id.
//! - Generated entities (no `LevelEntity`) are read-only: `apply` refuses to edit them.
//! - `SetComponent` carries the whole component; `before` is not checked (the UI's undo uses
//!   it, the backend does not reject a stale one: a slider scrub and a gizmo drag would
//!   otherwise race each other).
//! - Components are shown in the UI form of [`super::schema`] (handles as asset paths, colours
//!   as arrays).

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use bevy::asset::AssetServer;
use bevy::ecs::reflect::{AppTypeRegistry, ReflectComponent};
use bevy::prelude::*;
use bevy::reflect::TypeRegistration;
use bevy::world_serialization::WorldAssetRoot;
use editor_proto::*;
use serde_json::Value;

use super::schema;
use super::{EditorOnly, EditorState};
use crate::devkit::reflect_json::find_type;
use crate::level::{self, GeneratedBy, LevelEntity, Primitive};
use crate::paths::AssetsDir;

/// Components the Details panel never shows: edited through other commands (name, parent,
/// identity) or rebuilt at runtime.
const HIDDEN: &[&str] = &["Name", "ChildOf", "LevelEntity", "Children", "EditorOnly", "MainCamera"];

/// The editor's view of the world.
pub struct WorldBackend<'w> {
    pub world: &'w mut World,
}

impl<'w> WorldBackend<'w> {
    pub fn new(world: &'w mut World) -> Self {
        WorldBackend { world }
    }
}

fn is_hidden(r: &TypeRegistration, e: EntityRef) -> bool {
    let t = r.type_info().type_path_table();
    let short = t.short_path();
    if HIDDEN.contains(&short) {
        return true;
    }
    if t.path().starts_with("bevy_") && level::RUNTIME_ONLY.contains(&short) {
        return true;
    }
    // Shapes made from `Primitive` rebuild their mesh and material.
    e.contains::<Primitive>() && (short == "Mesh3d" || short.starts_with("MeshMaterial3d"))
}

/// The entity for a reference, if it exists.
pub fn resolve(world: &mut World, r: StableOrId) -> Result<Entity, String> {
    match r {
        StableOrId::Stable(s) => by_stable(world, s).ok_or_else(|| format!("no entity with stable id {}", s.0)),
        StableOrId::Id(bits) => {
            let e = Entity::try_from_bits(bits).ok_or_else(|| format!("bad entity id {bits}"))?;
            if world.get_entity(e).is_ok() { Ok(e) } else { Err(format!("entity {bits} no longer exists")) }
        }
    }
}

pub fn by_stable(world: &mut World, s: StableId) -> Option<Entity> {
    world.query::<(Entity, &LevelEntity)>().iter(world).find(|(_, l)| l.id.0 == s.0).map(|(e, _)| e)
}

pub fn stable_of(world: &World, e: Entity) -> Option<StableId> {
    world.get::<LevelEntity>(e).map(|l| StableId(l.id.0))
}

fn registry(world: &World) -> AppTypeRegistry {
    world.resource::<AppTypeRegistry>().clone()
}

fn editable_target(world: &mut World, r: StableOrId) -> Result<Entity, String> {
    let e = resolve(world, r)?;
    if world.get::<LevelEntity>(e).is_none() {
        return Err("this entity is built by code (generated) and is read-only in the editor".into());
    }
    Ok(e)
}

fn node_kind(world: &World, e: Entity) -> NodeKind {
    let Ok(er) = world.get_entity(e) else { return NodeKind::Empty };
    let mut kind = NodeKind::Empty;
    for &cid in er.archetype().components() {
        let Some(info) = world.components().get_info(cid) else { continue };
        let name = info.name().to_string();
        let k = if name.contains("Light") && !name.contains("Lightmap") {
            NodeKind::Light
        } else if name.ends_with("::Camera") || name.contains("Camera3d") || name.contains("Camera2d") {
            NodeKind::Camera
        } else if name.contains("AudioPlayer") || name.contains("SpatialAudio") {
            NodeKind::Audio
        } else if name.ends_with("::Logic") {
            NodeKind::Logic
        } else if name.ends_with("::Spline") {
            NodeKind::Spline
        } else if name.ends_with("::PcgVolume") {
            NodeKind::Foliage
        } else if world.get_resource::<crate::level::Placeables>().is_some_and(|p| p.0.iter().any(|x| x.type_path == name)) {
            NodeKind::Gameplay
        } else if name.contains("Mesh3d") || name.contains("WorldAssetRoot") || name.ends_with("::Primitive") {
            NodeKind::Mesh
        } else {
            continue;
        };
        // Lights and cameras win over a mesh on the same entity.
        if kind == NodeKind::Empty || matches!(k, NodeKind::Light | NodeKind::Camera | NodeKind::Spline | NodeKind::Foliage | NodeKind::Gameplay) {
            kind = k;
        }
    }
    kind
}

const MAX_TREE_NODES: usize = 6000;

/// Generated entities the engine and Bevy make for themselves: not level content, never shown.
const INTERNAL_NAMES: &[&str] = &["far detail", "FPS counter", "Perf overlay", "LineGizmoRenderer", "LineJointGizmoRenderer", "LineStripGizmoRenderer", "World", "terrain collider"];
/// Streaming cells, terrain chunks and the like.
const INTERNAL_PREFIXES: &[&str] = &["cell ", "chunk ", "pcg "];

/// True for names the engine gives its own entities (never level content, never picked).
pub(super) fn is_internal_name(n: &str) -> bool {
    INTERNAL_NAMES.contains(&n) || INTERNAL_PREFIXES.iter().any(|p| n.starts_with(p))
}

/// Who built a generated entity: its `GeneratedBy`, else the internal prefix (`pcg`), else its
/// name, else "generated".
fn origin_of(world: &World, e: Entity, named: Option<&str>) -> String {
    if let Some(g) = world.get::<GeneratedBy>(e) {
        return g.0.to_string();
    }
    match named {
        Some(n) => INTERNAL_PREFIXES.iter().find(|p| n.starts_with(**p)).map_or(n, |p| p.trim()).to_string(),
        None => "generated".to_string(),
    }
}

/// The row name of an unnamed entity: its kind and index.
fn fallback_name(world: &World, e: Entity) -> String {
    let kind = match node_kind(world, e) {
        NodeKind::Mesh => "Mesh",
        NodeKind::Light => "Light",
        NodeKind::Camera => "Camera",
        _ => "Entity",
    };
    format!("{kind} {}", e.index().index())
}

/// Components a level designer never adds by hand: input accumulators, accessibility, picking,
/// computed render and transform state, relationships, egui and the editor's own.
fn is_internal(path: &str, short: &str) -> bool {
    const PREFIXES: &[&str] = &["bevy_input", "bevy_a11y", "bevy_picking", "bevy_egui", "bevy_window", "bevy_winit", "bevy_ecs::hierarchy", "bevy_ecs::relationship", "engine::editor", "bevy_camera::visibility", "bevy_render", "bevy_ui::"];
    const SHORT: &[&str] = &["GlobalTransform", "TransformTreeChanged", "Aabb", "Anchor", "LevelEntity", "ChildOf", "Children", "Observer", "Disabled", "Window", "Monitor"];
    PREFIXES.iter().any(|p| path.starts_with(p))
        || SHORT.contains(&short)
        || short.starts_with("Accumulated")
        || short.starts_with("Accessib")
        || short.starts_with("Computed")
        || short.starts_with("Calculated")
        || short.starts_with("Inherited")
        || short.starts_with("Collider") && short != "Collider"
        || short.ends_with("Marker")
        || short.ends_with("Cache")
        || short.ends_with("Internal")
}

fn build_node(world: &World, e: Entity, budget: &mut usize, under_level: bool, selected: &[Entity], keep: &HashSet<Entity>) -> Option<TreeNode> {
    if *budget == 0 || world.get::<EditorOnly>(e).is_some() {
        return None;
    }
    let stable = stable_of(world, e);
    let named = world.get::<Name>(e).map(|n| n.as_str().to_string()).filter(|n| !n.is_empty());
    // A selected entity is always listed (so the selection is visible), as is anything that
    // declares itself generated with `GeneratedBy`.
    let is_selected = selected.contains(&e);
    let marked = world.get::<GeneratedBy>(e).is_some();
    // What a level entity builds for itself (glTF nodes, LOD children) is not listed.
    let internal = stable.is_none() && (under_level || named.as_deref().is_some_and(is_internal_name)) && !is_selected;
    if internal && !keep.contains(&e) {
        return None;
    }
    // Other unnamed generated entities (render and UI internals) are not shown; their children
    // attach to the nearest shown ancestor.
    let shown = !internal && (stable.is_some() || named.is_some() || marked || is_selected);
    let mut kids = Vec::new();
    if let Some(children) = world.get::<Children>(e) {
        for c in children.iter() {
            if let Some(n) = build_node(world, c, budget, stable.is_some() || under_level, selected, keep) {
                kids.push(n);
            }
        }
    }
    if !shown {
        // Splice: the caller takes the first child; multiple children are wrapped by the caller.
        return match kids.len() {
            0 => None,
            _ => {
                let mut wrapper = TreeNode::new(e.to_bits(), "");
                wrapper.children = kids;
                wrapper.icon = NodeKind::Other; // marks a pass-through, flattened by the parent
                Some(wrapper)
            }
        };
    }
    *budget = budget.saturating_sub(1);
    let generated = stable.is_none();
    let hidden = matches!(world.get::<Visibility>(e), Some(Visibility::Hidden));
    let origin = generated.then(|| origin_of(world, e, named.as_deref()));
    let name = named.unwrap_or_else(|| fallback_name(world, e));
    let mut node = TreeNode::new(e.to_bits(), name);
    node.stable = stable;
    node.generated = generated;
    node.hidden = hidden;
    node.origin = origin;
    node.icon = match node_kind(world, e) {
        NodeKind::Empty if generated => NodeKind::Generated,
        k => k,
    };
    node.children = flatten(kids);
    Some(node)
}

/// Pass-through wrappers (unnamed generated parents) are replaced by their children.
fn flatten(kids: Vec<TreeNode>) -> Vec<TreeNode> {
    let mut out = Vec::with_capacity(kids.len());
    for k in kids {
        if k.name.is_empty() && k.icon == NodeKind::Other && k.stable.is_none() {
            out.extend(flatten(k.children));
        } else {
            out.push(k);
        }
    }
    out
}

fn prune(nodes: Vec<TreeNode>, f: &TreeFilter, text: &str) -> Vec<TreeNode> {
    nodes
        .into_iter()
        .filter_map(|mut n| {
            if (!f.include_generated && n.generated) || (!f.include_hidden && n.hidden) {
                return None;
            }
            n.children = prune(std::mem::take(&mut n.children), f, text);
            if text.is_empty() || n.name.to_lowercase().contains(text) || !n.children.is_empty() { Some(n) } else { None }
        })
        .collect()
}

/// The component docs of an entity (visible components, `Transform` first).
pub fn component_docs(world: &World, e: Entity) -> Result<Vec<ComponentDoc>, String> {
    let er = world.get_entity(e).map_err(|_| "entity no longer exists".to_string())?;
    let registry = registry(world);
    let reg = registry.read();
    let mut docs = Vec::new();
    for &cid in er.archetype().components() {
        let Some(info) = world.components().get_info(cid) else { continue };
        let Some(r) = info.type_id().and_then(|t| reg.get(t)) else { continue };
        let Some(rc) = r.data::<ReflectComponent>() else { continue };
        if is_hidden(r, er) {
            continue;
        }
        let Some(value) = rc.reflect(er) else { continue };
        let t = r.type_info();
        let schema = schema::schema_of(&reg, t);
        let (json, editable) = match schema::serialize(&reg, value.as_partial_reflect()) {
            Ok(v) => (schema::to_ui(&reg, t, v), !matches!(schema, TypeSchema::Opaque)),
            Err(e) => (Value::String(format!("not serialisable: {e}")), false),
        };
        let (category, tip) = schema::type_hints(t);
        // `Default::default()` in the same form, for the reset arrows.
        let default = r.data::<bevy::reflect::std_traits::ReflectDefault>().and_then(|rd| {
            let d = rd.default();
            schema::serialize(&reg, d.as_partial_reflect()).ok().map(|v| schema::to_ui(&reg, t, v))
        });
        docs.push(ComponentDoc {
            type_path: t.type_path().to_string(),
            short_name: t.type_path_table().short_path().to_string(),
            value: json,
            schema,
            editable,
            category: category.unwrap_or_default().to_owned(),
            doc: tip.unwrap_or_default().to_owned(),
            default,
        });
    }
    docs.sort_by(|a, b| {
        let rank = |d: &ComponentDoc| if d.short_name == "Transform" { 0 } else { 1 };
        rank(a).cmp(&rank(b)).then_with(|| a.short_name.cmp(&b.short_name))
    });
    Ok(docs)
}

/// One component of an entity in UI JSON (`None` if absent or not serialisable).
pub fn read_component(world: &World, e: Entity, type_path: &str) -> Option<Value> {
    let registry = registry(world);
    let reg = registry.read();
    let r = find_type(&reg, type_path).ok()?;
    let rc = r.data::<ReflectComponent>()?;
    let er = world.get_entity(e).ok()?;
    let value = rc.reflect(er)?;
    let raw = schema::serialize(&reg, value.as_partial_reflect()).ok()?;
    Some(schema::to_ui(&reg, r.type_info(), raw))
}

/// Sets (inserts or replaces) a component from UI JSON; `None` removes it.
pub fn set_component(world: &mut World, e: Entity, type_path: &str, after: Option<&Value>) -> Result<(), String> {
    let registry = registry(world);
    let reg = registry.read();
    let r = find_type(&reg, type_path)?;
    let rc = r.data::<ReflectComponent>().ok_or_else(|| format!("`{type_path}` is not a component (#[reflect(Component)])"))?.clone();
    let Some(after) = after else {
        let mut em = world.get_entity_mut(e).map_err(|_| "entity no longer exists".to_string())?;
        rc.remove(&mut em);
        return Ok(());
    };
    let server = world.get_resource::<AssetServer>().cloned().ok_or("no AssetServer")?;
    let raw = schema::from_ui(&reg, r.type_info(), after.clone());
    let value = schema::deserialize(r, &raw, &reg, &server)?;
    // A component never added to this world has no id yet.
    let cid = world.components().get_id(r.type_id()).unwrap_or_else(|| rc.register_component(world));
    let mutable = world.components().get_info(cid).is_none_or(|i| i.mutable());
    let mut em = world.get_entity_mut(e).map_err(|_| "entity no longer exists".to_string())?;
    if em.contains_id(cid) && mutable {
        let mut target = rc.reflect_mut(&mut em).ok_or("component vanished")?;
        target.try_apply(value.as_ref()).map_err(|e| e.to_string())?;
    } else {
        rc.insert(&mut em, value.as_ref(), &reg);
    }
    Ok(())
}

pub fn snapshot_entity(world: &mut World, e: Entity) -> Result<EntitySnapshot, String> {
    let stable = stable_of(world, e).ok_or("generated entities have no stable id")?;
    let name = world.get::<Name>(e).map(|n| n.as_str().to_string()).unwrap_or_default();
    let parent = world.get::<ChildOf>(e).and_then(|c| stable_of(world, c.parent()));
    let components = component_docs(world, e)?.into_iter().map(|d| (d.type_path, d.value)).collect();
    let kids: Vec<Entity> = world.get::<Children>(e).map(|c| c.iter().collect()).unwrap_or_default();
    let mut children = Vec::new();
    for c in kids {
        if world.get::<LevelEntity>(c).is_some() {
            children.push(snapshot_entity(world, c)?);
        }
    }
    Ok(EntitySnapshot { stable, name, parent, components, children })
}

fn spawn_snapshot(world: &mut World, snap: &EntitySnapshot, parent: Option<Entity>) -> Result<Entity, String> {
    if by_stable(world, snap.stable).is_some() {
        return Err(format!("stable id {} already exists", snap.stable.0));
    }
    let e = world.spawn((LevelEntity { id: level::StableId(snap.stable.0) }, Name::new(snap.name.clone()))).id();
    let r = (|| {
        let parent = match (parent, snap.parent) {
            (Some(p), _) => Some(p),
            (None, Some(s)) => Some(by_stable(world, s).ok_or_else(|| format!("parent {} does not exist", s.0))?),
            (None, None) => None,
        };
        if let Some(p) = parent {
            world.entity_mut(e).insert(ChildOf(p));
        }
        for (tp, v) in &snap.components {
            set_component(world, e, tp, Some(v))?;
        }
        for c in &snap.children {
            spawn_snapshot(world, c, Some(e))?;
        }
        Ok(())
    })();
    if let Err(err) = r {
        world.entity_mut(e).despawn();
        return Err(err);
    }
    // Keep fresh ids above every id in use.
    if let Some(mut st) = world.get_resource_mut::<level::LevelState>() {
        st.next_id = st.next_id.max(snap.stable.0);
    }
    Ok(e)
}

/// Gives the snapshot and every child a fresh stable id (a copy must not clash with the original).
fn fresh_ids(world: &mut World, snap: &mut EntitySnapshot) {
    let old = snap.stable;
    let new = level::new_stable_id(world);
    // Reserve the id so the next call differs: the entity does not exist yet, so bump the counter.
    world.resource_mut::<level::LevelState>().next_id = new.0;
    snap.stable = StableId(new.0);
    for c in &mut snap.children {
        c.parent = Some(snap.stable);
        fresh_ids(world, c);
    }
    let _ = old;
}

/// The pseudo type path of the "convert to level entity" op (add or remove the identity).
const LEVEL_ENTITY: &str = "engine::level::LevelEntity";

fn apply_op(world: &mut World, op: &Op) -> Result<(), String> {
    match op {
        Op::SetComponent { entity, type_path, after, .. } if type_path.ends_with("::LevelEntity") => {
            let e = resolve(world, *entity)?;
            match after {
                Some(v) => {
                    let id = v.get("id").and_then(Value::as_u64).ok_or("LevelEntity needs a numeric id")?;
                    if by_stable(world, StableId(id)).is_some_and(|x| x != e) {
                        return Err(format!("stable id {id} already exists"));
                    }
                    world.entity_mut(e).insert(LevelEntity { id: level::StableId(id) });
                }
                None => {
                    world.entity_mut(e).remove::<LevelEntity>();
                }
            }
            Ok(())
        }
        Op::SetComponent { entity, type_path, after, .. } => {
            let e = editable_target(world, *entity)?;
            set_component(world, e, type_path, after.as_ref())
        }
        Op::Spawn { snapshot } => spawn_snapshot(world, snapshot, None).map(|_| ()),
        Op::Despawn { snapshot } => {
            let e = by_stable(world, snapshot.stable).ok_or_else(|| format!("no entity with stable id {}", snapshot.stable.0))?;
            world.entity_mut(e).despawn();
            Ok(())
        }
        Op::Reparent { entity, after, .. } => {
            let e = editable_target(world, *entity)?;
            match after {
                None => {
                    world.entity_mut(e).remove::<ChildOf>();
                }
                Some(p) => {
                    let p = resolve(world, *p)?;
                    if p == e || is_descendant(world, p, e) {
                        return Err("cannot parent an entity under itself or its own child".into());
                    }
                    world.entity_mut(e).insert(ChildOf(p));
                }
            }
            Ok(())
        }
        Op::Rename { entity, after, .. } => {
            let e = editable_target(world, *entity)?;
            world.entity_mut(e).insert(Name::new(after.clone()));
            Ok(())
        }
        Op::TerrainPatch { after, .. } => crate::world::TerrainEdit::apply_blob(world, crate::world::BlobId(*after)).map(|_| ()).map_err(|e| e.to_string()),
        Op::Batch(ops) => {
            for (i, o) in ops.iter().enumerate() {
                if let Err(err) = apply_op(world, o) {
                    // Undo what already ran so a failed batch changes nothing.
                    for done in ops[..i].iter().rev() {
                        let _ = apply_op(world, &done.inverse());
                    }
                    return Err(err);
                }
            }
            Ok(())
        }
    }
}

fn is_descendant(world: &World, e: Entity, ancestor: Entity) -> bool {
    let mut cur = e;
    while let Some(c) = world.get::<ChildOf>(cur) {
        if c.parent() == ancestor {
            return true;
        }
        cur = c.parent();
    }
    false
}

fn asset_kind(name: &str, is_dir: bool) -> AssetKind {
    if is_dir {
        return AssetKind::Folder;
    }
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".level.ron") {
        AssetKind::Level
    } else if lower.ends_with(".logic.ron") {
        AssetKind::Logic
    } else if lower.ends_with(".ruspy") {
        AssetKind::Script
    } else {
        match lower.rsplit('.').next().unwrap_or("") {
            "glb" | "gltf" => AssetKind::Model,
            "png" | "jpg" | "jpeg" | "ktx2" | "tga" | "bmp" | "hdr" | "exr" => AssetKind::Texture,
            "ogg" | "wav" | "mp3" | "flac" => AssetKind::Audio,
            "mat" => AssetKind::Material,
            _ => AssetKind::Other,
        }
    }
}

/// `library/LICENSES.json` licence for an asset path under `library/<key>/...`.
fn license_for(licenses: &Value, rel: &str) -> Option<String> {
    let under = rel.strip_prefix("library/")?;
    let map = licenses.as_object()?;
    map.iter()
        .filter(|(k, _)| under == k.as_str() || under.starts_with(&format!("{k}/")))
        .max_by_key(|(k, _)| k.len())
        .and_then(|(_, v)| v.get("license")?.as_str().map(str::to_string))
}

fn safe_rel(dir: &str) -> Option<PathBuf> {
    let p = Path::new(dir.trim_matches('/'));
    p.components().all(|c| matches!(c, std::path::Component::Normal(_))).then(|| p.to_path_buf())
}

pub fn list_assets(root: &Path, dir: &str) -> Vec<AssetEntry> {
    let Some(rel) = safe_rel(dir) else { return Vec::new() };
    let Ok(rd) = std::fs::read_dir(root.join(&rel)) else { return Vec::new() };
    let licenses: Value = std::fs::read_to_string(root.join("library/LICENSES.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    let mut out: Vec<AssetEntry> = rd
        .flatten()
        .take(5000)
        .filter_map(|ent| {
            let name = ent.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || name.ends_with(".bak") || name.ends_with(".tmp") || name.ends_with(".meta") {
                return None;
            }
            let is_dir = ent.file_type().ok()?.is_dir();
            let path = if rel.as_os_str().is_empty() { name.clone() } else { format!("{}/{name}", rel.to_string_lossy().replace('\\', "/")) };
            Some(AssetEntry { license: license_for(&licenses, &path), kind: asset_kind(&name, is_dir), path, name, thumbnail: None })
        })
        .collect();
    out.sort_by(|a, b| (a.kind != AssetKind::Folder).cmp(&(b.kind != AssetKind::Folder)).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    out
}

impl EditorBackend for WorldBackend<'_> {
    fn tree(&mut self, filter: &TreeFilter) -> Vec<TreeNode> {
        let world: &mut World = self.world;
        let roots: Vec<Entity> = world.query_filtered::<Entity, Without<ChildOf>>().iter(world).collect();
        let mut budget = MAX_TREE_NODES;
        let mut nodes = Vec::new();
        let selected = world.resource::<EditorState>().selection.clone();
        // The selection and its ancestors: kept in the tree even below an engine-internal node.
        let mut keep: HashSet<Entity> = HashSet::new();
        for &s in &selected {
            let mut cur = Some(s);
            while let Some(c) = cur {
                if !keep.insert(c) {
                    break;
                }
                cur = world.get::<ChildOf>(c).map(ChildOf::parent);
            }
        }
        for r in roots {
            if let Some(n) = build_node(world, r, &mut budget, false, &selected, &keep) {
                nodes.push(n);
            }
        }
        let text = filter.text.trim().to_lowercase();
        // Stable order: level entities by id, then generated by name.
        let mut nodes = prune(flatten(nodes), filter, &text);
        nodes.sort_by(|a, b| match (a.stable, b.stable) {
            (Some(x), Some(y)) => x.cmp(&y),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => a.name.cmp(&b.name),
        });
        nodes
    }

    fn components(&mut self, id: EntityId) -> Result<Vec<ComponentDoc>, String> {
        let e = resolve(self.world, StableOrId::Id(id))?;
        component_docs(self.world, e)
    }

    fn component_types(&mut self) -> Vec<(String, TypeSchema)> {
        let registry = registry(self.world);
        let reg = registry.read();
        let mut out: Vec<(String, TypeSchema)> = reg
            .iter()
            .filter(|r| r.data::<ReflectComponent>().is_some() && r.data::<bevy::reflect::std_traits::ReflectDefault>().is_some())
            .filter(|r| {
                let t = r.type_info().type_path_table();
                !HIDDEN.contains(&t.short_path()) && !(t.path().starts_with("bevy_") && level::RUNTIME_ONLY.contains(&t.short_path())) && !is_internal(t.path(), t.short_path())
            })
            .map(|r| (r.type_info().type_path().to_string(), schema::schema_of(&reg, r.type_info())))
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    fn apply(&mut self, op: &Op) -> Result<(), String> {
        let r = apply_op(self.world, op);
        if let Err(e) = &r {
            super::log(self.world, Level::Warn, "editor", format!("edit refused: {e}"));
        }
        r
    }

    fn snapshot(&mut self, id: EntityId) -> Result<EntitySnapshot, String> {
        let e = resolve(self.world, StableOrId::Id(id))?;
        snapshot_entity(self.world, e)
    }

    fn selection(&mut self) -> Vec<EntityId> {
        let sel: Vec<Entity> = self.world.resource::<EditorState>().selection.clone();
        let alive: Vec<Entity> = sel.into_iter().filter(|e| self.world.get_entity(*e).is_ok()).collect();
        self.world.resource_mut::<EditorState>().selection = alive.clone();
        alive.into_iter().map(Entity::to_bits).collect()
    }

    fn set_selection(&mut self, ids: &[EntityId]) {
        let sel: Vec<Entity> = ids.iter().filter_map(|b| Entity::try_from_bits(*b)).filter(|e| self.world.get_entity(*e).is_ok()).collect();
        self.world.resource_mut::<EditorState>().selection = sel;
    }

    fn assets(&mut self, dir: &str) -> Vec<AssetEntry> {
        match self.world.get_resource::<AssetsDir>() {
            Some(a) => list_assets(&a.0, dir),
            None => Vec::new(),
        }
    }

    fn place_asset(&mut self, path: &str, at: Placement) -> Result<Op, String> {
        let rel = safe_rel(path).ok_or("bad asset path")?;
        let rel = rel.to_string_lossy().replace('\\', "/");
        if asset_kind(&rel, false) != AssetKind::Model {
            return Err(format!("`{rel}` is not a model (glb/gltf)"));
        }
        let name = Path::new(&rel).file_stem().map_or_else(|| "Model".to_string(), |s| s.to_string_lossy().to_string());
        let pos = match at.screen {
            Some([u, v]) if u.is_finite() && v.is_finite() => super::picking::view_hit(self.world, Vec2::new(u, v)),
            _ if at.position == [0.0, 0.0, 0.0] => super::picking::view_centre_hit(self.world),
            _ => Vec3::from(at.position),
        };
        let server = self.world.get_resource::<AssetServer>().cloned().ok_or("no AssetServer")?;
        let id = level::new_stable_id(self.world);
        let handle = server.load(format!("{rel}#Scene0"));
        let e = self.world.spawn((LevelEntity { id }, Name::new(name), WorldAssetRoot(handle), Transform::from_translation(pos))).id();
        if let Some(p) = at.parent.and_then(|p| by_stable(self.world, p)) {
            self.world.entity_mut(e).insert(ChildOf(p));
        }
        let snap = snapshot_entity(self.world, e)?;
        self.world.resource_mut::<EditorState>().selection = vec![e];
        Ok(Op::Spawn { snapshot: snap })
    }

    fn level(&mut self) -> LevelInfo {
        let i = level::level_info(self.world);
        LevelInfo { path: i.path, dirty: i.dirty }
    }

    fn save_level(&mut self, path: Option<&str>) -> Result<(), String> {
        let target = match path {
            Some(p) => PathBuf::from(p),
            None => self.world.resource::<level::LevelState>().path.clone().ok_or("no level is open: use Save As")?,
        };
        level::save_level(self.world, &target).map(|r| {
            super::log(self.world, Level::Info, "level", format!("saved {} ({} entities)", target.display(), r.entities));
        })
        .map_err(|e| e.to_string())
    }

    fn open_level(&mut self, path: &str) -> Result<(), String> {
        match level::load_level(self.world, path) {
            Ok(n) => {
                self.world.resource_mut::<EditorState>().selection.clear();
                super::log(self.world, Level::Info, "level", format!("opened {path} ({n} entities)"));
                Ok(())
            }
            Err(e) => {
                super::log(self.world, Level::Error, "level", e.to_string());
                Err(e.to_string())
            }
        }
    }

    fn play(&mut self) -> Result<(), String> {
        super::play::start(self.world)
    }

    fn stop(&mut self) {
        super::play::stop(self.world);
    }

    fn play_state(&mut self) -> PlayState {
        super::play::state(self.world)
    }

    fn diagnostics(&mut self, since: u64) -> (u64, Vec<Diagnostic>) {
        self.world.resource::<EditorState>().diagnostics_since(since)
    }

    fn duplicate(&mut self, ids: &[EntityId]) -> Result<Op, String> {
        let mut ops = Vec::new();
        let mut copies = Vec::new();
        for id in ids {
            let e = resolve(self.world, StableOrId::Id(*id))?;
            let mut snap = snapshot_entity(self.world, e)?;
            fresh_ids(self.world, &mut snap);
            snap.name = format!("{} copy", snap.name);
            // Beside the original, so the copy is visible.
            for (tp, v) in snap.components.iter_mut() {
                if tp.ends_with("::Transform")
                    && let Some(x) = v.pointer_mut("/translation/0")
                    && let Some(f) = x.as_f64()
                {
                    *x = serde_json::json!(f + 1.0);
                }
            }
            spawn_snapshot(self.world, &snap, None)?;
            copies.push(snap.stable);
            ops.push(Op::Spawn { snapshot: snap });
        }
        if let Some(first) = copies.first().and_then(|s| by_stable(self.world, *s)) {
            self.world.resource_mut::<EditorState>().selection = vec![first];
        }
        Ok(if ops.len() == 1 { ops.remove(0) } else { Op::Batch(ops) })
    }

    fn reveal_asset(&mut self, path: &str) -> Result<(), String> {
        let root = self.world.get_resource::<AssetsDir>().ok_or("no assets folder")?.0.clone();
        let rel = safe_rel(path).ok_or("bad asset path")?;
        let full = root.join(rel);
        if !full.exists() {
            return Err(format!("`{path}` does not exist"));
        }
        let mut cmd = if cfg!(target_os = "macos") {
            let mut c = std::process::Command::new("open");
            c.arg("-R").arg(&full);
            c
        } else if cfg!(target_os = "windows") {
            let mut c = std::process::Command::new("explorer");
            c.arg(format!("/select,{}", full.display()));
            c
        } else {
            let mut c = std::process::Command::new("xdg-open");
            c.arg(full.parent().unwrap_or(&root));
            c
        };
        cmd.spawn().map(|_| ()).map_err(|e| format!("could not open the file manager: {e}"))
    }

    fn convert_to_level(&mut self, id: EntityId) -> Result<Op, String> {
        let e = resolve(self.world, StableOrId::Id(id))?;
        if self.world.get::<LevelEntity>(e).is_some() {
            return Err("already a level entity".into());
        }
        let stable = level::new_stable_id(self.world);
        let name = self.world.get::<Name>(e).map(|n| n.as_str().to_string()).filter(|n| !n.is_empty()).unwrap_or_else(|| fallback_name(self.world, e));
        let before_name = self.world.get::<Name>(e).map(|n| n.as_str().to_string()).unwrap_or_default();
        let ops = Op::Batch(vec![
            Op::SetComponent { entity: StableOrId::Id(id), type_path: LEVEL_ENTITY.into(), before: None, after: Some(serde_json::json!({ "id": stable.0 })) },
            Op::Rename { entity: StableOrId::Id(id), before: before_name, after: name },
        ]);
        apply_op(self.world, &ops)?;
        self.world.resource_mut::<level::LevelState>().next_id = stable.0;
        Ok(ops)
    }

    fn view_info(&mut self) -> ViewInfo {
        let st = self.world.resource::<EditorState>();
        let (local, grid) = (st.local_space, st.show_grid);
        let cam = self.world.resource::<super::camera::EditorCamera>();
        ViewInfo { camera_speed: cam.speed, local_space: local, show_grid: grid, show_all_scenery: self.world.resource::<EditorState>().show_all_scenery, camera_rotation: cam.rotation().to_array() }
    }

    fn tools(&mut self) -> Vec<ToolDoc> {
        super::tools::docs(self.world)
    }

    fn active_tool(&mut self) -> Option<String> {
        self.world.get_resource::<super::tools::ToolState>().and_then(|t| t.active.clone())
    }

    fn set_active_tool(&mut self, id: Option<&str>) {
        if let Err(e) = super::tools::activate(self.world, id) {
            super::log(self.world, Level::Warn, "tools", e);
        }
    }

    fn set_tool_settings(&mut self, id: &str, settings: Value) -> Result<(), String> {
        super::tools::apply_settings(self.world, id, settings)
    }

    fn take_recorded(&mut self) -> Vec<RecordedOp> {
        self.world.get_resource_mut::<EditorState>().map(|mut s| s.take_recorded()).unwrap_or_default()
    }

    #[cfg(feature = "scripting")]
    fn script_info(&mut self, id: EntityId) -> ScriptInfo {
        self.script_info_impl(id)
    }
    #[cfg(feature = "scripting")]
    fn script_create(&mut self, name: &str, template: &str) -> Result<String, String> {
        self.script_create_impl(name, template)
    }
    #[cfg(feature = "scripting")]
    fn script_node_path(&mut self, from: EntityId, to: EntityId) -> Result<String, String> {
        self.script_node_path_impl(from, to)
    }
    #[cfg(feature = "scripting")]
    fn script_add_stub(&mut self, target: EntityId, method: &str, params: &[String]) -> Result<String, String> {
        self.script_add_stub_impl(target, method, params)
    }

    fn logic_list(&mut self) -> Vec<LogicFile> {
        self.logic_list_impl()
    }
    fn logic_read(&mut self, path: &str) -> Result<String, String> {
        self.logic_read_impl(path)
    }
    fn logic_write(&mut self, path: &str, ron: &str) -> Result<Vec<GraphErrorDoc>, String> {
        self.logic_write_impl(path, ron)
    }
    fn logic_create(&mut self, name: &str, template: &str) -> Result<String, String> {
        self.logic_create_impl(name, template)
    }
    fn logic_palette(&mut self) -> LogicPalette {
        self.logic_palette_impl()
    }
    fn logic_users(&mut self, path: &str) -> Vec<EntityId> {
        self.logic_users_impl(path)
    }
    fn logic_attach(&mut self, entity: EntityId, path: &str) -> Result<Op, String> {
        self.logic_attach_impl(entity, path)
    }
    fn logic_fire(&mut self, entity: EntityId, event: &str) -> Result<LogicTrace, String> {
        self.logic_fire_impl(entity, event)
    }

    fn placeables(&mut self) -> Vec<PlaceableDoc> {
        self.world
            .get_resource::<crate::level::Placeables>()
            .map(|l| l.0.iter().map(|p| PlaceableDoc { name: p.name.clone(), icon: p.icon.clone(), category: p.category.clone(), type_path: p.type_path.to_string() }).collect())
            .unwrap_or_default()
    }

    fn settings(&mut self) -> Vec<SettingsGroup> {
        super::settings_backend::groups(self.world)
    }

    fn set_settings(&mut self, group: &str, value: serde_json::Value) -> Result<(), String> {
        super::settings_backend::set(self.world, group, &value)
    }

    fn viewport(&mut self, cmd: ViewportCmd) {
        match cmd {
            ViewportCmd::FocusSelection => super::camera::focus_selection(self.world),
            ViewportCmd::SetTool(t) => self.world.resource_mut::<EditorState>().tool = t,
            ViewportCmd::SetCameraSpeed(v) => self.world.resource_mut::<super::camera::EditorCamera>().speed = v.clamp(0.2, 400.0),
            ViewportCmd::SetLocalSpace(on) => self.world.resource_mut::<EditorState>().local_space = on,
            ViewportCmd::SetShowGrid(on) => self.world.resource_mut::<EditorState>().show_grid = on,
            ViewportCmd::SetShowAllScenery(on) => super::set_show_all_scenery(self.world, on),
            ViewportCmd::SetSnap { enabled, step } => {
                let mut st = self.world.resource_mut::<EditorState>();
                st.snap = enabled;
                st.snap_step = step;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bevy::world_serialization::{WorldAssetRoot, WorldSerializationPlugin};
    use serde_json::json;

    const TRANSFORM: &str = "bevy_transform::components::transform::Transform";

    fn app() -> App {
        let mut app = App::new();
        app.add_plugins((MinimalPlugins, AssetPlugin::default(), WorldSerializationPlugin))
            .init_asset::<Mesh>()
            .init_asset::<StandardMaterial>()
            .register_type::<Name>()
            .register_type::<Transform>()
            .register_type::<Visibility>()
            .register_type::<ChildOf>()
            .register_type::<PointLight>()
            .register_type::<WorldAssetRoot>()
            .add_plugins(crate::level::LevelPlugin)
            .init_resource::<EditorState>();
        app.finish();
        app.cleanup();
        app
    }

    fn level_entity(world: &mut World, name: &str, at: Vec3) -> Entity {
        let id = level::new_stable_id(world);
        world.spawn((LevelEntity { id }, Name::new(name.to_string()), Transform::from_translation(at))).id()
    }

    fn set_x(world: &mut World, e: Entity, x: f64) -> Op {
        let stable = stable_of(world, e).unwrap();
        let before = component_docs(world, e).unwrap().into_iter().find(|d| d.short_name == "Transform").unwrap().value;
        let mut after = before.clone();
        after["translation"][0] = json!(x);
        Op::SetComponent { entity: StableOrId::Stable(stable), type_path: TRANSFORM.into(), before: Some(before), after: Some(after) }
    }

    #[test]
    fn set_component_and_inverse() {
        let mut app = app();
        let w = app.world_mut();
        let e = level_entity(w, "A", Vec3::new(1.0, 2.0, 3.0));
        let op = set_x(w, e, 9.0);
        let mut be = WorldBackend::new(w);
        be.apply(&op).unwrap();
        assert_eq!(be.world.get::<Transform>(e).unwrap().translation, Vec3::new(9.0, 2.0, 3.0));
        be.apply(&op.inverse()).unwrap();
        assert_eq!(be.world.get::<Transform>(e).unwrap().translation, Vec3::new(1.0, 2.0, 3.0));
    }

    #[test]
    fn generated_entities_are_read_only() {
        let mut app = app();
        let w = app.world_mut();
        let g = w.spawn((Name::new("Code-built"), Transform::default())).id();
        let op = Op::Rename { entity: StableOrId::Id(g.to_bits()), before: "Code-built".into(), after: "x".into() };
        let err = WorldBackend::new(w).apply(&op).unwrap_err();
        assert!(err.contains("generated"), "{err}");
        assert_eq!(w.get::<Name>(g).unwrap().as_str(), "Code-built");
        let tree = WorldBackend::new(w).tree(&TreeFilter::default());
        assert!(tree.iter().any(|n| n.name == "Code-built" && n.generated));
        let tree = WorldBackend::new(w).tree(&TreeFilter { include_generated: false, ..default() });
        assert!(tree.iter().all(|n| n.name != "Code-built"));
    }

    fn find(nodes: &[TreeNode], id: Entity) -> Option<&TreeNode> {
        nodes.iter().find_map(|n| if n.id == id.to_bits() { Some(n) } else { find(&n.children, id) })
    }

    #[test]
    fn selected_unnamed_generated_entity_is_listed_with_its_origin() {
        let mut app = app();
        let w = app.world_mut();
        let plain = w.spawn(Transform::default()).id();
        let marked = w.spawn((GeneratedBy("town::spawn"), Transform::default())).id();
        let tree = WorldBackend::new(w).tree(&TreeFilter::default());
        assert!(find(&tree, plain).is_none(), "an unnamed, unselected entity stays out of the tree");
        let n = find(&tree, marked).expect("GeneratedBy lists it");
        assert!(n.generated);
        assert_eq!(n.origin.as_deref(), Some("town::spawn"));
        // Selecting the unnamed one adds it, with the "generated" fallback origin.
        WorldBackend::new(w).set_selection(&[plain.to_bits()]);
        let tree = WorldBackend::new(w).tree(&TreeFilter::default());
        let n = find(&tree, plain).expect("selected entity is listed");
        assert_eq!(n.origin.as_deref(), Some("generated"));
        assert!(n.name.starts_with("Entity ") || n.name.starts_with("Mesh "), "{}", n.name);
        // And it survives a selection poll.
        assert_eq!(WorldBackend::new(w).selection(), vec![plain.to_bits()]);
    }

    #[test]
    fn selected_entity_below_an_internal_cell_is_listed() {
        let mut app = app();
        let w = app.world_mut();
        let cell = w.spawn((Name::new("pcg cell 1,2"), Transform::default())).id();
        let inst = w.spawn((Name::new("pcg tree"), Transform::default(), ChildOf(cell))).id();
        let tree = WorldBackend::new(w).tree(&TreeFilter::default());
        assert!(find(&tree, inst).is_none() && find(&tree, cell).is_none());
        WorldBackend::new(w).set_selection(&[inst.to_bits()]);
        let tree = WorldBackend::new(w).tree(&TreeFilter::default());
        let n = find(&tree, inst).expect("listed");
        assert_eq!(n.origin.as_deref(), Some("pcg"));
        assert!(find(&tree, cell).is_none(), "the internal cell itself stays hidden");
    }

    #[test]
    fn convert_to_level_is_undoable() {
        let mut app = app();
        let w = app.world_mut();
        let g = w.spawn(Transform::from_xyz(1.0, 2.0, 3.0)).id();
        let mut be = WorldBackend::new(w);
        let op = be.convert_to_level(g.to_bits()).unwrap();
        assert!(be.world.get::<LevelEntity>(g).is_some());
        assert!(be.world.get::<Name>(g).is_some_and(|n| !n.is_empty()));
        assert!(be.convert_to_level(g.to_bits()).is_err(), "already converted");
        be.apply(&op.inverse()).unwrap();
        assert!(be.world.get::<LevelEntity>(g).is_none(), "undo makes it generated again");
        be.apply(&op).unwrap();
        assert!(be.world.get::<LevelEntity>(g).is_some(), "redo");
    }

    #[test]
    fn obj_is_not_a_model() {
        assert_eq!(asset_kind("a.obj", false), AssetKind::Other);
        assert_eq!(asset_kind("a.glb", false), AssetKind::Model);
    }

    #[test]
    fn despawn_and_spawn_keep_stable_ids_and_children() {
        let mut app = app();
        let w = app.world_mut();
        let parent = level_entity(w, "Parent", Vec3::X);
        let child = level_entity(w, "Child", Vec3::Y);
        w.entity_mut(child).insert(ChildOf(parent));
        let (pid, cid) = (stable_of(w, parent).unwrap(), stable_of(w, child).unwrap());
        let mut be = WorldBackend::new(w);
        let snap = be.snapshot(parent.to_bits()).unwrap();
        assert_eq!(snap.children.len(), 1);
        assert_eq!(snap.children[0].parent, Some(pid));
        be.apply(&Op::Despawn { snapshot: snap.clone() }).unwrap();
        assert!(by_stable(be.world, pid).is_none() && by_stable(be.world, cid).is_none());
        be.apply(&Op::Spawn { snapshot: snap }).unwrap();
        let (p2, c2) = (by_stable(be.world, pid).unwrap(), by_stable(be.world, cid).unwrap());
        assert_eq!(be.world.get::<ChildOf>(c2).unwrap().parent(), p2);
        assert_eq!(be.world.get::<Transform>(c2).unwrap().translation, Vec3::Y);
        // The same snapshot twice is refused (ids are unique).
        let snap = be.snapshot(p2.to_bits()).unwrap();
        assert!(be.apply(&Op::Spawn { snapshot: snap }).is_err());
    }

    #[test]
    fn reparent_rename_and_cycles() {
        let mut app = app();
        let w = app.world_mut();
        let a = level_entity(w, "A", Vec3::ZERO);
        let b = level_entity(w, "B", Vec3::ZERO);
        let (sa, sb) = (stable_of(w, a).unwrap(), stable_of(w, b).unwrap());
        let mut be = WorldBackend::new(w);
        be.apply(&Op::Reparent { entity: sb.into(), before: None, after: Some(sa.into()) }).unwrap();
        assert_eq!(be.world.get::<ChildOf>(b).unwrap().parent(), a);
        assert!(be.apply(&Op::Reparent { entity: sa.into(), before: None, after: Some(sb.into()) }).is_err(), "no cycles");
        be.apply(&Op::Reparent { entity: sb.into(), before: Some(sa.into()), after: None }).unwrap();
        assert!(be.world.get::<ChildOf>(b).is_none());
        be.apply(&Op::Rename { entity: sa.into(), before: "A".into(), after: "Alpha".into() }).unwrap();
        assert_eq!(be.world.get::<Name>(a).unwrap().as_str(), "Alpha");
    }

    #[test]
    fn a_failing_batch_changes_nothing() {
        let mut app = app();
        let w = app.world_mut();
        let e = level_entity(w, "A", Vec3::ZERO);
        let good = set_x(w, e, 5.0);
        let bad = Op::Rename { entity: StableOrId::Stable(StableId(9999)), before: String::new(), after: "x".into() };
        let mut be = WorldBackend::new(w);
        assert!(be.apply(&Op::Batch(vec![good, bad])).is_err());
        assert_eq!(be.world.get::<Transform>(e).unwrap().translation.x, 0.0);
    }

    #[test]
    fn bad_input_is_an_error_not_a_panic() {
        let mut app = app();
        let w = app.world_mut();
        let e = level_entity(w, "A", Vec3::ZERO);
        let s = stable_of(w, e).unwrap();
        let mut be = WorldBackend::new(w);
        let set = |tp: &str, v: Value| Op::SetComponent { entity: s.into(), type_path: tp.into(), before: None, after: Some(v) };
        assert!(be.apply(&set("no::such::Type", json!(1))).is_err());
        assert!(be.apply(&set(TRANSFORM, json!("nonsense"))).is_err());
        assert!(be.apply(&set(TRANSFORM, json!({"translation": [1, 2]}))).is_err());
        assert!(be.components(u64::MAX).is_err());
        assert!(be.snapshot(12345).is_err());
        assert!(be.place_asset("../../etc/passwd", Placement::default()).is_err());
        assert!(be.place_asset("textures/x.png", Placement::default()).is_err());
        assert!(be.open_level("/no/such/level.ron").is_err());
        assert!(be.assets("../..").is_empty());
        // Still intact.
        assert_eq!(be.world.get::<Transform>(e).unwrap().translation, Vec3::ZERO);
    }

    #[test]
    fn asset_handles_show_and_load_by_path() {
        let mut app = app();
        let w = app.world_mut();
        let e = level_entity(w, "Car", Vec3::ZERO);
        let s = stable_of(w, e).unwrap();
        let tp = "bevy_world_serialization::components::WorldAssetRoot";
        let mut be = WorldBackend::new(w);
        be.apply(&Op::SetComponent { entity: s.into(), type_path: tp.into(), before: None, after: Some(json!("library/cars/x/car.glb#Scene0")) }).unwrap();
        let doc = be.components(e.to_bits()).unwrap().into_iter().find(|d| d.short_name == "WorldAssetRoot").unwrap();
        assert_eq!(doc.value, json!("library/cars/x/car.glb#Scene0"));
        assert!(matches!(doc.schema, TypeSchema::AssetPath { .. }));
        let snap = be.snapshot(e.to_bits()).unwrap();
        assert!(snap.components.iter().any(|(t, v)| t == tp && v == &json!("library/cars/x/car.glb#Scene0")));
        // Removing a component is `after: None`.
        be.apply(&Op::SetComponent { entity: s.into(), type_path: tp.into(), before: None, after: None }).unwrap();
        assert!(be.world.get::<WorldAssetRoot>(e).is_none());
    }

    #[test]
    fn selection_drops_dead_entities() {
        let mut app = app();
        let w = app.world_mut();
        let a = level_entity(w, "A", Vec3::ZERO);
        let b = level_entity(w, "B", Vec3::ZERO);
        let mut be = WorldBackend::new(w);
        be.set_selection(&[a.to_bits(), b.to_bits(), 77]);
        assert_eq!(be.selection().len(), 2);
        be.world.entity_mut(a).despawn();
        assert_eq!(be.selection(), vec![b.to_bits()]);
    }

    #[test]
    fn asset_listing_marks_folders_kinds_and_licences() {
        let d = std::env::temp_dir().join(format!("editor-assets-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("library/cars/kit")).unwrap();
        std::fs::write(d.join("library/cars/kit/sedan.glb"), b"x").unwrap();
        std::fs::write(d.join("library/LICENSES.json"), r#"{"cars/kit": {"license": "CC0-1.0"}}"#).unwrap();
        std::fs::write(d.join("levels.level.ron"), b"x").unwrap();
        let root = list_assets(&d, "");
        assert_eq!(root[0].kind, AssetKind::Folder);
        assert!(root.iter().any(|a| a.path == "levels.level.ron" && a.kind == AssetKind::Level));
        let cars = list_assets(&d, "library/cars/kit");
        assert_eq!(cars[0].path, "library/cars/kit/sedan.glb");
        assert_eq!(cars[0].kind, AssetKind::Model);
        assert_eq!(cars[0].license.as_deref(), Some("CC0-1.0"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn diagnostics_cursor_advances() {
        let mut st = EditorState::default();
        for i in 0..3 {
            st.push_diag(Diagnostic { level: Level::Info, source: "t".into(), message: i.to_string(), file: None, line: None, col: None, entity: None });
        }
        let (c, items) = st.diagnostics_since(0);
        assert_eq!((c, items.len()), (3, 3));
        let (c2, items) = st.diagnostics_since(c);
        assert_eq!((c2, items.len()), (3, 0));
    }
}
