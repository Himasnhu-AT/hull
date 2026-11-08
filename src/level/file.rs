//! The level file: format, serialisation, parsing, migration and applying to a world.
//!
//! ```ron
//! (
//!   version: 1,
//!   world: Some("worlds/valley.world.ron"),
//!   look: Some(Preset("clear_day")),
//!   entities: (resources: {}, entities: { 1: (components: { ... }), 2: (...) }),
//! )
//! ```
//!
//! `entities` is Bevy's reflected world format (`DynamicWorld`), keyed by [`StableId`] instead
//! of runtime entity ids, so a save diffs cleanly and ids survive a reload. Entity references
//! inside components (`ChildOf`, any `#[entities]` field) are written as stable ids too.

use std::any::TypeId;
use std::collections::BTreeSet;
use std::fmt;

use bevy::asset::{EphemeralHandleBehavior, HandleSerializeProcessor, LoadFromPath};
use bevy::ecs::entity::{EntityHashMap, EntityMapper};
use bevy::ecs::reflect::{AppTypeRegistry, ReflectComponent};
use bevy::prelude::*;
use bevy::reflect::serde::TypedReflectSerializer;
use bevy::reflect::{PartialReflect, TypeRegistry};
use bevy::world_serialization::serde::{DynamicWorldSerializer, WorldDeserializer};
use bevy::world_serialization::{DynamicWorld, DynamicWorldBuilder, WorldFilter};
use serde::de::{DeserializeSeed, MapAccess, Visitor};
use serde::{Deserialize, Serialize, Serializer};

use super::{LevelEntity, StableId};

/// The format version this build writes. Older files go through [`LevelMigrations`].
pub const LEVEL_VERSION: u32 = 1;

/// Engine components that are rebuilt at runtime (transform / visibility / render caches,
/// relationship targets). Matched by short name for types whose path starts with `bevy_`, so
/// the list needs no exact paths. Games add more with `LevelConfig::deny`.
pub const RUNTIME_ONLY: &[&str] = &[
    "GlobalTransform",
    "TransformTreeChanged",
    "InheritedVisibility",
    "ViewVisibility",
    "VisibilityClass",
    "Children",
    "Aabb",
    "NoAutoAabb",
    "SyncToRenderWorld",
    "VisibleEntities",
    "VisibleMeshEntities",
    "Frustum",
    "CubemapFrusta",
    "CubemapVisibleEntities",
    "CascadesFrusta",
    "CascadesVisibility",
    "Cascades",
    "CascadesVisibleEntities",
    "CascadeShadowConfig",
    "WorldInstance",
    "MainEntity",
    "RenderEntity",
    "TemporaryRenderEntity",
    "ComputedNode",
    "ComputedUiTargetCamera",
    "UiGlobalTransform",
    "CalculatedClip",
    "ClusterFarZMode",
    "CameraMainTextureUsages",
    "Hdr",
    "ExtractedView",
    "ColorGradingState",
    "VisibilityRange",
    "Mesh3dWireframe",
    "Sphere",
    "RenderTarget",
];

/// Look of a level: a preset name or a complete [`crate::look::Look`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum LookRef {
    /// `clear_day`, `overcast`, `dusk`, `night`, `indoor`.
    Preset(String),
    #[cfg(feature = "look")]
    Inline(Box<crate::look::Look>),
}

/// The non-entity parts of a level file.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LevelHeader {
    /// A `WorldDesc` RON (terrain, scatter), relative to the assets folder or the project.
    pub world: Option<String>,
    pub look: Option<LookRef>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum LevelError {
    Io(String),
    Parse(String),
    Serialize(String),
    /// File is newer than this build, or no migration is registered.
    Version(String),
    Migrate { from: u32, message: String },
    /// Well-formed but unusable (duplicate ids, unregistered component, ...).
    Invalid(String),
    /// The `world` file could not be read or parsed.
    World(String),
    NoAssets,
}

impl fmt::Display for LevelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LevelError::Io(e) => write!(f, "level io: {e}"),
            LevelError::Parse(e) => write!(f, "level parse: {e}"),
            LevelError::Serialize(e) => write!(f, "level save: {e}"),
            LevelError::Version(e) => write!(f, "level version: {e}"),
            LevelError::Migrate { from, message } => write!(f, "level migration from version {from}: {message}"),
            LevelError::Invalid(e) => write!(f, "level invalid: {e}"),
            LevelError::World(e) => write!(f, "level world: {e}"),
            LevelError::NoAssets => write!(f, "level load needs an AssetServer (AssetPlugin)"),
        }
    }
}

impl std::error::Error for LevelError {}

/// Upgrades the text of a level file one version (`from` → `from + 1`). Register with
/// [`LevelMigrations::add`]. Text in, text out, so a migration can edit any part of the file.
pub type MigrateFn = fn(&str) -> Result<String, String>;

/// Migrations by source version. Version 0 (a file without `version`) → 1 is built in and
/// changes nothing; replace it with [`LevelMigrations::add`] if you need to.
#[derive(Resource)]
pub struct LevelMigrations {
    steps: Vec<(u32, MigrateFn)>,
}

impl Default for LevelMigrations {
    fn default() -> Self {
        LevelMigrations { steps: vec![(0, |t| Ok(t.to_string()))] }
    }
}

impl LevelMigrations {
    /// Migration from `from` to `from + 1` (replaces an earlier one for `from`).
    pub fn add(&mut self, from: u32, f: MigrateFn) -> &mut Self {
        self.steps.retain(|(v, _)| *v != from);
        self.steps.push((from, f));
        self
    }
    fn get(&self, from: u32) -> Option<MigrateFn> {
        self.steps.iter().find(|(v, _)| *v == from).map(|(_, f)| *f)
    }
}

/// A parsed, validated level, not yet in the world.
pub struct ParsedLevel {
    /// Version the file had before migration.
    pub file_version: u32,
    pub header: LevelHeader,
    pub entities: DynamicWorld,
}

/// What a save wrote.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SaveReport {
    pub entities: usize,
    /// Components left out because they could not be serialised (`Type on entity N: why`).
    pub skipped: Vec<String>,
}

fn type_id_of(c: &dyn PartialReflect) -> Option<TypeId> {
    c.get_represented_type_info().map(|i| i.type_id())
}

/// Type ids never written to a level: [`RUNTIME_ONLY`] plus `extra`.
pub fn deny_list(reg: &TypeRegistry, extra: &[TypeId]) -> Vec<TypeId> {
    let mut v: Vec<TypeId> = reg
        .iter()
        .filter(|r| {
            let t = r.type_info().type_path_table();
            t.path().starts_with("bevy_") && RUNTIME_ONLY.contains(&t.short_path())
        })
        .map(|r| r.type_id())
        .collect();
    v.extend_from_slice(extra);
    v
}

/// Strong handles without an asset path (made by `Assets::add`) cannot be written.
fn ephemeral<A: Asset>(h: &Handle<A>) -> bool {
    h.is_strong() && h.path().is_none()
}

/// Extracts every [`LevelEntity`] (and only those) into a [`DynamicWorld`] keyed by stable id.
pub fn extract(world: &mut World, extra_deny: &[TypeId]) -> Result<(DynamicWorld, SaveReport), LevelError> {
    let mut ents: Vec<(Entity, StableId)> = world.query::<(Entity, &LevelEntity)>().iter(world).map(|(e, l)| (e, l.id)).collect();
    ents.sort_by_key(|(_, id)| *id);
    let mut to_stable: EntityHashMap<Entity> = EntityHashMap::default();
    for w in ents.windows(2) {
        if w[0].1 == w[1].1 {
            return Err(LevelError::Invalid(format!("stable id {} is used by two entities", w[0].1.0)));
        }
    }
    for (e, id) in &ents {
        let key = u32::try_from(id.0).ok().and_then(Entity::from_raw_u32).ok_or_else(|| LevelError::Invalid(format!("stable id {} does not fit in 32 bits", id.0)))?;
        to_stable.insert(*e, key);
    }

    let registry = world.resource::<AppTypeRegistry>().clone();
    let reg = registry.read();
    let mut filter = WorldFilter::allow_all();
    for id in deny_list(&reg, extra_deny) {
        filter = filter.deny_by_id(id);
    }
    let mut dw = DynamicWorldBuilder::from_world(world, &reg)
        .with_component_filter(filter)
        .extract_entities(ents.iter().map(|(e, _)| *e))
        .build();

    let child_of = TypeId::of::<ChildOf>();
    let mesh3d = TypeId::of::<Mesh3d>();
    let material3d = TypeId::of::<MeshMaterial3d<StandardMaterial>>();
    let proc = HandleSerializeProcessor { ephemeral_handle_behavior: EphemeralHandleBehavior::Silent };
    let mut report = SaveReport { entities: dw.entities.len(), skipped: Vec::new() };

    for de in &mut dw.entities {
        let live = de.entity;
        let Some(&key) = to_stable.get(&live) else { continue };
        let parent_in_level = world.get::<ChildOf>(live).is_some_and(|c| to_stable.contains_key(&c.parent()));
        let drop_mesh = world.get::<Mesh3d>(live).is_some_and(|m| ephemeral(&m.0));
        let drop_mat = world.get::<MeshMaterial3d<StandardMaterial>>(live).is_some_and(|m| ephemeral(&m.0));
        let has_primitive = world.get::<super::Primitive>(live).is_some();
        de.components.retain(|c| match type_id_of(c.as_ref()) {
            Some(t) if t == child_of => parent_in_level,
            Some(t) if t == mesh3d => !(drop_mesh || has_primitive),
            Some(t) if t == material3d => !(drop_mat || has_primitive),
            _ => true,
        });
        for c in &mut de.components {
            // Entity fields (`#[entities]`) to stable keys, through the component's own `map_entities`.
            let rc = type_id_of(c.as_ref()).and_then(|t| reg.get(t)).and_then(|r| r.data::<ReflectComponent>());
            if let (Some(rc), Some(value)) = (rc, c.try_as_reflect_mut()) {
                rc.map_entities(value, &mut to_stable as &mut dyn EntityMapper);
            }
        }
        de.entity = key;
        de.components.retain(|c| match serde_json::to_value(TypedReflectSerializer::with_processor(c.as_ref(), &reg, &proc)) {
            Ok(_) => true,
            Err(e) => {
                report.skipped.push(format!("{} on entity {}: {e}", c.reflect_type_path(), key.index()));
                false
            }
        });
    }
    dw.entities.sort_by_key(|e| e.entity.index());
    Ok((dw, report))
}

struct LevelOut<'a> {
    header: &'a LevelHeader,
    entities: DynamicWorldSerializer<'a>,
}

impl Serialize for LevelOut<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("LevelFile", 4)?;
        st.serialize_field("version", &LEVEL_VERSION)?;
        st.serialize_field("world", &self.header.world)?;
        st.serialize_field("look", &self.header.look)?;
        st.serialize_field("entities", &self.entities)?;
        st.end()
    }
}

/// The text of the level file for the entities currently in `world`.
pub fn to_text(world: &mut World, header: &LevelHeader, extra_deny: &[TypeId]) -> Result<(String, SaveReport), LevelError> {
    let (dw, report) = extract(world, extra_deny)?;
    let registry = world.resource::<AppTypeRegistry>().clone();
    let reg = registry.read();
    let out = LevelOut { header, entities: DynamicWorldSerializer::new(&dw, &reg) };
    let cfg = ron::ser::PrettyConfig::default().indentor("  ".to_string()).new_line("\n".to_string());
    let text = ron::ser::to_string_pretty(&out, cfg).map_err(|e| LevelError::Serialize(e.to_string()))?;
    Ok((text, report))
}

#[derive(Deserialize)]
struct VersionOnly {
    #[serde(default)]
    version: u32,
}

#[derive(Deserialize)]
#[serde(field_identifier, rename_all = "lowercase")]
enum Field {
    Version,
    World,
    Look,
    Entities,
}

struct LevelSeed<'a> {
    reg: &'a TypeRegistry,
    loader: &'a mut dyn LoadFromPath,
}

impl<'de> DeserializeSeed<'de> for LevelSeed<'_> {
    type Value = (LevelHeader, DynamicWorld);
    fn deserialize<D: serde::Deserializer<'de>>(self, d: D) -> Result<Self::Value, D::Error> {
        d.deserialize_struct("LevelFile", &["version", "world", "look", "entities"], LevelVisitor { reg: self.reg, loader: self.loader })
    }
}

struct LevelVisitor<'a> {
    reg: &'a TypeRegistry,
    loader: &'a mut dyn LoadFromPath,
}

impl<'de> Visitor<'de> for LevelVisitor<'_> {
    type Value = (LevelHeader, DynamicWorld);
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("a level file `(version, world, look, entities)`")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        use serde::de::Error;
        let mut header = LevelHeader::default();
        let mut entities = None;
        while let Some(key) = map.next_key::<Field>()? {
            match key {
                Field::Version => {
                    map.next_value::<u32>()?;
                }
                Field::World => header.world = map.next_value()?,
                Field::Look => header.look = map.next_value()?,
                Field::Entities => {
                    entities = Some(map.next_value_seed(WorldDeserializer { type_registry: self.reg, load_from_path: self.loader })?);
                }
            }
        }
        Ok((header, entities.ok_or_else(|| A::Error::missing_field("entities"))?))
    }
}

/// Parses level text: migrates old versions, deserialises through the type registry (asset
/// handles load by path through `loader`) and checks the result. Nothing touches the world.
pub fn parse(text: &str, reg: &TypeRegistry, loader: &mut dyn LoadFromPath, migrations: &LevelMigrations) -> Result<ParsedLevel, LevelError> {
    let file_version = ron::from_str::<VersionOnly>(text).map_err(|e| LevelError::Parse(e.to_string()))?.version;
    if file_version > LEVEL_VERSION {
        return Err(LevelError::Version(format!("file is version {file_version}, this build reads up to {LEVEL_VERSION}")));
    }
    let mut text = std::borrow::Cow::Borrowed(text);
    for v in file_version..LEVEL_VERSION {
        let f = migrations.get(v).ok_or_else(|| LevelError::Version(format!("no migration from version {v}")))?;
        text = std::borrow::Cow::Owned(f(&text).map_err(|message| LevelError::Migrate { from: v, message })?);
    }
    let mut de = ron::de::Deserializer::from_str(&text).map_err(|e| LevelError::Parse(e.to_string()))?;
    let (header, mut entities) = LevelSeed { reg, loader }.deserialize(&mut de).map_err(|e| LevelError::Parse(de.span_error(e).to_string()))?;
    de.end().map_err(|e| LevelError::Parse(de.span_error(e).to_string()))?;
    validate(&mut entities, reg)?;
    Ok(ParsedLevel { file_version, header, entities })
}

/// Rejects duplicate ids and component types that cannot be spawned; drops `ChildOf` whose
/// parent is not in the file (the entity becomes a root).
fn validate(dw: &mut DynamicWorld, reg: &TypeRegistry) -> Result<(), LevelError> {
    let ids: BTreeSet<Entity> = dw.entities.iter().map(|e| e.entity).collect();
    if ids.len() != dw.entities.len() {
        return Err(LevelError::Invalid("two entities share an id".into()));
    }
    let child_of = TypeId::of::<ChildOf>();
    for de in &mut dw.entities {
        for c in &de.components {
            let t = type_id_of(c.as_ref()).ok_or_else(|| LevelError::Invalid(format!("component {} has no type info", c.reflect_type_path())))?;
            if reg.get(t).and_then(|r| r.data::<ReflectComponent>()).is_none() {
                return Err(LevelError::Invalid(format!("{} is not a registered component (#[reflect(Component)])", c.reflect_type_path())));
            }
        }
        let own = de.entity;
        de.components.retain(|c| {
            if type_id_of(c.as_ref()) != Some(child_of) {
                return true;
            }
            let parent = <ChildOf as FromReflect>::from_reflect(c.as_ref()).map(|c| c.parent());
            let ok = parent.is_some_and(|p| ids.contains(&p));
            if !ok {
                warn!("level: entity {} has a parent that is not in the file; made a root", own.index());
            }
            ok
        });
    }
    Ok(())
}

/// Despawns every [`LevelEntity`] (children included).
pub fn despawn_level(world: &mut World) {
    let all: Vec<Entity> = world.query_filtered::<Entity, With<LevelEntity>>().iter(world).collect();
    for e in all {
        if let Ok(em) = world.get_entity_mut(e) {
            em.despawn();
        }
    }
}

/// Spawns a parsed level into the world (the previous level must be despawned first). Returns
/// the number of entities and the highest stable id.
pub fn spawn(world: &mut World, parsed: &ParsedLevel) -> Result<(usize, u64), LevelError> {
    let registry = world.resource::<AppTypeRegistry>().clone();
    let reg = registry.read();
    let mut map: EntityHashMap<Entity> = EntityHashMap::default();
    parsed.entities.write_to_world_with(world, &mut map, &reg).map_err(|e| LevelError::Invalid(e.to_string()))?;
    let mut max_id = 0u64;
    // The map also holds entities reserved for references to things outside the file: skip those.
    let mut count = 0;
    for de in &parsed.entities.entities {
        let (file_e, new_e) = (&de.entity, &map[&de.entity]);
        count += 1;
        let id = u64::from(file_e.index().index());
        max_id = max_id.max(id);
        if world.get::<LevelEntity>(*new_e).is_none() {
            world.entity_mut(*new_e).insert(LevelEntity { id: StableId(id) });
        }
        // `write_to_world` skips relationship hooks; re-insert so `Children` is rebuilt.
        if let Some(p) = world.get::<ChildOf>(*new_e).map(|c| c.parent()) {
            world.entity_mut(*new_e).insert(ChildOf(p));
        }
    }
    Ok((count, max_id))
}

/// Spawns a parsed level as new, generated entities (Godot `PackedScene.instantiate`): no
/// [`LevelEntity`], so they are not saved with the current level and `despawn_level` leaves
/// them alone. The file's hierarchy is kept; its root entities go under `parent` if given.
/// Returns every spawned entity in file order (the first root comes first among roots).
pub fn spawn_instance(world: &mut World, parsed: &ParsedLevel, parent: Option<Entity>) -> Result<Vec<Entity>, LevelError> {
    let registry = world.resource::<AppTypeRegistry>().clone();
    let reg = registry.read();
    let mut map: EntityHashMap<Entity> = EntityHashMap::default();
    parsed.entities.write_to_world_with(world, &mut map, &reg).map_err(|e| LevelError::Invalid(e.to_string()))?;
    let mut out = Vec::with_capacity(parsed.entities.entities.len());
    for de in &parsed.entities.entities {
        let e = map[&de.entity];
        world.entity_mut(e).remove::<LevelEntity>();
        match world.get::<ChildOf>(e).map(|c| c.parent()) {
            // `write_to_world` skips relationship hooks; re-insert so `Children` is rebuilt.
            Some(p) => {
                world.entity_mut(e).insert(ChildOf(p));
            }
            None => {
                if let Some(p) = parent {
                    world.entity_mut(e).insert(ChildOf(p));
                }
            }
        }
        out.push(e);
    }
    Ok(out)
}
