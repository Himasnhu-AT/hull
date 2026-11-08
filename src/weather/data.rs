//! Weather as data: parameters, definitions with a transition table, and a schedule that is a
//! pure function of `(seed, library, time)`.

use bevy::prelude::*;
use serde::{Deserialize, Serialize};

/// Everything the rest of the engine reads about the sky. Each is 0..1 unless noted.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize, Reflect)]
#[serde(default)]
pub struct WeatherParams {
    /// Cloud cover: dims the sun, greys the sky, mutes colours.
    pub cloud: f32,
    /// Rain (or snow when cold) intensity.
    pub precip: f32,
    /// Fog density: cuts visibility.
    pub fog: f32,
    /// Mean wind speed (m/s).
    pub wind_speed: f32,
    /// 0..1: how gusty the wind is around its mean.
    pub gustiness: f32,
    /// Air temperature (°C); precipitation at or below 0.5 falls as snow.
    pub temperature_c: f32,
}

impl Default for WeatherParams {
    fn default() -> Self {
        WeatherParams { cloud: 0.1, precip: 0.0, fog: 0.0, wind_speed: 2.0, gustiness: 0.2, temperature_c: 18.0 }
    }
}

impl WeatherParams {
    pub fn lerp(&self, o: &WeatherParams, t: f32) -> WeatherParams {
        let l = |a: f32, b: f32| a + (b - a) * t;
        WeatherParams {
            cloud: l(self.cloud, o.cloud),
            precip: l(self.precip, o.precip),
            fog: l(self.fog, o.fog),
            wind_speed: l(self.wind_speed, o.wind_speed),
            gustiness: l(self.gustiness, o.gustiness),
            temperature_c: l(self.temperature_c, o.temperature_c),
        }
    }

    pub fn is_snow(&self) -> bool {
        self.temperature_c <= 0.5
    }

    /// Largest field difference (for "did anything change enough to apply").
    pub fn max_delta(&self, o: &WeatherParams) -> f32 {
        [
            (self.cloud - o.cloud).abs(),
            (self.precip - o.precip).abs(),
            (self.fog - o.fog).abs(),
            (self.wind_speed - o.wind_speed).abs() * 0.05,
            (self.gustiness - o.gustiness).abs(),
            (self.temperature_c - o.temperature_c).abs() * 0.05,
        ]
        .into_iter()
        .fold(0.0, f32::max)
    }

    /// A coarse label for UI and game rules.
    pub fn kind(&self) -> WeatherKind {
        if self.precip > 0.15 {
            if self.is_snow() {
                WeatherKind::Snow
            } else if self.precip > 0.75 && self.wind_speed > 10.0 {
                WeatherKind::Storm
            } else {
                WeatherKind::Rain
            }
        } else if self.fog > 0.4 {
            WeatherKind::Fog
        } else if self.cloud > 0.55 {
            WeatherKind::Overcast
        } else {
            WeatherKind::Clear
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum WeatherKind {
    Clear,
    Overcast,
    Rain,
    Fog,
    Storm,
    Snow,
}

/// One kind of weather: its parameters, how long it lasts and what may follow.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct WeatherDef {
    pub name: String,
    pub params: WeatherParams,
    /// Seconds a stretch of this weather lasts: drawn from this range.
    pub duration: (f32, f32),
    /// Seconds spent blending into the next weather at the end.
    pub blend_secs: f32,
    /// Next weather by name with weights.
    pub next: Vec<(String, f32)>,
}

impl Default for WeatherDef {
    fn default() -> Self {
        WeatherDef { name: String::new(), params: WeatherParams::default(), duration: (300.0, 600.0), blend_secs: 60.0, next: Vec::new() }
    }
}

/// The weather a world can have. Plain data: `load_json` accepts an array of [`WeatherDef`].
#[derive(Resource, Clone, Debug, Serialize, Deserialize)]
pub struct WeatherLibrary {
    pub defs: Vec<WeatherDef>,
    /// Name of the first weather (default: drawn from the seed).
    pub start: Option<String>,
}

impl Default for WeatherLibrary {
    fn default() -> Self {
        WeatherLibrary::presets()
    }
}

impl WeatherLibrary {
    pub fn index_of(&self, name: &str) -> Option<usize> {
        self.defs.iter().position(|d| d.name == name)
    }

    pub fn load_json(&mut self, path: &std::path::Path) -> Result<usize, String> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let defs: Vec<WeatherDef> = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
        let n = defs.len();
        for d in defs {
            match self.index_of(&d.name) {
                Some(i) => self.defs[i] = d,
                None => self.defs.push(d),
            }
        }
        Ok(n)
    }

    /// Clear, overcast, rain, fog, storm: a chain that mostly drifts clear → overcast → rain.
    pub fn presets() -> Self {
        let p = |cloud, precip, fog, wind_speed, gustiness, temperature_c| WeatherParams { cloud, precip, fog, wind_speed, gustiness, temperature_c };
        let n = |s: &str, w: f32| (s.to_string(), w);
        let d = |name: &str, params, duration, blend_secs, next: Vec<(String, f32)>| WeatherDef { name: name.into(), params, duration, blend_secs, next };
        WeatherLibrary {
            defs: vec![
                d("clear", p(0.1, 0.0, 0.0, 2.0, 0.2, 20.0), (480.0, 900.0), 90.0, vec![n("clear", 1.0), n("overcast", 3.0), n("fog", 1.0)]),
                d("overcast", p(0.75, 0.0, 0.1, 4.0, 0.3, 14.0), (240.0, 480.0), 60.0, vec![n("clear", 2.0), n("rain", 3.0), n("fog", 1.0)]),
                d("rain", p(0.9, 0.55, 0.2, 6.0, 0.4, 11.0), (240.0, 600.0), 60.0, vec![n("overcast", 3.0), n("storm", 1.0), n("clear", 1.0)]),
                d("fog", p(0.5, 0.0, 0.85, 0.8, 0.1, 9.0), (300.0, 600.0), 90.0, vec![n("clear", 2.0), n("overcast", 2.0)]),
                d("storm", p(1.0, 1.0, 0.3, 14.0, 0.8, 9.0), (120.0, 300.0), 45.0, vec![n("rain", 3.0), n("overcast", 1.0)]),
            ],
            start: Some("clear".into()),
        }
    }
}

// ---- deterministic schedule ----

fn mix(seed: u64, a: u64, b: u64) -> u64 {
    let mut z = seed.wrapping_add(a.wrapping_mul(0x9E37_79B9_7F4A_7C15)).wrapping_add(b.wrapping_mul(0xD1B5_4A32_D192_ED03));
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

/// Uniform in 0..1 from a hash.
fn unit(h: u64) -> f32 {
    (h >> 40) as f32 / (1u64 << 24) as f32
}

/// Smooth value noise in 0..1, a pure function of `(seed, x)`.
pub fn noise1d(seed: u64, x: f64) -> f32 {
    let i = x.floor();
    let f = (x - i) as f32;
    let s = f * f * (3.0 - 2.0 * f);
    let (a, b) = (unit(mix(seed, i as i64 as u64, 11)), unit(mix(seed, (i as i64 + 1) as u64, 11)));
    a + (b - a) * s
}

/// Walks the chain of weather stretches. Cheap to advance (segments last minutes); seeking
/// backwards restarts from the beginning.
#[derive(Clone, Debug)]
pub struct Schedule {
    pub seg: u64,
    pub start: f64,
    pub len: f64,
    pub cur: usize,
}

/// The weather at a moment: the current def, the def it blends toward, and the blend 0..1.
#[derive(Clone, Copy, Debug)]
pub struct ScheduleSample {
    pub params: WeatherParams,
    pub cur: usize,
    pub next: usize,
    pub blend: f32,
}

impl Schedule {
    pub fn new(seed: u64, lib: &WeatherLibrary) -> Schedule {
        let cur = match lib.start.as_deref().and_then(|n| lib.index_of(n)) {
            Some(i) => i,
            None if lib.defs.is_empty() => 0,
            None => (mix(seed, 0, 1) % lib.defs.len() as u64) as usize,
        };
        Schedule { seg: 0, start: 0.0, len: Self::seg_len(seed, lib, 0, cur), cur }
    }

    fn seg_len(seed: u64, lib: &WeatherLibrary, seg: u64, cur: usize) -> f64 {
        let Some(d) = lib.defs.get(cur) else { return 600.0 };
        let (lo, hi) = (d.duration.0.min(d.duration.1), d.duration.0.max(d.duration.1));
        ((lo + (hi - lo) * unit(mix(seed, seg, 2))) as f64).max(1.0)
    }

    /// The def that follows segment `seg` (weighted draw from `next`; unknown names are skipped,
    /// an empty table repeats the current weather).
    pub fn next_of(seed: u64, lib: &WeatherLibrary, seg: u64, cur: usize) -> usize {
        let Some(d) = lib.defs.get(cur) else { return cur };
        let opts: Vec<(usize, f32)> = d.next.iter().filter_map(|(n, w)| lib.index_of(n).map(|i| (i, w.max(0.0)))).collect();
        let total: f32 = opts.iter().map(|o| o.1).sum();
        if opts.is_empty() || total <= 0.0 {
            return cur;
        }
        let mut r = unit(mix(seed, seg, 3)) * total;
        for (i, w) in &opts {
            if r < *w {
                return *i;
            }
            r -= w;
        }
        opts.last().unwrap().0
    }

    pub fn advance_to(&mut self, seed: u64, lib: &WeatherLibrary, t: f64) {
        if t < self.start || lib.defs.get(self.cur).is_none() {
            *self = Schedule::new(seed, lib);
        }
        let mut guard = 0;
        while t >= self.start + self.len && guard < 100_000 {
            self.cur = Self::next_of(seed, lib, self.seg, self.cur);
            self.seg += 1;
            self.start += self.len;
            self.len = Self::seg_len(seed, lib, self.seg, self.cur);
            guard += 1;
        }
    }

    pub fn sample(&self, seed: u64, lib: &WeatherLibrary, t: f64) -> ScheduleSample {
        let Some(def) = lib.defs.get(self.cur) else { return ScheduleSample { params: WeatherParams::default(), cur: 0, next: 0, blend: 0.0 } };
        let next = Self::next_of(seed, lib, self.seg, self.cur);
        let b = (def.blend_secs as f64).clamp(0.001, self.len * 0.5);
        let x = ((t - (self.start + self.len - b)) / b).clamp(0.0, 1.0) as f32;
        let blend = x * x * (3.0 - 2.0 * x);
        let params = if blend > 0.0 && next != self.cur { def.params.lerp(&lib.defs[next].params, blend) } else { def.params };
        ScheduleSample { params, cur: self.cur, next, blend }
    }
}

/// The weather at `t` for a seed, from scratch. Same inputs, same answer on every machine.
pub fn sample_at(seed: u64, lib: &WeatherLibrary, t: f64) -> ScheduleSample {
    let mut s = Schedule::new(seed, lib);
    s.advance_to(seed, lib, t);
    s.sample(seed, lib, t)
}

/// Wind direction (radians in the XZ plane, 0 = toward +X, counter-clockwise seen from +Y) and
/// speed (m/s) at `t`: a slowly turning mean direction and gusts around the mean speed.
pub fn wind_at(seed: u64, t: f64, p: &WeatherParams) -> (f32, f32) {
    let angle = noise1d(seed ^ 0xA11CE, t / 420.0) * std::f32::consts::TAU * 1.5;
    let gust = (noise1d(seed ^ 0x600D, t / 3.5) - 0.5) * 2.0 * p.gustiness.clamp(0.0, 1.0);
    (angle, (p.wind_speed * (1.0 + gust)).max(0.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schedule_is_a_pure_function_of_seed_and_time() {
        let lib = WeatherLibrary::presets();
        for seed in [1u64, 42, 9999] {
            for t in [0.0, 100.0, 1234.5, 90_000.0, 1.0e6] {
                let a = sample_at(seed, &lib, t);
                let b = sample_at(seed, &lib, t);
                assert_eq!((a.cur, a.next, a.blend), (b.cur, b.next, b.blend));
                assert_eq!(a.params, b.params);
            }
        }
        // Incremental advance equals a fresh walk, also after seeking back.
        let mut s = Schedule::new(5, &lib);
        for t in (0..20_000).step_by(37) {
            s.advance_to(5, &lib, t as f64);
            let (a, b) = (s.sample(5, &lib, t as f64), sample_at(5, &lib, t as f64));
            assert_eq!((a.cur, a.blend), (b.cur, b.blend), "t={t}");
        }
        s.advance_to(5, &lib, 100.0);
        assert_eq!(s.sample(5, &lib, 100.0).cur, sample_at(5, &lib, 100.0).cur);
    }

    #[test]
    fn different_seeds_give_different_weather() {
        let lib = WeatherLibrary::presets();
        let trace = |seed| (0..40).map(|i| sample_at(seed, &lib, i as f64 * 600.0).cur).collect::<Vec<_>>();
        assert_ne!(trace(1), trace(2));
        let kinds: std::collections::HashSet<_> = trace(1).into_iter().chain(trace(2)).collect();
        assert!(kinds.len() >= 3, "the chain visits several weathers: {kinds:?}");
    }

    #[test]
    fn transitions_blend_smoothly_at_the_end_of_a_stretch() {
        let lib = WeatherLibrary::presets();
        let mut s = Schedule::new(3, &lib);
        s.advance_to(3, &lib, 0.0);
        let end = s.start + s.len;
        let blend = lib.defs[s.cur].blend_secs as f64;
        let before = s.sample(3, &lib, end - blend - 1.0);
        let mid = s.sample(3, &lib, end - blend * 0.5);
        assert_eq!(before.blend, 0.0);
        assert!(mid.blend > 0.3 && mid.blend < 0.7, "{}", mid.blend);
        if mid.next != mid.cur {
            let (a, b) = (lib.defs[mid.cur].params, lib.defs[mid.next].params);
            assert!(mid.params.cloud >= a.cloud.min(b.cloud) - 1e-5 && mid.params.cloud <= a.cloud.max(b.cloud) + 1e-5);
        }
        // Continuous across the boundary.
        let last = s.sample(3, &lib, end - 1e-3).params;
        let mut s2 = s.clone();
        s2.advance_to(3, &lib, end + 1e-3);
        assert!(last.max_delta(&s2.sample(3, &lib, end + 1e-3).params) < 0.02);
    }

    #[test]
    fn wind_is_deterministic_and_gusty() {
        let p = WeatherParams { wind_speed: 8.0, gustiness: 0.6, ..default() };
        assert_eq!(wind_at(7, 123.0, &p), wind_at(7, 123.0, &p));
        let speeds: Vec<f32> = (0..200).map(|i| wind_at(7, i as f64, &p).1).collect();
        let (lo, hi) = speeds.iter().fold((f32::MAX, 0f32), |(l, h), s| (l.min(*s), h.max(*s)));
        assert!(hi - lo > 2.0 && lo >= 0.0, "{lo} {hi}");
        let calm = WeatherParams { gustiness: 0.0, ..p };
        assert_eq!(wind_at(7, 5.0, &calm).1, 8.0);
    }

    #[test]
    fn classification() {
        let lib = WeatherLibrary::presets();
        let kind = |n: &str| lib.defs[lib.index_of(n).unwrap()].params.kind();
        assert_eq!(kind("clear"), WeatherKind::Clear);
        assert_eq!(kind("overcast"), WeatherKind::Overcast);
        assert_eq!(kind("rain"), WeatherKind::Rain);
        assert_eq!(kind("fog"), WeatherKind::Fog);
        assert_eq!(kind("storm"), WeatherKind::Storm);
        assert_eq!(WeatherParams { precip: 0.5, temperature_c: -3.0, ..default() }.kind(), WeatherKind::Snow);
    }
}
