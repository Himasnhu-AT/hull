//! Main-menu and pause-menu configuration. Owner: ui stream.

use bevy::prelude::*;

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
