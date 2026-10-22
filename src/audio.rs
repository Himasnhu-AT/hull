//! Audio categories, volumes from settings, a named sound library with variants, play helpers.
//! Owner: core stream (generic parts of Shroud `audio.rs`; game-specific sounds stay in the
//! game). `--headless`, `--mute` and test-driven runs are silent unless `--sound` (headless is
//! always silent); `--volume <v>` overrides master.
//!
//! ```ignore
//! fn load(mut lib: ResMut<SoundLibrary>, server: Res<AssetServer>, dir: Res<AssetsDir>) {
//!     lib.load(&server, &dir, "pickup", &["audio/pickup_0.ogg", "audio/pickup_1.ogg"]);
//! }
//! fn on_pickup(mut c: Commands, lib: Res<SoundLibrary>, vol: Res<Volumes>) {
//!     audio::play(&mut c, &lib, &vol, "pickup", AudioCategory::Sfx, 0.8, None);
//! }
//! ```
//! Looping sounds: [`play_loop`] spawns a sink tagged with its [`AudioCategory`] and
//! [`SinkGain`]; the engine re-volumes it live when settings change.

use bevy::audio::{AudioSinkPlayback, PlaybackSettings, SpatialListener, Volume};
use bevy::prelude::*;
use rand::Rng;

use crate::flow::Headless;
use crate::gfx::MainCamera;
use crate::paths::AssetsDir;
use crate::settings::CoreSettings;

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

/// `--volume <v>`: wins over the saved master volume.
#[derive(Resource, Clone, Copy, Debug, Default)]
pub struct VolumeOverride(pub Option<f32>);

/// Per-sink volume multiplier for live re-volume (`final = SinkGain × Volumes::gain(category)`).
#[derive(Component, Clone, Copy, Debug)]
pub struct SinkGain(pub f32);

impl Default for SinkGain {
    fn default() -> Self {
        SinkGain(1.0)
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

    /// Register `name` with every file in `paths` (relative to the assets dir) that exists.
    /// Returns how many were found.
    pub fn load(&mut self, server: &AssetServer, dir: &AssetsDir, name: &'static str, paths: &[&str]) -> usize {
        let list = self.0.entry(name).or_default();
        for p in paths {
            if dir.has(p) {
                list.push(server.load(p.to_string()));
            }
        }
        list.len()
    }

    /// Shroud's convention: `<base>.ogg` when `n == 1`, else `<base>_0.ogg … <base>_{n-1}.ogg`.
    pub fn load_variants(&mut self, server: &AssetServer, dir: &AssetsDir, name: &'static str, base: &str, n: usize) -> usize {
        let paths: Vec<String> = if n <= 1 { vec![format!("{base}.ogg")] } else { (0..n).map(|i| format!("{base}_{i}.ogg")).collect() };
        let refs: Vec<&str> = paths.iter().map(String::as_str).collect();
        self.load(server, dir, name, &refs)
    }

    /// A random variant of `name`.
    pub fn pick(&self, name: &str) -> Option<Handle<AudioSource>> {
        let list = self.0.get(name).filter(|l| !l.is_empty())?;
        Some(list[rand::rng().random_range(0..list.len())].clone())
    }
}

/// Play `name` once (random variant, slight pitch/volume jitter). `at = Some(pos)` → spatial.
/// Silent when muted or when the sound has no files.
pub fn play(commands: &mut Commands, lib: &SoundLibrary, vol: &Volumes, name: &str, category: AudioCategory, volume: f32, at: Option<Vec3>) {
    if vol.muted {
        return;
    }
    let Some(handle) = lib.pick(name) else { return };
    let mut rng = rand::rng();
    let speed = rng.random_range(0.93..1.07);
    let gain = volume * rng.random_range(0.88..1.0) * vol.gain(category);
    let mut settings = PlaybackSettings::DESPAWN.with_volume(Volume::Linear(gain)).with_speed(speed);
    match at {
        Some(p) => {
            settings = settings.with_spatial(true);
            commands.spawn((AudioPlayer::new(handle), settings, category, Transform::from_translation(p)));
        }
        None => {
            commands.spawn((AudioPlayer::new(handle), settings, category));
        }
    }
}

/// Start a looping sound (music, ambience). Kept at `volume × Volumes::gain(category)` as
/// settings change. `None` when muted (test runs never open a sink).
pub fn play_loop(commands: &mut Commands, vol: &Volumes, handle: Handle<AudioSource>, category: AudioCategory, volume: f32) -> Option<Entity> {
    if vol.muted {
        return None;
    }
    let settings = PlaybackSettings::LOOP.with_volume(Volume::Linear(volume * vol.gain(category)));
    Some(commands.spawn((AudioPlayer::new(handle), settings, category, SinkGain(volume))).id())
}

pub struct EngineAudioPlugin;

impl Plugin for EngineAudioPlugin {
    fn build(&self, app: &mut App) {
        let headless = app.world().get_resource::<Headless>().is_some_and(|h| h.0);
        let quiet = crate::cli::dev_flag("mute") || (crate::cli::test_driven() && !crate::cli::dev_flag("sound"));
        let cli = crate::cli::dev_value("volume").and_then(|v| v.parse::<f32>().ok()).map(|v| v.clamp(0.0, 1.0));
        let muted = headless || quiet;
        app.insert_resource(Volumes { muted, ..default() })
            .insert_resource(VolumeOverride(cli))
            .init_resource::<SoundLibrary>()
            .add_systems(PreUpdate, sync_volumes);
        if muted {
            return;
        }
        app.add_systems(Update, (attach_listener, revolume_sinks));
    }
}

fn sync_volumes(settings: Res<CoreSettings>, cli: Res<VolumeOverride>, mut v: ResMut<Volumes>) {
    let want = Volumes {
        master: cli.0.unwrap_or(settings.master_volume),
        sfx: settings.sfx_volume,
        music: settings.music_volume,
        ambience: settings.ambience_volume,
        ui: settings.ui_volume,
        muted: v.muted,
    };
    let same = (want.master, want.sfx, want.music, want.ambience, want.ui) == (v.master, v.sfx, v.music, v.ambience, v.ui);
    if !same {
        *v = want;
    }
}

fn revolume_sinks(
    v: Res<Volumes>,
    mut sinks: Query<(&mut AudioSink, &AudioCategory, &SinkGain)>,
    mut spatial: Query<(&mut SpatialAudioSink, &AudioCategory, &SinkGain)>,
) {
    if !v.is_changed() {
        return;
    }
    for (mut s, c, g) in &mut sinks {
        s.set_volume(Volume::Linear(g.0 * v.gain(*c)));
    }
    for (mut s, c, g) in &mut spatial {
        s.set_volume(Volume::Linear(g.0 * v.gain(*c)));
    }
}

fn attach_listener(mut commands: Commands, cams: Query<Entity, (With<MainCamera>, Without<SpatialListener>)>) {
    for e in &cams {
        // Narrow ear gap: world units are metres, so the default 4.0 would over-pan.
        commands.entity(e).insert(SpatialListener::new(0.4));
    }
}
