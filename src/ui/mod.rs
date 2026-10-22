//! UI kit and the engine's screens. Owner: ui stream (ported from Shroud `ui/theme.rs`,
//! `ui/widgets.rs`, `ui/screens.rs`, `ui/settings_screen.rs`, `ui/pause.rs`, `menu.rs`,
//! `ui/apply.rs` FPS counter — made game-agnostic).
//!
//! - [`theme`]: palette as a [`theme::Theme`] resource (games can re-brand: accent, colours,
//!   fonts via [`theme::override_font`]), type scale + spacing constants, embedded Barlow fonts,
//!   text/panel helpers, UI scaling by height.
//! - [`widgets`]: focus + keyboard/mouse nav, buttons, tabs, toggle, slider, choice, cards,
//!   swatches — all driven by [`crate::settings::FieldDef`]s.
//! - [`screens`]: a screen stack; built-in screens "main", "settings", "pause"; games register
//!   more (e.g. "setup", "results") with builder fns.
//! - [`menus`]: [`menus::MenuConfig`] — main-menu items, pause-menu items, side panel.
//! - [`settings_screen`]: the generated settings screen, per-tab side panels, reset defaults.
//! - [`toast`]: [`toast::Toast`] notifications. [`fps_counter`]: `CoreSettings.show_fps`.
//!
//! Game-facing API in short:
//! ```ignore
//! app.insert_resource(MenuConfig { eyebrow: "Arcade puzzler", main_items: vec![
//!         ("Play", MenuAction::Open("setup")), ("Settings", MenuAction::Settings), ("Quit", MenuAction::Quit)],
//!         main_panel: Some(build_stats_card), ..default() })
//!    .insert_resource(Theme::default().with_accent(Color::srgb(0.4, 0.8, 1.0)))
//!    .register_screen("setup", build_setup)        // fn(&mut World, Entity)
//!    .settings_panel("Gameplay", build_preview)    // fn(&mut World, Entity)
//!    .settings_defaults::<MySettings>();           // enables "Reset tab" for game fields
//! // anywhere: commands.write_message(Toast::new("Saved"));
//! //           read MenuEvent for Custom actions and "pause" / "resume" / "main_menu".
//! ```

pub mod fps_counter;
pub mod menus;
pub mod screens;
pub mod settings_screen;
pub mod theme;
pub mod toast;
pub mod widgets;

/// Everything a game needs to build screens and panels: `use engine::ui::prelude::*;`.
pub mod prelude {
    pub use super::UiKitPlugin;
    pub use super::menus::{MenuAction, MenuConfig, MenuEvent, PanelBuilder};
    pub use super::screens::{RebuildScreen, RegisterScreen, ScreenRequest, Screens};
    pub use super::settings_screen::RegisterSettingsUi;
    pub use super::theme::*;
    pub use super::toast::Toast;
    pub use super::widgets::{NavBack, UiAction, action_button, card_row, field_row, get_field, nav_button, nav_list, set_field};
}

use bevy::prelude::*;
use bevy::window::PrimaryWindow;

use crate::flow::Headless;

/// Order of the UI kit's Update work: widget input → screen stack → field refresh + paint.
#[derive(SystemSet, Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum UiSet {
    Input,
    Screens,
    Paint,
}

/// Run condition: UI exists (not `--headless`). Missing `Headless` counts as visible.
pub fn ui_visible(h: Option<Res<Headless>>) -> bool {
    !h.is_some_and(|h| h.0)
}

pub struct UiKitPlugin;

impl Plugin for UiKitPlugin {
    fn build(&self, app: &mut App) {
        app.configure_sets(Update, (UiSet::Input.run_if(ui_visible), UiSet::Screens, UiSet::Paint.run_if(ui_visible)).chain())
            .add_plugins((
                theme::ThemePlugin,
                widgets::WidgetsPlugin,
                screens::ScreensPlugin,
                settings_screen::SettingsScreenPlugin,
                toast::ToastPlugin,
                fps_counter::FpsCounterPlugin,
            ))
            .add_systems(Update, fallback_camera.run_if(ui_visible));
        // Built-in screens, unless the game registered its own under the same id.
        let builtins: [(&'static str, screens::ScreenBuilder); 3] =
            [("main", menus::build_main), ("settings", settings_screen::build), ("pause", menus::build_pause)];
        let mut reg = app.world_mut().get_resource_or_insert_with(screens::ScreenRegistry::default);
        for (id, b) in builtins {
            if reg.get(id).is_none() {
                reg.0.push((id, b));
            }
        }
    }
}

/// A plain 2D camera so menus render when the game has no camera yet (title screens before a
/// level loads). Removed as soon as any other camera exists.
#[derive(Component)]
pub struct UiFallbackCamera;

fn fallback_camera(
    mut commands: Commands,
    theme: Res<theme::Theme>,
    others: Query<(), (With<Camera>, Without<UiFallbackCamera>)>,
    mine: Query<Entity, With<UiFallbackCamera>>,
    windows: Query<(), With<PrimaryWindow>>,
) {
    let need = others.is_empty() && !windows.is_empty();
    if need && mine.is_empty() {
        commands.spawn((
            UiFallbackCamera,
            Name::new("UI fallback camera"),
            Camera2d,
            Camera { clear_color: ClearColorConfig::Custom(theme.bg), ..default() },
        ));
    } else if !need {
        for e in &mine {
            commands.entity(e).despawn();
        }
    }
}

#[cfg(test)]
mod tests;
