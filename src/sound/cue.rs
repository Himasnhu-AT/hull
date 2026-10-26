//! Sound cues ("events"): what to play and how, defined in Rust. A cue picks one of its clips
//! (random / shuffle without repeats / sequence), randomises volume and pitch, respects a
//! cooldown and a per-cue instance limit (with a stealing policy), plays after a delay, on a
//! bus, optionally in 3D with an [`Attenuation`], and can carry captions.
//!
//! ```ignore
//! cues.add(SoundCue::new("footstep").clips(steps).pick(Pick::Shuffle)
//!     .pitch_jitter(1.5).volume_jitter(2.0).max_instances(4, Steal::Oldest)
//!     .spatial(Attenuation { max_distance: 25.0, ..default() }));
//! cues.add(SoundCue::new("guard.alert").clip(line).bus("voice").priority(220)
//!     .caption(Caption::speech("Guard", "Who's there?")));
//! ```

use std::borrow::Cow;

use bevy::platform::collections::HashMap;
use bevy::prelude::*;

use super::clip::SoundClip;

/// How a cue chooses among its clips.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Pick {
    /// Uniform random (may repeat).
    #[default]
    Random,
    /// Random order, every clip once per round, never the same clip twice in a row.
    Shuffle,
    /// In order, wrapping.
    Sequence,
}

/// What happens when a cue is at its `max_instances`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Steal {
    /// Stop the oldest instance.
    #[default]
    Oldest,
    /// Stop the quietest instance (as heard: distance, occlusion, buses).
    Quietest,
    /// Stop the farthest instance.
    Farthest,
    /// Don't play the new one.
    Reject,
}

/// Distance → gain curve between `min_distance` (full volume) and `max_distance` (silent).
#[derive(Clone, Debug, Default, PartialEq)]
pub enum Rolloff {
    /// `min / d` (natural), faded to zero over the last 20 % of the range.
    #[default]
    Logarithmic,
    Linear,
    /// Piecewise-linear `(t, gain)` points, `t` = 0 at min .. 1 at max distance.
    Custom(Vec<(f32, f32)>),
}

/// 3D settings of a cue.
#[derive(Clone, Debug, PartialEq)]
pub struct Attenuation {
    pub min_distance: f32,
    pub max_distance: f32,
    pub rolloff: Rolloff,
    /// 0 = 2D (no panning/rolloff), 1 = fully 3D.
    pub spatial_blend: f32,
    /// Doppler amount (0 = off, 1 = physical).
    pub doppler: f32,
    /// Raycast occlusion (feature `physics`).
    pub occlusion: bool,
}

impl Default for Attenuation {
    fn default() -> Self {
        Attenuation { min_distance: 1.0, max_distance: 40.0, rolloff: Rolloff::Logarithmic, spatial_blend: 1.0, doppler: 1.0, occlusion: true }
    }
}

impl Attenuation {
    /// Distance gain 0..1 (before `spatial_blend`).
    pub fn gain(&self, d: f32) -> f32 {
        let (min, max) = (self.min_distance.max(0.01), self.max_distance.max(self.min_distance.max(0.01) + 0.01));
        if d <= min {
            return 1.0;
        }
        if d >= max {
            return 0.0;
        }
        let t = (d - min) / (max - min);
        match &self.rolloff {
            Rolloff::Linear => 1.0 - t,
            Rolloff::Logarithmic => {
                let fade = if t > 0.8 { 1.0 - (t - 0.8) / 0.2 } else { 1.0 };
                (min / d) * fade
            }
            Rolloff::Custom(pts) => curve(pts, t),
        }
    }

    /// Gain with spatial blend applied (2D part stays at 1).
    pub fn blended_gain(&self, d: f32) -> f32 {
        let b = self.spatial_blend.clamp(0.0, 1.0);
        1.0 - b + b * self.gain(d)
    }
}

fn curve(pts: &[(f32, f32)], t: f32) -> f32 {
    match pts {
        [] => 1.0 - t,
        [only] => only.1,
        _ => {
            if t <= pts[0].0 {
                return pts[0].1;
            }
            for w in pts.windows(2) {
                let (a, b) = (w[0], w[1]);
                if t <= b.0 {
                    let k = if b.0 > a.0 { (t - a.0) / (b.0 - a.0) } else { 1.0 };
                    return a.1 + (b.1 - a.1) * k;
                }
            }
            pts[pts.len() - 1].1
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CaptionKind {
    /// Dialogue: "SPEAKER: text".
    #[default]
    Speech,
    /// Sound effect description: "[Explosion]".
    Sound,
}

/// Caption text a cue shows when it starts (if captions are on).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Caption {
    pub text: Cow<'static, str>,
    pub speaker: Option<Cow<'static, str>>,
    /// Seconds on screen; 0 = clip length + 0.75 s (clamped 1.5..8).
    pub secs: f32,
    pub kind: CaptionKind,
}

impl Caption {
    pub fn speech(speaker: impl Into<Cow<'static, str>>, text: impl Into<Cow<'static, str>>) -> Self {
        Caption { text: text.into(), speaker: Some(speaker.into()), ..default() }
    }
    pub fn sound(text: impl Into<Cow<'static, str>>) -> Self {
        Caption { text: text.into(), kind: CaptionKind::Sound, ..default() }
    }
    pub fn secs(mut self, s: f32) -> Self {
        self.secs = s.max(0.0);
        self
    }
}

/// A playable sound event. Build with [`SoundCue::new`] + builder methods, or a struct literal
/// with `..default()`.
#[derive(Clone, Debug)]
pub struct SoundCue {
    pub name: Cow<'static, str>,
    pub clips: Vec<Handle<SoundClip>>,
    pub pick: Pick,
    /// Bus name (default "sfx").
    pub bus: Cow<'static, str>,
    pub volume_db: f32,
    /// ± dB, uniform.
    pub volume_jitter_db: f32,
    pub pitch_semitones: f32,
    /// ± semitones, uniform.
    pub pitch_jitter: f32,
    /// Seconds after a start during which new starts are rejected.
    pub cooldown: f32,
    /// 0 = unlimited.
    pub max_instances: u16,
    pub steal: Steal,
    /// 0..255; higher wins the global voice limit (distance/loudness break ties).
    pub priority: u8,
    /// Seconds before the sound starts (instance limits count it immediately).
    pub delay: f32,
    pub looping: bool,
    /// Seconds of fade-in.
    pub fade_in: f32,
    /// `None` = 2D.
    pub spatial: Option<Attenuation>,
    /// One caption for every clip, or one per clip (same order as `clips`).
    pub captions: Vec<Caption>,
}

impl Default for SoundCue {
    fn default() -> Self {
        SoundCue {
            name: Cow::Borrowed(""),
            clips: Vec::new(),
            pick: Pick::Random,
            bus: Cow::Borrowed("sfx"),
            volume_db: 0.0,
            volume_jitter_db: 0.0,
            pitch_semitones: 0.0,
            pitch_jitter: 0.0,
            cooldown: 0.0,
            max_instances: 0,
            steal: Steal::Oldest,
            priority: 128,
            delay: 0.0,
            looping: false,
            fade_in: 0.0,
            spatial: None,
            captions: Vec::new(),
        }
    }
}

impl SoundCue {
    pub fn new(name: impl Into<Cow<'static, str>>) -> Self {
        SoundCue { name: name.into(), ..default() }
    }
    pub fn clip(mut self, c: Handle<SoundClip>) -> Self {
        self.clips.push(c);
        self
    }
    pub fn clips(mut self, c: impl IntoIterator<Item = Handle<SoundClip>>) -> Self {
        self.clips.extend(c);
        self
    }
    pub fn pick(mut self, p: Pick) -> Self {
        self.pick = p;
        self
    }
    pub fn bus(mut self, b: impl Into<Cow<'static, str>>) -> Self {
        self.bus = b.into();
        self
    }
    pub fn volume(mut self, db: f32) -> Self {
        self.volume_db = db;
        self
    }
    pub fn volume_jitter(mut self, db: f32) -> Self {
        self.volume_jitter_db = db.abs();
        self
    }
    pub fn pitch(mut self, semitones: f32) -> Self {
        self.pitch_semitones = semitones;
        self
    }
    pub fn pitch_jitter(mut self, semitones: f32) -> Self {
        self.pitch_jitter = semitones.abs();
        self
    }
    pub fn cooldown(mut self, secs: f32) -> Self {
        self.cooldown = secs.max(0.0);
        self
    }
    pub fn max_instances(mut self, n: u16, steal: Steal) -> Self {
        self.max_instances = n;
        self.steal = steal;
        self
    }
    pub fn priority(mut self, p: u8) -> Self {
        self.priority = p;
        self
    }
    pub fn delay(mut self, secs: f32) -> Self {
        self.delay = secs.max(0.0);
        self
    }
    pub fn looping(mut self) -> Self {
        self.looping = true;
        self
    }
    pub fn fade_in(mut self, secs: f32) -> Self {
        self.fade_in = secs.max(0.0);
        self
    }
    pub fn spatial(mut self, a: Attenuation) -> Self {
        self.spatial = Some(a);
        self
    }
    pub fn caption(mut self, c: Caption) -> Self {
        self.captions.push(c);
        self
    }

    /// Caption for clip `i`.
    pub fn caption_for(&self, i: usize) -> Option<&Caption> {
        match self.captions.len() {
            0 => None,
            1 => self.captions.first(),
            _ => self.captions.get(i),
        }
    }
}

/// Index of a cue in [`SoundCues`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct CueId(pub u16);

/// Per-cue runtime state (selection memory, cooldown).
#[derive(Clone, Debug, Default)]
pub struct CueState {
    bag: Vec<u16>,
    next: u16,
    last: Option<u16>,
    pub(crate) last_start: Option<f64>,
}

/// Tiny deterministic xorshift RNG (seeded from `GameSeed`), so cue choices replay in tests.
#[derive(Clone, Debug)]
pub struct Rng32(u32);

impl Default for Rng32 {
    fn default() -> Self {
        Rng32(0x9E37_79B9)
    }
}

impl Rng32 {
    pub fn new(seed: u64) -> Self {
        let s = (seed ^ (seed >> 32)) as u32;
        Rng32(if s == 0 { 0x9E37_79B9 } else { s })
    }
    pub fn next_u32(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x
    }
    /// Uniform in [0, 1).
    pub fn unit(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 / (1u32 << 24) as f32
    }
    /// Uniform in [-1, 1).
    pub fn signed(&mut self) -> f32 {
        self.unit() * 2.0 - 1.0
    }
    pub fn below(&mut self, n: usize) -> usize {
        if n <= 1 { 0 } else { ((self.next_u32() as u64 * n as u64) >> 32) as usize }
    }
}

/// Choose a clip index for a cue with `n` clips.
pub fn pick_clip(pick: Pick, n: usize, st: &mut CueState, rng: &mut Rng32) -> usize {
    if n <= 1 {
        return 0;
    }
    let i = match pick {
        Pick::Random => rng.below(n) as u16,
        Pick::Sequence => {
            let i = st.next % n as u16;
            st.next = (i + 1) % n as u16;
            i
        }
        Pick::Shuffle => {
            if st.bag.is_empty() {
                st.bag.extend(0..n as u16);
                // Fisher–Yates; the bag is popped from the back.
                for k in (1..n).rev() {
                    st.bag.swap(k, rng.below(k + 1));
                }
                // No repeat across rounds: the first of the new round ≠ the last played.
                if let (Some(last), Some(&first)) = (st.last, st.bag.last())
                    && first == last
                {
                    st.bag.swap(0, n - 1);
                }
            }
            st.bag.pop().unwrap_or(0)
        }
    };
    st.last = Some(i);
    i as usize
}

/// Every cue, by name. Add in a startup system (needs clip handles).
#[derive(Resource, Clone, Debug, Default)]
pub struct SoundCues {
    cues: Vec<SoundCue>,
    pub(crate) states: Vec<CueState>,
    index: HashMap<Cow<'static, str>, u16>,
}

impl SoundCues {
    /// Adds a cue (replaces one with the same name).
    pub fn add(&mut self, cue: SoundCue) -> CueId {
        if let Some(&i) = self.index.get(cue.name.as_ref()) {
            self.cues[i as usize] = cue;
            self.states[i as usize] = CueState::default();
            return CueId(i);
        }
        let i = self.cues.len() as u16;
        self.index.insert(cue.name.clone(), i);
        self.cues.push(cue);
        self.states.push(CueState::default());
        CueId(i)
    }

    pub fn id(&self, name: &str) -> Option<CueId> {
        self.index.get(name).map(|&i| CueId(i))
    }

    pub fn get(&self, name: &str) -> Option<&SoundCue> {
        self.id(name).map(|i| &self.cues[i.0 as usize])
    }

    pub fn by_id(&self, id: CueId) -> &SoundCue {
        &self.cues[id.0 as usize]
    }

    pub fn iter(&self) -> impl Iterator<Item = &SoundCue> {
        self.cues.iter()
    }

    pub fn len(&self) -> usize {
        self.cues.len()
    }

    pub fn is_empty(&self) -> bool {
        self.cues.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shuffle_covers_all_and_never_repeats() {
        let mut st = CueState::default();
        let mut rng = Rng32::new(42);
        let mut prev = None;
        for round in 0..50 {
            let mut seen = [false; 5];
            for _ in 0..5 {
                let i = pick_clip(Pick::Shuffle, 5, &mut st, &mut rng);
                assert_ne!(Some(i), prev, "repeat in round {round}");
                seen[i] = true;
                prev = Some(i);
            }
            assert!(seen.iter().all(|s| *s), "each clip once per round");
        }
    }

    #[test]
    fn sequence_and_random() {
        let mut st = CueState::default();
        let mut rng = Rng32::new(1);
        let seq: Vec<usize> = (0..7).map(|_| pick_clip(Pick::Sequence, 3, &mut st, &mut rng)).collect();
        assert_eq!(seq, [0, 1, 2, 0, 1, 2, 0]);
        let mut counts = [0; 4];
        for _ in 0..4000 {
            counts[pick_clip(Pick::Random, 4, &mut st, &mut rng)] += 1;
        }
        assert!(counts.iter().all(|&c| (800..1200).contains(&c)), "uniform-ish: {counts:?}");
        assert_eq!(pick_clip(Pick::Shuffle, 1, &mut st, &mut rng), 0);
    }

    #[test]
    fn rolloff_curves() {
        let lin = Attenuation { min_distance: 2.0, max_distance: 12.0, rolloff: Rolloff::Linear, ..default() };
        assert_eq!(lin.gain(1.0), 1.0);
        assert!((lin.gain(7.0) - 0.5).abs() < 1e-6);
        assert_eq!(lin.gain(12.0), 0.0);
        let log = Attenuation { min_distance: 1.0, max_distance: 100.0, ..default() };
        assert!((log.gain(10.0) - 0.1).abs() < 1e-6, "inverse distance");
        assert!(log.gain(95.0) < 0.01 && log.gain(100.0) == 0.0, "fades to silence at max");
        let custom = Attenuation { min_distance: 0.0, max_distance: 10.0, rolloff: Rolloff::Custom(vec![(0.0, 1.0), (0.5, 0.8), (1.0, 0.0)]), ..default() };
        assert!((custom.gain(2.5) - 0.9).abs() < 1e-3);
        assert!((custom.gain(7.5) - 0.4).abs() < 1e-3);
        let half = Attenuation { spatial_blend: 0.5, ..lin.clone() };
        assert!((half.blended_gain(12.0) - 0.5).abs() < 1e-6, "2D half stays");
    }

    #[test]
    fn registry_replaces_by_name() {
        let mut c = SoundCues::default();
        let a = c.add(SoundCue::new("a"));
        c.add(SoundCue::new("b"));
        let a2 = c.add(SoundCue::new("a").volume(-3.0));
        assert_eq!(a, a2);
        assert_eq!(c.len(), 2);
        assert_eq!(c.get("a").unwrap().volume_db, -3.0);
        let cue = SoundCue::new("x").caption(Caption::speech("A", "one")).caption(Caption::speech("A", "two"));
        assert_eq!(cue.caption_for(1).unwrap().text, "two");
    }
}
