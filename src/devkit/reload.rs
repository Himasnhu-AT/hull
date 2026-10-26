//! JSON hot reload: tuning / data / settings files are polled (one `stat` per file every
//! [`HotReloadConfig::interval_secs`]) and, when their mtime or size changes, parsed and put
//! back into their resource. No Bevy features, no watcher threads.
//!
//! ```ignore
//! #[derive(Resource, Deserialize, PartialEq, Default)] #[serde(default)]
//! struct Tuning { enemy_speed: f32, spawn_every: f32 }
//! app.init_resource::<Tuning>()
//!    .hot_reload_json::<Tuning>(WatchPath::assets("tuning.json"), None)
//!    // one section of a bigger file (JSON pointer):
//!    .hot_reload_json::<CoreSettings>(WatchPath::data("settings.json"), Some("/core"));
//! ```
//!
//! The first poll (the first frame) loads the file if it exists, so the watch doubles as the
//! loader; a missing file leaves the resource as it is. The resource is only replaced when the
//! parsed value differs (`PartialEq`), so a game that saves the file itself doesn't loop. Bad JSON keeps the old value and logs a warning; every
//! attempt sends a [`Reloaded`] message. Off by default without `devtools` (ship builds):
//! set `HotReloadConfig { enabled: true, ..default() }` to keep it.
//!
//! Assets (textures, meshes, scenes) reload through Bevy's own watcher: the optional engine
//! feature `hot_reload` turns on `bevy/file_watcher` (it recompiles Bevy once).
//!
//! Control (`devtools`): `devkit.reload {force?}` lists the watches and their last result;
//! `force: true` reloads them all now.

use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use bevy::prelude::*;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::paths::{AssetsDir, DataDir};

/// Where a watched file lives.
#[derive(Clone, Debug)]
pub enum WatchPath {
    /// Relative to [`DataDir`].
    Data(PathBuf),
    /// Relative to [`AssetsDir`].
    Assets(PathBuf),
    Absolute(PathBuf),
}

impl WatchPath {
    pub fn data(p: impl Into<PathBuf>) -> Self {
        WatchPath::Data(p.into())
    }
    pub fn assets(p: impl Into<PathBuf>) -> Self {
        WatchPath::Assets(p.into())
    }
    fn resolve(&self, world: &World) -> PathBuf {
        match self {
            WatchPath::Data(p) => world.get_resource::<DataDir>().map_or_else(|| p.clone(), |d| d.0.join(p)),
            WatchPath::Assets(p) => world.get_resource::<AssetsDir>().map_or_else(|| p.clone(), |d| d.0.join(p)),
            WatchPath::Absolute(p) => p.clone(),
        }
    }
}

#[derive(Resource, Clone, Debug)]
pub struct HotReloadConfig {
    pub enabled: bool,
    /// Seconds (real time) between polls.
    pub interval_secs: f32,
}

impl Default for HotReloadConfig {
    fn default() -> Self {
        HotReloadConfig { enabled: cfg!(feature = "devtools"), interval_secs: 0.5 }
    }
}

/// Sent after every reload attempt.
#[derive(Message, Clone, Debug)]
pub struct Reloaded {
    pub path: PathBuf,
    /// `Ok(true)`: value changed and was applied; `Ok(false)`: same value.
    pub result: Result<bool, String>,
}

type ApplyFn = fn(&mut World, Value) -> Result<bool, String>;

struct Watch {
    at: WatchPath,
    path: Option<PathBuf>,
    pointer: Option<&'static str>,
    stamp: Option<(SystemTime, u64)>,
    seen: bool,
    apply: ApplyFn,
    type_name: &'static str,
    last: Option<Result<bool, String>>,
    reloads: u32,
}

/// The watch list.
#[derive(Resource, Default)]
pub struct HotReload {
    watches: Vec<Watch>,
    since: Duration,
}

impl HotReload {
    pub fn len(&self) -> usize {
        self.watches.len()
    }
    pub fn is_empty(&self) -> bool {
        self.watches.is_empty()
    }
}

pub trait HotReloadAppExt {
    /// Reload resource `T` from the JSON at `at` (or the part at JSON `pointer`, e.g. `"/core"`).
    /// `T` must already exist or have a `Default`: missing files leave it untouched.
    fn hot_reload_json<T: Resource + DeserializeOwned + PartialEq>(&mut self, at: WatchPath, pointer: Option<&'static str>) -> &mut Self;
}

impl HotReloadAppExt for App {
    fn hot_reload_json<T: Resource + DeserializeOwned + PartialEq>(&mut self, at: WatchPath, pointer: Option<&'static str>) -> &mut Self {
        self.world_mut().get_resource_or_init::<HotReload>().watches.push(Watch {
            at,
            path: None,
            pointer,
            stamp: None,
            seen: false,
            apply: apply::<T>,
            type_name: std::any::type_name::<T>(),
            last: None,
            reloads: 0,
        });
        self
    }
}

fn apply<T: Resource + DeserializeOwned + PartialEq>(world: &mut World, v: Value) -> Result<bool, String> {
    let new: T = serde_json::from_value(v).map_err(|e| e.to_string())?;
    if world.get_resource::<T>().is_some_and(|cur| *cur == new) {
        return Ok(false);
    }
    world.insert_resource(new);
    Ok(true)
}

pub(super) struct ReloadPlugin;

impl Plugin for ReloadPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<HotReload>()
            .init_resource::<HotReloadConfig>()
            .add_message::<Reloaded>()
            .add_systems(PreUpdate, poll.run_if(|h: Res<HotReload>, c: Res<HotReloadConfig>| c.enabled && !h.is_empty()));
        #[cfg(feature = "devtools")]
        {
            use crate::devtools::{AddControlCommand, params};
            app.add_control_command(
                "devkit.reload",
                "Hot-reloaded JSON files and their last result; force reloads now",
                params(&[("force", "boolean", "reload every watched file now")]),
                cmd_reload,
            );
        }
    }
}

fn stamp(path: &std::path::Path) -> Option<(SystemTime, u64)> {
    let m = std::fs::metadata(path).ok()?;
    Some((m.modified().ok()?, m.len()))
}

/// Polls every watch whose interval elapsed (all of them when `force`).
fn poll_watches(world: &mut World, force: bool) -> usize {
    let mut list = std::mem::take(&mut world.resource_mut::<HotReload>().watches);
    let mut changed = 0;
    for w in &mut list {
        let path = w.path.get_or_insert_with(|| w.at.resolve(world)).clone();
        let now = stamp(&path);
        // First poll loads the file if present (harmless if the game loaded it already: equal
        // values aren't applied); later polls load on any mtime/size change.
        let due = force || !w.seen || now != w.stamp;
        w.seen = true;
        if !due {
            continue;
        }
        w.stamp = now;
        if now.is_none() {
            continue; // missing (or deleted): keep the current value
        }
        let result = std::fs::read_to_string(&path)
            .map_err(|e| e.to_string())
            .and_then(|t| serde_json::from_str::<Value>(&t).map_err(|e| e.to_string()))
            .and_then(|v| match w.pointer {
                Some(p) => v.pointer(p).cloned().ok_or_else(|| format!("no `{p}` in the file")),
                None => Ok(v),
            })
            .and_then(|v| (w.apply)(world, v));
        match &result {
            Ok(true) => {
                info!("hot reload: {} ← {}", w.type_name, path.display());
                w.reloads += 1;
                changed += 1;
            }
            Ok(false) => {}
            Err(e) => warn!("hot reload {}: {e} (kept the old value)", path.display()),
        }
        w.last = Some(result.clone());
        world.write_message(Reloaded { path, result });
    }
    let mut h = world.resource_mut::<HotReload>();
    list.append(&mut h.watches); // watches added meanwhile
    h.watches = list;
    changed
}

fn poll(world: &mut World) {
    let dt = world.resource::<Time<Real>>().delta();
    let interval = Duration::from_secs_f32(world.resource::<HotReloadConfig>().interval_secs.max(0.0));
    let mut h = world.resource_mut::<HotReload>();
    h.since += dt;
    // A new watch is polled at once.
    let baseline = h.watches.iter().any(|w| !w.seen);
    if h.since < interval && !baseline {
        return;
    }
    h.since = Duration::ZERO;
    poll_watches(world, false);
}

/// Polls every watched file now (ignores the interval); returns how many resources changed.
pub fn reload_now(world: &mut World) -> usize {
    poll_watches(world, true)
}

#[cfg(feature = "devtools")]
fn cmd_reload(world: &mut World, p: Value) -> Result<Value, String> {
    use serde_json::json;
    let changed = if p.get("force").and_then(Value::as_bool) == Some(true) { Some(reload_now(world)) } else { None };
    let h = world.resource::<HotReload>();
    let watches: Vec<Value> = h
        .watches
        .iter()
        .map(|w| {
            json!({
                "type": w.type_name,
                "path": w.path.as_ref().map(|p| p.display().to_string()),
                "pointer": w.pointer,
                "reloads": w.reloads,
                "last": match &w.last { None => Value::Null, Some(Ok(c)) => json!({"ok": true, "changed": c}), Some(Err(e)) => json!({"ok": false, "error": e}) },
            })
        })
        .collect();
    Ok(json!({"enabled": world.resource::<HotReloadConfig>().enabled, "changed": changed, "watches": watches}))
}
