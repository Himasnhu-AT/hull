//! Voice playback: one jitter buffer per remote talker, mixed into a 16 kHz mono stream.
//!
//! With an audio device, the [`Player`] lives inside a rodio source ([`VoiceStream`]) that
//! Bevy's audio output pulls, so playout runs on the device clock (no drift against the main
//! loop, no hitches when a frame is slow). The main thread hands packets over through a
//! preallocated inbox swapped under a `try_lock`, and reads back per-talker status the same
//! way. Without a device (headless, `--mute`, tests) the same [`Player`] runs on the main
//! thread against the real-time clock, so everything but the speaker is still exercised.
//!
//! Gain comes from [`super::VoiceSettings::volume`] × the master volume, ramped per frame.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use bevy::asset::Asset;
use bevy::audio::{ChannelCount, Decodable, SampleRate, Source};
use bevy::reflect::TypePath;

use super::adpcm::{FRAME, FRAME_BYTES};
use super::dsp::{RATE, level_db};
use super::jitter::{JitterBuffer, JitterConfig, JitterStats};

/// Remote talkers mixed at once.
pub const MAX_TALKERS: usize = 8;
/// Packets the inbox holds between two audio-thread drains.
const INBOX_CAP: usize = 64;

/// One received frame, fixed size (no allocation on the audio path).
#[derive(Clone, Copy)]
pub struct Packet {
    pub talker: u32,
    pub ts: u32,
    pub at_ms: f64,
    pub data: [u8; FRAME_BYTES],
}

/// What the main thread sees of one talker.
#[derive(Clone, Copy, Debug, Default, serde::Serialize)]
pub struct TalkerStatus {
    pub talker: u32,
    /// Real (not concealed) audio in the last frame.
    pub talking: bool,
    pub level_db: f32,
    pub delay_ms: f32,
    pub jitter_ms: f32,
    pub depth: usize,
    pub stats: JitterStats,
}

struct Talker {
    id: u32,
    jb: JitterBuffer,
    status: TalkerStatus,
    /// Frames since this talker last had a packet (for evicting old talkers).
    idle_frames: u32,
    /// Per-talker gain (proximity), ramped.
    gain: f32,
}

/// The mixer of all remote talkers. Pure apart from its inputs.
pub struct Player {
    cfg: JitterConfig,
    talkers: Vec<Talker>,
    frame: [i16; FRAME],
    gain: f32,
    /// Target gain per talker id (default 1): proximity / mutes.
    pub talker_gains: Vec<(u32, f32)>,
}

impl Player {
    pub fn new(cfg: JitterConfig) -> Self {
        Player { cfg, talkers: Vec::with_capacity(MAX_TALKERS), frame: [0; FRAME], gain: 0.0, talker_gains: Vec::new() }
    }

    pub fn push(&mut self, p: &Packet) {
        let i = match self.talkers.iter().position(|t| t.id == p.talker) {
            Some(i) => i,
            None => {
                if self.talkers.len() == MAX_TALKERS {
                    // Evict the longest-idle talker.
                    let (j, _) = self.talkers.iter().enumerate().max_by_key(|(_, t)| t.idle_frames).unwrap();
                    self.talkers.swap_remove(j);
                }
                self.talkers.push(Talker { id: p.talker, jb: JitterBuffer::new(self.cfg), status: TalkerStatus { talker: p.talker, ..Default::default() }, idle_frames: 0, gain: self.talker_gains.iter().find(|g| g.0 == p.talker).map_or(1.0, |g| g.1) });
                self.talkers.len() - 1
            }
        };
        let t = &mut self.talkers[i];
        t.idle_frames = 0;
        t.jb.push(p.ts, &p.data, p.at_ms);
    }

    /// Mix the next 20 ms into `out` (−1..1), ramping from the last gain to `gain`.
    pub fn render(&mut self, gain: f32, out: &mut [f32; FRAME]) {
        out.fill(0.0);
        for t in &mut self.talkers {
            t.idle_frames = t.idle_frames.saturating_add(1);
            let active = t.jb.pull(&mut self.frame);
            let target = self.talker_gains.iter().find(|g| g.0 == t.id).map_or(1.0, |g| g.1);
            if active {
                let k = (target - t.gain) / FRAME as f32;
                for (i, (o, &s)) in out.iter_mut().zip(&self.frame).enumerate() {
                    *o += f32::from(s) * (1.0 / 32768.0) * (t.gain + k * i as f32);
                }
            }
            t.gain = target;
            let real = active && t.jb.stats().played != t.status.stats.played;
            t.status = TalkerStatus {
                talker: t.id,
                talking: real,
                level_db: if active { level_db(&self.frame) } else { -100.0 },
                delay_ms: t.jb.delay_ms(),
                jitter_ms: t.jb.jitter_ms(),
                depth: t.jb.depth(),
                stats: t.jb.stats(),
            };
        }
        let k = (gain - self.gain) / FRAME as f32;
        for (i, o) in out.iter_mut().enumerate() {
            *o = (*o * (self.gain + k * i as f32)).clamp(-1.0, 1.0);
        }
        self.gain = gain;
    }

    pub fn status(&self, out: &mut Vec<TalkerStatus>) {
        out.clear();
        out.extend(self.talkers.iter().map(|t| t.status));
    }
}

/// State shared between the game and the audio thread.
pub struct PlayShared {
    inbox: Mutex<Vec<Packet>>,
    status: Mutex<Vec<TalkerStatus>>,
    gain: AtomicU32,
    talker_gains: Mutex<Vec<(u32, f32)>>,
    /// Frames rendered (the playout clock, 20 ms each).
    frames: AtomicU32,
}

impl Default for PlayShared {
    fn default() -> Self {
        PlayShared {
            inbox: Mutex::new(Vec::with_capacity(INBOX_CAP)),
            status: Mutex::new(Vec::with_capacity(MAX_TALKERS)),
            gain: AtomicU32::new(1.0f32.to_bits()),
            talker_gains: Mutex::new(Vec::new()),
            frames: AtomicU32::new(0),
        }
    }
}

impl PlayShared {
    /// Queue a packet for the audio thread. Drops the oldest if the device stopped pulling.
    pub fn send(&self, p: Packet) {
        if let Ok(mut q) = self.inbox.lock() {
            if q.len() >= INBOX_CAP {
                q.remove(0);
            }
            q.push(p);
        }
    }
    /// Per-talker gains (proximity); talkers not listed play at 1.
    pub fn set_talker_gains(&self, gains: &[(u32, f32)]) {
        if let Ok(mut g) = self.talker_gains.lock() {
            g.clear();
            g.extend_from_slice(gains);
        }
    }
    pub fn set_gain(&self, g: f32) {
        self.gain.store(g.to_bits(), Ordering::Relaxed);
    }
    pub fn status(&self, out: &mut Vec<TalkerStatus>) {
        if let Ok(s) = self.status.lock() {
            out.clear();
            out.extend_from_slice(&s);
        }
    }
    pub fn frames(&self) -> u32 {
        self.frames.load(Ordering::Relaxed)
    }
}

/// Audio-thread side: drain the inbox, render a frame, publish status.
pub struct PlayoutEngine {
    shared: Arc<PlayShared>,
    player: Player,
    take: Vec<Packet>,
    statuses: Vec<TalkerStatus>,
}

impl PlayoutEngine {
    pub fn new(shared: Arc<PlayShared>, cfg: JitterConfig) -> Self {
        PlayoutEngine { shared, player: Player::new(cfg), take: Vec::with_capacity(INBOX_CAP), statuses: Vec::with_capacity(MAX_TALKERS) }
    }

    pub fn render(&mut self, out: &mut [f32; FRAME]) {
        if let Ok(mut q) = self.shared.inbox.try_lock()
            && !q.is_empty()
        {
            std::mem::swap(&mut *q, &mut self.take);
        }
        for p in self.take.drain(..) {
            self.player.push(&p);
        }
        if let Ok(g) = self.shared.talker_gains.try_lock() {
            self.player.talker_gains.clear();
            self.player.talker_gains.extend_from_slice(&g);
        }
        let gain = f32::from_bits(self.shared.gain.load(Ordering::Relaxed));
        self.player.render(gain, out);
        self.player.status(&mut self.statuses);
        if let Ok(mut s) = self.shared.status.try_lock() {
            s.clear();
            s.extend_from_slice(&self.statuses);
        }
        self.shared.frames.fetch_add(1, Ordering::Relaxed);
    }
}

/// The rodio source Bevy's audio output plays (16 kHz mono; rodio converts to the device).
#[derive(Asset, TypePath)]
pub struct VoiceStream {
    engine: Mutex<Option<PlayoutEngine>>,
}

impl VoiceStream {
    pub fn new(engine: PlayoutEngine) -> Self {
        VoiceStream { engine: Mutex::new(Some(engine)) }
    }
}

pub struct VoiceSource {
    engine: Option<PlayoutEngine>,
    buf: [f32; FRAME],
    idx: usize,
}

impl Iterator for VoiceSource {
    type Item = f32;
    #[inline]
    fn next(&mut self) -> Option<f32> {
        if self.idx >= FRAME {
            match &mut self.engine {
                Some(e) => e.render(&mut self.buf),
                None => self.buf.fill(0.0),
            }
            self.idx = 0;
        }
        let s = self.buf[self.idx];
        self.idx += 1;
        Some(s)
    }
}

impl Source for VoiceSource {
    fn current_span_len(&self) -> Option<usize> {
        None
    }
    fn channels(&self) -> ChannelCount {
        ChannelCount::new(1).unwrap()
    }
    fn sample_rate(&self) -> SampleRate {
        SampleRate::new(RATE).unwrap()
    }
    fn total_duration(&self) -> Option<std::time::Duration> {
        None
    }
}

impl Decodable for VoiceStream {
    type Decoder = VoiceSource;
    fn decoder(&self) -> VoiceSource {
        let engine = self.engine.lock().ok().and_then(|mut e| e.take());
        VoiceSource { engine, buf: [0.0; FRAME], idx: FRAME }
    }
}

#[cfg(test)]
mod tests {
    use super::super::adpcm::Encoder;
    use super::*;

    #[test]
    fn two_talkers_mix_and_report() {
        let mut enc = Encoder::new();
        let mut pcm = [0i16; FRAME];
        for (i, s) in pcm.iter_mut().enumerate() {
            *s = ((i as f32 * 0.2).sin() * 6000.0) as i16;
        }
        let mut data = [0u8; FRAME_BYTES];
        let sh = Arc::new(PlayShared::default());
        let mut eng = PlayoutEngine::new(sh.clone(), JitterConfig::default());
        let mut out = [0.0f32; FRAME];
        let mut peak = 0.0f32;
        for ts in 0..20u32 {
            enc.encode(&pcm, &mut data);
            for talker in [1, 2] {
                sh.send(Packet { talker, ts, at_ms: f64::from(ts) * 20.0, data });
            }
            eng.render(&mut out);
            peak = out.iter().fold(peak, |m, x| m.max(x.abs()));
        }
        let mut st = Vec::new();
        sh.status(&mut st);
        assert_eq!(st.len(), 2);
        assert!(st.iter().all(|t| t.talking && t.level_db > -30.0), "{st:?}");
        // Two copies of a ~0.18 peak sine sum to ~0.36.
        assert!(peak > 0.3 && peak < 0.45, "peak {peak}");
        assert_eq!(sh.frames(), 20);
        // Silence afterwards: both go quiet, then idle.
        for _ in 0..20 {
            eng.render(&mut out);
        }
        sh.status(&mut st);
        assert!(st.iter().all(|t| !t.talking));
        assert!(out.iter().all(|&x| x == 0.0));
    }
}
