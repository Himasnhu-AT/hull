//! Weather (feature `weather`): a seeded schedule of [`WeatherDef`]s (clear, overcast, rain, fog,
//! storm... as data) blended over time into one [`Weather`] state that drives the
//! [`crate::look::Look`] (sun, sky, fog, saturation), rain / snow particles around the camera,
//! surface wetness (global and per [`WeatherRegion`]) with a traction multiplier, and a wind
//! vector. Same seed + same time = same weather on every machine (multiplayer: sync `seed` and
//! `time`). Docs: `docs/WEATHER.md`.
//!
//! ```ignore
//! app.insert_resource(Weather::new(seed));                  // or leave it: seed 0
//! app.world_mut().resource_mut::<WeatherLibrary>().load_json("assets/weather.json".as_ref())?;
//! fn drive(surface: SurfaceQuery, wind: Res<Wind>, w: Res<Weather>) {
//!     let grip = surface.traction_at(pos, 1.0);             // 1.0 dry .. WeatherConfig::wet_traction
//!     let push = wind.vector();                             // m/s
//! }
//! weather.force("storm", 20.0);                             // scripted change, blended
//! ```

pub mod data;

#[cfg(feature = "devtools")]
mod control;

use bevy::ecs::system::SystemParam;
use bevy::prelude::*;

pub use data::{Schedule, ScheduleSample, WeatherDef, WeatherKind, WeatherLibrary, WeatherParams};

use crate::look::Look;

#[derive(SystemSet, Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum WeatherSet {
    /// Advances the clock, blends the params, updates wind and wetness.
    Advance,
    /// Writes `Look` and rain/snow effects.
    Apply,
}

/// Behaviour switches and tuning.
#[derive(Resource, Clone, Debug)]
pub struct WeatherConfig {
    /// Write the weather into `Look` (sun, sky, fog, saturation).
    pub drive_look: bool,
    /// Also lower `Look::exposure.ev100` under cloud. Leave off when a `PhotoCamera` or auto
    /// exposure sets exposure (two writers fight).
    pub drive_exposure: bool,
    /// Feed wind and rain/wind background noise to `ai::acoustic::AcousticEnv` (feature `ai`).
    pub drive_acoustics: bool,
    /// Rain / snow particles through `vfx` (needs a `VfxLibrary`, i.e. the vfx plugin).
    pub particles: bool,
    /// Wetness gained per second under full precipitation (0.02 = soaked in 50 s).
    pub wet_rate: f32,
    /// Wetness lost per second when dry; faster under clear skies.
    pub dry_rate: f32,
    /// Traction multiplier on fully wet ground for a surface with sensitivity 1.
    pub wet_traction: f32,
    /// Fog visibility (m) is multiplied by `frac^thickness`: this fraction at full thickness.
    pub fog_min_visibility_frac: f32,
}

impl Default for WeatherConfig {
    fn default() -> Self {
        WeatherConfig { drive_look: true, drive_exposure: false, drive_acoustics: true, particles: true, wet_rate: 0.02, dry_rate: 0.004, wet_traction: 0.55, fog_min_visibility_frac: 0.03 }
    }
}

#[derive(Clone, Debug)]
struct Forced {
    from: WeatherParams,
    /// `None`: blend back to the schedule, then drop the override.
    to: Option<WeatherParams>,
    name: Option<String>,
    elapsed: f32,
    blend: f32,
}

/// The weather state. Deterministic in `(seed, time)` except while a [`Weather::force`] is active.
#[derive(Resource, Clone, Debug)]
pub struct Weather {
    pub seed: u64,
    /// Seconds on the weather clock. Set it from a synced clock in multiplayer.
    pub time: f64,
    /// Clock speed multiplier (1 = real time, 60 = a minute per second).
    pub speed: f32,
    pub paused: bool,
    /// The blended parameters right now.
    pub params: WeatherParams,
    /// Schedule position: the def now, the def it blends toward and the blend 0..1.
    pub current: usize,
    pub next: usize,
    pub blend: f32,
    sched: Schedule,
    forced: Option<Forced>,
    started: bool,
}

impl Default for Weather {
    fn default() -> Self {
        Weather::new(0)
    }
}

impl Weather {
    pub fn new(seed: u64) -> Weather {
        Weather {
            seed,
            time: 0.0,
            speed: 1.0,
            paused: false,
            params: WeatherParams::default(),
            current: 0,
            next: 0,
            blend: 0.0,
            sched: Schedule { seg: 0, start: 0.0, len: 0.0, cur: usize::MAX },
            forced: None,
            started: false,
        }
    }

    pub fn kind(&self) -> WeatherKind {
        self.params.kind()
    }

    /// Name of the forced weather, else of the dominant def (the blend target once past halfway).
    pub fn name<'a>(&'a self, lib: &'a WeatherLibrary) -> &'a str {
        if let Some(n) = self.forced_name() {
            return n;
        }
        let i = if self.blend > 0.5 { self.next } else { self.current };
        lib.defs.get(i).map(|d| d.name.as_str()).unwrap_or("")
    }

    pub fn is_forced(&self) -> bool {
        self.forced.is_some()
    }

    /// Blend to the named weather over `blend_secs` and hold it until [`release`](Self::release).
    /// Returns `false` for an unknown name.
    pub fn force(&mut self, lib: &WeatherLibrary, name: &str, blend_secs: f32) -> bool {
        let Some(i) = lib.index_of(name) else { return false };
        self.forced = Some(Forced { from: self.params, to: Some(lib.defs[i].params), name: Some(name.into()), elapsed: 0.0, blend: blend_secs.max(0.0) });
        true
    }

    /// Hold arbitrary parameters.
    pub fn force_params(&mut self, to: WeatherParams, blend_secs: f32) {
        self.forced = Some(Forced { from: self.params, to: Some(to), name: None, elapsed: 0.0, blend: blend_secs.max(0.0) });
    }

    /// Go back to the schedule, blending over `blend_secs`.
    pub fn release(&mut self, blend_secs: f32) {
        if self.forced.is_some() {
            self.forced = Some(Forced { from: self.params, to: None, name: None, elapsed: 0.0, blend: blend_secs.max(0.0) });
        }
    }

    pub fn forced_name(&self) -> Option<&str> {
        self.forced.as_ref().and_then(|f| f.name.as_deref())
    }

    /// Restart the schedule walk (after changing `seed`).
    pub fn sched_reset(&mut self) {
        self.started = false;
    }

    /// Jump the clock (the schedule follows; seeking back replays from the start).
    pub fn set_time(&mut self, t: f64) {
        self.time = t.max(0.0);
    }

    fn update(&mut self, lib: &WeatherLibrary, dt: f32) {
        if !self.paused {
            self.time += dt as f64 * self.speed as f64;
        }
        if !self.started || self.sched.cur == usize::MAX {
            self.sched = Schedule::new(self.seed, lib);
            self.started = true;
        }
        self.sched.advance_to(self.seed, lib, self.time);
        let s = self.sched.sample(self.seed, lib, self.time);
        (self.current, self.next, self.blend) = (s.cur, s.next, s.blend);
        let target = match &mut self.forced {
            None => s.params,
            Some(f) => {
                f.elapsed += dt;
                let t = if f.blend <= 0.0 { 1.0 } else { (f.elapsed / f.blend).clamp(0.0, 1.0) };
                let t = t * t * (3.0 - 2.0 * t);
                let to = f.to.unwrap_or(s.params);
                let p = f.from.lerp(&to, t);
                if f.to.is_none() && f.elapsed >= f.blend {
                    self.forced = None;
                }
                p
            }
        };
        self.params = target;
    }
}

/// Wind now: horizontal direction (unit vector) and speed with gusts.
#[derive(Resource, Clone, Copy, Debug)]
pub struct Wind {
    pub dir: Vec3,
    /// m/s including the current gust.
    pub speed: f32,
}

impl Default for Wind {
    fn default() -> Self {
        Wind { dir: Vec3::X, speed: 0.0 }
    }
}

impl Wind {
    /// Air velocity (m/s): blows toward `dir`.
    pub fn vector(&self) -> Vec3 {
        self.dir * self.speed
    }
}

/// How wet the open ground is, 0 (dry) .. 1 (soaked).
#[derive(Resource, Clone, Copy, Debug, Default)]
pub struct Wetness(pub f32);

/// A patch of ground with its own wetting rules: under a canopy, a stream bank, a muddy hollow.
/// The smallest region containing a point decides its wetness.
#[derive(Component, Clone, Debug)]
#[require(Transform, RegionWetness)]
pub struct WeatherRegion {
    /// Horizontal radius (m) around the entity.
    pub radius: f32,
    /// Rain doesn't reach it (dries, never wets).
    pub sheltered: bool,
    pub wet_mul: f32,
    pub dry_mul: f32,
    /// Never drier than this (a stream bed, a bog).
    pub floor: f32,
}

impl Default for WeatherRegion {
    fn default() -> Self {
        WeatherRegion { radius: 10.0, sheltered: false, wet_mul: 1.0, dry_mul: 1.0, floor: 0.0 }
    }
}

/// A region's current wetness (maintained by the plugin).
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct RegionWetness(pub f32);

/// Surface wetness and traction at a point, for physics and vehicles.
#[derive(SystemParam)]
pub struct SurfaceQuery<'w, 's> {
    global: Res<'w, Wetness>,
    cfg: Res<'w, WeatherConfig>,
    regions: Query<'w, 's, (&'static WeatherRegion, &'static RegionWetness, &'static GlobalTransform)>,
}

impl SurfaceQuery<'_, '_> {
    /// 0..1 wetness at `pos`: the smallest [`WeatherRegion`] containing it, else the open ground.
    pub fn wetness_at(&self, pos: Vec3) -> f32 {
        let mut best: Option<(f32, f32)> = None;
        for (r, w, gt) in &self.regions {
            let c = gt.translation();
            if Vec2::new(pos.x - c.x, pos.z - c.z).length() <= r.radius && best.is_none_or(|b| r.radius < b.0) {
                best = Some((r.radius, w.0));
            }
        }
        best.map_or(self.global.0, |b| b.1)
    }

    /// Grip multiplier at `pos` for a surface that is `sensitivity` affected by water
    /// (1 = mud/dirt, ~0.3 = rock, 0 = unaffected).
    pub fn traction_at(&self, pos: Vec3, sensitivity: f32) -> f32 {
        traction_multiplier(self.wetness_at(pos), sensitivity, self.cfg.wet_traction)
    }
}

/// `1` dry, down to `1 - sensitivity · (1 - wet_traction)` soaked.
pub fn traction_multiplier(wetness: f32, sensitivity: f32, wet_traction: f32) -> f32 {
    1.0 - sensitivity.clamp(0.0, 1.0) * (1.0 - wet_traction) * wetness.clamp(0.0, 1.0)
}

/// One step of wetting / drying.
pub fn step_wetness(wet: f32, precip: f32, cloud: f32, cfg: &WeatherConfig, wet_mul: f32, dry_mul: f32, dt: f32) -> f32 {
    let w = if precip > 0.02 {
        wet + cfg.wet_rate * precip * wet_mul * dt
    } else {
        wet - cfg.dry_rate * (1.0 + (1.0 - cloud)) * dry_mul * dt
    };
    w.clamp(0.0, 1.0)
}

/// The weather applied to a base look (pure; tested).
pub fn look_for(base: &Look, p: &WeatherParams, cfg: &WeatherConfig) -> Look {
    use crate::look::{FogMode, Rgb, SkyMode};
    let mut l = base.clone();
    let c = p.cloud.clamp(0.0, 1.0);
    let grey = |v: Rgb, g: f32, t: f32| Rgb::from_linear(v.linear().lerp(Vec3::splat(g), t));
    l.sun.illuminance *= 1.0 - 0.8 * c;
    l.sun.disk_intensity *= 1.0 - c;
    l.sun.soft_shadow_size *= 1.0 + 3.0 * c;
    l.ambient.brightness *= 1.0 - 0.25 * c;
    if l.sky.mode == SkyMode::Gradient {
        let g = |v: Rgb| grey(v, (v.linear().element_sum() / 3.0 * 0.85).max(0.2), c * 0.8);
        l.sky.zenith = g(l.sky.zenith);
        l.sky.horizon = g(l.sky.horizon);
        l.sky.brightness *= 1.0 - 0.4 * c;
        l.sky.sun_glow *= 1.0 - c;
    }
    l.grading.post_saturation *= 1.0 - 0.25 * c - 0.1 * p.precip;
    if cfg.drive_exposure {
        l.exposure.ev100 -= 1.5 * c;
    }
    // Fog: thicker with fog density and (a little) rain; tinted toward the weather's grey.
    let thick = (p.fog + 0.35 * p.precip).clamp(0.0, 1.0);
    if thick > 0.01 {
        if l.fog.mode == FogMode::Off {
            l.fog.mode = FogMode::Exponential;
            l.fog.visibility = 4000.0;
        }
        let frac = cfg.fog_min_visibility_frac.powf(thick);
        l.fog.visibility = (l.fog.visibility * frac).max(8.0);
        l.fog.color = grey(l.fog.color, (l.fog.color.linear().element_sum() / 3.0).max(0.25), (0.6 * c).max(p.fog * 0.5));
        l.fog.sun_amount *= 1.0 - thick;
        if l.volumetric.enabled {
            l.volumetric.density *= 1.0 + 4.0 * p.fog;
        }
    }
    l
}

/// Captures the look weather builds on, and what it last wrote.
#[derive(Resource, Default)]
struct WeatherLook {
    base: Option<Look>,
    written: Option<Look>,
    applied: Option<WeatherParams>,
}

/// Rain and snow effect entities.
#[derive(Resource, Default)]
struct WeatherFx {
    rain: Option<Entity>,
    snow: Option<Entity>,
}

pub struct WeatherPlugin;

impl Plugin for WeatherPlugin {
    fn build(&self, app: &mut App) {
        app.init_resource::<Weather>()
            .init_resource::<WeatherLibrary>()
            .init_resource::<WeatherConfig>()
            .init_resource::<Wind>()
            .init_resource::<Wetness>()
            .init_resource::<WeatherLook>()
            .init_resource::<WeatherFx>()
            .register_type::<WeatherParams>()
            .configure_sets(Update, (WeatherSet::Advance, WeatherSet::Apply).chain())
            .add_systems(Update, (advance, wetness).chain().in_set(WeatherSet::Advance))
            .add_systems(Update, (drive_look.run_if(resource_exists::<Look>), drive_particles).in_set(WeatherSet::Apply));
        // Weather writes the look first, the photo camera's lens on top.
        #[cfg(feature = "photo")]
        app.configure_sets(Update, WeatherSet::Apply.before(crate::photo::PhotoSet::Lens));
        app.configure_sets(Update, WeatherSet::Apply.before(crate::look::apply::apply_look));
        #[cfg(feature = "devtools")]
        control::register(app);
    }
}

fn advance(time: Res<Time>, cfg: Res<WeatherConfig>, lib: Res<WeatherLibrary>, mut w: ResMut<Weather>, mut wind: ResMut<Wind>, #[cfg(feature = "ai")] mut env: Option<ResMut<crate::ai::acoustic::AcousticEnv>>) {
    let before = (w.time, w.paused);
    w.update(&lib, time.delta_secs());
    let (angle, speed) = data::wind_at(w.seed, w.time, &w.params);
    let dir = Vec3::new(angle.cos(), 0.0, angle.sin());
    if before.0 != w.time || wind.speed != speed {
        *wind = Wind { dir, speed };
    }
    #[cfg(feature = "ai")]
    if let Some(env) = env.as_mut().filter(|_| cfg.drive_acoustics) {
        env.wind = wind.vector();
        // Rain and wind mask quiet sounds.
        env.ambient_db = 15.0 + 28.0 * w.params.precip + 1.2 * wind.speed;
    }
}

fn wetness(time: Res<Time>, cfg: Res<WeatherConfig>, w: Res<Weather>, mut global: ResMut<Wetness>, mut regions: Query<(&WeatherRegion, &mut RegionWetness)>) {
    let dt = time.delta_secs();
    if dt <= 0.0 {
        return;
    }
    // Snow wets the ground slowly (melt); rain at full rate.
    let precip = if w.params.is_snow() { w.params.precip * 0.3 } else { w.params.precip };
    let g = step_wetness(global.0, precip, w.params.cloud, &cfg, 1.0, 1.0, dt);
    if g != global.0 {
        global.0 = g;
    }
    for (r, mut rw) in &mut regions {
        let p = if r.sheltered { 0.0 } else { precip };
        let v = step_wetness(rw.0, p, w.params.cloud, &cfg, r.wet_mul, r.dry_mul, dt).max(r.floor);
        if v != rw.0 {
            rw.0 = v;
        }
    }
}

/// The look groups weather rewrites. Everything else (lens, bloom, tonemapping, and exposure
/// unless `drive_exposure`) belongs to other writers and passes through untouched.
fn owned_eq(a: &Look, b: &Look, cfg: &WeatherConfig) -> bool {
    a.sun == b.sun
        && a.sky == b.sky
        && a.ambient == b.ambient
        && a.fog == b.fog
        && a.volumetric == b.volumetric
        && a.grading == b.grading
        && (!cfg.drive_exposure || a.exposure == b.exposure)
}

fn others_eq(a: &Look, b: &Look, cfg: &WeatherConfig) -> bool {
    a.lens == b.lens && a.bloom == b.bloom && a.tonemapping == b.tonemapping && a.name == b.name && (cfg.drive_exposure || a.exposure == b.exposure)
}

fn drive_look(cfg: Res<WeatherConfig>, w: Res<Weather>, mut st: ResMut<WeatherLook>, mut look: ResMut<Look>) {
    if !cfg.drive_look {
        return;
    }
    // Someone else (a timeline, a transition) rewrote a group weather owns: build on it. Other
    // writers touching other groups (the photo lens every frame) must not rebase, or weather
    // would be applied on top of itself.
    let foreign = st.base.is_none() || st.written.as_ref().is_none_or(|wr| !owned_eq(wr, &look, &cfg));
    if foreign {
        st.base = Some(look.clone());
    }
    let moved = st.applied.as_ref().is_none_or(|a| a.max_delta(&w.params) > 1e-3);
    if !foreign && !moved && st.written.as_ref().is_some_and(|wr| others_eq(wr, &look, &cfg)) {
        return;
    }
    let Some(base) = st.base.as_mut() else { return };
    if !foreign {
        // Carry the other writers' groups into the base.
        base.lens = look.lens.clone();
        base.bloom = look.bloom.clone();
        base.tonemapping = look.tonemapping;
        base.name = look.name.clone();
        if !cfg.drive_exposure {
            base.exposure = look.exposure.clone();
        }
    }
    let next = look_for(base, &w.params, &cfg);
    if next != *look {
        *look = next.clone();
    }
    st.written = Some(next);
    st.applied = Some(w.params);
}

fn drive_particles(
    mut commands: Commands,
    cfg: Res<WeatherConfig>,
    w: Res<Weather>,
    mut fx: ResMut<WeatherFx>,
    lib: Option<Res<crate::vfx::VfxLibrary>>,
    mut effects: Query<&mut crate::vfx::ParticleEffect>,
) {
    if !cfg.particles || lib.is_none() {
        return;
    }
    let (rain, snow) = {
        let p = &w.params;
        let on = p.precip > 0.03;
        (on && !p.is_snow(), on && p.is_snow())
    };
    let fx = &mut *fx;
    for (slot, name, on) in [(&mut fx.rain, "rain", rain), (&mut fx.snow, "snow", snow)] {
        let scale = w.params.precip.clamp(0.05, 1.0);
        match *slot {
            Some(e) => {
                if let Ok(mut pe) = effects.get_mut(e) {
                    if pe.emitting != on {
                        pe.emitting = on;
                    }
                    if on && (pe.rate_scale - scale).abs() > 0.01 {
                        pe.rate_scale = scale;
                    }
                }
            }
            None if on => {
                let mut pe = crate::vfx::ParticleEffect::new(name).on_finish(crate::vfx::OnFinish::Keep);
                pe.rate_scale = scale;
                *slot = Some(commands.spawn((Name::new(format!("weather {name}")), pe, Transform::default())).id());
            }
            None => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bevy::ecs::system::RunSystemOnce;
    use std::time::Duration;

    fn app(seed: u64) -> App {
        let mut app = App::new();
        app.add_plugins(MinimalPlugins)
            .insert_resource(bevy::time::TimeUpdateStrategy::ManualDuration(Duration::from_millis(100)))
            .insert_resource(Weather::new(seed))
            .init_resource::<WeatherLibrary>()
            .init_resource::<WeatherConfig>()
            .init_resource::<Wind>()
            .init_resource::<Wetness>()
            .init_resource::<WeatherLook>()
            .insert_resource(Look::clear_day())
            .add_systems(Update, (advance, wetness, drive_look).chain());
        app.update();
        app
    }

    #[test]
    fn same_seed_same_weather_across_runs() {
        let run = |seed| {
            let mut a = app(seed);
            a.world_mut().resource_mut::<Weather>().speed = 120.0;
            let mut trace = Vec::new();
            for _ in 0..600 {
                a.update();
                let w = a.world().resource::<Weather>();
                trace.push((w.current, w.params.cloud.to_bits(), w.params.precip.to_bits()));
            }
            trace
        };
        assert_eq!(run(11), run(11));
        assert_ne!(run(11), run(12));
    }

    #[test]
    fn force_blends_then_holds_and_release_returns() {
        let mut a = app(1);
        let lib = a.world().resource::<WeatherLibrary>().clone();
        assert!(!a.world_mut().resource_mut::<Weather>().force(&lib, "nonsense", 1.0));
        assert!(a.world_mut().resource_mut::<Weather>().force(&lib, "storm", 2.0));
        for _ in 0..10 {
            a.update();
        }
        let mid = a.world().resource::<Weather>().params.precip;
        assert!(mid > 0.0 && mid < 1.0, "blending: {mid}");
        for _ in 0..20 {
            a.update();
        }
        let w = a.world().resource::<Weather>();
        assert_eq!(w.kind(), WeatherKind::Storm);
        assert_eq!(w.forced_name(), Some("storm"));
        a.world_mut().resource_mut::<Weather>().release(1.0);
        for _ in 0..30 {
            a.update();
        }
        let w = a.world().resource::<Weather>();
        assert!(!w.is_forced());
        assert_eq!(w.params.kind(), WeatherKind::Clear, "the schedule starts clear");
    }

    #[test]
    fn look_follows_weather() {
        let mut a = app(1);
        let clear = a.world().resource::<Look>().clone();
        let lib = a.world().resource::<WeatherLibrary>().clone();
        a.world_mut().resource_mut::<Weather>().force(&lib, "fog", 0.0);
        for _ in 0..3 {
            a.update();
        }
        let foggy = a.world().resource::<Look>().clone();
        assert!(foggy.fog.visibility < clear.fog.visibility * 0.3, "{} vs {}", foggy.fog.visibility, clear.fog.visibility);
        assert!(foggy.sun.illuminance < clear.sun.illuminance);
        // Back to clear sky: the base look returns (not compounding).
        a.world_mut().resource_mut::<Weather>().force(&lib, "clear", 0.0);
        for _ in 0..3 {
            a.update();
        }
        let back = a.world().resource::<Look>();
        assert!((back.fog.visibility - clear.fog.visibility).abs() < clear.fog.visibility * 0.01);
        assert!((back.sun.illuminance - clear.sun.illuminance).abs() < clear.sun.illuminance * 0.01);
    }

    #[test]
    fn other_writers_of_other_groups_do_not_compound_the_weather() {
        let mut a = app(1);
        let lib = a.world().resource::<WeatherLibrary>().clone();
        a.world_mut().resource_mut::<Weather>().force(&lib, "overcast", 0.0);
        for _ in 0..3 {
            a.update();
        }
        let sun = a.world().resource::<Look>().sun.illuminance;
        // A photo camera moving its focus every frame.
        for i in 0..200 {
            a.world_mut().resource_mut::<Look>().lens.dof.focal_distance = 5.0 + i as f32;
            a.update();
        }
        let look = a.world().resource::<Look>();
        assert_eq!(look.sun.illuminance, sun, "weather must not re-apply itself on its own output");
        assert_eq!(look.lens.dof.focal_distance, 204.0, "their writes survive");
    }

    #[test]
    fn an_external_look_change_becomes_the_new_base() {
        let mut a = app(1);
        let lib = a.world().resource::<WeatherLibrary>().clone();
        a.world_mut().resource_mut::<Weather>().force(&lib, "overcast", 0.0);
        a.update();
        a.update();
        *a.world_mut().resource_mut::<Look>() = Look::night();
        a.update();
        let night_ev = Look::night().exposure.ev100;
        assert!(a.world().resource::<Look>().sun.illuminance <= Look::night().sun.illuminance, "weather re-applied on the night look");
        let _ = night_ev;
    }

    #[test]
    fn wetness_rises_in_rain_and_dries_after() {
        let mut a = app(1);
        let lib = a.world().resource::<WeatherLibrary>().clone();
        a.world_mut().resource_mut::<Weather>().force(&lib, "rain", 0.0);
        for _ in 0..400 {
            a.update();
        }
        let wet = a.world().resource::<Wetness>().0;
        assert!(wet > 0.4, "after 40 s of rain at 0.55: {wet}");
        a.world_mut().resource_mut::<Weather>().force(&lib, "clear", 0.0);
        for _ in 0..1500 {
            a.update();
        }
        assert!(a.world().resource::<Wetness>().0 < wet - 0.2, "drying");
    }

    #[test]
    fn regions_and_traction() {
        let mut a = app(1);
        let lib = a.world().resource::<WeatherLibrary>().clone();
        a.world_mut().resource_mut::<Weather>().force(&lib, "rain", 0.0);
        let shelter = a.world_mut().spawn((WeatherRegion { radius: 5.0, sheltered: true, ..default() }, GlobalTransform::from_xyz(50.0, 0.0, 0.0))).id();
        let bog = a.world_mut().spawn((WeatherRegion { radius: 8.0, floor: 0.9, ..default() }, GlobalTransform::from_xyz(-50.0, 0.0, 0.0))).id();
        for _ in 0..400 {
            a.update();
        }
        let w = a.world();
        assert_eq!(w.get::<RegionWetness>(shelter).unwrap().0, 0.0, "canopy stays dry");
        assert!(w.get::<RegionWetness>(bog).unwrap().0 >= 0.9);
        let open = w.resource::<Wetness>().0;
        assert!(open > 0.3);
        let cfg = WeatherConfig::default();
        assert_eq!(traction_multiplier(0.0, 1.0, cfg.wet_traction), 1.0);
        assert!((traction_multiplier(1.0, 1.0, cfg.wet_traction) - cfg.wet_traction).abs() < 1e-6);
        assert!(traction_multiplier(1.0, 0.3, cfg.wet_traction) > traction_multiplier(1.0, 1.0, cfg.wet_traction));
    }

    #[test]
    fn surface_query_picks_the_smallest_region() {
        let mut app = App::new();
        app.insert_resource(Wetness(0.5)).init_resource::<WeatherConfig>();
        app.world_mut().spawn((WeatherRegion { radius: 20.0, ..default() }, RegionWetness(0.2), GlobalTransform::default()));
        app.world_mut().spawn((WeatherRegion { radius: 4.0, ..default() }, RegionWetness(0.9), GlobalTransform::default()));
        let out = app.world_mut().run_system_once(|q: SurfaceQuery| (q.wetness_at(Vec3::new(1.0, 0.0, 0.0)), q.wetness_at(Vec3::new(10.0, 0.0, 0.0)), q.wetness_at(Vec3::new(99.0, 0.0, 0.0)))).unwrap();
        assert_eq!(out, (0.9, 0.2, 0.5));
    }
}
