//! Persisted settings + the field registry the settings screen is generated from.
//! Owner: core stream (store, persistence, core fields, applying window/vsync/FOV/quality/volume).
//!
//! - [`CoreSettings`]: what every game has (controls, video, audio, HUD basics).
//! - A game's own struct implements [`GameSettings`] and is added with `SettingsPlugin::<G>`
//!   (use `SettingsPlugin::<()>` for none). Both live in `<data>/settings.json` as
//!   `{ "core": {...}, "game": {...} }`; unknown/missing fields fall back to defaults, a corrupt
//!   file to defaults (never crash). Saved ~0.6 s after the last change and on app exit.
//! - Settings rows: [`FieldDef`]s grouped by tab, registered with [`RegisterSettings`]. The engine
//!   registers its core fields on tabs "Controls", "Video", "Audio" (and "Gameplay" for
//!   show-FPS-style HUD toggles); games add rows/tabs (e.g. "Gameplay": difficulty).
//!   Tab order = first registration order, engine tabs first unless a game calls
//!   `set_settings_tabs`.

use bevy::prelude::*;
use serde::{Deserialize, Serialize, de::DeserializeOwned};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum GraphicsQuality {
    Low,
    Medium,
    #[default]
    High,
    Ultra,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum WindowModeSetting {
    #[default]
    Windowed,
    Borderless,
    Fullscreen,
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

/// Loads `CoreSettings` + `G` at build time, saves on change (debounced) and on exit, registers
/// the core fields, and applies window mode / vsync / UI scale.
pub struct SettingsPlugin<G: GameSettings = NoGameSettings>(std::marker::PhantomData<G>);

impl<G: GameSettings> Default for SettingsPlugin<G> {
    fn default() -> Self {
        SettingsPlugin(std::marker::PhantomData)
    }
}

impl<G: GameSettings> Plugin for SettingsPlugin<G> {
    fn build(&self, app: &mut App) {
        let _ = app;
        todo!("core stream")
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
