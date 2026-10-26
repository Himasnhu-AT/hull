//! Music: tracks with an optional intro and a looping body of layered stems. Stems fade in and
//! out with an `intensity` parameter (0..1); track changes crossfade, quantized to the next
//! beat or bar of the playing track. Starts are scheduled on the mixer's sample clock, so
//! stems stay sample-locked and transitions land exactly on the grid.
//!
//! ```ignore
//! music.add_track(MusicTrack::new("explore", 96.0).intro(intro).stem(MusicStem::always(pad))
//!     .stem(MusicStem::at(drums, 0.4)).stem(MusicStem::at(lead, 0.75)));
//! music.play("explore", MusicTransition::default());   // next bar, 1.5 s crossfade
//! music.set_intensity(0.8);                           // drums + lead fade in
//! ```
//! [`MusicBeat`] messages fire on every beat (gameplay sync).

use std::borrow::Cow;

use bevy::prelude::*;

use super::backend::SoundBackend;
use super::bus::{BusId, Mixer, db_to_lin};
use super::clip::SoundClip;
use super::dsp::{Cmd, VoiceParams};
use super::voice::MUSIC_IDS;

#[derive(Clone, Debug, PartialEq)]
pub struct MusicStem {
    pub clip: Handle<SoundClip>,
    /// Intensity at which the stem starts to come in.
    pub threshold: f32,
    /// Intensity range over which it fades in (0 = hard switch).
    pub ramp: f32,
}

impl MusicStem {
    /// Always audible.
    pub fn always(clip: Handle<SoundClip>) -> Self {
        MusicStem { clip, threshold: 0.0, ramp: 0.0 }
    }
    /// Fades in over 0.2 of intensity from `threshold`.
    pub fn at(clip: Handle<SoundClip>, threshold: f32) -> Self {
        MusicStem { clip, threshold, ramp: 0.2 }
    }
    pub fn gain(&self, intensity: f32) -> f32 {
        if self.ramp <= 0.0 {
            if intensity >= self.threshold { 1.0 } else { 0.0 }
        } else {
            let t = ((intensity - self.threshold) / self.ramp).clamp(0.0, 1.0);
            t * t * (3.0 - 2.0 * t)
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct MusicTrack {
    pub name: Cow<'static, str>,
    pub intro: Option<Handle<SoundClip>>,
    /// Looping layers, all the same length.
    pub stems: Vec<MusicStem>,
    pub bpm: f32,
    pub beats_per_bar: u32,
    pub volume_db: f32,
    pub bus: Cow<'static, str>,
}

impl Default for MusicTrack {
    fn default() -> Self {
        MusicTrack { name: Cow::Borrowed(""), intro: None, stems: Vec::new(), bpm: 120.0, beats_per_bar: 4, volume_db: 0.0, bus: Cow::Borrowed("music") }
    }
}

impl MusicTrack {
    pub fn new(name: impl Into<Cow<'static, str>>, bpm: f32) -> Self {
        MusicTrack { name: name.into(), bpm, ..default() }
    }
    pub fn intro(mut self, clip: Handle<SoundClip>) -> Self {
        self.intro = Some(clip);
        self
    }
    pub fn stem(mut self, s: MusicStem) -> Self {
        self.stems.push(s);
        self
    }
    pub fn meter(mut self, beats_per_bar: u32) -> Self {
        self.beats_per_bar = beats_per_bar.max(1);
        self
    }
    pub fn volume(mut self, db: f32) -> Self {
        self.volume_db = db;
        self
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Quantize {
    Immediate,
    Beat,
    #[default]
    Bar,
}

impl Quantize {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "immediate" | "now" => Some(Self::Immediate),
            "beat" => Some(Self::Beat),
            "bar" => Some(Self::Bar),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MusicTransition {
    pub fade_out: f32,
    pub fade_in: f32,
    pub quantize: Quantize,
}

impl Default for MusicTransition {
    fn default() -> Self {
        MusicTransition { fade_out: 1.5, fade_in: 0.3, quantize: Quantize::Bar }
    }
}

/// Fired on every beat of the playing track.
#[derive(Message, Clone, Debug, PartialEq)]
pub struct MusicBeat {
    pub track: Cow<'static, str>,
    pub bar: u32,
    pub beat: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MusicPosition {
    pub track: Cow<'static, str>,
    pub bar: u32,
    pub beat: u32,
    /// 0..1 within the beat.
    pub phase: f32,
    pub secs: f64,
    pub in_intro: bool,
}

#[derive(Clone, Debug)]
struct Active {
    track: usize,
    origin: u64,
    loop_at: u64,
    intro: Option<u32>,
    /// (voice id, gain sent, rate).
    stems: Vec<(u32, f32, f32)>,
}

#[derive(Resource, Debug)]
pub struct Music {
    tracks: Vec<MusicTrack>,
    current: Option<Active>,
    pending: Option<(usize, MusicTransition)>,
    stop: Option<f32>,
    intensity: f32,
    target: f32,
    /// Intensity units per second.
    pub intensity_speed: f32,
    next_id: u32,
    last_beat: Option<u64>,
}

impl Default for Music {
    fn default() -> Self {
        Music { tracks: Vec::new(), current: None, pending: None, stop: None, intensity: 0.0, target: 0.0, intensity_speed: 0.5, next_id: MUSIC_IDS, last_beat: None }
    }
}

fn next_boundary(origin: u64, period: u64, earliest: u64) -> u64 {
    if earliest <= origin || period == 0 {
        return origin.max(earliest);
    }
    origin + (earliest - origin).div_ceil(period) * period
}

impl Music {
    /// Adds or replaces (same name) a track.
    pub fn add_track(&mut self, t: MusicTrack) {
        match self.tracks.iter().position(|o| o.name == t.name) {
            Some(i) => self.tracks[i] = t,
            None => self.tracks.push(t),
        }
    }

    pub fn tracks(&self) -> impl Iterator<Item = &MusicTrack> {
        self.tracks.iter()
    }

    /// Switch to `name` (no-op if it's already playing). `false` if unknown.
    pub fn play(&mut self, name: &str, tr: MusicTransition) -> bool {
        let Some(i) = self.tracks.iter().position(|t| t.name == name) else { return false };
        if self.current.as_ref().is_some_and(|a| a.track == i) && self.pending.is_none() {
            return true;
        }
        self.pending = Some((i, tr));
        self.stop = None;
        true
    }

    pub fn stop(&mut self, fade: f32) {
        self.pending = None;
        self.stop = Some(fade.max(0.0));
    }

    /// Target intensity 0..1 (approached at `intensity_speed`).
    pub fn set_intensity(&mut self, x: f32) {
        self.target = x.clamp(0.0, 1.0);
    }

    /// Jump to an intensity without smoothing.
    pub fn snap_intensity(&mut self, x: f32) {
        self.target = x.clamp(0.0, 1.0);
        self.intensity = self.target;
    }

    pub fn intensity(&self) -> f32 {
        self.intensity
    }

    pub fn current(&self) -> Option<&str> {
        self.current.as_ref().map(|a| self.tracks[a.track].name.as_ref())
    }

    pub fn pending(&self) -> Option<&str> {
        self.pending.as_ref().map(|(i, _)| self.tracks[*i].name.as_ref())
    }

    /// Voices the music holds (intro + stems).
    pub fn voice_count(&self) -> usize {
        self.current.as_ref().map_or(0, |a| a.stems.len() + a.intro.is_some() as usize)
    }

    /// Frame where the current track starts (its grid origin).
    pub fn origin(&self) -> Option<u64> {
        self.current.as_ref().map(|a| a.origin)
    }

    /// Bar / beat of the playing track at output frame `clock`. `None` before its start.
    pub fn position(&self, clock: u64, rate: u32) -> Option<MusicPosition> {
        let a = self.current.as_ref()?;
        if clock < a.origin {
            return None;
        }
        let t = &self.tracks[a.track];
        let beat_f = 60.0 / t.bpm.max(1.0) as f64 * rate as f64;
        let beats = (clock - a.origin) as f64 / beat_f;
        let whole = beats.floor() as u64;
        Some(MusicPosition {
            track: t.name.clone(),
            bar: (whole / t.beats_per_bar as u64) as u32,
            beat: (whole % t.beats_per_bar as u64) as u32,
            phase: beats.fract() as f32,
            secs: (clock - a.origin) as f64 / rate as f64,
            in_intro: clock < a.loop_at,
        })
    }

    /// Nothing playing, pending or stopping (the per-frame system does no work).
    pub(crate) fn idle(&self) -> bool {
        self.current.is_none() && self.pending.is_none() && self.stop.is_none()
    }

    fn id(&mut self) -> u32 {
        let id = self.next_id;
        self.next_id = if self.next_id == u32::MAX { MUSIC_IDS } else { self.next_id + 1 };
        id
    }

    pub(crate) fn update(&mut self, dt: f32, backend: &mut SoundBackend, mixer: &Mixer, clips: &Assets<SoundClip>, beats: &mut Vec<MusicBeat>) {
        let rate = backend.rate();
        let now = backend.clock();
        let mut retune = false;
        if self.intensity != self.target {
            let step = self.intensity_speed.max(0.0) * dt;
            self.intensity = if self.intensity_speed <= 0.0 {
                self.target
            } else if self.target > self.intensity {
                (self.intensity + step).min(self.target)
            } else {
                (self.intensity - step).max(self.target)
            };
            retune = true;
        }
        if let Some(fade) = self.stop.take()
            && let Some(a) = self.current.take()
        {
            let frames = (fade * rate as f32) as u32;
            for id in a.intro.into_iter().chain(a.stems.iter().map(|s| s.0)) {
                backend.push(Cmd::Fade { id, at: 0, target: 0.0, frames, stop: true });
            }
            self.last_beat = None;
        }
        if let Some((ti, tr)) = self.pending {
            let t = &self.tracks[ti];
            let loaded = t.intro.iter().chain(t.stems.iter().map(|s| &s.clip)).all(|h| clips.get(h).is_some());
            if loaded {
                self.pending = None;
                self.start(ti, tr, now, rate, backend, mixer, clips);
                retune = false;
            }
        }
        if retune && let Some(a) = &mut self.current {
            let t = &self.tracks[a.track];
            let vol = db_to_lin(t.volume_db);
            for (k, (id, sent, r)) in a.stems.iter_mut().enumerate() {
                let g = t.stems[k].gain(self.intensity) * vol;
                if (g - *sent).abs() > 0.004 {
                    *sent = g;
                    backend.push(Cmd::Params(*id, VoiceParams { gain: g, rate: *r, ..default() }));
                }
            }
        }
        if let Some(p) = self.position(now, rate) {
            let t = &self.tracks[self.current.as_ref().unwrap().track];
            let idx = p.bar as u64 * t.beats_per_bar as u64 + p.beat as u64;
            if self.last_beat != Some(idx) {
                self.last_beat = Some(idx);
                beats.push(MusicBeat { track: p.track, bar: p.bar, beat: p.beat });
            }
        }
    }

    fn start(&mut self, ti: usize, tr: MusicTransition, now: u64, rate: u32, backend: &mut SoundBackend, mixer: &Mixer, clips: &Assets<SoundClip>) {
        let earliest = now + (0.06 * rate as f32) as u64;
        let at = match (&self.current, tr.quantize) {
            (Some(a), q) if q != Quantize::Immediate => {
                let cur = &self.tracks[a.track];
                let beat = (60.0 / cur.bpm.max(1.0) as f64 * rate as f64).round() as u64;
                let period = if q == Quantize::Bar { beat * cur.beats_per_bar as u64 } else { beat };
                next_boundary(a.origin, period, earliest)
            }
            _ => earliest,
        };
        if let Some(a) = self.current.take() {
            let frames = (tr.fade_out * rate as f32) as u32;
            for id in a.intro.into_iter().chain(a.stems.iter().map(|s| s.0)) {
                backend.push(Cmd::Fade { id, at, target: 0.0, frames, stop: true });
            }
        }
        let t = self.tracks[ti].clone();
        let bus = mixer.bus(&t.bus).unwrap_or(BusId::MUSIC).0;
        let vol = db_to_lin(t.volume_db);
        let fade_in = (tr.fade_in * rate as f32) as u32;
        let mut loop_at = at;
        let mut intro = None;
        if let Some(clip) = t.intro.as_ref().and_then(|h| clips.get(h)) {
            let id = self.id();
            let r = clip.rate() as f32 / rate as f32;
            backend.push(Cmd::Start { id, clip: clip.pcm().clone(), bus, at, looping: false, params: VoiceParams { gain: vol, rate: r, ..default() }, offset: 0.0, fade_in });
            loop_at = at + (clip.frames() as f64 * rate as f64 / clip.rate() as f64).round() as u64;
            intro = Some(id);
        }
        let mut stems = Vec::with_capacity(t.stems.len());
        for s in &t.stems {
            let Some(clip) = clips.get(&s.clip) else { continue };
            let id = self.id();
            let r = clip.rate() as f32 / rate as f32;
            let g = s.gain(self.intensity) * vol;
            let fi = if intro.is_some() { 0 } else { fade_in };
            backend.push(Cmd::Start { id, clip: clip.pcm().clone(), bus, at: loop_at, looping: true, params: VoiceParams { gain: g, rate: r, ..default() }, offset: 0.0, fade_in: fi });
            stems.push((id, g, r));
        }
        self.current = Some(Active { track: ti, origin: at, loop_at, intro, stems });
        self.last_beat = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boundaries_and_stem_gains() {
        assert_eq!(next_boundary(1000, 500, 1200), 1500);
        assert_eq!(next_boundary(1000, 500, 1500), 1500);
        assert_eq!(next_boundary(1000, 500, 900), 1000);
        let s = MusicStem::at(Handle::default(), 0.5);
        assert_eq!(s.gain(0.4), 0.0);
        assert_eq!(s.gain(0.7), 1.0);
        assert!((s.gain(0.6) - 0.5).abs() < 1e-6);
        assert_eq!(MusicStem::always(Handle::default()).gain(0.0), 1.0);
    }
}
