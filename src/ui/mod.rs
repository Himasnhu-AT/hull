//! UI kit and the engine's screens. Owner: ui stream (port from Shroud `ui/theme.rs`,
//! `ui/widgets.rs`, `ui/screens.rs`, `ui/settings_screen.rs`, `ui/pause.rs`, `menu.rs`,
//! `ui/apply.rs` FPS counter — made game-agnostic).
//!
//! - [`theme`]: palette + type scale + spacing as a [`theme::Theme`] resource (games can
//!   re-brand: accent, fonts), embedded Barlow fonts, text/panel helpers, UI scaling by height.
//! - [`widgets`]: focus + keyboard/mouse nav, buttons, tabs, toggle, slider, choice, cards,
//!   swatches — all driven by [`crate::settings::FieldDef`]s.
//! - [`screens`]: a screen stack; built-in screens "main", "settings", "pause"; games register
//!   more (e.g. "setup", "results") with builder fns.
//! - [`menus`]: [`menus::MenuConfig`] — main-menu items, pause-menu extra items, side panel.
//! - FPS counter (CoreSettings.show_fps), key-hint footer, toast messages.

pub mod menus;
pub mod screens;
pub mod theme;
pub mod widgets;

use bevy::prelude::*;

pub struct UiKitPlugin;

impl Plugin for UiKitPlugin {
    fn build(&self, app: &mut App) {
        let _ = app;
        todo!("ui stream")
    }
}
