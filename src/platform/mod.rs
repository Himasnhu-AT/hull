//! Game <-> local PC integration (feature `platform`, on by default; costs nothing unused).
//! A skeleton: each piece is small, standalone and swappable. Docs: `docs/PLATFORM.md`.
//!
//! | Piece | What | Swap / extend |
//! |---|---|---|
//! | [`dirs`] | `GameFolders`: Pictures / Documents / Saved Games with a per-game subfolder | `UserDirs::new(os, home)`, `GameFolders::with_root` |
//! | [`imgmeta`], [`shots`] | PNG `iTXt` / JPEG `COM` metadata, `save_png`, `SaveScreenshot` | add EXIF by writing a segment in `imgmeta` |
//! | [`os`] | `Platform` (`OsServices`): open in file browser, clipboard, notifications, file dialogs | `Platform::set(MyOs)` |
//! | [`window`] | `WindowSettings` (persisted): mode, monitor, size, scale, vsync, cursor | override in your display menu |
//! | [`text`] | `TextInput` + IME composition/commit, `TextFocus`, `typing` | render it with any UI |
//! | [`glyphs`] | `Glyphs`: action -> text / icon id for the device in use, `hint_bar` | map `icon` ids to sprites |
//! | [`lifecycle`] | `FocusPolicy` + `AppFocusChanged`, `SingleInstance` | `PlatformPlugin { single_instance }` |

use bevy::prelude::*;

pub mod dirs;
#[cfg(feature = "actions")]
pub mod glyphs;
pub mod imgmeta;
pub mod lifecycle;
pub mod os;
pub mod shots;
pub mod text;
pub mod window;

#[cfg(feature = "devtools")]
mod control;

pub use dirs::{GameFolders, OsKind, UserDir, UserDirs};
pub use lifecycle::{AppFocusChanged, FocusPolicy, InstanceError, InstanceGuard, SingleInstance};
pub use os::{DialogSpec, NullOs, OsServices, Platform};
pub use shots::{SaveScreenshot, ScreenshotSaved, ShotStatus, save_png};
pub use text::{TextFocus, TextInput, TextInputChanged, TextInputSubmitted, typing};
pub use window::{CursorMode, WindowInfo, WindowSettings};

/// Takes the single-instance lock for this game (`<data dir>/<id>.lock`), or prints a message
/// and exits if another copy holds it. Call right after `engine::app(..)`. `--allow-multiple`
/// skips it.
pub fn single_instance(app: &mut App) {
    if crate::cli::has_flag("--allow-multiple") || app.world().contains_resource::<InstanceGuard>() {
        return;
    }
    let info = app.world().get_resource::<crate::GameInfo>().cloned().unwrap_or_else(|| crate::GameInfo::new("game", "Game"));
    match SingleInstance::acquire(&crate::paths::data_dir(&info), info.id) {
        Ok(g) => {
            app.insert_resource(InstanceGuard(g));
        }
        Err(InstanceError::AlreadyRunning) => {
            eprintln!("{} is already running.", info.title);
            std::process::exit(0);
        }
        Err(InstanceError::Io(e)) => warn!("single-instance guard unavailable: {e}"),
    }
}

/// Added by `EnginePlugin`. Games tweak it through the resources (`FocusPolicy`, `Platform`,
/// `WindowSettings`) or add their own copy with options before `EnginePlugin`.
#[derive(Default)]
pub struct PlatformPlugin {
    /// Refuse to start a second copy (exit with a message). Off by default.
    pub single_instance: bool,
}

impl Plugin for PlatformPlugin {
    fn build(&self, app: &mut App) {
        let info = app.world().get_resource::<crate::GameInfo>().cloned().unwrap_or_else(|| crate::GameInfo::new("game", "Game"));
        let quiet = app.world().get_resource::<crate::flow::Headless>().is_some_and(|h| h.0) || crate::cli::test_driven();
        // Headless and scripted runs get the null OS (no Finder windows or notifications), unless
        // PLATFORM_NATIVE=1.
        let os: Box<dyn OsServices> = if quiet && std::env::var_os("PLATFORM_NATIVE").is_none() { Box::new(NullOs::default()) } else { os::native() };
        let mut folders = GameFolders::new(info.title, UserDirs::detect());
        if let Some(root) = crate::cli::arg_value("--platform-root").map(std::path::PathBuf::from).or_else(|| std::env::var_os("PLATFORM_ROOT").map(std::path::PathBuf::from)) {
            folders = folders.with_root(root);
        }
        if self.single_instance {
            single_instance(app);
        }
        crate::settings::add_settings_section::<WindowSettings>(app, "window");
        app.add_observer(text::focus_on_press);
        app.insert_resource(folders)
            .insert_resource(Platform(os))
            .init_resource::<FocusPolicy>()
            .init_resource::<WindowInfo>()
            .init_resource::<TextFocus>()
            .init_resource::<ShotStatus>()
            .add_message::<AppFocusChanged>()
            .add_message::<TextInputChanged>()
            .add_message::<TextInputSubmitted>()
            .add_message::<SaveScreenshot>()
            .add_message::<ScreenshotSaved>()
            .add_systems(Update, (window::apply.run_if(resource_exists::<crate::settings::CoreSettings>), window::refresh_info));
        // Everything below needs the window / input stack.
        if app.world().get_resource::<crate::flow::Headless>().is_none_or(|h| !h.0) {
            app.add_systems(
                Update,
                (
                    lifecycle::focus_hook.run_if(resource_exists::<crate::pause::Paused>),
                    (text::edit, text::window_ime, text::sync_text).chain(),
                    shots::request.run_if(resource_exists::<Assets<Image>>),
                ),
            );
            #[cfg(feature = "devtools")]
            app.add_systems(Update, shots::track_offscreen);
        }
        #[cfg(feature = "actions")]
        app.init_resource::<glyphs::PadStyle>().add_systems(Update, glyphs::detect_pad_family);
        #[cfg(feature = "devtools")]
        control::register(app);
    }
}
