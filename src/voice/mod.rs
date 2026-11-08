//! Voice chat for co-op sessions (docs/VOICE.md, feature `voice`).
//!
//! ```text
//! mic (cpal thread) ─▶ 16 kHz mono ─▶ 20 ms frames ─▶ gate (push-to-talk / open mic)
//!     ─▶ IMA ADPCM (164 B) ─▶ VoiceFrame, unreliable net message ─▶ host hub ─▶ jitter buffer per talker
//!     ─▶ per-talker gain (proximity) ─▶ mix ─▶ rodio source on Bevy audio ─▶ speakers; sfx/ambience ducked
//! ```
//!
//! Add [`VoicePlugin`] to a game that uses `engine::net` (a session or any host/connect). Capture
//! runs only while at least one other peer is connected. Push-to-talk is the `voice.talk` action
//! (V / left trigger).
//!
//! Extension points: [`VoiceSettings`] (persisted, shown on the Audio tab), [`VoiceTalker`] +
//! [`VoiceProximity`] (distance attenuation against the sound listener), [`VoiceTalkerGains`]
//! (write your own per-talker gains, e.g. radio vs. in-person), [`VoiceState`] (mic level,
//! transmitting, who talks: for HUD indicators), the `voice_chat` mix snapshot, and the
//! `--voice-test` / `voice.source` test sources (no microphone needed).

pub mod adpcm;
pub mod capture;
pub mod dsp;
pub mod jitter;
pub mod net;
pub mod playback;

use std::sync::Arc;

use bevy::audio::{AddAudioSource, AudioPlayer, PlaybackSettings};
use bevy::prelude::*;
use serde::{Deserialize, Serialize};

use crate::actions::{ActionDef, ActionState, AddAction, Binding};
use crate::net::{Channel, NetAppExt, NetClient, NetRole, NetServer};
use crate::settings::{FieldDef, FieldKind, RegisterSettings, add_settings_section};
use crate::sound::{Attenuation, BackendKind, MixSnapshot, Mixer, SoundBackend, SoundListener};

use adpcm::{Encoder, FRAME, FRAME_BYTES};
use capture::{Capture, MicStatus};
use dsp::{Gate, SignalGen, level_db};
use jitter::JitterConfig;
use net::{VoiceFrame, VoiceInbox, VoiceNetStats, VoiceOutbox};
use playback::{PlayShared, PlayoutEngine, TalkerStatus, VoiceStream};

/// Action name for push-to-talk.
pub const TALK_ACTION: &str = "voice.talk";
/// Mix snapshot active while someone else talks (ducks sfx and ambience).
pub const DUCK_SNAPSHOT: &str = "voice_chat";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum TalkMode {
    /// Transmit when the voice gate opens (or push-to-talk is held).
    #[default]
    OpenMic,
    PushToTalk,
}

impl TalkMode {
    pub const ALL: [TalkMode; 2] = [Self::OpenMic, Self::PushToTalk];
}

/// Persisted as section `"voice"` of settings.json; rows on the "Audio" tab.
#[derive(Resource, Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct VoiceSettings {
    pub enabled: bool,
    /// Linear, multiplied by the voice bus gain.
    pub volume: f32,
    pub mode: TalkMode,
    /// Open mic opens above this level (dBFS) and 10 dB over the noise floor.
    pub open_mic_threshold_db: f32,
    /// Input device name; empty = the system default.
    pub input_device: String,
    /// How far sfx drops while someone talks; ambience 2 dB more.
    pub duck_db: f32,
}

impl Default for VoiceSettings {
    fn default() -> Self {
        VoiceSettings { enabled: true, volume: 1.0, mode: TalkMode::OpenMic, open_mic_threshold_db: -45.0, input_device: String::new(), duck_db: 4.0 }
    }
}

/// Marks the entity that is the avatar of talker `0` (the `ClientId` of the player who speaks
/// through it; the host is 0). [`VoiceProximity`] measures distance to it.
#[derive(Component, Clone, Copy, Debug, PartialEq, Eq)]
pub struct VoiceTalker(pub u32);

/// Distance attenuation of remote voices against the sound listener (`SoundListener`, else a
/// camera). Off by default (everyone is heard at full volume, e.g. a radio channel).
#[derive(Resource, Clone, Debug)]
pub struct VoiceProximity {
    pub enabled: bool,
    pub attenuation: Attenuation,
}

impl Default for VoiceProximity {
    fn default() -> Self {
        VoiceProximity { enabled: false, attenuation: Attenuation { min_distance: 4.0, max_distance: 40.0, ..default() } }
    }
}

/// Per-talker gain handed to the playout every frame. [`VoiceProximity`] fills it; with
/// proximity off, write it yourself (talkers not listed play at 1).
#[derive(Resource, Default, Clone, Debug)]
pub struct VoiceTalkerGains(pub Vec<(u32, f32)>);

/// Live voice state (inspect with `voice.status`).
#[derive(Resource)]
pub struct VoiceState {
    /// In a session with at least one other peer: capture and playback are on.
    pub active: bool,
    pub talker: Option<u32>,
    pub mode: TalkMode,
    pub mic_status: MicStatus,
    pub mic_device: String,
    /// Meter level (dBFS, fast attack / slow release).
    pub mic_level_db: f32,
    /// Sending frames right now.
    pub transmitting: bool,
    /// Forced push-to-talk (control port / tests).
    pub force_talk: Option<bool>,
    /// Remote talkers as the playout last reported them.
    pub talkers: Vec<TalkerStatus>,
    /// Someone else is talking (with a short hold), drives the duck and indicators.
    pub remote_talking: bool,
    /// Frames produced by the microphone / test source.
    pub frames_captured: u64,
    /// Playout ran on the audio device (else on the main thread).
    pub device_playout: bool,

    capture: Option<Capture>,
    test: Option<SignalGen>,
    test_spec: Option<String>,
    test_debt: f64,
    pending: Vec<i16>,
    encoder: Encoder,
    gate: Gate,
    /// Last two encoded frames, sent ahead of the first loud frame so syllables aren't cut.
    preroll: [(u32, [u8; FRAME_BYTES]); 2],
    preroll_len: usize,
    ts: u32,
    seq: u32,
    warned_silent: bool,
    remote_hold: f32,
    shared: Arc<PlayShared>,
    /// Main-thread playout when there is no device.
    local: Option<PlayoutEngine>,
    local_debt: f64,
    /// Headless playout output, kept when `keep_output` is on (tests).
    pub keep_output: bool,
    pub output: Vec<f32>,
}

impl Default for VoiceState {
    fn default() -> Self {
        let shared = Arc::new(PlayShared::default());
        VoiceState {
            active: false,
            talker: None,
            mode: TalkMode::OpenMic,
            mic_status: MicStatus::Off,
            mic_device: String::new(),
            mic_level_db: -100.0,
            transmitting: false,
            force_talk: None,
            talkers: Vec::with_capacity(playback::MAX_TALKERS),
            remote_talking: false,
            frames_captured: 0,
            device_playout: false,
            capture: None,
            test: None,
            test_spec: None,
            test_debt: 0.0,
            pending: Vec::with_capacity(4 * FRAME),
            encoder: Encoder::new(),
            gate: Gate::new(-45.0),
            preroll: [(0, [0; FRAME_BYTES]); 2],
            preroll_len: 0,
            ts: 0,
            seq: 0,
            warned_silent: false,
            remote_hold: 0.0,
            local: Some(PlayoutEngine::new(shared.clone(), JitterConfig::default())),
            shared,
            local_debt: 0.0,
            keep_output: false,
            output: Vec::new(),
        }
    }
}

impl VoiceState {
    /// Use a generated signal / file instead of the microphone (`None`: back to the mic).
    pub fn set_test_source(&mut self, spec: Option<&str>) -> Result<(), String> {
        match spec {
            Some(s) => {
                self.test = Some(SignalGen::parse(s)?);
                self.test_spec = Some(s.to_string());
                self.capture = None;
            }
            None => {
                self.test = None;
                self.test_spec = None;
            }
        }
        self.test_debt = 0.0;
        Ok(())
    }

    pub fn test_source(&self) -> Option<&str> {
        self.test_spec.as_deref()
    }

    pub fn sent_frames(&self) -> u32 {
        self.seq
    }
}

pub struct VoicePlugin;

impl Plugin for VoicePlugin {
    fn build(&self, app: &mut App) {
        app.add_net_message::<VoiceFrame>(Channel::Unreliable)
            .init_resource::<VoiceState>()
            .init_resource::<VoiceOutbox>()
            .init_resource::<VoiceInbox>()
            .init_resource::<VoiceNetStats>()
            .init_resource::<VoiceProximity>()
            .init_resource::<VoiceTalkerGains>()
            .init_resource::<VoiceSettings>()
            .add_action(
                ActionDef::button(TALK_ACTION)
                    .label("Push to talk")
                    .group("Voice")
                    .context("global")
                    .passthrough()
                    .bind(Binding::key(KeyCode::KeyV))
                    .bind(Binding::pad(GamepadButton::LeftTrigger)),
            );
        add_settings_section::<VoiceSettings>(app, "voice");
        register_settings(app);
        let headless = app.world().get_resource::<crate::flow::Headless>().is_some_and(|h| h.0);
        app.insert_resource(MicBlocked(mic_blocked(headless, crate::cli::dev_flag("mute"), crate::cli::test_driven(), crate::cli::dev_flag("mic"))));
        if let Some(mut mixer) = app.world_mut().get_resource_mut::<Mixer>() {
            mixer.add_snapshot(duck_snapshot(VoiceSettings::default().duck_db));
        }
        if app.is_plugin_added::<bevy::audio::AudioPlugin>() {
            app.add_audio_source::<VoiceStream>();
            app.add_systems(PostStartup, start_device_playout);
        }
        if let Some(spec) = crate::cli::arg_value("voice-test") {
            let mut st = app.world_mut().resource_mut::<VoiceState>();
            match st.set_test_source(Some(&spec)) {
                Ok(()) => info!("voice: test source \"{spec}\" instead of the microphone"),
                Err(e) => warn!("voice: --voice-test: {e}"),
            }
        }
        app.add_systems(Update, (track_session, capture_frames, net::send_frames, net::recv_frames, proximity, run_playout, duck).chain().in_set(VoiceSet));
        #[cfg(feature = "devtools")]
        control::register(app);
    }
}

/// The microphone must stay closed in this run (see [`mic_blocked`]).
#[derive(Resource, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MicBlocked(pub bool);

/// Never open the microphone in headless runs, with `--mute`, or in test-driven runs (control
/// port, `--offscreen`) unless `--mic` asks for it. The `--voice-test` source still works there.
pub fn mic_blocked(headless: bool, mute: bool, test_driven: bool, mic_flag: bool) -> bool {
    headless || mute || (test_driven && !mic_flag)
}

/// The voice systems (`Update`), in case others need to order against them.
#[derive(SystemSet, Debug, Clone, PartialEq, Eq, Hash)]
pub struct VoiceSet;

fn duck_snapshot(db: f32) -> MixSnapshot {
    MixSnapshot::new(DUCK_SNAPSHOT).volume("sfx", -db.abs()).volume("ambience", -db.abs() - 2.0).fades(0.12, 0.7)
}

fn vs(w: &World) -> &VoiceSettings {
    w.resource::<VoiceSettings>()
}
fn vs_mut(w: &mut World) -> Mut<'_, VoiceSettings> {
    w.resource_mut::<VoiceSettings>()
}

fn register_settings(app: &mut App) {
    app.register_setting(FieldDef {
        key: "voice_chat",
        tab: "Audio",
        label: "Voice chat",
        hint: "Talk to your friends over the microphone.",
        kind: FieldKind::Toggle,
        get: |w| vs(w).enabled as u8 as f32,
        set: |w, v| vs_mut(w).enabled = v > 0.5,
    })
    .register_setting(FieldDef {
        key: "voice_chat_volume",
        tab: "Audio",
        label: "Voice chat volume",
        hint: "How loud your friends are.",
        kind: FieldKind::Slider { min: 0.0, max: 1.5, step: 0.05, format: crate::settings::format_percent },
        get: |w| vs(w).volume,
        set: |w, v| vs_mut(w).volume = v.clamp(0.0, 1.5),
    })
    .register_setting(FieldDef {
        key: "voice_mode",
        tab: "Audio",
        label: "Talk mode",
        hint: "Open mic transmits when you speak; push-to-talk (V / LT) when you hold the key.",
        kind: FieldKind::Choice { options: vec!["Open mic", "Push to talk"] },
        get: |w| TalkMode::ALL.iter().position(|m| *m == vs(w).mode).unwrap_or(0) as f32,
        set: |w, v| vs_mut(w).mode = TalkMode::ALL[(v.round().max(0.0) as usize).min(1)],
    })
    .register_setting(FieldDef {
        key: "voice_threshold",
        tab: "Audio",
        label: "Open mic threshold",
        hint: "Lower picks up quieter speech (and more noise).",
        kind: FieldKind::Slider { min: -70.0, max: -20.0, step: 1.0, format: |v| format!("{v:.0} dB") },
        get: |w| vs(w).open_mic_threshold_db,
        set: |w, v| vs_mut(w).open_mic_threshold_db = v.clamp(-70.0, -20.0),
    });
}

/// With an audio device: move the playout onto the audio thread.
fn start_device_playout(world: &mut World) {
    if world.get_resource::<SoundBackend>().is_none_or(|b| b.kind() != BackendKind::Device) {
        return;
    }
    let mut st = world.resource_mut::<VoiceState>();
    let Some(engine) = st.local.take() else { return };
    st.device_playout = true;
    let h = world.resource_mut::<Assets<VoiceStream>>().add(VoiceStream::new(engine));
    world.spawn((Name::new("Voice chat"), AudioPlayer::<VoiceStream>(h), PlaybackSettings::ONCE));
}

#[allow(clippy::too_many_arguments)]
fn track_session(
    role: Res<NetRole>,
    server: Option<Res<NetServer>>,
    client: Option<Res<NetClient>>,
    settings: Res<VoiceSettings>,
    blocked: Option<Res<MicBlocked>>,
    mut st: ResMut<VoiceState>,
    mut mixer: Option<ResMut<Mixer>>,
) {
    let st = &mut *st;
    // Only with company: a lone host or a connecting client keeps the mic closed.
    st.active = match *role {
        NetRole::Offline => false,
        NetRole::Server | NetRole::ListenServer => server.as_deref().is_some_and(|s| !s.endpoint.is_empty()),
        NetRole::Client => client.as_deref().is_some_and(|c| c.id().is_some()),
    };
    st.talker = net::local_talker(*role, client.as_deref());
    st.mode = settings.mode;
    st.gate.threshold_db = settings.open_mic_threshold_db;
    if settings.is_changed()
        && let Some(m) = mixer.as_deref_mut()
    {
        m.add_snapshot(duck_snapshot(settings.duck_db));
    }
    let want_mic = settings.enabled && st.active && st.test.is_none() && !blocked.is_some_and(|b| b.0);
    if want_mic && st.capture.is_none() {
        let dev = Some(settings.input_device.clone()).filter(|d| !d.is_empty());
        st.capture = Some(Capture::start(dev));
        st.warned_silent = false;
    } else if !want_mic && st.capture.is_some() {
        st.capture = None;
    }
    st.mic_status = match &st.capture {
        Some(c) => c.status(),
        None if st.test.is_some() => MicStatus::Live,
        None => MicStatus::Off,
    };
    if let Some(c) = &st.capture {
        if st.mic_device.is_empty() {
            st.mic_device = c.device_name();
        }
    } else if st.test.is_none() {
        st.mic_device.clear();
    }
    if st.mic_status == MicStatus::Silent && !st.warned_silent {
        st.warned_silent = true;
        warn!(
            "voice: the microphone delivers only silence. On macOS, allow microphone access for this app (or the terminal it runs from) in System Settings > Privacy & Security > Microphone, then restart the game."
        );
    }
}

fn capture_frames(
    settings: Res<VoiceSettings>,
    actions: Option<Res<ActionState>>,
    time: Res<Time<Real>>,
    mut st: ResMut<VoiceState>,
    mut outbox: ResMut<VoiceOutbox>,
) {
    let st = &mut *st;
    let live = settings.enabled && (st.capture.is_some() || (st.test.is_some() && st.active));
    if !live {
        st.pending.clear();
        st.transmitting = false;
        st.mic_level_db = -100.0;
        return;
    }
    if let Some(c) = &st.capture {
        c.drain(&mut st.pending);
    } else if let Some(g) = &mut st.test {
        st.test_debt += time.delta_secs_f64() * f64::from(dsp::RATE);
        let n = st.test_debt.floor() as usize;
        st.test_debt -= n as f64;
        let start = st.pending.len();
        st.pending.resize(start + n, 0);
        g.fill(&mut st.pending[start..]);
    }
    let ptt = st.force_talk.unwrap_or_else(|| actions.is_some_and(|a| a.pressed(TALK_ACTION)));
    let mut frame = [0i16; FRAME];
    let mut bytes = [0u8; FRAME_BYTES];
    let mut used = 0;
    while st.pending.len() - used >= FRAME {
        frame.copy_from_slice(&st.pending[used..used + FRAME]);
        used += FRAME;
        st.frames_captured += 1;
        let lvl = level_db(&frame);
        // Meter: instant attack, ~12 dB/s release.
        st.mic_level_db = lvl.max(st.mic_level_db - 0.25);
        let gate_open = st.gate.update(lvl);
        let tx = match st.mode {
            TalkMode::PushToTalk => ptt,
            TalkMode::OpenMic => gate_open || ptt,
        };
        st.encoder.encode(&frame, &mut bytes);
        let ts = st.ts;
        st.ts = st.ts.wrapping_add(1);
        if tx && st.talker.is_some() {
            let talker = st.talker.unwrap_or(0);
            // Open mic just opened: send the two frames before it first.
            if !st.transmitting && st.mode == TalkMode::OpenMic {
                for i in 0..st.preroll_len {
                    let (pts, pb) = st.preroll[i];
                    outbox.frames.push(VoiceFrame { talker, seq: st.seq, ts: pts, data: pb.to_vec() });
                    st.seq += 1;
                }
            }
            outbox.frames.push(VoiceFrame { talker, seq: st.seq, ts, data: bytes.to_vec() });
            st.seq += 1;
            st.preroll_len = 0;
        } else {
            st.preroll[0] = st.preroll[1];
            st.preroll[1] = (ts, bytes);
            st.preroll_len = (st.preroll_len + 1).min(2);
        }
        st.transmitting = tx;
    }
    st.pending.drain(..used);
    if used == 0 && st.mode == TalkMode::PushToTalk {
        st.transmitting = ptt;
    }
}

/// Distance attenuation per talker (when [`VoiceProximity`] is on).
fn proximity(
    prox: Res<VoiceProximity>,
    st: Res<VoiceState>,
    listener: Query<&GlobalTransform, With<SoundListener>>,
    camera: Query<&GlobalTransform, With<Camera3d>>,
    talkers: Query<(&VoiceTalker, &GlobalTransform)>,
    mut gains: ResMut<VoiceTalkerGains>,
) {
    if !prox.enabled {
        return;
    }
    let Some(at) = listener.iter().next().or_else(|| camera.iter().next()).map(GlobalTransform::translation) else { return };
    gains.0.clear();
    for (t, tf) in &talkers {
        if st.talker == Some(t.0) {
            continue;
        }
        gains.0.push((t.0, prox.attenuation.gain(at.distance(tf.translation()))));
    }
}

fn run_playout(
    settings: Res<VoiceSettings>,
    mixer: Option<Res<Mixer>>,
    time: Res<Time<Real>>,
    gains: Res<VoiceTalkerGains>,
    mut inbox: ResMut<VoiceInbox>,
    mut st: ResMut<VoiceState>,
) {
    let st = &mut *st;
    // On the device, voice follows the engine's "voice" bus (master x Dialogue volume, mute,
    // solo); the main-thread playout (headless, muted, tests) keeps the voice level alone so
    // its output can be checked.
    let master = match (&mixer, st.device_playout) {
        (Some(m), true) => m.effective_gain(crate::sound::BusId::VOICE),
        _ => 1.0,
    };
    let gain = if settings.enabled { settings.volume * master } else { 0.0 };
    st.shared.set_gain(gain);
    st.shared.set_talker_gains(&gains.0);
    for p in inbox.packets.drain(..) {
        if settings.enabled && st.active {
            st.shared.send(p);
        }
    }
    if let Some(local) = &mut st.local {
        // Main-thread playout: one 20 ms frame per 20 ms of real time.
        st.local_debt = (st.local_debt + time.delta_secs_f64() * 50.0).min(10.0);
        let mut out = [0.0f32; FRAME];
        while st.local_debt >= 1.0 {
            st.local_debt -= 1.0;
            local.render(&mut out);
            if st.keep_output {
                st.output.extend_from_slice(&out);
            }
        }
    }
    st.shared.status(&mut st.talkers);
    let talking = st.talkers.iter().any(|t| t.talking && t.level_db > -55.0);
    if talking {
        st.remote_hold = 0.25;
    } else {
        st.remote_hold = (st.remote_hold - time.delta_secs()).max(0.0);
    }
    st.remote_talking = talking || st.remote_hold > 0.0;
}

fn duck(st: Res<VoiceState>, mixer: Option<ResMut<Mixer>>, mut last: Local<bool>) {
    let Some(mut mixer) = mixer else { return };
    if st.remote_talking != *last {
        *last = st.remote_talking;
        mixer.set_snapshot(DUCK_SNAPSHOT, *last);
    }
}

#[cfg(feature = "devtools")]
mod control {
    use bevy::prelude::*;
    use serde_json::{Value, json};

    use super::{VoiceNetStats, VoiceSettings, VoiceState, net::VoiceInbox};
    use crate::devtools::{AddControlCommand, params};

    pub(super) fn register(app: &mut App) {
        app.add_control_command("voice.status", "Voice chat: mic, transmit, remote talkers, jitter stats", params(&[]), status)
            .add_control_command(
                "voice.talk",
                "Force push-to-talk on/off (null: back to the key)",
                params(&[("on", "boolean", "hold the talk button (null releases the override)")]),
                talk,
            )
            .add_control_command(
                "voice.source",
                "Feed a test signal instead of the mic: tone, tone:<hz>, talk, a WAV path, or null for the mic",
                params(&[("source", "string", "tone | tone:<hz> | talk | path.wav | null")]),
                source,
            );
    }

    fn status(w: &mut World, _: Value) -> Result<Value, String> {
        let st = w.resource::<VoiceState>();
        let set = w.resource::<VoiceSettings>();
        let net = *w.resource::<VoiceNetStats>();
        let inbox = w.resource::<VoiceInbox>();
        Ok(json!({
            "enabled": set.enabled,
            "active": st.active,
            "talker": st.talker,
            "mode": format!("{:?}", st.mode),
            "mic": { "status": st.mic_status.as_str(), "device": st.mic_device, "level_db": st.mic_level_db, "test_source": st.test_source() },
            "transmitting": st.transmitting,
            "frames_captured": st.frames_captured,
            "sent": net.sent, "relayed": net.relayed, "sent_bytes": net.sent_bytes,
            "received": inbox.received, "malformed": inbox.malformed,
            "remote_talking": st.remote_talking,
            "talkers": st.talkers,
            "device_playout": st.device_playout,
        }))
    }

    fn talk(w: &mut World, p: Value) -> Result<Value, String> {
        let on = p.get("on").and_then(Value::as_bool);
        w.resource_mut::<VoiceState>().force_talk = on;
        Ok(json!({ "force_talk": on }))
    }

    fn source(w: &mut World, p: Value) -> Result<Value, String> {
        let spec = p.get("source").and_then(Value::as_str).map(str::to_string);
        w.resource_mut::<VoiceState>().set_test_source(spec.as_deref())?;
        Ok(json!({ "source": spec }))
    }
}

#[cfg(test)]
mod mic_tests {
    use super::mic_blocked;

    #[test]
    fn the_mic_stays_closed_in_muted_headless_and_test_runs() {
        assert!(!mic_blocked(false, false, false, false), "a normal game run may open it");
        assert!(mic_blocked(true, false, false, false), "headless");
        assert!(mic_blocked(false, true, false, false), "--mute");
        assert!(mic_blocked(false, false, true, false), "control port / --offscreen");
        assert!(!mic_blocked(false, false, true, true), "--mic opts a test run in");
        assert!(mic_blocked(false, true, true, true), "--mute wins over --mic");
    }
}
