//! Voices: every playing (or waiting, or virtual) sound. Not entities — a flat list, so a
//! one-shot costs no archetype moves.
//!
//! Life of a voice: request ([`SoundCtl::play`]) → cooldown and per-cue instance limit
//! (stealing per [`Steal`]) → `Loading` (clip not loaded yet) / `Delayed` (cue delay) →
//! admission: inaudible one-shots are culled, inaudible loops go `Virtual`; above the global
//! limit the lowest-scored real voice (priority, then loudness as heard — so the farthest/
//! quietest) is stolen if the newcomer beats it. Virtual voices keep their clock and come
//! back (at the right offset) when audible and a slot frees up. Real voices send the backend
//! only parameters that changed.

use std::borrow::Cow;
use std::collections::VecDeque;

use bevy::prelude::*;

use super::backend::SoundBackend;
use super::bus::{BusId, Mixer, NO_LOWPASS, db_to_lin, lerp_hz};
use super::captions::Captions;
use super::clip::SoundClip;
use super::cue::{Attenuation, CueId, Rng32, SoundCues, Steal, pick_clip};
use super::dsp::{Cmd, VoiceParams};
use super::spatial::{Listener, spatialize};
use super::{SoundConfig, SoundStats};

/// Handle to a requested sound (valid even if it was culled; then it simply isn't found).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Default)]
pub struct VoiceId(pub u32);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VoiceState {
    /// Waiting for its clip to load.
    Loading,
    /// Waiting out the cue's delay.
    Delayed,
    /// Rendered.
    Playing,
    /// Tracked (clock running) but not rendered: inaudible or over the voice limit.
    Virtual,
    /// Fading out, then freed.
    Stopping,
}

impl VoiceState {
    pub fn as_str(self) -> &'static str {
        match self {
            VoiceState::Loading => "loading",
            VoiceState::Delayed => "delayed",
            VoiceState::Playing => "playing",
            VoiceState::Virtual => "virtual",
            VoiceState::Stopping => "stopping",
        }
    }
}

/// What happened to a play request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Playing,
    Virtual,
    Delayed,
    Loading,
    /// Inaudible (distance / bus volume) one-shot: never started.
    Culled,
    /// Global voice limit full of higher-scored voices.
    VoiceLimit,
    Cooldown,
    MaxInstances,
    UnknownCue,
    NoClips,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::Playing => "playing",
            Outcome::Virtual => "virtual",
            Outcome::Delayed => "delayed",
            Outcome::Loading => "loading",
            Outcome::Culled => "culled",
            Outcome::VoiceLimit => "voice_limit",
            Outcome::Cooldown => "cooldown",
            Outcome::MaxInstances => "max_instances",
            Outcome::UnknownCue => "unknown_cue",
            Outcome::NoClips => "no_clips",
        }
    }
    /// The voice exists (now or later).
    pub fn alive(self) -> bool {
        matches!(self, Outcome::Playing | Outcome::Virtual | Outcome::Delayed | Outcome::Loading)
    }
}

/// Per-request overrides.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PlayParams {
    /// World position (3D cues).
    pub at: Option<Vec3>,
    /// Follow this entity's `GlobalTransform` (3D cues); the voice stops (loops) or keeps its
    /// last position (one-shots) when it despawns.
    pub follow: Option<Entity>,
    /// Stop when this entity despawns.
    pub owner: Option<Entity>,
    /// Linear volume multiplier.
    pub volume: f32,
    /// Pitch ratio multiplier.
    pub pitch: f32,
}

impl Default for PlayParams {
    fn default() -> Self {
        PlayParams { at: None, follow: None, owner: None, volume: 1.0, pitch: 1.0 }
    }
}

#[derive(Clone, Debug)]
pub(crate) enum PlaySource {
    Cue(Cow<'static, str>),
    /// Ad-hoc clip (legacy `audio::play`), no cue rules.
    Clip { clip: Handle<SoundClip>, bus: BusId, looping: bool, spatial: Option<Attenuation> },
}

#[derive(Clone, Debug)]
pub(crate) enum Ctl {
    Play { id: u32, src: PlaySource, params: PlayParams },
    Stop { id: u32, fade: f32 },
    StopCue { name: Cow<'static, str>, fade: f32 },
    StopAll { fade: f32 },
    Volume { id: u32, volume: f32 },
}

/// Ask for sounds from any system: `ctl.play("ui.click")`, `ctl.play_at("boom", pos)`.
/// Requests resolve in `PostUpdate` the same frame.
#[derive(Resource, Debug)]
pub struct SoundCtl {
    next: u32,
    pub(crate) queue: Vec<Ctl>,
}

impl Default for SoundCtl {
    fn default() -> Self {
        SoundCtl { next: 1, queue: Vec::with_capacity(64) }
    }
}

/// Voice ids at or above this belong to the music player.
pub(crate) const MUSIC_IDS: u32 = 1 << 31;

impl SoundCtl {
    fn id(&mut self) -> u32 {
        let id = self.next;
        self.next = if self.next + 1 >= MUSIC_IDS { 1 } else { self.next + 1 };
        id
    }

    pub fn play(&mut self, cue: impl Into<Cow<'static, str>>) -> VoiceId {
        self.play_with(cue, PlayParams::default())
    }

    pub fn play_at(&mut self, cue: impl Into<Cow<'static, str>>, at: Vec3) -> VoiceId {
        self.play_with(cue, PlayParams { at: Some(at), ..default() })
    }

    /// 3D, following `entity`; stops with it.
    pub fn play_on(&mut self, cue: impl Into<Cow<'static, str>>, entity: Entity) -> VoiceId {
        self.play_with(cue, PlayParams { follow: Some(entity), owner: Some(entity), ..default() })
    }

    pub fn play_with(&mut self, cue: impl Into<Cow<'static, str>>, params: PlayParams) -> VoiceId {
        let id = self.id();
        self.queue.push(Ctl::Play { id, src: PlaySource::Cue(cue.into()), params });
        VoiceId(id)
    }

    pub(crate) fn play_clip(&mut self, clip: Handle<SoundClip>, bus: BusId, looping: bool, spatial: Option<Attenuation>, params: PlayParams) -> VoiceId {
        let id = self.id();
        self.queue.push(Ctl::Play { id, src: PlaySource::Clip { clip, bus, looping, spatial }, params });
        VoiceId(id)
    }

    /// Stop with a fade (seconds; 0 = a few ms de-click).
    pub fn stop(&mut self, v: VoiceId, fade: f32) {
        self.queue.push(Ctl::Stop { id: v.0, fade });
    }

    pub fn stop_cue(&mut self, cue: impl Into<Cow<'static, str>>, fade: f32) {
        self.queue.push(Ctl::StopCue { name: cue.into(), fade });
    }

    pub fn stop_all(&mut self, fade: f32) {
        self.queue.push(Ctl::StopAll { fade });
    }

    /// Live volume multiplier of a voice (e.g. ambience by zone weight).
    pub fn set_volume(&mut self, v: VoiceId, volume: f32) {
        self.queue.push(Ctl::Volume { id: v.0, volume });
    }
}

#[derive(Clone, Debug)]
pub(crate) struct Voice {
    pub(crate) id: u32,
    pub(crate) cue: Option<CueId>,
    clip: Handle<SoundClip>,
    clip_index: usize,
    pub(crate) bus: BusId,
    pub(crate) priority: u8,
    pub(crate) looping: bool,
    gain: f32,
    ext_volume: f32,
    pitch: f32,
    fade_in: f32,
    pub(crate) spatial: Option<Attenuation>,
    pub(crate) pos: Vec3,
    vel: Vec3,
    pub(crate) follow: Option<Entity>,
    owner: Option<Entity>,
    delay: f32,
    wait: f32,
    pub(crate) age: f32,
    duration: f32,
    clip_rate: u32,
    pub(crate) state: VoiceState,
    pub(crate) audible: f32,
    pub(crate) dist: f32,
    pub(crate) pan_x: f32,
    pub(crate) behind: f32,
    pub(crate) occl: f32,
    pub(crate) occl_target: f32,
    sent: VoiceParams,
    stop_left: f32,
    captioned: bool,
}

impl Voice {
    #[cfg_attr(not(feature = "physics"), allow(dead_code))]
    pub(crate) fn wants_occlusion(&self) -> bool {
        matches!(self.state, VoiceState::Playing | VoiceState::Virtual) && self.spatial.as_ref().is_some_and(|a| a.occlusion && a.spatial_blend > 0.0)
    }
}

/// Read-only view of a voice (stats, control port, tests).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VoiceInfo {
    pub id: VoiceId,
    pub cue: Option<CueId>,
    pub bus: BusId,
    pub state: VoiceState,
    pub priority: u8,
    /// Gain as heard (voice × attenuation × occlusion × buses).
    pub audible: f32,
    pub distance: f32,
    pub pan: f32,
    pub occlusion: f32,
    pub age: f32,
    pub looping: bool,
}

/// All voices + the listener.
#[derive(Resource, Debug, Default)]
pub struct Voices {
    pub(crate) list: Vec<Voice>,
    pub(crate) rng: Rng32,
    pub(crate) listener: Listener,
    #[cfg_attr(not(feature = "physics"), allow(dead_code))]
    pub(crate) ray_cursor: usize,
    pub(crate) recent: VecDeque<(u32, Outcome)>,
}

/// Everything a voice update touches.
pub(crate) struct Cx<'a> {
    pub cues: &'a mut SoundCues,
    pub mixer: &'a mut Mixer,
    pub clips: &'a Assets<SoundClip>,
    pub backend: &'a mut SoundBackend,
    pub captions: &'a mut Captions,
    pub stats: &'a mut SoundStats,
    pub cfg: &'a SoundConfig,
    /// Seconds (real time) since start.
    pub now: f64,
}

#[inline]
fn score(priority: u8, audible: f32) -> f32 {
    priority as f32 + audible.clamp(0.0, 1.0) * 0.999
}

fn semis(s: f32) -> f32 {
    2f32.powf(s / 12.0)
}

impl Voices {
    pub fn listener(&self) -> &Listener {
        &self.listener
    }

    pub fn get(&self, id: VoiceId) -> Option<VoiceInfo> {
        self.list.iter().find(|v| v.id == id.0).map(info)
    }

    pub fn iter(&self) -> impl Iterator<Item = VoiceInfo> + '_ {
        self.list.iter().map(info)
    }

    pub fn len(&self) -> usize {
        self.list.len()
    }

    pub fn is_empty(&self) -> bool {
        self.list.is_empty()
    }

    /// How the last requests with these ids resolved (kept for the last 64 requests).
    pub fn outcome(&self, id: VoiceId) -> Option<Outcome> {
        self.recent.iter().rev().find(|(i, _)| *i == id.0).map(|(_, o)| *o)
    }

    pub(crate) fn real_count(&self) -> usize {
        self.list.iter().filter(|v| v.state == VoiceState::Playing).count()
    }

    /// (real voices, lowest real score) — what a virtual voice must beat to come back.
    fn floor(&self) -> (usize, f32) {
        self.list
            .iter()
            .filter(|v| v.state == VoiceState::Playing)
            .fold((0, f32::INFINITY), |(n, m), v| (n + 1, m.min(score(v.priority, v.audible))))
    }

    fn remember(&mut self, id: u32, o: Outcome) {
        if self.recent.len() >= 64 {
            self.recent.pop_front();
        }
        self.recent.push_back((id, o));
    }

    /// Resolve queued requests (play / stop / volume).
    pub(crate) fn apply_ctl(&mut self, ctl: &mut SoundCtl, cx: &mut Cx, pos_of: &dyn Fn(Entity) -> Option<Vec3>) {
        let mut queue = std::mem::take(&mut ctl.queue);
        for c in queue.drain(..) {
            match c {
                Ctl::Play { id, src, params } => {
                    let o = self.request(id, src, params, cx, pos_of);
                    self.remember(id, o);
                }
                Ctl::Stop { id, fade } => {
                    if let Some(i) = self.list.iter().position(|v| v.id == id) {
                        self.stop_at(i, fade, cx);
                    }
                }
                Ctl::StopCue { name, fade } => {
                    if let Some(cue) = cx.cues.id(&name) {
                        let mut i = 0;
                        while i < self.list.len() {
                            if self.list[i].cue == Some(cue) && self.list[i].state != VoiceState::Stopping && self.stop_at(i, fade, cx) {
                                continue;
                            }
                            i += 1;
                        }
                    }
                }
                Ctl::StopAll { fade } => {
                    let mut i = 0;
                    while i < self.list.len() {
                        if self.list[i].state != VoiceState::Stopping && self.stop_at(i, fade, cx) {
                            continue;
                        }
                        i += 1;
                    }
                }
                Ctl::Volume { id, volume } => {
                    if let Some(v) = self.list.iter_mut().find(|v| v.id == id) {
                        v.ext_volume = volume.max(0.0);
                    }
                }
            }
        }
        ctl.queue = queue;
    }

    /// Stop voice `i`. Returns `true` if it was removed from the list (index now reused).
    fn stop_at(&mut self, i: usize, fade: f32, cx: &mut Cx) -> bool {
        let v = &mut self.list[i];
        if v.state == VoiceState::Playing {
            let frames = (fade.max(0.0) * cx.backend.rate() as f32) as u32;
            if frames > 64 {
                cx.backend.push(Cmd::Fade { id: v.id, at: 0, target: 0.0, frames, stop: true });
            } else {
                cx.backend.push(Cmd::Stop(v.id));
            }
            v.state = VoiceState::Stopping;
            v.stop_left = fade.max(0.0) + 0.05;
            false
        } else if v.state == VoiceState::Stopping {
            false
        } else {
            self.list.swap_remove(i);
            true
        }
    }

    fn request(&mut self, id: u32, src: PlaySource, p: PlayParams, cx: &mut Cx, pos_of: &dyn Fn(Entity) -> Option<Vec3>) -> Outcome {
        let pos = p.follow.and_then(pos_of).or(p.at).unwrap_or(self.listener.pos);
        let mut v = Voice {
            id,
            cue: None,
            clip: Handle::default(),
            clip_index: 0,
            bus: BusId::SFX,
            priority: 128,
            looping: false,
            gain: p.volume.max(0.0),
            ext_volume: 1.0,
            pitch: p.pitch.max(0.01),
            fade_in: 0.0,
            spatial: None,
            pos,
            vel: Vec3::ZERO,
            follow: p.follow,
            owner: p.owner,
            delay: 0.0,
            wait: 0.0,
            age: 0.0,
            duration: f32::INFINITY,
            clip_rate: 48_000,
            state: VoiceState::Loading,
            audible: 0.0,
            dist: 0.0,
            pan_x: 0.0,
            behind: 0.0,
            occl: 0.0,
            occl_target: 0.0,
            sent: VoiceParams::default(),
            stop_left: 0.0,
            captioned: false,
        };
        match src {
            PlaySource::Clip { clip, bus, looping, spatial } => {
                v.clip = clip;
                v.bus = bus;
                v.looping = looping;
                v.spatial = if p.at.is_some() || p.follow.is_some() { spatial } else { None };
            }
            PlaySource::Cue(name) => {
                let Some(cid) = cx.cues.id(&name) else {
                    return Outcome::UnknownCue;
                };
                let cue = cx.cues.by_id(cid);
                if cue.clips.is_empty() {
                    return Outcome::NoClips;
                }
                let (cooldown, max, steal) = (cue.cooldown, cue.max_instances, cue.steal);
                let st = &cx.cues.states[cid.0 as usize];
                if cooldown > 0.0 && st.last_start.is_some_and(|t| cx.now - t < cooldown as f64) {
                    cx.stats.rejected_cooldown += 1;
                    return Outcome::Cooldown;
                }
                if max > 0 {
                    let mine = self.list.iter().enumerate().filter(|(_, o)| o.cue == Some(cid) && o.state != VoiceState::Stopping);
                    if mine.clone().count() >= max as usize {
                        let victim = match steal {
                            Steal::Reject => None,
                            Steal::Oldest => mine.max_by(|a, b| a.1.age.total_cmp(&b.1.age)).map(|(i, _)| i),
                            Steal::Quietest => mine.min_by(|a, b| a.1.audible.total_cmp(&b.1.audible)).map(|(i, _)| i),
                            Steal::Farthest => mine.max_by(|a, b| a.1.dist.total_cmp(&b.1.dist)).map(|(i, _)| i),
                        };
                        match victim {
                            Some(i) => {
                                cx.stats.stolen += 1;
                                self.stop_at(i, 0.03, cx);
                            }
                            None => {
                                cx.stats.rejected_instances += 1;
                                return Outcome::MaxInstances;
                            }
                        }
                    }
                }
                let cue = cx.cues.by_id(cid);
                let (n, pick) = (cue.clips.len(), cue.pick);
                let k = pick_clip(pick, n, &mut cx.cues.states[cid.0 as usize], &mut self.rng);
                cx.cues.states[cid.0 as usize].last_start = Some(cx.now);
                let cue = cx.cues.by_id(cid);
                v.cue = Some(cid);
                v.clip = cue.clips[k].clone();
                v.clip_index = k;
                v.bus = cx.mixer.bus(&cue.bus).unwrap_or(BusId::SFX);
                v.priority = cue.priority;
                v.looping = cue.looping;
                v.gain *= db_to_lin(cue.volume_db + cue.volume_jitter_db * self.rng.signed());
                v.pitch *= semis(cue.pitch_semitones + cue.pitch_jitter * self.rng.signed());
                v.delay = cue.delay;
                v.fade_in = cue.fade_in;
                v.spatial = cue.spatial.clone();
            }
        }
        self.list.push(v);
        let i = self.list.len() - 1;
        self.advance_pending(i, 0.0, cx)
    }

    /// Loading/Delayed → admission when ready. Returns the outcome for voice `i` (which may
    /// have been removed when culled).
    fn advance_pending(&mut self, i: usize, dt: f32, cx: &mut Cx) -> Outcome {
        let v = &mut self.list[i];
        if v.state == VoiceState::Loading {
            match cx.clips.get(&v.clip) {
                Some(clip) => {
                    v.clip_rate = clip.rate();
                    v.duration = if v.looping { f32::INFINITY } else { clip.duration() / v.pitch };
                    v.state = VoiceState::Delayed;
                }
                None => {
                    v.wait += dt;
                    if v.wait > cx.cfg.load_timeout {
                        warn!("sound: clip for voice {} never loaded; dropped", v.id);
                        self.list.swap_remove(i);
                        return Outcome::Culled;
                    }
                    return Outcome::Loading;
                }
            }
        }
        if v.state == VoiceState::Delayed {
            v.delay -= dt;
            if v.delay > 0.0 {
                return Outcome::Delayed;
            }
            return self.admit(i, cx);
        }
        Outcome::Playing
    }

    fn params(&mut self, i: usize, cx: &Cx, out_rate: u32) -> VoiceParams {
        let v = &mut self.list[i];
        let cfg = cx.cfg;
        let mut p = VoiceParams { gain: v.gain * v.ext_volume, pan: [1.0, 1.0], rate: v.pitch, lowpass: NO_LOWPASS, mono: 0.0 };
        if let Some(att) = &v.spatial {
            let s = spatialize(att, &self.listener, v.pos, v.vel, &cfg.spatial);
            p.gain *= s.gain;
            p.pan = s.pan;
            p.lowpass = s.lowpass;
            p.rate *= s.doppler;
            p.mono = att.spatial_blend;
            v.dist = s.dist;
            v.pan_x = s.pan_x;
            v.behind = s.behind;
        }
        if v.occl > 0.0 {
            p.gain *= 1.0 + (db_to_lin(cfg.occlusion_db) - 1.0) * v.occl;
            p.lowpass = p.lowpass.min(lerp_hz(NO_LOWPASS, cfg.occlusion_lowpass_hz, v.occl));
        }
        p.rate *= v.clip_rate as f32 / out_rate as f32;
        v.audible = p.gain * cx.mixer.effective_gain(v.bus);
        p
    }

    /// Admit voice `i` (ready to start): real, virtual or culled.
    fn admit(&mut self, i: usize, cx: &mut Cx) -> Outcome {
        let rate = cx.backend.rate();
        let p = self.params(i, cx, rate);
        let cull = db_to_lin(cx.cfg.cull_db);
        let (audible, looping, priority) = (self.list[i].audible, self.list[i].looping, self.list[i].priority);
        if audible < cull {
            if looping {
                self.list[i].state = VoiceState::Virtual;
                return Outcome::Virtual;
            }
            cx.stats.culled += 1;
            self.list.swap_remove(i);
            return Outcome::Culled;
        }
        if !self.make_room(i, score(priority, audible), cx) {
            if looping {
                self.list[i].state = VoiceState::Virtual;
                return Outcome::Virtual;
            }
            cx.stats.voice_limited += 1;
            self.list.swap_remove(i);
            return Outcome::VoiceLimit;
        }
        self.start_real(i, p, cx);
        Outcome::Playing
    }

    /// Free a real slot for a voice scoring `s` (not voice `except`). `false` if full of
    /// voices scoring at least as high.
    fn make_room(&mut self, except: usize, s: f32, cx: &mut Cx) -> bool {
        if self.real_count() < cx.cfg.max_voices {
            return true;
        }
        let victim = self
            .list
            .iter()
            .enumerate()
            .filter(|(j, v)| *j != except && v.state == VoiceState::Playing)
            .map(|(j, v)| (j, score(v.priority, v.audible)))
            .min_by(|a, b| a.1.total_cmp(&b.1));
        match victim {
            Some((j, vs)) if vs < s => {
                cx.stats.stolen += 1;
                let v = &mut self.list[j];
                cx.backend.push(Cmd::Stop(v.id));
                if v.looping || v.age < v.duration {
                    // Keeps its clock; comes back when there's room.
                    v.state = VoiceState::Virtual;
                } else {
                    v.state = VoiceState::Stopping;
                    v.stop_left = 0.05;
                }
                true
            }
            _ => false,
        }
    }

    fn start_real(&mut self, i: usize, p: VoiceParams, cx: &mut Cx) {
        let rate = cx.backend.rate();
        let v = &mut self.list[i];
        let Some(clip) = cx.clips.get(&v.clip) else {
            v.state = VoiceState::Virtual;
            return;
        };
        let offset = v.age as f64 * v.pitch as f64 * v.clip_rate as f64;
        let fade_in = if v.age > 0.0 { (0.03 * rate as f32) as u32 } else { (v.fade_in * rate as f32) as u32 };
        cx.backend.push(Cmd::Start { id: v.id, clip: clip.pcm().clone(), bus: v.bus.0, at: 0, looping: v.looping, params: p, offset, fade_in });
        v.sent = p;
        if v.state != VoiceState::Virtual {
            cx.stats.started += 1;
        } else {
            cx.stats.revived += 1;
        }
        v.state = VoiceState::Playing;
        if !v.captioned {
            v.captioned = true;
            if let Some(cue) = v.cue {
                let cue = cx.cues.by_id(cue);
                if let Some(c) = cue.caption_for(v.clip_index) {
                    let secs = if c.secs > 0.0 { c.secs } else { (clip.duration() / v.pitch + 0.75).clamp(1.5, 8.0) };
                    cx.captions.push(c, Some(VoiceId(v.id)), secs, v.spatial.is_some().then_some(v.pan_x));
                }
            }
        }
    }

    /// Per-frame update of every voice.
    pub(crate) fn update(&mut self, dt: f32, cx: &mut Cx, pos_of: &dyn Fn(Entity) -> Option<Vec3>, alive: &dyn Fn(Entity) -> bool) {
        let rate = cx.backend.rate();
        let cull = db_to_lin(cx.cfg.cull_db);
        let active_floor = db_to_lin(cx.cfg.duck_trigger_db);
        let occl_k = (dt * cx.cfg.occlusion_speed).min(1.0);
        let finished = std::mem::take(&mut cx.backend.finished);
        let max = cx.cfg.max_voices;
        // Recomputed lazily (only when a virtual voice wants back in after a change): keeps the
        // frame O(voices) even with thousands of virtual voices.
        let mut floor: Option<(usize, f32)> = None;
        let mut i = 0;
        while i < self.list.len() {
            let v = &mut self.list[i];
            if v.owner.is_some_and(|o| !alive(o)) {
                v.owner = None;
                v.follow = None;
                if self.stop_at(i, 0.05, cx) {
                    continue;
                }
                i += 1;
                continue;
            }
            let v = &mut self.list[i];
            if let Some(f) = v.follow {
                match pos_of(f) {
                    Some(p) => {
                        if dt > 0.0 {
                            v.vel = v.vel.lerp((p - v.pos) / dt, 0.3);
                        }
                        v.pos = p;
                    }
                    None => {
                        v.follow = None;
                        v.vel = Vec3::ZERO;
                        if v.looping {
                            if self.stop_at(i, 0.1, cx) {
                                continue;
                            }
                            i += 1;
                            continue;
                        }
                    }
                }
            }
            let v = &mut self.list[i];
            v.occl += (v.occl_target - v.occl) * occl_k;
            match v.state {
                VoiceState::Loading | VoiceState::Delayed => {
                    let before = self.list.len();
                    let o = self.advance_pending(i, dt, cx);
                    if self.list.len() < before && !o.alive() {
                        continue; // removed (culled / dropped): `i` now holds another voice
                    }
                }
                VoiceState::Stopping => {
                    v.stop_left -= dt;
                    if v.stop_left <= 0.0 {
                        self.list.swap_remove(i);
                        continue;
                    }
                }
                VoiceState::Playing => {
                    v.age += dt;
                    let done_early = !v.looping && finished.contains(&v.id);
                    if done_early || v.age >= v.duration + 0.25 {
                        self.list.swap_remove(i);
                        floor = None;
                        continue;
                    }
                    let p = self.params(i, cx, rate);
                    let v = &mut self.list[i];
                    if v.audible < cull {
                        cx.backend.push(Cmd::Stop(v.id));
                        v.state = VoiceState::Virtual;
                        cx.stats.virtualized += 1;
                        floor = None;
                    } else {
                        if changed(&v.sent, &p) {
                            cx.backend.push(Cmd::Params(v.id, p));
                            v.sent = p;
                        }
                        if v.audible >= active_floor {
                            cx.mixer.mark_active(v.bus);
                        }
                    }
                }
                VoiceState::Virtual => {
                    v.age += dt;
                    if v.age >= v.duration {
                        self.list.swap_remove(i);
                        continue;
                    }
                    let p = self.params(i, cx, rate);
                    let v = &self.list[i];
                    if v.audible >= cull * 1.25 {
                        let s = score(v.priority, v.audible);
                        let (real, low) = *floor.get_or_insert_with(|| self.floor());
                        // Hysteresis: only displace a real voice it clearly beats (no ping-pong).
                        if (real < max || s > low + 0.05) && self.make_room(i, s, cx) {
                            self.start_real(i, p, cx);
                            floor = None;
                        }
                    }
                }
            }
            i += 1;
        }
        cx.backend.finished = finished;
    }

    /// Fill the per-frame stats.
    pub(crate) fn count(&self, stats: &mut SoundStats) {
        let (mut real, mut virt, mut pending, mut stopping) = (0, 0, 0, 0);
        for v in &self.list {
            match v.state {
                VoiceState::Playing => real += 1,
                VoiceState::Virtual => virt += 1,
                VoiceState::Loading | VoiceState::Delayed => pending += 1,
                VoiceState::Stopping => stopping += 1,
            }
        }
        stats.active = real;
        stats.virtual_voices = virt;
        stats.pending = pending;
        stats.stopping = stopping;
        stats.peak_active = stats.peak_active.max(real);
    }

    /// Pan of a 3D voice (captions' direction hints).
    pub(crate) fn pan_of(&self, id: VoiceId) -> Option<f32> {
        self.list.iter().find(|v| v.id == id.0 && v.spatial.is_some()).map(|v| v.pan_x)
    }
}

fn info(v: &Voice) -> VoiceInfo {
    VoiceInfo {
        id: VoiceId(v.id),
        cue: v.cue,
        bus: v.bus,
        state: v.state,
        priority: v.priority,
        audible: v.audible,
        distance: v.dist,
        pan: v.pan_x,
        occlusion: v.occl,
        age: v.age,
        looping: v.looping,
    }
}

#[inline]
fn changed(a: &VoiceParams, b: &VoiceParams) -> bool {
    let rel = |x: f32, y: f32, e: f32| (x - y).abs() > e * x.abs().max(y.abs()).max(1e-3);
    rel(a.gain, b.gain, 0.01)
        || (a.pan[0] - b.pan[0]).abs() > 0.005
        || (a.pan[1] - b.pan[1]).abs() > 0.005
        || rel(a.rate, b.rate, 0.0005)
        || rel(a.lowpass, b.lowpass, 0.01)
        || (a.mono - b.mono).abs() > 0.01
}
