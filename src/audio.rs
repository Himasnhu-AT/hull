//! Audio categories, volumes from settings, a named sound library with variants, play helpers.
//! Owner: core stream (port the generic parts of Shroud `audio.rs`; game-specific sounds stay
//! in the game). `--mute` and test-driven runs are silent unless `--sound`; `--volume <v>`
//! overrides master.

use bevy::prelude::*;

#[derive(Component, Clone, Copy, Debug, PartialEq, Eq, Hash, Default)]
pub enum AudioCategory {
    #[default]
    Sfx,
    Music,
    Ambience,
    Ui,
}

/// Effective gains (master × category), kept in sync with `CoreSettings`. Looping sinks with an
/// [`AudioCategory`] are re-volumed live when settings change.
#[derive(Resource, Clone, Copy, Debug)]
pub struct Volumes {
    pub master: f32,
    pub sfx: f32,
    pub music: f32,
    pub ambience: f32,
    pub ui: f32,
    pub muted: bool,
}

impl Default for Volumes {
    fn default() -> Self {
        Volumes { master: 0.8, sfx: 1.0, music: 0.7, ambience: 0.6, ui: 0.8, muted: false }
    }
}

impl Volumes {
    pub fn gain(&self, c: AudioCategory) -> f32 {
        if self.muted {
            return 0.0;
        }
        self.master
            * match c {
                AudioCategory::Sfx => self.sfx,
                AudioCategory::Music => self.music,
                AudioCategory::Ambience => self.ambience,
                AudioCategory::Ui => self.ui,
            }
    }
}

/// Named sounds with random variants: `load(server, dir, "shot", &["audio/shot1.ogg", …])`.
/// Missing files are skipped (games must not crash without audio assets).
#[derive(Resource, Clone, Debug, Default)]
pub struct SoundLibrary(pub std::collections::HashMap<&'static str, Vec<Handle<AudioSource>>>);

impl SoundLibrary {
    pub fn has(&self, name: &str) -> bool {
        self.0.get(name).is_some_and(|v| !v.is_empty())
    }
}

/// Play `name` once (random variant, slight pitch/volume jitter). `at = Some(pos)` → spatial.
pub fn play(commands: &mut Commands, lib: &SoundLibrary, vol: &Volumes, name: &str, category: AudioCategory, volume: f32, at: Option<Vec3>) {
    let _ = (commands, lib, vol, name, category, volume, at);
    todo!("core stream")
}

pub struct EngineAudioPlugin;

impl Plugin for EngineAudioPlugin {
    fn build(&self, app: &mut App) {
        let _ = app;
        todo!("core stream")
    }
}
