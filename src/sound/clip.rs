//! [`SoundClip`]: decoded PCM (f32, mono or stereo) shared with the mixer thread by `Arc`.
//! Loaded from `.wav` (own parser: 8/16/24/32-bit int, 32-bit float) or `.ogg` (Bevy's vorbis
//! decoder) by [`SoundClipLoader`] on the asset task pool, or built in code ([`synth`]).
//! Decoding happens once, at load: playing a clip never decodes.

use std::sync::Arc;

use bevy::asset::{AssetLoader, LoadContext, io::Reader};
use bevy::prelude::*;

/// Interleaved f32 samples. `channels` is 1 or 2.
#[derive(Debug)]
pub struct ClipPcm {
    pub samples: Box<[f32]>,
    pub channels: u16,
    pub rate: u32,
}

impl ClipPcm {
    pub fn frames(&self) -> usize {
        self.samples.len() / self.channels.max(1) as usize
    }
}

/// A decoded sound. Cheap to clone (one `Arc`).
#[derive(Asset, TypePath, Clone, Debug)]
pub struct SoundClip {
    pcm: Arc<ClipPcm>,
}

impl SoundClip {
    pub fn from_mono(samples: Vec<f32>, rate: u32) -> Self {
        Self::from_interleaved(samples, 1, rate)
    }

    /// `channels` > 2 keeps the first two channels.
    pub fn from_interleaved(samples: Vec<f32>, channels: u16, rate: u32) -> Self {
        let channels = channels.max(1);
        let samples: Box<[f32]> = if channels > 2 {
            samples.chunks_exact(channels as usize).flat_map(|f| [f[0], f[1]]).collect()
        } else {
            samples.into_boxed_slice()
        };
        SoundClip { pcm: Arc::new(ClipPcm { samples, channels: channels.min(2), rate: rate.max(1) }) }
    }

    pub fn frames(&self) -> usize {
        self.pcm.frames()
    }
    pub fn channels(&self) -> u16 {
        self.pcm.channels
    }
    pub fn rate(&self) -> u32 {
        self.pcm.rate
    }
    pub fn samples(&self) -> &[f32] {
        &self.pcm.samples
    }
    /// Seconds at pitch 1.
    pub fn duration(&self) -> f32 {
        self.frames() as f32 / self.pcm.rate as f32
    }
    pub(crate) fn pcm(&self) -> &Arc<ClipPcm> {
        &self.pcm
    }

    /// `.wav` or `.ogg` bytes (sniffed from the header).
    pub fn decode(bytes: &[u8]) -> Result<Self, String> {
        if bytes.starts_with(b"RIFF") {
            Self::from_wav(bytes)
        } else if bytes.starts_with(b"OggS") {
            Self::from_ogg(bytes)
        } else {
            Err("unknown audio format (want RIFF/WAVE or Ogg Vorbis)".into())
        }
    }

    /// RIFF/WAVE: PCM 8/16/24/32-bit or IEEE float 32-bit.
    pub fn from_wav(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
            return Err("not a RIFF/WAVE file".into());
        }
        let (mut fmt, mut data) = (None, None);
        let mut i = 12;
        while i + 8 <= bytes.len() {
            let id = &bytes[i..i + 4];
            let len = u32::from_le_bytes(bytes[i + 4..i + 8].try_into().unwrap()) as usize;
            let body = &bytes[i + 8..(i + 8 + len).min(bytes.len())];
            match id {
                b"fmt " => fmt = Some(body),
                b"data" => data = Some(body),
                _ => {}
            }
            i += 8 + len + (len & 1);
        }
        let fmt = fmt.ok_or("wav: no fmt chunk")?;
        let data = data.ok_or("wav: no data chunk")?;
        if fmt.len() < 16 {
            return Err("wav: short fmt chunk".into());
        }
        let u16_at = |o: usize| u16::from_le_bytes([fmt[o], fmt[o + 1]]);
        let mut format = u16_at(0);
        let channels = u16_at(2).max(1);
        let rate = u32::from_le_bytes(fmt[4..8].try_into().unwrap());
        let bits = u16_at(14);
        if format == 0xFFFE && fmt.len() >= 26 {
            format = u16_at(24); // WAVE_FORMAT_EXTENSIBLE: sub-format GUID starts with the tag
        }
        let samples: Vec<f32> = match (format, bits) {
            (1, 8) => data.iter().map(|&b| (b as f32 - 128.0) / 128.0).collect(),
            (1, 16) => data.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0).collect(),
            (1, 24) => data.chunks_exact(3).map(|c| (i32::from_le_bytes([0, c[0], c[1], c[2]]) >> 8) as f32 / 8_388_608.0).collect(),
            (1, 32) => data.chunks_exact(4).map(|c| i32::from_le_bytes(c.try_into().unwrap()) as f32 / 2_147_483_648.0).collect(),
            (3, 32) => data.chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect(),
            _ => return Err(format!("wav: unsupported format {format} / {bits} bits")),
        };
        Ok(Self::from_interleaved(samples, channels, rate))
    }

    /// Ogg Vorbis through Bevy's decoder (feature `bevy/vorbis`, on by default).
    pub fn from_ogg(bytes: &[u8]) -> Result<Self, String> {
        use bevy::audio::{Decodable, Source};
        let src = bevy::audio::AudioSource { bytes: bytes.to_vec().into() };
        // rodio's decoder builder unwraps internally: contain a bad file to an error.
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let dec = src.decoder();
            let channels = dec.channels().get();
            let rate = dec.sample_rate().get();
            let samples: Vec<f32> = dec.collect();
            Self::from_interleaved(samples, channels, rate)
        }))
        .map_err(|_| "ogg: decode failed".to_string())
    }

    /// 16-bit PCM WAV bytes (tests, tools, `sound` example assets).
    pub fn to_wav(&self) -> Vec<u8> {
        let ch = self.pcm.channels;
        let data_len = self.pcm.samples.len() * 2;
        let mut out = Vec::with_capacity(44 + data_len);
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + data_len as u32).to_le_bytes());
        out.extend_from_slice(b"WAVEfmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&ch.to_le_bytes());
        out.extend_from_slice(&self.pcm.rate.to_le_bytes());
        out.extend_from_slice(&(self.pcm.rate * ch as u32 * 2).to_le_bytes());
        out.extend_from_slice(&(ch * 2).to_le_bytes());
        out.extend_from_slice(&16u16.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&(data_len as u32).to_le_bytes());
        for s in self.pcm.samples.iter() {
            out.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
        }
        out
    }
}

/// Loads `.wav` / `.ogg` / `.oga` as [`SoundClip`] (decoded on the asset task pool). Bevy's own
/// `AudioSource` loader keeps `.ogg` for `Handle<AudioSource>`: the requested type picks the loader.
#[derive(Default, TypePath)]
pub struct SoundClipLoader;

impl AssetLoader for SoundClipLoader {
    type Asset = SoundClip;
    type Settings = ();
    type Error = std::io::Error;

    async fn load(&self, reader: &mut dyn Reader, _settings: &(), _cx: &mut LoadContext<'_>) -> Result<SoundClip, Self::Error> {
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).await?;
        SoundClip::decode(&bytes).map_err(std::io::Error::other)
    }

    fn extensions(&self) -> &[&str] {
        &["wav", "ogg", "oga"]
    }
}

/// Tiny generated test sounds, so tests and demos need no binary assets. All mono.
pub mod synth {
    use super::SoundClip;
    use std::f32::consts::TAU;

    pub const RATE: u32 = 48_000;

    fn n(secs: f32) -> usize {
        (secs.max(0.0) * RATE as f32) as usize
    }

    /// Attack/decay envelope (seconds) so clips don't click.
    fn env(i: usize, len: usize, attack: f32, release: f32) -> f32 {
        let t = i as f32 / RATE as f32;
        let left = (len - i) as f32 / RATE as f32;
        (t / attack.max(1e-4)).min(1.0) * (left / release.max(1e-4)).min(1.0)
    }

    /// Sine tone with a short fade in/out.
    pub fn tone(freq: f32, secs: f32, amp: f32) -> SoundClip {
        let len = n(secs);
        let s = (0..len).map(|i| (TAU * freq * i as f32 / RATE as f32).sin() * amp * env(i, len, 0.005, 0.02)).collect();
        SoundClip::from_mono(s, RATE)
    }

    /// Short percussive blip (exponential decay), e.g. UI clicks / pickups.
    pub fn blip(freq: f32, secs: f32) -> SoundClip {
        let len = n(secs);
        let s = (0..len)
            .map(|i| {
                let t = i as f32 / RATE as f32;
                (TAU * freq * t).sin() * (-t * 6.0 / secs.max(1e-3)).exp() * 0.6 * env(i, len, 0.002, 0.005)
            })
            .collect();
        SoundClip::from_mono(s, RATE)
    }

    /// Frequency sweep `f0` → `f1`.
    pub fn chirp(f0: f32, f1: f32, secs: f32) -> SoundClip {
        let len = n(secs);
        let mut phase = 0.0f32;
        let s = (0..len)
            .map(|i| {
                let k = i as f32 / len.max(1) as f32;
                phase += TAU * (f0 + (f1 - f0) * k) / RATE as f32;
                phase.sin() * 0.5 * env(i, len, 0.005, 0.03)
            })
            .collect();
        SoundClip::from_mono(s, RATE)
    }

    /// Decaying noise burst (impacts, footsteps). Deterministic per `seed`.
    pub fn noise_burst(secs: f32, seed: u32) -> SoundClip {
        let len = n(secs);
        let mut x = seed.max(1);
        let mut lp = 0.0f32;
        let s = (0..len)
            .map(|i| {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                let w = (x as f32 / u32::MAX as f32) * 2.0 - 1.0;
                lp += 0.35 * (w - lp);
                let t = i as f32 / RATE as f32;
                lp * (-t * 5.0 / secs.max(1e-3)).exp() * 0.8 * env(i, len, 0.001, 0.01)
            })
            .collect();
        SoundClip::from_mono(s, RATE)
    }

    /// Seamless loop: a whole number of cycles of a two-partial drone (ambience beds).
    pub fn drone(freq: f32, secs: f32) -> SoundClip {
        let cycles = (freq * secs).round().max(1.0);
        let len = (cycles / freq * RATE as f32).round() as usize;
        let s = (0..len)
            .map(|i| {
                let t = i as f32 / len as f32 * cycles;
                ((TAU * t).sin() * 0.3 + (TAU * t * 2.0).sin() * 0.1) * 0.8
            })
            .collect();
        SoundClip::from_mono(s, RATE)
    }

    /// Vowel-ish buzz with pitch movement: stands in for dialogue (voice bus / ducking tests).
    pub fn babble(secs: f32, base: f32) -> SoundClip {
        let len = n(secs);
        let mut phase = 0.0f32;
        let s = (0..len)
            .map(|i| {
                let t = i as f32 / RATE as f32;
                phase += TAU * base * (1.0 + 0.15 * (TAU * 3.0 * t).sin()) / RATE as f32;
                let syll = (0.5 + 0.5 * (TAU * 4.0 * t).sin()).powf(0.7);
                ((phase).sin() * 0.5 + (phase * 3.0).sin() * 0.25 + (phase * 5.0).sin() * 0.12) * syll * 0.6 * env(i, len, 0.01, 0.05)
            })
            .collect();
        SoundClip::from_mono(s, RATE)
    }

    /// Kinds of [`music_stem`].
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum Stem {
        /// Kick on every beat.
        Drums,
        /// Root-fifth bass on eighths.
        Bass,
        /// Arpeggio on sixteenths.
        Lead,
        /// Sustained pad.
        Pad,
    }

    /// A loopable music stem of `bars` bars of 4/4 at `bpm` (all stems of one call line up
    /// sample-exactly, so they stay in sync when layered).
    pub fn music_stem(kind: Stem, bpm: f32, bars: u32, root: f32) -> SoundClip {
        let beat = 60.0 / bpm;
        let len = (beat * 4.0 * bars as f32 * RATE as f32).round() as usize;
        let s = (0..len)
            .map(|i| {
                let t = i as f32 / RATE as f32;
                match kind {
                    Stem::Drums => {
                        let tb = t % beat;
                        let f = 50.0 + 90.0 * (-tb * 30.0).exp();
                        (TAU * f * tb).sin() * (-tb * 9.0).exp() * 0.7
                    }
                    Stem::Bass => {
                        let e = beat / 2.0;
                        let k = (t / e) as u32;
                        let te = t % e;
                        let f = if k % 4 == 2 { root * 1.5 } else { root };
                        (TAU * f * te).sin() * (-te * 4.0).exp() * 0.45
                    }
                    Stem::Lead => {
                        let sx = beat / 4.0;
                        let k = (t / sx) as u32;
                        let ts = t % sx;
                        let f = root * 4.0 * [1.0, 1.25, 1.5, 2.0][(k % 4) as usize];
                        (TAU * f * ts).sin() * (-ts * 14.0).exp() * 0.22
                    }
                    Stem::Pad => {
                        ((TAU * root * 2.0 * t).sin() + (TAU * root * 2.5 * t).sin() + (TAU * root * 3.0 * t).sin()) * 0.08
                    }
                }
            })
            .collect();
        SoundClip::from_mono(s, RATE)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_roundtrip_keeps_shape() {
        let clip = synth::tone(440.0, 0.1, 0.5);
        let bytes = clip.to_wav();
        let back = SoundClip::decode(&bytes).unwrap();
        assert_eq!(back.frames(), clip.frames());
        assert_eq!(back.rate(), 48_000);
        assert_eq!(back.channels(), 1);
        let err: f32 = clip.samples().iter().zip(back.samples()).map(|(a, b)| (a - b).abs()).fold(0.0, f32::max);
        assert!(err < 1e-3, "16-bit roundtrip error {err}");
    }

    #[test]
    fn rejects_garbage() {
        assert!(SoundClip::decode(b"hello world, not audio").is_err());
        assert!(SoundClip::decode(b"OggS-but-broken").is_err());
        let mut wav = synth::tone(440.0, 0.01, 0.5).to_wav();
        wav[20] = 9; // format tag 9: unsupported
        assert!(SoundClip::from_wav(&wav).is_err());
    }

    #[test]
    fn stems_line_up_and_drones_loop() {
        let a = synth::music_stem(synth::Stem::Drums, 120.0, 2, 55.0);
        let b = synth::music_stem(synth::Stem::Lead, 120.0, 2, 55.0);
        assert_eq!(a.frames(), b.frames());
        assert!((a.duration() - 4.0).abs() < 1e-3, "2 bars at 120 bpm = 4 s");
        let d = synth::drone(110.0, 2.0);
        let s = d.samples();
        assert!((s[0] - s[s.len() - 1]).abs() < 0.05, "drone loops without a step");
    }
}
