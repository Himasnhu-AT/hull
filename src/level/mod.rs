//! Level files (feature `level`): a level is the set of entities marked [`LevelEntity`],
//! stored as RON (`levels/<name>.level.ron`) through Bevy's reflected world format. The editor
//! and the game share it: the editor writes it, `--level <file>` plays it, and code-built
//! content keeps working next to it (entities without `LevelEntity` are *generated*: never
//! saved, never despawned by a load). Docs: `docs/LEVELS.md`.
//!
//! ```ignore
//! app.add_plugins(LevelPlugin);                       // added by EnginePlugin
//! commands.queue(LoadLevel("levels/town.level.ron".into()));
//! // or, with &mut World:
//! engine::level::load_level(world, "levels/town.level.ron")?;
//! engine::level::save_level(world, "levels/town.level.ron")?;
//! ```
//!
//! What is saved: entities with [`LevelEntity`] and every reflected component on them except
//! the runtime-only list ([`file::RUNTIME_ONLY`]); parents through `ChildOf` by stable id;
//! asset handles by asset path (`WorldAssetRoot("models/x.glb#Scene0")`); shapes as
//! [`Primitive`] (meshes made with `Assets::add` have no path and are left out).

use std::any::TypeId;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use bevy::ecs::reflect::AppTypeRegistry;
use bevy::prelude::*;
use serde::{Deserialize, Serialize};
#[cfg(feature = "devkit")]
use serde_json::{Value, json};

#[cfg(feature = "devtools")]
mod control;
pub mod file;
pub mod placeable;
pub mod primitive;

pub use file::{LEVEL_VERSION, LevelError, LevelHeader, LevelMigrations, LookRef, MigrateFn, RUNTIME_ONLY, SaveReport};
pub use placeable::{Placeable, Placeables, RegisterPlaceable};
pub use primitive::{Primitive, PrimitiveShape, sync_primitives};

use crate::cli;
use crate::flow::{SkipMenu, in_game};
use crate::paths::AssetsDir;

/// Identity of a level entity, stable across saves, loads and undo. Unique within a level, must
/// fit in 32 bits. Get a fresh one with [`new_stable_id`].
#[derive(Reflect, Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct StableId(pub u64);

/// Marks an entity as part of the level (saved, replaced on load).
#[derive(Component, Reflect, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[reflect(Component, Default)]
pub struct LevelEntity {
    pub id: StableId,
}

/// Marks an entity built by code (not a level file) and says by what, e.g.
/// `GeneratedBy("pacenote::town")`. The editor lists it in the Outliner's Generated folder, makes
/// it selectable (picking a part of it selects the marked root) and shows the origin in Details.
/// Without the marker the editor falls back to the entity's `Name`, else "generated".
#[derive(Component, Clone, Copy, Debug, PartialEq, Eq)]
pub struct GeneratedBy(pub &'static str);

/// A fresh [`StableId`]: above every id in the world and every id handed out so far.
pub fn new_stable_id(world: &mut World) -> StableId {
    let max = world.query::<&LevelEntity>().iter(world).map(|l| l.id.0).max().unwrap_or(0);
    let mut st = world.resource_mut::<LevelState>();
    st.next_id = st.next_id.max(max) + 1;
    StableId(st.next_id)
}

/// Settings. `startup` is filled from `--level <file>` (devtools builds).
#[derive(Resource, Clone, Debug)]
pub struct LevelConfig {
    /// Reload the level when its file changes on disk.
    pub hot_reload: bool,
    /// Seconds between file checks.
    pub poll_secs: f32,
    /// Level loaded once when the game starts (`--level`).
    pub startup: Option<PathBuf>,
    /// The level file this one is a copy of (`--level-origin`, env `EDITOR_LEVEL_ORIGIN`): the
    /// editor's Play writes a copy, and relative world / terrain paths are resolved next to the
    /// original.
    pub origin: Option<PathBuf>,
    /// Extra component types never saved (on top of [`RUNTIME_ONLY`]).
    pub deny: Vec<TypeId>,
}

impl Default for LevelConfig {
    fn default() -> Self {
        LevelConfig { hot_reload: cfg!(feature = "devtools"), poll_secs: 1.0, startup: None, origin: None, deny: Vec::new() }
    }
}

/// Which level file is open.
#[derive(Resource, Default)]
pub struct LevelState {
    /// Path of the open level (as saved / loaded).
    pub path: Option<PathBuf>,
    pub header: LevelHeader,
    /// File version the level had when loaded.
    pub version: u32,
    pub(crate) next_id: u64,
    stamp: Option<(SystemTime, u64)>,
    saved_hash: u64,
    since: Duration,
    startup_done: bool,
    #[cfg(feature = "world")]
    world_spawned: Option<String>,
}

/// Load a level, replacing the current one: `commands.queue(LoadLevel(path))` or
/// `messages.write(LoadLevel(path))`. The result arrives as a [`LevelEvent`].
#[derive(Message, Clone, Debug)]
pub struct LoadLevel(pub PathBuf);

impl Command for LoadLevel {
    type Out = ();
    fn apply(self, world: &mut World) {
        if let Err(e) = load_level(world, &self.0) {
            warn!("{e}");
        }
    }
}

/// Outcome of a load or save (also sent for hot reloads).
#[derive(Message, Clone, Debug)]
pub enum LevelEvent {
    Loaded { path: PathBuf, entities: usize },
    Saved { path: PathBuf, entities: usize },
    Failed { path: PathBuf, error: String },
}

fn send(world: &mut World, ev: LevelEvent) {
    if let Some(mut m) = world.get_resource_mut::<Messages<LevelEvent>>() {
        m.write(ev);
    }
}

fn stamp(path: &Path) -> Option<(SystemTime, u64)> {
    let m = std::fs::metadata(path).ok()?;
    Some((m.modified().ok()?, m.len()))
}

fn hash(text: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut h);
    h.finish()
}

/// The folder paths inside a level are relative to: the original level's folder when this is a
/// copy (`LevelConfig::origin`), else the folder of the open level.
pub fn origin_dir(world: &World) -> Option<PathBuf> {
    let from = world.get_resource::<LevelConfig>().and_then(|c| c.origin.clone()).or_else(|| world.get_resource::<LevelState>().and_then(|s| s.path.clone()))?;
    from.parent().map(Path::to_path_buf).filter(|p| !p.as_os_str().is_empty())
}

/// Relative paths: next to the original level, else as given (project folder), else under the
/// assets folder.
pub(crate) fn resolve(world: &World, p: &Path) -> PathBuf {
    if p.is_absolute() {
        return p.to_path_buf();
    }
    if let Some(o) = world.get_resource::<LevelConfig>().and_then(|c| c.origin.as_ref()).and_then(|o| o.parent())
        && o.join(p).exists()
    {
        return o.join(p);
    }
    if p.exists() {
        return p.to_path_buf();
    }
    match world.get_resource::<AssetsDir>() {
        Some(a) if a.0.join(p).exists() => a.0.join(p),
        _ => p.to_path_buf(),
    }
}

fn with_suffix(p: &Path, s: &str) -> PathBuf {
    let mut o = p.as_os_str().to_owned();
    o.push(s);
    PathBuf::from(o)
}

/// Writes the level to `path` (atomic: temp file then rename; the previous file is kept as
/// `<path>.bak`). The path becomes the open level.
pub fn save_level(world: &mut World, path: impl AsRef<Path>) -> Result<SaveReport, LevelError> {
    let path = path.as_ref().to_path_buf();
    let r = save_inner(world, &path);
    match &r {
        Ok(rep) => send(world, LevelEvent::Saved { path, entities: rep.entities }),
        Err(e) => send(world, LevelEvent::Failed { path, error: e.to_string() }),
    }
    r
}

fn save_inner(world: &mut World, path: &Path) -> Result<SaveReport, LevelError> {
    // Terrain edits (sculpt/paint) go to the level's terrain files first: a level that points
    // at terrain must never be saved ahead of it.
    #[cfg(feature = "world")]
    crate::world::TerrainEdit::save_if_dirty(world).map_err(|e| LevelError::Io(format!("terrain: {e}")))?;
    let header = world.resource::<LevelState>().header.clone();
    let deny = world.resource::<LevelConfig>().deny.clone();
    let (text, report) = file::to_text(world, &header, &deny)?;
    for s in &report.skipped {
        warn!("level save skipped {s}");
    }
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir).map_err(|e| LevelError::Io(format!("{}: {e}", dir.display())))?;
    }
    let tmp = with_suffix(path, ".tmp");
    std::fs::write(&tmp, &text).map_err(|e| LevelError::Io(format!("{}: {e}", tmp.display())))?;
    if path.is_file() {
        let _ = std::fs::copy(path, with_suffix(path, ".bak"));
    }
    std::fs::rename(&tmp, path).map_err(|e| LevelError::Io(format!("{}: {e}", path.display())))?;
    let mut st = world.resource_mut::<LevelState>();
    st.path = Some(path.to_path_buf());
    st.stamp = stamp(path);
    st.saved_hash = hash(&text);
    st.version = LEVEL_VERSION;
    Ok(report)
}

/// Loads the level at `path`, replacing the current one. Everything is parsed and checked
/// first: on any error the current level is left as it was. Returns the entity count.
pub fn load_level(world: &mut World, path: impl AsRef<Path>) -> Result<usize, LevelError> {
    let path = resolve(world, path.as_ref());
    let r = load_inner(world, &path);
    match &r {
        Ok(n) => send(world, LevelEvent::Loaded { path, entities: *n }),
        Err(e) => send(world, LevelEvent::Failed { path, error: e.to_string() }),
    }
    r
}

fn load_inner(world: &mut World, path: &Path) -> Result<usize, LevelError> {
    let text = std::fs::read_to_string(path).map_err(|e| LevelError::Io(format!("{}: {e}", path.display())))?;
    let mut server = world.get_resource::<AssetServer>().cloned().ok_or(LevelError::NoAssets)?;
    let registry = world.resource::<AppTypeRegistry>().clone();
    let parsed = {
        let migrations = world.resource::<LevelMigrations>();
        file::parse(&text, &registry.read(), &mut server, migrations)?
    };
    #[cfg(feature = "world")]
    let world_desc = match &parsed.header.world {
        Some(w) => Some(read_world_desc(world, w, path)?),
        None => None,
    };
    #[cfg(feature = "look")]
    let look = match &parsed.header.look {
        Some(LookRef::Preset(name)) => Some(crate::look::Look::preset(name).ok_or_else(|| LevelError::Invalid(format!("unknown look preset `{name}`")))?),
        Some(LookRef::Inline(l)) => Some((**l).clone()),
        None => None,
    };

    file::despawn_level(world);
    let (count, max_id) = file::spawn(world, &parsed)?;

    #[cfg(feature = "look")]
    if let Some(l) = look {
        world.insert_resource(l);
    }
    // An already spawned world file is kept as is (rebuilding terrain on every hot reload is slow).
    #[cfg(feature = "world")]
    match world_desc {
        None => {
            if world.resource_mut::<LevelState>().world_spawned.take().is_some() {
                crate::world::despawn_world(world);
            }
        }
        Some(desc) => {
            if world.resource::<LevelState>().world_spawned != parsed.header.world {
                crate::world::despawn_world(world);
                crate::world::spawn_world(world, desc).map_err(|e| LevelError::World(e.to_string()))?;
                world.resource_mut::<LevelState>().world_spawned = parsed.header.world.clone();
            }
        }
    }

    let mut st = world.resource_mut::<LevelState>();
    st.path = Some(path.to_path_buf());
    st.header = parsed.header;
    st.version = parsed.file_version;
    st.next_id = st.next_id.max(max_id);
    st.stamp = stamp(path);
    // The saved baseline is what saving the loaded level would write now.
    let header = st.header.clone();
    let deny = world.resource::<LevelConfig>().deny.clone();
    let baseline = file::to_text(world, &header, &deny).map(|(t, _)| hash(&t)).unwrap_or(0);
    world.resource_mut::<LevelState>().saved_hash = baseline;
    Ok(count)
}

#[cfg(feature = "world")]
fn read_world_desc(world: &World, rel: &str, level: &Path) -> Result<crate::world::WorldDesc, LevelError> {
    let p = resolve(world, Path::new(rel));
    let text = std::fs::read_to_string(&p).map_err(|e| LevelError::World(format!("{}: {e}", p.display())))?;
    let mut desc = crate::world::WorldDesc::from_ron(&text).map_err(|e| LevelError::World(format!("{}: {e}", p.display())))?;
    // A terrain folder given relative to the level (not the assets folder) is found next to the
    // original level (the one `--level-origin` names when this file is a copy), and saved there.
    if let crate::world::desc::HeightSource::TerrainFiles { dir } = &mut desc.terrain.source
        && Path::new(dir.as_str()).is_relative()
    {
        let base = world.get_resource::<LevelConfig>().and_then(|c| c.origin.clone()).unwrap_or_else(|| level.to_path_buf());
        if let Some(d) = base.parent().map(|b| b.join(dir.as_str())).filter(|d| d.join("terrain.ron").is_file()) {
            *dir = d.display().to_string();
        }
    }
    Ok(desc)
}

/// Summary of the open level (`level.info`).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct LevelInfo {
    pub path: Option<String>,
    pub entities: usize,
    pub version: u32,
    /// The level differs from what is on disk (compared by content, so moving an entity and
    /// moving it back is clean).
    pub dirty: bool,
    pub world: Option<String>,
    pub look: Option<String>,
}

pub fn level_info(world: &mut World) -> LevelInfo {
    let entities = world.query_filtered::<(), With<LevelEntity>>().iter(world).count();
    let header = world.resource::<LevelState>().header.clone();
    let deny = world.resource::<LevelConfig>().deny.clone();
    let now = file::to_text(world, &header, &deny).map(|(t, _)| hash(&t)).ok();
    let st = world.resource::<LevelState>();
    LevelInfo {
        path: st.path.as_ref().map(|p| p.display().to_string()),
        entities,
        version: st.version,
        dirty: now.is_none_or(|h| h != st.saved_hash),
        world: header.world,
        look: header.look.map(|l| match l {
            LookRef::Preset(n) => n,
            #[cfg(feature = "look")]
            LookRef::Inline(l) => format!("inline:{}", l.name),
        }),
    }
}

/// Is this entity built by code (no [`LevelEntity`])? Generated entities are read-only in the editor.
pub fn is_generated(world: &World, e: Entity) -> bool {
    world.get::<LevelEntity>(e).is_none()
}

/// Every named entity as `(entity, nearest named ancestor, name)`, parents before children, in
/// hierarchy order. Unnamed entities are skipped but their named descendants attach to the
/// nearest named ancestor. Use [`is_generated`] to tell code-built nodes from level entities.
pub fn tree(world: &mut World) -> Vec<(Entity, Option<Entity>, String)> {
    let roots: Vec<Entity> = world.query_filtered::<Entity, Without<ChildOf>>().iter(world).collect();
    let mut out = Vec::new();
    let mut stack: Vec<(Entity, Option<Entity>)> = roots.into_iter().rev().map(|e| (e, None)).collect();
    while let Some((e, named_parent)) = stack.pop() {
        let name = world.get::<Name>(e).map(|n| n.as_str().to_string());
        let up = match name {
            Some(n) => {
                out.push((e, named_parent, n));
                Some(e)
            }
            None => named_parent,
        };
        if let Some(kids) = world.get::<Children>(e) {
            for c in kids.iter().rev() {
                stack.push((c, up));
            }
        }
    }
    out
}

/// Reflect JSON of every level entity (`{stable id: {ShortName: value}}`, runtime-only
/// components left out, `ChildOf` as the parent's stable id; other entity references stay raw): for tests and tools that compare levels.
#[cfg(feature = "devkit")]
pub fn snapshot_json(world: &mut World) -> Value {
    use crate::devkit::reflect_json::entity_json;
    let ents: Vec<(Entity, u64)> = world.query::<(Entity, &LevelEntity)>().iter(world).map(|(e, l)| (e, l.id.0)).collect();
    let registry = world.resource::<AppTypeRegistry>().clone();
    let reg = registry.read();
    let stable: std::collections::HashMap<Entity, u64> = ents.iter().copied().collect();
    let mut map = serde_json::Map::new();
    for (e, id) in ents {
        let Ok((mut comps, _)) = entity_json(world, e, &reg) else { continue };
        for name in RUNTIME_ONLY {
            comps.remove(*name);
        }
        // Runtime entity ids differ between loads: show the parent by stable id.
        if let Some(c) = world.get::<ChildOf>(e) {
            comps.insert("ChildOf".into(), stable.get(&c.parent()).map_or(Value::Null, |s| json!(s)));
        }
        map.insert(id.to_string(), Value::Object(comps));
    }
    json!(map)
}

fn apply_load_requests(world: &mut World) {
    let reqs: Vec<LoadLevel> = world.resource_mut::<Messages<LoadLevel>>().drain().collect();
    for r in reqs {
        if let Err(e) = load_level(world, &r.0) {
            warn!("{e}");
        }
    }
}

/// `--level`: load once the game has started.
fn load_startup(world: &mut World) {
    let st = world.resource::<LevelState>();
    if st.startup_done {
        return;
    }
    world.resource_mut::<LevelState>().startup_done = true;
    if let Some(p) = world.resource::<LevelConfig>().startup.clone()
        && let Err(e) = load_level(world, &p)
    {
        error!("--level {}: {e}", p.display());
    }
}

fn hot_reload(world: &mut World) {
    let cfg = world.resource::<LevelConfig>();
    if !cfg.hot_reload {
        return;
    }
    let interval = Duration::from_secs_f32(cfg.poll_secs.max(0.0));
    let dt = world.resource::<Time<Real>>().delta();
    let mut st = world.resource_mut::<LevelState>();
    st.since += dt;
    if st.since < interval {
        return;
    }
    st.since = Duration::ZERO;
    let Some(path) = st.path.clone() else { return };
    let now = stamp(&path);
    if now.is_none() || now == st.stamp {
        return;
    }
    // Remember the stamp first: a half-written file is retried only when it changes again.
    st.stamp = now;
    info!("level hot reload: {}", path.display());
    if let Err(e) = load_level(world, &path) {
        warn!("level hot reload kept the old level: {e}");
    }
}

/// Added by `EnginePlugin`.
pub struct LevelPlugin;

impl Plugin for LevelPlugin {
    fn build(&self, app: &mut App) {
        let mut cfg = LevelConfig::default();
        if let Some(p) = cli::dev_value("level") {
            cfg.startup = Some(PathBuf::from(p));
            app.insert_resource(SkipMenu(true));
        }
        cfg.origin = cli::dev_value("level-origin").or_else(|| cfg!(feature = "devtools").then(|| std::env::var("EDITOR_LEVEL_ORIGIN").ok()).flatten()).map(PathBuf::from);
        app.insert_resource(cfg)
            .init_resource::<LevelState>()
            .init_resource::<LevelMigrations>()
            .init_resource::<Placeables>()
            .init_resource::<primitive::PrimitiveCache>()
            .add_message::<LoadLevel>()
            .add_message::<LevelEvent>()
            .register_type::<StableId>()
            .register_type::<LevelEntity>()
            .register_type::<Primitive>()
            .register_type::<PrimitiveShape>()
            .add_systems(Update, (apply_load_requests, load_startup.run_if(in_game), hot_reload, sync_primitives).chain());
        #[cfg(feature = "world")]
        app.register_type::<crate::world::prefab::PrefabInstance>().register_type::<crate::world::WorldTags>();
        #[cfg(feature = "devtools")]
        control::register(app);
    }
}

#[cfg(test)]
mod tests;
