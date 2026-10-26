//! Save games: versioned JSON slots with metadata, migrations, backups, corruption recovery,
//! autosave and optional thumbnails. Plain JSON on purpose: diffable, greppable, editable by
//! an agent.
//!
//! Two layers:
//! - [`SaveStore`]: no ECS, just files. `write(slot, &data, meta)`, `read::<T>(slot)`, `list()`,
//!   `delete(slot)`. Usable from tools and unit tests.
//! - [`SavePlugin<T>`]: saves / loads resource `T` on [`SaveRequest`] messages, tracks
//!   [`Playtime`], autosaves, takes thumbnails, answers `save.*` control commands.
//!
//! ```ignore
//! #[derive(Resource, Serialize, Deserialize, Default)] #[serde(default)]
//! struct Progress { level: u32, coins: u32 }
//! app.add_plugins(SavePlugin::<Progress>::new(SaveConfig { version: 2, autosave_secs: Some(120.0), ..default() })
//!     // v1 stored `gold`; v2 calls it `coins`.
//!     .migration(1, |mut v| { v["coins"] = v["gold"].take(); Ok(v) }));
//! // anywhere: commands.write_message(SaveRequest::save("slot1"));
//! ```
//!
//! File `<DataDir>/<dir>/<slot>.save.json`:
//! `{"format":"engine-save","version":2,"checksum":"fnv1a64:…","meta":{…},"data":{…}}`.
//! Writes are atomic (temp file + rename) and keep the previous file as `<slot>.save.json.bak`.
//! A file that fails to parse or whose checksum doesn't match is moved to `….corrupt` and the
//! backup is restored (`recovered_from_backup` in the result).

use std::collections::BTreeMap;
use std::marker::PhantomData;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use bevy::prelude::*;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::paths::{DataDir, write_atomic};

const FORMAT: &str = "engine-save";
const EXT: &str = "save.json";

/// A migration from version `from` to `from + 1`, over the raw `data` JSON.
pub type Migration = Box<dyn Fn(Value) -> Result<Value, String> + Send + Sync>;

/// Slot metadata (shown in load menus, `save.list`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SaveMeta {
    pub slot: String,
    /// Free text for menus ("Chapter 2 — Docks").
    pub label: String,
    /// Unix seconds.
    pub saved_at: u64,
    pub playtime_secs: f64,
    pub game_version: String,
    /// Thumbnail file name next to the save (`<slot>.png`), if one was taken.
    pub thumbnail: Option<String>,
    pub extra: BTreeMap<String, Value>,
}

/// One slot as `list()` sees it.
#[derive(Clone, Debug, Serialize)]
pub struct SaveInfo {
    pub slot: String,
    pub path: PathBuf,
    pub version: u32,
    pub bytes: u64,
    pub meta: SaveMeta,
    /// `None` = readable; else why not (the slot may still load from its backup).
    pub error: Option<String>,
}

/// A successful load.
#[derive(Clone, Debug)]
pub struct Loaded<T> {
    pub data: T,
    pub meta: SaveMeta,
    /// Version stored in the file (before migrations).
    pub file_version: u32,
    pub recovered_from_backup: bool,
}

impl<T> Loaded<T> {
    pub fn migrated(&self, current: u32) -> bool {
        self.file_version != current
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum SaveError {
    BadSlot(String),
    NotFound(String),
    Io(String),
    /// Not a save file, bad JSON or checksum mismatch (and no usable backup).
    Corrupt(String),
    /// Written by a newer game version.
    FutureVersion { file: u32, current: u32 },
    /// No migration from this version, or the migration failed.
    Migration { from: u32, error: String },
    /// The (migrated) data doesn't fit the type.
    Decode(String),
}

impl std::fmt::Display for SaveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SaveError::BadSlot(s) => write!(f, "bad slot name `{s}` (1-64 chars of A-Z a-z 0-9 _ -)"),
            SaveError::NotFound(s) => write!(f, "no save in slot `{s}`"),
            SaveError::Io(e) => write!(f, "io: {e}"),
            SaveError::Corrupt(e) => write!(f, "corrupt save: {e}"),
            SaveError::FutureVersion { file, current } => write!(f, "save is version {file}, this game reads up to {current}"),
            SaveError::Migration { from, error } => write!(f, "migration from v{from}: {error}"),
            SaveError::Decode(e) => write!(f, "save data doesn't match: {e}"),
        }
    }
}

impl std::error::Error for SaveError {}

/// FNV-1a 64 over bytes (corruption check, not security).
fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

fn checksum(version: u32, data: &Value) -> String {
    let text = serde_json::to_string(data).unwrap_or_default();
    let mut bytes = version.to_le_bytes().to_vec();
    bytes.extend_from_slice(text.as_bytes());
    format!("fnv1a64:{:016x}", fnv1a64(&bytes))
}

fn valid_slot(slot: &str) -> Result<(), SaveError> {
    let ok = !slot.is_empty() && slot.len() <= 64 && slot.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if ok { Ok(()) } else { Err(SaveError::BadSlot(slot.into())) }
}

fn unix_now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

fn with_suffix(p: &Path, suffix: &str) -> PathBuf {
    let mut s = p.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}

/// The file layer (see the module docs).
pub struct SaveStore {
    pub dir: PathBuf,
    /// Current data version; files with lower versions are migrated on read.
    pub version: u32,
    /// Keep the previous file as `.bak` on every write (default true).
    pub keep_backup: bool,
    migrations: Vec<(u32, Migration)>,
}

impl SaveStore {
    pub fn new(dir: impl Into<PathBuf>, version: u32) -> Self {
        SaveStore { dir: dir.into(), version: version.max(1), keep_backup: true, migrations: Vec::new() }
    }

    /// Registers the migration `from` → `from + 1`.
    pub fn migration(mut self, from: u32, f: impl Fn(Value) -> Result<Value, String> + Send + Sync + 'static) -> Self {
        self.add_migration(from, Box::new(f));
        self
    }

    pub fn add_migration(&mut self, from: u32, f: Migration) {
        self.migrations.retain(|(v, _)| *v != from);
        self.migrations.push((from, f));
    }

    pub fn path(&self, slot: &str) -> PathBuf {
        self.dir.join(format!("{slot}.{EXT}"))
    }

    pub fn exists(&self, slot: &str) -> bool {
        self.path(slot).is_file() || with_suffix(&self.path(slot), ".bak").is_file()
    }

    /// Writes `data` to `slot` (atomically, previous file → `.bak`). `meta.slot` and
    /// `meta.saved_at` are filled in.
    pub fn write<T: Serialize>(&self, slot: &str, data: &T, mut meta: SaveMeta) -> Result<SaveInfo, SaveError> {
        valid_slot(slot)?;
        let data = serde_json::to_value(data).map_err(|e| SaveError::Decode(e.to_string()))?;
        meta.slot = slot.into();
        if meta.saved_at == 0 {
            meta.saved_at = unix_now();
        }
        let file = json!({
            "format": FORMAT,
            "version": self.version,
            "checksum": checksum(self.version, &data),
            "meta": meta,
            "data": data,
        });
        let text = serde_json::to_string_pretty(&file).map_err(|e| SaveError::Io(e.to_string()))?;
        let path = self.path(slot);
        std::fs::create_dir_all(&self.dir).map_err(|e| SaveError::Io(e.to_string()))?;
        // Only a readable file becomes the backup: never replace a good backup with junk.
        if self.keep_backup && read_file(&path).is_ok() {
            let _ = std::fs::rename(&path, with_suffix(&path, ".bak"));
        }
        write_atomic(&path, &text).map_err(|e| SaveError::Io(e.to_string()))?;
        Ok(SaveInfo { slot: slot.into(), path, version: self.version, bytes: text.len() as u64, meta, error: None })
    }

    /// The slot's data JSON, migrated to the current version.
    pub fn read_value(&self, slot: &str) -> Result<Loaded<Value>, SaveError> {
        valid_slot(slot)?;
        let path = self.path(slot);
        let bak = with_suffix(&path, ".bak");
        let (version, meta, data, recovered) = match read_file(&path) {
            Ok((v, m, d)) => (v, m, d, false),
            Err(main_err) => {
                let main_missing = matches!(main_err, SaveError::NotFound(_));
                match read_file(&bak) {
                    Ok((v, m, d)) => {
                        if !main_missing {
                            warn!("save {}: {main_err}; restored the backup", path.display());
                            let _ = std::fs::rename(&path, with_suffix(&path, ".corrupt"));
                        }
                        let _ = std::fs::copy(&bak, &path);
                        (v, m, d, true)
                    }
                    Err(_) if main_missing => return Err(SaveError::NotFound(slot.into())),
                    Err(_) => {
                        // Keep the bad file for inspection; the slot reads as missing next time.
                        let _ = std::fs::rename(&path, with_suffix(&path, ".corrupt"));
                        return Err(main_err);
                    }
                }
            }
        };
        let data = self.migrate(version, data)?;
        Ok(Loaded { data, meta, file_version: version, recovered_from_backup: recovered })
    }

    /// [`SaveStore::read_value`] decoded as `T`.
    pub fn read<T: DeserializeOwned>(&self, slot: &str) -> Result<Loaded<T>, SaveError> {
        let l = self.read_value(slot)?;
        let data = serde_json::from_value(l.data).map_err(|e| SaveError::Decode(e.to_string()))?;
        Ok(Loaded { data, meta: l.meta, file_version: l.file_version, recovered_from_backup: l.recovered_from_backup })
    }

    /// Runs the migration chain `version` → `self.version`.
    pub fn migrate(&self, mut version: u32, mut data: Value) -> Result<Value, SaveError> {
        if version > self.version {
            return Err(SaveError::FutureVersion { file: version, current: self.version });
        }
        while version < self.version {
            let (_, f) = self
                .migrations
                .iter()
                .find(|(from, _)| *from == version)
                .ok_or_else(|| SaveError::Migration { from: version, error: format!("no migration v{version} → v{}", version + 1) })?;
            data = f(data).map_err(|error| SaveError::Migration { from: version, error })?;
            version += 1;
        }
        Ok(data)
    }

    /// Every slot in the folder, newest first.
    pub fn list(&self) -> Vec<SaveInfo> {
        let Ok(rd) = std::fs::read_dir(&self.dir) else { return Vec::new() };
        let mut out: Vec<SaveInfo> = rd
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                let slot = name.strip_suffix(&format!(".{EXT}"))?.to_string();
                let path = e.path();
                let bytes = e.metadata().map_or(0, |m| m.len());
                Some(match read_file(&path) {
                    Ok((version, meta, _)) => SaveInfo { slot, path, version, bytes, meta, error: None },
                    Err(err) => SaveInfo { slot, path, version: 0, bytes, meta: SaveMeta::default(), error: Some(err.to_string()) },
                })
            })
            .collect();
        out.sort_by(|a, b| b.meta.saved_at.cmp(&a.meta.saved_at).then_with(|| a.slot.cmp(&b.slot)));
        out
    }

    /// Removes the slot, its backup and thumbnail.
    pub fn delete(&self, slot: &str) -> Result<(), SaveError> {
        valid_slot(slot)?;
        let path = self.path(slot);
        if !self.exists(slot) {
            return Err(SaveError::NotFound(slot.into()));
        }
        for p in [path.clone(), with_suffix(&path, ".bak"), self.dir.join(format!("{slot}.png"))] {
            let _ = std::fs::remove_file(p);
        }
        Ok(())
    }
}

/// `(version, meta, data)` of a save file, checksum verified.
fn read_file(path: &Path) -> Result<(u32, SaveMeta, Value), SaveError> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(SaveError::NotFound(path.display().to_string())),
        Err(e) => return Err(SaveError::Io(e.to_string())),
    };
    let mut v: Value = serde_json::from_str(&text).map_err(|e| SaveError::Corrupt(e.to_string()))?;
    if v.get("format").and_then(Value::as_str) != Some(FORMAT) {
        return Err(SaveError::Corrupt("not an engine save file".into()));
    }
    let version = v.get("version").and_then(Value::as_u64).ok_or_else(|| SaveError::Corrupt("no version".into()))? as u32;
    let data = v.get_mut("data").map(Value::take).ok_or_else(|| SaveError::Corrupt("no data".into()))?;
    let want = v.get("checksum").and_then(Value::as_str).unwrap_or_default();
    if want != checksum(version, &data) {
        return Err(SaveError::Corrupt("checksum mismatch".into()));
    }
    let meta = v.get_mut("meta").map(Value::take).and_then(|m| serde_json::from_value(m).ok()).unwrap_or_default();
    Ok((version, meta, data))
}

// ---- ECS layer ----

/// Plugin config. Build with `..default()`.
#[derive(Clone, Debug)]
pub struct SaveConfig {
    /// Folder under [`DataDir`].
    pub dir: String,
    /// Current data version (bump it when `T` changes shape; add a migration).
    pub version: u32,
    /// Autosave every this many seconds of play time (`None` = off).
    pub autosave_secs: Option<f32>,
    pub autosave_slot: String,
    /// Take a 320×180 PNG thumbnail on save (windowed / `--offscreen` runs only).
    pub thumbnails: bool,
    pub keep_backup: bool,
}

impl Default for SaveConfig {
    fn default() -> Self {
        SaveConfig { dir: "saves".into(), version: 1, autosave_secs: None, autosave_slot: "autosave".into(), thumbnails: true, keep_backup: true }
    }
}

/// Ask the save plugin to act. Handled in `Update`.
#[derive(Message, Clone, Debug, PartialEq)]
pub enum SaveRequest {
    Save { slot: String, label: String },
    Load { slot: String },
    Delete { slot: String },
}

impl SaveRequest {
    pub fn save(slot: impl Into<String>) -> Self {
        SaveRequest::Save { slot: slot.into(), label: String::new() }
    }
    pub fn load(slot: impl Into<String>) -> Self {
        SaveRequest::Load { slot: slot.into() }
    }
}

/// What happened to a [`SaveRequest`].
#[derive(Message, Clone, Debug, PartialEq)]
pub enum SaveEvent {
    Saved { slot: String, path: PathBuf },
    Loaded { slot: String, file_version: u32, recovered_from_backup: bool },
    Deleted { slot: String },
    Failed { slot: String, error: String },
}

/// Seconds of unpaused in-game time (virtual time while `AppState::InGame`). Saved in every
/// slot's meta and restored on load.
#[derive(Resource, Clone, Copy, Debug, Default, PartialEq)]
pub struct Playtime(pub f64);

/// The store the plugin uses (also reachable by game code: `Res<SaveSlots>.0.list()`).
#[derive(Resource)]
pub struct SaveSlots(pub SaveStore);

#[derive(Resource, Clone)]
struct SaveSettings {
    config: SaveConfig,
    last_autosave: f64,
}

/// Saves / loads resource `T` (see the module docs). One per app.
pub struct SavePlugin<T> {
    config: SaveConfig,
    migrations: Mutex<Vec<(u32, Migration)>>,
    _t: PhantomData<fn() -> T>,
}

impl<T> SavePlugin<T> {
    pub fn new(config: SaveConfig) -> Self {
        SavePlugin { config, migrations: Mutex::new(Vec::new()), _t: PhantomData }
    }
    /// Migration `from` → `from + 1` over the raw data JSON.
    pub fn migration(self, from: u32, f: impl Fn(Value) -> Result<Value, String> + Send + Sync + 'static) -> Self {
        if let Ok(mut m) = self.migrations.lock() {
            m.push((from, Box::new(f)));
        }
        self
    }
}

impl<T: Resource + Serialize + DeserializeOwned> Plugin for SavePlugin<T> {
    fn build(&self, app: &mut App) {
        let data = app.world().get_resource::<DataDir>().map(|d| d.0.clone()).unwrap_or_else(|| PathBuf::from("."));
        let mut store = SaveStore::new(data.join(&self.config.dir), self.config.version);
        store.keep_backup = self.config.keep_backup;
        if let Ok(mut m) = self.migrations.lock() {
            for (from, f) in m.drain(..) {
                store.add_migration(from, f);
            }
        }
        app.insert_resource(SaveSlots(store))
            .insert_resource(SaveSettings { config: self.config.clone(), last_autosave: 0.0 })
            .init_resource::<Playtime>()
            .add_message::<SaveRequest>()
            .add_message::<SaveEvent>()
            .add_systems(Update, (track_playtime, autosave, handle_requests::<T>).chain());
        #[cfg(feature = "devtools")]
        register_commands(app);
    }
}

fn track_playtime(time: Res<Time<Virtual>>, state: Option<Res<State<crate::flow::AppState>>>, mut play: ResMut<Playtime>) {
    if state.is_none_or(|s| *s.get() == crate::flow::AppState::InGame) {
        play.0 += time.delta_secs_f64();
    }
}

fn autosave(play: Res<Playtime>, mut settings: ResMut<SaveSettings>, mut out: MessageWriter<SaveRequest>) {
    let Some(every) = settings.config.autosave_secs else { return };
    if play.0 - settings.last_autosave >= f64::from(every.max(1.0)) {
        settings.last_autosave = play.0;
        out.write(SaveRequest::Save { slot: settings.config.autosave_slot.clone(), label: "Autosave".into() });
    }
}

fn handle_requests<T: Resource + Serialize + DeserializeOwned>(world: &mut World) {
    let reqs: Vec<SaveRequest> = world.resource_mut::<Messages<SaveRequest>>().drain().collect();
    for req in reqs {
        let ev = match req {
            SaveRequest::Save { slot, label } => save_now::<T>(world, &slot, label),
            SaveRequest::Load { slot } => load_now::<T>(world, &slot),
            SaveRequest::Delete { slot } => match world.resource::<SaveSlots>().0.delete(&slot) {
                Ok(()) => SaveEvent::Deleted { slot },
                Err(e) => SaveEvent::Failed { slot, error: e.to_string() },
            },
        };
        match &ev {
            SaveEvent::Failed { slot, error } => warn!("save `{slot}`: {error}"),
            other => debug!("save: {other:?}"),
        }
        world.write_message(ev);
    }
}

fn save_now<T: Resource + Serialize>(world: &mut World, slot: &str, label: String) -> SaveEvent {
    let Some(data) = world.get_resource::<T>() else {
        return SaveEvent::Failed { slot: slot.into(), error: format!("no resource {}", std::any::type_name::<T>()) };
    };
    let thumbs = world.resource::<SaveSettings>().config.thumbnails && can_screenshot(world);
    let meta = SaveMeta {
        label,
        playtime_secs: world.resource::<Playtime>().0,
        game_version: world.get_resource::<crate::app::GameInfo>().map(|g| g.version.to_string()).unwrap_or_default(),
        thumbnail: thumbs.then(|| format!("{slot}.png")),
        ..default()
    };
    let store = &world.resource::<SaveSlots>().0;
    match store.write(slot, data, meta) {
        Ok(info) => {
            if thumbs {
                let png = store.dir.join(format!("{slot}.png"));
                thumbnail(world, png);
            }
            SaveEvent::Saved { slot: slot.into(), path: info.path }
        }
        Err(e) => SaveEvent::Failed { slot: slot.into(), error: e.to_string() },
    }
}

fn load_now<T: Resource + DeserializeOwned>(world: &mut World, slot: &str) -> SaveEvent {
    match world.resource::<SaveSlots>().0.read::<T>(slot) {
        Ok(l) => {
            world.insert_resource(l.data);
            world.resource_mut::<Playtime>().0 = l.meta.playtime_secs;
            world.resource_mut::<SaveSettings>().last_autosave = l.meta.playtime_secs;
            SaveEvent::Loaded { slot: slot.into(), file_version: l.file_version, recovered_from_backup: l.recovered_from_backup }
        }
        Err(e) => SaveEvent::Failed { slot: slot.into(), error: e.to_string() },
    }
}

fn can_screenshot(world: &World) -> bool {
    !world.get_resource::<crate::flow::Headless>().is_some_and(|h| h.0) && world.contains_resource::<Assets<Image>>()
}

/// 320×180 PNG of the next rendered frame (offscreen image under `--offscreen`).
fn thumbnail(world: &mut World, path: PathBuf) {
    use bevy::render::view::window::screenshot::{Screenshot, ScreenshotCaptured};
    #[cfg(feature = "devtools")]
    let shot = match world.get_resource::<crate::devtools::offscreen::OffscreenTarget>() {
        Some(t) => Screenshot::image(t.0.clone()),
        None => Screenshot::primary_window(),
    };
    #[cfg(not(feature = "devtools"))]
    let shot = Screenshot::primary_window();
    world.spawn(shot).observe(move |cap: On<ScreenshotCaptured>| {
        let Ok(img) = cap.image.clone().try_into_dynamic() else { return };
        let path = path.clone();
        // Resize + encode off the main thread.
        std::thread::spawn(move || {
            let small = image::imageops::thumbnail(&img.to_rgb8(), 320, 180);
            if let Err(e) = small.save_with_format(&path, image::ImageFormat::Png) {
                warn!("save thumbnail {}: {e}", path.display());
            }
        });
    });
}

#[cfg(feature = "devtools")]
fn register_commands(app: &mut App) {
    use crate::devtools::{AddControlCommand, params};
    app.add_control_command("save.list", "Save slots (newest first) with metadata", params(&[]), |w, _| {
        let slots = w.resource::<SaveSlots>().0.list();
        Ok(json!({"dir": w.resource::<SaveSlots>().0.dir, "version": w.resource::<SaveSlots>().0.version, "slots": slots, "playtime_secs": w.resource::<Playtime>().0}))
    })
    .add_control_command(
        "save.write",
        "Save the game to a slot (done this frame's Update; see save.list)",
        params(&[("slot", "string", "slot name (A-Z a-z 0-9 _ -)"), ("label", "string", "menu label")]),
        |w, p| {
            let slot = p.get("slot").and_then(Value::as_str).ok_or("`slot` is required")?.to_string();
            valid_slot(&slot).map_err(|e| e.to_string())?;
            let label = p.get("label").and_then(Value::as_str).unwrap_or_default().to_string();
            w.write_message(SaveRequest::Save { slot: slot.clone(), label });
            Ok(json!({"queued": slot}))
        },
    )
    .add_control_command("save.load", "Load a slot (this frame's Update)", params(&[("slot", "string", "slot name")]), |w, p| {
        let slot = p.get("slot").and_then(Value::as_str).ok_or("`slot` is required")?.to_string();
        if !w.resource::<SaveSlots>().0.exists(&slot) {
            return Err(SaveError::NotFound(slot).to_string());
        }
        w.write_message(SaveRequest::Load { slot: slot.clone() });
        Ok(json!({"queued": slot}))
    })
    .add_control_command("save.delete", "Delete a slot", params(&[("slot", "string", "slot name")]), |w, p| {
        let slot = p.get("slot").and_then(Value::as_str).ok_or("`slot` is required")?;
        w.resource::<SaveSlots>().0.delete(slot).map_err(|e| e.to_string())?;
        Ok(json!({"deleted": slot}))
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Serialize, Deserialize, Debug, PartialEq, Default)]
    #[serde(default)]
    struct V3 {
        level: u32,
        coins: u32,
        name: String,
    }

    fn tmp(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("engine-save-unit-{tag}-{}-{}", std::process::id(), rand::random::<u32>()))
    }

    #[test]
    fn write_read_list_delete() {
        let dir = tmp("basic");
        let s = SaveStore::new(&dir, 3);
        let d = V3 { level: 2, coins: 5, name: "a".into() };
        s.write("slot1", &d, SaveMeta { label: "L".into(), playtime_secs: 12.5, ..default() }).unwrap();
        let l = s.read::<V3>("slot1").unwrap();
        assert_eq!(l.data, d);
        assert_eq!(l.meta.label, "L");
        assert_eq!(l.meta.slot, "slot1");
        assert!(!l.recovered_from_backup);
        assert_eq!(s.list().len(), 1);
        assert!(matches!(s.read::<V3>("nope"), Err(SaveError::NotFound(_))));
        assert!(matches!(s.write("../x", &d, default()), Err(SaveError::BadSlot(_))));
        s.delete("slot1").unwrap();
        assert!(s.list().is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn migrations_chain_and_future_versions() {
        let dir = tmp("mig");
        // A v1 file: {lvl, gold}.
        SaveStore::new(&dir, 1).write("s", &json!({"lvl": 4, "gold": 9}), default()).unwrap();
        let s = SaveStore::new(&dir, 3)
            .migration(1, |mut v| {
                v["level"] = v["lvl"].take();
                Ok(v)
            })
            .migration(2, |mut v| {
                v["coins"] = v["gold"].take();
                v["name"] = json!("migrated");
                Ok(v)
            });
        let l = s.read::<V3>("s").unwrap();
        assert_eq!(l.data, V3 { level: 4, coins: 9, name: "migrated".into() });
        assert_eq!(l.file_version, 1);
        assert!(l.migrated(3));
        // Missing link in the chain.
        let gap = SaveStore::new(&dir, 3).migration(1, Ok);
        assert!(matches!(gap.read_value("s"), Err(SaveError::Migration { from: 2, .. })));
        // Newer file than the game.
        SaveStore::new(&dir, 9).write("new", &json!({}), default()).unwrap();
        assert_eq!(s.read_value("new").err(), Some(SaveError::FutureVersion { file: 9, current: 3 }));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn corrupt_file_recovers_from_backup() {
        let dir = tmp("corrupt");
        let s = SaveStore::new(&dir, 1);
        s.write("s", &json!({"n": 1}), default()).unwrap();
        s.write("s", &json!({"n": 2}), default()).unwrap();
        // Flip a byte in the data: checksum catches it.
        let p = s.path("s");
        let text = std::fs::read_to_string(&p).unwrap().replace("\"n\": 2", "\"n\": 3");
        std::fs::write(&p, text).unwrap();
        let l = s.read_value("s").unwrap();
        assert!(l.recovered_from_backup);
        assert_eq!(l.data, json!({"n": 1}), "backup = previous good save");
        assert!(with_suffix(&p, ".corrupt").is_file(), "bad file kept aside");
        // Restored: the next read is clean.
        assert!(!s.read_value("s").unwrap().recovered_from_backup);
        // Truncated file and no backup: Corrupt.
        let s2 = SaveStore { keep_backup: false, ..SaveStore::new(dir.join("b"), 1) };
        s2.write("t", &json!({"n": 1}), default()).unwrap();
        std::fs::write(s2.path("t"), "{\"format\":\"engine-save\",").unwrap();
        assert!(matches!(s2.read_value("t"), Err(SaveError::Corrupt(_))));
        let _ = std::fs::remove_dir_all(dir);
    }
}
