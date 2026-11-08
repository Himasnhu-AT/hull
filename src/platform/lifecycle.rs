//! Window focus and process lifecycle: pause when the window loses focus, and a single-instance
//! guard.

use std::fs::{File, OpenOptions, TryLockError};
use std::io::Write;
use std::path::{Path, PathBuf};

use bevy::prelude::*;
use bevy::window::WindowFocused;

use crate::flow::AppState;
use crate::pause::PauseCtl;
#[cfg(test)]
use crate::pause::Paused;

/// What to do when the window loses or regains focus.
#[derive(Resource, Clone, Debug)]
pub struct FocusPolicy {
    /// Pause the game (only while `InGame`) when focus is lost.
    pub pause_on_focus_loss: bool,
    /// Unpause on regaining focus, but only a pause this policy made.
    pub resume_on_focus: bool,
}

impl Default for FocusPolicy {
    fn default() -> Self {
        FocusPolicy { pause_on_focus_loss: true, resume_on_focus: false }
    }
}

/// Sent when the primary window gains (`true`) or loses (`false`) focus. Hook it for muting
/// audio, releasing the cursor, flushing a save.
#[derive(Message, Clone, Copy, Debug, PartialEq, Eq)]
pub struct AppFocusChanged(pub bool);

pub(super) fn focus_hook(
    policy: Res<FocusPolicy>,
    mut events: MessageReader<WindowFocused>,
    mut out: MessageWriter<AppFocusChanged>,
    state: Option<Res<State<AppState>>>,
    mut pause: PauseCtl,
    mut we_paused: Local<bool>,
) {
    for ev in events.read() {
        out.write(AppFocusChanged(ev.focused));
        // Offscreen / scripted runs never have a focused window: don't pause those.
        if crate::cli::test_driven() {
            continue;
        }
        if !ev.focused {
            let in_game = state.as_ref().is_none_or(|s| *s.get() == AppState::InGame);
            if policy.pause_on_focus_loss && in_game && !pause.is_paused() {
                pause.set(true);
                *we_paused = true;
            }
        } else if policy.resume_on_focus && *we_paused {
            pause.set(false);
            *we_paused = false;
        } else {
            *we_paused = false;
        }
    }
}

/// Another copy of the game holds the lock.
#[derive(Debug, PartialEq, Eq)]
pub enum InstanceError {
    AlreadyRunning,
    Io(String),
}

/// An exclusive lock on `<dir>/<id>.lock`, held until dropped (the OS releases it if the process
/// dies). The file holds the owner's pid, for humans.
#[derive(Debug)]
pub struct SingleInstance {
    _file: File,
    pub path: PathBuf,
}

impl SingleInstance {
    pub fn acquire(dir: &Path, id: &str) -> Result<Self, InstanceError> {
        std::fs::create_dir_all(dir).map_err(|e| InstanceError::Io(e.to_string()))?;
        let path = dir.join(format!("{id}.lock"));
        let mut file = OpenOptions::new().create(true).truncate(false).write(true).open(&path).map_err(|e| InstanceError::Io(e.to_string()))?;
        match file.try_lock() {
            Ok(()) => {
                let _ = file.set_len(0);
                let _ = write!(file, "{}", std::process::id());
                Ok(SingleInstance { _file: file, path })
            }
            Err(TryLockError::WouldBlock) => Err(InstanceError::AlreadyRunning),
            Err(TryLockError::Error(e)) => Err(InstanceError::Io(e.to_string())),
        }
    }
}

/// The held guard, when `PlatformPlugin::single_instance` is on.
#[derive(Resource)]
pub struct InstanceGuard(#[allow(dead_code)] pub SingleInstance);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_instance_is_refused_until_the_first_drops() {
        let dir = std::env::temp_dir().join(format!("platform-lock-{}", std::process::id()));
        let a = SingleInstance::acquire(&dir, "game").unwrap();
        assert_eq!(SingleInstance::acquire(&dir, "game").unwrap_err(), InstanceError::AlreadyRunning);
        assert!(SingleInstance::acquire(&dir, "other").is_ok());
        drop(a);
        assert!(SingleInstance::acquire(&dir, "game").is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn focus_loss_pauses_only_in_game_and_resume_is_opt_in() {
        use crate::pause::PausePlugin;
        let mut app = App::new();
        app.add_plugins(MinimalPlugins).add_plugins(bevy::state::app::StatesPlugin).init_state::<AppState>();
        app.add_plugins(PausePlugin).add_message::<WindowFocused>().add_message::<AppFocusChanged>().init_resource::<FocusPolicy>();
        app.add_systems(Update, focus_hook);
        let win = app.world_mut().spawn_empty().id();
        let focus = |app: &mut App, f: bool| {
            app.world_mut().write_message(WindowFocused { window: win, focused: f });
            app.update();
        };
        focus(&mut app, false);
        assert!(!app.world().resource::<Paused>().0, "not InGame: no pause");
        app.world_mut().resource_mut::<NextState<AppState>>().set(AppState::InGame);
        app.update();
        focus(&mut app, false);
        assert!(app.world().resource::<Paused>().0);
        focus(&mut app, true);
        assert!(app.world().resource::<Paused>().0, "resume_on_focus is off");
        app.world_mut().resource_mut::<Paused>().0 = false;
        app.world_mut().resource_mut::<FocusPolicy>().resume_on_focus = true;
        focus(&mut app, false);
        focus(&mut app, true);
        assert!(!app.world().resource::<Paused>().0);
    }
}
