//! The mix: a bus tree (master → music, sfx, voice, ui, ambience; games add more), per-bus
//! user volume / mute / solo, mix snapshots blended by weight with fades, and ducking rules
//! (sidechain on bus activity with attack / hold / release). Pure logic: [`Mixer::update`]
//! computes each bus's local gain, low-pass and reverb send; the backend only receives the
//! numbers that changed.
//!
//! ```ignore
//! fn setup(mut mixer: ResMut<Mixer>) {
//!     let radio = mixer.add_bus("radio", BusId::VOICE);
//!     mixer.add_snapshot(MixSnapshot::new("slowmo").volume("music", -6.0).lowpass("sfx", 2_000.0).fades(0.3, 0.8));
//!     mixer.set_snapshot("slowmo", true);
//!     mixer.set_volume(radio, 0.7);
//! }
//! ```

use std::borrow::Cow;

use bevy::prelude::*;

use super::dsp::{MAX_BUSES, ReverbParams};

/// Index of a bus in [`Mixer`]. The six built-ins have fixed ids.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Default)]
pub struct BusId(pub u16);

impl BusId {
    pub const MASTER: BusId = BusId(0);
    pub const MUSIC: BusId = BusId(1);
    pub const SFX: BusId = BusId(2);
    pub const VOICE: BusId = BusId(3);
    pub const UI: BusId = BusId(4);
    pub const AMBIENCE: BusId = BusId(5);
}

/// Decibels → linear gain.
#[inline]
pub fn db_to_lin(db: f32) -> f32 {
    if db <= -96.0 { 0.0 } else { 10f32.powf(db / 20.0) }
}

/// Linear gain → decibels (−∞ clamped to −96).
#[inline]
pub fn lin_to_db(g: f32) -> f32 {
    if g <= 1.6e-5 { -96.0 } else { 20.0 * g.log10() }
}

/// Interpolate a cut-off in log-frequency space (what the ear hears as linear).
#[inline]
pub fn lerp_hz(a: f32, b: f32, t: f32) -> f32 {
    if t <= 0.0 {
        a
    } else if t >= 1.0 {
        b
    } else {
        (a.max(1.0).ln() + (b.max(1.0).ln() - a.max(1.0).ln()) * t).exp()
    }
}

pub const NO_LOWPASS: f32 = 20_000.0;

#[derive(Clone, Debug)]
pub struct Bus {
    pub name: Cow<'static, str>,
    pub parent: Option<BusId>,
    /// User volume, linear 0..1 (settings / `sound.bus`).
    pub volume: f32,
    pub mute: bool,
    pub solo: bool,
    /// Computed by [`Mixer::update`]: this bus's own gain (volume × mute/solo × snapshot × duck).
    pub local_gain: f32,
    /// Computed: product of local gains from master down to this bus.
    pub effective: f32,
    pub lowpass_hz: f32,
    pub reverb_send: f32,
    pub snapshot_db: f32,
    pub duck_db: f32,
}

/// What a snapshot does to one bus at full weight.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BusOverride {
    pub volume_db: f32,
    pub lowpass_hz: f32,
    pub reverb_send: f32,
}

impl Default for BusOverride {
    fn default() -> Self {
        BusOverride { volume_db: 0.0, lowpass_hz: NO_LOWPASS, reverb_send: 0.0 }
    }
}

/// A named mix state ("paused", "underwater"). Several can be active; they blend by weight:
/// dB offsets add, cut-offs take the lowest (log-interpolated by weight), sends the highest.
#[derive(Clone, Debug)]
pub struct MixSnapshot {
    pub name: Cow<'static, str>,
    pub buses: Vec<(Cow<'static, str>, BusOverride)>,
    /// Seconds to reach full weight / to fall back to zero.
    pub fade_in: f32,
    pub fade_out: f32,
    /// Reverb character while active (blended from the default by weight).
    pub reverb: Option<ReverbParams>,
}

impl Default for MixSnapshot {
    fn default() -> Self {
        MixSnapshot { name: Cow::Borrowed(""), buses: Vec::new(), fade_in: 0.4, fade_out: 0.6, reverb: None }
    }
}

impl MixSnapshot {
    pub fn new(name: impl Into<Cow<'static, str>>) -> Self {
        MixSnapshot { name: name.into(), ..default() }
    }
    fn entry(&mut self, bus: impl Into<Cow<'static, str>>) -> &mut BusOverride {
        let bus = bus.into();
        let i = match self.buses.iter().position(|(n, _)| *n == bus) {
            Some(i) => i,
            None => {
                self.buses.push((bus, BusOverride::default()));
                self.buses.len() - 1
            }
        };
        &mut self.buses[i].1
    }
    pub fn volume(mut self, bus: impl Into<Cow<'static, str>>, db: f32) -> Self {
        self.entry(bus).volume_db = db;
        self
    }
    pub fn lowpass(mut self, bus: impl Into<Cow<'static, str>>, hz: f32) -> Self {
        self.entry(bus).lowpass_hz = hz;
        self
    }
    pub fn reverb_send(mut self, bus: impl Into<Cow<'static, str>>, amount: f32) -> Self {
        self.entry(bus).reverb_send = amount.clamp(0.0, 1.0);
        self
    }
    pub fn fades(mut self, fade_in: f32, fade_out: f32) -> Self {
        self.fade_in = fade_in.max(0.0);
        self.fade_out = fade_out.max(0.0);
        self
    }
    pub fn reverb(mut self, p: ReverbParams) -> Self {
        self.reverb = Some(p);
        self
    }
}

/// Sidechain ducking: while `trigger` (or a child bus) has an audible voice, each target bus
/// is lowered by its dB depth, with attack / hold / release in seconds.
#[derive(Clone, Debug)]
pub struct DuckRule {
    pub trigger: Cow<'static, str>,
    pub targets: Vec<(Cow<'static, str>, f32)>,
    pub attack: f32,
    pub hold: f32,
    pub release: f32,
}

impl Default for DuckRule {
    fn default() -> Self {
        DuckRule { trigger: Cow::Borrowed("voice"), targets: Vec::new(), attack: 0.12, hold: 0.25, release: 0.7 }
    }
}

impl DuckRule {
    pub fn new(trigger: impl Into<Cow<'static, str>>) -> Self {
        DuckRule { trigger: trigger.into(), ..default() }
    }
    pub fn duck(mut self, bus: impl Into<Cow<'static, str>>, db: f32) -> Self {
        self.targets.push((bus.into(), -db.abs()));
        self
    }
    pub fn times(mut self, attack: f32, hold: f32, release: f32) -> Self {
        self.attack = attack.max(0.0);
        self.hold = hold.max(0.0);
        self.release = release.max(0.0);
        self
    }
}

/// Ducking envelope 0..1: linear rise over `attack`, hold, linear fall over `release`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Envelope {
    pub value: f32,
    hold_left: f32,
}

impl Envelope {
    pub fn step(&mut self, active: bool, dt: f32, attack: f32, hold: f32, release: f32) -> f32 {
        if active {
            self.hold_left = hold;
            self.value = if attack <= 0.0 { 1.0 } else { (self.value + dt / attack).min(1.0) };
        } else if self.hold_left > 0.0 {
            self.hold_left -= dt;
        } else {
            self.value = if release <= 0.0 { 0.0 } else { (self.value - dt / release).max(0.0) };
        }
        self.value
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct SnapState {
    target: f32,
    manual: f32,
    zone: f32,
}

impl SnapState {
    fn weight(&self) -> f32 {
        self.manual.max(self.zone)
    }
}

/// Buses, snapshots and ducks. See the module docs.
#[derive(Resource, Clone, Debug)]
pub struct Mixer {
    buses: Vec<Bus>,
    snapshots: Vec<MixSnapshot>,
    snap: Vec<SnapState>,
    ducks: Vec<DuckRule>,
    envs: Vec<Envelope>,
    /// Per bus: had an audible voice this frame (set by the voice system, incl. children).
    pub(crate) activity: Vec<bool>,
    pub(crate) reverb: ReverbParams,
    /// Bumped when buses are added (the backend resends the topology).
    pub(crate) topology: u32,
    dirty: bool,
}

impl Default for Mixer {
    fn default() -> Self {
        let mut m = Mixer {
            buses: Vec::new(),
            snapshots: Vec::new(),
            snap: Vec::new(),
            ducks: Vec::new(),
            envs: Vec::new(),
            activity: Vec::new(),
            reverb: ReverbParams::default(),
            topology: 1,
            dirty: true,
        };
        m.push_bus("master", None);
        for name in ["music", "sfx", "voice", "ui", "ambience"] {
            m.push_bus(name, Some(BusId::MASTER));
        }
        m.add_snapshot(
            MixSnapshot::new("paused")
                .volume("music", -8.0)
                .lowpass("music", 2_500.0)
                .volume("sfx", -10.0)
                .lowpass("sfx", 900.0)
                .volume("ambience", -12.0)
                .lowpass("ambience", 900.0)
                .volume("voice", -6.0)
                .fades(0.25, 0.5),
        );
        m.add_snapshot(
            MixSnapshot::new("underwater")
                .lowpass("sfx", 600.0)
                .lowpass("ambience", 500.0)
                .lowpass("voice", 1_200.0)
                .lowpass("music", 1_500.0)
                .volume("sfx", -4.0)
                .reverb_send("sfx", 0.35)
                .reverb(ReverbParams { room: 0.85, damping: 0.8, wet: 0.7 })
                .fades(0.3, 0.5),
        );
        m.add_snapshot(
            MixSnapshot::new("cave")
                .reverb_send("sfx", 0.45)
                .reverb_send("voice", 0.25)
                .reverb_send("ambience", 0.2)
                .reverb(ReverbParams { room: 0.9, damping: 0.3, wet: 0.8 })
                .fades(0.6, 0.8),
        );
        m.add_duck(DuckRule::new("voice").duck("music", 9.0).duck("sfx", 4.0).duck("ambience", 6.0));
        m
    }
}

impl Mixer {
    fn push_bus(&mut self, name: &'static str, parent: Option<BusId>) -> BusId {
        self.buses.push(Bus {
            name: Cow::Borrowed(name),
            parent,
            volume: 1.0,
            mute: false,
            solo: false,
            local_gain: 1.0,
            effective: 1.0,
            lowpass_hz: NO_LOWPASS,
            reverb_send: 0.0,
            snapshot_db: 0.0,
            duck_db: 0.0,
        });
        self.activity.push(false);
        BusId(self.buses.len() as u16 - 1)
    }

    /// Adds a bus under `parent` (or returns the existing one with that name). At most
    /// [`MAX_BUSES`]; beyond that the bus maps onto `parent`.
    pub fn add_bus(&mut self, name: impl Into<Cow<'static, str>>, parent: BusId) -> BusId {
        let name = name.into();
        if let Some(id) = self.bus(&name) {
            return id;
        }
        if self.buses.len() >= MAX_BUSES || parent.0 as usize >= self.buses.len() {
            warn!("sound: bus '{name}' not added (limit {MAX_BUSES} or bad parent); using its parent");
            return parent;
        }
        let id = self.push_bus("", Some(parent));
        self.buses[id.0 as usize].name = name;
        self.topology += 1;
        self.dirty = true;
        id
    }

    pub fn bus(&self, name: &str) -> Option<BusId> {
        self.buses.iter().position(|b| b.name == name).map(|i| BusId(i as u16))
    }

    pub fn buses(&self) -> &[Bus] {
        &self.buses
    }

    pub fn get(&self, id: BusId) -> Option<&Bus> {
        self.buses.get(id.0 as usize)
    }

    pub fn set_volume(&mut self, id: BusId, v: f32) {
        if let Some(b) = self.buses.get_mut(id.0 as usize)
            && b.volume != v
        {
            b.volume = v.clamp(0.0, 4.0);
            self.dirty = true;
        }
    }

    pub fn set_mute(&mut self, id: BusId, mute: bool) {
        if let Some(b) = self.buses.get_mut(id.0 as usize) {
            b.mute = mute;
            self.dirty = true;
        }
    }

    pub fn set_solo(&mut self, id: BusId, solo: bool) {
        if let Some(b) = self.buses.get_mut(id.0 as usize) {
            b.solo = solo;
            self.dirty = true;
        }
    }

    /// Master-to-bus gain product (what a voice on this bus is multiplied by).
    pub fn effective_gain(&self, id: BusId) -> f32 {
        self.buses.get(id.0 as usize).map_or(0.0, |b| b.effective)
    }

    /// Adds or replaces (same name) a snapshot.
    pub fn add_snapshot(&mut self, s: MixSnapshot) {
        match self.snapshots.iter().position(|o| o.name == s.name) {
            Some(i) => self.snapshots[i] = s,
            None => {
                self.snapshots.push(s);
                self.snap.push(SnapState::default());
            }
        }
        self.dirty = true;
    }

    pub fn snapshots(&self) -> impl Iterator<Item = &MixSnapshot> {
        self.snapshots.iter()
    }

    /// Turn a snapshot on/off (fades by its own times). `false` if unknown.
    pub fn set_snapshot(&mut self, name: &str, on: bool) -> bool {
        match self.snapshots.iter().position(|s| s.name == name) {
            Some(i) => {
                self.snap[i].target = if on { 1.0 } else { 0.0 };
                self.dirty = true;
                true
            }
            None => false,
        }
    }

    /// Release every manually set snapshot.
    pub fn clear_snapshots(&mut self) {
        for s in &mut self.snap {
            s.target = 0.0;
        }
        self.dirty = true;
    }

    /// Current blend weight 0..1.
    pub fn snapshot_weight(&self, name: &str) -> f32 {
        self.snapshots.iter().position(|s| s.name == name).map_or(0.0, |i| self.snap[i].weight())
    }

    /// `(name, weight)` of snapshots with any weight or a pending target.
    pub fn active_snapshots(&self) -> impl Iterator<Item = (&str, f32)> {
        self.snapshots
            .iter()
            .zip(&self.snap)
            .filter(|(_, s)| s.weight() > 0.0 || s.target > 0.0)
            .map(|(m, s)| (m.name.as_ref(), s.weight()))
    }

    /// Weight from reverb/ambience zones (already spatially smooth). Set every frame.
    pub(crate) fn set_zone_weight(&mut self, idx: usize, w: f32) {
        if let Some(s) = self.snap.get_mut(idx)
            && (s.zone - w).abs() > 1e-4
        {
            s.zone = w.clamp(0.0, 1.0);
            self.dirty = true;
        }
    }

    pub(crate) fn snapshot_index(&self, name: &str) -> Option<usize> {
        self.snapshots.iter().position(|s| s.name == name)
    }

    pub(crate) fn snapshot_count(&self) -> usize {
        self.snapshots.len()
    }

    pub fn add_duck(&mut self, rule: DuckRule) {
        self.ducks.push(rule);
        self.envs.push(Envelope::default());
        self.dirty = true;
    }

    pub fn clear_ducks(&mut self) {
        self.ducks.clear();
        self.envs.clear();
        self.dirty = true;
    }

    pub fn ducks(&self) -> &[DuckRule] {
        &self.ducks
    }

    /// Envelope value 0..1 of duck rule `i`.
    pub fn duck_level(&self, i: usize) -> f32 {
        self.envs.get(i).map_or(0.0, |e| e.value)
    }

    /// Mark bus activity (and its ancestors') for this frame. Cleared by [`Mixer::update`].
    pub(crate) fn mark_active(&mut self, id: BusId) {
        let mut cur = Some(id);
        while let Some(b) = cur {
            match self.activity.get_mut(b.0 as usize) {
                Some(a) if !*a => *a = true,
                _ => break,
            }
            cur = self.buses[b.0 as usize].parent;
        }
    }

    /// Advance snapshot fades and duck envelopes by `dt`, recompute bus parameters.
    /// Returns whether any bus parameter changed (cheap no-op when idle).
    pub fn update(&mut self, dt: f32) -> bool {
        let mut moving = false;
        for (s, st) in self.snapshots.iter().zip(&mut self.snap) {
            if st.manual != st.target {
                let fade = if st.target > st.manual { s.fade_in } else { s.fade_out };
                st.manual = if fade <= 0.0 {
                    st.target
                } else {
                    let step = dt / fade;
                    if st.target > st.manual { (st.manual + step).min(st.target) } else { (st.manual - step).max(st.target) }
                };
                moving = true;
            }
        }
        for (i, rule) in self.ducks.iter().enumerate() {
            let active = self.buses.iter().position(|b| b.name == rule.trigger).is_some_and(|t| self.activity[t]);
            let before = self.envs[i].value;
            let after = self.envs[i].step(active, dt, rule.attack, rule.hold, rule.release);
            moving |= before != after;
        }
        self.activity.iter_mut().for_each(|a| *a = false);
        if !(moving || self.dirty) {
            return false;
        }
        self.dirty = false;
        self.recompute();
        true
    }

    fn recompute(&mut self) {
        let n = self.buses.len();
        // Solo: soloed buses, their ancestors and their descendants stay audible.
        let any_solo = self.buses.iter().any(|b| b.solo);
        let mut keep = [!any_solo; MAX_BUSES];
        if any_solo {
            for i in 0..n {
                if self.buses[i].solo {
                    let mut cur = Some(BusId(i as u16));
                    while let Some(b) = cur {
                        keep[b.0 as usize] = true;
                        cur = self.buses[b.0 as usize].parent;
                    }
                }
            }
            for (i, k) in keep.iter_mut().enumerate().take(n) {
                // Descendants of a soloed bus.
                let mut cur = self.buses[i].parent;
                while let Some(p) = cur {
                    if self.buses[p.0 as usize].solo {
                        *k = true;
                        break;
                    }
                    cur = self.buses[p.0 as usize].parent;
                }
            }
        }
        let mut reverb = ReverbParams::default();
        let mut best = 0.0f32;
        for b in &mut self.buses {
            b.snapshot_db = 0.0;
            b.duck_db = 0.0;
            b.lowpass_hz = NO_LOWPASS;
            b.reverb_send = 0.0;
        }
        for (s, st) in self.snapshots.iter().zip(&self.snap) {
            let w = st.weight();
            if w <= 0.0 {
                continue;
            }
            for (name, o) in &s.buses {
                if let Some(b) = self.buses.iter_mut().find(|b| b.name == *name) {
                    b.snapshot_db += o.volume_db * w;
                    b.lowpass_hz = b.lowpass_hz.min(lerp_hz(NO_LOWPASS, o.lowpass_hz, w));
                    b.reverb_send = b.reverb_send.max(o.reverb_send * w);
                }
            }
            if let Some(p) = s.reverb
                && w > best
            {
                best = w;
                let d = ReverbParams::default();
                reverb = ReverbParams {
                    room: d.room + (p.room - d.room) * w,
                    damping: d.damping + (p.damping - d.damping) * w,
                    wet: d.wet + (p.wet - d.wet) * w,
                };
            }
        }
        for (rule, env) in self.ducks.iter().zip(&self.envs) {
            if env.value <= 0.0 {
                continue;
            }
            for (name, depth) in &rule.targets {
                if let Some(b) = self.buses.iter_mut().find(|b| b.name == *name) {
                    b.duck_db += depth * env.value;
                }
            }
        }
        self.reverb = reverb;
        for (i, &kept) in keep.iter().enumerate().take(n) {
            let b = &self.buses[i];
            let on = if b.mute || !kept { 0.0 } else { 1.0 };
            let local = b.volume * on * db_to_lin(b.snapshot_db + b.duck_db);
            let parent = b.parent.map_or(1.0, |p| self.buses[p.0 as usize].effective);
            let b = &mut self.buses[i];
            b.local_gain = local;
            b.effective = local * parent;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settle(m: &mut Mixer, secs: f32) {
        let dt = 1.0 / 60.0;
        for _ in 0..(secs / dt) as usize {
            m.update(dt);
        }
    }

    #[test]
    fn hierarchy_volume_mute_solo() {
        let mut m = Mixer::default();
        let radio = m.add_bus("radio", BusId::VOICE);
        assert_eq!(m.add_bus("radio", BusId::SFX), radio, "same name → same bus");
        m.set_volume(BusId::MASTER, 0.5);
        m.set_volume(BusId::VOICE, 0.5);
        m.set_volume(radio, 0.8);
        m.update(0.0);
        assert!((m.effective_gain(radio) - 0.2).abs() < 1e-5);
        m.set_mute(BusId::VOICE, true);
        m.update(0.0);
        assert_eq!(m.effective_gain(radio), 0.0, "muting a parent silences children");
        m.set_mute(BusId::VOICE, false);
        m.set_solo(BusId::MUSIC, true);
        m.update(0.0);
        assert_eq!(m.effective_gain(BusId::SFX), 0.0, "solo silences siblings");
        assert_eq!(m.effective_gain(radio), 0.0);
        assert!(m.effective_gain(BusId::MUSIC) > 0.0, "soloed bus stays");
        assert!(m.effective_gain(BusId::MASTER) > 0.0, "its ancestors stay");
        m.set_solo(BusId::MUSIC, false);
        m.set_solo(BusId::VOICE, true);
        m.update(0.0);
        assert!(m.effective_gain(radio) > 0.0, "descendants of a soloed bus stay");
    }

    #[test]
    fn snapshot_fades_in_and_blends() {
        let mut m = Mixer::default();
        assert!(m.set_snapshot("paused", true));
        m.update(0.125); // half of the 0.25 s fade-in
        assert!((m.snapshot_weight("paused") - 0.5).abs() < 1e-4);
        let sfx = m.get(BusId::SFX).unwrap();
        assert!((sfx.snapshot_db + 5.0).abs() < 1e-3, "half weight → half the dB: {}", sfx.snapshot_db);
        let mid = sfx.lowpass_hz;
        assert!(mid < 20_000.0 && mid > 900.0, "cut-off log-interpolated: {mid}");
        assert!((mid - (20_000f32 * 900.0).sqrt()).abs() < 5.0, "geometric mean at half weight: {mid}");
        settle(&mut m, 1.0);
        assert_eq!(m.snapshot_weight("paused"), 1.0);
        assert!((m.get(BusId::SFX).unwrap().lowpass_hz - 900.0).abs() < 1.0);
        // Second snapshot: dB add, lowest cut-off wins.
        m.set_snapshot("underwater", true);
        settle(&mut m, 1.0);
        let sfx = m.get(BusId::SFX).unwrap();
        assert!((sfx.snapshot_db + 14.0).abs() < 1e-3);
        assert!((sfx.lowpass_hz - 600.0).abs() < 1.0);
        assert!(m.reverb.room > 0.8, "underwater reverb active");
        m.set_snapshot("paused", false);
        m.set_snapshot("underwater", false);
        settle(&mut m, 1.0);
        assert_eq!(m.active_snapshots().count(), 0);
        assert_eq!(m.get(BusId::SFX).unwrap().lowpass_hz, NO_LOWPASS);
        assert!(!m.set_snapshot("nope", true));
    }

    #[test]
    fn ducking_attack_hold_release() {
        let mut m = Mixer::default();
        m.update(0.0);
        let dt = 1.0 / 60.0;
        let music = || BusId::MUSIC;
        // Voice active for 0.5 s: full duck after the 0.12 s attack.
        for _ in 0..30 {
            m.mark_active(BusId::VOICE);
            m.update(dt);
        }
        assert_eq!(m.duck_level(0), 1.0);
        assert!((m.get(music()).unwrap().duck_db + 9.0).abs() < 1e-4);
        assert!((m.effective_gain(music()) - db_to_lin(-9.0)).abs() < 1e-4);
        // Hold 0.25 s, then release over 0.7 s.
        settle(&mut m, 0.2);
        assert_eq!(m.duck_level(0), 1.0, "still holding");
        settle(&mut m, 0.4);
        let mid = m.duck_level(0);
        assert!(mid > 0.0 && mid < 1.0, "releasing: {mid}");
        settle(&mut m, 1.0);
        assert_eq!(m.duck_level(0), 0.0);
        assert!((m.effective_gain(music()) - 1.0).abs() < 1e-6);
        // A child bus of voice triggers the duck too.
        let radio = m.add_bus("radio", BusId::VOICE);
        m.mark_active(radio);
        m.update(dt);
        assert!(m.duck_level(0) > 0.0);
    }

    #[test]
    fn idle_update_is_a_no_op() {
        let mut m = Mixer::default();
        assert!(m.update(0.016));
        assert!(!m.update(0.016), "nothing moving → nothing recomputed");
    }

    #[test]
    fn envelope_math() {
        let mut e = Envelope::default();
        assert_eq!(e.step(true, 0.05, 0.1, 0.0, 0.2), 0.5);
        assert_eq!(e.step(true, 0.1, 0.1, 0.0, 0.2), 1.0);
        assert!((e.step(false, 0.1, 0.1, 0.0, 0.2) - 0.5).abs() < 1e-6);
        assert_eq!(e.step(false, 1.0, 0.1, 0.0, 0.2), 0.0);
        assert_eq!(e.step(true, 0.0, 0.0, 0.0, 0.0), 1.0, "zero attack is instant");
    }
}
