//! Small DSP pieces for voice: resampling any device rate to 16 kHz mono, frame level, the
//! open-mic voice gate, and generated test signals (no microphone needed).

use std::f32::consts::TAU;

/// Voice sample rate.
pub const RATE: u32 = 16_000;

/// RBJ biquad low-pass (direct form I).
#[derive(Clone, Copy, Debug, Default)]
struct Biquad {
    b: [f32; 3],
    a: [f32; 2],
    x: [f32; 2],
    y: [f32; 2],
}

impl Biquad {
    fn lowpass(rate: f32, hz: f32) -> Self {
        let w = TAU * hz / rate;
        let (s, c) = w.sin_cos();
        let alpha = s / (2.0 * std::f32::consts::FRAC_1_SQRT_2);
        let a0 = 1.0 + alpha;
        let b1 = (1.0 - c) / a0;
        Biquad { b: [b1 * 0.5, b1, b1 * 0.5], a: [-2.0 * c / a0, (1.0 - alpha) / a0], ..Default::default() }
    }

    #[inline]
    fn run(&mut self, x: f32) -> f32 {
        let y = self.b[0] * x + self.b[1] * self.x[0] + self.b[2] * self.x[1] - self.a[0] * self.y[0] - self.a[1] * self.y[1];
        self.x = [x, self.x[0]];
        self.y = [y, self.y[0]];
        y
    }
}

/// Streaming resampler: interleaved device samples (any rate, any channel count) → 16 kHz
/// mono. Downsampling runs a 24 dB/oct low-pass at 7 kHz first; then linear interpolation.
#[derive(Clone, Debug)]
pub struct Resampler {
    channels: usize,
    step: f64,
    pos: f64,
    prev: f32,
    lp: Option<[Biquad; 2]>,
}

impl Resampler {
    pub fn new(in_rate: u32, channels: u16) -> Self {
        let lp = (in_rate > RATE).then(|| [Biquad::lowpass(in_rate as f32, 7_000.0); 2]);
        Resampler { channels: usize::from(channels.max(1)), step: f64::from(in_rate) / f64::from(RATE), pos: 0.0, prev: 0.0, lp }
    }

    /// Feed interleaved samples (−1..1); `out` gets each 16 kHz mono sample.
    pub fn push(&mut self, interleaved: &[f32], mut out: impl FnMut(f32)) {
        let inv = 1.0 / self.channels as f32;
        for frame in interleaved.chunks_exact(self.channels) {
            let mut x = frame.iter().sum::<f32>() * inv;
            if let Some([a, b]) = &mut self.lp {
                x = b.run(a.run(x));
            }
            // Output samples falling between prev (t = 0) and x (t = 1).
            while self.pos < 1.0 {
                out(self.prev + (x - self.prev) * self.pos as f32);
                self.pos += self.step;
            }
            self.pos -= 1.0;
            self.prev = x;
        }
    }
}

/// f32 → i16 with clipping.
#[inline]
pub fn to_i16(x: f32) -> i16 {
    (x * 32767.0).round().clamp(-32768.0, 32767.0) as i16
}

/// RMS level of a frame in dBFS (−100 for silence).
pub fn level_db(pcm: &[i16]) -> f32 {
    if pcm.is_empty() {
        return -100.0;
    }
    let e: f64 = pcm.iter().map(|&s| f64::from(s) * f64::from(s)).sum::<f64>() / pcm.len() as f64;
    if e < 1.0 { -100.0 } else { (10.0 * (e / (32768.0 * 32768.0)).log10()) as f32 }
}

/// Open-mic voice gate: opens when a frame is `margin_db` above the tracked noise floor and
/// above `threshold_db`; stays open for `hang_frames` after the last loud frame.
#[derive(Clone, Debug)]
pub struct Gate {
    pub threshold_db: f32,
    pub margin_db: f32,
    pub hang_frames: u32,
    noise_db: f32,
    hang: u32,
}

impl Gate {
    pub fn new(threshold_db: f32) -> Self {
        Gate { threshold_db, margin_db: 10.0, hang_frames: 15, noise_db: -60.0, hang: 0 }
    }

    pub fn noise_db(&self) -> f32 {
        self.noise_db
    }

    /// One 20 ms frame's level in; `true` while the gate is open.
    pub fn update(&mut self, level: f32) -> bool {
        // Noise floor: falls fast to quiet frames, rises slowly (5 dB/s). Speech dips between
        // syllables keep pulling it down; a steady hum lifts it past itself in a few seconds.
        if level < self.noise_db {
            self.noise_db += (level - self.noise_db) * 0.3;
        } else {
            self.noise_db = (self.noise_db + 0.1).min(level);
        }
        self.noise_db = self.noise_db.clamp(-90.0, -25.0);
        if level > self.threshold_db && level > self.noise_db + self.margin_db {
            self.hang = self.hang_frames;
            true
        } else if self.hang > 0 {
            self.hang -= 1;
            true
        } else {
            false
        }
    }
}

/// Generated input used instead of the microphone (debug / tests).
#[derive(Clone, Debug)]
pub enum TestSignal {
    /// Continuous sine at this frequency, −12 dBFS.
    Tone(f32),
    /// Speech-like buzz in bursts: 1.6 s talking, 0.9 s silence (exercises the voice gate).
    Talk,
    /// 16 kHz mono samples, looped.
    Clip(Vec<i16>),
}

/// Plays a [`TestSignal`] sample by sample.
#[derive(Clone, Debug)]
pub struct SignalGen {
    signal: TestSignal,
    n: u64,
    phase: f32,
}

impl SignalGen {
    pub fn new(signal: TestSignal) -> Self {
        SignalGen { signal, n: 0, phase: 0.0 }
    }

    /// Parse `tone`, `tone:<hz>`, `talk`, or a path to a WAV/OGG file.
    pub fn parse(spec: &str) -> Result<Self, String> {
        let sig = match spec {
            "tone" => TestSignal::Tone(440.0),
            "talk" | "babble" => TestSignal::Talk,
            s if s.starts_with("tone:") => TestSignal::Tone(s[5..].parse().map_err(|_| format!("bad tone frequency in {s:?}"))?),
            path => {
                let bytes = std::fs::read(path).map_err(|e| format!("{path}: {e}"))?;
                let clip = crate::sound::SoundClip::decode(&bytes).map_err(|e| format!("{path}: {e}"))?;
                let mut r = Resampler::new(clip.rate(), clip.channels());
                let mut v = Vec::with_capacity(clip.frames() * RATE as usize / clip.rate().max(1) as usize + 1);
                r.push(clip.samples(), |x| v.push(to_i16(x)));
                if v.is_empty() {
                    return Err(format!("{path}: empty"));
                }
                TestSignal::Clip(v)
            }
        };
        Ok(Self::new(sig))
    }

    pub fn fill(&mut self, out: &mut [i16]) {
        let dt = 1.0 / RATE as f32;
        for o in out {
            let t = (self.n % (RATE as u64 * 1000)) as f32 * dt;
            *o = match &self.signal {
                TestSignal::Tone(hz) => {
                    self.phase = (self.phase + TAU * hz * dt) % TAU;
                    to_i16(self.phase.sin() * 0.25)
                }
                TestSignal::Talk => {
                    let cycle = t % 2.5;
                    if cycle >= 1.6 {
                        0
                    } else {
                        let base = 140.0;
                        self.phase = (self.phase + TAU * base * (1.0 + 0.15 * (TAU * 3.0 * t).sin()) * dt) % (TAU * 100.0);
                        let syll = (0.5 + 0.5 * (TAU * 4.0 * t).sin()).powf(0.7);
                        let env = (cycle / 0.02).min(1.0) * ((1.6 - cycle) / 0.05).min(1.0);
                        let p = self.phase;
                        to_i16((p.sin() * 0.5 + (p * 3.0).sin() * 0.25 + (p * 5.0).sin() * 0.12) * syll * 0.6 * env)
                    }
                }
                TestSignal::Clip(v) => v[(self.n % v.len() as u64) as usize],
            };
            self.n += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resampler_rates() {
        for (rate, ch) in [(48_000u32, 2u16), (44_100, 1), (16_000, 1), (8_000, 1)] {
            let mut r = Resampler::new(rate, ch);
            let secs = 1.0;
            let n = (rate as f32 * secs) as usize;
            let input: Vec<f32> = (0..n).flat_map(|i| std::iter::repeat_n((i as f32 / rate as f32 * 440.0 * TAU).sin() * 0.5, ch as usize)).collect();
            let mut out = Vec::new();
            r.push(&input, |x| out.push(x));
            assert!((out.len() as i64 - 16_000).abs() <= 2, "{rate}: {} samples", out.len());
            // A 440 Hz tone survives at about the same level (skip the filter's settling).
            let peak = out[2000..].iter().fold(0.0f32, |m, &x| m.max(x.abs()));
            assert!((0.45..0.55).contains(&peak), "{rate}: peak {peak}");
        }
    }

    #[test]
    fn resampler_rejects_aliasing() {
        // 12 kHz at 48 kHz would alias to 4 kHz at 16 kHz without the low-pass.
        let mut r = Resampler::new(48_000, 1);
        let input: Vec<f32> = (0..48_000).map(|i| (i as f32 / 48_000.0 * 12_000.0 * TAU).sin() * 0.5).collect();
        let mut out = Vec::new();
        r.push(&input, |x| out.push(x));
        let peak = out[2000..].iter().fold(0.0f32, |m, &x| m.max(x.abs()));
        assert!(peak < 0.08, "alias peak {peak}");
    }

    #[test]
    fn gate_opens_on_talk_and_closes_after_hang() {
        let mut g = SignalGen::new(TestSignal::Talk);
        let mut gate = Gate::new(-45.0);
        let mut frame = [0i16; 320];
        let mut open = Vec::new();
        for _ in 0..250 {
            g.fill(&mut frame);
            open.push(gate.update(level_db(&frame)));
        }
        // 2.5 s cycle = 125 frames: talking for frames 0..80, silent 80..125.
        assert!(open[5..78].iter().all(|&o| o), "open while talking");
        assert!(open[100..124].iter().all(|&o| !o), "closed in silence after the hang");
        assert!(open[126..200].iter().filter(|&&o| o).count() > 70, "reopens");
    }

    #[test]
    fn gate_ignores_steady_noise() {
        let mut gate = Gate::new(-60.0);
        // −40 dBFS hum for 10 s: the floor rises to it, so the gate closes within ~2.5 s.
        let open: Vec<bool> = (0..500).map(|_| gate.update(-40.0)).collect();
        assert!(open[130..].iter().all(|&o| !o), "still open on steady noise");
    }

    #[test]
    fn levels() {
        assert_eq!(level_db(&[0; 320]), -100.0);
        let full: Vec<i16> = (0..320).map(|i| if i % 2 == 0 { 32767 } else { -32767 }).collect();
        assert!(level_db(&full).abs() < 0.1);
    }
}
