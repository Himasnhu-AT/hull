//! Main-menu and pause-menu configuration and the two built-in screens. Owner: ui stream.
//!
//! - "main": eyebrow + [`crate::GameInfo::title`] + tagline, [`MenuConfig::main_items`], the
//!   optional [`MenuConfig::main_panel`] (bottom right), key hints, version.
//! - "pause": game title as eyebrow, "PAUSED", the optional [`MenuConfig::pause_header`],
//!   [`MenuConfig::pause_items`], [`MenuConfig::pause_note`], key hints.

use bevy::prelude::*;

use super::theme::*;
use super::widgets::{UiAction, nav_list};
use crate::app::GameInfo;

/// What a menu button does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MenuAction {
    /// Go to `AppState::InGame`.
    Play,
    /// Push a registered screen (e.g. "setup").
    Open(&'static str),
    /// Push "settings".
    Settings,
    /// Close the pause menu.
    Resume,
    /// Leave the game: `AppState::MainMenu` (sends [`MenuEvent`]("main_menu") first).
    MainMenu,
    /// Exit the app.
    Quit,
    /// Game-defined: sends [`MenuEvent`] with this id (e.g. "restart", "start_match").
    Custom(&'static str),
}

/// Sent for `MenuAction::Custom(id)` and for engine transitions games may care about
/// ("main_menu", "resume", "pause").
#[derive(Message, Clone, Copy, Debug, PartialEq, Eq)]
pub struct MenuEvent(pub &'static str);

/// Side panel on the main menu (e.g. Shroud's "Enemy brain" card). Exclusive builder.
pub type PanelBuilder = fn(&mut World, Entity);

#[derive(Resource, Clone)]
pub struct MenuConfig {
    /// Small label above the title ("ADAPTIVE SQUAD SHOOTER").
    pub eyebrow: &'static str,
    /// Main menu buttons, top to bottom. Default: Play, Settings, Quit.
    pub main_items: Vec<(&'static str, MenuAction)>,
    /// Pause menu buttons. Default: Resume, Settings, Main menu, Quit game.
    pub pause_items: Vec<(&'static str, MenuAction)>,
    /// Small print under the pause buttons.
    pub pause_note: &'static str,
    pub main_panel: Option<PanelBuilder>,
    /// Extra line(s) under "PAUSED" (e.g. score), built by the game.
    pub pause_header: Option<PanelBuilder>,
}

impl Default for MenuConfig {
    fn default() -> Self {
        MenuConfig {
            eyebrow: "",
            main_items: vec![("Play", MenuAction::Play), ("Settings", MenuAction::Settings), ("Quit", MenuAction::Quit)],
            pause_items: vec![
                ("Resume", MenuAction::Resume),
                ("Settings", MenuAction::Settings),
                ("Main menu", MenuAction::MainMenu),
                ("Quit game", MenuAction::Quit),
            ],
            pause_note: "",
            main_panel: None,
            pause_header: None,
        }
    }
}

fn items(list: &[(&'static str, MenuAction)]) -> Vec<(&'static str, UiAction)> {
    list.iter().map(|(n, a)| (*n, UiAction::Menu(*a))).collect()
}

/// Hero size that keeps long titles on one line.
pub fn hero_size(title: &str) -> f32 {
    let n = title.chars().count().max(1) as f32;
    if n <= 9.0 { SIZE_HERO } else { (SIZE_HERO * 9.0 / n).max(72.0) }
}

/// Built-in "main" screen.
pub fn build_main(world: &mut World, root: Entity) {
    let t = world.resource::<Theme>().clone();
    let cfg = world.get_resource::<MenuConfig>().cloned().unwrap_or_default();
    let (name, tagline, version) = world.get_resource::<GameInfo>().map_or(("", "", ""), |i| (i.title, i.tagline, i.version));
    let nav = items(&cfg.main_items);
    let mut slot = None;
    world.commands().entity(root).with_children(|p| {
        menu_backdrop(p, &t, 0.0, 1.0);
        p.spawn(menu_column(0.0)).with_children(|col| {
            if !cfg.eyebrow.is_empty() {
                eyebrow_bar(col, cfg.eyebrow, t.accent);
            }
            if !name.is_empty() {
                let size = hero_size(name);
                col.spawn(title(name, size, t.text));
            }
            if !tagline.is_empty() {
                col.spawn(text(tagline, body(24.0), t.text_muted));
            }
            col.spawn(spacer(64.0));
            nav_list(col, &t, &nav, 1);
        });
        if cfg.main_panel.is_some() {
            slot = Some(
                p.spawn((
                    Node {
                        position_type: PositionType::Absolute,
                        right: px(EDGE),
                        bottom: px(FOOTER_BOTTOM),
                        width: px(380),
                        flex_direction: FlexDirection::Column,
                        row_gap: px(GAP_M),
                        ..default()
                    },
                    Pickable::IGNORE,
                ))
                .id(),
            );
        }
        spawn_footer(p, &t, &[("W / S", "Navigate"), ("Enter", "Select")]);
        if !version.is_empty() {
            p.spawn((
                text(format!("v{version}"), body(SIZE_TINY), t.text_dim),
                Node { position_type: PositionType::Absolute, right: px(20), bottom: px(12), ..default() },
            ));
        }
    });
    world.flush();
    if let (Some(build), Some(slot)) = (cfg.main_panel, slot) {
        build(world, slot);
    }
}

/// Built-in "pause" screen.
pub fn build_pause(world: &mut World, root: Entity) {
    let t = world.resource::<Theme>().clone();
    let cfg = world.get_resource::<MenuConfig>().cloned().unwrap_or_default();
    let name = world.get_resource::<GameInfo>().map_or("", |i| i.title);
    let nav = items(&cfg.pause_items);
    let mut slot = None;
    world.commands().entity(root).with_children(|p| {
        menu_backdrop(p, &t, 0.55, 0.95);
        p.spawn(menu_column(0.0)).with_children(|col| {
            if !name.is_empty() {
                col.spawn(eyebrow(name, t.accent));
            }
            col.spawn(title("Paused", SIZE_H1 + 24.0, t.text));
            if cfg.pause_header.is_some() {
                slot = Some(
                    col.spawn((Node { flex_direction: FlexDirection::Column, row_gap: px(GAP_S), margin: UiRect::top(px(GAP_S)), ..default() }, Pickable::IGNORE))
                        .id(),
                );
            }
            col.spawn(spacer(48.0));
            nav_list(col, &t, &nav, 1);
            if !cfg.pause_note.is_empty() {
                col.spawn(spacer(24.0));
                col.spawn(text(cfg.pause_note, body(SIZE_SMALL), t.text_dim));
            }
        });
        spawn_footer(p, &t, &[("W / S", "Navigate"), ("Enter", "Select"), ("Esc", "Resume")]);
    });
    world.flush();
    if let (Some(build), Some(slot)) = (cfg.pause_header, slot) {
        build(world, slot);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_titles_shrink() {
        assert_eq!(hero_size("SHROUD"), SIZE_HERO);
        assert!(hero_size("A VERY LONG GAME TITLE") < SIZE_HERO);
        assert!(hero_size(&"X".repeat(80)) >= 72.0);
    }
}
