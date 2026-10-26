//! # sound — a code-first audio middleware (Wwise/FMOD-lite) on Bevy's audio output
//!
//! ```text
//!  SoundCtl::play("cue") ─▶ Voices (cooldown, instance limits, voice limit + stealing,
//!       zones ─┐            distance culling, virtual voices, 3D, occlusion, captions)
//!  Music ──────┤                │ only changed params
//!  Mixer ──────┘ buses/snapshots/ducking ─▶ SoundBackend ─▶ dsp::Renderer (audio thread)
//!                                                         voices → bus tree → reverb → master
//! ```
//! Everything above the backend is plain logic, testable headless with `App::update()`; the
//! renderer is the same code online (one rodio source into Bevy's output) or offline (tests:
//! `SoundConfig { offline: true, .. }`, then inspect [`SoundBackend::capture`] / meters).
//!
//! ```ignore
//! fn setup(mut cues: ResMut<SoundCues>, mut clips: ResMut<Assets<SoundClip>>, server: Res<AssetServer>) {
//!     cues.add(SoundCue::new("pickup").clip(server.load("audio/pickup.wav")).pitch_jitter(1.0));
//!     cues.add(SoundCue::new("beep").clip(clips.add(synth::blip(880.0, 0.1))).bus("ui"));
//! }
//! fn on_pickup(mut ctl: ResMut<SoundCtl>) { ctl.play_at("pickup", Vec3::new(3.0, 0.0, -2.0)); }
//! ```
//! Docs: `docs/SOUND.md` (API, control commands, measurements, limits).

pub mod backend;
pub mod bus;
pub mod captions;
pub mod clip;
#[cfg(feature = "devtools")]
pub mod control;
pub mod cue;
pub mod dsp;
pub mod legacy;
pub mod music;
pub mod settings;
pub mod spatial;
pub mod voice;
pub mod zone;

use std::borrow::Cow;

use bevy::audio::{AddAudioSource, AudioPlayer, PlaybackSettings};
use bevy::ecs::system::SystemParam;
use bevy::prelude::*;
use bevy::transform::TransformSystems;
use serde::Serialize;

pub use backend::{BackendKind, SoundBackend};
pub use bus::{Bus, BusId, BusOverride, DuckRule, MixSnapshot, Mixer, db_to_lin, lin_to_db};
pub use captions::{CaptionLine, Captions};
pub use clip::{SoundClip, SoundClipLoader, synth};
pub use cue::{Attenuation, Caption, CaptionKind, CueId, Pick, Rolloff, SoundCue, SoundCues, Steal};
pub use dsp::ReverbParams;
pub use music::{Music, MusicBeat, MusicPosition, MusicStem, MusicTrack, MusicTransition, Quantize};
pub use settings::{CaptionSize, SoundSettings};
pub use spatial::{Listener, SoundListener, SoundOcclusionIgnore, SpatialCfg};
pub use voice::{Outcome, PlayParams, SoundCtl, VoiceId, VoiceInfo, VoiceState, Voices};
pub use zone::{SoundZone, ZoneShape};

use crate::audio::Volumes;
use dsp::MixStream;
use voice::Cx;

/// Budgets and global knobs. Insert your own before the first frame (`Startup` reads
/// `offline` / `sample_rate`); the rest is read live.
#[derive(Resource, Clone, Debug)]
pub struct SoundConfig {
    /// Real (rendered) voices at once; more go virtual or are culled by score.
    pub max_voices: usize,
    /// Below this (as heard, dB) a sound isn't rendered.
    pub cull_db: f32,
    pub sample_rate: u32,
    /// Seconds a voice waits for its clip to load before it's dropped.
    pub load_timeout: f32,
    pub spatial: SpatialCfg,
    /// Occlusion raycasts per frame (round-robin; 0 disables occlusion).
    pub occlusion_rays_per_frame: usize,
    /// Gain of a fully occluded source.
    pub occlusion_db: f32,
    /// Low-pass of a fully occluded source.
    pub occlusion_lowpass_hz: f32,
    /// How fast occlusion follows its target (1/s).
    pub occlusion_speed: f32,
    /// A voice louder than this (as heard) makes its bus "active" for ducking.
    pub duck_trigger_db: f32,
    /// Snapshot turned on while the game is paused (`None`: none).
    pub pause_snapshot: Option<Cow<'static, str>>,
    /// Render on the main thread, `dt` per frame, instead of a device (tests, captures).
    pub offline: bool,
    /// Offline only: seconds of output kept in [`SoundBackend::capture`].
    pub capture_secs: f32,
    /// Gain of the device stream after the mixer (`--mute-output` sets 0: the whole DSP runs
    /// against the real device, silently — for measuring without making noise).
    pub device_volume: f32,
}

impl Default for SoundConfig {
    fn default() -> Self {
        SoundConfig {
            max_voices: 48,
            cull_db: -60.0,
            sample_rate: 48_000,
            load_timeout: 5.0,
            spatial: SpatialCfg::default(),
            occlusion_rays_per_frame: 8,
            occlusion_db: -9.0,
            occlusion_lowpass_hz: 1_200.0,
            occlusion_speed: 6.0,
            duck_trigger_db: -40.0,
            pause_snapshot: Some(Cow::Borrowed("paused")),
            offline: false,
            capture_secs: 0.0,
            device_volume: 1.0,
        }
    }
}

/// Counters (totals since start) and current voice counts.
#[derive(Resource, Clone, Debug, Default, Serialize)]
pub struct SoundStats {
    /// Rendered voices now.
    pub active: usize,
    pub virtual_voices: usize,
    /// Loading or delayed.
    pub pending: usize,
    pub stopping: usize,
    pub music_voices: usize,
    pub peak_active: usize,
    pub started: u64,
    /// Virtual voices that became real again.
    pub revived: u64,
    /// One-shots never started because inaudible.
    pub culled: u64,
    /// Voices stopped/virtualised to make room (instance or global limit).
    pub stolen: u64,
    /// One-shots dropped because the voice limit was full of higher-scored voices.
    pub voice_limited: u64,
    /// Real voices that went virtual (became inaudible).
    pub virtualized: u64,
    pub rejected_cooldown: u64,
    pub rejected_instances: u64,
    /// Voices the renderer holds (incl. music and fading ones).
    pub renderer_voices: u32,
    /// Share of real time spent rendering (device/offline).
    pub dsp_load: f32,
    pub backend: &'static str,
    pub clock_secs: f64,
    /// Peak meter per bus (decaying hold, linear).
    #[serde(skip)]
    pub meters: Vec<f32>,
}

/// `PostUpdate` order: gather inputs → voices + music → mixer + backend.
#[derive(SystemSet, Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SoundSet {
    Gather,
    Voices,
    Mix,
}

/// Bevy's `AudioPlugin` was present at build time (a device stream can be opened).
#[derive(Resource)]
struct DeviceAudio;

pub struct SoundPlugin;

impl Plugin for SoundPlugin {
    fn build(&self, app: &mut App) {
        if !app.world().contains_resource::<SoundConfig>() {
            app.init_resource::<SoundConfig>();
        }
        let rate = app.world().resource::<SoundConfig>().sample_rate;
        let seed = app.world().get_resource::<crate::cli::GameSeed>().map_or(1, |s| s.0);
        app.init_asset::<SoundClip>()
            .init_asset_loader::<SoundClipLoader>()
            .init_resource::<Mixer>()
            .init_resource::<SoundCues>()
            .init_resource::<SoundCtl>()
            .insert_resource(Voices { rng: cue::Rng32::new(seed), ..default() })
            .init_resource::<Music>()
            .init_resource::<Captions>()
            .init_resource::<SoundStats>()
            .init_resource::<legacy::LegacyClips>()
            .insert_resource(SoundBackend::new(rate))
            .add_message::<MusicBeat>()
            .configure_sets(PostUpdate, (SoundSet::Gather, SoundSet::Voices, SoundSet::Mix).chain().after(TransformSystems::Propagate))
            .add_systems(Startup, init_backend)
            .add_systems(
                PostUpdate,
                (
                    (sync_bus_volumes, pause_snapshot, spatial::update_listener, zone::update_zones, legacy::sync_loops).in_set(SoundSet::Gather),
                    (run_voices, run_music).chain().in_set(SoundSet::Voices),
                    (run_mixer, backend_frame, captions::tick_captions).chain().in_set(SoundSet::Mix),
                ),
            )
            .add_systems(Update, captions::captions_ui.run_if(resource_exists::<crate::ui::theme::Theme>));
        #[cfg(feature = "physics")]
        app.add_systems(
            PostUpdate,
            spatial::occlusion_rays.in_set(SoundSet::Voices).before(run_voices).run_if(resource_exists::<avian3d::collider_tree::ColliderTrees>),
        );
        settings::build(app);
        if app.is_plugin_added::<bevy::audio::AudioPlugin>() {
            app.add_audio_source::<MixStream>().insert_resource(DeviceAudio);
        }
        #[cfg(feature = "devtools")]
        control::register(app);
    }
}

fn init_backend(world: &mut World) {
    let cfg = world.resource::<SoundConfig>().clone();
    let muted = world.get_resource::<Volumes>().is_some_and(|v| v.muted);
    let capacity = cfg.max_voices * 2 + 32;
    let mut backend = SoundBackend::new(cfg.sample_rate);
    if cfg.offline {
        backend.start_offline(capacity, cfg.capture_secs);
    } else if world.contains_resource::<DeviceAudio>() && !muted {
        let stream = backend.device_stream(capacity);
        let h = world.resource_mut::<Assets<MixStream>>().add(stream);
        let gain = if crate::cli::dev_flag("mute-output") { 0.0 } else { cfg.device_volume };
        world.spawn((Name::new("Sound mixer"), AudioPlayer::<MixStream>(h), PlaybackSettings::ONCE.with_volume(bevy::audio::Volume::Linear(gain))));
    }
    world.insert_resource(backend);
}

fn sync_bus_volumes(vol: Res<Volumes>, settings: Res<SoundSettings>, mut mixer: ResMut<Mixer>, mut first: Local<bool>) {
    if *first && !vol.is_changed() && !settings.is_changed() {
        return;
    }
    *first = true;
    let m = &mut *mixer;
    m.set_volume(BusId::MASTER, vol.master);
    m.set_volume(BusId::MUSIC, vol.music);
    m.set_volume(BusId::SFX, vol.sfx);
    m.set_volume(BusId::AMBIENCE, vol.ambience);
    m.set_volume(BusId::UI, vol.ui);
    m.set_volume(BusId::VOICE, settings.voice_volume);
}

fn pause_snapshot(paused: Option<Res<crate::pause::Paused>>, cfg: Res<SoundConfig>, mut mixer: ResMut<Mixer>, mut last: Local<bool>) {
    let (Some(p), Some(name)) = (paused, cfg.pause_snapshot.as_deref()) else { return };
    if p.0 != *last {
        *last = p.0;
        mixer.set_snapshot(name, p.0);
    }
}

/// The resources a voice update touches.
#[derive(SystemParam)]
pub struct VoiceSys<'w, 's> {
    time: Res<'w, Time<Real>>,
    voices: ResMut<'w, Voices>,
    ctl: ResMut<'w, SoundCtl>,
    cues: ResMut<'w, SoundCues>,
    mixer: ResMut<'w, Mixer>,
    clips: Res<'w, Assets<SoundClip>>,
    backend: ResMut<'w, SoundBackend>,
    captions: ResMut<'w, Captions>,
    stats: ResMut<'w, SoundStats>,
    cfg: Res<'w, SoundConfig>,
    tfs: Query<'w, 's, &'static GlobalTransform>,
    ents: Query<'w, 's, Entity>,
}

impl VoiceSys<'_, '_> {
    fn run(&mut self, update: bool) {
        if self.voices.is_empty() && self.ctl.queue.is_empty() {
            return;
        }
        let now = self.time.elapsed_secs_f64();
        let dt = self.time.delta_secs();
        let tfs = &self.tfs;
        let ents = &self.ents;
        let pos_of = |e: Entity| tfs.get(e).ok().map(|t| t.translation());
        let alive = |e: Entity| ents.contains(e);
        let mut cx = Cx {
            cues: &mut self.cues,
            mixer: &mut self.mixer,
            clips: &self.clips,
            backend: &mut self.backend,
            captions: &mut self.captions,
            stats: &mut self.stats,
            cfg: &self.cfg,
            now,
        };
        self.voices.apply_ctl(&mut self.ctl, &mut cx, &pos_of);
        if update {
            self.voices.update(dt, &mut cx, &pos_of, &alive);
        }
    }
}

fn run_voices(mut s: VoiceSys) {
    s.run(true);
}

/// Resolve queued [`SoundCtl`] requests now instead of in `PostUpdate`
/// (`world.run_system_cached(apply_requests)`; control commands answer with the outcome).
pub fn apply_requests(mut s: VoiceSys) {
    s.run(false);
}

fn run_music(
    time: Res<Time<Real>>,
    mut music: ResMut<Music>,
    mut backend: ResMut<SoundBackend>,
    mixer: Res<Mixer>,
    clips: Res<Assets<SoundClip>>,
    mut out: MessageWriter<MusicBeat>,
    mut beats: Local<Vec<MusicBeat>>,
) {
    if music.idle() {
        return;
    }
    music.update(time.delta_secs(), &mut backend, &mixer, &clips, &mut beats);
    for b in beats.drain(..) {
        out.write(b);
    }
}

fn run_mixer(time: Res<Time<Real>>, mut mixer: ResMut<Mixer>, mut backend: ResMut<SoundBackend>, mut sent: Local<Vec<(f32, f32, f32)>>, mut reverb: Local<Option<ReverbParams>>) {
    let changed = mixer.update(time.delta_secs());
    if backend.sent_topology != mixer.topology {
        backend.sent_topology = mixer.topology;
        let parents = mixer.buses().iter().map(|b| b.parent.map_or(u16::MAX, |p| p.0)).collect();
        backend.push(dsp::Cmd::Topology(parents));
        sent.clear();
    }
    if !changed && !sent.is_empty() {
        return;
    }
    sent.resize(mixer.buses().len(), (-1.0, -1.0, -1.0));
    for (i, b) in mixer.buses().iter().enumerate() {
        let now = (b.local_gain, b.lowpass_hz, b.reverb_send);
        if sent[i] != now {
            sent[i] = now;
            backend.push(dsp::Cmd::Bus { idx: i as u16, gain: now.0, lowpass: now.1, reverb: now.2 });
        }
    }
    if *reverb != Some(mixer.reverb) {
        *reverb = Some(mixer.reverb);
        backend.push(dsp::Cmd::Reverb(mixer.reverb));
    }
}

fn backend_frame(time: Res<Time<Real>>, mut backend: ResMut<SoundBackend>, mut stats: ResMut<SoundStats>, voices: Res<Voices>, music: Res<Music>, mixer: Res<Mixer>) {
    backend.frame(time.delta_secs());
    let s = &mut *stats;
    voices.count(s);
    s.music_voices = music.voice_count();
    s.backend = backend.kind().as_str();
    s.clock_secs = backend.clock_secs();
    if backend.active() {
        s.dsp_load = backend.dsp_load;
        s.renderer_voices = backend.shared.live_voices.load(std::sync::atomic::Ordering::Relaxed);
        s.meters.resize(mixer.buses().len(), 0.0);
        for (i, m) in s.meters.iter_mut().enumerate() {
            *m = backend.take_peak(i).max(*m * 0.9);
        }
    }
}
