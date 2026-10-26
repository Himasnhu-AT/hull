//! # engine
//!
//! A reusable game shell on Bevy 0.19. Pick it up, describe your game, and you get:
//! window / headless bootstrap, CLI flags, data + asset folders, persisted settings with a
//! generated settings screen, a main menu, an Esc pause menu, a themed UI kit, rendering
//! quality presets, PBR texture loading with mipmaps, audio volumes, mouse look + cursor
//! capture, and (feature `devtools`) a control port for automated tests and screenshots.
//!
//! ```ignore
//! use engine::prelude::*;
//! fn main() {
//!     engine::app(GameInfo::new("orbs", "Orbs").tagline("Collect them all."))
//!         .add_plugins(MyGamePlugin)
//!         .run();
//! }
//! ```
//!
//! Games put their own flow under [`flow::AppState::InGame`] (Bevy sub-states), register
//! their settings rows with [`settings::RegisterSettings`], and add screens / menu items
//! through [`ui::screens::ScreenRegistry`] and [`ui::menus::MenuConfig`].
//!
//! CONTRACT: the public names in this crate's module docs are shared by the parallel
//! implementation streams (core, ui, devtools). Don't rename them; add freely.

#![allow(clippy::type_complexity, clippy::too_many_arguments)]

pub use bevy;
#[cfg(feature = "physics")]
pub use avian3d;

#[cfg(feature = "anim")]
pub mod anim;
pub mod app;
pub mod audio;
pub mod chase;
pub mod cli;
pub mod exit;
pub mod flow;
pub mod gfx;
pub mod input;
pub mod meshkit;
pub mod pause;
pub mod paths;
pub mod render_budget;
pub mod settings;
pub mod ui;

#[cfg(feature = "devkit")]
pub mod devkit;
#[cfg(feature = "devtools")]
pub mod devtools;
#[cfg(feature = "fps")]
pub mod fps;
#[cfg(feature = "look")]
pub mod look;
#[cfg(feature = "trace")]
pub mod trace;

pub use app::{EngineOptions, GameInfo, app, app_with};

pub mod prelude {
    pub use crate::app::{EngineOptions, EnginePlugin, GameInfo, app, app_with};
    pub use crate::audio::{AudioCategory, SoundLibrary, Volumes};
    pub use crate::chase::ChaseCamera;
    pub use crate::cli::{GameSeed, arg_value, has_flag};
    pub use crate::flow::{AppState, Headless, has_visuals, in_game};
    pub use crate::gfx::{MainCamera, QualityPreset};
    pub use crate::input::{Bindings, CaptureCursor, CursorCaptured, LookInput};
    pub use crate::meshkit::MeshKit;
    pub use crate::pause::{PauseCtl, Paused, not_paused};
    pub use crate::paths::{AssetsDir, DataDir};
    pub use crate::render_budget::{Actor, FarLook, KeepDetail, RenderBudget, RenderStats, Scenery, SceneryRanges, SceneryStream};
    pub use crate::settings::{CoreSettings, FieldDef, FieldKind, GameSettings, GraphicsQuality, RegisterSettings, SettingsPlugin, WindowModeSetting};
    pub use crate::ui::theme::Theme;
    #[cfg(feature = "devkit")]
    pub use crate::devkit::{HotReloadAppExt, PerfBudget, SaveConfig, SaveEvent, SavePlugin, SaveRequest, Scenario, WatchPath};
    #[cfg(feature = "anim")]
    pub use crate::anim::{AnimConfig, AnimGraphDef, AnimLayer, AnimNotify, AnimPlugin, AnimState, Animator, ClipBuilder, Mannequin, RigDef, RootMotion, RootMotionDelta, Skeleton};
    #[cfg(feature = "fps")]
    pub use crate::fps::{FpsController, FpsInput, FpsLook, FpsMotor, FpsPlugin, FpsSet};
    #[cfg(feature = "look")]
    pub use crate::look::{Look, LookPlugin, LookTimeline, LookTransition, ReflectionProbe};
    pub use bevy::prelude::*;
}
