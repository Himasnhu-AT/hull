//! UI library v2: a React-style, game-agnostic component layer on bevy_ui (docs/UI2.md).
//!
//! - [`tokens`]: design tokens as data (`assets/ui/tokens.ron`, hot reloaded).
//! - [`components`]: props structs with builders (`Tile`, `TabBar`, `Header`, `KeyHints`, `Modal`,
//!   `Grid`, `Carousel`, `Button`, `Toggle`, `Slider`); the same structs deserialize from screen files.
//! - [`screen`]: declarative screens `assets/ui/<name>.ui.ron`, a screen stack with page transitions,
//!   hot reload, located errors ([`Ui2Diagnostics`]).
//! - [`focus`]: spatial focus (arrows / D-pad / stick / mouse), activation, shoulder tab switching.
//! - [`anim`]: focus scale + glow, staggered entrances, page slides (no tween crate: small eased systems).
//! - [`store`]: [`UiData`], a key-value store screens bind to (`{player.credits}` in any text).
//! - [`glyph`]: key hints that show the glyph of the device the player used last.
//!
//! ```ignore
//! app.add_plugins(Ui2Plugin);                         // added by `engine::app` with feature `ui2`
//! world.resource_mut::<UiData>().set("player.credits", 1200);
//! world.resource_mut::<Ui2Cmds>().open("hub");        // assets/ui/hub.ui.ron
//! // read `UiEvent { id, kind }` messages: Activate, Focus, Tab(i), Toggle(b), Slide(v), Back
//! ```

pub mod anim;
pub mod backdrop;
pub mod components;
pub mod focus;
pub mod glyph;
pub mod screen;
pub mod store;
pub mod tokens;

#[cfg(feature = "devtools")]
mod devtools;
#[cfg(test)]
mod tests;

pub use components::*;
pub use focus::{Focusable2, Nav2, Ui2Focus};
pub use screen::{Screen, Ui2Screens};
pub use store::{Bind, BindTarget, UiData};
pub use tokens::{ColorRef, Tokens};

use bevy::prelude::*;

/// What a component did. `id` is the component's `id` prop.
#[derive(Clone, Debug, PartialEq)]
pub enum UiEventKind {
    Activate,
    Focus,
    Tab(usize),
    Toggle(bool),
    Slide(f32),
    Back,
}

#[derive(Message, Clone, Debug)]
pub struct UiEvent {
    pub id: String,
    pub kind: UiEventKind,
    pub entity: Entity,
}

/// What activating a component does besides emitting its [`UiEvent`].
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum Action {
    #[default]
    None,
    /// Push a screen (`assets/ui/<name>.ui.ron`).
    Open(String),
    /// Pop the top screen (or close the modal).
    Back,
    SetStr(String, String),
    SetNum(String, f64),
    SetBool(String, bool),
}

/// Queued screen / data commands. Systems and scripts push, [`screen::run_cmds`] applies.
#[derive(Resource, Default)]
pub struct Ui2Cmds(pub Vec<Cmd>);

pub enum Cmd {
    Open(String),
    Back,
    CloseAll,
    /// Show a screen built in Rust (no file).
    Show(String, Box<Screen>),
    Set(String, serde_json::Value),
}

impl Ui2Cmds {
    pub fn open(&mut self, name: &str) {
        self.0.push(Cmd::Open(name.into()));
    }
    pub fn show(&mut self, name: &str, screen: Screen) {
        self.0.push(Cmd::Show(name.into(), Box::new(screen)));
    }
    pub fn back(&mut self) {
        self.0.push(Cmd::Back);
    }
    pub fn set(&mut self, key: &str, v: impl Into<serde_json::Value>) {
        self.0.push(Cmd::Set(key.into(), v.into()));
    }
}

/// Bumped when tokens or a screen file changed: open screens rebuild.
#[derive(Resource, Default, Debug)]
pub struct Ui2Rev(pub u64);

/// Located problems in screen / token files (file, line, col, message). Also logged.
#[derive(Resource, Default, Debug)]
pub struct Ui2Diagnostics(pub Vec<Ui2Diag>);

#[derive(Clone, Debug, PartialEq)]
pub struct Ui2Diag {
    pub file: String,
    pub line: u32,
    pub col: u32,
    pub message: String,
}

impl Ui2Diagnostics {
    pub fn report(&mut self, file: &str, line: u32, col: u32, message: impl Into<String>) {
        let d = Ui2Diag { file: file.into(), line, col, message: message.into() };
        if !self.0.contains(&d) {
            warn!("ui2 {}:{}:{} {}", d.file, d.line, d.col, d.message);
            self.0.push(d);
        }
    }
    pub fn clear_file(&mut self, file: &str) {
        self.0.retain(|d| d.file != file);
    }
}

/// Order of the library's Update work.
#[derive(SystemSet, Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Ui2Set {
    Input,
    Screens,
    Paint,
}

pub struct Ui2Plugin;

impl Plugin for Ui2Plugin {
    fn build(&self, app: &mut App) {
        if !app.world().contains_resource::<Tokens>() {
            let t = app.world().get_resource::<crate::ui::theme::Theme>().map(Tokens::from_theme).unwrap_or_default();
            app.insert_resource(t);
        }
        app.init_resource::<UiData>()
            .init_resource::<Ui2Cmds>()
            .init_resource::<Ui2Rev>()
            .init_resource::<Ui2Diagnostics>()
            .init_resource::<Ui2Screens>()
            .init_resource::<Ui2Focus>()
            .add_message::<UiEvent>()
            .add_message::<Nav2>()
            .configure_sets(Update, (Ui2Set::Input, Ui2Set::Screens, Ui2Set::Paint).chain())
            .add_plugins((screen::ScreenPlugin, focus::FocusPlugin, anim::AnimPlugin, store::StorePlugin, glyph::GlyphPlugin));
        #[cfg(feature = "devtools")]
        devtools::register(app);
    }
}
