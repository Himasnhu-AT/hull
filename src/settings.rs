//! Persisted settings + the field registry the settings screen is generated from.
//! Owner: core stream (store, persistence, core fields, applying window/vsync).
//!
//! - [`CoreSettings`]: what every game has (controls, video, audio, HUD basics). Always loaded:
//!   `EnginePlugin` adds [`CoreSettingsPlugin`], so a game without its own settings needs nothing.
//! - A game's own struct implements [`GameSettings`] (blanket impl: `Resource + Serialize +
//!   DeserializeOwned + Default + Clone + PartialEq`; put `#[serde(default)]` on it) and is added
//!   with `app.add_plugins(SettingsPlugin::<MySettings>::default())` after `engine::app(..)`.
//!   Both live in `<data>/settings.json` as `{ "core": {...}, "game": {...} }`;
//!   unknown/missing fields fall back to defaults, a corrupt file to defaults (renamed to
//!   `settings.json.corrupt`, never a crash). A flat legacy file (no `core`/`game` keys) is read
//!   as both sections, so pre-engine settings survive. Saved ~0.6 s (real time) after the last
//!   change, on [`SaveSettings`] and on app exit.
//! - Settings rows: [`FieldDef`]s grouped by tab, registered with [`RegisterSettings`]. The engine
//!   registers its core fields on tabs "Controls", "Video", "Audio"; games add rows/tabs (e.g.
//!   "Gameplay": difficulty). Tab order = first registration order, engine tabs first unless a
//!   game calls `set_settings_tabs`.
//! - Applied here: window mode (never in [`crate::cli::test_driven`] runs) and vsync. FOV and
//!   quality: `gfx`; volumes: `audio`; sensitivity/invert: `input`; UI scale + show FPS: ui stream.

use std::path::{Path, PathBuf};

use bevy::prelude::*;
use bevy::window::{MonitorSelection, PresentMode, PrimaryWindow, VideoModeSelection, WindowMode};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Map, Value};

use crate::flow::has_visuals;
use crate::paths::DataDir;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum GraphicsQuality {
    Low,
    Medium,
    #[default]
    High,
    Ultra,
}

impl GraphicsQuality {
    pub const ALL: [GraphicsQuality; 4] = [Self::Low, Self::Medium, Self::High, Self::Ultra];
    /// 0 = Low … 3 = Ultra (index into [`crate::gfx::QualityPreset`] arrays).
    pub fn index(self) -> usize {
        self as usize
    }
    pub fn from_index(i: usize) -> Self {
        Self::ALL[i.min(3)]
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum WindowModeSetting {
    #[default]
    Windowed,
    Borderless,
    Fullscreen,
}

impl WindowModeSetting {
    pub const ALL: [WindowModeSetting; 3] = [Self::Windowed, Self::Borderless, Self::Fullscreen];
    pub fn index(self) -> usize {
        self as usize
    }
    pub fn from_index(i: usize) -> Self {
        Self::ALL[i.min(2)]
    }
}

#[derive(Resource, Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct CoreSettings {
    // Controls
    pub sensitivity: f32,
    pub invert_y: bool,
    // Video
    pub fov_deg: f32,
    pub quality: GraphicsQuality,
    pub window_mode: WindowModeSetting,
    pub vsync: bool,
    pub show_fps: bool,
    /// UI scale multiplier on top of the automatic height-based scale.
    pub ui_scale: f32,
    // Audio (0..1)
    pub master_volume: f32,
    pub sfx_volume: f32,
    pub music_volume: f32,
    pub ambience_volume: f32,
    pub ui_volume: f32,
}

impl Default for CoreSettings {
    fn default() -> Self {
        CoreSettings {
            sensitivity: 1.0,
            invert_y: false,
            fov_deg: 80.0,
            quality: GraphicsQuality::default(),
            window_mode: WindowModeSetting::default(),
            vsync: true,
            show_fps: false,
            ui_scale: 1.0,
            master_volume: 0.8,
            sfx_volume: 1.0,
            music_volume: 0.7,
            ambience_volume: 0.6,
            ui_volume: 0.8,
        }
    }
}

/// A game's own persisted settings (difficulty, crosshair, …).
pub trait GameSettings: Resource + Serialize + DeserializeOwned + Default + Clone + PartialEq {}
impl<T: Resource + Serialize + DeserializeOwned + Default + Clone + PartialEq> GameSettings for T {}

/// Adds a game's own settings `G` (section `"game"` of settings.json): loads it at build time,
/// saves it with the core settings when it changes. Add after `engine::app(..)` /
/// `EnginePlugin`. Core settings are handled by `EnginePlugin` whether or not this is added.
pub struct SettingsPlugin<G: GameSettings = NoGameSettings>(std::marker::PhantomData<G>);

impl<G: GameSettings> Default for SettingsPlugin<G> {
    fn default() -> Self {
        SettingsPlugin(std::marker::PhantomData)
    }
}

impl<G: GameSettings> Plugin for SettingsPlugin<G> {
    fn build(&self, app: &mut App) {
        let mut store = store_mut(app);
        let game: G = store.decode(GAME);
        store.sections.retain(|(k, _)| *k != GAME);
        store.sections.push((GAME, serialize_resource::<G>));
        app.insert_resource(game).add_systems(PostUpdate, mark_dirty::<G>.in_set(SettingsSet::Track));
    }
}

/// Placeholder for games without their own settings.
#[derive(Resource, Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct NoGameSettings;

/// Ask for a save now (debounce still applies). Widgets send it after edits.
#[derive(Message, Clone, Copy, Debug, Default)]
pub struct SaveSettings;

/// How a row edits its value. Values travel as `f32` (bools 0/1, choices as index).
#[derive(Clone, Debug)]
pub enum FieldKind {
    Toggle,
    Slider { min: f32, max: f32, step: f32, format: fn(f32) -> String },
    /// Segmented control.
    Choice { options: Vec<&'static str> },
    /// Big cards with a title + blurb (difficulty, map, mode pickers).
    Cards { options: Vec<(&'static str, &'static str)> },
    /// Colour swatches (sRGB).
    Swatches { colors: Vec<[f32; 3]> },
}

/// One settings row.
#[derive(Clone, Debug)]
pub struct FieldDef {
    /// Stable id, used by the control port (`ui.setting {key, value}`) and tests.
    pub key: &'static str,
    pub tab: &'static str,
    pub label: &'static str,
    pub hint: &'static str,
    pub kind: FieldKind,
    pub get: fn(&World) -> f32,
    pub set: fn(&mut World, f32),
}

/// All registered rows, in registration order.
#[derive(Resource, Clone, Debug, Default)]
pub struct SettingsRegistry {
    pub tabs: Vec<&'static str>,
    pub fields: Vec<FieldDef>,
}

impl SettingsRegistry {
    pub fn tab_fields(&self, tab: &str) -> impl Iterator<Item = &FieldDef> {
        self.fields.iter().filter(move |f| f.tab == tab)
    }
    pub fn field(&self, key: &str) -> Option<&FieldDef> {
        self.fields.iter().find(|f| f.key == key)
    }
}

pub trait RegisterSettings {
    fn register_setting(&mut self, field: FieldDef) -> &mut Self;
    /// Replace the tab order (unknown tabs are appended).
    fn set_settings_tabs(&mut self, tabs: &[&'static str]) -> &mut Self;
}

impl RegisterSettings for App {
    fn register_setting(&mut self, field: FieldDef) -> &mut Self {
        let mut reg = self.world_mut().get_resource_or_insert_with(SettingsRegistry::default);
        if !reg.tabs.contains(&field.tab) {
            reg.tabs.push(field.tab);
        }
        reg.fields.retain(|f| f.key != field.key);
        reg.fields.push(field);
        self
    }
    fn set_settings_tabs(&mut self, tabs: &[&'static str]) -> &mut Self {
        let mut reg = self.world_mut().get_resource_or_insert_with(SettingsRegistry::default);
        let mut order: Vec<&'static str> = tabs.to_vec();
        for t in reg.tabs.clone() {
            if !order.contains(&t) {
                order.push(t);
            }
        }
        reg.tabs = order;
        self
    }
}

// ---------------------------------------------------------------- persistence

const CORE: &str = "core";
const GAME: &str = "game";
/// Seconds of real time between the last change and the write.
pub const SAVE_DEBOUNCE_SECS: f32 = 0.6;

type SectionFn = fn(&World) -> Option<Value>;

/// The settings file: its path, the JSON it was loaded from (sections nobody claims are kept
/// on save) and the pending-save timer.
#[derive(Resource, Debug)]
pub struct SettingsStore {
    pub path: PathBuf,
    root: Map<String, Value>,
    /// File was a flat (pre-engine) object: every section decodes from the root.
    legacy: bool,
    sections: Vec<(&'static str, SectionFn)>,
    /// Real seconds until the next save; `None` = nothing to save.
    pending: Option<f32>,
}

impl SettingsStore {
    /// Read `path`. Missing → empty; unreadable/corrupt → empty + warning, and the bad file is
    /// moved aside to `<name>.corrupt` so the next save doesn't silently destroy it.
    pub fn load(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let mut store = SettingsStore { path, root: Map::new(), legacy: false, sections: Vec::new(), pending: None };
        let text = match std::fs::read_to_string(&store.path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return store,
            Err(e) => {
                warn!("settings: could not read {}: {e}; using defaults", store.path.display());
                return store;
            }
        };
        match serde_json::from_str::<Value>(&text) {
            Ok(Value::Object(root)) => {
                store.legacy = !root.contains_key(CORE) && !root.contains_key(GAME);
                store.root = root;
            }
            Ok(_) | Err(_) => {
                let aside = store.path.with_extension("json.corrupt");
                warn!("settings: {} is corrupt; using defaults (moved to {})", store.path.display(), aside.display());
                let _ = std::fs::rename(&store.path, aside);
            }
        }
        store
    }

    /// Decode section `key` (or the whole legacy file). Bad section → defaults + warning.
    pub fn decode<T: DeserializeOwned + Default>(&self, key: &str) -> T {
        let v = if self.legacy { Some(Value::Object(self.root.clone())) } else { self.root.get(key).cloned() };
        match v {
            None | Some(Value::Null) => T::default(),
            Some(v) => serde_json::from_value(v).unwrap_or_else(|e| {
                warn!("settings: section '{key}' invalid ({e}); using defaults");
                T::default()
            }),
        }
    }

    /// Schedule a save [`SAVE_DEBOUNCE_SECS`] from now.
    pub fn mark_dirty(&mut self) {
        self.pending = Some(SAVE_DEBOUNCE_SECS);
    }

    pub fn is_dirty(&self) -> bool {
        self.pending.is_some()
    }

    /// The JSON that would be written now.
    pub fn to_json(&self, world: &World) -> Value {
        let mut root = if self.legacy { Map::new() } else { self.root.clone() };
        for (key, ser) in &self.sections {
            match ser(world) {
                Some(Value::Null) | None => {
                    root.remove(*key);
                }
                Some(v) => {
                    root.insert((*key).to_string(), v);
                }
            }
        }
        Value::Object(root)
    }

    /// Write now (atomically: temp file + rename). Clears the pending timer.
    pub fn save(&mut self, world: &World) -> std::io::Result<()> {
        self.pending = None;
        let json = self.to_json(world);
        let text = serde_json::to_string_pretty(&json).map_err(std::io::Error::other)?;
        write_atomic(&self.path, &text)?;
        if let Value::Object(root) = json {
            self.root = root;
            self.legacy = false;
        }
        Ok(())
    }
}

fn write_atomic(path: &Path, text: &str) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)
}

fn serialize_resource<T: Resource + Serialize>(w: &World) -> Option<Value> {
    w.get_resource::<T>().and_then(|r| serde_json::to_value(r).ok())
}

/// The store, created from `DataDir` (or the platform data dir) on first use.
fn store_mut(app: &mut App) -> Mut<'_, SettingsStore> {
    if !app.world().contains_resource::<SettingsStore>() {
        let dir = match app.world().get_resource::<DataDir>() {
            Some(d) => d.0.clone(),
            None => {
                let info = app.world().get_resource::<crate::GameInfo>().cloned().unwrap_or_else(|| crate::GameInfo::new("game", "Game"));
                crate::paths::data_dir(&info)
            }
        };
        app.insert_resource(SettingsStore::load(dir.join("settings.json")));
    }
    app.world_mut().resource_mut::<SettingsStore>()
}

#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
pub enum SettingsSet {
    /// PostUpdate: notice changed settings resources.
    Track,
}

fn mark_dirty<T: Resource>(res: Res<T>, mut store: ResMut<SettingsStore>) {
    if res.is_changed() && !res.is_added() {
        store.mark_dirty();
    }
}

fn on_save_request(mut msgs: MessageReader<SaveSettings>, mut store: ResMut<SettingsStore>) {
    if msgs.read().count() > 0 {
        store.mark_dirty();
    }
}

/// Last: count down the debounce in real time; write when due, or immediately on `AppExit`.
fn save_when_due(world: &mut World, mut exit_cursor: Local<bevy::ecs::message::MessageCursor<AppExit>>) {
    let exiting = exit_cursor.read(world.resource::<Messages<AppExit>>()).count() > 0;
    let dt = world.resource::<Time<Real>>().delta_secs();
    let due = {
        let mut store = world.resource_mut::<SettingsStore>();
        match store.pending.as_mut() {
            Some(t) => {
                *t -= dt;
                *t <= 0.0 || exiting
            }
            None => false,
        }
    };
    if !due {
        return;
    }
    world.resource_scope(|world, mut store: Mut<SettingsStore>| {
        if let Err(e) = store.save(world) {
            warn!("settings: could not save {}: {e}", store.path.display());
        }
    });
}

/// Loads [`CoreSettings`], registers the core rows, saves, and applies window mode / vsync.
/// Added by `EnginePlugin`; games don't add it.
pub struct CoreSettingsPlugin;

impl Plugin for CoreSettingsPlugin {
    fn build(&self, app: &mut App) {
        let mut store = store_mut(app);
        let core: CoreSettings = store.decode(CORE);
        store.sections.retain(|(k, _)| *k != CORE);
        store.sections.insert(0, (CORE, serialize_resource::<CoreSettings>));
        app.insert_resource(core)
            .add_message::<SaveSettings>()
            .init_resource::<SettingsRegistry>()
            .add_systems(PostUpdate, (mark_dirty::<CoreSettings>, on_save_request).in_set(SettingsSet::Track))
            .add_systems(Last, save_when_due.after(crate::flow::quit_after))
            .add_systems(Update, apply_window.run_if(has_visuals));
        register_core_fields(app);
    }
}

fn apply_window(settings: Res<CoreSettings>, mut windows: Query<&mut Window, With<PrimaryWindow>>) {
    if !settings.is_changed() {
        return;
    }
    let test_run = crate::cli::test_driven();
    for mut w in &mut windows {
        let present = if settings.vsync { PresentMode::AutoVsync } else { PresentMode::AutoNoVsync };
        if w.present_mode != present {
            w.present_mode = present;
        }
        if test_run {
            continue;
        }
        let mode = match settings.window_mode {
            WindowModeSetting::Windowed => WindowMode::Windowed,
            WindowModeSetting::Borderless => WindowMode::BorderlessFullscreen(MonitorSelection::Current),
            WindowModeSetting::Fullscreen => WindowMode::Fullscreen(MonitorSelection::Current, VideoModeSelection::Current),
        };
        if w.mode != mode {
            w.mode = mode;
        }
    }
}

// ---------------------------------------------------------------- core rows

pub fn format_percent(v: f32) -> String {
    format!("{:.0}%", v * 100.0)
}
pub fn format_multiplier(v: f32) -> String {
    format!("{v:.2}\u{d7}")
}
pub fn format_degrees(v: f32) -> String {
    format!("{v:.0}\u{b0}")
}

fn core(w: &World) -> &CoreSettings {
    w.resource::<CoreSettings>()
}
fn core_mut(w: &mut World) -> Mut<'_, CoreSettings> {
    w.resource_mut::<CoreSettings>()
}

fn volume_slider(key: &'static str, label: &'static str, hint: &'static str, get: fn(&World) -> f32, set: fn(&mut World, f32)) -> FieldDef {
    FieldDef {
        key,
        tab: "Audio",
        label,
        hint,
        kind: FieldKind::Slider { min: 0.0, max: 1.0, step: 0.05, format: format_percent },
        get,
        set,
    }
}

fn register_core_fields(app: &mut App) {
    app.register_setting(FieldDef {
        key: "sensitivity",
        tab: "Controls",
        label: "Mouse sensitivity",
        hint: "How far the view turns per mouse movement.",
        kind: FieldKind::Slider { min: 0.1, max: 3.0, step: 0.05, format: format_multiplier },
        get: |w| core(w).sensitivity,
        set: |w, v| core_mut(w).sensitivity = v.clamp(0.1, 3.0),
    })
    .register_setting(FieldDef {
        key: "invert_y",
        tab: "Controls",
        label: "Invert Y",
        hint: "Moving the mouse forward looks down.",
        kind: FieldKind::Toggle,
        get: |w| core(w).invert_y as u8 as f32,
        set: |w, v| core_mut(w).invert_y = v > 0.5,
    })
    .register_setting(FieldDef {
        key: "quality",
        tab: "Video",
        label: "Graphics quality",
        hint: "Anti-aliasing, ambient occlusion, bloom and shadow detail.",
        kind: FieldKind::Choice { options: vec!["Low", "Medium", "High", "Ultra"] },
        get: |w| core(w).quality.index() as f32,
        set: |w, v| core_mut(w).quality = GraphicsQuality::from_index(v.round().max(0.0) as usize),
    })
    .register_setting(FieldDef {
        key: "fov_deg",
        tab: "Video",
        label: "Field of view",
        hint: "Vertical field of view.",
        kind: FieldKind::Slider { min: 60.0, max: 110.0, step: 1.0, format: format_degrees },
        get: |w| core(w).fov_deg,
        set: |w, v| core_mut(w).fov_deg = v.clamp(60.0, 110.0),
    })
    .register_setting(FieldDef {
        key: "window_mode",
        tab: "Video",
        label: "Window mode",
        hint: "Windowed, borderless fullscreen or exclusive fullscreen.",
        kind: FieldKind::Choice { options: vec!["Windowed", "Borderless", "Fullscreen"] },
        get: |w| core(w).window_mode.index() as f32,
        set: |w, v| core_mut(w).window_mode = WindowModeSetting::from_index(v.round().max(0.0) as usize),
    })
    .register_setting(FieldDef {
        key: "vsync",
        tab: "Video",
        label: "VSync",
        hint: "Sync frames to the display to avoid tearing.",
        kind: FieldKind::Toggle,
        get: |w| core(w).vsync as u8 as f32,
        set: |w, v| core_mut(w).vsync = v > 0.5,
    })
    .register_setting(FieldDef {
        key: "show_fps",
        tab: "Video",
        label: "Show FPS",
        hint: "Frame-rate counter in the corner.",
        kind: FieldKind::Toggle,
        get: |w| core(w).show_fps as u8 as f32,
        set: |w, v| core_mut(w).show_fps = v > 0.5,
    })
    .register_setting(FieldDef {
        key: "ui_scale",
        tab: "Video",
        label: "UI scale",
        hint: "Size of menus and HUD text.",
        kind: FieldKind::Slider { min: 0.75, max: 1.5, step: 0.05, format: format_percent },
        get: |w| core(w).ui_scale,
        set: |w, v| core_mut(w).ui_scale = v.clamp(0.75, 1.5),
    })
    .register_setting(volume_slider("master_volume", "Master volume", "Overall loudness.", |w| core(w).master_volume, |w, v| {
        core_mut(w).master_volume = v.clamp(0.0, 1.0)
    }))
    .register_setting(volume_slider("sfx_volume", "Effects", "Gameplay sound effects.", |w| core(w).sfx_volume, |w, v| {
        core_mut(w).sfx_volume = v.clamp(0.0, 1.0)
    }))
    .register_setting(volume_slider("music_volume", "Music", "Background music.", |w| core(w).music_volume, |w, v| {
        core_mut(w).music_volume = v.clamp(0.0, 1.0)
    }))
    .register_setting(volume_slider("ambience_volume", "Ambience", "Environmental background sound.", |w| core(w).ambience_volume, |w, v| {
        core_mut(w).ambience_volume = v.clamp(0.0, 1.0)
    }))
    .register_setting(volume_slider("ui_volume", "Interface", "Menu clicks and notifications.", |w| core(w).ui_volume, |w, v| {
        core_mut(w).ui_volume = v.clamp(0.0, 1.0)
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Resource, Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
    #[serde(default)]
    struct MyGame {
        difficulty: u8,
        name: String,
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("engine-settings-{tag}-{}-{}", std::process::id(), rand::random::<u32>()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn store_with_sections(path: PathBuf) -> SettingsStore {
        let mut s = SettingsStore::load(path);
        s.sections.push((CORE, serialize_resource::<CoreSettings>));
        s.sections.push((GAME, serialize_resource::<MyGame>));
        s
    }

    #[test]
    fn json_round_trip() {
        let dir = temp_dir("rt");
        let path = dir.join("settings.json");
        let mut world = World::new();
        let core = CoreSettings { sensitivity: 2.25, quality: GraphicsQuality::Ultra, window_mode: WindowModeSetting::Borderless, ..default() };
        let game = MyGame { difficulty: 3, name: "x".into() };
        world.insert_resource(core.clone());
        world.insert_resource(game.clone());
        store_with_sections(path.clone()).save(&world).unwrap();

        let back = SettingsStore::load(&path);
        assert_eq!(back.decode::<CoreSettings>(CORE), core);
        assert_eq!(back.decode::<MyGame>(GAME), game);
        let raw: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(raw.get("core").is_some() && raw.get("game").is_some());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn missing_and_unknown_fields_use_defaults() {
        let dir = temp_dir("fields");
        let path = dir.join("settings.json");
        std::fs::write(&path, r#"{"core":{"fov_deg":95.0,"bogus":1},"game":{"difficulty":2,"extra":[1]},"other_tool":{"k":1}}"#).unwrap();
        let store = SettingsStore::load(&path);
        let core: CoreSettings = store.decode(CORE);
        assert_eq!(core.fov_deg, 95.0);
        assert_eq!(core.sensitivity, CoreSettings::default().sensitivity);
        assert_eq!(store.decode::<MyGame>(GAME), MyGame { difficulty: 2, name: String::new() });
        // Missing file / missing section → defaults.
        let empty = SettingsStore::load(dir.join("nope.json"));
        assert_eq!(empty.decode::<CoreSettings>(CORE), CoreSettings::default());
        assert_eq!(empty.decode::<MyGame>(GAME), MyGame::default());
        // Sections nobody claims survive a save.
        let mut world = World::new();
        world.insert_resource(core);
        world.insert_resource(MyGame::default());
        let mut s = store_with_sections(path.clone());
        s.save(&world).unwrap();
        let raw: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(raw["other_tool"]["k"], 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn corrupt_file_falls_back_and_is_moved_aside() {
        let dir = temp_dir("corrupt");
        let path = dir.join("settings.json");
        std::fs::write(&path, "{ not json").unwrap();
        let store = SettingsStore::load(&path);
        assert_eq!(store.decode::<CoreSettings>(CORE), CoreSettings::default());
        assert!(!path.exists());
        assert!(dir.join("settings.json.corrupt").exists());
        // Wrong type for a section → that section defaults.
        std::fs::write(&path, r#"{"core":{"fov_deg":"wide"}}"#).unwrap();
        assert_eq!(SettingsStore::load(&path).decode::<CoreSettings>(CORE), CoreSettings::default());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn legacy_flat_file_reads_both_sections() {
        let dir = temp_dir("legacy");
        let path = dir.join("settings.json");
        std::fs::write(&path, r#"{"sensitivity":1.5,"difficulty":4}"#).unwrap();
        let store = SettingsStore::load(&path);
        assert_eq!(store.decode::<CoreSettings>(CORE).sensitivity, 1.5);
        assert_eq!(store.decode::<MyGame>(GAME).difficulty, 4);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn registry_ordering() {
        let dir = temp_dir("reg");
        let mut app = App::new();
        app.insert_resource(DataDir(dir.clone()));
        app.add_plugins(CoreSettingsPlugin);
        let field = |key, tab| FieldDef { key, tab, label: key, hint: "", kind: FieldKind::Toggle, get: |_| 0.0, set: |_, _| {} };
        app.register_setting(field("difficulty", "Gameplay")).register_setting(field("crosshair", "HUD"));
        {
            let reg = app.world().resource::<SettingsRegistry>();
            assert_eq!(reg.tabs, vec!["Controls", "Video", "Audio", "Gameplay", "HUD"]);
            let video: Vec<_> = reg.tab_fields("Video").map(|f| f.key).collect();
            assert_eq!(video, vec!["quality", "fov_deg", "window_mode", "vsync", "show_fps", "ui_scale"]);
        }
        // Re-registering a key replaces it (moves to the end), tabs unchanged.
        app.register_setting(field("sensitivity", "Controls"));
        app.set_settings_tabs(&["Gameplay", "Controls"]);
        let reg = app.world().resource::<SettingsRegistry>();
        assert_eq!(reg.tabs, vec!["Gameplay", "Controls", "Video", "Audio", "HUD"]);
        assert_eq!(reg.tab_fields("Controls").map(|f| f.key).collect::<Vec<_>>(), vec!["invert_y", "sensitivity"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn core_field_get_set() {
        let mut app = App::new();
        let dir = temp_dir("getset");
        app.insert_resource(DataDir(dir.clone()));
        app.add_plugins(CoreSettingsPlugin);
        let reg = app.world().resource::<SettingsRegistry>().clone();
        let w = app.world_mut();
        (reg.field("quality").unwrap().set)(w, 0.0);
        assert_eq!(w.resource::<CoreSettings>().quality, GraphicsQuality::Low);
        (reg.field("invert_y").unwrap().set)(w, 1.0);
        assert_eq!((reg.field("invert_y").unwrap().get)(w), 1.0);
        (reg.field("fov_deg").unwrap().set)(w, 500.0);
        assert_eq!(w.resource::<CoreSettings>().fov_deg, 110.0);
        assert_eq!(format_percent(0.75), "75%");
        let _ = std::fs::remove_dir_all(dir);
    }
}
