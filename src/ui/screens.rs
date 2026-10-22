//! Screen stack + registry. Owner: ui stream.
//!
//! Built-in ids: "main" (main menu, opened on entering `AppState::MainMenu`), "settings",
//! "pause" (Esc in game). Games register more with [`RegisterScreen::register_screen`].
//! Builders run exclusively: `fn(&mut World, root: Entity)` — spawn children under `root`.
//! The stack is rebuilt (despawn + build) when it changes or `RebuildScreen` is sent.

use bevy::prelude::*;

pub type ScreenBuilder = fn(&mut World, Entity);

#[derive(Resource, Clone, Default)]
pub struct ScreenRegistry(pub Vec<(&'static str, ScreenBuilder)>);

/// Open screens, top last. Empty = gameplay (HUD only).
#[derive(Resource, Clone, Debug, Default)]
pub struct Screens {
    pub stack: Vec<&'static str>,
    /// Active tab index on the top screen (settings).
    pub tab: usize,
}

impl Screens {
    pub fn top(&self) -> Option<&'static str> {
        self.stack.last().copied()
    }
}

/// Push/pop/replace requests (from buttons, Esc, games, control port).
#[derive(Message, Clone, Debug)]
pub enum ScreenRequest {
    Push(&'static str),
    Pop,
    /// Clear the stack, then push (None = clear only).
    Replace(Option<&'static str>),
    SetTab(usize),
}

/// Force a rebuild of the top screen (e.g. after data it shows changed).
#[derive(Message, Clone, Copy, Debug, Default)]
pub struct RebuildScreen;

pub trait RegisterScreen {
    fn register_screen(&mut self, id: &'static str, build: ScreenBuilder) -> &mut Self;
}

impl RegisterScreen for App {
    fn register_screen(&mut self, id: &'static str, build: ScreenBuilder) -> &mut Self {
        let mut reg = self.world_mut().get_resource_or_insert_with(ScreenRegistry::default);
        reg.0.retain(|(k, _)| *k != id);
        reg.0.push((id, build));
        self
    }
}
