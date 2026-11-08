//! Window control as one persisted resource: [`WindowSettings`] (section `"window"` of
//! settings.json). Mode, monitor, size, scale override, vsync and cursor behaviour; a system
//! applies it to the primary window whenever it changes.
//!
//! `CoreSettings` (the settings screen's Window mode / VSync rows) stays the source for mode and
//! vsync until `override_core` is set, so the stock settings screen keeps working; a game with
//! its own display menu sets `override_core = true` and edits `WindowSettings` instead.

use bevy::prelude::*;
use bevy::window::{CursorGrabMode, CursorOptions, MonitorSelection, PresentMode, PrimaryWindow, VideoModeSelection, WindowMode};
use serde::{Deserialize, Serialize};

use crate::settings::{CoreSettings, WindowModeSetting};

/// How the mouse cursor behaves. `Auto` leaves it to the game (`engine::input` locks it in play).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum CursorMode {
    #[default]
    Auto,
    Free,
    Hidden,
    /// Hidden and locked (mouse look).
    Locked,
    /// Visible, kept inside the window (not on macOS).
    Confined,
}

impl CursorMode {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s.to_ascii_lowercase().as_str() {
            "auto" => Self::Auto,
            "free" => Self::Free,
            "hidden" => Self::Hidden,
            "locked" => Self::Locked,
            "confined" => Self::Confined,
            _ => return None,
        })
    }
    /// `(visible, grab)` or `None` for `Auto`.
    pub fn options(self) -> Option<(bool, CursorGrabMode)> {
        match self {
            Self::Auto => None,
            Self::Free => Some((true, CursorGrabMode::None)),
            Self::Hidden => Some((false, CursorGrabMode::None)),
            Self::Locked => Some((false, CursorGrabMode::Locked)),
            Self::Confined => Some((true, CursorGrabMode::Confined)),
        }
    }
}

#[derive(Resource, Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct WindowSettings {
    /// Use `mode` / `vsync` here instead of `CoreSettings`'.
    pub override_core: bool,
    pub mode: WindowModeSetting,
    pub vsync: bool,
    /// Monitor index for borderless / fullscreen (`None` = the one the window is on).
    pub monitor: Option<usize>,
    /// Windowed size in logical pixels (`None` = leave as is).
    pub size: Option<(u32, u32)>,
    /// Forces the DPI scale factor (`None` = the OS's).
    pub scale_override: Option<f32>,
    pub cursor: CursorMode,
}

impl Default for WindowSettings {
    fn default() -> Self {
        WindowSettings { override_core: false, mode: WindowModeSetting::default(), vsync: true, monitor: None, size: None, scale_override: None, cursor: CursorMode::Auto }
    }
}

impl WindowSettings {
    fn effective(&self, core: &CoreSettings) -> (WindowModeSetting, bool) {
        if self.override_core { (self.mode, self.vsync) } else { (core.window_mode, core.vsync) }
    }

    /// The Bevy window mode this resolves to.
    pub fn window_mode(&self, core: &CoreSettings) -> WindowMode {
        let sel = self.monitor.map_or(MonitorSelection::Current, MonitorSelection::Index);
        match self.effective(core).0 {
            WindowModeSetting::Windowed => WindowMode::Windowed,
            WindowModeSetting::Borderless => WindowMode::BorderlessFullscreen(sel),
            WindowModeSetting::Fullscreen => WindowMode::Fullscreen(sel, VideoModeSelection::Current),
        }
    }

    pub fn present_mode(&self, core: &CoreSettings) -> PresentMode {
        if self.effective(core).1 && !crate::cli::uncapped() { PresentMode::AutoVsync } else { PresentMode::AutoNoVsync }
    }
}

/// What the window looks like now (read-only; refreshed every frame the window exists).
#[derive(Resource, Clone, Debug, Default)]
pub struct WindowInfo {
    pub scale_factor: f32,
    pub physical: UVec2,
    pub focused: bool,
    pub monitors: Vec<String>,
}

pub(super) fn apply(
    settings: Res<WindowSettings>,
    core: Res<CoreSettings>,
    mut windows: Query<(&mut Window, Option<&mut CursorOptions>), With<PrimaryWindow>>,
    mut last_cursor: Local<Option<CursorMode>>,
) {
    let cursor_changed = *last_cursor != Some(settings.cursor);
    if !settings.is_changed() && !core.is_changed() && !cursor_changed {
        return;
    }
    let test_run = crate::cli::test_driven();
    for (mut w, cursor) in &mut windows {
        let present = settings.present_mode(&core);
        if w.present_mode != present {
            w.present_mode = present;
        }
        if !test_run {
            let mode = settings.window_mode(&core);
            if w.mode != mode {
                w.mode = mode;
            }
            if let (WindowMode::Windowed, Some((x, y))) = (w.mode, settings.size)
                && (w.resolution.width() as u32, w.resolution.height() as u32) != (x, y)
            {
                w.resolution.set(x as f32, y as f32);
            }
        }
        if w.resolution.scale_factor_override() != settings.scale_override {
            w.resolution.set_scale_factor_override(settings.scale_override);
        }
        if cursor_changed && !test_run && let (Some(mut c), Some((visible, grab))) = (cursor, settings.cursor.options()) {
            c.visible = visible;
            c.grab_mode = grab;
        }
    }
    *last_cursor = Some(settings.cursor);
}

pub(super) fn refresh_info(
    mut info: ResMut<WindowInfo>,
    windows: Query<&Window, With<PrimaryWindow>>,
    monitors: Query<&bevy::window::Monitor>,
) {
    if let Ok(w) = windows.single() {
        info.scale_factor = w.resolution.scale_factor();
        info.physical = UVec2::new(w.resolution.physical_width(), w.resolution.physical_height());
        info.focused = w.focused;
    }
    if info.monitors.len() != monitors.iter().count() {
        info.monitors = monitors.iter().map(|m| m.name.clone().unwrap_or_else(|| "monitor".into())).collect();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_comes_from_core_until_overridden() {
        let core = CoreSettings { window_mode: WindowModeSetting::Borderless, vsync: false, ..default() };
        let mut s = WindowSettings::default();
        assert_eq!(s.window_mode(&core), WindowMode::BorderlessFullscreen(MonitorSelection::Current));
        assert_eq!(s.present_mode(&core), PresentMode::AutoNoVsync);
        s.override_core = true;
        s.mode = WindowModeSetting::Fullscreen;
        s.monitor = Some(1);
        assert_eq!(s.window_mode(&core), WindowMode::Fullscreen(MonitorSelection::Index(1), VideoModeSelection::Current));
        assert_eq!(s.present_mode(&core), PresentMode::AutoVsync);
    }

    #[test]
    fn serde_round_trip_and_defaults() {
        let s = WindowSettings { cursor: CursorMode::Confined, size: Some((1280, 720)), scale_override: Some(1.5), ..default() };
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(serde_json::from_value::<WindowSettings>(json).unwrap(), s);
        assert_eq!(serde_json::from_value::<WindowSettings>(serde_json::json!({"cursor": "Locked"})).unwrap().cursor, CursorMode::Locked);
        assert_eq!(CursorMode::parse("Locked").unwrap().options(), Some((false, CursorGrabMode::Locked)));
        assert_eq!(CursorMode::Auto.options(), None);
    }
}
