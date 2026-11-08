//! Per-talker jitter buffer: reorders frames by capture index, holds a playout delay that
//! adapts to measured jitter (60 ms by default), and conceals losses by repeating the last
//! frame while fading it out. Pure: the caller supplies arrival times and pulls one 20 ms
//! frame per 20 ms of playout clock (the audio device's clock in the game). No allocation
//! after construction.

use super::adpcm::{self, FRAME, FRAME_BYTES};

/// Frames the buffer can hold (1.28 s).
pub const SLOTS: usize = 64;
/// Frame length in ms.
pub const FRAME_MS: f32 = 20.0;

#[derive(Clone, Copy, Debug)]
pub struct JitterConfig {
    /// Playout delay with a clean link.
    pub target_ms: f32,
    /// Upper bound for the adaptive delay.
    pub max_ms: f32,
    /// Delay = max(target, jitter × this).
    pub jitter_factor: f32,
    /// Concealed frames before the talk spurt is considered over (silence after a fade).
    pub conceal_frames: u32,
    /// Drop a frame to catch up when this many frames beyond the delay are buffered.
    pub excess_frames: u32,
}

impl Default for JitterConfig {
    fn default() -> Self {
        JitterConfig { target_ms: 60.0, max_ms: 300.0, jitter_factor: 3.0, conceal_frames: 8, excess_frames: 4 }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize)]
pub struct JitterStats {
    pub received: u32,
    pub played: u32,
    /// Frames that arrived after their playout time.
    pub late: u32,
    pub duplicate: u32,
    /// Missing frames filled by repeating/fading the last one.
    pub concealed: u32,
    /// Frames dropped to shrink an overfull buffer.
    pub skipped: u32,
    /// Frames thrown away as undecodable.
    pub corrupt: u32,
    /// Talk spurts started.
    pub spurts: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Idle,
    Buffering { start: u32, waited: u32 },
    Playing { next: u32 },
}

#[derive(Clone, Copy)]
struct Slot {
    ts: u32,
    used: bool,
    data: [u8; FRAME_BYTES],
}

pub struct JitterBuffer {
    cfg: JitterConfig,
    slots: Box<[Slot; SLOTS]>,
    phase: Phase,
    /// Newest frame index received in this spurt.
    newest: Option<u32>,
    /// Frames before this index were played (or skipped): later arrivals are late.
    played_upto: u32,
    last: [i16; FRAME],
    has_last: bool,
    gain: f32,
    conceal: u32,
    /// RFC 3550 interarrival jitter estimate (ms).
    jitter_ms: f32,
    last_transit: Option<f64>,
    delay_ms: f32,
    stats: JitterStats,
}

impl JitterBuffer {
    pub fn new(cfg: JitterConfig) -> Self {
        JitterBuffer {
            cfg,
            slots: Box::new([Slot { ts: 0, used: false, data: [0; FRAME_BYTES] }; SLOTS]),
            phase: Phase::Idle,
            newest: None,
            played_upto: 0,
            last: [0; FRAME],
            has_last: false,
            gain: 1.0,
            conceal: 0,
            jitter_ms: 0.0,
            last_transit: None,
            delay_ms: cfg.target_ms,
            stats: JitterStats::default(),
        }
    }

    pub fn stats(&self) -> JitterStats {
        self.stats
    }
    /// Current playout delay (ms), re-chosen at the start of every talk spurt.
    pub fn delay_ms(&self) -> f32 {
        self.delay_ms
    }
    pub fn jitter_ms(&self) -> f32 {
        self.jitter_ms
    }
    /// Playing real or concealed audio (not idle or pre-buffering).
    pub fn playing(&self) -> bool {
        matches!(self.phase, Phase::Playing { .. })
    }
    /// Frames waiting in the buffer.
    pub fn depth(&self) -> usize {
        self.slots.iter().filter(|s| s.used).count()
    }

    /// A frame arrived: `ts` is its capture frame index, `now_ms` the local arrival time.
    pub fn push(&mut self, ts: u32, data: &[u8], now_ms: f64) {
        if data.len() != FRAME_BYTES {
            self.stats.corrupt += 1;
            return;
        }
        self.stats.received += 1;
        let next = match self.phase {
            Phase::Playing { next } => Some(next),
            Phase::Buffering { start, .. } => Some(start),
            Phase::Idle => None,
        };
        let behind = u64::from(ts) + SLOTS as u64 <= u64::from(self.played_upto);
        let ahead = next.is_some_and(|n| u64::from(ts) >= u64::from(n) + SLOTS as u64);
        if behind || ahead {
            // Far behind (the sender restarted its frame count) or far ahead (long outage):
            // start over from this frame, and don't count the jump as jitter.
            self.reset_slots();
            self.phase = Phase::Idle;
            self.played_upto = self.played_upto.min(ts);
            self.last_transit = None;
        }
        // Jitter: variation of (arrival − send time) between consecutive packets.
        let transit = now_ms - f64::from(ts) * f64::from(FRAME_MS);
        if let Some(prev) = self.last_transit {
            let d = (transit - prev).abs() as f32;
            // One wild sample (a stall) can't blow the estimate up.
            self.jitter_ms += (d.min(500.0) - self.jitter_ms) / 16.0;
        }
        self.last_transit = Some(transit);
        if ts < self.played_upto {
            self.stats.late += 1;
            return;
        }
        if let Phase::Buffering { start, waited } = self.phase
            && ts < start
        {
            // An earlier frame of the spurt we are buffering: begin from it instead.
            self.phase = Phase::Buffering { start: ts, waited };
        }
        let slot = &mut self.slots[ts as usize % SLOTS];
        if slot.used && slot.ts == ts {
            self.stats.duplicate += 1;
            return;
        }
        slot.ts = ts;
        slot.used = true;
        slot.data.copy_from_slice(data);
        self.newest = Some(self.newest.map_or(ts, |n| n.max(ts)));
    }

    fn reset_slots(&mut self) {
        for s in self.slots.iter_mut() {
            s.used = false;
        }
        self.newest = None;
    }

    fn oldest(&self) -> Option<u32> {
        self.slots.iter().filter(|s| s.used).map(|s| s.ts).min()
    }

    /// The next 20 ms of audio. Returns `false` (and silence) while idle or buffering.
    pub fn pull(&mut self, out: &mut [i16; FRAME]) -> bool {
        if self.phase == Phase::Idle
            && let Some(start) = self.oldest()
        {
            let want = (self.jitter_ms * self.cfg.jitter_factor).max(self.cfg.target_ms).min(self.cfg.max_ms);
            self.delay_ms = (want / FRAME_MS).ceil() * FRAME_MS;
            self.phase = Phase::Buffering { start, waited: 0 };
            self.stats.spurts += 1;
            self.has_last = false;
            self.gain = 1.0;
        }
        if let Phase::Buffering { start, waited } = self.phase {
            // The first frame waits out the playout delay; frames behind it get that much slack.
            if (waited as f32 + 1.0) * FRAME_MS >= self.delay_ms {
                self.phase = Phase::Playing { next: start };
            } else {
                self.phase = Phase::Buffering { start, waited: waited + 1 };
                out.fill(0);
                return false;
            }
        }
        let Phase::Playing { mut next } = self.phase else {
            out.fill(0);
            return false;
        };

        // Overfull (the sender's clock runs fast, or a burst after a stall): drop one frame.
        if let Some(newest) = self.newest {
            let ahead = newest.saturating_sub(next) as f32 * FRAME_MS;
            if ahead > self.delay_ms + self.cfg.excess_frames as f32 * FRAME_MS {
                let s = &mut self.slots[next as usize % SLOTS];
                if s.used && s.ts == next {
                    s.used = false;
                }
                self.stats.skipped += 1;
                next += 1;
            }
        }

        let slot = &mut self.slots[next as usize % SLOTS];
        let mut have = false;
        if slot.used && slot.ts == next {
            slot.used = false;
            if adpcm::decode(&slot.data, out) {
                have = true;
            } else {
                self.stats.corrupt += 1;
            }
        }
        next += 1;
        self.played_upto = next;

        if have {
            // Ramp back up if we were concealing.
            if self.gain < 1.0 {
                ramp(out, self.gain, 1.0);
                self.gain = 1.0;
            }
            self.last = *out;
            self.has_last = true;
            self.conceal = 0;
            self.stats.played += 1;
            self.phase = Phase::Playing { next };
            return true;
        }

        // Missing: repeat the last frame, fading out over three frames, then silence.
        self.conceal += 1;
        if self.conceal > self.cfg.conceal_frames {
            // Spurt over (the talker stopped, or a long outage).
            self.phase = Phase::Idle;
            self.conceal = 0;
            self.newest = None;
            out.fill(0);
            return false;
        }
        self.stats.concealed += 1;
        let g1 = (self.gain - 0.4).max(0.0);
        if self.has_last && self.gain > 0.0 {
            *out = self.last;
            ramp(out, self.gain, g1);
        } else {
            out.fill(0);
        }
        self.gain = g1;
        self.phase = Phase::Playing { next };
        true
    }
}

/// Multiply by a gain ramping linearly from `g0` to `g1` across the frame.
fn ramp(pcm: &mut [i16; FRAME], g0: f32, g1: f32) {
    let k = (g1 - g0) / FRAME as f32;
    for (i, s) in pcm.iter_mut().enumerate() {
        *s = (f32::from(*s) * (g0 + k * i as f32)) as i16;
    }
}

#[cfg(test)]
mod tests {
    use super::super::adpcm::Encoder;
    use super::*;

    /// Frame `i` encodes a constant-ish tone whose first sample tags the frame.
    fn frames(n: usize) -> Vec<[u8; FRAME_BYTES]> {
        let mut enc = Encoder::new();
        (0..n)
            .map(|i| {
                let mut pcm = [0i16; FRAME];
                for (k, s) in pcm.iter_mut().enumerate() {
                    *s = ((k as f32 * 0.3).sin() * 8000.0) as i16 + i as i16 * 10;
                }
                let mut b = [0u8; FRAME_BYTES];
                enc.encode(&pcm, &mut b);
                b
            })
            .collect()
    }

    fn decoded(b: &[u8; FRAME_BYTES]) -> [i16; FRAME] {
        let mut p = [0i16; FRAME];
        assert!(adpcm::decode(b, &mut p));
        p
    }

    /// Run: packet i is sent at 20·i ms and arrives `delay(i)` later (None = lost); pull every
    /// 20 ms. Returns the frames played (Some(index) for real, None for concealed/silent).
    fn run(n: usize, delay: impl Fn(usize) -> Option<f64>, cfg: JitterConfig) -> (Vec<Option<usize>>, JitterStats) {
        let f = frames(n);
        let mut jb = JitterBuffer::new(cfg);
        let mut arrivals: Vec<(f64, usize)> = (0..n).filter_map(|i| delay(i).map(|d| (i as f64 * 20.0 + d, i))).collect();
        arrivals.sort_by(|a, b| a.0.total_cmp(&b.0));
        let mut ai = 0;
        let mut played = Vec::new();
        let mut out = [0i16; FRAME];
        let mut t = 0.0;
        while t < (n as f64 + 30.0) * 20.0 {
            while ai < arrivals.len() && arrivals[ai].0 <= t {
                let (at, i) = arrivals[ai];
                jb.push(i as u32, &f[i], at);
                ai += 1;
            }
            if jb.pull(&mut out) {
                let hit = (0..n).find(|&i| decoded(&f[i]) == out);
                played.push(hit);
            }
            t += 20.0;
        }
        (played, jb.stats())
    }

    #[test]
    fn clean_link_plays_everything_in_order() {
        let (played, st) = run(100, |_| Some(5.0), JitterConfig::default());
        let real: Vec<usize> = played.iter().flatten().copied().collect();
        assert_eq!(real, (0..100).collect::<Vec<_>>());
        assert_eq!(st.played, 100);
        assert_eq!(st.late, 0);
        assert_eq!(st.spurts, 1);
    }

    #[test]
    fn reordering_within_the_delay_is_fixed() {
        // Every pair arrives swapped (odd before even), 30 ms apart at worst.
        let (played, st) = run(100, |i| Some(if i % 2 == 0 { 30.0 } else { 0.0 }), JitterConfig::default());
        let real: Vec<usize> = played.iter().flatten().copied().collect();
        assert_eq!(real, (0..100).collect::<Vec<_>>());
        // Only the fade after the last frame is concealment.
        assert_eq!((st.late, st.concealed), (0, 8));
    }

    #[test]
    fn loss_is_concealed_with_a_fade() {
        let f = frames(40);
        let mut jb = JitterBuffer::new(JitterConfig::default());
        let mut out = [0i16; FRAME];
        let mut t = 0.0;
        let mut energies = Vec::new();
        for i in 0..40u32 {
            if i != 20 {
                jb.push(i, &f[i as usize], t);
            }
            if jb.pull(&mut out) {
                energies.push(out.iter().map(|&s| i64::from(s).abs()).sum::<i64>());
            }
            t += 20.0;
        }
        assert_eq!(jb.stats().concealed, 1);
        // The concealed frame (played 20th) is quieter than its neighbours but not silent.
        let e = energies[20];
        assert!(e > 0 && e < energies[19] * 9 / 10, "concealed energy {e} vs {}", energies[19]);
    }

    #[test]
    fn late_frames_are_dropped_and_delay_adapts() {
        // 30 % of frames are 120 ms late: they miss the 60 ms playout and get concealed.
        let jitter = |i: usize| Some(if i % 10 < 3 { 120.0 } else { 0.0 });
        let (_, st) = run(200, jitter, JitterConfig::default());
        assert!(st.late > 0 && st.concealed > 0);
        // Two talk spurts on the same jittery link: the second one starts with a larger delay.
        let f = frames(300);
        let mut jb = JitterBuffer::new(JitterConfig::default());
        let mut out = [0i16; FRAME];
        for step in 0..300u32 {
            let t = f64::from(step) * 20.0;
            if !(100..160).contains(&step) {
                let d = if step % 10 < 3 { 120.0 } else { 0.0 };
                jb.push(step, &f[step as usize], t + d);
            }
            jb.pull(&mut out);
            if step == 10 {
                assert_eq!(jb.delay_ms(), 60.0);
            }
        }
        assert_eq!(jb.stats().spurts, 2);
        assert!(jb.delay_ms() > 60.0, "delay {} (jitter {:.1})", jb.delay_ms(), jb.jitter_ms());
    }

    #[test]
    fn heavy_loss_never_reorders_and_goes_idle_after_spurt() {
        let mut x = 7u32;
        let lost = move |_: usize| {
            x = x.wrapping_mul(1_103_515_245).wrapping_add(12345);
            (x >> 16) % 100 < 20
        };
        let lost = std::cell::RefCell::new(lost);
        let (played, st) = run(300, |_| if (lost.borrow_mut())(0) { None } else { Some(10.0) }, JitterConfig::default());
        let real: Vec<usize> = played.iter().flatten().copied().collect();
        assert!(real.windows(2).all(|w| w[0] < w[1]), "out of order");
        assert!(st.played > 200 && st.concealed > 30, "{st:?}");
        // After the last frame the buffer goes idle (pull returns false).
        let mut jb = JitterBuffer::new(JitterConfig::default());
        let f = frames(5);
        let mut out = [0i16; FRAME];
        for (i, fr) in f.iter().enumerate() {
            jb.push(i as u32, fr, 0.0);
        }
        let active = (0..40).filter(|_| jb.pull(&mut out)).count();
        assert_eq!(active, 5 + 8, "5 real frames + 8 concealed, then idle");
        assert!(!jb.playing());
    }

    #[test]
    fn duplicates_and_far_jumps() {
        let f = frames(3);
        let mut jb = JitterBuffer::new(JitterConfig::default());
        jb.push(0, &f[0], 0.0);
        jb.push(0, &f[0], 1.0);
        assert_eq!(jb.stats().duplicate, 1);
        let mut out = [0i16; FRAME];
        for _ in 0..4 {
            jb.pull(&mut out);
        }
        assert!(jb.playing());
        // The sender restarted far ahead: the buffer starts a new spurt there.
        jb.push(10_000, &f[1], 100.0);
        jb.push(10_001, &f[2], 120.0);
        let mut got = Vec::new();
        for _ in 0..6 {
            if jb.pull(&mut out) {
                got.push(out == decoded(&f[1]) || out == decoded(&f[2]));
            }
        }
        assert!(got.iter().filter(|&&g| g).count() == 2, "{got:?}");
        jb.push(5, &[1, 2, 3], 0.0);
        assert_eq!(jb.stats().corrupt, 1);
        // A new session counting from 0 again is accepted, not treated as late.
        for _ in 0..20 {
            jb.pull(&mut out);
        }
        let late = jb.stats().late;
        jb.push(0, &f[0], 500.0);
        assert_eq!(jb.stats().late, late);
        let played = jb.stats().played;
        for _ in 0..8 {
            jb.pull(&mut out);
        }
        assert_eq!(jb.stats().played, played + 1);
    }

    #[test]
    fn overfull_buffer_catches_up() {
        // The sender's clock runs 5 % fast (a frame every 19 ms): frames pile up, and the
        // buffer drops one now and then to hold its delay.
        let (played, st) = run(400, |i| Some(-(i as f64)), JitterConfig::default());
        assert!(st.skipped >= 10 && st.skipped <= 25, "{st:?}");
        let real: Vec<usize> = played.iter().flatten().copied().collect();
        assert!(real.windows(2).all(|w| w[0] < w[1]));
    }
}
